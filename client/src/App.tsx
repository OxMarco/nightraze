import { useCallback, useEffect, useRef } from "react";
import { GameProvider } from "./game/GameContext.js";
import {
  useConnectionStatus,
  useGameClient,
  useLeaderboard,
  useWorldFrames,
  useWorldStateThrottled,
} from "./game/hooks.js";
import { useControlScheme, useIsTouch } from "./game/controls.js";
import { confirmName, isNamePending } from "./game/prefs.js";
import { beginTutorial, noteDash, noteToggle, useTutorial } from "./game/tutorial.js";
import { platform } from "./platform/current.js";
import { SceneRenderer } from "./render/scene.js";
import { REF } from "./render/core.js";
import { BounceScreen, DeathOverlay, StartScreen } from "./ui/modals.js";
import { TouchPads } from "./ui/pads.js";
import { Tutorial } from "./ui/tutorial.js";

// Same-origin: in production the game server itself serves this bundle behind
// Traefik, and locally the Vite dev server proxies /play and the HTTP API
// routes to it. Deriving from location keeps this working over both http/ws
// and https/wss without any build-time config.
const WS_PROTO = location.protocol === "https:" ? "wss" : "ws";
const config = {
  wsUrl: `${WS_PROTO}://${location.host}/play`,
  apiUrl: location.origin,
};

export default function App() {
  return (
    <GameProvider config={config}>
      <Screens />
    </GameProvider>
  );
}

function Screens() {
  const status = useConnectionStatus();
  useGameplayReporting(status.state);
  if (status.state === "open" || status.state === "dead") return <Arena />;
  if (status.state === "closed" && status.full) return <BounceScreen />;
  return <StartScreen />;
}

/**
 * Tells the host page when the player is actually playing.
 *
 * "open" is the only state where the lantern is in the water and inputs mean
 * something; every other state is a menu, a corpse, or a dropped socket. That
 * maps exactly onto what a portal wants from gameplayStart/gameplayStop, and it
 * gets respawn for free — "once more" returns the connection to open, which is
 * a fresh start as far as the host is concerned. Keyed on the state string
 * rather than the status object so a new playerId or world size doesn't
 * re-announce a run that never stopped.
 */
function useGameplayReporting(state: string): void {
  useEffect(() => {
    if (state !== "open") return;
    platform().gameplayStart();
    return () => platform().gameplayStop();
  }, [state]);
}

// ---------------------------------------------------------------- arena
function Arena() {
  const status = useConnectionStatus();
  const client = useGameClient();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const pointerRef = useRef({ x: innerWidth / 2, y: innerHeight / 2 });
  const touchRef = useRef<{ t: number; x: number; y: number; moved: number } | null>(null);

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
    // our own player state is the only report of what the arena calls us —
    // the server may have sanitized the name we asked for (prefs.ts)
    if (isNamePending()) {
      confirmName(frame.players.find((p) => p.id === selfId)?.name);
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

  // input: pointer steers, click/tap jumps, keys toggle the lantern.
  // Under the pad scheme the stick owns steering, so a touch on the water is
  // only ever a candidate tap — but the tap still jumps, and still jumps
  // *toward the touch point*, which is what keeps the aimed ambush strike (§9)
  // instead of trading it for a button that can only fire along the heading.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerType !== "mouse" && !touchRef.current) return;
      pointerRef.current = { x: ev.clientX, y: ev.clientY };
      const t0 = touchRef.current;
      if (t0 && ev.pointerType !== "mouse") {
        t0.moved = Math.max(t0.moved, Math.hypot(ev.clientX - t0.x, ev.clientY - t0.y));
        if (padsOn) return;
      }
      client.sendDirection(ev.clientX - innerWidth / 2, ev.clientY - innerHeight / 2);
    };
    const onDown = (ev: PointerEvent) => {
      if ((ev.target as HTMLElement).closest(".ui")) return;
      if (ev.pointerType === "mouse") {
        dash(ev.clientX, ev.clientY);
      } else {
        touchRef.current = { t: performance.now(), x: ev.clientX, y: ev.clientY, moved: 0 };
        pointerRef.current = { x: ev.clientX, y: ev.clientY };
      }
    };
    const onUp = (ev: PointerEvent) => {
      const t0 = touchRef.current;
      touchRef.current = null;
      if (!t0 || ev.pointerType === "mouse") return;
      // every released touch returns to a stationary intent — except under the
      // pads, where the stick is holding a direction this touch never set and
      // must not be allowed to cancel
      if (!padsOn) client.sendDirection(0, 0);
      if (performance.now() - t0.t < 200 && t0.moved < 12) dash(ev.clientX, ev.clientY);
    };
    const stopInput = () => {
      touchRef.current = null;
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
  }, [client, dash, padsOn]);

  return (
    <>
      <canvas ref={canvasRef} id="c" />
      <Hud selfId={selfId} />
      <Leaderboard />
      {/* the controls are taught on the start screen and, once per browser, by
          the first-descent coach — the arena itself stays unlettered */}
      {teaching && <Tutorial state={tutorial} selfId={selfId} />}
      {padsOn
        ? status.state === "open" && <TouchPads selfId={selfId} />
        : <LanternButton />}
      {status.state === "dead" && <DeathOverlay by={status.by} peak={status.peakLight} />}
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

function Leaderboard() {
  const { entries } = useLeaderboard(2000);
  if (!entries.length) return null;
  return (
    <div className="leaderboard">
      <h4>Brightest</h4>
      {entries.slice(0, 5).map((e, i) => (
        <div key={i}>
          {i + 1}. {e.name} · {e.light}
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
