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

   So the arena opens itself and the name question waits for the first death.
   It was first asked in the live arena, over a lantern whose two seconds of
   spawn protection ran out mid-keystroke, and the typist got eaten. The death
   screen is the one moment nobody can drain you, and "once more" was about to
   reconnect anyway. Who sees it:

     - a signed-in CrazyGames player never does. The portal already knows a
       name their friends recognise, and identity.ts prefers it over anything
       typed here.
     - a phone or tablet never does. On iOS Safari, focusing a text field in
       the portal's iframe raises the keyboard, the portal re-lays its page
       and the game is replaced by its "Join game" screen. Touch guests play
       as "ember".
     - every other guest does, on every death screen, pre-filled with the
       name they last played under. "not now" hides it for that death only.

   Answering it reconnects, because the name is settled in the socket handshake
   (`?name=`) and there is no rename frame on the wire. On the death screen
   that is simply the next run starting under the new name — the same new spawn
   "once more" would have given, so the host sees an ordinary gameplayStart. */

import { useState } from "react";
import { useIsTouch } from "../game/controls.js";
import { useGameActions } from "../game/hooks.js";
import { useIdentity } from "../game/identity.js";
import { MAX_NAME, proposeName, readName } from "../game/prefs.js";
import "./nameOverlay.css";

export function NameOverlay() {
  const { player } = useIdentity();
  const touch = useIsTouch();
  // Offered before every run, pre-filled with the name this browser last had
  // accepted, so keeping it is one tap and changing it is always possible.
  const [name, setName] = useState(readName);
  const [dismissed, setDismissed] = useState(false);
  const { connect } = useGameActions();

  if (player || touch || dismissed) return null;

  const dismiss = () => setDismissed(true);

  const commit = () => {
    const typed = name.trim();
    dismiss();
    if (!typed) return;          // "not now" by another route
    proposeName(typed);          // kept only if the arena hands it back intact
    connect(typed);              // the handshake is where a name is settled
  };

  return (
    <div className="nameOverlay ui" role="dialog" aria-label="Choose your name">
      <label htmlFor="nameOverlayInput">What should the arena call you next run?</label>
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
            // The arena listens on window for Space
            // and L. A name with a space in it should not also shutter the
            // lantern, and Escape should close the box rather than reach
            // whatever else may come to listen for it.
            ev.stopPropagation();
            if (ev.key === "Enter") commit();
            if (ev.key === "Escape") dismiss();
          }}
        />
        <button type="button" onClick={commit}>play</button>
      </div>
      <button type="button" className="nameOverlaySkip" onClick={dismiss}>
        not now
      </button>
    </div>
  );
}
