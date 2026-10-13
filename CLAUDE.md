# CLAUDE.md

Buzzdrop is a one-time, self-destructing file-sharing Flask app.
- Files and text notes are encrypted in the browser.
- The server holds half the key and releases it exactly once.
- The ciphertext downloads once and is deleted.

## Working on issues

Never commit issue work to `main`. Before the first change, branch off an up-to-date `main` as `BD-<issue number>-<short-kebab-summary>` (e.g. `BD-188-note-success-page-wording` for #188) and commit there.

## Commands

```bash
python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
python app.py                      # local dev; or docker-compose build && docker-compose up
pytest -v                          # all Python tests; narrow with a path or ::test_name
npm run typecheck                  # JSDoc + tsc --checkJs over browser JS and JS tests (no build step; jsconfig.json; CI job js-fast)
npm test                           # JS unit + DOM tests
npm run fixtures                   # regenerate DOM fixtures + protocol contract
python translations/catalogs.py    # extract/update/compile gettext catalogs
```

CI fails while the DOM fixtures, the protocol contract or the catalogs are stale, or while a Polish entry is missing or fuzzy. The pre-commit hook in `.githooks/` (enabled by `npm install`) runs the catalogs and then the fixtures for commits that touch `templates/`, `db/`, `translations/` or the root Python modules. E2E (Playwright against the Docker image): `tests/CLAUDE.md`.

## Where things live

Each pointer names when to read it. Folder-level `CLAUDE.md` files load on their own when you work in that folder.

- **`app.py`** holds the routes, security headers and the expiry sweep. It is helped by `auth.py` (users, login decorators), `tokens.py` (API tokens), `storage.py` (local/S3 blobs, `STORAGE_BACKEND`), `i18n.py` (language selection; translate through it, not `flask_babel`), `timestamps.py`, `config.py`, `models.py` (`FileRepository`, the facade over `db/`'s `FileStore`) and `utils.py` (display timestamps, upload checks, client IP, orphan cleanup). `migrate_db.py` is a one-off TinyDB → SQLite migration.
- **Share protocol**, i.e. the crypto, `/upload*`, `/view`, `/release`, `/download`, `/report_decryption`, expiry and the file lifecycle → `docs/dev/share-protocol.md`. The design rationale is in `docs/true-one-time.md` §6.
- **Database** (`files`, `api_tokens`, `file_keys`, adding a backend) → `db/CLAUDE.md`.
- **User-facing text**, i.e. any template or flash text, JS-written text, a JSON error the UI shows, or a new language → `docs/dev/i18n.md`.
- **Auth, CSRF, API tokens, SRI/import map/CSP**, whenever you add a route or a script → `docs/dev/security.md`.
- **Env vars, Docker, `.dockerignore`, Passenger** → `docs/dev/configuration.md`.
- **Browser JS** (`static/js/`: layers, import rules, text) → `static/js/CLAUDE.md`.
- **Tests** (fixtures, JS test spec, protocol fake, E2E) → `tests/CLAUDE.md`.
- **CLI** (`cli/buzz`) → `cli/CLAUDE.md`.

## Invariants

- **Timestamps are UTC** (`timestamps.py`, #250). Write every stored time with `now_iso()`/`to_utc_iso()`: ISO 8601 with `+00:00`, always with microseconds, because the SQL text comparisons depend on it. Compare against `utcnow()`. Never use a naive `datetime.now()`.
  - `parse_timestamp` reads a value with no offset as UTC. Zoneless values from older versions are deliberately not migrated (a pre-production break, like BKV3).
  - The server renders its own text in UTC. The index page script (`features/shared-files`) shows local times with `Intl` from the `<field>_iso` twins. `DEFAULT_TIMEZONE` is used for notification emails only.
- **`BKV3` is the only share format.** Legacy formats are rejected. This is a deliberate pre-production break, with no backward compatibility.
- **JSON responses stay English.** An error the web UI may show carries a stable `code` that the browser maps to its own text.
- **Protocol contract — keep in step.** When a response of `/upload/begin`, `/upload`, `/download`, `/release` or `/report_decryption` changes (its status, its body or the condition that triggers it), the JS protocol fake must follow. The steps are in `tests/CLAUDE.md` §Protocol contract.
- **Explainer page — keep in step.** `docs/how-it-works.md` is the source of truth for `/how-it-works` and the landing-page walkthrough.
  - A change to the upload/view/release/download/expiry flow, the crypto, what is stored or how long it is kept must update the doc and the page in the same PR, or the PR must say that neither is affected.
  - `tests/unit/test_how_it_works_fingerprint.py` fails until someone has re-read both and pasted the new hash.
  - Page layout and its other checks: `docs/dev/share-protocol.md` §Explainer page.
