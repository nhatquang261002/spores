// The Sale stage (S12). The organism stays put in its dish, with its tubes, money
// and age. What changes is everything round it: the paper label on the dish (who
// owns it), the violet key line (who runs it), the money. Everything is drawn
// from the log (Design §3.5): the label flips and the old key is cut only at the
// `buy` tx's final outcome, money moves only when a receipt says so, and a tube
// never moves here, because nothing in a sale touches one. Under reduced motion
// each state is a still; the narrator and the checklist say the same in words.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fanOut, artDiscR, clamp01, drawArt, drawBead, drawDish, drawMembrane, drawRipple, drawStamp, drawTube, easeInOut, easeOut, metrics, onRing, plainNode, stageTubeWidth, subCurve, tubeCurveTo, type MembraneBulge, type StageMetrics } from '../graph/stage';
import { fillTube, rgba, type FlexClock } from '../graph/flex';
import { useNodeArt, type NodeArtInput } from '../graph/nodeArt';
import { artReach, curvePoint, type Curve, type Pt } from '../model/network';
import { accountWord, type SaleState } from '../model/sale';
import type { PeerArt } from '../model/scene';
import { repText } from '../model/scene';
import { formatNear, tubesText } from '../ui/format';
import { breakpoint, color, motion } from '../ui/tokens';
import type { SheetRow } from './StageAids';

/** Who is on stage before a run: read from the chain by the page. */
export interface SaleCast {
  spore: number;
  owner: string | null;
  /** The agent running it now, as read; a key line is drawn only for one the chain names. */
  operator: string | null;
  art: PeerArt | null;
  peers: PeerArt[];
  tubes: [number, string][];
  balance: string | null;
  reputation: string | null;
  age: number | null;
}

export function saleCastOf(s: SaleState, idle: SaleCast | null): SaleCast | null {
  if (!s.start) return idle;
  const now = s.now;
  return {
    spore: s.start.spore,
    owner: s.owner,
    operator: s.sold ? (s.appointed ? s.start.new_operator : null) : s.start.old_operator,
    art: now?.art ?? null,
    peers: s.start.peers,
    tubes: now?.connections ?? s.start.peers.map((p) => [p.id, '0'] as [number, string]),
    balance: now?.balance ?? null,
    reputation: now ? String(now.reputation) : null,
    age: now?.age ?? null,
  };
}

/** A spore on the stage, for a page that makes it something you can point at (the Overview). */
export interface PeerSpot {
  id: number;
  /** Its tube to the spore in the middle, D; null if there's none yet. */
  d: string | null;
  /** What it quoted for the job on stage. */
  quote: string | null;
  state: 'plain' | 'won' | 'lost' | 'grown';
  /** Its tube fell under the minimum and is gone. */
  removed?: boolean;
  /** What it's doing on this stage, if not trading with the spore. */
  role?: string;
  /** Where it stands and where its id goes, % of the stage. */
  at: { left: string; top: string };
  label: { left: string; top: string };
  right: boolean;
  size: number;
}
/** Given, the stage leaves its figures to the page and draws these over its spores instead. */
export interface StageSpots {
  peer: (p: PeerSpot) => ReactNode;
  hero: (id: number, size: number) => ReactNode;
}

/** A spore's spot on the stage: its id clear of its art, which reaches 0.17 u from where it stands. */
export function spotOf(m: StageMetrics, size: { w: number; h: number }, angle: number, p: Pick<PeerSpot, 'id' | 'd' | 'quote' | 'state'>): PeerSpot {
  const pct = (q: Pt) => ({ left: `${(q.x / size.w) * 100}%`, top: `${(q.y / size.h) * 100}%` });
  return { ...p, at: pct(onRing(m, angle, m.ringR)), label: pct(clampY(clampX(onRing(m, angle, m.ringR + m.u * 0.2), size.w), size.h)), right: Math.sin(angle) >= 0, size: m.u * PEER_ART };
}

export const ART_SCALE = 2.1;
/** Height kept clear for a party's words at the stage's foot, px. */
const PARTY_H = 92;
/** Stage width below which the phone layout applies (`breakpoint.md`). */
export const PHONE = breakpoint.md;
/** Room a tube's short id needs at the stage's edge, px. */
const ID_ROOM = 30;
/** Half a one-line note's height, px. */
const NOTE_ROOM = 10;
export const PEER_ART = 0.34;
const TAU = Math.PI * 2;
export const slotAngle = (id: number) => ((id % 64) * TAU) / 64;
export const angleOf = (m: StageMetrics, p: Pt) => Math.atan2(p.x - m.cx, -(p.y - m.cy));

/** The parties' places: the corners a round dish leaves free in the stage. */
export function partyAnchors(w: number, h: number, m: StageMetrics) {
  const dx = Math.min(w / 2, m.u * 1.06) * 0.86;
  const dy = Math.min(h / 2, m.u * 1.06) * 0.86;
  // Lines start just above the party's words, which can grow to four lines.
  const low = Math.min(m.cy + dy, h - PARTY_H);
  // On a phone the top band holds the plate, so the royalty account stands between the other two.
  const royalty = w < PHONE ? { x: m.cx, y: h - PARTY_H * 0.72 } : { x: m.cx + dx, y: m.cy - dy };
  return { seller: { x: m.cx - dx, y: low }, buyer: { x: m.cx + dx, y: low }, royalty };
}

/** A line grown from a party to a point: bowed, so it reads as grown rather than ruled. */
export function limb(from: Pt, to: Pt, lean: number): Curve {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const bow = { x: -dy * 0.14 * lean, y: dx * 0.14 * lean };
  return { p0: from, c0: { x: from.x + dx * 0.33 + bow.x, y: from.y + dy * 0.33 + bow.y }, c1: { x: from.x + dx * 0.66 + bow.x, y: from.y + dy * 0.66 + bow.y }, p1: to };
}

export function drawLimb(ctx: CanvasRenderingContext2D, q: Curve, reach: number, width: number, k: number, clock: FlexClock, c: string, alpha = 1) {
  if (reach <= 0.002) return;
  const part = reach >= 0.999 ? q : subCurve(q, reach);
  const base = { k, angle: 0, reveal: 1, swell: 0, clock, taper: [0.5, 0.35] as [number, number] };
  for (const layer of [
    { w: 2.3, a: 0.2, c },
    { w: 1, a: 0.95, c },
    { w: 0.32, a: 0.65, c: color.text },
  ]) {
    ctx.fillStyle = rgba(layer.c, layer.a * alpha);
    fillTube(ctx, part, { ...base, width: width * layer.w });
  }
}

/** Everything that can happen on stage, as named moments the log has confirmed. */
function momentsOf(s: SaleState): string[] {
  const out: string[] = [];
  const add = (on: boolean, key: string) => {
    if (on) out.push(key);
  };
  add(s.listed, 'listed');
  add(s.buying, 'buying');
  add(s.sold, 'sold');
  add(!!s.payouts.seller?.ok, 'paidSeller');
  add(!!s.payouts.royalty?.ok, 'paidRoyalty');
  add(!!s.oldKey, 'keySent');
  add(!!s.oldKey && s.oldKey.state !== 'pending', 'keyDone');
  add(!!s.oldOwner, 'ownerSent');
  add(!!s.oldOwner && s.oldOwner.state !== 'pending', 'ownerDone');
  add(s.intact, 'intact');
  add(s.appointed, 'appointed');
  add(s.unlocked, 'unlocked');
  add(!!s.probe, 'probeSent');
  add(s.probe?.state === 'ok', 'probeOk');
  return out;
}

/** `resting`: mounted so its art is ready, but another stage is showing: it paints nothing. */
export function SaleStage({ scene, idle, reducedMotion, resting = false, spots }: { scene: SaleState; idle: SaleCast | null; reducedMotion: boolean; resting?: boolean; spots?: StageSpots }) {
  const cast = saleCastOf(scene, idle);
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

  const artItems = useMemo<NodeArtInput[]>(() => {
    if (!cast) return [];
    const items: NodeArtInput[] = [];
    if (cast.art) items.push({ id: cast.spore, input: cast.art, glyph: null });
    for (const p of cast.peers) if (p.id !== cast.spore) items.push({ id: p.id, input: p, glyph: null });
    return items;
  }, [cast]);
  const art = useNodeArt(artItems);

  const partners = useMemo(() => (cast ? fanOut(cast.tubes.map(([id]) => ({ id, a: slotAngle(id) })), (20 * Math.PI) / 180) : new Map<number, number>()), [cast?.tubes]); // eslint-disable-line react-hooks/exhaustive-deps

  const anim = useRef({ times: new Map<string, number>(), lines: 0 });
  const latest = useRef({ scene, cast, art, reducedMotion, size, partners, resting });
  latest.current = { scene, cast, art, reducedMotion, size, partners, resting };

  useEffect(() => {
    const a = anim.current;
    const now = performance.now();
    // A seek isn't an event: what it lands on is drawn as already done.
    const jumped = scene.lines < a.lines || scene.lines - a.lines > 8;
    a.lines = scene.lines;
    const on = new Set(momentsOf(scene));
    if (jumped) {
      a.times.clear();
      for (const k of on) a.times.set(k, now - 1e5);
    } else {
      for (const k of on) if (!a.times.has(k)) a.times.set(k, now);
      for (const k of [...a.times.keys()]) if (!on.has(k) && k !== 'buying') a.times.delete(k);
    }
    schedule();
  }, [scene]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const { scene: s, cast: c, art: arts, reducedMotion: still, size: z, partners: fan, resting: off } = latest.current;
    const ctx = el?.getContext?.('2d');
    if (!el || !ctx || z.w === 0 || off) return;
    if (el.width !== z.w * z.dpr || el.height !== z.h * z.dpr) {
      el.width = z.w * z.dpr;
      el.height = z.h * z.dpr;
    }
    ctx.setTransform(z.dpr, 0, 0, z.dpr, 0, 0);
    ctx.clearRect(0, 0, z.w, z.h);
    const m = metrics(z.w, z.h);
    const now = performance.now();
    const clock: FlexClock = { now, ambient: !still };
    const times = anim.current.times;
    /** ms since a moment, or null if it hasn't happened. */
    const since = (k: string) => (times.has(k) ? now - times.get(k)! : null);
    /** 0–1 through a moment; 1 once done, and at once under reduced motion. */
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
    if (!c) return;
    const seed = c.art?.seed ?? null;
    const seedOf = (id: number) => c.peers.find((p) => p.id === id)?.seed ?? null;
    const anchors = partyAnchors(z.w, z.h, m);
    const sellerGate = angleOf(m, anchors.seller);
    const buyerGate = angleOf(m, anchors.buyer);

    // Tubes, under everything. They never change here: a sale doesn't touch them.
    const dMax = c.tubes.reduce((x, [, d]) => Math.max(x, Number(d)), 1);
    const held = through('intact', motion.pulse);
    for (const [id, dText] of c.tubes) {
      const angle = fan.get(id);
      if (angle === undefined) continue;
      const d = Number(dText);
      const startR = artDiscR(artReach(d, c.tubes.length || 1), m.artR * ART_SCALE);
      const q = tubeCurveTo(m, slotAngle(id), angle, m.ringR, id % 2 ? 1 : -1, startR);
      if (seed && d > 0) drawTube(ctx, q, Math.max(1, stageTubeWidth(d, dMax, m.u)), 0.5 + 0.5 * Math.sqrt(d / dMax), seed, 1000 + id, clock, null);
      const pos = onRing(m, angle, m.ringR);
      plainNode(ctx, pos, m.u * 0.012, seedOf(id));
      const img = arts.get(id);
      if (img) drawArt(ctx, img, pos, m.u * PEER_ART, 1);
      // Check 9: the chain says it kept this. A pulse runs out along what it kept.
      going(held);
      if (!still && held > 0 && held < 1) {
        const p = curvePoint(q, easeOut(held));
        ctx.beginPath();
        ctx.arc(p.x, p.y, m.u * 0.018 * (1 - held * 0.4), 0, TAU);
        ctx.fillStyle = rgba(color.growth, 1 - held * 0.6);
        ctx.fill();
      }
    }

    const bulges: MembraneBulge[] = [];
    const inner = (gate: number) => onRing(m, gate, m.artR * 0.62);
    const width = m.u * 0.03;

    // The old agent's key: from the seller's side to the spore, cut at the sale.
    const oldLine = limb(anchors.seller, inner(sellerGate), 1);
    const cut = through('sold', motion.grow);
    going(cut);
    // Before a run the line is whoever runs the spore now, or nothing if the chain names nobody.
    if (cut < 1 && (s.start || c.operator)) drawLimb(ctx, oldLine, 1 - easeInOut(cut), width, 3001, clock, color.agent);
    if (times.has('sold')) {
      // Where it was cut: the mark stays, like the ✕ on the Rogue wall.
      const at = onRing(m, sellerGate, m.membraneR);
      drawStamp(ctx, at, m.u * 0.022, Math.min(1, 0.4 + cut));
      const r = through('sold', motion.art);
      if (!still && r < 1) drawRipple(ctx, at, m.u * (0.02 + 0.13 * easeOut(r)), color.agent, 0.7 * (1 - r));
    }

    // The two tries of the old hands: each presses on the wall and is refused.
    const attempt = (sent: string, done: string, offset: number, tint: string, k: number, step: SaleState['oldKey']) => {
      if (!times.has(sent) || !step) return;
      const gate = sellerGate + offset;
      const reach = easeOut(through(sent, motion.epoch));
      going(through(sent, motion.epoch));
      const decided = times.has(done);
      const refused = decided && step.state === 'failed';
      const back = decided ? through(done, motion.art) : 0;
      going(back);
      const push = m.u * 0.085 * (refused ? 1 - easeOut(back) : clamp01((reach - 0.6) / 0.4));
      const flash = refused && !still ? clamp01(1 - (since(done) ?? 0) / motion.grow) : 0;
      if (flash > 0) moving = true;
      bulges.push({ angle: gate, push, part: 0, flash });
      const tip = onRing(m, gate, m.membraneR + push);
      const q = limb(anchors.seller, tip, offset >= 0 ? -1 : 1);
      drawLimb(ctx, q, refused ? reach * (1 - easeInOut(back)) : reach, width * 0.9, k, clock, tint);
      if (refused) {
        const at = onRing(m, gate, m.membraneR);
        drawStamp(ctx, at, m.u * 0.02, Math.min(1, 0.4 + back));
        const r = through(done, motion.art);
        if (!still && r < 1) drawRipple(ctx, at, m.u * (0.02 + 0.13 * easeOut(r)), color.warn, 0.7 * (1 - r));
      }
    };
    attempt('keySent', 'keyDone', -0.3, color.agent, 3002, s.oldKey);
    attempt('ownerSent', 'ownerDone', 0.3, color.text2, 3003, s.oldOwner);

    // The new agent's key: from the buyer's side, once the chain has it.
    if (times.has('appointed')) {
      const q = limb(anchors.buyer, inner(buyerGate), -1);
      const grow = through('appointed', motion.grow);
      going(grow);
      const woken = through('unlocked', motion.grow);
      going(woken);
      drawLimb(ctx, q, easeOut(grow), width * (0.55 + 0.45 * woken), 3004, clock, color.agent);
      if (times.has('probeSent')) {
        const u = through('probeSent', motion.grow);
        going(u);
        if (!still && !times.has('probeOk') && u < 1) drawBead(ctx, curvePoint(q, easeInOut(u)), m.u * 0.016);
      }
    }

    // Money. Pending: the price leaves the buyer and waits at the wall. Final: it goes in, and comes out in two parts.
    const gatePoint = onRing(m, buyerGate, m.membraneR);
    const beadR = (amount: number) => m.u * 0.03 * Math.sqrt(Math.max(0.02, amount));
    const inTo = limb(anchors.buyer, gatePoint, 1);
    if (times.has('buying') && !s.payouts.seller) {
      const u = through('buying', motion.grow);
      going(u);
      if (!times.has('sold')) {
        drawBead(ctx, curvePoint(inTo, easeOut(u) * 0.92), beadR(1));
        moving = true;
      } else {
        const v = through('sold', motion.art);
        going(v);
        if (v < 1) drawBead(ctx, curvePoint(inTo, 0.92 + 0.08 * v), beadR(1), 1 - v * 0.3);
      }
    }
    const pay = (key: string, to: Pt, lean: number, share: number) => {
      if (!times.has(key)) return;
      const u = through(key, motion.grow);
      going(u);
      if (u >= 1 || still) return;
      const route = limb(gatePoint, to, lean);
      drawBead(ctx, curvePoint(route, easeInOut(u)), beadR(share));
    };
    if (s.start) {
      const price = Number(s.start.price) || 1;
      pay('paidSeller', anchors.seller, 0.5, Number(s.payouts.seller?.amount ?? 0) / price);
      pay('paidRoyalty', anchors.royalty, -0.3, Number(s.payouts.royalty?.amount ?? 0) / price);
    }

    // The spore. Asleep from the sale until the buyer's policy is final: paused is chain state, and it shows.
    const center = { x: m.cx, y: m.cy };
    const side = m.artR * ART_SCALE;
    const breath = still ? 1 : 0.94 + 0.06 * Math.sin((Math.PI * now) / motion.breathe);
    const asleep = times.has('sold') ? 1 - through('unlocked', motion.grow) : 0;
    const fell = through('sold', motion.grow);
    const dim = 1 - 0.55 * Math.min(asleep, fell);
    const img = arts.get(c.spore);
    if (img) drawArt(ctx, img, center, side, breath * dim);
    else plainNode(ctx, center, m.u * 0.05, seed);

    // The wall: thin while the spore is running, full while it's locked.
    drawMembrane(ctx, m, bulges, clock, 0.5 + 0.5 * Math.min(asleep, fell));

    // The first job under new hands.
    if (times.has('probeOk')) {
      const u = through('probeOk', motion.pulse);
      going(u);
      if (!still && u < 1) drawRipple(ctx, center, m.u * (0.08 + 0.34 * easeOut(u)), color.agent, 0.8 * (1 - u));
    }

    if (moving) schedule();
  };
  useEffect(() => {
    schedule();
  });

  const m = size.w ? metrics(size.w, size.h) : null;
  const pct = (p: Pt) => ({ left: `${(p.x / size.w) * 100}%`, top: `${(p.y / size.h) * 100}%` });
  const start = scene.start;
  const seller = start?.seller ?? null;
  const owner = cast?.owner ?? null;
  const summary = cast ? `Spore #${cast.spore} in a dish, owned by ${owner ?? 'an account not read yet'}. ${tubesText(cast.tubes.length)}. ${scene.sold ? 'Sold.' : scene.listed ? 'Listed.' : ''}` : 'The dish, empty until a spore is known.';

  return (
    <div className="stage sale-stage" ref={box}>
      <canvas ref={canvas} className="stage-canvas" role="img" aria-label={summary} />
      {cast && m && (
        <div className="stage-notes">
          {!spots && cast.tubes.map(([id, d]) => {
            const angle = partners.get(id);
            if (angle === undefined) return null;
            return (
              <span key={id} className={`stage-note ${Math.sin(angle) >= 0 ? 'is-right' : 'is-left'}`} style={pct(clampX(onRing(m, angle, m.ringR + m.u * (size.w < PHONE ? 0.1 : 0.15)), size.w))}>
                <span className="mono-s">#{id}</span>
                {Number(d) > 0 && <span className="mono-s stage-d">D {Number(d).toLocaleString('en-US')}</span>}
              </span>
            );
          })}
          {scene.sold && !scene.unlocked && (
            <span className="stage-note stage-wall is-right sale-locked" style={pct(onRing(m, Math.PI * 0.62, m.membraneR + m.u * 0.03))}>
              <span className="mono-s">paused · budget 0</span>
            </span>
          )}
        </div>
      )}

      {cast && m && spots && (
        <div className="stage-spots">
          {spots.hero(cast.spore, m.artR * 2)}
          {cast.tubes.map(([id, d]) => {
            const angle = partners.get(id);
            return angle === undefined ? null : <span key={id}>{spots.peer(spotOf(m, size, angle, { id, d: Number(d) > 0 ? d : null, quote: null, state: 'plain' }))}</span>;
          })}
        </div>
      )}

      {/* The label on the dish: the one light thing on the stage, the thing a sale changes. */}
      {cast && m && (
        <div className="dish-label-slot" style={pct(onRing(m, Math.PI, m.dishR * 0.86))}>
          {scene.listed && start && !scene.sold && (
            <span className="price-tag" key="tag">
              <span className="label">for sale</span> <span className="mono">{formatNear(start.price)}</span>
            </span>
          )}
          {scene.sold && seller && <DishLabel key={`old-${seller}`} name={seller} peeling reduced={reducedMotion} />}
          {owner && <DishLabel key={owner} name={owner} landing={scene.sold} />}
        </div>
      )}

      {!start && cast?.owner && <Party cls="party-seller" role="owner" name={cast.owner} delta={null} agent={cast.operator ? accountWord(cast.operator) : null} agentWord="its agent" />}
      {start && (
        <>
          <Party cls="party-seller" role={scene.sold ? 'old owner' : 'owner'} name={start.seller} delta={scene.payouts.seller?.amount ? `+${formatNear(scene.payouts.seller.amount)}` : null} agent={!scene.sold ? accountWord(start.old_operator) : null} agentWord="its agent" />
          <Party cls="party-buyer" role={scene.sold ? 'owner' : 'buyer'} name={start.buyer} delta={scene.sold ? `−${formatNear(start.price)}` : null} agent={scene.appointed ? accountWord(start.new_operator) : null} agentWord="its agent" spent />
          {(scene.payouts.royalty || scene.sold) && <Party cls="party-royalty" role={`royalty ${start.royalty_bps / 100}%`} name={start.royalty_account} delta={scene.payouts.royalty?.amount ? `+${formatNear(scene.payouts.royalty.amount)}` : null} />}
                  </>
      )}
    </div>
  );
}

/** What a buyer gets, for the sheet beside the stage. */
export function saleSheetRows(scene: SaleState, cast: SaleCast): SheetRow[] {
  // Check 9 compares the blocks either side of the buy. A value read after a later close isn't what it proved.
  const kept = (same: (after: Record<string, any>) => boolean) => scene.intact && !!scene.diff && same(scene.diff.after);
  return [
    { term: 'Balance', tip: 'Its own money, held by the contract under its id. It stays with the spore. Testnet NEAR has no value.', value: <Kept word={cast.balance ? formatNear(cast.balance) : '—'} money kept={kept((a) => String(a.balance) === cast.balance)} /> },
    { term: 'Tubes', tip: 'Live links to other spores, grown by settled payments. A sale doesn’t touch them.', value: <Kept word={tubesText(cast.tubes.length)} kept={kept((a) => a.connections?.length === cast.tubes.length)} /> },
    { term: 'Age', tip: 'Epochs since it was activated. It stays with the spore through a sale.', value: <Kept word={cast.age !== null ? `${cast.age} epochs` : '—'} kept={kept((a) => a.age === cast.age)} /> },
    { term: 'Reputation', tip: 'R, added up from its tubes.', value: <Kept word={cast.reputation ? repText(cast.reputation) : '—'} kept={kept((a) => String(a.reputation) === cast.reputation)} /> },
  ];
}

/** Keeps a note's anchor inside the stage, so a short id isn't clipped at the edge. */
export const clampX = (p: Pt, w: number): Pt => ({ x: Math.max(ID_ROOM, Math.min(w - ID_ROOM, p.x)), y: p.y });

/** Keeps a note inside the stage at its top and foot, clear of what's under the stage. */
const clampY = (p: Pt, h: number): Pt => ({ x: p.x, y: Math.max(NOTE_ROOM, Math.min(h - NOTE_ROOM, p.y)) });

export function Kept({ word, money, kept }: { word: string; money?: boolean; kept: boolean }) {
  return (
    <span className="mono kept-row">
      <span className={money ? 'money' : undefined}>{word}</span>
      {kept && (
        <span className="kept-mark tone-growth">
          <span aria-hidden="true">✓</span>
          <span className="kept-word"> kept</span>
          <span className="sr-only"> (kept)</span>
        </span>
      )}
    </span>
  );
}

export function DishLabel({ name, peeling, landing, reduced }: { name: string; peeling?: boolean; landing?: boolean; reduced?: boolean }) {
  if (peeling && reduced) return null;
  return (
    <span className={`dish-label${peeling ? ' is-peeling' : ''}${landing ? ' is-landing' : ''}`} aria-hidden={peeling ? true : undefined}>
      <span className="eyebrow">belongs to</span>
      <span className="dish-label-name">{accountWord(name)}</span>
    </span>
  );
}

/** On a phone only the first part of the name fits; the whole name is in the proof below. */
function AccountParts({ name }: { name: string }) {
  const dot = name.indexOf('.');
  return dot > 0 ? <>{name.slice(0, dot)}<span className="stage-long">{name.slice(dot)}</span></> : <>{name}</>;
}

export function Party({ cls, role, name, delta, agent, agentWord, spent }: { cls: string; role: string; name: string; delta: string | null; agent?: string | null; agentWord?: string; spent?: boolean }) {
  return (
    <div className={`party ${cls}`}>
      <span className="eyebrow party-role">{role}</span>
      <span className="mono-s party-name"><AccountParts name={name} /></span>
      {delta && (
        <span className={`mono party-delta${spent ? ' is-spent' : ''}`} key={delta}>
          {delta}
        </span>
      )}
      {agent && (
        <span className="label party-agent" key={agent}>
          <span aria-hidden="true">⚷</span> {agentWord}: <span className="mono-s">{agent}</span>
        </span>
      )}
    </div>
  );
}
