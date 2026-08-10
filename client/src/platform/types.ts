/* What the surrounding page can do for us.

   nightraze runs in two places: on its own domain, where the page is ours and
   there is nobody to tell, and inside the CrazyGames frame, where a host is
   listening for a small set of lifecycle events and owns the storage the player
   keeps. The game itself should not know or care which — it reports what
   happened and asks for what it remembered, and the platform decides whether
   that goes to localStorage and nowhere, or to a portal that syncs it across
   the player's devices.

   Every method here must be safe to call at any time and must never throw.
   The CrazyGames SDK has a server-flippable fail mode in which every one of its
   methods throws by design; a lost telemetry event cannot be allowed to take
   the arena down with it. */

export interface PlatformStorage {
  /** The stored value, or null if there isn't one / storage is unavailable. */
  get(key: string): string | null;
  /** Store a value. Silently does nothing if storage is unavailable. */
  set(key: string, value: string): void;
}

/** The player as the surrounding page already knows them.

    A portal that has its own accounts knows who is playing before we ask a
    name, and the whole point of showing that name in the arena is that the
    player's friends recognise it — a self-typed handle recognises nobody. */
export interface PlatformIdentity {
  /** Display name. Treated as a proposal like any other: the server still
      sanitizes it, and the arena's own limits still apply. */
  readonly name: string;
  /** Absolute URL of an avatar, if the host has one. */
  readonly avatarUrl?: string;
}

/** The player's account with the host, where there is such a thing. */
export interface PlatformAccount {
  /** Whether this host has accounts at all. False on our own domain. */
  supported(): boolean;

  /** Who the host says is playing, or null when nobody is signed in.
      Synchronous and cheap: hosts that answer asynchronously must have
      resolved this during ready(), because the arena reads it while it
      renders the first frame. */
  current(): PlatformIdentity | null;

  /** Ask the host to sign the player in, showing whatever prompt it owns.
      Resolves null when the host has no accounts or the player declined —
      never rejects. */
  signIn(): Promise<PlatformIdentity | null>;

  /** Called when the signed-in player changes. Returns an unsubscribe. */
  onChange(listener: (identity: PlatformIdentity | null) => void): () => void;
}

/** Where the player is, in terms the host can show to their friends.

    "Session" rather than "room" deliberately: nightraze has one persistent
    arena rather than lobbies, and a host that thinks in rooms is served
    perfectly well by being told about the arena. If shards or private matches
    ever arrive, they become more session ids and nothing here changes. */
export interface PlatformSession {
  /** We are in a session, and `joinable` says whether anyone else can still
      get in — for us, whether the arena is below capacity. Safe to call
      repeatedly; hosts expect it whenever joinability changes. */
  enter(state: { id: string; joinable: boolean; params?: Record<string, string> }): void;

  /** We are out of the session: death to the menu, a drop, a closed tab. */
  leave(): void;

  /** A link that brings someone else into our session, or null if this host
      has no way to make one. The host decides what the link points at; we only
      say which session it should land in. */
  link(params: Record<string, string>): string | null;

  /** The params we were launched with, when we were launched by following one
      of those links. Null on an ordinary cold start. */
  launchParams(): Record<string, string> | null;

  /** The host asking us, mid-session, to go and join somebody. Returns an
      unsubscribe. */
  onJoinRequest(listener: (params: Record<string, string>) => void): () => void;

  /** The host launched us specifically to put the player into a match, and the
      menu should be skipped. */
  wantsInstantPlay(): boolean;
}

/** Rules the host imposes that the game must obey, whatever it would prefer. */
export interface PlatformConstraints {
  /** Player-to-player text must not be shown or sent. */
  readonly chatDisabled: boolean;
  /** The game must make no sound. */
  readonly audioMuted: boolean;
}

export interface Platform {
  /** Which host we're running under. For diagnostics; never branch on this. */
  readonly name: "web" | "crazygames";

  /** Resolves once `storage` and the event methods are usable. */
  ready(): Promise<void>;

  storage: PlatformStorage;

  account: PlatformAccount;
  session: PlatformSession;

  /** What the host currently forbids. Read at the point of use, never cached:
      a host may change its mind mid-run. */
  constraints(): PlatformConstraints;

  /** Called when constraints change. Returns an unsubscribe. */
  onConstraintsChange(listener: (constraints: PlatformConstraints) => void): () => void;

  /** The game has started fetching what it needs to be playable. */
  loadingStart(): void;
  /** The player can now interact. */
  loadingStop(): void;

  /** The player is in the arena: first spawn, respawn, or resumed from a pause. */
  gameplayStart(): void;
  /** The player is out of the arena: death, disconnect, back to the menu. */
  gameplayStop(): void;

  /** A moment worth celebrating on the host page. Rare by contract. */
  happytime(): void;
}
