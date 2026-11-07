// Every step of a run, grouped by the act it belongs to. One row per transaction: when,
// who, what, and what the chain said. A row opens to what was expected against what came
// back, with the tx and how far the app has checked it. Refusals can be picked out, and
// they say so in the row, because they are what the page is about.
import { useState } from 'react';
import { actorWord, stepWords, type SceneStep } from '../model/scene';
import { formatClock, formatNear } from '../ui/format';
import { Tooltip } from '../ui/Tooltip';
import { Evidence } from './SceneLanes';

function outcome(s: SceneStep): { glyph: string; word: string; tone: string } {
  if (s.state === 'pending') return { glyph: '○', word: 'Waiting', tone: 'muted' };
  if (s.state === 'failed') return s.expected === 'ok' ? { glyph: '✕', word: 'Failed', tone: 'warn' } : { glyph: '✕', word: 'Refused', tone: 'warn' };
  return { glyph: '✓', word: 'Done', tone: 'growth' };
}

function Step({ s, sender }: { s: SceneStep; sender?: string }) {
  const o = outcome(s);
  const who = actorWord(s.actor);
  const asExpected = s.expected === 'ok' ? s.state !== 'failed' : s.err === s.expected;
  const tx = s.tx && !s.tx.endsWith(')') ? s.tx : null;
  return (
    <li className={`step is-${s.state}`}>
      <details className="step-details">
        <summary className="step-row">
          <span className="mono-s step-time">{formatClock(Date.parse(s.at))}</span>
          <span className={`label step-who${s.actor === 'agent' || s.actor === 'new agent' ? ' tone-agent' : ''}`}>{who}</span>
          <span className="step-what">
            <span className="body">{stepWords(s)}</span>
            {s.amount && <> <span className="mono money">{formatNear(s.amount)}</span></>}
            {s.err && <span className="mono-s tone-warn step-err">{s.err}</span>}
          </span>
          <span className={`label step-out tone-${o.tone}`}><span aria-hidden="true">{o.glyph} </span>{o.word}</span>
          <span className="step-open" aria-hidden="true">›</span>
        </summary>
        <dl className="step-body">
          <dt className="label">Expected</dt>
          <dd className="mono-s">{s.expected === 'ok' ? 'goes through' : s.expected}</dd>
          <dt className="label">Chain said</dt>
          <dd className={`mono-s${asExpected ? '' : ' tone-warn'}`}>
            {s.state === 'pending' ? 'not yet' : s.err ?? 'went through'}
            {!asExpected && s.state !== 'pending' && ' (not what the script expected)'}
          </dd>
          <dt className="label">Transaction</dt>
          <dd>{tx ? <Evidence tx={tx} sender={sender} /> : <span className="mono-s tone-muted">— no tx in the log for this step</span>}</dd>
        </dl>
      </details>
    </li>
  );
}

export function SceneSteps({ steps, acts, sender }: { steps: SceneStep[]; acts: { key: string; word: string }[]; sender?: string }) {
  const [only, setOnly] = useState(false);
  const refused = steps.filter((s) => s.state === 'failed').length;
  if (!steps.length) return <p className="body">Each transaction lands here with its time, what was expected and what the chain said.</p>;
  const shown = only ? steps.filter((s) => s.state === 'failed') : steps;
  // In the order they happened: an act can only open once.
  const groups: { key: string; word: string; steps: SceneStep[] }[] = [];
  for (const s of shown) {
    const last = groups.at(-1);
    if (last?.key === s.act) last.steps.push(s);
    else groups.push({ key: s.act, word: acts.find((a) => a.key === s.act)?.word ?? 'Setting up', steps: [s] });
  }
  return (
    <div className="steps">
      <div className="steps-filter" role="group" aria-label="Which steps to show">
        <button type="button" className={`pace-btn label${only ? '' : ' is-on'}`} aria-pressed={!only} onClick={() => setOnly(false)}>All <span className="mono-s">{steps.length}</span></button>
        <Tooltip content={refused ? 'Only the steps the chain turned down.' : 'Nothing has been turned down so far.'} focusable={false}>
          <button type="button" className={`pace-btn label${only ? ' is-on' : ''}`} aria-pressed={only} disabled={!refused} onClick={() => setOnly(true)}>Refused <span className="mono-s">{refused}</span></button>
        </Tooltip>
      </div>
      {groups.map((g, i) => (
        <section key={`${g.key}-${i}`} className="step-group" aria-label={g.word}>
          <h3 className="label step-group-head">{g.word}</h3>
          <ol className="step-list">
            {g.steps.map((s) => <Step key={s.id} s={s} sender={sender} />)}
          </ol>
        </section>
      ))}
    </div>
  );
}
