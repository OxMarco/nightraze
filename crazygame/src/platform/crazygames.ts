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

import type {
  Platform,
  PlatformAccount,
  PlatformConstraints,
  PlatformIdentity,
  PlatformSession,
  PlatformStorage,
} from "./types.js";
import { webStorage } from "./web.js";

interface CrazyGamesData {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface CrazyGamesSettings {
  readonly disableChat?: boolean;
  readonly muteAudio?: boolean;
}

interface CrazyGamesGame {
  loadingStart(): void;
  loadingStop(): void;
  gameplayStart(): void;
  gameplayStop(): void;
  happytime(): void;

  /* Multiplayer. updateRoom is how the portal learns there is something to
     join; leftRoom retracts it. inviteLink mints the URL the friend follows,
     inviteParams is what we were opened with when we are the friend, and the
     join listener is the same arrival happening to a tab that is already
     playing. */
  updateRoom(room: {
    roomId: string;
    isJoinable: boolean;
    inviteParams?: Record<string, string>;
  }): void;
  leftRoom(): void;
  inviteLink(params: Record<string, string>): string;
  showInviteButton(params: Record<string, string>): string;
  hideInviteButton(): void;
  readonly inviteParams: Record<string, string> | null;
  addJoinRoomListener(listener: (params: Record<string, string>) => void): void;
  removeJoinRoomListener(listener: (params: Record<string, string>) => void): void;
  readonly isInstantMultiplayer: boolean;

  readonly settings: CrazyGamesSettings;
  addSettingsChangeListener(listener: (settings: CrazyGamesSettings) => void): void;
  removeSettingsChangeListener(listener: (settings: CrazyGamesSettings) => void): void;
}

interface CrazyGamesUser {
  readonly username: string;
  readonly profilePictureUrl?: string;
}

interface CrazyGamesUserModule {
  readonly isUserAccountAvailable: boolean;
  getUser(): Promise<CrazyGamesUser | null>;
  showAuthPrompt(): Promise<CrazyGamesUser | null>;
  addAuthListener(listener: (user: CrazyGamesUser | null) => void): void;
  removeAuthListener(listener: (user: CrazyGamesUser | null) => void): void;
}

interface CrazyGamesSdk {
  init(): Promise<unknown>;
  readonly environment: string;
  readonly data: CrazyGamesData;
  readonly game: CrazyGamesGame;
  readonly user: CrazyGamesUserModule;
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

/** Read a value out of the SDK, falling back when it is absent or throwing.
    Every property below is a getter that can throw in fail mode, so none of
    them may be touched outside this. */
function read<T>(what: string, fn: (api: CrazyGamesSdk) => T, fallback: T): T {
  const api = sdk();
  if (!api) return fallback;
  try {
    const value = fn(api);
    return value === undefined || value === null ? fallback : value;
  } catch (err) {
    console.warn(`[platform] CrazyGames ${what} failed`, err);
    return fallback;
  }
}

/** Subscribe/unsubscribe pairs, guarded on both ends so a failed add never
    leaves a remove to throw at cleanup time. */
function subscribe<L>(
  what: string,
  add: (api: CrazyGamesSdk, listener: L) => void,
  remove: (api: CrazyGamesSdk, listener: L) => void,
  listener: L,
): () => void {
  let attached = false;
  attempt(`${what} subscribe`, (api) => {
    add(api, listener);
    attached = true;
  });
  return () => {
    if (!attached) return;
    attached = false;
    attempt(`${what} unsubscribe`, (api) => remove(api, listener));
  };
}

function toIdentity(user: CrazyGamesUser | null | undefined): PlatformIdentity | null {
  if (!user?.username) return null;
  return { name: user.username, avatarUrl: user.profilePictureUrl };
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

/* The signed-in player, resolved once during ready() and kept current by the
   SDK's auth listener.

   getUser() is a promise, and the arena reads the player's name synchronously
   while it renders its first frame — the same reason main-embed.tsx waits for
   ready() before it renders at all. So the await happens there, once, and
   every later read is of this. A player who signs in mid-session arrives
   through the listener rather than a second await. */
let identity: PlatformIdentity | null = null;

const crazyGamesAccount: PlatformAccount = {
  supported: () => read("isUserAccountAvailable", (api) => api.user.isUserAccountAvailable, false),

  current: () => identity,

  async signIn() {
    const api = sdk();
    if (!api) return null;
    try {
      const user = await api.user.showAuthPrompt();
      identity = toIdentity(user);
      return identity;
    } catch (err) {
      // userCancelled is the ordinary outcome of showing a login box, and
      // userAlreadySignedIn means we asked a question already answered.
      // Neither is a failure worth propagating into the arena.
      console.info("[platform] CrazyGames sign-in not completed", err);
      return identity;
    }
  },

  onChange(listener) {
    const wrapped = (user: CrazyGamesUser | null) => {
      identity = toIdentity(user);
      listener(identity);
    };
    return subscribe(
      "authListener",
      (api, l) => api.user.addAuthListener(l),
      (api, l) => api.user.removeAuthListener(l),
      wrapped,
    );
  },
};

/* Where the player is, told to the portal so their friends can follow.

   nightraze has one arena rather than lobbies, so the session id is constant
   and joinability is the only part that moves: the arena bounces at capacity
   (close 1013), and a portal that advertises a full arena as joinable sends
   friends into that bounce. game/session.ts owns working out which it is. */
const crazyGamesSession: PlatformSession = {
  enter: (state) => {
    attempt("updateRoom", (api) =>
      api.game.updateRoom({
        roomId: state.id,
        isJoinable: state.joinable,
        inviteParams: state.params,
      }),
    );
    // The portal's own invite button, in its chrome outside our frame — the
    // twin of the in-arena InviteButton, minting the same link. CrazyGames
    // deprecates it in favour of updateRoom above but still checks for it at
    // submission, and either way the contract is the same as updateRoom's:
    // it may only offer an arena a friend can actually get into.
    if (state.joinable) {
      attempt("showInviteButton", (api) => void api.game.showInviteButton(state.params ?? {}));
    } else {
      attempt("hideInviteButton", (api) => api.game.hideInviteButton());
    }
  },

  leave: () => {
    attempt("leftRoom", (api) => api.game.leftRoom());
    attempt("hideInviteButton", (api) => api.game.hideInviteButton());
  },

  link: (params) => read("inviteLink", (api) => api.game.inviteLink(params), null),

  launchParams: () => read("inviteParams", (api) => api.game.inviteParams, null),

  onJoinRequest: (listener) =>
    subscribe(
      "joinRoomListener",
      (api, l) => api.game.addJoinRoomListener(l),
      (api, l) => api.game.removeJoinRoomListener(l),
      listener,
    ),

  wantsInstantPlay: () => read("isInstantMultiplayer", (api) => api.game.isInstantMultiplayer, false),
};

const UNCONSTRAINED: PlatformConstraints = { chatDisabled: false, audioMuted: false };

function toConstraints(settings: CrazyGamesSettings | null): PlatformConstraints {
  if (!settings) return UNCONSTRAINED;
  return {
    chatDisabled: settings.disableChat === true,
    audioMuted: settings.muteAudio === true,
  };
}

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

    // Whoever the portal already has signed in, resolved before the first
    // render so the arena can put their name on the lantern (see `identity`).
    // A guest, a disabled environment and a rejected init are the same answer
    // here — nobody — and all three are fine.
    try {
      if (api.user.isUserAccountAvailable) {
        identity = toIdentity(await api.user.getUser());
      }
    } catch (err) {
      console.warn("[platform] CrazyGames getUser failed", err);
    }
  },

  storage: crazyGamesStorage,

  account: crazyGamesAccount,
  session: crazyGamesSession,

  constraints: () => toConstraints(read("settings", (api) => api.game.settings, null)),

  onConstraintsChange(listener) {
    const wrapped = (settings: CrazyGamesSettings) => listener(toConstraints(settings));
    return subscribe(
      "settingsChangeListener",
      (api, l) => api.game.addSettingsChangeListener(l),
      (api, l) => api.game.removeSettingsChangeListener(l),
      wrapped,
    );
  },

  loadingStart: () => attempt("loadingStart", (api) => api.game.loadingStart()),
  loadingStop: () => attempt("loadingStop", (api) => api.game.loadingStop()),
  gameplayStart: () => attempt("gameplayStart", (api) => api.game.gameplayStart()),
  gameplayStop: () => attempt("gameplayStop", (api) => api.game.gameplayStop()),
  happytime: () => attempt("happytime", (api) => api.game.happytime()),
};
