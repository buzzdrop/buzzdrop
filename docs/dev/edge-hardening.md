# Edge hardening

Recommendations for the layer *in front of* Buzzdrop — TLS termination,
body handling and rate limiting belong to the ingress, not the app. The
app deliberately does not re-implement a proxy; compose the deployment
out of pieces and swap them as needed. These notes come out of the
security audit's two medium findings; how far to take them is the
deployer's call.

## The invariant

**The origin must be reachable only through the ingress.** Everything
below assumes that path is the only way in. If the gunicorn port is
reachable directly (published port, same-network peer, forgotten
firewall), forwarded-IP headers can be spoofed and slow clients reach
the worker pool unfiltered.

- Hosted edge (Render, Cloudflare): the platform routes everything
  through its edge already — verify there is no second path (direct
  origin IP, internal services that skip the edge).
- Self-hosted: publish the app port only on the internal interface, or
  set `TRUSTED_PROXY_IPS` so only the ingress's addresses may speak for
  a client IP (`docs/dev/configuration.md`, `proxy.py`).

## Slow clients (request smuggling of time)

The shipped image runs `gunicorn` with `workers=1`, `worker_class=gthread`,
`threads=8`. A gthread that accepted a connection reads the request body
on a blocking socket **with no deadline** — gunicorn's `timeout` watches
the worker, and in gthread mode the heartbeat runs on the main thread, so
body-blocked threads are never reclaimed. Eight connections trickling a
byte a minute starve the whole pool: every route, including `/healthz`,
times out while they hold. Verified against the shipped config.

The fix lives at the edge: terminate slow clients before their request
reaches gunicorn — a proxy that buffers or times out request bodies.
Reference nginx settings:

```nginx
client_header_timeout 10s;
client_body_timeout   30s;
client_max_body_size  100m;   # match MAX_CONTENT_LENGTH
proxy_pass http://buzzdrop:5000;
```

Any ingress with equivalent timeouts works (Caddy, Traefik, a cloud
load balancer). Render's edge already buffers and times out clients —
deployments there are covered by topology; a bare `docker run -p 5000`
on a host is not. If a deployment cannot guarantee an edge, raising
`threads` in `gunicorn.conf.py` only increases the attacker's cost —
it does not close the hole.

## Rate limiting

The app limits by `request.remote_addr` (`Flask-Limiter`), which is fine
as a second layer. Two gaps the edge should own:

- **Bearer-token cost.** Every `Authorization: Bearer` header costs
  ~95 ms of PBKDF2 before it can be rejected — an unauthenticated CPU
  burn. App-side per-IP limits only start counting after the KDF ran;
  an edge rule (e.g. N req/min per IP on the API routes) caps the total
  cost regardless of how the app is configured.
- **Per-identifier buckets.** Routes limited by a path id
  (`/release/<id>`, `/dropzones/<id>/release`) mint a fresh bucket per
  id — rotating ids evades them. An edge limit keyed by client IP is
  id-independent by construction.

Login (`/login`) is already rate-limited in-app; an edge rule for it is
defense in depth, not a requirement.

## What stays in the app

`TRUSTED_PROXY_IPS` (the ingress allowlist for forwarded-IP headers) and
the existing `Flask-Limiter` limits are the app's own layer — keep them
as the fallback for deployments without a managed edge.
