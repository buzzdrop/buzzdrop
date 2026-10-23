# How the image should serve Buzzdrop in production

Research for [#375](https://github.com/buzzdrop/buzzdrop/issues/375) (map [#373](https://github.com/buzzdrop/buzzdrop/issues/373)).
Web sources are official docs, specs, package indexes and source repos, **accessed 2026-10-23**. Code references are to `main` at `2e31e5b`. Statements marked **(probe)** come from running the app on `python:3.15-alpine` with gunicorn 26.2.0 under OrbStack (arm64) on 2026-10-23. They are spot checks, not benchmarks.

This file gives facts and trade-offs. It flags options but decides nothing.

## Today's image, as it is

- `FROM python:3.15-rc-alpine3.22`. The tag is stale: it resolves to **Python 3.15.0b2 with SQLite 3.49.2** (probe). 3.15.0 final shipped 2026-10-09 and 3.15.1 on 2026-10-21 [1][2].
- `CMD ["flask", "run"]` (the dev server), port 5000, runs as root. There is no `HEALTHCHECK`, no `FLASK_ENV`, and only `uploads/` is created.
- **`FLASK_ENV` is not set**, so `get_config()` falls back to `development` (`config.py`, `get_config`). That gives `DEBUG=True`, `SESSION_COOKIE_SECURE=False`, and no enforcement of `FLASK_SECRET_KEY` or `TOKEN_HASH_SECRET`. A deployer who doesn't set `FLASK_ENV=production` gets a dev-mode app.
- **The app does not create the database directory.** `DATABASE_URL=sqlite:///data/buzzdrop.db` with no `data/` dir fails at import with `sqlite3.OperationalError: unable to open database file` (probe). Compose works only because it mounts `./data`. `UPLOAD_FOLDER` *is* created (`app.py:491`).
- `requirements.txt` mixes runtime and test deps: `pytest` and `pytest-flask` ship in the image. site-packages is about 108 MB, mostly Babel (33 MB) and botocore (27 MB) (probe).
- CI builds the image once, then runs `pytest`, the fixture renderers and `migrate_db.py` inside it, and runs E2E against it with `--init` because "flask as PID 1 ignores SIGTERM" (`.github/workflows/ci.yml`).

## 1. WSGI server: workers vs threads

### The constraints in Buzzdrop's code

| Constraint | Where | What it means per process |
|---|---|---|
| `RATE_LIMIT_STORAGE_URI=memory://` | `app.py:85`, `config.py` | Flask-Limiter: "Each application process will have it's own storage" and the state does not outlive the process [3]. N processes means N independent counters. |
| Startup sweep at import | `app.py:704` | Runs once in every process that imports `app`. |
| `start_expiry_sweep_thread` at import | `app.py:752` | One `buzzdrop-expiry-sweep` daemon thread per process, every `EXPIRY_SWEEP_INTERVAL_SECONDS` (default 300). The docstring calls the sweep idempotent and "safe under WSGI deployments with several workers". |
| SQLite: one connection per thread | `db/sqlite_backend.py:1541` | `threading.local()` connection, `isolation_level=None`, `PRAGMA journal_mode=WAL`, then `PRAGMA busy_timeout=10000`, `secure_delete=ON`. |
| One-time release | `db/sqlite_backend.py:605` (`attempt_key_release`) and the other `BEGIN IMMEDIATE` blocks | Read, check and claim happen inside one `BEGIN IMMEDIATE`. After an H-destroying write it runs `PRAGMA wal_checkpoint(TRUNCATE)`. |

### SQLite facts that apply

- **Threads and processes are the same to SQLite's locks.** Locking is on the file, and only one write transaction can be active at a time. `BEGIN IMMEDIATE` "start[s] a new write immediately" and fails with `SQLITE_BUSY` if another connection holds a write transaction [4]. In WAL mode IMMEDIATE and EXCLUSIVE are the same [4]. So the read-check-claim in `attempt_key_release` serializes the same way under N threads or N processes. The 10 s busy timeout makes a waiter retry instead of failing at once.
- **WAL needs every process on the same host and a real local filesystem.** WAL "does not work over a network filesystem", because the wal-index is shared memory in the `-shm` file next to the database [5]. Network filesystems with broken locks can corrupt the database once two or more threads or processes write [6]. That matters for a host's "persistent disk" if it is network-backed: check this per host in #374/#378.
- **Readers don't block the writer, and there is one writer at a time** [5]. Buzzdrop's writes are short, so concurrency is bounded by write throughput, not by worker count.
- **Never carry a connection across `fork()`.** "Any database connection that is used in a child process must be opened in the child process, not inherited from the parent" [6]. See `--preload` below.
- **The WAL-reset bug.** It can corrupt a database when "two or more database connections [are] open on the same file, in separate threads or processes" and write or checkpoint "at the same instant". It is present in 3.7.0 through 3.51.2 and fixed in **3.51.3** (backports in 3.44.6 and 3.50.7). SQLite calls it rare ("not an emergency") but says to upgrade [5]. **Buzzdrop meets that condition with threads alone:** request threads plus the sweep thread, each with its own connection, and a `wal_checkpoint(TRUNCATE)` after every key burn. So the bundled SQLite version matters whichever server model is picked (see §2).

### Probe results (gunicorn 26.2.0, `python:3.15-alpine`)

- **The login limit multiplies by the worker count.** 50 `POST /login` with `LOGIN_RATE_LIMIT=10 per minute`:
  - `-w 4` (sync): 40 accepted, 10 got 429;
  - `-w 1 --threads 4` (gthread): 10 accepted, 40 got 429;
  - `-w 2`: 17 of 30 accepted (round-robin is not exact, so the effective limit lies between 1x and Nx).

  The same multiplier applies to every per-`file_id` limit, including `KEY_RELEASE_RATE_LIMIT`, and `KEY_RELEASE_MAX_ATTEMPTS` is the hard cap on guesses. That cap lives in SQLite, so it is not multiplied.
- **Each worker runs its own startup sweep and its own sweep thread.** With `-w 4` there were four `buzzdrop-expiry` threads.
- **First boot on an empty volume can fail with several workers.** On a fresh database, `-w 2` failed to boot in 4 of 10 runs and `-w 4` in 3 of 10, with `sqlite3.OperationalError: database is locked`. The gunicorn master then exits ("Worker failed to boot"). The traceback points at `PRAGMA journal_mode=WAL` (`db/sqlite_backend.py:1553`), which runs *before* `PRAGMA busy_timeout` is set on the next line, so concurrent schema creation doesn't wait. With an existing database, `-w 4` booted 10 of 10, and `-w 1 --threads 8` booted 10 of 10 on a fresh one. A host restart loop would probably get past it on a retry, but a one-click first deploy would show a crash.
- **`--preload` breaks two things.** The app is imported once in the master and then forked. Probe with `--preload -w 2`:
  - the sweep thread exists **only in the master** (POSIX `fork()` copies only the calling thread), so workers don't sweep, and nothing is sweeping if the master's thread dies;
  - each worker inherits the master's 3 open `buzzdrop.db*` file descriptors (db, `-wal`, `-shm`). The sync worker's main thread reuses the inherited thread-local connection, which is exactly what SQLite says not to do [6].

  `--preload` is off by default [7]. A production config should keep it off, unless the app moves its startup work into a `post_fork` hook [7].
- **Memory:** about 61 MB RSS per worker plus 25 MB for the master. `-w 1 --threads 4` used one 61 MB process.

### The options

| | **A. 1 process, N threads** | **B. N processes** | **C. N processes + shared limiter store** |
|---|---|---|---|
| Rate limits | Exact, as configured | Multiplied by up to N | Exact |
| Sweep threads | 1 | N, concurrent (idempotent by design; concurrent deletes of the same blob were not tested) | N |
| Fresh-volume boot | Clean (probe) | Can crash (probe), unless the `journal_mode`/`busy_timeout` order is fixed or the schema is created before workers start | Same as B |
| SQLite write path | Serialized by `BEGIN IMMEDIATE` | Same | Same |
| Fault isolation | One crash or leak takes down the whole app | Better | Better |
| CPU use | One core for Python code (the GIL) | All cores | All cores |
| Fits "architecture stays as it is" (#373) | Yes | Changes limiter semantics | No: needs Redis/Memcached/Mongo [3] and is out of scope in #373 |

Buzzdrop's request work is mostly I/O: SQLite, file or S3 streaming, SMTP. The heavy crypto runs in the browser. On the target hosts (0.1 to 1 vCPU, 256 to 512 MB) there is rarely a second core to use anyway. Gunicorn's own guidance: "Threads share memory → lower footprint", "Workers isolate failures" [8].

Another option is to pin the process count at 1 and accept N workers only on a box where the operator also sets a shared limiter. That is a deployer choice, not an image default.

### Server candidates

| | gunicorn 26.2.0 (2026-08-24) | waitress 3.0.2 (2024-11-16) | granian 2.8.5 (2026-10-20) |
|---|---|---|---|
| Model | Pre-fork master plus workers. `sync` default; `--threads >1` switches to `gthread` [7][8] | One process, thread pool (`threads=4` default) [9] | Rust server, `--interface wsgi`, `--workers` (default 1) plus blocking threads [10] |
| Package | Pure Python, `>=3.10` [11] | Pure Python, `>=3.9` [11] | Native wheels. cp315 musllinux and manylinux wheels exist for 2.8.5 [11] |
| `$PORT` | **Yes:** with no `bind`, the default becomes `0.0.0.0:$PORT` when `PORT` is set, otherwise `127.0.0.1:8000` [7] | No env support. `port` defaults to 8080 [9] | `GRANIAN_PORT` (default 8000), not `PORT` [10] |
| Concurrency env | `WEB_CONCURRENCY` sets `workers` [7] | — | `GRANIAN_WORKERS` etc. [10] |
| Proxy headers | `forwarded_allow_ips` (default `127.0.0.1,::1`) [7] | `trusted_proxy*`, `clear_untrusted_proxy_headers=True` [9] | — |
| SIGTERM | Handled gracefully, `graceful_timeout` 30 s [7][12] | — | — |
| Listed by Flask docs | Yes [13] | Yes [13] | No (Flask lists ASGI separately) |

Notes on gunicorn specifics:
- **`timeout` 30 s**: "Workers silent for more than this many seconds are killed" [7]. A sync worker is busy for the whole request, so a slow 100 MB upload (`MAX_CONTENT_LENGTH`) or download can be killed unless a buffering proxy sits in front. Gunicorn "strongly recommend[s]" a buffering proxy for sync workers [14]. With gthread, "threads can extend request time beyond the worker timeout while still notifying the arbiter" [8]. This was not probed.
- **Worker heartbeat** writes a temp file. On disk-backed `/tmp`, `os.fchmod` can block, and the fix is `--worker-tmp-dir` on a tmpfs [7][15]. `/dev/shm` is the usual tmpfs in Docker.
- **The `WEB_CONCURRENCY` env var** can silently raise workers. Some PaaS hosts set it, so an image that wants option A should pin `workers` explicitly.
- Gunicorn 26 starts a control socket under `$HOME/.gunicorn/` (probe log: `Control socket listening at /root/.gunicorn/gunicorn.ctl`). A non-root user needs a writable `HOME`.

## 2. Base image

Supported official tags today [16]: `3.15.1-slim-trixie` / `-slim-bookworm` and `3.15.1-alpine3.24` / `-alpine3.23` (plus 3.14.9 and 3.13.17 lines). 3.15 gets bugfix releases about every two months until 2028-10 and security fixes until about 2031-10 [2]. PEP 790 still lists 3.15.1 as "expected 2026-12-01", but python.org lists it as released on 2026-10-21 [1].

| | `python:3.15-alpine` (3.24) | `python:3.15-slim` (trixie) |
|---|---|---|
| Size, local arm64 | 85.6 MB | 208 MB |
| libc | musl. "software will often run into issues" depending on libc depth [16] | glibc |
| **SQLite linked by `sqlite3`** | **3.53.4**, has the WAL-reset fix (probe; Alpine package [17]) | **3.46.1**, no fix (probe). The trixie package `3.46.1-7+deb13u2` backports only FTS5 CVEs [18][19] |
| `tzdata` | Included (Dockerfile keeps it [20], probe) | Included [20] |
| HTTP client for HEALTHCHECK | busybox `wget` (probe) | none: no `curl`/`wget` (probe); use `python -c` |
| Non-root user | none: runs as root [20] | none: runs as root [20] |

- **Deps vs musl:** `boto3`/`botocore`, `Babel`, `Flask`, `Flask-Limiter` and `gunicorn` are pure Python. The only native dep pulled in is `MarkupSafe`, which ships cp315 musllinux wheels [11], and the build installed with no compiler (probe). `granian` also ships cp315 musllinux wheels [11]. Nothing in the current deps forces glibc.
- The `apk add tzdata` in today's Dockerfile is redundant on the official alpine image, which already keeps `tzdata` [20].
- The SQLite version is fixed by the base image. The stdlib `sqlite3` links the system library, so slim stays on 3.46.x for trixie's life unless Debian backports the fix.
- Pin the minor *and* the distro (e.g. `python:3.15-alpine3.24`) so a rebuild doesn't jump distros. Publishing and versioning are covered in #376.

## 3. Health check

- Docker `HEALTHCHECK [OPTIONS] CMD …`: defaults `interval=30s`, `timeout=30s`, `start-period=0s`, `start-interval=5s` (Engine ≥25), `retries=3`; exit 0 means healthy, 1 unhealthy [21]. Compose and `docker ps` use it.
- PaaS hosts probe an HTTP path set in their own config, not the Dockerfile's `HEALTHCHECK`. Render: any 2xx/3xx within 5 s counts as healthy, and Render recommends "operation-critical checks, such as executing a simple database query" [22]. Per-host details belong to #374/#378.
- What exists today: `GET /login` returns 200 without auth and is rate-limited only on POST (`app.py:942`). CI's E2E job already uses it as a readiness probe. It renders a template but doesn't touch SQLite, so it shows the process is up, not that the database is usable.
- Options:
  - (a) reuse `GET /login`;
  - (b) add a dedicated unauthenticated endpoint, e.g. `/healthz`, that runs a trivial query (e.g. `SELECT 1` on the backend connection) and returns a fixed body. It needs no rate limit (`default_limits=[]`) and must not leak config.

  Either works with `HEALTHCHECK CMD wget -qO- http://127.0.0.1:${PORT:-…}/… || exit 1` on alpine, or `python -c "import urllib.request,sys; urllib.request.urlopen(...)"` on either base.
- The security headers (`set_security_headers`) apply to every response and don't affect a probe.

## 4. Non-root user and volume permissions

- The official images run as root [20]. Gunicorn's Docker guide recommends running "as a non-root user" [12].
- Probe, with a non-root `app` (uid 10001) that owns `/app/data` in the image:
  - a **fresh Docker named volume** mounted there takes the image dir's ownership (10001:10001) and is writable. Docker copies the existing content into an empty volume by default [23];
  - with `volume-nocopy`, or with a fresh **root-owned** mount (tmpfs uid 0, standing in for a PaaS disk), the dir is `0:0` and **not writable**;
  - a bind mount (`./data:/app/data` in compose) keeps the host dir's owner. On Linux, a dir that Docker creates on the host is root-owned.
- Railway warns that images running as a non-root UID "will have permissions issues" on attached volumes and suggests `RAILWAY_RUN_UID=0` [24].
- Options:
  - (a) stay root;
  - (b) non-root `USER` and document the host-specific fix (`RAILWAY_RUN_UID=0`, `chown` on compose);
  - (c) start as root in an entrypoint that `chown`s `/app/data` and `/app/uploads`, then drops to the app user (e.g. `su-exec` on alpine, `setpriv` on Debian).

  (c) works on fresh disks everywhere, at the cost of a shell entrypoint and root at start.
- Whatever the user, the image should create `/app/data` itself, or the app should `makedirs` the SQLite dir as it does for uploads (see "Today's image").
- If the server is non-root and gunicorn 26 is used, `HOME` must be writable for the control socket (§1).

## 5. What the image keeps or drops

- Kept today on purpose: `tests/` (1.7 MB), `docs/` (520 KB), `cli/` (136 KB), plus `sdk/` (1.0 MB), `.env.example`, and dev files like `package.json`, `playwright.config.js` and `vitest.config.js` that `.dockerignore` doesn't exclude. `pytest`/`pytest-flask` are installed from `requirements.txt`.
- CI depends on the image for:
  - `pytest` (`docker run … buzzdrop-test pytest`);
  - `tests/fixtures/render_dom_fixtures.py` and `record_protocol_contract.py` (with the workspace mounted over `/app`, so those two steps only need the interpreter and deps);
  - the `migrate_db.py` smoke test;
  - E2E (`--env-file tests/e2e/e2e.env`, port 5000).
- The weight is in the deps (about 108 MB), not in the repo dirs (about 3 MB). Dropping `tests/`/`docs/` saves little space. The real gains are fewer things to scan and no test tooling in production.
- Options:
  - (a) keep one image as today;
  - (b) a multi-stage Dockerfile with a `runtime` target (runtime deps only, app code, `migrate_db.py`) and a `test` target `FROM runtime` that adds `requirements-dev` and `tests/`. CI then builds `--target test` for pytest and the runtime target for the published image and E2E, so E2E tests what ships;
  - (c) keep one image and mount `tests/` from the workspace in CI, as the fixture steps already do.

  (b) and (c) need `requirements.txt` split into runtime and test files. The `.dockerignore` decoy check in CI applies to whichever target is published.
- `migrate_db.py` is a runtime tool for self-hosters coming from `db.json`, so it belongs in the runtime image.

## 6. Port

- Hosts that inject a port: Render sets `PORT` (default 10000), recommends binding to it, and requires `0.0.0.0` [25]. Railway's volume docs don't mention `PORT`. Fly uses `internal_port` in `fly.toml` instead (#374). So yes: a one-click image should honour `$PORT`, and fall back to a fixed port for compose.
- `flask run` reads `FLASK_RUN_PORT`, not `PORT`. Gunicorn's built-in default honours `PORT`, but with no `PORT` it binds `127.0.0.1:8000`, which is unreachable from outside the container [7]. So the image needs an explicit fallback:
  - shell-form `--bind 0.0.0.0:${PORT:-5000}`;
  - or a `gunicorn.conf.py` that reads `os.environ`;
  - or setting `PORT` in the image (`ENV PORT=5000`) and letting gunicorn's default use it. This last one is the least code: hosts that inject `PORT` override it, and compose keeps 5000.
- `EXPOSE` only documents the port and does not publish it [21]. Keeping 5000 avoids breaking existing `docker-compose.yml` users and CI's `-p …:5000`.
- Shell-form `CMD` makes `sh` PID 1 unless it `exec`s the server. Docker says PID 1 "ignores any signal with the default action" [26]. Gunicorn installs its own SIGTERM handler [12], so `exec gunicorn …` (or the exec form) is enough. `--init`/tini [26] stays useful in CI but isn't needed for gunicorn.

## Not covered here

- Real client IP and `ProxyFix`/`forwarded_allow_ips` (#377). Gunicorn's `forwarded_allow_ips` and waitress's `trusted_proxy` are the server-side knobs noted above.
- Image publishing, tags and architectures (#376). Render and Railway are amd64-only, per the #374 research.
- TLS on the compose path (map: "Not yet specified").

## Sources

1. python.org Downloads, release list (3.15.0 2026-10-09, 3.15.1 2026-10-21) — https://www.python.org/downloads/
2. PEP 790, Python 3.15 Release Schedule — https://peps.python.org/pep-0790/
3. Flask-Limiter 4.1.1, Configuration, storage backends (`memory://` per process) — https://flask-limiter.readthedocs.io/en/stable/configuration.html
4. SQLite, Transaction (`BEGIN IMMEDIATE`) — https://www.sqlite.org/lang_transaction.html
5. SQLite, Write-Ahead Logging (concurrency, same-host requirement, §11 WAL-reset bug) — https://www.sqlite.org/wal.html
6. SQLite, How To Corrupt An SQLite Database File (§2.1, §2.2, §2.7 fork) — https://www.sqlite.org/howtocorrupt.html
7. Gunicorn, Settings (`bind`/`PORT`, `workers`/`WEB_CONCURRENCY`, `threads`, `preload_app`, `timeout`, `graceful_timeout`, `worker_tmp_dir`, `forwarded_allow_ips`, `post_fork`) — https://gunicorn.org/reference/settings/
8. Gunicorn, Design (sync, gthread, worker count, threads vs workers) — https://gunicorn.org/design/
9. Waitress, Arguments — https://docs.pylonsproject.org/projects/waitress/en/stable/arguments.html
10. Granian README — https://github.com/emmett-framework/granian
11. PyPI JSON API for gunicorn, waitress, granian, markupsafe (versions, `requires_python`, wheel tags) — https://pypi.org/pypi/<name>/json
12. Gunicorn, Docker guide (non-root, `/health` HEALTHCHECK, SIGTERM) — https://gunicorn.org/guides/docker/
13. Flask 3.1.x, Deploying to Production — https://flask.palletsprojects.com/en/stable/deploying/
14. Gunicorn, Deploying (buffering proxy for sync workers) — https://gunicorn.org/deploy/
15. Gunicorn, FAQ (blocking `os.fchmod`, `--worker-tmp-dir` on tmpfs) — https://gunicorn.org/faq/
16. Docker Hub, `python` official image (tags, alpine/slim notes) — https://hub.docker.com/_/python
17. Alpine packages, `sqlite-libs` v3.24 (3.53.4-r0) — https://pkgs.alpinelinux.org/packages?name=sqlite-libs&branch=v3.24&arch=x86_64
18. Debian packages, `libsqlite3-0` trixie (3.46.1-7+deb13u2) — https://packages.debian.org/trixie/libsqlite3-0
19. Debian changelog, sqlite3 3.46.1-7+deb13u2 — https://metadata.ftp-master.debian.org/changelogs/main/s/sqlite3/sqlite3_3.46.1-7+deb13u2_changelog
20. docker-library/python Dockerfiles, `3.15/slim-trixie` and `3.15/alpine3.24` — https://github.com/docker-library/python/tree/master/3.15
21. Dockerfile reference (`HEALTHCHECK`, `USER`, `EXPOSE`) — https://docs.docker.com/reference/dockerfile/
22. Render, Health checks — https://render.com/docs/health-checks
23. Docker, Volumes (populating an empty volume, `volume-nocopy`) — https://docs.docker.com/engine/storage/volumes/
24. Railway, Volumes reference (`RAILWAY_RUN_UID`) — https://docs.railway.com/reference/volumes
25. Render, Web services (`PORT`, `0.0.0.0`) — https://render.com/docs/web-services
26. Docker, `docker container run` (`--init`, PID 1 signals) — https://docs.docker.com/reference/cli/docker/container/run/
