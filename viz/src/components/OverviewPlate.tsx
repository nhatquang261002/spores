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
import { deepLink, nextStop, noteWorthy, overviewDelay, plateSheet, plateTarget, shownStop, STOP_GLOSS, type PlateTarget } from '../model/plate';
import { narrateSale } from '../model/sale';
import { linkTo, sourceQuery } from '../sources/source';
import { useLoopRun, useStorySource } from '../state/loop';
import { usePlayback } from '../state/scene';
import { useApp } from '../state/source';
import { EmptyState, ErrorState } from '../ui/states';
import { SourceBadge } from '../ui/status';
import { breakpoint } from '../ui/tokens';
import { RenderQueueContext } from '../wasm/art';
import { HandArrow } from './HandArrow';
import { loopCast, LoopStage, share, stageAngles, usePrewarm } from './LoopStage';
import { LoopVein } from './LoopVein';
import { ART_SCALE, partyAnchors, SaleStage } from './SaleStage';
import { seconds } from './SceneChrome';
import { SporeSheet, StageLegend, useSpots } from './StageAids';
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
            <StageLegend seed={sheet?.seed ?? null} marks={s.saleStarted ? ['hero', 'peer', 'tube', 'agent', 'wall'] : ['hero', 'peer', 'tube', 'agent', 'wall', 'rim']} />
          </>
        )}
      </div>

      <SporeSheet sheet={sheet} />

      <div className="ov-timeline">
        <div className={`ov-strip${playback.finished ? ' is-finished' : ''}`}>
          <LoopVein
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
