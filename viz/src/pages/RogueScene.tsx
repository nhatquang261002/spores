// Rogue agent (Design §6.H, /lab/rogue; §13 items 19, 25). Built so someone who has
// never heard of Spores gets it in seconds: a spore pressing against the wall of its
// contract, and beside it the question, the line being said and what the contract
// decided. The story's controls stay in reach under both; the evidence sits below, a
// tab at a time. Nothing moves or reads as done before the log says so.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { DecayStrip } from '../components/DecayStrip';
import { ActRail, Checks, NextScene, PaceSwitch, Preconditions, ProofTabs, retold, SceneHead, SceneNav, seconds } from '../components/SceneChrome';
import { Evidence, SceneLanes } from '../components/SceneLanes';
import { SceneStage, castOf, type StageCast } from '../components/SceneStage';
import { SceneSteps } from '../components/SceneSteps';
import { SpecimenSheet, StageLegend, useSpots, type SheetRow } from '../components/StageAids';
import { ACTS, buildScene, durationMs, narrate, refusalCount, repText, type AttemptKey, type SceneLine, type SceneState, type PeerArt } from '../model/scene';
import { liveRouter } from '../sources/live';
import { type RecordedBundle } from '../sources/recorded';
import { canReachFrom, latestRecording, loadSceneLog, SCENE_SERVER, SceneClient } from '../sources/scene';
import { linkTo, sourceQuery } from '../sources/source';
import { ReceiptContext, useReceiptStore } from '../state/activity';
import { useLiveRun, usePlayback, useSceneServer } from '../state/scene';
import { useApp } from '../state/source';
import { formatNear, shortAccount } from '../ui/format';
import { ErrorState, LoadingBar } from '../ui/states';
import '../components/activity.css';
import '../components/detail.css';
import '../components/gallery.css';
import '../components/lab.css';

/** What each act shows, on the timeline's stops. */
const ACT_TIPS: Record<string, string> = {
  limits: 'The owner writes the spore’s limits into the contract.',
  cap: 'The agent tries one payment bigger than the cap.',
  budget: 'Small payments, until together they pass the epoch’s budget.',
  drain: 'The agent tries to pay an account the owner never approved.',
  quiet: 'The agent stops, and each close takes a share of every tube.',
  cleanup: 'What the run’s own checks found.',
};

function Verdict({ scene }: { scene: SceneState }) {
  const v = scene.verdict;
  const { refused, total } = refusalCount(scene);
  if (v.status !== 'completed' && v.status !== 'failed') return null;
  return (
    <section className={`scene-verdict is-${v.status}`} aria-live="polite">
      <div className="sv-figure">
        <span className="figure-l">{refused} / {total}</span>
        <span className="label">attempts refused by the contract</span>
      </div>
      {v.line && (
        <p className={`sv-line ${v.status === 'failed' ? 'tone-warn mono' : 'tone-growth body'}`} role="status">
          <span aria-hidden="true">{v.status === 'completed' ? '✓ ' : '✕ '}</span>
          {v.line}
        </p>
      )}
    </section>
  );
}

/** The spore's figures. Once the story is over, each one that moved says where it started. */
export function sheetRows(cast: StageCast | null, scene: SceneState, over: boolean): SheetRow[] {
  const from = (now: string, then: string | undefined) => (over && then !== undefined && then !== now ? `was ${then}` : null);
  const b = scene.before;
  const rep = cast?.reputation ? repText(cast.reputation) : '—';
  // No read of it yet: an empty list here means not known, not none.
  const tubes = cast?.balance ? String(cast.tubes.length) : '—';
  const bal = cast?.balance ? formatNear(cast.balance) : '—';
  return [
    { term: 'Balance', tip: 'Its own money, held by the contract under its id. Testnet NEAR has no value.', value: bal, money: true, side: scene.escrow ? `+ ${formatNear(scene.escrow.amount)} in escrow` : from(bal, b ? formatNear(b.balance) : undefined) },
    { term: 'Reputation', tip: 'R, added up from its tubes. It falls when they decay.', value: rep, side: from(rep, b ? repText(b.reputation) : undefined), spent: true },
    { term: 'Tubes', tip: 'Live links to other spores. They live on settled work and fall away without it.', value: tubes, side: from(tubes, b ? String(b.connections.length) : undefined), spent: true },
  ];
}

function StateDiff({ scene }: { scene: SceneState }) {
  const a = scene.before;
  const b = scene.now;
  if (!a || !b) return <p className="body">Before and after values appear once the run has read them.</p>;
  const policy = (s: typeof a) => (s.policy?.allow_all_spores ? 'any spore' : `only #${(s.policy?.allowlist ?? []).join(', #')}`);
  const rows: [string, string, string][] = [
    ['balance', formatNear(a.balance), formatNear(b.balance)],
    ['reputation', repText(a.reputation), repText(b.reputation)],
    ['tubes', String(a.connections.length), String(b.connections.length)],
    ['may hire', policy(a), policy(b)],
    ['per payment', formatNear(a.policy?.max_payment ?? '0'), formatNear(b.policy?.max_payment ?? '0')],
  ];
  return (
    <table className="state-diff">
      <thead>
        <tr><th className="label" scope="col">Value</th><th className="label" scope="col">Before</th><th className="label" scope="col">Latest</th></tr>
      </thead>
      <tbody>
        {rows.map(([k, x, y]) => (
          <tr key={k} className={x !== y ? 'is-changed' : ''}><th className="body" scope="row">{k}</th><td className="mono">{x}</td><td className="mono">{y}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/** Before any run on LIVE: the real spore from a recording or the server, read from the chain now. */
function useIdleCast(id: number | null, provider: number | null, attacker: string | null, live: boolean): StageCast | null {
  const { router } = useApp();
  const [cast, setCast] = useState<StageCast | null>(null);
  useEffect(() => {
    if (!live || !router || id === null) return;
    let alive = true;
    (async () => {
      const [s, art, peer, config] = await Promise.all([router.sporeSummary(id), router.renderInput(id), provider !== null ? router.renderInput(provider) : null, router.config()]);
      if (!s) return;
      const tubes = (s.connections ?? []).map(([n, d]: [number, string]) => [n, String(d)] as [number, string]);
      const partners = await Promise.all(tubes.map(([n]) => router.renderInput(n)));
      const asPeer = (r: any): PeerArt => ({ id: r.spore_id, seed: r.seed, age: r.age, edges: r.edges });
      if (alive) setCast({ spore: id, provider, attacker: attacker ?? '', art: asPeer(art), peers: [...(peer ? [asPeer(peer)] : []), ...partners.map(asPeer)], tubes, balance: s.balance, reputation: String(s.reputation), dMin: String(config.d_min) });
    })().catch(() => {
      // The stage stays an empty dish; the epoch clock and preconditions already say the router isn't answering.
    });
    return () => {
      alive = false;
    };
  }, [id, provider, attacker, live, router]);
  return cast;
}

export function RogueScene({ client: given }: { client?: SceneClient } = {}) {
  const { source, reducedMotion, epoch } = useApp();
  const q = source ? sourceQuery(source) : '';
  const client = useMemo(() => given ?? new SceneClient(), [given]);
  const isLive = source?.kind === 'live';
  const logSource = source?.kind === 'run' || source?.kind === 'recorded' ? source : null;

  // A recording to play on this source, or to offer from LIVE.
  const [log, setLog] = useState<SceneLine[] | null>(null);
  const [logError, setLogError] = useState<Error | null>(null);
  const [offer, setOffer] = useState<RecordedBundle | null>(null);
  const [offerLines, setOfferLines] = useState<SceneLine[] | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setLog(null);
    setLogError(null);
    if (!logSource) return;
    let alive = true;
    loadSceneLog(logSource).then(
      (l) => alive && setLog(l),
      (e) => alive && setLogError(e),
    );
    return () => {
      alive = false;
    };
  }, [logSource?.kind, logSource?.run, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isLive) return;
    let alive = true;
    latestRecording('rogue').then(
      async (b) => {
        if (!alive || !b) return;
        setOffer(b);
        const lines = await loadSceneLog({ kind: 'recorded', run: b.run, date: b.date });
        if (alive) setOfferLines(lines);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [isLive]);

  const playback = usePlayback(log, { autoplay: true });
  const liveRun = useLiveRun(client, 'rogue');
  const server = useSceneServer(client, 'rogue', { enabled: isLive, paused: liveRun.active && !liveRun.ended });

  // Opened while a run is going: follow it rather than offering another.
  const followed = useRef(false);
  useEffect(() => {
    if (server.scene?.running && !liveRun.active && !followed.current) {
      followed.current = true;
      liveRun.follow();
    }
  }, [server.scene?.running, liveRun]);
  useEffect(() => {
    if (liveRun.ended) server.refresh();
  }, [liveRun.ended]); // eslint-disable-line react-hooks/exhaustive-deps

  const scene: SceneState = logSource ? playback.scene : liveRun.active ? liveRun.scene : EMPTY;
  const hasRun = scene.lines > 0;

  // The idle stage shows a real spore, read now: the one the server would pick, else the one the recording used.
  const offerStart = useMemo(() => offerLines?.find((l) => l.type === 'start'), [offerLines]);
  const pick = server.scene?.preconditions.find((p) => p.pick)?.pick;
  const idleId = pick?.spore ?? offerStart?.spore ?? null;
  const idleProvider = pick?.provider ?? offerStart?.provider ?? null;
  const idleCast = useIdleCast(idleId, idleProvider, offerStart?.attacker ?? 'an account the owner never approved', isLive && !hasRun);

  // Receipts: the app reads the refusals itself once a run is over, so they can say Confirmed.
  const start = scene.start;
  const rpcRouter = useMemo(() => liveRouter(), []);
  const receipts = useReceiptStore(rpcRouter.rpc, start?.router ?? rpcRouter.id);
  const over = scene.verdict.status === 'completed' || scene.verdict.status === 'failed';
  const fetched = useRef(false);
  useEffect(() => {
    if (!over || fetched.current || !start) return;
    fetched.current = true;
    for (const a of scene.attempts) {
      for (const t of a.tries) {
        if (t.tx && !t.tx.endsWith(')')) receipts.fetch(t.tx, start.operator);
      }
    }
  }, [over]); // eslint-disable-line react-hooks/exhaustive-deps

  const pre = server.scene?.preconditions ?? [];
  // Only whoever runs the scene server, on its own machine, sees the live controls.
  const operator = isLive && server.reachable === true;
  const canRun = operator && !!epoch.info && pre.length > 0 && pre.every((p) => p.ok) && !server.scene?.running && !liveRun.starting;
  const running = isLive && liveRun.active && !liveRun.ended;
  const offerLink = offer ? linkTo('/lab/rogue', sourceQuery({ kind: 'recorded', run: offer.run, date: offer.date })) : null;
  const liveLink = linkTo('/lab/rogue', '');
  const storyLen = offerLines ? seconds(durationMs(offerLines, 'story')) : null;
  const line = hasRun ? narrate(scene) : idleLine(idleCast);
  const lastDecided = scene.beat.kind === 'decided' ? scene.beat.step : null;

  // Coming from the Watch link or a jump mid-page: the stage must be in view when it starts.
  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [q]);

  const cast = castOf(scene, idleCast);
  const spots = useSpots(q, cast?.spore ?? null);
  const [pointed, setPointed] = useState<AttemptKey | null>(null);
  const firstRefusal = scene.steps.filter((s) => s.state === 'failed').length;
  const passed = scene.checks.filter((c) => c.ok).length;
  const note = source?.kind === 'recorded' && log ? retold(playback.length, playback.pace) : null;

  return (
    <ReceiptContext.Provider value={receipts}>
      <div className="scene">
        <SceneNav current="rogue" q={q} aside={source?.kind === 'recorded' && canReachFrom(SCENE_SERVER, window.location.hostname) ? <Link className="scene-alt" to={liveLink}>Run it live instead</Link> : null} />

        <div className="scene-play">
          <div className="scene-bench">
            <div className="scene-side">
              <SceneHead question="What if the agent goes rogue?" line={line} quote={lastDecided?.decision === 'refused' ? lastDecided.err : null} />
              {liveRun.error && <p className="mono tone-warn" role="alert">Could not start: {liveRun.error}</p>}
              {logError && <ErrorState error={logError} what="this scene's log" onRetry={() => setAttempt((n) => n + 1)} />}
              {logSource && !log && !logError && <LoadingBar label="Loading the log" ch={12} />}
              {cast && <SpecimenSheet spore={cast.spore} to={linkTo(`/spore/${cast.spore}`, q)} rows={sheetRows(cast, scene, over)} label={`Spore #${cast.spore}, as of this moment`} />}
              <aside className="scene-docket">
                <Verdict scene={scene} />
                <SceneLanes attempts={scene.attempts} sender={start?.operator} onPoint={setPointed} />
                {!hasRun && <p className="body scene-idle-note">Three attempts, each a real transaction. The limits are in the contract, so it doesn’t matter what the agent wants.</p>}
              </aside>
            </div>

            <div className="scene-stage-slot">
              <div className="stage-frame">
                <SceneStage scene={scene} idle={idleCast} reducedMotion={reducedMotion} spots={spots} pointed={pointed} />
                {note && <span className="label stage-source">{note}</span>}
              </div>
              <StageLegend seed={cast?.art?.seed ?? null} marks={['hero', 'peer', 'tube', 'wall', 'attempt', 'refused']} />
            </div>
          </div>

          <div className="scene-transport">
            <div className="scene-controls">
              {logSource ? (
                playback.finished ? (
                  <button type="button" className="btn btn-primary" onClick={playback.restart}>↻ Watch again</button>
                ) : playback.playing ? (
                  <button type="button" className="btn btn-secondary" onClick={playback.pause}>Pause</button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={playback.play} disabled={!log}>▶︎ Play</button>
                )
              ) : running ? (
                <span className="body scene-running" role="status">
                  <span className="dot-live" aria-hidden="true" /> Running on testnet · each tx waits for its final outcome
                  {liveRun.lost && <span className="tone-warn"> · connection lost, retrying</span>}
                </span>
              ) : (
                <>
                  {offerLink && (
                    <Link className="btn btn-primary scene-cta" to={offerLink}>▶︎ Watch it happen{storyLen ? ` · ${storyLen}` : ''}</Link>
                  )}
                  {operator && (
                    <button type="button" className={`btn ${offerLink ? 'btn-secondary' : 'btn-primary'}`} disabled={!canRun} onClick={liveRun.start}>
                      {liveRun.starting ? 'Starting…' : hasRun ? 'Run again on testnet' : 'Run it live on testnet'}
                    </button>
                  )}
                  {!canRun && server.reachable !== false && pre.some((p) => !p.ok) && <span className="mono-s scene-why">{pre.find((p) => !p.ok)!.label}: not ready. See preconditions below.</span>}
                  {!offerLink && server.reachable === false && <span className="body scene-why">No recording available.</span>}
                </>
              )}
            </div>
            <ActRail acts={ACTS} act={scene.act} over={over} onSeek={logSource && log ? playback.seekAct : undefined} reducedMotion={reducedMotion} tips={ACT_TIPS} />
            <div className="scene-after">
              {logSource && <PaceSwitch playback={playback} />}
              {over && <NextScene after="rogue" />}
            </div>
          </div>
        </div>

        <DecayStrip plates={scene.plates} sporeId={start?.spore ?? null} active={hasRun && (scene.act === 'quiet' || scene.act === 'cleanup')} decayBps={start?.decay_bps ?? null} />

        <ProofTabs
          opening={!hasRun && operator ? 'run' : 'steps'}
          tabs={[
            {
              key: 'steps',
              word: 'Every step',
              count: scene.steps.length ? (firstRefusal ? `${scene.steps.length} · ${firstRefusal} refused` : String(scene.steps.length)) : undefined,
              body: (
                <>
                  <SceneSteps steps={scene.steps} acts={ACTS} sender={start?.operator} />
                  {scene.bad.map((b, i) => (
                    <p key={i} className="mono-s tone-warn">Unreadable log line: {b}</p>
                  ))}
                  {scene.notes.map((n, i) => (
                    <p key={i} className="body tone-warn">{n}</p>
                  ))}
                  {scene.plates.flatMap((p) => (p.close?.tx ? [p] : [])).map((p) => (
                    <p key={p.mark} className="mono-s proof-close">close of epoch {p.close!.epoch}: <Evidence tx={p.close!.tx!} /> fingerprint {p.close!.fingerprint ? `${p.close!.fingerprint.slice(0, 10)}…` : '—'}</p>
                  ))}
                  {hasRun && <Link className="body" to={linkTo('/activity', q)}>See these txs in Activity →</Link>}
                </>
              ),
            },
            { key: 'diff', word: 'Before and after', body: <StateDiff scene={scene} /> },
            { key: 'checks', word: 'Checks', count: scene.checks.length ? `${passed} of ${scene.checks.length}` : undefined, body: <Checks checks={scene.checks} /> },
            {
              key: 'run',
              word: operator ? 'Before you run it' : 'What this view is',
              body: (
                <>
                  {operator ? (
                    <Preconditions list={pre} epochOk={!!epoch.info && !epoch.error} epochKnown={!!epoch.info} />
                  ) : (
                    <p className="body">This view replays a log, so nothing is sent. Every tx link here points at a real past transaction.</p>
                  )}
                  {isLive && server.scene && (
                    <>
                      <button type="button" className="btn btn-secondary" disabled={!!server.scene.reset.blocked || running} onClick={() => client.reset('rogue').finally(server.refresh)}>Reset</button>
                      {server.scene.reset.blocked && <p className="body scene-why">{server.scene.reset.blocked}</p>}
                    </>
                  )}
                  {operator && <p className="body scene-why">A live run spends real testnet gas and two real closes. Every spore’s tubes decay at those closes, so it’s worth running only when you want it to count.</p>}
                  {start && (
                    <p className="body scene-why">
                      Owner <span className="mono">{shortAccount(start.owner)}</span> · agent <span className="mono">{shortAccount(start.operator)}</span> · attacker <span className="mono">{start.attacker}</span> · contract <span className="mono">{start.router}</span>
                    </p>
                  )}
                </>
              ),
            },
          ]}
        />
      </div>
    </ReceiptContext.Provider>
  );
}

const EMPTY = buildScene([]);

function idleLine(c: StageCast | null): string {
  if (!c) return 'A spore’s agent holds a key that can spend its money.';
  return `Spore #${c.spore}’s agent holds a key to ${c.balance ? formatNear(c.balance) : 'its money'}.`;
}
