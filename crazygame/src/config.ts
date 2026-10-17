/* Where the arena actually is.

   This is the one thing that genuinely could not be copied from client/. There,
   the bundle is served by the game server itself, so `location` names the
   simulation and same-origin does the rest — no build-time configuration, and
   http/ws and https/wss follow whatever the page was loaded over.

   Here the bundle is uploaded to CrazyGames and served from their CDN, so
   `location` names *their* host and says nothing whatsoever about where the
   simulation lives. The origin has to be baked in at build time, and every
   connection this build makes is cross-origin: the socket carries CrazyGames'
   origin rather than ours (see ALLOWED_ORIGINS in server/src/server.ts), and
   /health and /leaderboard are reached through CORS rather than same-origin.

   VITE_SERVER_ORIGIN exists so a staging arena is a build flag rather than an
   edit. Unset, a production build points at the live arena — the overwhelmingly
   common case, since that is the artifact that gets zipped and uploaded —
   while `npm run dev` falls back to its own origin so the dev server's proxy
   (vite.config.ts) handles /play and the HTTP API the way client/ does. */

const configured = import.meta.env.VITE_SERVER_ORIGIN;
const ORIGIN = (
  configured ?? (import.meta.env.DEV ? location.origin : "https://nightraze.io")
).replace(/\/+$/, "");

export const config = {
  // https -> wss, http -> ws, and nothing else changes.
  wsUrl: `${ORIGIN.replace(/^http/, "ws")}/play`,
  apiUrl: ORIGIN,
};
