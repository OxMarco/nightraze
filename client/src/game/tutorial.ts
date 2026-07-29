/* The first descent, taught in three beats.
   Players who arrive cold can see a glowing blob and a dark screen and never
   discover that the three verbs (eat, lunge, shutter) are the whole game. This
   walks them through those verbs once, in order, and then never appears again.

   It teaches by watching the arena, not by gating it: nothing here blocks
   input, pauses the sim, or talks to the server. A step is retired when the
   player actually does the thing — eats their way past the starter ember,
   lunges, shutters — so the prompt is on screen for exactly as long as it is
   still unanswered. Sequential on purpose: an out-of-order action does not
   retire a step whose text has not been read yet.

   Nothing here is authority over anything; it is a hint that remembers whether
   it has already been given. */

import { useSyncExternalStore } from "react";
import { platform } from "../platform/current.js";
import { readBest } from "./best.js";

const KEY = "nightraze.taught";

/** Light at which "eat to grow" has visibly worked: the starter ember (12, see
    CFG.starterEmber in room.ts) plus a handful of motes at 1 light each. */
const FED_LIGHT = 17;

/** How long the closing beat lingers after the last step, in ms. */
const CLOSING_MS = 4500;

/** Personal best that grandfathers a player out of ever being taught. It has to
    sit well clear of the starter ember: a first run that ends in a quick snuff
    still records a best (12-ish), and that player is precisely the one who
    needs the next run to explain itself. Nobody reaches this without having
    eaten, hunted, and hidden already. */
const KNOWS_BEST = 40;

export type TutorialStep = "feed" | "lunge" | "shutter";

const ORDER: readonly TutorialStep[] = ["feed", "lunge", "shutter"];

export interface TutorialState {
  /** The step being taught, or null when there is nothing left to teach. */
  step: TutorialStep | null;
  /** Steps already retired — drives the progress pips. */
  index: number;
  total: number;
  /** The brief sign-off shown once the third step lands. */
  closing: boolean;
}

const IDLE: TutorialState = { step: null, index: 0, total: ORDER.length, closing: false };

let state: TutorialState = IDLE;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(next: TutorialState): void {
  state = next;
  for (const l of listeners) l();
}

export const subscribeTutorial = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getTutorialState = (): TutorialState => state;

/** The teaching state as React state. Changes at most three times a run. */
export function useTutorial(): TutorialState {
  return useSyncExternalStore(subscribeTutorial, getTutorialState, getTutorialState);
}

/** Whether this browser has been taught, or plainly does not need to be. */
function alreadyTaught(): boolean {
  return platform().storage.get(KEY) === "1" || readBest() >= KNOWS_BEST;
}

/** Start teaching, unless this player already knows. Safe to call on every
    arena entry: only the first one with an untaught browser does anything. */
export function beginTutorial(): void {
  if (state.step !== null || alreadyTaught()) return;
  set({ step: ORDER[0]!, index: 0, total: ORDER.length, closing: false });
}

function retire(celebrate: boolean): void {
  // Unwritable storage is not an error: the player still gets the lesson, it
  // just gets offered again next time.
  platform().storage.set(KEY, "1");
  if (closeTimer) clearTimeout(closeTimer);
  if (!celebrate) {
    set(IDLE);
    return;
  }
  set({ step: null, index: ORDER.length, total: ORDER.length, closing: true });
  closeTimer = setTimeout(() => {
    closeTimer = null;
    set(IDLE);
  }, CLOSING_MS);
}

/** Retire the step currently on screen; anything else is ignored. */
function advance(step: TutorialStep): void {
  if (state.step !== step) return;
  const index = state.index + 1;
  if (index >= ORDER.length) {
    retire(true);
    return;
  }
  set({ step: ORDER[index]!, index, total: ORDER.length, closing: false });
}

/** The player's current light, sampled from the world frame. */
export function noteLight(light: number): void {
  if (light >= FED_LIGHT) advance("feed");
}

/** The player lunged. */
export function noteDash(): void {
  advance("lunge");
}

/** The player worked the lantern shutter. */
export function noteToggle(): void {
  advance("shutter");
}

/** "i know how to play" — dismissed for good, with no sign-off. */
export function skipTutorial(): void {
  if (state.step === null) return;
  retire(false);
}
