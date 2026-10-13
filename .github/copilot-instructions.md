# Copilot Instructions

## Commands

```bash
# Setup
python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt

# Run app
python app.py

# Run all tests
pytest -v

# Run a single test file
pytest tests/unit/test_db.py -v

# Run a single test function
pytest tests/integration/test_app.py::test_function_name -v
```

## Architecture

Buzzdrop is a one-time self-destructing file-sharing app where files are encrypted client-side (AES-GCM) under a **server-gated key release** scheme (`docs/true-one-time.md` §6): `file_key = HKDF(Kp ‖ H)` where `Kp` derives from the password and `H` is a server-held share released exactly once. The server never handles plaintext data.

**Module layout** — the app was refactored from a single-file monolith; responsibilities are now split:
- `app.py` — Flask routes, `get_backend()`/`get_files_store()` helpers, SRI context processor, startup logic
- `db/` — swappable storage backends: `base.py` defines `FileStore`/`TokenStore`/`Backend`, `sqlite_backend.py` implements them over raw `sqlite3`, `create_backend(DATABASE_URL)` selects by URL scheme
- `models.py` — `FileRepository`: domain facade delegating to the injected `FileStore`
- `storage.py` — `StorageBackend` ABC with `LocalStorage` and `S3Storage` implementations
- `auth.py` — user loading from env vars, `@login_required`/`@admin_required` decorators
- `config.py` — `Config`/`DevelopmentConfig`/`TestingConfig`/`ProductionConfig`; selected via `FLASK_ENV`
- `i18n.py` — language resolution and Flask-Babel setup (see `docs/dev/i18n.md`)
- `tokens.py` — `generate_api_token`, `validate_api_token`, `revoke_api_token`; token hashes stored via `TokenStore` (`api_tokens` table)
- `utils.py` — shared helpers: `enhance_file_display()` (formats timestamps with `<field>_iso` twins, adds `status_key`/`status_display` from `STATUS_LABELS` and the list's `display_name`), `allowed_file()`, `get_client_ip()` (proxy-aware), `cleanup_orphaned_files()`. Server text is UTC (`WEB_TIMEZONE`); the page script shows times in the viewer's zone. `timestamps.py` — every stored time is UTC (`utcnow()`, `now_iso()`, `to_utc_iso()`, `parse_expiry()`); never use a naive `datetime.now()`.
- `cli/buzz` — standalone CLI script (install to `$PATH`; deps in `requirements-cli.txt`)
- `static/js/` — browser code in `lib/` / `features/` / `pages/` with enforced import rules (see `static/js/CLAUDE.md`); `lib/crypto.js` is the BKV3 format, `features/share-protocol/` the upload and key-release handshake, `pages/<page>/entry.js` what each template loads

**File lifecycle:** `/upload/begin` (server mints `file_id` + share H) → browser encrypts → `/upload` (binds verifier V, stores the blob) → recipient opens and confirms `/view/<id>` (burns nothing) → `POST /release/<id>` with V returns H exactly once → `/download/<id>` with the ticket derived from H serves the ciphertext once and deletes it → browser decrypts and posts its receipt to `/report_decryption`. Each step, route and status code is in `docs/dev/share-protocol.md`; check there rather than inferring them.

**Storage abstraction:** `get_storage_backend(config)` returns either `LocalStorage` or `S3Storage`. Both expose `save(file_id, file_data) -> path`, `retrieve(path) -> Iterator[bytes]`, `delete(path)` and `read_prefix(path, length)`. The `path` stored in DB is a local filesystem path for local storage and an S3 key (`uploads/{uuid}`) for S3.

**API token auth:** `POST /api/token` (admin-only, JSON `{"username": "..."}`) issues a raw token shown once. The `@api_auth_required` decorator on `/upload` and `/upload/begin` accepts either `Authorization: Bearer <token>` or a session cookie. When a Bearer header is present and invalid → 401 JSON (no session fallback). On success it sets `flask.g.username`; routes read `g.username` not `session['username']`. Tokens are stored as PBKDF2-HMAC-SHA256 digests in the `api_tokens` table via `TokenStore` — never the raw token.

**`buzz` CLI** (`cli/buzz`): a standalone script that uses the browser's `BKV3` format and two-phase upload over a Bearer token. Its dependencies, token file, passphrase default and binary releases are in `cli/CLAUDE.md`.

All `<script>` tags must include `integrity="{{ sri_hash('js/filename.js') }}" crossorigin="anonymous"`; modules they import get SRI from the import map in `base.html` (`_module_import_map`), so every import is a relative specifier under `static/js` (see `docs/dev/security.md`). In development, missing files raise `FileNotFoundError`; in production they log a warning.

## Key Conventions

**Users are environment variables, not a database.** Format: `FLASK_USER_N=username:password:is_admin`. `get_users()` in `auth.py` is decorated with `@lru_cache` — it hashes passwords on first call. In tests, **clearing and re-adding `FLASK_USER_*` env vars requires calling `get_users.cache_clear()`** or the cached result will be stale.

**`FileRepository` resolves its store lazily.** When initialized without a `files_store` argument (the default), the `store` property calls `from app import get_files_store` at access time, which respects the current Flask app context. Tests that supply a store directly bypass this.

**`get_backend()` recreates backends on config change.** It compares the canonicalized `DATABASE_URL` against `backend.url`, closes the displaced backend, and skips closed ones — do not construct `SQLiteBackend` directly in new code; go through `create_backend()`.

**Test isolation:** `conftest.py` sets `FLASK_USER_1`/`FLASK_USER_2` at module level before any imports. The `db_instance` fixture is `scope='function'` and truncates all tables per test. The `app` fixture is `scope='session'` with a shared temp DB file.

**Encrypted binary format (client-side, `BKV3` only):** `BKV3 ‖ salt (16 bytes) ‖ iv (12 bytes) ‖ AES-GCM ciphertext`. Key derivation: `master = PBKDF2-SHA256(password, salt, 600k)`, `Kp = HKDF(master, salt, 'enc')`, `V = HKDF(master, salt, 'ver')`, `file_key = HKDF(Kp ‖ H, salt, 'file')` — `H` is the server share from `file_keys`, `V` the verifier sent on upload/release (both as hex). The plaintext is `BKP-FILE ‖ receipt(32B random) ‖ payload` — the receipt is the decryption proof reported back to `/report_decryption` (server stores only `SHA-256(receipt)` as `receipt_hash`). Legacy v1/v2 blobs are rejected — no backward compatibility (pre-production wipe).

**Key-release config:** the `KEY_RELEASE_*` and `KEY_SHARE_PENDING_TTL_SECONDS` settings, their defaults and what lockout does are in `docs/dev/configuration.md`.

**Type field:** DB entries have `type: 'file'` or `type: 'text'` (text notes). Text note content is base64-encoded encrypted data sent via form field `note_text`; file uploads use `multipart/form-data` with field `file`.

**AJAX detection:** Routes check `request.headers.get('X-Requested-With') == 'XMLHttpRequest'` to decide between JSON and redirect responses.

**CSRF on session-authed mutating routes:** every one checks the token, and only some exempt a request carrying an `Authorization` header. Which routes do, and how the token travels, is in `docs/dev/security.md` §CSRF.

**`sdk/` directory:** Contains a vendored copy of the Dagger Python SDK. No CI workflow uses it, and it is not part of the web application and should not be modified.

