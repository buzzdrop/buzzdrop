# db

SQLite through stdlib `sqlite3`, behind a swappable-backend interface selected by `DATABASE_URL` (default `sqlite:///buzzdrop.db`).

- `base.py` defines the `FileStore`/`TokenStore` interfaces and the `Backend` container.
- `sqlite_backend.py` is the SQLite implementation over raw DB-API, with typed columns plus an `extra` JSON overflow column.
- `create_backend(url)` picks the backend by URL scheme.

A new engine implements the two stores, registers a scheme and must pass `tests/contract/test_backend_contract.py` (walkthrough: `docs/howto-new-db-backend.md`).

In `app.py`:
- `get_backend()` returns the `Backend` (`.files`/`.tokens`) and recreates it when `DATABASE_URL` changed (tests rely on this);
- `get_files_store()` returns the FileStore for the current app context.

Every stored time is a UTC string from `timestamps.py` (root `CLAUDE.md`, *Timestamps are UTC*). The text comparisons in `purge_expired` and `purge_stale_key_shares` depend on that format.

## `files`

- `id` (UUID), `original_name`, `path` (local path or S3 key), `type` (`'file'` or `'text'` for text notes)
- `created_at`, `downloaded_at`, `expiry_at`
- `uploaded_by` (username), `status` (active/expired), `downloaded_by_ip`
- `decryption_success`: a bool, NULL-guarded and written once. Whichever lands first wins:
  - a receipt-backed `record_decryption_result` report;
  - `False`, stamped by key-release lockout, which is a terminal never-decrypted outcome.
- `receipt_hash`: SHA-256 of the in-plaintext decryption receipt. `/report_decryption` must present a matching receipt.

## `api_tokens`

- `token_hash`: a PBKDF2-HMAC-SHA256 fingerprint. The raw token is never stored.
- `username`, `created_at`, `last_used_at`, `expires_at`

## `file_keys`

The server-held key-release material, one row per share (protocol: `docs/dev/share-protocol.md`). It is kept off `files` for two reasons: the share must exist before the file record does, and deleting the row burns H.

- `file_id`: the UUID minted by `/upload/begin`, unique
- `h`: the server key share, 32 bytes as hex
- `v`: the password verifier, hex. NULL until `/upload` binds it atomically.
- `created_by`: the uploader's username. Only that account may finish the pending share.
- `salt`: the BKV3 envelope salt, hex. Bound with `v` at `/upload` and rendered into the view page, so the client can derive V before any download.
- `attempts`: the failed-release counter
- `released_at`: set once by the atomic `attempt_key_release` transaction, which also wipes `h` and `v`
- `created_at`
- `ticket_hash`: SHA-256 of the download ticket derived from H. Set by the winning release and consumed by `claim_download_with_ticket`; the ticket itself is never stored.

How a row goes away:
- `FileRepository.delete()` drops the row together with the file.
- `burn_key_share()` deletes the row alone, crypto-shredding H. SQLite runs `secure_delete=ON` and a WAL `TRUNCATE` checkpoint.
- Expiry burns the share.
- Stale pending shares are swept after `KEY_SHARE_PENDING_TTL_SECONDS`, at startup and on each `/upload/begin`.
- A share that is released but not downloaded within `KEY_RELEASE_DOWNLOAD_TTL_SECONDS` expires. `expire_unclaimed_releases`, part of the expiry sweep (startup + periodic), marks the file expired and deletes the row, and the caller deletes the blob. `claim_download_with_ticket` refuses a late ticket the same way.

## `dropzones`

The reversed flow's zone record (docs/adr/0001; protocol: `docs/dev/share-protocol.md` §Dropzone protocol). Unlike `file_keys`, the secrets live on the row itself: `v`/`ws`/`sv` are NULLed in place by `_wipe_dropzone_secrets` on release, expiry and lockout burn — the row stays for bookkeeping, like `files` outliving `file_keys`. A zone carries exactly one link (`link_consumed_at` stamps its death) and at most one submission.

- `id`: the UUID minted by `POST /api/dropzones`, unique
- `salt`: the KDF salt, hex. Rendered back to the owner by `GET /api/dropzones/<id>` so the client can derive V before releasing.
- `ws`: the dropzone secret `s` wrapped under the password key, hex (`iv ‖ AES-GCM ct`). Released once by `attempt_dropzone_release`.
- `v`: the dropzone password verifier, hex
- `sv`: the submit verifier, hex — `HKDF(s, 'submit')`. `consume_for_submission` constant-time compares it before consuming the link; the responder's `sv` field itself is verified then discarded.
- `attempts`: the failed-release counter
- `expiry_at`, `created_at`, `created_by` (the requester's username)
- `link_consumed_at`: set once by `consume_for_submission` in the same transaction that inserts the submission — one link, one shot
- `released_at`: set once by `attempt_dropzone_release`, which also wipes `v`, `ws` and `sv`
- `collected_at`, `collected_by_ip`: stamped by `claim_dropzone_submission` when the owner fetches the blob
- `status` (active/expired)
- `notify_on_submission`, `notification_email`, `notification_sent_at`, `notification_claimed_at`: the submission-landed email, claimed then marked like the drop-opened one
- `language`: the zone's language, used for the notification email
- `memo`: the requester's private memo

## `dropzone_submissions`

At most one row per zone (`dropzone_id UNIQUE`) — the responder's ciphertext pointer.

- `id` (UUID), `dropzone_id` (unique), `path` (local path or S3 key), `type` (`'file'` or `'text'`)
- `wk`: the submission key wrapped under `s`, hex (`iv ‖ AES-GCM ct`). Served to the owner with the zone metadata before collection.
- `receipt_hash`: SHA-256 of the in-plaintext decryption receipt. `/dropzones/<id>/report` must present a matching receipt.
- `decryption_success`: a bool, NULL-guarded and written once by `record_dropzone_decryption`.
- `created_at`

How rows and secrets go away:
- `delete_dropzone()` drops both rows in one transaction; the caller deletes the blob.
- Collection stamps `collected_at` on the zone and streams the blob once; the route deletes it after the stream. The submission row stays so the list shows collected/decrypted.
- `purge_expired_dropzones()` wipes the zone's secrets, marks it expired and deletes the submission row; the sweep deletes the blob. `_expire_dropzone` does the same lazily on read paths.
- `expire_unclaimed_dropzone_releases()` expires a zone released but never collected within `DROPZONE_COLLECT_TTL_SECONDS`, the same way — part of the expiry sweep, and `claim_dropzone_submission` refuses a late collect the same way.
- Wrong-password misses increment `attempts`; at `DROPZONE_MAX_ATTEMPTS` the zone locks, and `DROPZONE_BURN_ON_LOCKOUT` (off by default) decides whether the secrets are wiped too.
