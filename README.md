<p align="center">
  <img src="docs/brand/logo.svg" alt="Buzzdrop Logo" width="180" />
</p>

<p align="center">
  <a href="https://github.com/buzzdrop/buzzdrop/actions/workflows/ci.yml">
    <img src="https://github.com/buzzdrop/buzzdrop/actions/workflows/ci.yml/badge.svg" alt="Build Status" />
  </a>
</p>

# Buzzdrop

One-time, self-destructing file and text sharing with client-side encryption. Files are encrypted in the browser before upload; each link works exactly once.

**How "one-time" works:** the ciphertext is served once and deleted. The decryption key is split — one half derives from the recipient's password, the other half (`H`) is held by the server and released exactly once, inside a single atomic transaction. A stolen ciphertext without `H` is not brute-forceable; password guessing only happens online, through a rate-limited, attempt-capped endpoint. Details: [docs/true-one-time.md](docs/true-one-time.md).

One honest caveat: "one-time" means no *second* read — nothing takes back what the recipient already saw, and nothing stops a malicious server operator.

## Features

- One-time links for files and secret text notes, with optional expiry
- Client-side AES-GCM encryption — the server never sees plaintext or the password
- Split key: password-derived half + one-shot server share `H`, released once
- One-click links (password in the URL fragment) or link + password separately
- Optional "notify me when opened" email with the decryption outcome
- `buzz` CLI for terminal uploads, API tokens for automation
- Local or S3 storage, SQLite by default with swappable DB backends

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install && npm run build:css   # compiled Tailwind CSS (committed; rebuild after changing styles)

cp .env.example .env               # set FLASK_SECRET_KEY and at least one FLASK_USER_N
python app.py
```

Open **http://127.0.0.1:5000** (Flask dev server binds to 127.0.0.1, not `localhost`).

Generate a secret key:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
# → FLASK_SECRET_KEY=<output> in .env
```

### Docker

```bash
docker-compose up --build
```

App on http://localhost:5000. Uploads and the SQLite database are volume-mounted to the host.

## Using it

1. Log in (users are configured via `FLASK_USER_N=username:password:is_admin[:email]` in `.env`).
2. Upload a file or write a secret text note. Set a password and optional expiry.
3. Share the link two ways:
   - **One-click link** — password embedded in the URL fragment (convenient)
   - **Link + password separately** — send them over different channels (safer)
4. The recipient opens the link, confirms, enters the password, decrypts in the browser. The drop is then gone — for everyone (no re-reads; what they already saw can't be un-seen).

Optional: enable "notify me when opened" to get one email with the decryption outcome. Requires SMTP settings in `.env` *and* an account email — the optional 4th field of `FLASK_USER_N` — otherwise the app refuses to enable it.

## `buzz` CLI

Terminal client that speaks the same protocol — encrypts locally, uploads via API token.

```bash
# Install the binary
curl -fsSL https://github.com/buzzdrop/buzzdrop/releases/latest/download/buzz -o ~/.local/bin/buzz
chmod +x ~/.local/bin/buzz

# Configure: ~/.buzz_token → {"token": "<api-token>", "server": "https://your-host"}
buzz file.pdf                  # generates a 6-word passphrase
buzz file.pdf -p mypassword
buzz file.pdf --expiry 2025-12-31T23:59+01:00   # expiry needs an explicit zone
```

Get an API token with `POST /api/token` (see below) — it's shown once. `buzz` refuses plain `http://` servers outside localhost unless you pass `--insecure`, and it aborts against a server that doesn't answer `/upload/begin`.

## API tokens

```bash
POST /api/token                  # any logged-in user for themselves; admins for anyone
GET  /api/tokens                 # list your tokens
POST /api/tokens/<id>/revoke
```

Body: `{"username": "name", "expires_in_days": 30}` → `{"token": "<64-hex>"}`, shown once. `expires_in_days` defaults to 30. Tokens are stored as PBKDF2-HMAC-SHA256 digests; the raw value is never persisted. In production `TOKEN_HASH_SECRET` is required and must differ from `FLASK_SECRET_KEY`. Admins can review and revoke tokens for any user on the **Manage Users** page.

## Storage and database

- `STORAGE_BACKEND=local` (files in `uploads/`) or `s3` (set `S3_*` vars in `.env`).
- `DATABASE_URL` selects the DB backend — default `sqlite:///buzzdrop.db`. Under Docker the DB lives in `./data`.
- Migrating an old `db.json`: `python migrate_db.py --source db.json --target buzzdrop.db`.

## Upgrading

Breaking changes from pre-production releases — nothing here is migrated, by design:

- Only `BKV3` shares decrypt; links created by older releases won't open.
- Legacy API tokens are rejected — generate replacements with `POST /api/token`.
- Old SHA-256 password hashes in `FLASK_USER_*` no longer work — set real passwords in `.env`.
- All timestamps are stored in UTC (#250). `expiry` must be sent as an ISO time with its zone (`2025-12-31T23:59+01:00` or `Z`) — a zoneless time gets a 400. Zoneless values written by earlier releases aren't migrated; they're read as UTC, so they can be off by the server's old offset until those drops are gone.

## Security notes

- Everything sensitive is encrypted client-side (AES-GCM, key split between password and a one-shot server share). The server stores only a verifier `V` it can't decrypt with — though a malicious admin could dictionary-attack `V`, so weak passwords stay weak.
- Wrong-password attempts are capped (`KEY_RELEASE_MAX_ATTEMPTS`, default 1); lockout burns the key share by default.
- `/release` and `/report_decryption` are rate-limited per file, not per IP. Buzzdrop deliberately ignores `X-Forwarded-For` (uses `request.remote_addr`) so a client can't spoof IPs to bypass limits — but that means behind a proxy without trusted-IP handling, `remote_addr` is the proxy and all users share one rate-limit bucket. Configure your proxy/deployment to pass real client IPs correctly.
- Client IPs of recipients are recorded (`downloaded_by_ip`) as a delivery audit trail — disclose this if IPs are personal data in your jurisdiction.
- All JS ships with SRI hashes; CSP, HSTS, `X-Frame-Options: DENY` and friends are set on every response.

Full protocol and threat-model documentation lives in [docs/](docs/) — especially `true-one-time.md` and `how-it-works.md`.

## Production checklist

1. Strong `FLASK_SECRET_KEY` and a separate `TOKEN_HASH_SECRET`.
2. Real passwords in `FLASK_USER_*` entries.
3. HTTPS via reverse proxy — HSTS assumes it; preserve real client IPs.
4. Review the limiter env vars (`LOGIN_RATE_LIMIT`, `API_TOKEN_RATE_LIMIT`, `UPLOAD_RATE_LIMIT`, `PUBLIC_FILE_RATE_LIMIT`, `KEY_RELEASE_RATE_LIMIT`, `REPORT_DECRYPTION_RATE_LIMIT`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_STORAGE_URI`) and layer nginx/Cloudflare/WAF limits on top.
5. If you run modified code, set `SOURCE_CODE_URL` to your own source — the AGPL-3.0 §13 footer link points users at it.
6. Optional: `STORAGE_BACKEND=s3` with scoped AWS credentials.

## Tests

```bash
pytest -v                    # Python unit + integration tests
npm run typecheck            # JSDoc type-checking of browser JS
npm run test:dom             # DOM/JS tests
npx playwright install chromium firefox webkit         # once, for E2E
docker build -t buzzdrop-e2e . && npx playwright test   # E2E (Playwright)
```

Regenerate committed JS fixtures after touching templates, `db/`, or protocol responses: `npm run fixtures`.

## License

Copyright (c) 2025 Łukasz Przybył

Buzzdrop is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License, version 3 only](LICENSE) as published by the Free Software Foundation.

If you run a modified version of Buzzdrop as a network service, AGPL §13 requires offering its users the corresponding source — set `SOURCE_CODE_URL` so the footer link points at it.
