import { useCallback, useEffect, useRef } from "react";
// Cross-origin, unlike client/: this bundle is served from CrazyGames' CDN and
// the arena is somewhere else entirely, so the origin is baked in at build time
// rather than read off `location`. See config.ts.
import { config } from "./config.js";
import { GameProvider } from "./game/GameContext.js";
import {
  useConnectionStatus,
  useGameClient,
  useLeaderboard,
  useWorldFrames,
  useWorldStateThrottled,
} from "./game/hooks.js";
import { useControlScheme, useIsTouch } from "./game/controls.js";
import { useIdentity } from "./game/identity.js";
import { confirmName, isNamePending, readName } from "./game/prefs.js";
import { useAutoJoin, useSessionPresence } from "./game/session.js";
import { beginTutorial, noteDash, noteToggle, useTutorial } from "./game/tutorial.js";
import { platform } from "./platform/current.js";
import { SceneRenderer } from "./render/scene.js";
import { REF } from "./render/core.js";
import { InviteButton } from "./ui/invite.js";
import { BounceScreen, DeathOverlay, StartScreen } from "./ui/modals.js";
import { NameOverlay } from "./ui/nameOverlay.js";
import { TouchPads } from "./ui/pads.js";
import { Tutorial } from "./ui/tutorial.js";

/** Pad-mode double-tap recognition. Each constituent tap still has the tighter
    200ms / 12px tap test below; these only decide whether two valid taps form
    the optional sprint gesture. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_RADIUS = 36;

/** Distance from the lantern — which the camera pins to screen centre — at
    which a held thumb asks for full speed, as a fraction of the short side of
    the viewport. A quarter is about a hundred points on a phone: inside it the
    throttle is proportional, so a thumb resting near the body still creeps and
    standing still stays reachable (§6), and outside it every comfortable thumb
    position is full tilt rather than only the screen edges. The mouse keeps the
    raw 40px offset the server documents; a pointer that can sit anywhere on a
    desk doesn't need the span stretched to thumb reach. */
const TOUCH_FULL_THROTTLE_FRAC = 0.25;

/** Screen point -> steering command for a held thumb. The vector is measured
    from screen centre because that is where the camera keeps the player: point
    at the water you want and this is the direction to it. */
function touchSteer(clientX: number, clientY: number): { x: number; y: number } {
  const dx = clientX - innerWidth / 2;
  const dy = clientY - innerHeight / 2;
  const len = Math.hypot(dx, dy);
  if (len < 1) return { x: 0, y: 0 };
  const span = Math.min(innerWidth, innerHeight) * TOUCH_FULL_THROTTLE_FRAC;
  // 40 is the server's throttle ceiling: at or past `span` this saturates.
  const throttle = Math.min(1, len / span) * 40;
  return { x: (dx / len) * throttle, y: (dy / len) * throttle };
}

export default function App() {
  return (
    <GameProvider config={config}>
      <Screens />
    </GameProvider>
  );
}

/**
 * What the player sees, which on this build is the arena or a reason it isn't.
 *
 * There is no start screen in the ordinary path. The player chose this game on
 * the portal's page; asking them to choose it again is a menu answering a
 * question already answered, and CrazyGames caps a new user at one click before
 * gameplay in any case. So useAutoJoin joins on mount and the name question
 * follows the player into the water (ui/nameOverlay.tsx).
 *
 * That is also what makes the portal's instrumentation work at all.
 * gameplayStart and updateRoom both trigger on the connection leaving idle, so
 * behind a button they only fire for a QA pass that presses it — which is
 * precisely what was reported as "first gameplay start: failed" and "game
 * updates multiplayer room: not detected".
 *
 * StartScreen survives for one case: a connection that closed on its own. That
 * is a player who needs a way back in, and the screen already is one.
 */
function Screens() {
  const status = useConnectionStatus();
  useGameplayReporting(status.state);
  // What the host is told about the player: that they are in a joinable arena
  // (game/session.ts), and that the arena is where they should already be.
  useSessionPresence();
  useAutoJoin(useJoinName());
  if (status.state === "open" || status.state === "dead") return <Arena />;
  if (status.state === "closed" && status.full) return <BounceScreen />;
  // A dropped or refused connection: the start screen is the retry.
  if (status.state === "closed") return <StartScreen />;
  // idle and connecting are the handshake, which lasts a few hundred
  // milliseconds — flashing a menu through it would advertise a choice that is
  // already made and gone before it could be acted on.
  return <Descending />;
}

/** The handshake, which is short enough that this is mostly a held breath. */
function Descending() {
  return (
    <div className="descending" role="status" aria-live="polite">
      <span>descending…</span>
    </div>
  );
}

/**
 * The name to use for a run the player did not start from the start screen.
 *
 * Read at the moment of joining rather than at mount: a friend's invite may
 * land minutes after the page did, by which time the player may have signed in
 * (game/identity.ts). Storage is the fallback because an auto-join skips the
 * screen where a name would otherwise be typed — the last name this browser
 * played under is the best guess available, and the server defaults the rest.
 */
function useJoinName(): () => string {
  const { player } = useIdentity();
  return () => player?.name ?? readName();
}

/**
 * Tells the host page when the player is actually playing.
 *
 * Playing begins at "connecting" — the press of the play button — not at
 * "open". The distinction matters to the host more than to us: CrazyGames
 * takes the first gameplayStart as the end of the initial download, and a
 * start gated on our server handshake folds network time into a measurement
 * of bundle size — or, on a QA run where the socket never settles, reports a
 * game that no one ever played. "reconnecting" stays in for the same reason
 * it isn't a departure in useSessionPresence: a dropped socket on its way
 * back is not the player taking a break. A corpse is, so "dead" is out and
 * respawn comes for free — "once more" reopens the connection, which is a
 * fresh start as far as the host is concerned. Collapsed to a boolean so
 * connecting → open doesn't re-announce a run that never stopped.
 */
function useGameplayReporting(state: string): void {
  const playing = state === "connecting" || state === "reconnecting" || state === "open";
  useEffect(() => {
    if (!playing) return;
    platform().gameplayStart();
    return () => platform().gameplayStop();
  }, [playing]);
}

// ---------------------------------------------------------------- arena
function Arena() {
  const status = useConnectionStatus();
  const client = useGameClient();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const pointerRef = useRef({ x: innerWidth / 2, y: innerHeight / 2 });
  const touchRef = useRef<{
    pointerId: number;
    t: number;
    x: number;
    y: number;
    moved: number;
  } | null>(null);
  const padHeadingRef = useRef({ x: 0, y: -1 });
  const stickActiveRef = useRef(false);
  const lastArenaTapRef = useRef<{ t: number; x: number; y: number } | null>(null);

  const selfId = status.state === "open" || status.state === "dead" ? status.playerId : 0;
  const worldSize = status.state === "open" || status.state === "dead" ? status.worldSize : 2600;

  // Capability gates the scheme: thumb pads are for thumbs, and a mouse-only
  // desktop steers with the cursor and hides with Space/L — it has no use
  // for a stick it would have to drag. Both hooks are called unconditionally;
  // `&&` between the calls would short-circuit useIsTouch away and change the
  // hook count the moment the scheme flips.
  const scheme = useControlScheme();
  const touch = useIsTouch();
  const padsOn = scheme === "pads" && touch;

  // the three verbs, taught once per browser (game/tutorial.ts)
  const tutorial = useTutorial();
  useEffect(beginTutorial, []);
  const teaching =
    status.state === "open" && (tutorial.step !== null || tutorial.closing);

  const setStickActive = useCallback((active: boolean) => {
    stickActiveRef.current = active;
    if (active) lastArenaTapRef.current = null;
  }, []);

  // renderer lifecycle
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new SceneRenderer(canvas, worldSize);
    rendererRef.current = renderer;
    const onResize = () => renderer.resize();
    window.addEventListener("resize", onResize);
    // dragging the window to a monitor with a different devicePixelRatio does
    // not reliably fire resize — watch the resolution media query instead
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => {
      renderer.resize();
      watchDpr();
    };
    const watchDpr = () => {
      dprQuery?.removeEventListener("change", onDprChange);
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", onDprChange);
    };
    watchDpr();
    return () => {
      window.removeEventListener("resize", onResize);
      dprQuery?.removeEventListener("change", onDprChange);
      rendererRef.current = null;
    };
  }, [worldSize]);

  // render loop: drain server effects, draw the interpolated frame
  useWorldFrames((frame) => {
    const self = frame.players.find((p) => p.id === selfId);
    // our own player state is the only report of what the arena calls us —
    // the server may have sanitized the name we asked for (prefs.ts)
    if (isNamePending()) {
      confirmName(self?.name);
    }

    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.ingest(client.buffer.drainEffects());
    renderer.draw(frame, {
      selfId,
      pointerX: pointerRef.current.x,
      pointerY: pointerRef.current.y,
    });
  });

  const dash = useCallback(
    (sx: number, sy: number) => {
      client.sendDash(sx - innerWidth / 2, sy - innerHeight / 2);
      noteDash();
    },
    [client],
  );

  // input: pointer steers, desktop click / one-finger tap jumps, keys toggle
  // the lantern. Under the pad scheme, a short water tap sets a destination
  // and a double-tap sprints toward it; jump remains on its dedicated button
  // and uses the current travel heading.
  useEffect(() => {
    const steer = (ev: PointerEvent) => {
      if (ev.pointerType === "mouse") {
        client.sendDirection(ev.clientX - innerWidth / 2, ev.clientY - innerHeight / 2);
        return;
      }
      // The stick always wins. While a thumb holds it, a second thumb on the
      // water is a spectator rather than a second steering input — two live
      // sources would fight over one direction every frame.
      if (stickActiveRef.current) return;
      const { x, y } = touchSteer(ev.clientX, ev.clientY);
      // remembered so the pad's jump button has the current travel heading to
      // lunge along when the steering thumb is elsewhere
      if (x !== 0 || y !== 0) padHeadingRef.current = { x, y };
      client.sendDirection(x, y);
    };
    const onMove = (ev: PointerEvent) => {
      const t0 = touchRef.current;
      if (
        ev.pointerType !== "mouse" &&
        (!t0 || t0.pointerId !== ev.pointerId)
      ) return;
      pointerRef.current = { x: ev.clientX, y: ev.clientY };
      if (t0 && ev.pointerType !== "mouse") {
        t0.moved = Math.max(t0.moved, Math.hypot(ev.clientX - t0.x, ev.clientY - t0.y));
      }
      steer(ev);
    };
    const onDown = (ev: PointerEvent) => {
      if ((ev.target as HTMLElement).closest(".ui")) return;
      if (ev.pointerType === "mouse") {
        dash(ev.clientX, ev.clientY);
      } else {
        if (touchRef.current) return;
        touchRef.current = {
          pointerId: ev.pointerId,
          t: performance.now(),
          x: ev.clientX,
          y: ev.clientY,
          moved: 0,
        };
        pointerRef.current = { x: ev.clientX, y: ev.clientY };
        // Touch-down is already an instruction: the thumb names a place and the
        // lantern sets off toward it, with no drag needed to commit. Waiting for
        // a pointermove made a still thumb mean nothing, which is exactly the
        // "define a direction first" step neither scheme should have.
        steer(ev);
      }
    };
    const onUp = (ev: PointerEvent) => {
      const t0 = touchRef.current;
      if (!t0 || t0.pointerId !== ev.pointerId || ev.pointerType === "mouse") return;
      touchRef.current = null;
      const tapped = performance.now() - t0.t < 200 && t0.moved < 12;

      if (padsOn) {
        // The stick always wins. A water touch made by the other thumb while
        // the stick is held never steered, so releasing it must not stop the
        // stick — and it cannot count as a tap either.
        if (stickActiveRef.current) {
          lastArenaTapRef.current = null;
          return;
        }
        // Lifting the thumb stops the lantern and drops the camera lead: the
        // water no longer holds a route to keep travelling along.
        client.sendDirection(0, 0);
        pointerRef.current = { x: innerWidth / 2, y: innerHeight / 2 };
        if (!tapped || status.state !== "open") {
          lastArenaTapRef.current = null;
          return;
        }
        const now = performance.now();
        const previousTap = lastArenaTapRef.current;
        const doubleTapped =
          previousTap !== null &&
          now - previousTap.t <= DOUBLE_TAP_MS &&
          Math.hypot(ev.clientX - previousTap.x, ev.clientY - previousTap.y) <=
            DOUBLE_TAP_RADIUS;
        lastArenaTapRef.current = doubleTapped
          ? null
          : { t: now, x: ev.clientX, y: ev.clientY };
        // double-tap still sprints, now aimed straight at the tapped water
        // rather than at a route it no longer sets
        if (doubleTapped) dash(ev.clientX, ev.clientY);
        return;
      }

      client.sendDirection(0, 0);
      if (tapped) dash(ev.clientX, ev.clientY);
    };
    const stopInput = () => {
      touchRef.current = null;
      stickActiveRef.current = false;
      lastArenaTapRef.current = null;
      pointerRef.current = { x: innerWidth / 2, y: innerHeight / 2 };
      client.sendDirection(0, 0);
    };
    const onVisibility = () => {
      if (document.hidden) stopInput();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.repeat) return;
      if (ev.code === "Space" || ev.code === "KeyL") {
        ev.preventDefault();
        client.sendToggle();
        noteToggle();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", stopInput);
    window.addEventListener("blur", stopInput);
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", stopInput);
      window.removeEventListener("blur", stopInput);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, dash, padsOn, status.state]);

  return (
    <>
      <canvas ref={canvasRef} id="c" />
      <Hud selfId={selfId} />
      <Leaderboard selfId={selfId} />
      {/* beside the leaderboard because that is where the wish comes from:
          you read the names, and you want one of them to be someone you know */}
      {!teaching && <InviteButton className="inArena" />}
      {/* the controls are taught on the start screen and, once per browser, by
          the first-descent coach — the arena itself stays unlettered */}
      {teaching && <Tutorial state={tutorial} selfId={selfId} />}
      {padsOn
        ? status.state === "open" && (
            <TouchPads
              selfId={selfId}
              headingRef={padHeadingRef}
              onStickActiveChange={setStickActive}
            />
          )
        : <LanternButton />}
      {/* The start screen's name field is asked on the death screen — shown
          only to a guest who arrived with no name at all (ui/nameOverlay.tsx).
          Never in the live arena: typing there got the typist eaten. */}
      {status.state === "dead" && (
        <DeathOverlay by={status.by} peak={status.peakLight}>
          <NameOverlay />
        </DeathOverlay>
      )}
    </>
  );
}

function Hud({ selfId }: { selfId: number }) {
  const frame = useWorldStateThrottled(200);
  const self = frame?.players.find((p) => p.id === selfId);
  if (!self) return <div className="hudState">— <span className="dim">snuffed</span></div>;
  const state = self.light < REF.gutter ? "GUTTERING" : self.lit ? "LIT" : "DARK";
  return (
    <div className={"hudState" + (state === "GUTTERING" ? " gutterState" : "")}>
      <b>{Math.floor(self.light)}</b> light · {state}
    </div>
  );
}

function Leaderboard({ selfId }: { selfId: number }) {
  const { entries } = useLeaderboard(2000, selfId);
  if (!entries.length) return null;
  /* The server sends exactly the rows to paint: the top of the ladder, with our
     own row substituted into the last one when we are below the cut. The rank
     printed is the real one, so a distant player reads "11." and not "5.". */
  return (
    <div className="leaderboard">
      <h4>Leaderboard</h4>
      {entries.map((e) => (
        <div key={e.id}>
          {e.rank}. {e.id === selfId ? <b>{e.name}</b> : e.name} · {e.light}
        </div>
      ))}
    </div>
  );
}

function LanternButton() {
  const client = useGameClient();
  return (
    <button
      type="button"
      className="lanternBtn ui"
      title="Hide (Space / L)"
      aria-label="Hide lantern"
      onClick={(ev) => {
        ev.stopPropagation();
        client.sendToggle();
        noteToggle();
      }}
    />
  );
}
