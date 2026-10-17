/* Which host we're running under.

   Set once, by the entry point, before anything renders — never inferred at
   runtime. There is a temptation to sniff location.hostname or poke at
   window.parent to work out whether we're inside the CrazyGames frame, and it
   is the wrong instinct: our hostname is nightraze.io in both cases, and the
   only reliable answer is the postMessage handshake the SDK already performs.
   So the entry document decides. index.html is the open water and gets the web
   platform by default; embed.html loads the SDK and installs the other one. */

import type { Platform } from "./types.js";
import { webPlatform } from "./web.js";

let current: Platform = webPlatform;

export function setPlatform(next: Platform): void {
  current = next;
}

/** The active platform. Safe to call before setPlatform: defaults to web. */
export function platform(): Platform {
  return current;
}
