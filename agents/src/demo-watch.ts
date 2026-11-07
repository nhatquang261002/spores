// The terminal half of `scripts/demo.sh`: follows a run's logs and prints each
// stage of the loop the moment the log confirms it, with the real numbers and
// what the browser shows at that point. Append-only, so its output can be pasted
// into a log as it is. Nothing here touches the chain.
//
//   node agents/src/demo-watch.ts <run> [--pid N]
//
// Exits when the run's report is written (0 if every check passed, else 1), or 1
// if the run's process (--pid) dies without one.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './scenes/rogue.ts';

export interface RunLogs {
  run: any;
  events: any[];
  decisions: any[];
  /** Snapshots by the epoch they were read in (`start` included, under its epoch). */
  snapshots: Map<number, any>;
  scene: any[];
  report: any | null;
}

export interface Stage {
  key: string;
  at: string | null;
  word: string;
  text: string;
  see?: string;
  tx?: string;
}

const near = (y: string | bigint) => {
  const n = Number(BigInt(y) / 10n ** 21n) / 1000;
  return `${n.toFixed(n < 1 ? 3 : 2)} NEAR`;
};
const rep = (r: string | number) => (Number(r) / 1000).toFixed(2);
const fmtD = (d: number) => d.toLocaleString('en-US');

/** Every stage the logs confirm so far. Pure: the same logs give the same lines. */
export function demoStages(l: RunLogs): Stage[] {
  const out: Stage[] = [];
  const hero: number | null = l.run?.sale_spore ?? null;
  const starts = l.events.filter((e) => e.kind === 'start' && typeof e.spore === 'number');
  // All of them, once they've all started: they come up over a few seconds.
  if (starts.length && starts.length >= (l.run?.spores?.length ?? 1)) {
    out.push({ key: 'wake', at: starts[0].at, word: 'Wake', text: `${starts.length} agents started${hero !== null ? `. Spore #${hero} is the one to watch` : ''}`, see: 'one spore in a dish, its owner on a paper label, its agent as a violet line' });
  }
  const decision = hero === null ? l.decisions.find((d) => d.outcome === 'settled') : l.decisions.find((d) => d.consumer === hero && d.outcome === 'settled');
  if (decision) {
    const winner = decision.candidates.find((c: any) => c.provider === decision.winner);
    const price = winner ? near(winner.price) : 'its quote';
    out.push({ key: 'hire', at: decision.at, word: 'Hire', text: `#${decision.consumer} hired #${decision.winner} at ${price} from ${decision.candidates.length} quote${decision.candidates.length === 1 ? '' : 's'}`, see: 'quotes arrive as threads; the winner’s turns solid', tx: decision.tx?.accept });
    out.push({ key: 'settle', at: decision.at, word: 'Settle', text: `#${decision.consumer} paid #${decision.winner} ${price}`, see: 'an amber bead runs from one spore to the other', tx: decision.tx?.settle });
  }
  const closes = l.events.filter((e) => e.kind === 'tx' && e.method === 'close_epoch' && e.ok);
  if (closes.length) out.push({ key: 'close', at: closes[0].at, word: 'Close', text: `epoch ${closes[0].closed ?? '?'} closed`, see: 'a yolk ring sweeps the dish', tx: closes[0].hash });
  if (decision && hero !== null) {
    // A decision's `at` is when it was made; the tube moves at the close after the settle tx.
    const settled = l.events.find((e) => e.hash === decision.tx?.settle)?.at ?? decision.at;
    const edgeIn = (s: any) => s?.spores[hero]?.render_input?.edges?.find(([n]: [number, number]) => n === decision.winner)?.[1] ?? 0;
    const before = (c: any) => l.snapshots.get(c.closed) ?? l.snapshots.get(l.run?.start_epoch);
    const last = [...closes].reverse().find((c) => c.at <= settled);
    // Log order and block order can disagree by a few seconds at a close: the tube shows which it was.
    const landedFirst = last && typeof last.closed === 'number' && Date.parse(settled) - Date.parse(last.at) <= 15_000 && l.snapshots.has(last.closed + 1) && edgeIn(l.snapshots.get(last.closed + 1)) > edgeIn(before(last));
    const after = landedFirst ? last : closes.find((c) => c.at > settled && typeof c.closed === 'number' && l.snapshots.has(c.closed + 1));
    const snapAfter = after && l.snapshots.get(after.closed + 1);
    const snapBefore = after && before(after);
    if (snapAfter && snapBefore) {
      out.push({ key: 'grow', at: after.at, word: 'Grow', text: `tube #${hero}–#${decision.winner}: D ${fmtD(edgeIn(snapBefore))} → ${fmtD(edgeIn(snapAfter))}`, see: 'the tube swells from both ends' });
      const [a, b] = [snapBefore.spores[hero], snapAfter.spores[hero]];
      out.push({ key: 'reputation', at: after.at, word: 'Reputation', text: `R ${rep(a.reputation)} → ${rep(b.reputation)}, may spend ${near(a.effective_budget)} → ${near(b.effective_budget)} an epoch`, see: 'the amber arc round the dish moves' });
      out.push({ key: 'art', at: after.at, word: 'Art', text: `redrawn from ${b.render_input.edges.length} tube${b.render_input.edges.length === 1 ? '' : 's'} at age ${b.render_input.age}`, see: 'the spore’s picture crossfades to the new one' });
    }
  }
  const buy = l.scene.find((s) => s.type === 'result' && s.method === 'buy');
  if (buy) {
    const st = l.scene.find((s) => s.type === 'start');
    out.push({ key: 'sell', at: buy.at, word: 'Sell', text: buy.ok ? `#${st?.spore} sold to ${st?.buyer} for ${near(st?.price ?? '0')}` : `the buy failed: ${buy.err}`, see: 'the paper label peels off and the buyer’s lands', tx: buy.tx });
  }
  const refused = l.scene.find((s) => s.type === 'result' && s.method === 'post_job' && s.role === 'agent');
  if (refused) {
    const resumed = l.events.find((e) => e.spore === hero && e.kind === 'tx' && e.ok && e.at > refused.at);
    if (resumed) out.push({ key: 'control', at: resumed.at, word: 'Control', text: `old key ${refused.ok ? 'was NOT refused' : `refused (${refused.err})`}; the buyer’s agent sent ${resumed.method}`, see: 'a ✕ on the wall, then a new violet line from the buyer', tx: resumed.hash });
  }
  if (closes.length > 1 && l.report) {
    const gaps = closes.slice(1).map((c, i) => Math.round((Date.parse(c.at) - Date.parse(closes[i].at)) / 1000));
    out.push({ key: 'closes', at: closes.at(-1).at, word: 'Closes', text: `${closes.length} closes, seconds between them: ${gaps.join(', ')}` });
  }
  if (l.report) {
    const checks: { name: string; ok: boolean }[] = l.report.checks ?? [];
    const failed = checks.filter((c) => !c.ok);
    out.push({ key: 'report', at: null, word: 'Report', text: failed.length ? `${checks.length - failed.length} of ${checks.length} checks passed. Failed: ${failed.map((c) => c.name).join('; ')}` : `${checks.length} of ${checks.length} checks passed` });
  }
  return out;
}

function readJsonl(file: string): any[] {
  if (!existsSync(file)) return [];
  // The last line can be half written; it arrives whole on the next read.
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readRun(dir: string): RunLogs {
  const snapshots = new Map<number, any>();
  const snapDir = join(dir, 'snapshots');
  if (existsSync(snapDir)) {
    for (const f of readdirSync(snapDir)) {
      if (!f.endsWith('.json')) continue;
      const s = readJson(join(snapDir, f));
      if (s) snapshots.set(s.epoch, s);
    }
  }
  return { run: readJson(join(dir, 'run.json')), events: readJsonl(join(dir, 'events.jsonl')), decisions: readJsonl(join(dir, 'decisions.jsonl')), snapshots, scene: readJsonl(join(dir, 'scene.jsonl')), report: readJson(join(dir, 'report.json')) };
}

async function main() {
  const argv = process.argv.slice(2);
  const run = argv[0];
  if (!run) {
    console.error('usage: node agents/src/demo-watch.ts <run> [--pid N]');
    process.exit(2);
  }
  const p = argv.indexOf('--pid');
  const pid = p >= 0 ? Number(argv[p + 1]) : null;
  const dir = join(ROOT, 'out/agents', run);
  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
  const started = Date.now();
  const clock = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const shown = new Set<string>();
  for (;;) {
    const logs = readRun(dir);
    for (const st of demoStages(logs)) {
      if (shown.has(st.key)) continue;
      shown.add(st.key);
      console.log(`  ${dim(clock())}  ✓ ${bold(st.word.padEnd(11))}${st.text}${st.tx ? dim(`  tx ${st.tx}`) : ''}`);
      if (st.see) console.log(`  ${dim(`        you should see: ${st.see}`)}`);
    }
    if (logs.report) process.exit((logs.report.checks ?? []).every((c: { ok: boolean }) => c.ok) ? 0 : 1);
    if (pid !== null) {
      try {
        process.kill(pid, 0);
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
        if (readRun(dir).report) continue;
        console.log('  ✕ the run stopped without a report; its log says why');
        process.exit(1);
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

if (import.meta.main) main();
