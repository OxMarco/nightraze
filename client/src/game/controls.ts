/* Which touch scheme the player is on.

   The default is the pad scheme: a stick bottom-left, jump and hide above
   it. This answers §9's recorded watch item — drag-anywhere steering puts the
   player's thumb over the darkness they are squinting into, and a stick in the
   corner moves the thumb off the water.

   The one-finger scheme (drag anywhere to steer, tap to jump, corner button to
   hide) stays available as an opt-out, because "one-finger playable" is a
   platform claim in the GDD header and part of the portal pitch. Flipping
   either way is the player's choice and it sticks.

   Both schemes are touch schemes, and neither reaches a mouse-only desktop:
   useIsTouch() gates every render site, so a desktop steers with the cursor and
   hides with Space/L, and is never offered the switch.

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
    // pads are the default; one-finger is what you opt *out* to
    cached = platform().storage.get(KEY) === "one-finger" ? "one-finger" : "pads";
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
