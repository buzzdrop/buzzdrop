# db

SQLite through stdlib `sqlite3`, behind a swappable-backend interface selected by `DATABASE_URL` (default `sqlite:///buzzdrop.db`).

- `base.py` defines the `FileStore`/`TokenStore` interfaces and the `Backend` container.
- `sqlite_backend.py` is the SQLite implementation over raw DB-API, with typed columns plus an `extra` JSON overflow column.
- `create_backend(url)` picks the backend by URL scheme.

A new engine implements the two stores, registers a scheme and must pass `tests/contract/test_backend_contract.py` (walkthrough: `docs/howto-new-db-backend.md`).

In `app.py`:
- `get_backend()` returns the `Backend` (`.files`/`.tokens`) and recreates it when `DATABASE_URL` changed (tests rely on this);
- `get_files_store()` returns the FileStore for the current app context.

Every stored time is a UTC string from `timestamps.py` (see the root `CLAUDE.md`). The text comparisons in `purge_expired` and `purge_stale_key_shares` depend on that format.

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
