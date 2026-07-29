import assert from "node:assert/strict";
import test from "node:test";
import { MetricsStore } from "../dist/metrics-store.js";

test("metrics store aggregates sessions, DAU, ping, locations, bans and crashes", () => {
  const store = new MetricsStore(":memory:");
  const now = Date.UTC(2026, 6, 29, 12);
  const first = store.startSession("visitor_0000000001", "country:MT", now - 20_000);
  const second = store.startSession("visitor_0000000001", "country:MT", now - 10_000);
  store.startSession("visitor_0000000002", "timezone:Europe/London", now - 5_000);
  store.endSession(first, now);
  store.endSession(second, now);
  store.recordPing(first, 20, now);
  store.recordPing(second, 80, now);
  store.recordBan(2, 50_000, now);
  store.recordCrash("visitor_0000000001", "react-render", now);

  const result = store.snapshot(3, now);
  assert.equal(result.currentPlaying, 3);
  assert.deepEqual(result.dailyActiveUsers, [{ date: "2026-07-29", users: 2 }]);
  assert.deepEqual(result.sessions, { completed: 2, meanPlaytimeSeconds: 15 });
  assert.deepEqual(result.connection, { samples: 2, meanPingMs: 50, p95PingMs: 80 });
  assert.deepEqual(result.locations, [
    { location: "country:MT", users: 1 },
    { location: "timezone:Europe/London", users: 1 },
  ]);
  assert.deepEqual(result.bans, { last24Hours: 1, last30Days: 1, total: 1 });
  assert.equal(result.appCrashes.last30Days, 1);
  assert.deepEqual(result.appCrashes.byKind, [{ kind: "react-render", crashes: 1 }]);
  store.close();
});

test("anonymous legacy sessions do not inflate DAU", () => {
  const store = new MetricsStore(":memory:");
  store.startSession(null, "unknown", Date.UTC(2026, 6, 29));
  const result = store.snapshot(1, Date.UTC(2026, 6, 29, 1));
  assert.deepEqual(result.dailyActiveUsers, []);
  store.close();
});

test("daily aggregates contain exactly 30 UTC calendar dates", () => {
  const store = new MetricsStore(":memory:");
  const now = Date.UTC(2026, 6, 29, 12);
  store.startSession("visitor_first_included", "country:MT", Date.UTC(2026, 5, 30, 0));
  store.startSession("visitor_one_day_old", "country:GB", Date.UTC(2026, 5, 29, 23, 59));

  const result = store.snapshot(0, now);
  assert.deepEqual(result.dailyActiveUsers, [{ date: "2026-06-30", users: 1 }]);
  assert.deepEqual(result.locations, [{ location: "country:MT", users: 1 }]);
  store.close();
});

test("sweep bounds rolling detail without deleting lifetime events", () => {
  const store = new MetricsStore(":memory:");
  const now = Date.UTC(2026, 6, 29, 12);
  const old = now - 91 * 86_400_000;
  const recent = now - 89 * 86_400_000;
  const oldSession = store.startSession("visitor_old_detail", "country:MT", old);
  const recentSession = store.startSession("visitor_recent_detail", "country:GB", recent);
  store.recordPing(oldSession, 20, old);
  store.recordPing(recentSession, 40, recent);
  store.recordBan(1, 1_000, old);
  store.recordCrash("visitor_old_detail", "window-error", old);

  assert.deepEqual(store.sweep(now), { sessions: 1, dailyUsers: 1, pingSamples: 1 });
  const result = store.snapshot(0, now);
  assert.equal(result.bans.total, 1);
  assert.equal(result.appCrashes.total, 1);
  store.close();
});
