// `TransactionReceipt` (Design §6.G): one layout for every kind, the evidence
// level first (§4.3). `✓ Confirmed on chain` only after the app read the final
// outcome; a hash from a run log is `○ Logged` with a Fetch action, and what
// only the tx can say is `—` with the reason.
import { Link } from 'react-router';
import { EXPLORER } from '../chain/rpc';
import type { Receipt } from '../model/receipts';
import { linkTo } from '../sources/source';
import { useReceipts } from '../state/activity';
import { formatNear, shortAccount, shortHash } from '../ui/format';
import { ErrorState, Unavailable } from '../ui/states';
import { Tooltip } from '../ui/Tooltip';

const FETCH_REASON = 'Only the tx says this. Fetch reads its final outcome.';

function Near({ y }: { y: string }) {
  return (
    <Tooltip content={<span className="mono">{y} yocto</span>}>
      <span className="mono money">{formatNear(y)}</span>
    </Tooltip>
  );
}

function FullHash({ h }: { h: string }) {
  return (
    <Tooltip content={<span className="mono">{h}</span>}>
      <span className="mono">{shortHash(h)}</span>
    </Tooltip>
  );
}

function Amount({ y, logged }: { y?: string; logged: boolean }) {
  if (y) return <Near y={y} />;
  return <Unavailable reason={logged ? FETCH_REASON : 'The contract logged no amount for this.'} />;
}

function Tube({ a, b, q, epoch }: { a: number; b: number; q: string; epoch: number | null }) {
  const [x, y] = a < b ? [a, b] : [b, a];
  return (
    <Link className="mono-s receipt-tube" to={linkTo('/network', q, { ...(epoch !== null ? { epoch } : {}), sel: `${x}-${y}` })}>
      tube #{x}–#{y} →
    </Link>
  );
}

function Body({ r, q, epoch }: { r: Receipt; q: string; epoch: number | null }) {
  const logged = r.evidence === 'logged';
  switch (r.kind) {
    case 'settlement':
      return (
        <>
          <span className="mono">{r.from !== null && r.to !== null ? `#${r.from} → #${r.to}` : <Unavailable reason={FETCH_REASON} />}</span>
          <Amount y={r.amount} logged={logged} />
          <span className="mono">fee {r.fee ? <Near y={r.fee} /> : <Unavailable reason={FETCH_REASON} />}</span>
          {r.auto && <span className="body receipt-note">Paid at the deadline: the consumer didn’t settle. It counts as no flow, so no tube grows from it.</span>}
          {r.from !== null && r.to !== null && <Tube a={r.from} b={r.to} q={q} epoch={epoch} />}
        </>
      );
    case 'refund':
      return (
        <>
          <span className="mono">{r.from !== null ? `refund to #${r.from}` : <Unavailable reason={FETCH_REASON} />}</span>
          <Amount y={r.amount} logged={logged} />
          <span className="body">reason <span className="mono">{r.reason ?? '—'}</span></span>
          {r.from !== null && r.to !== null && <Tube a={r.from} b={r.to} q={q} epoch={epoch} />}
        </>
      );
    case 'service':
      return (
        <>
          <span className="mono">#{r.from} → {r.payee ? shortAccount(r.payee) : '—'}</span>
          <Amount y={r.amount} logged={logged} />
        </>
      );
    case 'sale':
      return (
        <>
          <span className="mono">{r.spore !== undefined ? `#${r.spore} ` : ''}{r.seller ? shortAccount(r.seller) : '—'} → {r.buyer ? shortAccount(r.buyer) : '—'}</span>
          <Amount y={r.amount} logged={logged} />
          <span className="mono">seller {r.sellerAmount ? <Near y={r.sellerAmount} /> : <Unavailable reason={FETCH_REASON} />}</span>
          <span className="mono">royalty {r.royalty ? <Near y={r.royalty} /> : <Unavailable reason={FETCH_REASON} />}</span>
        </>
      );
    case 'market':
      return (
        <>
          <span className="mono">{r.spore !== undefined ? `#${r.spore}` : ''}{r.seller ? ` · ${shortAccount(r.seller)}` : ''}</span>
          {r.amount && <Near y={r.amount} />}
        </>
      );
    case 'refusal':
      return (
        <>
          <span className="body">Refused by the contract:</span>
          <span className="mono tone-warn">{r.error}</span>
          {!logged && <span className="body">No amounts moved.</span>}
        </>
      );
    case 'failed':
      return (
        <>
          <span className="body">The tx failed:</span>
          <span className="mono tone-warn">{r.error}</span>
        </>
      );
    case 'close':
      return (
        <>
          <span className="mono">fingerprint {r.fingerprint ? <FullHash h={r.fingerprint} /> : <Unavailable reason={FETCH_REASON} />}</span>
          <span className="mono">
            {r.flowsDerived && <Derived what="counted from this log’s settle txs by their time" />}
            {r.flows ?? '—'} {r.flows === 1 ? 'flow' : 'flows'}
          </span>
          {r.rejects !== undefined && <span className="mono">{r.rejects} rejected</span>}
          <span className="mono">{r.tubes ?? <Unavailable reason="This source has no tube count for this close." />} {r.tubes === 1 ? 'tube' : 'tubes'}</span>
          {r.pool && <span className="mono">pool <Near y={r.pool} /></span>}
          {r.treasury && <span className="mono">treasury <Near y={r.treasury} /></span>}
          {epoch !== null && (
            <Link className="mono-s" to={linkTo('/verify', q, { epoch })}>
              Verify →
            </Link>
          )}
        </>
      );
    case 'image':
      return (
        <>
          <span className="mono">#{r.spore} · epoch {r.epoch ?? '—'}</span>
          {r.imageHash && <span className="mono">image <FullHash h={r.imageHash} /></span>}
          {r.stateHash && <span className="mono">state <FullHash h={r.stateHash} /></span>}
          {r.rendererVersion !== undefined && <span className="mono">renderer v{r.rendererVersion}</span>}
          {r.spore !== undefined && (
            <Link className="mono-s" to={linkTo('/verify', q, { spore: r.spore })}>
              Verify →
            </Link>
          )}
        </>
      );
    default:
      return <span className="mono">{r.event}</span>;
  }
}

/** The `≈` mark (Design §4.2). */
export function Derived({ what }: { what: string }) {
  return (
    <Tooltip content={`Derived in your browser: ${what}.`}>
      <span className="derived" aria-label="derived">≈ </span>
    </Tooltip>
  );
}

export function TransactionReceipt({ logged, fallbackEpoch, q, sender, loggedOk }: { logged: Receipt; fallbackEpoch: number | null; q: string; sender?: string | null; loggedOk?: boolean }) {
  const store = useReceipts();
  const state = logged.tx && logged.evidence === 'logged' && store ? store.stateOf(logged.tx) : { status: 'idle' as const };
  const r = state.status === 'ok' ? state.receipt : logged;
  const confirmed = r.evidence === 'confirmed';
  const exact = r.epoch !== null;
  const epoch = r.epoch ?? fallbackEpoch;
  const chainFailed = r.kind === 'refusal' || r.kind === 'failed';
  const disagrees = confirmed && loggedOk !== undefined && loggedOk === chainFailed;
  return (
    <section className={`receipt${chainFailed ? ' is-refusal' : ''}`} aria-label={`Receipt ${r.tx}`}>
      <div className="receipt-line">
        {confirmed ? (
          <span className="receipt-evidence tone-growth">
            <span aria-hidden="true">✓</span> Confirmed on chain
          </span>
        ) : (
          <span className="receipt-evidence">
            <span aria-hidden="true">○</span> Logged
          </span>
        )}
        <span className="mono-s">{r.event}</span>
        {epoch !== null && (
          <Link className="mono-s receipt-epoch" to={linkTo('/network', q, { epoch })}>
            {!exact && <span className="derived" aria-label="derived from log timing">≈ </span>}Epoch {epoch}
          </Link>
        )}
      </div>
      <div className="receipt-line">
        <Body r={r} q={q} epoch={epoch} />
      </div>
      {r.warnings?.map((w) => (
        <p key={w} className="mono tone-warn">{w}</p>
      ))}
      {disagrees && <p className="body tone-warn">The log and the chain disagree: the log says this tx {loggedOk ? 'succeeded' : 'failed'}. The chain’s outcome is the one shown.</p>}
      {r.tx && (
        <div className="receipt-line receipt-meta">
          <a className="mono-s" href={`${EXPLORER}/${r.tx}`} target="_blank" rel="noreferrer" aria-label={`tx ${r.tx}, opens the explorer`}>
            tx {shortHash(r.tx)} ↗
          </a>
          {r.block && (
            <Tooltip content={<span className="mono">{r.block.hash}</span>}>
              <span className="mono-s">block {r.block.height ?? shortHash(r.block.hash)}</span>
            </Tooltip>
          )}
          {r.signer && <span className="mono-s">signer {shortAccount(r.signer)}</span>}
          {!confirmed && store && (
            <button type="button" className="btn btn-secondary receipt-fetch" disabled={state.status === 'loading'} onClick={() => store.fetch(r.tx, sender ?? null)}>
              {state.status === 'loading' ? 'Fetching…' : 'Fetch'}
            </button>
          )}
        </div>
      )}
      {state.status === 'error' && <ErrorState error={state.error} what={`tx ${shortHash(r.tx)}`} onRetry={() => store?.fetch(r.tx, sender ?? null)} />}
    </section>
  );
}
