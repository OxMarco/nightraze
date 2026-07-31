import { useEffect } from "react";
import { useControlScheme, useIsTouch } from "../game/controls.js";
import { useWorldStateThrottled } from "../game/hooks.js";
import {
  noteLight,
  skipTutorial,
  type TutorialState,
  type TutorialStep,
} from "../game/tutorial.js";
import "./tutorial.css";

/** The three beats, in the arena's voice. Control lines follow the same
    keys/touch split as the rest of the UI — one set of words per device — and
    the touch line follows the scheme the player actually picked, because a
    coach that names a control the player doesn't have is worse than none. */
const COPY: Record<
  TutorialStep,
  { title: string; body: string; keys: string; touch: string; pads: string }
> = {
  feed: {
    title: "eat to grow",
    body: "drift over the motes. each one is light — your score, your reach, and your life.",
    keys: "cursor steers",
    touch: "hold anywhere to swim there",
    pads: "stick, or hold the water · double-tap to sprint",
  },
  jump: {
    title: "jump to take",
    body: "light also lives in other lanterns. jump into one and contact drains it.",
    keys: "click jumps",
    touch: "tap to jump",
    pads: "the jump button lunges",
  },
  hide: {
    title: "go dark",
    body: "your glow is how far you are seen. hide the lantern to vanish — it takes a moment.",
    keys: "space hides",
    touch: "the lantern button hides",
    pads: "the small button hides",
  },
};

/**
 * The first-descent coach: one step at a time, retired by doing rather than by
 * dismissing. Deliberately pointer-transparent except for "skip" — the arena is
 * live underneath and a jump aimed through this card must land.
 */
export function Tutorial({ state, selfId }: { state: TutorialState; selfId: number }) {
  // Light is the only step signal the player doesn't hand us directly, so it is
  // read from the world at HUD cadence rather than per frame.
  const frame = useWorldStateThrottled(300);
  const light = frame?.players.find((p) => p.id === selfId)?.light;
  useEffect(() => {
    if (light !== undefined) noteLight(light);
  }, [light]);

  // same gate as the pads themselves — never name a control that isn't there.
  // Both hooks called unconditionally: see the note in App.tsx.
  const scheme = useControlScheme();
  const touch = useIsTouch();
  const padsOn = scheme === "pads" && touch;
  const copy = state.step ? COPY[state.step] : null;

  return (
    <div className={"coach" + (padsOn ? " withPads" : "")} role="status" aria-live="polite">
      <div className="coachPips" aria-hidden="true">
        {Array.from({ length: state.total }, (_, i) => (
          <span
            key={i}
            className={"coachPip" + (i < state.index ? " done" : i === state.index ? " now" : "")}
          />
        ))}
      </div>
      {copy ? (
        <>
          <div className="coachStep">
            step {state.index + 1} of {state.total}
          </div>
          <h2 className="coachTitle">{copy.title}</h2>
          <p className="coachBody">{copy.body}</p>
          <div className="coachKey">
            <span className="coachKeys">{copy.keys}</span>
            <span className="coachTouch">{padsOn ? copy.pads : copy.touch}</span>
          </div>
          <button type="button" className="coachSkip ui" onClick={skipTutorial}>
            skip
          </button>
        </>
      ) : (
        <>
          <h2 className="coachTitle">the dark is yours</h2>
          <p className="coachBody">
            hunt, or hide. the brightest lantern is always the easiest to find.
          </p>
        </>
      )}
    </div>
  );
}
