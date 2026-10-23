# What each platform needs to run Buzzdrop without its own disk

Research for [#382](https://github.com/buzzdrop/buzzdrop/issues/382) (map [#381](https://github.com/buzzdrop/buzzdrop/issues/381)).
All sources are the platforms' own docs, changelogs or pricing pages, **accessed 2026-10-23**. Where a page doesn't state something, the cell says *not documented* rather than guessing. Cost lines marked *(arithmetic)* are my sums of published prices, not a quote from the platform. This page states facts only; the go/no-go is [#384](https://github.com/buzzdrop/buzzdrop/issues/384).

## In plain words

1. All four platforms can run a Flask app like Buzzdrop, as long as the database, uploads, rate-limit counters and the cleanup job live in separate services.
2. **DigitalOcean** and **Heroku** run Buzzdrop as an ordinary always-on server; the smallest working setup costs about **$17–32/month** (DigitalOcean) or about **$20/month** (Heroku).
3. **Cloudflare** is the cheapest (about **$5–7/month** plus a database from elsewhere), but every request goes through Cloudflare's own code layer, so it needs more new code than the others.
4. **Vercel** has a hard **4.5 MB limit on what a request or response can carry**, for uploads *and* downloads. Buzzdrop files up to 100 MB would have to go straight between the browser and storage. Its free plan is for non-commercial use only and runs the cleanup job at most once a day.
5. The deploy buttons differ in how much they set up: Heroku's and Vercel's can add the database, storage and Redis; Cloudflare's can add its own database and storage but not a container; DigitalOcean's can add only a small development database, so file storage and Redis are created by hand.

## Facts about the app that matter here

- Uploads are capped at **100 MiB** (`MAX_CONTENT_LENGTH`, `config.py:61`), i.e. 104,857,600 bytes plus multipart overhead.
- The production image is `python:3.15-rc-alpine3.22` (`Dockerfile:2`). Platforms that build from source with a buildpack pick their own Python version (see "Runtime").
- The client IP comes from `request.remote_addr` with no `ProxyFix` (finding carried over from [`docs/research/deploy-button-hosts.md`](https://github.com/buzzdrop/buzzdrop/blob/research/deploy-button-hosts/docs/research/deploy-button-hosts.md)). Every platform below needs the app to read a specific header instead.

## Per platform

### DigitalOcean App Platform

| | |
|---|---|
| Runtime | Long-running container (Dockerfile or buildpack). Optional **Scale to Zero (Inactivity Sleep)** for web services; can't be combined with request-based autoscaling [1][2]. Ephemeral local disk capped at **4 GiB**, lost on deploy or container replacement [1]. **AMD64 images only** [1]. |
| Python | Buildpack: **3.10–3.14**, default 3.13, pinned with `runtime.txt` [3]. A Dockerfile can use any version, including Buzzdrop's 3.15-rc image. |
| Body size | *Not documented.* "File uploads to apps timeout after 600 seconds" [1]. |
| Request timeout | *Not documented* for general HTTP. The only figure is the 600 s upload timeout [1]. |
| Memory | Set by instance size: 512 MiB ($5), 1 GiB ($10/$12) … [4]. |
| Deploy button | `https://cloud.digitalocean.com/apps/new?repo=https://github.com/<owner>/<repo>/tree/<branch>`, reads `.do/deploy.template.yaml` (app spec under `spec:`). **Public repos only.** Supported shapes: one service, one service + **Dev Database**, one static site (+ Dev Database). **Managed databases can't be connected**; jobs and workers aren't mentioned [5]. |
| Image vs repo | Button docs cover GitHub/GitLab repos only [5]. The app spec itself supports `image` with `registry_type` `GHCR` or `DOCKER_HUB` [6]. |
| Secrets / prompts | Prompts for variables with placeholder or empty values; `type: SECRET` encrypts. **No secret generation** [5][6]. |
| Postgres | **Dev Database: $7/month**, 512 MB, PostgreSQL only, single database, **no built-in backups**, region-locked [4][7]. Managed PostgreSQL from **$15/month** (1 GiB single node) [8]. |
| S3-compatible storage | **Spaces: $5/month** for 250 GiB storage + 1,024 GiB outbound; $0.02/GiB storage and $0.01/GiB transfer over that. S3-compatible [9]. Not part of the app spec; created separately. |
| Redis | Managed **Valkey from $15/month** (1 GiB single node) [10]. App spec supports `engine: VALKEY`/`REDIS` [6], but the button can't attach managed databases [5]. |
| Scheduler | App spec job `kind: SCHEDULED` with `schedule.cron` and `time_zone` [6]. Jobs are "billed only when they run" at the size-slug rate, prorated per second [4]. The button docs don't list jobs as a supported template shape [5]. |
| Free tier | Static sites only [4]. |
| Client IP | **`do-connecting-ip`**. `X-Forwarded-For` holds the DigitalOcean ingress server's IP, not the client's [11]. |

### Heroku

| | |
|---|---|
| Runtime | Long-running dyno. **Eco** ($5) sleeps after 30 min without web traffic, wakes "after a short delay" [12][13]; **Basic** ($7) is always on [12]. Dyno filesystem is ephemeral (carried over from earlier research). |
| Python | **3.11–3.15** supported (3.15 released October 2026); new apps default to **3.14**; pin with `.python-version` [14]. Docker builds (`heroku.yml`, `container` stack) are Cedar-only [15]; whether the button supports them is *not documented* [16]. |
| Body size | *Not documented.* Bodies with a content-length go through a 1024-byte buffer; chunked bodies stream through [17]. |
| Request timeout | **30 s** for the dyno to return its first response bytes, then a **55 s rolling window** reset by each byte from either side [17]. How the 30 s window interacts with a slow 100 MB upload isn't stated. |
| Memory | Eco and Basic: **0.5 GB** [18]. |
| Deploy button | `https://www.heroku.com/deploy?template=https://github.com/<org>/<repo>` (optionally `/tree/<branch>`, `&env[KEY]=value`), reads `app.json` in the repo root. Public or private GitHub repos. **Not available on the Fir generation** [16]. |
| Image vs repo | Builds from the GitHub tarball via the Build API [16]; the `image` key in `app.json` is deprecated [19]. |
| Secrets / prompts | `"generator": "secret"`; `"required"` (default true), `description`, `value`. `addons` provision services at deploy, e.g. `heroku-postgresql`; `scripts.postdeploy` runs once [19]. |
| Postgres | **Essential-0: $5/month** [12], 1 GB storage, 20 connections, 99.5% expected uptime [20]. |
| S3-compatible storage | No first-party storage. **Bucketeer** add-on (an AWS S3 bucket + IAM credentials): Hobbyist **$5/month**, 5 GB [21]. |
| Redis | Heroku Key-Value Store **Mini: $3/month**, 25 MB, 20 connections [12]. |
| Scheduler | **Heroku Scheduler** add-on is free; runs every 10 min, hourly or daily on one-off dynos that are billed as usage. "Execution is expected but not guaranteed"; a job may rarely be skipped or run twice [22]. |
| Free tier | **None**; cheapest is Eco $5 for 1,000 shared dyno hours [12][13]. |
| Platform status | Heroku moved to a **"sustaining engineering model"** on 2026-02-06; Enterprise contracts are no longer offered to new customers; credit-card customers see no changes [23]. |
| Client IP | `X-Forwarded-For`; the router **appends** the client IP on the right, and Heroku calls the header untrusted [17]. Only the rightmost entry is Heroku's. |

### Cloudflare (Workers and Containers)

Two different ways to run Buzzdrop:

- **Python Worker**: the Flask app runs inside Cloudflare's Pyodide (WebAssembly) runtime.
- **Container**: the existing Docker image runs in a container, but every request reaches it through a Worker and a Durable Object written in JavaScript/TypeScript.

| | Python Worker | Container |
|---|---|---|
| Runtime | Serverless isolate per request. Since 2026-09-02, WSGI frameworks (Flask, Django) run via `workers.wsgi.entrypoint(app)` [24][25]. Only part of the standard library is supported [26]. | Firecracker microVM per instance. Request path: Worker → Durable Object → container. **Sleeps after 10 min** by default (`sleepAfter`); cold start often 1–3 s. "All disk is ephemeral by default." Images must be **`linux/amd64`** [27]. The docs index titles Containers "(Beta)" [28]. |
| Python | **3.14** by default for compatibility date ≥ 2026-09-08 (Pyodide 314.0.6) [29]; Flask example requires `requires-python = ">=3.12"` [25]. | Any (it's your image). |
| Body size | Set by the zone's Cloudflare plan: **100 MB** Free/Pro, 200 MB Business, up to 5 GB Enterprise [30]. Whether "MB" means 10^6 bytes isn't stated; Buzzdrop's cap is 100 MiB (≈104.9 × 10^6 bytes) plus multipart overhead. | Same, since the request enters through a Worker [27][30]. |
| Request timeout | No wall-clock limit while the client stays connected. CPU time: **10 ms** (Free), **30 s default / 5 min max** (Paid) per request [30]. | Not covered in the container docs [27][31]. |
| Memory | **128 MB per isolate** [30]. | By instance type: `lite` 256 MiB / 1/16 vCPU / 2 GB disk, `basic` 1 GiB / ¼ vCPU / 4 GB … [32]. |
| Deploy button | `https://deploy.workers.cloudflare.com/?url=<repo>`. Public github.com/gitlab.com repos only. Reads the Wrangler config and provisions **KV, D1, R2, Hyperdrive, Durable Objects, Queues**, Secrets Store; prompts for secrets listed in `.dev.vars.example` / `.env.example` [33]. **Containers are not listed**; Python isn't mentioned [33]. No secret generation documented. | Same button; Containers aren't among the provisioned resources [33]. |
| Image vs repo | Repo (cloned into the deployer's account) [33]. | Wrangler builds or references the image; the button page doesn't cover it [33]. |
| Network database | **D1** (SQLite-based): auto-commit; `batch()` runs statements "sequentially, non-concurrently" as one transaction and rolls back on failure. The docs don't mention `BEGIN`/`BEGIN IMMEDIATE` or interactive transactions [34]. **No managed Postgres**; **Hyperdrive** only connects to an existing external database [35]. D1 on Paid: 5 GB, 25 bn rows read, 50 M rows written included [36]. | Same options, reached through the Worker or over the network to an external Postgres. |
| S3-compatible storage | **R2**: free 10 GB-month, 1 M Class A, 10 M Class B ops; then $0.015/GB-month; **egress free** [37]. | Same. |
| Redis | **None.** Options: Workers KV (1 M writes/month included on Paid, then $5/M) [36]; Durable Objects [36]; the Rate Limiting binding, which is per-location and eventually consistent, with 10 s or 60 s periods only [38]. | Same. |
| Scheduler | **Cron Triggers** in the Wrangler config, UTC, finest shown `* * * * *` [39]. 5 per account Free, 250 Paid; 15 min wall-clock per run [30]. Billed as normal Worker requests [36]. | A cron Worker can start a container through its Durable Object; Cloudflare has a "Cron container" example. Runs are not guaranteed exactly-once [40]. |
| Price | Workers Free: $0 (10 ms CPU/request). Workers Paid: **$5/month minimum**, 10 M requests + 30 M CPU-ms included [36]. | **Workers Paid required.** Included monthly: 25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk; billed per 10 ms while running, nothing while asleep [32]. |
| Client IP | `CF-Connecting-IP` (one IP); `X-Forwarded-For` appends if already present [41]. Documented for origin requests; what the Worker or container sees is not spelled out [41]. | The Worker code decides which headers it forwards to the container [27]. |

### Vercel

| | |
|---|---|
| Runtime | **Serverless functions** (Fluid compute). Python runtime runs WSGI and ASGI apps; Flask is auto-detected from `app.py` etc. with a top-level `app` [42]. **Container Runtime (beta, all plans)** runs a `Dockerfile.vercel` image as a function; scales down after **5 min** without traffic in production [43]. Same limits apply to containers [43]. |
| Python | **3.12 (default), 3.13, 3.14** [42]. Container Runtime: any image [43]. |
| Body size | **4.5 MB for the request body and for the response body**; larger payloads get `413 FUNCTION_PAYLOAD_TOO_LARGE` [44]. Vercel's workaround is client uploads straight to Vercel Blob [45]. |
| Request timeout | Max duration: Hobby **300 s**; Pro/Enterprise 300 s default, **800 s** max, 1800 s beta [44]. |
| Memory | Hobby 2 GB / 1 vCPU; Pro up to 4 GB / 2 vCPU [44]. |
| Deploy button | `https://vercel.com/new/clone?repository-url=<repo>` clones the repo into the deployer's GitHub/GitLab/Bitbucket [46]. `env=` lists required variables the deployer must fill in, with `envDescription`, `envLink`, `envDefaults` (non-secret defaults only) [47]. `stores=` creates a Blob store or a Marketplace store at deploy time [48]; `integration-ids=` requires up to 3 integrations [49]. **No secret generation** [47]. Config file: `vercel.json` [42]. |
| Image vs repo | Repo only (cloned) [46]. |
| Postgres | Through the **Marketplace** (Neon, Supabase …); credentials injected as env vars [50]. Neon Free: 1 GB storage/project, 100 CU-hours, suspends after 5 min idle; Launch is pay-as-you-go, no minimum [51]. |
| Storage | **Vercel Blob**: Hobby includes 1 GB, 10K simple ops, 2K advanced ops, 10 GB transfer; Pro $0.023/GB [52]. Uses its own SDK; an S3-compatible API isn't documented [45][50]. Any external S3 (R2, Spaces, AWS) also works over the network. |
| Redis | Through the Marketplace (Upstash) [50]. Upstash Free: 500K commands/month, 250 MB; pay-as-you-go $0.20 per 100K commands [53]. |
| Scheduler | **Cron Jobs** in `vercel.json`, which call a function. Hobby: **once per day**, ±59 min precision; Pro: once per minute [54]. |
| Price | Hobby **$0, personal non-commercial use only**; Pro **$20/month per developer seat** with $20 usage credit [52]. |
| Client IP | `x-forwarded-for` holds the client IP; Vercel **overwrites** it (no client-supplied entries). `x-real-ip` and `x-vercel-forwarded-for` are identical [55]. |

## Minimal setup cost (one small instance, 1 GB of files, light traffic)

*(arithmetic)* from the prices above; usage-based items assume the included allowances cover a small install.

| | DigitalOcean | Heroku | Cloudflare (Container) | Cloudflare (Python Worker) | Vercel Hobby | Vercel Pro |
|---|---|---|---|---|---|---|
| App | $5 (512 MiB) [4] | $7 Basic [12] | $5 Workers Paid [36] + ~$1.75 for an always-on `lite` container beyond the included allowance (CPU extra if busy; less if it sleeps) [32] | $0 Free or $5 Paid [36] | $0 [52] | $20 [52] |
| Database | $7 Dev DB [4] | $5 Essential-0 [12] | D1 included [36], or external Postgres (e.g. Neon Free $0 [51]) | same | Neon Free $0 [51] | Neon Free $0 or usage [51] |
| File storage | $5 Spaces [9] | $5 Bucketeer [21] | R2 free up to 10 GB [37] | same | Blob 1 GB included [52] | Blob $0.023/GB [52] |
| Redis | $15 Valkey [10], or $0 if counters go in Postgres | $3 Mini [12] | — (no Redis) | — | Upstash Free $0 [53] | Upstash $0 or usage [53] |
| Scheduler | Job, billed per run [4] | Free add-on + one-off dyno time [22] | Cron Trigger, billed as requests [36] | same | Cron, **daily only** [54] | Cron, per minute [54] |
| **Total/month** | **~$17** (no Redis) **– ~$32** | **~$20** | **~$7** + external DB if not D1 | **$0–5** | **$0** (non-commercial) | **~$20** |
| Free tier/trial | Static sites only | None | Workers Free (no Containers) | Workers Free (10 ms CPU) | Yes, non-commercial | — |

## Checking the map's estimates

| Map note | Finding |
|---|---|
| Vercel caps request bodies at about 4.5 MB | **Confirmed: exactly 4.5 MB** [44]. The same cap applies to **response** bodies, so downloads larger than 4.5 MB can't be streamed through the app either, and it applies to the Container Runtime too [43][44]. |
| Roughly $15–30/month for app, database and storage | **Holds for DigitalOcean (~$17 without Redis, ~$32 with) and Heroku (~$20).** Too high for Cloudflare (~$7 plus database) and Vercel (Hobby $0 but non-commercial and daily cron; Pro ~$20). |
| `storage.py` has no custom endpoint, so R2, Spaces and MinIO can't be used | Not re-checked here (code, not platform). Relevant because DigitalOcean (Spaces) and Cloudflare (R2) offer only S3-compatible storage with their own endpoints [9][37]; Heroku's Bucketeer is plain AWS S3 [21]; Vercel Blob has its own SDK [45]. |
| Expiry sweep needs a scheduled trigger | Every platform has one; minimum intervals differ: DigitalOcean cron [6], Heroku 10 min [22], Cloudflare 1 min [39], Vercel Hobby once a day [54]. |

## Cross-reference with `deploy-button-hosts.md`

Consistent with the earlier findings for these four platforms. New or corrected here:

- DigitalOcean's button supports **only Dev Databases**, not managed databases, so it can't attach Valkey or a managed Postgres [5].
- Cloudflare Python Workers gained **WSGI/Flask support on 2026-09-02** [24]; the earlier page only covered Containers.
- Vercel's Python runtime runs Flask directly (no container needed), with Python 3.12–3.14 [42].
- DigitalOcean's client IP header is `do-connecting-ip` (earlier page: not checked) [11].

## Sources

All accessed 2026-10-23.

1. DigitalOcean, App Platform limits — https://docs.digitalocean.com/products/app-platform/details/limits/
2. DigitalOcean, How to scale apps — https://docs.digitalocean.com/products/app-platform/how-to/scale-app/
3. DigitalOcean, Python buildpack — https://docs.digitalocean.com/products/app-platform/reference/buildpacks/python/
4. DigitalOcean, App Platform pricing — https://docs.digitalocean.com/products/app-platform/details/pricing/
5. DigitalOcean, Add a Deploy to DigitalOcean button — https://docs.digitalocean.com/products/app-platform/how-to/add-deploy-do-button/
6. DigitalOcean, App spec reference — https://docs.digitalocean.com/products/app-platform/reference/app-spec/
7. DigitalOcean, Manage databases in App Platform — https://docs.digitalocean.com/products/app-platform/how-to/manage-databases/
8. DigitalOcean, PostgreSQL pricing — https://docs.digitalocean.com/products/databases/postgresql/details/pricing/
9. DigitalOcean, Spaces pricing — https://docs.digitalocean.com/products/spaces/details/pricing/
10. DigitalOcean, Valkey pricing — https://docs.digitalocean.com/products/databases/valkey/details/pricing/
11. DigitalOcean, Where can I find the client IP address — https://docs.digitalocean.com/support/where-can-i-find-the-client-ip-address-of-a-request-connecting-to-my-app/
12. Heroku, Pricing — https://www.heroku.com/pricing
13. Heroku, Eco dyno hours — https://devcenter.heroku.com/articles/eco-dyno-hours
14. Heroku, Python support — https://devcenter.heroku.com/articles/python-support
15. Heroku, Building Docker images with heroku.yml — https://devcenter.heroku.com/articles/build-docker-images-heroku-yml
16. Heroku, Heroku Button — https://devcenter.heroku.com/articles/heroku-button
17. Heroku, HTTP routing — https://devcenter.heroku.com/articles/http-routing
18. Heroku, Dyno types — https://devcenter.heroku.com/articles/dyno-types
19. Heroku, app.json schema — https://devcenter.heroku.com/articles/app-json-schema
20. Heroku, Heroku Postgres plans — https://devcenter.heroku.com/articles/heroku-postgres-plans
21. Heroku Elements, Bucketeer — https://elements.heroku.com/addons/bucketeer
22. Heroku, Scheduler — https://devcenter.heroku.com/articles/scheduler
23. Heroku blog, An update on Heroku (2026-02-06) — https://www.heroku.com/blog/an-update-on-heroku/
24. Cloudflare changelog, Python Workers now support WSGI web frameworks (2026-09-02) — https://developers.cloudflare.com/changelog/post/2026-09-02-python-workers-web-framework-support/
25. Cloudflare, Flask in Python Workers — https://developers.cloudflare.com/workers/languages/python/packages/flask/
26. Cloudflare, Python Workers — https://developers.cloudflare.com/workers/languages/python/
27. Cloudflare, Container lifecycle / architecture — https://developers.cloudflare.com/containers/platform-details/architecture/
28. Cloudflare, Containers docs index (llms-full.txt) — https://developers.cloudflare.com/containers/llms-full.txt
29. Cloudflare changelog, Python 3.14 for Python Workers (2026-09-08) — https://developers.cloudflare.com/changelog/post/2026-09-08-python-workers-314/
30. Cloudflare, Workers limits — https://developers.cloudflare.com/workers/platform/limits/
31. Cloudflare, Containers limits — https://developers.cloudflare.com/containers/platform-details/limits/
32. Cloudflare, Containers pricing — https://developers.cloudflare.com/containers/pricing/
33. Cloudflare, Deploy buttons — https://developers.cloudflare.com/workers/platform/deploy-buttons/
34. Cloudflare, D1 Database API — https://developers.cloudflare.com/d1/worker-api/d1-database/
35. Cloudflare, Hyperdrive — https://developers.cloudflare.com/hyperdrive/
36. Cloudflare, Workers pricing — https://developers.cloudflare.com/workers/platform/pricing/
37. Cloudflare, R2 pricing — https://developers.cloudflare.com/r2/pricing/
38. Cloudflare, Rate Limiting binding — https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
39. Cloudflare, Cron Triggers — https://developers.cloudflare.com/workers/configuration/cron-triggers/
40. Cloudflare, Cron container example — https://developers.cloudflare.com/containers/examples/cron/
41. Cloudflare, HTTP request headers — https://developers.cloudflare.com/fundamentals/reference/http-headers/
42. Vercel, Python runtime — https://vercel.com/docs/functions/runtimes/python
43. Vercel, Container Runtime — https://vercel.com/docs/functions/runtimes/container
44. Vercel, Functions limits — https://vercel.com/docs/functions/limitations
45. Vercel, Client uploads with Vercel Blob — https://vercel.com/docs/vercel-blob/client-upload
46. Vercel, Deploy Button — https://vercel.com/docs/deploy-button
47. Vercel, Deploy Button environment variables — https://vercel.com/docs/deploy-button/environment-variables
48. Vercel, Deploy Button source — https://vercel.com/docs/deploy-button/source
49. Vercel, Deploy Button integrations — https://vercel.com/docs/deploy-button/integrations
50. Vercel, Storage overview — https://vercel.com/docs/storage
51. Neon, Pricing — https://neon.com/pricing
52. Vercel, Pricing — https://vercel.com/pricing
53. Upstash, Redis pricing — https://upstash.com/pricing/redis
54. Vercel, Cron Jobs usage and pricing — https://vercel.com/docs/cron-jobs/usage-and-pricing
55. Vercel, Request headers — https://vercel.com/docs/headers/request-headers
