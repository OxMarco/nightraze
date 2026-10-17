import { useEffect, useState } from "react";
import { useConnectionStatus, useGameActions, useGameClient } from "../game/hooks.js";
import { readBest, recordRun } from "../game/best.js";
import { setScheme, useControlScheme, useIsTouch } from "../game/controls.js";
import { useIdentity } from "../game/identity.js";
import { MAX_NAME, proposeName, readName } from "../game/prefs.js";
import { InviteButton } from "./invite.js";
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
  const scheme = useControlScheme();
  // the switch is only meaningful on a device that can touch; asking a mouse
  // which thumb layout it prefers is noise
  const touch = useIsTouch();
  const waiting = status.state === "connecting" || status.state === "reconnecting";
  // On a host with its own accounts the player already has a name their friends
  // know, and it beats anything typed here (game/identity.ts).
  const { player, canSignIn, signIn } = useIdentity();

  const go = () => {
    if (waiting) return;
    if (player) {
      // Not proposed and not remembered: the host owns this name, and storing
      // it would only mean prefilling a stranger's handle for the next guest on
      // a shared machine.
      connect(player.name);
      return;
    }
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
          <b>hide</b> to go dark, but it takes a moment
          <br />
          contact <b>drains</b> · drain a lantern dry to snuff it
        </p>
        {player ? (
          /* Shown rather than editable, and shown at all rather than silently
             used, because the point of carrying the host's name into the arena
             is that it is the name on the leaderboard your friends are reading.
             A player who cannot see what they are called cannot know that. */
          <div className="identity">
            {player.avatarUrl && (
              <img className="identityFace" src={player.avatarUrl} alt="" aria-hidden="true" />
            )}
            <span className="identityName">{player.name}</span>
          </div>
        ) : (
          <input
            className="nameInput"
            placeholder="name your player"
            maxLength={MAX_NAME}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()}
            autoFocus
          />
        )}
        <button className="modalAction" onClick={go} disabled={waiting}>
          {waiting ? "descending…" : "light the lantern"}
        </button>
        {/* Offered under the action, never in front of it: signing in is how
            friends find each other on the ladder, but it is not the price of
            playing, and a guest who ignores this loses nothing. */}
        {canSignIn && (
          <button className="modalQuiet" onClick={() => void signIn()}>
            sign in to play under your name
          </button>
        )}
        <InviteButton />
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
            <kbd>cursor</kbd> steers · <kbd>click</kbd> jumps · <kbd>space</kbd> hides
          </span>
          <span className="touch">
            {scheme === "pads"
              ? "stick or hold the water moves · double-tap sprints · jump and hide buttons"
              : "hold anywhere to swim there · tap jumps · lantern button hides"}
          </span>
        </div>
        {touch && (
          <div className="schemePick">
            <span className="schemeLbl">touch controls</span>
            {/* default first, so the order reads as the recommendation */}
            <button
              type="button"
              className={"schemeOpt" + (scheme === "pads" ? " on" : "")}
              onClick={() => setScheme("pads")}
            >
              stick + buttons
            </button>
            <button
              type="button"
              className={"schemeOpt" + (scheme === "one-finger" ? " on" : "")}
              onClick={() => setScheme("one-finger")}
            >
              touch to move
            </button>
          </div>
        )}
        <PrivacyNotice hostAccount={player !== null} />
      </div>
    </div>
  );
}

/* The standing notice, on the last screen before the arena.

   Non-blocking by requirement and by preference: no gate, no dialog, no button
   to dismiss, because nothing here needs consent to be lawful — there are no
   cookies, no trackers and no ad network to ask about. It is a disclosure, and
   a disclosure's whole job is to be findable by the person who wants it and
   invisible to the person who does not.

   It opens in a new tab deliberately. Inside a portal frame the game is not the
   top-level document, and navigating the frame to a policy would replace the
   game with a wall of text inside somebody else's page, with no way back.

   The href is absolute, not "/privacy". Root-relative resolves against whoever
   is serving the document, which is us today — but if the game is ever uploaded
   to a portal's own hosting rather than framed from nightraze.io, "/privacy"
   silently becomes a link to *their* privacy page. This is also the URL that
   gets typed into the submission form, so there is one canonical answer. */
const PRIVACY_URL = "https://nightraze.io/privacy";
const TERMS_URL = "https://nightraze.io/terms";

/* `hostAccount` is not a detail. "no account" is true of nightraze and false of
   the screen it is printed on the moment a portal account is signed in — the
   player is looking at their own username and avatar two lines above it. A
   disclosure that contradicts what the reader can see is worse than none, so
   the claim narrows to the one we can still make: the account is the host's,
   and we keep none of our own. The policy page has always said this at
   length; this line just stops disagreeing with it. */
export function PrivacyNotice({ hostAccount }: { hostAccount: boolean }) {
  return (
    <p className="legalNote">
      {hostAccount ? "no account of ours" : "no account"}, no cookies, no trackers ·{" "}
      <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
        what we store
      </a>{" "}
      ·{" "}
      <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
        terms
      </a>
    </p>
  );
}

// ---------------------------------------------------------------- death
export function DeathOverlay({ by, peak }: { by: string; peak: number }) {
  const client = useGameClient();
  const { player } = useIdentity();
  // recorded once, when the overlay mounts — one run, one entry. The host-page
  // celebration is not here: it fired mid-run, the moment the record actually
  // broke (game/best.ts) — this screen only reports it.
  const [run] = useState(() => recordRun(peak));
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
        <PrivacyNotice hostAccount={player !== null} />
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
