/* The run's record.
   Death takes your position in the arena; it was never supposed to take the
   fact that you got there. The server already tracks the high-water mark of
   every run (`peak`, shipped on the Dead message) — this keeps the best of
   them across runs, so a leader who gets mobbed still has something that
   survives the snuff.

   Deliberately NOT a bank: this number is a record of what happened, not a
   reserve of light. It removes nothing from the arena economy (§3, where
   spilled wealth always returns to the field), and it cannot be protected by
   hiding — peak only ever rises by being lit, fat, and findable. It lives in
   whatever storage the platform gives us and is trivially editable, which is
   fine for a personal best and is exactly why it must never feed the live
   leaderboard: that board ranks current light because it is a hunt list. */

import { platform } from "../platform/current.js";

const KEY = "nightraze.best";

/** Best peak light the player has recorded, or 0 if there isn't one yet. */
export function readBest(): number {
  const raw = Number(platform().storage.get(KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export interface RunRecord {
  peak: number;
  best: number;
  isBest: boolean;
}

/** Record a finished run and report where it landed against the best so far. */
export function recordRun(peak: number): RunRecord {
  const floored = Math.max(0, Math.floor(peak));
  const previous = readBest();
  const isBest = floored > previous;
  // Unwritable storage is not an error here: the overlay still celebrates the
  // run, it just won't be there next time.
  if (isBest) platform().storage.set(KEY, String(floored));
  return { peak: floored, best: Math.max(previous, floored), isBest };
}
