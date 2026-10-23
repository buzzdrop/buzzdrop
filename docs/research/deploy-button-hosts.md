# Deploy-button hosts that can run Buzzdrop as it is

Research for [#374](https://github.com/buzzdrop/buzzdrop/issues/374) (map [#373](https://github.com/buzzdrop/buzzdrop/issues/373)).
All sources are the hosts' own docs, pricing pages or repos, **accessed 2026-10-23**. Where a host's docs don't state something, the cell says *not documented* rather than guessing. Forum or staff posts are marked as such.

"As it is" means: one long-running container, a persistent volume for `data/` (SQLite) and uploads, the in-process expiry sweep, and the in-memory rate limiter. That also means **one instance only**, and a host that scales to zero pauses the sweep and resets the rate limiter.

## Relevant fact about the app

Buzzdrop reads the client IP from `request.remote_addr` (`utils.py:226`) and has no `ProxyFix` (`app.py:1199`). On every host below at least one proxy sits in front of the container, so without proxy handling the app sees the proxy's IP. The "Proxy" row tells you which header each host sets.

## Hosted PaaS

### Render

| | |
|---|---|
| Button | `https://render.com/deploy?repo=https://github.com/<org>/<repo>` reads `render.yaml` (Blueprint) from that repo. Public repos work out of the box. [1] |
| Image vs repo | `runtime: image` pulls a prebuilt image from any registry it can reach; `repo` is not used then [2]. The `render.yaml` still has to live in the repo the button points at. Image services don't auto-redeploy when `latest` moves; redeploy by hand or deploy hook [3]. |
| Volume | `disk:` (`name`, `mountPath`, `sizeGB`) in the Blueprint [2]. Paid instances only, not Free [4][5]. One instance, no scaling, no zero-downtime deploys, size can grow but not shrink [4]. **$0.25/GB/month** [6]. |
| Env vars | `generateValue: true` makes a random base64 256-bit value. `sync: false` prompts the deployer, but **only at the first Blueprint creation** [2]. Editable later in the dashboard. |
| Cost | Free: $0, 512 MB, 0.1 CPU. Starter: **$7/month**, 512 MB, 0.5 CPU [6]. With a 1 GB disk: about **$7.25/month**. |
| Free tier | Spins down after 15 min without traffic (about 1 min to wake). Filesystem lost on redeploy, restart or spin-down. No disks. 750 instance hours/month [5]. |
| Proxy | `X-Forwarded-For`. The docs don't say which header or how many hops. A Render staff post says the first IP is the client's; a user in the same thread reports Render appends to a client-sent header rather than replacing it [7, forum]. |
| Architecture | Images must be `linux/amd64` [3]. |

### Railway

| | |
|---|---|
| Button | Image `https://railway.com/button.svg` linking to a published template, `https://railway.com/deploy/<code>` [8]. The template is built and stored in the Railway dashboard, **not read from a file in the repo** [9]. |
| Image vs repo | A template service can be a GitHub repo or a Docker image [9]. Repo-based services deploy from the template repo until the deployer "ejects" to a copy [10]. |
| Volume | Attached to a service in the template (mount path) [9]. Defaults: 0.5 GB on Free/Trial, 5 GB on Hobby. One volume per service, no replicas, short downtime on each redeploy. Images running as non-root may need `RAILWAY_RUN_UID=0` [11]. About **$0.15/GB/month** [12]. |
| Env vars | `${{secret(length?, alphabet?)}}` generates a secret at deploy time (32 chars default) [9]. The docs say to "add required Variables" but don't define an optional/required flag [9]. Editable later in the dashboard. |
| Cost | Trial: one-off $5 credit, 30 days, no card. Free: $1 credit/month, 1 vCPU / 0.5 GB per service. Hobby: **$5/month including $5 usage** [12]. RAM about $10/GB/month, CPU about $20/vCPU/month [12], so an always-on 256 MB service runs about $2.50 in RAM alone: it fits inside Hobby's $5, not inside Free's $1. |
| Free tier | No forced sleep; "Serverless" sleeping is a per-service setting [13]. Free/Trial volume data is deleted 30 days after expiry [14]. |
| Proxy | `X-Real-IP` carries the client IP; `X-Forwarded-Proto` is always `https` [15]. `X-Forwarded-For` and hop count not documented. |
| Architecture | Not in the docs. Railway staff on its forum: x86 only, no arm64 plans [16, forum]. |

### Fly.io

| | |
|---|---|
| Button | **No web deploy button.** The closest is the CLI: `fly launch --from <repo-url>` clones the repo and launches it as a new app [17, staff forum post]. The deployer needs `flyctl`. |
| Image vs repo | `fly.toml` `[build] image = "..."` deploys an existing public image with no build [18]. |
| Volume | `[[mounts]] source/destination/initial_size` in `fly.toml`; created by `fly launch` or `fly deploy` [18]. **$0.15/GB/month** of provisioned size [19]. |
| Env vars | `[env]` is for non-secret values only. `fly.toml` **cannot generate or prompt for secrets**; they are set with `fly secrets set` [18]. |
| Cost | No free tier for new orgs. Trial: 2 h of Machine runtime or 7 days, whichever ends first, no card [19]. `shared-cpu-1x` 256 MB **$2.19/month**, 512 MB $3.69/month [19]. |
| Free tier | None. `auto_stop_machines` defaults to `"off"` [18]. |
| Proxy | `Fly-Client-IP` (client IP as Fly Proxy saw it); `X-Forwarded-For` also has it. The docs' example shows one proxy [20]. |
| Architecture | Not in the current docs. Staff forum post (about 4 years old): no arm64 Machines [21, forum]. |

### DigitalOcean App Platform

| | |
|---|---|
| Button | `https://cloud.digitalocean.com/apps/new?repo=https://github.com/<owner>/<repo>/tree/<branch>`, reads `.do/deploy.template.yaml` (an app spec under `spec:`). **Public repos only** [22]. |
| Image vs repo | The app spec supports `image` (`registry_type: GHCR`/`DOCKER_HUB`) [23], but the button docs show only `git` sources [22]. |
| Volume | **None.** "App Platform does not support volumes." Local disk is capped at 4 GiB and lost on every deploy or container replacement [24]. |
| Env vars | Prompts at creation for variables with a placeholder or no value; `SECRET` type. No secret generation [22]. |
| Cost | Free tier is static sites only. Cheapest container 512 MiB **$5/month** [25]. |
| Proxy | Not checked: the host is ruled out by the volume. |
| Architecture | AMD64 only [24]. |

### Koyeb

| | |
|---|---|
| Button | `https://app.koyeb.com/deploy?type=docker&image=...&name=...&env[KEY]=value&instance_type=...&regions=...`. Everything is in the URL query; no repo file [26]. |
| Image vs repo | `type=docker` with `image=` deploys a published image [26]. |
| Volume | **No volume parameter is documented for the button** [26]. Volumes are "in public preview and … currently only suitable for testing", only on standard (not `eco` or `free`) instances, only in `was` and `fra`, 1–10 GB, scale 1 only [27]. Volume price **not published** on the pricing page or the pricing FAQ [28][29]. |
| Env vars | Only fixed values the button author writes in the URL. No generation, no prompt documented [26]. |
| Cost | One free web service per org: 512 MB, 0.1 vCPU, 2 GB SSD [29]. Cheapest standard (volume-capable) instance `nano`: 256 MB, **$2.68/month** [30]. |
| Free tier | Scales to zero after 1 h without traffic [30]. No volumes on free [27]. |
| Proxy | `X-Forwarded-For`; Koyeb appends the connecting IP and says "the last IP of the `x-forwarded-for` is the only IP we can certify as valid" [31]. Hop count not documented. |
| Architecture | Not documented [30]. |

### Northflank

| | |
|---|---|
| Button | A template (JSON, editable in the UI) shared by link; the recipient gets a copy prefilled in their account and runs it [32]. Public templates are listed as `northflank.com/stacks/<slug>`. The template can live in the repo with GitOps sync [33]. |
| Image vs repo | A deployment service can "deploy an image from a container registry" [34]. |
| Volume | Volume node in the template [34]. Sandbox lists volumes as included (no stated quota). **$0.11657/GiB/month** [35]. |
| Env vars | `${fn.randomSecret(length, encoding)}` in argument overrides, generated once and kept across runs [36]. Secrets belong in the deployer's own argument overrides, not in the shared template [32]. |
| Cost | Sandbox: free, **no card**, 2 services, up to $20/month of resources, "Always on, no sleeping" [35]. Smallest plan `nf-compute-10` (0.1 vCPU, 256 MB) about **$2.70/month** (Northflank blog; the plan list on the pricing page is collapsed) [37]. |
| Free tier | No sleep [35]. |
| Proxy | `X-Forwarded-For`, added by the Northflank load balancer [38]. Hop count not documented. |
| Architecture | Not documented. |

### Heroku

| | |
|---|---|
| Button | `https://www.heroku.com/deploy?template=https://github.com/<org>/<repo>` reads `app.json`. Not available on the Fir generation [39]. |
| Image vs repo | Builds from a GitHub source tarball via the Build API [39]; the `image` key in `app.json` is deprecated [40]. |
| Volume | **None.** The dyno filesystem is ephemeral and wiped on every stop or restart [41]. |
| Env vars | `"generator": "secret"`, `"required": false`, `description`, `value` [40]. |
| Cost | No free tier. Eco $5/month (sleeps after 30 min), Basic $7/month [42]. |
| Proxy | `X-Forwarded-For`, router appends the client IP on the right; Heroku calls the header untrusted [43]. |

### Zeabur

| | |
|---|---|
| Button | A snippet generated by the template author from the Zeabur dashboard; it points at a published template [44]. The template is a YAML file published with the `zeabur` CLI [45]. |
| Image vs repo | Template services use images (examples use Docker Hub images; `ghcr.io` not mentioned) [45]. |
| Volume | `volumes: [{id, dir}]`; data persists "until the service is deleted" [45]. Price not published for the current plans. |
| Env vars | `${PASSWORD}` is a random password per service; template `variables` of type `STRING` or `DOMAIN` prompt the deployer [45]. |
| Cost | Shared clusters are deprecated: "New projects can no longer be created on shared clusters" [46]. The deployer needs their own server (Free plan manages 1) or a server bought through Zeabur (cheapest $2 → $3/month from 2026-06-01, 2 vCPU / 2 GB) [47][48]. Dev plan $5/month, 14-day trial [47]. |
| Proxy | Not documented. |
| Architecture | Not documented. |

### Vercel (ruled out)

The new Container runtime (beta, `Dockerfile.vercel`) runs an image as a Vercel Function that scales down after 5 min without traffic [49]. Functions have a read-only filesystem with 500 MB `/tmp` [50]. Daemons run continuously but "have no persistent local storage" and receive no HTTP traffic [51]. Vercel's own Render migration guide says to replace disks and SQLite with external storage [52]. **No persistent disk: Buzzdrop does not run as it is.**

### Cloudflare Containers / Workers (ruled out)

Containers require Workers Paid ($5/month) [53]. "All disk is ephemeral by default", containers sleep after 10 min by default, and every request goes through a Worker [54]. Persistence means snapshots, Durable Object storage or R2 mounts, all of which need code changes. The Workers deploy button (`https://deploy.workers.cloudflare.com/?url=<repo>`) clones the repo into the deployer's account and prompts for secrets from `.dev.vars.example`, but its docs don't list Containers among supported resources [55]. **Buzzdrop does not run as it is.**

## Template catalogues for self-hosted PaaS

The deployer brings their own server, so cost is the VPS. Each catalogue is a Docker Compose file in a shared repo that the PaaS maintainers merge; the template runs the published image directly.

| | Coolify | Dokploy | CapRover |
|---|---|---|---|
| Template | `templates/compose/<service>.yaml` in `coollabsio/coolify`, with header comments (`# slogan`, `# port`, …) [56] | `blueprints/<id>/` in `Dokploy/templates`: `docker-compose.yml`, `template.toml`, `meta.json` [57] | `public/v4/apps/<app>.yml` in `caprover/one-click-apps`, `captainVersion: 4` [58] |
| Image | `image:` in compose; pin a version, no `latest` [56] | `image:` in compose [57] | `image:`; only `image`, `environment`, `ports`, `volumes`, `depends_on`, `hostname`, `command`, `cap_add` are read [58] |
| Volume | Named volume, shown under Persistent Storage [59] | `[[config.mounts]]` and compose volumes [57] | `volumes:` [58] |
| Generated secret | `SERVICE_PASSWORD_<ID>`, `SERVICE_REALBASE64_<ID>`, … persist across deploys [59] | `${password:32}`, `${base64:64}`, `${hash}`, `${uuid}`, … [57] | `$$cap_gen_random_hex(length)` [58] |
| Prompt / optional | `${VAR:?}` required (blocks deploy), `${VAR:-default}` optional [59] | `[variables]` with helpers or literal defaults [57] | `variables` with `id`/`label`/`defaultValue`/`validRegex`; fields are optional unless `validRegex` is set [58] |
| Edit later | Yes, Environment Variables page [59] | Not checked | Not checked |
| Acceptance | **External contributions temporarily paused**; 1,000 GitHub stars needed [56] | PR to the repo; each PR gets a preview deploy [57] | PR after testing on your own CapRover [58] |
| Proxy | Traefik (default) appends the client to `X-Forwarded-For` [60] | Traefik, same [60] | nginx sets `X-Real-IP $remote_addr` and `X-Forwarded-For` [61] |
| Cost | Self-hosted free; Coolify Cloud $5/month, bring your own servers [62] | Self-hosted, free | Self-hosted, free |

## Fits / doesn't fit as it is

| Host | Verdict | Reason |
|---|---|---|
| Render | **Fits** | Image + disk + generated + prompted env in `render.yaml`. About $7.25/month (Starter + 1 GB), slightly over $7; no free path with a disk. Prompted values only at first creation. |
| Railway | **Fits** | Image + volume + `${{secret()}}` in a dashboard template. Trial $5/30 days, then Hobby $5/month; Free $1 credit too small. Template isn't a repo file. |
| Northflank | **Fits** | Image + volume + `randomSecret` in a template, free Sandbox with no sleep and no card. Sharing is a "copy template, add overrides, run" flow rather than a one-click form. |
| Zeabur | **Fits only with a server** | Template supports image, volume and `${PASSWORD}`, but no shared cluster for new projects, so the deployer must bring or buy a server. |
| Koyeb | **Doesn't fit as a button** | The button can't attach a volume or generate/prompt a secret; volumes are preview-only and not on the free instance. |
| Fly.io | **Doesn't fit as a button** | No web button (CLI `fly launch --from`); secrets can't be generated. Cheap otherwise (~$2.34/month with 1 GB). |
| DigitalOcean App Platform | **Doesn't fit** | No volumes. |
| Heroku | **Doesn't fit** | No volumes; builds from source. |
| Vercel | **Doesn't fit** | No persistent disk; scale-to-zero. |
| Cloudflare Containers | **Doesn't fit** | Ephemeral disk, sleeps; persistence needs code changes. |
| Coolify / Dokploy / CapRover | **Fit (own server)** | Compose + volume + generated secrets. Coolify isn't accepting new templates right now. |

## Open points

- Proxy hop counts are undocumented on every host except Fly (one hop in its example). Confirming them is part of the hands-on test.
- Koyeb volume pricing and Zeabur volume pricing are not published.
- arm64: only Render, DigitalOcean and Cloudflare document amd64-only; Railway and Fly say so only on forums; the rest don't say.

## Sources (accessed 2026-10-23)

1. Render, Deploy to Render button — https://render.com/docs/deploy-to-render
2. Render, Blueprint spec — https://render.com/docs/blueprint-spec
3. Render, Deploying an image — https://render.com/docs/deploying-an-image
4. Render, Persistent disks — https://render.com/docs/disks
5. Render, Free instances — https://render.com/docs/free
6. Render, Pricing — https://render.com/pricing
7. Render feedback forum, "Send the correct X_FORWARDED_FOR" (staff answer) — https://feedback.render.com/features/p/send-the-correct-xforwardedfor
8. Railway, Publish and share templates — https://docs.railway.com/templates/publish-and-share
9. Railway, Create a template — https://docs.railway.com/guides/create
10. Railway, Deploy a template — https://docs.railway.com/guides/deploy
11. Railway, Volumes — https://docs.railway.com/reference/volumes
12. Railway, Pricing — https://railway.com/pricing
13. Railway, App sleeping — https://docs.railway.com/reference/app-sleeping
14. Railway, Plans — https://docs.railway.com/reference/pricing/plans
15. Railway, Public networking specs and limits — https://docs.railway.com/networking/public-networking/specs-and-limits
16. Railway Station forum, "Supported architectures" — https://station.railway.com/questions/supported-architectures-06e77576
17. Fly.io community, "Pre-configured Apps" (staff post) — https://community.fly.io/t/pre-configured-apps/19110
18. Fly.io, fly.toml configuration — https://docs.fly.io/reference/configuration
19. Fly.io, Pricing — https://docs.fly.io/about/pricing
20. Fly.io, Request headers — https://docs.fly.io/networking/request-headers
21. Fly.io community, "Are arm64 Fly machines available?" — https://community.fly.io/t/are-arm64-fly-machines-available/5902
22. DigitalOcean, Add a Deploy to DigitalOcean button — https://docs.digitalocean.com/products/app-platform/how-to/add-deploy-do-button/
23. DigitalOcean, App spec reference — https://docs.digitalocean.com/products/app-platform/reference/app-spec/
24. DigitalOcean, App Platform limits — https://docs.digitalocean.com/products/app-platform/details/limits/
25. DigitalOcean, App Platform pricing — https://docs.digitalocean.com/products/app-platform/details/pricing/
26. Koyeb, Deploy to Koyeb button — https://www.koyeb.com/docs/deploy-to-koyeb-button
27. Koyeb, Volumes — https://www.koyeb.com/docs/reference/volumes
28. Koyeb, Pricing — https://www.koyeb.com/pricing
29. Koyeb, Pricing FAQ — https://www.koyeb.com/docs/faqs/pricing
30. Koyeb, Instances — https://www.koyeb.com/docs/reference/instances
31. Koyeb, Edge network — https://www.koyeb.com/docs/reference/edge-network
32. Northflank, Share a template — https://northflank.com/docs/v1/application/infrastructure-as-code/share-a-template
33. Northflank, Infrastructure as code — https://northflank.com/docs/v1/application/infrastructure-as-code/infrastructure-as-code
34. Northflank, Template nodes — https://northflank.com/docs/v1/application/infrastructure-as-code/template-nodes
35. Northflank, Pricing — https://northflank.com/pricing
36. Northflank, Make a template dynamic — https://northflank.com/docs/v1/application/infrastructure-as-code/make-a-template-dynamic
37. Northflank blog, Railway alternatives (nf-compute-10 price) — https://northflank.com/blog/railway-alternatives
38. Northflank, Networking — https://northflank.com/docs/v1/application/network/networking-on-northflank
39. Heroku, Heroku Button — https://devcenter.heroku.com/articles/heroku-button
40. Heroku, app.json schema — https://devcenter.heroku.com/articles/app-json-schema
41. Heroku, Dynos — https://devcenter.heroku.com/articles/dynos
42. Heroku, Pricing — https://www.heroku.com/pricing
43. Heroku, HTTP routing — https://devcenter.heroku.com/articles/http-routing
44. Zeabur, Deploy button — https://zeabur.com/docs/en-US/deploy/deploy-button
45. Zeabur, Template format — https://zeabur.com/docs/en-US/template/template-format
46. Zeabur, Platform overview — https://zeabur.com/docs/en-US/get-started/platform-overview
47. Zeabur, Pricing — https://zeabur.com/pricing
48. Zeabur, Server & VPS price update — https://zeabur.com/pricing/server-price-update
49. Vercel, Container runtime — https://vercel.com/docs/functions/runtimes/container
50. Vercel, Runtimes — https://vercel.com/docs/functions/runtimes
51. Vercel KB, Functions, containers and Daemons — https://vercel.com/kb/guide/vercel-functions-containers-daemons
52. Vercel KB, Migrate a Python API from Render — https://vercel.com/kb/guide/migrate-a-python-api-from-render-to-vercel
53. Cloudflare, Containers pricing — https://developers.cloudflare.com/containers/pricing/
54. Cloudflare, Container lifecycle — https://developers.cloudflare.com/containers/platform-details/architecture/
55. Cloudflare, Deploy buttons — https://developers.cloudflare.com/workers/platform/deploy-buttons/
56. Coolify, Contribute a service — https://coolify.io/docs/get-started/contribute/service
57. Dokploy templates README — https://github.com/Dokploy/templates
58. CapRover one-click-apps README — https://github.com/caprover/one-click-apps
59. Coolify, Docker Compose — https://coolify.io/docs/knowledge-base/docker/compose
60. Traefik, Entrypoints (forwardedHeaders) — https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/
61. CapRover nginx server block template — https://github.com/caprover/caprover/blob/master/template/server-block-conf.ejs
62. Coolify, Pricing — https://coolify.io/pricing
