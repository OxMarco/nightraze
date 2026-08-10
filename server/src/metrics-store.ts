import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface MetricsSnapshot {
  currentPlaying: number;
  dailyActiveUsers: Array<{ date: string; users: number }>;
  sessions: { completed: number; meanPlaytimeSeconds: number };
  connection: { samples: number; meanPingMs: number; p95PingMs: number };
  locations: Array<{ location: string; users: number }>;
  bans: { last24Hours: number; last30Days: number; total: number };
  appCrashes: {
    last24Hours: number;
    last30Days: number;
    total: number;
    byKind: Array<{ kind: string; crashes: number }>;
  };
}

interface SessionResult { lastInsertRowid: number | bigint }

export interface MetricsSweepResult {
  sessions: number;
  dailyUsers: number;
  pingSamples: number;
}

const DETAIL_RETENTION_MS = 90 * 86_400_000;

/** Durable, privacy-minimised product metrics. Only hashed visitor ids enter this DB. */
export class MetricsStore {
  private readonly db: DatabaseSync;
  private readonly insertSession: StatementSync;
  private readonly endSessionStatement: StatementSync;
  private readonly identifySessionStatement: StatementSync;
  private readonly insertDailyUser: StatementSync;
  private readonly insertPing: StatementSync;
  private readonly updateSessionPing: StatementSync;
  private readonly insertBan: StatementSync;
  private readonly insertCrash: StatementSync;
  private closed = false;

  constructor(path: string) {
    if (!path) throw new Error("metrics database path must not be empty");
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 1_000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- recordPing commits a transaction per sample: one every ten seconds per
      -- connected player, which at capacity is ten commits a second on the
      -- game's own event loop. NORMAL keeps WAL's crash safety and drops the
      -- fsync per commit; the exposure is losing the last few milliseconds of
      -- latency samples and session bookkeeping to a power cut, which is not
      -- data anything depends on being complete.
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY,
        visitor_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        location TEXT NOT NULL,
        ping_sum_ms REAL NOT NULL DEFAULT 0,
        ping_count INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS daily_users (
        day TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        location TEXT NOT NULL,
        PRIMARY KEY (day, visitor_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ping_samples (
        recorded_at INTEGER NOT NULL,
        ping_ms REAL NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ban_events (
        issued_at INTEGER NOT NULL,
        offense_count INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS crash_events (
        occurred_at INTEGER NOT NULL,
        visitor_id TEXT,
        kind TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at);
      CREATE INDEX IF NOT EXISTS daily_users_day ON daily_users (day);
      CREATE INDEX IF NOT EXISTS ping_samples_time ON ping_samples (recorded_at);
      -- The p95 below asks for one row from the middle of the window sorted by
      -- latency. With only the time index, SQLite answers that by sorting every
      -- sample in the window on each /metrics request — the largest table here
      -- by orders of magnitude, since it gains a row per player per ten
      -- seconds. Leading on ping_ms makes the ORDER BY an index walk, and
      -- carrying recorded_at makes the window filter a covering read, so the
      -- table itself is never touched.
      CREATE INDEX IF NOT EXISTS ping_samples_value ON ping_samples (ping_ms, recorded_at);
      CREATE INDEX IF NOT EXISTS ban_events_time ON ban_events (issued_at);
      CREATE INDEX IF NOT EXISTS crash_events_time ON crash_events (occurred_at);
    `);
    this.insertSession = this.db.prepare(`
      INSERT INTO sessions (visitor_id, started_at, location) VALUES (?, ?, ?)
    `);
    this.endSessionStatement = this.db.prepare(`
      UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL
    `);
    this.identifySessionStatement = this.db.prepare(`
      UPDATE sessions SET visitor_id = ?, location = ?
      WHERE id = ? AND visitor_id IS NULL
    `);
    this.insertDailyUser = this.db.prepare(`
      INSERT INTO daily_users (day, visitor_id, location) VALUES (?, ?, ?)
      ON CONFLICT(day, visitor_id) DO UPDATE SET location = excluded.location
    `);
    this.insertPing = this.db.prepare(`
      INSERT INTO ping_samples (recorded_at, ping_ms) VALUES (?, ?)
    `);
    this.updateSessionPing = this.db.prepare(`
      UPDATE sessions
      SET ping_sum_ms = ping_sum_ms + ?, ping_count = ping_count + 1
      WHERE id = ?
    `);
    this.insertBan = this.db.prepare(`
      INSERT INTO ban_events (issued_at, offense_count, duration_ms) VALUES (?, ?, ?)
    `);
    this.insertCrash = this.db.prepare(`
      INSERT INTO crash_events (occurred_at, visitor_id, kind) VALUES (?, ?, ?)
    `);
  }

  startSession(visitorId: string | null, location: string, now = Date.now()): number {
    const result = this.insertSession.run(visitorId, now, location) as SessionResult;
    if (visitorId) {
      const day = new Date(now).toISOString().slice(0, 10);
      this.insertDailyUser.run(day, visitorId, location);
    }
    return Number(result.lastInsertRowid);
  }

  endSession(id: number, now = Date.now()): void {
    this.endSessionStatement.run(now, id);
  }

  identifySession(id: number, visitorId: string, location: string, now = Date.now()): void {
    const result = this.identifySessionStatement.run(visitorId, location, id);
    if (Number(result.changes) === 0) return;
    const day = new Date(now).toISOString().slice(0, 10);
    this.insertDailyUser.run(day, visitorId, location);
  }

  recordPing(sessionId: number, pingMs: number, now = Date.now()): void {
    if (!Number.isFinite(pingMs) || pingMs < 0 || pingMs > 120_000) return;
    const value = Math.round(pingMs * 10) / 10;
    this.db.exec("BEGIN");
    try {
      this.insertPing.run(now, value);
      this.updateSessionPing.run(value, sessionId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  recordBan(offenseCount: number, durationMs: number, now = Date.now()): void {
    this.insertBan.run(now, offenseCount, durationMs);
  }

  recordCrash(visitorId: string | null, kind: string, now = Date.now()): void {
    this.insertCrash.run(now, visitorId, kind.slice(0, 40) || "unknown");
  }

  /** Prune detail that is used only by rolling reports. Lifetime event tables
      deliberately remain intact because their totals are part of the API. */
  sweep(now = Date.now()): MetricsSweepResult {
    const cutoff = now - DETAIL_RETENTION_MS;
    let result: MetricsSweepResult;
    this.db.exec("BEGIN");
    try {
      const sessions = this.db.prepare(
        "DELETE FROM sessions WHERE started_at < ?",
      ).run(cutoff);
      const dailyUsers = this.db.prepare(`
        DELETE FROM daily_users WHERE day < date(?, 'unixepoch')
      `).run(Math.floor(cutoff / 1_000));
      const pingSamples = this.db.prepare(
        "DELETE FROM ping_samples WHERE recorded_at < ?",
      ).run(cutoff);
      this.db.exec("COMMIT");
      result = {
        sessions: Number(sessions.changes),
        dailyUsers: Number(dailyUsers.changes),
        pingSamples: Number(pingSamples.changes),
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    // Deliberately after the transaction closes, so a failure here cannot reach
    // a catch that would try to roll back a transaction already committed.
    //
    // Load-bearing rather than housekeeping. snapshot()'s p95 asks for one row
    // from the middle of the latency window in sorted order; with no statistics
    // SQLite has no reason to believe the window filter is unselective, so it
    // takes the time index and sorts the whole window in a temp b-tree.
    // Measured on 2M samples that is a two second query — and it runs on the
    // event loop the simulation ticks on, so one /metrics request stutters the
    // arena for every connected player. With statistics it takes the covering
    // index instead and answers in ~40ms. `optimize` rather than a blanket
    // ANALYZE: 2ms on a cold 2M-row table, and a no-op once nothing has changed
    // enough to matter.
    this.db.exec("PRAGMA optimize");
    return result;
  }

  snapshot(currentPlaying: number, now = Date.now()): MetricsSnapshot {
    const rolling30 = now - 30 * 86_400_000;
    const day1 = now - 86_400_000;
    const firstUtcDay = new Date(now);
    firstUtcDay.setUTCHours(0, 0, 0, 0);
    firstUtcDay.setUTCDate(firstUtcDay.getUTCDate() - 29);
    const firstUtcDaySeconds = Math.floor(firstUtcDay.getTime() / 1_000);
    const dailyActiveUsers = this.db.prepare(`
      SELECT day AS date, COUNT(*) AS users FROM daily_users
      WHERE day >= date(?, 'unixepoch') GROUP BY day ORDER BY day
    `).all(firstUtcDaySeconds).map((row) => ({
      date: String(row.date), users: Number(row.users),
    }));
    const session = this.db.prepare(`
      SELECT COUNT(*) AS completed,
             COALESCE(AVG(ended_at - started_at), 0) AS mean_ms
      FROM sessions WHERE ended_at IS NOT NULL AND started_at >= ?
    `).get(rolling30)!;
    // Keep the potentially large sample set inside SQLite rather than loading
    // 30 days of pings into the Node heap merely to calculate two aggregates.
    const pingAggregate = this.db.prepare(`
      SELECT COUNT(*) AS samples, COALESCE(AVG(ping_ms), 0) AS mean
      FROM ping_samples WHERE recorded_at >= ?
    `).get(rolling30)!;
    const pingSamples = Number(pingAggregate.samples);
    const meanPing = Number(pingAggregate.mean);
    const p95Row = pingSamples === 0 ? undefined : this.db.prepare(`
      SELECT ping_ms FROM ping_samples WHERE recorded_at >= ?
      ORDER BY ping_ms LIMIT 1 OFFSET ?
    `).get(rolling30, Math.ceil(pingSamples * 0.95) - 1);
    const p95 = Number(p95Row?.ping_ms ?? 0);
    const locations = this.db.prepare(`
      SELECT location, COUNT(DISTINCT visitor_id) AS users FROM daily_users
      WHERE day >= date(?, 'unixepoch') GROUP BY location ORDER BY users DESC, location LIMIT 50
    `).all(firstUtcDaySeconds).map((row) => ({
      location: String(row.location), users: Number(row.users),
    }));
    const countSince = (table: string, column: string, since?: number): number => {
      const sql = since === undefined
        ? `SELECT COUNT(*) AS count FROM ${table}`
        : `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} >= ?`;
      const row = since === undefined ? this.db.prepare(sql).get() : this.db.prepare(sql).get(since);
      return Number(row?.count ?? 0);
    };
    const byKind = this.db.prepare(`
      SELECT kind, COUNT(*) AS crashes FROM crash_events
      WHERE occurred_at >= ? GROUP BY kind ORDER BY crashes DESC, kind
    `).all(rolling30).map((row) => ({ kind: String(row.kind), crashes: Number(row.crashes) }));
    return {
      currentPlaying,
      dailyActiveUsers,
      sessions: {
        completed: Number(session.completed),
        meanPlaytimeSeconds: Math.round(Number(session.mean_ms) / 100) / 10,
      },
      connection: {
        samples: pingSamples,
        meanPingMs: Math.round(meanPing * 10) / 10,
        p95PingMs: Math.round(p95 * 10) / 10,
      },
      locations,
      bans: {
        last24Hours: countSince("ban_events", "issued_at", day1),
        last30Days: countSince("ban_events", "issued_at", rolling30),
        total: countSince("ban_events", "issued_at"),
      },
      appCrashes: {
        last24Hours: countSince("crash_events", "occurred_at", day1),
        last30Days: countSince("crash_events", "occurred_at", rolling30),
        total: countSince("crash_events", "occurred_at"),
        byKind,
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
