# Share protocol: crypto, routes, lifecycle

The engineering reference for how a drop is encrypted, uploaded, released and downloaded — and for the dropzone, its reversed mirror ("send it to me, securely"), where an anonymous responder submits into a user's one-time zone and the requester collects once (`docs/adr/0001-dropzone-reverse-flow.md`). The reasoning behind the design is `docs/true-one-time.md` §6; the user-facing account is `docs/how-it-works.md`. The tables behind it are in `db/CLAUDE.md`.

Two wire formats exist: **BKV3** is the envelope for drops, **BKD1** is the envelope for dropzone submissions. Everything else is rejected.

## Client-side encryption

Files are encrypted in the browser with the Web Crypto API (`static/js/lib/crypto.js`, driven through `static/js/features/share-protocol/` by `pages/index/index-page.js`) under a **server-gated key release** scheme. The file key is split. One half derives from the password. The other half, `H` (32 random bytes), lives in the `file_keys` table and is released exactly once. So a stolen ciphertext alone cannot be brute-forced offline.

### Upload (always two-phase)

1. `POST /upload/begin` → server mints `file_id` and a random share `H`, returns `{file_id, h}` (H as hex)
2. `master = PBKDF2-SHA256(password, salt, 600k)`; `Kp = HKDF(master, salt, 'enc')`, `V = HKDF(master, salt, 'ver')`
3. `file_key = HKDF(Kp ‖ H, salt, 'file')`; plaintext is `BKP-FIL2 ‖ receipt(32B random) ‖ name_len(2B BE) ‖ name(utf-8) ‖ data` (the receipt is the decryption proof — the server stores only its SHA-256; the name is the original filename, which reaches the recipient only through the ciphertext, #246), then AES-GCM encrypted
4. Envelope: `BKV3 ‖ salt(16) ‖ iv(12) ‖ ciphertext`, uploaded with `file_id` + `key_verifier` (hex V) + `receipt_hash` — the server binds V to the pending share atomically (only the account that ran `begin` may finish: `created_by` check, 403 otherwise)

### Decryption: password first, ciphertext second

In `static/js/pages/view/view-page.js` (`initView`), through `features/share-protocol` (`claimShare`); see `docs/true-one-time.md` §6.4.

The server renders the BKV3 envelope salt into the view page config, so nothing is downloaded up front. The salt is stored on the `file_keys` row at `/upload`; shares bound before that fall back to `storage.read_prefix` of the blob.

1. The client derives `V` from the password, one PBKDF2 per attempt: `openSalted(salt).unlock(password)` keeps `Kp` for `finish(h, blob)`.
2. `POST /release/<file_id>` `{v}` → the server returns `H` exactly once. The whole read→check→count→release cycle is one transaction, `attempt_key_release`, which also stores `SHA-256(ticket)`.
3. The client derives the download ticket `HKDF-SHA256(ikm=H, info='buzzdrop-download-ticket')`. The ticket is never stored raw and never sent in a response.
4. The client fetches the ciphertext from `/download/<file_id>` with `X-Download-Ticket`, with progress from `Content-Length`. `finish` checks that the blob's salt matches the page's.
5. The client derives `file_key`, decrypts, extracts the receipt and reports it to `/report_decryption`. That route validates `SHA-256(receipt)` and writes `decryption_success` once (the first valid report wins).

## Routes

- `/upload/begin` (POST): Mints `file_id` + server share `H` for the two-phase key-release upload. Shares the `UPLOAD_RATE_LIMIT` bucket with `/upload`. Sends `Cache-Control: no-store`, since the response carries H
- `/upload` (POST): Completes the key-release upload.
  - Requires the `file_id`, `key_verifier` and `receipt_hash` form fields.
  - Refuses to finish another account's share (403).
  - Refuses an `expiry` that isn't an ISO time with a zone (400, `timestamps.parse_expiry`). The check runs before the bind, so the share can retry. The browser sends `Date.toISOString()`.
  - Binds V to the pending share atomically, stores the encrypted blob and returns the share link. On a storage or DB failure the pending share is burned.
- `/view/<file_id>` (GET): Shows the download confirmation page.
  - A drop that was already opened, released (even if never downloaded), expired, never bound or never existed gets one uniform 404 "This drop is gone" page (`_drop_gone`, `templates/error.html`). The same applies on `/view/<file_id>/confirm`, so the page doesn't reveal which case it is. `/download/<id>` still flashes the specific reason.
  - Unknown URLs and server errors render the same template (`handle_not_found`/`handle_server_error`; JSON for API clients).
- `/view/<file_id>/confirm` (POST): Shows the decryption interface, with the envelope salt in the page config
- `/download/<file_id>` (GET): Serves the ciphertext once, and only to the release winner.
  - Requires `X-Download-Ticket`. `claim_download_with_ticket` verifies the digest (constant-time), stamps `downloaded_at` and consumes the ticket in one `BEGIN IMMEDIATE` transaction. Then the blob streams (with `Content-Length`) and is deleted.
  - Answers: 403 for a live unreleased share (a bare `Forbidden`, no `code`); 410 `code: 'claimed'` for a released share without the winner's ticket; 410 `code: 'expired'` once `KEY_RELEASE_DOWNLOAD_TTL_SECONDS` have passed since the release or the drop's expiry; 410 `code: 'opened'` once downloaded; 404 `code: 'not_found'` when missing. An XHR gets JSON (`DOWNLOAD_REFUSALS`); a plain request gets a flash + redirect. The page reads an `expired` 410 as gone, like `/release`'s, and any other 410 as already opened.
  - The ticket is consumed before the body streams, so a broken-off transfer cannot be resumed. This is deliberate: there is no re-download surface.
- `/release/<file_id>` (POST): Server-gated key release. JSON `{v}` → `{h}` on a constant-time match inside one atomic `attempt_key_release` transaction.
  - Answers: 403 on a wrong verifier; 410 after release or expiry (an expiry's carries `code: 'expired'`); 429 on the attempt that locks the share (no `code`, unlike the rate limit's 429 with `code: 'rate_limited'`); a uniform 404 when the file or share is missing, pending or burned. So with burn-on-lockout, calls after the lockout get 404.
  - Misses increment `attempts`; lockout comes at `KEY_RELEASE_MAX_ATTEMPTS` (burn is optional).
  - Rate-limited per `file_id`, not per IP. Sends `Cache-Control: no-store`.
- `/report_decryption/<file_id>` (POST): Records whether client-side decryption succeeded. Requires the plaintext `receipt` matching the stored `receipt_hash` (403 otherwise), and only the first valid report takes effect. Unauthenticated but rate-limited per `file_id` via `REPORT_DECRYPTION_RATE_LIMIT`
- `/delete/<file_id>` (POST): Manual deletion by the uploader (also drops the `file_keys` row)
- `/how-it-works` (GET): Public explainer of the share flow (see *Explainer page* below). `?sender=web|cli&content=file|text` picks the view; CLI + text falls back to file until the CLI can send notes (#247)
- `/language` (POST): see `docs/dev/i18n.md`

## File lifecycle

The steps under *Client-side encryption* are the flow. This is the state each one leaves behind.

- **Begin:** a pending `file_keys` row.
- **Upload:** V bound, the blob stored (local/S3), and a `files` row with `status: active`. The share link is `/view/{uuid}`.
- **Opening and confirming the link** burns nothing.
- **Wrong passwords** consume `attempts`. Lockout comes at `KEY_RELEASE_MAX_ATTEMPTS`; what it does to the row depends on `KEY_RELEASE_BURN_ON_LOCKOUT` (`docs/dev/configuration.md`).
- **Download:** `downloaded_at` set, the ticket consumed, the blob deleted. The browser then decrypts and saves the file.
- **Released but never downloaded** is terminal: `/view` shows the "drop is gone" page, and after `KEY_RELEASE_DOWNLOAD_TTL_SECONDS` the drop expires and the sweep deletes the blob.
- **Expiry:** files with `expiry_at` are auto-deleted by `check_and_handle_expiry()`. It also burns the `file_keys` row inside the same transaction, so H never outlives the file.

## Dropzone protocol

The reversed flow (`docs/adr/0001-dropzone-reverse-flow.md`): a requester creates a one-time dropzone, an anonymous responder submits into it, the requester proves the dropzone password and collects once. There is no server-held key share like `H`; the server only stores wrapped secrets. The crypto lives in `static/js/lib/dropzone-crypto.js` (driven by `pages/respond/` for the responder and the dropzones section of `pages/index/` for the requester).

### Creation (requester)

1. The browser draws a random dropzone secret `s` (32B) and a salt, then the BKV3 ladder from the dropzone password: `master = PBKDF2-SHA256(password, salt, 600k)`, `Kw = HKDF(master, salt, 'dz-wrap')`, `V = HKDF(master, salt, 'ver')`.
2. `wS = AES-GCM(Kw, s)`; `SV = HKDF(s, 'submit')` — proof of request-link possession, one-way over a random secret so not offline-crackable like `V`.
3. `POST /api/dropzones` `{salt, ws, v, sv, expiry, notify_on_submission, notification_email, memo}` → `{dropzone_id}`. The server stores those and never sees `s` or the password.
4. The browser assembles the request link `/dropzone/<id>#s=<hex>`: `s` rides in the fragment and never reaches the server. One zone, one link — a dead link means a new dropzone.

### Submission (responder)

1. `GET /dropzone/<id>` renders the respond page while the zone is live; a missing, consumed or expired zone gets the same uniform "drop is gone" page a dead drop link gets, so the page reveals nothing about which.
2. The responder's browser draws a fresh random `K` and encrypts `BKP-FIL2 ‖ receipt(32B) ‖ name_len(2B BE) ‖ name ‖ data` under AES-GCM — the BKV3 inner layout, but a **BKD1** envelope (`BKD1 ‖ iv(12) ‖ ciphertext`): BKV3's salt exists to feed the password KDF and a random `K` has nothing to derive from it. Then `wK = AES-GCM(s, K)`. Wrapped keys travel as `iv(12) ‖ ct` in hex.
3. `POST /dropzone/<id>/submit` (`file` or `note_text`, plus `type`, `wk`, `receipt_hash`, `sv`). The server constant-time compares `sv` to the stored `SV` **before** consuming the link, in the `consume_for_submission` transaction, so a bare `dropzone_id` from logs can't burn the zone and racing submissions get exactly one winner. A rejected `sv` leaves the link alive.

### Collection (requester)

1. `GET /api/dropzones/<id>` returns the zone's salt (so the browser can derive `V`) and the submission's `wk`/`type` — the same role as the salt rendered into the view page.
2. `POST /dropzones/<id>/release` `{v}` → `{ws}` on a constant-time match inside `attempt_dropzone_release`, released exactly once with `v`/`ws`/`sv` wiped in the same transaction. Misses increment `attempts`; lockout at `DROPZONE_MAX_ATTEMPTS` (burn optional via `DROPZONE_BURN_ON_LOCKOUT`, default off — a locked zone strands a submission the responder can't re-send, so it's gentler than `KEY_RELEASE_*`). The winner is an authenticated session, but the claim still carries a collect ticket derived from `wS` (like `/download`'s `X-Download-Ticket`) so a bare URL can't burn it, not an anonymous link holder.
3. `GET /dropzones/<id>/submission` claims the blob in `collect_dropzone_submission` (stamps `collected_at`/`collected_by_ip`) before streaming it once; a broken-off transfer can't resume. The browser unwraps `s`, unwraps `K`, decrypts, and posts the receipt to `POST /dropzones/<id>/report`, which validates `SHA-256(receipt)` against the stored `receipt_hash` and writes `decryption_success` once.

### Routes

- `/dropzone/<id>` (GET): the responder's page. Uniform "gone" page for missing/consumed/expired zones; shares the `PUBLIC_FILE_RATE_LIMIT` bucket with `/view`.
- `/dropzone/<id>/submit` (POST): the responder's one shot, gated on `sv`. Rate-limited per `dropzone_id` via `DROPZONE_SUBMIT_RATE_LIMIT`. Checks the blob's `BKD1` magic before storing; a refused consume deletes the blob again.
  - Answers (`code` in `SUBMIT_REFUSALS`): 404 `not_found`; 403 `invalid_link` on a bad `sv`; 410 `consumed` once the link is used; 410 `expired`; 400 `invalid_submission` for a missing/invalid field or non-BKD1 blob.
- `/api/dropzones` (POST): creates the zone (`created_by` = the authed user; shares the `UPLOAD_RATE_LIMIT` bucket) and (GET) lists the caller's zones for the index section and API clients. `/api/dropzones/<id>` (GET) returns the salt and submission metadata, owner-only (404 otherwise).
- `/dropzones/<id>/release` (POST): password-first `wS` release, owner-only. Rate-limited per `dropzone_id` via `DROPZONE_RELEASE_RATE_LIMIT`.
  - Answers mirror `/release`: 403 on a wrong verifier (`attempts_remaining`), 429 on the attempt that locks, 410 after release or expiry (`code: 'expired'`), 409 `no_submission` when the link hasn't been used (wS must not leave before there is something to decrypt), a uniform 404 when the zone is missing or not the caller's.
- `/dropzones/<id>/submission` (GET): streams the blob once to the owner who won the release — requires the `X-Collect-Ticket` header, derived client-side from `wS` (`HKDF` info `buzzdrop-collect-ticket`); the release stores only its SHA-256, so the bare session URL can't burn the one-shot claim. 403 `not_released`; 404 `missing`/`no_submission`; 410 `collected` after collection; 410 `expired` past `DROPZONE_COLLECT_TTL_SECONDS` since the release. A zone's own `expiry_at` bounds only the request link — a landed submission stays collectable past it.
- `/dropzones/<id>/report` (POST): receipt-gated proof of decryption, public like `/report_decryption` (403 `Invalid receipt`), rate-limited per `dropzone_id` by `REPORT_DECRYPTION_RATE_LIMIT`.
- `/dropzones/<id>/delete` (POST): manual deletion by the owner; drops both rows, and the caller deletes the blob.

### Dropzone lifecycle

- **Create:** a `dropzones` row with `salt`, `ws`, `v`, `sv`, `created_by`, optional `expiry_at`, memo and notification fields.
- **Submit:** `sv` verified, `link_consumed_at` stamped, a `dropzone_submissions` row (`path`, `type`, `wk`, `receipt_hash`) and the blob stored (local/S3). `sv` is verified then discarded — never stored beyond its `sv` column.
- **Wrong passwords** consume `attempts`. Lockout comes at `DROPZONE_MAX_ATTEMPTS`; burn-on-lockout (off by default) NULLs `v`/`ws`/`sv`.
- **Release:** `released_at` set, `v`/`ws`/`sv` wiped in the same transaction — a post-release DB theft yields nothing crackable.
- **Collect:** `collected_at`/`collected_by_ip` set, the blob streams and is deleted; the browser decrypts and reports the receipt (`decryption_success` written once).
- **Released but never collected** expires after `DROPZONE_COLLECT_TTL_SECONDS`: `expire_uncollected_dropzone_releases` marks the zone expired, deletes the submission row, and the sweep deletes the blob.
- **Expiry:** `purge_expired_dropzones` (and `expire_dropzone_unconsumed` on read paths) wipes `v`/`ws`/`sv` and marks the zone expired — only while the link is unconsumed. `expiry_at` bounds the request link's submit window; a landed submission outlives it and stays collectable until the requester fetches it or deletes the zone. Zone rows stay for bookkeeping until `POST /dropzones/<id>/delete` removes zone + submission + blob.

## Explainer page

`/how-it-works` takes its words from `templates/_how_it_works_content.html`, is laid out by `templates/how_it_works.html`, and has its script in `static/js/pages/how-it-works/`. `docs/how-it-works.md` is its source of truth. The page mirrors the doc step for step under the same `step-…` ids, and every claim it makes (what the server sees, what is deleted when, what is kept) is in the doc first.

The landing page's hero walkthrough is its one short account of the flow (#271).
- Its captions are `brief` in the same content file and must read word for word like the doc's "In brief" (`tests/integration/test_how_it_works.py`). They link on to `/how-it-works`.
- Each "What's guaranteed" card links to the doc step that makes it true (`#step-…`, checked against the doc's step ids).

The page and the walkthrough are translated; the doc stays English (`docs/dev/i18n.md`, #291). A change to the page's English fuzzes its Polish entries, so the same PR updates the Polish too.

`tests/unit/test_how_it_works_fingerprint.py` hashes the code that defines the flow. What it covers is listed in the doc's "Keeping this true" note and in the test's `WHOLE_FILES`, `FUNCTIONS`, `QUOTED_LINES` and `MODULE_ASSIGNMENTS` tables. The doc carries that hash, and the test's failure message prints the new one.
