import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { IpBanStore } from "../dist/ip-ban-store.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const BASE_BAN = 5 * MINUTE;

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "nightraze-ip-bans-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "bans.sqlite");
}

function options(now, overrides = {}) {
  return {
    now,
    multiplier: 10,
    maxBanMs: 7 * DAY,
    resetAfterMs: 30 * DAY,
    ...overrides,
  };
}

test("active bans survive closing and reopening the store", (t) => {
  const path = temporaryDatabase(t);
  let now = 1_000_000;

  const first = new IpBanStore(path, options(() => now));
  const applied = first.ban("203.0.113.4", BASE_BAN);
  assert.deepEqual(applied, {
    offenseCount: 1,
    durationMs: BASE_BAN,
    bannedUntil: now + BASE_BAN,
  });
  first.close();

  now += MINUTE;
  const reopened = new IpBanStore(path, options(() => now));
  assert.equal(reopened.isBanned("203.0.113.4"), true);
  assert.equal(reopened.activeCount(), 1);
  reopened.close();
});

test("repeat offenses scale by ten after the previous ban expires", (t) => {
  const path = temporaryDatabase(t);
  let now = 2_000_000;
  const store = new IpBanStore(path, options(() => now));

  const first = store.ban("2001:db8::1", BASE_BAN);
  now = first.bannedUntil;
  assert.equal(store.isBanned("2001:db8::1"), false);

  const second = store.ban("2001:db8::1", BASE_BAN);
  assert.equal(second.offenseCount, 2);
  assert.equal(second.durationMs, 50 * MINUTE);
  now = second.bannedUntil;

  const third = store.ban("2001:db8::1", BASE_BAN);
  assert.equal(third.offenseCount, 3);
  assert.equal(third.durationMs, 500 * MINUTE);
  store.close();
});

test("offense history survives restarts after the active ban expires", (t) => {
  const path = temporaryDatabase(t);
  let now = 3_000_000;

  const first = new IpBanStore(path, options(() => now));
  const initial = first.ban("198.51.100.9", BASE_BAN);
  first.close();

  now = initial.bannedUntil;
  const reopened = new IpBanStore(path, options(() => now));
  assert.equal(reopened.isBanned("198.51.100.9"), false);
  const repeated = reopened.ban("198.51.100.9", BASE_BAN);
  assert.equal(repeated.offenseCount, 2);
  assert.equal(repeated.durationMs, 50 * MINUTE);
  reopened.close();
});

test("exponential durations stop at the configured cap", (t) => {
  const path = temporaryDatabase(t);
  let now = 4_000_000;
  const store = new IpBanStore(path, options(() => now, { maxBanMs: 60 * MINUTE }));

  const first = store.ban("192.0.2.8", BASE_BAN);
  now = first.bannedUntil;
  const second = store.ban("192.0.2.8", BASE_BAN);
  now = second.bannedUntil;
  const third = store.ban("192.0.2.8", BASE_BAN);

  assert.equal(second.durationMs, 50 * MINUTE);
  assert.equal(third.offenseCount, 3);
  assert.equal(third.durationMs, 60 * MINUTE);
  store.close();
});

test("offense history resets after a clean interval", (t) => {
  const path = temporaryDatabase(t);
  let now = 5_000_000;
  const resetAfterMs = DAY;
  const store = new IpBanStore(path, options(() => now, { resetAfterMs }));

  store.ban("203.0.113.55", BASE_BAN);
  now += resetAfterMs + 1;
  assert.equal(store.isBanned("203.0.113.55"), false);
  assert.equal(store.sweepExpired(), 1);

  const afterReset = store.ban("203.0.113.55", BASE_BAN);
  assert.equal(afterReset.offenseCount, 1);
  assert.equal(afterReset.durationMs, BASE_BAN);
  store.close();
});

test("databases from the single-duration schema are migrated", (t) => {
  const path = temporaryDatabase(t);
  let now = 6_000_000;
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE ip_bans (
      ip TEXT PRIMARY KEY,
      banned_until INTEGER NOT NULL
    ) STRICT;
  `);
  legacy.prepare("INSERT INTO ip_bans (ip, banned_until) VALUES (?, ?)")
    .run("192.0.2.44", now + BASE_BAN);
  legacy.close();

  const migrated = new IpBanStore(path, options(() => now));
  assert.equal(migrated.isBanned("192.0.2.44"), true);
  const repeated = migrated.ban("192.0.2.44", BASE_BAN);
  assert.equal(repeated.offenseCount, 2);
  assert.equal(repeated.durationMs, 50 * MINUTE);
  migrated.close();
});
