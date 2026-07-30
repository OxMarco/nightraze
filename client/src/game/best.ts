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

/* The host page is allowed to celebrate with us, but a record is broken while
   you are alive, not when you die — confetti over "the dark closed over you"
   reads as mockery. So the celebration fires the instant the live light first
   passes the stored best, and the death overlay only reports it. Still rare by
   construction: at most once per run, and never on the first run of a browser
   (nothing beaten, nothing to celebrate — otherwise every newcomer's spawn
   would throw confetti). */

let toBeat = 0; // 0 = nothing to beat this run, or already celebrated

/** Arm the celebration for a fresh run. Call when play actually starts. */
export function beginRun(): void {
  toBeat = readBest();
}

/** Report the live light; fires the host celebration on first passing the best. */
export function noteLight(light: number): void {
  if (toBeat <= 0 || light <= toBeat) return;
  toBeat = 0;
  platform().happytime();
}
