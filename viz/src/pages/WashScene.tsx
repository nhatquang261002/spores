// Wash trading (Design §6.H, /lab/wash; §13 item 25): a SIMULATION panel on the same
// bench as the other scenes, built so the answer is on screen in seconds and can be
// pushed on. Drag the loop, change the traffic, scrub the 40 epochs. The figure names
// its configuration, every configuration S1 measured stays on screen, and the
// unfavourable one opens first.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ProofTabs, SceneNav } from '../components/SceneChrome';
import { WashChart } from '../components/WashChart';
import { WashLoop } from '../components/WashLoop';
import { cappedBy, configOf, configWords, failures, FIRST_PICK, FIXED_SENTENCE, LOOPS, loopOf, nearOfMilli, pathsOf, trafficName, washLine, yMax, type WashData, type WashPick } from '../model/wash';
import { washData } from '../sources/recorded';
import { sourceQuery } from '../sources/source';
import { useApp } from '../state/source';
import { ErrorState, LoadingBar } from '../ui/states';
import { motion } from '../ui/tokens';
import { Tooltip } from '../ui/Tooltip';
import '../components/lab.css';

/** One run of the 40 epochs on screen. */
const PLAY_MS = motion.epoch * 8;

export function WashScene() {
  const { source, reducedMotion } = useApp();
  const q = source ? sourceQuery(source) : '';
  const [data, setData] = useState<WashData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pick, setPick] = useState<WashPick>(FIRST_PICK);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    washData().then(
      (d) => alive && setData(d),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  const config = data ? configOf(data, pick) : null;
  const loop = config ? loopOf(config, pick) : null;
  const paths = useMemo(() => (loop ? pathsOf(loop) : null), [loop]);
  const last = paths ? paths.attacker.length - 1 : 0;

  // Any change of case replays it: the lines draw out epoch by epoch.
  const play = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (reducedMotion || typeof requestAnimationFrame !== 'function') {
      setAt(last);
      setPlaying(false);
      return;
    }
    const start = performance.now();
    setPlaying(true);
    const tick = () => {
      const u = Math.min(1, (performance.now() - start) / PLAY_MS);
      setAt(u * last);
      if (u < 1) raf.current = requestAnimationFrame(tick);
      else {
        raf.current = null;
        setPlaying(false);
      }
    };
    raf.current = requestAnimationFrame(tick);
  };
  useEffect(() => {
    if (paths) play();
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [paths, reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dragging the epochs takes the replay's place: the case stays, the clock is yours.
  const scrub = (to: number) => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setPlaying(false);
    setAt(to);
  };

  const head = <SceneNav current="wash" q={q} />;

  if (error) return <div className="scene">{head}<ErrorState error={error} what="the simulation output" onRetry={() => setAttempt((n) => n + 1)} /></div>;
  if (!data || !config || !loop || !paths) return <div className="scene">{head}<h1 className="scene-q">Can one owner pump reputation by trading between their own spores?</h1><LoadingBar label="Loading the simulation output" ch={12} /></div>;

  const epochNow = Math.round(at);
  const money = paths.money[epochNow];
  const capped = cappedBy(config, loop);
  const top = yMax(data);
  const list = failures(data);
  const groups = [...data.configs].sort((a, b) => b.jobs - a.jobs || b.active - a.active);

  return (
    <div className="scene wash">
      {head}
      <div className="scene-play">
        <div className="scene-bench">
          <div className="scene-side">
            <header className="scene-head">
              <h1 className="scene-q">Can one owner pump reputation by trading between their own spores?</h1>
              <p className="scene-narrator" aria-live="polite" key={washLine(loop)}>{washLine(loop)}</p>
              <p className="wash-case body" role="status">
                <span className={`stamp is-small ${loop.default.gate_pass ? 'is-allowed' : 'is-refused'}`} key={String(loop.default.gate_pass)}>
                  <span aria-hidden="true">{loop.default.gate_pass ? '✓' : '✕'}</span> {loop.default.gate_pass ? 'Gate held' : 'Gate failed'}
                </span>
                <span>{pick.spores} spores, {nearOfMilli(pick.loop)} a loop, {trafficName(config).toLowerCase()}. Shipped fee, K and gain; worst of {data.seeds.length} seeds.</span>
              </p>
            </header>

            <div className="wash-controls">
              <label className="wash-slider">
                <span className="label">How much money goes round the loop, per edge, per epoch</span>
                <input
                  className="wash-range"
                  type="range"
                  min={0}
                  max={LOOPS.length - 1}
                  step={1}
                  value={LOOPS.indexOf(pick.loop as (typeof LOOPS)[number])}
                  aria-valuetext={nearOfMilli(pick.loop)}
                  onChange={(e) => setPick({ ...pick, loop: LOOPS[Number(e.target.value)] })}
                />
                <span className="wash-ticks mono-s" aria-hidden="true">
                  {LOOPS.map((l) => (
                    <span key={l} className={l === pick.loop ? 'is-on' : ''}>{l / 1000}</span>
                  ))}
                </span>
              </label>
              <div className="wash-spores">
                <span className="label">Spores in the loop</span>
                <span className="pace" role="group" aria-label="Spores in the loop">
                  {[2, 3].map((n) => (
                    <button key={n} type="button" className={`pace-btn label${pick.spores === n ? ' is-on' : ''}`} aria-pressed={pick.spores === n} onClick={() => setPick({ ...pick, spores: n })}>{n} spores</button>
                  ))}
                </span>
              </div>
              {capped && <p className="body wash-note"><span className="tone-muted">≈</span> Same result as {nearOfMilli(capped.loop_milli_near)}. The living allowance caps what the spore may spend, so a bigger loop buys nothing.</p>}
            </div>

            <div className="traffic" role="group" aria-label="Honest traffic">
              {groups.map((c) => {
                const on = c.active === pick.active && c.jobs === pick.jobs;
                return (
                  <button key={`${c.active}x${c.jobs}`} type="button" className={`traffic-row${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => setPick({ ...pick, active: c.active, jobs: c.jobs })}>
                    <span className="label traffic-name">{trafficName(c)}</span>
                    <span className="mono-s tone-muted">{c.active} × {c.jobs}</span>
                    <span className="mono traffic-n">{c.gate_pass} / {c.cases}</span>
                    <span className="traffic-bar" aria-hidden="true"><span style={{ width: `${(c.gate_pass / c.cases) * 100}%` }} /></span>
                  </button>
                );
              })}
            </div>

          </div>

          <div className="scene-stage-slot">
            <section className="sim-panel" aria-label="Simulation">
              <header className="sim-head">
                <Tooltip content="Nothing here happened on the chain. The simulator ran this case, with the shipped rules.">
                  <span className="mode-chip mode-simulation label">SIMULATION</span>
                </Tooltip>
                <span className="mono-s tone-muted">simulator · no chain · {data.epochs} epochs</span>
              </header>
              <div className="sim-body">
                <div className="sim-loop">
                  <WashLoop
                    spores={pick.spores}
                    active={config.active}
                    jobs={config.jobs}
                    loopNear={pick.loop / 1000}
                    attackerR={paths.attacker[epochNow]}
                    honestR={paths.honest[epochNow]}
                    money={money}
                    playing={playing}
                    reducedMotion={reducedMotion}
                    label={`A loop of ${pick.spores} attacker spores inside ${config.active} honest ones. Attacker's money so far ${money.toFixed(4)} NEAR.`}
                  />
                  <p className="sim-burn">
                    <span className="label">the attacker’s money so far</span>
                    <span className="figure money">{money.toFixed(4)} NEAR</span>
                  </p>
                  <p className="mono-s tone-muted sim-legend">A picture of the case: its widths, counts and money are simulated values; single beads are not.</p>
                </div>
                <WashChart attacker={paths.attacker} honest={paths.honest} top={top} at={at} title={`Reputation per epoch, ${pick.spores} spores, ${nearOfMilli(pick.loop)} a loop, ${configWords(config)}`} />
              </div>
            </section>
            <div className="wash-under">
              <section className="wash-figure" aria-label="Gate result">
              <div className="sv-figure">
                <span className="figure-l" key={config.gate_pass}>{config.gate_pass} / {config.cases}</span>
                <span className="body">in-range cases: attacker loses money and stays below the honest median R</span>
              </div>
              <p className="mono-s wash-config">{configWords(config)}{config.active === 64 && config.jobs === 1 ? ' (the live network’s traffic)' : ''}. In every case at this traffic, including the failures, the attacker lost money: {config.loses_money} / {config.cases}.</p>
            </section>

            <p className="wash-fixed body">{FIXED_SENTENCE}</p>
            </div>
          </div>
        </div>

        <div className="scene-transport wash-transport">
          <div className="scene-controls">
            <button type="button" className="btn btn-secondary" onClick={play} disabled={playing}>↻ Replay {data.epochs} epochs</button>
          </div>
          <label className="wash-scrub">
            <span className="sr-only">Epoch</span>
            <input className="wash-range" type="range" min={0} max={last} step={1} value={epochNow} aria-valuetext={`epoch ${epochNow + 1} of ${data.epochs}`} onChange={(e) => scrub(Number(e.target.value))} />
          </label>
          <span className="mono-s sim-clock" aria-hidden="true">epoch {epochNow + 1} / {data.epochs}</span>
        </div>
      </div>

      <section className="wash-fails sim-panel">
        <header className="sim-head">
          <h2 className="title">Where it fails</h2>
          <span className="mode-chip mode-simulation label">SIMULATION</span>
        </header>
        <table className="fails-table">
          <thead>
            <tr><th className="label" scope="col">Test</th><th className="label" scope="col">Result</th><th className="label" scope="col">What happened</th><th className="label" scope="col">Worst</th></tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <tr key={f.where}>
                <th className="body" scope="row">{f.where}</th>
                <td className="mono tone-warn"><span aria-hidden="true">✕ </span>{f.count}</td>
                <td className="body">{f.what}</td>
                <td className="mono-s">{f.worst}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <ProofTabs
        opening="loops"
        tabs={[
          {
            key: 'loops',
            word: 'This traffic, every loop',
            body: (
              <table className="state-diff">
                <thead>
                  <tr><th className="label" scope="col">Spores</th><th className="label" scope="col">Loop</th><th className="label" scope="col">Gate</th><th className="label" scope="col">Smallest loss</th></tr>
                </thead>
                <tbody>
                  {config.loops.map((l) => (
                    <tr key={`${l.spores}-${l.loop_milli_near}`}>
                      <th className="mono" scope="row">{l.spores}</th>
                      <td className="mono">{nearOfMilli(l.loop_milli_near)}</td>
                      <td className={`mono ${l.gate_pass < l.cases ? 'tone-warn' : ''}`}>{l.gate_pass} / {l.cases}</td>
                      <td className="mono">{l.worst_net_near.toFixed(4)} NEAR</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ),
          },
          {
            key: 'numbers',
            word: 'The chart as numbers',
            body: (
              <div className="wash-table-scroll">
                <table className="state-diff">
                  <thead>
                    <tr><th className="label" scope="col">Epoch</th><th className="label" scope="col">Attacker’s best R</th><th className="label" scope="col">Honest median R</th><th className="label" scope="col">Attacker’s money (NEAR)</th></tr>
                  </thead>
                  <tbody>
                    {paths.attacker.map((a, i) => (
                      <tr key={i}>
                        <th className="mono" scope="row">{i + 1}</th>
                        <td className="mono">{a.toFixed(3)}</td>
                        <td className="mono">{paths.honest[i].toFixed(3)}</td>
                        <td className="mono">{paths.money[i].toFixed(6)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          },
          {
            key: 'data',
            word: 'The data',
            body: (
              <>
                <p className="body">The panel reads the simulator’s own output, nothing typed in by hand.</p>
                <ul className="wash-files body">
                  <li><a href="/recorded/sim/wash.json">All the data on this page</a> (JSON)</li>
                  <li><a href="/recorded/sim/phase1-report.md">The first sweep</a> (report)</li>
                  <li><a href="/recorded/sim/allowance-64-j1.md">64 spores, 1 job each</a> (report)</li>
                  <li><a href="/recorded/sim/allowance-j1.md">16 spores, 1 job each</a> (report)</li>
                  <li><a href="/recorded/sim/allowance-64.md">64 spores, 3 jobs each</a> (report)</li>
                  <li><a href="/recorded/sim/allowance.md">16 spores, 3 jobs each</a> (report)</li>
                </ul>
                <p className="body scene-why">The first sweep’s acceptance test: {data.phase1.gate_in_range.pass} / {data.phase1.gate_in_range.cases} in range, {data.phase1.gate_all.pass} / {data.phase1.gate_all.cases} over the whole grid (16 × 3, no allowance). This loop has not been run on the chain; every figure here is simulated.</p>
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
