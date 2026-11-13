// The Network explorer's model (Design §6.C): the tube set per epoch, how it
// changed at each close, the ring geometry shared with the art (§1.2) and hit
// testing. Pure functions only; the canvas and the loaders sit on top.
//
// Epoch numbering: frame E (closed) holds the tubes after the close of epoch
// E and the flows and rejects settled during E (what that close consumed).
// The `live` frame is the epoch in progress, C: its tubes are the state after
// the close of C − 1 (`edges()`), and its flows are those settled so far.

/** Unordered spore pair, the router's `edge_key` (a < b). */
export type PairKey = number;
export const pairKey = (x: number, y: number): PairKey => (x < y ? x * 1024 + y : y * 1024 + x);
export const pairOf = (k: PairKey): [number, number] => [Math.floor(k / 1024), k % 1024];

export type TubesFrom = 'event' | 'replay' | 'edges' | 'snapshot';

export interface Frame {
  epoch: number;
  kind: 'closed' | 'live';
  /** pair → D (1e6 scale) after this frame's close; null when the source doesn't have it. */
  tubes: Map<PairKey, number> | null;
  tubesFrom: TubesFrom | null;
  /** `[a, b, yocto]` settled during this epoch (undirected, as the chain keeps them); null = unknown. */
  flows: [number, number, string][] | null;
  /** `[a, b, count]` rejected deliveries during this epoch; null = unknown. */
  rejects: [number, number, number][] | null;
  /** Spores active in this epoch; null = unknown. */
  active: number[] | null;
  /** R per spore (Σ isqrt(D)) after this frame's tubes; from the replay, a snapshot or the token views. */
  reputation: Map<number, number> | null;
  /** The close transaction, when the source has it. `fetched`: the app read its outcome. */
  close: { tx: string; fetched: boolean } | null;
  fingerprint: string | null;
  /** Replay check (↻): the replayed fingerprint and tubes against the event; null when not replayed. */
  replay: 'match' | 'mismatch' | null;
  /** What counted the flows: the chain's per-pair totals or the run log's settled jobs. */
  flowsFrom: 'chain' | 'run-log' | null;
}

export interface NetworkHistory {
  /** Closed frames by epoch, 1 … current − 1; missing epochs are absent. */
  frames: Map<number, Frame>;
  /** The epoch in progress (LIVE) or the run's last epoch (LOCAL RUN / RECORDED). */
  current: number;
  live: Frame;
  /** `config.d_min`: tubes below it are not drawn, as the contract drops them. */
  dMin: number;
}

export const emptyFrame = (epoch: number, kind: Frame['kind'] = 'closed'): Frame => ({
  epoch,
  kind,
  tubes: null,
  tubesFrom: null,
  flows: null,
  rejects: null,
  active: null,
  reputation: null,
  close: null,
  fingerprint: null,
  replay: null,
  flowsFrom: null,
});

export function tubesFromTuples(tuples: [number, number, string | number][], dMin = 0): Map<PairKey, number> {
  const m = new Map<PairKey, number>();
  for (const [a, b, d] of tuples) {
    const v = Number(d);
    if (v >= dMin && v > 0) m.set(pairKey(a, b), v);
  }
  return m;
}

/** The frame shown at scrubber position `epoch` (the live frame at `current`). */
export function frameAt(h: NetworkHistory, epoch: number): Frame {
  if (epoch >= h.current) return h.live;
  return h.frames.get(epoch) ?? emptyFrame(epoch);
}

/**
 * The tubes in force *before* frame `f` (the state its close started from):
 * frame E − 1's tubes; for the live frame (whose tubes are C − 1's), C − 2's.
 * Epoch 1 starts from no tubes (GENESIS).
 */
export function previousTubes(h: NetworkHistory, f: Frame): Map<PairKey, number> | null {
  const prev = f.kind === 'live' ? f.epoch - 2 : f.epoch - 1;
  if (prev < 1) return new Map();
  return h.frames.get(prev)?.tubes ?? null;
}

/** The rejects that shaped frame `f`'s tubes: its own for a closed frame, C − 1's for the live one. */
export function shapingRejects(h: NetworkHistory, f: Frame): [number, number, number][] | null {
  if (f.kind === 'closed') return f.rejects;
  return h.frames.get(f.epoch - 1)?.rejects ?? null;
}

// --- change at a close (Show change, the epoch-close summary) --------------

export type TubeChange = 'new' | 'grew' | 'decayed' | 'same' | 'dropped';

export interface FrameDiff {
  change: Map<PairKey, TubeChange>;
  /** Pairs with a rejected delivery in the epoch that produced these tubes. */
  rejected: Set<PairKey>;
  counts: Record<TubeChange, number>;
}

export function diffTubes(prev: Map<PairKey, number>, next: Map<PairKey, number>, rejects: [number, number, number][] | null = null): FrameDiff {
  const change = new Map<PairKey, TubeChange>();
  const counts: Record<TubeChange, number> = { new: 0, grew: 0, decayed: 0, same: 0, dropped: 0 };
  const put = (k: PairKey, c: TubeChange) => {
    change.set(k, c);
    counts[c]++;
  };
  for (const [k, d] of next) {
    const p = prev.get(k);
    put(k, p === undefined ? 'new' : d > p ? 'grew' : d < p ? 'decayed' : 'same');
  }
  for (const k of prev.keys()) if (!next.has(k)) put(k, 'dropped');
  const rejected = new Set<PairKey>((rejects ?? []).map(([a, b]) => pairKey(a, b)));
  return { change, rejected, counts };
}

/** "Epoch 18 closed · 3 tubes grew · 2 decayed · 1 dropped" (Design §3.5, reduced motion). */
export function closeSummary(epoch: number, d: FrameDiff): string {
  const parts = [`Epoch ${epoch} closed`];
  const n = (k: number, w: string) => k > 0 && parts.push(`${k} ${w}`);
  n(d.counts.new, d.counts.new === 1 ? 'new tube' : 'new tubes');
  n(d.counts.grew, d.counts.grew === 1 ? 'tube grew' : 'tubes grew');
  n(d.counts.decayed, 'decayed');
  n(d.counts.dropped, 'dropped');
  if (parts.length === 1) parts.push('no tube changed');
  return parts.join(' · ');
}

// --- per-spore and per-tube reads -------------------------------------------

export interface SporeTube {
  partner: number;
  d: number;
}

/** A spore's tubes in a tube set, strongest first. */
export function tubesOf(tubes: Map<PairKey, number> | null, id: number): SporeTube[] {
  if (!tubes) return [];
  const out: SporeTube[] = [];
  for (const [k, d] of tubes) {
    const [a, b] = pairOf(k);
    if (a === id) out.push({ partner: b, d });
    else if (b === id) out.push({ partner: a, d });
  }
  return out.sort((x, y) => y.d - x.d || x.partner - y.partner);
}

/** D of one pair at every closed epoch: null where the source has no tubes for that epoch. */
export function dSeries(h: NetworkHistory, k: PairKey): { epoch: number; d: number | null }[] {
  const out: { epoch: number; d: number | null }[] = [];
  for (let e = 1; e < h.current; e++) {
    const t = h.frames.get(e)?.tubes;
    out.push({ epoch: e, d: t ? (t.get(k) ?? 0) : null });
  }
  return out;
}

/** Flows of one pair by epoch, from frames whose flows are known. */
export function flowSeries(h: NetworkHistory, k: PairKey): { epoch: number; amount: string; live: boolean }[] {
  const out: { epoch: number; amount: string; live: boolean }[] = [];
  const add = (f: Frame) => {
    for (const [a, b, amt] of f.flows ?? []) if (pairKey(a, b) === k) out.push({ epoch: f.epoch, amount: amt, live: f.kind === 'live' });
  };
  for (let e = 1; e < h.current; e++) {
    const f = h.frames.get(e);
    if (f) add(f);
  }
  add(h.live);
  return out;
}

/** Largest D across every loaded frame, so brightness compares across epochs. */
export function maxD(h: NetworkHistory): number {
  let m = 0;
  for (const f of [...h.frames.values(), h.live]) for (const d of f.tubes?.values() ?? []) if (d > m) m = d;
  return m;
}

export function maxR(h: NetworkHistory): number {
  let m = 0;
  for (const f of [...h.frames.values(), h.live]) for (const r of f.reputation?.values() ?? []) if (r > m) m = r;
  return m;
}

/** Flows per epoch for the scrubber bars: null = no history for that epoch. */
export function flowCounts(h: NetworkHistory): { epoch: number; flows: number | null; tubes: boolean }[] {
  const out: { epoch: number; flows: number | null; tubes: boolean }[] = [];
  for (let e = 1; e < h.current; e++) {
    const f = h.frames.get(e);
    out.push({ epoch: e, flows: f?.flows ? f.flows.length : null, tubes: !!f?.tubes });
  }
  out.push({ epoch: h.current, flows: h.live.flows ? h.live.flows.length : null, tubes: !!h.live.tubes });
  return out;
}

// --- geometry (Design §6.C, §1.2) -------------------------------------------

/** Ring slots: 64, at N·5.625° clockwise from 12 o'clock (renderer `ring_pos`). */
export const SLOTS = 64;
export const RING_FRACTION = 0.42;
/** Tubes bow toward the centre: control = centre + 0.35·(midpoint − centre). Layout, not data. */
export const BOW = 0.35;

export interface Pt {
  x: number;
  y: number;
}

export function ringPos(id: number, cx: number, cy: number, r: number): Pt {
  const a = ((id % SLOTS) * 2 * Math.PI) / SLOTS;
  return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) };
}

/** A cubic Bézier: a tube from p0 to p1 with a handle at each end. */
export interface Curve {
  p0: Pt;
  c0: Pt;
  c1: Pt;
  p1: Pt;
}

/**
 * Where a tube leaves a spore's art (user 2026-11-04: "its tube is the tube"):
 * the offset from the spore's slot to the partner's disc in its art, world
 * px. The art puts each partner at its own slot angle, `artReach` art px from
 * the nucleus; the map draws the 512 px art `side` px wide.
 */
export type TubeEnds = (id: number, partner: number) => Pt | null;

/** Unit vector of slot `id` (clockwise from 12 o'clock, as `ringPos` and the renderer). */
export const slotDir = (id: number): Pt => {
  const a = ((id % SLOTS) * 2 * Math.PI) / SLOTS;
  return { x: Math.sin(a), y: -Math.cos(a) };
};

/**
 * Renderer `nodes()` (renderer/src/sim.rs), integer math: a partner's disc sits
 * `min(168 − 84·dn/1000, bound_r(deg) − 12)` art px from the nucleus, with
 * dn = min(D, 1e6)/1000 and bound_r = min(140 + 10·deg, 215).
 */
export function artReach(d: number, deg: number): number {
  const dn = Math.floor(Math.min(d, 1_000_000) / 1000);
  return Math.min(168 - Math.floor((84 * dn) / 1000), Math.min(140 + 10 * deg, 215) - 12);
}

/** Side of a spore's whole art on the map, world px: 24–36% of the ring radius, larger with R (size = R). */
export const organismSide = (r: number, rep: number, rMax: number) => r * (0.24 + 0.12 * Math.sqrt(rMax > 0 ? Math.min(1, Math.max(0, rep) / rMax) : 0));

/** The art's side in art px (renderer N). */
export const ART_SIDE = 512;

/** Tube ends from each spore's art: `reach(id)` = partner → `artReach` art px (from its render input), `side(id)` = its art's side on the map. */
export function artEnds(reach: (id: number) => Map<number, number> | null | undefined, side: (id: number) => number): TubeEnds {
  return (id, partner) => {
    const rr = reach(id)?.get(partner);
    if (rr === undefined) return null;
    const k = (rr * side(id)) / ART_SIDE;
    const u = slotDir(partner);
    return { x: u.x * k, y: u.y * k };
  };
}

/** A tube end that leaves an art carries on along the art's vein for this many times the vein's reach, then bends into the bowed curve. */
const VEIN_ON = 1.5;

/**
 * The tube between slots a and b. Plain: a curve bowed toward the centre
 * (control = centre + BOW·(midpoint − centre)). With `ends`, each end that
 * has art starts at the partner's disc in that spore's art and leaves in the
 * art's vein direction, so the map tube continues the art's own tube.
 */
export function tubeCurve(a: number, b: number, cx: number, cy: number, r: number, ends?: TubeEnds): Curve {
  const pa = ringPos(a, cx, cy, r);
  const pb = ringPos(b, cx, cy, r);
  const c = { x: cx + BOW * ((pa.x + pb.x) / 2 - cx), y: cy + BOW * ((pa.y + pb.y) / 2 - cy) };
  const oa = ends?.(a, b) ?? null;
  const ob = ends?.(b, a) ?? null;
  const p0 = oa ? { x: pa.x + oa.x, y: pa.y + oa.y } : pa;
  const p1 = ob ? { x: pb.x + ob.x, y: pb.y + ob.y } : pb;
  // An end's handle is the quadratic's (2/3 of the way to its control), so the plain curve is unchanged;
  // an end that leaves an art adds a push along the art's vein.
  const handle = (p: Pt, o: Pt | null): Pt => {
    const h = { x: p.x + (2 / 3) * (c.x - p.x), y: p.y + (2 / 3) * (c.y - p.y) };
    return o ? { x: h.x + VEIN_ON * o.x, y: h.y + VEIN_ON * o.y } : h;
  };
  return { p0, c0: handle(p0, oa), c1: handle(p1, ob), p1 };
}

export function curvePoint(q: Curve, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * q.p0.x + b * q.c0.x + c * q.c1.x + d * q.p1.x, y: a * q.p0.y + b * q.c0.y + c * q.c1.y + d * q.p1.y };
}

/** Integer square root, for the width scale only (layout; R itself comes from the chain or core-wasm). */
const isqrt = (n: number) => Math.floor(Math.sqrt(n));

/** Width `1 + 6·isqrt(D)/isqrt(Dmax)` px. */
export const tubeWidth = (d: number, dMax: number) => (dMax > 0 ? 1 + (6 * isqrt(d)) / Math.max(1, isqrt(dMax)) : 1);
/**
 * Opacity `0.45 + 0.55·√(D/Dmax)`, on the same √ scale as the width. It was linear from 0.25,
 * and on router5 (2026-11-13) two thirds of the 24 tubes sat near 0.3, so the map looked like 8.
 */
export const tubeAlpha = (d: number, dMax: number) => (dMax > 0 ? 0.45 + 0.55 * Math.sqrt(Math.min(1, Math.max(0, d) / dMax)) : 0.45);
/** Active core radius `3 + 6·√(R/Rmax)` px. */
export const nodeRadius = (r: number, rMax: number) => 3 + 6 * Math.sqrt(rMax > 0 ? Math.min(1, Math.max(0, r) / rMax) : 0);

// --- hit testing ------------------------------------------------------------

const SEGMENTS = 16;
export const TUBE_HIT_PX = 6;
export const NODE_HIT_PX = 14;

function segDist2(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  const x = a.x + t * dx - p.x;
  const y = a.y + t * dy - p.y;
  return x * x + y * y;
}

/**
 * A coarse grid over the curves of one tube set (Design §6.C performance):
 * each curve is cut into 16 segments, each segment is filed under the cells
 * its box touches (plus a one-cell margin), and a query checks only the cell
 * under the pointer. Built per (tube set, layout), in world coordinates.
 */
export class TubeIndex {
  private readonly cell: number;
  private readonly grid = new Map<number, { k: PairKey; a: Pt; b: Pt }[]>();
  constructor(keys: Iterable<PairKey>, cx: number, cy: number, r: number, ends?: TubeEnds, cell = 24) {
    this.cell = cell;
    for (const k of keys) {
      const [a, b] = pairOf(k);
      const q = tubeCurve(a, b, cx, cy, r, ends);
      let prev = q.p0;
      for (let i = 1; i <= SEGMENTS; i++) {
        const next = curvePoint(q, i / SEGMENTS);
        const seg = { k, a: prev, b: next };
        const x0 = Math.floor(Math.min(prev.x, next.x) / cell) - 1;
        const x1 = Math.floor(Math.max(prev.x, next.x) / cell) + 1;
        const y0 = Math.floor(Math.min(prev.y, next.y) / cell) - 1;
        const y1 = Math.floor(Math.max(prev.y, next.y) / cell) + 1;
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) {
            const id = x * 100_003 + y;
            (this.grid.get(id) ?? this.grid.set(id, []).get(id)!).push(seg);
          }
        prev = next;
      }
    }
  }

  /** The nearest tube within `maxDist` (world units, at most one cell) of `p`, or null. */
  hit(p: Pt, maxDist: number): PairKey | null {
    const id = Math.floor(p.x / this.cell) * 100_003 + Math.floor(p.y / this.cell);
    let best: PairKey | null = null;
    let bestD = maxDist * maxDist;
    for (const s of this.grid.get(id) ?? []) {
      const d = segDist2(p, s.a, s.b);
      if (d <= bestD) {
        bestD = d;
        best = s.k;
      }
    }
    return best;
  }
}

/** The spore whose slot is nearest `p` within `maxDist`, or null. */
export function hitNode(p: Pt, ids: Iterable<number>, cx: number, cy: number, r: number, maxDist: number): number | null {
  let best: number | null = null;
  let bestD = maxDist * maxDist;
  for (const id of ids) {
    const q = ringPos(id, cx, cy, r);
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

// --- view transform (pan and zoom) -------------------------------------------

export interface View {
  scale: number;
  tx: number;
  ty: number;
}

export const IDENTITY: View = { scale: 1, tx: 0, ty: 0 };
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

export const toWorld = (v: View, p: Pt): Pt => ({ x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale });

/** Zoom by `factor` keeping the world point under `anchor` (screen) fixed; clamped to 0.5×–4×. */
export function zoomAt(v: View, factor: number, anchor: Pt): View {
  const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.scale * factor));
  const w = toWorld(v, anchor);
  return { scale, tx: anchor.x - w.x * scale, ty: anchor.y - w.y * scale };
}

// --- tween (Design §3.5 epoch close) -----------------------------------------

/** cubic-bezier(x1, y1, x2, y2) solved for y at x, for the canvas (the CSS easing tokens). */
export function bezierEase(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dsx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      const d = dsx(t);
      if (Math.abs(e) < 1e-5 || !d) break;
      t -= e / d;
    }
    return sy(Math.max(0, Math.min(1, t)));
  };
}

/** `--ease-grow`, `--ease-decay` and `--ease-out` (tokens.css). */
export const easeGrow = bezierEase(0.16, 1, 0.3, 1);
export const easeDecay = bezierEase(0.4, 0, 0.6, 1);
export const easeOut = bezierEase(0.2, 0, 0, 1);

export interface TweenTube {
  k: PairKey;
  d: number;
  /** 0–1 share of the curve drawn (new tubes draw in from both ends). */
  reveal: number;
  /** 0–1 fade (tubes that left the set fade to 0). */
  fade: number;
  /** 0–1: a tube that grew glows briefly during the transition (§3.4). */
  glow: number;
  /** 0–1 progress of the close for a tube that grew or was born (the expansion runs in from both ends); 0 otherwise. */
  swell: number;
}

/**
 * Tubes at progress `t` (0–1) of the close from `from` to `to`. Growth eases
 * with `--ease-grow`, decay with `--ease-decay`; new tubes draw in; tubes
 * that left the set fade out.
 */
export function tweenTubes(from: Map<PairKey, number>, to: Map<PairKey, number>, t: number): TweenTube[] {
  const out: TweenTube[] = [];
  const pulse = Math.sin(Math.PI * Math.max(0, Math.min(1, t)));
  for (const [k, d1] of to) {
    const d0 = from.get(k);
    if (d0 === undefined) out.push({ k, d: d1, reveal: easeGrow(t), fade: 1, glow: pulse, swell: t < 1 ? t : 0 });
    else if (d1 >= d0) out.push({ k, d: d0 + (d1 - d0) * easeGrow(t), reveal: 1, fade: 1, glow: d1 > d0 ? pulse : 0, swell: d1 > d0 && t < 1 ? t : 0 });
    else out.push({ k, d: d0 + (d1 - d0) * easeDecay(t), reveal: 1, fade: 1, glow: 0, swell: 0 });
  }
  for (const [k, d0] of from) if (!to.has(k)) out.push({ k, d: d0, reveal: 1, fade: 1 - easeDecay(t), glow: 0, swell: 0 });
  return out;
}
