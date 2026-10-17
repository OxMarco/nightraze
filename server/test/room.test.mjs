import assert from "node:assert/strict";
import test from "node:test";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { Room, settleFieldMotes } from "../dist/game/room.js";
import { ClientMessageSchema, ServerMessageSchema, EffectKind } from "../dist/gen/nightraze/v1/game_pb.js";

class FakeSocket {
  OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  sent = [];
  closed = null;
  terminated = false;

  send(data) {
    this.sent.push(data);
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
}

function makeRoomAndPlayer() {
  const room = new Room();
  room.close();
  const socket = new FakeSocket();
  const player = room.addPlayer(socket, "test");
  return { room, socket, player };
}

test("fractional settlements create only whole field motes", () => {
  let remainder = 0;
  let count = 0;
  for (let i = 0; i < 10; i++) {
    const settled = settleFieldMotes(0.2, remainder);
    count += settled.count;
    remainder = settled.remainder;
  }

  assert.equal(count, 2);
  assert.ok(Math.abs(remainder) < 1e-9);
});

test("room health becomes ready only after the simulation advances", async () => {
  const room = new Room();
  assert.equal(room.health().ok, false);

  await new Promise((resolve) => setTimeout(resolve, 80));
  const health = room.health();
  room.close();

  assert.equal(health.ok, true);
  assert.ok(health.ticks >= 1);
  assert.ok(health.tickAgeMs >= 0);
  assert.ok(health.tickDurationMs >= 0);

  room.lastTickCompletedAt = performance.now() - 1_100;
  assert.equal(room.health().ok, false);
});

test("toggle cooldown rejects repeated stance changes", () => {
  const { room, player } = makeRoomAndPlayer();
  const toggle = Buffer.from(toBinary(
    ClientMessageSchema,
    create(ClientMessageSchema, { msg: { case: "toggle", value: {} } }),
  ));

  room.handleMessage(player, toggle, true);
  room.handleMessage(player, toggle, true);

  assert.equal(player.lit, false);
});

test("respawn synchronously restores the protected starter ember", () => {
  const { room, player } = makeRoomAndPlayer();
  const respawn = Buffer.from(toBinary(
    ClientMessageSchema,
    create(ClientMessageSchema, { msg: { case: "respawn", value: {} } }),
  ));
  player.dead = true;
  player.light = 0;
  player.peak = 50;

  room.handleMessage(player, respawn, true);

  assert.equal(player.dead, false);
  assert.equal(player.light, 12);
  assert.equal(player.peak, 12);
  assert.ok(player.protectedUntil > 0);
});

test("a human stays protected until their first steer", () => {
  const { room, player } = makeRoomAndPlayer();
  const steer = (tx, ty) => Buffer.from(toBinary(
    ClientMessageSchema,
    create(ClientMessageSchema, { msg: { case: "input", value: { tx, ty } } }),
  ));

  // well past ordinary spawn protection, still untouched: still held
  room.now += 10;
  assert.ok(room.now < player.protectedUntil);

  room.handleMessage(player, steer(0, 0), true);   // a released stick is not a steer
  assert.ok(room.now + 5 < player.protectedUntil);

  room.handleMessage(player, steer(30, 0), true);
  assert.equal(player.awaitingSteer, false);
  assert.ok(player.protectedUntil <= room.now + 2);

  const bot = room.addPlayer(null, "bot");
  assert.equal(bot.awaitingSteer, false);
  assert.ok(bot.protectedUntil <= room.now + 2);
});

/* Contact-law tests drive the private tick() directly (TS privacy is
   compile-time only) with two overlapping players and the field cleared,
   so the light ledger contains nothing but the contact itself. */
function makeContactPair() {
  const room = new Room();
  room.close();
  const a = room.addPlayer(new FakeSocket(), "toucher");
  const b = room.addPlayer(new FakeSocket(), "victim");
  room.motes.clear();
  a.x = 500; a.y = 500;
  b.x = 501; b.y = 500;
  a.protectedUntil = -1;
  b.protectedUntil = -1;
  return { room, a, b };
}

function looseTotal(room) {
  let sum = 0;
  for (const m of room.loose.values()) sum += m.value;
  return sum;
}

test("a lit touch spills the victim onto the table, never to the toucher", () => {
  const { room, a, b } = makeContactPair();
  a.light = 50;
  b.light = 100;
  b.lit = false;                      // dark protects against nothing (§7)

  room.tick();

  assert.equal(b.light, 100 - (4 + 0.16 * 100));       // spillFlat + spillPct
  assert.equal(a.light, 50);                           // nothing transfers
  assert.ok(Math.abs(looseTotal(room) - (4 + 0.16 * 100)) < 1e-9);
});

test("lit-on-lit contact burns both ways", () => {
  const { room, a, b } = makeContactPair();
  a.light = 50;
  b.light = 100;

  room.tick();

  assert.equal(a.light, 50 - (4 + 0.16 * 50));
  assert.equal(b.light, 100 - (4 + 0.16 * 100));
});

test("dash asymmetry: the striker's own light does not spill", () => {
  const { room, a, b } = makeContactPair();
  a.light = 100;
  b.light = 100;
  const dash = Buffer.from(toBinary(
    ClientMessageSchema,
    create(ClientMessageSchema, { msg: { case: "dash", value: { tx: 1, ty: 0 } } }),
  ));

  room.handleMessage(a, dash, true);  // opens the ~0.3s strike window
  const afterCost = a.light;          // dash fuel is spent up front
  room.tick();

  assert.equal(a.light, afterCost);                    // no burn-back on the striker
  assert.equal(b.light, 100 - (4 + 0.16 * 100));       // the victim still spills
});

test("burning a guttering lantern snuffs it and scatters its remainder", () => {
  const { room, a, b } = makeContactPair();
  const socketB = b.socket;
  a.light = 50;
  b.light = 5;                        // below the gutter (6)
  b.peak = 5;
  b.lit = false;

  room.tick();

  assert.equal(b.dead, true);
  assert.equal(b.light, 0);
  assert.ok(Math.abs(looseTotal(room) - 5) < 1e-9);    // the final crescent
  const dead = socketB.sent
    .map((buf) => fromBinary(ServerMessageSchema, buf))
    .find((m) => m.msg.case === "dead");
  assert.equal(dead.msg.value.by, "toucher");
  assert.equal(dead.msg.value.peakLight, 5);
});

test("spawn protection blocks the burn entirely", () => {
  const { room, a, b } = makeContactPair();
  a.light = 50;
  b.light = 100;
  b.protectedUntil = 1e9;

  room.tick();

  assert.equal(a.light, 50);
  assert.equal(b.light, 100);
  assert.equal(looseTotal(room), 0);
});

test("the total frame budget closes a flooding socket", () => {
  const { room, socket, player } = makeRoomAndPlayer();
  // valid input frames: past 60/s they are dropped without strikes, but every
  // frame still counts against the total budget
  const input = Buffer.from(toBinary(
    ClientMessageSchema,
    create(ClientMessageSchema, { msg: { case: "input", value: { tx: 10, ty: 0 } } }),
  ));

  for (let i = 0; i < 91; i++) room.handleMessage(player, input, true);

  assert.deepEqual(socket.closed, { code: 1008, reason: "message rate exceeded" });
  assert.equal(player.closing, true);
});

test("a slow consumer is terminated before more data is queued", () => {
  const room = new Room();
  room.close();
  const socket = new FakeSocket();
  socket.bufferedAmount = 256 * 1024 + 1;

  const player = room.addPlayer(socket, "slow");

  assert.equal(socket.terminated, true);
  assert.equal(player.closing, true);
  assert.equal(socket.sent.length, 0);
});

/* Perception fidelity (§6). Gating alone would still hand a modified client a
   wallhack: it renders whatever it receives, so what a contact is *allowed to
   be* has to be decided on this side of the wire. These drive the private
   broadcast() directly and read the frames off the FakeSocket. */
function lastSnapshot(socket) {
  for (let i = socket.sent.length - 1; i >= 0; i--) {
    const msg = fromBinary(ServerMessageSchema, socket.sent[i]);
    if (msg.msg.case === "snapshot") return msg.msg.value;
  }
  return null;
}

function makePerceptionPair() {
  const room = new Room();
  room.close();
  const viewer = room.addPlayer(new FakeSocket(), "viewer");
  const target = room.addPlayer(new FakeSocket(), "stalker");
  viewer.x = 1000; viewer.y = 1000;
  viewer.lit = false;              // dark vision: 60
  target.lit = false;
  target.speed = 0;
  return { room, viewer, target };
}

test("a shimmer contact sends a wake ring and no player state at all", () => {
  const { room, viewer, target } = makePerceptionPair();
  // 90 units away: past dark vision + body radius (~76), inside the wake
  // radius for this speed (~115)
  target.x = 1090; target.y = 1000;
  target.speed = 150;

  room.broadcast();
  const snap = lastSnapshot(viewer.socket);

  assert.deepEqual(snap.players.map((p) => p.id), [viewer.id]);
  const wakes = snap.effects.filter((e) => e.kind === EffectKind.SHIMMER);
  assert.equal(wakes.length, 1);
  // grid-snapped, so 25 snapshots a second still resolve to one cell
  assert.equal(wakes[0].x, 1104);
  assert.equal(wakes[0].y, 1008);
  // intensity is one of the three §6 steps, never a velocity
  assert.ok([0.35, 0.7, 1].some((i) => Math.abs(wakes[0].m - i) < 1e-6));
});

test("wake rings are throttled to the cadence, not the snapshot rate", () => {
  const { room, viewer, target } = makePerceptionPair();
  target.x = 1090; target.y = 1000;
  target.speed = 150;   // fastest step: one ring per 0.14s, i.e. per 3.5 ticks

  let rings = 0;
  for (let i = 0; i < 25; i++) {   // one second of ticks
    viewer.socket.sent.length = 0;
    room.broadcast();
    rings += lastSnapshot(viewer.socket).effects
      .filter((e) => e.kind === EffectKind.SHIMMER).length;
  }

  assert.ok(rings >= 6 && rings <= 8, `rings=${rings}`);
});

test("a glow-only smudge carries no name, no gait, and no exact light", () => {
  const { room, viewer, target } = makePerceptionPair();
  target.light = 900;              // irreducible glow 150, body radius 66
  target.x = 1140; target.y = 1000;  // past vision + body (126), inside the glow

  room.broadcast();
  const seen = lastSnapshot(viewer.socket).players.find((p) => p.id === target.id);

  assert.ok(seen, "the smudge is still perceived");
  assert.equal(seen.name, "");
  assert.equal(seen.speed, 0);
  // only the radius of the smudge is honest information, rounded to its step
  const glow = (Math.sqrt(seen.light) - 5) * 6;
  assert.ok(Math.abs(glow - 152) < 0.1, `glow=${glow}`);
  assert.ok(Math.abs(seen.light - 900) > 1, "exact light stayed server-side");
});

test("a lantern seen outright is reported in full", () => {
  const { room, viewer, target } = makePerceptionPair();
  target.light = 900;
  target.lit = true;               // its glow reaches 520 — simply seen
  target.x = 1140; target.y = 1000;
  target.speed = 40;

  room.broadcast();
  const seen = lastSnapshot(viewer.socket).players.find((p) => p.id === target.id);

  assert.equal(seen.name, "stalker");
  assert.equal(seen.light, 900);
  assert.equal(seen.speed, 40);
});

test("an unperceived body leaves nothing on the wire", () => {
  const { room, viewer, target } = makePerceptionPair();
  target.x = 1400; target.y = 1000;
  target.speed = 150;              // moving fast, but far past wake range

  room.broadcast();
  const snap = lastSnapshot(viewer.socket);

  assert.deepEqual(snap.players.map((p) => p.id), [viewer.id]);
  assert.equal(snap.effects.length, 0);
});

test("your own wake is still drawn for you, at your exact position", () => {
  const { room, viewer, target } = makePerceptionPair();
  target.x = 2000; target.y = 2000;   // out of the picture
  viewer.speed = 150;                 // sneaking: dark and moving

  room.broadcast();
  const wakes = lastSnapshot(viewer.socket).effects
    .filter((e) => e.kind === EffectKind.SHIMMER);

  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].x, viewer.x);
  assert.equal(wakes[0].y, viewer.y);
});

/* Live levers (§10). G is the anti-snowball dial, and §15 Q2 is answered by
   sweeping it during a sitting — so moving it has to keep the server's
   perception and the client's darkness in agreement. */
function tuningMessages(socket) {
  return socket.sent
    .map((buf) => fromBinary(ServerMessageSchema, buf))
    .filter((m) => m.msg.case === "tuning")
    .map((m) => m.msg.value);
}

test("a joining player is told the levers this arena is running", () => {
  const { socket } = makeRoomAndPlayer();
  const tunings = tuningMessages(socket);

  assert.equal(tunings.length, 1);
  assert.equal(tunings[0].glowG, 6);
});

test("moving G changes what a dark lantern cannot hide, and every client hears", () => {
  const { room, viewer, target } = makePerceptionPair();
  target.light = 900;              // irreducible glow 150 at G=6
  target.x = 1140; target.y = 1000;  // past vision + body (126): a smudge

  room.broadcast();
  assert.ok(lastSnapshot(viewer.socket).players.some((p) => p.id === target.id));

  // G=0 is one end of the Q2 sweep: leaders hide freely
  assert.equal(room.setGlowG(0), 0);
  viewer.socket.sent.length = 0;
  room.broadcast();

  assert.ok(!lastSnapshot(viewer.socket).players.some((p) => p.id === target.id),
    "at G=0 the smudge is gone from perception entirely");
  room.setGlowG(6);
});

test("the lever refuses values outside the sweep range", () => {
  const { room } = makePerceptionPair();

  assert.equal(room.setGlowG(-1), null);
  assert.equal(room.setGlowG(NaN), null);
  assert.equal(room.setGlowG(999), null);
  assert.equal(room.glowG(), 6, "a rejected value leaves the curve alone");
});

test("a mid-session lever move reaches players already connected", () => {
  const { room, viewer } = makePerceptionPair();
  viewer.socket.sent.length = 0;

  room.setGlowG(11);
  const tunings = tuningMessages(viewer.socket);

  assert.equal(tunings.length, 1);
  assert.equal(tunings[0].glowG, 11);
  room.setGlowG(6);
});

/* The board is trimmed on the server, so these cover the whole contract the
   client relies on: five rows, true ranks, and the caller's own row present
   however far down the ladder it has fallen. */
function makeLadder(count) {
  const room = new Room();
  room.close();
  // descending light, so the join order is also the finishing order
  return {
    room,
    players: Array.from({ length: count }, (_, i) => {
      const p = room.addPlayer(new FakeSocket(), `p${i + 1}`);
      p.light = 1000 - i * 10;
      return p;
    }),
  };
}

test("the leaderboard is five rows of true ranks, brightest first", () => {
  const { room, players } = makeLadder(8);
  const board = room.leaderboard();

  assert.equal(board.length, 5);
  assert.deepEqual(board.map((e) => e.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(board.map((e) => e.name), players.slice(0, 5).map((p) => p.name));
  assert.equal(board[0].light, 1000, "light is floored, not rounded or scaled");
});

test("a player below the cut takes the last row, keeping its real rank", () => {
  const { room, players } = makeLadder(11);
  const board = room.leaderboard(players[10].id);

  assert.equal(board.length, 5, "the board never grows a sixth row");
  assert.deepEqual(board.map((e) => e.rank), [1, 2, 3, 4, 11]);
  assert.equal(board[4].id, players[10].id);
  assert.equal(board[3].id, players[3].id, "rank 5 yields the row, rank 4 stays");
});

test("a player inside the top five is not doubled onto the board", () => {
  const { room, players } = makeLadder(11);
  const board = room.leaderboard(players[2].id);

  assert.deepEqual(board.map((e) => e.rank), [1, 2, 3, 4, 5]);
  assert.equal(board.filter((e) => e.id === players[2].id).length, 1);
});

test("the dead are off the ladder, and cannot claim a row by asking", () => {
  const { room, players } = makeLadder(7);
  players[0].dead = true;
  players[6].dead = true;

  const board = room.leaderboard(players[6].id);

  assert.equal(board.length, 5);
  assert.deepEqual(board.map((e) => e.rank), [1, 2, 3, 4, 5]);
  assert.ok(!board.some((e) => e.id === players[0].id || e.id === players[6].id));
  assert.equal(board[0].id, players[1].id, "the brightest survivor is rank 1");
});

test("players level on light hold a stable order between polls", () => {
  const { room, players } = makeLadder(6);
  for (const p of players) p.light = 100;

  const first = room.leaderboard().map((e) => e.id);
  // re-insert in a different iteration order: ties must not follow the map
  const moved = players[2];
  room.players.delete(moved.id);
  room.players.set(moved.id, moved);

  assert.deepEqual(room.leaderboard().map((e) => e.id), first);
});

test("an unknown id asks for nothing, and an empty arena has no board", () => {
  const { room, players } = makeLadder(6);

  assert.deepEqual(room.leaderboard(99999).map((e) => e.rank), [1, 2, 3, 4, 5],
    "a stale id leaves the top of the ladder untouched");

  for (const p of players) room.players.delete(p.id);
  assert.deepEqual(room.leaderboard(players[0].id), []);
});
