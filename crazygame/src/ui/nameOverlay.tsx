/* Naming, moved into the water.

   client/ asks for a name on the start screen, and that is right for
   nightraze.io: someone who followed a link to the game's own page is choosing
   to play, and a screen that explains the three verbs before the dark closes
   in is worth the tap.

   Here it is wrong, twice over. The player already chose this game on the
   portal's page — a second menu in front of it is a menu they have already
   answered. And the start screen is what was holding gameplayStart and
   updateRoom behind a button, which is what CrazyGames QA reported as "first
   gameplay start: failed" and "game updates multiplayer room: not detected":
   both fire when the connection leaves idle, and nothing left idle until
   someone pressed play.

   So the arena opens itself and the name question follows the player in. Who
   actually sees this is narrow by design:

     - a signed-in CrazyGames player never does. The portal already knows a
       name their friends recognise, and identity.ts prefers it over anything
       typed here.
     - a returning browser never does. prefs.ts has the last name the server
       accepted from it.
     - a first-time guest does, once, having already been dropped into a
       playable arena under the default name.

   Answering it reconnects, because the name is settled in the socket handshake
   (`?name=`) and there is no rename frame on the wire. That costs the seconds
   of the run so far, which is the right trade for a run that is seconds old —
   and it is the same reconnect that "once more" already performs, so the host
   sees an ordinary gameplayStart rather than anything novel. */

import { useState } from "react";
import { useGameActions } from "../game/hooks.js";
import { useIdentity } from "../game/identity.js";
import { MAX_NAME, proposeName, readName } from "../game/prefs.js";
import { PrivacyNotice } from "./modals.js";
import "./nameOverlay.css";

export function NameOverlay() {
  const { player } = useIdentity();
  // Read once, at mount: this asks whether the player arrived nameless, and a
  // name confirmed later in this very run should not make the box vanish
  // mid-keystroke.
  const [arrivedNamed] = useState(() => readName() !== "");
  const [name, setName] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const { connect } = useGameActions();

  if (player || arrivedNamed || dismissed) return null;

  const commit = () => {
    const typed = name.trim();
    setDismissed(true);
    if (!typed) return;          // "play as ember" by another route
    proposeName(typed);          // kept only if the arena hands it back intact
    connect(typed);              // the handshake is where a name is settled
  };

  return (
    <div className="nameOverlay ui" role="dialog" aria-label="Choose your name">
      <label htmlFor="nameOverlayInput">What should the arena call you?</label>
      <div className="nameOverlayRow">
        <input
          id="nameOverlayInput"
          type="text"
          value={name}
          maxLength={MAX_NAME}
          placeholder="ember"
          autoComplete="off"
          spellCheck={false}
          onChange={(ev) => setName(ev.target.value)}
          onKeyDown={(ev) => {
            // The arena is live behind this box and listens on window for Space
            // and L. A name with a space in it should not also shutter the
            // lantern, and Escape should close the box rather than reach
            // whatever else may come to listen for it.
            ev.stopPropagation();
            if (ev.key === "Enter") commit();
            if (ev.key === "Escape") setDismissed(true);
          }}
        />
        <button type="button" onClick={commit}>Set</button>
      </div>
      <button type="button" className="nameOverlaySkip" onClick={() => setDismissed(true)}>
        play as ember
      </button>
      <PrivacyNotice hostAccount={false} />
    </div>
  );
}
