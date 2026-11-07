// The arrow you'd draw on a printed plate with a pen: it grows from the note to the
// thing the note is about, a little unsteady, the same way twice. Decorative: the
// note says it in words, and under reduced motion it's simply there.
import type { Pt } from '../model/network';

const STEPS = 22;
const HEAD = 13;

/** A stable small number from a string, so one line always gets the same hand. */
function hash(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
  return h;
}

/** The shaft and the head's two strokes. `bow`: how far the middle swings off the straight line, px (+ = to the left of travel). */
export function handPath(from: Pt, to: Pt, bow: number, seed: string): { shaft: string; head: string } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dy / len;
  const ny = -dx / len;
  const h = hash(seed);
  const c0 = { x: from.x + dx * 0.3 + nx * bow, y: from.y + dy * 0.3 + ny * bow };
  const c1 = { x: from.x + dx * 0.72 + nx * bow * 0.9, y: from.y + dy * 0.72 + ny * bow * 0.9 };
  const pts: Pt[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const u = 1 - t;
    const x = u * u * u * from.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * to.x;
    const y = u * u * u * from.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * to.y;
    // The tremor fades at both ends: a pen starts and lands on purpose.
    const shake = Math.sin(Math.PI * t) * (1.6 * Math.sin(t * 9 + h) + 0.9 * Math.sin(t * 23 + h * 0.7));
    pts.push({ x: x + nx * shake, y: y + ny * shake });
  }
  let shaft = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    shaft += ` Q${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const end = pts[pts.length - 1];
  shaft += ` L${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
  const before = pts[pts.length - 3];
  const a = Math.atan2(end.y - before.y, end.x - before.x);
  const barb = (spread: number, l: number) => `M${(end.x - Math.cos(a + spread) * l).toFixed(1)} ${(end.y - Math.sin(a + spread) * l).toFixed(1)} L${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
  return { shaft, head: `${barb(0.48, HEAD)} ${barb(-0.42, HEAD * 0.86)}` };
}

export function HandArrow({ from, to, bow, seed }: { from: Pt; to: Pt; bow: number; seed: string }) {
  const { shaft, head } = handPath(from, to, bow, seed);
  return (
    <g className="hand-arrow" key={seed}>
      <path className="hand-arrow-halo" d={shaft} />
      <path className="hand-arrow-shaft" d={shaft} pathLength={1} />
      <path className="hand-arrow-head" d={head} />
    </g>
  );
}
