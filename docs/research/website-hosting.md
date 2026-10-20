# Research: hosting the static Website (buzzdrop.io) from a private repo

Ticket: #352 (part of #348). Researched 2026-10-20 against vendor docs and pricing pages.

**Question.** Where should the static marketing Website be hosted? It is built from the private repo `buzzdrop/website` (en + pl) and served at the apex `buzzdrop.io`. The App stays at `app.buzzdrop.io`.

**Criteria.** The ticket lists these:
- apex domain + TLS;
- custom response headers (CSP, HSTS, `X-Frame-Options`);
- per-language routing/redirects;
- deploy from GitHub Actions or a git push;
- preview deploys;
- cost;
- EU data residency for access logs.

## Ranked summary

| # | Host | Verdict |
|---|------|---------|
| 1 | **Cloudflare Workers + static assets** | Best fit. Free tier, `_headers`/`_redirects`, GitHub (Actions or Workers Builds) with PR preview URLs, automatic apex cert. Two catches: language redirect needs a few lines of Worker code, and EU log residency is Enterprise-only. |
| 2 | **Netlify** | Strongest built-in features: `Language=` redirect conditions, `_headers`, unlimited Deploy Previews. But a private **organization-owned** repo needs Pro ($20/mo). No documented EU log residency. |
| 3 | **Existing host / plain VPS** (nginx/Apache, EU) | Full header and `Accept-Language` control. The only option where access logs certainly stay in the EU under our own retention. No previews; we run TLS, deploys and patching. |
| 4 | **GitHub Pages** | Not suitable. No custom response headers, so CSP goes in a `<meta>` tag and `frame-ancestors`/HSTS can't be set. A private repo needs a paid plan. No PR previews. Its terms restrict sites "primarily directed at … commercial software as a service". |

**Recommendation: Cloudflare Workers static assets.**
- Deploy from GitHub Actions with `cloudflare/wrangler-action`, or connect Workers Builds for automatic PR preview URLs.
- Put the security headers in `_headers` and the static/locale-prefix redirects in `_redirects`.
- Route only `/` through the Worker (`run_worker_first: ["/"]`) to pick `/en/` or `/pl/` from `Accept-Language`.
- This needs `buzzdrop.io` DNS on Cloudflare (an active zone).

If EU-only access logs are a **hard** requirement (not just a preference), pick option 3 instead, or accept Netlify/Cloudflare under their DPF/SCC transfer terms. Neither vendor offers EU log residency below the Enterprise tier. That decision belongs to #348.

## Per-option findings

### Cloudflare Workers with static assets (also Cloudflare Pages)

- **Apex + TLS.** A Custom Domain needs "an active Cloudflare zone", and the hostname can't already have a CNAME. Creating it "generates an Advanced Certificate" automatically. [CF custom domains][cf-domains]
- **Headers.** A `_headers` file in the asset directory overrides Cloudflare's defaults. The limit is 100 rules of up to 2,000 characters per line. The rules are *not* applied to responses the Worker code generates, so those must set headers themselves. [CF headers][cf-headers]
- **Redirects.** `_redirects` allows 2,000 static and 100 dynamic rules, with splats and placeholders. "Redirect by country or language" is listed as **unsupported**, so it has to be done in Worker code. [CF redirects][cf-redirects] Selective `run_worker_first` takes an array of route patterns, so only `/` needs to hit the Worker. [CF worker-first][cf-wfirst]
- **Deploy.** There is an official GitHub Action (`cloudflare/wrangler-action`) using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets. [CF GH Actions][cf-gha] Alternatively, Workers Builds connects through the Cloudflare GitHub App, including on org repos. [CF GitHub integration][cf-ghint]
- **Previews.** With preview builds enabled, "every push to a branch that is not your production branch triggers a preview build". On a PR, Cloudflare posts a comment with the Preview URL. [CF build branches][cf-branches], [CF GitHub integration][cf-ghint]
  - Every upload also gets a Version URL. [CF previews][cf-previews]
  - Private-repo support isn't stated explicitly. The GitHub App grants per-repo access, so it is expected to work. **Unverified.**
- **Cost.** "Requests to static assets are free and unlimited". Paid is a $5/month minimum. [CF pricing][cf-pricing]
  - Requests that invoke the Worker count toward the Free plan's 100,000 requests/day. [CF limits][cf-limits] With only `/` routed through the Worker, that is ample.
  - Free plan limits: 20,000 files per version and 25 MiB per file.
- **EU log residency.** The Data Localization Suite (Customer Metadata Boundary covers "logs and analytics") is an "Enterprise-only paid add-on". [CF DLS][cf-dls]
- **Pages vs Workers.** `_headers` and `_redirects` work natively in both. Cloudflare says Workers has "a distinctly broader set of features". [CF migrate from Pages][cf-migrate] Prefer Workers for a new project.

### Netlify

- **Headers.** Set them in `_headers` or in `netlify.toml` `[[headers]]`. They apply to static files only, and some server-managed headers are ignored (e.g. `Location`, `Server`). [Netlify headers][nf-headers]
- **Language routing.** Built in. For example, `/  /pl/  302  Language=pl` matches "the first language reported by the browser in the `Accept-Language` header". `nf_lang` is a cookie override. [Netlify redirect options][nf-redirects]
- **Apex + TLS, previews.** "Custom domains with SSL support" and "Unlimited Deploy Previews" are on every plan, Free included. Deploy previews are not metered by credits. [Netlify credit plans][nf-plans]
- **Private org repo.** "Organization-owned private repos" are N/A on Free and Personal and ✓ on Pro. [Netlify credit plans][nf-plans] Pro is $20/month. [Netlify pricing][nf-pricing]
  - Netlify's forum names a workaround: deploy with the Netlify CLI from GitHub Actions instead of linking the repo. That loses the linked-repo Deploy Preview integration. [Netlify forum][nf-forum]
- **Cost.** Plans are credit-based: 1 GB of bandwidth is 20 credits, 10k requests are 2 credits, and each production deploy is 15 credits. Free has 300 credits/month. [Netlify credit plans][nf-plans], [Netlify pricing][nf-pricing]
  - Production deploys are what eat credits. 20 deploys a month on Free is 300 credits.
- **EU log residency.** None documented. Log drains are Enterprise. [Netlify pricing][nf-pricing]
  - The DPA says logs are "retained on-line for 90 days and offline for 1 year". [Netlify DPA][nf-dpa]
  - The privacy policy says data may be processed outside the EU, under DPF/SCCs. [Netlify privacy][nf-privacy]

### Existing App host / plain VPS (nginx or Apache)

- **What runs the App today.** The repo documents a Passenger WSGI entry point and a Docker compose deployment (`docs/dev/configuration.md` §Deployment). It doesn't name the host or its location. Any EU host the App already uses could serve a static docroot for the apex.
- **What we get.** Full control: every header, `Accept-Language` redirects through nginx `map` or Apache `mod_rewrite`, and our own log retention in the EU.
- **What we give up and own.** There are no preview deploys, and we own Let's Encrypt renewal, CI deploys (rsync/ssh from Actions with a deploy key) and patching.
- **Coupling.** Marketing and App share one host, so a Website incident can affect the App, which undercuts the reason for the split.
- **Cost.** About zero extra if the host is shared. Otherwise a small VPS.

### GitHub Pages

- **Private repo.** Free plan: Pages in public repos only. Pro and Team include Pages for private repos. [GitHub plans][gh-plans] Team costs $4/user/month (an introductory price for the first 12 months). [GitHub pricing][gh-pricing]
  - "Privately published" (access-controlled) Pages need Enterprise Cloud. That isn't needed here: the site is public, only the repo is private. [GitHub plans][gh-plans]
- **Apex + TLS.** Set `A`/`AAAA` records to 185.199.108–111.153, or `ALIAS`. "Enforce HTTPS" can take up to 24 hours to become available. [GH custom domain][gh-domain]
- **Headers.** GitHub's docs don't document any custom-header mechanism. Community reports agree it is unsupported, so CSP ends up in a `<meta>` tag, which can't express `frame-ancestors` or `report-uri`. [Hugo forum][hugo], [Scott Helme][helme]
  - HSTS and `X-Frame-Options` can't be set at all.
  - The only escape is a proxy in front, i.e. Cloudflare, at which point option 1 is simpler.
- **Redirects.** There is no server-side redirect mechanism. The only way is a client-side meta/JS redirect at `/`.
- **Previews.** One live deployment per site. There are no native PR previews (an inference from the docs; none are described).
- **Limits.** 1 GB site, a 100 GB/month soft bandwidth limit, a 10-minute deploy timeout, and builds via a custom Actions workflow. [GH limits][gh-limits]
- **Terms.** Pages is "not intended for or allowed to be used as a free web hosting service to run your online business" or a site "primarily directed at … providing commercial software as a service (SaaS)". [GitHub additional product terms][gh-terms] A SaaS vendor's marketing site is at best a grey area.
- **Logs.** GitHub logs visitor IP addresses. [What is GitHub Pages][gh-what] There is no EU residency option for Pages (not documented; **unverified**).

## Criteria matrix

| Criterion | Cloudflare Workers | Netlify | Own host/VPS | GitHub Pages |
|---|---|---|---|---|
| Apex + auto TLS | Yes (zone on CF) | Yes | Manual (certbot) | Yes (A/ALIAS) |
| CSP/HSTS/XFO headers | `_headers` | `_headers`/toml | Full | No (meta CSP only) |
| Accept-Language redirect | Worker code at `/` | Native `Language=` | Server config | Client-side only |
| GitHub deploy | Action or Workers Builds | Git link (Pro for org private) or CLI | Action + ssh | Action |
| PR previews | Yes | Yes (with git link) | No | No |
| Cost for us | $0 | $0 via CLI / $20 Pro | ~$0 shared | $4+/user Team or Pro |
| EU-only access logs | Enterprise only | Not offered | Yes | No |

## Open questions for #348

- Is EU-only access-log residency a hard requirement or a preference? It decides between option 1 and option 3.
- Is the `buzzdrop.io` zone already on Cloudflare, or can it move there? The App subdomain can stay pointed at its host with a DNS-only record.

[cf-domains]: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
[cf-headers]: https://developers.cloudflare.com/workers/static-assets/headers/
[cf-redirects]: https://developers.cloudflare.com/workers/static-assets/redirects/
[cf-wfirst]: https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
[cf-gha]: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
[cf-ghint]: https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/
[cf-branches]: https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
[cf-previews]: https://developers.cloudflare.com/workers/configuration/previews/
[cf-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[cf-limits]: https://developers.cloudflare.com/workers/platform/limits/
[cf-dls]: https://developers.cloudflare.com/data-localization/
[cf-migrate]: https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/
[nf-headers]: https://docs.netlify.com/manage/routing/headers/
[nf-redirects]: https://docs.netlify.com/manage/routing/redirects/redirect-options/
[nf-plans]: https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/
[nf-pricing]: https://www.netlify.com/pricing/
[nf-forum]: https://answers.netlify.com/t/connecting-to-organization-owned-private-github-repositories/76747
[nf-dpa]: https://www.netlify.com/pdf/netlify-dpa.pdf
[nf-privacy]: https://www.netlify.com/privacy/
[gh-plans]: https://docs.github.com/en/get-started/learning-about-github/githubs-plans
[gh-pricing]: https://github.com/pricing
[gh-domain]: https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site
[gh-limits]: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
[gh-terms]: https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features
[gh-what]: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
[hugo]: https://discourse.gohugo.io/t/is-it-possible-to-add-custom-http-header-in-hugo-using-github-pages/32182
[helme]: https://scotthelme.co.uk/launching-report-uri-js/
