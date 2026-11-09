# HOWTO: running Buzzdrop with Clerk sign-in

| | |
|---|---|
| **Document version** | 1.0 |
| **Applies to** | `AUTH_BACKEND=clerk` (the `auth/` package, `auth/CLAUDE.md`) |
| **Goal** | have a Buzzdrop deployment where users sign in through Clerk, not `FLASK_USER_*` |

The `env` backend stays the self-hosted default. This doc is for a deployment
(SaaS, managed instance) that delegates accounts to Clerk. Backend internals:
`auth/clerk_backend.py` and `docs/dev/security.md` §Authentication.

---

## 1. Clerk dashboard setup

A free (Hobby) Clerk application covers this: no add-ons needed.

1. Create an application in the Clerk dashboard.
2. From **API Keys** take: the publishable key (`pk_test_…`/`pk_live_…`),
   the secret key (`sk_test_…`/`sk_live_…`) and the **Frontend API URL**
   (e.g. `https://your-app.clerk.accounts.dev`).
3. Optional but recommended: copy the **JWT public key** (API Keys →
   "Show JWT public key") for `CLERK_JWT_KEY` — session tokens then verify
   with no network call.
4. Sign-up policy is yours: Clerk defaults to open sign-up; Buzzdrop
   additionally gates admission with `CLERK_ALLOWED_USERS` (the Hobby plan
   has no hosted allowlist).
5. Production: a production Clerk instance wants its Frontend API on a
   subdomain of your domain (`clerk.example.com` via CNAME). Dev instances
   (`*.clerk.accounts.dev`) are capped at ~100 users and are fine for trying
   this out.

## 2. `.env`

```bash
AUTH_BACKEND=clerk
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
CLERK_FRONTEND_API_URL=https://clerk.example.com
CLERK_JWT_KEY=-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n
CLERK_AUTHORIZED_PARTIES=https://buzzdrop.example.com
CLERK_ADMIN_USERS=ops@example.com
# CLERK_ALLOWED_USERS=ops@example.com,second@example.com
```

- `CLERK_AUTHORIZED_PARTIES` lists the origins allowed in the session
  token's `azp` — set it in production (dev also needs its
  `http://localhost:PORT`). Empty accepts any `azp`.
- `CLERK_ADMIN_USERS` — CSV of Clerk user ids or emails; live-checked on
  every request.
- `CLERK_ALLOWED_USERS` — CSV of who may sign in at all; empty allows every
  Clerk-authenticated user.
- `CLERK_JS_VERSION` — clerk.js major pinned on the CDN path (default 5).

`FLASK_USER_*` are ignored under this backend.

## 3. What the flow looks like

```
/login ──► login.html mounts clerk.js SignIn (from CLERK_FRONTEND_API_URL)
                │
   Clerk issues a short-lived session JWT
                │
   page POSTs it to /auth/session (X-Requested-With)
                │
   server verifies RS256 (CLERK_JWT_KEY or the Frontend API JWKS,
   iss = FAPI, azp in CLERK_AUTHORIZED_PARTIES), fetches the user over
   the Backend API (CLERK_SECRET_KEY), applies CLERK_ALLOWED_USERS
                │
   start_session(profile) ──► ordinary Flask session ──► '/'
```

`/logout` clears the Flask session and lands on `/login?signed_out=1`,
where the page also signs Clerk out.

The Buzzdrop username is the Clerk user id (`user_…`) — stable across
email changes; `display_name` (Clerk username, name or email) is what the
UI shows. API tokens and `cli/buzz` are unchanged: a user generates a
token under `/users` and sends it as Bearer.

## 4. Verifying by hand

```bash
AUTH_BACKEND=clerk CLERK_PUBLISHABLE_KEY=pk_test_... \
CLERK_SECRET_KEY=sk_test_... \
CLERK_FRONTEND_API_URL=https://your-app.clerk.accounts.dev \
CLERK_AUTHORIZED_PARTIES=http://localhost:5000 \
python app.py
```

1. `/` redirects to `/login` and mounts the Clerk SignIn (dark theme).
2. Sign in as a dashboard user → land on `/`, the nav shows the display name.
3. `GET /login` response CSP lists the FAPI origin (script/connect/img),
   `challenges.cloudflare.com` (frame) and `worker-src blob:` — check
   DevTools has no CSP violations.
4. Logout → `/login?signed_out=1`, Clerk signed out too (SignIn shows again).
5. Admin: your email in `CLERK_ADMIN_USERS` → `/users` lists Clerk users
   (display names with the `user_…` id underneath) and token minting works.

Automated coverage: `tests/unit/test_clerk_auth.py` (JWT verify against a
local RSA keypair, allowlists), `tests/integration/test_clerk_login.py`
(bridge, logout, CSP), `tests/js/dom/login.test.js` (mount/bridge/sign-out
against a clerk.js stub), `tests/contract/test_auth_backend_contract.py`.
E2E keeps running the `env` backend.

## 5. Troubleshooting

| Symptom | Likely cause |
|---|---|
| "The sign-in service did not load" | clerk.js blocked (CSP, adblocker) or wrong `CLERK_FRONTEND_API_URL` |
| "Sign-in could not be completed" right after Clerk succeeds | token verification failed — `CLERK_JWT_KEY`/JWKS or `iss` mismatch; or the user fails `CLERK_ALLOWED_USERS` |
| 401 `auth_failed` on `/auth/session` | same as above; check the server log |
| Signed in, instantly back at `/login` | missing `user_snapshot` (stale session) — sign in again |
| Admin sees nobody on `/users` | `CLERK_SECRET_KEY` wrong, or Backend API unreachable |
| Token verify hits the network | `CLERK_JWT_KEY` unset — JWKS is fetched and cached |
| Everyone is admin / nobody is | `CLERK_ADMIN_USERS` matched by `user_…` id or email, case-insensitive |
