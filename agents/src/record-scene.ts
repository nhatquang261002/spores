// Saves a finished scene run as a committed RECORDED bundle
// (viz/public/recorded/<run>/, listed in recorded/index.json), so the Demo Lab
// can replay it with no keys, no server and no testnet.
//
//   node agents/src/record-scene.ts <run>     (a run in out/agents/)
//
// Refuses a run that didn't complete: a recording is what a judge sees, and a
// failed one needs a person to decide on it. Refuses any file holding a value
// from .env that looks like a secret: bundles get committed. The run's closes
// join the router's close list, because LIVE Network and Verify need every close.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDotEnv, ROOT } from './scenes/rogue.ts';

const FILES = ['run.json', 'scene.jsonl', 'events.jsonl'];

/** The first secret found in `text`, by the name of its variable; never the value. */
export function findSecret(text: string, env: Record<string, string>): string | null {
  if (/ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/.test(text)) return 'an ed25519 key';
  if (/"?(private_?key|seed_?phrase)"?\s*[:=]/i.test(text)) return 'a key field';
  for (const [name, value] of Object.entries(env)) {
    if (/PRIVATE|SECRET|SEED|MNEMONIC|PASSWORD|TOKEN/i.test(name) && value.length >= 16 && text.includes(value)) return name;
  }
  return null;
}

/** Why this log can't be a recording, or null. */
export function unfitToRecord(log: string): string | null {
  const lines = log.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const done = lines.find((l) => l.type === 'done');
  const exit = lines.find((l) => l.type === 'exit');
  if (!exit) return 'it has no exit line: run it through the scene server';
  if (exit.code !== 0) return `it exited with code ${exit.code}`;
  if (!done?.ok) return 'its checks did not all pass';
  return null;
}

/** The close list with this run's closes added, each once, in the order they happened. */
export function withCloses(list: string, log: string): string {
  const have = list.split('\n').filter(Boolean);
  const closes = log.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'close' && l.tx);
  for (const c of closes) if (!have.includes(c.tx)) have.push(c.tx);
  return have.length ? have.join('\n') + '\n' : '';
}

export function main(run: string, root = ROOT): void {
  const dir = join(root, 'out/agents', run);
  const scene = readFileSync(join(dir, 'scene.jsonl'), 'utf8');
  const why = unfitToRecord(scene);
  if (why) throw new Error(`not recording ${run}: ${why}`);
  const env = loadDotEnv(root);
  const present = FILES.filter((f) => existsSync(join(dir, f)));
  for (const f of present) {
    const hit = findSecret(readFileSync(join(dir, f), 'utf8'), env);
    if (hit) throw new Error(`not recording ${run}: ${f} holds ${hit}`);
  }
  const base = join(root, 'viz/public/recorded');
  const out = join(base, run);
  mkdirSync(out, { recursive: true });
  for (const f of present) copyFileSync(join(dir, f), join(out, f));
  writeFileSync(join(out, 'files.json'), JSON.stringify(present, null, 2) + '\n');
  const indexFile = join(base, 'index.json');
  const index: { run: string; date: string; scene?: string }[] = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : [];
  const first = JSON.parse(scene.split('\n')[0]);
  const entry = { run, date: String(first.at).slice(0, 10), scene: JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).scene };
  writeFileSync(indexFile, JSON.stringify([...index.filter((b) => b.run !== run), entry], null, 2) + '\n');
  const router = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).router;
  if (router === 'spores-hack-router4.testnet') {
    for (const f of [join(root, 'docs/router4-closes.txt'), join(root, `viz/public/closes/${router}.txt`)]) {
      if (existsSync(f)) writeFileSync(f, withCloses(readFileSync(f, 'utf8'), scene));
    }
  }
  console.log(`recorded ${run} in viz/public/recorded/${run}/ (${present.join(', ')})`);
}

if (import.meta.main) {
  const run = process.argv[2];
  if (!run) {
    console.error('usage: node agents/src/record-scene.ts <run>');
    process.exit(2);
  }
  try {
    main(run);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
