// `VerificationResult` (Design §6.G, §7). `full` is the `/verify` table: one row
// per epoch, `✓ Match`, `✕ Mismatch` with its diff, or `! Unable` with the
// reason. `compact` is the verdict with a Details link, on the Spore page and
// on close rows. Nothing here is stored: it shows the run in memory or offers one.
import { useEffect, useRef, useState, type Ref } from 'react';
import { Link } from 'react-router';
import { EXPLORER } from '../chain/rpc';
import { matchedEpochs, overallVerdict, progressText, summaryText, VERDICT_WORD, type Check, type EpochRow, type Verdict, type VerifyResult } from '../model/verify';
import { linkTo } from '../sources/source';
import { useVerify } from '../state/verify';
import { formatClock, shortHash } from '../ui/format';
import { Unavailable } from '../ui/states';
import { Tooltip } from '../ui/Tooltip';
import './verify.css';

export function VerdictWord({ verdict }: { verdict: Verdict }) {
  const v = VERDICT_WORD[verdict];
  return (
    <span className={`verdict ${v.tone}`}>
      <span className={verdict === 'unable' ? 'glyph-caution' : undefined} aria-hidden="true">{v.glyph}</span> {v.word}
    </span>
  );
}

export function FullHash({ h }: { h: string }) {
  return (
    <Tooltip content={<span className="mono">{h}</span>}>
      <span className="mono">{shortHash(h)}</span>
    </Tooltip>
  );
}

/** `✓ Match · 16/16 epochs · image matches commit`: the overall verdict of a run. */
export function RunSummary({ result, className = 'mono' }: { result: VerifyResult; className?: string }) {
  const verdict = overallVerdict(result);
  const v = VERDICT_WORD[verdict];
  return (
    <span className={`${className} ${v.tone}`}>
      <span className={verdict === 'unable' ? 'glyph-caution' : undefined} aria-hidden="true">{v.glyph}</span> {summaryText(result)}
    </span>
  );
}

const ranTip = (r: VerifyResult) => `Ran at ${formatClock(r.ranAt)} in this tab. It is not stored: a reload forgets it, and each run reads the chain again.`;

/** A close row (Design §6.E): `Verify →`, or that epoch's verdict once a run has reached it. */
export function EpochVerification({ epoch, q, className }: { epoch: number; q: string; className?: string }) {
  const { run } = useVerify();
  const row = run?.status === 'done' ? run.result.rows.find((r) => r.epoch === epoch) : undefined;
  const to = linkTo('/verify', q, { epoch });
  if (!row || run?.status !== 'done') {
    return (
      <Link className={className} to={to}>
        Verify →
      </Link>
    );
  }
  const v = VERDICT_WORD[row.verdict];
  return (
    <Tooltip content={ranTip(run.result)} focusable={false}>
      <Link className={`${className ?? ''} ${v.tone}`} to={to} aria-label={`Epoch ${epoch}: ${v.word}. Details`}>
        <span aria-hidden="true">{v.glyph} {v.word} →</span>
      </Link>
    </Tooltip>
  );
}

/** The Spore page's Technical block (Design §6.D): the button, then `VerificationResult compact`. */
export function SporeVerification({ spore, hasCommit, q }: { spore: number; hasCommit: boolean; q: string }) {
  const { available, run, start } = useVerify();
  if (!hasCommit) return <Unavailable reason={`Spore #${spore} has no committed image to verify.`} />;
  const details = (
    <Link className="mono-s" to={linkTo('/verify', q, { spore })}>
      Details
    </Link>
  );
  if (run?.spore === spore && run.status === 'running') {
    return (
      <span className="mono-s verify-compact" role="status">
        {progressText(run.progress)} {details}
      </span>
    );
  }
  if (run?.spore === spore && run.status === 'done') {
    return (
      <span className="verify-compact" aria-live="polite">
        <Tooltip content={ranTip(run.result)}>
          <RunSummary result={run.result} />
        </Tooltip>{' '}
        {details}
      </span>
    );
  }
  if (run?.spore === spore && run.status === 'failed') {
    return (
      <span className="verify-compact" aria-live="polite">
        <VerdictWord verdict="unable" /> <span className="mono-s">{run.error.message}</span> {details}
      </span>
    );
  }
  const busy = run?.status === 'running';
  return (
    <span className="verify-compact">
      <button type="button" className="btn btn-secondary" disabled={!available || busy} onClick={() => start(spore)}>
        {busy ? 'Another verification is running' : 'Verify this image'}
      </button>
    </span>
  );
}

function CheckLine({ c }: { c: Check }) {
  return (
    <>
      <dt className="label">{c.what}</dt>
      <dd>
        <VerdictWord verdict={c.verdict} />
        {c.verdict === 'match' && <span className="mono verify-value"> {c.replayed}</span>}
        {c.verdict === 'mismatch' && (
          <span className="verify-diff">
            <span className="mono">replayed {c.replayed}</span>
            <span className="mono">on chain {c.chain ?? 'nothing'}</span>
          </span>
        )}
        {c.verdict === 'unable' && <span className="mono verify-value"> {c.reason}</span>}
      </dd>
    </>
  );
}

function Marks({ marks }: { marks: [string, Verdict | null][] }) {
  return (
    <>
      {marks.map(([word, v]) =>
        v === null ? (
          <span key={word} className="verify-mark tone-muted">— {word}</span>
        ) : (
          <span key={word} className={`verify-mark ${VERDICT_WORD[v].tone}`}>
            <span aria-hidden="true">{VERDICT_WORD[v].glyph}</span> {word}
            <span className="sr-only"> {VERDICT_WORD[v].word}</span>
          </span>
        ),
      )}
    </>
  );
}

const checkOf = (row: EpochRow, what: Check['what']): Verdict | null => row.checks.find((c) => c.what === what)?.verdict ?? null;

function Row({ row, q, target, targetRef }: { row: EpochRow; q: string; target: boolean; targetRef?: Ref<HTMLTableRowElement> }) {
  const [open, setOpen] = useState(target);
  const NOT_REPLAYED = 'This epoch was not replayed: the replay needs every close before it.';
  const prev = checkOf(row, 'prev fingerprint');
  return (
    <>
      <tr className={`${target ? 'is-target ' : ''}is-${row.verdict}`} ref={targetRef}>
        <td className="mono">
          <Link to={linkTo('/network', q, { epoch: row.epoch })}>{row.epoch}</Link>
        </td>
        <td>{row.replayed ? <FullHash h={row.replayed} /> : <Unavailable reason={NOT_REPLAYED} />}</td>
        <td className="v-col-optional mono-s">
          {row.eventFingerprint ? <FullHash h={row.eventFingerprint} /> : <Unavailable reason="No close tx was read for this epoch." />}
          {row.checks.length > 0 && <Marks marks={[['event', checkOf(row, 'event fingerprint')], ['view', checkOf(row, 'stored fingerprint')]]} />}
        </td>
        <td className="v-col-optional mono-s">{prev ? <Marks marks={[[prev === 'match' ? 'linked' : 'differs', prev]]} /> : <Unavailable reason={NOT_REPLAYED} />}</td>
        <td className="v-col-optional mono-s">
          {row.tubeCount === null ? (
            <Unavailable reason={NOT_REPLAYED} />
          ) : (
            <Tooltip content={row.tubesListed ? 'The event lists its tubes: each one was compared with the replay.' : 'This close logs only its tube count (router4 since epoch 17): the count was compared.'}>
              <span>
                {row.tubeCount}
                <Marks marks={[[row.tubesListed ? 'listed' : 'count', checkOf(row, row.tubesListed ? 'tubes' : 'tube count')]]} />
              </span>
            </Tooltip>
          )}
        </td>
        <td>
          <button type="button" className="verify-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} aria-label={`Epoch ${row.epoch}: ${VERDICT_WORD[row.verdict].word}. ${open ? 'Hide' : 'Show'} details`}>
            <VerdictWord verdict={row.verdict} />
          </button>
          {row.reason && <span className="mono-s verify-reason">{row.reason}</span>}
        </td>
      </tr>
      {open && (
        <tr className="verify-detail">
          <td colSpan={6}>
            <dl className="verify-dl">
              <dt className="label">Close tx</dt>
              <dd className="mono">
                {row.tx ? (
                  <a href={`${EXPLORER}/${row.tx}`} target="_blank" rel="noreferrer" aria-label={`tx ${row.tx}, opens the explorer`}>
                    {shortHash(row.tx)} ↗
                  </a>
                ) : (
                  <Unavailable reason="No close tx was read for this epoch." />
                )}
              </dd>
              {row.checks.map((c) => (
                <CheckLine key={c.what} c={c} />
              ))}
              {!row.checks.length && (
                <>
                  <dt className="label">Not checked</dt>
                  <dd className="mono">{row.reason}</dd>
                </>
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

/** One row per epoch (Design §6.G). `target` is the row a `Verify →` link opened at. */
export function VerificationTable({ result, q, target }: { result: VerifyResult; q: string; target: number | null }) {
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'center' });
  }, [result, target]);
  return (
    <div className="verify-table-wrap">
      <table className="verify-table">
        <caption className="sr-only">
          {matchedEpochs(result.rows)} of {result.rows.length} epochs of {result.router} match. Overall {VERDICT_WORD[overallVerdict(result)].word}.
        </caption>
        <thead>
          <tr className="label">
            <th scope="col">Epoch</th>
            <th scope="col">Fingerprint (replayed)</th>
            <th scope="col" className="v-col-optional">On chain (event / view)</th>
            <th scope="col" className="v-col-optional">Prev link</th>
            <th scope="col" className="v-col-optional">Tubes</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => (
            <Row key={row.epoch} row={row} q={q} target={row.epoch === target} targetRef={row.epoch === target ? ref : undefined} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
