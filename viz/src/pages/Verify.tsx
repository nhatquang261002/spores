// `/verify` (Design §6.G, plan S10): the browser does what `verify/src/main.rs`
// does. The header says what will be checked and where the close hashes come
// from; Run verification reads the chain and recomputes on every click.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router';
import { FullHash, RunSummary, VerdictWord, VerificationTable } from '../components/VerificationResult';
import type { ImageCheck, VerifyResult } from '../model/verify';
import { progressText } from '../model/verify';
import { sourceQuery } from '../sources/source';
import { useApp } from '../state/source';
import { useCloseHashes, useVerify } from '../state/verify';
import { formatClock } from '../ui/format';
import { EmptyState, ErrorState, LoadingBar, Unavailable } from '../ui/states';
import { SourceBadge } from '../ui/status';
import { hex, paletteOf } from '../ui/tokens';
import { N, rgbToRgba } from '../wasm/renderer';
import { PageHeader } from './Pages';

/** The spore the Design's example names: sold in the Phase 5 run, with a commit `spores-verify` also checks. */
const DEFAULT_SPORE = 5;

/** `?spore=N`; absent is the default, an empty value means epochs only. */
export function parseSporeParam(v: string | null): number | null {
  if (v === null) return DEFAULT_SPORE;
  return /^\d{1,4}$/.test(v) ? Number(v) : null;
}

export function parseTargetEpoch(v: string | null): number | null {
  return v !== null && /^\d{1,9}$/.test(v) && Number(v) >= 1 ? Number(v) : null;
}

function RenderedCanvas({ check }: { check: ImageCheck }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (check.rgb) ref.current?.getContext('2d')?.putImageData(new ImageData(rgbToRgba(check.rgb), N, N), 0, 0);
  }, [check.rgb]);
  return (
    <figure className="artwork verify-art" data-state="ready" style={{ '--accent': hex(paletteOf(check.seed!).stops[3]) } as CSSProperties}>
      <div className="artwork-frame" role="img" aria-label={`Spore #${check.spore} at epoch ${check.epoch}, as this browser rendered it just now`}>
        <canvas ref={ref} width={N} height={N} className="artwork-canvas is-front" aria-hidden="true" />
      </div>
      <figcaption className="mono-s artwork-caption">rendered in this browser · epoch {check.epoch}</figcaption>
    </figure>
  );
}

function HashLine({ what, mine, committed, mineWord }: { what: string; mine: string; committed: string; mineWord: string }) {
  return (
    <>
      <dt className="label">{what}</dt>
      <dd>
        <VerdictWord verdict={mine === committed ? 'match' : 'mismatch'} />
        <span className="verify-diff">
          <span className="mono">{mineWord} {mine}</span>
          <span className="mono">committed {committed}</span>
        </span>
      </dd>
    </>
  );
}

function ImageSection({ check }: { check: ImageCheck }) {
  return (
    <section className="verify-image" aria-label="Image check">
      <h2 className="heading">
        Image · Spore #{check.spore}
        {check.epoch !== null && ` · commit for epoch ${check.epoch}`} · <VerdictWord verdict={check.verdict} />
      </h2>
      {check.reason && <p className="mono verify-reason">{check.reason}</p>}
      {check.state && check.image && check.renderer && (
        <div className="verify-image-body">
          <div className="verify-figures">
            <RenderedCanvas check={check} />
            <figure className="artwork verify-art">
              <div className="artwork-frame">
                {check.glyph ? <img className="artwork-glyph" src={check.glyph} alt={`On-chain glyph of Spore #${check.spore}, as of now`} /> : <div className="artwork-glyph" />}
              </div>
              <figcaption className="mono-s artwork-caption">{check.glyph ? 'on-chain glyph · as of now' : <Unavailable reason="The token could not be read; the glyph is not part of the check." />}</figcaption>
            </figure>
          </div>
          <dl className="verify-dl">
            <HashLine what="State hash" mine={check.state.mine} committed={check.state.committed} mineWord="recomputed" />
            <HashLine what="Image hash" mine={check.image.mine} committed={check.image.committed} mineWord="rendered" />
            <dt className="label">Renderer</dt>
            <dd>
              <VerdictWord verdict={check.renderer.mine === check.renderer.committed ? 'match' : 'mismatch'} />
              <span className="mono verify-value"> this app v{check.renderer.mine}, committed v{check.renderer.committed}</span>
            </dd>
            <dt className="label">State used</dt>
            <dd className="mono">age {check.age} · {check.tubes} {check.tubes === 1 ? 'tube' : 'tubes'} from the replay</dd>
          </dl>
        </div>
      )}
    </section>
  );
}

function HeadLine({ result }: { result: VerifyResult }) {
  const h = result.head;
  if (h.kind === 'checked') {
    return (
      <p className="body verify-head">
        The contract’s latest fingerprint, epoch {h.epoch}: <FullHash h={h.chain} /> · <VerdictWord verdict={h.verdict} />
        {h.verdict === 'mismatch' && <span className="mono"> replayed {h.replayed}</span>}
      </p>
    );
  }
  if (h.kind === 'unable') {
    return (
      <p className="body verify-head">
        The contract’s latest fingerprint: <VerdictWord verdict="unable" /> <span className="mono">{h.reason}</span>
      </p>
    );
  }
  return (
    <p className="body verify-head">
      The contract’s latest fingerprint: <Unavailable reason="It can be compared only when the contract is on the epoch right after the last replayed close." /> not compared. The contract is at epoch {h.routerEpoch}; the replay reached epoch {h.lastEpoch}.
    </p>
  );
}

function Footer({ result }: { result: VerifyResult }) {
  const replayed = result.rows.filter((r) => r.checks.length);
  const listed = replayed.filter((r) => r.tubesListed).length;
  const h = result.head;
  const checked = [
    `each close tx used was sent to ${result.router} and carries its close event`,
    `${replayed.length} replayed ${replayed.length === 1 ? 'fingerprint' : 'fingerprints'} against the event and the fingerprint the contract stores, and each link to the previous one`,
    ...(listed ? [`the tubes one by one for ${listed} ${listed === 1 ? 'epoch' : 'epochs'} whose event lists them`] : []),
    ...(replayed.length - listed ? [`only the tube count for the ${replayed.length - listed} ${replayed.length - listed === 1 ? 'epoch' : 'epochs'} whose event does not list them`] : []),
  ];
  if (h.kind === 'checked') checked.push('the contract’s latest fingerprint');
  if (result.image?.state) checked.push(`Spore #${result.image.spore}’s state hash, image hash and renderer version against its commit`);
  return (
    <footer className="body verify-footer">
      <p>Verification ran in your browser using the same core code as the contract (compiled to WebAssembly).</p>
      <p>It checked: {checked.join('; ')}.</p>
      <p>
        It did not check: anything not listed above
        {h.kind === 'skipped' && h.routerEpoch > h.lastEpoch + 1 && <>, including epochs {h.lastEpoch + 1} to {h.routerEpoch - 1}, whose closes were not replayed</>}.
      </p>
    </footer>
  );
}

export function Verify() {
  const { source, router } = useApp();
  const { run, start, available } = useVerify();
  const hashes = useCloseHashes(source, router);
  const [params, setParams] = useSearchParams();
  const spore = parseSporeParam(params.get('spore'));
  const [sporeText, setSporeText] = useState(spore === null ? '' : String(spore));
  const target = parseTargetEpoch(params.get('epoch'));
  const q = source ? sourceQuery(source) : '';

  const setSpore = (text: string) => {
    if (!/^\d{0,4}$/.test(text)) return;
    setSporeText(text);
    const next = new URLSearchParams(params);
    next.set('spore', text);
    setParams(next, { replace: true });
  };

  if (source?.kind === 'sim' || !available) {
    return (
      <>
        <PageHeader title="Verify" />
        <EmptyState title="The simulation has no chain to verify">
          Verification replays the contract’s closes, and the simulation has none. <Link to="/verify">Open Verify on LIVE</Link>.
        </EmptyState>
      </>
    );
  }

  const list = hashes.list;
  const result = run?.status === 'done' ? run.result : null;
  const running = run?.status === 'running';
  // Known only after a run: a list needn't start at epoch 1, so its length says nothing about how far it reaches.
  const toEpoch = result?.rows.length;
  const targetMissing = result && target !== null && !result.rows.some((r) => r.epoch === target);

  return (
    <>
      <PageHeader title="Verify" />

      <section className="verify-header">
        {list ? (
          <p className="body-l">
            Every epoch fingerprint of <span className="mono">{list.router}</span> from epoch 1{toEpoch ? ` to ${toEpoch}` : ''}
            {spore !== null ? `, and the committed image of Spore #${spore}` : ''}.
          </p>
        ) : !hashes.error ? (
          <LoadingBar ch={48} label="Reading the close list" />
        ) : null}
        {hashes.error && <ErrorState error={hashes.error} what="the close hashes" onRetry={hashes.retry} />}
        {list && (
          <p className="body verify-sources">
            Close hashes:{' '}
            {list.from.length ? (
              list.from.map((f, i) => (
                <span key={f.label}>
                  {i > 0 && ' + '}
                  {f.url ? <a className="mono" href={f.url}>{f.label}</a> : <span className="mono">{f.label}</span>} ({f.count})
                </span>
              ))
            ) : (
              <span className="mono">none</span>
            )}
            {list.unreadableLines > 0 && <span className="tone-caution"> · {list.unreadableLines} log {list.unreadableLines === 1 ? 'line' : 'lines'} could not be read and {list.unreadableLines === 1 ? 'was' : 'were'} skipped</span>}
            {source?.kind !== 'live' && (
              <span className="verify-chain">
                Chain reads: <SourceBadge source={{ kind: 'live', network: 'testnet', router: list.router }} />
              </span>
            )}
          </p>
        )}
        {list && !list.hashes.length && (
          <EmptyState title="No close hashes for this router">
            Verification needs every close since epoch 1. Add them to <span className="mono">public/closes/{list.router}.txt</span>, one hash per line.
          </EmptyState>
        )}
        <div className="verify-controls">
          <label className="label verify-spore">
            Spore
            <input className="mono" inputMode="numeric" value={sporeText} onChange={(e) => setSpore(e.target.value)} aria-describedby="verify-spore-note" disabled={running} />
          </label>
          <button type="button" className="btn btn-primary" disabled={running || !list?.hashes.length} onClick={() => start(spore)}>
            {running ? 'Running…' : 'Run verification'}
          </button>
          <span id="verify-spore-note" className="mono-s tone-muted">
            {spore === null ? 'No spore: epochs only.' : 'Each click reads the chain and recomputes. Nothing is kept as verified.'}
          </span>
        </div>
      </section>

      {target !== null && (
        <p className="body verify-target">
          Opened for epoch {target}. It is checked as part of the whole chain, because the replay has to start at epoch 1.
        </p>
      )}

      <div role="status" className="verify-status">
        {run?.status === 'running' && <span className="mono">{progressText(run.progress)}</span>}
      </div>

      {run?.status === 'failed' && (
        <>
          {/* Not checked isn't failed: the word a judge reads must say which. */}
          <p className="body-l verify-unable" role="status"><VerdictWord verdict="unable" />. Nothing was checked: the chain could not be read, so this says nothing about the run either way.</p>
          <ErrorState error={run.error} what="this verification" onRetry={() => start(run.spore)} />
        </>
      )}

      {!run && list && list.hashes.length > 0 && (
        <EmptyState title="Not run yet">
          Nothing has been checked. Run verification reads {list.hashes.length} close {list.hashes.length === 1 ? 'tx' : 'txs'} from archival nodes, which are rate-limited.
        </EmptyState>
      )}

      {result && (
        <>
          <div aria-live="polite" className="verify-summary">
            <RunSummary result={result} className="figure" />
            <span className="mono-s tone-muted">ran at {formatClock(result.ranAt)} · {(result.ms / 1000).toFixed(0)} s</span>
          </div>
          {targetMissing && (
            <p className="body">
              Epoch {target}: <Unavailable reason="Add its close hash to the list." /> this run reached epoch {result.rows.length}, so it did not check it.
            </p>
          )}
          {result.replayError && (
            <p className="body">
              <VerdictWord verdict="unable" /> The replay refused the input: <span className="mono">{result.replayError}</span>
            </p>
          )}
          {result.failed.length > 0 && (
            <section className="verify-failed" aria-label="Close txs that could not be used">
              <h2 className="heading">
                <VerdictWord verdict="unable" /> {result.failed.length} close {result.failed.length === 1 ? 'tx' : 'txs'} of {result.listed} could not be used
              </h2>
              <ul>
                {result.failed.map((f) => (
                  <li key={f.tx} className="mono">
                    <FullHash h={f.tx} /> {f.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {result.rows.length > 0 && <VerificationTable key={`table-${result.ranAt}`} result={result} q={q} target={target} />}
          <HeadLine result={result} />
          {result.image && <ImageSection key={`image-${result.ranAt}`} check={result.image} />}
          <Footer result={result} />
        </>
      )}
    </>
  );
}
