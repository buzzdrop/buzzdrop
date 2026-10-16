# Security plumbing: SRI, auth, CSRF, API tokens

## Subresource Integrity (SRI)

The Flask context processor `sri_hash_processor` generates SHA-384 hashes for JavaScript files at runtime. Every `<script src>` tag carries `integrity` and `crossorigin` attributes, so the browser verifies the file before running it.

Those attributes cover only entry files. So `base.html` also renders a `<script type="importmap">` whose `integrity` section pins every module under `static/js` (`_module_import_map`). That is how imported modules such as `lib/crypto.js` get SRI.

- **Browser support:** import-map `integrity` needs Chromium 127+, Safari 18+ or Firefox 138+. Older browsers ignore the key and load the modules unchecked.
- **What it protects:** as with entry scripts, the hashes come from the server's own files. This catches tampering in transit and in caches, not on the server.
- **CSP:** the CSP allows that one inline block by its SHA-256, added per response by `set_security_headers`.
- **Imports:** the SRI above holds only for imports that follow `static/js/CLAUDE.md` §Import rules.

## Authentication (`auth.py`)

There is no users table: users come from `.env` as `FLASK_USER_N=username:password:is_admin`. Passwords are hashed with PBKDF2-SHA256 via Werkzeug. `get_users()` reads every `FLASK_USER_*` variable and is `@lru_cache`d.

Decorators:
- `@login_required`: checks the session for a username
- `@admin_required`: checks both login and the admin flag
- `@api_auth_required`: accepts an `Authorization: Bearer <token>` header **or** the session cookie. An invalid Bearer gets 401 JSON, with no fallback to the session. On success it sets `flask.g.username`, so routes must read `g.username`, not `session['username']`.

## CSRF

Every session-authed mutating route checks the CSRF token. `_is_valid_csrf_token()` accepts it via the `X-CSRF-Token` header, a `csrf_token` form field or a JSON field. JS clients read the token from `<meta name="csrf-token">` in `base.html` (`static/js/features/csrf/`); forms carry it as a hidden `csrf_token` input.

These routes call `_session_csrf_required()`, which exempts any request carrying an `Authorization` header: cross-site requests can't set one, so the Bearer clients of `/upload` and `/upload/begin` are immune to CSRF. `/logout` and `/api/token` accept no Bearer token but get the same exemption.
- `/upload` and `/upload/begin`
- `/logout`
- `/api/token`
- `/api/dropzones` (POST)
- `/dropzones/<id>/release`
- `/dropzones/<id>/delete`

These routes call `_is_valid_csrf_token()` directly, with no `Authorization` exemption:
- `/delete/<id>`
- `/view/<id>/confirm`
- `/api/tokens/<id>/revoke`
- `/language` (see `docs/dev/i18n.md`)

The public unauthenticated POSTs (`/release`, `/report_decryption`) intentionally have no CSRF gate. The dropzone's public POSTs get the same treatment: `/dropzone/<id>/submit` (the responder needs no session; its credential is the request link's `sv` verifier) and `/dropzones/<id>/report` (its credential is the plaintext receipt, as on `/report_decryption`). Both are rate-limited per `dropzone_id` for the same reason `/release` is per `file_id` — a cross-site POST can do no more than the public flow already allows.

The remaining dropzone routes are `@api_auth_required` (Bearer token or session cookie): `GET /api/dropzones`, `GET /api/dropzones/<id>` and `GET /dropzones/<id>/submission`. All of them, and the mutating dropzone routes above, answer 404 unless the zone's `created_by` is the caller.

## API tokens (`tokens.py`)

- `generate_api_token(username)` stores a PBKDF2-HMAC-SHA256 fingerprint in the `api_tokens` table and returns the raw 64-character token, which is shown once.
- `validate_api_token(raw_token)` returns the username or None, and updates `last_used_at`.
- `revoke_api_token(raw_token)` removes the entry.

An admin generates a token with:

```bash
POST /api/token
Content-Type: application/json
{"username": "targetuser"}
# Response: {"token": "<64-char hex>"}  ← store immediately, never shown again
```
