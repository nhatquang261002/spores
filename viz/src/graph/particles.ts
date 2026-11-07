// One short visual per network step (S7 step playback, Design §3.5 rows
// "Step playback" and "Live settlement"). A particle is only ever made from a
// step that happened: a logged tx with `ok:true` in a run log, a flow or
// reject that appeared in `epoch_info` between two polls, or a flow in a
// close event. Colour follows meaning (§3.1.2): agent violet for agent
// actions, amber for money, green for settled, red for rejected or failed.
// Tubes never change here: D moves only at a close (the truth rule).
import { curvePoint, nodeRadius, ringPos, tubeCurve, type Curve, type Pt } from '../model/network';
import type { StepKind } from '../model/steps';
import { color, motion } from '../ui/tokens';
import type { NodeDraw } from './draw';

export interface Particle {
  kind: StepKind;
  from: number | null;
  to: number | null;
  /** performance.now() at start. */
  t0: number;
  dur: number;
}

/** Durations from the motion tokens (§3.5). */
export const PARTICLE_MS: Record<StepKind, number> = {
  wake: motion.epoch,
  post: motion.epoch,
  quote: motion.epoch,
  hire: motion.grow,
  deliver: motion.epoch,
  settle: motion.grow,
  reject: motion.pulse,
  timeout: motion.epoch,
  outside: motion.grow,
  close: motion.pulse,
  commit: motion.epoch,
  failed: motion.pulse,
};

export function particle(kind: StepKind, from: number | null, to: number | null, t0: number, delay = 0): Particle {
  return { kind, from, to, t0: t0 + delay, dur: PARTICLE_MS[kind] };
}

export const alive = (p: Particle, now: number) => now < p.t0 + p.dur;

interface Ctx {
  cx: number;
  cy: number;
  r: number;
  hair: number;
  accents: Map<number, string>;
  rMax: number;
  nodes: NodeDraw[];
  /** The tube's curve as drawn (it sways, graph/flex.ts); the plain layout curve when absent. */
  path?: (from: number, to: number) => Curve;
}

function rgba(hexColor: string, a: number): string {
  const n = parseInt(hexColor.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a))})`;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

function partial(ctx: CanvasRenderingContext2D, q: Curve, t0: number, t1: number) {
  ctx.beginPath();
  const n = 20;
  for (let i = 0; i <= n; i++) {
    const p = curvePoint(q, t0 + ((t1 - t0) * i) / n);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function dot(ctx: CanvasRenderingContext2D, p: Pt, rad: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
  ctx.fill();
}

function ring(ctx: CanvasRenderingContext2D, p: Pt, rad: number, stroke: string, width: number, from = 0, to = Math.PI * 2) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(p.x, p.y, Math.max(0.1, rad), from, to);
  ctx.stroke();
}

function diamond(ctx: CanvasRenderingContext2D, p: Pt, s: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - s);
  ctx.lineTo(p.x + s, p.y);
  ctx.lineTo(p.x, p.y + s);
  ctx.lineTo(p.x - s, p.y);
  ctx.closePath();
  ctx.fill();
}

function cross(ctx: CanvasRenderingContext2D, p: Pt, s: number, stroke: string, width: number) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(p.x - s, p.y - s);
  ctx.lineTo(p.x + s, p.y + s);
  ctx.moveTo(p.x + s, p.y - s);
  ctx.lineTo(p.x - s, p.y + s);
  ctx.stroke();
}

function check(ctx: CanvasRenderingContext2D, p: Pt, s: number, stroke: string, width: number) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(p.x - s, p.y);
  ctx.lineTo(p.x - s * 0.3, p.y + s * 0.7);
  ctx.lineTo(p.x + s, p.y - s * 0.6);
  ctx.stroke();
}

export function drawParticle(ctx: CanvasRenderingContext2D, pt: Particle, now: number, c: Ctx) {
  const t = (now - pt.t0) / pt.dur;
  if (t < 0 || t > 1) return;
  const node = (id: number) => ringPos(id, c.cx, c.cy, c.r);
  const path = (from: number, to: number): Curve => c.path?.(from, to) ?? tubeCurve(from, to, c.cx, c.cy, c.r);
  const coreOf = (id: number) => {
    const n = c.nodes[id];
    return n?.active ? nodeRadius(n.rep, c.rMax) : 2;
  };
  const fade = 1 - easeOut(Math.max(0, (t - 0.6) / 0.4));
  ctx.lineCap = 'round';
  switch (pt.kind) {
    case 'wake': {
      // The agent's ring closes around its spore.
      if (pt.from === null) return;
      const a = -Math.PI / 2;
      ring(ctx, node(pt.from), coreOf(pt.from) + 6, rgba(color.agent, fade), 1.5, a, a + Math.PI * 2 * easeOut(Math.min(1, t * 1.6)));
      return;
    }
    case 'post': {
      // A ripple: the consumer asks the network for work.
      if (pt.from === null) return;
      const p = node(pt.from);
      ring(ctx, p, coreOf(pt.from) + 4 + 20 * easeOut(t), rgba(color.agent, 0.9 * (1 - t)), 1.5);
      diamond(ctx, p, 3 * (1 - t) + 1, rgba(color.agent, 1 - t));
      return;
    }
    case 'quote': {
      // A dashed thread from the provider toward the consumer.
      if (pt.from === null) return;
      if (pt.to === null) {
        ring(ctx, node(pt.from), coreOf(pt.from) + 4 + 8 * easeOut(t), rgba(color.agent, 0.7 * (1 - t)), 1);
        return;
      }
      ctx.setLineDash([3 * c.hair, 3 * c.hair]);
      ctx.strokeStyle = rgba(color.agent, 0.75 * fade);
      ctx.lineWidth = 1;
      partial(ctx, path(pt.from, pt.to), 0, easeOut(Math.min(1, t * 1.8)));
      ctx.setLineDash([]);
      return;
    }
    case 'hire': {
      // The consumer reaches its chosen provider: a solid thread with a diamond at its head.
      if (pt.from === null || pt.to === null) return;
      const q = path(pt.from, pt.to);
      const head = easeInOut(Math.min(1, t * 1.4));
      ctx.strokeStyle = rgba(color.agent, 0.9 * fade);
      ctx.lineWidth = 1.5;
      partial(ctx, q, 0, head);
      diamond(ctx, curvePoint(q, head), 3.5, rgba(color.agent, fade));
      return;
    }
    case 'deliver': {
      // The work travels back: a hollow bead, provider → consumer.
      if (pt.from === null || pt.to === null) return;
      ring(ctx, curvePoint(path(pt.from, pt.to), easeInOut(t)), 3, rgba(color.agent, fade), 1.5);
      return;
    }
    case 'settle': {
      // Money moves: an amber bead, consumer → provider; a green ✓ lands on arrival.
      if (pt.from === null || pt.to === null) return;
      const q = path(pt.from, pt.to);
      if (t < 0.8) {
        const k = easeInOut(Math.min(1, t / 0.75));
        const p = curvePoint(q, k);
        const trail = curvePoint(q, Math.max(0, k - 0.06));
        ctx.strokeStyle = rgba(color.value, 0.5);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(trail.x, trail.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        dot(ctx, p, 4, color.value);
        dot(ctx, p, 1.6, color.text);
      }
      if (t > 0.7) {
        const u = (t - 0.7) / 0.3;
        const p = node(pt.to);
        const core = coreOf(pt.to);
        ring(ctx, p, core + 4 + 10 * easeOut(u), rgba(color.growth, 1 - u), 1.5);
        check(ctx, { x: p.x, y: p.y - core - 14 }, 3.5, rgba(color.growth, 1 - u * u), 1.5);
      }
      return;
    }
    case 'reject': {
      // The consumer refuses the delivery: a red ✕ on the pair.
      if (pt.from === null) return;
      const p = pt.to === null ? node(pt.from) : curvePoint(path(pt.from, pt.to), 0.5);
      cross(ctx, p, 2 + 3 * easeOut(Math.min(1, t * 3)), rgba(color.warn, fade), 1.75);
      return;
    }
    case 'timeout': {
      if (pt.from === null) return;
      if (pt.to === null) {
        ring(ctx, node(pt.from), coreOf(pt.from) + 6, rgba(color.text3, fade), 1);
        return;
      }
      ctx.setLineDash([2 * c.hair, 4 * c.hair]);
      ctx.strokeStyle = rgba(color.text3, 0.8 * (1 - t));
      ctx.lineWidth = 1;
      partial(ctx, path(pt.from, pt.to), 0, 1);
      ctx.setLineDash([]);
      return;
    }
    case 'outside': {
      // Paid to the outside service: the bead leaves the dish.
      if (pt.from === null) return;
      const a = node(pt.from);
      const b = ringPos(pt.from, c.cx, c.cy, c.r * 1.2);
      const k = easeInOut(t);
      dot(ctx, { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, 3, rgba(color.value, 1 - t * t));
      return;
    }
    case 'commit': {
      // The keeper committed this spore's image hash: a green ✓ by the node.
      if (pt.from === null) return;
      const p = node(pt.from);
      const core = coreOf(pt.from);
      check(ctx, { x: p.x + core + 8, y: p.y - core - 6 }, 3, rgba(color.growth, fade), 1.5);
      return;
    }
    case 'failed': {
      if (pt.from === null) return;
      const p = node(pt.from);
      const core = coreOf(pt.from);
      cross(ctx, { x: p.x + core + 8, y: p.y + core + 6 }, 3, rgba(color.warn, fade), 1.5);
      return;
    }
    case 'close': {
      // The keeper closed the epoch: a yolk ring sweeps from the centre to the dish's edge.
      const k = easeOut(t);
      ring(ctx, { x: c.cx, y: c.cy }, c.r * k, rgba(color.slime, 0.45 * (1 - t)), 2 * c.hair + 2 * (1 - t));
      return;
    }
  }
}
