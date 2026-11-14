# Known issues

Accepted findings from the security audit that we deliberately do **not**
fix — documented so operators and users know what the design does and
doesn't promise. Each entry says what happens and why we live with it.

## Destroyed key material is recoverable from the database WAL files

The drops and dropzone key-halves are wiped from SQLite on burn, but the
WAL (`buzzdrop.db-wal`) keeps the deleted bytes readable on disk until the
next checkpoint. "Destroyed" means *deleted from the live data*, not
*cryptographically erased from the filesystem*.

We accept this: the residue is useless without the other key half, which
lives only in the recipient's URL fragment and never reaches the server.
An attacker who can already read the server's filesystem has bigger wins
than stale WAL pages (live key halves, ciphertext). Operators who need
stronger erasure should encrypt the disk or run on tmpfs.

## Orphaned ciphertext blobs can outlive their records

Two confirmed edge cases leave a ciphertext blob in storage with no row
pointing at it: an owner deleting a drop in the tiny window between a
recipient's download claim and the blob read, and a storage delete that
fails silently during a burn. The blob is still ciphertext — useless
without the key halves — but it occupies space.

**Cleanup:** `python cleanup_orphans.py` (from the repo root, with the
app's environment) lists and deletes every blob no `files` or
`dropzone_submissions` row references, for the local and the S3 backend;
`--dry-run` reports only. Run it with the app stopped — the sweep skips
blobs younger than `KEY_SHARE_PENDING_TTL_SECONDS` anyway, but a stopped
app is the honest answer. On local storage the same sweep also runs at
every app startup; on S3 this command is the only sweep.

## The dropzone report endpoint writes before the owner reads

`POST /dropzones/<id>/report` accepts the decryption result without
authentication — by design, the responder holds only what the zone's
crypto gives them. The edge case: a responder can submit a report
*before* the owner opens the submission, pre-seeding a status the owner
never observed. It forges a status field, nothing else — it cannot forge
content, because the server has none.

We accept this: the report field is advisory bookkeeping; the receipt
requirement still gates what counts as a real decrypt attempt.

## Some endpoints reveal record existence through their status codes

Three endpoints answer differently for "never existed / expired" versus
"exists but denied" (typically 404 vs 403):

- `/report_decryption/<file_id>` — a guesser can tell whether a drop was
  deleted by its owner or simply expired.
- `/dropzones/<id>/report` — reveals that a submission has landed, which
  the dropzone flow otherwise hides from observers.
- `/api/tokens/<id>` (revoke) — token ids are sequential, so the 404/403
  distinction reveals the existence of other users' active tokens.

We accept this: the information leaked is operational metadata, not
content — the one-time property of drops is unaffected. Uniform response
codes would also make legitimate error handling harder for no real gain.
