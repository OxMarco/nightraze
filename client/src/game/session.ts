/* The arena as something a friend can be invited into.

   Portals model multiplayer as rooms: a player is in one, it is joinable or it
   is not, and a link carries a friend into the same one. nightraze has no
   rooms — there is a single persistent arena and everyone who connects is in
   it. That mismatch is smaller than it looks. The arena *is* the room; it is
   joinable while it is below capacity; and a link into it is a link into the
   only session there is. Nothing here needs the server to grow lobbies.

   What that leaves is joinability, which is the one claim we can get wrong in
   a way the player feels. The arena bounces at capacity with close 1013 (the
   BounceScreen), so advertising a full arena as joinable spends a friend's
   click on a countdown. GET /health already reports the live player count, so
   we ask it — and when it cannot answer, we fall back to what our own socket
   has told us, which is the one thing we always know. */

import { useEffect, useRef, useState } from "react";
import { useGameContext } from "./GameContext.js";
import { useConnectionStatus, useGameActions } from "./hooks.js";
import { platform } from "../platform/current.js";

/* One arena, one id. It is a constant rather than a value from the server
   because the server has no concept to hand us — if shards ever arrive, this
   becomes whatever /health names and everything downstream is unchanged. */
export const ARENA_ID = "nightraze-arena";

/** The query key our own invite links carry. Portals build their own links and
    hand back their own params; this is only for nightraze.io's. */
const ARENA_PARAM = "arena";

/** How often to ask /health whether the arena still has room. Slower than the
    leaderboard poll: joinability changes on the scale of players leaving, not
    of frames. */
const CAPACITY_POLL_MS = 15_000;

interface Health {
  players?: number;
  /** Absent on servers that predate reporting it — see useJoinable. */
  maxPlayers?: number;
}

/**
 * Whether someone else could get into the arena right now.
 *
 * Two sources, in order of authority. Our own socket is first and is never
 * wrong: a 1013 close *is* the arena telling us it is full, and an open
 * connection means it had room a moment ago. /health fills the gap that leaves
 * — once we are in, our socket says nothing about whether the last place was
 * the one we took — but only when it reports a capacity to compare against. A
 * server that does not report one leaves us with the socket's answer, which is
 * optimistic and occasionally sends a friend to the bounce screen. That is the
 * right way round: the failure is a countdown, not a locked door.
 *
 * `active` gates the polling, and is not a nicety. The only consumer of this
 * answer is the presence announcement, which is silent unless we are in the
 * arena — so polling from the start screen bought a value nobody read, once
 * every fifteen seconds, from every browser that had the page open, including
 * the backgrounded tabs. The socket-side verdict below still applies whether
 * or not we are polling.
 */
export function useJoinable(active: boolean): boolean {
  const { config } = useGameContext();
  const status = useConnectionStatus();
  const [byHealth, setByHealth] = useState<boolean | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${config.apiUrl}/health`);
        // 503 is a server that is unwell or shutting down; either way it is not
        // taking friends. It is still a definite answer, unlike a dead fetch.
        if (!res.ok) {
          if (!cancelled) setByHealth(false);
          return;
        }
        const health = (await res.json()) as Health;
        if (cancelled) return;
        setByHealth(
          typeof health.players === "number" && typeof health.maxPlayers === "number"
            ? health.players < health.maxPlayers
            : null,
        );
      } catch {
        // Unreachable server: no claim either way, defer to the socket.
        if (!cancelled) setByHealth(null);
      }
    };

    void poll();
    const id = setInterval(poll, CAPACITY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [config.apiUrl, active]);

  // The socket's own verdict, when it has one.
  if (status.state === "closed" && status.full) return false;
  return byHealth ?? true;
}

/**
 * Keeps the host's idea of where the player is in step with the arena.
 *
 * The session begins at "connecting", not "open": pressing play is joining the
 * room, and the handshake in between is not a state a friends list needs to
 * distinguish — a portal told about the room only after the socket settles
 * misses exactly the sessions where joining was slow, which are the ones worth
 * following a friend into. "dead" stays in for the same flicker reason: a
 * corpse is still in the water with a respawn button, and "reconnecting" is a
 * dropped socket on its way back, not a departure. Everything else — the menu,
 * a final drop, the capacity bounce — is out.
 */
export function useSessionPresence(): void {
  const status = useConnectionStatus();
  const inArena =
    status.state === "connecting" ||
    status.state === "reconnecting" ||
    status.state === "open" ||
    status.state === "dead";
  const joinable = useJoinable(inArena);

  // Announcing and retracting are split because they answer to different
  // things. The announcement is re-sent whenever joinability moves, so a portal
  // stops offering a full arena without waiting for us to die; the retraction
  // must fire only on the way out, and folding it into the same effect would
  // have every capacity poll read as leaving and immediately rejoining.
  useEffect(() => {
    if (!inArena) return;
    platform().session.enter({
      id: ARENA_ID,
      joinable,
      params: { [ARENA_PARAM]: ARENA_ID },
    });
  }, [inArena, joinable]);

  useEffect(() => {
    if (!inArena) return;
    return () => platform().session.leave();
  }, [inArena]);
}

/**
 * Whether this page load is somebody following one of our invite links.
 *
 * The test is for our own arena parameter, not merely for the presence of
 * launch params, and the difference matters most off-portal: on nightraze.io
 * the launch params are the URL's query string, so "any params at all" would
 * make every ?utm_source= link in existence skip the start screen and drop a
 * first-time visitor straight into the dark with no idea what the three verbs
 * are. Every link we mint carries the arena (inviteLink below), on a portal and
 * off it, so requiring it costs nothing and keeps the shortcut to people who
 * were actually invited.
 */
function followedInviteLink(): boolean {
  return platform().session.launchParams()?.[ARENA_PARAM] === ARENA_ID;
}

/** The host telling us to put the player straight into a match. A direct
    instruction, so it needs no corroboration and overrides everything below. */
function hostWantsInstantPlay(): boolean {
  return platform().session.wantsInstantPlay();
}

/**
 * The two ways a player arrives without touching the start screen.
 *
 * A cold start carrying our arena parameter, or the host's instant-play flag,
 * is somebody who followed a friend's link — the menu is in their way. A join
 * request is the same arrival reaching a tab that is already open, which for a
 * single-arena game means either "you are already there" (nothing to do) or
 * "you are at the menu, go in".
 *
 * The two are not held to the same standard, deliberately. The link is an
 * inference about a page load and is second-guessed below; a join request is
 * the player pressing something a moment ago, and second-guessing that would
 * mean answering a deliberate press with a screen they were already looking at.
 *
 * `name` is read through a getter rather than passed by value so a join
 * request three minutes in still uses the name the player has by then.
 */
export function useAutoJoin(name: () => string): void {
  const status = useConnectionStatus();
  const { connect } = useGameActions();
  // The effects below must not re-run when the connection state moves; they
  // are one-shot arrivals, not a state machine. Refs keep them honest.
  //
  // Written after the commit, not during render: a render React discards would
  // otherwise leave these holding a status that never reached the screen. Both
  // readers run later than that — the mount effect after this one (effects fire
  // in declaration order) and the join listener long after — and useRef has
  // already seeded the first render's values, so nothing reads a stale one.
  const statusRef = useRef(status);
  const nameRef = useRef(name);
  const connectRef = useRef(connect);
  useEffect(() => {
    statusRef.current = status;
    nameRef.current = name;
    connectRef.current = connect;
  });

  const joinIfOutside = () => {
    const state = statusRef.current.state;
    // Already in the water, or on the way: an invite to the arena we are
    // standing in is not a reason to drop the run and reconnect.
    if (state === "open" || state === "dead" || state === "connecting") return;
    connectRef.current(nameRef.current() || "ember");
  };

  // Arrival by link, once, on mount.
  //
  // The name check is the whole subtlety. A link is followed most often by
  // someone who has never played — that is what inviting a friend means — and
  // for them there is no host account and nothing in storage, so skipping the
  // start screen would put an unnamed "ember" on the leaderboard their friend
  // is reading. That is the precise outcome carrying names across (identity.ts)
  // exists to prevent, arrived at by the shortcut meant to help. So the
  // shortcut applies to people we can already name: a signed-in portal player,
  // or a returning browser. Everyone else gets the start screen, which for them
  // is one tap and ten seconds of rules they had not read yet.
  //
  // The host's own instant-play flag is exempt. It is an instruction rather
  // than an inference, and a portal that asked for a match and got a menu has
  // been disobeyed.
  useEffect(() => {
    if (hostWantsInstantPlay() || (followedInviteLink() && nameRef.current())) {
      joinIfOutside();
    }
  }, []);

  // Arrival by the host asking, for as long as we are running.
  useEffect(() => platform().session.onJoinRequest(joinIfOutside), []);
}

/**
 * A link that brings a friend into the arena, or null where the host has none.
 *
 * Recomputed per call rather than cached: on a portal the SDK mints the link,
 * and it is entitled to mint a different one once the player signs in.
 */
export function inviteLink(): string | null {
  return platform().session.link({ [ARENA_PARAM]: ARENA_ID });
}
