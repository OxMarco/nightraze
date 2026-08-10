# One image for the whole application. `runtime` is what production runs: the
# Fastify server with the built SPA baked in at /app/public, so a single
# container serves the static client, the HTTP API, and the /play WebSocket on
# one origin. Traefik sits in front purely for TLS/Let's Encrypt and host
# routing — there is no second web tier and no in-container reverse proxy.
#
# The build context is the repository root because the runtime image needs both
# workspaces. The *-dev targets are used only by docker-compose.local.yml, which
# bind-mounts the sources over the copies made here.

# ---- client dev (hot reload) ----
# Vite dev server (HMR) on 5173; it proxies /play and the HTTP API routes to the
# server container (VITE_PROXY_TARGET), matching the same-origin layout of prod.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS client-dev
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/tsconfig.json client/vite.config.ts client/index.html client/embed.html ./
COPY client/public ./public
COPY client/src ./src
EXPOSE 5173
CMD ["npm", "run", "dev"]

# ---- server dev (hot reload) ----
# `dev:docker` = nodemon -L (legacy/polling watch on src) that reruns
# `tsc && node dist/server.js` on each change. Polling is required because
# TypeScript 7's native tsc --watch and node --watch don't get fs events across
# macOS/Windows bind mounts; nodemon -L polls, so edits reliably trigger a
# rebuild + restart. tsc 7 does a full build in a fraction of a second.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS server-dev
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
EXPOSE 3000
CMD ["npm", "run", "dev:docker"]

# ---- client build ----
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS client-build
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/tsconfig.json client/vite.config.ts client/index.html client/embed.html ./
COPY client/public ./public
COPY client/src ./src
RUN npm run build

# ---- server build ----
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS server-build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ---- lint ----
# Its own stage, and its own npm install, because the linter needs a TypeScript
# the two build stages deliberately do not have (eslint.config.js explains why).
# Nothing here is compiled: ESLint parses the sources, so neither workspace's
# node_modules is needed and this stays a small, fast layer that only rebuilds
# when the sources or the rules change.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS lint
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY eslint.config.js ./
COPY client/src ./client/src
COPY client/test ./client/test
COPY server/src ./server/src
RUN npm run lint && touch /lint-passed

# ---- client test ----
# The platform suite, which is the only place the CrazyGames adapter's guards
# are exercised at all — there is no way to open their frame locally — plus the
# arrival rules, which mount the real hooks. It runs against the sources rather
# than the bundle, and builds on client-build so `npm ci` and `tsc` are already
# done and cached.
FROM client-build AS client-test
COPY client/tsconfig.test.json client/vitest.config.ts ./
COPY client/test ./test
RUN npm run test:unit && touch /client-tests-passed

# ---- test ----
# Deploys run the suite here instead of on the host: production has Docker but
# no Node toolchain, so `npm` and `node` only exist inside these stages. This
# target is what `make test-docker` builds and what scripts/deploy.sh gates on,
# so it must fail for every reason `make test` fails locally.
#
# Building on server-build reuses its `npm ci` (devDependencies included) and
# `tsc` output. Pulling in the client bundle covers the client's build, and the
# two stamp files drag lint and client-test into the graph so the rules and the
# client's *tests* are covered too — without them BuildKit prunes those stages
# as unreachable and the deploy gate silently stops checking. dist/server.js
# resolves ../public, so the integration test drives the same static+API+
# WebSocket layout production serves.
FROM server-build AS test
COPY --from=client-build /app/dist ./public
COPY --from=lint /lint-passed /tmp/
COPY --from=client-test /client-tests-passed /tmp/
COPY server/test ./test
COPY server/integration.test.mjs ./
RUN node --test test/*.test.mjs && node integration.test.mjs

# ---- runtime ----
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=server-build /app/dist ./dist
# server.ts resolves ../public relative to dist/ and serves it; if this copy is
# ever missing the server still boots and only stops serving the static client.
COPY --from=client-build /app/dist ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
