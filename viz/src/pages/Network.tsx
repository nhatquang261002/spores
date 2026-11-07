// Network explorer `/network` (Design §6.C, the signature screen): every
// tube in the collection on the art's own ring, epoch by epoch, and every
// step of the loop that made them: Wake → Post → Quote → Hire → Deliver →
// Settle → Close → Grow.
//
// What moves and why (Design §3.5, truth rule):
// - At a close (a live `epoch_info` rise, or the scrubber moving), tubes tween
//   to the new tube set. Nothing else changes D.
// - ▶︎ plays epochs. With "Steps" on, each epoch's steps play first: from a
//   run log, every logged tx in log order, time compressed; from chain
//   history, the epoch's settled flows (the chain keeps per-pair totals, not
//   their order, so they move together). Then the close.
// - LIVE at Live: a flow or reject that appears between two polls is a
//   settlement confirmed on chain, shown as it arrives.
// Reduced motion: no particles or tweens; play steps through the epochs and
// each close is announced in words.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { SporeSummary } from '../chain/router';
import { EpochScrubber } from '../components/EpochScrubber';
import { LoopRail, narrate, type FeedRow, type RailCount, type RailKey } from '../components/LoopRail';
import { NetworkGraph, type NetworkGraphHandle, type NodeInfo } from '../components/NetworkGraph';
import { EpochSummary, NetworkEdgeDetails, NodeDetails, type SporeFigures } from '../components/NetworkInspector';
import { NetworkTable } from '../components/NetworkTable';
import { StepMonitor } from '../components/StepMonitor';
import '../components/network.css';
import type { Selection } from '../graph/draw';
import { readStatus } from '../model/gallery';
import {
  closeSummary,
  diffTubes,
  flowCounts,
  frameAt,
  maxD,
  maxR,
  pairKey,
  pairOf,
  previousTubes,
  shapingRejects,
  tubesOf,
  type Frame,
  type NetworkHistory,
} from '../model/network';
import type { Step, StepKind } from '../model/steps';
import type { StatusReading } from '../model/types';
import type { NetworkData } from '../sources/network';
import { shortRouter, sourceQuery } from '../sources/source';
import { useNetwork } from '../state/network';
import { useApp } from '../state/source';
import { formatR } from '../ui/format';
import { EmptyState, ErrorState, LoadingBar } from '../ui/states';
import { SourceBadge } from '../ui/status';
import { motion } from '../ui/tokens';
import { Tooltip } from '../ui/Tooltip';

/** One epoch's steps play over this long (run logs; the real epochs took 30–80 s). */
export const STEP_SPAN_MS = 6000;
/** Without steps: one epoch per 1.2 s (Design §6.C). */
export const EPOCH_BEAT_MS = 1200;

const STEP_RAIL: Partial<Record<StepKind, RailKey>> = {
  wake: 'wake',
  post: 'post',
  quote: 'quote',
  hire: 'hire',
  deliver: 'deliver',
  settle: 'settle',
  close: 'close',
};
const SIDE: StepKind[] = ['reject', 'timeout', 'outside', 'commit', 'failed'];
const NO_LOG = 'Needs the agents’ log: the chain keeps only settled flows and rejects per epoch. Open a recording to see every step.';

/** Steps of one epoch (the close excluded), in log order. */
export const stepsIn = (steps: Step[] | null, epoch: number) => (steps ?? []).filter((s) => s.epoch === epoch && s.kind !== 'close');

/** The frame's active spores; a frame without the list falls back to its tube endpoints. */
function activeOf(f: Frame): number[] {
  if (f.active) return f.active;
  const s = new Set<number>();
  for (const k of f.tubes?.keys() ?? []) pairOf(k).forEach((id) => s.add(id));
  return [...s];
}

/** The rail's counts for the epoch on screen (or the steps played so far). `null` counts carry the reason. */
export function railCounts(data: NetworkData, frame: Frame, grow: number | null, played: Step[] | null): Record<RailKey, RailCount> {
  const out = {} as Record<RailKey, RailCount>;
  const steps = played ?? stepsIn(data.steps, frame.epoch);
  const closed = (data.steps ?? []).some((s) => s.kind === 'close' && s.closed === frame.epoch);
  for (const k of ['wake', 'post', 'quote', 'hire', 'deliver', 'settle'] as const) {
    if (data.steps === null)
      out[k] =
        k === 'settle' && frame.flows
          ? { n: frame.flows.length }
          : { n: null, reason: k === 'settle' ? `No close tx for epoch ${frame.epoch} in this source.` : NO_LOG };
    else out[k] = { n: steps.filter((s) => s.kind === k).length };
  }
  if (frame.kind === 'live')
    out.close = {
      n: null,
      reason: data.steps === null ? 'This epoch is still in progress. Its tubes change when it closes.' : 'The recording ended before this epoch closed.',
    };
  else if (data.steps === null) out.close = frame.close ? { n: 1 } : { n: null, reason: `No close tx for epoch ${frame.epoch} in this source.` };
  // While an epoch plays, its close has not happened yet.
  else out.close = { n: closed && played === null ? 1 : 0 };
  out.grow = grow === null ? { n: null, reason: 'Needs the tube sets before and after this close.' } : { n: grow };
  return out;
}

/** `t0`: the log time of the epoch's first step, so the row's `t` is its place in the epoch. */
function feedRow(s: Step, i: number, t0: number): FeedRow {
  return { key: `${s.at}-${i}-${s.kind}`, kind: s.kind, text: narrate(s), epoch: s.epoch, t: s.t - t0, tx: s.tx, evidence: 'logged' };
}

/** An epoch's steps as monitor input: rows newest first, the log span and every kind present. */
export function epochFeed(steps: Step[]): { rows: FeedRow[]; span: number; kinds: StepKind[] } {
  const t0 = steps[0]?.t ?? 0;
  return {
    rows: steps.map((s, i) => feedRow(s, i, t0)).reverse(),
    span: steps.length ? steps[steps.length - 1].t - t0 : 0,
    kinds: [...new Set(steps.map((s) => s.kind))],
  };
}

/** Feed rows from chain flows and rejects (no tx per job on chain). */
export function flowRows(f: Frame): FeedRow[] {
  const rows: FeedRow[] = (f.flows ?? []).map(([a, b, amt]) => ({
    key: `f${f.epoch}-${a}-${b}-${amt}`,
    kind: 'settle',
    text: narrate({ kind: 'settle', from: a, to: b, amount: amt }),
    epoch: f.epoch,
    t: null,
    tx: null,
    evidence: 'chain',
  }));
  // The chain keeps rejects by unordered pair: who rejected whom is in the run log only.
  for (const [a, b, n] of f.rejects ?? [])
    rows.push({
      key: `r${f.epoch}-${a}-${b}-${n}`,
      kind: 'reject',
      text: (
        <>
          <span className="mono">#{a}</span> ↔ <span className="mono">#{b}</span> · {n === 1 ? 'a delivery was' : `${n} deliveries were`} rejected and refunded
        </>
      ),
      epoch: f.epoch,
      t: null,
      tx: null,
      evidence: 'chain',
    });
  return rows;
}

function NetworkLegend({ showChange, open, setOpen }: { showChange: boolean; open: boolean; setOpen: (o: boolean) => void }) {
  const row = (mark: ReactNode, text: ReactNode) => (
    <div>
      <dt>{mark}</dt>
      <dd>{text}</dd>
    </div>
  );
  return (
    <div className="network-legend">
      <button type="button" className="legend-toggle label" aria-expanded={open} onClick={() => setOpen(!open)}>
        Legend <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <dl className="legend-list mono-s">
          {row(<span className="lg-node" aria-hidden="true" />, 'spore = its own art (the NFT) · size = R')}
          {row(<span className="lg-tube" aria-hidden="true" />, "tube = the art's vein · width √D · brightness D")}
          {row(<span className="lg-dormant" aria-hidden="true" />, 'grey dot = dormant')}
          {row(<span className="lg-paused" aria-hidden="true" />, 'dimmed, dashed outline = paused')}
          {row(<span className="lg-listed" aria-hidden="true" />, 'amber tick = listed')}
          {showChange && (
            <>
              {row(<span className="lg-grew" aria-hidden="true" />, 'green stroke = grew (dashed: new)')}
              {row(<span className="lg-dropped" aria-hidden="true" />, 'grey dashes = dropped below threshold')}
              {row(
                <span className="tone-warn" aria-hidden="true">
                  ✕
                </span>,
                'red tick = a delivery was rejected (halves the tube)',
              )}
            </>
          )}
          {row(
            <span className="tone-agent" aria-hidden="true">
              ◆
            </span>,
            'violet = an agent step: post, quote, hire, deliver',
          )}
          {row(
            <span className="lg-bead" aria-hidden="true" />,
            <>
              amber bead = a payment · <span className="tone-growth">✓</span> settled
            </>,
          )}
          {row(<span className="lg-sweep" aria-hidden="true" />, 'yolk sweep = an epoch close')}
        </dl>
      )}
    </div>
  );
}

/** `7` → the node, `3-7` → the tube; anything else selects nothing. */
export function parseEpochParam(v: string | null): number | 'end' {
  return v !== null && /^\d{1,9}$/.test(v) && Number(v) >= 1 ? Number(v) : 'end';
}

export function parseSelection(v: string | null): Selection {
  const m = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(v ?? '');
  if (!m) return null;
  const a = Number(m[1]);
  if (m[2] === undefined) return a < 64 ? { kind: 'node', id: a } : null;
  const b = Number(m[2]);
  return a < 64 && b < 64 && a !== b ? { kind: 'tube', k: pairKey(a, b) } : null;
}

export function Network() {
  const { source, epoch, router, reducedMotion } = useApp();
  const net = useNetwork(source, router, source?.kind === 'live' ? epoch.info : null);
  const data = net.data;
  const h = data?.history ?? null;

  const [params] = useSearchParams();
  // `?epoch=17` opens scrubbed there (Design §5.1, §5.5); read once, like `sel`.
  const [pos, setPos] = useState<number | 'end'>(() => parseEpochParam(params.get('epoch')));
  // `?sel=7` (a spore) or `?sel=3-7` (a tube), Design §5.1; read once, so links from a Spore page open with it selected.
  const [selection, setSelection] = useState<Selection>(() => parseSelection(params.get('sel')));
  const [showChange, setShowChange] = useState(false);
  const [labels, setLabels] = useState<'selected' | 'all'>('selected');
  const [mode, setMode] = useState<'map' | 'table'>(() => (params.get('view') === 'table' ? 'table' : 'map'));
  const [withSteps, setWithSteps] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [played, setPlayed] = useState<{ epoch: number; steps: Step[]; rows: FeedRow[]; span: number; kinds: StepKind[] } | null>(null);
  const [firing, setFiring] = useState<{ key: RailKey; n: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [legendOpen, setLegendOpen] = useState(true);
  const [sheet, setSheet] = useState<'peek' | 'half' | 'full'>('peek');
  const [summary, setSummary] = useState<{ id: number; s: SporeSummary | null; error: boolean } | null>(null);
  const graph = useRef<NetworkGraphHandle>(null);
  const inspector = useRef<HTMLElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const fireN = useRef(0);

  const position = h ? (pos === 'end' ? h.current : Math.max(1, Math.min(pos, h.current))) : 0;
  const frame = h ? frameAt(h, position) : null;
  const shownFrame = useMemo(() => (frame ? { ...frame, active: activeOf(frame) } : null), [frame]);
  const diff = useMemo(() => {
    if (!h || !frame?.tubes) return null;
    const prev = previousTubes(h, frame);
    return prev ? diffTubes(prev, frame.tubes, shapingRejects(h, frame)) : null;
  }, [h, frame]);
  const dMax = useMemo(() => (h ? maxD(h) : 0), [h]);
  const rMax = useMemo(() => (h ? maxR(h) : 0), [h]);
  const nodeInfo = useMemo(() => {
    const m = new Map<number, NodeInfo>();
    const live = h?.live.tubes ?? null;
    for (const s of data?.spores.values() ?? []) {
      // The node shows the spore's art now: the inspector thumb's input (seed, age, live tubes).
      const edges = tubesOf(live, s.id)
        .map((t) => [t.partner, String(t.d)] as [number, string])
        .sort((a, b) => a[0] - b[0]);
      m.set(s.id, {
        palette: s.palette,
        price: s.listedPrice,
        paused: s.paused === true,
        art: s.age !== null && s.active ? { seed: s.seed, age: s.age, edges } : null,
        glyph: s.glyph,
      });
    }
    return m;
  }, [data?.spores, h?.live.tubes]);
  const paletteMap = useMemo(() => new Map([...(data?.spores.values() ?? [])].map((s) => [s.id, s.palette])), [data?.spores]);
  const endWord = source?.kind === 'live' ? 'Live' : 'End';

  const fire = useCallback((key: RailKey) => setFiring({ key, n: ++fireN.current }), []);
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const stop = useCallback(() => {
    clearTimers();
    setPlaying(false);
    setPlayed(null);
  }, []);
  useEffect(() => () => clearTimers(), []);
  // A new source starts over.
  // Only a change of source: on mount, `?epoch=` and `?sel=` must stand.
  const key = source ? JSON.stringify(source) : '';
  const shownKey = useRef(key);
  useEffect(() => {
    if (shownKey.current === key) return;
    shownKey.current = key;
    stop();
    setPos('end');
    setSelection(null);
  }, [key, stop]);

  // --- selection ---------------------------------------------------------------

  const select = useCallback(
    (s: Selection) => {
      setSelection(s);
      if (s) setSheet((x) => (x === 'peek' ? 'half' : x));
      if (!s || !h) return setAnnounce(s ? '' : 'Selection cleared');
      const f = frameAt(h, position);
      if (s.kind === 'node') {
        const r = f.reputation?.get(s.id);
        const n = tubesOf(f.tubes, s.id).length;
        setAnnounce(`Spore #${s.id} selected${r !== undefined ? `, R ${formatR(r)}` : ''}, ${n} tube${n === 1 ? '' : 's'}`);
      } else {
        const [a, b] = pairOf(s.k);
        const d = f.tubes?.get(s.k);
        setAnnounce(`Tube #${a} to #${b} selected${d !== undefined ? `, D ${(d / 1e6).toFixed(2)}` : ''}`);
      }
    },
    [h, position],
  );

  // LIVE: one spore_summary when a node is selected (balance and allowance now); never polled.
  const selId = selection?.kind === 'node' ? selection.id : null;
  useEffect(() => {
    if (source?.kind !== 'live' || !router || selId === null) return;
    let alive = true;
    setSummary({ id: selId, s: null, error: false });
    router.sporeSummary(selId).then(
      (s) => alive && setSummary({ id: selId, s, error: false }),
      () => alive && setSummary({ id: selId, s: null, error: true }),
    );
    return () => {
      alive = false;
    };
  }, [selId, router, source?.kind]);

  // --- the close: tween (in NetworkGraph), sweep, rail, words -----------------

  const announceClose = useCallback((hist: NetworkHistory, e: number) => {
    const f = frameAt(hist, e);
    const closed = f.kind === 'live' ? e - 1 : e;
    const prev = previousTubes(hist, f);
    setAnnounce(f.tubes && prev ? closeSummary(closed, diffTubes(prev, f.tubes)) : `Epoch ${closed} closed`);
  }, []);

  // LIVE: a close seen while at Live.
  const lastCurrent = useRef<number | null>(null);
  useEffect(() => {
    if (!h || source?.kind !== 'live') return;
    const was = lastCurrent.current;
    lastCurrent.current = h.current;
    if (was === null || h.current <= was || pos !== 'end') return;
    graph.current?.emit('close', null, null);
    fire('close');
    timers.current.push(setTimeout(() => fire('grow'), motion.epoch));
    announceClose(h, h.current);
  }, [h?.current]); // a close only

  // LIVE: settlements and rejects confirmed since the last poll, while at Live.
  useEffect(() => {
    const b = net.live;
    if (!b || pos !== 'end' || !h || b.epoch !== h.current) return;
    b.settled.forEach(([a, x], i) => graph.current?.emit('settle', a, x, i * motion.micro));
    b.rejected.forEach(([a, x], i) => graph.current?.emit('reject', a, x, i * motion.micro));
    if (b.settled.length) fire('settle');
    setAnnounce(`${b.settled.length} settlement${b.settled.length === 1 ? '' : 's'} confirmed${b.rejected.length ? `, ${b.rejected.length} rejected` : ''}`);
  }, [net.live?.n]); // each poll batch once

  // --- play --------------------------------------------------------------------

  const firstEpoch = useMemo(() => {
    if (!h) return 1;
    const known = [...h.frames.values()].filter((x) => x.tubes).map((x) => x.epoch);
    return known.length ? Math.min(...known) : 1;
  }, [h]);

  const playRef = useRef<(from: number) => void>(() => {});
  playRef.current = (from: number) => {
    if (!h || !data) return;
    const next = from + 1;
    if (next > h.current) return stop();
    const later = (ms: number, fn: () => void) => void timers.current.push(setTimeout(fn, ms));
    const closeTo = (delay: number) =>
      later(delay, () => {
        setPos(next >= h.current ? 'end' : next);
        setPlayed(null);
        if (!reducedMotion) graph.current?.emit('close', null, null);
        fire('close');
        later(motion.epoch, () => fire('grow'));
        announceClose(h, next);
        later(reducedMotion ? EPOCH_BEAT_MS : motion.epoch + motion.panel, () => playRef.current(next));
      });

    if (!withSteps) return closeTo(EPOCH_BEAT_MS);
    if (data.steps) {
      const steps = stepsIn(data.steps, next);
      const all = epochFeed(steps);
      if (reducedMotion || !steps.length) {
        setPlayed({ epoch: next, steps, ...all });
        return closeTo(EPOCH_BEAT_MS);
      }
      setPlayed({ epoch: next, steps: [], rows: [], span: all.span, kinds: all.kinds });
      const t0 = steps[0].t;
      const span = Math.max(1, all.span);
      steps.forEach((s, i) =>
        later(((s.t - t0) / span) * STEP_SPAN_MS, () => {
          graph.current?.emit(s.kind, s.from, s.to);
          const rk = STEP_RAIL[s.kind];
          if (rk) fire(rk);
          // The rows are newest first: the last `i + 1` of them are the steps played so far.
          setPlayed({ epoch: next, steps: steps.slice(0, i + 1), rows: all.rows.slice(steps.length - 1 - i), span: all.span, kinds: all.kinds });
        }),
      );
      return closeTo(STEP_SPAN_MS + motion.grow);
    }
    // Chain history: the epoch's settled flows, all at once (the chain keeps totals, not their order).
    const target = frameAt(h, next);
    const rows = flowRows(target);
    setPlayed({ epoch: next, steps: [], rows, span: 0, kinds: [...new Set(rows.map((r) => r.kind))] });
    if (!reducedMotion) {
      (target.flows ?? []).forEach(([a, b]) => graph.current?.emit('settle', a, b));
      (target.rejects ?? []).forEach(([a, b]) => graph.current?.emit('reject', a, b));
    }
    if (target.flows?.length) fire('settle');
    closeTo(target.flows?.length && !reducedMotion ? motion.grow + motion.ui : EPOCH_BEAT_MS);
  };

  const togglePlay = () => {
    if (playing) return stop();
    if (!h) return;
    clearTimers();
    setPlaying(true);
    let from = position;
    if (position >= h.current) {
      from = Math.max(1, firstEpoch);
      setPos(from);
    }
    timers.current.push(setTimeout(() => playRef.current(from), motion.epoch));
  };

  const scrubTo = (e: number) => {
    stop();
    setPos(h && e >= h.current ? 'end' : e);
  };

  // --- render ------------------------------------------------------------------

  if (!source) return null;
  const where = source.kind === 'live' ? shortRouter(source.router) : source.kind === 'sim' ? 'the simulation' : source.run;

  if (source.kind === 'sim')
    return (
      <div className="network-page is-message">
        <EmptyState title="The simulation has no map">The simulator writes totals for the whole economy, not tubes per spore. Pick LIVE or a recording.</EmptyState>
      </div>
    );
  if (!data || !h || !shownFrame)
    return (
      <div className="network-page is-message">
        {net.error ? (
          <ErrorState
            error={net.error}
            what={source.kind === 'live' ? 'the network' : `the network from ${where}`}
            onRetry={net.retry}
          >
            {source.kind !== 'live' && <p className="body">A Demo Lab recording holds one scene, not the whole network. <Link to="/network">Open the network on LIVE</Link>.</p>}
          </ErrorState>
        ) : (
          <p className="body" aria-busy="true">
            Reading the network from <span className="mono">{where}</span> <LoadingBar ch={8} label="Reading the network" />
          </p>
        )}
      </div>
    );

  const f = shownFrame;
  const q = sourceQuery(source);
  const playingNow = playing && played ? played : null;
  const railFrame = playingNow ? frameAt(h, playingNow.epoch) : f;
  const counts = railCounts(data, railFrame, playingNow ? null : diff ? diff.counts.new + diff.counts.grew : null, playingNow ? playingNow.steps : null);
  const sideSteps = playingNow ? playingNow.steps : stepsIn(data.steps, f.epoch);
  const side = SIDE.map((k) => ({ kind: k, n: sideSteps.filter((s) => s.kind === k).length })).filter((s) => s.n > 0);
  const rail = <LoopRail counts={counts} side={side} firing={reducedMotion ? null : firing} />;
  const still = data.steps ? epochFeed(stepsIn(data.steps, f.epoch)) : null;
  const chainRows = still ? null : flowRows(f);
  const feed = playingNow ?? still ?? { rows: chainRows!, span: 0, kinds: [...new Set(chainRows!.map((r) => r.kind))] };
  const feedEmpty = data.steps
    ? `The agents’ log has no steps in epoch ${railFrame.epoch}.`
    : railFrame.flows
      ? railFrame.kind === 'live'
        ? 'No settlements yet this epoch. New ones appear here when the next poll sees them.'
        : `No flows in epoch ${railFrame.epoch}.`
      : `No close tx for epoch ${railFrame.epoch} in this source.`;

  const spore = selId !== null ? data.spores.get(selId) : undefined;
  const runFig = selId !== null ? data.figures?.get(f.epoch)?.get(selId) : undefined;
  const liveSummary = summary && summary.id === selId ? summary : null;
  const figures: SporeFigures | null = runFig
    ? { balance: runFig.balance, allowance: runFig.allowance, from: 'snapshot' }
    : liveSummary?.s
      ? { balance: liveSummary.s.balance, allowance: liveSummary.s.budget_left, from: 'summary' }
      : null;
  const figuresState = runFig ? 'ok' : liveSummary ? (liveSummary.error ? 'error' : liveSummary.s ? 'ok' : 'loading') : 'none';
  const activeNow = selId !== null && (f.active ?? []).includes(selId);
  const reading: StatusReading = !activeNow
    ? { status: 'dormant', derived: false }
    : runFig
      ? readStatus({ active: true, policy: { paused: runFig.paused }, operator: runFig.operator, transfers: null })
      : liveSummary?.s
        ? readStatus({ active: true, policy: liveSummary.s.policy, operator: liveSummary.s.operator_id, transfers: liveSummary.s.transfers })
        : readStatus({ active: true });

  let inspectorBody: ReactNode;
  if (selection?.kind === 'node') {
    inspectorBody = (
      <NodeDetails
        id={selection.id}
        frame={f}
        history={h}
        seed={spore?.seed ?? null}
        age={spore?.age ?? null}
        owner={spore?.owner ?? null}
        reading={reading}
        figures={figures}
        figuresState={figuresState}
        dMax={dMax}
        onSelect={select}
        sporeHref={`/spore/${selection.id}${q}`}
        liveTubes={tubesOf(h.live.tubes, selection.id)
          .map((t) => [t.partner, String(t.d)] as [number, string])
          .sort((a, b) => a[0] - b[0])}
      />
    );
  } else if (selection?.kind === 'tube') {
    inspectorBody = (
      <NetworkEdgeDetails k={selection.k} frame={f} history={h} steps={data.steps} palettes={paletteMap} dMax={dMax} onSelect={select} onEpoch={scrubTo} />
    );
  } else {
    inspectorBody = (
      <EpochSummary
        data={data}
        frame={railFrame}
        diff={playingNow ? null : diff}
        endWord={endWord}
        rail={rail}
        monitor={
          <StepMonitor
            rows={feed.rows}
            span={feed.span}
            kinds={feed.kinds}
            epoch={railFrame.epoch}
            mode={playingNow ? 'play' : railFrame.kind === 'live' && source.kind === 'live' ? 'live' : 'still'}
            empty={feedEmpty}
          />
        }
        inForce={playingNow ? f : null}
      />
    );
  }

  return (
    <div className={`network-page sheet-${sheet}`}>
      <div className="network-stage">
        <div className="network-bar">
          <div className="network-head">
            <h1 className="title">Network</h1>
            <SourceBadge source={source} staleSince={epoch.staleSince} />
            <div className="segmented" role="group" aria-label="View">
              <button type="button" aria-pressed={mode === 'map'} onClick={() => setMode('map')}>
                Map
              </button>
              <button type="button" aria-pressed={mode === 'table'} onClick={() => setMode('table')}>
                Table view
              </button>
            </div>
          </div>
          {mode === 'map' && (
            <div className="network-controls">
              <button type="button" className="btn btn-secondary btn-icon" onClick={() => graph.current?.zoom(0.8)} aria-label="Zoom out">
                −
              </button>
              <button type="button" className="btn btn-secondary btn-icon" onClick={() => graph.current?.zoom(1.25)} aria-label="Zoom in">
                +
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  graph.current?.reset();
                  select(null);
                  scrubTo(h.current);
                }}
              >
                Reset
              </button>
              <div className="segmented" role="group" aria-label="Labels">
                <button type="button" aria-pressed={labels === 'selected'} onClick={() => setLabels('selected')}>
                  Selected
                </button>
                <button type="button" aria-pressed={labels === 'all'} onClick={() => setLabels('all')}>
                  All
                </button>
              </div>
              <button type="button" className="chip" aria-pressed={showChange} onClick={() => setShowChange((x) => !x)}>
                Show change
              </button>
              <Tooltip
                align="end"
                focusable={false}
                content={
                  data.steps
                    ? 'With Steps on, ▶︎ plays each epoch’s logged steps (post, quote, hire, deliver, settle, reject) before its close.'
                    : 'With Steps on, ▶︎ plays each epoch’s settled flows (from its close event) before the close. Per-job steps need a recording.'
                }
              >
                {(d) => (
                  <button type="button" className="chip" aria-pressed={withSteps} aria-describedby={d} onClick={() => setWithSteps((x) => !x)}>
                    Steps
                  </button>
                )}
              </Tooltip>
            </div>
          )}
        </div>
        <div className="network-area">
          {mode === 'map' ? (
            <>
              <NetworkGraph
                ref={graph}
                frame={f}
                nodeInfo={nodeInfo}
                dMax={dMax}
                rMax={rMax}
                diff={showChange ? diff : null}
                selection={selection}
                onSelect={select}
                onOpen={() => {
                  setSheet('half');
                  inspector.current?.focus();
                }}
                labels={labels}
                reducedMotion={reducedMotion}
                describedBy="network-help"
              />
              <p id="network-help" className="sr-only">
                Tab moves through active spores in id order. Enter opens the inspector. Arrow keys pan, plus and minus zoom, 0 resets, Escape clears the
                selection. The table view lists every spore and tube.
              </p>
              {!f.tubes && (
                <p className="network-overlay body" role="note">
                  No tube set for epoch {f.epoch} in this source.
                </p>
              )}
              <NetworkLegend showChange={showChange} open={legendOpen} setOpen={setLegendOpen} />
              {playingNow && withSteps && (
                <p className="network-playing mono-s" role="status">
                  ▶︎ epoch {playingNow.epoch}
                  {data.steps ? ` · agents’ log, ${STEP_SPAN_MS / 1000} s per epoch` : ' · settled flows from the close event'}
                </p>
              )}
            </>
          ) : (
            <div className="network-table-wrap">
              <NetworkTable frame={f} diff={diff} palette={paletteMap} selection={selection} onSelect={select} />
            </div>
          )}
        </div>
      </div>
      <aside className="network-inspector" ref={inspector} tabIndex={-1} aria-label="Inspector">
        <button
          type="button"
          className="sheet-handle"
          onClick={() => setSheet((s) => (s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek'))}
          aria-label={`Inspector size: ${sheet}. Change`}
        >
          <span aria-hidden="true" />
        </button>
        {selection && (
          <button type="button" className="link-button label inspector-back" onClick={() => select(null)}>
            ← Epoch {f.epoch}
          </button>
        )}
        {net.error && <ErrorState error={net.error} what={`the network after epoch ${h.current}`} onRetry={net.retry} />}
        {inspectorBody}
        {selection === null && data.steps && (
          <p className="mono-s inspector-note">
            {data.steps.length} steps in the agents’ log. <Link to={`/activity${q}`}>Activity</Link> lists them with receipts.
          </p>
        )}
      </aside>
      <div className="network-scrubber">
        <EpochScrubber
          ticks={flowCounts(h)}
          position={position}
          current={h.current}
          endWord={endWord}
          flowsWord={data.steps ? 'paid pair' : 'flow'}
          playing={playing}
          onChange={scrubTo}
          onPlay={togglePlay}
          onLive={() => scrubTo(h.current)}
        />
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
