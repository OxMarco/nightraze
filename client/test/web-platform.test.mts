/* @vitest-environment node */
/* Exercises the real client/src/platform/web.ts against stubbed browser
   globals. This is the layer the invite links and deep links are built on, and
   the layer the ?utm_source= auto-join bug lived in. */
import assert from "node:assert";
import { test } from "vitest";

// Must exist before the module under test touches them.
function at(url: string): void {
  const parsed = new URL(url);
  (globalThis as any).location = {
    origin: parsed.origin,
    pathname: parsed.pathname,
    search: parsed.search,
    href: parsed.href,
  };
}
at("https://nightraze.io/");
(globalThis as any).localStorage = {
  _v: new Map<string, string>(),
  getItem(k: string) { return this._v.get(k) ?? null; },
  setItem(k: string, v: string) { this._v.set(k, v); },
};

const { webPlatform } = await import("../src/platform/web.ts");
// Imported rather than restated — and imported the same deferred way as the
// module above, because the stubs at the top of this file must be in place
// before anything under src/ is evaluated. This used to be a local copy of
// session.ts's constants, alongside a local copy of its arrival rule, because
// the real module could not be loaded here at all. The rule is now tested by
// being run, in test/auto-join.test.tsx.
const { ARENA_ID } = await import("../src/game/session.js");

const ARENA_PARAM = "arena";

/* What this file is for, after that move: the host's own answers. Whether a
   given set of launch params should skip the start screen is session.ts's
   business; whether launchParams() reports them faithfully is this layer's. */

test("an invite link carries the arena and round-trips", () => {
  const link = webPlatform.session.link({ [ARENA_PARAM]: ARENA_ID });
  assert.ok(link, "web platform must be able to mint a link");
  assert.equal(link, "https://nightraze.io/?arena=nightraze-arena");

  // following it is what the friend's browser does
  at(link!);
  assert.deepEqual(webPlatform.session.launchParams(), { arena: ARENA_ID });
});

test("a link is built from the path we are served at, not the bare origin", () => {
  at("https://nightraze.io/play/?utm_source=twitter#frag");
  // The path survives, so a build that ever moves off "/" keeps inviting people
  // to a page that exists. What brought us here does not travel with it.
  assert.equal(
    webPlatform.session.link({ [ARENA_PARAM]: ARENA_ID }),
    "https://nightraze.io/play/?arena=nightraze-arena",
  );
});

test("every query parameter is reported, invite or not", () => {
  // A marketing link is launch params too. Reporting them faithfully is what
  // lets session.ts require *our* parameter rather than merely "any params",
  // which is the distinction the ?utm_source= bug turned on.
  at("https://nightraze.io/?utm_source=twitter&utm_campaign=launch");
  assert.deepEqual(webPlatform.session.launchParams(), {
    utm_source: "twitter",
    utm_campaign: "launch",
  });
});

test("a bare cold start has no launch params at all", () => {
  at("https://nightraze.io/");
  assert.equal(webPlatform.session.launchParams(), null);
});

test("?play=1 is the off-portal spelling of instant play", () => {
  at("https://nightraze.io/?play=1");
  assert.ok(webPlatform.session.wantsInstantPlay());
  at("https://nightraze.io/?play=0");
  assert.equal(webPlatform.session.wantsInstantPlay(), false);
  at("https://nightraze.io/");
  assert.equal(webPlatform.session.wantsInstantPlay(), false);
});

test("the web host has no account, and says so without throwing", async () => {
  assert.equal(webPlatform.account.supported(), false);
  assert.equal(webPlatform.account.current(), null);
  assert.equal(await webPlatform.account.signIn(), null);
  assert.equal(typeof webPlatform.account.onChange(() => {}), "function");
});

test("session presence off-portal is inert but callable", () => {
  // Nothing is listening, but the game calls these unconditionally.
  assert.doesNotThrow(() => webPlatform.session.enter({ id: ARENA_ID, joinable: true }));
  assert.doesNotThrow(() => webPlatform.session.leave());
  assert.equal(typeof webPlatform.session.onJoinRequest(() => {}), "function");
});

test("constraints off-portal forbid nothing", () => {
  assert.deepEqual(webPlatform.constraints(), { chatDisabled: false, audioMuted: false });
});
