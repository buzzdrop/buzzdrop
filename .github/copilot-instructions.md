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

**File lifecycle:**
1. Browser calls `POST /upload/begin` → server mints `{file_id, h}` (random 32-byte share, hex); a pending row lands in the `file_keys` table
2. Browser derives `file_key = HKDF(Kp ‖ H)`, encrypts plaintext `BKP-FILE ‖ receipt(32B) ‖ data`, then `POST /upload` with `file_id` + `key_verifier` (hex verifier V) + `receipt_hash` (SHA-256 of the receipt) → V is bound to the pending share atomically (owner-checked via `created_by`, 403 for another account), blob stored (local path or S3 key), `files` entry created: `status: active`, `downloaded_at: null`
3. Recipient visits `/view/<id>` → confirms → `/view/<id>/confirm` renders the decryption UI with the BKV3 envelope salt in the page config; no ciphertext is downloaded yet, and opening the link burns nothing
4. Browser derives V from the password and `POST /release/<id>` `{v}` → `attempt_key_release` runs the whole read/compare/count/release in ONE transaction, returns `h` exactly once and stores `SHA-256(ticket)` (wrong V → 403; after release or expiry → 410; the locking attempt → 429; missing/pending/burned → 404). Misses increment `file_keys.attempts`; lockout at `KEY_RELEASE_MAX_ATTEMPTS` (with `KEY_RELEASE_BURN_ON_LOCKOUT` — the default — the row — and H — is deleted). `/release` is rate-limited per file_id, not per IP
5. Browser derives the download ticket `HKDF-SHA256(ikm=H, info='buzzdrop-download-ticket')` and fetches `/download/<id>` with `X-Download-Ticket` → `claim_download_with_ticket` verifies it, sets `downloaded_at` and consumes the ticket in one transaction; the ciphertext streams once and is deleted from storage (403 for an unreleased share, 410 without the winner's ticket or after `KEY_RELEASE_DOWNLOAD_TTL_SECONDS`)
6. Browser derives `file_key`, decrypts client-side and posts the embedded `receipt` to `/report_decryption` — the server validates it against `receipt_hash` and the NULL-guarded write lets only the first valid report set `decryption_success`. A share released but never downloaded is terminal and expires after `KEY_RELEASE_DOWNLOAD_TTL_SECONDS`
7. Optional expiry: `check_and_handle_expiry()` marks `status: expired`, deletes storage file, and burns the `file_keys` row in the same transaction

The full protocol, with every route's answers, is in `docs/dev/share-protocol.md`.

**Storage abstraction:** `get_storage_backend(config)` returns either `LocalStorage` or `S3Storage`. Both expose `save(file_id, file_data) -> path`, `retrieve(path) -> Iterator[bytes]`, `delete(path)` and `read_prefix(path, length)`. The `path` stored in DB is a local filesystem path for local storage and an S3 key (`uploads/{uuid}`) for S3.

**API token auth:** `POST /api/token` (admin-only, JSON `{"username": "..."}`) issues a raw token shown once. The `@api_auth_required` decorator on `/upload` and `/upload/begin` accepts either `Authorization: Bearer <token>` or a session cookie. When a Bearer header is present and invalid → 401 JSON (no session fallback). On success it sets `flask.g.username`; routes read `g.username` not `session['username']`. Tokens are stored as PBKDF2-HMAC-SHA256 digests in the `api_tokens` table via `TokenStore` — never the raw token.

**`buzz` CLI** (`cli/buzz`): encrypts a file with the same `BKV3` format as the browser and runs the same two-phase upload (`/upload/begin` → `/upload`); aborts if begin 404s. Uploads via Bearer token. Reads `~/.buzz_token` as JSON `{"token": "...", "server": "https://..."}`. Requires `cryptography` and `requests` (see `requirements-cli.txt`). Generates a 6-word passphrase if `-p` is omitted.

All `<script>` tags must include `integrity="{{ sri_hash('js/filename.js') }}" crossorigin="anonymous"`; modules they import get SRI from the import map in `base.html` (`_module_import_map`), so every import is a relative specifier under `static/js` (see `docs/dev/security.md`). In development, missing files raise `FileNotFoundError`; in production they log a warning.

## Key Conventions

**Users are environment variables, not a database.** Format: `FLASK_USER_N=username:password:is_admin`. `get_users()` in `auth.py` is decorated with `@lru_cache` — it hashes passwords on first call. In tests, **clearing and re-adding `FLASK_USER_*` env vars requires calling `get_users.cache_clear()`** or the cached result will be stale.

**`FileRepository` resolves its store lazily.** When initialized without a `files_store` argument (the default), the `store` property calls `from app import get_files_store` at access time, which respects the current Flask app context. Tests that supply a store directly bypass this.

**`get_backend()` recreates backends on config change.** It compares the canonicalized `DATABASE_URL` against `backend.url`, closes the displaced backend, and skips closed ones — do not construct `SQLiteBackend` directly in new code; go through `create_backend()`.

**Test isolation:** `conftest.py` sets `FLASK_USER_1`/`FLASK_USER_2` at module level before any imports. The `db_instance` fixture is `scope='function'` and truncates all tables per test. The `app` fixture is `scope='session'` with a shared temp DB file.

**Encrypted binary format (client-side, `BKV3` only):** `BKV3 ‖ salt (16 bytes) ‖ iv (12 bytes) ‖ AES-GCM ciphertext`. Key derivation: `master = PBKDF2-SHA256(password, salt, 600k)`, `Kp = HKDF(master, salt, 'enc')`, `V = HKDF(master, salt, 'ver')`, `file_key = HKDF(Kp ‖ H, salt, 'file')` — `H` is the server share from `file_keys`, `V` the verifier sent on upload/release (both as hex). The plaintext is `BKP-FILE ‖ receipt(32B random) ‖ payload` — the receipt is the decryption proof reported back to `/report_decryption` (server stores only `SHA-256(receipt)` as `receipt_hash`). Legacy v1/v2 blobs are rejected — no backward compatibility (pre-production wipe).

**Key-release config:** `KEY_RELEASE_RATE_LIMIT` (10/min per file_id), `KEY_RELEASE_MAX_ATTEMPTS` (1), `KEY_RELEASE_BURN_ON_LOCKOUT` (default on — lockout deletes the `file_keys` row, H+V destroyed; off keeps the row but permanently refuses releases — currently no unlock path), `KEY_SHARE_PENDING_TTL_SECONDS` (default 3600 — stale pending shares swept at startup and on `/upload/begin`), `KEY_RELEASE_DOWNLOAD_TTL_SECONDS` (default 600 — the download ticket is honoured that long after release; a release nobody downloaded expires and the expiry sweep deletes its blob). `/upload/begin` and `/upload` share the `UPLOAD_RATE_LIMIT` bucket. SQLite runs `PRAGMA secure_delete=ON` + WAL `TRUNCATE` checkpoint after burns.

**Type field:** DB entries have `type: 'file'` or `type: 'text'` (text notes). Text note content is base64-encoded encrypted data sent via form field `note_text`; file uploads use `multipart/form-data` with field `file`.

**AJAX detection:** Routes check `request.headers.get('X-Requested-With') == 'XMLHttpRequest'` to decide between JSON and redirect responses.

**CSRF on session-authed mutating routes:** `_session_csrf_required()` gates `POST /upload`, `/upload/begin`, `/logout` and `/api/token`; the session-only form routes (`/delete/<id>`, `/view/<id>/confirm`, `/api/tokens/<id>/revoke`, `/language`) call `_is_valid_csrf_token()` directly. The token travels as `X-CSRF-Token` header, `csrf_token` form field, or JSON field; templates render `<meta name="csrf-token">` (JS reads it in `static/js/features/csrf/`) and hidden form inputs. Under `_session_csrf_required()` only, requests carrying an `Authorization` header are exempt — cross-site requests can't set it, so Bearer clients are CSRF-immune. Public POSTs (`/release`, `/report_decryption`) have no CSRF gate by design.

**`sdk/` directory:** Contains a vendored copy of the Dagger Python SDK. No CI workflow uses it, and it is not part of the web application and should not be modified.

**CLI binary releases:** Pushing to `main` with changes under `cli/` or `requirements-cli.txt` triggers `.github/workflows/release-cli.yml`, which builds a PyInstaller single-file binary and publishes it to GitHub Releases automatically.
