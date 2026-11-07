// One candidate's quote drawn as a tube (Design §6.E; user 2026-11-05: "make the
// bar as a tube"): the Network map's own body and vein layers (graph/flex.ts),
// width √D, brightness D, from the consumer's palette to the provider's. The
// live body ends at a node on the effective price, the number the hiring rule
// compares; past it the tube fades and thins out at the full quote, the part its
// strength took off. With no tube there is no body: a bare thread to the node.
// Length is money on a shared zero-based scale. Still, on purpose: only a close
// changes a tube (§3.5). Decorative: the row's text carries every value.
import { useEffect, useRef } from 'react';
import { fillTube, rgba, STILL, stopOf, VEIN, type BodyOpts } from '../graph/flex';
import { color } from '../ui/tokens';

export interface QuoteTubeSpec {
  /** Of the scale, 0..1. */
  quote: number;
  effective: number;
  tube: boolean;
  /** Width at rest, px, and brightness: the map's `tubeWidth` and `tubeAlpha`. */
  width: number;
  alpha: number;
  won: boolean;
  /** Palette of the consumer, at the root, and of the provider, at the tip. */
  from: number;
  to: number;
}

const NODE_R = 3;
/** At row size the map's widths and its faintest brightness barely read, so both step up; their order stays. */
const WIDTH_SCALE = 1.6;
const brightness = (alpha: number) => 0.4 + 0.6 * alpha;
/** The body swells between its ends: thinner at the root and where it meets the node. */
const ENDS: [number, number] = [0.45, 0.6];
/** The faded part: its width against the body's, how far it thins by the quote, and its opacity. */
const FADE_WIDTH = 0.6;
const FADE_END = 0.15;
const FADE_ALPHA = 0.3;
/** Candidates that didn't win step back, as the map's unrelated tubes do. */
const LOSER = 0.55;

const line = (x0: number, x1: number, y: number) => ({ p0: { x: x0, y }, c0: { x: x0 + (x1 - x0) / 3, y }, c1: { x: x0 + (2 * (x1 - x0)) / 3, y }, p1: { x: x1, y } });

export function paintQuoteTube(ctx: CanvasRenderingContext2D, w: number, h: number, s: QuoteTubeSpec) {
  if (w <= 0) return;
  const y = h / 2;
  const span = w - 2 * NODE_R;
  const tip = NODE_R + s.effective * span;
  const end = NODE_R + s.quote * span;
  const dim = s.won ? 1 : LOSER;

  if (!s.tube) {
    ctx.lineCap = 'round';
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(color.lineStrong, dim);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(tip, y);
    ctx.stroke();
  } else {
    const width = s.width * WIDTH_SCALE;
    const base: BodyOpts = { width, k: 0, angle: 0, reveal: 1, swell: 0, clock: STILL };
    if (end > tip) {
      ctx.fillStyle = rgba(stopOf(s.to, 3), FADE_ALPHA * dim);
      fillTube(ctx, line(tip, end, y), { ...base, width: width * FADE_WIDTH, taper: [1, FADE_END] });
    }
    const alpha = brightness(s.alpha) * dim;
    for (const layer of VEIN) {
      const g = ctx.createLinearGradient(0, y, tip, y);
      g.addColorStop(0, rgba(stopOf(s.from, layer.stop), alpha * layer.alpha));
      g.addColorStop(1, rgba(stopOf(s.to, layer.stop), alpha * layer.alpha));
      ctx.fillStyle = g;
      fillTube(ctx, line(0, tip, y), { ...base, width: width * layer.width, taper: ENDS });
    }
  }

  ctx.fillStyle = rgba(stopOf(s.to, 3), dim);
  ctx.beginPath();
  ctx.arc(tip, y, NODE_R, 0, Math.PI * 2);
  ctx.fill();
}

export function QuoteTube({ spec }: { spec: QuoteTubeSpec }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify(spec);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext?.('2d');
    if (!cv || !ctx) return;
    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      paintQuoteTube(ctx, w, h, spec);
    };
    paint();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(paint);
    ro.observe(cv);
    return () => ro.disconnect();
    // `key` is the spec's value: rows re-render with equal specs on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <canvas ref={ref} className="hire-tube" aria-hidden="true" />;
}
