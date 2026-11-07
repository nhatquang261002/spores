// What every Demo Lab scene page shares: the act rail, the pace switch, the
// checks, the preconditions and the step timeline's rows. Each scene brings its
// own question, stage and docket.
import { EXPLORER } from '../chain/rpc';
import type { JobStep } from '../model/activity';
import type { SceneCheck, SceneStep } from '../model/scene';
import type { Playback } from '../state/scene';
import { Tooltip } from '../ui/Tooltip';

export const seconds = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

export function ActRail({ acts, act, over, onSeek }: { acts: { key: string; word: string }[]; act: string | null; over: boolean; onSeek?: (a: string) => void }) {
  const at = act ? acts.findIndex((a) => a.key === act) : -1;
  const share = over ? 1 : at < 0 ? 0 : at / (acts.length - 1);
  return (
    <ol className="act-rail" aria-label="Acts of this scene" style={{ '--rail-share': share, '--acts': acts.length } as React.CSSProperties}>
      {acts.map((a, i) => {
        const state = i < at || (over && i === at) ? 'is-past' : i === at ? 'is-now' : '';
        const word = <span className="label">{a.word}</span>;
        return (
          <li key={a.key} className={`act ${state}`} aria-current={i === at && !over ? 'step' : undefined}>
            {onSeek ? (
              <button type="button" className="act-btn" onClick={() => onSeek(a.key)} aria-label={`Jump to: ${a.word}`}>
                <span className="act-dot" key={state} aria-hidden="true" />
                {word}
              </button>
            ) : (
              <span className="act-btn">
                <span className="act-dot" key={state} aria-hidden="true" />
                {word}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function PaceSwitch({ playback }: { playback: Pick<Playback<unknown>, 'pace' | 'setPace' | 'length'> }) {
  return (
    <span className="pace" role="group" aria-label="Playback speed">
      <Tooltip content={`Waits are shortened to ${seconds(playback.length.story)}. Every row keeps its real time.`}>
        <button type="button" className={`pace-btn label${playback.pace === 'story' ? ' is-on' : ''}`} aria-pressed={playback.pace === 'story'} onClick={() => playback.setPace('story')}>Story pace</button>
      </Tooltip>
      <Tooltip content={`As it happened: ${seconds(playback.length.real)}.`}>
        <button type="button" className={`pace-btn label${playback.pace === 'real' ? ' is-on' : ''}`} aria-pressed={playback.pace === 'real'} onClick={() => playback.setPace('real')}>Real time</button>
      </Tooltip>
    </span>
  );
}

/** Who did it, unless the action already says. */
function stepLabel(actor: string, action: string): string {
  const who = actor === 'keeper' ? 'anyone' : actor;
  return action.toLowerCase().includes(who) ? action : `${who} · ${action}`;
}

export function timelineSteps(steps: SceneStep[]): JobStep[] {
  return steps.map((s) => ({
    key: s.id,
    label: stepLabel(s.actor, s.action),
    state: s.state === 'pending' ? 'pending' : s.state === 'ok' ? 'ok' : 'failed',
    at: Date.parse(s.at),
    tx: s.tx && !s.tx.endsWith(')') ? s.tx : undefined,
    amount: s.amount,
    err: s.err,
    note: s.expected === 'ok' ? undefined : `expected: ${s.expected}`,
  }));
}

export function Checks({ checks }: { checks: SceneCheck[] }) {
  if (!checks.length) return <p className="body">Checks are reported as the run reaches them.</p>;
  return (
    <ol className="scene-checks">
      {checks.map((c) => (
        <li key={c.n} className="scene-check">
          <span className={c.ok ? 'tone-growth' : 'tone-warn'} aria-hidden="true">{c.ok ? '✓' : '✕'}</span>
          <span className="body">{c.name}<span className="sr-only">{c.ok ? ': passed' : ': failed'}</span></span>
          {!c.ok && <span className="mono-s tone-warn check-why">expected {c.expected}, got {c.actual}</span>}
          {c.tx && !c.tx.endsWith(')') && <a className="mono-s" href={`${EXPLORER}/${c.tx}`} target="_blank" rel="noreferrer" aria-label={`Check ${c.n} tx ${c.tx}, opens the explorer`}>tx ↗</a>}
        </li>
      ))}
    </ol>
  );
}

export function Preconditions({ list, epochOk, epochKnown }: { list: { key: string; label: string; ok: boolean; detail?: string }[]; epochOk: boolean; epochKnown: boolean }) {
  const rows = [
    { key: 'router', label: 'Contract reachable', ok: epochOk, detail: epochKnown ? undefined : 'Reading the contract…' },
    ...list,
  ];
  return (
    <ul className="preconditions">
      {rows.map((p) => (
        <li key={p.key}>
          <span className={p.ok ? 'tone-growth' : 'tone-warn'} aria-hidden="true">{p.ok ? '✓' : '✕'}</span>
          <span className="body">{p.label}<span className="sr-only">{p.ok ? ': yes' : ': no'}</span></span>
          {!p.ok && p.detail && <span className="mono-s precondition-why">{p.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
