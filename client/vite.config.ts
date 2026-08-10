import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import { promisify } from "node:util";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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

/* Emit a .br and a .gz beside every compressible build artifact.

   Compressed here rather than by the server, and that is the point rather than
   a preference: the game server runs the authoritative simulation on the same
   event loop it answers HTTP on, so a runtime compressor would spend the tick
   budget of every player on squeezing bytes for one of them. Doing it at build
   time costs nothing at runtime, buys the strongest setting each codec has
   (quality 11 / level 9 are far too slow to use per request), and pairs with
   @fastify/static's preCompressed, which picks the encoding the browser asked
   for and falls back to the plain file when it asked for none.

   Fingerprinted assets make this exactly-once work: a file compressed at build
   time is served immutable until the next deploy renames it.

   Only text is worth it. woff2 and png carry their own compression, and running
   deflate over them costs build time to make them very slightly larger. */
const COMPRESSIBLE = new Set([".js", ".css", ".html", ".svg", ".json", ".webmanifest", ".txt"]);
const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const precompress: Plugin = {
  name: "nightraze-precompress",
  apply: "build",
  // After the bundle is fully written, including anything copied from public/.
  closeBundle: {
    sequential: true,
    order: "post",
    async handler() {
      const root = fileURLToPath(new URL("dist", import.meta.url));
      const walk = async (dir: string): Promise<string[]> => {
        const entries = await readdir(dir, { withFileTypes: true });
        const files = await Promise.all(entries.map(async (entry) => {
          const path = join(dir, entry.name);
          return entry.isDirectory() ? walk(path) : [path];
        }));
        return files.flat();
      };

      let saved = 0;
      let count = 0;
      for (const path of await walk(root)) {
        if (!COMPRESSIBLE.has(extname(path))) continue;
        const raw = await readFile(path);
        // Below about a packet there is nothing to win and the framing costs
        // more than the saving.
        if (raw.byteLength < 1024) continue;
        const [br, gzipped] = await Promise.all([
          brotli(raw, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
              [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
            },
          }),
          gz(raw, { level: zlibConstants.Z_BEST_COMPRESSION }),
        ]);
        // A codec that made the file bigger has earned no sibling: without one
        // the server simply serves the original.
        if (br.byteLength < raw.byteLength) await writeFile(`${path}.br`, br);
        if (gzipped.byteLength < raw.byteLength) await writeFile(`${path}.gz`, gzipped);
        saved += raw.byteLength - Math.min(br.byteLength, gzipped.byteLength);
        count++;
      }
      const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
      this.info?.(`precompressed ${count} files, saving ${kb(saved)} on a best-encoding load`);
    },
  },
};

export default defineConfig({
  plugins: [tailwindcss(), react(), embedRoute, precompress],
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
      "^/metrics$": { target },
      "/telemetry": { target },
      "/tune": { target },
    },
  },
});
