/* The CrazyGames frame.

   Reached only from the /embed entry (embed.html), which is the document
   CrazyGames iframes; nightraze.io's own page never loads the SDK. The SDK
   script tag must already have run — it is a classic script in <head>, so it
   executes before the deferred module that imports this file.

   Two things about the SDK drive the shape of everything below.

   First, it decides where it is by postMessage: init() asks window, parent,
   parent.parent and parent.parent.parent whether a CrazyGames game frame is
   listening, and waits up to seven seconds for an answer. That is why it may
   only be awaited on the embed entry — on nightraze.io it would be seven
   seconds of nothing before the start screen appeared. It is also why hosting
   the game ourselves works at all: the SDK never looks at our hostname, so it
   reports the crazygames environment inside the frame even though the document
   came from nightraze.io.

   Second, it is allowed to fail loudly. Off a CrazyGames domain every method
   throws "SDK is disabled on this domain", and CrazyGames can additionally flip
   a game into a fail mode where every method throws by design. So each call is
   guarded individually and storage falls back to localStorage: a game that is
   merely unmonetized is fine, a game that is dead is not. */

import type { Platform, PlatformStorage } from "./types.js";
import { webStorage } from "./web.js";

interface CrazyGamesData {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface CrazyGamesGame {
  loadingStart(): void;
  loadingStop(): void;
  gameplayStart(): void;
  gameplayStop(): void;
  happytime(): void;
}

interface CrazyGamesSdk {
  init(): Promise<unknown>;
  readonly environment: string;
  readonly data: CrazyGamesData;
  readonly game: CrazyGamesGame;
}

declare global {
  interface Window {
    CrazyGames?: { SDK?: CrazyGamesSdk };
  }
}

function sdk(): CrazyGamesSdk | null {
  return window.CrazyGames?.SDK ?? null;
}

/** Run an SDK call, swallowing whatever it throws. */
function attempt(what: string, fn: (api: CrazyGamesSdk) => void): void {
  const api = sdk();
  if (!api) return;
  try {
    fn(api);
  } catch (err) {
    console.warn(`[platform] CrazyGames ${what} failed`, err);
  }
}

/* The data module is the reason storage goes through the platform at all.
   Inside a third-party frame the browser partitions our localStorage per
   embedding site — the same player returning through a different CrazyGames
   regional domain would arrive with no name and no personal best, and Safari
   may withhold it entirely. The data module is written against the frame's own
   storage and syncs to the player's CrazyGames account once they log in,
   including a one-time transfer of whatever they accumulated as a guest. */
const crazyGamesStorage: PlatformStorage = {
  get(key) {
    const api = sdk();
    if (api) {
      try {
        return api.data.getItem(key);
      } catch {
        // disabled environment or fail mode — fall through to the browser's own
      }
    }
    return webStorage.get(key);
  },
  set(key, value) {
    const api = sdk();
    if (api) {
      try {
        api.data.setItem(key, value);
        return;
      } catch {
        // as above: better remembered in one frame than nowhere
      }
    }
    webStorage.set(key, value);
  },
};

export const crazyGamesPlatform: Platform = {
  name: "crazygames",

  async ready() {
    const api = sdk();
    if (!api) {
      console.warn("[platform] CrazyGames SDK script did not load; running unhosted");
      return;
    }
    try {
      await api.init();
      console.info(`[platform] CrazyGames SDK ready, environment: ${api.environment}`);
    } catch (err) {
      // A rejected init leaves the SDK in a state where every method throws.
      // Every call site already tolerates that, so there is nothing to do but
      // say so and open the arena anyway.
      console.warn("[platform] CrazyGames SDK init failed", err);
    }
  },

  storage: crazyGamesStorage,

  loadingStart: () => attempt("loadingStart", (api) => api.game.loadingStart()),
  loadingStop: () => attempt("loadingStop", (api) => api.game.loadingStop()),
  gameplayStart: () => attempt("gameplayStart", (api) => api.game.gameplayStart()),
  gameplayStop: () => attempt("gameplayStop", (api) => api.game.gameplayStop()),
  happytime: () => attempt("happytime", (api) => api.game.happytime()),
};
