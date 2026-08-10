import assert from "node:assert/strict";
import test from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Room, sanitizeName } from "../dist/game/room.js";
import { ClientMessageSchema } from "../dist/gen/nightraze/v1/game_pb.js";

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

function makeRoomAndPlayer(onCheat) {
  const room = new Room(onCheat);
  room.close();
  const socket = new FakeSocket();
  const player = room.addPlayer(socket, "test");
  return { room, socket, player };
}

function frame(msg) {
  return Buffer.from(toBinary(ClientMessageSchema, create(ClientMessageSchema, msg)));
}

test("sanitizeName strips control and zero-width characters", () => {
  assert.equal(sanitizeName("bad\u200bname"), "badname");
  assert.equal(sanitizeName("a\u202eb\nc"), "abc"); // \n is a control char: stripped
});

test("sanitizeName never yields an empty or overlong name", () => {
  assert.equal(sanitizeName(""), "ember");
  assert.equal(sanitizeName("\u200b\u200b   "), "ember");
  assert.equal(sanitizeName(null), "ember");
  // 20 is CFG.maxNameLen: wide enough for a portal username to arrive intact,
  // still short enough that a name cannot crowd the leaderboard.
  assert.ok(sanitizeName("x".repeat(50)).length <= 20);
  assert.equal(sanitizeName("x".repeat(50)).length, 20);
});

test("profane names fall back to the default", () => {
  assert.equal(sanitizeName("fuck"), "ember");
  assert.equal(sanitizeName("sh1thead"), "ember");   // l33t evasion
  assert.equal(sanitizeName("f u c k e r"), "ember"); // spacing evasion
  assert.equal(sanitizeName("FUCKface99"), "ember");  // case + embedding
});

test("innocent names survive the profanity filter", () => {
  assert.equal(sanitizeName("lantern"), "lantern");
  assert.equal(sanitizeName("NightRazer"), "NightRazer");
  assert.equal(sanitizeName("class act"), "class act"); // 'ass' inside a word is not a match
});

test("repeated malformed frames kick the player and report to onCheat", () => {
  const kicked = [];
  const { room, socket, player } = makeRoomAndPlayer((p, reason) => kicked.push([p.id, reason]));
  const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff]);

  for (let i = 0; i < 9; i++) room.handleMessage(player, garbage, true);
  assert.equal(socket.closed, null);

  room.handleMessage(player, garbage, true);
  assert.equal(socket.closed?.code, 1008);
  assert.deepEqual(kicked, [[player.id, "malformed frame"]]);
});

test("text frames count as strikes", () => {
  const kicked = [];
  const { room, socket, player } = makeRoomAndPlayer((p, reason) => kicked.push(reason));

  for (let i = 0; i < 10; i++) room.handleMessage(player, Buffer.from("hello"), false);
  assert.equal(socket.closed?.code, 1008);
  assert.deepEqual(kicked, ["text frame"]);
});

test("non-finite movement input counts as a strike but is not applied", () => {
  const { room, player } = makeRoomAndPlayer();

  room.handleMessage(player, frame({ msg: { case: "input", value: { tx: NaN, ty: 1 } } }), true);
  assert.equal(player.strikes, 1);
  assert.equal(player.dirX, 0);
  assert.equal(player.dirY, 0);
});

test("legitimate traffic never accumulates strikes", () => {
  const { room, socket, player } = makeRoomAndPlayer();

  for (let i = 0; i < 20; i++) {
    room.handleMessage(player, frame({ msg: { case: "input", value: { tx: 10, ty: 5 } } }), true);
  }
  room.handleMessage(player, frame({ msg: { case: "toggle", value: {} } }), true);
  room.handleMessage(player, frame({ msg: { case: "dash", value: { tx: 1, ty: 0 } } }), true);

  assert.equal(player.strikes, 0);
  assert.equal(socket.closed, null);
});

test("message flood kicks immediately and reports to onCheat", () => {
  const kicked = [];
  const { room, socket, player } = makeRoomAndPlayer((p, reason) => kicked.push(reason));
  const toggle = frame({ msg: { case: "toggle", value: {} } });

  for (let i = 0; i < 91; i++) room.handleMessage(player, toggle, true);
  assert.equal(socket.closed?.code, 1008);
  assert.deepEqual(kicked, ["message rate exceeded"]);
});

test("kicked players are ignored afterwards", () => {
  const { room, socket, player } = makeRoomAndPlayer();
  const garbage = Buffer.from([0xff]);

  for (let i = 0; i < 10; i++) room.handleMessage(player, garbage, true);
  assert.equal(socket.closed?.code, 1008);

  const before = player.strikes;
  room.handleMessage(player, frame({ msg: { case: "toggle", value: {} } }), true);
  assert.equal(player.strikes, before);
});
