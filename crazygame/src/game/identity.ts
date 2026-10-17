/* Who the arena calls the player.

   nightraze has always let you type a name, and off-portal it still does. On a
   host that has its own accounts the typed name is the wrong answer, and not
   for tidiness: the whole reason a portal asks for the username to be shown is
   that a player scanning a leaderboard should be able to spot their friend on
   it. A handle invented on our start screen is recognisable to nobody, so
   where the host knows a name, that name wins.

   The precedence is one line — host name, else typed name, else "ember" — and
   everything else here exists to keep it live: a player who signs in halfway
   through should not have to reload to be recognised. */

import { useEffect, useState } from "react";
import { platform } from "../platform/current.js";
import type { PlatformIdentity } from "../platform/types.js";

export interface Identity {
  /** The host's player, or null when there is no host account or no sign-in. */
  readonly player: PlatformIdentity | null;
  /** Whether offering a sign-in button makes any sense here. */
  readonly canSignIn: boolean;
  /** Show the host's sign-in prompt. Resolves whether or not it worked. */
  signIn: () => Promise<void>;
}

/**
 * The host's identity for this player, kept current.
 *
 * The initial value is read synchronously — the CrazyGames adapter resolves it
 * during ready(), which the embed entry awaits before rendering, so it is
 * already there on the first paint and a returning player never sees their own
 * name appear a beat late.
 */
export function useIdentity(): Identity {
  const [player, setPlayer] = useState<PlatformIdentity | null>(() =>
    platform().account.current(),
  );

  useEffect(() => platform().account.onChange(setPlayer), []);

  return {
    player,
    // Worth showing only when the host has accounts and nobody is in one yet.
    canSignIn: player === null && platform().account.supported(),
    signIn: async () => {
      setPlayer(await platform().account.signIn());
    },
  };
}
