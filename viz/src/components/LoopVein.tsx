// A story's stops as one living vein across the page: the eight stops of the loop, or a
// scene's acts, and always the same timeline. Each stop is its name and its state; the
// vein grows from stop to stop with the same tube body as the map and the shell, in yolk,
// because this is interface, not data. When the new agent is working, a thin vein runs
// back from the last stop to Hire: it's a loop, and the log has just said so.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { EXPLORER } from '../chain/rpc';
import { clamp01, easeInOut, easeOut, subCurve } from '../graph/stage';
import { fillTube, rgba, type FlexClock } from '../graph/flex';
import { curvePoint, type Curve, type Pt } from '../model/network';
import type { LoopRow } from '../model/loop';
import { color, motion } from '../ui/tokens';
import { Tooltip } from '../ui/Tooltip';

const LAYERS = [
  { w: 2.4, a: 0.16, c: color.slime },
  { w: 1, a: 0.95, c: color.slime },
  { w: 0.34, a: 0.75, c: color.text },
];

/** The vein's line from the canvas's top, px. Room above it for the way back. */
const LINE_Y = 30;

/** A point on the vein: `along` the page's run, `side` px off its line. */
const place = (along: number, side: number): Pt => ({ x: along, y: LINE_Y + side });

/** A gentle S between two stops, so it reads as grown rather than ruled. */
function segment(a: number, b: number, i: number): Curve {
  const lean = i % 2 ? 5 : -5;
  const h = b - a;
  return { p0: place(a, 0), c0: place(a + h * 0.35, lean), c1: place(a + h * 0.65, -lean), p1: place(b, 0) };
}

/** A stop's state in a word, so it doesn't rest on colour. */
export function stopWord(r: Pick<VeinStop, 'state' | 'warn'>): { glyph: string; word: string } {
  if (r.warn) return { glyph: '✕', word: 'failed' };
  if (r.state === 'past') return { glyph: '✓', word: 'done' };
  if (r.state === 'now') return { glyph: '●', word: 'now' };
  return { glyph: '○', word: 'to come' };
}

/** What the vein needs of a stop. */
export interface VeinStop<K extends string = string> {
  key: K;
  word: string;
  state: 'future' | 'now' | 'past';
  warn?: boolean;
}

export function LoopVein<K extends string>({ rows, returned = false, reducedMotion, onSeek, label = 'The loop, stop by stop', seekName, tips }: {
  rows: VeinStop<K>[];
  /** The loop has come round: the new agent is working. */
  returned?: boolean;
  reducedMotion: boolean;
  onSeek?: (a: K) => void;
  label?: string;
  /** A stop button's accessible name; by default its word and state. */
  seekName?: (word: string) => string;
  /** What each stop means, on hover and focus. */
  tips?: Partial<Record<K, string>>;
}) {
  const box = useRef<HTMLOListElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ys, setYs] = useState<number[]>([]);
  const reached = rows.reduce((n, r, i) => (r.state === 'future' ? n : i), -1);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // From the list's own edge: a stop may sit in a tooltip's anchor, so offsetLeft wouldn't reach it.
    const measure = () => {
      const left = el.getBoundingClientRect().left;
      setYs([...el.querySelectorAll<HTMLElement>('.vein-dot')].map((d) => d.getBoundingClientRect().left - left));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length]);

  const anim = useRef({ shown: -1, from: -1, at: -1e9, returnAt: -1e9 });
  const latest = useRef({ reached, ys, returned, reducedMotion, rows });
  latest.current = { reached, ys, returned, reducedMotion, rows };
  const raf = useRef<number | null>(null);
  const schedule = () => {
    if (raf.current === null && typeof requestAnimationFrame === 'function') raf.current = requestAnimationFrame(paint);
  };

  useEffect(() => {
    const a = anim.current;
    const now = performance.now();
    if (reached !== a.shown) {
      // A step forward grows; a seek lands.
      a.from = reached === a.shown + 1 ? a.shown : reached;
      a.shown = reached;
      a.at = now;
    }
    schedule();
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [reached, ys.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the stops scroll sideways (a phone), the one reached stays in view.
  useEffect(() => {
    const el = box.current;
    const strip = el?.parentElement;
    const row = el?.querySelectorAll<HTMLElement>('.vein-row')[Math.max(0, reached)];
    if (!strip || !row || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollTo?.({ left: row.offsetLeft - strip.clientWidth / 2 + row.offsetWidth / 2, behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [reached]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    anim.current.returnAt = returned ? performance.now() : -1e9;
    schedule();
  }, [returned]); // eslint-disable-line react-hooks/exhaustive-deps

  const paint = () => {
    raf.current = null;
    const el = canvas.current;
    const ctx = el?.getContext?.('2d');
    const { reached: n, ys: y, returned: back, reducedMotion: still } = latest.current;
    if (!el || !ctx || y.length < 2) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const at = place;
    const now = performance.now();
    const a = anim.current;
    const clock: FlexClock = { now, ambient: !still };
    const u = still ? 1 : clamp01((now - a.at) / motion.epoch);
    let moving = !still && n >= 0;
    if (u < 1) moving = true;

    // The road ahead: a thread through the stops still to come.
    ctx.setLineDash([2, 6]);
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color.lineStrong;
    ctx.beginPath();
    const road0 = at(y[Math.max(0, n)], 0);
    const road1 = at(y[y.length - 1], 0);
    ctx.moveTo(road0.x, road0.y);
    ctx.lineTo(road1.x, road1.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // The vein so far.
    const tip = (q: Curve, reach: number): Pt => curvePoint(q, reach);
    let head: Pt | null = n >= 0 ? at(y[0], 0) : null;
    for (let i = 0; i < n && i + 1 < y.length; i++) {
      const q = segment(y[i], y[i + 1], i);
      const growing = i === n - 1 && a.from === n - 1;
      const reach = growing ? easeOut(u) : 1;
      const part = reach >= 0.999 ? q : subCurve(q, reach);
      for (const l of LAYERS) {
        ctx.fillStyle = rgba(l.c, l.a);
        fillTube(ctx, part, { width: 5 * l.w, k: 40 + i, angle: i, reveal: 1, swell: 0, clock, taper: [0.8, 0.8] });
      }
      head = tip(q, reach);
    }

    // The way back: the loop closes when the log says the new agent is working.
    if (back && y.length > 1) {
      const v = still ? 1 : clamp01((now - a.returnAt) / motion.pulse);
      if (v < 1) moving = true;
      const last = y[y.length - 1];
      // It bows up over the stops.
      const bow = -26;
      const q: Curve = { p0: at(last, 0), c0: at(last - 20, bow), c1: at(y[1] + 20, bow), p1: at(y[1], 0) };
      const part = v >= 0.999 ? q : subCurve(q, easeInOut(v));
      for (const l of LAYERS) {
        ctx.fillStyle = rgba(l.c, l.a * 0.55);
        fillTube(ctx, part, { width: 2.4 * l.w, k: 90, angle: 0, reveal: 1, swell: 0, clock, taper: [0.5, 0.5] });
      }
    }

    // The stops: the one reached shines; those to come are hollow.
    y.forEach((yy, i) => {
      const stop = at(yy, 0);
      ctx.beginPath();
      ctx.arc(stop.x, stop.y, i === n ? 6 : 4.5, 0, Math.PI * 2);
      if (i <= n) {
        ctx.fillStyle = i === n ? color.text : color.slime;
        ctx.fill();
        if (i === n) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = color.slime;
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = color.bg;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = color.lineStrong;
        ctx.stroke();
      }
    });
    if (head && u < 1 && !still) {
      ctx.beginPath();
      ctx.arc(head.x, head.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color.text;
      ctx.fill();
    }
    if (moving) schedule();
  };

  return (
    <ol className="loop-vein" ref={box} aria-label={label} style={{ '--stops': rows.length } as CSSProperties}>
      <canvas ref={canvas} className="vein-canvas" aria-hidden="true" />
      {rows.map((r, i) => {
        const said = stopWord(r);
        const body = (
          <>
            <span className="vein-dot" aria-hidden="true" />
            <span className="vein-word">{r.word}</span>
            <span className={`vein-status label${r.warn ? ' tone-warn' : ''}`}><span aria-hidden="true">{said.glyph} </span>{said.word}</span>
          </>
        );
        const tip = tips?.[r.key];
        const button = onSeek && (
          <button type="button" className="vein-stop" onClick={() => onSeek(r.key)} aria-label={seekName?.(r.word)} aria-description="Show this stop">
            {body}
          </button>
        );
        const stop = button ?? <span className="vein-stop">{body}</span>;
        return (
          <li key={r.key} className={`vein-row is-${r.state}${r.warn ? ' is-warn' : ''}`} aria-current={r.state === 'now' ? 'step' : undefined}>
            {/* The last stops' tips open inward, so they stay on the page. */}
            {tip ? <Tooltip focusable={false} align={i >= rows.length / 2 ? 'end' : 'start'} content={tip}>{stop}</Tooltip> : stop}
          </li>
        );
      })}
    </ol>
  );
}

/** The story so far, as a causal chain: each stop's promise until it has happened, then the run's figures and their tx. */
export function LoopChain({ rows }: { rows: LoopRow[] }) {
  return (
    <ol className="loop-chain" aria-label="What each stop means and what the run did">
      {rows.map((r) => (
        <li key={r.key} className={`chain-row is-${r.state}${r.warn ? ' is-warn' : ''}`}>
          <span className="chain-word label">{r.word}</span>
          <span className={r.fact ? `chain-fact mono-s${r.warn ? ' tone-warn' : ''}` : 'chain-promise body'} key={r.fact ?? 'p'}>{r.fact ?? r.promise}</span>
          {r.tx && !r.tx.endsWith(')') ? (
            <a className="chain-tx mono-s" href={`${EXPLORER}/${r.tx}`} target="_blank" rel="noreferrer" aria-label={`${r.word} tx ${r.tx}, opens the explorer`}>tx ↗</a>
          ) : <span />}
        </li>
      ))}
    </ol>
  );
}
