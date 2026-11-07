// What every Demo Lab scene page shares: where you are in the lab, the bench with its
// transport, the proof's tabs, the checks and the preconditions. Each scene brings its
// own question, stage and docket.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { EXPLORER } from '../chain/rpc';
import type { SceneCheck } from '../model/scene';
import { listRecorded } from '../sources/recorded';
import { linkTo, sourceQuery } from '../sources/source';
import type { Playback } from '../state/scene';
import { useApp } from '../state/source';
import { Tooltip } from '../ui/Tooltip';
import { LoopVein, type VeinStop } from './LoopVein';

export const seconds = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

export const LAB_SCENES = [
  { id: 'loop', word: 'The whole loop', recorded: true },
  { id: 'rogue', word: 'Rogue agent', recorded: true },
  { id: 'sale', word: 'Sale', recorded: true },
  { id: 'wash', word: 'Wash trading', recorded: false },
] as const;
export type LabSceneId = (typeof LAB_SCENES)[number]['id'];

/**
 * Where each scene's link goes. On a recording you stay on recordings: a run's log only
 * tells its own scene, so a sibling link must never carry this run's name.
 */
export function useLabLinks(): Record<LabSceneId, string> {
  const { source } = useApp();
  const [recs, setRecs] = useState<Partial<Record<LabSceneId, string>>>({});
  const onRecording = source?.kind === 'recorded';
  useEffect(() => {
    if (!onRecording) return;
    let alive = true;
    listRecorded().then(
      (all) => {
        if (!alive) return;
        const next: Partial<Record<LabSceneId, string>> = {};
        const newest = [...all].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        for (const b of newest) {
          if (b.scene === 'loop' || b.scene === 'rogue' || b.scene === 'sale') next[b.scene] = sourceQuery({ kind: 'recorded', run: b.run, date: b.date });
        }
        setRecs(next);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [onRecording]);
  const to = (id: LabSceneId) => linkTo(`/lab/${id}`, recs[id] ?? '');
  return { loop: to('loop'), rogue: to('rogue'), sale: to('sale'), wash: to('wash') };
}

/** Where you are in the lab, and the way to the other scenes. */
export function SceneNav({ current, q, aside }: { current: LabSceneId; q: string; /** A secondary way to see this scene, at the row's far end. */ aside?: ReactNode }) {
  const links = useLabLinks();
  return (
    <nav className="scene-nav body" aria-label="Breadcrumb">
      <Link to={linkTo('/lab', q)}>Demo Lab</Link>
      <span aria-hidden="true">/</span>
      <ul className="scene-nav-list">
        {LAB_SCENES.map((s) => (
          <li key={s.id}>
            {s.id === current ? <span className="scene-nav-item is-on" aria-current="page">{s.word}</span> : <Link className="scene-nav-item" to={links[s.id]}>{s.word}</Link>}
          </li>
        ))}
      </ul>
      {aside && <span className="scene-nav-aside">{aside}</span>}
    </nav>
  );
}

/** The next scene, offered when this one is over. */
export function NextScene({ after }: { after: LabSceneId }) {
  const links = useLabLinks();
  const at = LAB_SCENES.findIndex((s) => s.id === after);
  const next = LAB_SCENES[at + 1];
  if (!next) return null;
  return <Link className="body scene-next" to={links[next.id]}>Next: {next.word} →</Link>;
}

export interface ProofTab {
  key: string;
  word: string;
  /** A count or a result, in mono beside the word. */
  count?: string;
  body: ReactNode;
}

/** The evidence under the bench, a tab at a time. Every panel stays in the page, hidden until asked for. */
export function ProofTabs({ tabs, opening }: { tabs: ProofTab[]; /** Which opens until someone picks. */ opening: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  const on = tabs.some((t) => t.key === picked) ? picked! : opening;
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = tabs[(tabs.findIndex((t) => t.key === on) + step + tabs.length) % tabs.length];
    setPicked(next.key);
    refs.current.get(next.key)?.focus();
  };
  return (
    <section className="scene-proof" aria-labelledby="proof-title">
      <div className="proof-head">
        <h2 className="title" id="proof-title">Check it yourself</h2>
        <div className="proof-tabs" role="tablist" aria-labelledby="proof-title" onKeyDown={onKey}>
          {tabs.map((t) => (
            <button
              key={t.key}
              ref={(el) => {
                if (el) refs.current.set(t.key, el);
                else refs.current.delete(t.key);
              }}
              type="button"
              role="tab"
              id={`proof-tab-${t.key}`}
              className={`proof-tab label${t.key === on ? ' is-on' : ''}`}
              aria-selected={t.key === on}
              aria-controls={`proof-panel-${t.key}`}
              tabIndex={t.key === on ? 0 : -1}
              onClick={() => setPicked(t.key)}
            >
              {t.word}{t.count && <span className="mono-s proof-count">{t.count}</span>}
            </button>
          ))}
        </div>
      </div>
      {tabs.map((t) => (
        <div key={t.key} role="tabpanel" id={`proof-panel-${t.key}`} aria-labelledby={`proof-tab-${t.key}`} className="proof-panel" hidden={t.key !== on}>
          {t.body}
        </div>
      ))}
    </section>
  );
}

/** A scene's acts on the same vein as the loop's stops. */
export function ActRail({ acts, act, over, onSeek, reducedMotion, tips }: { acts: { key: string; word: string }[]; act: string | null; over: boolean; onSeek?: (a: string) => void; reducedMotion: boolean; tips?: Record<string, string> }) {
  const at = act ? acts.findIndex((a) => a.key === act) : -1;
  const rows: VeinStop[] = acts.map((a, i) => ({ key: a.key, word: a.word, state: i < at || (over && i === at) ? 'past' : i === at ? 'now' : 'future' }));
  return (
    <div className={`scene-rail${over ? ' is-finished' : ''}`}>
      <LoopVein rows={rows} reducedMotion={reducedMotion} onSeek={onSeek} label="Acts of this scene" seekName={(w) => `Jump to: ${w}`} tips={tips} />
    </div>
  );
}

/** The question, the line being said, and the contract's own words under it. Room is kept for them, so nothing below jumps when a line is short. */
export function SceneHead({ question, line, quote }: { question: string; line: string; quote?: string | null }) {
  return (
    <header className="scene-head">
      <h1 className="scene-q">{question}</h1>
      <div className="scene-say">
        <p className="scene-narrator" aria-live="polite" key={line}>{line}</p>
        <p className="scene-quote mono tone-warn" aria-live="polite">{quote ?? ' '}</p>
      </div>
    </header>
  );
}

/** How a recording relates to what happened, next to the stage it governs. */
export function retold(length: { story: number; real: number }, pace: 'story' | 'real'): string | null {
  if (!length.real) return null;
  return pace === 'story' ? `Real transactions, retold in ${seconds(length.story)}. It took ${seconds(length.real)}.` : `Real transactions, at the pace they happened: ${seconds(length.real)}.`;
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
