# crazygame — the CrazyGames build

A standalone copy of the game client, built to be zipped and uploaded to the
CrazyGames developer portal. CrazyGames serves it from their CDN; this repo's
server does not serve it at all.

```
npm install
npm run build      # -> dist/
npm run package    # -> nightraze-crazygames.zip, the upload artifact
npm run dev        # localhost:5174, proxying /play to a local server
```

`dist/` is 18 files and about 456 kB against portal budgets of 1500 files,
50 MB initial download and 250 MB total.

## Why this is a copy and not a second entry point

It is a copy because we chose one, not because it had to be. `client/` used to
build two documents — `index.html` for nightraze.io and `embed.html` for the
portal — sharing every chunk, and the `platform/` interface exists precisely so
one codebase can serve both. That worked; the portal integration was complete
under it.

What it cost was that `client/` had to stay portal-aware. Separating them buys
nightraze.io a client with no SDK in it and buys this build the freedom to
answer to the portal alone — most visibly, to have no start screen. What it
costs is this file: two copies of one game, which drift unless someone stops
them.

## What actually differs from `client/`

Everything not listed here is byte-identical, and a fix to any of it belongs in
both trees. `diff -rq client/src crazygame/src` is the check, and it should
never return more than this:

| Path | Difference |
|---|---|
| `src/config.ts` | **Only here.** The arena's origin, baked in at build time. `client/` derives it from `location` because the server serves that bundle; this one is served from CrazyGames' CDN, so `location` names their host and every connection is cross-origin. |
| `src/main.tsx` | Installs `crazyGamesPlatform` and awaits `ready()` before the first render, because the SDK's data module only answers after `init()` resolves. `client/`'s installs nothing and renders immediately. |
| `src/App.tsx` | Imports `config` rather than deriving it. `Screens` joins on mount instead of showing `StartScreen`, falls back to `StartScreen` only for a connection that closed, and renders `<Descending />` through the handshake. `Arena` renders `<NameOverlay />` inside `<DeathOverlay>`, never over the live arena. |
| `src/game/session.ts` | `useAutoJoin` joins unconditionally on mount. `followedInviteLink()` and `hostWantsInstantPlay()` are gone — they decided when to skip a screen that no longer stands in the way. |
| `src/index.css` | Adds `.descending`. |
| `src/ui/nameOverlay.*` | **Only here.** The start screen's name field, asked on every death screen, pre-filled. |
| `src/platform/crazygames.ts` | **Only here.** The SDK adapter. `client/` no longer carries one. |
| `src/metrics/` | **Only in `client/`.** The dashboard is nightraze.io's own operational surface and has no business in a portal build. |

`index.html` differs wholesale and is meant to: this one loads the SDK, uses
relative paths, and carries no canonical, Open Graph, structured data or
manifest, because it is never the page anyone finds or shares.

## Things that will break if you forget them

**Relative paths.** `base: "./"` in `vite.config.ts` is load-bearing. Uploaded
builds are served from a subdirectory of the portal's CDN, so an absolute
`/assets/...` resolves against their root and 404s. This also applies to
`public/fonts/fonts.css`, whose `url()`s were rewritten from `/fonts/…` to
`./…` when it was copied here.

**The server origin.** `VITE_SERVER_ORIGIN` unset means `https://nightraze.io`.
Point a build at staging by setting it; there is no runtime switch.

**`PORTAL_ORIGINS` on the server — this one blocks the launch.** This build
connects cross-origin, so the socket's `Origin` is CrazyGames', not ours.
Production already restricts `/play` to `https://$DOMAIN`, verified against the
live server:

```
WS open from https://games.crazygames.com  ->  close 1008 "origin not allowed"
```

So until the portal's origin is added, every portal player is refused and the
game does not start for anyone. The iframe's `src` is misleading here: it names
`games.crazygames.com`, but the document that opens the socket is served from
`https://nightraze.game-files.crazygames.com`, which is what the server log's
refused `Origin` showed during QA. Production sets

```
PORTAL_ORIGINS=https://*.crazygames.com
```

in `.env`. A `*.` entry admits any https subdomain (not the bare domain), so a
per-game or regional host we have not seen yet is not refused.
`docker-compose.prod.yml` appends it to our own domain.

`frame-ancestors` used to be what stopped a reskin, and no longer participates,
so this check is now the only thing that could.

**Gameplay events are not gated.** `gameplayStart` and `updateRoom` both fire
when the connection leaves idle. Reintroduce anything between load and the
socket — a menu, a splash, a consent gate — and both go dark for any QA pass
that does not click through it, which is exactly the failure this build was
made to fix.
