/* Lint rules for both workspaces.

   ---- why this lives at the repo root, and not in client/ and server/ ----

   Both workspaces build with typescript@7 — the native compiler, which ships a
   `tsc` binary and nothing else: its package exports "." as a version stub and
   the classic JS compiler API only under ./unstable/*. typescript-eslint's
   parser needs that classic API, so it cannot run against the TypeScript either
   workspace installs, and npm refuses the peer range besides.

   So the linter gets its own typescript@5 up here, where nothing builds. Node
   resolves `typescript` from the nearest node_modules, which means eslint run
   from the root finds the 5.x that its parser needs, while `cd client && tsc`
   finds the 7.x that the build needs. The two never meet. Nothing in client/ or
   server/ depends on anything here, and no application code imports it.

   Revisit when typescript-eslint supports the native compiler: at that point
   this collapses into two ordinary per-workspace configs and the root package
   disappears. */

import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Generated protobuf bindings are not ours to style, and they already say
    // so themselves with a /* eslint-disable */ header. Listed here as well so
    // they cost no parse time at all.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/gen/**",
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    // Type-aware linting is deliberately off. It would need the parser to build
    // a program from tsconfig.json using typescript@5, while the tsconfig is
    // written for and checked by typescript@7 — two compilers disagreeing about
    // one project is a worse failure mode than the rules it would buy. `tsc`
    // already runs on every build and in every test script; this is here for
    // what the type checker does not see.
    rules: {
      // The convention throughout: a deliberately unused binding is named with
      // a leading underscore (see server.ts's `_req`), which the codebase
      // already does. Anything else unused is a mistake.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // An empty catch is how half this codebase degrades gracefully — a failed
      // clipboard write, an SDK in fail mode, a storage quota. Those are real
      // decisions and they are commented; the rule would flag every one.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  {
    // ---- the browser half ----
    files: ["client/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // .flat, not .configs.recommended: the plugin still ships the eslintrc
    // shape under the bare name, and flat config rejects it.
    extends: [reactHooks.configs.flat["recommended-latest"]],
    rules: {
      // The renderer is a canvas, and the game loop mutates plain objects it
      // owns (SceneRenderer's particle and camera state) by design — none of it
      // is React state and none of it is rendered from. The compiler rules that
      // police mutation and memoization are aimed at code that does not look
      // like this, so they are advisory here rather than blocking.
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      // This is the rule the whole exercise is for: session.ts and App.tsx are
      // full of hand-managed effect dependencies, and until now nothing checked
      // them. An error, not a warning, so a wrong dependency list fails a build
      // rather than scrolling past.
      "react-hooks/exhaustive-deps": "error",
    },
  },

  {
    // ---- the client's own test suite ----
    // Node globals for the stubs and assertions; the tests that render run in a
    // DOM environment vitest provides, and neither set is worth splitting the
    // config over. .tsx included: the hook tests mount real components.
    files: ["client/test/**/*.{ts,tsx,mts}", "client/vitest.config.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // The suite's whole job is impersonating a hostile SDK and a browser that
      // is not there, which cannot be done in the types.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  {
    // ---- the server half ----
    files: ["server/src/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
);
