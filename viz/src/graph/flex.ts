// Living tubes for the Network map (user 2026-11-04: "more flexible, limber,
// feels like tube expanding"). Layout and motion only; no data:
// - Shape: a tube is a filled body, not a line. It flares where it meets a
//   plain spore, like a Physarum junction; where it leaves a spore's art it
//   starts at the art's own vein width and thickens to √D (`taper`). Its
//   width at rest is still √D (`tubeWidth`).
// - Ambient (off under reduced motion): a peristaltic wave runs along each
//   tube and reverses every `--t-stream`, as Physarum shuttle-streams (the
//   shell veins do the same); widths breathe on `--t-breathe`, rolling round
//   the ring; each curve sways a few px. The mean width stays √D.
// - Expansion (a confirmed close, §3.5): a tube that grew or was born swells,
//   a bulge running in from both spores to the middle over `--t-epoch`.
import { curvePoint, type Curve, type PairKey, type Pt } from '../model/network';
import { hex, motion, palettes } from '../ui/tokens';

/** Peak sway of a curve's control point, px (inside the 6 px tube hit tolerance). */
const SWAY_PX = 3.5;
/** Ambient wave: share of the width, and wavelength along the tube, px. */
const WAVE_AMP = 0.22;
const WAVE_PX = 90;
/** The wave travels this many radians each way per shuttle leg. */
const WAVE_TRAVEL = 16 * Math.PI;
const BREATHE_AMP = 0.12;
/** Junction flare: extra width at each end, and how far along the tube it reaches (share of the tube). */
const FLARE = 0.9;
const FLARE_REACH = 0.07;
/** Close swell: extra width at the bulge, and its half-length (share of the tube). */
const SWELL = 1.4;
const SWELL_REACH = 0.08;

export interface FlexClock {
  now: number;
  /** false under reduced motion: the shape stays, nothing moves. */
  ambient: boolean;
}

export const STILL: FlexClock = { now: 0, ambient: false };

export const stopOf = (palette: number, i: number) => hex((palettes[palette] ?? palettes[0]).stops[i]);

/** A tube in the art's vein layers (renderer palette stops): a dark halo, the accent body, a bright core. */
export const VEIN = [
  { stop: 2, width: 2.2, alpha: 0.35 },
  { stop: 3, width: 1, alpha: 1 },
  { stop: 4, width: 0.35, alpha: 0.9 },
] as const;

export function rgba(hexColor: string, a: number): string {
  const n = parseInt(hexColor.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a))})`;
}

/** A stable per-tube phase, so tubes don't move in unison. */
export const phaseOf = (k: PairKey) => (((k * 2654435761) >>> 0) % 4096) * ((Math.PI * 2) / 4096);

/** The curve with its control point swayed sideways. The same in either direction of the pair. */
export function sway(q: Curve, k: PairKey, clock: FlexClock): Curve {
  if (!clock.ambient) return q;
  // Order the ends the same way whichever direction the curve runs.
  const [a, b] = q.p0.x < q.p1.x || (q.p0.x === q.p1.x && q.p0.y <= q.p1.y) ? [q.p0, q.p1] : [q.p1, q.p0];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return q;
  const amp = Math.min(SWAY_PX, 0.03 * len) * Math.sin((Math.PI * clock.now) / (1.6 * motion.breathe) + phaseOf(k));
  const ox = -(dy / len) * amp;
  const oy = (dx / len) * amp;
  return { p0: q.p0, c0: { x: q.c0.x + ox, y: q.c0.y + oy }, c1: { x: q.c1.x + ox, y: q.c1.y + oy }, p1: q.p1 };
}

export interface BodyOpts {
  /** Width at rest, px (`tubeWidth`). */
  width: number;
  k: PairKey;
  /** Mid-angle of the tube on the ring, radians: the breath rolls round the ring by it. */
  angle: number;
  /** 0–1 share drawn (a new tube draws in from both ends). */
  reveal: number;
  /** 0–1 close progress for a tube that grew or was born; 0 otherwise. */
  swell: number;
  clock: FlexClock;
  /** Width at each end as a share of `width` where the tube leaves a spore's art (the art's vein); null = the junction flare. */
  taper?: [number | null, number | null];
  /** Most samples along the body (default 48); a long tube needs more to keep the wave smooth. */
  steps?: number;
}

/** How far along the tube (share) an end tapers from the art's vein to the full width. */
const TAPER_REACH = 0.18;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Width multiplier at `u` along a tube `len` px long (0 at one spore, 1 at the other). */
export function profile(u: number, len: number, o: Omit<BodyOpts, 'width' | 'reveal'>): number {
  const [ta, tb] = o.taper ?? [null, null];
  let m = 1;
  if (ta === null) m += FLARE * Math.exp(-((u / FLARE_REACH) ** 2));
  else m *= ta + (1 - ta) * smooth(u / TAPER_REACH);
  if (tb === null) m += FLARE * Math.exp(-(((1 - u) / FLARE_REACH) ** 2));
  else m *= tb + (1 - tb) * smooth((1 - u) / TAPER_REACH);
  if (o.clock.ambient) {
    const shuttle = WAVE_TRAVEL * Math.sin((Math.PI * o.clock.now) / motion.stream);
    m *= 1 + WAVE_AMP * Math.sin((2 * Math.PI * u * len) / WAVE_PX - shuttle + phaseOf(o.k));
    m *= 1 + BREATHE_AMP * Math.sin((Math.PI * o.clock.now) / motion.breathe + o.angle);
  }
  if (o.swell > 0 && o.swell < 1) {
    const s = 0.5 * o.swell;
    const dist = Math.min(Math.abs(u - s), Math.abs(u - (1 - s)));
    m *= 1 + SWELL * Math.sin(Math.PI * o.swell) * Math.exp(-((dist / SWELL_REACH) ** 2));
  }
  return m;
}

function tangent(q: Curve, u: number): Pt {
  const v = 1 - u;
  const x = 3 * v * v * (q.c0.x - q.p0.x) + 6 * v * u * (q.c1.x - q.c0.x) + 3 * u * u * (q.p1.x - q.c1.x);
  const y = 3 * v * v * (q.c0.y - q.p0.y) + 6 * v * u * (q.c1.y - q.c0.y) + 3 * u * u * (q.p1.y - q.c1.y);
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

function approxLength(q: Curve): number {
  let len = 0;
  let prev = q.p0;
  for (let i = 1; i <= 8; i++) {
    const p = curvePoint(q, i / 8);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

/** Adds the tube's body from u0 to u1 as one closed subpath. */
function bodyPath(ctx: CanvasRenderingContext2D, q: Curve, u0: number, u1: number, len: number, o: BodyOpts) {
  const n = Math.max(6, Math.min(o.steps ?? 48, Math.ceil(((u1 - u0) * len) / 6)));
  const right: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n;
    const p = curvePoint(q, u);
    const t = tangent(q, u);
    const h = (o.width / 2) * profile(u, len, o);
    if (i === 0) ctx.moveTo(p.x - t.y * h, p.y + t.x * h);
    else ctx.lineTo(p.x - t.y * h, p.y + t.x * h);
    right.push({ x: p.x + t.y * h, y: p.y - t.x * h });
  }
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
  ctx.closePath();
}

/** Fills the tube's living body with the current fill style. */
export function fillTube(ctx: CanvasRenderingContext2D, q: Curve, o: BodyOpts) {
  const len = approxLength(q);
  ctx.beginPath();
  if (o.reveal >= 1) bodyPath(ctx, q, 0, 1, len, o);
  else {
    const half = Math.max(0, o.reveal) / 2;
    bodyPath(ctx, q, 0, half, len, o);
    bodyPath(ctx, q, 1 - half, 1, len, o);
  }
  ctx.fill();
}
