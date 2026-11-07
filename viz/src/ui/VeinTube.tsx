// Shell veins (Design §3.4–§3.5): the top bar's, footer's and bottom bar's
// edge is drawn as a living tube, the same body as the Network map's tubes
// (graph/flex.ts; user 2026-11-04: "I like the tube's one"). A peristaltic
// wave runs along it and reverses every `--t-stream`, and it breathes on
// `--t-breathe` in step with the wordmark; the veins lower down lag 2 s and
// 4 s. In yolk, not a palette: it is interface, not data. Decorative
// (aria-hidden); drawn once and still under reduced motion.
import { useEffect, useRef } from 'react';
import { fillTube, type BodyOpts } from '../graph/flex';
import { color, motion } from './tokens';

/** Canvas height, px: the tube and its halo, centred on the edge. */
const H = 16;
/** Width at rest, px. */
const WIDTH = 2.5;
/** Halo, body and bright core, as the map's tube layers (draw.ts `VEIN`); the body is `--vein` (yolk at 36%). */
const LAYERS = [
  { width: 2.2, alpha: 0.12 },
  { width: 1, alpha: 0.36 },
  { width: 0.35, alpha: 0.55 },
] as const;
/** The ends thin out to this share of the width, like a vein running out. */
const END = 0.4;

function rgba(hexColor: string, a: number): string {
  const n = parseInt(hexColor.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function VeinTube({ edge, lag = 0, reducedMotion }: { edge: 'top' | 'bottom'; /** Breath delay, ms. */ lag?: number; reducedMotion: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    let raf = 0;
    const paint = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, H);
      if (w > 0) {
        const y = H / 2;
        const q = { p0: { x: 0, y }, c0: { x: w / 3, y }, c1: { x: (2 * w) / 3, y }, p1: { x: w, y } };
        // -π/2: thinnest at the start of a breath, as the wordmark is thinnest at the start of its own.
        const body: BodyOpts = {
          width: WIDTH,
          k: 1 + lag,
          angle: -Math.PI / 2 - (Math.PI * lag) / motion.breathe,
          reveal: 1,
          swell: 0,
          clock: { now, ambient: !reducedMotion },
          taper: [END, END],
          steps: Math.ceil(w / 6),
        };
        for (const l of LAYERS) {
          ctx.fillStyle = rgba(color.slime, l.alpha);
          fillTube(ctx, q, { ...body, width: WIDTH * l.width });
        }
      }
      if (!reducedMotion) raf = requestAnimationFrame(paint);
    };
    paint(performance.now());
    // Still: repaint only when the bar changes size.
    const ro = reducedMotion && typeof ResizeObserver === 'function' ? new ResizeObserver(() => paint(performance.now())) : null;
    ro?.observe(cv);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [edge, lag, reducedMotion]);
  return <canvas ref={ref} className={`vein-tube vein-tube-${edge}`} aria-hidden="true" />;
}
