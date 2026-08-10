/* The arrival rules, run rather than restated.

   This file is the reason the suite moved to a runner with a transform. The
   rule it checks — an invite link is a shortcut only for someone the arena can
   already name — lives in game/session.ts, which imports game/GameContext.tsx,
   which `node --test` cannot load. So the rule used to be *copied* into
   test/web-platform.test.mts as a local predicate, with a comment admitting the
   copy and hoping divergence would be caught. Here the real hook runs.

   What it takes to run it: a fake platform through setPlatform (the seam the
   app already uses to install a portal adapter), and a stub on
   GameClient.connect so "would have joined" is observable without opening a
   socket. The GameProvider is real — constructing a GameClient does not connect,
   so an unconnected client sits in exactly the "idle" state a page load has. */

import assert from "node:assert";
import { afterEach, beforeEach, test, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { GameProvider } from "../src/game/GameContext.js";
import { useAutoJoin } from "../src/game/session.js";
import { GameClient } from "../src/net/connection.js";
import { setPlatform } from "../src/platform/current.js";
import { webPlatform } from "../src/platform/web.js";
import type { Platform } from "../src/platform/types.js";

const config = { wsUrl: "ws://arena.test/play", apiUrl: "http://arena.test" };

/** A host that answers only the two questions the arrival rules ask. */
function hostWith(options: {
  launchParams?: Record<string, string> | null;
  instantPlay?: boolean;
}): Platform {
  return {
    ...webPlatform,
    session: {
      ...webPlatform.session,
      launchParams: () => options.launchParams ?? null,
      wantsInstantPlay: () => options.instantPlay === true,
    },
  };
}

let connect: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Stubbed rather than spied-through: the real one opens a WebSocket.
  connect = vi.spyOn(GameClient.prototype, "connect").mockImplementation(() => {});
  // /health is polled by useSessionPresence, not by this hook, but a stray
  // rejection would still surface as an unhandled error in the run.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setPlatform(webPlatform);
});

/** Mount the hook exactly as Screens does, with the name it would be given. */
function arrive(host: Platform, storedName: string): void {
  setPlatform(host);
  function Harness() {
    useAutoJoin(() => storedName);
    return null;
  }
  render(<GameProvider config={config}><Harness /></GameProvider>);
}

const INVITE = { arena: "nightraze-arena" };

test("a first-time invitee is left at the start screen to name themselves", () => {
  arrive(hostWith({ launchParams: INVITE }), "");
  // The whole point of carrying names across is that a friend recognises one on
  // the ladder. Skipping the screen for someone we cannot name spends the invite
  // on an anonymous "ember" — the outcome the shortcut was meant to avoid.
  assert.equal(connect.mock.calls.length, 0);
});

test("a returning invitee goes straight into the dark", () => {
  arrive(hostWith({ launchParams: INVITE }), "emberkeeper");
  assert.deepEqual(connect.mock.calls, [["emberkeeper"]]);
});

test("the host's instant-play flag joins even a browser with no name", () => {
  // An instruction, not an inference: a portal that asked for a match and got a
  // menu has been disobeyed.
  arrive(hostWith({ instantPlay: true }), "");
  assert.deepEqual(connect.mock.calls, [["ember"]]);
});

test("a marketing link is not an invite", () => {
  // The regression this guards: launchParams() is non-null for any query string,
  // so a "params exist?" test would drop every ?utm_source= visitor into the
  // arena with no idea what the three verbs are.
  arrive(hostWith({ launchParams: { utm_source: "twitter" } }), "emberkeeper");
  assert.equal(connect.mock.calls.length, 0);
});

test("a foreign arena id is not our invite", () => {
  arrive(hostWith({ launchParams: { arena: "someone-elses" } }), "emberkeeper");
  assert.equal(connect.mock.calls.length, 0);
});

test("an ordinary cold start waits at the start screen", () => {
  arrive(hostWith({}), "emberkeeper");
  assert.equal(connect.mock.calls.length, 0);
});

test("a mid-session join request is obeyed without second-guessing it", () => {
  // Unlike a link, this is the player pressing something a moment ago. Answering
  // a deliberate press with the screen they were already looking at would be the
  // wrong kind of caution, so it joins whatever the name situation is.
  const listeners: Array<(params: Record<string, string>) => void> = [];
  const host: Platform = {
    ...webPlatform,
    session: {
      ...webPlatform.session,
      launchParams: () => null,
      wantsInstantPlay: () => false,
      onJoinRequest: (listener) => {
        listeners.push(listener);
        return () => { listeners.length = 0; };
      },
    },
  };
  arrive(host, "");
  assert.equal(connect.mock.calls.length, 0, "nothing has happened yet");
  const [fire] = listeners;
  assert.ok(fire, "the hook must subscribe for as long as it is mounted");
  fire(INVITE);
  assert.deepEqual(connect.mock.calls, [["ember"]]);
});
