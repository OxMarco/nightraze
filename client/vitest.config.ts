/* Test config for the client.

   Separate from vite.config.ts on purpose: the build config carries the two
   HTML entry points, the dev proxy and the precompressor, none of which mean
   anything to a test run, and the precompressor in particular would walk dist/
   on every invocation.

   The reason this exists at all is that the suite could not previously import
   the modules it was testing. `node --test` with a resolver hook gets as far as
   the first .tsx in the graph and stops — Node's type stripping has no JSX — so
   game/session.ts was unreachable behind game/GameContext.tsx, and the tests
   had to restate its logic instead of running it. Vite's transform pipeline
   handles JSX and TypeScript's ".js"-means-".tsx" import style, so the real
   modules load and the restatements are gone. */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // happy-dom over jsdom: an order of magnitude faster to construct, and the
    // surface these tests touch — localStorage, location, matchMedia, a React
    // root — is well inside what it implements.
    environment: "happy-dom",
    include: ["test/**/*.test.{ts,tsx,mts}"],
    // Each file installs its own globals — a stubbed portal SDK, a location at
    // a particular URL — and the platform modules cache identity at module
    // scope. One process per file keeps that from leaking sideways.
    isolate: true,
    restoreMocks: true,
  },
});
