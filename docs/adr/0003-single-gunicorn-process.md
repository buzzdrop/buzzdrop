# ADR-0003: One gunicorn process with threads

- Status: accepted
- Date: 2026-10-29
- Decided in [What does the production image look like?](https://github.com/buzzdrop/buzzdrop/issues/386), from the [production-image research](https://github.com/buzzdrop/buzzdrop/blob/research/production-image/docs/research/production-image.md).

The image runs gunicorn with **one worker process and 8 threads** (gthread). `gunicorn.conf.py` pins `workers = 1`, so a host's `WEB_CONCURRENCY` can't raise it. We give up fault isolation and the use of more than one core. In return we keep two things that otherwise need more infrastructure:

- **Exact rate limits.** Flask-Limiter's `memory://` store keeps its counters per process, so with N workers each limit is multiplied by up to N (a probe with `-w 4` let 40 of 50 logins through a `10 per minute` limit). A shared store such as Redis would fix that, but adding one is out of scope: one long-running container, no extra services.
- **One sweep thread and a clean first boot.** Each worker imports the app, so with N workers there are N startup sweeps and N sweep threads, and on an empty disk several workers raced each other to create the schema and crashed.

Buzzdrop's request work is mostly I/O (SQLite, file or S3 streaming, SMTP), because the crypto runs in the browser. The target hosts rarely have a second core anyway. SQLite serializes writes through `BEGIN IMMEDIATE` either way, so one-time release is just as safe under threads.

## Consequences

- An operator can still raise workers through `GUNICORN_CMD_ARGS`. The deploy docs warn that this multiplies the rate limits. The boot race is fixed separately (`busy_timeout` is set before `journal_mode=WAL`), so this no longer crashes the first boot.
- Moving to several workers or several instances means moving the limiter to a shared store first. Several instances also need a database other than a local SQLite file.
- Keep `--preload` off: forking after import leaves the sweep thread in the master only, and the workers inherit its SQLite connection.
