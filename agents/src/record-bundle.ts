// Saves a finished run as a committed RECORDED bundle (viz/public/recorded/<run>/,
// listed in recorded/index.json), so the app can replay the whole loop with no
// keys, no server and no testnet. Used by
// scripts/record-bundle.sh; `--closes-only` just adds the run's closes to the
// router's close list, which LIVE Network and Verify need to see every close.
//
//   node agents/src/record-bundle.ts <run> [--closes-only]
//
// Refuses a run that has no report or failed a check: a recording is what a
// judge sees, and a failed one needs a person to decide on it. Scans every file
// for secrets first and copies nothing if it finds one. `renders/` stays out: the
// app redraws each image from the snapshots with the same wasm, and a PNG per
// spore per epoch is about 60 MB.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findSecret } from './record-scene.ts';
import { loadDotEnv, ROOT } from './scenes/rogue.ts';

const FILES = ['run.json', 'report.json', 'decisions.jsonl', 'events.jsonl', 'scene.jsonl'];

/** Why this run can't be a recording, or null. */
export function unfitBundle(report: any): string | null {
  if (!report) return 'it has no report.json: it did not finish';
  const failed = (report.checks ?? []).filter((c: { ok: boolean }) => !c.ok);
  if (!report.checks?.length) return 'its report has no checks';
  if (failed.length) return `${failed.length} of its checks failed: ${failed.map((c: { name: string }) => c.name).join('; ')}`;
  return null;
}

/** The close list with this run's closes added, each once, in the order they happened. */
export function listWithCloses(list: string, events: string): string {
  const have = list.split('\n').map((l) => l.trim()).filter(Boolean);
  const closes = events.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.method === 'close_epoch' && e.ok && e.hash);
  for (const c of closes) if (!have.includes(c.hash)) have.push(c.hash);
  return have.length ? have.join('\n') + '\n' : '';
}

/** Files of the bundle, relative to the run directory; snapshots sorted. */
export function bundleFiles(dir: string): string[] {
  const snaps = existsSync(join(dir, 'snapshots')) ? readdirSync(join(dir, 'snapshots')).filter((f) => /^(start|epoch-\d{3,6})\.json$/.test(f)).sort() : [];
  return [...FILES.filter((f) => existsSync(join(dir, f))), ...snaps.map((f) => `snapshots/${f}`)];
}

export function addCloses(run: string, root = ROOT): number {
  const dir = join(root, 'out/agents', run);
  const router = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).router as string;
  const name = /router\d*/.exec(router)?.[0];
  const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  let added = 0;
  for (const f of [name ? join(root, 'docs', `${name}-closes.txt`) : null, join(root, `viz/public/closes/${router}.txt`)]) {
    if (!f || !existsSync(f)) continue;
    const before = readFileSync(f, 'utf8');
    const after = listWithCloses(before, events);
    if (after !== before) writeFileSync(f, after);
    added = after.split('\n').length - before.split('\n').length;
  }
  return added;
}

export function record(run: string, root = ROOT): string[] {
  const dir = join(root, 'out/agents', run);
  if (!existsSync(join(dir, 'run.json'))) throw new Error(`not recording ${run}: no run.json in ${dir}`);
  const report = existsSync(join(dir, 'report.json')) ? JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) : null;
  const why = unfitBundle(report);
  if (why) throw new Error(`not recording ${run}: ${why}`);
  const present = bundleFiles(dir);
  const env = loadDotEnv(root);
  for (const f of present) {
    const hit = findSecret(readFileSync(join(dir, f), 'utf8'), env);
    if (hit) throw new Error(`not recording ${run}: ${f} holds ${hit}`);
  }
  const base = join(root, 'viz/public/recorded');
  const out = join(base, run);
  for (const f of present) {
    mkdirSync(dirname(join(out, f)), { recursive: true });
    copyFileSync(join(dir, f), join(out, f));
  }
  writeFileSync(join(out, 'files.json'), JSON.stringify(present, null, 2) + '\n');
  const indexFile = join(base, 'index.json');
  const index: { run: string; date: string; scene?: string }[] = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : [];
  const first = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n')[0];
  const entry = { run, date: String(JSON.parse(first).at).slice(0, 10), scene: 'loop' };
  writeFileSync(indexFile, JSON.stringify([...index.filter((b) => b.run !== run), entry], null, 2) + '\n');
  addCloses(run, root);
  return present;
}

if (import.meta.main) {
  const run = process.argv[2];
  if (!run || run.startsWith('--')) {
    console.error('usage: node agents/src/record-bundle.ts <run> [--closes-only]');
    process.exit(2);
  }
  try {
    if (process.argv.includes('--closes-only')) {
      console.log(`close list: ${addCloses(run)} added`);
    } else {
      const files = record(run);
      console.log(`recorded ${run} in viz/public/recorded/${run}/ (${files.length} files)`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
