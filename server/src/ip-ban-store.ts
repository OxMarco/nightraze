import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Clock = () => number;

export interface IpBanStoreOptions {
  now?: Clock;
  multiplier?: number;
  maxBanMs?: number;
  resetAfterMs?: number;
}

export interface AppliedBan {
  offenseCount: number;
  durationMs: number;
  bannedUntil: number;
}

interface BanHistoryRow {
  banned_until: number;
  offense_count: number;
  last_banned_at: number;
}

const DEFAULT_MAX_BAN_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_RESET_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Durable, escalating IP bans with an in-memory admission path.
 *
 * SQLite is touched only when a ban is added or old history is swept. Socket
 * admission remains a Map lookup, while both active bans and offense counts
 * survive server restarts.
 */
export class IpBanStore {
  private readonly db: DatabaseSync;
  private readonly bans = new Map<string, number>();
  private readonly getHistory: StatementSync;
  private readonly upsertBan: StatementSync;
  private readonly deleteStaleHistory: StatementSync;
  private readonly now: Clock;
  private readonly multiplier: number;
  private readonly maxBanMs: number;
  private readonly resetAfterMs: number;
  private closed = false;

  constructor(path: string, options: IpBanStoreOptions = {}) {
    if (!path) throw new Error("IP ban database path must not be empty");
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });

    this.now = options.now ?? Date.now;
    this.multiplier = options.multiplier ?? 10;
    this.maxBanMs = options.maxBanMs ?? DEFAULT_MAX_BAN_MS;
    this.resetAfterMs = options.resetAfterMs ?? DEFAULT_RESET_AFTER_MS;
    if (!Number.isFinite(this.multiplier) || this.multiplier < 1) {
      throw new TypeError("IP ban multiplier must be at least 1");
    }
    if (!Number.isSafeInteger(this.maxBanMs) || this.maxBanMs <= 0) {
      throw new TypeError("maximum IP ban duration must be a positive integer");
    }
    if (!Number.isSafeInteger(this.resetAfterMs) || this.resetAfterMs <= 0) {
      throw new TypeError("IP ban reset duration must be a positive integer");
    }

    this.db = new DatabaseSync(path, { timeout: 1_000 });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ip_bans (
        ip TEXT PRIMARY KEY,
        banned_until INTEGER NOT NULL,
        offense_count INTEGER NOT NULL DEFAULT 1,
        last_banned_at INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
    this.migrateLegacySchema();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS ip_bans_expiry ON ip_bans (banned_until);
      CREATE INDEX IF NOT EXISTS ip_bans_history_expiry ON ip_bans (last_banned_at);
    `);

    this.getHistory = this.db.prepare(`
      SELECT banned_until, offense_count, last_banned_at
      FROM ip_bans
      WHERE ip = ?
    `);
    this.upsertBan = this.db.prepare(`
      INSERT INTO ip_bans (ip, banned_until, offense_count, last_banned_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET
        banned_until = excluded.banned_until,
        offense_count = excluded.offense_count,
        last_banned_at = excluded.last_banned_at
    `);
    this.deleteStaleHistory = this.db.prepare(`
      DELETE FROM ip_bans
      WHERE banned_until <= ? AND last_banned_at <= ?
    `);

    const currentTime = this.now();
    const active = this.db
      .prepare("SELECT ip, banned_until FROM ip_bans WHERE banned_until > ?")
      .all(currentTime) as Array<{ ip: string; banned_until: number }>;
    for (const row of active) this.bans.set(row.ip, row.banned_until);
    this.deleteStaleHistory.run(currentTime, currentTime - this.resetAfterMs);
  }

  private migrateLegacySchema(): void {
    const columns = new Set(
      this.db.prepare("PRAGMA table_info(ip_bans)").all().map((row) => String(row.name)),
    );
    if (!columns.has("offense_count")) {
      this.db.exec("ALTER TABLE ip_bans ADD COLUMN offense_count INTEGER NOT NULL DEFAULT 1");
    }
    if (!columns.has("last_banned_at")) {
      this.db.exec("ALTER TABLE ip_bans ADD COLUMN last_banned_at INTEGER NOT NULL DEFAULT 0");
    }
  }

  isBanned(ip: string): boolean {
    const until = this.bans.get(ip);
    if (until === undefined) return false;
    if (this.now() < until) return true;

    // Keep SQLite off the socket-admission path. The periodic sweep retains the
    // offense history until its reset window has passed.
    this.bans.delete(ip);
    return false;
  }

  ban(ip: string, baseDurationMs: number): AppliedBan {
    if (!Number.isSafeInteger(baseDurationMs) || baseDurationMs <= 0) {
      throw new TypeError("base IP ban duration must be a positive integer");
    }

    const currentTime = this.now();
    const previous = this.getHistory.get(ip) as BanHistoryRow | undefined;
    const continuesHistory = previous !== undefined && (
      previous.banned_until > currentTime ||
      previous.last_banned_at > currentTime - this.resetAfterMs
    );
    const offenseCount = continuesHistory
      ? Math.max(1, previous.offense_count) + 1
      : 1;
    const durationMs = this.scaledDuration(baseDurationMs, offenseCount);
    const bannedUntil = Math.max(previous?.banned_until ?? 0, currentTime + durationMs);

    // Update memory first so a transient disk error cannot immediately let the
    // offending client reconnect. The caller still receives the write error.
    this.bans.set(ip, bannedUntil);
    this.upsertBan.run(ip, bannedUntil, offenseCount, currentTime);
    return { offenseCount, durationMs, bannedUntil };
  }

  private scaledDuration(baseDurationMs: number, offenseCount: number): number {
    let duration = Math.min(baseDurationMs, this.maxBanMs);
    if (this.multiplier === 1) return duration;
    for (let offense = 1; offense < offenseCount && duration < this.maxBanMs; offense++) {
      duration = Math.min(this.maxBanMs, duration * this.multiplier);
    }
    return Math.trunc(duration);
  }

  sweepExpired(): number {
    const currentTime = this.now();
    for (const [ip, until] of this.bans) {
      if (until <= currentTime) this.bans.delete(ip);
    }
    return Number(
      this.deleteStaleHistory.run(currentTime, currentTime - this.resetAfterMs).changes,
    );
  }

  activeCount(): number {
    return this.bans.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
