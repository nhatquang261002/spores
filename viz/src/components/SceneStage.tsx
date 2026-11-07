// The Rogue stage (S11). What a first-time viewer watches: the spore in its
// dish, the contract as a membrane, attempts as pseudopods that the membrane
// stops. Motion follows the log (Design §3.5): a pseudopod grows when its tx was
// sent, the membrane answers only at the tx's final outcome, tubes fall only at
// a close. Under reduced motion each state is drawn as a still; the lanes and
// the narrator say the same in words.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  artDiscR,
  clamp01,
  drawArt,
  drawBead,
  drawDish,
  drawHole,
  drawMembrane,
  drawPod,
  drawRipple,
  drawStamp,
  drawTube,
  easeInOut,
  easeOut,
  escrowPoint,
  gateLayout,
  metrics,
  onRing,
  plainNode,
  podCurve,
  REACH_MS,
  RETREAT_MS,
  stageTubeWidth,
  tubeCurveTo,
  type MembraneBulge,
} from '../graph/stage';
import { useNodeArt, type NodeArtInput } from '../graph/nodeArt';
import { artReach, curvePoint } from '../model/network';
import { refusalCount, type AttemptKey, type PeerArt, type SceneState } from '../model/scene';
import { formatNear } from '../ui/format';
import { color, motion } from '../ui/tokens';

export interface StageCast {
  spore: number;
  provider: number | null;
  attacker: string;
  art: PeerArt | null;
  peers: PeerArt[];
  tubes: [number, string][];
  balance: string | null;
  reputation: string | null;
  dMin: string | null;
}

/** Who is on stage from the log (or, before a run, from the caller's read of the chain). */
export function castOf(scene: SceneState, idle: StageCast | null): StageCast | null {
  if (!scene.start) return idle;
  const now = scene.now;
  return {
    spore: scene.start.spore,
    provider: scene.start.provider,
    attacker: scene.start.attacker,
    art: now?.art ?? scene.start.peers.find((p) => p.id === scene.start!.spore) ?? null,
    peers: scene.start.peers,
    tubes: now?.connections ?? [],
    balance: now?.balance ?? null,
    reputation: now?.reputation ?? null,
    dMin: scene.start.d_min,
  };
}

interface TryAnim {
  id: string;
  attempt: AttemptKey;
  decision: 'pending' | 'refused' | 'allowed';
  label: string;
  sentAt: number;
  decidedAt: number | null;
}

const LABEL_GAP = 0.15;
/** Side of another spore's art on the ring, as a share of the half side. */
const PEER_ART = 0.34;
/** The spore's art side, as a share of artR. */
const ART_SCALE = 2.1;

export function SceneStage({ scene, idle, reducedMotion }: { scene: SceneState; idle: StageCast | null; reducedMotion: boolean }) {
  const cast = castOf(scene, idle);
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

  const partnerIds = useMemo(() => {
    const first = scene.before?.connections ?? cast?.tubes ?? [];
    return first.map(([n]) => n);
  }, [scene.before, cast?.tubes]);
  const gates = useMemo(() => (cast && cast.provider !== null ? gateLayout(partnerIds, cast.provider) : null), [partnerIds, cast?.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const artItems = useMemo<NodeArtInput[]>(() => {
    if (!cast) return [];
    const items: NodeArtInput[] = [];
    if (cast.art) items.push({ id: cast.spore, input: cast.art, glyph: null });
    for (const p of cast.peers) if (p.id !== cast.spore) items.push({ id: p.id, input: p, glyph: null });
    return items;
  }, [cast]);
  const art = useNodeArt(artItems);

  // Everything the paint reads, always current.
  const anim = useRef({
    tries: new Map<string, TryAnim>(),
    tubes: new Map<number, { from: number; to: number; at: number; gone: boolean }>(),
    dMax: 1,
    sweepAt: -Infinity,
    closes: 0,
    escrowBack: null as number | null,
    hadEscrow: false,
    artPrev: null as CanvasImageSource | null,
    artNow: null as CanvasImageSource | null,
    artAt: -Infinity,
    lines: 0,
  });
  const latest = useRef({ scene, cast, gates, art, reducedMotion, size });
  latest.current = { scene, cast, gates, art, reducedMotion, size };

  // Turn the log into poses. A seek backwards starts clean rather than animating history.
  useEffect(() => {
    const a = anim.current;
    const now = performance.now();
    const stale = scene.lines < a.lines;
    a.lines = scene.lines;
    if (stale) {
      a.tries.clear();
      a.tubes.clear();
      a.closes = 0;
      a.sweepAt = -Infinity;
      a.hadEscrow = false;
      a.escrowBack = null;
    }
    for (const at of scene.attempts) {
      for (const t of at.tries) {
        const cur = a.tries.get(t.id);
        if (!cur) a.tries.set(t.id, { id: t.id, attempt: at.key, decision: t.decision, label: t.amount ? formatNear(t.amount) : '', sentAt: stale ? now - 1e5 : now, decidedAt: t.decision === 'pending' ? null : stale ? now - 1e5 : now });
        else if (cur.decision !== t.decision) {
          cur.decision = t.decision;
          cur.decidedAt = now;
        }
      }
    }
    for (const id of [...a.tries.keys()]) {
      if (!scene.attempts.some((at) => at.tries.some((t) => t.id === id))) a.tries.delete(id);
    }
    const tubes = cast?.tubes ?? [];
    const initial = scene.before?.connections ?? tubes;
    a.dMax = initial.reduce((m, [, d]) => Math.max(m, Number(d)), 1);
    for (const [id, d] of initial) {
      if (!a.tubes.has(id)) a.tubes.set(id, { from: Number(d), to: Number(d), at: now - 1e5, gone: false });
    }
    for (const [id, cur] of a.tubes) {
      const next = tubes.find(([n]) => n === id);
      const to = next ? Number(next[1]) : 0;
      const known = !!next || !!scene.before;
      if (known && to !== cur.to) {
        const fromNow = cur.from + (cur.to - cur.from) * tubeProgress(cur.at, now);
        a.tubes.set(id, { from: stale ? to : fromNow, to, at: stale ? now - 1e5 : now, gone: !next });
      }
    }
    if (scene.closes > a.closes) {
      a.sweepAt = now;
    }
    a.closes = scene.closes;
    if (a.hadEscrow && !scene.escrow) a.escrowBack = now;
    if (scene.escrow) a.escrowBack = null;
    a.hadEscrow = !!scene.escrow;
    schedule();
  }, [scene, cast]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const img = cast ? (art.get(cast.spore) ?? null) : null;
    const a = anim.current;
    if (img !== a.artNow) {
      a.artPrev = a.artNow;
      a.artNow = img;
      a.artAt = performance.now();
    }
    schedule();
  }, [art, cast?.spore]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const { scene: s, cast: c, gates: g, art: arts, reducedMotion: still, size: z } = latest.current;
    const ctx = el?.getContext?.('2d');
    if (!el || !ctx || z.w === 0) return;
    if (el.width !== z.w * z.dpr || el.height !== z.h * z.dpr) {
      el.width = z.w * z.dpr;
      el.height = z.h * z.dpr;
    }
    ctx.setTransform(z.dpr, 0, 0, z.dpr, 0, 0);
    ctx.clearRect(0, 0, z.w, z.h);
    const m = metrics(z.w, z.h);
    const now = performance.now();
    const clock = { now, ambient: !still };
    const a = anim.current;
    drawDish(ctx, m);
    if (!c) return;

    const bulges: MembraneBulge[] = [];
    const seedOf = (id: number) => (id === c.spore ? c.art?.seed : c.peers.find((p) => p.id === id)?.seed) ?? null;
    const sporeSeed = c.art?.seed ?? null;
    let moving = !still;

    // Close sweep (Design §3.5): the ring runs out from the centre while the tubes tween.
    const sweep = clamp01((now - a.sweepAt) / motion.pulse);
    if (!still && sweep < 1) {
      drawRipple(ctx, { x: m.cx, y: m.cy }, m.dishR * easeOut(sweep), color.slime, 0.5 * (1 - sweep));
      moving = true;
    }

    // Tubes, under the membrane and the art.
    if (g) {
      for (const [id, t] of a.tubes) {
        const angle = g.partners.get(id);
        if (angle === undefined) continue;
        const u = still ? 1 : tubeProgress(t.at, now);
        if (u < 1) moving = true;
        const d = t.from + (t.to - t.from) * u;
        const fade = t.gone ? 1 - clamp01((now - t.at) / motion.grow) : 1;
        if (t.gone && still) continue;
        if (fade <= 0) continue;
        const initial = s.before?.connections.find(([n]) => n === id);
        const first = initial ? Number(initial[1]) : d;
        const startR = artDiscR(artReach(d, c.tubes.length || 1), m.artR * ART_SCALE);
        const q = tubeCurveTo(m, slotAngleOf(id), angle, m.ringR, id % 2 ? 1 : -1, startR);
        const width = Math.max(1, stageTubeWidth(d, a.dMax, m.u));
        const brightness = (0.5 + 0.5 * Math.sqrt(d / a.dMax)) * fade;
        if (sporeSeed) drawTube(ctx, q, width, brightness, sporeSeed, 1000 + id, clock, first > d + 1 ? stageTubeWidth(first, a.dMax, m.u) : null);
        const pos = onRing(m, angle, m.ringR);
        const side = m.u * PEER_ART;
        plainNode(ctx, pos, m.u * 0.012, seedOf(id));
        const img = arts.get(id);
        if (img) drawArt(ctx, img, pos, side, fade);
      }

      // The provider and the attacker, outside the wall.
      if (c.provider !== null) {
        const pos = onRing(m, g.provider, m.ringR);
        // A young spore's art is mostly dark: the nucleus always marks where it is.
        plainNode(ctx, pos, m.u * 0.018, seedOf(c.provider));
        const img = arts.get(c.provider);
        if (img) drawArt(ctx, img, pos, m.u * PEER_ART, 1);
      }
      drawHole(ctx, onRing(m, g.attacker, m.ringR), m.u * 0.055);
    }

    // The attempts.
    const stamps: { angle: number; at: number }[] = [];
    const pods: (() => void)[] = [];
    if (g) {
      for (const t of a.tries.values()) {
        const angle = g[t.attempt];
        const width = m.u * 0.034;
        const k = 2000 + hashId(t.id);
        const reachT = still ? 1 : clamp01((now - t.sentAt) / REACH_MS);
        const bead = m.u * 0.022;
        if (t.decision === 'pending') {
          const reach = easeOut(reachT);
          const push = m.u * 0.085 * clamp01((reach - 0.6) / 0.4);
          bulges.push({ angle, push, part: 0, flash: 0 });
          const q = podCurve(m, angle, m.membraneR + push);
          pods.push(() => drawPod(ctx, q, reach, width, k, clock, { r: bead, label: t.label }));
          moving = true;
        } else if (t.decision === 'refused') {
          const u = still ? 1 : clamp01((now - (t.decidedAt ?? now)) / RETREAT_MS);
          const flash = still ? 0 : clamp01(1 - (now - (t.decidedAt ?? now)) / motion.grow);
          if (u < 1 || flash > 0) moving = true;
          const push = m.u * 0.085 * (1 - easeOut(u));
          bulges.push({ angle, push, part: 0, flash });
          stamps.push({ angle, at: t.decidedAt ?? now });
          const q = podCurve(m, angle, m.membraneR + push);
          const reach = 1 - easeInOut(u);
          pods.push(() => drawPod(ctx, q, reach, width, k, clock, reach > 0.05 ? { r: bead, label: t.label } : null));
        } else {
          // Allowed: the wall parts, the bead goes through and waits in escrow beyond it.
          const u = still ? 1 : clamp01((now - (t.decidedAt ?? now)) / motion.grow);
          if (u < 1) moving = true;
          const part = Math.sin(Math.PI * u);
          bulges.push({ angle, push: 0, part, flash: 0 });
          const outR = m.membraneR + (m.ringR - m.membraneR) * 0.55;
          const q = podCurve(m, angle, outR);
          const reach = u < 0.6 ? easeOut(u / 0.6) : 1 - easeInOut((u - 0.6) / 0.4);
          pods.push(() => drawPod(ctx, q, reach, width, k, clock, null));
          const back = a.escrowBack;
          const rest = escrowPoint(m, angle, g.provider);
          const out = onRing(m, angle, outR);
          const mix = (p: { x: number; y: number }, r: { x: number; y: number }, w: number) => ({ x: p.x + (r.x - p.x) * w, y: p.y + (r.y - p.y) * w });
          if (s.escrow && u > 0) {
            const tip = u < 0.6 ? curvePoint(q, easeOut(u / 0.6)) : mix(out, rest, easeInOut((u - 0.6) / 0.4));
            drawBead(ctx, tip, bead);
          } else if (back !== null && !still && now - back < motion.grow) {
            drawBead(ctx, mix(rest, { x: m.cx, y: m.cy }, easeInOut((now - back) / motion.grow)), bead);
            moving = true;
          }
        }
      }
    }

    // The spore, its art crossfading when a close changed it (Design §3.5, New art).
    const center = { x: m.cx, y: m.cy };
    const side = m.artR * ART_SCALE;
    const breath = still ? 1 : 0.94 + 0.06 * Math.sin((Math.PI * now) / motion.breathe);
    const xf = still ? 1 : clamp01((now - a.artAt) / motion.art);
    if (a.artPrev && xf < 1) {
      drawArt(ctx, a.artPrev, center, side, (1 - xf) * breath);
      moving = true;
    }
    if (a.artNow) drawArt(ctx, a.artNow, center, side, xf * breath);
    else plainNode(ctx, center, m.u * 0.05, sporeSeed);

    pods.forEach((f) => f());

    // The wall goes in once the owner has set limits; before that the spore has only its default policy.
    // Thin before the owner narrows it and after the policy is restored, full while the limits are the story.
    drawMembrane(ctx, m, bulges, clock, s.limitsSet ? 1 : 0.5);

    for (const st of stamps) {
      const age = still ? 1 : clamp01((now - st.at) / motion.ui);
      if (age < 1) moving = true;
      const size2 = m.u * 0.022 * (1 + 0.9 * (1 - easeOut(age)));
      const p = onRing(m, st.angle, m.membraneR);
      drawStamp(ctx, p, size2, Math.min(1, 0.4 + age));
      const rippleT = clamp01((now - st.at) / motion.art);
      if (!still && rippleT < 1) {
        drawRipple(ctx, p, m.u * (0.02 + 0.13 * easeOut(rippleT)), color.warn, 0.7 * (1 - rippleT));
        moving = true;
      }
    }

    if (moving) schedule();
  };
  // Paint with the newest closure.
  useEffect(() => {
    schedule();
  });

  const m = size.w ? metrics(size.w, size.h) : null;
  const pct = (p: { x: number; y: number }) => ({ left: `${(p.x / size.w) * 100}%`, top: `${(p.y / size.h) * 100}%` });
  const side = (angle: number) => (Math.sin(angle) >= 0 ? 'is-right' : 'is-left');
  const lim = scene.start?.limits;
  const count = refusalCount(scene);
  const summary = cast
    ? `Spore #${cast.spore} in a dish. The contract is a wall round it. ${count.refused} of ${count.total} attempts refused so far. ${cast.tubes.length} tubes.`
    : 'The dish, empty until a spore is known.';
  const gateTip = (key: AttemptKey) => scene.attempts.find((a) => a.key === key)?.tries.at(-1);

  return (
    <div className="stage" ref={box}>
      <canvas ref={canvas} className="stage-canvas" role="img" aria-label={summary} />
      {cast && m && gates && (
        <div className="stage-notes">
          {[...gates.partners].map(([id, angle]) => {
            const tube = cast.tubes.find(([n]) => n === id);
            const gone = !tube && !!scene.before;
            return (
              <span key={id} className={`stage-note ${side(angle)}${gone ? ' is-gone' : ''}`} style={pct(onRing(m, angle, m.ringR + m.u * LABEL_GAP))}>
                <span className="mono-s">#{id}</span>
                {tube && <span className="mono-s stage-d">D {Number(tube[1]).toLocaleString('en-US')}</span>}
                {gone && <span className="mono-s stage-d"><span className="stage-long">tube </span>removed</span>}
              </span>
            );
          })}
          {cast.provider !== null && (
            <span className={`stage-note ${side(gates.provider)}`} style={pct(onRing(m, gates.provider, m.ringR + m.u * LABEL_GAP))}>
              <span className="mono-s">#{cast.provider}</span>
              <span className="label stage-role">quotes for the agent</span>
            </span>
          )}
          <span className={`stage-note stage-attacker ${side(gates.attacker)}`} style={pct(onRing(m, gates.attacker, m.ringR + m.u * 0.08))}>
            <AccountName name={cast.attacker} />
            <span className="label stage-role">never approved by the owner</span>
          </span>
          <span className={`stage-note stage-wall ${side(gates.wall)}`} style={pct(onRing(m, gates.wall, m.membraneR + m.u * 0.05))}>
            <span className="label">the contract</span>
          </span>
          {lim && (scene.limitsSet || scene.verdict.status === 'completed' || scene.verdict.status === 'failed') && (
            <>
              <GateNote at={pct(onRing(m, gates.cap, m.membraneR + m.u * 0.09))} cls={side(gates.cap)} word={`cap ${formatNear(lim.max_payment)}`} tried={gateTip('cap')?.decision} />
              <GateNote at={pct(onRing(m, gates.budget, m.membraneR + m.u * 0.09))} cls={side(gates.budget)} word={<>budget {formatNear(lim.budget_per_epoch)}<span className="stage-long"> / epoch</span></>} tried={gateTip('budget')?.decision} />
              {/* Rotated up the wall, so it clears the hole on the same radius. */}
              <GateNote at={pct(onRing(m, gates.drain + (Math.sin(gates.drain) >= 0 ? -0.34 : 0.34), m.membraneR + m.u * 0.07))} cls={side(gates.drain)} word="no outside payees" tried={gateTip('drain')?.decision} />
            </>
          )}
        </div>
      )}
      {cast && (
        <div className="stage-plate">
          <span className="display-s">Spore #{cast.spore}</span>
          <span className="mono">
            {cast.balance ? <span className="money">{formatNear(cast.balance)}</span> : '—'}
            {scene.escrow && <span className="stage-escrow"> + {formatNear(scene.escrow.amount)} in escrow</span>}
          </span>
          <span className="mono">reputation {cast.reputation ? (Number(cast.reputation) / 1000).toFixed(2) : '—'}</span>
        </div>
      )}
    </div>
  );
}

/** On a narrow dish only the name's first part fits; the whole name is in the proof below. */
function AccountName({ name }: { name: string }) {
  const dot = name.indexOf('.');
  return (
    <span className="mono-s tone-warn">
      {dot > 0 ? name.slice(0, dot) : name}
      {dot > 0 && <span className="stage-long">{name.slice(dot)}</span>}
    </span>
  );
}

function GateNote({ at, cls, word, tried }: { at: { left: string; top: string }; cls: string; word: ReactNode; tried?: 'pending' | 'refused' | 'allowed' }) {
  return (
    <span className={`stage-note stage-gate ${cls}${tried === 'refused' ? ' is-hit' : ''}`} style={at}>
      <span className="mono-s">{word}</span>
      {tried === 'refused' && (
        <span className="stamp is-refused is-small">
          <span aria-hidden="true">✕</span> Refused
        </span>
      )}
    </span>
  );
}

const tubeProgress = (at: number, now: number) => clamp01((now - at) / motion.epoch);
const slotAngleOf = (id: number) => ((id % 64) * Math.PI * 2) / 64;
const hashId = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 4096;
