// The loop itself (S12): the attacker's spores passing money round in a ring, the
// honest network round the dish. A schematic of the mechanism, labelled so: the
// widths, the counts and the money are this case's simulated numbers (both rings
// use one R-to-width scale, so a loop that outgrows the honest median is visibly
// fatter than it), and the paths of single beads are not data. It moves only
// while the simulation plays; a frame is drawn for reduced motion and at the end.
import { useEffect, useRef } from 'react';
import { fillTube, rgba, type FlexClock } from '../graph/flex';
import type { Curve, Pt } from '../model/network';
import { color } from '../ui/tokens';

const TAU = Math.PI * 2;

interface Props {
  spores: number;
  active: number;
  jobs: number;
  /** NEAR through each edge per epoch. */
  loopNear: number;
  attackerR: number;
  honestR: number;
  /** Money lost so far, NEAR (negative). */
  money: number;
  playing: boolean;
  reducedMotion: boolean;
  label: string;
}

const dot = (ctx: CanvasRenderingContext2D, p: Pt, r: number, c: string, a = 1) => {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, TAU);
  ctx.fillStyle = rgba(c, a);
  ctx.fill();
};

export function WashLoop(p: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(p);
  latest.current = p;
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const paint = () => {
      raf.current = null;
      const el = canvas.current;
      const holder = box.current;
      const ctx = el?.getContext?.('2d');
      if (!el || !ctx || !holder) return;
      const q = latest.current;
      const b = holder.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(b.width);
      const h = Math.round(b.height);
      if (el.width !== w * dpr || el.height !== h * dpr) {
        el.width = w * dpr;
        el.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const u = Math.min(w, h) / 2;
      const c = { x: w / 2, y: h / 2 };
      const now = performance.now();
      const moving = q.playing && !q.reducedMotion;
      const clock: FlexClock = { now, ambient: moving };
      /** One scale for both rings. */
      const widthOf = (r: number) => Math.max(1, (u / 150) * (0.8 + 1.8 * r));

      // The dish: a dashed rim, because this is a simulation (§4.1).
      ctx.beginPath();
      ctx.arc(c.x, c.y, u * 0.97, 0, TAU);
      ctx.fillStyle = color.surface;
      ctx.fill();
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = color.lineStrong;
      ctx.stroke();
      ctx.setLineDash([]);

      // The honest network: as many spores as the case has, a band as wide as the median's R.
      const honestAt = (i: number): Pt => {
        const a = (i / q.active) * TAU;
        return { x: c.x + Math.sin(a) * u * 0.8, y: c.y - Math.cos(a) * u * 0.8 };
      };
      ctx.beginPath();
      ctx.arc(c.x, c.y, u * 0.8, 0, TAU);
      ctx.lineWidth = widthOf(q.honestR);
      ctx.strokeStyle = rgba(color.text2, 0.3);
      ctx.stroke();
      const nodeR = Math.max(1.2, (u * 0.8 * TAU) / q.active / 5);
      for (let i = 0; i < q.active; i++) dot(ctx, honestAt(i), nodeR, color.text2, 0.75);
      // Its traffic: more spores and more jobs, more beads. Which pair is only a picture.
      if (moving) {
        const beads = Math.min(40, Math.round((q.active * q.jobs) / 5));
        for (let i = 0; i < beads; i++) {
          const t = (now / 1100 + (i * 0.37) % 1) % 1;
          const from = (i * 7) % q.active;
          const to = (from + 1 + ((i * 3) % 5)) % q.active;
          const A = honestAt(from);
          const B = honestAt(to);
          dot(ctx, { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t }, Math.max(1.2, u * 0.012), color.text2, 0.8 * Math.sin(Math.PI * t));
        }
      }

      // The loop: the attacker's spores, joined in a ring as wide as its best R.
      const R = u * 0.36;
      const nodes = Array.from({ length: q.spores }, (_, i) => {
        const a = (i / q.spores) * TAU - Math.PI / 2 + (q.spores === 2 ? Math.PI / 2 : 0);
        return { x: c.x + Math.cos(a) * R, y: c.y + Math.sin(a) * R, a };
      });
      const edge = (i: number): Curve => {
        const a = nodes[i];
        const b = nodes[(i + 1) % q.spores];
        const mid = a.a + (q.spores === 2 ? Math.PI / 2 : TAU / 6);
        const push = q.spores === 2 ? 1.15 : 1.25;
        const m = { x: c.x + Math.cos(mid) * R * push, y: c.y + Math.sin(mid) * R * push };
        return { p0: a, c0: { x: a.x + (m.x - a.x) * 0.8, y: a.y + (m.y - a.y) * 0.8 }, c1: { x: b.x + (m.x - b.x) * 0.8, y: b.y + (m.y - b.y) * 0.8 }, p1: b };
      };
      const width = widthOf(q.attackerR);
      for (let i = 0; i < q.spores; i++) {
        const base = { k: 400 + i, angle: i, reveal: 1, swell: 0, clock, taper: [0.8, 0.8] as [number, number] };
        ctx.fillStyle = rgba(color.warn, 0.25);
        fillTube(ctx, edge(i), { ...base, width: width * 2.1 });
        ctx.fillStyle = rgba(color.warn, 0.95);
        fillTube(ctx, edge(i), { ...base, width });
      }
      // The money going round. Bigger loop, bigger bead; a fee drips off at every spore.
      const beadR = Math.max(2, u * 0.022 * Math.sqrt(Math.min(5, q.loopNear) / 0.2) * 0.6);
      const ring = (now / 1800) % 1;
      const cubic = (t: number, e: Curve) => {
        const s = 1 - t;
        return { x: s * s * s * e.p0.x + 3 * s * s * t * e.c0.x + 3 * s * t * t * e.c1.x + t * t * t * e.p1.x, y: s * s * s * e.p0.y + 3 * s * s * t * e.c0.y + 3 * s * t * t * e.c1.y + t * t * t * e.p1.y };
      };
      for (let i = 0; i < q.spores; i++) {
        const t = moving ? (ring + i / q.spores) % 1 : 0.5;
        const seg = t * q.spores;
        const which = Math.floor(seg) % q.spores;
        const pos = cubic(seg - Math.floor(seg), edge(which));
        dot(ctx, pos, beadR * 1.9, color.value, 0.22);
        dot(ctx, pos, beadR, color.value);
        dot(ctx, pos, beadR * 0.42, color.text);
        // The fee falls out of the loop and is gone.
        if (moving) {
          const fall = (seg - Math.floor(seg)) % 1;
          const n = nodes[which];
          if (fall < 0.45) dot(ctx, { x: n.x + Math.sin(i * 2.1) * 8 * fall, y: n.y + u * 0.32 * fall * fall * 4 }, Math.max(1.4, beadR * 0.4), color.value, 0.9 * (1 - fall / 0.45));
        }
      }
      for (const n of nodes) {
        dot(ctx, n, u * 0.05, color.bg);
        dot(ctx, n, u * 0.038, color.warn);
      }
      if (moving) raf.current = requestAnimationFrame(paint);
    };
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(paint) : null;
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [p.playing, p.reducedMotion, p.spores, p.active, p.jobs, p.loopNear, p.attackerR, p.honestR]);

  return (
    <div className="wash-loop" ref={box}>
      <canvas ref={canvas} className="stage-canvas" role="img" aria-label={p.label} />
    </div>
  );
}
