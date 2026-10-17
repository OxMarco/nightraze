import type {
  Snapshot,
  PlayerState,
  MoteState,
  LooseMoteState,
  Effect,
} from "../gen/nightraze/v1/game_pb.js";

/**
 * The world state at a single render instant, produced by interpolating
 * between two server snapshots. This is what the renderer draws.
 */
export interface WorldFrame {
  /** Server time (ms) this frame represents. */
  serverTimeMs: number;
  players: InterpolatedPlayer[];
  motes: MoteState[];
  loose: InterpolatedLoose[];
}

export interface InterpolatedPlayer {
  id: number;
  x: number;
  y: number;
  light: number;
  lit: boolean;
  revealT: number;
  shielded: boolean;
  speed: number;
  name: string;
  dashCd: number;
}

export interface InterpolatedLoose {
  id: number;
  x: number;
  y: number;
  value: number;
  settling: boolean;
}

/** How far in the past we render, so there's always a pair of snapshots to lerp between. */
export const INTERP_DELAY_MS = 100;

/** Snapshots older than this are dropped. */
const BUFFER_WINDOW_MS = 1000;

/** Cap on undrained one-shot effects — bounds the burst a backgrounded tab
 *  (RAF paused, so drainEffects never runs) replays all at once on refocus. */
const MAX_PENDING_EFFECTS = 48;

interface BufferedSnapshot {
  snapshot: Snapshot;
  playerById: Map<number, PlayerState>;
  looseById: Map<number, LooseMoteState>;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Holds recent server snapshots and produces interpolated world frames.
 * Transient effects (burns, snuffs, douses) are not part of the sampled
 * frame — they are one-shot events, queued on arrival and drained once by
 * the renderer, which turns them into local particles with lifetimes.
 */
export class SnapshotBuffer {
  private snapshots: BufferedSnapshot[] = [];
  private clockOffsetMs: number | null = null; // serverTime - performance.now()
  private pendingEffects: Effect[] = [];

  push(snapshot: Snapshot): void {
    const nowLocal = performance.now();

    const observed = snapshot.serverTimeMs - nowLocal;
    this.clockOffsetMs =
      this.clockOffsetMs === null
        ? observed
        : this.clockOffsetMs * 0.9 + observed * 0.1;

    const playerById = new Map<number, PlayerState>();
    for (const p of snapshot.players) playerById.set(p.id, p);
    const looseById = new Map<number, LooseMoteState>();
    for (const m of snapshot.loose) looseById.set(m.id, m);
    this.snapshots.push({ snapshot, playerById, looseById });

    if (snapshot.effects.length) {
      this.pendingEffects.push(...snapshot.effects);
      if (this.pendingEffects.length > MAX_PENDING_EFFECTS) {
        this.pendingEffects.splice(0, this.pendingEffects.length - MAX_PENDING_EFFECTS);
      }
    }

    const cutoff = snapshot.serverTimeMs - BUFFER_WINDOW_MS;
    while (this.snapshots.length > 2 && this.snapshots[0]!.snapshot.serverTimeMs < cutoff) {
      this.snapshots.shift();
    }
  }

  clear(): void {
    this.snapshots = [];
    this.clockOffsetMs = null;
    this.pendingEffects = [];
  }

  /** One-shot server effects since the last drain. Call once per render frame. */
  drainEffects(): Effect[] {
    if (this.pendingEffects.length === 0) return this.pendingEffects;
    const out = this.pendingEffects;
    this.pendingEffects = [];
    return out;
  }

  /** Estimated current server time, or null before the first snapshot. */
  estimatedServerNowMs(): number | null {
    if (this.clockOffsetMs === null) return null;
    return performance.now() + this.clockOffsetMs;
  }

  /**
   * Interpolated world state at the standard render delay.
   * Returns null until at least one snapshot has arrived.
   */
  sample(): WorldFrame | null {
    const serverNow = this.estimatedServerNowMs();
    if (serverNow === null || this.snapshots.length === 0) return null;
    const renderTime = serverNow - INTERP_DELAY_MS;

    let older = this.snapshots[0]!;
    let newer = this.snapshots[this.snapshots.length - 1]!;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const s = this.snapshots[i]!;
      if (s.snapshot.serverTimeMs <= renderTime) {
        older = s;
        newer = this.snapshots[i + 1] ?? s;
        break;
      }
    }

    const t0 = older.snapshot.serverTimeMs;
    const t1 = newer.snapshot.serverTimeMs;
    const t = t1 > t0 ? Math.min(1, Math.max(0, (renderTime - t0) / (t1 - t0))) : 1;

    // Entities only in the older snapshot have left perception (or died) —
    // let them vanish; that IS the stealth model working.
    const players: InterpolatedPlayer[] = [];
    for (const pNew of newer.snapshot.players) {
      const pOld = older.playerById.get(pNew.id);
      players.push({
        id: pNew.id,
        name: pNew.name,
        lit: pNew.lit,
        revealT: pNew.revealT,
        shielded: pNew.shielded,
        speed: pNew.speed,
        dashCd: pOld ? lerp(pOld.dashCd, pNew.dashCd, t) : pNew.dashCd,
        x: pOld ? lerp(pOld.x, pNew.x, t) : pNew.x,
        y: pOld ? lerp(pOld.y, pNew.y, t) : pNew.y,
        light: pOld ? lerp(pOld.light, pNew.light, t) : pNew.light,
      });
    }

    // Loose motes scatter with velocity — interpolate them too.
    const loose: InterpolatedLoose[] = [];
    for (const mNew of newer.snapshot.loose) {
      const mOld = older.looseById.get(mNew.id);
      loose.push({
        id: mNew.id,
        value: mNew.value,
        settling: mNew.settling,
        x: mOld ? lerp(mOld.x, mNew.x, t) : mNew.x,
        y: mOld ? lerp(mOld.y, mNew.y, t) : mNew.y,
      });
    }

    // Field motes barely move (suction drift only); newest view is fine.
    return { serverTimeMs: renderTime, players, motes: newer.snapshot.motes, loose };
  }
}
