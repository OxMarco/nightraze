// Integration test: drive a real client against the running nightraze server.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  ClientMessageSchema, ServerMessageSchema,
} from "./dist/gen/nightraze/v1/game_pb.js";
import WebSocket from "ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = Number(process.env.TEST_PORT) || 31000 + (process.pid % 10000);
const httpBase = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;
const ownsServer = process.env.NIGHTRAZE_TEST_EXTERNAL !== "1";
let serverProcess = null;
let serverError = "";

async function startServer() {
  if (!ownsServer) return;
  serverProcess = spawn(process.execPath, ["dist/server.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      MAX_PLAYERS: "2",
      BOT_POP_TARGET: "0",   // the deterministic checks need an empty arena
      BAN_DB_PATH: ":memory:",
      METRICS_DB_PATH: ":memory:",
      METRICS_TOKEN: "integration-metrics-token",
      ALLOWED_ORIGINS: "https://allowed.example",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  serverProcess.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (serverProcess?.exitCode !== null && serverProcess?.exitCode !== undefined) break;
    try {
      const res = await fetch(`${httpBase}/health`);
      if (res.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(100);
  }
  throw new Error(`test server did not become healthy${serverError ? `: ${serverError}` : ""}`);
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill("SIGTERM");
  await Promise.race([once(serverProcess, "exit"), sleep(2000)]);
  if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
}

process.on("exit", () => {
  if (serverProcess?.exitCode === null) serverProcess.kill("SIGTERM");
});

await startServer();
await waitForServer();

let fails = 0;
const check = (name, ok, extra = "") =>
  console.log((ok ? "PASS  " : (fails++, "FAIL  ")) + name + (extra ? `  [${extra}]` : ""));

function rejectedConnection(options) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/play?name=rejected`, options);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ code: 0, reason: "timeout" });
    }, 2000);
    ws.on("error", () => {});
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function makeClient(name, base = wsBase) {
  const ws = new WebSocket(`${base}/play?name=${encodeURIComponent(name)}`);
  ws.binaryType = "arraybuffer";
  const c = { ws, welcome: null, snaps: [], dead: null, tuning: null, error: null };
  ws.on("error", (err) => { c.error = err; });
  ws.on("open", () => {
    c.send({ msg: { case: "telemetry", value: {
      visitorId: `integration-${name}-visitor`, timezone: "Europe/Malta",
    } } });
  });
  ws.on("message", (data) => {
    const msg = fromBinary(ServerMessageSchema, new Uint8Array(data));
    if (msg.msg.case === "welcome") c.welcome = msg.msg.value;
    else if (msg.msg.case === "snapshot") { c.snaps.push(msg.msg.value); if (c.snaps.length > 100) c.snaps.shift(); }
    else if (msg.msg.case === "dead") c.dead = msg.msg.value;
    else if (msg.msg.case === "tuning") c.tuning = msg.msg.value;
  });
  c.send = (m) => ws.send(toBinary(ClientMessageSchema, create(ClientMessageSchema, m)));
  c.self = () => {
    const s = c.snaps[c.snaps.length - 1];
    return s?.players.find((p) => p.id === c.welcome?.playerId);
  };
  c.last = () => c.snaps[c.snaps.length - 1];
  return c;
}

if (ownsServer) {
  const rejected = await rejectedConnection({ origin: "https://evil.example" });
  check("cross-origin browser socket is rejected", rejected.code === 1008,
    `code=${rejected.code} reason=${rejected.reason}`);
}

const a = makeClient("alpha");
await sleep(500);
check("welcome received", !!a.welcome && a.welcome.worldSize === 2600, JSON.stringify(a.welcome));
check("snapshots flowing (~25Hz)", a.snaps.length > 8, "n=" + a.snaps.length);
check("self present in snapshot", !!a.self());
// the client must be told the levers it has to draw with (§10)
check("levers arrive on join", a.tuning?.glowG === 6, JSON.stringify(a.tuning));
const live = await (await fetch(`${httpBase}/health`)).json();
check("health reports a live authoritative simulation",
  live.ok === true && live.simulation?.ticks > 0 && live.simulation?.tickAgeMs >= 0,
  JSON.stringify(live.simulation));
if (ownsServer) {
  const deniedMetrics = await fetch(`${httpBase}/metrics`);
  check("product metrics require their token", deniedMetrics.status === 403,
    `status=${deniedMetrics.status}`);
  const metrics = await (await fetch(
    `${httpBase}/metrics?token=${encodeURIComponent("integration-metrics-token")}`,
  )).json();
  check("product metrics count the connected anonymous user",
    metrics.currentPlaying === 1 && metrics.dailyActiveUsers?.at(-1)?.users === 1 &&
      metrics.locations?.[0]?.location === "timezone:Europe/Malta",
    JSON.stringify(metrics));
  const crash = await fetch(`${httpBase}/telemetry/crash`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitorId: "integration-alpha-visitor", kind: "window-error" }),
  });
  check("browser crash reports are accepted", crash.status === 204, `status=${crash.status}`);
  const invalidCrash = await fetch(`${httpBase}/telemetry/crash`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitorId: "integration-alpha-visitor", kind: "invented-kind" }),
  });
  check("browser crash categories are allow-listed", invalidCrash.status === 400,
    `status=${invalidCrash.status}`);
  const crashBurst = [];
  for (let i = 0; i < 6; i++) {
    crashBurst.push(await fetch(`${httpBase}/telemetry/crash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visitorId: "integration-alpha-visitor", kind: "window-error" }),
    }));
  }
  check("browser crash reports are rate-limited",
    crashBurst.some((response) => response.status === 429),
    `statuses=${crashBurst.map((response) => response.status).join(",")}`);
  // the tuning route is a playtest instrument: absent unless TUNE_TOKEN is set
  const tune = await fetch(`${httpBase}/tune`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ g: 0 }),
  });
  check("lever tuning is off without a token", tune.status === 404, "status=" + tune.status);
}
// >= 12, not == 12: the spawn point can land on a field mote and eat it
// before the first sampled snapshot
check("spawn is lit with starter ember", a.self()?.lit === true && a.self()?.light >= 12 && a.self()?.light < 15,
  "L=" + a.self()?.light);
check("spawn is shielded", a.self()?.shielded === true);
check("motes visible while lit", a.last()?.motes.length > 0, "n=" + a.last()?.motes.length);

// steer right for 1.5s
const x0 = a.self().x;
a.send({ msg: { case: "input", value: { tx: 400, ty: 0 } } });
await sleep(1500);
check("server moves the player from direction input", a.self().x > x0 + 100, "dx=" + (a.self().x - x0).toFixed(0));
a.send({ msg: { case: "input", value: { tx: 0, ty: 0 } } });

// douse: lit false, motes stop being sent beyond dark vision
a.send({ msg: { case: "toggle", value: {} } });
await sleep(300);
check("toggle shutters the lantern", a.self().lit === false);
const darkMotes = a.last().motes.length;
check("perception collapses when dark (few/no motes sent)", darkMotes < 8, "n=" + darkMotes);

// dash: relights, reveals, breaks shield, costs light
const Ld = a.self().light;
a.send({ msg: { case: "dash", value: { tx: 1, ty: 1 } } });
await sleep(300);
check("dash relights + reveals", a.self().lit === true && a.self().revealT > 0,
  "revealT=" + a.self().revealT?.toFixed(2));
check("dash broke spawn protection", a.self().shielded === false);
// mote pickups are worth exactly 1, so compare fractional parts to stay robust
// against a mote eaten during the lunge
const dashCost = Math.max(0.8, 0.025 * Ld);
const fracDiff = Math.abs((((Ld - dashCost) % 1) - (a.self().light % 1) + 1.5) % 1 - 0.5);
check("dash costs max(0.8, 2.5% of light)", fracDiff < 0.02,
  `L ${Ld.toFixed(2)} -> ${a.self().light.toFixed(2)}`);

// Farm by steering at the nearest server-visible mote. This follows observed
// state instead of hoping a random sweep crosses enough randomly placed motes.
let farmSteps = 0;
while (a.self().light < 20 && farmSteps < 250) {
  const self = a.self();
  const motes = a.last()?.motes ?? [];
  let target = null, targetD = Infinity;
  for (const mote of motes) {
    const d = Math.hypot(mote.x - self.x, mote.y - self.y);
    if (d < targetD) { target = mote; targetD = d; }
  }
  if (target) {
    a.send({ msg: { case: "input", value: { tx: target.x - self.x, ty: target.y - self.y } } });
  } else {
    const ang = farmSteps * 0.35;
    a.send({ msg: { case: "input", value: { tx: Math.cos(ang) * 400, ty: Math.sin(ang) * 400 } } });
  }
  await sleep(100);
  farmSteps++;
}
check("eating grows light server-side", a.self().light >= 18, "L=" + a.self().light.toFixed(1));

// second client: perception isolation at spawn distance
const b = makeClient("beta");
await sleep(500);
if (ownsServer) {
  const rejected = await rejectedConnection({});
  check("global room capacity rejects excess players", rejected.code === 1013,
    `code=${rejected.code} reason=${rejected.reason}`);
}
const dAB = Math.hypot(a.self().x - (b.self()?.x ?? 0), a.self().y - (b.self()?.y ?? 0));
const aSeesB = a.last().players.some((p) => p.id === b.welcome.playerId);
// mirror the server's §6 rules exactly: vision (+ b's body radius) and glow
// reach (the branch depends on b's stance/reveal). The third rule, the
// dark-mover shimmer, deliberately does NOT put b in this list — a wake
// arrives as a SHIMMER effect carrying a grid-snapped point and nothing else
// (see the perception-fidelity tests in test/room.test.mjs).
const bL = b.self().light;
const bodyRB = 9 + 1.9 * Math.sqrt(bL);
const glowB =
  b.self().revealT > 0 ? 90 + 26 * Math.sqrt(bL)
  : b.self().lit ? Math.min(520, 60 + 24 * Math.sqrt(bL))
  : Math.max(0, (Math.sqrt(bL) - 5) * 6);
const visA = a.self().lit ? Math.min(560, 110 + 22 * Math.sqrt(a.self().light)) : 60;
const shouldSee = dAB <= visA + bodyRB || dAB <= glowB;
check("perception filtering is consistent with §6", aSeesB === shouldSee,
  `d=${dAB.toFixed(0)} sees=${aSeesB} should=${shouldSee}`);

// ---- combat: the contact law end-to-end (§7) ----
// steer both lit players into each other until they burn
const steerTogether = () => {
  const pa = a.self(), pb = b.self();
  if (!pa || !pb) return;
  a.send({ msg: { case: "input", value: { tx: pb.x - pa.x, ty: pb.y - pa.y } } });
  b.send({ msg: { case: "input", value: { tx: pa.x - pb.x, ty: pa.y - pb.y } } });
};
if (!b.self().lit) b.send({ msg: { case: "toggle", value: {} } });
let burned = false, looseSeen = 0;
for (let i = 0; i < 120 && !burned; i++) {
  steerTogether();
  await sleep(200);
  looseSeen = Math.max(looseSeen, a.last()?.loose.length ?? 0);
  burned = (a.self()?.revealT ?? 0) > 0 && (b.self()?.revealT ?? 0) > 0;
}
check("lit-on-lit contact burns and reveals both", burned);
await sleep(200);
looseSeen = Math.max(looseSeen, a.last()?.loose.length ?? 0);
check("burn scatters loose motes (spill, not transfer)", looseSeen > 0,
  "loose=" + looseSeen);

// dark protects nothing: beta shutters and holds still while the lit hunter
// burns one-way until beta gutters out and is snuffed
if (b.self()?.lit) b.send({ msg: { case: "toggle", value: {} } });
b.send({ msg: { case: "input", value: { tx: 0, ty: 0 } } });
let snuffed = null;
for (let i = 0; i < 150 && !snuffed; i++) {
  if (a.dead) snuffed = { c: a, killer: "beta" };
  else if (b.dead) snuffed = { c: b, killer: "alpha" };
  else {
    const pa = a.self(), pb = b.self();
    if (pa && pb) a.send({ msg: { case: "input", value: { tx: pb.x - pa.x, ty: pb.y - pa.y } } });
    await sleep(200);
  }
}
check("lit hunter drains a dark lantern to the snuff",
  !!snuffed && snuffed.c.dead.by === snuffed.killer,
  snuffed ? `by=${snuffed.c.dead.by} peak=${snuffed.c.dead.peakLight.toFixed(1)}` : "nobody died");
if (snuffed) {
  snuffed.c.send({ msg: { case: "respawn", value: {} } });
  await sleep(400);
  const re = snuffed.c.self();
  check("respawn returns a shielded starter ember",
    !!re && re.light >= 12 && re.shielded === true,
    re ? `L=${re.light}` : "not in snapshot");
}
a.send({ msg: { case: "input", value: { tx: 0, ty: 0 } } });
b.send({ msg: { case: "input", value: { tx: 0, ty: 0 } } });

// leaderboard endpoint
const lb = await (await fetch(`${httpBase}/leaderboard`)).json();
check("leaderboard reports light", Array.isArray(lb) && lb.length >= 2 && "light" in lb[0],
  JSON.stringify(lb));

a.ws.close(); b.ws.close();
await sleep(100);
await stopServer();

// ---- bots: adaptive socket-less population ----
// A separate server so the bot rules don't disturb the deterministic checks above.
if (ownsServer) {
  const botPort = port + 1;
  const botBase = `http://127.0.0.1:${botPort}`;
  let botServerError = "";
  const botServer = spawn(process.execPath, ["dist/server.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(botPort),
      BOT_POP_TARGET: "5",
      BAN_DB_PATH: ":memory:",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  botServer.stderr.on("data", (chunk) => { botServerError += chunk.toString(); });
  let botHealthy = false;
  for (let attempt = 0; attempt < 50 && !botHealthy; attempt++) {
    try { botHealthy = (await fetch(`${botBase}/health`)).ok; } catch { /* starting */ }
    if (!botHealthy) await sleep(100);
  }
  if (!botHealthy) throw new Error(`bot test server did not become healthy${botServerError ? `: ${botServerError}` : ""}`);

  const empty = await (await fetch(`${botBase}/health`)).json();
  check("no bots while the arena has no humans", empty.bots === 0, `bots=${empty.bots}`);

  const c = makeClient("gamma", `ws://127.0.0.1:${botPort}`);
  await sleep(6000);   // bots join one per 0.6s once a human is present
  const withHuman = await (await fetch(`${botBase}/health`)).json();
  // target = popTarget(5) - humans(1) + jitter(±2) → 2..6 once ramped
  check("bots fill in around the human (adaptive ± jitter)",
    withHuman.bots >= 2 && withHuman.bots <= 6, `bots=${withHuman.bots}`);
  const botLb = await (await fetch(`${botBase}/leaderboard`)).json();
  check("bots appear on the leaderboard", botLb.length >= 3, JSON.stringify(botLb));

  // more humans → bots yield their slots; fewer humans → bots refill
  const extras = ["delta", "epsilon", "zeta"].map((n) => makeClient(n, `ws://127.0.0.1:${botPort}`));
  await sleep(5000);
  const crowded = await (await fetch(`${botBase}/health`)).json();
  // target = popTarget(5) - humans(4) + jitter(±2) → at most 3
  check("bots despawn as humans fill the arena", crowded.bots <= 3, `bots=${crowded.bots}`);
  for (const e of extras) e.ws.close();
  await sleep(6000);
  const refilled = await (await fetch(`${botBase}/health`)).json();
  check("bots refill when humans thin out", refilled.bots >= 2 && refilled.bots <= 6, `bots=${refilled.bots}`);

  c.ws.close();
  await sleep(8000);   // bots leave one per 0.6s once the target drops to 0
  const drained = await (await fetch(`${botBase}/health`)).json();
  check("bots drain when the last human leaves", drained.bots === 0, `bots=${drained.bots}`);

  botServer.kill("SIGTERM");
  await Promise.race([once(botServer, "exit"), sleep(2000)]);
  if (botServer.exitCode === null) botServer.kill("SIGKILL");
}
console.log(fails ? `\n${fails} FAILURES` : "\nALL CHECKS PASSED");
process.exit(fails ? 1 : 0);
