/* "Bring someone into the dark."

   The link itself is the host's business (game/session.ts): on a portal the
   SDK mints one that carries the player back to the portal's own page, and on
   nightraze.io it is our URL with the arena in its query string. Where a host
   offers neither, this renders nothing rather than a button that copies null.

   Copying is the whole interaction. There is a Web Share sheet on phones and
   it is genuinely nicer there, so it is used when the browser has one, but it
   can be dismissed and it can reject, and neither is a failure worth reporting
   to someone who just wanted a link — both fall through to the clipboard. */

import { useEffect, useMemo, useState } from "react";
import { inviteLink } from "../game/session.js";
import "./invite.css";

const CONFIRM_MS = 2_000;

async function share(link: string): Promise<boolean> {
  if (!navigator.share) return false;
  try {
    await navigator.share({ title: "nightraze.io", url: link });
    return true;
  } catch {
    // dismissed, or a browser that advertises share and then refuses it
    return false;
  }
}

async function copy(link: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(link);
    return true;
  } catch {
    // insecure context, denied permission, or a frame without clipboard access
    return false;
  }
}

export function InviteButton({ className = "" }: { className?: string }) {
  const [state, setState] = useState<"idle" | "shared" | "failed">("idle");
  // Minting a link is an SDK call on a portal, so it is not something to do
  // while rendering — and this component re-renders whenever the arena around
  // it does. Once per mount is enough: the only input is the arena id, which is
  // a constant (game/session.ts), so nothing about this player or this run can
  // change the answer. An earlier version keyed this on the signed-in identity
  // on the theory that a host might mint a link naming the player; it does not,
  // and the dependency was decoration.
  const link = useMemo(() => inviteLink(), []);

  useEffect(() => {
    if (state === "idle") return;
    const id = setTimeout(() => setState("idle"), CONFIRM_MS);
    return () => clearTimeout(id);
  }, [state]);

  if (!link) return null;

  const invite = async () => {
    if (await share(link)) {
      setState("shared");
      return;
    }
    setState((await copy(link)) ? "shared" : "failed");
  };

  return (
    <button
      type="button"
      className={`inviteBtn ui${state === "shared" ? " done" : ""} ${className}`.trim()}
      onClick={(ev) => {
        ev.stopPropagation();
        void invite();
      }}
    >
      {state === "shared" ? "link copied" : state === "failed" ? "copy failed" : "invite a friend"}
    </button>
  );
}
