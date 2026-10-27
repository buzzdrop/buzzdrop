# auth

Sign-in behind a swappable-backend interface selected by `AUTH_BACKEND` (default `env`), like `db/` is selected by `DATABASE_URL`.

- `base.py` defines the `AuthBackend` contract and the *profile* dict shape.
- `env_backend.py` is the self-hosted default: `FLASK_USER_*` users, PBKDF2 passwords, the classic form POST on `/login`.
- `clerk_backend.py` delegates sign-in to Clerk: `clerk.js` mounts on `/login` and `POST /auth/session` bridges the session JWT into a Flask session. Operator setup: `docs/howto-clerk-auth.md`.
- `session.py` is the backend-agnostic half: `start_session`/`logout_user`, the per-request `active_session_user`, `get_current_user`, `get_users()`.
- `decorators.py` is `login_required`, `admin_required`, `api_auth_required` (+ `bearer_token`).
- `auth.create_backend(name)`/`get_auth_backend()` picks the backend — one instance per name, like `get_backend()` is per `DATABASE_URL`.

A new engine implements `AuthBackend`, registers a name in `auth._BACKENDS` and must pass `tests/contract/test_auth_backend_contract.py` (walkthrough: `docs/howto-new-auth-backend.md`).

## The contract, briefly

- **Profile** — what `start_session` stores: `{'username', 'display_name', 'email', 'is_admin'}`. `username` is the stable id that lands in `uploaded_by`, `created_by` and API-token ownership, so prefer an immutable id over an email.
- **`login(request)`** owns `/login` entirely — render, redirect, or `start_session` + redirect.
- **`exchange(request)`** is optional (`supports_exchange = True`): a credential → profile swap reached by `POST /auth/session`, which requires `X-Requested-With` (no session to ride yet, so no CSRF token to check) and shares `LOGIN_RATE_LIMIT`.
- **`session_user(username, snapshot)`** resolves the session each request — `snapshot` is the dict `start_session` kept. Read `is_admin` live where the backend allows it, so a deploy can grant or revoke without waiting out sessions.
- **`after_logout()`** — extra `/login` query args the `/logout` redirect carries.
- **`list_users()`** — the registry the admin's user list and API-token existence checks read, `{'username': {'is_admin', 'email', 'display_name'}}`.

Sessions carry `auth_backend`; one started under another backend is dropped. Sessions written before the split have no marker and are accepted by whichever backend is configured (test fixtures rely on this).
