# Security plumbing: SRI, auth, CSRF, API tokens

## Subresource Integrity (SRI)

The Flask context processor `sri_hash_processor` generates SHA-384 hashes for JavaScript files at runtime. Every `<script src>` tag carries `integrity` and `crossorigin` attributes, so the browser verifies the file before running it.

Those attributes cover only entry files. So `base.html` also renders a `<script type="importmap">` whose `integrity` section pins every module under `static/js` (`_module_import_map`). That is how imported modules such as `lib/crypto.js` get SRI.

- **Browser support:** import-map `integrity` needs Chromium 127+, Safari 18+ or Firefox 138+. Older browsers ignore the key and load the modules unchecked.
- **What it protects:** as with entry scripts, the hashes come from the server's own files. This catches tampering in transit and in caches, not on the server.
- **CSP:** the CSP allows that one inline block by its SHA-256, added per response by `set_security_headers`.
- **Imports:** the SRI above holds only for imports that follow `static/js/CLAUDE.md` §Import rules.

## Authentication (`auth/`)

`AUTH_BACKEND` picks the user source — a swappable-backend package like `db/` (`auth/CLAUDE.md`, `docs/howto-new-auth-backend.md`). The decorators and the session are the same under both.

- **`env` (default):** there is no users table: users come from the environment. Passwords are hashed with PBKDF2-SHA256 via Werkzeug. `get_users()` reads them and is `@lru_cache`d.

  - **The first admin:** `ADMIN_USERNAME` + `ADMIN_PASSWORD` (+ optional `ADMIN_EMAIL`) make one admin user. A deploy button sets the name and prompts for the password.
  - **More users:** each `FLASK_USER_N=username:password:is_admin[:email]` adds one user.

  The backend's `validate()` runs at startup and refuses a setup it can't run with. It names the variable to fix.

  - **Everywhere:**
    - an `ADMIN_USERNAME` that a `FLASK_USER_N` also uses;
    - an `ADMIN_EMAIL` that isn't an address.
  - **In production also:**
    - `ADMIN_USERNAME`/`ADMIN_PASSWORD` set only half or empty;
    - no admin at all (neither `ADMIN_*` nor a `FLASK_USER_N` admin).

  Outside production a half-set or empty admin is ignored, the half-set one with a warning. A malformed `FLASK_USER_N` is always only a warning. There is no password policy beyond "not empty".


Decorators:
- `@login_required`: checks the session for a username and redirects to `/login` without one
- `@json_login_required`: the same check for session-only routes the browser calls with `fetch` (`POST /api/token`, `/api/user/files/status`). Without a session it answers 401 JSON with `code: 'login_required'`, with no redirect and no flash. A route a form posts to keeps `@login_required`, even under `/api/`.
- `@admin_required`: checks both login and the admin flag
- `@api_auth_required`: accepts an `Authorization: Bearer <token>` header **or** the session cookie. An invalid Bearer gets 401 JSON, with no fallback to the session. With no Bearer and no session it refuses like `@json_login_required`, since the browser calls these routes with `fetch` too. On success it sets `flask.g.username`, so routes must read `g.username`, not `session['username']`.

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

`GET /healthz` is public on purpose as well: the image's `HEALTHCHECK` and hosts' health checks call it without a session. It has no rate limit and no CSRF gate (it is a GET that changes nothing). So that anyone may call it, it reveals only whether the database answers: `ok`, or 503 `unavailable`, with no version, config or error detail in the body. The failure is logged server-side.

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
