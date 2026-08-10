/* @vitest-environment node */
/* Exercises client/src/platform/crazygames.ts against a stubbed SDK.

   The case worth the most here is the last one. CrazyGames can flip a game into
   a fail mode where every SDK method throws by design, and off their domains
   every method throws "SDK is disabled on this domain" — so the adapter's whole
   job is that a portal turning hostile costs us monetization and nothing else.
   That is a claim about behaviour under an SDK we cannot run locally, and it is
   exactly the sort of claim that is true when written and false a year later.
   Hence a fake SDK: not to test CrazyGames, but to test our guards. */

import assert from "node:assert";
import { test, beforeEach } from "vitest";

interface Call { method: string; args: unknown[] }

let calls: Call[] = [];
let mode: "ok" | "throwing" | "absent" = "ok";
let settings: Record<string, boolean> = {};
let user: { username: string; profilePictureUrl?: string } | null = null;
let joinListeners: ((p: Record<string, string>) => void)[] = [];

/** Every SDK member routes through here so fail mode is one switch. */
function guard<T>(method: string, value: () => T) {
  return (...args: unknown[]): T => {
    calls.push({ method, args });
    if (mode === "throwing") throw new Error("SDK is disabled on this domain");
    return value();
  };
}

function installSdk(): void {
  const game = {
    loadingStart: guard("loadingStart", () => undefined),
    loadingStop: guard("loadingStop", () => undefined),
    gameplayStart: guard("gameplayStart", () => undefined),
    gameplayStop: guard("gameplayStop", () => undefined),
    happytime: guard("happytime", () => undefined),
    updateRoom: guard("updateRoom", () => undefined),
    leftRoom: guard("leftRoom", () => undefined),
    inviteLink: guard("inviteLink", () => "https://crazygames.com/g/nightraze?p=1"),
    showInviteButton: guard("showInviteButton", () => "https://crazygames.com/g/nightraze?p=1"),
    hideInviteButton: guard("hideInviteButton", () => undefined),
    addJoinRoomListener: (l: (p: Record<string, string>) => void) => {
      calls.push({ method: "addJoinRoomListener", args: [] });
      if (mode === "throwing") throw new Error("disabled");
      joinListeners.push(l);
    },
    removeJoinRoomListener: (l: (p: Record<string, string>) => void) => {
      calls.push({ method: "removeJoinRoomListener", args: [] });
      if (mode === "throwing") throw new Error("disabled");
      joinListeners = joinListeners.filter((x) => x !== l);
    },
    addSettingsChangeListener: guard("addSettingsChangeListener", () => undefined),
    removeSettingsChangeListener: guard("removeSettingsChangeListener", () => undefined),
  };
  // Getters, because that is how the SDK exposes these and a getter that throws
  // is precisely the hazard the adapter's read() helper exists for.
  Object.defineProperty(game, "inviteParams", {
    get: guard("inviteParams", () => ({ arena: "nightraze-arena" })),
  });
  Object.defineProperty(game, "isInstantMultiplayer", {
    get: guard("isInstantMultiplayer", () => false),
  });
  Object.defineProperty(game, "settings", { get: guard("settings", () => settings) });

  const userModule = {
    getUser: async () => {
      calls.push({ method: "getUser", args: [] });
      if (mode === "throwing") throw new Error("disabled");
      return user;
    },
    showAuthPrompt: async () => {
      calls.push({ method: "showAuthPrompt", args: [] });
      if (mode === "throwing") throw new Error("userCancelled");
      user = { username: "lanternfriend" };
      return user;
    },
    addAuthListener: guard("addAuthListener", () => undefined),
    removeAuthListener: guard("removeAuthListener", () => undefined),
  };
  Object.defineProperty(userModule, "isUserAccountAvailable", {
    get: guard("isUserAccountAvailable", () => true),
  });

  (globalThis as any).window = {
    CrazyGames: {
      SDK: {
        init: async () => {
          calls.push({ method: "init", args: [] });
          if (mode === "throwing") throw new Error("init failed");
        },
        get environment() { return "crazygames"; },
        data: {
          getItem: guard("data.getItem", () => "stored"),
          setItem: guard("data.setItem", () => undefined),
        },
        game,
        user: userModule,
      },
    },
  };
}

installSdk();
(globalThis as any).localStorage = {
  _v: new Map<string, string>(),
  getItem(k: string) { return this._v.get(k) ?? null; },
  setItem(k: string, v: string) { this._v.set(k, v); },
};
(globalThis as any).location = { origin: "https://nightraze.io", search: "" };

const { crazyGamesPlatform } = await import("../src/platform/crazygames.ts");

const called = (method: string) => calls.filter((c) => c.method === method);

beforeEach(() => {
  calls = [];
  mode = "ok";
  settings = {};
  joinListeners = [];
});

test("ready() resolves the signed-in player before the first render", async () => {
  user = { username: "emberkeeper", profilePictureUrl: "https://img/x.png" };
  await crazyGamesPlatform.ready();
  assert.deepEqual(crazyGamesPlatform.account.current(), {
    name: "emberkeeper",
    avatarUrl: "https://img/x.png",
  });
});

test("entering the arena tells the portal the room and its joinability", () => {
  crazyGamesPlatform.session.enter({
    id: "nightraze-arena",
    joinable: false,
    params: { arena: "nightraze-arena" },
  });
  const [call] = called("updateRoom");
  assert.ok(call, "entering must reach the portal at all");
  assert.deepEqual(call.args[0], {
    roomId: "nightraze-arena",
    isJoinable: false,
    inviteParams: { arena: "nightraze-arena" },
  });
  // A full arena must not be advertised on the portal's own invite button
  // either — same claim, second surface.
  assert.equal(called("showInviteButton").length, 0);
  assert.equal(called("hideInviteButton").length, 1);
});

test("a joinable arena raises the portal's invite button with the same params", () => {
  crazyGamesPlatform.session.enter({
    id: "nightraze-arena",
    joinable: true,
    params: { arena: "nightraze-arena" },
  });
  const [call] = called("showInviteButton");
  assert.ok(call, "a joinable session must offer the portal's own button");
  assert.deepEqual(call.args[0], { arena: "nightraze-arena" });
  assert.equal(called("hideInviteButton").length, 0);
});

test("leaving retracts it", () => {
  crazyGamesPlatform.session.leave();
  assert.equal(called("leftRoom").length, 1);
  assert.equal(called("hideInviteButton").length, 1);
});

test("a join request reaches the game, and unsubscribing detaches it", () => {
  const seen: Record<string, string>[] = [];
  const off = crazyGamesPlatform.session.onJoinRequest((p) => seen.push(p));
  const [attached] = joinListeners;
  assert.ok(attached, "subscribing must attach exactly one listener");
  assert.equal(joinListeners.length, 1);
  attached({ arena: "nightraze-arena" });
  assert.deepEqual(seen, [{ arena: "nightraze-arena" }]);
  off();
  assert.equal(joinListeners.length, 0);
});

/* Named for what it checks and no more. Nothing in the game reads constraints()
   yet — there is no audio and no chat to suppress — so this pins the adapter's
   translation of the host's settings, not any obedience to them. The day sound
   ships, the test that asserts it goes quiet belongs next to the sound. */
test("host settings are translated into constraints", () => {
  settings = { disableChat: true, muteAudio: true };
  assert.deepEqual(crazyGamesPlatform.constraints(), {
    chatDisabled: true,
    audioMuted: true,
  });
  settings = {};
  assert.deepEqual(crazyGamesPlatform.constraints(), {
    chatDisabled: false,
    audioMuted: false,
  });
});

test("storage prefers the portal's, so a name survives a regional domain", () => {
  assert.equal(crazyGamesPlatform.storage.get("nightraze.name"), "stored");
  assert.equal(called("data.getItem").length, 1);
});

/* ---- the one that matters: the portal turning hostile ---- */

test("in fail mode every call is survivable and the arena still opens", async () => {
  mode = "throwing";

  // None of these may throw: they sit on the hot path of starting a run.
  await assert.doesNotReject(() => crazyGamesPlatform.ready());
  assert.doesNotThrow(() => crazyGamesPlatform.loadingStart());
  assert.doesNotThrow(() => crazyGamesPlatform.loadingStop());
  assert.doesNotThrow(() => crazyGamesPlatform.gameplayStart());
  assert.doesNotThrow(() => crazyGamesPlatform.gameplayStop());
  assert.doesNotThrow(() => crazyGamesPlatform.happytime());
  assert.doesNotThrow(() =>
    crazyGamesPlatform.session.enter({ id: "a", joinable: true }),
  );
  assert.doesNotThrow(() => crazyGamesPlatform.session.leave());

  // Reads degrade to "the host offers nothing", never to a crash.
  assert.equal(crazyGamesPlatform.session.link({ arena: "x" }), null);
  assert.equal(crazyGamesPlatform.session.launchParams(), null);
  assert.equal(crazyGamesPlatform.session.wantsInstantPlay(), false);
  assert.equal(crazyGamesPlatform.account.supported(), false);
  assert.deepEqual(crazyGamesPlatform.constraints(), {
    chatDisabled: false,
    audioMuted: false,
  });

  // Subscribing fails closed, and the unsubscribe it hands back is still safe
  // to call — a React cleanup must never throw on unmount.
  const off = crazyGamesPlatform.session.onJoinRequest(() => {});
  assert.doesNotThrow(off);
  const offAuth = crazyGamesPlatform.account.onChange(() => {});
  assert.doesNotThrow(offAuth);

  // A declined or broken sign-in resolves rather than rejecting.
  await assert.doesNotReject(() => crazyGamesPlatform.account.signIn());

  // Storage falls through to the browser's own rather than losing the value.
  assert.doesNotThrow(() => crazyGamesPlatform.storage.set("k", "v"));
  assert.equal(crazyGamesPlatform.storage.get("k"), "v");
});

test("a missing SDK script is the same as a silent one", async () => {
  const saved = (globalThis as any).window;
  (globalThis as any).window = {};
  try {
    await assert.doesNotReject(() => crazyGamesPlatform.ready());
    assert.doesNotThrow(() => crazyGamesPlatform.gameplayStart());
    assert.doesNotThrow(() => crazyGamesPlatform.session.leave());
    assert.equal(crazyGamesPlatform.session.link({ arena: "x" }), null);
    assert.equal(crazyGamesPlatform.session.launchParams(), null);
    // current() is deliberately not asserted null here. The identity cache is
    // module-level and only ever written by a ready() that found an SDK, so on
    // a real cold start with no script it is null — but in this file an earlier
    // test already signed someone in, and a vanishing script is not a reason to
    // forget who is playing. Asserting null would be testing the test order.
    assert.doesNotThrow(() => crazyGamesPlatform.account.current());
  } finally {
    (globalThis as any).window = saved;
  }
});
