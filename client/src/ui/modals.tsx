import { useEffect, useState } from "react";
import { useConnectionStatus, useGameActions, useGameClient } from "../game/hooks.js";
import { readBest, recordRun } from "../game/best.js";
import { proposeName, readName } from "../game/prefs.js";
import { platform } from "../platform/current.js";
import "./modals.css";

// Motion encodes the state: rings expand outward on welcome (you're about to
// disturb the dark), collapse inward in red on death (the dark closing over
// you), and freeze at capacity (nothing moves — no room).
function Ripples({ mode }: { mode: "out" | "in" | "still" }) {
  if (mode === "still") {
    return (
      <div className="rippleField" aria-hidden="true">
        <span className="ring still" style={{ transform: "scale(0.45)" }} />
        <span className="ring still" style={{ transform: "scale(0.8)" }} />
        <span className="ring still" style={{ transform: "scale(1.15)" }} />
      </div>
    );
  }
  const cls = "ring" + (mode === "in" ? " in" : "");
  return (
    <div className="rippleField" aria-hidden="true">
      <span className={cls} />
      <span className={cls} style={{ animationDelay: "-2s" }} />
      <span className={cls} style={{ animationDelay: "-4s" }} />
    </div>
  );
}

// ---------------------------------------------------------------- start
export function StartScreen() {
  const status = useConnectionStatus();
  const { connect } = useGameActions();
  const [name, setName] = useState(readName);
  const [best] = useState(readBest);
  const waiting = status.state === "connecting" || status.state === "reconnecting";

  const go = () => {
    if (waiting) return;
    const typed = name.trim();
    proposeName(typed);   // remembered only if the arena hands it back intact
    connect(typed || "ember");
  };

  return (
    <div className="modalBackdrop">
      <Ripples mode="out" />
      <div className="modalCore">
        <div className="kicker">nightraze.io</div>
        <h1 className="modalTitle">
          every move
          <br />
          ripples the dark
        </h1>
        <p className="rules">
          motes grow your <b>light</b> · it is your score, your health, and how far you're seen
          <br />
          <b>shutter</b> to go dark, but it takes a moment
          <br />
          contact <b>drains</b> · drain a lantern dry to snuff it
        </p>
        <input
          className="nameInput"
          placeholder="name your player"
          maxLength={15}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          autoFocus
        />
        <button className="modalAction" onClick={go} disabled={waiting}>
          {waiting ? "descending…" : "light the lantern"}
        </button>
        {best > 0 && (
          <div className="numLbl dim">your best · {best}</div>
        )}
        {status.state === "closed" && (
          <div className="modalErr">
            {status.wasError ? "could not reach the abyss. is the server running?" : "connection closed"}
          </div>
        )}
        {status.state === "reconnecting" && (
          <div className="modalErr">
            reconnecting (attempt {status.attempt})…
          </div>
        )}
        <div className="modalControls">
          <span className="keys">
            cursor steers · <kbd>click</kbd> lunges · <kbd>space</kbd> shutters · <kbd>V</kbd> vents
          </span>
          <span className="touch">drag steers · tap lunges · lantern button shutters, double-tap vents</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- death
export function DeathOverlay({ by, peak }: { by: string; peak: number }) {
  const client = useGameClient();
  // recorded once, when the overlay mounts — one run, one entry
  const [run] = useState(() => recordRun(peak));
  // The host page is allowed to celebrate with us, but only for something that
  // actually happened once: a personal best is rare by construction, which is
  // the whole contract on this call.
  useEffect(() => {
    if (run.isBest) platform().happytime();
  }, [run.isBest]);
  return (
    <div className="modalBackdrop seeThrough">
      <Ripples mode="in" />
      <div className="modalCore">
        <div className="kicker bad">lantern lost</div>
        <h1 className="modalTitle bad">
          the dark
          <br />
          closed over you
        </h1>
        <p className="rules">
          drained by <b>{by || "the dark"}</b>
        </p>
        <div className={"bigNum" + (run.isBest ? " crowned" : "")}>{run.peak}</div>
        <div className="numLbl">
          {/* the run is scored on how bright it ever got, not on what was left
              when it ended — the light you spilled was still light you held */}
          {run.isBest ? "your brightest burn yet" : "peak light this run"}
        </div>
        {!run.isBest && run.best > 0 && (
          <div className="numLbl dim">your best · {run.best}</div>
        )}
        <div>
          <button className="modalAction bad" onClick={() => client.sendRespawn()}>
            once more
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bounce
const RETRY_SECONDS = 8;

/** Shown when the server bounces us at capacity (WebSocket close 1013). */
export function BounceScreen() {
  const client = useGameClient();
  const { disconnect } = useGameActions();
  const [seconds, setSeconds] = useState(RETRY_SECONDS);

  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s - 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (seconds <= 0) client.reconnect();
  }, [seconds, client]);

  return (
    <div className="modalBackdrop">
      <Ripples mode="still" />
      <div className="modalCore">
        <div className="kicker">abyss at capacity</div>
        <h1 className="modalTitle">
          the water
          <br />
          is still
        </h1>
        <p className="rules">every place below is taken. when a lantern goes out, you get one</p>
        <div className="bigNum">{Math.max(0, seconds)}</div>
        <div className="numLbl">retrying in</div>
        <div>
          <button className="modalAction" onClick={() => client.reconnect()}>
            try now
          </button>
        </div>
        <button className="modalQuiet" onClick={disconnect}>
          back to the surface
        </button>
      </div>
    </div>
  );
}
