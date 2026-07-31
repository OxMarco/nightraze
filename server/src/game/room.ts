import type { WebSocket } from "ws";
import { create, toBinary, fromBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";
import {
  ClientMessageSchema,
  ServerMessageSchema,
  EffectKind,
} from "../gen/nightraze/v1/game_pb.js";

/* nightraze authoritative simulation. This is the single-player sim
   (src/{core,world,combat}.js) ported to the server: same formulas, same
   contact law, same mote lifecycle — now the only copy that decides anything.
   The client renders snapshots and expresses intent; it can never state a
   position, a speed, or a spill. */

// ---- config (GDD reference values) ----
const CFG = {
  arena: 2600,
  tickRate: 25,
  fieldMoteTarget: 260,

  // §10 lever 1, the anti-snowball dial: how much glow a dark lantern cannot
  // shed. Mutable at runtime (see Room.setGlowG) because §15 Q2 — "where
  // between 'leader hides freely' and 'leader is food' does first place stay
  // desirable?" — is a question you answer by sweeping it during a session,
  // not by rebuilding between them.
  G: 6,
  glowGMax: 20,           // sweep bound; §15 Q2 brackets the question at 0..14
  visionLitCap: 560,
  glowLitCap: 520,
  darkVision: 60,
  darkSpeedMult: 1.15,

  dashDist: 95, dashTime: 0.18, dashCooldown: 0.9,
  dashCostMin: 0.8, dashCostPct: 0.025,
  dashStrike: 0.3,   // §14 dash asymmetry (ships on): no self-spill inside this window
  revealLinger: 1.0,

  gutter: 6, starterEmber: 12,
  spillFlat: 4, spillPct: 0.16, spillLockout: 1.5,
  pairImmunity: 0.5, burnReveal: 0.5,
  crescentHalfAngle: (100 * Math.PI) / 180,
  spawnProtection: 2.0,

  mergeRadius: 12, settleRest: 25, settleFlicker: 3,

  shimmerBase: 65, shimmerPerSpeed: 20, shimmerMinSpeed: 20,
  shimmerGrid: 32,        // grid a shimmer ring's origin snaps to (§6 fidelity)
  glowGrid: 8,            // step a glow-only contact's smudge radius snaps to
  flareVisibility: 900,   // burn/snuff flashes read as distant flares (§5)

  // bots: the arena is kept near botPopTarget bodies while humans are present
  botAdjustMin: 6, botAdjustMax: 12,   // seconds between target re-rolls
  botJitter: 2,                        // ± bots of randomness on the target
  botRamp: 0.6,                        // seconds between bot joins/leaves
  botRespawnMin: 2, botRespawnMax: 6,

  maxInputsPerSec: 60,
  maxMessagesPerSec: 90,
  toggleCooldown: 0.2,
  maxEventsPerTick: 256,
  maxBufferedBytes: 256 * 1024,
  maxNameLen: 15,
  maxStrikes: 10,
};

// ---- the one resource, and everything it derives (§4) ----
const bodyR = (L: number) => 9 + 1.9 * Math.sqrt(L);
const speedOf = (L: number, dark: boolean) =>
  (2.7 - Math.min(1.4, Math.sqrt(L) / 9)) * (dark ? CFG.darkSpeedMult : 1) * 60;
const visionLit = (L: number) => Math.min(CFG.visionLitCap, 110 + 22 * Math.sqrt(L));
const glowLit = (L: number) => Math.min(CFG.glowLitCap, 60 + 24 * Math.sqrt(L));
const glowRevealed = (L: number) => 90 + 26 * Math.sqrt(L);
const glowIrr = (L: number) => Math.max(0, (Math.sqrt(L) - 5) * CFG.G);
const spillAmount = (L: number) => Math.min(L, CFG.spillFlat + CFG.spillPct * L);

/* ---- perception fidelity (§6) ----
   Gating what crosses the wire is only half the anti-cheat. A modified client
   renders everything it receives, so a contact the design means to be
   ambiguous has to *arrive* ambiguous — otherwise the shimmer that is
   explicitly "not a trail a hunter could simply follow" becomes exactly that.

   Both degradations below are deterministic, never per-tick jitter: fresh
   noise on every snapshot is averaged away in a few hundred milliseconds at
   25Hz, and a per-viewer offset would let two colluding accounts intersect
   their views. A fixed global grid tells everyone the same lie forever. */

/** Snap to the centre of a fixed world grid cell. */
const snapGrid = (v: number, grid: number) => (Math.floor(v / grid) + 0.5) * grid;

/** The light a glow-only contact reports: the value that reproduces its smudge
    radius rounded to a glowGrid step. The size of the smudge is the tell the
    design grants; the exact number behind it is not, or a modified client
    reads the leaderboard off every smudge it drifts past. */
function smudgeLight(L: number): number {
  const g = Math.round(glowIrr(L) / CFG.glowGrid) * CFG.glowGrid;
  return g <= 0 ? 25 : (g / CFG.G + 5) ** 2;   // 25 light = conceals completely (§6)
}

/** §6's three stealth states are the entire resolution of the shimmer channel.
    Cadence and intensity both derive from the step index, so a client timing
    the rings with a stopwatch recovers a bucket — not a speed, and not the
    light value that speed would give away. */
const SHIMMER_STEPS = [
  { period: 0.50, intensity: 0.35 },   // moving carefully
  { period: 0.28, intensity: 0.70 },
  { period: 0.14, intensity: 1.00 },   // moving quickly
];
const shimmerStep = (speed: number) => (speed < 70 ? 0 : speed < 120 ? 1 : 2);

/** How far a dark mover's wake registers (§6). */
const shimmerRadius = (p: Player) =>
  CFG.shimmerBase + CFG.shimmerPerSpeed * (p.speed / 60);

/* What one entity has earned the right to know about another. */
const P_NONE = 0, P_FULL = 1, P_GLOW = 2, P_SHIMMER = 3;
type PerceiveMode = typeof P_NONE | typeof P_FULL | typeof P_GLOW | typeof P_SHIMMER;

/** Convert settled loose light into whole field motes without minting fractions. */
export function settleFieldMotes(value: number, remainder: number): {
  count: number;
  remainder: number;
} {
  const total = Math.max(0, value) + remainder;
  const count = Math.max(0, Math.floor(total));
  return { count, remainder: total - count };
}

// englishRecommendedTransformers catch the usual evasions (l33t, spacing,
// repeated letters), so "sh1t" and "s h i t" match alongside the plain word.
const profanity = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

/** The real client never sends control, bidi-override, or zero-width characters;
    strip them so names cannot be blank, multi-line, or impersonate via lookalikes.
    Profane names are not censored into fragments -- they fall back whole. */
export function sanitizeName(raw: string | null): string {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CFG.maxNameLen)
    .trim();
  // also match with spaces removed, so "f u c k" cannot slip through
  if (!cleaned || profanity.hasMatch(cleaned) ||
    profanity.hasMatch(cleaned.replace(/\s+/g, ""))) return "ember";
  return cleaned;
}

const TAU = Math.PI * 2;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

let nextId = 1;

// Bot lanterns pass sanitizeName like everyone else; the pool is small on
// purpose — repeat encounters with "vesper" read as a rival, not a spawn.
const BOT_NAMES = [
  "vesper", "wisp", "tinder", "cinder", "gloam", "moth", "lumen", "dusk",
  "murk", "pyre", "fen", "sylph", "nix", "sooth", "ashen", "flicker",
];

export interface Player {
  id: number;
  socket: WebSocket | null;        // null = bot: same body, same laws, no wire
  name: string;
  x: number; y: number;
  dirX: number; dirY: number;      // the only thing the client controls
  throttle: number;                // 0..1 from input magnitude (≤40px = proportional)
  light: number;
  lit: boolean;
  revealT: number;
  protectedUntil: number;          // sim-seconds
  dashT: number; dashCd: number; dashDX: number; dashDY: number;
  strikeT: number;                 // dash-asymmetry window: while > 0, this lantern doesn't spill when touched
  toggleCd: number;
  speed: number;
  heading: number;
  peak: number;
  dead: boolean;
  closing: boolean;
  messageTimestamps: number[];
  inputTimestamps: number[];
  strikes: number;                 // protocol violations the real client can never produce
  shimmerClocks: Map<number, number>;   // target id -> seconds until its next wake ring
}

interface FieldMote { id: number; x: number; y: number; }
interface LooseMote {
  id: number; x: number; y: number; vx: number; vy: number;
  value: number; restT: number; settling: number;
  lockOwner: number; lockUntil: number;
}
interface FxEvent { kind: EffectKind; x: number; y: number; m: number; }

interface BotBrain {
  decideT: number;                 // countdown to the next decision (reaction time)
  waypointX: number; waypointY: number;
  respawnT: number;
  darkBias: number;                // personality: how much this bot likes stalking dark
  aggression: number;              // personality: 0 = grazer that ignores prey, 1 = relentless hunter
}

export interface LeaderboardEntry { id: number; name: string; light: number; rank: number; }

/** Rows on the board. The client paints what it is sent, so this is the only
 *  place the number lives. */
export const LEADERBOARD_ROWS = 5;

export interface RoomHealth {
  ok: boolean;
  tickAgeMs: number;
  tickDurationMs: number;
  tickDelayMs: number;
  ticks: number;
  overBudgetTicks: number;
}

function glowRadius(p: Player): number {
  if (p.revealT > 0) return glowRevealed(p.light);
  if (p.lit) return glowLit(p.light);
  return glowIrr(p.light);
}

export class Room {
  readonly players = new Map<number, Player>();
  private readonly motes = new Map<number, FieldMote>();
  private readonly loose = new Map<number, LooseMote>();
  private readonly pairImmune = new Map<string, number>();
  private events: FxEvent[] = [];
  private now = 0;                 // sim-seconds
  private mergeClock = 0;
  private settleRemainder = 0;     // carries settle rounding so the field economy stays light-conserving
  private readonly interval: NodeJS.Timeout;
  private readonly botBrains = new Map<number, BotBrain>();
  private botAdjustT = 0;
  private botJitterNow = 0;
  private botRampT = 0;
  private lastTickStartedAt = performance.now();
  private lastTickCompletedAt = 0;
  private lastTickDurationMs = 0;
  private lastTickDelayMs = 0;
  private tickCount = 0;
  private overBudgetTicks = 0;

  constructor(
    // called when a player is kicked for cheating/abuse, so the transport
    // layer (which knows IPs — the room does not) can apply a temp ban
    private readonly onCheat?: (player: Player, reason: string) => void,
    // how many bodies the arena is kept near while humans are present; 0 = no bots
    private readonly botPopTarget = 0,
    // One privacy-minimised identity message per socket, handled by transport
    // because the room has no persistence or request-location concerns.
    private readonly onTelemetry?: (player: Player, visitorId: string, timezone: string) => void,
    private readonly onRunEnd?: (player: Player) => void,
    private readonly onRespawn?: (player: Player) => void,
  ) {
    for (let i = 0; i < CFG.fieldMoteTarget; i++) this.spawnMote();
    this.interval = setInterval(() => this.runTick(), 1000 / CFG.tickRate);
  }

  close(): void {
    clearInterval(this.interval);
  }

  /** Container liveness is tied to the authoritative simulation, not merely
      to Fastify still being able to answer HTTP. A stopped timer therefore
      becomes unhealthy even if the event loop can serve /health. */
  health(): RoomHealth {
    const tickAgeMs = this.lastTickCompletedAt === 0
      ? Number.POSITIVE_INFINITY
      : performance.now() - this.lastTickCompletedAt;
    return {
      ok: tickAgeMs < 1000,
      tickAgeMs: Number.isFinite(tickAgeMs) ? Math.round(tickAgeMs) : -1,
      tickDurationMs: Number(this.lastTickDurationMs.toFixed(2)),
      tickDelayMs: Number(this.lastTickDelayMs.toFixed(2)),
      ticks: this.tickCount,
      overBudgetTicks: this.overBudgetTicks,
    };
  }

  private runTick(): void {
    const startedAt = performance.now();
    const tickBudgetMs = 1000 / CFG.tickRate;
    this.lastTickDelayMs = Math.max(0, startedAt - this.lastTickStartedAt - tickBudgetMs);
    this.lastTickStartedAt = startedAt;

    // Deliberately do not catch: an unexpected simulation exception must end
    // the process so Docker's restart policy can recover it.
    this.tick();

    const completedAt = performance.now();
    this.lastTickDurationMs = completedAt - startedAt;
    this.lastTickCompletedAt = completedAt;
    this.tickCount += 1;
    if (this.lastTickDurationMs > tickBudgetMs) this.overBudgetTicks += 1;
  }

  // ---------------------------------------------------------------- world
  private spawnMote(): void {
    const id = nextId++;
    this.motes.set(id, { id, x: rand(30, CFG.arena - 30), y: rand(30, CFG.arena - 30) });
  }

  private spawnLoose(x: number, y: number, value: number, vx: number, vy: number,
    lockOwner = 0, lockUntil = 0): void {
    const id = nextId++;
    this.loose.set(id, {
      id,
      x: clamp(x, 8, CFG.arena - 8), y: clamp(y, 8, CFG.arena - 8),
      vx, vy, value, restT: 0, settling: 0, lockOwner, lockUntil,
    });
  }

  // ---------------------------------------------------------------- players
  private send(p: Player, msg: MessageInitShape<typeof ServerMessageSchema>): void {
    if (!p.socket || p.closing || p.socket.readyState !== p.socket.OPEN) return;
    if (p.socket.bufferedAmount > CFG.maxBufferedBytes) {
      // A close frame would sit behind the same queued data, so terminate slow
      // consumers immediately instead of allowing snapshots to grow without bound.
      p.closing = true;
      p.socket.terminate();
      return;
    }
    try {
      p.socket.send(toBinary(ServerMessageSchema, create(ServerMessageSchema, msg)));
    } catch {
      p.closing = true;
      p.socket.terminate();
    }
  }

  private emitEffect(event: FxEvent): void {
    if (this.events.length < CFG.maxEventsPerTick) this.events.push(event);
  }

  addPlayer(socket: WebSocket | null, name: string | null): Player {
    const p: Player = {
      id: nextId++,
      socket,
      name: sanitizeName(name),
      x: rand(200, CFG.arena - 200), y: rand(200, CFG.arena - 200),
      dirX: 0, dirY: 0, throttle: 0,
      light: CFG.starterEmber,
      lit: true,
      revealT: 0,
      protectedUntil: this.now + CFG.spawnProtection,
      dashT: 0, dashCd: 0, dashDX: 0, dashDY: 0,
      strikeT: 0,
      toggleCd: 0,
      speed: 0, heading: 0,
      peak: CFG.starterEmber,
      dead: false,
      closing: false,
      messageTimestamps: [],
      inputTimestamps: [],
      strikes: 0,
      shimmerClocks: new Map(),
    };
    this.players.set(p.id, p);
    this.send(p, { msg: { case: "welcome", value: { playerId: p.id, worldSize: CFG.arena } } });
    this.sendTuning(p);   // the levers this arena is currently running (§10)
    return p;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
    this.botBrains.delete(id);
  }

  // ---------------------------------------------------------------- live levers (§10)
  /** The irreducible-glow curve, readable so the transport layer can report it. */
  glowG(): number {
    return CFG.G;
  }

  /** Move lever 1 mid-session and tell every client, so the darkness they draw
      keeps matching the perception the server is running. Returns the value
      actually applied, or null if the request was out of range. */
  setGlowG(value: number): number | null {
    if (!Number.isFinite(value) || value < 0 || value > CFG.glowGMax) return null;
    CFG.G = value;
    for (const p of this.players.values()) this.sendTuning(p);
    return CFG.G;
  }

  private sendTuning(p: Player): void {
    this.send(p, { msg: { case: "tuning", value: { glowG: CFG.G } } });
  }

  humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.socket) n++;
    return n;
  }

  activeHumanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.socket && !p.dead) n++;
    return n;
  }

  botCount(): number {
    return this.players.size - this.humanCount();
  }

  private respawn(p: Player): void {
    p.dead = false;
    p.light = CFG.starterEmber;
    p.peak = CFG.starterEmber;
    p.x = rand(200, CFG.arena - 200);
    p.y = rand(200, CFG.arena - 200);
    p.lit = true;
    p.revealT = 0;
    p.dashT = 0; p.dashCd = 0; p.strikeT = 0; p.toggleCd = 0;
    p.dirX = 0; p.dirY = 0;
    p.protectedUntil = this.now + CFG.spawnProtection;
    this.onRespawn?.(p);
    this.send(p, { msg: { case: "welcome", value: { playerId: p.id, worldSize: CFG.arena } } });
  }

  // ---------------------------------------------------------------- input
  /* Frames the shipped client can never produce (text frames, undecodable
     protobuf, non-finite floats) mean someone is speaking the protocol by
     hand. Each earns a strike; enough strikes and the socket is closed and
     the transport layer is told to temp-ban the source. */
  private strike(p: Player, reason: string): void {
    p.strikes += 1;
    if (p.strikes < CFG.maxStrikes) return;
    this.kick(p, reason);
  }

  private kick(p: Player, reason: string): void {
    p.closing = true;
    p.socket?.close(1008, reason);
    this.onCheat?.(p, reason);
  }

  handleMessage(p: Player, data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (p.closing) return;

    // Count every frame before decoding, including malformed and text frames.
    // This bounds parser/callback work as well as valid game actions.
    const nowMs = Date.now();
    const allTs = p.messageTimestamps;
    while (allTs.length && nowMs - allTs[0]! > 1000) allTs.shift();
    if (allTs.length >= CFG.maxMessagesPerSec) {
      // no strike ladder for floods: 90/s is beyond any legitimate client,
      // and each excess frame costs the server work — cut and ban at once
      this.kick(p, "message rate exceeded");
      return;
    }
    allTs.push(nowMs);

    if (!isBinary) { this.strike(p, "text frame"); return; }

    const buf = Array.isArray(data) ? Buffer.concat(data)
      : Buffer.isBuffer(data) ? data : Buffer.from(data);

    let msg;
    try {
      msg = fromBinary(ClientMessageSchema, buf);
    } catch {
      this.strike(p, "malformed frame");
      return;
    }

    // Rate-limit only the high-frequency movement stream; actions (dash and
    // toggle) are also gated by their own server-side cooldowns, and
    // malformed frames were rejected above — none of them should be able to
    // starve a legitimate input of its budget.
    if (msg.msg.case === "input") {
      const ts = p.inputTimestamps;
      while (ts.length && nowMs - ts[0]! > 1000) ts.shift();
      if (ts.length >= CFG.maxInputsPerSec) return;
      ts.push(nowMs);
    }

    switch (msg.msg.case) {
      case "input": {
        const { tx, ty } = msg.msg.value;
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) { this.strike(p, "non-finite input"); return; }
        this.applySteer(p, tx, ty);
        break;
      }
      case "toggle": {
        this.applyToggle(p);
        break;
      }
      case "dash": {
        const { tx, ty } = msg.msg.value;
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) { this.strike(p, "non-finite input"); return; }
        this.applyDash(p, tx, ty);
        break;
      }
      case "respawn": {
        if (p.dead) this.respawn(p);
        break;
      }
      case "telemetry": {
        this.onTelemetry?.(p, msg.msg.value.visitorId, msg.msg.value.timezone);
        break;
      }
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- actions
  /* Shared by the socket path above and the bot brains below, so a bot can
     never do anything a hand on a pointer couldn't. */
  private applySteer(p: Player, tx: number, ty: number): void {
    if (p.dead) return;
    const len = Math.hypot(tx, ty);
    if (len < 1e-3) { p.dirX = 0; p.dirY = 0; p.throttle = 0; }
    else {
      p.dirX = tx / len; p.dirY = ty / len;
      // magnitude is a throttle only (pointer within 40px of center =
      // proportional speed, so standing still — stealth — is possible);
      // it can never express a position or a speed boost
      p.throttle = clamp(len / 40, 0, 1);
    }
  }

  private applyToggle(p: Player): void {
    if (p.dead || p.toggleCd > 0) return;
    p.toggleCd = CFG.toggleCooldown;
    p.lit = !p.lit;
    if (!p.lit) {
      // the douse beat: afterimage stain where the light went out (§5)
      this.emitEffect({ kind: EffectKind.DOUSE, x: p.x, y: p.y, m: glowLit(p.light) * 0.7 });
    }
  }

  private applyDash(p: Player, tx: number, ty: number): void {
    if (p.dead || p.dashCd > 0 || p.light < CFG.gutter) return; // guttering cannot dash
    const len = Math.hypot(tx, ty);
    if (len < 1e-3) return;
    // the flare is fuel: cost is spent whether or not the lunge connects (§7)
    p.light -= Math.max(CFG.dashCostMin, CFG.dashCostPct * p.light);
    p.dashDX = tx / len; p.dashDY = ty / len;
    p.dashT = CFG.dashTime;
    p.strikeT = CFG.dashStrike;
    p.dashCd = CFG.dashCooldown;
    p.lit = true;                                    // the flame is the thrust
    p.revealT = Math.max(p.revealT, CFG.revealLinger);
    p.protectedUntil = this.now;                     // dash breaks spawn protection
  }

  // ---------------------------------------------------------------- combat (§7)
  private pairKey(a: Player, b: Player): string {
    return a.id < b.id ? a.id + ":" + b.id : b.id + ":" + a.id;
  }

  private scatterCrescent(victim: Player, awayAngle: number, amount: number): void {
    let rem = amount;
    while (rem > 0.05) {
      const v = Math.min(rem, rand(1, 2.6));
      rem -= v;
      const a = awayAngle + rand(-CFG.crescentHalfAngle, CFG.crescentHalfAngle);
      const sp = rand(110, 260);
      // the crescent spawns inside the victim's own pickup radius — lock it
      // against the spiller until it has flown clear, or every burn is
      // instantly re-eaten and lanterns can never be drained
      this.spawnLoose(
        victim.x + Math.cos(a) * (bodyR(victim.light) + 4),
        victim.y + Math.sin(a) * (bodyR(victim.light) + 4),
        v, Math.cos(a) * sp, Math.sin(a) * sp,
        victim.id, this.now + CFG.spillLockout);
    }
  }

  private applySpill(toucher: Player, victim: Player): void {
    victim.revealT = Math.max(victim.revealT, CFG.burnReveal);
    toucher.revealT = Math.max(toucher.revealT, CFG.burnReveal);
    if (victim.light < CFG.gutter) {                   // extinguishing
      this.emitEffect({ kind: EffectKind.SNUFF, x: victim.x, y: victim.y, m: bodyR(victim.light) * 3 + 30 });
      this.scatterCrescent(victim, rand(0, TAU), victim.light);
      victim.light = 0;
      victim.dead = true;
      this.onRunEnd?.(victim);
      this.send(victim, { msg: { case: "dead", value: { by: toucher.name, peakLight: victim.peak } } });
      return;
    }
    const s = spillAmount(victim.light);
    victim.light -= s;
    this.scatterCrescent(victim, Math.atan2(victim.y - toucher.y, victim.x - toucher.x), s);
  }

  private resolveContact(a: Player, b: Player): void {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (!a.lit && !b.lit) {
      // one ripple per encounter, not one per overlapping tick
      const key = this.pairKey(a, b);
      if ((this.pairImmune.get(key) ?? 0) <= this.now) {
        this.pairImmune.set(key, this.now + CFG.pairImmunity);
        this.emitEffect({ kind: EffectKind.BUMP, x: mx, y: my, m: 40 });
      }
      return;
    }
    if (this.now < a.protectedUntil || this.now < b.protectedUntil) return;
    const key = this.pairKey(a, b);
    if ((this.pairImmune.get(key) ?? 0) > this.now) return;
    this.pairImmune.set(key, this.now + CFG.pairImmunity);

    this.emitEffect({ kind: EffectKind.BURN, x: mx, y: my, m: 130 });

    const aLit = a.lit, bLit = b.lit;   // evaluate both directions on pre-burn state
    // dash asymmetry (§14, ships on): inside the strike window a lantern spills
    // nothing when touched — deliberate dashes are one-way, brushes stay mutual.
    // A guttering lantern can never be striking (it cannot dash), so the
    // suppression never shields anyone from the execute.
    if (aLit && b.strikeT <= 0) this.applySpill(a, b);
    // b's flame was open at contact — it burns back even if the first spill
    // snuffed b (the kill shot is never free); skip only if a itself just died
    if (bLit && !a.dead && a.strikeT <= 0) this.applySpill(b, a);
  }

  // ---------------------------------------------------------------- bots
  /* Socket-less players. The population tracks the humans in the arena:
     target = botPopTarget - humans, re-rolled with a small ± jitter every few
     seconds so the count breathes instead of snapping. Bots join and leave
     one at a time, and an empty arena drains to zero so an idle server sits
     still. */
  private updateBots(dt: number): void {
    if (this.botPopTarget <= 0) return;
    let humans = 0, bots = 0;
    for (const p of this.players.values()) p.socket ? humans++ : bots++;

    this.botAdjustT -= dt;
    if (this.botAdjustT <= 0) {
      this.botAdjustT = rand(CFG.botAdjustMin, CFG.botAdjustMax);
      this.botJitterNow = Math.round(rand(-CFG.botJitter, CFG.botJitter));
    }
    const target = humans === 0 ? 0
      : clamp(this.botPopTarget - humans + this.botJitterNow, 0, this.botPopTarget + CFG.botJitter);

    this.botRampT -= dt;
    if (this.botRampT <= 0 && bots !== target) {
      this.botRampT = CFG.botRamp;
      if (bots < target) this.addBot();
      else this.removeOneBot();
    }

    for (const [id, brain] of this.botBrains) {
      const p = this.players.get(id);
      if (p) this.botThink(p, brain, dt);
    }
  }

  private addBot(): void {
    const inUse = new Set<string>();
    for (const p of this.players.values()) if (!p.socket) inUse.add(p.name);
    const free = BOT_NAMES.filter((n) => !inUse.has(n));
    const name = free.length ? free[Math.floor(Math.random() * free.length)]! : "ember";
    const p = this.addPlayer(null, name);
    this.botBrains.set(p.id, {
      decideT: rand(0, 0.3),
      waypointX: rand(150, CFG.arena - 150),
      waypointY: rand(150, CFG.arena - 150),
      respawnT: rand(CFG.botRespawnMin, CFG.botRespawnMax),
      darkBias: Math.random(),
      aggression: Math.random(),
    });
  }

  private removeOneBot(): void {
    // prefer a snuffed bot; otherwise fade out the one deepest in the dark,
    // farthest from any human, so the despawn is least likely to be witnessed
    let pick: Player | null = null;
    let bestD = -1;
    for (const p of this.players.values()) {
      if (p.socket) continue;
      if (p.dead) { pick = p; break; }
      let nearest = Infinity;
      for (const h of this.players.values()) {
        if (!h.socket || h.dead) continue;
        nearest = Math.min(nearest, Math.hypot(h.x - p.x, h.y - p.y));
      }
      if (nearest > bestD) { bestD = nearest; pick = p; }
    }
    if (pick) this.removePlayer(pick.id);
  }

  private botThink(p: Player, brain: BotBrain, dt: number): void {
    if (p.dead) {
      brain.respawnT -= dt;
      if (brain.respawnT <= 0) {
        this.respawn(p);
        brain.respawnT = rand(CFG.botRespawnMin, CFG.botRespawnMax);
      }
      return;
    }
    brain.decideT -= dt;
    if (brain.decideT > 0) return;         // hold the current intent between decisions
    // docile bots also think slower — sloppier tracking, easier to shake off
    brain.decideT = rand(0.15, 0.35) + (1 - brain.aggression) * 0.25;

    // bots obey §6 too: they only react to what their own lantern earns them
    const vision = p.lit ? visionLit(p.light) : CFG.darkVision;
    let threat: Player | null = null, threatD = Infinity;
    let prey: Player | null = null, preyD = Infinity;
    for (const o of this.players.values()) {
      if (o.id === p.id || o.dead) continue;
      const mode = this.perceiveMode(p, o, vision);
      // a wake says something is moving, never how big it is — so a bot may
      // not weigh a shimmer contact as threat or prey either. Symmetry with
      // what a human client now receives is the point (§6)
      if (mode === P_NONE || mode === P_SHIMMER) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (o.light > p.light * 1.25) {
        if (d < threatD) { threat = o; threatD = d; }
      } else if (p.light > o.light * 1.25 && this.now >= o.protectedUntil &&
        (o.lit || o.revealT > 0)) {
        // only a visibly burning (or freshly revealed) lantern reads as prey:
        // humans can stalk a shimmer, but bots don't get to be that sharp —
        // shuttering your flame genuinely drops you off their hunt list
        if (d < preyD) { prey = o; preyD = d; }
      }
    }

    if (threat) {
      // run, with a sideways lean so flights aren't straight lines
      const away = Math.atan2(p.y - threat.y, p.x - threat.x) + rand(-0.5, 0.5);
      this.steerBot(p, Math.cos(away), Math.sin(away), 1);
      if (p.lit && Math.random() < 0.4) this.applyToggle(p);   // douse: faster, harder to track
      else if (threatD < 140 && Math.random() < 0.35) {
        this.applyDash(p, p.x - threat.x, p.y - threat.y);     // burn light to open the gap
      }
      return;
    }

    // engage range and pursuit persistence both scale with temperament: a
    // docile bot only snaps at prey under its nose and loses interest between
    // decisions, a hot one commits from far off and stays on you
    if (prey && preyD < 200 + 320 * brain.aggression &&
      Math.random() < 0.4 + 0.6 * brain.aggression) {
      this.steerBot(p, prey.x - p.x, prey.y - p.y, 1);
      if (preyD < 130 && Math.random() < 0.3 + 0.6 * brain.aggression) {
        this.applyDash(p, prey.x - p.x, prey.y - p.y);         // the lunge relights the flame
      } else if (p.lit && preyD > 260 && brain.darkBias > 0.5 && Math.random() < 0.3) {
        this.applyToggle(p);                                   // stalk dark, strike lit
      }
      return;
    }

    // graze: head for the nearest mote the lantern can actually show us
    if (!p.lit && Math.random() < 0.5) this.applyToggle(p);    // relight to feed — suction needs flame
    let tx = NaN, ty = NaN, best = Infinity;
    const moteR = vision + 20;
    for (const m of this.motes.values()) {
      const dx = m.x - p.x, dy = m.y - p.y;
      if (Math.abs(dx) > moteR || Math.abs(dy) > moteR) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; tx = m.x; ty = m.y; }
    }
    const looseR = Math.max(vision, 150);
    for (const m of this.loose.values()) {
      if (m.lockOwner === p.id && this.now < m.lockUntil) continue;
      const dx = m.x - p.x, dy = m.y - p.y;
      if (Math.abs(dx) > looseR || Math.abs(dy) > looseR) continue;
      const d2 = (dx * dx + dy * dy) / (1 + m.value);          // richer piles pull harder
      if (d2 < best) { best = d2; tx = m.x; ty = m.y; }
    }
    if (Number.isFinite(tx)) {
      this.steerBot(p, tx - p.x, ty - p.y, 1);
      return;
    }
    // nothing visible: wander toward the waypoint, re-rolling when reached
    if (Math.hypot(brain.waypointX - p.x, brain.waypointY - p.y) < 80) {
      brain.waypointX = rand(150, CFG.arena - 150);
      brain.waypointY = rand(150, CFG.arena - 150);
    }
    this.steerBot(p, brain.waypointX - p.x, brain.waypointY - p.y, rand(0.7, 1));
  }

  /** Bot steering feeds the same throttle model as pointer input: a unit
      direction and a 0..1 throttle, never a position or a speed. */
  private steerBot(p: Player, tx: number, ty: number, throttle: number): void {
    const len = Math.hypot(tx, ty);
    if (len < 1e-3) { p.dirX = 0; p.dirY = 0; p.throttle = 0; return; }
    p.dirX = tx / len; p.dirY = ty / len;
    p.throttle = clamp(throttle, 0, 1);
  }

  // ---------------------------------------------------------------- tick
  private tick(): void {
    const dt = 1 / CFG.tickRate;
    this.now += dt;

    this.updateBots(dt);

    const alive = [...this.players.values()].filter((p) => !p.dead);

    // timers + movement
    for (const p of alive) {
      p.revealT = Math.max(0, p.revealT - dt);
      p.dashCd = Math.max(0, p.dashCd - dt);
      p.strikeT = Math.max(0, p.strikeT - dt);
      p.toggleCd = Math.max(0, p.toggleCd - dt);

      let vx = p.dirX * p.throttle * speedOf(p.light, !p.lit);
      let vy = p.dirY * p.throttle * speedOf(p.light, !p.lit);
      if (p.dashT > 0) {
        p.dashT -= dt;
        const dv = CFG.dashDist / CFG.dashTime;
        vx = vx * 0.5 + p.dashDX * dv;
        vy = vy * 0.5 + p.dashDY * dv;
      }
      const r = bodyR(p.light);
      p.x = clamp(p.x + vx * dt, r, CFG.arena - r);
      p.y = clamp(p.y + vy * dt, r, CFG.arena - r);
      p.speed = Math.hypot(vx, vy);
      if (p.speed > 8) p.heading = Math.atan2(vy, vx);
    }

    // eat field motes: suction while lit; a dark blunder still collects (§5)
    for (const p of alive) {
      const eatR = bodyR(p.light) + 3;
      const pullR = eatR + 26;
      for (const m of this.motes.values()) {
        const dx = p.x - m.x, dy = p.y - m.y;
        if (Math.abs(dx) > pullR || Math.abs(dy) > pullR) continue;
        const d = Math.hypot(dx, dy);
        if (d < eatR) {
          p.light += 1;
          p.peak = Math.max(p.peak, p.light);
          if (this.motes.size > CFG.fieldMoteTarget) {
            this.motes.delete(m.id);      // settled surplus drains back out
          } else {
            m.x = rand(30, CFG.arena - 30);   // instant respawn elsewhere
            m.y = rand(30, CFG.arena - 30);
          }
        } else if (p.lit && d < pullR) {
          const k = ((1 - d / pullR) * 140 * dt) / d;
          m.x += dx * k; m.y += dy * k;
        }
      }
    }

    // collect loose motes (spill self-pickup lockout honored)
    for (const p of alive) {
      const eatR = bodyR(p.light) + 3;
      const pullR = eatR + 26;
      for (const m of this.loose.values()) {
        if (m.lockOwner === p.id && this.now < m.lockUntil) continue;
        const rr = pullR + Math.sqrt(m.value) * 2;
        const dx = p.x - m.x, dy = p.y - m.y;
        if (Math.abs(dx) > rr || Math.abs(dy) > rr) continue;
        const d = Math.hypot(dx, dy);
        if (d < eatR + Math.sqrt(m.value) * 2) {
          p.light += m.value;
          p.peak = Math.max(p.peak, p.light);
          this.loose.delete(m.id);
        } else if (p.lit && d < rr) {
          const k = ((1 - d / rr) * 140 * dt) / d;
          m.x += dx * k; m.y += dy * k;
          m.restT = 0;
        }
      }
    }

    // loose-mote lifecycle: physics, merge, settle (§3)
    for (const m of this.loose.values()) {
      if (Math.abs(m.vx) + Math.abs(m.vy) > 6) {
        m.x = clamp(m.x + m.vx * dt, 8, CFG.arena - 8);
        m.y = clamp(m.y + m.vy * dt, 8, CFG.arena - 8);
        const f = Math.pow(0.02, dt);
        m.vx *= f; m.vy *= f;
        m.restT = 0;
      } else {
        m.vx = 0; m.vy = 0;
        m.restT += dt;
      }
    }
    this.mergeClock -= dt;
    if (this.mergeClock <= 0) {
      this.mergeClock = 0.4;
      const arr = [...this.loose.values()];
      for (let i = arr.length - 1; i >= 0; i--) {
        const a = arr[i]!;
        if (a.restT <= 0.3 || !this.loose.has(a.id)) continue;
        for (let j = i - 1; j >= 0; j--) {
          const b = arr[j]!;
          if (b.restT <= 0.3 || !this.loose.has(b.id)) continue;
          if (Math.abs(a.x - b.x) < CFG.mergeRadius && Math.abs(a.y - b.y) < CFG.mergeRadius) {
            b.value += a.value;
            b.x = (a.x + b.x) / 2; b.y = (a.y + b.y) / 2;
            b.restT = Math.min(a.restT, b.restT);
            if (a.lockUntil > b.lockUntil) { b.lockUntil = a.lockUntil; b.lockOwner = a.lockOwner; }
            this.loose.delete(a.id);
            break;
          }
        }
      }
    }
    for (const m of this.loose.values()) {
      if (m.restT > CFG.settleRest) {
        m.settling += dt;
        if (m.settling > CFG.settleFlicker) {
          this.loose.delete(m.id);
          // field motes are worth exactly 1, so a loose value can't be represented
          // exactly — carry the sub-unit remainder forward so total light stays
          // conserved across settles (the accumulator always stays in [0,1))
          const settled = settleFieldMotes(m.value, this.settleRemainder);
          this.settleRemainder = settled.remainder;
          if (settled.count > 0) {
            const id = nextId++;
            this.motes.set(id, { id, x: m.x, y: m.y });       // one where it settled
            for (let k = 1; k < settled.count; k++) this.spawnMote(); // the rest scattered
          }
        }
      } else {
        m.settling = 0;
      }
    }

    // the contact law — O(n²) is fine at room scale
    for (let i = 0; i < alive.length; i++) {
      const a = alive[i]!;
      if (a.dead) continue;
      for (let j = i + 1; j < alive.length; j++) {
        const b = alive[j]!;
        if (b.dead || a.dead) continue;
        const ra = bodyR(a.light), rb = bodyR(b.light);
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d >= ra + rb) continue;
        this.resolveContact(a, b);
        // soft separation
        if (!a.dead && !b.dead && d > 0.01) {
          const push = (ra + rb - d) / 2;
          const nx = (b.x - a.x) / d, ny = (b.y - a.y) / d;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
        }
      }
    }

    // prune stale immunity entries
    if (this.pairImmune.size > 512) {
      for (const [k, t] of this.pairImmune) if (t < this.now) this.pairImmune.delete(k);
    }

    this.broadcast();
    this.events = [];
  }

  // ---------------------------------------------------------------- perception broadcast (§6)
  /* Each client receives exactly what its lantern earns it: entities within
     its vision, entities whose glow reaches it, dark movers close enough to
     shimmer — nothing else ever crosses the wire. The three ways of being
     perceived are not equally revealing, so they do not produce equal
     payloads; see PerceiveMode and the fidelity helpers at the top. */
  private perceiveMode(viewer: Player, o: Player, vision: number): PerceiveMode {
    const d = Math.hypot(o.x - viewer.x, o.y - viewer.y);
    if (d <= vision + bodyR(o.light)) return P_FULL;                  // in my vision
    // a burning or freshly revealed lantern that reaches me is simply seen;
    // a dark one is only the smudge its irreducible glow cannot hide
    if (d <= glowRadius(o)) return o.lit || o.revealT > 0 ? P_FULL : P_GLOW;
    return !o.lit && o.speed > CFG.shimmerMinSpeed && d <= shimmerRadius(o)
      ? P_SHIMMER : P_NONE;
  }

  /** Whether o's wake registers for this viewer at all, independent of how
      much else the viewer knows about it. */
  private shimmers(viewer: Player, o: Player): boolean {
    return !o.lit && o.speed > CFG.shimmerMinSpeed &&
      Math.hypot(o.x - viewer.x, o.y - viewer.y) <= shimmerRadius(o);
  }

  private broadcast(): void {
    const nowMs = Date.now();
    const dt = 1 / CFG.tickRate;
    for (const p of this.players.values()) {
      if (!p.socket) continue;   // bots perceive in botThink; nothing to send them
      const vision = p.dead ? 400 : p.lit ? visionLit(p.light) : CFG.darkVision;

      const players = [];
      const wakes: FxEvent[] = [];
      const shimmering = new Set<number>();
      for (const o of this.players.values()) {
        if (o.dead) continue;
        const mode = o.id === p.id ? P_FULL : this.perceiveMode(p, o, vision);
        if (mode === P_NONE) continue;

        /* Wake rings are emitted here, at the cadence, rather than derived on
           the client from a speed — a client-side throttle is one edit away
           from a continuous track. The origin is exact only for a body this
           client can already see anyway (including its own, so you can still
           read how loud your own sneaking is); otherwise it is grid-snapped,
           so 25 snapshots a second still resolve to one cell. */
        if (this.shimmers(p, o)) {
          shimmering.add(o.id);
          const step = SHIMMER_STEPS[shimmerStep(o.speed)]!;
          const c = (p.shimmerClocks.get(o.id) ?? 0) - dt;
          if (c > 0) {
            p.shimmerClocks.set(o.id, c);
          } else {
            p.shimmerClocks.set(o.id, step.period);
            const exact = mode === P_FULL;
            wakes.push({
              kind: EffectKind.SHIMMER,
              x: exact ? o.x : snapGrid(o.x, CFG.shimmerGrid),
              y: exact ? o.y : snapGrid(o.y, CFG.shimmerGrid),
              m: step.intensity,
            });
          }
        }

        if (mode === P_SHIMMER) continue;   // the ring is the whole message

        // a smudge has no name and no readable gait, and reports only the
        // light its own radius already gives away
        const smudge = mode === P_GLOW;
        players.push({
          id: o.id, x: o.x, y: o.y,
          light: smudge ? smudgeLight(o.light) : o.light,
          lit: o.lit,
          revealT: o.revealT,
          shielded: this.now < o.protectedUntil,
          speed: smudge ? 0 : o.speed,
          name: smudge ? "" : o.name,
          dashCd: o.id === p.id ? o.dashCd : 0,   // only your own cooldown crosses the wire
        });
      }
      // contacts that slipped out of wake range restart their cadence on
      // return, and stop holding a slot in the map
      for (const id of p.shimmerClocks.keys()) {
        if (!shimmering.has(id)) p.shimmerClocks.delete(id);
      }

      const motes = [];
      const moteR = vision + 20;
      const moteR2 = moteR * moteR;
      for (const m of this.motes.values()) {
        const dx = m.x - p.x, dy = m.y - p.y;
        if (Math.abs(dx) > moteR || Math.abs(dy) > moteR) continue;   // broad-phase box
        if (dx * dx + dy * dy <= moteR2) motes.push({ id: m.id, x: m.x, y: m.y });
      }

      const loose = [];
      const looseR = Math.max(vision, 150);
      const looseR2 = looseR * looseR;
      for (const m of this.loose.values()) {
        const dx = m.x - p.x, dy = m.y - p.y;
        if (Math.abs(dx) > looseR || Math.abs(dy) > looseR) continue;
        if (dx * dx + dy * dy <= looseR2) {
          loose.push({ id: m.id, x: m.x, y: m.y, value: m.value, settling: m.settling > 0 });
        }
      }

      const effects = [...wakes];
      for (const e of this.events) {
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        const reach =
          e.kind === EffectKind.BURN || e.kind === EffectKind.SNUFF
            ? CFG.flareVisibility                          // flares pierce the darkness (§5)
            : e.kind === EffectKind.DOUSE ? 500 : 300;
        if (d <= reach) effects.push(e);
      }

      this.send(p, {
        msg: {
          case: "snapshot",
          value: { serverTimeMs: nowMs, players, motes, loose, effects },
        },
      });
    }
  }

  /* Exactly the rows a client should paint, in order. The caller may name
     itself: a player below the cut then takes the last row, carrying its true
     rank, rather than being handed the whole ladder to search. Trimming here
     rather than in the client leaves one place that decides the board's shape. */
  leaderboard(selfId?: number): LeaderboardEntry[] {
    const ranked = [...this.players.values()]
      .filter((p) => !p.dead)
      // id breaks ties: without it, players level on light swap rows between
      // polls and the reader's eye is dragged across a board that hasn't moved
      .sort((a, b) => b.light - a.light || a.id - b.id)
      .map((p, i) => ({ id: p.id, name: p.name, light: Math.floor(p.light), rank: i + 1 }));
    const top = ranked.slice(0, LEADERBOARD_ROWS);
    if (selfId !== undefined && top.length && !top.some((e) => e.id === selfId)) {
      const self = ranked.find((e) => e.id === selfId);
      if (self) top[top.length - 1] = self;
    }
    return top;
  }
}
