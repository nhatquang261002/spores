// scripts/demo.sh's parts (S13): the plan for a run, the stages it prints, and the
// recorded bundle's refusals. No chain and no real keys: a fixture directory.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tubesGrew } from '../src/common.ts';
import { expiredOf, planDemo, unfit, type SporeFacts } from '../src/demo-prep.ts';
import { demoStages, readRun, type RunLogs } from '../src/demo-watch.ts';
import { addCloses, bundleFiles, listWithCloses, record, unfitBundle } from '../src/record-bundle.ts';

const NEAR = 10n ** 24n;
const spore = (id: number, over: Partial<SporeFacts> = {}): SporeFacts => ({ id, owner: 'owner.t', operator: 'op.t', active: true, paused: false, listed: false, balance: NEAR, tubes: [], ...over });
const fit = (s: SporeFacts) => unfit(s, 'op.t', () => true) === null;

test('unfit names why a spore cannot trade, and takes anyone’s spore', () => {
  assert.equal(unfit(spore(1, { owner: 'deployer.t' }), 'op.t', () => true), null);
  assert.equal(unfit(spore(1, { active: false }), 'op.t', () => true), 'not active');
  assert.equal(unfit(spore(1, { paused: true }), 'op.t', () => true), 'paused');
  assert.equal(unfit(spore(1, { listed: true }), 'op.t', () => true), 'listed');
  assert.equal(unfit(spore(1, { operator: 'op2.t' }), 'op.t', () => true), 'run by op2.t');
  assert.equal(unfit(spore(1), 'op.t', () => false), 'no operator key');
});

test('the hero is the seller’s spore with the most tubes, and its partners come first', () => {
  const all = [spore(0, { tubes: [9] }), spore(1, { owner: 'deployer.t', tubes: [2, 3, 4, 5] }), spore(2, { tubes: [7, 8, 3] }), spore(3), spore(4), spore(7), spore(8), spore(9)];
  const p = planDemo(all, 4, fit, 'owner.t', NEAR / 5n, NEAR / 2n)!;
  assert.equal(p.hero, 2, 'spore 1 has more tubes but is not the seller’s');
  assert.deepEqual(p.spores, [2, 3, 7, 8]);
});

test('between spores with no tubes the lowest id stars', () => {
  assert.equal(planDemo([spore(5), spore(3)], 2, fit, 'owner.t', 0n, 0n)!.hero, 3);
});

test('only the run’s spores’ expired jobs are cleared, past the same margin as the keeper’s', () => {
  const jobs = [{ id: 1, consumer: 2, deadline_ns: '100' }, { id: 2, consumer: 9, deadline_ns: '100' }, { id: 3, consumer: 2, deadline_ns: String(5_000_000_000n) }];
  assert.deepEqual(expiredOf(jobs, [2], 4_000_000_000n), [1]);
  assert.deepEqual(expiredOf(jobs, [2], 8_000_000_000n), [1, 3]);
  assert.deepEqual(expiredOf(jobs, [2, 9], 4_000_000_000n), [1, 2]);
});

test('only spores in the run are topped up, up to the target', () => {
  const all = [spore(0, { tubes: [1], balance: NEAR / 10n }), spore(1, { balance: NEAR }), spore(2, { balance: NEAR / 100n })];
  const p = planDemo(all, 2, fit, 'owner.t', NEAR / 5n, NEAR / 2n)!;
  assert.deepEqual(p.spores, [0, 1]);
  assert.deepEqual(p.low, [{ id: 0, amount: NEAR / 2n - NEAR / 10n }]);
});

test('no plan without a spore the seller can sell', () => {
  assert.equal(planDemo([spore(0, { owner: 'x' }), spore(1, { owner: 'x' })], 2, fit, 'owner.t', 0n, 0n), null);
  assert.equal(planDemo([spore(0)], 2, fit, 'owner.t', 0n, 0n), null);
});

const logs = (over: Partial<RunLogs> = {}): RunLogs => ({ run: { sale_spore: 2, spores: [2, 7], start_epoch: 10 }, events: [], decisions: [], snapshots: new Map(), scene: [], report: null, ...over });
const started = [{ at: 't0', spore: 2, kind: 'start' }, { at: 't1', spore: 7, kind: 'start' }];
const hire = { at: '2026-11-06T00:01:00Z', consumer: 2, winner: 7, outcome: 'settled', candidates: [{ provider: 7, price: String(10n ** 23n) }, { provider: 8, price: String(2n * 10n ** 23n) }], tx: { accept: 'ACC', settle: 'SET' } };
const snap = (epoch: number, d: number, r: number, b: bigint) => ({ epoch, spores: { 2: { reputation: r, effective_budget: String(b), render_input: { age: epoch, edges: d ? [[7, d]] : [] } } } });

test('wake waits for every agent, so it can’t print a partial count', () => {
  assert.deepEqual(demoStages(logs({ events: started.slice(0, 1) })), []);
  const [w] = demoStages(logs({ events: started }));
  assert.equal(w.word, 'Wake');
  assert.match(w.text, /2 agents started\. Spore #2/);
});

test('a hire prints only once the hero has a settled one, with the log’s numbers', () => {
  assert.equal(demoStages(logs({ decisions: [{ ...hire, outcome: 'rejected' }] })).some((s) => s.key === 'hire'), false);
  assert.equal(demoStages(logs({ decisions: [{ ...hire, consumer: 9 }] })).some((s) => s.key === 'hire'), false, 'someone else’s hire is not the story');
  const st = demoStages(logs({ decisions: [hire] }));
  const h = st.find((s) => s.key === 'hire')!;
  assert.match(h.text, /#2 hired #7 at 0\.100 NEAR from 2 quotes/);
  assert.equal(h.tx, 'ACC');
  assert.equal(st.find((s) => s.key === 'settle')!.tx, 'SET');
});

test('grow, reputation and art wait for the snapshot after the close, and say a fall as a fall', () => {
  const close = { at: '2026-11-06T00:02:00Z', spore: 'keeper', kind: 'tx', method: 'close_epoch', ok: true, closed: 10, hash: 'CLOSE' };
  const without = demoStages(logs({ decisions: [hire], events: [close], snapshots: new Map([[10, snap(10, 0, 500, NEAR)]]) }));
  assert.ok(without.some((s) => s.key === 'close'));
  assert.equal(without.some((s) => s.key === 'grow'), false);
  const up = demoStages(logs({ decisions: [hire], events: [close], snapshots: new Map([[10, snap(10, 0, 500, NEAR)], [11, snap(11, 300000, 900, 2n * NEAR)]]) }));
  assert.match(up.find((s) => s.key === 'grow')!.text, /D 0 → 300,000/);
  assert.match(up.find((s) => s.key === 'reputation')!.text, /R 0\.50 → 0\.90/);
  const down = demoStages(logs({ decisions: [hire], events: [close], snapshots: new Map([[10, snap(10, 800000, 900, 2n * NEAR)], [11, snap(11, 600000, 700, NEAR)]]) }));
  assert.match(down.find((s) => s.key === 'grow')!.text, /D 800,000 → 600,000/);
  assert.match(down.find((s) => s.key === 'reputation')!.text, /R 0\.90 → 0\.70/);
});

test('the tube is read at the close after the settle tx, not after the decision was made', () => {
  const made = { ...hire, at: '2026-11-06T00:00:50Z' };
  const events = [
    { at: '2026-11-06T00:00:55Z', spore: 'keeper', kind: 'tx', method: 'close_epoch', ok: true, closed: 10, hash: 'C10' },
    { at: '2026-11-06T00:01:30Z', spore: 2, kind: 'tx', method: 'settle', ok: true, hash: 'SET' },
    { at: '2026-11-06T00:02:00Z', spore: 'keeper', kind: 'tx', method: 'close_epoch', ok: true, closed: 11, hash: 'C11' },
  ];
  const snapshots = new Map([[10, snap(10, 0, 500, NEAR)], [11, snap(11, 0, 500, NEAR)], [12, snap(12, 300000, 900, NEAR)]]);
  assert.match(demoStages(logs({ decisions: [made], events, snapshots })).find((s) => s.key === 'grow')!.text, /D 0 → 300,000/);
});

test('a settle logged just after a close counts at that close if the tube says so', () => {
  const events = [
    { at: '2026-11-06T00:01:00Z', spore: 'keeper', kind: 'tx', method: 'close_epoch', ok: true, closed: 10, hash: 'C10' },
    { at: '2026-11-06T00:01:05Z', spore: 2, kind: 'tx', method: 'settle', ok: true, hash: 'SET' },
    { at: '2026-11-06T00:02:00Z', spore: 'keeper', kind: 'tx', method: 'close_epoch', ok: true, closed: 11, hash: 'C11' },
  ];
  const snapshots = new Map([[10, snap(10, 0, 500, NEAR)], [11, snap(11, 300000, 900, NEAR)], [12, snap(12, 225000, 800, NEAR)]]);
  assert.match(demoStages(logs({ decisions: [hire], events, snapshots })).find((s) => s.key === 'grow')!.text, /D 0 → 300,000/);
});

test('a failed buy and an unrefused old key are said, not passed over', () => {
  const start = { type: 'start', spore: 2, buyer: 'buyer.t', price: String(NEAR) };
  const failed = demoStages(logs({ scene: [start, { type: 'result', method: 'buy', ok: false, err: 'nope', tx: 'B', at: 't' }] }));
  assert.match(failed.find((s) => s.key === 'sell')!.text, /the buy failed: nope/);
  const open = demoStages(logs({ scene: [start, { type: 'result', method: 'post_job', role: 'agent', ok: true, at: '2026-11-06T00:03:00Z' }], events: [{ at: '2026-11-06T00:04:00Z', spore: 2, kind: 'tx', ok: true, method: 'quote', hash: 'Q' }] }));
  assert.match(open.find((s) => s.key === 'control')!.text, /was NOT refused/);
});

test('the report line names failed checks', () => {
  const r = demoStages(logs({ report: { checks: [{ name: 'a', ok: true }, { name: 'b', ok: false }] } })).find((s) => s.key === 'report')!;
  assert.match(r.text, /1 of 2 checks passed\. Failed: b/);
});

test('stages only ever grow as the log does, so nothing prints twice or changes', () => {
  const a = demoStages(logs({ events: started })).map((s) => s.key);
  const b = demoStages(logs({ events: started, decisions: [hire] })).map((s) => s.key);
  assert.deepEqual(b.slice(0, a.length), a);
});

test('readRun skips a half-written last line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-'));
  writeFileSync(join(dir, 'run.json'), '{"sale_spore":1}');
  writeFileSync(join(dir, 'events.jsonl'), '{"kind":"start"}\n{"kind":"st');
  const r = readRun(dir);
  assert.equal(r.events.length, 1);
  assert.equal(r.report, null);
});

test('a bundle needs a finished run with every check passed', () => {
  assert.match(unfitBundle(null)!, /no report/);
  assert.match(unfitBundle({ checks: [] })!, /no checks/);
  assert.match(unfitBundle({ checks: [{ name: 'x', ok: false }] })!, /1 of its checks failed: x/);
  assert.equal(unfitBundle({ checks: [{ name: 'x', ok: true }] }), null);
});

test('closes join the list once, in order, and only successful ones', () => {
  const ev = ['{"method":"close_epoch","ok":true,"hash":"B"}', '{"method":"close_epoch","ok":false,"hash":"X"}', '{"method":"quote","ok":true,"hash":"Q"}', '{"method":"close_epoch","ok":true,"hash":"C"}'].join('\n');
  assert.equal(listWithCloses('A\nB\n', ev), 'A\nB\nC\n');
});

function fixture(report: object, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bundle-'));
  const dir = join(root, 'out/agents/r1');
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  mkdirSync(join(dir, 'renders'));
  mkdirSync(join(root, 'viz/public/recorded'), { recursive: true });
  mkdirSync(join(root, 'viz/public/closes'), { recursive: true });
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/router4-closes.txt'), 'A\n');
  writeFileSync(join(root, 'viz/public/closes/x-router4.testnet.txt'), 'A\n');
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ router: 'x-router4.testnet' }));
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
  writeFileSync(join(dir, 'events.jsonl'), '{"at":"2026-11-06T00:00:00Z","method":"close_epoch","ok":true,"hash":"B"}\n');
  writeFileSync(join(dir, 'snapshots/start.json'), '{}');
  writeFileSync(join(dir, 'snapshots/epoch-010.json'), '{}');
  writeFileSync(join(dir, 'renders/epoch-010-spore-1.png'), 'png');
  writeFileSync(join(dir, 'keeper.log'), 'not for the bundle');
  for (const [f, v] of Object.entries(extra)) writeFileSync(join(dir, f), v);
  return { root, dir };
}
const PASSED = { checks: [{ name: 'x', ok: true }] };

test('record copies the logs and snapshots, lists the bundle, and adds the closes', () => {
  const { root, dir } = fixture(PASSED);
  assert.deepEqual(bundleFiles(dir), ['run.json', 'report.json', 'events.jsonl', 'snapshots/epoch-010.json', 'snapshots/start.json']);
  record('r1', root);
  const out = join(root, 'viz/public/recorded/r1');
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'files.json'), 'utf8')), bundleFiles(dir));
  assert.equal(existsSync(join(out, 'renders')), false, 'the app redraws the images');
  assert.equal(existsSync(join(out, 'keeper.log')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'viz/public/recorded/index.json'), 'utf8')), [{ run: 'r1', date: '2026-11-06', scene: 'loop' }]);
  assert.equal(readFileSync(join(root, 'docs/router4-closes.txt'), 'utf8'), 'A\nB\n');
  assert.equal(readFileSync(join(root, 'viz/public/closes/x-router4.testnet.txt'), 'utf8'), 'A\nB\n');
  record('r1', root);
  assert.equal(JSON.parse(readFileSync(join(root, 'viz/public/recorded/index.json'), 'utf8')).length, 1, 'recording again replaces the entry');
});

test('record refuses a secret or a failed run and copies nothing', () => {
  const key = `ed25519:${'3'.repeat(40)}`;
  for (const [report, extra, why] of [
    [PASSED, { 'decisions.jsonl': `{"note":"${key}"}\n` }, /decisions\.jsonl holds an ed25519 key/],
    [{ checks: [{ name: 'x', ok: false }] }, {}, /checks failed/],
  ] as const) {
    const { root } = fixture(report, extra);
    assert.throws(() => record('r1', root), why);
    assert.equal(existsSync(join(root, 'viz/public/recorded/r1')), false);
    assert.equal(existsSync(join(root, 'viz/public/recorded/index.json')), false);
    assert.equal(readFileSync(join(root, 'docs/router4-closes.txt'), 'utf8'), 'A\n');
  }
});

test('record refuses a value from .env, by the name of its variable', () => {
  const { root } = fixture(PASSED, { 'decisions.jsonl': '{"note":"word word word word word word word word"}\n' });
  writeFileSync(join(root, '.env'), 'OWNER_SEED_PHRASE=word word word word word word word word\n');
  assert.throws(() => record('r1', root), /decisions\.jsonl holds OWNER_SEED_PHRASE/);
});

test('addCloses works on its own', () => {
  const { root } = fixture(PASSED);
  addCloses('r1', root);
  assert.equal(readFileSync(join(root, 'docs/router4-closes.txt'), 'utf8'), 'A\nB\n');
});

test('tubes formed means a tube between the run’s spores grew, whatever the router’s total did', () => {
  const ids = [1, 2];
  assert.equal(tubesGrew([{ edges: [[1, 2, '100'], [8, 9, '900']] }, { edges: [[1, 2, '200']] }], ids), true, 'the total fell, this tube grew');
  assert.equal(tubesGrew([{ edges: [] }, { edges: [[1, 2, '5']] }], ids), true, 'born');
  assert.equal(tubesGrew([{ edges: [[1, 2, '100']] }, { edges: [[1, 2, '75']] }], ids), false, 'decay only');
  assert.equal(tubesGrew([{ edges: [] }, { edges: [[8, 9, '5']] }], ids), false, 'someone else’s tube');
  assert.equal(tubesGrew([{ edges: [[1, 2, '100']] }], ids), false, 'one snapshot says nothing');
});
