// The Overview's plate (§13 items 22, 23): one real spore's life, told in 30 seconds on
// the loop's own stage, with a pen arrow from the words to the thing they're about. Beside
// it a sheet says which spore this is, what state it's in and who holds it; under it the
// eight stops are a timeline you can click, with the chosen stop's detail below them. It
// plays a recording and says so: a router between runs has nothing moving to show. Every
// line comes from the run's log, through the same fold as `/lab/loop` (model/loop.ts).
//
// It waits for the first picture before it starts, pauses when it's scrolled away or the
// tab is hidden, and under reduced motion starts on its finished frame, which is readable
// as a diagram. It announces nothing: a story playing itself is not a live region.
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { EXPLORER } from '../chain/rpc';
import { artDiscR, metrics, onRing } from '../graph/stage';
import { artReach, type Pt } from '../model/network';
import { buildLoop, heroOf, loopArtInputs, loopRows, narrateLoop, type LoopAct, type LoopRow, type LoopState } from '../model/loop';
import { deepLink, nextStop, noteWorthy, overviewDelay, plateSheet, plateTarget, shownStop, STOP_GLOSS, type PlateSheet, type PlateTarget } from '../model/plate';
import { narrateSale } from '../model/sale';
import { repText } from '../model/scene';
import { linkTo, sourceQuery } from '../sources/source';
import { useLoopRun, useStorySource } from '../state/loop';
import { usePlayback } from '../state/scene';
import { useApp } from '../state/source';
import { EmptyState, ErrorState } from '../ui/states';
import { SourceBadge } from '../ui/status';
import { formatNear, tubesText } from '../ui/format';
import { breakpoint, hex, paletteOf } from '../ui/tokens';
import { Tooltip } from '../ui/Tooltip';
import { RenderQueueContext } from '../wasm/art';
import { HandArrow } from './HandArrow';
import { loopCast, LoopStage, share, stageAngles, usePrewarm } from './LoopStage';
import { LoopVein } from './LoopVein';
import { ART_SCALE, partyAnchors, SaleStage, type PeerSpot, type StageSpots } from './SaleStage';
import { seconds } from './SceneChrome';
import '../components/detail.css';
import '../components/lab.css';

/** Longest the story waits for its first picture, ms. */
const FIRST_ART_WAIT = 2500;
const NARROW = `(max-width: ${breakpoint.md - 1}px)`;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

/** Where the target is on the stage box, and how far short of it the pen stops, px. */
function targetPoint(t: PlateTarget, s: LoopState, w: number, h: number, box: HTMLElement | null): { p: Pt; short: number } | null {
  const m = metrics(w, h);
  const side = m.artR * ART_SCALE;
  const hero = { x: m.cx, y: m.cy };
  switch (t.at) {
    case 'hero':
      return { p: hero, short: side * 0.2 };
    case 'peer': {
      const a = stageAngles(s).get(t.id);
      return a === undefined ? null : { p: onRing(m, a, m.ringR), short: m.u * 0.1 };
    }
    case 'tube': {
      const a = stageAngles(s).get(t.id);
      if (a === undefined) return null;
      const start = artDiscR(artReach(s.growth?.after ?? 0, s.frame?.tubes.length || 1), side);
      return { p: onRing(m, a, (start + m.ringR) / 2), short: m.u * 0.03 };
    }
    case 'rim': {
      const f = s.frame;
      if (!f) return null;
      return { p: onRing(m, Math.PI * 2 * Math.min(1, share(f.allowance, f.cap)), m.dishR * 0.985), short: m.u * 0.015 };
    }
    case 'label': {
      const el = box?.querySelector<HTMLElement>('.loop-layer-top:not(.is-off) .dish-label:not(.is-peeling)');
      const b = box?.getBoundingClientRect();
      if (!el || !b) return { p: { x: m.cx, y: m.cy + m.dishR }, short: m.u * 0.12 };
      const r = el.getBoundingClientRect();
      return { p: { x: r.left + r.width / 2 - b.left, y: r.top - b.top }, short: 4 };
    }
    case 'seller':
      return { p: partyAnchors(w, h, m).seller, short: 8 };
    case 'buyer':
      return { p: partyAnchors(w, h, m).buyer, short: 8 };
    case 'royalty':
      return { p: partyAnchors(w, h, m).royalty, short: 8 };
  }
}

/** The pen's line in the hero's own coordinates, redrawn when anything it spans changes size. */
function useArrow(hero: HTMLElement | null, note: HTMLElement | null, stage: HTMLElement | null, s: LoopState, line: string, target: PlateTarget | null, on: boolean) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!hero || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => setTick((n) => n + 1));
    ro.observe(hero);
    return () => ro.disconnect();
  }, [hero]);
  const [arrow, setArrow] = useState<{ from: Pt; to: Pt; bow: number; seed: string; w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (!on || !hero || !note || !stage || !target) return setArrow(null);
    const hb = hero.getBoundingClientRect();
    const sb = stage.getBoundingClientRect();
    const nb = note.getBoundingClientRect();
    if (!sb.width) return setArrow(null);
    const place = targetPoint(target, s, sb.width, sb.height, stage);
    if (!place) return setArrow(null);
    const m = metrics(sb.width, sb.height);
    // The note's on the right of the plate: the pen leaves its left edge, at the first line.
    const from = { x: nb.left - hb.left - 8, y: nb.top - hb.top + 16 };
    const aim = { x: place.p.x + sb.left - hb.left, y: place.p.y + sb.top - hb.top };
    const dx = aim.x - from.x;
    const dy = aim.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const to = { x: aim.x - (dx / len) * place.short, y: aim.y - (dy / len) * place.short };
    // What lies beyond the spore, the pen swings under rather than through it. Otherwise a slight arc: a hand, not a ruler.
    const beyond = place.p.x < m.cx - m.artR;
    const bow = beyond ? Math.max(m.artR * 1.5, len * 0.3) : len * 0.12;
    setArrow({ from, to, bow, seed: `${line}|${target.at}`, w: hb.width, h: hb.height });
  }, [hero, note, stage, target?.at, line, on, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return arrow;
}

const dWords = (d: string) => Number(d).toLocaleString('en-US');

/** The spores on the stage, as things you can point at: what each one is, and a way to its page. */
function useSpots(q: string, reducedHero: number | null): StageSpots {
  return useMemo(() => ({
    hero: (id, size) => (
      <span className="stage-spot-at" style={{ left: '50%', top: '50%' }}>
        <Tooltip focusable={false} content={<>This is <strong>Spore #{id}</strong>: its art, drawn from its own tubes. Open its page.</>}>
          <Link className="stage-spot is-hero" style={{ width: size, height: size }} to={linkTo(`/spore/${id}`, q)} aria-label={`Spore #${id}, the spore in the middle. Open its page`} />
        </Tooltip>
      </span>
    ),
    peer: (p: PeerSpot) => (
      <>
        <span className="stage-spot-at" style={p.at}>
          <Tooltip
            focusable={false}
            // It opens away from the dish's middle, so it doesn't cover what it's about.
            align={p.right ? 'start' : 'end'}
            content={
              <>
                <strong>Spore #{p.id}</strong>
                {p.quote && <><br />Quoted {formatNear(p.quote)} for this job{p.state === 'won' ? ' and was hired' : p.state === 'lost' ? ' and lost' : ''}.</>}
                {p.d ? <><br />Tube to #{reducedHero}: D {dWords(p.d)}. D is its strength.</> : !p.quote && <><br />No tube yet.</>}
                <br />Open its page.
              </>
            }
          >
            <Link className={`stage-spot is-${p.state}`} style={{ width: p.size, height: p.size }} to={linkTo(`/spore/${p.id}`, q)} aria-label={`Spore #${p.id}${p.d ? `, tube D ${dWords(p.d)}` : ''}. Open its page`} />
          </Tooltip>
        </span>
        <span className={`stage-note ${p.right ? 'is-right' : 'is-left'}${p.state === 'lost' ? ' is-gone' : ''}${p.state === 'won' || p.state === 'grown' ? ' is-on' : ''}`} style={p.label}>
          <span className="mono-s">#{p.id}</span>
          {p.quote && <span className={`mono-s ${p.state === 'won' ? 'money' : 'stage-d'}`}>{formatNear(p.quote)}</span>}
        </span>
      </>
    ),
  }), [q, reducedHero]);
}

/** What's drawn on the stage, read from the code that draws it (LoopStage, SaleStage). */
function PlateLegend({ seed, rim }: { seed: string | null; /** The rim is on the loop's stage; the sale's dish doesn't draw it. */ rim: boolean }) {
  const tube = seed ? hex(paletteOf(seed).stops[3]) : 'currentColor';
  const items = [
    { key: 'hero', word: 'this spore', tip: 'The spore in the middle. Its picture is drawn from its tubes.', mark: <circle cx="8" cy="8" r="4" fill="var(--text)" /> },
    { key: 'peer', word: 'other spores', tip: 'Spores it trades with, or that quoted for its job. Each stands at its own place on a ring of 64.', mark: <circle cx="8" cy="8" r="4" fill="none" stroke="var(--text-2)" strokeWidth="1.5" /> },
    { key: 'tube', word: 'tube', tip: 'Grows from settled payments, at an epoch’s close, and decays without them. Thicker means stronger.', mark: <path d="M1 11 C5 4 10 12 15 5" fill="none" stroke={tube} strokeWidth="3" strokeLinecap="round" /> },
    { key: 'agent', word: 'its agent', tip: 'The agent’s key, held for the spore’s owner. It’s cut when the spore is sold.', mark: <path d="M1 12 L15 4" fill="none" stroke="var(--agent)" strokeWidth="2.5" strokeLinecap="round" /> },
    { key: 'wall', word: 'contract’s wall', tip: 'Limits the contract enforces, not the agent. It thickens while the spore is locked, and a ✕ marks a refusal.', mark: <circle cx="8" cy="8" r="6" fill="none" stroke="var(--slime)" strokeWidth="1.5" /> },
    ...(rim ? [{ key: 'rim', word: 'may spend', tip: 'The dish’s rim: what it may spend each epoch. A full circle is the budget its owner set.', mark: <path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="var(--value)" strokeWidth="2.5" strokeLinecap="round" /> }] : []),
  ];
  return (
    <ul className="ov-legend" aria-label="What’s on the stage">
      {items.map((i) => (
        <li key={i.key}>
          <Tooltip content={i.tip}>
            <span className="ov-legend-item label">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">{i.mark}</svg>
              {i.word}
            </span>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

/** Which spore this is, what state it's in, who holds it, what it has: one list, one alignment. */
function SporeSheet({ sheet }: { sheet: PlateSheet | null }) {
  if (!sheet) return <div className="ov-sheet" aria-hidden="true" />;
  const rows: { term: string; tip: string; value: string; money?: boolean; delta?: string | null; spent?: boolean }[] = [
    { term: 'Owner', tip: 'Whoever holds the NFT controls the agent and owns its money.', value: sheet.owner, delta: sheet.ownerDelta, spent: true },
    ...(sheet.previousOwner ? [{ term: 'Previous owner', tip: 'Paid at the sale, then refused by the contract.', value: sheet.previousOwner, delta: sheet.previousDelta }] : []),
    ...(sheet.royalty ? [{ term: 'Royalty', tip: `This account, the collection’s creator, gets ${sheet.royalty.bps / 100}% of every sale.`, value: sheet.royalty.account, delta: sheet.royalty.got }] : []),
    { term: 'Agent', tip: 'The account running the spore, on a key that can only make the calls the contract allows.', value: sheet.agent ?? 'none until the owner appoints one' },
    { term: 'Balance', tip: 'Its own money, in testnet NEAR, held by the contract under its id. Testnet NEAR has no value.', value: formatNear(sheet.balance), money: true },
    { term: 'Reputation', tip: `R, added up from its tubes.${sheet.allowance ? ` It lets the agent spend ${formatNear(sheet.allowance)} an epoch now.` : ''}`, value: repText(sheet.reputation) },
    { term: 'Tubes', tip: 'Live links to other spores, grown by settled payments.', value: tubesText(sheet.tubes).replace(/ tubes?$/, '') },
    { term: 'Age', tip: 'Epochs since it was activated. It stays with the spore through a sale.', value: `${sheet.age} epochs` },
  ];
  return (
    <section className="ov-sheet" aria-label={`Spore #${sheet.spore}, as of this moment in the recording`}>
      <header className="ov-sheet-head">
        <h2 className="display-s">Spore #{sheet.spore}</h2>
        <span className={`ov-status label tone-${sheet.status.tone === 'money' ? 'value' : sheet.status.tone}`} key={sheet.status.word}><span aria-hidden="true">{sheet.status.glyph} </span>{sheet.status.word}</span>
        <p className="body ov-sheet-why">{sheet.status.why}</p>
      </header>
      <dl className="ov-sheet-rows">
        {rows.map((r) => (
          <div key={r.term} className="ov-sheet-row">
            <dt className="label"><Tooltip content={r.tip}><span className="ov-term">{r.term}</span></Tooltip></dt>
            <dd className="mono-s">
              <span className={r.money ? 'money' : undefined}>{r.value}</span>
              {r.delta && <span className={r.spent ? 'is-spent' : 'money'}>{r.delta}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The chosen stop in full: what it means, the run's figures, what they mean, and the proof. */
function StopDetail({ row, deep, control }: { row: LoopRow; deep: { to: string; word: string }; control: ReactNode }) {
  return (
    <div className="ov-stop">
      {control}
      <div className="ov-stop-body" key={row.key}>
        <p className="ov-stop-line">
          <span className="heading">{row.word}.</span> <span className="body">{row.promise}.</span>
          {row.fact && <> <span className={`mono ov-stop-fact${row.warn ? ' tone-warn' : ''}`}>{row.fact}</span></>}
        </p>
        <p className="label ov-stop-gloss">{STOP_GLOSS[row.key]}</p>
      </div>
      <div className="ov-stop-links">
        {row.tx && !row.tx.endsWith(')') && (
          <a className="body ov-tx" href={`${EXPLORER}/${row.tx}`} target="_blank" rel="noreferrer" aria-label={`${row.word} transaction ${row.tx}, opens the explorer`}>Transaction ↗</a>
        )}
        <Link className="body" to={deep.to}>{deep.word} →</Link>
      </div>
    </div>
  );
}

export default function OverviewPlate({ hero }: { hero: HTMLElement | null }) {
  const { source, reducedMotion } = useApp();
  const narrow = useNarrow();
  const found = useStorySource(source);
  const story = found.story;
  const data = useLoopRun(story);
  const playback = usePlayback<LoopState>(data.lines, { autoplay: false, build: buildLoop, delay: overviewDelay, lastAct: null, landOnLine: true });
  usePrewarm(data.lines);
  const s = playback.scene;
  const q = story ? sourceQuery(story) : '';
  const over = !!s.checks;
  const rows = useMemo(() => loopRows(s, over), [s, over]);
  // The note holds its line through the small steps; a seek lands on what it lands on.
  const said = useRef<{ line: string; target: PlateTarget | null; lines: number } | null>(null);
  const prior = said.current;
  const jumped = !prior || s.lines < prior.lines || s.lines - prior.lines > 6;
  if (jumped || noteWorthy(s)) said.current = { line: narrateLoop(s, narrateSale), target: plateTarget(s), lines: s.lines };
  else said.current = { ...prior!, lines: s.lines };
  const { line, target: pointAt } = said.current;
  const cast = useMemo(() => loopCast(s), [s]);
  const heroId = s.hero ?? (data.run ? heroOf(data.run, []) : null);
  const sheet = useMemo(() => plateSheet(s), [s]);
  const stop = shownStop(rows);
  const stopDeep = deepLink(stop.key, heroId);
  const spots = useSpots(q, heroId);

  const [noteEl, setNoteEl] = useState<HTMLElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLElement | null>(null);
  const arrow = useArrow(hero, noteEl, stageEl, s, line, pointAt, !narrow);

  // Waits for the first picture, then plays. Under reduced motion: the finished frame.
  const getQueue = useContext(RenderQueueContext);
  const started = useRef(false);
  const [ready, setReady] = useState(false);
  const inputs = useMemo(() => (data.lines ? loopArtInputs(data.lines) : []), [data.lines]);
  useEffect(() => {
    if (!data.lines?.length || started.current) return;
    started.current = true;
    if (reducedMotion) {
      playback.seekEnd();
      setReady(true);
      return;
    }
    const go = () => setReady(true);
    // Not cleared on cleanup: `started` already keeps this from running twice, and a story that never starts is worse than one that starts late.
    setTimeout(go, FIRST_ART_WAIT);
    if (inputs[0]) {
      getQueue()
        .then((queue) => queue.request(inputs[0], { priority: 6 }))
        .then(go, go);
    } else go();
  }, [data.lines]); // eslint-disable-line react-hooks/exhaustive-deps

  // Plays only while someone can see it, and never over a pause they asked for.
  const paused = useRef(false);
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    if (!stageEl) return;
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([e]) => setSeen(e.intersectionRatio > 0.3), { threshold: [0, 0.3, 0.6] }) : null;
    io?.observe(stageEl);
    return () => io?.disconnect();
  }, [stageEl]);
  const [tabOn, setTabOn] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setTabOn(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  useEffect(() => {
    if (!ready || reducedMotion || !data.lines || paused.current || playback.finished) return;
    if (seen && tabOn) playback.play();
    else playback.pause();
  }, [ready, seen, tabOn, data.lines]); // eslint-disable-line react-hooks/exhaustive-deps

  const pause = () => {
    paused.current = true;
    playback.pause();
  };
  const play = () => {
    paused.current = false;
    if (playback.finished) playback.restart();
    else playback.play();
  };

  const failed = found.error ?? data.error;
  const none = found.done && !story;

  // On a phone the stops scroll sideways: the chosen one stays in view.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current;
    const row = el?.querySelector<HTMLElement>(`.vein-row:nth-child(${rows.indexOf(stop) + 2})`);
    if (!el || !row || el.scrollWidth <= el.clientWidth) return;
    el.scrollTo?.({ left: row.offsetLeft - el.clientWidth / 2 + row.offsetWidth / 2, behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [stop.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = (a: LoopAct) => {
    pause();
    said.current = null;
    playback.seekUntil(nextStop(a));
  };

  const control = !!data.lines?.length && (
    playback.finished ? (
      <button type="button" className="btn btn-secondary ov-play" onClick={play}>↻ Watch again</button>
    ) : playback.playing ? (
      <button type="button" className="btn btn-secondary ov-play" onClick={pause}>Pause</button>
    ) : (
      <button type="button" className="btn btn-secondary ov-play" onClick={play}>▶︎ Play</button>
    )
  );

  return (
    <>
      <p className="ov-note" ref={setNoteEl} key={line}>{line}</p>

      <div className="ov-stage">
        {failed ? (
          <ErrorState error={failed} what="the recording" onRetry={() => (found.error ? found.retry() : data.retry())} />
        ) : none ? (
          <EmptyState title="No recording to play">Watch the live map below.</EmptyState>
        ) : (
          <>
            <div className="loop-stages" ref={setStageEl}>
              <div className={s.saleStarted ? 'loop-layer is-off' : 'loop-layer'}>
                <LoopStage state={s} reducedMotion={reducedMotion} spots={spots} />
              </div>
              <div className={s.saleStarted ? 'loop-layer loop-layer-top' : 'loop-layer loop-layer-top is-off'} aria-hidden={s.saleStarted ? undefined : true}>
                <SaleStage scene={s.sale} idle={cast} reducedMotion={reducedMotion} resting={!s.saleStarted} spots={spots} />
              </div>
              <div className="ov-stage-source">
                {story && <SourceBadge source={story} staleSince={null} compact />}
                {story && playback.length.story > 0 && <span className="label ov-stage-why">Real transactions, retold in {seconds(playback.length.story)}. It took {seconds(playback.length.real)}.</span>}
              </div>
            </div>
            <PlateLegend seed={sheet?.seed ?? null} rim={!s.saleStarted} />
          </>
        )}
      </div>

      <SporeSheet sheet={sheet} />

      <div className="ov-timeline">
        <div className={`ov-strip${playback.finished ? ' is-finished' : ''}`} ref={strip}>
          <LoopVein
            across
            rows={rows}
            returned={!!s.resumed}
            reducedMotion={reducedMotion}
            // A click on a stop means "show me this": the story waits at its end, with everything it said.
            onSeek={data.lines?.length ? seek : undefined}
          />
        </div>
        <StopDetail row={stop} deep={{ to: linkTo(stopDeep.path, q, stopDeep.params ?? {}), word: stopDeep.word }} control={control} />
      </div>

      {arrow && (
        <svg className="ov-pen" viewBox={`0 0 ${arrow.w} ${arrow.h}`} width={arrow.w} height={arrow.h} aria-hidden="true">
          <HandArrow key={arrow.seed} from={arrow.from} to={arrow.to} bow={arrow.bow} seed={arrow.seed} />
        </svg>
      )}
    </>
  );
}
