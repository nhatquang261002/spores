// Demo Lab index (Design §6.H, §13 item 25): where to start, then one claim at a time.
// Each scene says what it runs on now, and a card goes straight to what it says it is.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { saleDelay } from '../model/sale';
import { durationMs, parseSceneLog, type StoryDelay } from '../model/scene';
import { LOOP_ACTS } from '../model/loop';
import { linkTo, sourceQuery } from '../sources/source';
import { latestRecording, SceneClient, type ServerScene } from '../sources/scene';
import { recordedFiles, type RecordedBundle } from '../sources/recorded';
import { useLoopRecording } from '../state/loop';
import { useApp } from '../state/source';
import { PageHeader } from './Pages';
import '../components/activity.css';
import '../components/detail.css';
import '../components/lab.css';

type Mode = 'live' | 'recorded' | 'simulation' | 'unavailable';

const CHIP: Record<Mode, string> = {
  live: 'LIVE testnet',
  recorded: 'RECORDED',
  simulation: 'SIMULATION',
  unavailable: 'Unavailable',
};

/** A sketch of the mechanism, not an illustration: the same parts as the stage. */
function Sketch({ kind }: { kind: 'loop' | 'rogue' | 'sale' | 'wash' | 'none' }) {
  return (
    <svg className={`sketch sketch-${kind}`} viewBox="0 0 96 96" aria-hidden="true">
      <circle className="sk-dish" cx="48" cy="48" r="46" />
      {kind === 'loop' && (
        <>
          <path className="sk-wall" d="M48 22 A26 26 0 1 1 26 34" />
          <path className="sk-wall" d="M26 34 l-2 -9 M26 34 l9 -2" />
          <circle className="sk-bead" cx="72" cy="56" r="5" />
          <circle className="sk-core" cx="48" cy="48" r="7" />
        </>
      )}
      {kind === 'rogue' && (
        <>
          <circle className="sk-wall" cx="48" cy="48" r="27" />
          <path className="sk-pod" d="M48 48 C56 46 64 40 67 30" />
          <path className="sk-x" d="M63 22 l10 10 M73 22 l-10 10" />
          <circle className="sk-core" cx="48" cy="48" r="6" />
        </>
      )}
      {kind === 'sale' && (
        <>
          <path className="sk-tube" d="M48 40 C44 28 36 22 26 18 M48 40 C56 28 62 22 72 20" />
          <circle className="sk-core" cx="48" cy="40" r="6" />
          <path className="sk-pod" d="M12 74 C20 64 34 58 42 46" strokeDasharray="4 5" />
          <path className="sk-x" d="M21 57 l7 7 M28 57 l-7 7" />
          <path className="sk-pod" d="M84 74 C76 64 62 58 54 46" />
          <rect className="sk-label" x="30" y="70" width="36" height="13" rx="2" transform="rotate(-3 48 76)" />
        </>
      )}
      {kind === 'wash' && (
        <>
          <path className="sk-loop" d="M28 44 C34 22 62 22 68 44 C62 66 34 66 28 44 Z" />
          <circle className="sk-core" cx="28" cy="44" r="6" />
          <circle className="sk-core" cx="68" cy="44" r="6" />
          <circle className="sk-bead" cx="48" cy="28" r="4" />
          <path className="sk-money" d="M48 68 v4 M48 77 v5" />
        </>
      )}
      {kind === 'none' && <circle className="sk-empty" cx="48" cy="48" r="27" />}
    </svg>
  );
}

function SceneCard({ kind, title, question, claim, mode, meta, to, action, wide, children }: { kind: 'loop' | 'rogue' | 'sale' | 'wash'; title: string; question: string; claim: ReactNode; mode: Mode; meta?: ReactNode; to: string; action: string; wide?: boolean; children?: ReactNode }) {
  return (
    <li className={`scene-card${wide ? ' is-wide' : ''}`}>
      <Link className="scene-card-link" to={to}>
        <Sketch kind={kind} />
        <div className="scene-card-body">
          <span className={`mode-chip mode-${mode} label`}>{CHIP[mode]}</span>
          <h2 className={wide ? 'display-s' : 'title'}>{title}</h2>
          <p className="scene-card-q body">{question}</p>
          <p className="body scene-card-claim">{claim}</p>
          {children}
          <span className="scene-card-foot">
            <span className={`scene-card-go btn ${wide ? 'btn-primary' : 'btn-secondary'}`}>{action}</span>
            {meta && <span className="mono-s scene-card-meta">{meta}</span>}
          </span>
        </div>
      </Link>
    </li>
  );
}

/** Not built, and it says so: no run button, no mock, one way on. */
function UnbuiltCard({ to }: { to: string }) {
  return (
    <li className="scene-card is-off">
      <Sketch kind="none" />
      <div className="scene-card-body">
        <span className="mode-chip mode-unavailable label">{CHIP.unavailable}</span>
        <h2 className="title">Prompt injection against a naive agent</h2>
        <p className="body scene-card-claim">Not built. No LLM agent exists in this project, so there is nothing honest to show. What the contract enforces regardless of what an agent is told is shown in <em>Rogue agent</em>.</p>
        <Link className="body" to={to}>Go to Rogue agent →</Link>
      </div>
    </li>
  );
}

const secs = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** The server's word on a scene, and its newest recording's length. */
function useSceneFacts(client: SceneClient, id: string, delay?: StoryDelay) {
  /** undefined while the first answer is out: a slow answer isn't a server that's down. */
  const [server, setServer] = useState<ServerScene | null | undefined>(undefined);
  const [recording, setRecording] = useState<RecordedBundle | null>(null);
  const [lengths, setLengths] = useState<{ story: number; real: number } | null>(null);
  useEffect(() => {
    let alive = true;
    client.list().then(
      (all) => alive && setServer(all.find((s) => s.id === id) ?? null),
      () => alive && setServer(null),
    );
    latestRecording(id).then(
      async (b) => {
        if (!alive || !b) return;
        setRecording(b);
        const lines = parseSceneLog(await recordedFiles(b.run).text('scene.jsonl'));
        if (alive) setLengths({ story: durationMs(lines, 'story', delay), real: durationMs(lines, 'real', delay) });
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [client, id, delay]);
  const ready = server?.preconditions.filter((p) => p.ok).length ?? 0;
  const total = server?.preconditions.length ?? 0;
  return { server, recording, lengths, ready, total };
}

function FactsLine({ facts }: { facts: ReturnType<typeof useSceneFacts> }) {
  const { lengths, server, ready, total } = facts;
  return (
    <>
      {lengths ? `${secs(lengths.story)} to watch · ${secs(lengths.real)} in real time` : 'length —'}
      {server ? ` · preconditions ${ready}/${total}` : ''}
    </>
  );
}

/** Straight to the scene's recording when that is what the card says it is; a run's log tells only its own scene. */
const recordedLink = (path: string, b: RecordedBundle | null) => linkTo(path, b ? sourceQuery({ kind: 'recorded', run: b.run, date: b.date }) : '');

export function DemoLab({ client: given }: { client?: SceneClient } = {}) {
  const { source } = useApp();
  const client = useMemo(() => given ?? new SceneClient(), [given]);
  const loop = useLoopRecording();
  const rogue = useSceneFacts(client, 'rogue');
  const sale = useSceneFacts(client, 'sale', saleDelay);
  const modeOf = (f: ReturnType<typeof useSceneFacts>): Mode => (source?.kind === 'live' && !!f.server && f.ready === f.total && f.total > 0 ? 'live' : f.recording ? 'recorded' : 'unavailable');
  const toOf = (path: string, f: ReturnType<typeof useSceneFacts>) => (modeOf(f) === 'live' ? linkTo(path, '') : recordedLink(path, f.recording));
  const actionOf = (f: ReturnType<typeof useSceneFacts>) => {
    const m = modeOf(f);
    if (m === 'live') return 'Open it';
    if (m === 'unavailable') return 'See what it needs';
    return '▶︎ Watch';
  };

  return (
    <div className="lab-index">
      <PageHeader title="Demo Lab" />
      <p className="body-l lab-intro">Short demonstrations of what the contract enforces and what the economics do. Each one says whether it’s live, a recording or a simulation.</p>
      <ol className="scene-cards">
        <SceneCard
          wide
          kind="loop"
          title="The whole loop"
          question="What does a Spore actually do?"
          claim="One spore, start to finish: it hires, it pays, a tube grows, its allowance and its picture follow, and then it is sold."
          mode={loop.bundle ? 'recorded' : 'unavailable'}
          to={recordedLink('/lab/loop', loop.bundle)}
          action={loop.bundle ? '▶︎ Start here' : 'See what it needs'}
          meta={loop.bundle ? (loop.length ? `${secs(loop.length)} to watch` : null) : 'no recording available'}
        >
          <p className="scene-card-stops mono-s">{LOOP_ACTS.map((a) => a.word).join(' · ')}</p>
        </SceneCard>
        <SceneCard
          kind="rogue"
          title="Rogue agent"
          question="What if the agent goes rogue?"
          claim="An agent holding the spore’s real key tries to overspend. The contract refuses each time. Then the agent goes quiet and the spore loses its tubes."
          mode={modeOf(rogue)}
          to={toOf('/lab/rogue', rogue)}
          action={actionOf(rogue)}
          meta={<FactsLine facts={rogue} />}
        />
        <SceneCard
          kind="sale"
          title="Sale and control transfer"
          question="What does a buyer actually get?"
          claim="A buyer takes the spore. Its tubes, balance and age stay. The old agent’s key stops working."
          mode={modeOf(sale)}
          to={toOf('/lab/sale', sale)}
          action={actionOf(sale)}
          meta={<FactsLine facts={sale} />}
        />
        <SceneCard
          kind="wash"
          title="Wash trading"
          question="Can one owner pump reputation?"
          claim="Trading between their own spores, as hard as they like. Push the loop and see."
          mode="simulation"
          to={linkTo('/lab/wash', '')}
          action="Push on it"
          meta="simulator output · no chain"
        />
        <UnbuiltCard to={linkTo('/lab/rogue', '')} />
      </ol>
    </div>
  );
}
