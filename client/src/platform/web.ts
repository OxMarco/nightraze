/* nightraze.io itself: the page is ours, there is no host to report to.

   Storage is plain localStorage, wrapped because it throws rather than returns
   in the cases that matter — private mode, storage disabled, quota exhausted,
   and a cross-site frame whose partition the browser refuses to open. A run
   that can't be remembered is still a run worth playing, so every failure here
   degrades to "we didn't remember that" and nothing else. */

import type {
  Platform,
  PlatformAccount,
  PlatformConstraints,
  PlatformSession,
  PlatformStorage,
} from "./types.js";

export const webStorage: PlatformStorage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // unwritable storage: the run still works, it just won't be kept
    }
  },
};

/* There is nobody here to sign in with. nightraze.io has no accounts of its
   own and is not about to grow some to satisfy an interface — the arena falls
   back to the name the player types, which is what it always did. */
const webAccount: PlatformAccount = {
  supported: () => false,
  current: () => null,
  signIn: () => Promise.resolve(null),
  onChange: () => () => {},
};

/* Session links are the one part of this that is real on our own domain rather
   than a stand-in for something a portal does. A link into the arena is just
   our own URL carrying the session in its query string, and a cold start that
   arrives with that query string is somebody following one. It costs nothing,
   it makes "invite a friend" work off-portal, and it means the game's own
   wiring is exercised on every dev run instead of only inside a frame we
   cannot open locally. */
function currentQuery(): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(location.search)) params[key] = value;
  return params;
}

const webSession: PlatformSession = {
  // No host is listening, so there is nothing to tell about where we are.
  enter: () => {},
  leave: () => {},

  link(params) {
    try {
      // Built from the path we are actually served at, not from the origin
      // alone: origin-only happens to be right while the game sits at "/", and
      // silently mints links to a page that does not exist the day it does not.
      // The query and hash are dropped on purpose — whatever brought *us* here
      // is not what we are sending someone else.
      const url = new URL(location.pathname || "/", location.origin);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url.toString();
    } catch {
      return null;
    }
  },

  launchParams() {
    const params = currentQuery();
    return Object.keys(params).length > 0 ? params : null;
  },

  // Nothing can ask us to join mid-run: the only way in is a fresh page load.
  onJoinRequest: () => () => {},

  // ?play=1 is the link's way of saying "straight in, skip the menu", which is
  // exactly what a portal's instant-multiplayer flag means.
  wantsInstantPlay: () => new URLSearchParams(location.search).get("play") === "1",
};

const UNCONSTRAINED: PlatformConstraints = { chatDisabled: false, audioMuted: false };

export const webPlatform: Platform = {
  name: "web",
  ready: () => Promise.resolve(),
  storage: webStorage,
  account: webAccount,
  session: webSession,
  constraints: () => UNCONSTRAINED,
  onConstraintsChange: () => () => {},
  loadingStart: () => {},
  loadingStop: () => {},
  gameplayStart: () => {},
  gameplayStop: () => {},
  happytime: () => {},
};
