/* nightraze scene renderer — draws interpolated WorldFrames in the Abyssal
   language: abyss background, plankton, loose plasma, creatures, transient
   effects, and the darkness layer with every glow cut out of it.

   All state here is cosmetic (animation blends, particles, camera). The
   authoritative world arrives in the frame. */

import type { WorldFrame, InterpolatedPlayer } from "../net/interpolation.js";
import { EffectKind, type Effect } from "../gen/nightraze/v1/game_pb.js";
import {
  TAU, clamp, lerp, damp,
  ABYSS_TOP, ABYSS_BOT, LIFE_BRIGHT, PLANKTON, RIM, HARM, DARKNESS, REF,
  LIFE_HUE, BRIGHT_OF, playerHue,
  bodyR, visionLit, glowLit, glowRevealed, glowIrr,
} from "./core.js";
import { drawCreature, drawCooldownArc, glowPool } from "./creature.js";

interface LocalFx {
  type: "spark" | "burst" | "stain" | "flash" | "wake";
  x: number; y: number;
  life: number; max: number;
  r: number;       // primary radius / magnitude
  r1?: number;     // wake target radius
}

export interface DrawOpts {
  selfId: number;
  /** Pointer position in screen px (for camera lead). */
  pointerX: number;
  pointerY: number;
}

const pr = (i: number) => (((Math.sin(i * 127.1) * 43758.5453) % 1) + 1) % 1;

export class SceneRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly darkCanvas: HTMLCanvasElement;
  private readonly dctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private DPR = 1;

  private readonly worldSize: number;
  private readonly speckle: { x: number; y: number; a: number }[] = [];

  private cam = { x: 0, y: 0 };
  private camInit = false;
  private fx: LocalFx[] = [];
  private litAnim = new Map<number, number>();
  private eatPulse = new Map<number, number>();
  private prevLight = new Map<number, number>();
  private prevPos = new Map<number, { x: number; y: number; heading: number }>();

  private visionCur = 200;
  private visionStart = 200;
  private visionClock = 99;
  private prevSelfLit: boolean | null = null;

  private lastT = performance.now() / 1000;

  constructor(canvas: HTMLCanvasElement, worldSize: number) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.darkCanvas = document.createElement("canvas");
    this.dctx = this.darkCanvas.getContext("2d")!;
    this.worldSize = worldSize;
    for (let i = 0; i < 900; i++) {
      this.speckle.push({
        x: pr(i + 3000) * worldSize,
        y: pr(i + 4000) * worldSize,
        a: 0.05 + pr(i + 5000) * 0.09,
      });
    }
    this.resize();
  }

  resize(): void {
    this.DPR = Math.min(2, window.devicePixelRatio || 1);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = this.W * this.DPR;
    this.canvas.height = this.H * this.DPR;
    // replaced elements ignore inset:0 sizing — pin CSS size or retina shows a quarter
    this.canvas.style.width = this.W + "px";
    this.canvas.style.height = this.H + "px";
    this.darkCanvas.width = this.W;
    this.darkCanvas.height = this.H;
  }

  /** Convert server effects into local particles. Call once per frame with drainEffects(). */
  ingest(effects: Effect[]): void {
    for (const e of effects) {
      switch (e.kind) {
        case EffectKind.BURN:
          this.fx.push({ type: "spark", x: e.x, y: e.y, life: 0.45, max: 0.45, r: 36 });
          this.fx.push({ type: "flash", x: e.x, y: e.y, life: 0.5, max: 0.5, r: e.m || 130 });
          break;
        case EffectKind.SNUFF:
          this.fx.push({ type: "burst", x: e.x, y: e.y, life: 0.6, max: 0.6, r: e.m || 90 });
          this.fx.push({ type: "flash", x: e.x, y: e.y, life: 0.5, max: 0.5, r: (e.m || 90) * 1.5 });
          break;
        case EffectKind.DOUSE:
          this.fx.push({ type: "stain", x: e.x, y: e.y, life: 0.4, max: 0.4, r: e.m || 120 });
          break;
        case EffectKind.BUMP:
          this.fx.push({ type: "wake", x: e.x, y: e.y, life: 0.5, max: 0.5, r: 10, r1: e.m || 40 });
          break;
        // movement shimmer (§6): the server decides who shimmers, where, and
        // how often — the client only draws the ring. Deliberately sized from
        // the intensity step alone, never from the mover's body, so the wake
        // never reports how big the thing making it is.
        case EffectKind.SHIMMER:
          this.fx.push({
            type: "wake", x: e.x, y: e.y, life: 0.8, max: 0.8,
            r: 14, r1: 40 + 46 * (e.m || 0.35),
          });
          break;
      }
    }
  }

  draw(frame: WorldFrame, opts: DrawOpts): void {
    const t = performance.now() / 1000;
    const dt = Math.min(1 / 20, Math.max(0.0001, t - this.lastT));
    this.lastT = t;

    const { ctx, dctx, W, H } = this;
    const self = frame.players.find((p) => p.id === opts.selfId);
    // dash cooldown arc is driven by the server's authoritative timer, so it
    // never lies when the server rejects a dash (guttering / already cooling)
    const dashCdFrac = self ? clamp(1 - self.dashCd / REF.dashCooldown, 0, 1) : 1;

    // ---- camera: follow self with a lead toward the pointer ----
    if (self) {
      if (!this.camInit) { this.cam.x = self.x; this.cam.y = self.y; this.camInit = true; }
      const leadX = self.x + (opts.pointerX - W / 2) * 0.18;
      const leadY = self.y + (opts.pointerY - H / 2) * 0.18;
      this.cam.x = damp(this.cam.x, leadX, 5, dt);
      this.cam.y = damp(this.cam.y, leadY, 5, dt);
    }

    // ---- per-player cosmetic state ----
    for (const p of frame.players) {
      const la = this.litAnim.get(p.id) ?? (p.lit ? 1 : 0);
      this.litAnim.set(p.id, damp(la, p.lit ? 1 : 0, (1 / REF.irisTime) * 3, dt));

      const prevL = this.prevLight.get(p.id);
      if (prevL !== undefined && p.light > prevL + 0.4) this.eatPulse.set(p.id, 1);
      this.prevLight.set(p.id, p.light);
      const ep = this.eatPulse.get(p.id) ?? 0;
      if (ep > 0) this.eatPulse.set(p.id, Math.max(0, ep - dt * 4));

      const prev = this.prevPos.get(p.id);
      let heading = prev?.heading ?? 0;
      if (prev) {
        const dx = p.x - prev.x, dy = p.y - prev.y;
        if (Math.hypot(dx, dy) > 0.5) heading = Math.atan2(dy, dx);
      }
      this.prevPos.set(p.id, { x: p.x, y: p.y, heading });
    }

    // ---- own vision iris (linear contraction over irisTime — §5) ----
    if (self) {
      if (this.prevSelfLit !== null && this.prevSelfLit !== self.lit) {
        this.visionStart = this.visionCur;
        this.visionClock = 0;
      }
      this.prevSelfLit = self.lit;
      this.visionClock += dt;
      const target = self.lit ? visionLit(self.light) : REF.darkVision;
      this.visionCur = lerp(this.visionStart, target, clamp(this.visionClock / REF.irisTime, 0, 1));
    } else {
      // dead / spectating: widen slowly
      this.visionCur = damp(this.visionCur, 400, 2, dt);
    }

    // ---- fx lifetimes ----
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i]!;
      f.life -= dt;
      if (f.life <= 0) this.fx.splice(i, 1);
    }

    // ================= draw =================
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, ABYSS_TOP);
    bg.addColorStop(1, ABYSS_BOT);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(W / 2 - this.cam.x, H / 2 - this.cam.y);
    const x0 = this.cam.x - W / 2 - 40, x1 = this.cam.x + W / 2 + 40;
    const y0 = this.cam.y - H / 2 - 40, y1 = this.cam.y + H / 2 + 40;
    const inView = (p: { x: number; y: number }, pad = 0) =>
      p.x > x0 - pad && p.x < x1 + pad && p.y > y0 - pad && p.y < y1 + pad;

    // floor speckle — rim-blue dust that makes motion readable in the dark
    for (const s of this.speckle) {
      if (!inView(s)) continue;
      ctx.fillStyle = RIM(s.a);
      ctx.fillRect(s.x, s.y, 2, 2);
    }

    // plankton field (server only sends what this client may perceive)
    for (const m of frame.motes) {
      if (!inView(m)) continue;
      const phase = (m.id % 97) * 0.7;
      const blink = Math.max(0, Math.sin(t * 1.8 + phase));
      const px = m.x + Math.sin(t * 0.7 + phase) * 6;
      const py = m.y + Math.cos(t * 0.5 + phase) * 5;
      glowPool(ctx, px, py, 6 + blink * 5, PLANKTON, blink * 0.7 + 0.08);
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, TAU);
      ctx.fillStyle = PLANKTON(0.45 + blink * 0.5);
      ctx.fill();
    }

    // loose plasma — spilled wealth
    for (const m of frame.loose) {
      if (!inView(m)) continue;
      const r = 2.2 + Math.sqrt(m.value) * 1.5;
      let a = 0.85;
      if (m.settling) a = Math.sin(t * 24) > 0 ? 0.85 : 0.2;
      const pulse = 0.8 + 0.2 * Math.sin(t * 3 + m.x);
      glowPool(ctx, m.x, m.y, r * 3.2 * pulse, LIFE_BRIGHT, a * 0.6);
      ctx.beginPath();
      ctx.arc(m.x, m.y, r, 0, TAU);
      ctx.fillStyle = LIFE_BRIGHT(a);
      ctx.fill();
    }

    // creatures
    for (const p of frame.players) {
      if (!inView(p, 400)) continue;
      const heading = this.prevPos.get(p.id)?.heading ?? 0;
      const squashK = 1 + 0.10 * clamp(p.speed / 160, 0, 1.5);
      // you are always the signature teal; everyone else wears their own
      // hue from the palette's alive band, derived from their server id
      const hue = p.id === opts.selfId ? LIFE_HUE : playerHue(p.id);
      drawCreature(ctx, t, {
        x: p.x, y: p.y, L: p.light,
        lit: p.lit,
        litAnim: this.litAnim.get(p.id),
        revealT: p.revealT,
        gutter: p.light < REF.gutter,
        shielded: p.shielded,
        seed: p.id % 17,
        eatPulse: this.eatPulse.get(p.id),
        squash: squashK > 1.02 ? { a: heading, k: squashK } : null,
        hue,
      });
      if (p.id === opts.selfId) {
        drawCooldownArc(ctx, p.x, p.y, bodyR(p.light), dashCdFrac);
      } else if (p.lit && self && Math.hypot(p.x - self.x, p.y - self.y) < 420) {
        ctx.font = '12px "Avenir Next", "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = "center";
        ctx.fillStyle = BRIGHT_OF(hue, 0.55);
        ctx.fillText(p.name, p.x, p.y - bodyR(p.light) - 10);
      }
    }
    ctx.restore();

    // ---- darkness: every glow in the world cuts it — light travels (§6) ----
    const lights: { x: number; y: number; r: number; a: number }[] = [];
    if (self) lights.push({ x: self.x, y: self.y, r: this.visionCur, a: 1 });
    else lights.push({ x: this.cam.x, y: this.cam.y, r: this.visionCur, a: 0.9 });
    for (const p of frame.players) {
      const la = this.litAnim.get(p.id) ?? (p.lit ? 1 : 0);
      const gr = lerp(
        glowIrr(p.light),
        p.revealT > 0 ? glowRevealed(p.light) : glowLit(p.light),
        Math.max(la, p.revealT > 0 ? 1 : 0),
      );
      const strobe = p.light < REF.gutter ? (Math.sin(t * 22 + p.id) > -0.3 ? 1 : 0.25) : 1;
      if (gr > 1) lights.push({ x: p.x, y: p.y, r: gr, a: 0.9 * strobe });
    }
    for (const f of this.fx) {
      if (f.type !== "stain" && f.type !== "flash") continue;
      const p = f.life / f.max;
      lights.push({ x: f.x, y: f.y, r: f.r, a: 0.8 * p });
    }

    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.globalCompositeOperation = "source-over";
    dctx.fillStyle = DARKNESS;
    dctx.fillRect(0, 0, W, H);
    dctx.globalCompositeOperation = "destination-out";
    for (const li of lights) {
      const lx = li.x - this.cam.x + W / 2, ly = li.y - this.cam.y + H / 2;
      if (lx + li.r < 0 || lx - li.r > W || ly + li.r < 0 || ly - li.r > H) continue;
      const g = dctx.createRadialGradient(lx, ly, 0, lx, ly, li.r);
      g.addColorStop(0, `rgba(255,255,255,${li.a})`);
      g.addColorStop(0.7, `rgba(255,255,255,${li.a * 0.7})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      dctx.fillStyle = g;
      dctx.beginPath();
      dctx.arc(lx, ly, li.r, 0, TAU);
      dctx.fill();
    }
    ctx.drawImage(this.darkCanvas, 0, 0, this.darkCanvas.width, this.darkCanvas.height, 0, 0, W, H);

    // ---- above the darkness ----
    ctx.save();
    ctx.translate(W / 2 - this.cam.x, H / 2 - this.cam.y);

    for (const f of this.fx) {
      const p = f.life / f.max;
      if (f.type === "wake") {
        ctx.beginPath();
        ctx.arc(f.x, f.y, lerp(f.r1 ?? f.r + 30, f.r, p), 0, TAU);
        ctx.strokeStyle = RIM((1 - p) * 0.05 + p * 0.25);
        ctx.lineWidth = 1.4;
        ctx.stroke();
      } else if (f.type === "spark") {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU + f.x * 0.01;
          const rr = (1 - p) * f.r + 5;
          ctx.beginPath();
          ctx.arc(f.x + Math.cos(a) * rr, f.y + Math.sin(a) * rr, 2.2 * p + 0.6, 0, TAU);
          ctx.fillStyle = HARM(p);
          ctx.fill();
        }
      } else if (f.type === "burst") {
        ctx.beginPath();
        ctx.arc(f.x, f.y, (1 - p) * f.r, 0, TAU);
        ctx.strokeStyle = HARM(p * 0.9);
        ctx.lineWidth = 3 + 5 * p;
        ctx.stroke();
      }
    }

    // boundary — the only warm color in the world, sensed within 300 units (§5)
    const anchor = self ?? this.cam;
    const bs = REF.boundarySense;
    const sides = [
      { d: anchor.x, x0: 0, y0: 0, x1: 0, y1: this.worldSize },
      { d: this.worldSize - anchor.x, x0: this.worldSize, y0: 0, x1: this.worldSize, y1: this.worldSize },
      { d: anchor.y, x0: 0, y0: 0, x1: this.worldSize, y1: 0 },
      { d: this.worldSize - anchor.y, x0: 0, y0: this.worldSize, x1: this.worldSize, y1: this.worldSize },
    ];
    for (const s of sides) {
      const a = clamp(1 - s.d / bs, 0, 1);
      if (a <= 0.01) continue;
      const pulse = 0.7 + 0.3 * Math.sin(t * 2.4);
      ctx.strokeStyle = HARM(a * 0.9 * pulse);
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
    }
    ctx.restore();

    // drop cosmetic state for players no longer in view — these Maps are keyed
    // by player id and would otherwise grow unbounded as players enter and leave
    // perception over a long session
    this.pruneCosmeticState(frame.players);
  }

  private pruneCosmeticState(players: InterpolatedPlayer[]): void {
    const live = new Set<number>();
    for (const p of players) live.add(p.id);
    for (const m of [
      this.litAnim, this.eatPulse, this.prevLight, this.prevPos,
    ]) {
      for (const id of m.keys()) if (!live.has(id)) m.delete(id);
    }
  }
}
