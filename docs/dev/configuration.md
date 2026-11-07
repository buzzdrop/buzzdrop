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
- **Website:** `WEBSITE_URL` (default `https://buzzdrop.io`), the Website's base URL. Every link to it goes through `website_url(page)` (`website.py`), which adds the page's language prefix and that language's slug, e.g. `https://buzzdrop.io/pl/jak-to-dziala/` on a Polish page; a language the Website lacks gets English. `website.ROUTES` mirrors the Website's route table (`src/i18n/routes.ts` in `buzzdrop/website`): keep them in step. Today's links are all "How it works": the footer, the recipient's pages, the login page and the dead-end page an anonymous visitor sees. Unlike `SOURCE_CODE_URL`, an empty value hides every link to the Website and does not fall back to the default. The old `EXPLAINER_URL` is refused at startup.
- **Decryption reports:** `REPORT_DECRYPTION_RATE_LIMIT` (default `10 per minute`, per `file_id`).
- **Notifications** (uploader emails, sent once the recipient's decryption report arrives): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_USE_TLS`, `SMTP_USE_SSL`, `SMTP_TIMEOUT_SECONDS` (examples in `.env.example`). They are off unless both `SMTP_HOST` and `SMTP_FROM_EMAIL` are set.
  - `DEFAULT_TIMEZONE` (default `Europe/Warsaw`) is the zone of their times (root `CLAUDE.md`, *Timestamps are UTC*).
  - A subject never carries the filename: subjects show up in previews and provider logs.

## Deployment

**Passenger WSGI:** `passenger_wsgi.py` is the WSGI entry point, with PATH_INFO encoding fixes for production deployment.

**Docker:** the `Dockerfile` has two stages (#386). A plain `docker build .` builds `runtime`.

- **`runtime`** is published, deployed and driven by E2E.
  - It runs gunicorn from `gunicorn.conf.py`: 1 worker × 8 threads, because the rate limits and the sweep thread are per process (ADR-0003).
  - It runs as the non-root `app` user (uid 10001) and defaults to `FLASK_ENV=production`, `PORT=5000` and `DATABASE_URL=sqlite:///data/buzzdrop.db`. Without `FLASK_SECRET_KEY` and `TOKEN_HASH_SECRET` it refuses to start.
  - Its `HEALTHCHECK` polls `GET /healthz`, which answers `ok`, or 503 when the database doesn't answer.
  - It copies an **allowlist**: the root modules except `passenger_wsgi.py`, `db/`, `templates/`, `static/`, `translations/`, `gunicorn.conf.py` and `LICENSE`. A new root module must be added to the Dockerfile's `COPY` line, or the image fails to start (CI's E2E catches it).
- **`test`** is `runtime` plus `requirements-dev.txt`, `tests/`, `cli/` and what the tests read. It runs as root with `FLASK_ENV` empty. CI runs pytest, the DOM fixtures and the protocol contract in it.
- **More workers:** `workers` in `gunicorn.conf.py` outranks a host's `WEB_CONCURRENCY`. `GUNICORN_CMD_ARGS=--workers N` overrides it, but multiplies every rate limit by up to N.
- **Disk:** keep `data/` on a local disk, not NFS or another network filesystem. One-time release relies on SQLite's locking.

`docker-compose.yml` is the developer's compose and is for local work only, not for running Buzzdrop in production. It is a single service with the named volumes `buzzdrop-data` and `buzzdrop-uploads`, which take the image's ownership. Because the image runs production, `.env` needs `FLASK_ENV=development` for local work (or both secrets, to try the production config). Moving from the earlier `./data`/`./uploads` bind mounts means copying them into the volumes once, with the app stopped, owned by the app user:

```bash
docker compose run --rm --user root -v "$PWD/data:/old-data" -v "$PWD/uploads:/old-uploads" buzzdrop \
  sh -c 'cp -a /old-data/. /app/data/ && cp -a /old-uploads/. /app/uploads/ && chown -R app:app /app/data /app/uploads'
```

`.dockerignore` is a safety net under the allowlist. It keeps these out even inside a copied directory:
- secrets: `.env*` except the placeholder `.env.example`, and keys;
- local state: `*.db*`, `data/`, `uploads/`;
- dev clutter.

The CI `build` job plants a decoy for each secret/state pattern (its `DECOYS` list) and fails if one leaks into either image. Add a new pattern to both `.dockerignore` and `DECOYS`.

### Published image and versions

CI publishes the image to `ghcr.io/buzzdrop/buzzdrop` (public) for amd64 and arm64, each built on a native runner. The `publish` job in `ci.yml` calls `publish-image.yml` only after every other check has passed for the commit, and never for a pull request. The tags are a public contract that deploy configs depend on; the reasoning is in ADR-0002.

| Trigger | Tags | `BUZZDROP_VERSION` |
|---|---|---|
| push to `main` | `main`, `sha-<7>` | `main+<7>` |
| tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `latest` | `X.Y.Z` |

- A local `docker build` gets `BUZZDROP_VERSION=dev`.
- Each image carries the OCI labels `org.opencontainers.image.version`, `.revision` and `.source`, and the multi-arch index carries them as annotations.
- Each published index has a GitHub build-provenance attestation. Check it with `gh attestation verify oci://ghcr.io/buzzdrop/buzzdrop:<tag> -R buzzdrop/buzzdrop`.
- There is no moving `0` tag, and old `main`/`sha-*` images are kept.

**Cutting a version** (by hand). Versions are SemVer on `0.x`: a minor bump may break things, a patch never does.

1. On an up-to-date `main` whose CI is green, tag it and push the tag: `git tag v0.4.2 && git push origin v0.4.2`. Only `vX.Y.Z` tags publish; a pre-release suffix doesn't match.
2. CI runs again on the tag and publishes `0.4.2`, `0.4` and `latest`.
3. Publish a GitHub Release for the tag. Its notes always have a **Breaking changes** section, even when it says "None". Outside the GitHub Release itself, text for self-hosters says **version** (see `CONTEXT.md`).

The CLI is not versioned with the app: `release-cli.yml` keeps its own `cli-*` tags.

**First publish (one-off):** GHCR creates the package as private. An org owner sets `buzzdrop/buzzdrop` to **public** under the organisation's Packages → Package settings, and checks that it's linked to this repository with Actions write access.
