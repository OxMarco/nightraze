/* The Abyssal creature — a TS port of the approved specimen sheet
   (design/abyssal.html): one wobbling membrane filled with a single luminous
   gradient, bright heart fading to a dim rim. No internal anatomy. */

import {
  TAU, clamp, lerp, REF, LIFE_HUE, LIFE_OF, BRIGHT_OF, RIM, HARM,
  bodyR, glowLit, glowRevealed, glowIrr,
} from "./core.js";

export interface CreatureView {
  x: number;
  y: number;
  L: number;
  lit: boolean;
  /** 0 = fully dark .. 1 = fully lit; animates the membrane contraction. */
  litAnim?: number;
  /** Seconds of revealed-glow remaining. */
  revealT?: number;
  gutter?: boolean;
  shielded?: boolean;
  seed?: number;
  eatPulse?: number;
  squash?: { a: number; k: number } | null;
  /** Palette hue for this lantern (see playerHue); defaults to the signature LIFE teal. */
  hue?: number;
}

export function glowPool(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number,
  colorFn: (a: number) => string, a0: number,
): void {
  if (r <= 1 || a0 <= 0.002) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, colorFn(a0));
  g.addColorStop(0.45, colorFn(a0 * 0.35));
  g.addColorStop(1, colorFn(0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

function membranePath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number, t: number, seed: number,
  amp: number, squash?: { a: number; k: number } | null,
): void {
  ctx.beginPath();
  for (let i = 0; i <= 26; i++) {
    const a = (i / 26) * TAU;
    const rr = r * (1 + amp * Math.sin(a * 3 + t * 3 + seed));
    let px = Math.cos(a) * rr, py = Math.sin(a) * rr;
    if (squash) {
      const c = Math.cos(squash.a), s = Math.sin(squash.a);
      const lx = px * c + py * s, ly = -px * s + py * c;
      px = lx * squash.k * c - (ly / squash.k) * s;
      py = lx * squash.k * s + (ly / squash.k) * c;
    }
    if (i) ctx.lineTo(x + px, y + py);
    else ctx.moveTo(x + px, y + py);
  }
  ctx.closePath();
}

export function drawCreature(ctx: CanvasRenderingContext2D, t: number, o: CreatureView): void {
  const hue = o.hue ?? LIFE_HUE;
  const life = (a: number) => LIFE_OF(hue, a);
  const lifeBright = (a: number) => BRIGHT_OF(hue, a);
  const r = bodyR(o.L) * (1 + (o.eatPulse ?? 0) * 0.10);
  const seed = o.seed ?? 0;
  const litF = o.litAnim !== undefined ? o.litAnim : o.lit ? 1 : 0;
  const revealT = o.revealT ?? 0;
  const pulse = 1 + 0.08 * Math.sin(t * 2.2 + seed) + (o.eatPulse ?? 0) * 0.2;
  const strobe = o.gutter ? (Math.sin(t * 22 + seed) > -0.3 ? 1 : 0.15) : 1;
  const revealF = revealT > 0 ? Math.min(1, revealT / 0.5) : 0;

  // glow pool: blend between irreducible (dark) and lit/revealed glow
  const grLit = revealF > 0 ? glowRevealed(o.L) : glowLit(o.L);
  const gr = lerp(glowIrr(o.L), grLit, Math.max(litF, revealF));
  if (gr > 1) glowPool(ctx, o.x, o.y, gr * pulse * 0.9, life, (0.22 + 0.12 * Math.max(litF, revealF)) * strobe);
  if (revealF > 0) {
    ctx.beginPath();
    ctx.arc(o.x, o.y, r + 14 + (1 - revealF) * 30, 0, TAU);
    ctx.strokeStyle = lifeBright(revealF * 0.8);
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // body — one solid gradient, no internal anatomy
  const amp = o.gutter ? 0.14 : 0.06;
  const bright = Math.max(litF, revealF);
  membranePath(ctx, o.x, o.y, r, t, seed, amp, o.squash);
  ctx.fillStyle = "rgba(10,26,30,0.6)";
  ctx.fill();
  const body = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, r * 1.15);
  if (o.gutter && strobe < 0.5) {
    body.addColorStop(0, HARM(0.75));
    body.addColorStop(0.6, HARM(0.25));
    body.addColorStop(1, HARM(0.05));
  } else {
    /* The heart stays white-hot but must stay SMALL. lifeBright sits at 92%
       lightness, where hsl chroma has collapsed to ~0.16 — every hue there
       composites to the same pale near-white, so a wide bright core erases the
       per-player hue entirely (see playerHue in core.ts). The hue-carrying 68%
       stop owns the body from 28% of the radius out; that keeps "bright heart,
       dim rim" while leaving the identity readable at a glance. */
    body.addColorStop(0, lifeBright(lerp(0.20, 0.85, bright) * strobe));
    body.addColorStop(0.28, life(lerp(0.16, 0.75, bright) * strobe));
    body.addColorStop(0.7, life(lerp(0.10, 0.45, bright) * strobe));
    body.addColorStop(1, life(lerp(0.04, 0.15, bright) * strobe));
  }
  ctx.fillStyle = body;
  ctx.fill();
  // the rim carries hue too — an outline is a stronger identity cue than a core
  ctx.strokeStyle = bright > 0.5 ? life(0.9 * strobe * bright) : RIM(0.35 + 0.3 * bright);
  ctx.lineWidth = lerp(1.5, 2, bright);
  ctx.stroke();
  if (o.gutter) glowPool(ctx, o.x, o.y, r * 1.6, HARM, 0.3 * (1 - strobe));

  /* The crown (§11). Scales continuously with held light and fades out with
     the flame, so it is worn only while you are also worth hunting — no rank
     check, no threshold pop, and nothing a dark lantern can carry. Drawn
     inside the existing glow so it reads as status, never as extra reach. */
  const crown = clamp((o.L - REF.crownMin) / (REF.crownFull - REF.crownMin), 0, 1) * bright;
  if (crown > 0.01) {
    const cr = r + 9 + 5 * crown;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(t * 0.25);
    ctx.strokeStyle = lifeBright(0.30 * crown * strobe);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, cr, 0, TAU);
    ctx.stroke();
    // rays: eight at the threshold, sixteen at full — the count is the tell
    const rays = crown < 0.5 ? 8 : 16;
    const len = 5 + 9 * crown;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = lifeBright(0.5 * crown * strobe);
    ctx.beginPath();
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * TAU + Math.sin(t * 1.1 + seed) * 0.04;
      const c = Math.cos(a), s = Math.sin(a);
      ctx.moveTo(c * (cr + 2), s * (cr + 2));
      ctx.lineTo(c * (cr + 2 + len), s * (cr + 2 + len));
    }
    ctx.stroke();
    ctx.restore();
  }

  // spawn protection ring
  if (o.shielded) {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(t * 0.8);
    ctx.setLineDash([8, 10]);
    ctx.beginPath();
    ctx.arc(0, 0, r + 8, 0, TAU);
    ctx.strokeStyle = lifeBright(0.5 + 0.25 * Math.sin(t * 6));
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

/** Dash cooldown as a thin diegetic arc around the body (only while cooling). */
export function drawCooldownArc(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number, frac: number,
): void {
  if (frac <= 0 || frac >= 1) return;
  ctx.beginPath();
  ctx.arc(x, y, r + 12, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
  ctx.strokeStyle = RIM(0.35);
  ctx.lineWidth = 2;
  ctx.stroke();
}
