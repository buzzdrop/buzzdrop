# Share protocol: crypto, routes, lifecycle

The engineering reference for how a drop is encrypted, uploaded, released and downloaded. The reasoning behind the design is `docs/true-one-time.md` §6; the user-facing account is `docs/how-it-works.md`. The tables behind it are in `db/CLAUDE.md`.

## Client-side encryption

Files are encrypted in the browser with the Web Crypto API (`static/js/lib/crypto.js`, driven through `static/js/features/share-protocol/` by `pages/index/index-page.js`) under a **server-gated key release** scheme. The file key is split. One half derives from the password. The other half, `H` (32 random bytes), lives in the `file_keys` table and is released exactly once. So a stolen ciphertext alone cannot be brute-forced offline.

### Upload (always two-phase)

1. `POST /upload/begin` → server mints `file_id` and a random share `H`, returns `{file_id, h}` (H as hex)
2. `master = PBKDF2-SHA256(password, salt, 600k)`; `Kp = HKDF(master, salt, 'enc')`, `V = HKDF(master, salt, 'ver')`
3. `file_key = HKDF(Kp ‖ H, salt, 'file')`; plaintext is `BKP-FILE ‖ receipt(32B random) ‖ data` (the receipt is the decryption proof — the server stores only its SHA-256), then AES-GCM encrypted
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

- `/upload/begin` (POST): Mints `file_id` + server share `H` for the two-phase key-release upload. Shares the `UPLOAD_RATE_LIMIT` bucket with `/upload`
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
  - Answers: 403 for a live unreleased share; 410 "claimed" for a released share without the winner's ticket; 410 "expired" once `KEY_RELEASE_DOWNLOAD_TTL_SECONDS` have passed since the release; 410/404 for downloaded/expired/missing. An XHR gets JSON; a plain request gets a flash + redirect.
  - The ticket is consumed before the body streams, so a broken-off transfer cannot be resumed. This is deliberate: there is no re-download surface.
- `/release/<file_id>` (POST): Server-gated key release. JSON `{v}` → `{h}` on a constant-time match inside one atomic `attempt_key_release` transaction.
  - Answers: 403 on a wrong verifier; 410 after release or expiry; 429 on the attempt that locks the share; a uniform 404 when the file or share is missing, pending or burned. So with burn-on-lockout, calls after the lockout get 404.
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

## Explainer page

`/how-it-works` takes its words from `templates/_how_it_works_content.html`, is laid out by `templates/how_it_works.html`, and has its script in `static/js/pages/how-it-works/`. `docs/how-it-works.md` is its source of truth. The page mirrors the doc step for step under the same `step-…` ids, and every claim it makes (what the server sees, what is deleted when, what is kept) is in the doc first.

The landing page's hero walkthrough is its one short account of the flow (#271).
- Its captions are `brief` in the same content file and must read word for word like the doc's "In brief" (`tests/integration/test_how_it_works.py`). They link on to `/how-it-works`.
- Each "What's guaranteed" card links to the doc step that makes it true (`#step-…`, checked against the doc's step ids).

`tests/unit/test_how_it_works_fingerprint.py` hashes the code that defines the flow. What it covers is listed in the doc's "Keeping this true" note and in the test's `WHOLE_FILES`, `FUNCTIONS`, `QUOTED_LINES` and `MODULE_ASSIGNMENTS` tables. The doc carries that hash, and the test's failure message prints the new one.
