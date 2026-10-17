import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Where the arena is during `npm run dev`. The built artifact talks to whatever
// VITE_SERVER_ORIGIN said at build time (src/config.ts); this only spares the
// dev server from needing a local origin baked in.
const target = process.env.VITE_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  // The single most important line in this file. CrazyGames serves an uploaded
  // build from a subdirectory of their CDN, so absolute asset paths resolve
  // against their root and 404. Their requirements say it outright: only
  // relative paths, absolute paths will fail.
  base: "./",

  plugins: [tailwindcss(), react()],

  build: {
    // One entry, unlike client/. There is no second document here: the portal
    // frames this build directly and nightraze.io is a separate artifact.
    outDir: "dist",
    emptyOutDir: true,
    // The upload is a zip of dist/. Inlining small assets keeps the file count
    // down, which is the budget CrazyGames actually enforces (1500 files).
    assetsInlineLimit: 8192,
  },

  server: {
    host: true,
    port: 5174,   // 5173 is client/; both may want to run at once
    proxy: {
      "/play": { target, ws: true },
      "/health": { target },
      "/leaderboard": { target },
      "/telemetry": { target },
    },
  },
});
