// The Rogue stage (Demo Lab, S11): the spore in its dish, the contract drawn
// as a membrane round it, its real tubes running out through the membrane, and
// the agent's attempts as pseudopods pressing against it. Geometry and paint
// only; every pose comes from a logged event (model/scene.ts).
//
// Partners sit at their ring slots, the angle the art itself puts their discs
// at (Design §1.2), fanned out just enough that neighbours don't overlap. The
// gates are placed in the free part of the ring, so an attempt never crosses a
// tube.
import { curvePoint, slotDir, SLOTS, type Curve, type Pt } from '../model/network';
import { color, hex, motion, palettes, paletteOf } from '../ui/tokens';
import { fillTube, phaseOf, rgba, VEIN, type FlexClock } from './flex';

const TAU = Math.PI * 2;
const slotAngle = (id: number) => ((id % SLOTS) * TAU) / SLOTS;
const dirOf = (a: number): Pt => ({ x: Math.sin(a), y: -Math.cos(a) });
const norm = (a: number) => ((a % TAU) + TAU) % TAU;
/** Shortest way round from a to b. */
export const angleGap = (a: number, b: number) => {
  const d = Math.abs(norm(a) - norm(b));
  return Math.min(d, TAU - d);
};

/** Keeps order and spreads neighbours to at least `minGap` radians. Ids stay on their side of the ring. */
export function fanOut(angles: { id: number; a: number }[], minGap: number): Map<number, number> {
  const sorted = [...angles].sort((x, y) => x.a - y.a);
  const out = sorted.map((p) => p.a);
  for (let pass = 0; pass < 12; pass++) {
    for (let i = 1; i < out.length; i++) {
      const short = minGap - (out[i] - out[i - 1]);
      if (short > 0) {
        out[i - 1] -= short / 2;
        out[i] += short / 2;
      }
    }
  }
  return new Map(sorted.map((p, i) => [p.id, norm(out[i])]));
}

export interface Gates {
  cap: number;
  budget: number;
  drain: number;
  provider: number;
  attacker: number;
  /** Free wall for the words "the contract". */
  wall: number;
  partners: Map<number, number>;
}

/** Where everything sits on the ring (radians, clockwise from 12 o'clock). */
export function gateLayout(partners: number[], provider: number): Gates {
  const pa = slotAngle(provider);
  const fan = fanOut(partners.map((id) => ({ id, a: slotAngle(id) })), (20 * Math.PI) / 180);
  const spread = (26 * Math.PI) / 180;
  const cap = norm(pa + spread);
  const budget = norm(pa - spread);
  // The attacker goes in the middle of the widest free arc.
  const taken = [...fan.values(), cap, budget].map(norm).sort((a, b) => a - b);
  let attacker = norm(pa + Math.PI);
  let widest = -1;
  taken.forEach((a, i) => {
    const b = i + 1 < taken.length ? taken[i + 1] : taken[0] + TAU;
    const mid = norm((a + b) / 2);
    // Ties go to the left of the dish, where the eye starts.
    const gap = b - a + (mid > Math.PI ? 1e-6 : 0);
    if (gap > widest) {
      widest = gap;
      attacker = mid;
    }
  });
  // The words go in the widest arc left once the attacker has its place.
  const rest = [...taken, attacker].sort((a, b) => a - b);
  let wall = norm(attacker + Math.PI);
  let free = -1;
  rest.forEach((a, i) => {
    const b = i + 1 < rest.length ? rest[i + 1] : rest[0] + TAU;
    if (b - a > free) {
      free = b - a;
      wall = norm((a + b) / 2);
    }
  });
  return { cap, budget, drain: attacker, provider: pa, attacker, wall, partners: fan };
}

export interface StageMetrics {
  cx: number;
  cy: number;
  /** Half of the shorter side. */
  u: number;
  /** Radius of the art's edge, of the membrane, and of the ring of other spores. */
  artR: number;
  membraneR: number;
  ringR: number;
  dishR: number;
}

export function metrics(w: number, h: number): StageMetrics {
  const u = Math.min(w, h) / 2;
  return { cx: w / 2, cy: h / 2, u, artR: u * 0.46, membraneR: u * 0.52, ringR: u * 0.78, dishR: u * 0.975 };
}

export const onRing = (m: StageMetrics, angle: number, r: number): Pt => {
  const d = dirOf(angle);
  return { x: m.cx + d.x * r, y: m.cy + d.y * r };
};

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** Where an allowed price waits while it's in escrow: past the wall, part of the way to the provider, clear of the gate's notes. */
export function escrowPoint(m: StageMetrics, gate: number, provider: number): Pt {
  let d = norm(provider - gate);
  if (d > Math.PI) d -= TAU;
  return onRing(m, gate + d * 0.62, m.membraneR + (m.ringR - m.membraneR) * 0.5);
}

/** How long an attempt takes to reach the membrane, ms. */
export const REACH_MS = motion.epoch;
/** Retreat after a refusal. */
export const RETREAT_MS = motion.art;

export interface MembraneBulge {
  angle: number;
  /** Outward push, px. */
  push: number;
  /** 0–1: how far the membrane has parted here (an allowed payment passes through). */
  part: number;
  /** 0–1: a refusal's flash. */
  flash: number;
}

const BULGE_WIDTH = 0.26;

export function membraneAt(m: StageMetrics, theta: number, bulges: MembraneBulge[], clock: FlexClock): { r: number; w: number } {
  let r = m.membraneR;
  let w = Math.max(2, m.u * 0.012);
  if (clock.ambient) {
    r += m.u * 0.006 * Math.sin(3 * theta + clock.now / 2200) + m.u * 0.004 * Math.sin(5 * theta - clock.now / 3100);
    const shuttle = 16 * Math.PI * Math.sin((Math.PI * clock.now) / motion.stream);
    w *= 1 + 0.22 * Math.sin(14 * theta - shuttle);
    w *= 1 + 0.12 * Math.sin((Math.PI * clock.now) / motion.breathe + theta);
  }
  for (const b of bulges) {
    const d = angleGap(theta, b.angle);
    const g = Math.exp(-((d / BULGE_WIDTH) ** 2));
    r += b.push * g;
    // A push thins the wall where it stretches; a passage opens it.
    w *= 1 - 0.45 * clamp01(b.push / (m.u * 0.1)) * g;
    if (b.part > 0) w *= 1 - b.part * Math.exp(-((d / 0.09) ** 2));
  }
  return { r, w };
}

function ringPath(ctx: CanvasRenderingContext2D, m: StageMetrics, bulges: MembraneBulge[], clock: FlexClock, scale: number) {
  const N = 240;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * TAU;
    const { r, w } = membraneAt(m, t, bulges, clock);
    const d = dirOf(t);
    const p = r + (w * scale) / 2;
    if (i === 0) ctx.moveTo(m.cx + d.x * p, m.cy + d.y * p);
    else ctx.lineTo(m.cx + d.x * p, m.cy + d.y * p);
  }
  for (let i = N; i >= 0; i--) {
    const t = (i / N) * TAU;
    const { r, w } = membraneAt(m, t, bulges, clock);
    const d = dirOf(t);
    const p = r - (w * scale) / 2;
    ctx.lineTo(m.cx + d.x * p, m.cy + d.y * p);
  }
  ctx.closePath();
}

export function drawMembrane(ctx: CanvasRenderingContext2D, m: StageMetrics, bulges: MembraneBulge[], clock: FlexClock, alpha: number) {
  for (const layer of [
    { scale: 3.4, a: 0.16, c: color.slime },
    { scale: 1, a: 0.9, c: color.slime },
    { scale: 0.3, a: 0.6, c: color.text },
  ]) {
    ringPath(ctx, m, bulges, clock, layer.scale);
    ctx.fillStyle = rgba(layer.c, layer.a * alpha);
    ctx.fill();
  }
  // A refusal flashes the wall where it was hit, in the colour of a refusal.
  for (const b of bulges) {
    if (b.flash <= 0) continue;
    const span = BULGE_WIDTH * 1.5;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const t = b.angle - span + (i / 40) * span * 2;
      const { r } = membraneAt(m, t, bulges, clock);
      const d = dirOf(t);
      if (i === 0) ctx.moveTo(m.cx + d.x * r, m.cy + d.y * r);
      else ctx.lineTo(m.cx + d.x * r, m.cy + d.y * r);
    }
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(3, m.u * 0.022);
    ctx.strokeStyle = rgba(color.warn, b.flash);
    ctx.stroke();
  }
}

/** A curve from the art to the membrane at a gate, bowed slightly so it reads as grown, not ruled. */
export function podCurve(m: StageMetrics, angle: number, reachR: number): Curve {
  const inner = m.artR * 0.42;
  const p0 = onRing(m, angle, inner);
  const p1 = onRing(m, angle, reachR);
  const side = dirOf(angle + Math.PI / 2);
  const bow = (reachR - inner) * 0.16;
  const mid = (t: number) => {
    const r = inner + (reachR - inner) * t;
    const p = onRing(m, angle, r);
    return { x: p.x + side.x * bow, y: p.y + side.y * bow };
  };
  return { p0, c0: mid(0.33), c1: mid(0.66), p1 };
}

/** The first `u` (0–1) of a cubic (de Casteljau). */
export function subCurve(q: Curve, u: number): Curve {
  const lerp = (a: Pt, b: Pt): Pt => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  const a = lerp(q.p0, q.c0);
  const b = lerp(q.c0, q.c1);
  const c = lerp(q.c1, q.p1);
  const d = lerp(a, b);
  const e = lerp(b, c);
  return { p0: q.p0, c0: a, c1: d, p1: lerp(d, e) };
}

export function drawBead(ctx: CanvasRenderingContext2D, p: Pt, r: number, alpha = 1) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 1.9, 0, TAU);
  ctx.fillStyle = rgba(color.value, 0.22 * alpha);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, TAU);
  ctx.fillStyle = rgba(color.value, alpha);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 0.42, 0, TAU);
  ctx.fillStyle = rgba(color.text, alpha);
  ctx.fill();
}

export function drawPod(ctx: CanvasRenderingContext2D, q: Curve, reach: number, width: number, k: number, clock: FlexClock, bead: { r: number; label: string | null } | null) {
  if (reach <= 0.002) return;
  const part = reach >= 0.999 ? q : subCurve(q, reach);
  const base = { k, angle: 0, reveal: 1, swell: 0, clock, taper: [0.5, 0.35] as [number, number] };
  for (const layer of [
    { w: 2.3, a: 0.2, c: color.agent },
    { w: 1, a: 0.95, c: color.agent },
    { w: 0.32, a: 0.65, c: color.text },
  ]) {
    ctx.fillStyle = rgba(layer.c, layer.a);
    fillTube(ctx, part, { ...base, width: width * layer.w });
  }
  if (bead) {
    const tip = part.p1;
    drawBead(ctx, tip, bead.r);
    if (bead.label) {
      // Set back along the pseudopod, inside the wall, on a plate of the dish's own colour so the art doesn't eat it.
      const back = curvePoint(q, Math.max(0, reach - 0.28));
      ctx.font = `500 ${Math.max(12, bead.r * 2)}px "Geist Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 5;
      ctx.strokeStyle = color.surface;
      ctx.strokeText(bead.label, back.x, back.y);
      ctx.fillStyle = color.value;
      ctx.fillText(bead.label, back.x, back.y);
    }
  }
}

export function drawStamp(ctx: CanvasRenderingContext2D, p: Pt, size: number, alpha: number) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = rgba(color.warn, alpha);
  ctx.lineWidth = Math.max(2.5, size * 0.28);
  ctx.beginPath();
  ctx.moveTo(p.x - size, p.y - size);
  ctx.lineTo(p.x + size, p.y + size);
  ctx.moveTo(p.x + size, p.y - size);
  ctx.lineTo(p.x - size, p.y + size);
  ctx.stroke();
  ctx.restore();
}

export function drawRipple(ctx: CanvasRenderingContext2D, p: Pt, r: number, c: string, alpha: number) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, TAU);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = rgba(c, alpha);
  ctx.stroke();
}

/** Width at rest for a tube, against the strongest tube the scene started with, so a fall in D is a fall on screen. */
export const stageTubeWidth = (d: number, dMax: number, u: number) => (u / 300) * 1.7 * (1 + 6 * Math.sqrt(Math.max(0, d) / Math.max(1, dMax)));

/** A tube leaves the art at the partner's slot and grows out to it, bowed like a vein rather than ruled. `lean` picks the side. */
export function tubeCurveTo(m: StageMetrics, sporeSide: number, far: number, farR: number, lean = 1, startR = m.artR * 0.34): Curve {
  const p0 = onRing(m, sporeSide, startR);
  const p1 = onRing(m, far, farR);
  const side = dirOf(far + Math.PI / 2);
  const bow = m.u * 0.11 * lean;
  const c0 = onRing(m, sporeSide, Math.max(startR, m.artR * 0.5) + m.artR * 0.45);
  const c1 = onRing(m, far, farR - m.artR * 0.5);
  return { p0, c0: { x: c0.x + side.x * bow, y: c0.y + side.y * bow }, c1: { x: c1.x - side.x * bow * 0.6, y: c1.y - side.y * bow * 0.6 }, p1 };
}

export function drawTube(ctx: CanvasRenderingContext2D, q: Curve, width: number, brightness: number, seed: string, k: number, clock: FlexClock, ghost: number | null) {
  const pal = paletteOf(seed);
  // Tapered at both ends: it leaves one spore's vein and joins the other's, with no spike at either.
  const base = { k, angle: phaseOf(k), reveal: 1, swell: 0, clock, taper: [0.6, 0.55] as [number, number] };
  if (ghost !== null) {
    // What the tube was at N: the loss is the gap between this outline and the body.
    ctx.fillStyle = rgba(color.lineStrong, 0.28);
    fillTube(ctx, q, { ...base, width: ghost, clock: { now: clock.now, ambient: false } });
  }
  for (const v of VEIN) {
    ctx.fillStyle = rgba(hex(pal.stops[v.stop]), v.alpha * brightness);
    fillTube(ctx, q, { ...base, width: width * v.width });
  }
}

export function drawArt(ctx: CanvasRenderingContext2D, img: CanvasImageSource | null | undefined, p: Pt, side: number, alpha: number) {
  if (!img) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'screen';
  ctx.drawImage(img, p.x - side / 2, p.y - side / 2, side, side);
  ctx.restore();
}

export function drawDish(ctx: CanvasRenderingContext2D, m: StageMetrics) {
  ctx.beginPath();
  ctx.arc(m.cx, m.cy, m.dishR, 0, TAU);
  ctx.fillStyle = color.surface;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = color.line;
  ctx.stroke();
}

/** The account the owner never approved: a hole in the agar, nothing in it. */
export function drawHole(ctx: CanvasRenderingContext2D, p: Pt, r: number) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, TAU);
  ctx.fillStyle = color.bg;
  ctx.fill();
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color.warn;
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Where a tube starts: at the partner's disc in the art. `reach` is `artReach` in art px; the art is drawn `side` wide. */
export const artDiscR = (reach: number, side: number) => (reach / 512) * side;

export function plainNode(ctx: CanvasRenderingContext2D, p: Pt, r: number, seed: string | null) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, TAU);
  ctx.fillStyle = seed ? hex(paletteOf(seed).stops[2]) : hex(palettes[0].stops[1]);
  ctx.fill();
}

export { curvePoint, easeInOut, easeOut, clamp01, dirOf, slotDir };
