// The Loop stage (S13). The dish from the Sale scene, so the sale at the end of the
// story happens on the same stage, in the same places: the spore in the middle,
// its agent's line from the owner's corner, the paper label on the dish. What's new
// is the hire and the close: quotes arrive as dashed threads, the winner's turns
// solid, an amber bead pays it, then a ring sweeps the dish and the tube swells.
// The rim is its allowance: a full circle is its owner's budget.
//
// Every pose comes from a line the log has confirmed (model/loop.ts). A tube moves
// only at a close, money only at a settle. Under reduced motion each state is a
// still, and the narrator and the stops say the same in words.
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { fanOut, artDiscR, clamp01, curvePoint, drawArt, drawBead, drawDish, drawMembrane, drawRipple, easeInOut, easeOut, metrics, onRing, plainNode, stageTubeWidth, subCurve, tubeCurveTo, type StageMetrics } from '../graph/stage';
import { fillTube, phaseOf, rgba, VEIN, type FlexClock } from '../graph/flex';
import { useNodeArt, type NodeArtInput } from '../graph/nodeArt';
import { artReach, type Curve, type Pt } from '../model/network';
import type { LoopState } from '../model/loop';
import { loopArtInputs } from '../model/loop';
import type { SceneLine } from '../model/scene';
import { formatNear, tubesText } from '../ui/format';
import { color, hex, motion, paletteOf } from '../ui/tokens';
import { RenderQueueContext } from '../wasm/art';
import { ART_SCALE, angleOf, clampX, DishLabel, drawLimb, limb, partyAnchors, PEER_ART, PHONE, Party, slotAngle, spotOf, type SaleCast, type StageSpots } from './SaleStage';

const TAU = Math.PI * 2;
/** Id of the "when it woke" image in the art map: not a spore id. */
const START_ART = -1;
const RIM = 0.985;

/** The shortest way round from a to b, signed. */
const turn = (a: number, b: number) => {
  const d = (b - a) % TAU;
  return d > Math.PI ? d - TAU : d < -Math.PI ? d + TAU : d;
};

function drawThread(ctx: CanvasRenderingContext2D, q: Curve, reach: number, c: string, alpha: number, width: number) {
  if (reach <= 0.002 || alpha <= 0) return;
  const part = reach >= 0.999 ? q : subCurve(q, reach);
  ctx.save();
  ctx.setLineDash([3, 6]);
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = rgba(c, alpha);
  ctx.beginPath();
  ctx.moveTo(part.p0.x, part.p0.y);
  ctx.bezierCurveTo(part.c0.x, part.c0.y, part.c1.x, part.c1.y, part.p1.x, part.p1.y);
  ctx.stroke();
  ctx.restore();
}

function drawTubeBody(ctx: CanvasRenderingContext2D, q: Curve, width: number, alpha: number, seed: string, k: number, clock: FlexClock, swell: number) {
  const pal = paletteOf(seed);
  const base = { k, angle: phaseOf(k), reveal: 1, swell, clock, taper: [0.6, 0.55] as [number, number] };
  for (const v of VEIN) {
    ctx.fillStyle = rgba(hex(pal.stops[v.stop]), v.alpha * alpha);
    fillTube(ctx, q, { ...base, width: width * v.width });
  }
}

/** The allowance on the dish's rim: a full circle is the owner's budget. */
function drawAllowance(ctx: CanvasRenderingContext2D, m: StageMetrics, share: number) {
  const r = m.dishR * RIM;
  const lw = Math.max(3, m.u * 0.012);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = rgba(color.value, 0.14);
  ctx.beginPath();
  ctx.arc(m.cx, m.cy, r, 0, TAU);
  ctx.stroke();
  if (share > 0.002) {
    ctx.strokeStyle = color.value;
    ctx.beginPath();
    ctx.arc(m.cx, m.cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, share));
    ctx.stroke();
  }
  ctx.restore();
}

export const share = (allowance: string, cap: string | null) => {
  if (!cap || BigInt(cap) === 0n) return 0;
  return Number((BigInt(allowance) * 10_000n) / BigInt(cap)) / 10_000;
};

/** Fetches every render the story will show, so playing it doesn't wait for the worker. */
export function usePrewarm(lines: SceneLine[] | null) {
  const getQueue = useContext(RenderQueueContext);
  useEffect(() => {
    if (!lines?.length) return;
    const ctrl = new AbortController();
    for (const input of loopArtInputs(lines)) {
      getQueue()
        .then((q) => q.request(input, { priority: 5, signal: ctrl.signal }))
        .catch(() => {
          // Only a head start: the stage asks again and shows its own state if this fails.
        });
    }
    return () => ctrl.abort();
  }, [lines, getQueue]);
}

/** Who stands on the dish now, and where: during the hire everyone who quoted, after the close only the tubes. */
export function stageAngles(state: LoopState): Map<number, number> {
  const ids = new Set<number>();
  for (const [id] of state.frame?.tubes ?? []) ids.add(id);
  if (state.job && !state.growth && state.quoted) for (const c of state.job.candidates) ids.add(c.provider);
  return fanOut([...ids].map((id) => ({ id, a: slotAngle(id) })), (20 * Math.PI) / 180);
}

/** The spore on stage as the Sale stage takes it before its first line. */
export function loopCast(s: LoopState): SaleCast | null {
  const f = s.frame;
  if (!f || s.hero === null) return null;
  return { spore: s.hero, owner: f.owner, operator: f.operator, art: f.art, peers: f.peers.filter((p) => f.tubes.some(([n]) => n === p.id)), tubes: f.tubes, balance: f.balance, reputation: f.reputation, age: f.art.age };
}

export function LoopStage({ state, reducedMotion, spots }: { state: LoopState; reducedMotion: boolean; spots?: StageSpots }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const b = el.getBoundingClientRect();
      setSize({ w: Math.round(b.width), h: Math.round(b.height), dpr: Math.min(2, window.devicePixelRatio || 1) });
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { hero, frame, artFrame, start, job } = state;
  const hiring = !!job && !state.growth;
  const targets = useMemo(() => stageAngles(state), [frame, job, state.growth, state.quoted]); // eslint-disable-line react-hooks/exhaustive-deps
  const cast = useMemo(() => [...targets.keys()], [targets]);

  const artItems = useMemo<NodeArtInput[]>(() => {
    if (hero === null || !artFrame || !frame) return [];
    const items: NodeArtInput[] = [{ id: hero, input: artFrame.art, glyph: null }];
    for (const id of cast) {
      const p = frame.peers.find((x) => x.id === id);
      if (p) items.push({ id, input: p, glyph: null });
    }
    if (start && artFrame !== start) items.push({ id: START_ART, input: start.art, glyph: null });
    return items;
  }, [hero, artFrame, frame, cast, start]);
  const art = useNodeArt(artItems);

  const anim = useRef({
    times: new Map<string, number>(),
    lines: 0,
    angles: new Map<number, number>(),
    /** What each tube was before the latest close. */
    fromTubes: new Map<number, number>(),
    closeAt: -1e9,
    swells: new Set<number>(),
    fromShare: 0,
    shareAt: -1e9,
    hero: null as CanvasImageSource | null,
    heroPrev: null as CanvasImageSource | null,
    heroAt: -1e9,
  });
  const latest = useRef({ state, art, reducedMotion, size, targets });
  latest.current = { state, art, reducedMotion, size, targets };

  useEffect(() => {
    const a = anim.current;
    const now = performance.now();
    // A seek isn't an event: what it lands on is drawn as already done.
    const jumped = state.lines < a.lines || state.lines - a.lines > 6;
    a.lines = state.lines;
    const on = new Set(state.moments);
    if (jumped) {
      a.times.clear();
      for (const k of on) a.times.set(k, now - 1e5);
      a.closeAt = -1e9;
      a.shareAt = -1e9;
      a.fromTubes = new Map();
      a.swells = new Set();
    } else {
      const closes = state.moments.filter((k) => (k === 'closed' || k.startsWith('lapse:')) && !a.times.has(k));
      if (closes.length && state.prior && state.frame) {
        const before = new Map(state.prior.tubes.map(([n, d]) => [n, Number(d)]));
        a.fromTubes = before;
        a.closeAt = now;
        a.swells = new Set(state.frame.tubes.filter(([n, d]) => Number(d) > (before.get(n) ?? 0)).map(([n]) => n));
      }
      if (state.moments.some((k) => (k === 'rep' || k.startsWith('lapse:')) && !a.times.has(k)) && state.prior) {
        a.fromShare = share(state.prior.allowance, state.prior.cap);
        a.shareAt = now;
      }
      for (const k of on) if (!a.times.has(k)) a.times.set(k, now);
      for (const k of [...a.times.keys()]) if (!on.has(k)) a.times.delete(k);
    }
    schedule();
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const raf = useRef<number | null>(null);
  const schedule = () => {
    if (raf.current === null && typeof requestAnimationFrame === 'function') raf.current = requestAnimationFrame(paint);
  };
  useEffect(() => () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  const paint = () => {
    raf.current = null;
    const el = canvas.current;
    const { state: s, art: arts, reducedMotion: still, size: z, targets: goal } = latest.current;
    const ctx = el?.getContext?.('2d');
    if (!el || !ctx || z.w === 0 || s.saleStarted) return;
    if (el.width !== z.w * z.dpr || el.height !== z.h * z.dpr) {
      el.width = z.w * z.dpr;
      el.height = z.h * z.dpr;
    }
    ctx.setTransform(z.dpr, 0, 0, z.dpr, 0, 0);
    ctx.clearRect(0, 0, z.w, z.h);
    const m = metrics(z.w, z.h);
    const now = performance.now();
    const clock: FlexClock = { now, ambient: !still };
    const a = anim.current;
    const since = (k: string) => (a.times.has(k) ? now - a.times.get(k)! : null);
    const through = (k: string, ms: number) => {
      const t = since(k);
      if (t === null) return 0;
      return still ? 1 : clamp01(t / ms);
    };
    let moving = !still;
    const going = (u: number) => {
      if (u > 0 && u < 1) moving = true;
      return u;
    };

    drawDish(ctx, m);
    const f = s.frame;
    if (!f || s.hero === null) return;

    // Who stands where: they ease to a new place when the cast changes, never jump.
    for (const [id, t] of goal) {
      const cur = a.angles.get(id);
      if (cur === undefined || still) a.angles.set(id, t);
      else {
        const d = turn(cur, t);
        if (Math.abs(d) > 0.002) {
          a.angles.set(id, cur + d * 0.12);
          moving = true;
        } else a.angles.set(id, t);
      }
    }

    const anchors = partyAnchors(z.w, z.h, m);
    const gate = angleOf(m, anchors.seller);
    const seed = f.art.seed;
    const seedOf = (id: number) => f.peers.find((p) => p.id === id)?.seed ?? null;
    const side = m.artR * ART_SCALE;

    // The allowance on the rim.
    const nowShare = share(f.allowance, f.cap);
    const heldShare = s.rep || s.lapses ? nowShare : share((s.prior ?? f).allowance, (s.prior ?? f).cap);
    const u = still ? 1 : clamp01((now - a.shareAt) / motion.epoch);
    going(u);
    drawAllowance(ctx, m, a.fromShare + (heldShare - a.fromShare) * easeOut(u));

    // Tubes tween at a close, and only there.
    const closeU = still ? 1 : clamp01((now - a.closeAt) / motion.epoch);
    going(closeU);
    const tubeNow = new Map(f.tubes.map(([n, d]) => [n, Number(d)]));
    const dMax = Math.max(1, ...tubeNow.values(), ...a.fromTubes.values());
    const pathTo = (id: number, reachD: number) => {
      const angle = a.angles.get(id);
      if (angle === undefined) return null;
      const startR = artDiscR(artReach(reachD, f.tubes.length || 1), side);
      return tubeCurveTo(m, slotAngle(id), angle, m.ringR, id % 2 ? 1 : -1, startR);
    };
    const ids = new Set<number>([...tubeNow.keys(), ...(closeU < 1 ? a.fromTubes.keys() : [])]);
    for (const id of ids) {
      const d = tubeNow.get(id) ?? 0;
      const was = closeU < 1 ? (a.fromTubes.get(id) ?? 0) : d;
      const shown = was + (d - was) * (d >= was ? easeOut(closeU) : easeInOut(closeU));
      if (shown <= 0) continue;
      const q = pathTo(id, Math.max(d, was));
      if (!q) continue;
      const swell = a.swells.has(id) && closeU < 1 ? closeU : 0;
      const fade = d === 0 ? 1 - closeU : 1;
      drawTubeBody(ctx, q, Math.max(1, stageTubeWidth(shown, dMax, m.u)), (0.5 + 0.5 * Math.sqrt(shown / dMax)) * fade, seed, 1000 + id, clock, swell);
    }

    // The hire: threads, then the winner's line, then the money.
    const j = s.job;
    const hiringNow = !!j && !s.growth;
    if (j && (hiringNow || closeU < 1)) {
      const out = s.growth ? 1 - closeU : 1;
      j.candidates.forEach((c, i) => {
        const q = pathTo(c.provider, Number(c.d));
        if (!q) return;
        const won = c.provider === j.winner;
        const back: Curve = { p0: q.p1, c0: q.c1, c1: q.c0, p1: q.p0 };
        const t = through('quotes', motion.epoch + i * 200);
        going(t);
        const hired = through('hired', motion.epoch);
        going(hired);
        if (won && s.hired) drawLimb(ctx, q, easeOut(hired), m.u * 0.022, 3100 + c.provider, clock, color.agent, out);
        drawThread(ctx, back, easeOut(t), color.agent, (won ? 1 - hired * 0.8 : 0.85 * (1 - hired * 0.75)) * out, Math.max(1.5, m.u * 0.008));
        if (won && s.delivered && !s.paid) {
          const v = through('delivered', motion.grow);
          going(v);
          if (v < 1 && !still) drawBead(ctx, curvePoint(back, easeInOut(v)), m.u * 0.012, 0.6);
        }
        if (won && s.paid) {
          const v = through('paid', motion.grow);
          going(v);
          if (v < 1 && !still) drawBead(ctx, curvePoint(q, easeInOut(v)), m.u * 0.024);
          const r = clamp01((v - 0.75) / 0.25);
          if (r > 0 && r < 1 && !still) drawRipple(ctx, q.p1, m.u * (0.04 + 0.16 * easeOut(r)), color.growth, 1 - r);
        }
      });
    }

    // Partners: their own art, at their ring slots. Those who lost the quote step back.
    for (const id of goal.keys()) {
      const angle = a.angles.get(id);
      if (angle === undefined) continue;
      const pos = onRing(m, angle, m.ringR);
      const isTube = tubeNow.has(id);
      const lost = !!j && hiringNow && s.hired && id !== j.winner && !isTube;
      const appear = isTube ? 1 : through('quotes', motion.art);
      going(appear);
      const alpha = appear * (lost ? 0.35 : 1);
      plainNode(ctx, pos, m.u * 0.012 * appear, seedOf(id));
      const img = arts.get(id);
      if (img) drawArt(ctx, img, pos, m.u * PEER_ART, alpha);
    }

    // A close: a ring sweeps the dish.
    const sweepU = still ? 1 : clamp01((now - a.closeAt) / motion.pulse);
    going(sweepU);
    if (!still && sweepU < 1) drawRipple(ctx, { x: m.cx, y: m.cy }, m.dishR * easeOut(sweepU), color.slime, 0.9 * (1 - sweepU));

    // The agent's key: from its owner's corner to the spore.
    const inner = onRing(m, gate, m.artR * 0.62);
    const keyU = through('wake', motion.grow);
    going(keyU);
    if (f.operator) drawLimb(ctx, limb(anchors.seller, inner, 1), easeOut(keyU), m.u * 0.03, 3001, clock, color.agent);

    // The spore. An image stays until the next is complete, then crossfades (Design §3.5).
    const center = { x: m.cx, y: m.cy };
    const img = arts.get(s.hero) ?? null;
    if (img !== a.hero) {
      a.heroPrev = a.hero;
      a.hero = img;
      a.heroAt = now;
    }
    const fade = still ? 1 : clamp01((now - a.heroAt) / motion.art);
    going(fade);
    const breath = still ? 1 : 0.94 + 0.06 * Math.sin((Math.PI * now) / motion.breathe);
    const bloom = s.beat === 'art' ? through('art', motion.grow) : 1;
    going(bloom);
    const grow = 1 + 0.07 * Math.sin(Math.PI * bloom) * (still ? 0 : 1);
    if (a.hero) {
      if (a.heroPrev && fade < 1) drawArt(ctx, a.heroPrev, center, side * grow, breath * (1 - fade));
      drawArt(ctx, a.hero, center, side * grow, breath * (a.heroPrev ? fade : 1));
    } else plainNode(ctx, center, m.u * 0.05, seed);
    if (!still && s.beat === 'art' && bloom < 1) drawRipple(ctx, center, m.artR * (0.8 + 0.5 * easeOut(bloom)), color.slime, 0.8 * (1 - bloom));
    // Waking and posting: a violet ring closes round it; a ripple goes out when it asks.
    const wakeU = through('wake', motion.grow);
    if (!still && wakeU < 1) drawRipple(ctx, center, m.artR * (1.5 - 0.7 * easeOut(wakeU)), color.agent, wakeU);
    const postU = through('post', motion.pulse);
    going(postU);
    if (!still && postU > 0 && postU < 1) drawRipple(ctx, center, m.artR * (0.8 + 1.1 * easeOut(postU)), color.agent, 0.8 * (1 - postU));

    drawMembrane(ctx, m, [], clock, 0.5);

    // How it looked when it woke, once it looks different.
    const first = arts.get(START_ART);
    if (first && s.artFrame !== s.start) {
      const v = through('art', motion.art);
      going(v);
      const thumb = m.u * 0.46;
      drawArt(ctx, first, { x: z.w - thumb / 2, y: thumb / 2 }, thumb, v * 0.9);
    }

    if (moving) schedule();
  };
  useEffect(() => {
    schedule();
  });

  const m = size.w ? metrics(size.w, size.h) : null;
  const pct = (p: Pt) => ({ left: `${(p.x / size.w) * 100}%`, top: `${(p.y / size.h) * 100}%` });
  const hiringNotes = !!job && hiring && state.quoted;
  const summary = frame ? `Spore #${hero} in a dish, owned by ${frame.owner}. ${tubesText(frame.tubes.length)}.` : 'The dish, empty until the first reading.';

  return (
    <div className="stage sale-stage loop-stage" ref={box}>
      <canvas ref={canvas} className="stage-canvas" role="img" aria-label={summary} />
      {frame && m && (
        <div className="stage-notes">
          {!spots && targets.size > 0 &&
            [...targets].map(([id, angle]) => {
              const d = frame.tubes.find(([n]) => n === id)?.[1];
              const quote = hiringNotes ? job!.candidates.find((c) => c.provider === id) : null;
              const lost = !!quote && state.hired && job!.winner !== id;
              const won = !!quote && state.hired && job!.winner === id;
              return (
                <span key={id} className={`stage-note ${Math.sin(angle) >= 0 ? 'is-right' : 'is-left'}${lost ? ' is-gone' : ''}`} style={pct(clampX(onRing(m, angle, m.ringR + m.u * (size.w < PHONE ? 0.1 : 0.15)), size.w))}>
                  <span className="mono-s">#{id}</span>
                  {quote && <span className={`mono-s ${won ? 'money' : 'stage-d'}`}>{formatNear(quote.price)}</span>}
                  {!quote && d !== undefined && <span className={`mono-s stage-d${state.growth?.partner === id && !state.saleStarted ? ' is-grown' : ''}`} key={d}>D {Number(d).toLocaleString('en-US')}</span>}
                </span>
              );
            })}
        </div>
      )}
      {frame && m && state.beat === 'rep' && (
        // While the rim moves, it says what it is.
        <span className={`stage-note loop-rim mono-s money ${share(frame.allowance, frame.cap) < 0.5 ? 'is-right' : 'is-left'}`} style={pct(onRing(m, TAU * Math.min(1, share(frame.allowance, frame.cap)), m.dishR * RIM))}>
          may spend {formatNear(frame.allowance)}
        </span>
      )}
      {frame && m && spots && hero !== null && (
        <div className="stage-spots">
          {spots.hero(hero, m.artR * 2)}
          {[...targets].map(([id, angle]) => {
            const quote = hiringNotes ? job!.candidates.find((c) => c.provider === id) : null;
            const lost = !!quote && state.hired && job!.winner !== id;
            const won = !!quote && state.hired && job!.winner === id;
            const grown = state.growth?.partner === id && !state.saleStarted;
            const d = frame.tubes.find(([n]) => n === id)?.[1] ?? null;
            return <span key={id}>{spots.peer(spotOf(m, size, angle, { id, d, quote: quote?.price ?? null, state: lost ? 'lost' : won ? 'won' : grown ? 'grown' : 'plain' }))}</span>;
          })}
        </div>
      )}
      {start && artFrame && artFrame !== start && (
        <span className="stage-note loop-then mono-s" style={{ right: 0, top: 0 }}>
          when it woke{spots ? '' : ` · E ${start.epoch}`}
        </span>
      )}
      {frame && m && (
        <div className="dish-label-slot" style={pct(onRing(m, Math.PI, m.dishR * 0.86))}>
          <DishLabel key={frame.owner} name={frame.owner} />
        </div>
      )}
      {frame && <Party cls="party-seller" role="owner" name={frame.owner} delta={null} agent={frame.operator ? frame.operator.split('.')[0] : null} agentWord="its agent" />}
    </div>
  );
}

