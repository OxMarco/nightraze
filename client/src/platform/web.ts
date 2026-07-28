/* nightraze.io itself: the page is ours, there is no host to report to.

   Storage is plain localStorage, wrapped because it throws rather than returns
   in the cases that matter — private mode, storage disabled, quota exhausted,
   and a cross-site frame whose partition the browser refuses to open. A run
   that can't be remembered is still a run worth playing, so every failure here
   degrades to "we didn't remember that" and nothing else. */

import type { Platform, PlatformStorage } from "./types.js";

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

export const webPlatform: Platform = {
  name: "web",
  ready: () => Promise.resolve(),
  storage: webStorage,
  loadingStart: () => {},
  loadingStop: () => {},
  gameplayStart: () => {},
  gameplayStop: () => {},
  happytime: () => {},
};
