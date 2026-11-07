// The whole loop (S13, /lab/loop): the first thing `scripts/demo.sh` opens, and the
// way into the app for someone who has never heard of it. One spore, one question,
// one line at a time: wake, hire, settle, grow, reputation, art, sell, control. It
// plays on arrival, with the eight stops on screen from the first frame, so the idea
// is readable before anything has moved. A recording plays on a timer; a run still
// going is followed as its log grows, and the page waits when the chain does.
import { useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import { EXPLORER } from '../chain/rpc';
import { loopCast, LoopStage, usePrewarm } from '../components/LoopStage';
import { LoopChain, LoopVein } from '../components/LoopVein';
import { SaleStage } from '../components/SaleStage';
import { NextScene, PaceSwitch, ProofTabs, retold, SceneHead, SceneNav, seconds } from '../components/SceneChrome';
import { SporeSheet, StageLegend, useSpots } from '../components/StageAids';
import { decisionSummary, ruleCaption } from '../model/decisions';
import { buildLoop, heroOf, loopDelay, loopRows, loopWaiting, narrateLoop, type LoopAct, type LoopState } from '../model/loop';
import { plateSheet, STOP_GLOSS } from '../model/plate';
import { narrateSale } from '../model/sale';
import type { Source } from '../model/types';
import { type LogSource } from '../sources/loop';
import { linkTo, sourceQuery } from '../sources/source';
import { useLoopRecording, useLoopRun } from '../state/loop';
import { useIdleCast, usePlayback } from '../state/scene';
import { useApp } from '../state/source';
import { formatClock, shortAccount, shortHash } from '../ui/format';
import { ErrorState, LoadingBar } from '../ui/states';
import '../components/activity.css';
import '../components/detail.css';
import '../components/gallery.css';
import '../components/lab.css';

const QUESTION = 'What does a Spore actually do?';

/** Where else this run can be read, one click deeper. */
function NextSteps({ q, hero }: { q: string; hero: number | null }) {
  return (
    <p className="body loop-next">
      <Link to={linkTo('/network', q)}>See every spore</Link>
      <Link to={linkTo('/activity', q)}>See every hire</Link>
      {hero !== null && <Link to={linkTo(`/spore/${hero}`, q)}>Spore #{hero}</Link>}
      <Link to={linkTo('/lab', q)}>More scenes</Link>
    </p>
  );
}

function Verdict({ checks }: { checks: { name: string; ok: boolean }[] }) {
  const failed = checks.filter((c) => !c.ok);
  return (
    <section className={`scene-verdict is-${failed.length ? 'failed' : 'completed'}`} aria-live="polite">
      <div className="sv-figure">
        <span className="figure-l">{checks.length - failed.length} / {checks.length}</span>
        <span className="label">checks this recording passed</span>
      </div>
      {failed.length > 0 && (
        <p className="sv-line tone-warn mono" role="status">
          <span aria-hidden="true">✕ </span>Failed: {failed.map((c) => c.name).join('; ')}
        </p>
      )}
    </section>
  );
}

function LogStory({ source }: { source: LogSource }) {
  const { reducedMotion } = useApp();
  const q = sourceQuery(source);
  const data = useLoopRun(source);
  const follow = source.kind === 'run' && !data.run?.report;
  const playback = usePlayback<LoopState>(data.lines, { autoplay: true, build: buildLoop, delay: loopDelay, lastAct: null, follow, landOnLine: true });
  usePrewarm(data.lines);
  const s = playback.scene;
  const over = !!s.checks;
  const rows = useMemo(() => loopRows(s, over), [s, over]);
  const line = narrateLoop(s, narrateSale);
  const waiting = data.run && playback.finished ? loopWaiting(data.run, s) : null;
  const refusal = s.beat === 'sale' && (s.sale.beat.kind === 'triedKey' || s.sale.beat.kind === 'triedOwner') ? (s.sale.beat.step.err ?? null) : null;
  const cast = useMemo(() => loopCast(s), [s]);
  const canSeek = source.kind === 'recorded' && !!data.lines;
  const heroKnown = data.run ? heroOf(data.run, []) : null;

  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [q]);

  const sheet = useMemo(() => plateSheet(s), [s]);
  const spots = useSpots(q, s.hero ?? heroKnown);
  const note = source.kind === 'recorded' && data.lines ? retold(playback.length, playback.pace) : null;

  return (
    <div className="scene loop-scene">
      <SceneNav current="loop" q={q} />

      <div className="scene-play">
        <div className="scene-bench">
          <div className="scene-side">
            <SceneHead question={QUESTION} line={line} quote={refusal} />
            {data.lostSince !== null && <p className="mono tone-warn" role="alert">Lost the connection at {formatClock(data.lostSince)}, retrying. What’s here is what it said before that.</p>}
            {data.error && <ErrorState error={data.error} what="this recording’s logs" onRetry={data.retry} />}
            {!data.lines && !data.error && (source.kind === 'run' ? <p className="body scene-why">Waiting for the run to write its first line.</p> : <LoadingBar label="Loading the run" ch={12} />)}
            {sheet && <SporeSheet sheet={sheet} to={linkTo(`/spore/${sheet.spore}`, q)} />}
            <aside className="scene-docket">
              {s.checks && <Verdict checks={s.checks} />}
              <LoopChain rows={rows} />
              {playback.finished && over && <NextSteps q={q} hero={s.hero ?? heroKnown} />}
            </aside>
          </div>

          <div className="scene-stage-slot">
            <div className="stage-frame">
              <div className="loop-stages">
                <div className={s.saleStarted ? 'loop-layer is-off' : 'loop-layer'}>
                  <LoopStage state={s} reducedMotion={reducedMotion} spots={spots} />
                </div>
                <div className={s.saleStarted ? 'loop-layer loop-layer-top' : 'loop-layer loop-layer-top is-off'} aria-hidden={s.saleStarted ? undefined : true}>
                  <SaleStage scene={s.sale} idle={cast} reducedMotion={reducedMotion} resting={!s.saleStarted} spots={spots} />
                </div>
              </div>
              {note && <span className="label stage-source">{note}</span>}
            </div>
            <StageLegend seed={sheet?.seed ?? null} marks={s.saleStarted ? ['hero', 'peer', 'tube', 'agent', 'wall'] : ['hero', 'peer', 'tube', 'agent', 'wall', 'rim']} />
          </div>
        </div>

        <div className="scene-transport">
          <div className="scene-controls">
            {source.kind === 'recorded' || !follow ? (
              <>
                {playback.finished && over && <Link className="btn btn-primary scene-cta" to={linkTo('/verify', q, s.hero !== null ? { spore: s.hero } : {})}>Check it against the chain</Link>}
                {playback.finished ? (
                  <button type="button" className="btn btn-secondary" onClick={playback.restart}>↻ Watch again</button>
                ) : playback.playing ? (
                  <button type="button" className="btn btn-secondary" onClick={playback.pause}>Pause</button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={playback.play} disabled={!data.lines}>▶︎ Play</button>
                )}
              </>
            ) : (
              <span className="body scene-running" role="status">
                <span className="dot-live" aria-hidden="true" />
                {waiting ?? 'Following it live'}
              </span>
            )}
          </div>
          <div className={`scene-rail${playback.finished ? ' is-finished' : ''}`}>
            <LoopVein rows={rows} returned={!!s.resumed} reducedMotion={reducedMotion} tips={STOP_GLOSS} onSeek={canSeek ? (a: LoopAct) => playback.seekAct(a) : undefined} />
          </div>
          <div className="scene-after">
            {(source.kind === 'recorded' || !follow) && !(playback.finished && over) && <PaceSwitch playback={playback} />}
            {playback.finished && over && <NextScene after="loop" />}
          </div>
        </div>
      </div>

      <Proof s={s} source={source} routerId={data.run?.run.router ?? null} start={data.run?.events[0]?.at ?? null} real={playback.length.real} story={playback.length.story} />
    </div>
  );
}

function Proof({ s, source, routerId, start, real, story }: { s: LoopState; source: LogSource; routerId: string | null; start: string | null; real: number; story: number }) {
  const q = sourceQuery(source);
  const d = s.job?.decision;
  const txs: [string, string | null | undefined][] = [
    ['Job posted', s.txs.post],
    ['Provider hired', s.txs.accept],
    ['Work delivered', s.txs.deliver],
    ['Job settled', s.txs.settle],
    ['Epoch closed', s.txs.close],
    ['Sold', s.sale.buyTx],
    ['Old key refused', s.sale.oldKey?.tx],
    ['Old owner refused', s.sale.oldOwner?.tx],
    ['New agent', s.resumed?.tx],
  ];
  const shown = txs.filter(([, h]) => h && !h.endsWith(')'));
  return (
    <ProofTabs
      opening="txs"
      tabs={[
        {
          key: 'txs',
          word: 'The transactions',
          count: shown.length ? String(shown.length) : undefined,
          body: (
            <>
              <ul className="loop-txs">
                {shown.map(([what, h]) => (
                  <li key={what}>
                    <span className="body">{what}</span> <a className="mono-s" href={`${EXPLORER}/${h}`} target="_blank" rel="noreferrer" aria-label={`${what} tx ${h}, opens the explorer`}>{shortHash(h!)} ↗</a>
                  </li>
                ))}
                {s.sale.start && <li><span className="body">Seller, buyer</span> <span className="mono-s">{shortAccount(s.sale.start.seller)}, {shortAccount(s.sale.start.buyer)}</span></li>}
              </ul>
              {!shown.length && <p className="body">The transactions behind the story land here as it reaches them.</p>}
              <p className="body scene-why">The sale has its own scene, with all its checks: <Link to={linkTo('/lab/sale', q)}>Sale and control transfer →</Link></p>
            </>
          ),
        },
        {
          key: 'why',
          word: d?.winner !== undefined && d?.winner !== null ? `Why it hired #${d.winner}` : 'Why it hired whom it did',
          body: d ? (
            <>
              <p className="body"><span aria-label="derived" title="Derived in the browser from the logged quotes">≈ </span>{decisionSummary(d)}</p>
              <p className="mono-s scene-why">{ruleCaption(d.rule)}</p>
            </>
          ) : (
            <p className="body">The rule’s numbers appear here once the story has reached its hire.</p>
          ),
        },
        {
          key: 'view',
          word: 'What this view is',
          body: (
            <>
              <p className="body">
                Each line above is read from the agents’ logs: {source.kind === 'recorded' ? <>this recording is real, played in {seconds(story)}; it took {seconds(real)}.</> : 'as it happens.'} Nothing here is sent to the chain. From the sale on, the sheet shows the chain at the buy: closes went on while it took place, so its tubes kept decaying after that, and the <Link to={linkTo(`/spore/${s.hero ?? ''}`, q)}>Spore page</Link> has where it ended.
              </p>
              {routerId && <p className="body scene-why">Contract <span className="mono">{routerId}</span>{start && <>, started at {formatClock(Date.parse(start))} your time</>}.</p>}
              <p className="body scene-why">Check it yourself, in this browser: <Link to={linkTo('/verify', q)}>Verify →</Link></p>
            </>
          ),
        },
      ]}
    />
  );
}

/** On LIVE nothing is playing, and a recording is one honest click away. */
function LiveInvite({ source }: { source: Source }) {
  const { reducedMotion } = useApp();
  const rec = useLoopRecording();
  const cast = useIdleCast(rec.hero, true, 0);
  const empty = useMemo(() => buildLoop([]), []);
  const link = rec.bundle ? linkTo('/lab/loop', sourceQuery({ kind: 'recorded', run: rec.bundle.run, date: rec.bundle.date })) : null;
  const q = sourceQuery(source);
  const spots = useSpots(q, cast?.spore ?? null);
  const rows = loopRows(empty, false);
  return (
    <div className="scene loop-scene">
      <SceneNav current="loop" q={q} />
      <div className="scene-play">
        <div className="scene-bench">
          <div className="scene-side">
            <SceneHead question={QUESTION} line={cast ? `Spore #${cast.spore} is an NFT with its own money. An agent runs it.` : 'A Spore is an NFT with its own money and an agent that spends it.'} />
            <aside className="scene-docket">
              <LoopChain rows={rows} />
            </aside>
          </div>
          <div className="scene-stage-slot">
            <div className="stage-frame">
              <SaleStage scene={empty.sale} idle={cast} reducedMotion={reducedMotion} spots={spots} />
            </div>
            <StageLegend seed={cast?.art?.seed ?? null} marks={['hero', 'peer', 'tube', 'agent', 'wall']} />
          </div>
        </div>
        <div className="scene-transport">
          <div className="scene-controls">
            {link ? <Link className="btn btn-primary scene-cta" to={link}>▶︎ Watch the recording{rec.length ? ` · ${seconds(rec.length)}` : ''}</Link> : <span className="body scene-why">No recording available.</span>}
          </div>
          <div className="scene-rail">
            <LoopVein rows={rows} reducedMotion={reducedMotion} tips={STOP_GLOSS} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function LoopScene() {
  const { source } = useApp();
  if (source?.kind === 'run' || source?.kind === 'recorded') return <LogStory source={source} />;
  if (source?.kind === 'live') return <LiveInvite source={source} />;
  return (
    <div className="scene">
      <ErrorState error={new Error('The whole loop comes from a run: it has no simulation.')} what="this source" />
      <Link className="body" to="/lab/loop">Open it on LIVE →</Link>
    </div>
  );
}

