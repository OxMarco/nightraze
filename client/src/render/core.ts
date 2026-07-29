/* nightraze client render core: palette tokens (design/STYLE.md) and the
   light-resource formulas. The formulas MUST match server/src/game/room.ts —
   the client derives radius/glow/vision from the one number the server sends. */

export const TAU = Math.PI * 2;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Frame-rate independent smoothing: k = responsiveness per second. */
export const damp = (cur: number, target: number, k: number, dt: number) =>
  lerp(cur, target, 1 - Math.exp(-k * dt));

// ---- palette tokens ----
export const ABYSS_TOP = "#02121a";
export const ABYSS_BOT = "#010a0e";
export const LIFE = (a: number) => `rgba(90,255,220,${a})`;
export const LIFE_BRIGHT = (a: number) => `rgba(216,255,242,${a})`;
export const PLANKTON = (a: number) => `rgba(157,255,176,${a})`;
export const RIM = (a: number) => `rgba(80,150,220,${a})`;
export const HARM = (a: number) => `rgba(255,61,104,${a})`;
export const DARKNESS = "rgba(1,8,11,0.955)"; // never pure black

// ---- per-player hues ----
// LIFE/LIFE_BRIGHT sit at hsl(167, 100%, 68%) / hsl(160, 100%, 92%); these are
// the same colors with the hue left open. Saturation and lightness stay fixed —
// glow visibility is gameplay, so no hue may be brighter or stealthier than
// another.
export const LIFE_HUE = 167;
export const LIFE_OF = (h: number, a: number) => `hsla(${h},100%,68%,${a})`;
export const BRIGHT_OF = (h: number, a: number) => `hsla(${h},100%,92%,${a})`;

// Every other lantern derives its hue from its server-assigned id, inside the
// palette's "alive" band (green -> teal -> cyan -> blue). A window around the
// signature teal is skipped so no one else reads as "me", and HARM's pink-red
// stays reserved for danger. Deterministic: every client colors the same id the
// same way.
//
// CAVEAT: golden-ratio stepping only spreads *consecutive* ids far apart, and
// player ids are not consecutive — server/src/game/room.ts draws players, field
// motes and loose light from one shared `nextId++`, so ids arrive sparse and
// effectively arbitrary. Hues are therefore ~uniform random in the band, and
// two players in a room can land a few degrees apart. Fixing that needs a small
// per-room slot index (0,1,2,...) assigned server-side and fed in here instead
// of the raw id; that restores the low-discrepancy spread this was written for.
const HUE_MIN = 125, HUE_MAX = 225;
const SELF_GAP_LO = 157, SELF_GAP_HI = 177;
const GOLDEN = 0.618033988749895;
export function playerHue(id: number): number {
  const span = HUE_MAX - HUE_MIN - (SELF_GAP_HI - SELF_GAP_LO);
  let h = HUE_MIN + ((id * GOLDEN) % 1) * span;
  if (h >= SELF_GAP_LO) h += SELF_GAP_HI - SELF_GAP_LO;
  return h;
}

// ---- shared reference values (client-side rendering only; server is authoritative) ----
export const REF = {
  G: 6,
  visionLitCap: 560,
  glowLitCap: 520,
  darkVision: 60,
  gutter: 6,
  irisTime: 0.45,
  dashCooldown: 0.9,
  boundarySense: 300,
  // no shimmer constants live here on purpose: who shimmers, where, and how
  // often is decided server-side and arrives as SHIMMER effects (§6). A copy
  // of the rule on this side is a copy an edited client can widen.

  // ---- the crown (§11, the Leader) ----
  // Prestige keyed to held light, never to leaderboard position: one resource
  // explains everything (pillar 1), so rank checks have no place in the render
  // either. It is drawn only while the lantern is open — the crown is worn by
  // being visible, which is the same thing that makes you hunted, so the
  // fantasy pays for its own counterplay. Tight to the body on purpose: this
  // is regalia, not reach. It must never look like extra glow radius.
  crownMin: 120,
  crownFull: 400,
};

/** Server-pushed balance levers (§10). The server remains the only authority;
    this only keeps what the client *draws* in step with what it may perceive. */
export function applyTuning(t: { glowG: number }): void {
  if (Number.isFinite(t.glowG) && t.glowG >= 0) REF.G = t.glowG;
}

export const bodyR = (L: number) => 9 + 1.9 * Math.sqrt(L);
export const visionLit = (L: number) => Math.min(REF.visionLitCap, 110 + 22 * Math.sqrt(L));
export const glowLit = (L: number) => Math.min(REF.glowLitCap, 60 + 24 * Math.sqrt(L));
export const glowRevealed = (L: number) => 90 + 26 * Math.sqrt(L);
export const glowIrr = (L: number) => Math.max(0, (Math.sqrt(L) - 5) * REF.G);
