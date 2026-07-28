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
