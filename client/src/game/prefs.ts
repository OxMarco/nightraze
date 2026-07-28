/* What the platform remembers about the player between runs (see platform/).
   Convenience only — nothing here is authority over anything.

   The server sanitizes every name it is given (sanitizeName: control and
   bidi characters stripped, whitespace collapsed, 15 chars, profanity falls
   back to "ember"), so a name is only worth remembering once the server has
   handed it back unchanged. A proposed name is held here until the first
   snapshot shows what the arena actually called us; anything the server
   altered was a rejection, and is dropped rather than prefilled again. */

import { platform } from "../platform/current.js";

const NAME_KEY = "nightraze.name";
const MAX_NAME = 15;   // matches the server's maxNameLen

/** The last name the server accepted from this browser, or "" if none. */
export function readName(): string {
  return (platform().storage.get(NAME_KEY) ?? "").slice(0, MAX_NAME);
}

let pending: string | null = null;

/** Offer the name we're about to play under. Kept only if confirmName() later
    sees the server using it verbatim. */
export function proposeName(name: string): void {
  const trimmed = name.trim().slice(0, MAX_NAME);
  pending = trimmed || null;   // a blank name is the "ember" default, not a choice
}

/** Whether a proposal is still waiting on the server's verdict. */
export function isNamePending(): boolean {
  return pending !== null;
}

/** The name the server is actually using for us, from our own player state.
    Resolves the pending proposal either way — one verdict per connection. */
export function confirmName(accepted: string | undefined): void {
  if (pending === null || accepted === undefined) return;
  const proposed = pending;
  pending = null;
  if (accepted !== proposed) return;   // renamed by the server: not ours to keep
  platform().storage.set(NAME_KEY, proposed);
}
