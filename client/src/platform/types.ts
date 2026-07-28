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

export interface Platform {
  /** Which host we're running under. For diagnostics; never branch on this. */
  readonly name: "web" | "crazygames";

  /** Resolves once `storage` and the event methods are usable. */
  ready(): Promise<void>;

  storage: PlatformStorage;

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
