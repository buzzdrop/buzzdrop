# HOWTO: implementing a new auth backend

| | |
|---|---|
| **Document version** | 1.0 |
| **Applies to** | the `auth/` architecture (`AUTH_BACKEND`) |
| **Goal** | add a backend (Okta / Auth0 / LDAP / a DB table) without changes to the rest of the application |

---

## 1. Architecture at a glance

```
app.py routes
      │
      ▼
decorators (login_required, api_auth_required, admin_required)
      │
      ▼
active_session_user()  ──►  backend.session_user(username, snapshot)
get_users()            ──►  backend.list_users()
/login                 ──►  backend.login(request)
/auth/session          ──►  backend.exchange(request)   (if supports_exchange)
      │
      └──────────► AuthBackend ◄────────── auth.create_backend(AUTH_BACKEND)
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   env_backend   clerk_backend    your_backend
```

The rule: the application **doesn't know** which backend is underneath. Everything
downstream of sign-in is an ordinary Flask session.

## 2. What a backend must do

Implement `auth.base.AuthBackend`:

- `name` — the `AUTH_BACKEND` value.
- `list_users()` — the `{'username': {'is_admin', 'email', 'display_name'}}`
  registry for `/users` and the API-token existence checks.
- `login(request)` — own `/login`, GET and POST. Render `login.html` with
  `auth_backend` set (the template switches on it), redirect to an IdP, or
  call `auth.session.start_session(profile)` and redirect to `index`.
- `session_user(username, snapshot)` — resolve the session per request;
  return `None` to drop it.
- Optionally: `supports_exchange = True` + `exchange(request)` for a
  credential → profile bridge at `POST /auth/session`; `after_logout()`
  for extra `/login` query args after `/logout`; `clear_caches()`.

Then register it in `auth._BACKENDS` (`'name': ('auth.your_backend', 'YourBackend')`),
add the config keys and validation (`config.py`), and document the env vars
(`.env.example`, `docs/dev/configuration.md`).

## 3. The details that bite

- **`username` is forever.** It is stored on drops (`uploaded_by`), dropzones
  (`created_by`) and API tokens. Prefer an immutable id over an email; put the
  human name in `display_name`.
- **`is_admin` live.** `session_user` runs per request — derive the flag there,
  not at sign-in, so admin changes apply without waiting out sessions.
- **CSP.** If your sign-in needs third-party origins, grant them through
  `g.csp_extra` inside `login()` (see `ClerkBackend.login`) — never widen the
  baseline.
- **Text.** `login.html` strings go through gettext (`docs/dev/i18n.md`);
  browser-side strings belong in a `templates/_<name>_strings.html` partial.
- **CSRF.** `POST /auth/session` predates the session, so it can't check a
  session CSRF token — the route requires `X-Requested-With` instead. If your
  exchange is a GET redirect (OIDC callback), add your own route and protect
  its `state` parameter like any other credential.

## 4. Tests

- `tests/contract/test_auth_backend_contract.py` runs every registered
  backend through the contract — it is parametrized by `auth._BACKENDS`
  keys, so yours is picked up automatically.
- env backend: the `conftest.py` users (`FLASK_USER_*`) cover it.
- External backends: stub the provider's HTTP at the module seam the way
  `tests/unit/test_clerk_auth.py` stubs `fetch_user`.
