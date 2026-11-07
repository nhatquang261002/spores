// The Network explorer's inspector (Design §6.C): with nothing selected, the
// epoch on screen (its one primary figure, how the close changed the tubes,
// the close's evidence, and the step feed); with a node, `SporeIdentity` and
// its tubes; with a tube, `NetworkEdgeDetails` (D now, D by epoch, flows by
// epoch, and per-job settlements when the source has the run log).
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EXPLORER } from '../chain/rpc';
import type { Selection } from '../graph/draw';
import { dSeries, flowSeries, pairKey, pairOf, tubesOf, type Frame, type FrameDiff, type NetworkHistory, type PairKey } from '../model/network';
import type { Step } from '../model/steps';
import type { StatusReading } from '../model/types';
import type { NetworkData } from '../sources/network';
import { formatNear, shortAccount, shortHash } from '../ui/format';
import { LoadingBar, Unavailable } from '../ui/states';
import { Tooltip } from '../ui/Tooltip';
import { ConductivityIndicator, formatD, ReputationIndicator, SporeRef } from './indicators';
import { SporeArtwork } from './SporeArtwork';
import { StateMarker } from './StateMarker';

export interface SporeFigures {
  balance: string;
  allowance: string;
  /** A run snapshot at this epoch, or `spore_summary` now. */
  from: 'snapshot' | 'summary';
}

const TUBES_FROM: Record<string, string> = {
  event: 'the close event (epoch_closed.tubes)',
  replay: 'the replay of every close since epoch 1 (core-wasm)',
  edges: 'the contract',
  snapshot: 'a reading of the contract taken after the close',
};

function sumYocto(flows: [number, number, string][]): string {
  return flows.reduce((a, [, , amt]) => a + BigInt(amt), 0n).toString();
}

function CloseEvidence({ frame, endWord }: { frame: Frame; endWord: string }) {
  const parts: ReactNode[] = [];
  if (frame.kind === 'closed') {
    if (frame.close)
      parts.push(
        <span key="c" className={frame.close.fetched ? 'evidence-ok' : undefined}>
          <span aria-hidden="true">{frame.close.fetched ? '✓' : '○'}</span> {frame.close.fetched ? 'Confirmed on chain' : 'Logged'} ·{' '}
          <a className="mono-s" href={`${EXPLORER}/${frame.close.tx}`} target="_blank" rel="noreferrer">
            close {shortHash(frame.close.tx)}
          </a>
        </span>,
      );
    else
      parts.push(
        <span key="c">
          close tx <Unavailable reason={`No close tx for epoch ${frame.epoch} in this source. Add it to docs/<router>-closes.txt or load a run that has it.`} />
        </span>,
      );
  } else {
    parts.push(<span key="c">{endWord === 'Live' ? 'in progress: flows settled so far' : 'the last epoch recorded'}</span>);
  }
  if (frame.replay === 'match')
    parts.push(
      <Tooltip key="r" content="core-wasm replayed every close from epoch 1 and got this close’s fingerprints (and its tubes, where the event lists them).">
        <span className="evidence-ok">↻ replay matches</span>
      </Tooltip>,
    );
  if (frame.replay === 'mismatch')
    parts.push(
      <span key="r" className="evidence-bad">
        <span aria-hidden="true">✕</span> replay mismatch
      </span>,
    );
  return <p className="body inspector-line">{parts.flatMap((p, i) => (i ? [' · ', p] : [p]))}</p>;
}

export function EpochSummary({
  data,
  frame,
  diff,
  endWord,
  rail,
  monitor,
  inForce = null,
}: {
  data: NetworkData;
  frame: Frame;
  /** While ▶︎ plays this epoch: the tubes on the map (in force until its close). The close's results wait for the close. */
  inForce?: Frame | null;
  diff: FrameDiff | null;
  endWord: string;
  rail: ReactNode;
  /** The step monitor (StepMonitor) for this epoch. */
  monitor: ReactNode;
}) {
  const c = data.closes;
  const head = frame.kind === 'live' ? `${endWord} · epoch ${frame.epoch}` : `Epoch ${frame.epoch}`;
  if (inForce)
    return (
      <>
        <p className="eyebrow">{head} · playing</p>
        <p className="inspector-primary">
          <span className="figure-l">{inForce.tubes ? inForce.tubes.size : <Unavailable reason={`No tube set for epoch ${inForce.epoch} in this source.`} />}</span>{' '}
          <span className="label">tubes in force until this close</span>
        </p>
        {rail}
        <h2 className="heading inspector-h">Steps</h2>
        {monitor}
      </>
    );
  return (
    <>
      <p className="eyebrow">{head}</p>
      <p className="inspector-primary">
        <span className="figure-l">{frame.tubes ? frame.tubes.size : <Unavailable reason={`No tube set for epoch ${frame.epoch} in this source.`} />}</span>{' '}
        <span className="label">tubes {frame.kind === 'live' ? 'now' : 'after the close'}</span>
      </p>
      <p className="body inspector-line">
        {frame.flows ? (
          <>
            <span className="mono">{frame.flows.length}</span> {frame.flowsFrom === 'run-log' ? 'paid pairs (agents’ log)' : 'flows'} ·{' '}
            <span className="mono value">{formatNear(sumYocto(frame.flows))}</span>
          </>
        ) : (
          <>
            flows <Unavailable reason={`Needs the close tx for epoch ${frame.epoch}: past flows are only in epoch_closed logs.`} />
          </>
        )}
        {frame.rejects && frame.rejects.length > 0 && (
          <>
            {' · '}
            <span className="tone-warn">
              <span aria-hidden="true">✕</span> {frame.rejects.reduce((a, r) => a + r[2], 0)} rejected
            </span>
          </>
        )}
      </p>
      {diff && (
        <p className="body inspector-line">
          <span className="tone-growth">{diff.counts.new} new</span> · <span className="tone-growth">{diff.counts.grew} grew</span> · {diff.counts.decayed} decayed ·{' '}
          {diff.counts.dropped} dropped <span className="mono-s unavailable">at {frame.kind === 'live' ? 'the last' : 'this'} close</span>
        </p>
      )}
      {frame.flowsFrom === 'run-log' && (
        <p className="mono-s inspector-note">
          Paid pairs come from the settlements in the agents’ log, placed by log time; a settle logged next to a close can count in the other epoch on chain.
        </p>
      )}
      <CloseEvidence frame={frame} endWord={endWord} />
      {frame.tubesFrom && <p className="mono-s inspector-note">tubes from {TUBES_FROM[frame.tubesFrom]}</p>}
      {frame.kind === 'live' && data.edgesCheck && (
        <p className={`mono-s inspector-note ${data.edgesCheck === 'match' ? 'evidence-ok' : 'evidence-bad'}`}>
          {data.edgesCheck === 'match' ? '↻ replaying every close reproduces these tubes' : '✕ replaying the closes does not reproduce these tubes'}
        </p>
      )}
      {c.listUrl && c.loaded < c.listed && !c.error && (
        <p className="mono-s inspector-note" role="status">
          Reading close history {c.loaded} / {c.listed} <LoadingBar ch={6} label="Reading close history" />
        </p>
      )}
      {c.error && (
        <p className="mono-s inspector-note evidence-bad" role="alert">
          ✕ {c.listed ? `${c.listed - c.loaded} of ${c.listed} closes could not be read` : 'the close history could not be read'}: <span className="mono">{c.error.message}</span>
        </p>
      )}
      {data.steps === null && !c.listUrl && c.listed === 0 && (
        <p className="mono-s inspector-note">No close list for this contract, so past epochs are hollow.</p>
      )}
      {rail}
      <h2 className="heading inspector-h">Steps</h2>
      {monitor}
    </>
  );
}

export function NodeDetails({
  id,
  frame,
  history,
  seed,
  age,
  owner,
  reading,
  figures,
  figuresState,
  dMax,
  onSelect,
  sporeHref,
  liveTubes,
}: {
  id: number;
  frame: Frame;
  history: NetworkHistory;
  seed: string | null;
  age: number | null;
  owner: string | null;
  reading: StatusReading;
  figures: SporeFigures | null;
  figuresState: 'loading' | 'error' | 'none' | 'ok';
  dMax: number;
  onSelect: (s: Selection) => void;
  sporeHref: string;
  /** The current tubes, for the art (the art is the spore's state now). */
  liveTubes: [number, string][];
}) {
  const tubes = tubesOf(frame.tubes, id);
  const r = frame.reputation?.get(id) ?? null;
  const fig = (v: string | undefined, what: string) =>
    figuresState === 'loading' ? (
      <LoadingBar ch={7} label={`Reading ${what}`} />
    ) : v ? (
      <span className="mono value">{formatNear(v)}</span>
    ) : (
      <Unavailable reason={figuresState === 'error' ? `Could not read Spore #${id} from the contract.` : `This source has no ${what} for Spore #${id} at this epoch.`} />
    );
  return (
    <>
      <div className="spore-identity">
        {seed && age !== null ? <SporeArtwork organism={{ id, seed, age, tubes: liveTubes }} variant="thumb" priority={0} /> : <div className="identity-blank" aria-hidden="true" />}
        <div className="identity-text">
          <h2 className="display-m">Spore #{id}</h2>
          <StateMarker reading={reading} />
          {owner && (
            <p className="mono-s identity-owner">
              <Tooltip content={owner}>{shortAccount(owner)}</Tooltip>
            </p>
          )}
        </div>
      </div>
      {frame.kind === 'closed' && <p className="mono-s inspector-note">The art is the spore now; the map shows epoch {frame.epoch}.</p>}
      <p className="body inspector-line">
        <ReputationIndicator r={r} note={frame.kind === 'live' ? 'Computed by the contract at read time.' : 'After this epoch’s close.'} /> · <span className="mono">{tubes.length}</span> tube
        {tubes.length === 1 ? '' : 's'}
      </p>
      <p className="body inspector-line">
        balance {fig(figures?.balance, 'balance')} · allowance {fig(figures?.allowance, 'allowance')}
        {figures?.from === 'summary' && <span className="mono-s unavailable"> now</span>}
      </p>
      <h3 className="heading inspector-h">Tubes</h3>
      {tubes.length === 0 ? (
        <p className="body feed-empty">{frame.tubes ? 'No tubes at this epoch.' : 'This source has no tube set for this epoch.'}</p>
      ) : (
        <ul className="tube-list">
          {tubes.map((t) => (
            <li key={t.partner}>
              <button type="button" className="tube-row" onClick={() => onSelect({ kind: 'tube', k: pairKey(id, t.partner) })} aria-label={`Tube #${id} to #${t.partner}, D ${formatD(t.d)}`}>
                <span className="mono">#{t.partner}</span>
                <ConductivityIndicator d={t.d} dMax={dMax} dMin={history.dMin} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Link className="btn btn-secondary inspector-open" to={sporeHref}>
        Open Spore #{id}
      </Link>
    </>
  );
}

/** D by epoch as a sparkline with gaps where the source has no tubes; the epoch on screen is marked. */
export function Sparkline({ series, at, dMax }: { series: { epoch: number; d: number | null }[]; at: number; dMax: number }) {
  const W = 300;
  const H = 48;
  if (!series.length) return null;
  const n = series.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * (W - 8) + 4);
  const y = (d: number) => H - 4 - (dMax > 0 ? Math.min(1, d / dMax) : 0) * (H - 8);
  const runs: string[] = [];
  let cur = '';
  series.forEach((p, i) => {
    if (p.d === null) {
      if (cur) runs.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.d).toFixed(1)}`;
  });
  if (cur) runs.push(cur);
  const ai = series.findIndex((p) => p.epoch === at);
  const known = series.filter((p) => p.d !== null);
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`D by epoch, ${known.length} of ${n} epochs known: ${known.map((p) => `E${p.epoch} ${formatD(p.d!)}`).join(', ')}`}
    >
      <line x1="0" x2={W} y1={H - 4} y2={H - 4} className="spark-base" />
      {runs.map((d, i) => (
        <path key={i} d={d} className="spark-line" />
      ))}
      {series.map((p, i) => (p.d === null ? <circle key={p.epoch} cx={x(i)} cy={H - 4} r="1.5" className="spark-gap" /> : null))}
      {ai >= 0 && <line x1={x(ai)} x2={x(ai)} y1="2" y2={H - 2} className="spark-at" />}
    </svg>
  );
}

export function NetworkEdgeDetails({
  k,
  frame,
  history,
  steps,
  palettes,
  dMax,
  onSelect,
  onEpoch,
}: {
  k: PairKey;
  frame: Frame;
  history: NetworkHistory;
  steps: Step[] | null;
  palettes: Map<number, number>;
  dMax: number;
  onSelect: (s: Selection) => void;
  onEpoch: (e: number) => void;
}) {
  const [a, b] = pairOf(k);
  const d = frame.tubes?.get(k);
  const flows = flowSeries(history, k);
  const settles = (steps ?? []).filter((s) => s.kind === 'settle' && s.from !== null && s.to !== null && pairKey(s.from, s.to) === k);
  return (
    <>
      <h2 className="title edge-title">
        <SporeRef id={a} palette={palettes.get(a) ?? null} onClick={() => onSelect({ kind: 'node', id: a })} /> <span aria-hidden="true">↔</span>
        <span className="sr-only">and</span> <SporeRef id={b} palette={palettes.get(b) ?? null} onClick={() => onSelect({ kind: 'node', id: b })} />
      </h2>
      <p className="inspector-primary">
        {d !== undefined ? (
          <>
            <span className="figure">D {formatD(d)}</span> <span className="label">{frame.kind === 'live' ? 'now' : `after epoch ${frame.epoch}`}</span>
          </>
        ) : (
          <span className="body">{frame.tubes ? `No tube at epoch ${frame.epoch}: under d_min (${formatD(history.dMin)}) or never formed.` : 'This source has no tube set for this epoch.'}</span>
        )}
      </p>
      <Sparkline series={dSeries(history, k)} at={frame.kind === 'live' ? history.current - 1 : frame.epoch} dMax={dMax} />
      <h3 className="heading inspector-h">Flows by epoch</h3>
      {flows.length === 0 ? (
        <p className="body feed-empty">
          No flows between #{a} and #{b} in the epochs this source has.
        </p>
      ) : (
        <table className="flows-table">
          <thead>
            <tr>
              <th className="label">Epoch</th>
              <th className="label">Amount</th>
            </tr>
          </thead>
          <tbody>
            {flows.map((f) => (
              <tr key={`${f.epoch}${f.live ? 'l' : ''}`}>
                <td>
                  <button type="button" className="link-button mono" onClick={() => onEpoch(f.epoch)}>
                    E {f.epoch}
                    {f.live ? ' (so far)' : ''}
                  </button>
                </td>
                <td className="mono value">{formatNear(f.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="heading inspector-h">Settlements</h3>
      {steps === null ? (
        <p className="body feed-empty">Per-job receipts are in the agents’ log. On chain: per-epoch flows only.</p>
      ) : settles.length === 0 ? (
        <p className="body feed-empty">
          The agents’ log has no settled job between #{a} and #{b}.
        </p>
      ) : (
        <ul className="settle-list">
          {settles.map((s) => (
            <li key={s.tx ?? `${s.at}`} className="body">
              <span className="mono">E {s.epoch}</span> · <span className="mono">#{s.from}</span> → <span className="mono">#{s.to}</span>{' '}
              {s.amount && <span className="mono value">{formatNear(s.amount)}</span>}
              {s.job !== undefined && <span className="mono-s"> · job {s.job}</span>}{' '}
              {s.tx && (
                <a className="mono-s" href={`${EXPLORER}/${s.tx}`} target="_blank" rel="noreferrer">
                  ○ {shortHash(s.tx)}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
