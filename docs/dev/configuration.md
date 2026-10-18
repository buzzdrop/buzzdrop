# Configuration and deployment

## Environment variables (`.env`)

- **Users:** `FLASK_USER_N=username:password:is_admin` (see `docs/dev/security.md`)
- **Storage:** `STORAGE_BACKEND` (`local`: files in `UPLOAD_FOLDER` with UUID names; `s3`: under `uploads/{uuid}` keys, `storage.py`), `UPLOAD_FOLDER`
- **S3:** `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`
- **Limits:** `MAX_CONTENT_LENGTH` (default 100 MB), `ALLOWED_EXTENSIONS`
- **Session cookies:**
  - `SESSION_COOKIE_SECURE`: default true, but false in development/testing, since dev runs over HTTP
  - `SESSION_COOKIE_HTTPONLY`: default true
  - `SESSION_COOKIE_SAMESITE`: default `Lax`
  - `PERMANENT_SESSION_LIFETIME`: seconds, default 28800
- **Secrets:** `TOKEN_HASH_SECRET` is required in `FLASK_ENV=production` and must differ from `FLASK_SECRET_KEY`. Dev falls back to `FLASK_SECRET_KEY`.
- **Database:** `DATABASE_URL`. The deprecated `DATABASE_PATH` maps to a `sqlite:///` fallback.
- **Languages:** `DEFAULT_LANGUAGE` (default `en`) and `LANGUAGES` (default `en,pl`). Startup fails if the default isn't listed, or if a listed language other than `en` has no compiled catalog.
- **Key release** (semantics in `docs/dev/share-protocol.md`):
  - `KEY_RELEASE_RATE_LIMIT`: default `10 per minute`, per `file_id`
  - `KEY_RELEASE_MAX_ATTEMPTS`: default 1
  - `KEY_RELEASE_BURN_ON_LOCKOUT`: default on. Lockout deletes the `file_keys` row, destroying H and V. Off keeps the row but permanently refuses releases; there is currently no unlock path.
  - `KEY_SHARE_PENDING_TTL_SECONDS`: default 3600, the TTL for shares that were begun but never finished
  - `KEY_RELEASE_DOWNLOAD_TTL_SECONDS`: default 600. How long after a successful release the download ticket is honoured; afterwards the drop expires.
- **Dropzones** (`docs/adr/0001`, semantics in `docs/dev/share-protocol.md`):
  - `DROPZONE_SUBMIT_RATE_LIMIT`: default `30 per hour`, per `dropzone_id`
  - `DROPZONE_RELEASE_RATE_LIMIT`: default `10 per minute`, per `dropzone_id`
  - `DROPZONE_MAX_ATTEMPTS`: default 3
  - `DROPZONE_BURN_ON_LOCKOUT`: default off. Gentler than `KEY_RELEASE_*` on purpose: a locked zone strands a submission the responder can never re-send (their request link is already consumed). On wipes `v`/`ws`/`sv`; off keeps them but permanently refuses releases.
  - `DROPZONE_COLLECT_TTL_SECONDS`: default 600. How long after a successful release the submission stays collectable; afterwards the zone expires and the sweep deletes the blob.
- **Source code:** `SOURCE_CODE_URL` (default: the upstream GitHub repo; empty falls back to it). It is used for every repository link on the site, including the AGPL-3.0 §13 footer link. A deployment running modified code must point it at its own source.
- **Decryption reports:** `REPORT_DECRYPTION_RATE_LIMIT` (default `10 per minute`, per `file_id`).
- **Notifications** (uploader emails, sent once the recipient's decryption report arrives): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_USE_TLS`, `SMTP_USE_SSL`, `SMTP_TIMEOUT_SECONDS` (examples in `.env.example`). They are off unless both `SMTP_HOST` and `SMTP_FROM_EMAIL` are set.
  - `DEFAULT_TIMEZONE` (default `Europe/Warsaw`) is the zone of their times (root `CLAUDE.md`, *Timestamps are UTC*).
  - A subject never carries the filename: subjects show up in previews and provider logs.

## Deployment

**Passenger WSGI:** `passenger_wsgi.py` is the WSGI entry point, with PATH_INFO encoding fixes for production deployment.

**Docker:** a single-service compose with volume mounts for `uploads/` and `buzzdrop.db` persistence.

The `Dockerfile` copies the whole context, so `.dockerignore` keeps these out of the image:
- secrets: `.env*` except the placeholder `.env.example`, and keys;
- local state: `*.db*`, `data/`, `uploads/`;
- dev clutter.

`tests/`, `docs/` and `cli/` stay in, because CI runs pytest inside the image.

The CI `build` job plants a decoy for each secret/state pattern (its `DECOYS` list) and fails if one leaks into the image. Add a new pattern to both `.dockerignore` and `DECOYS`.
