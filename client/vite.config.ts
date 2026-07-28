import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// In dev the client runs on 5173 but talks same-origin, so proxy the game
// server's routes to it. Bare-metal (`npm run dev`) it's localhost:3000; inside
// docker-compose.local.yml it's the server container (VITE_PROXY_TARGET).
const target = process.env.VITE_PROXY_TARGET ?? "http://localhost:3000";

// Under Docker on macOS/Windows, bind-mount fs events don't reach the watcher,
// so HMR needs polling. Enabled via CHOKIDAR_USEPOLLING=true in the compose
// file; left off for bare-metal dev (native events, no polling CPU cost).
const usePolling = process.env.CHOKIDAR_USEPOLLING === "true";

// In production the game server routes /embed to embed.html; the dev server
// would fall back to index.html instead and quietly hand back the wrong entry —
// which looks like a working game with the SDK missing. Match the real URL.
const embedRoute: Plugin = {
  name: "nightraze-embed-route",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/embed" || req.url?.startsWith("/embed?")) {
        req.url = "/embed.html" + req.url.slice("/embed".length);
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), embedRoute],
  build: {
    rollupOptions: {
      // Two documents, one app. index.html is nightraze.io itself; embed.html is
      // the one a portal iframes, and the only one that loads a portal SDK (see
      // src/platform/). They share every chunk under /assets, so the second
      // entry costs a few hundred bytes of HTML, not a second bundle.
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        embed: fileURLToPath(new URL("embed.html", import.meta.url)),
      },
    },
  },
  server: {
    host: true, // bind 0.0.0.0 so the port is reachable from outside the container
    port: 5173,
    watch: usePolling ? { usePolling: true, interval: 200 } : undefined,
    proxy: {
      "/play": { target, ws: true },
      "/health": { target },
      "/leaderboard": { target },
      "/tune": { target },
    },
  },
});
