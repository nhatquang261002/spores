// Sale and control transfer (Design §6.H, /lab/sale). Starts from Rogue's layout:
// the question, one button, the stage pinned beside the story, proof underneath.
// The owner flips only when the `buy` tx is final, and payouts come from receipts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { EXPLORER } from '../chain/rpc';
import { JobTimeline } from '../components/JobTimeline';
import { SaleStage, type SaleCast } from '../components/SaleStage';
import { ActRail, Checks, PaceSwitch, Preconditions, seconds, timelineSteps } from '../components/SceneChrome';
import { Evidence } from '../components/SceneLanes';
import { buildSale, narrateSale, SALE_ACTS, saleDelay, saleRows, type SaleState } from '../model/sale';
import { durationMs, repText, type SceneLine } from '../model/scene';
import { liveRouter } from '../sources/live';
import { type RecordedBundle } from '../sources/recorded';
import { canReachFrom, latestRecording, loadSceneLog, SCENE_SERVER, SceneClient } from '../sources/scene';
import { linkTo, sourceQuery } from '../sources/source';
import { ReceiptContext, useReceiptStore } from '../state/activity';
import { useIdleCast, useLiveRun, usePlayback, useSceneServer } from '../state/scene';
import { useApp } from '../state/source';
import { formatClock, formatNear, shortAccount, tubesText } from '../ui/format';
import { ErrorState, LoadingBar } from '../ui/states';
import { SourceBadge } from '../ui/status';
import '../components/activity.css';
import '../components/detail.css';
import '../components/gallery.css';
import '../components/lab.css';

const EMPTY = buildSale([]);

/** A failed row quotes the contract or the check as it is; a passed row keeps its evidence one click away. */
function SaleChecklist({ scene, evidence, sender }: { scene: SaleState; evidence: boolean; sender?: string }) {
  const rows = saleRows(scene);
  return (
    <ol className="sale-steps" aria-label="The 11 checks">
      {rows.map((r) => (
        <li key={r.n} className={`sale-step is-${r.state}`}>
          <span className="sale-n mono-s" key={r.state}>
            {r.state === 'ok' ? <span aria-hidden="true">✓</span> : r.state === 'failed' ? <span aria-hidden="true">✕</span> : r.n}
          </span>
          <span className="body sale-name">
            {r.name}
            <span className="sr-only">{r.state === 'ok' ? ': passed' : r.state === 'failed' ? ': failed' : ': not reached yet'}</span>
          </span>
          {r.check?.tx && !r.check.tx.endsWith(')') && (evidence && (r.n === 2 || r.n === 6 || r.n === 7) ? <Evidence tx={r.check.tx} sender={sender} /> : <a className="mono-s" href={`${EXPLORER}/${r.check.tx}`} target="_blank" rel="noreferrer" aria-label={`Check ${r.n} tx ${r.check.tx}, opens the explorer`}>tx ↗</a>)}
          {r.state === 'failed' && r.check && <span className="mono-s tone-warn sale-why">expected {r.check.expected}, got {r.check.actual}</span>}
        </li>
      ))}
    </ol>
  );
}

function Verdict({ scene }: { scene: SaleState }) {
  const v = scene.verdict;
  if (v.status !== 'completed' && v.status !== 'failed') return null;
  const passed = scene.checks.filter((c) => c.ok).length;
  return (
    <section className={`scene-verdict is-${v.status}`} aria-live="polite">
      <div className="sv-figure">
        <span className="figure-l">{passed} / {saleRows(scene).length}</span>
        <span className="label">checks passed</span>
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

/** The chain's own values in the blocks either side of the buy: what moved, and what didn't. */
function BlockDiffTable({ scene }: { scene: SaleState }) {
  const d = scene.diff;
  if (!d) return <p className="body">The chain’s values either side of the buy appear once the run has read them.</p>;
  const a = d.before;
  const b = d.after;
  const policy = (p: any) => (p?.paused ? 'paused, budget 0' : `budget ${formatNear(p?.budget_per_epoch ?? '0')}`);
  const rows: [string, string, string][] = [
    ['owner', shortAccount(a.owner), shortAccount(b.owner)],
    ['agent', a.operator ? shortAccount(a.operator) : 'none', b.operator ? shortAccount(b.operator) : 'none'],
    ['policy', policy(a.policy), policy(b.policy)],
    ['balance', formatNear(a.balance), formatNear(b.balance)],
    ['tubes', String(a.connections?.length ?? 0), String(b.connections?.length ?? 0)],
    ['age', String(a.age), String(b.age)],
    ['reputation', repText(a.reputation), repText(b.reputation)],
  ];
  return (
    <table className="state-diff">
      <thead>
        <tr><th className="label" scope="col">Value</th><th className="label" scope="col">Block before</th><th className="label" scope="col">Block of the buy</th></tr>
      </thead>
      <tbody>
        {rows.map(([k, x, y]) => (
          <tr key={k} className={x !== y ? 'is-changed' : ''}><th className="body" scope="row">{k}</th><td className="mono">{x}</td><td className="mono">{y}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export function SaleScene({ client: given }: { client?: SceneClient } = {}) {
  const { source, reducedMotion, epoch } = useApp();
  const q = source ? sourceQuery(source) : '';
  const client = useMemo(() => given ?? new SceneClient(), [given]);
  const isLive = source?.kind === 'live';
  const logSource = source?.kind === 'run' || source?.kind === 'recorded' ? source : null;

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
    latestRecording('sale').then(
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

  const playback = usePlayback<SaleState>(log, { autoplay: true, build: buildSale, delay: saleDelay, lastAct: 'takeover' });
  const liveRun = useLiveRun<SaleState>(client, 'sale', buildSale);
  const server = useSceneServer(client, 'sale', { enabled: isLive, paused: liveRun.active && !liveRun.ended });

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

  const scene: SaleState = logSource ? playback.scene : liveRun.active ? liveRun.scene : EMPTY;
  const hasRun = scene.lines > 0;

  const offerStart = useMemo(() => offerLines?.find((l) => l.type === 'start'), [offerLines]);
  const pick = server.scene?.preconditions.find((p) => p.pick)?.pick;
  const idleId = pick?.spore ?? offerStart?.spore ?? null;
  // A reset really sells it back, so it takes a while and can fail; the page says which.
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resets, setResets] = useState(0);
  const idleCast = useIdleCast(idleId, isLive && !hasRun, resets);
  const reset = () => {
    setResetting(true);
    setResetError(null);
    client.reset('sale').then(
      () => {
        // What's on stage was true before the sale back; the stage now reads the chain again.
        liveRun.clear();
        setResets((n) => n + 1);
      },
      (e) => setResetError((e as Error).message),
    ).finally(() => {
      setResetting(false);
      server.refresh();
    });
  };

  // Receipts: once a run is over the app reads the sale and the refusals itself, so they can say Confirmed.
  const start = scene.start;
  const rpcRouter = useMemo(() => liveRouter(), []);
  const receipts = useReceiptStore(rpcRouter.rpc, start?.router ?? rpcRouter.id);
  const over = scene.verdict.status === 'completed' || scene.verdict.status === 'failed';
  const fetched = useRef(false);
  useEffect(() => {
    if (!over || fetched.current || !start) return;
    fetched.current = true;
    if (scene.buyTx && !scene.buyTx.endsWith(')')) receipts.fetch(scene.buyTx, start.buyer);
    if (scene.oldKey?.tx && !scene.oldKey.tx.endsWith(')')) receipts.fetch(scene.oldKey.tx, start.old_operator);
    if (scene.oldOwner?.tx && !scene.oldOwner.tx.endsWith(')')) receipts.fetch(scene.oldOwner.tx, start.seller);
  }, [over]); // eslint-disable-line react-hooks/exhaustive-deps

  const pre = server.scene?.preconditions ?? [];
  // Only whoever runs the scene server, on its own machine, sees the live controls.
  const operator = isLive && server.reachable === true;
  const canRun = operator && !!epoch.info && pre.length > 0 && pre.every((p) => p.ok) && !server.scene?.running && !liveRun.starting;
  const running = isLive && liveRun.active && !liveRun.ended;
  const canReset = isLive && !!server.scene && !server.scene.reset.blocked && !running;
  const offerLink = offer ? linkTo('/lab/sale', sourceQuery({ kind: 'recorded', run: offer.run, date: offer.date })) : null;
  const liveLink = linkTo('/lab/sale', '');
  const storyLen = offerLines ? seconds(durationMs(offerLines, 'story', saleDelay)) : null;
  const line = hasRun ? narrateSale(scene) : idleLine(idleCast);
  const refusal = scene.beat.kind === 'triedKey' || scene.beat.kind === 'triedOwner' ? scene.beat.step.err ?? null : null;

  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [q]);

  const steps = timelineSteps(scene.steps);
  const failed = scene.steps.filter((s) => s.state === 'failed').length;

  return (
    <ReceiptContext.Provider value={receipts}>
      <div className="scene">
        <div className="scene-top">
          <nav className="breadcrumb body" aria-label="Breadcrumb">
            <Link to={linkTo('/lab', q)}>Demo Lab</Link> <span aria-hidden="true">/</span> <span aria-current="page">Sale and control transfer</span>
          </nav>
          {source && <SourceBadge source={source} staleSince={isLive ? epoch.staleSince : null} />}
        </div>

        <div className="scene-bench">
          <div className="scene-head">
            <h1 className="scene-q">What does a buyer actually get?</h1>
            <p className="scene-narrator" aria-live="polite" key={line}>{line}</p>
            <p className="scene-quote mono tone-warn" aria-live="polite">{refusal ?? ' '}</p>
            <div className="scene-controls">
              {logSource ? (
                <>
                  {playback.finished ? (
                    <button type="button" className="btn btn-primary" onClick={playback.restart}>↻ Watch again</button>
                  ) : playback.playing ? (
                    <button type="button" className="btn btn-secondary" onClick={playback.pause}>Pause</button>
                  ) : (
                    <button type="button" className="btn btn-primary" onClick={playback.play} disabled={!log}>▶︎ Play</button>
                  )}
                  <PaceSwitch playback={playback} />
                  {source?.kind === 'recorded' && canReachFrom(SCENE_SERVER, window.location.hostname) && <Link className="scene-alt body" to={liveLink}>Run it live instead</Link>}
                </>
              ) : running ? (
                <span className="body scene-running" role="status">
                  <span className="dot-live" aria-hidden="true" /> Running on testnet · each tx waits for its final outcome
                  {liveRun.lost && <span className="tone-warn"> · connection lost, retrying</span>}
                </span>
              ) : (
                <>
                  {offerLink && <Link className="btn btn-primary scene-cta" to={offerLink}>▶︎ Watch it happen{storyLen ? ` · ${storyLen}` : ''}</Link>}
                  {canReset ? (
                    <button type="button" className={`btn ${offerLink ? 'btn-secondary' : 'btn-primary'}`} disabled={resetting} onClick={reset}>
                      {resetting ? 'Selling it back…' : 'Reset: sell it back'}
                    </button>
                  ) : operator ? (
                    <button type="button" className={`btn ${offerLink ? 'btn-secondary' : 'btn-primary'}`} disabled={!canRun} onClick={liveRun.start}>
                      {liveRun.starting ? 'Starting…' : hasRun ? 'Run again on testnet' : 'Run it live on testnet'}
                    </button>
                  ) : null}
                                    {canReset && <span className="body scene-why">A live run sold this spore and it stays sold. Reset is a second real sale, back to its first owner, with its own royalty.</span>}
                  {!canReset && !canRun && server.reachable !== false && pre.some((p) => !p.ok) && <span className="mono-s scene-why">{pre.find((p) => !p.ok)!.label}: not ready. See preconditions below.</span>}
                  {!offerLink && server.reachable === false && <span className="body scene-why">No recording available.</span>}
                </>
              )}
            </div>
            {liveRun.error && <p className="mono tone-warn" role="alert">Could not start: {liveRun.error}</p>}
            {resetError && <p className="mono tone-warn" role="alert">The reset failed: {resetError}</p>}
            {logError && <ErrorState error={logError} what="this scene's log" onRetry={() => setAttempt((n) => n + 1)} />}
            {logSource && !log && !logError && <LoadingBar label="Loading the log" ch={12} />}
            <ActRail acts={SALE_ACTS} act={scene.act} over={over} onSeek={logSource && log ? playback.seekAct : undefined} />
          </div>

          <div className="scene-stage-slot">
            <SaleStage scene={scene} idle={idleCast} reducedMotion={reducedMotion} />
          </div>

          <aside className="scene-docket">
            <Verdict scene={scene} />
            <SaleChecklist scene={scene} evidence={over} sender={start?.buyer} />
          </aside>
        </div>

        <details className="scene-proof" open={!hasRun && operator && !offerLink}>
          <summary className="title">Check it yourself</summary>
          <div className="proof-grid">
            <section>
              <h3 className="heading">{operator ? 'Before you run it' : 'What this view is'}</h3>
              {operator ? (
                <Preconditions list={pre} epochOk={!!epoch.info && !epoch.error} epochKnown={!!epoch.info} />
              ) : (
                <p className="body">This view replays a log, so nothing is sent. Every tx link below points at a real past transaction.</p>
              )}
              {operator && server.scene?.reset.blocked && <p className="body scene-why">{server.scene.reset.blocked}</p>}
              {operator && <p className="body scene-why">A live run is a real sale: the spore goes to the buyer and stays there. Reset is a second real sale back to the first owner, with its own royalty. Nothing here closes an epoch, so no tube decays because of it.</p>}
              {start && (
                <p className="body scene-why">
                  Seller <span className="mono">{shortAccount(start.seller)}</span> · buyer <span className="mono">{shortAccount(start.buyer)}</span> · royalty <span className="mono">{shortAccount(start.royalty_account)}</span> · router <span className="mono">{start.router}</span>
                </p>
              )}
            </section>
            <section>
              <h3 className="heading">Either side of the buy</h3>
              <BlockDiffTable scene={scene} />
              <h3 className="heading proof-gap">Payouts, from the receipts</h3>
              {scene.payouts.seller || scene.payouts.royalty ? (
                <ul className="preconditions">
                  {(['seller', 'royalty'] as const).map((role) => {
                    const p = scene.payouts[role];
                    if (!p) return null;
                    return (
                      <li key={role}>
                        <span className={p.ok ? 'tone-growth' : 'tone-warn'} aria-hidden="true">{p.ok ? '✓' : '✕'}</span>
                        <span className="body">{role}: <span className="mono">{shortAccount(p.to)}</span> <span className="mono money">{p.amount ? formatNear(p.amount) : '—'}</span><span className="sr-only">{p.ok ? ', paid' : ', not paid'}</span></span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="body">The contract’s two transfers appear here once the buy’s receipts are read.</p>
              )}
              <h3 className="heading proof-gap">Checks</h3>
              <Checks checks={scene.checks} />
            </section>
            <section className="proof-wide">
              <h3 className="heading">Every step{failed ? ` · ${failed} refused` : ''}</h3>
              {steps.length ? <JobTimeline steps={steps} variant="scene" /> : <p className="body">Each transaction lands here with its time, what was expected and what the chain said.</p>}
              {scene.bad.map((b, i) => (
                <p key={i} className="mono-s tone-warn">Unreadable log line: {b}</p>
              ))}
              {scene.notes.map((n, i) => (
                <p key={i} className="body tone-warn">{n}</p>
              ))}
              {start?.run && steps[0]?.at && <p className="mono-s scene-why">First transaction at {formatClock(steps[0].at)} your time.</p>}
              {hasRun && <Link className="body" to={linkTo('/activity', q)}>See these txs in Activity →</Link>}
            </section>
          </div>
        </details>
      </div>
    </ReceiptContext.Provider>
  );
}

function idleLine(c: SaleCast | null): string {
  if (!c) return 'A spore has tubes, money and an agent. It can be sold.';
  return `Spore #${c.spore} has ${tubesText(c.tubes.length)}, ${c.balance ? formatNear(c.balance) : 'money'} and an agent.`;
}
