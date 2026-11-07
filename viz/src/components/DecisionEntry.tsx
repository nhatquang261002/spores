// `DecisionEntry` (Design §6.E): the expanded decision. Summary (derived), the
// job's rail, recompute badge, tube check and receipt up front; the numbers, the
// job's txs and the raw line one click further.
import { useMemo } from 'react';
import { Link } from 'react-router';
import { errorText, jobRail, jobSteps, type Activity, type ActivityRow } from '../model/activity';
import { byScore, decisionSummary, recompute, ruleCaption, tubeCheck, type Decision, type Recompute, type TubeCheck } from '../model/decisions';
import type { Receipt } from '../model/receipts';
import { linkTo } from '../sources/source';
import { formatD, formatNear, shortHash } from '../ui/format';
import { Unavailable } from '../ui/states';
import { Tooltip } from '../ui/Tooltip';
import { SporeRef } from './indicators';
import { JobRail, JobTimeline, RowWord } from './JobTimeline';
import { Derived, TransactionReceipt } from './TransactionReceipt';

export function SporeLink({ id, palettes, q }: { id: number; palettes: Map<number, number>; q: string }) {
  return (
    <Link className="spore-link" to={linkTo(`/spore/${id}`, q)}>
      <SporeRef id={id} palette={palettes.get(id) ?? null} />
    </Link>
  );
}

function RecomputeBadge({ r }: { r: Recompute }) {
  if (r.status === 'matches') {
    return (
      <Tooltip content="Re-ran the hiring rule in your browser (the agents’ own rules.ts) over the logged quotes: every D_norm, score and the winner came out the same.">
        <span className="check-badge tone-growth">
          <span aria-hidden="true">↻</span> matches log
        </span>
      </Tooltip>
    );
  }
  if (r.status === 'unverifiable') {
    return (
      <span className="check-badge tone-caution">
        <span aria-hidden="true">!</span> Unable to recompute: <span className="mono">{r.reason}</span>
      </span>
    );
  }
  return (
    <details className="check-details">
      <summary className="check-badge tone-warn">
        <span aria-hidden="true">↻</span> differs
      </summary>
      <table className="mini-table">
        <thead>
          <tr>
            <th scope="col" className="label">What</th>
            <th scope="col" className="label">Log</th>
            <th scope="col" className="label">Recomputed</th>
          </tr>
        </thead>
        <tbody>
          {r.diffs.map((x) => (
            <tr key={x.what} className="mono">
              <td>{x.what}</td>
              <td>{x.logged}</td>
              <td>{x.recomputed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function TubeCheckLine({ c }: { c: TubeCheck }) {
  if (c.status === 'needs') {
    return (
      <span className="check-badge">
        <Unavailable reason={`This source has no tube set for the close of epoch ${c.epoch}. A recording has one for each reading it took.`} /> needs the epoch {c.epoch} close
      </span>
    );
  }
  if (c.status === 'match') {
    return (
      <Tooltip content={`Compared with the tubes read from the contract after the close of epoch ${c.epoch}, in your browser.`}>
        <span className="check-badge tone-growth">
          <span aria-hidden="true">↻</span> D values match the epoch {c.epoch} close
        </span>
      </Tooltip>
    );
  }
  return (
    <details className="check-details">
      <summary className="check-badge tone-warn">
        <span aria-hidden="true">↻</span> D values differ from the epoch {c.epoch} close
      </summary>
      <table className="mini-table">
        <thead>
          <tr>
            <th scope="col" className="label">Provider</th>
            <th scope="col" className="label">D in the log</th>
            <th scope="col" className="label">D after the close</th>
          </tr>
        </thead>
        <tbody>
          {c.diffs.map((x) => (
            <tr key={x.provider} className="mono">
              <td>#{x.provider}</td>
              <td>{x.logged}</td>
              <td>{x.close}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Candidates({ d, palettes, q }: { d: Decision; palettes: Map<number, number>; q: string }) {
  const sorted = useMemo(() => byScore(d.candidates), [d]);
  return (
    <div className="table-scroll">
      <table className="candidates">
        <thead>
          <tr>
            <th scope="col" className="label">Provider</th>
            <th scope="col" className="label num">Quote</th>
            <th scope="col" className="label num">D</th>
            <th scope="col" className="label num">D_norm</th>
            <th scope="col" className="label num">Effective price (score)</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.provider} className={c.provider === d.winner ? 'is-winner' : undefined}>
              <td>
                <SporeLink id={c.provider} palettes={palettes} q={q} />
                {c.provider === d.winner && <span className="label tone-agent winner-word">winner</span>}
              </td>
              <td className="mono num money">{formatNear(c.price)}</td>
              <td className="mono num">{formatD(c.d)}</td>
              <td className="mono num">{(Number(c.d_norm) / 1e6).toFixed(2)}</td>
              <td className="mono num money">{formatNear(c.score)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The outcome's terminal tx as a receipt, Logged until fetched. */
function terminalReceipt(d: Decision): Receipt | null {
  const win = d.candidates.find((c) => c.provider === d.winner);
  const base = { evidence: 'logged' as const, epoch: null, from: d.consumer, to: d.winner, amount: win?.price };
  if (d.outcome === 'settled' && d.tx.settle) return { ...base, kind: 'settlement', event: 'settle', tx: d.tx.settle };
  if (d.outcome === 'rejected' && d.tx.reject) return { ...base, kind: 'refund', event: 'reject', tx: d.tx.reject, reason: 'rejected' };
  if (d.outcome === 'accept_failed' && d.tx.accept) return { ...base, kind: 'refusal', event: 'accept', tx: d.tx.accept, amount: undefined, error: errorText(d.err) };
  return null;
}

export function DecisionEntry({ row, data, q }: { row: ActivityRow; data: Activity; q: string }) {
  const d = row.decision!;
  const r = useMemo(() => recompute(d), [d]);
  const tube = useMemo(() => tubeCheck(d, (e) => data.tubesAt.get(e)), [d, data]);
  const steps = useMemo(() => jobSteps(d, data), [d, data]);
  const receipt = terminalReceipt(d);
  return (
    <div className="decision-entry">
      <p className="body decision-summary">
        <Derived what="this sentence reads the logged quotes and scores" />
        {decisionSummary(d)}
      </p>
      <JobRail stages={jobRail(d, steps)} labelled>
        <RowWord row={row} />
      </JobRail>
      <div className="decision-checks">
        <RecomputeBadge r={r} />
        <TubeCheckLine c={tube} />
      </div>
      {receipt && <TransactionReceipt logged={receipt} fallbackEpoch={d.epoch} q={q} sender={row.sender} loggedOk={d.outcome !== 'accept_failed'} />}
      <details className="technical">
        <summary className="label">Numbers and rule</summary>
        <Candidates d={d} palettes={data.palettes} q={q} />
        <p className="mono-s decision-rule">{ruleCaption(d.rule)}</p>
      </details>
      <details className="technical">
        <summary className="label">Steps and txs ({steps.length})</summary>
        <JobTimeline steps={steps} />
        <p className="mono-s decision-rule">In job order. Times are when each agent logged its step, after its tx returned, so they can run out of order.</p>
      </details>
      <details className="technical">
        <summary className="label">Technical</summary>
        <dl className="tech-list">
          <dt className="label">Task hash</dt>
          <dd className="mono">{d.task_hash ? shortHash(d.task_hash) : <Unavailable reason="The log line has no task hash." />}</dd>
          <dt className="label">Attempt</dt>
          <dd className="mono">{d.attempt ?? <Unavailable reason="The log line has no attempt." />}</dd>
          <dt className="label">Budget left</dt>
          <dd className="mono">{d.budget_left ? formatNear(d.budget_left) : <Unavailable reason="The agent logs this only when it read the budget and stopped." />}</dd>
          <dt className="label">Balance</dt>
          <dd className="mono">{d.balance ? formatNear(d.balance) : <Unavailable reason="The agent logs this only when it read the balance and stopped." />}</dd>
        </dl>
        {row.raw.map((l) => (
          <pre key={l.where} className="mono-s raw-line" aria-label={l.where}>{l.text}</pre>
        ))}
      </details>
    </div>
  );
}
