import Fastify, { LogController } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { Room } from "./game/room.js";
import { IpBanStore } from "./ip-ban-store.js";
import { MetricsStore } from "./metrics-store.js";
import { NO_FRAMING, embedFrameAncestors } from "./embedding.js";

const isProduction = process.env.NODE_ENV === "production";

// LOG_LEVEL picks the pino threshold; anything unset or unrecognized falls back
// to info so a typo can't silently mute the server.
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
function logLevelEnv(): string {
  const value = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  return LOG_LEVELS.includes(value) ? value : "info";
}

// Fastify's per-request "incoming request"/"request completed" pair is pure
// noise here: the only HTTP traffic is the 3s healthcheck plus the WS upgrade,
// and the game's own events are logged explicitly below. Off by default in
// production, on elsewhere; LOG_REQUESTS overrides either way.
function logRequestsEnv(): boolean {
  const value = (process.env.LOG_REQUESTS ?? "").trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return !isProduction;
}

// trustProxy: behind Traefik, use X-Forwarded-For as req.ip so the per-IP
// connection limit sees real client IPs, not the proxy's address.
// Keep it off for direct/local exposure so clients cannot spoof that header.
const fastify = Fastify({
  logger: { level: logLevelEnv() },
  logController: new LogController({ disableRequestLogging: !logRequestsEnv() }),
  trustProxy: process.env.TRUST_PROXY === "true",
});
await fastify.register(websocket, {
  options: { maxPayload: 128 }, // client only ever sends tiny ClientMessage frames
});

// Cheap anti-flood: cap concurrent play sockets per source IP so a single
// client can't spawn unbounded bodies into the O(n²) sim / perception broadcast.
function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function finiteEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== undefined && process.env[name] !== ""
    ? value : fallback;
}

const MAX_CONNS_PER_IP = positiveIntEnv("MAX_CONNS_PER_IP", 8);
const MAX_PLAYERS = positiveIntEnv("MAX_PLAYERS", 100);
const CHEAT_BAN_SECONDS = positiveIntEnv("CHEAT_BAN_SECONDS", 300);
const CHEAT_BAN_MULTIPLIER = positiveIntEnv("CHEAT_BAN_MULTIPLIER", 10);
const CHEAT_BAN_MAX_SECONDS = Math.max(
  CHEAT_BAN_SECONDS,
  positiveIntEnv("CHEAT_BAN_MAX_SECONDS", 7 * 24 * 60 * 60),
);
const CHEAT_BAN_RESET_SECONDS = positiveIntEnv(
  "CHEAT_BAN_RESET_SECONDS",
  30 * 24 * 60 * 60,
);
const BOT_POP_TARGET = nonNegativeIntEnv("BOT_POP_TARGET", 12); // 0 disables bots
const GLOW_G = finiteEnv("GLOW_G", 6);                          // §10 lever 1 at boot
// Live lever tuning is off unless a token is configured: it is a playtest
// instrument, not a game feature, and moving G changes what every player can
// hide from. No token, no route.
const TUNE_TOKEN = process.env.TUNE_TOKEN ?? "";
const METRICS_TOKEN = process.env.METRICS_TOKEN ?? "";
const CRASH_REPORT_WINDOW_MS = 60_000;
const CRASH_REPORTS_PER_IP = 6;
const CRASH_REPORTS_GLOBAL = 120;
const BROWSER_CRASH_KINDS = new Set([
  "window-error",
  "unhandled-rejection",
  "react-render",
]);
const connsByIp = new Map<string, number>();
const liveSockets = new Set<import("ws").WebSocket>();
const crashReportsByIp = new Map<string, { startedAt: number; count: number }>();
let globalCrashReports = { startedAt: 0, count: 0 };
let shuttingDown = false;

// The room kicks on protocol violations but only knows player ids; the
// transport layer maps them back to IPs and applies a temporary ban so a
// kicked cheater can't just reconnect in the same breath.
const ipByPlayer = new Map<number, string>();
const sessionByPlayer = new Map<number, number>();
const locationByPlayer = new Map<number, string>();
const visitorByPlayer = new Map<number, string>();
const banStore = new IpBanStore(process.env.BAN_DB_PATH ?? "./data/ip-bans.sqlite", {
  multiplier: CHEAT_BAN_MULTIPLIER,
  maxBanMs: CHEAT_BAN_MAX_SECONDS * 1_000,
  resetAfterMs: CHEAT_BAN_RESET_SECONDS * 1_000,
});
const metricsStore = new MetricsStore(process.env.METRICS_DB_PATH ?? "./data/metrics.sqlite");
let metricsClosed = false;
let metricsCleanupTimer: ReturnType<typeof setInterval> | null = null;
function metric(operation: () => void): void {
  if (metricsClosed) return;
  try {
    operation();
  } catch (err) {
    fastify.log.error({ err }, "failed to persist metric");
  }
}
function closeMetrics(): void {
  if (metricsClosed) return;
  if (metricsCleanupTimer) {
    clearInterval(metricsCleanupTimer);
    metricsCleanupTimer = null;
  }
  // Close live sessions at shutdown time instead of leaving them permanently
  // incomplete while WebSocket close callbacks race process termination.
  for (const sessionId of sessionByPlayer.values()) {
    metric(() => metricsStore.endSession(sessionId));
  }
  metricsClosed = true;
  metricsStore.close();
}
metric(() => metricsStore.sweep());
metricsCleanupTimer = setInterval(() => {
  metric(() => metricsStore.sweep());
}, 60 * 60_000);
metricsCleanupTimer.unref();
process.on("uncaughtExceptionMonitor", () => {
  metric(() => metricsStore.recordCrash(null, "server-uncaught-exception"));
});
const banCleanupTimer = setInterval(() => {
  try {
    banStore.sweepExpired();
  } catch (err) {
    fastify.log.error({ err }, "failed to clean up expired IP bans");
  }
  sweepCrashReportWindows();
}, 60_000);
banCleanupTimer.unref();
fastify.log.info({ activeBans: banStore.activeCount() }, "IP ban store ready");

// One room for the prototype. Multi-room later: Map<roomId, Room> + a matchmaker.
const room = new Room((player, reason) => {
  const ip = ipByPlayer.get(player.id);
  fastify.log.warn({ id: player.id, name: player.name, ip, reason }, "player kicked: anticheat");
  if (ip && ip !== "unknown") {
    try {
      const applied = banStore.ban(ip, CHEAT_BAN_SECONDS * 1_000);
      metric(() => metricsStore.recordBan(applied.offenseCount, applied.durationMs));
      fastify.log.warn({
        ip,
        offenseCount: applied.offenseCount,
        banSeconds: applied.durationMs / 1_000,
        bannedUntil: new Date(applied.bannedUntil).toISOString(),
      }, "temporary IP ban applied");
    } catch (err) {
      // ban() updates the in-memory guard before attempting the durable write,
      // so the current process remains protected if the volume becomes unwritable.
      fastify.log.error({ err, ip }, "failed to persist IP ban");
    }
  }
}, BOT_POP_TARGET, (player, rawVisitorId, timezone) => {
  const sessionId = sessionByPlayer.get(player.id);
  const rawId = validVisitorId(rawVisitorId);
  if (!sessionId || !rawId) return;
  const visitorId = anonymousVisitorHash(rawId);
  const proxyLocation = locationByPlayer.get(player.id) ?? "unknown";
  const location = proxyLocation.startsWith("country:")
    ? proxyLocation
    : clientLocation({}, timezone);
  visitorByPlayer.set(player.id, visitorId);
  locationByPlayer.set(player.id, location);
  metric(() => metricsStore.identifySession(sessionId, visitorId, location));
}, (player) => {
  const sessionId = sessionByPlayer.get(player.id);
  if (!sessionId) return;
  metric(() => metricsStore.endSession(sessionId));
  sessionByPlayer.delete(player.id);
}, (player) => {
  let sessionId = 0;
  metric(() => {
    sessionId = metricsStore.startSession(
      visitorByPlayer.get(player.id) ?? null,
      locationByPlayer.get(player.id) ?? "unknown",
    );
  });
  if (sessionId !== 0) sessionByPlayer.set(player.id, sessionId);
});
if (room.setGlowG(GLOW_G) === null) {
  fastify.log.warn({ GLOW_G }, "GLOW_G out of range; keeping the reference curve");
}
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function validVisitorId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,64}$/.test(value)
    ? value
    : null;
}

function anonymousVisitorHash(visitorId: string): string {
  return createHash("sha256").update(visitorId).digest("base64url");
}

function allowCrashReport(ip: string, now = Date.now()): boolean {
  if (now - globalCrashReports.startedAt >= CRASH_REPORT_WINDOW_MS) {
    globalCrashReports = { startedAt: now, count: 0 };
  }
  const previous = crashReportsByIp.get(ip);
  const perIp = !previous || now - previous.startedAt >= CRASH_REPORT_WINDOW_MS
    ? { startedAt: now, count: 0 }
    : previous;
  if (globalCrashReports.count >= CRASH_REPORTS_GLOBAL || perIp.count >= CRASH_REPORTS_PER_IP) {
    return false;
  }
  globalCrashReports.count++;
  perIp.count++;
  crashReportsByIp.set(ip, perIp);
  return true;
}

function sweepCrashReportWindows(now = Date.now()): void {
  for (const [ip, window] of crashReportsByIp) {
    if (now - window.startedAt >= CRASH_REPORT_WINDOW_MS) crashReportsByIp.delete(ip);
  }
}

function clientLocation(
  headers: Record<string, string | string[] | undefined>,
  timezone: string | null,
): string {
  // A country header is trusted only when explicitly configured. In production
  // the app port is private behind the proxy; operators may configure a
  // geo-aware proxy header without making client-supplied IPs analytics data.
  const headerName = (process.env.GEO_COUNTRY_HEADER ?? "").trim().toLowerCase();
  const header = headerName ? headers[headerName] : undefined;
  const country = Array.isArray(header) ? header[0] : header;
  if (country && /^[a-zA-Z]{2}$/.test(country)) return `country:${country.toUpperCase()}`;
  if (timezone && timezone.length <= 64 && /^[a-zA-Z_+-]+(?:\/[a-zA-Z0-9_+-]+){1,2}$/.test(timezone)) {
    return `timezone:${timezone}`;
  }
  return "unknown";
}

// Every document we serve declares who may frame it. /embed sets its own
// permissive policy in its handler; this closes the door on everything else,
// including the SPA fallback, so a new route can never become embeddable by
// omission. Keyed on the response content type rather than the path for the
// same reason.
fastify.addHook("onSend", async (_req, reply, payload) => {
  const contentType = String(reply.getHeader("content-type") ?? "");
  if (contentType.startsWith("text/html") && !reply.hasHeader("content-security-policy")) {
    reply.header("content-security-policy", NO_FRAMING);
  }
  return payload;
});

// ---- HTTP API ----
fastify.get("/health", { logLevel: "silent" }, async (_req, reply) => {
  const simulation = room.health();
  const ok = simulation.ok && !shuttingDown;
  return reply.code(ok ? 200 : 503).send({
    ok,
    players: room.humanCount(),
    bots: room.botCount(),
    g: room.glowG(),
    simulation,
  });
});

fastify.get("/leaderboard", async () => room.leaderboard());

// Aggregates only; the underlying anonymous visitor and session rows are never
// exposed over HTTP. With no token configured the route does not exist.
if (METRICS_TOKEN) {
  fastify.get("/metrics", async (req, reply) => {
    if (req.headers["x-metrics-token"] !== METRICS_TOKEN) {
      return reply.code(403).send({ error: "bad metrics token" });
    }
    reply.header("cache-control", "no-store");
    return metricsStore.snapshot(room.activeHumanCount());
  });
  fastify.log.info("aggregate product metrics enabled at GET /metrics");
}

// Browser exceptions are intentionally reduced to a category. Messages,
// stacks, URLs, names and IP addresses are not retained.
fastify.post("/telemetry/crash", { bodyLimit: 4_096 }, async (req, reply) => {
  const body = (req.body ?? {}) as { visitorId?: unknown; kind?: unknown };
  const visitorId = validVisitorId(body.visitorId);
  if (!visitorId) return reply.code(400).send({ error: "invalid visitor" });
  const kind = typeof body.kind === "string" && BROWSER_CRASH_KINDS.has(body.kind)
    ? body.kind
    : null;
  if (!kind) return reply.code(400).send({ error: "invalid crash kind" });
  if (!allowCrashReport(req.ip || "unknown")) {
    reply.header("retry-after", String(CRASH_REPORT_WINDOW_MS / 1_000));
    return reply.code(429).send({ error: "crash report rate limit reached" });
  }
  metric(() => metricsStore.recordCrash(anonymousVisitorHash(visitorId), kind));
  return reply.code(204).send();
});

// ---- Playtest tuning (§10 / §15 Q2) ----
// POST /tune  { "g": 9 }  with header x-tune-token
// Sweeping the irreducible-glow curve across one sitting is how the "is first
// place desirable?" question actually gets answered; every player is told the
// new value so their darkness keeps matching the server's perception.
if (TUNE_TOKEN) {
  fastify.post("/tune", async (req, reply) => {
    if (req.headers["x-tune-token"] !== TUNE_TOKEN) {
      return reply.code(403).send({ error: "bad tune token" });
    }
    const body = (req.body ?? {}) as { g?: unknown };
    if (body.g !== undefined) {
      const applied = room.setGlowG(Number(body.g));
      if (applied === null) return reply.code(400).send({ error: "g out of range" });
      fastify.log.warn({ g: applied }, "lever moved: irreducible glow (G)");
    }
    return { g: room.glowG() };
  });
  fastify.log.info("live lever tuning enabled at POST /tune");
}

// ---- Game WebSocket ----
// Connect with:  ws://host:3000/play?name=YourName
// All frames in both directions are binary protobuf (see proto/nightraze/v1/game.proto).
fastify.get("/play", { websocket: true }, (socket, req) => {
  // Note for anyone adding a portal: this list does NOT need the embedder's
  // origin. A WebSocket's Origin is the origin of the document running the
  // script, and inside the CrazyGames frame that document is still ours —
  // https://nightraze.io. Adding crazygames.com here would only widen who may
  // open a socket, never fix a connection that was failing.
  const origin = req.headers.origin;
  if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
    fastify.log.warn({ origin }, "connection rejected: origin not allowed");
    socket.close(1008, "origin not allowed");
    return;
  }

  const ip = req.ip || "unknown";
  if (banStore.isBanned(ip)) {
    fastify.log.warn({ ip }, "connection rejected: temp-banned");
    socket.close(1008, "temporarily banned");
    return;
  }
  const open = connsByIp.get(ip) ?? 0;
  if (open >= MAX_CONNS_PER_IP) {
    fastify.log.warn({ ip }, "connection rejected: per-IP limit reached");
    socket.close(1013, "too many connections"); // 1013 = Try Again Later
    return;
  }
  // capacity counts humans only — bots yield as humans arrive, never block them
  if (room.humanCount() >= MAX_PLAYERS) {
    fastify.log.warn({ players: room.humanCount() }, "connection rejected: room full");
    socket.close(1013, "room full");
    return;
  }
  connsByIp.set(ip, open + 1);
  liveSockets.add(socket);

  const url = new URL(req.url, "http://x");
  const name = url.searchParams.get("name");
  const location = clientLocation(req.headers, null);
  let sessionId = 0;
  metric(() => { sessionId = metricsStore.startSession(null, location); });

  // Browser WebSockets automatically answer control-frame pings with pongs.
  // One outstanding sample at a time avoids treating a delayed pong as a newer
  // measurement. RTT is aggregated; individual payloads are not stored.
  let pingStartedAt: number | null = null;
  const pingTimer = setInterval(() => {
    if (socket.readyState !== 1 || pingStartedAt !== null) return;
    pingStartedAt = performance.now();
    try {
      socket.ping();
    } catch {
      pingStartedAt = null;
    }
  }, 10_000);
  pingTimer.unref();
  socket.on("pong", () => {
    const activeSessionId = sessionByPlayer.get(player.id);
    if (pingStartedAt === null || !activeSessionId) return;
    const pingMs = performance.now() - pingStartedAt;
    pingStartedAt = null;
    metric(() => metricsStore.recordPing(activeSessionId, pingMs));
  });

  const player = room.addPlayer(socket, name);
  ipByPlayer.set(player.id, ip);
  if (sessionId !== 0) sessionByPlayer.set(player.id, sessionId);
  locationByPlayer.set(player.id, location);
  fastify.log.info({ id: player.id, name: player.name }, "player joined");

  socket.on("message", (data, isBinary) => {
    room.handleMessage(player, data as Buffer, isBinary);
  });

  socket.on("close", () => {
    clearInterval(pingTimer);
    const activeSessionId = sessionByPlayer.get(player.id);
    if (activeSessionId) metric(() => metricsStore.endSession(activeSessionId));
    liveSockets.delete(socket);
    room.removePlayer(player.id);
    ipByPlayer.delete(player.id);
    sessionByPlayer.delete(player.id);
    locationByPlayer.delete(player.id);
    visitorByPlayer.delete(player.id);
    const n = (connsByIp.get(ip) ?? 1) - 1;
    if (n <= 0) connsByIp.delete(ip);
    else connsByIp.set(ip, n);
    fastify.log.info({ id: player.id }, "player left");
  });

  socket.on("error", () => socket.close());
});

// ---- Static client ----
// Production bakes the built SPA into this image at /app/public and serves it
// from the same origin as /play and the HTTP API, so the browser needs neither
// CORS nor a build-time server URL. Traefik in front only terminates TLS and
// routes the host here; there is no separate web tier. Locally the Vite dev
// server plays that role and no public directory exists, so this is skipped —
// which is also why the integration test, run from server/, stays unaffected.
const publicDir = process.env.PUBLIC_DIR ?? join(import.meta.dirname, "..", "public");
if (existsSync(join(publicDir, "index.html"))) {
  await fastify.register(fastifyStatic, {
    root: publicDir,
    // wildcard:false registers one route per file instead of a catch-all, which
    // leaves every unmatched path to the handler below — the SPA fallback.
    wildcard: false,
    setHeaders(reply, path) {
      // Vite fingerprints everything it emits under /assets, so those may be
      // cached forever. index.html must always be revalidated, or a browser
      // would keep loading the previous deploy's (now deleted) asset names.
      const immutable = path.includes(`${sep}assets${sep}`);
      reply.header(
        "cache-control",
        immutable ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });
  // The document CrazyGames iframes (client/embed.html): the same app, plus
  // their SDK. Declared as a route rather than left to the SPA fallback, which
  // would hand back index.html — the entry point is what tells the client which
  // platform it is running on, so serving the wrong one silently disables the
  // whole integration. Registered before the fallback for that reason.
  const embedCsp = embedFrameAncestors();
  if (existsSync(join(publicDir, "embed.html"))) {
    fastify.get("/embed", async (_req, reply) => {
      reply.header("content-security-policy", embedCsp);
      return reply.sendFile("embed.html");
    });
    fastify.log.info({ csp: embedCsp }, "serving the embeddable client at /embed");
  } else {
    fastify.log.warn("embed.html missing from the client build; /embed disabled");
  }

  fastify.setNotFoundHandler((req, reply) => {
    // Client-side routes must resolve to the app shell; unknown API verbs must
    // not, or a typo'd POST would get a 200 page instead of a 404.
    if (req.method !== "GET" && req.method !== "HEAD") {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
  fastify.log.info({ root: publicDir }, "serving the built client");
}

// ---- Start ----
const port = Number(process.env.PORT) || 3000;
try {
  await fastify.listen({ port, host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  clearInterval(banCleanupTimer);
  banStore.close();
  closeMetrics();
  process.exit(1);
}

// graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    room.close();
    // 1012 tells browsers this is a temporary service restart. The client
    // reconnects with backoff instead of stranding the player on an error UI.
    for (const socket of liveSockets) socket.close(1012, "service restart");
    clearInterval(banCleanupTimer);
    banStore.close();
    closeMetrics();
    await fastify.close();
    process.exit(0);
  });
}
