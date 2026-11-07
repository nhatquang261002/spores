// Canvas drawing for the Network explorer (Design §6.C). One 2D canvas: the
// ring and its ticks, the tubes (curves bowed toward the centre, width ∝ √D,
// brightness ∝ D, drawn like the art's veins in the two endpoint palettes),
// the nodes (each spore's whole art, keyed onto the dish, graph/nodeArt.ts;
// a tube leaves a spore at its partner's disc in that art, in the art's vein
// direction and at the vein's width), the Show change overlays, and the step
// particles (each one a logged or confirmed step; see graph/particles.ts).
// Colours come from tokens.ts only.
import {
  ART_SIDE,
  artEnds,
  curvePoint,
  nodeRadius,
  organismSide,
  pairKey,
  pairOf,
  ringPos,
  tubeAlpha,
  tubeCurve,
  tubeWidth,
  type Curve,
  type FrameDiff,
  type PairKey,
  type Pt,
  type TweenTube,
  type View,
} from '../model/network';
import { color, hex, motion, palettes } from '../ui/tokens';
import { fillTube, rgba, stopOf, sway, VEIN, type BodyOpts, type FlexClock } from './flex';
import { drawParticle, type Particle } from './particles';

export type Selection = { kind: 'node'; id: number } | { kind: 'tube'; k: PairKey } | null;

export interface NodeDraw {
  id: number;
  active: boolean;
  /** R (REP_ONE = 1000), animated between frames. */
  rep: number;
  degree: number;
  palette: number;
  paused: boolean;
  listed: boolean;
  /** The spore's art (glyph, then the rendered image, keyed); null = the plain node. */
  art: CanvasImageSource | null;
  /** Partner → art px from the nucleus to that partner's disc in this spore's art (`artReach`); null = no art input. */
  reach: Map<number, number> | null;
}

export interface Scene {
  /** CSS pixels. */
  w: number;
  h: number;
  dpr: number;
  view: View;
  tubes: TweenTube[];
  dMax: number;
  rMax: number;
  nodes: NodeDraw[];
  selection: Selection;
  hover: Selection;
  /** Show change: what the last close did to each tube (null when off). */
  diff: FrameDiff | null;
  labels: 'selected' | 'all';
  /** The slot numbers round the ring; the compact map leaves them to the explorer. */
  slotLabels?: boolean;
  particles: Particle[];
  now: number;
  /** Ambient tube motion (graph/flex.ts); false under reduced motion. */
  ambient: boolean;
}

export const accentOf = (palette: number) => hex(palettes[palette]?.stops[3] ?? palettes[0].stops[3]);
/** Past this many tubes the map draws each with one layer: the most a real run has shown is far below it. */
export const DENSE_TUBES = 400;
const DENSE_STEPS = 10;
/** The tube's body: the layer that remains on a crowded map. */
const BODY_STOP = 3;
/** Width of a vein in the art, art px: a tube starts this wide where it leaves the art. */
const ART_VEIN_PX = 7;

/** The breath that rolls round the ring (tubes and nodes share it), −1…1. */
const breathAt = (now: number, angle: number) => Math.sin((Math.PI * now) / motion.breathe + angle);

/** World layout: centre and ring radius (42% of the short side, less on narrow screens so the slot labels fit). */
export function layout(w: number, h: number) {
  const m = Math.min(w, h);
  return { cx: w / 2, cy: h / 2, r: Math.max(0, Math.min(0.42 * m, m / 2 - 34)) };
}

export { rgba };

export function strokeCurve(ctx: CanvasRenderingContext2D, q: Curve) {
  ctx.beginPath();
  ctx.moveTo(q.p0.x, q.p0.y);
  ctx.bezierCurveTo(q.c0.x, q.c0.y, q.c1.x, q.c1.y, q.p1.x, q.p1.y);
  ctx.stroke();
}

/** Nodes and tubes tied to the selection (they stay at full opacity; the rest drops to 20%). */
export function related(sel: Selection, tubes: Iterable<PairKey>): { nodes: Set<number>; tubes: Set<PairKey> } | null {
  if (!sel) return null;
  const nodes = new Set<number>();
  const ts = new Set<PairKey>();
  if (sel.kind === 'tube') {
    const [a, b] = pairOf(sel.k);
    nodes.add(a).add(b);
    ts.add(sel.k);
    return { nodes, tubes: ts };
  }
  nodes.add(sel.id);
  for (const k of tubes) {
    const [a, b] = pairOf(k);
    if (a === sel.id || b === sel.id) {
      ts.add(k);
      nodes.add(a).add(b);
    }
  }
  return { nodes, tubes: ts };
}

export function draw(ctx: CanvasRenderingContext2D, s: Scene) {
  const { cx, cy, r } = layout(s.w, s.h);
  const v = s.view;
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  ctx.clearRect(0, 0, s.w, s.h);
  ctx.setTransform(s.dpr * v.scale, 0, 0, s.dpr * v.scale, s.dpr * v.tx, s.dpr * v.ty);
  const hair = 1 / v.scale;
  const accents = new Map(s.nodes.map((n) => [n.id, accentOf(n.palette)]));
  const pal = new Map(s.nodes.map((n) => [n.id, n.palette]));
  const rel = related(
    s.selection,
    s.tubes.filter((t) => t.fade > 0.5).map((t) => t.k),
  );
  const clock: FlexClock = { now: s.now, ambient: s.ambient };
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  // Each spore's art on the map: its side, and where it puts each partner.
  const side = new Map(s.nodes.map((n) => [n.id, organismSide(r, n.rep, s.rMax)]));
  const ends = artEnds(
    (id) => (byId.get(id)?.active ? byId.get(id)?.reach : null),
    (id) => side.get(id) ?? 0,
  );
  // Every tube, overlay and bead follows the same living curve.
  const curveOf = (k: PairKey) => {
    const [a, b] = pairOf(k);
    return sway(tubeCurve(a, b, cx, cy, r, ends), k, clock);
  };

  // The dish: the ring (it breathes with the tubes; the slots stay fixed, §1.2) and its ticks every 8 slots.
  ctx.lineWidth = hair;
  ctx.strokeStyle = color.line;
  ctx.beginPath();
  if (s.ambient) {
    const breath = Math.sin((Math.PI * s.now) / motion.breathe);
    const roll = (Math.PI * s.now) / motion.stream;
    ctx.lineWidth = hair * (1.25 + 0.5 * breath);
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      const rr = r + 1.5 * Math.sin(5 * a + roll) + 0.8 * breath;
      if (i === 0) ctx.moveTo(cx + rr * Math.sin(a), cy - rr * Math.cos(a));
      else ctx.lineTo(cx + rr * Math.sin(a), cy - rr * Math.cos(a));
    }
  } else ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  for (let id = 0; id < 64; id += 8) {
    const a = ringPos(id, cx, cy, r + 8);
    const b = ringPos(id, cx, cy, r + 14);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Tubes, weakest first so the strong ones sit on top.
  const order = [...s.tubes].sort((x, y) => x.d - y.d);
  ctx.lineCap = 'round';
  // A crowded map keeps its frame rate with one layer per tube and fewer points on each. The width, the
  // brightness and the positions are the same data; only the halo and the bright core go (Design §10).
  const dense = order.length > DENSE_TUBES;
  const layers = dense ? VEIN.filter((l) => l.stop === BODY_STOP) : VEIN;
  for (const t of order) {
    if (t.fade <= 0.001 || t.reveal <= 0.001) continue;
    const [a, b] = pairOf(t.k);
    const q = curveOf(t.k);
    const dim = rel && !rel.tubes.has(t.k) ? 0.2 : 1;
    const alpha = tubeAlpha(t.d, s.dMax) * t.fade * dim;
    // A living body: flared at the spores, width √D at rest; a new tube draws in from both ends.
    const width = tubeWidth(t.d, s.dMax);
    // Where it leaves a spore's art it starts at the art's vein width.
    const vein = (id: number, p: number) => (ends(id, p) ? ((side.get(id) ?? 0) * ART_VEIN_PX) / ART_SIDE / width : null);
    const body: BodyOpts = { width, k: t.k, angle: ((a + b) * Math.PI) / 64, reveal: t.reveal, swell: t.swell, clock, taper: [vein(a, b), vein(b, a)], ...(dense ? { steps: DENSE_STEPS } : {}) };
    for (const layer of layers) {
      const w = body.width * layer.width;
      if (layer.stop === 4 && w < 0.6 * hair) continue;
      const g = ctx.createLinearGradient(q.p0.x, q.p0.y, q.p1.x, q.p1.y);
      g.addColorStop(0, rgba(stopOf(pal.get(a) ?? 0, layer.stop), alpha * layer.alpha));
      g.addColorStop(1, rgba(stopOf(pal.get(b) ?? 0, layer.stop), alpha * layer.alpha));
      ctx.fillStyle = g;
      if (layer.stop === BODY_STOP && t.glow > 0.01 && !dense) {
        ctx.shadowColor = rgba(accents.get(a) ?? color.growth, 0.6 * t.glow);
        ctx.shadowBlur = 12 * t.glow * s.dpr * v.scale;
      }
      fillTube(ctx, q, { ...body, width: w });
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
    if (s.hover?.kind === 'tube' && s.hover.k === t.k) {
      ctx.lineWidth = hair;
      ctx.strokeStyle = rgba(color.text, 0.8);
      strokeCurve(ctx, q);
    }
  }

  // Show change overlays (this close against the one before).
  if (s.diff) {
    ctx.lineWidth = hair;
    for (const [k, c] of s.diff.change) {
      const q = curveOf(k);
      const dim = rel && !rel.tubes.has(k) ? 0.2 : 1;
      if (c === 'grew' || c === 'new') {
        ctx.strokeStyle = rgba(color.growth, 0.95 * dim);
        if (c === 'new') ctx.setLineDash([4 * hair, 3 * hair]);
        strokeCurve(ctx, q);
        ctx.setLineDash([]);
      } else if (c === 'dropped') {
        ctx.strokeStyle = rgba(color.text3, 0.8 * dim);
        ctx.setLineDash([3 * hair, 3 * hair]);
        strokeCurve(ctx, q);
        ctx.setLineDash([]);
      }
    }
    for (const k of s.diff.rejected) {
      const q = curveOf(k);
      const m = curvePoint(q, 0.5);
      const p = curvePoint(q, 0.52);
      const nx = -(p.y - m.y);
      const ny = p.x - m.x;
      const l = Math.hypot(nx, ny) || 1;
      const half = 5 * hair;
      ctx.strokeStyle = color.warn;
      ctx.lineWidth = 1.5 * hair;
      ctx.beginPath();
      ctx.moveTo(m.x - (nx / l) * half, m.y - (ny / l) * half);
      ctx.lineTo(m.x + (nx / l) * half, m.y + (ny / l) * half);
      ctx.stroke();
    }
  }

  // Nodes.
  for (const n of s.nodes) {
    const p = ringPos(n.id, cx, cy, r);
    const dim = rel && !rel.nodes.has(n.id) ? 0.2 : 1;
    const accent = accents.get(n.id)!;
    if (!n.active) {
      ctx.fillStyle = rgba(color.text3, 0.6 * dim);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const core = nodeRadius(n.rep, s.rMax);
    const selected = s.selection?.kind === 'node' && s.selection.id === n.id;
    // The spore itself: its whole art, keyed onto the dish (no disc, no ring), breathing with the ring.
    const breath = s.ambient ? breathAt(s.now, (n.id * Math.PI) / 32) : 0;
    const sd = side.get(n.id) ?? 0;
    const body = 0.42 * sd;
    if (n.art) {
      if (selected) {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, body);
        g.addColorStop(0, rgba(accent, 0.35));
        g.addColorStop(1, rgba(accent, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, body, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = dim * (n.paused ? 0.55 : 1) * (s.ambient ? 0.9 + 0.1 * breath : 1);
      ctx.drawImage(n.art, p.x - sd / 2, p.y - sd / 2, sd, sd);
      ctx.restore();
      if (n.paused) {
        // Paused (policy): a dashed hairline round the body, the plain node's dash.
        ctx.lineWidth = hair;
        ctx.strokeStyle = rgba(accent, 0.8 * dim);
        ctx.setLineDash([3 * hair, 3 * hair]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, body, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      if (selected) {
        ctx.shadowColor = rgba(accent, 0.4);
        ctx.shadowBlur = 12 * s.dpr * v.scale;
        ctx.fillStyle = rgba(accent, 0.4);
        ctx.beginPath();
        ctx.arc(p.x, p.y, core + 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = color.artBg;
      ctx.beginPath();
      ctx.arc(p.x, p.y, core + 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(accent, dim);
      if (n.paused) ctx.setLineDash([2.5, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = n.degree > 0 ? rgba(color.text, dim) : rgba(accent, 0.35 * dim);
      ctx.beginPath();
      ctx.arc(p.x, p.y, core, 0, Math.PI * 2);
      ctx.fill();
    }
    const outer = n.art ? body : core;
    if (n.listed) {
      const a = ringPos(n.id, cx, cy, r + outer + 5);
      const b = ringPos(n.id, cx, cy, r + outer + 10);
      ctx.strokeStyle = rgba(color.value, dim);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    if (s.hover?.kind === 'node' && s.hover.id === n.id && !selected) {
      ctx.lineWidth = hair;
      ctx.strokeStyle = rgba(color.text, 0.7);
      ctx.beginPath();
      ctx.arc(p.x, p.y, outer + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Steps in flight.
  const path = (from: number, to: number) => sway(tubeCurve(from, to, cx, cy, r, ends), pairKey(from, to), clock);
  for (const pt of s.particles) drawParticle(ctx, pt, s.now, { cx, cy, r, hair, accents, rMax: s.rMax, nodes: s.nodes, path });

  // Labels in screen space, so they stay 11 px at any zoom.
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  ctx.font = '400 11px "Geist Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const screen = (p: Pt): Pt => ({ x: p.x * v.scale + v.tx, y: p.y * v.scale + v.ty });
  ctx.fillStyle = color.text3;
  if (s.slotLabels !== false) {
    for (let id = 0; id < 64; id += 8) {
      const p = screen(ringPos(id, cx, cy, r + 26));
      ctx.fillText(String(id), p.x, p.y);
    }
  }
  const named = new Set<number>();
  if (s.labels === 'all') for (const n of s.nodes) if (n.active && n.id % 8 !== 0) named.add(n.id);
  if (rel) for (const id of rel.nodes) named.add(id);
  if (s.hover?.kind === 'node') named.add(s.hover.id);
  for (const id of named) {
    const p = screen(ringPos(id, cx, cy, r));
    const o = screen(ringPos(id, cx, cy, r + 1));
    const dx = o.x - p.x;
    const dy = o.y - p.y;
    const l = Math.hypot(dx, dy) || 1;
    ctx.fillStyle = s.selection?.kind === 'node' && s.selection.id === id ? color.text : color.text2;
    ctx.fillText(`#${id}`, p.x + (dx / l) * 18, p.y + (dy / l) * 18);
  }
}
