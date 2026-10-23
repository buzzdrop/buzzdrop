# Research: which outside database can keep the one-time guarantee?

Ticket: [#383](https://github.com/buzzdrop/buzzdrop/issues/383) (map [#381](https://github.com/buzzdrop/buzzdrop/issues/381)). Sources read 2026-10-23. Facts and trade-offs only; the pick is [#384](https://github.com/buzzdrop/buzzdrop/issues/384).

## In plain words

1. **Postgres can keep the promise.** It has a standard, well-documented way to make two simultaneous requests wait in line. Every platform can reach it, and it costs $0–15/month. It is the most work to build (about a week), because it is a different database dialect.
2. **Turso (SQLite over the internet) is the closest to what we have.** Most of today's code would carry over almost unchanged. The risks are speed, since every step of a "wait in line" crosses the network, and a young Python driver. Free tier available.
3. **Cloudflare D1 can only keep the promise if we rewrite every one-time step** in a different style ("change it only if nobody changed it first"). Outside Cloudflare's own Workers, the only way in is a web API capped at about 4 requests a second for the whole account.
4. **None of the three can truly erase a burned key the way our SQLite setup tries to.** Each keeps backups or old copies for hours to 30 days. This is a trade-off for #384 to weigh against `docs/true-one-time.md` §10.
5. **Testing:** Postgres and Turso can run inside our CI for free. D1 can't be tested faithfully without a real Cloudflare account.

## What has to be preserved

Today, seven `FileStore` methods open `BEGIN IMMEDIATE`. That takes SQLite's single database-wide write lock *before* the first read, so read → decide in Python → write runs as one indivisible step (`db/sqlite_backend.py`):

| Method | Lines | Python logic between read and write |
|---|---|---|
| `attempt_key_release` | 605–712 | `secrets.compare_digest(v)`, attempt counting, lockout and burn branches, HKDF ticket digest computed from the `h` it just read |
| `claim_download_with_ticket` | 759–847 | ticket format check, `compare_digest(ticket_hash)`, TTL parse |
| `expire_unclaimed_releases` | 849–881 | loop over the selected rows |
| `consume_for_submission` | 1090–1133 | `compare_digest(sv)`, expiry check, insert submission |
| `attempt_dropzone_release` | 1135–1224 | `attempt_key_release` mirror, ticket digest computed from `ws` |
| `collect_dropzone_submission` | 1226–1312 | `claim_download_with_ticket` mirror |
| `delete_dropzone`, `purge_expired_dropzones`, `expire_uncollected_dropzone_releases` | 1314–1403 | select, then loop |

The other one-shot methods (`record_decryption_result`, `bind_key_verifier`, `claim_notification_send`, `expire_dropzone_unconsumed`, `purge_stale_key_shares`, `record_dropzone_decryption`) already use a single conditional `UPDATE`/`DELETE … WHERE x IS NULL` plus `rowcount`, which ports directly to any engine.

Two features of the SQLite setup that any port must replace:

- **The `is_iso_timestamp` Python UDF** (`conn.create_function`, line 1558) is used in `expire_unclaimed_releases`, `purge_stale_key_shares`, `purge_expired_dropzones`, `expire_uncollected_dropzone_releases` and `TokenStore.purge_expired`. A remote engine can't call back into Python, so the "malformed timestamp counts as stale" rule has to become SQL: a regex or `GLOB` check, a Postgres function, or a `TIMESTAMPTZ` column type.
- **Physical deletion**: `PRAGMA secure_delete=ON` plus `wal_checkpoint(TRUNCATE)` after a burn (`checkpoint_wal`, lines 1604–1616). It is a hard requirement in `docs/howto-new-db-backend.md` §2.

The contract suite already enforces the guarantee with thread races (`tests/contract/test_backend_contract.py`: `…_concurrent_single_winner` for claim, release, consume, dropzone release and collect, plus `test_attempt_key_release_mixed_race` and `…_race_never_exceeds_max`). It parametrizes extra DSNs through `_EXTRA_DSNS`, which already has a `BUZZDROP_TEST_PG_DSN` slot.

## Two ways to write an atomic operation on a remote engine

- **A. Interactive transaction with a lock taken first.** Keep today's shape: lock, read, decide in Python, write, commit. This needs an engine that holds a transaction open across several client round trips.
- **B. Guarded writes (compare-and-swap).** Read without a lock and decide in Python, still using `compare_digest`. Then write with a `WHERE` that repeats the state the decision was based on, for example:

  ```sql
  UPDATE file_keys SET released_at=?, h=NULL, v=NULL, ticket_hash=?
  WHERE file_id=? AND released_at IS NULL AND attempts=? AND h IS NOT NULL
  RETURNING file_id
  ```

  If no row changed, someone else moved first: re-read and report their outcome (`released`, `locked`, …). A miss is `SET attempts=attempts+1 WHERE … AND attempts=?`. This is sound here because the state only moves one way: `v` is fixed once bound, `released_at` and `downloaded_at` are set once, and rows are only ever deleted. It needs no multi-round-trip transaction, only single statements or a one-shot batch. The cost is that every atomic method is restructured, with a retry loop and a re-read to compute the loser's status.

## Postgres

**Semantics (primary docs, PostgreSQL 18).**
- `SELECT … FOR UPDATE` "prevents them from being locked, modified or deleted by other transactions until the current transaction ends … other transactions that attempt `UPDATE`, `DELETE`, `SELECT FOR UPDATE` … will be blocked until the current transaction ends" ([explicit locking §13.3.2](https://www.postgresql.org/docs/current/explicit-locking.html)).
- Under the default Read Committed, a blocked `UPDATE`/`DELETE`/`FOR UPDATE` waits for the first transaction, then re-evaluates its `WHERE` "to see if the updated version of the row still matches the search condition" ([transaction isolation §13.2.1](https://www.postgresql.org/docs/current/transaction-iso.html)). That makes pattern B correct even without explicit locks.
- `SERIALIZABLE` aborts conflicting transactions with SQLSTATE `40001`, and "applications using this level must be prepared to retry" (same page, §13.2.3). Row locks under Read Committed avoid that retry loop.
- Deadlocks are detected and one transaction is aborted. The documented defence is to "acquire locks on multiple objects in a consistent order" ([§13.3.4](https://www.postgresql.org/docs/current/explicit-locking.html)).

**How each operation would look (pattern A, closest to today).**
- `attempt_key_release` / `claim_download_with_ticket`: `BEGIN; SELECT … FROM files f LEFT JOIN file_keys k … WHERE f.id=%s FOR UPDATE OF f;`, then the same Python branches and `UPDATE`s, then `COMMIT`.
  - Locking the parent `files` row serializes every caller of these methods for that drop.
  - `OF f` matters: the lock must name the non-nullable side of the outer join. Postgres rejects `FOR UPDATE` on the nullable side of an outer join. That is a server error, not stated on the SELECT page; confirm it in CI.
  - Lock order: always the `files`/`dropzones` row first, then children. This matches the deadlock guidance.
- `consume_for_submission`, `attempt_dropzone_release`, `collect_dropzone_submission`, `delete_dropzone`: the same, with `FOR UPDATE OF z` on `dropzones`. The `dropzone_id UNIQUE` constraint is a second fence against two submissions.
- Sweeps (`expire_unclaimed_releases`, `purge_expired_dropzones`, `expire_uncollected_dropzone_releases`): `SELECT … FOR UPDATE OF f SKIP LOCKED` or plain `FOR UPDATE`, then the loop. `SKIP LOCKED` "is not suitable for general purpose work, but can be used to avoid lock contention" ([SELECT](https://www.postgresql.org/docs/current/sql-select.html)). Either is safe here, because a row skipped this time is picked up on the next sweep.
- Single-statement guards (`record_decryption_result`, etc.): unchanged SQL plus `rowcount`, safe under Read Committed's re-evaluation.

**Preserves "released exactly once"?** Yes, with either pattern. Row locks give the same serialization as `BEGIN IMMEDIATE`, but per drop instead of per database.

**Reuse of `sqlite_backend.py`.** High for structure, branches and helpers (`_download_ticket`, `_ticket_digest`, `_row_to_doc`, the status logic). Mechanical changes:
- `?` becomes `%s`
- `INTEGER` 0/1 becomes `BOOLEAN`
- `AUTOINCREMENT` becomes `GENERATED … AS IDENTITY`
- `json_set(extra, …)` becomes `jsonb` operators or a merge in Python
- the `is_iso_timestamp` UDF becomes SQL
- `PRAGMA table_info` migrations become `information_schema`
- `BEGIN IMMEDIATE` becomes `BEGIN` + `FOR UPDATE OF`

The howto already sketches the `psycopg` template (§4.1). Rough estimate: ~60–70% of the lines carry over with edits.

**Physical deletion.** No `secure_delete` equivalent. "An `UPDATE` or `DELETE` of a row does not immediately remove the old version of the row … This is done by running `VACUUM`" ([routine vacuuming §24.1.2](https://www.postgresql.org/docs/current/routine-vacuuming.html)). WAL archives and the provider's point-in-time backups keep old row versions for the retention window.

**Reachability and cheapest price** (from the vendors' pricing pages, 2026-10-23).
- **DigitalOcean:** App Platform dev database $7/month (512 MB, [DO App Platform pricing](https://docs.digitalocean.com/products/app-platform/details/pricing/)). Managed PostgreSQL from $15.15/month (1 GiB RAM, 10 GiB, [DO pricing](https://www.digitalocean.com/pricing/managed-databases)).
- **Heroku:** Heroku Postgres Essential-0 $5/month, 1 GB ([Heroku add-on](https://elements.heroku.com/addons/heroku-postgresql)). Heroku injects `DATABASE_URL` as `postgres://…`; the factory must accept both schemes, as the howto §4.2 already does.
- **Vercel:** "Vercel Postgres is no longer available"; databases come through the Marketplace, with Neon as the default ([Vercel docs](https://vercel.com/docs/postgres)). Neon Free is $0 with 100 CU-hours/project and 1 GB/project, and compute "suspends after 5 minutes of inactivity and can't be turned off" (cold start on the first request). Neon Launch is pay-as-you-go at $0.106/CU-hour plus $0.35/GB-month ([Neon pricing](https://neon.com/pricing)). Serverless functions should use the provider's pooled endpoint.
- **Cloudflare:** a Flask container makes ordinary outbound TCP connections to any hosted Postgres, such as Neon. Hyperdrive exists for Workers but isn't needed for a container. Whether the container runtime allows outbound TCP belongs to the platform research ([#382](https://github.com/buzzdrop/buzzdrop/issues/382)).

**CI.** A GitHub Actions `services: postgres:` container, with `BUZZDROP_TEST_PG_DSN` pointing at it, so the existing contract suite and race tests run unchanged. No paid account or secrets needed.

**Rough effort.** About 4–6 dev-days: backend, migrations, a CI job, docs and the `.env.example` entry. Lowest unknowns of the three.

## libSQL / Turso

**Semantics (primary docs).**
- Turso SQL: `BEGIN IMMEDIATE` "acquires a write lock immediately when BEGIN is executed. Other connections can still read but can't write until the transaction ends" ([Turso transactions](https://docs.turso.tech/sql-reference/statements/transactions)). This is the same mode `sqlite_backend.py` uses.
- `BEGIN CONCURRENT` (MVCC) gives "snapshot isolation": on a write-write conflict "the COMMIT fails and the transaction must be rolled back and retried" (same page). This is not needed here.
- The TypeScript client documents interactive transactions: they "lock the database for writing until committed or rolled back, with a 5-second timeout. They can impact performance on high-latency or busy databases" ([TS reference](https://docs.turso.tech/sdk/ts/reference)).
- A batch runs "within an implicit transaction"; "any failure results in a full rollback" (same page).
- Over HTTP (`/v2/pipeline`), a `baton` keeps one connection across requests, so `BEGIN` → statements → `COMMIT` can span round trips. "Transaction have a 5 seconds window to complete" and "connections get closed after 10 seconds of idle time" ([HTTP reference](https://docs.turso.tech/sdk/http/reference)).

**How each operation would look.** Pattern A, unchanged: the same `BEGIN IMMEDIATE` blocks, the same SQL, the same Python branches. Only the connection changes.

**Preserves "released exactly once"?** Yes, as long as the driver really runs `BEGIN IMMEDIATE` on one server-side connection for the whole block. The lock is database-wide, as today. The difference is how long it is held: today it is microseconds; remotely it is about 4–6 network round trips (`BEGIN`, `SELECT`, 1–3 writes, `COMMIT`). Every write from every user waits behind it, and a stalled request is cut off at 5 s, which rolls back and is safe but returns a 500. Pattern B over batches is the fallback if lock hold time hurts.

**Python driver (the main unknown).** Turso documents three Python packages, all described as "Python `sqlite3`-compatible" ([Python reference](https://docs.turso.tech/sdk/python/reference)):
- `libsql`, the legacy engine, embedded replicas. "Concurrent writes: Not supported."
- `pyturso`, a local file.
- `turso_serverless`, "Remote Turso database (over-the-wire)", connected with `turso_serverless.connect(url, auth_token=…)` ([quickstart](https://docs.turso.tech/sdk/python/quickstart)).

The Python docs show only `conn.commit()` and say nothing about `BEGIN`, rollback, `isolation_level` or per-thread connections. Before committing to Turso, a half-day spike should run the contract race tests against a real database.

**Reuse of `sqlite_backend.py`.** Highest of the three, with the same dialect and statements. Changes:
- the connection factory (URL plus auth token from config, passed through the factory, not read from `.env` in the backend)
- the `is_iso_timestamp` UDF becomes SQL
- `PRAGMA journal_mode/busy_timeout/secure_delete/wal_checkpoint` are server-managed on a hosted database; the docs don't say whether they're honoured, so treat them as unavailable
- `checkpoint_wal` becomes a no-op

It could even be the same class with a different connection, roughly 85–90% reuse.

**Physical deletion.** Not under our control. The plans include point-in-time restore of 1 day (Free) and 10 days (Developer) ([Turso pricing](https://turso.tech/pricing)), so a burned `h` stays recoverable from backups for that long.

**Reachability and cheapest price.** HTTPS/WebSocket with a token, reachable from all four platforms. Free: $0 for 100 databases, 5 GB, 500 M rows read and 10 M rows written a month. Developer: $4.99/month (same page).

**CI.** The Turso CLI ships a local dev server (`turso dev`), and libSQL's server is open source. Run it as a CI service and point a `BUZZDROP_TEST_LIBSQL_DSN` entry in `_EXTRA_DSNS` at it. Not verified here: whether the local server reproduces hosted-Turso locking exactly. One nightly run against a free hosted database would close that gap, at the cost of a token as a CI secret.

**Rough effort.** About 2–4 dev-days if the spike passes. If the Python driver can't hold an interactive transaction, it becomes the D1-style rewrite below.

## Cloudflare D1

**Semantics (primary docs).**
- "D1 operates in auto-commit." `batch()` is the only documented grouping: "each statement in the list will execute and commit, sequentially, non-concurrently", "Batched statements are SQL transactions", and a failure "aborts or rolls back the entire sequence" ([D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/)).
- "Each individual D1 database is inherently single-threaded, and processes queries one at a time" ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).
- There are no interactive transactions. Cloudflare's own feature request for them ([workers-sdk#2733](https://github.com/cloudflare/workers-sdk/issues/2733)) was closed "not planned" on 2025-10-07. Third-party reports say explicit `BEGIN` is rejected on remote D1 but accepted by local Miniflare, which hides the gap in local tests (for example [better-auth#10860](https://github.com/better-auth/better-auth/issues/10860), [drizzle-orm#4212](https://github.com/drizzle-team/drizzle-orm/issues/4212)). These are secondary sources; the primary docs are silent.
- A batch can't branch on a value read earlier in the same batch, so today's read → Python decision → write shape can't run inside one D1 transaction.

**How each operation would look.** Pattern B only. Each method becomes:
1. an unlocked read;
2. a Python decision, keeping `compare_digest` and computing the ticket digest from the `h`/`ws` just read;
3. one `batch()` of guarded statements with `RETURNING`;
4. a re-read and retry when the guard missed.

Examples:
- `claim_download_with_ticket`: `[UPDATE files SET downloaded_at=?, downloaded_by_ip=? WHERE id=? AND downloaded_at IS NULL AND EXISTS (SELECT 1 FROM file_keys WHERE file_id=? AND ticket_hash=?) RETURNING id, UPDATE file_keys SET ticket_hash=NULL WHERE file_id=? AND ticket_hash=?]`. Both run in one transaction, so the second only matches when the first did.
- `consume_for_submission`: `[UPDATE dropzones SET link_consumed_at=? WHERE id=? AND link_consumed_at IS NULL AND sv=? … RETURNING id, INSERT … dropzone_submissions …]`. The `UNIQUE(dropzone_id)` constraint fails a second insert and rolls back that batch.
- Expiry branches (flip the `files` status and delete the share) go into the same batch, guarded on the state that was read.
- Sweeps: select the candidates, then one batch of guarded updates and deletes.

**Preserves "released exactly once"?** Yes in principle. Each batch is a transaction on a single-threaded database, and the guards make a stale decision a no-op. But it is new code for every atomic method, not a port, and correctness rests on getting every guard right. The contract race tests are the safety net, and they only mean something against real D1.

**Access from Flask (outside Workers).** Bindings exist only inside Workers. From Python the options are:
- **The REST API:** `POST /accounts/{account_id}/d1/database/{database_id}/query`, body `{"sql","params"}` or `{"batch":[…]}`, with a Bearer API token holding `D1 Write` ([API reference](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)). That page doesn't say whether a REST batch is one transaction. It is also subject to the Cloudflare API global limit of "1,200 requests per five minute period per user", shared with dashboard and other API use ([API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)). That is about 4 requests a second for all reads and writes, which is too low for a public site.
- **A small Worker of our own in front of D1**, exposing each store method over authenticated HTTP. This moves the atomic logic into JS/TS, a second implementation of the store to keep in step with Python.

**Reuse of `sqlite_backend.py`.** The SQL dialect is the same (SQLite), so the DDL, column mapping and `_row_to_doc` carry over. The seven atomic methods are rewritten, plus an HTTP transport layer. Roughly 40–50% reuse, less with the Worker-proxy route.

**Physical deletion.** Time Travel "is always on" and keeps restore points for up to 30 days on Paid and 7 days on Free ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)). A burned `h` is restorable by anyone with account access for that window. `secure_delete` isn't among the documented D1 PRAGMAs ([SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)).

**Reachability and cheapest price.**
- **Cloudflare:** native through a Worker. Other hosts can only use the REST API or our own Worker proxy.
- **Free plan:** 5 M rows read and 100 k rows written per day, 5 GB total, a 500 MB maximum per database.
- **Paid plan:** Workers Paid $5/month minimum. It includes 25 billion rows read and 50 million rows written a month, and 5 GB ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).

**CI.** Local Miniflare/`wrangler dev` runs D1 on local SQLite and reportedly accepts what remote D1 rejects (see above), so it can't prove the guarantee. A faithful run needs a real D1 database, with an account ID and API token as CI secrets, and runs into the API rate limit when 8-thread race tests hammer it.

**Rough effort.** About 2–3 weeks: rewrite seven methods into guarded batches, an HTTP client or Worker proxy, a CI setup against real D1, and a security review of the new shape. Highest unknowns of the three.

## Side by side

| | Postgres | Turso (libSQL) | Cloudflare D1 |
|---|---|---|---|
| Atomic pattern | A (`FOR UPDATE OF` parent row) or B | A (unchanged `BEGIN IMMEDIATE`) or B | B only (guarded `batch()`) |
| Exactly-once under races | Yes; per-row locks, documented | Yes, if the Python driver holds one remote transaction (spike) | Yes in principle; new code per method |
| Lock scope / cost | per drop or zone row | whole database, held across 4–6 round trips, 5 s cap | none (optimistic); retry on a miss |
| Reuse of `sqlite_backend.py` | ~60–70% (dialect port) | ~85–90% | ~40–50% |
| Physical deletion of burned keys | no; `VACUUM` + provider backups | no; PITR 1–10 days | no; Time Travel 7–30 days, always on |
| DO / Heroku / Vercel / Cloudflare | all (native add-ons on DO, Heroku, Vercel) | all (HTTPS + token) | Cloudflare only; others via a rate-limited API or our own Worker |
| Cheapest | $0 (Neon Free, sleeps after 5 min) · $5 Heroku · $7 DO dev DB | $0 Free · $4.99 Developer | $0 Free · $5 Workers Paid |
| CI | free `postgres` service container; existing DSN slot | local libSQL server; hosted check optional | needs a real account + secrets; local emulator misleading |
| Effort | ~4–6 days | ~2–4 days + spike | ~2–3 weeks |

## Open questions for #384

- Is losing physical deletion of burned keys acceptable? It applies to every candidate; only the retention window differs. If yes, `docs/true-one-time.md` §10 and the howto's "hard requirement" need an explicit carve-out for network backends.
- For Turso, does `turso_serverless` (or `libsql`) hold a `BEGIN IMMEDIATE` across calls from Python threads? Settle it with a half-day spike against the contract race tests.
- Does the platform research ([#382](https://github.com/buzzdrop/buzzdrop/issues/382)) keep Cloudflare in play at all? D1 is only worth its cost if Cloudflare is chosen *and* the app runs as a Worker.
