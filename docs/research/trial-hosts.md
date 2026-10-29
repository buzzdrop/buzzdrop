# Free hosts that keep a trial Buzzdrop and its drops for 24 idle hours

Research for [#392](https://github.com/buzzdrop/buzzdrop/issues/392) (map [#373](https://github.com/buzzdrop/buzzdrop/issues/373)).
Sources are the hosts' own docs, pricing pages or repos, **accessed 2026-10-29** unless marked *(2026-10-23)*, which means carried over from the earlier pages [`deploy-button-hosts.md`](https://github.com/buzzdrop/buzzdrop/blob/research/deploy-button-hosts/docs/research/deploy-button-hosts.md) and [`platforms-without-disk.md`](https://github.com/buzzdrop/buzzdrop/blob/research/platforms-without-disk/docs/research/platforms-without-disk.md). Where a host's docs don't state something, the cell says *not documented*. Forum, staff and blog posts are marked as such. Cost lines marked *(arithmetic)* are my sums of published prices. Facts only; the shortlist is [#378](https://github.com/buzzdrop/buzzdrop/issues/378).

## In plain words

1. A trial Buzzdrop keeps its data on the server's own disk. Most free hosts put an app to sleep when nobody uses it, and on most of them waking up starts from a blank disk, so the drop is gone.
2. **Northflank** (free, no card, "always on, no sleeping") is the only free host whose docs promise the app stays up. **Railway** also doesn't put apps to sleep, but its free trial lasts 30 days and its permanent free plan is $1 of usage a month.
3. **Render** and **Koyeb** are free but put the app to sleep after 15 minutes and 1 hour of no visitors, and waking starts from a blank disk: a drop does not survive a quiet day.
4. **Fly.io**'s trial is 2 hours of running time; **Hugging Face** now charges $9/month for this kind of app; **Google Cloud Run** needs a card and drops idle servers within 15 minutes; **Cloudflare** needs a $5/month plan; **Zeabur** needs your own server.
5. Nothing here has been tested by hand yet. Even on the "yes" hosts, an unplanned restart wipes the drops, and none of them publishes how often that happens.

## The question in Buzzdrop terms

A trial runs plain SQLite and local uploads on the container's own disk, no persistent volume (map #373). A drop survives 24 idle hours only if, for 24 hours without traffic, the **same container keeps running** (no sleep that restarts it, no routine restart) **and only one instance serves requests**. The app caps uploads at 100 MiB (`config.py:61`) and reads the client IP from `request.remote_addr` with no `ProxyFix` *(2026-10-23)*.

## Per host

| Host | Free without a card? Limit on the trial | Idle behaviour | Restart / redeploy cadence | Single instance | Deploy button | Limits (body / timeout / memory) | Client-IP header | **Survives 24 idle hours** |
|---|---|---|---|---|---|---|---|---|
| **Render Free** | Card not mentioned for Free web services. No expiry; 750 instance hours per workspace per month, then all Free services are suspended until next month [1]. | Spins down after **15 min** without inbound traffic, ~1 min to wake. "Whenever a service spins down, any changes to its local filesystem are lost." [1] | Filesystem also lost on every redeploy or restart; "Render might restart a Free web service at any time." [1] | Yes: Free can't scale beyond one instance [1]. | `render.com/deploy?repo=…` reads `render.yaml`; `runtime: image` pulls the published image; `generateValue: true` generates, `sync: false` prompts at first creation *(2026-10-23)* [2]. | Body: *not documented* (only a ~6-year-old staff forum post saying no limit [3, forum]). Timeout: 100 min (Render comparison page) [4]. Memory: 512 MB *(2026-10-23)* [2]. | `X-Forwarded-For`; first-IP rule rests on a staff forum post *(2026-10-23)* [2]. | **No.** The disk is wiped 15 min after the last visit. |
| **Northflank Sandbox** | Free, "No card needed"; 2 services, up to $20/month of resources; no time limit stated [5]. | "Always on, no sleeping." [5] | Ephemeral storage "will be erased when the container is restarted or terminated" [6]. How often Northflank restarts or reschedules containers is *not documented*. A container that writes more than its ephemeral allowance (1 GB default) may be evicted and restarted [6]. | Yes: horizontal scaling and autoscaling are not included on Sandbox [5]. | Template (JSON) shared by link; recipient gets a prefilled copy and runs it; image deploys supported; `${fn.randomSecret()}` generates secrets *(2026-10-23)* [2]. | Body and timeout: *not documented* (searched). Memory: by plan, smallest 256 MB, within the $20 credit *(2026-10-23)* [2]. Note: 1 GB default ephemeral storage [6] caps SQLite plus uploads. | `X-Forwarded-For` from the load balancer; hop count not documented *(2026-10-23)* [2]. | **Yes**, per docs: no sleep, one instance. Unknown: unplanned restart frequency. Volumes are also listed as included on Sandbox [5]. |
| **Koyeb Free** | One free web service per org (512 MB, 0.1 vCPU, 2 GB SSD), never charged, no time limit [7]. The pricing FAQ says "We require a credit card to prevent fraud and abuse" without saying whether that covers Free [7]. | Scales to zero after **1 hour** without traffic; can't be disabled or changed on Free [8]. A cold start (Deep Sleep, the default) "typically takes 1 to 5 seconds to create a new dedicated virtual machine" [8]; the docs don't say in so many words that the disk is wiped. | *Not documented* for Free [9]. | Yes: Free can't have custom scaling; one Free instance per org [9]. | `app.koyeb.com/deploy?type=docker&image=…&env[KEY]=…`; all in the URL; no generation or prompt *(2026-10-23)* [2]. | Body: *not documented*. Timeout: **100 s** per HTTP request [10]. Memory: 512 MB [7]. | `X-Forwarded-For`; only the last IP is certified [10]. | **No.** After 1 h idle the instance is gone and waking builds a new VM from the image; Free can't attach a volume [9]. |
| **Railway Trial / Free** | Trial: $5 one-off credit, 30 days, "No credit card required" [11][12]. Unverified accounts get a "Limited Trial" with restricted outbound network and "a limited set of ports" [12]. After the trial: Free plan, $1 credit/month [11][12]. | No forced sleep; "Serverless" sleep (5–10 min) is something you enable [13]. | Ephemeral disk lost on redeploy *(2026-10-23)*; routine restart cadence *not documented*. When credit runs out, the plans page only documents that workloads stop for credit-paying accounts [14]. | Trial allows 2 replicas, Free 1 replica per service [14]; a template can set 1. Volumes force a single replica [15]. | Template built in the Railway dashboard, button `railway.com/deploy/<code>`; image or repo; `${{secret()}}` generates *(2026-10-23)* [2]. | Body: no size limit stated; bodies must finish uploading within **5 min**. Requests up to **15 min** while data flows [16]. Memory: Trial 1 GB, Free 0.5 GB per service [14]. Ephemeral storage 1 GB per service [14]. | `X-Real-IP` [16]. | **Yes during the 30-day trial**, per docs (no sleep). On Free, yes only while the $1 credit lasts: about $10/GB-month RAM [11], so a ~150 MB app uses about $1.50/month *(arithmetic)*. Unknown: restart frequency. 0.5 GB volume available on both [15]. |
| **Fly.io** | No free tier for new orgs. Trial: no card, ends at **2 h of Machine runtime** (shared pool) **or 7 days**; then apps stop until a card is added [17][18]. | Trial Machines "automatically stop after running for 5 minutes" [18]. Fly Proxy can auto-start on request. Machines "provide ephemeral storage, a blank slate on every startup" [19]. | Machine updates take it down and back up [19]; host maintenance *not documented*. | Yes, if the app has one Machine (`fly scale count 1`); not checked further. | No web button; CLI `fly launch --from <repo>`; secrets via `fly secrets set` only *(2026-10-23)* [2]. | Body and timeout: *not documented* (not checked). Memory: up to 4 GB on trial [18]. | `Fly-Client-IP` *(2026-10-23)* [2]. | **No.** Every 5-minute stop restarts from a blank disk, and the trial ends after 2 h runtime or 7 days. A volume (20 GB included in the trial [18]) would keep data across stops, but only until the trial ends. |
| **Zeabur** | Free plan manages 1 server "you purchased and own elsewhere"; no Zeabur-hosted compute listed [20]. Dev/Pro: first 14 days free [20]. | n/a on Free | n/a | n/a | Template YAML published with the CLI *(2026-10-23)* [2]. | Upload of a single file up to 50 MB is a dashboard limit, not an app one [20]. | *Not documented* *(2026-10-23)* [2]. | **No free host.** The deployer must bring a server. |
| **Cloudflare Containers** | Requires **Workers Paid ($5/month)** *(2026-10-23)* [21]. | Sleeps after 10 min by default (`sleepAfter`); "All disk is ephemeral by default." *(2026-10-23)* [22] | *Not documented* | Per Durable Object; routing is code the app author writes *(2026-10-23)* [22]. | Workers button doesn't list Containers *(2026-10-23)* [23]. | Body 100 MB on Free/Pro zones (unit unstated) *(2026-10-23)* [24]. | `CF-Connecting-IP` at the edge; what reaches the container depends on the Worker *(2026-10-23)* [22]. | **No.** Not free; disk ephemeral and sleeps. |
| **Hugging Face Docker Spaces** | CPU Basic (2 vCPU, 16 GB, 50 GB disk) has no hourly cost, but "creating a Space that runs on compute (Gradio or Docker) requires a paid plan" (PRO **$9/month**) [25][26][27]. | CPU Basic sleeps after **48 hours** of inactivity; a visitor restarts it [26]. | "The data written on disk is lost whenever your Docker Space restarts" [28]; a push rebuilds and restarts [25]. Routine cadence *not documented*. | Yes: replicas are only for paid hardware [26]. | No deploy URL; "Duplicate this Space" copies a Space; public Variables carry over, Secrets are prompted (not generated) [25]. Builds from the Space's Dockerfile [28]. Runs as UID 1000 [28]. | Body and timeout: *not documented*. Memory 16 GB [26]. | *Not documented.* | **No free tier** for Docker Spaces. On PRO with CPU Basic, 24 idle hours fits within the 48-hour sleep window. |
| **Google Cloud Run** | Free tier needs a billing account; the $300/90-day trial needs a card [29]. Free tier: 2 M requests, 360,000 GB-s, 180,000 vCPU-s per month [29]. | Scales to zero by default; idle instances kept "up to 15 minutes" [30]. Filesystem is in memory and "doesn't persist when the instance stops" [31]. | "An idle instance can be shut down at any time", even one kept warm by min-instances [31]. | Max instances is an upper limit per revision that "can be exceeded under normal operation a few times per week" for up to ~15 min [30]. Not guaranteed. | `deploy.cloud.run` button; `app.json` `env` with `generator: secret`, `required`, prompts; builds from source, no prebuilt-image path; "not an officially supported Google product" [32]. | Body **32 MiB** on HTTP/1 (no limit with an HTTP/2 server) [33]; timeout up to 60 min [33]; memory up to 32 GiB, shared with the in-memory disk [33]. | *Not checked.* | **No.** Needs a card; idle instances stop within 15 min and lose the disk; one instance not guaranteed; 100 MiB uploads exceed 32 MiB on HTTP/1. |
| **Back4App Containers** (other) | Free: 0.25 shared CPU, 256 MB RAM, 100 GB transfer, "no credit card required"; one container per plan [34]. | *Not documented* on the pricing page. A Back4App blog guide says free plans may sleep after inactivity, with no timing [35, blog]. | *Not documented* | One container per plan [34]; scaling *not documented*. | Deploys from GitHub; a deploy-button URL is *not documented*. | *Not documented.* Memory 256 MB [34]. | *Not documented.* | **Unknown.** Sleep and disk behaviour aren't in the docs. |
| **Leapcell** (other) | Hobby $0, 20 projects; a $1 card check is mentioned in the FAQ [36]. | Hobby includes serverless only; persistent servers are a paid-plan feature [36]. Serverless: "Only the `/tmp` directory is writable", CPU suspended when idle [37]. | *Not documented* | No: serverless "can scale to thousands of instances" [37]. | *Not checked.* | *Not documented.* | *Not checked.* | **No.** Free tier is serverless with many instances, each with its own disk. |

Vercel is out by the ticket's own terms. Heroku and DigitalOcean App Platform have no free container tier *(2026-10-23)*.

## Open points

- **Unplanned restarts.** No "yes" host (Northflank, Railway) documents how often a container is restarted or moved for maintenance. Only the hands-on 24-hour idle check from the map can answer it.
- **Northflank** request body and timeout limits aren't documented; a 100 MiB upload needs testing. The 1 GB ephemeral default may evict a container that fills it.
- **Railway Free**: what happens when the $1 credit runs out isn't documented for the Free plan specifically; and whether a "Limited Trial" (unverified) account can serve public HTTP on the app's port is unclear from "a limited set of ports".
- **Koyeb**: whether the Free instance can use Light Sleep (snapshot) isn't stated; the default Deep Sleep starts a new VM.

## Sources (accessed 2026-10-29 unless noted)

1. Render, Deploy for free — https://render.com/docs/free
2. Buzzdrop research, Deploy-button hosts (accessed 2026-10-23) — https://github.com/buzzdrop/buzzdrop/blob/research/deploy-button-hosts/docs/research/deploy-button-hosts.md, and the host pages cited there
3. Render community, "Request size limits" (staff post, forum) — https://community.render.com/t/request-size-limits/552
4. Render, Render vs Vercel — https://render.com/docs/render-vs-vercel-comparison
5. Northflank, Pricing — https://northflank.com/pricing
6. Northflank, Increase storage — https://northflank.com/docs/v1/application/scale/increase-storage
7. Koyeb, Pricing FAQ — https://www.koyeb.com/docs/faqs/pricing
8. Koyeb, Scale-to-zero — https://www.koyeb.com/docs/run-and-scale/scale-to-zero
9. Koyeb, Instances — https://www.koyeb.com/docs/reference/instances
10. Koyeb, Edge network — https://www.koyeb.com/docs/reference/edge-network
11. Railway, Pricing — https://railway.com/pricing
12. Railway, Free trial — https://docs.railway.com/reference/pricing/free-trial
13. Railway, App sleeping — https://docs.railway.com/reference/app-sleeping
14. Railway, Plans — https://docs.railway.com/reference/pricing/plans
15. Railway, Volumes — https://docs.railway.com/reference/volumes
16. Railway, Public networking specs and limits — https://docs.railway.com/networking/public-networking/specs-and-limits
17. Fly.io, Pricing — https://docs.fly.io/about/pricing
18. Fly.io, Free trial — https://docs.fly.io/about/free-trial
19. Fly.io, Machines overview — https://docs.fly.io/machines/overview
20. Zeabur, Pricing — https://zeabur.com/pricing
21. Cloudflare, Containers pricing (accessed 2026-10-23) — https://developers.cloudflare.com/containers/pricing/
22. Cloudflare, Container lifecycle (accessed 2026-10-23) — https://developers.cloudflare.com/containers/platform-details/architecture/
23. Cloudflare, Deploy buttons (accessed 2026-10-23) — https://developers.cloudflare.com/workers/platform/deploy-buttons/
24. Cloudflare, Workers limits (accessed 2026-10-23) — https://developers.cloudflare.com/workers/platform/limits/
25. Hugging Face, Spaces overview — https://huggingface.co/docs/hub/spaces-overview
26. Hugging Face, GPU Spaces (hardware, sleep time, replicas) — https://huggingface.co/docs/hub/spaces-gpus
27. Hugging Face, Pricing — https://huggingface.co/pricing
28. Hugging Face, Docker Spaces — https://huggingface.co/docs/hub/spaces-sdks-docker
29. Google Cloud, Free cloud features — https://docs.cloud.google.com/free/docs/free-cloud-features
30. Google Cloud Run, Instance autoscaling — https://docs.cloud.google.com/run/docs/about-instance-autoscaling
31. Google Cloud Run, Container runtime contract — https://docs.cloud.google.com/run/docs/container-contract
32. GoogleCloudPlatform/cloud-run-button README — https://github.com/GoogleCloudPlatform/cloud-run-button
33. Google Cloud Run, Quotas and limits — https://docs.cloud.google.com/run/quotas
34. Back4App, Containers pricing — https://www.back4app.com/pricing/container-as-a-service
35. Back4App blog, Deploy your Node.js backend for free (blog) — https://blog.back4app.com/deploy-node-js-backend/
36. Leapcell, Pricing — https://leapcell.io/pricing
37. Leapcell, Serverless vs Persistent — https://docs.leapcell.io/serverless-vs-persistent
