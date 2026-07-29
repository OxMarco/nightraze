import { useCallback, useRef, useState } from "react";
import { useGameClient, useWorldStateThrottled } from "../game/hooks.js";
import { noteDash, noteToggle } from "../game/tutorial.js";
import { REF } from "../render/core.js";
import "./pads.css";

/* The opt-in two-thumb scheme (§9): a stick on the left, lunge and shutter on
   the right. Two buttons rather than one overloaded button, on purpose — the
   two verbs have opposite timing profiles, and any short/long or multi-press
   scheme makes a touch-down ambiguous until its timer expires. The lunge is the
   fastest verb in the game and the ambush strike; it cannot wait behind a
   disambiguation window. §9 already rejected both directions of that trade
   (double-tap-to-lunge "adds latency to the fastest verb"; hold-to-douse
   "imposed release-latency in the unified-button variant"), so the buttons are
   separated in space instead of in time — which also means neither has to be
   explained, the failure that cost vent-light its place (§8). */

/** Fraction of the knob's travel below which the thumb is resting, not
    steering. Standing still is a stealth state (§6) — a stick that crept would
    quietly delete it. Proportional so it survives the pad changing size. */
const DEADZONE_FRAC = 0.16;

export function TouchPads({ selfId }: { selfId: number }) {
  const client = useGameClient();
  // The stick's heading, remembered so the lunge button has something to aim
  // along when the thumb is off the stick. Screen-space, like every other
  // vector the client sends.
  const headingRef = useRef({ x: 0, y: -1 });

  const steer = useCallback(
    (tx: number, ty: number) => {
      if (tx !== 0 || ty !== 0) headingRef.current = { x: tx, y: ty };
      client.sendDirection(tx, ty);
    },
    [client],
  );

  const lunge = useCallback(() => {
    const { x, y } = headingRef.current;
    client.sendDash(x, y);
    noteDash();
  }, [client]);

  const shutter = useCallback(() => {
    client.sendToggle();
    noteToggle();
  }, [client]);

  return (
    <>
      <Stick onSteer={steer} />
      <ActionButtons selfId={selfId} onLunge={lunge} onShutter={shutter} />
    </>
  );
}

// ---------------------------------------------------------------- stick
function Stick({ onSteer }: { onSteer: (tx: number, ty: number) => void }) {
  const baseRef = useRef<HTMLDivElement | null>(null);
  const knobRef = useRef<HTMLSpanElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  const release = (ev: React.PointerEvent) => {
    if (pointerIdRef.current !== ev.pointerId) return;
    pointerIdRef.current = null;
    setKnob({ x: 0, y: 0 });
    onSteer(0, 0);
  };

  const track = (ev: React.PointerEvent) => {
    const base = baseRef.current;
    const knobEl = knobRef.current;
    if (!base || !knobEl) return;
    const r = base.getBoundingClientRect();
    // Travel is measured, never hard-coded: the pad shrinks at small
    // breakpoints, and a fixed radius would strand the knob short of the ring
    // on one size and push it outside on another.
    const travel = Math.max(1, (r.width - knobEl.getBoundingClientRect().width) / 2);
    let dx = ev.clientX - (r.left + r.width / 2);
    let dy = ev.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > travel) {
      dx = (dx / len) * travel;
      dy = (dy / len) * travel;
    }
    setKnob({ x: dx, y: dy });
    if (Math.hypot(dx, dy) < travel * DEADZONE_FRAC) onSteer(0, 0);
    // full deflection maps to the server's throttle ceiling; anything shorter
    // is a proportional throttle, so creeping quietly is still possible
    else onSteer((dx / travel) * 40, (dy / travel) * 40);
  };

  return (
    <div
      ref={baseRef}
      className="padStick ui"
      // one pointer owns the stick; a second thumb landing on it is ignored
      // rather than fighting the first for the knob
      onPointerDown={(ev) => {
        if (pointerIdRef.current !== null) return;
        pointerIdRef.current = ev.pointerId;
        ev.currentTarget.setPointerCapture(ev.pointerId);
        track(ev);
      }}
      onPointerMove={(ev) => {
        if (pointerIdRef.current !== ev.pointerId) return;
        track(ev);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      aria-hidden="true"
    >
      <span
        ref={knobRef}
        className="padKnob"
        style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- icons
/* Feather icons — MIT licensed, © Cole Bemis, feathericons.com.
   Inlined rather than taken as a dependency:
   the package ships ~280 glyphs plus a DOM-replace runtime and this scheme
   needs two. Feather's own attributes are kept verbatim — 24px grid, no fill,
   currentColor stroke, width 2, round caps and joins — so these are the icons
   rather than lookalikes, and the button still owns hue and opacity for every
   state. Feather has no lantern or bulb in the set; sun/moon is its on/off pair
   for light, and reads correctly on a control that opens and closes one. */
const FEATHER = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

/** Feather `chevrons-up` — the flare lunge: a burst forward, not a stance. */
function LungeIcon() {
  return (
    <svg {...FEATHER}>
      <polyline points="17 11 12 6 7 11" />
      <polyline points="17 18 12 13 7 18" />
    </svg>
  );
}

/** Feather `sun` while the lantern burns, `moon` once it is shuttered — so the
    button reports the stance it is about to change. */
function LanternIcon({ lit }: { lit: boolean }) {
  if (!lit) {
    return (
      <svg {...FEATHER}>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );
  }
  return (
    <svg {...FEATHER}>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

// ---------------------------------------------------------------- buttons
function ActionButtons({
  selfId,
  onLunge,
  onShutter,
}: {
  selfId: number;
  onLunge: () => void;
  onShutter: () => void;
}) {
  // The lunge costs light whether or not it connects (§7), so the button says
  // when it would be spent for nothing; the lantern says which way it is about
  // to swing. Sampled, not per-frame: these are classes, not animations.
  const frame = useWorldStateThrottled(120);
  const self = frame?.players.find((p) => p.id === selfId);
  const spent = self ? self.dashCd > 0 || self.light < REF.gutter : false;
  const lit = self ? self.lit : true;

  return (
    <>
      <button
        type="button"
        className={"padBtn padLunge ui" + (spent ? " spent" : "")}
        aria-label="Lunge"
        title="Lunge"
        // fires on touch-down, with no disambiguation window in front of it —
        // that is the entire argument for two buttons
        onPointerDown={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          onLunge();
        }}
      >
        <LungeIcon />
      </button>
      <button
        type="button"
        className={"padBtn padShutter ui" + (lit ? "" : " off")}
        aria-label={lit ? "Shutter lantern" : "Relight lantern"}
        title={lit ? "Shutter" : "Relight"}
        // a stance change, not a reflex: click semantics are fine here, and
        // keep the button reachable by assistive tech
        onClick={(ev) => {
          ev.stopPropagation();
          onShutter();
        }}
      >
        <LanternIcon lit={lit} />
      </button>
    </>
  );
}
