// The docket beside the stage (Design §6.H, Rogue): what the agent attempted
// (scripted) against what the contract decided, one row per try. The contract's
// words are verbatim; a stamp lands only on the tx's final outcome.
import { EXPLORER } from '../chain/rpc';
import { stepWords, type AttemptKey, type SceneAttempt, type SceneTry } from '../model/scene';
import { useReceipts } from '../state/activity';
import { formatNear, shortHash } from '../ui/format';
import { Tooltip } from '../ui/Tooltip';

export function Evidence({ tx, sender }: { tx: string; sender?: string }) {
  const store = useReceipts();
  const state = store?.stateOf(tx);
  const confirmed = state?.status === 'ok';
  return (
    <span className="lane-evidence">
      {confirmed ? (
        <Tooltip content="The app read this tx’s final outcome from the chain.">
          <span className="mono-s tone-growth">
            <span aria-hidden="true">✓</span> Confirmed on chain
          </span>
        </Tooltip>
      ) : (
        <Tooltip content="The agents’ log has this hash. The app has not read the transaction itself.">
          <span className="mono-s tone-muted">
            <span aria-hidden="true">○</span> Logged
          </span>
        </Tooltip>
      )}
      <a className="mono-s" href={`${EXPLORER}/${tx}`} target="_blank" rel="noreferrer" aria-label={`tx ${tx}, opens the explorer`}>
        {shortHash(tx)} ↗
      </a>
      {!confirmed && store && (
        <button type="button" className="lane-fetch mono-s" disabled={state?.status === 'loading'} onClick={() => store.fetch(tx, sender ?? null)}>
          {state?.status === 'loading' ? 'Fetching…' : state?.status === 'error' ? 'Retry' : 'Fetch'}
        </button>
      )}
    </span>
  );
}

function Decision({ t, sender }: { t: SceneTry; sender?: string }) {
  if (t.decision === 'pending') {
    return (
      <div className="lane lane-contract is-waiting">
        <span className="label tone-muted">Waiting for the final outcome…</span>
      </div>
    );
  }
  const refused = t.decision === 'refused';
  return (
    <div className="lane lane-contract">
      <span className={`stamp is-small ${refused ? 'is-refused' : 'is-allowed'}`}>
        <span aria-hidden="true">{refused ? '✕' : '✓'}</span> {refused ? 'Refused' : 'Allowed'}
      </span>
      {refused && <span className="mono-s lane-error">{t.err}</span>}
      {!refused && <span className="label lane-note">The price moved into escrow.</span>}
      {t.unexpected && (
        <span className="body tone-warn">
          The script expected {t.expected === 'ok' ? 'this to go through' : <span className="mono">{t.expected}</span>}.
        </span>
      )}
      {t.tx && <Evidence tx={t.tx} sender={sender} />}
    </div>
  );
}

function Attempt({ a, n, sender, future, onPoint }: { a: SceneAttempt; n: number; sender?: string; future: boolean; onPoint?: (k: AttemptKey | null) => void }) {
  const point = onPoint && { onMouseEnter: () => onPoint(a.key), onMouseLeave: () => onPoint(null), onFocus: () => onPoint(a.key), onBlur: () => onPoint(null) };
  return (
    <li className={`attempt${future ? ' is-future' : ''}`} {...point}>
      <div className="attempt-head">
        <span className="attempt-n mono-s" aria-hidden="true">{n}</span>
        <h3 className="heading">{a.title}</h3>
      </div>
      {a.tries.length === 0 && !future && <p className="body attempt-plan">{a.plan}</p>}
      {a.tries.map((t) => (
        <div key={t.id} className="attempt-row">
          <div className="lane lane-agent">
            <span className="body">
              {stepWords(t)}
              {t.amount && <> <span className="mono money">{formatNear(t.amount)}</span></>}
            </span>
          </div>
          <span className="lane-arrow" aria-hidden="true">→</span>
          <Decision t={t} sender={sender} />
        </div>
      ))}
    </li>
  );
}

export function SceneLanes({ attempts, sender, onPoint }: { attempts: SceneAttempt[]; sender?: string; /** Which attempt the visitor is on, so the stage can show its gate. */ onPoint?: (k: AttemptKey | null) => void }) {
  const lastActive = attempts.reduce((m, a, i) => (a.tries.length ? i : m), -1);
  return (
    <section className="lanes" aria-label="What the agent attempted and what the contract decided">
      <div className="lanes-key">
        <span className="label tone-agent">
          <span aria-hidden="true">◆</span> Agent attempted · <Tooltip content="There is no model here: a script holds the spore’s real agent key and tries to break each limit."><span className="lanes-scripted">scripted</span></Tooltip>
        </span>
        <span className="label">Contract decided</span>
      </div>
      <ol className="attempts">
        {attempts.map((a, i) => (
          <Attempt key={a.key} a={a} n={i + 1} sender={sender} future={lastActive >= 0 && a.tries.length === 0} onPoint={onPoint} />
        ))}
      </ol>
    </section>
  );
}
