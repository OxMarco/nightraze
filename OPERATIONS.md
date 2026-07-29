# CX22 production operations

This deployment deliberately uses one authoritative game room on one Docker
Compose host. That is the right trade-off for an initial 5–10 DAU: it keeps the
arena populated and recovery understandable. A second room, Redis, Kubernetes,
PM2, and Node cluster mode are intentionally out of scope until measured load
requires them.

## One-time Hetzner setup

1. Create an Ubuntu 24.04 LTS CX22 and install Docker Engine plus the Compose
   plugin from Docker's official apt repository. Docker must be enabled at boot.
2. Add a Hetzner Cloud Firewall allowing inbound TCP 80 and 443 from anywhere,
   and TCP 22 only from trusted administration addresses. Apply equivalent IPv6
   rules or remove the DNS AAAA record until IPv6 is configured.
3. Enable Hetzner daily backups. Take a manual snapshot after the host has been
   hardened and the first deployment succeeds.
4. Point the domain's A/AAAA records at the server. Copy `.env.example` to
   `.env`, fill it in, and run `chmod 600 .env`.
5. Configure an external uptime monitor for `https://DOMAIN/health`. Alert on
   two consecutive failures. This is intentionally external: a monitor inside
   the same VPS cannot detect loss of the VPS, Docker daemon, network, DNS, or
   TLS path.

Do not publish the Docker API or application port 3000. Only Traefik publishes
host ports. Note that Docker-published ports can bypass uncomplicated `ufw`
rules; the Hetzner firewall is the primary inbound boundary.

## Deploy and rollback

```sh
make deploy
```

Deployment pulls source, validates Compose, runs the complete test suite,
preserves the currently running application image, builds serially to reduce
CX22 contention, waits for every container to become healthy, and checks the
static site, simulation health, and WebSocket upgrade. A failed deployment
automatically restores the previous application image.

To roll back the most recent successful deployment manually:

```sh
make rollback
```

The first deployment has no rollback image. Base and infrastructure images are
pinned by digest; review and deliberately refresh those pins at least monthly so
security fixes are not missed.

## Recovery expectations

- A process exit is restarted by Docker immediately.
- A live-but-unhealthy app, Traefik, or Docker socket proxy is marked
  unhealthy after two failed checks. Autoheal gives a frozen process 5 seconds
  to stop; recovery should normally complete in roughly 20–25 seconds.
- The browser reconnects abnormal WebSocket closures with jittered exponential
  backoff capped at 15 seconds. The arena is in memory, so a server restart gives
  the player a fresh run rather than restoring the interrupted run.
- A host reboot recovers when Docker starts. Loss of the host itself requires a
  Hetzner rebuild/restore; true automatic host failover requires a second server
  and is intentionally not claimed by this single-CX22 design.

## Routine checks

```sh
make status
make health
make logs
curl -fsS https://DOMAIN/health
```

Log verbosity is set per environment, not compiled in. `LOG_LEVEL` (fatal,
error, warn, info, debug, trace, silent; unrecognized values fall back to info)
sets the threshold, and `LOG_REQUESTS` toggles Fastify's per-request
"incoming request"/"request completed" pair — off by default in production,
on elsewhere. Production therefore logs the game's own events (joins, leaves,
rejected connections, kicks, ban failures) without one line per HTTP hit; set
`LOG_REQUESTS=true` in `.env` and `make restart` when debugging the proxy or
the WebSocket upgrade. `/health` is silent at the route level regardless, so
the 3-second healthcheck never appears.

The health response includes simulation tick age, duration, scheduling delay,
total ticks, and ticks that exceeded the 40 ms budget. Investigate when tick
duration or delay repeatedly approaches 40 ms, when container memory stays over
70%, or when logs show slow clients being terminated. Because CX plans use
shared CPU, measure on the real VPS before increasing `MAX_PLAYERS`; start at 40
and raise it only after a representative load test.

## Product metrics

Metrics are stored in `/data/metrics.sqlite` on the existing durable app volume.
Set a long random `METRICS_TOKEN` in `.env` to enable the aggregate-only read
route, restart the app, then query it without exposing identifiers or IPs:

```sh
curl -sS https://DOMAIN/metrics -H "x-metrics-token: $METRICS_TOKEN"
```

For the visual dashboard, open `https://DOMAIN/metrics-dashboard` and enter the
same token. The token is kept in that browser tab's session storage, the view
refreshes every 30 seconds, and locking the dashboard removes it immediately.

The response reports current living players; DAU and coarse locations for
the last 30 days; completed run count and mean active-run duration; 30-day
mean and p95 WebSocket RTT; and 24-hour, 30-day, and lifetime ban/crash counts.
A death ends a run, while respawn begins another. Disconnect ends a living run.
Browser timezones provide coarse location by
default. If a trusted geo-aware proxy adds a two-letter country header, set
`GEO_COUNTRY_HEADER` to its lowercase header name to aggregate by country.
Never configure this to an IP header: analytics stores no raw IPs, names, or
raw browser IDs (the random browser ID is SHA-256 hashed before persistence).

Browser render errors and unhandled errors/rejections are counted by category;
messages, stack traces, URLs and user agents are discarded. Fatal uncaught
server exceptions are also counted when SQLite remains writable. OOM kills,
power loss and forced container termination require the external uptime monitor
and cannot reliably be recorded by the dying process itself.

Session, daily-user, and RTT detail older than 90 days is pruned hourly whether
or not the dashboard is open. Lifetime ban and crash events are retained. The
public browser-crash receiver accepts only the shipped error categories and is
bounded per source IP and globally so it cannot become an unbounded write path.

## Portal embedding

The game is listed on CrazyGames as an *iframe game*: they embed
`https://DOMAIN/embed` instead of hosting a copy of the bundle, so this VPS
serves portal traffic and direct traffic from the same process. `/embed` is the
same app plus the CrazyGames SDK (`client/embed.html`); `/` never loads it.

Verify after any deploy that touches the client or the framing policy:

```sh
curl -sI https://DOMAIN/embed | grep -i content-security-policy   # crazygames domains
curl -sI https://DOMAIN/       | grep -i content-security-policy   # frame-ancestors 'none'
curl -s  https://DOMAIN/       | grep -c sdk.crazygames.com        # must be 0
```

Neither response may carry `X-Frame-Options`: it cannot express a wildcard list
and, where a browser honours both, it overrides `frame-ancestors`. Adding it —
in Fastify, in Traefik, or in a "security headers" middleware — delists the game.

`EMBED_FRAME_ANCESTORS` overrides the domain list in `server/src/embedding.ts`
when a portal adds a region; leaving it empty is the normal state.
`ALLOWED_ORIGINS` stays at our own origin and must not gain the portal's: a
WebSocket's `Origin` is the document running the script, which inside the iframe
is still ours.

Portal traffic arrives in bursts against a single room capped by `MAX_PLAYERS`,
past which players are closed with 1013 and see the capacity screen. Watch
`make health` player counts and the "room full" warnings in the log during a
listing's first days — that rejection rate, not tick duration, is the first
thing a portal launch will expose.

At this traffic level, do not add worker threads merely to occupy both vCPUs.
The hard one-CPU quota has been removed, so the Node runtime, Traefik, and
Docker can use the whole machine. If one room eventually becomes CPU-bound,
first add a spatial grid to the simulation. If concurrent population can support
multiple rooms, scale with one process/container per room rather than Node
cluster workers sharing an authoritative world.
