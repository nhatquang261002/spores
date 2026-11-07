// The Network map (Design §6.C, §7 `NetworkGraph`, variant `explorer`): one
// canvas with the 64-slot ring in the art's own geometry (§1.2). Takes
// Organism-level data (tubes, R, palette, active) plus a listed price and a
// paused flag per spore; never a Holding (§11).
//
// Motion (§3.5): when the frame changes, tubes tween old → new over
// `--t-epoch` (growth `--ease-grow`, decay `--ease-decay`, new tubes draw in,
// dropped ones fade) and node cores follow R. Under reduced motion every
// change is instant. Step particles come in through `emit` (graph/particles.ts).
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import { draw, layout, type NodeDraw, type Selection } from '../graph/draw';
import { useNodeArt, type NodeArtInput } from '../graph/nodeArt';
import { alive, particle, type Particle } from '../graph/particles';
import {
  artEnds,
  artReach,
  hitNode,
  IDENTITY,
  NODE_HIT_PX,
  organismSide,
  pairOf,
  toWorld,
  TUBE_HIT_PX,
  TubeIndex,
  tubesOf,
  tweenTubes,
  zoomAt,
  type Frame,
  type FrameDiff,
  type PairKey,
  type TweenTube,
  type View,
} from '../model/network';
import type { StepKind } from '../model/steps';
import { formatNear, formatR } from '../ui/format';
import { motion } from '../ui/tokens';
import type { RenderInput } from '../wasm/renderer';

/** Keeps a drag on this element; a pointer the browser no longer tracks can't be captured, which is fine. */
function capture(el: Element, id: number) {
  try {
    el.setPointerCapture?.(id);
  } catch {
    // not an active pointer
  }
}

export interface NodeInfo {
  palette: number;
  /** Listed price (yocto), shown on hover only; null = not listed. */
  price: string | null;
  paused: boolean;
  /** The spore's current render input (its art on the node); null or absent = no art. */
  art?: RenderInput | null;
  /** NEP-177 `media` glyph, shown until the art is rendered. */
  glyph?: string | null;
}

export interface NetworkGraphHandle {
  /** Shows one step that happened (a logged or confirmed tx). */
  emit: (kind: StepKind, from: number | null, to: number | null, delayMs?: number) => void;
  zoom: (factor: number) => void;
  reset: () => void;
}

export interface NetworkGraphProps {
  frame: Frame;
  nodeInfo: Map<number, NodeInfo>;
  dMax: number;
  rMax: number;
  diff: FrameDiff | null;
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** Enter on a selection: open the inspector and move focus there. */
  onOpen?: () => void;
  labels: 'selected' | 'all';
  reducedMotion: boolean;
  /** The instructions line for screen readers. */
  describedBy?: string;
  /** `compact` (Overview): a picture, not an instrument. No pan, zoom, hover or focus; this is its summary for screen readers. */
  compactLabel?: string;
}

type Tween = { from: Map<PairKey, number>; to: Map<PairKey, number>; repFrom: Map<number, number>; repTo: Map<number, number>; t0: number; dur: number };

const PAN_STEP = 40;

/** The tubes and R on screen at `now` during a tween (or its end state). */
export function sample(tw: Tween, now: number): { tubes: TweenTube[]; rep: Map<number, number>; done: boolean } {
  const t = tw.dur <= 0 ? 1 : Math.min(1, Math.max(0, (now - tw.t0) / tw.dur));
  const tubes = tweenTubes(tw.from, tw.to, t);
  const rep = new Map<number, number>();
  for (const id of new Set([...tw.repFrom.keys(), ...tw.repTo.keys()])) {
    const a = tw.repFrom.get(id) ?? 0;
    const b = tw.repTo.get(id) ?? 0;
    rep.set(id, a + (b - a) * (b >= a ? 1 - (1 - t) ** 3 : t * t * (3 - 2 * t)));
  }
  return { tubes, rep, done: t >= 1 };
}

export const NetworkGraph = forwardRef<NetworkGraphHandle, NetworkGraphProps>(function NetworkGraph(
  { frame, nodeInfo, dMax, rMax, diff, selection, onSelect, onOpen, labels, reducedMotion, describedBy, compactLabel },
  ref,
) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });
  const [view, setView] = useState<View>(IDENTITY);
  const [hover, setHover] = useState<{ sel: NonNullable<Selection>; x: number; y: number } | null>(null);
  const tween = useRef<Tween | null>(null);
  const particles = useRef<Particle[]>([]);
  const raf = useRef<number | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean; id: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; view: View } | null>(null);

  const tubes = useMemo(() => frame.tubes ?? new Map<PairKey, number>(), [frame.tubes]);
  const rep = useMemo(() => frame.reputation ?? new Map<number, number>(), [frame.reputation]);
  const activeSet = useMemo(() => new Set(frame.active ?? []), [frame.active]);

  const paintRef = useRef<() => void>(() => {});
  const schedule = useCallback(() => {
    if (raf.current === null && typeof requestAnimationFrame === 'function') raf.current = requestAnimationFrame(() => paintRef.current());
  }, []);

  // A new frame: tween from what is on screen now to the frame's tubes and R.
  useEffect(() => {
    const now = performance.now();
    const cur = tween.current ? sample(tween.current, now) : null;
    const from = new Map<PairKey, number>();
    for (const t of cur?.tubes ?? []) if (t.fade > 0.5 && t.reveal > 0.5) from.set(t.k, t.d);
    tween.current = {
      from: cur ? from : tubes,
      to: tubes,
      repFrom: cur ? cur.rep : rep,
      repTo: rep,
      t0: now,
      dur: reducedMotion || !cur ? 0 : motion.epoch,
    };
    schedule();
  }, [tubes, rep]); // the frame's data, not its identity

  // Size: the canvas fills its box at device pixel ratio up to 2.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const b = el.getBoundingClientRect();
      setSize({ w: Math.max(1, Math.round(b.width)), h: Math.max(1, Math.round(b.height)), dpr: Math.min(2, window.devicePixelRatio || 1) });
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { cx, cy, r } = layout(size.w, size.h);
  // Hit testing against the curves, cached per tube set and layout.
  // Where each spore's art puts its partners (tubes leave from there): partner → art px.
  const reach = useMemo(() => {
    const m = new Map<number, Map<number, number>>();
    for (const [id, i] of nodeInfo) {
      const edges = i.art?.edges;
      if (edges) m.set(id, new Map(edges.map(([p, d]) => [p, artReach(Number(d), edges.length)])));
    }
    return m;
  }, [nodeInfo]);
  const index = useMemo(
    () => new TubeIndex(tubes.keys(), cx, cy, r, artEnds((id) => reach.get(id), (id) => organismSide(r, rep.get(id) ?? 0, rMax))),
    [tubes, cx, cy, r, reach, rep, rMax],
  );

  const artItems = useMemo(
    (): NodeArtInput[] => [...nodeInfo].filter(([, i]) => i.art || i.glyph).map(([id, i]) => ({ id, input: i.art ?? null, glyph: i.glyph ?? null })),
    [nodeInfo],
  );
  const art = useNodeArt(artItems);

  const nodes = useMemo((): NodeDraw[] => {
    const out: NodeDraw[] = [];
    for (let id = 0; id < 64; id++) {
      const info = nodeInfo.get(id);
      out.push({
        id,
        active: activeSet.has(id),
        rep: rep.get(id) ?? 0,
        degree: tubesOf(tubes, id).length,
        palette: info?.palette ?? 0,
        paused: info?.paused ?? false,
        listed: !!info?.price,
        art: art.get(id) ?? null,
        reach: reach.get(id) ?? null,
      });
    }
    return out;
  }, [nodeInfo, activeSet, tubes, rep, art, reach]);

  const paint = useCallback(() => {
    raf.current = null;
    const c = canvas.current;
    const ctx = c?.getContext?.('2d');
    if (!c || !ctx || size.w < 2) return;
    const now = performance.now();
    const s = tween.current ? sample(tween.current, now) : { tubes: [...tubes].map(([k, d]) => ({ k, d, reveal: 1, fade: 1, glow: 0, swell: 0 })), rep, done: true };
    particles.current = particles.current.filter((p) => alive(p, now));
    draw(ctx, {
      w: size.w,
      h: size.h,
      dpr: size.dpr,
      view,
      tubes: s.tubes,
      dMax,
      rMax,
      nodes: nodes.map((n) => ({ ...n, rep: s.rep.get(n.id) ?? n.rep })),
      selection,
      hover: hover?.sel ?? null,
      diff: s.done ? diff : null,
      labels,
      slotLabels: compactLabel === undefined,
      particles: particles.current,
      now,
      ambient: !reducedMotion,
    });
    // The tubes are alive (graph/flex.ts), so the map keeps painting unless motion is reduced.
    if (!s.done || particles.current.length || !reducedMotion) raf.current = requestAnimationFrame(() => paintRef.current());
  }, [size, view, nodes, selection, hover, diff, labels, dMax, rMax, tubes, rep, reducedMotion]);
  paintRef.current = paint;

  useEffect(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    schedule();
  }, [paint, schedule]);
  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  useImperativeHandle(ref, () => ({
    emit(kind, from, to, delayMs = 0) {
      if (reducedMotion) return;
      particles.current.push(particle(kind, from, to, performance.now(), delayMs));
      schedule();
    },
    zoom(factor) {
      setView((v) => zoomAt(v, factor, { x: size.w / 2, y: size.h / 2 }));
    },
    reset() {
      setView(IDENTITY);
    },
  }));

  // --- pointer: drag to pan, click to select, wheel and pinch to zoom -------

  const local = (e: { clientX: number; clientY: number }) => {
    const b = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };

  const hitAt = (p: { x: number; y: number }): Selection => {
    const w = toWorld(view, p);
    const node = hitNode(w, activeSet, cx, cy, r, NODE_HIT_PX / view.scale) ?? hitNode(w, nodes.map((n) => n.id), cx, cy, r, 4 / view.scale);
    if (node !== null) return { kind: 'node', id: node };
    const k = index.hit(w, TUBE_HIT_PX / view.scale);
    return k === null ? null : { kind: 'tube', k };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    capture(e.target as Element, e.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), view };
      drag.current = null;
      return;
    }
    drag.current = { x: p.x, y: p.y, tx: view.tx, ty: view.ty, moved: false, id: e.pointerId };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = local(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      setView(zoomAt(pinch.current.view, d / Math.max(1, pinch.current.d), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }));
      return;
    }
    const dg = drag.current;
    if (dg && dg.id === e.pointerId) {
      if (!dg.moved && Math.hypot(p.x - dg.x, p.y - dg.y) > 4) dg.moved = true;
      if (dg.moved) setView((v) => ({ ...v, tx: dg.tx + p.x - dg.x, ty: dg.ty + p.y - dg.y }));
      return;
    }
    if (e.pointerType === 'mouse') {
      const sel = hitAt(p);
      setHover(sel ? { sel, x: p.x, y: p.y } : null);
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const dg = drag.current;
    drag.current = null;
    if (!dg || dg.id !== e.pointerId || dg.moved) return;
    onSelect(hitAt(local(e)));
  };

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const p = local(e);
    setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0015), p));
  };

  // Wheel zoom must not scroll the page (React's wheel listener is passive).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const stop = (e: globalThis.WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, []);

  // --- keyboard (Design §9): Tab through active nodes, arrows pan, +/− zoom, 0 resets, Escape clears, Enter opens

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const centre = { x: size.w / 2, y: size.h / 2 };
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? PAN_STEP : e.key === 'ArrowRight' ? -PAN_STEP : 0;
        const dy = e.key === 'ArrowUp' ? PAN_STEP : e.key === 'ArrowDown' ? -PAN_STEP : 0;
        setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
        return;
      }
      case '+':
      case '=':
        e.preventDefault();
        setView((v) => zoomAt(v, 1.25, centre));
        return;
      case '-':
      case '_':
        e.preventDefault();
        setView((v) => zoomAt(v, 0.8, centre));
        return;
      case '0':
        e.preventDefault();
        setView(IDENTITY);
        return;
      case 'Escape':
        if (selection) {
          e.preventDefault();
          onSelect(null);
        }
        return;
      case 'Enter':
        if (selection) {
          e.preventDefault();
          onOpen?.();
        }
        return;
      case 'Tab': {
        const ids = [...activeSet].sort((a, b) => a - b);
        if (!ids.length) return;
        const cur = selection?.kind === 'node' ? ids.indexOf(selection.id) : -1;
        const next = e.shiftKey ? (cur < 0 ? ids.length - 1 : cur - 1) : cur + 1;
        // Past either end, focus leaves the map as usual.
        if (next < 0 || next >= ids.length) return;
        e.preventDefault();
        onSelect({ kind: 'node', id: ids[next] });
        return;
      }
    }
  };

  const tip = hover ? tooltipText(hover.sel, tubes, rep, nodeInfo) : null;

  if (compactLabel !== undefined) {
    return (
      <div ref={wrap} className="network-canvas is-compact" role="img" aria-label={compactLabel}>
        <canvas ref={canvas} width={size.w * size.dpr} height={size.h * size.dpr} style={{ width: size.w, height: size.h }} aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      ref={wrap}
      className="network-canvas"
      role="application"
      aria-roledescription="network map"
      aria-label="Network map: 64 spores on a ring, tubes between partners"
      aria-describedby={describedBy}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      data-hover={hover ? 'true' : undefined}
    >
      <canvas ref={canvas} width={size.w * size.dpr} height={size.h * size.dpr} style={{ width: size.w, height: size.h }} aria-hidden="true" />
      {tip && hover && (
        <div className="network-hover mono-s" style={{ left: hover.x, top: hover.y }} aria-hidden="true">
          {tip}
        </div>
      )}
    </div>
  );
});

export function tooltipText(sel: NonNullable<Selection>, tubes: Map<PairKey, number>, rep: Map<number, number>, info: Map<number, NodeInfo>): string {
  if (sel.kind === 'tube') {
    const [a, b] = pairOf(sel.k);
    const d = tubes.get(sel.k);
    return `#${a} ↔ #${b}${d === undefined ? '' : ` · D ${(d / 1e6).toFixed(2)}`}`;
  }
  const r = rep.get(sel.id);
  const deg = tubesOf(tubes, sel.id).length;
  const price = info.get(sel.id)?.price;
  return `Spore #${sel.id}${r === undefined ? '' : ` · R ${formatR(r)}`} · ${deg} tube${deg === 1 ? '' : 's'}${price ? ` · listed ${formatNear(price)}` : ''}`;
}
