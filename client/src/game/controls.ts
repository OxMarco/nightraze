/* Which touch scheme the player is on.

   The default is the one-finger scheme the game was designed around (§9): drag
   anywhere to steer, tap to lunge, corner button to shutter. "one-finger
   playable" is a platform claim in the GDD header and part of the portal pitch,
   so the pad scheme is offered, never imposed — flipping this is the player's
   choice and it sticks.

   The pads exist to answer §9's recorded watch item: drag-anywhere steering
   puts the player's thumb over the darkness they are squinting into. A stick in
   the corner moves the thumb off the water.

   Convenience only — nothing here is authority over anything, and the server
   cannot tell the two schemes apart: both express the same steer/dash/toggle
   intents through the same wire. */

import { useEffect, useState, useSyncExternalStore } from "react";
import { platform } from "../platform/current.js";

const KEY = "nightraze.controls";

export type ControlScheme = "one-finger" | "pads";

// Read lazily rather than at module load: the platform's storage may not be
// usable until platform().ready() resolves, and nothing needs this before the
// first render.
let cached: ControlScheme | null = null;
const listeners = new Set<() => void>();

export function readScheme(): ControlScheme {
  if (cached === null) {
    cached = platform().storage.get(KEY) === "pads" ? "pads" : "one-finger";
  }
  return cached;
}

export function setScheme(next: ControlScheme): void {
  if (readScheme() === next) return;
  cached = next;
  platform().storage.set(KEY, next);
  for (const l of listeners) l();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The active scheme as React state. Changes only when the player picks. */
export function useControlScheme(): ControlScheme {
  return useSyncExternalStore(subscribe, readScheme, readScheme);
}

/** Whether this device can use a touch scheme at all — the switch is pointless
    on a machine that only has a mouse, so it is never offered there. */
export function hasTouch(): boolean {
  return navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches;
}

/**
 * Live touch capability.
 *
 * The stored preference alone must never put pads on screen: it follows a
 * browser profile across machines, and a mouse-only desktop that inherits
 * "pads" would get thumb controls it cannot use and did not ask for — the
 * switch isn't even offered there. Capability is the gate; the preference only
 * chooses between the schemes a device could actually run.
 *
 * Watched rather than read once, so device emulation and hybrid machines that
 * gain or lose a coarse pointer mid-session settle on the right answer.
 */
export function useIsTouch(): boolean {
  const [touch, setTouch] = useState(hasTouch);
  useEffect(() => {
    const mq = matchMedia("(pointer: coarse)");
    const sync = () => setTouch(hasTouch());
    mq.addEventListener("change", sync);
    sync();
    return () => mq.removeEventListener("change", sync);
  }, []);
  return touch;
}
