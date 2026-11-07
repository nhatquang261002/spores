import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ATTACKER, ERR_BUDGET, ERR_CAP, ERR_PAYEE, decayed, panicText, ringGap, runRogue, unfit, type Role, type SceneChain } from '../src/scenes/rogue.ts';
import { ERR_OLD_KEY, ERR_OLD_OWNER, LOCKED, payoutsTo, runSale, sellBack, unfitForSale, type SaleChain, type SaleOpts, type SaleRole } from '../src/scenes/sale.ts';
import { createSceneServer, refusal, sseFrame, type SceneDef } from '../src/scene-server.ts';
import type { TxResult } from '../src/near.ts';

// --- a tiny router: enough of the real rules to drive the script ---------------

const NEAR = 10n ** 24n;
const FAKE_KEY = 'ed25519:FAKEKEYTHATMUSTNEVERAPPEAR';

function fakeChain(over: Partial<{ errAt: Record<string, string>; noDecay: boolean; chargeRefused: bigint; failRestore: boolean }> = {}) {
  const state = {
    now: 1_000_000_000_000n,
    epoch: 30,
    balance: NEAR,
    spent: 0n,
    jobs: new Map<number, any>(),
    nextJob: 1,
    policy: { paused: false, budget_per_epoch: (3n * NEAR).toString(), max_payment: NEAR.toString(), allow_all_spores: true, allowlist: [], external_allowlist: ['outside.testnet'] } as any,
    tubes: new Map<number, bigint>([[1, 400_000n], [2, 300_000n]]),
    calls: [] as { role: Role; method: string; args: any }[],
  };
  const fail = (hash: string, err: string): TxResult => ({ hash, ok: false, err: `Smart contract panicked: ${err}`, ret: null, gasTgas: 1, events: [], logBytes: [] });
  const ok = (hash: string, ret: unknown = null): TxResult => ({ hash, ok: true, err: '', ret, gasTgas: 1, events: [], logBytes: [] });
  let n = 0;
  const chain: SceneChain = {
    timeNs: async () => state.now,
    sleep: async (ms) => {
      state.now += BigInt(ms) * 1_000_000n;
    },
    view: async (method, args: any = {}) => {
      switch (method) {
        case 'edges':
          return [...state.tubes].map(([id, d]) => [0, id, d.toString()]);
        case 'config':
          return { decay_bps: 2500, d_min: '50000', epoch_len_ns: '30000000000', job_timeout_ns: '60000000000' };
        case 'epoch_info':
          return { epoch: state.epoch, ends_ns: (state.now + 1_000_000_000n).toString(), flows: [], rejects: [], active: [0, 1, 2, 9] };
        case 'fingerprint':
          return 'f'.repeat(64);
        case 'get_job':
          return state.jobs.get(args.job_id);
        case 'render_input':
          return { spore_id: args.spore_id, epoch: state.epoch, seed: 'a'.repeat(64), age: state.epoch, edges: args.spore_id === 0 ? [...state.tubes].map(([id, d]) => [id, Number(d)]) : [] };
        case 'spore_summary':
          if (args.spore_id !== 0) return { spore_id: args.spore_id, active: true, operator_id: 'op', policy: { paused: false }, listed_price: null };
          return {
            spore_id: 0, active: true, owner_id: 'owner.testnet', operator_id: 'op', balance: state.balance.toString(), reputation: String([...state.tubes.values()].reduce((s, d) => s + d / 100n, 0n)),
            degree: state.tubes.size, connections: [...state.tubes].map(([id, d]) => [id, d.toString()]), spent_this_epoch: state.spent.toString(), effective_budget: state.policy.budget_per_epoch, policy: state.policy, posted_jobs: [], listed_price: null,
          };
        default:
          throw new Error(`view ${method}`);
      }
    },
    call: async (role, method, args: any) => {
      const hash = `tx${++n}`;
      state.calls.push({ role, method, args });
      const forced = over.errAt?.[`${method}#${state.calls.filter((c) => c.method === method).length}`];
      if (forced) return fail(hash, forced);
      switch (method) {
        case 'set_policy':
          if (over.failRestore && args.policy.allow_all_spores) return fail(hash, 'owner key gone');
          state.policy = args.policy;
          return ok(hash);
        case 'post_job': {
          const id = state.nextJob++;
          state.jobs.set(id, { max: BigInt(args.max_price), deadline_ns: (state.now + 60_000_000_000n).toString(), status: 'open' });
          return ok(hash, id);
        }
        case 'quote':
          state.jobs.get(args.job_id).price = BigInt(args.price);
          return ok(hash);
        case 'accept': {
          const j = state.jobs.get(args.job_id);
          if (j.price > BigInt(state.policy.max_payment)) return fail(hash, ERR_CAP);
          if (state.spent + j.price > BigInt(state.policy.budget_per_epoch)) return fail(hash, ERR_BUDGET);
          state.spent += j.price;
          state.balance -= j.price;
          j.status = 'accepted';
          return ok(hash);
        }
        case 'pay_service':
          if (!state.policy.external_allowlist.includes(args.payee)) {
            state.balance -= over.chargeRefused ?? 0n;
            return fail(hash, ERR_PAYEE);
          }
          state.balance -= BigInt(args.amount);
          return ok(hash);
        case 'close_epoch':
          state.epoch++;
          state.spent = 0n;
          if (!over.noDecay) for (const [id, d] of state.tubes) state.tubes.set(id, decayed(d, 2500n, 1));
          return ok(hash, 'f'.repeat(64));
        case 'timeout_job': {
          const j = state.jobs.get(args.job_id);
          if (j.status === 'accepted') state.balance += j.price;
          return ok(hash);
        }
        default:
          return fail(hash, `no method ${method}`);
      }
    },
  };
  return { chain, state };
}

const OPTS = { owners: ['owner.testnet'], hasOperatorKey: () => true, run: 'test-run', router: 'router.testnet' };

async function play(over?: Parameters<typeof fakeChain>[0]) {
  const { chain, state } = fakeChain(over);
  const lines: any[] = [];
  const result = await runRogue(chain, (e) => lines.push(e), OPTS);
  return { result, lines, state };
}

test('a clean run: three exact refusals, one allowed payment, decay, money and policy back', async () => {
  const { result, lines, state } = await play();
  assert.deepEqual(result, { ok: true, passed: 8, total: 8 });
  const refusals = lines.filter((l) => l.type === 'result' && !l.ok).map((l) => l.err);
  assert.deepEqual(refusals, [ERR_CAP, ERR_BUDGET, ERR_PAYEE]);
  assert.equal(state.balance, NEAR);
  assert.equal(state.policy.allow_all_spores, true);
  assert.deepEqual(lines.filter((l) => l.type === 'act').map((l) => l.act), ['limits', 'cap', 'budget', 'drain', 'quiet', 'cleanup']);
  assert.equal(lines.filter((l) => l.type === 'close').length, 2);
  assert.equal(lines.at(-1).type, 'done');
});

test('the attacker is on no allowlist and gets a call that can only be refused for the payee', async () => {
  const { state, lines } = await play();
  const drain = state.calls.find((c) => c.method === 'pay_service')!;
  assert.equal(drain.args.payee, ATTACKER);
  const limits = lines.find((l) => l.type === 'start').limits;
  assert.ok(BigInt(drain.args.amount) <= BigInt(limits.max_payment));
});

test('a different error string fails that check and names both', async () => {
  const { result, lines } = await play({ errAt: { 'accept#1': 'policy: spore is paused' } });
  assert.equal(result.ok, false);
  const c = lines.find((l) => l.type === 'check' && !l.ok);
  assert.equal(c.expected, ERR_CAP);
  assert.equal(c.actual, 'policy: spore is paused');
});

test('a refused tx that goes through instead fails the check', async () => {
  const { chain, state } = fakeChain();
  const realCall = chain.call;
  chain.call = async (role, method, args, d, g) => {
    if (method === 'pay_service') {
      state.calls.push({ role, method, args });
      return { hash: 'txpaid', ok: true, err: '', ret: null, gasTgas: 1, events: [], logBytes: [] };
    }
    return realCall(role, method, args, d, g);
  };
  const lines: any[] = [];
  const result = await runRogue(chain, (e) => lines.push(e), OPTS);
  assert.equal(result.ok, false);
  assert.equal(lines.find((l) => l.type === 'check' && !l.ok).actual, 'the tx succeeded');
});

test('tubes that did not decay and money that moved fail their checks', async () => {
  assert.equal((await play({ noDecay: true })).lines.find((l) => l.type === 'check' && !l.ok).name, 'Every tube shrank at every close while the agent was quiet');
  const leak = await play({ chargeRefused: 1n });
  assert.deepEqual(leak.lines.filter((l) => l.type === 'check' && !l.ok).map((l) => l.name), ['The refused attempts moved nothing', 'The escrowed payment came back']);
});

test('a scene that blows up mid-way still restores the policy and reports the failure', async () => {
  const { result, lines, state } = await play({ errAt: { 'post_job#1': 'too many unfinished jobs' } });
  assert.equal(result.ok, false);
  assert.equal(state.policy.allow_all_spores, true, 'policy restored');
  assert.match(lines.find((l) => l.type === 'check' && !l.ok).actual, /too many unfinished jobs/);
});

test('a policy that cannot be restored is never a completed run', async () => {
  const { result } = await play({ failRestore: true });
  assert.equal(result.ok, false);
});

test('the log carries no key', async () => {
  const { lines } = await play();
  assert.ok(!JSON.stringify(lines).includes(FAKE_KEY));
  assert.ok(!/private|ed25519:/i.test(JSON.stringify(lines)));
});

test('unfit says why a spore cannot star', () => {
  const opts = { owners: ['o'], hasOperatorKey: () => true };
  const base = { spore_id: 3, active: true, policy: { paused: false }, listed_price: null, owner_id: 'o', balance: NEAR.toString(), spent_this_epoch: '0', connections: [[1, '400000'], [2, '300000']] };
  const info = { flows: [], rejects: [] };
  const config = { decay_bps: 2500, d_min: '50000' };
  assert.equal(unfit(base, info, config, opts), null);
  assert.match(unfit({ ...base, owner_id: 'x' }, info, config, opts)!, /no key for its owner/);
  assert.match(unfit({ ...base, spent_this_epoch: '1' }, info, config, opts)!, /already spent/);
  assert.match(unfit(base, { flows: [[3, 9, '1']], rejects: [] }, config, opts)!, /traded/);
  assert.match(unfit({ ...base, connections: [[1, '60000'], [2, '60000']] }, info, config, opts)!, /outlast/);
});

test('ringGap wraps round the ring', () => {
  assert.equal(ringGap(31, [1, 2, 7, 55]), 24);
  assert.equal(ringGap(63, [0]), 1);
  assert.equal(ringGap(9, []), 64);
});

test('panicText strips only NEAR’s prefix; decayed matches the core rule', () => {
  assert.equal(panicText(`Smart contract panicked: ${ERR_CAP}`), ERR_CAP);
  assert.equal(panicText('Exceeded the prepaid gas.'), 'Exceeded the prepaid gas.');
  assert.equal(decayed(137063n, 2500n, 1), 102798n);
});

// --- server ---------------------------------------------------------------------

test('only loopback peers, hosts and origins get through', () => {
  assert.equal(refusal('127.0.0.1', '127.0.0.1:8790', undefined), null);
  assert.equal(refusal('::1', 'localhost:8790', 'http://localhost:5173'), null);
  assert.equal(refusal('::ffff:127.0.0.1', '127.0.0.1:8790', 'http://127.0.0.1:5173'), null);
  assert.match(refusal('10.0.0.5', '127.0.0.1:8790', undefined)!, /this machine/);
  assert.match(refusal('127.0.0.1', 'evil.example:8790', undefined)!, /Host/, 'a DNS-rebound name');
  assert.match(refusal('127.0.0.1', '127.0.0.1:8790', 'https://evil.example')!, /page served from this machine/);
  assert.match(refusal('127.0.0.1', '127.0.0.1:8790', 'http://127.0.0.1.evil.example')!, /page served/);
  assert.match(refusal('127.0.0.1', '127.0.0.1:8790', 'null')!, /page served/, 'a sandboxed iframe');
  assert.ok(refusal(undefined, undefined, undefined));
});

test('SSE framing: one message per frame, whatever the payload holds', () => {
  assert.equal(sseFrame(3, 'scene', '{"a":1}'), 'id: 3\nevent: scene\ndata: {"a":1}\n\n');
  assert.equal(sseFrame(null, 'end', '{}'), 'event: end\ndata: {}\n\n');
  const evil = sseFrame(1, 'scene', 'x\n\nevent: end\ndata: forged\r\nmore');
  assert.equal(evil, 'id: 1\nevent: scene\ndata: x\ndata: \ndata: event: end\ndata: data: forged\ndata: more\n\n');
  assert.equal(evil.split('\n\n').length, 2, 'no blank line before the end of the frame');
});

function nodeScript(body: string) {
  return { cmd: process.execPath, args: ['-e', body] };
}

function scene(body: string, pre = [{ key: 'k', label: 'ready', ok: true }]): SceneDef {
  return { id: 'demo', title: 'Demo', command: () => nodeScript(body), preconditions: async () => pre };
}

async function withServer(def: SceneDef, fn: (port: number) => Promise<void>) {
  const server = createSceneServer({ scenes: [def], runName: () => 'r1', heartbeatMs: 50 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const call = (port: number, method: string, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string; headers: any }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });

test('the server refuses a foreign origin and host before doing anything', async () => {
  let ran = false;
  const def = scene('process.exit(0)');
  const command = def.command;
  def.command = (r) => {
    ran = true;
    return command(r);
  };
  await withServer(def, async (port) => {
    assert.equal((await call(port, 'POST', '/scenes/demo/run', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(port, 'POST', '/scenes/demo/run', { host: 'evil.example' })).status, 403);
    assert.equal(ran, false);
    const ok = await call(port, 'GET', '/scenes', { origin: 'http://127.0.0.1:5173' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');
  });
});

test('a run streams its JSON lines in order, then the real exit code, then ends', async () => {
  const def = scene(`console.log(JSON.stringify({type:'a'}));console.log('not json');console.log(JSON.stringify({type:'done',ok:true}));process.exit(0)`);
  await withServer(def, async (port) => {
    assert.equal((await call(port, 'POST', '/scenes/demo/run')).status, 202);
    const res = await call(port, 'GET', '/scenes/demo/stream');
    assert.match(res.headers['content-type'], /text\/event-stream/);
    const frames = res.body.split('\n\n').filter((f) => f && !f.startsWith(':'));
    const data = frames.filter((f) => f.includes('event: scene')).map((f) => JSON.parse(f.split('data: ')[1]));
    assert.deepEqual(data.map((d) => d.type), ['a', 'done', 'exit']);
    assert.equal(data[2].code, 0);
    assert.match(frames.at(-1)!, /^event: end/);
    // Last-Event-ID resumes after what the client already has.
    const resumed = await call(port, 'GET', '/scenes/demo/stream', { 'last-event-id': '2' });
    assert.equal(resumed.body.split('\n\n').filter((f) => f.includes('event: scene')).length, 1);
  });
});

test('a failing script reports its exit code, a second run is refused while one is going', async () => {
  await withServer(scene(`console.log(JSON.stringify({type:'done',ok:true}));process.exit(3)`), async (port) => {
    await call(port, 'POST', '/scenes/demo/run');
    const res = await call(port, 'GET', '/scenes/demo/stream');
    assert.ok(res.body.includes('"code":3'), 'done:true does not outvote the exit code');
  });
  await withServer(scene(`setTimeout(()=>{},300)`), async (port) => {
    assert.equal((await call(port, 'POST', '/scenes/demo/run')).status, 202);
    const again = await call(port, 'POST', '/scenes/demo/run');
    assert.equal(again.status, 409);
    assert.equal(JSON.parse((await call(port, 'GET', '/scenes')).body).scenes[0].running, true);
  });
});

test('a stream with no run says idle and ends, so a client never hangs on it', async () => {
  await withServer(scene('process.exit(0)'), async (port) => {
    const res = await call(port, 'GET', '/scenes/demo/stream');
    assert.equal(res.body, 'event: idle\ndata: {}\n\n');
  });
});

test('two quick POSTs start one run', async () => {
  let spawned = 0;
  const def = scene(`setTimeout(()=>{},200)`);
  // Slow enough that the second POST arrives while the first is still reading them.
  def.preconditions = () => new Promise((r) => setTimeout(() => r([{ key: 'k', label: 'ready', ok: true }]), 40));
  const command = def.command;
  def.command = (r) => {
    spawned++;
    return command(r);
  };
  await withServer(def, async (port) => {
    const [a, b] = await Promise.all([call(port, 'POST', '/scenes/demo/run'), call(port, 'POST', '/scenes/demo/run')]);
    assert.deepEqual([a.status, b.status].sort(), [202, 409]);
    assert.equal(spawned, 1);
  });
});

test('preconditions gate a run; a scene without a reset says so', async () => {
  await withServer(scene('process.exit(0)', [{ key: 'k', label: 'keys', ok: false }]), async (port) => {
    const r = await call(port, 'POST', '/scenes/demo/run');
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(r.body).failed[0].key, 'k');
    assert.equal((await call(port, 'POST', '/scenes/demo/reset')).status, 409);
    assert.equal((await call(port, 'POST', '/scenes/nope/run')).status, 404);
    assert.equal((await call(port, 'GET', '/scenes/demo/run')).status, 405);
  });
});

test('anything on a child’s stdout that is not a JSON line never reaches a client', async () => {
  const def = scene(`console.log(${JSON.stringify(FAKE_KEY)});process.exit(0)`);
  await withServer(def, async (port) => {
    await call(port, 'POST', '/scenes/demo/run');
    const res = await call(port, 'GET', '/scenes/demo/stream');
    assert.ok(!res.body.includes(FAKE_KEY));
  });
});

test('a recording refuses secrets and unfinished or failed runs', async () => {
  const { findSecret, unfitToRecord, withCloses } = await import('../src/record-scene.ts');
  const log = '{"type":"close","epoch":26,"tx":"AAA"}\n{"type":"step"}\n{"type":"close","epoch":27,"tx":"BBB"}\n{"type":"close","epoch":28,"tx":null}\n';
  assert.equal(withCloses('X\nAAA\n', log), 'X\nAAA\nBBB\n', 'each once, and a close someone else made has no hash to add');
  const secret = 'ed25519:3vQB7B6MrGQZaxCuFg4oh9xQ1zqX7yL2mN8pR5sT6uV';
  assert.equal(findSecret('{"tx":"abc"}', {}), null);
  assert.equal(findSecret(`{"k":"${secret}"}`, {}), 'an ed25519 key');
  assert.equal(findSecret('{"private_key":"x"}', {}), 'a key field');
  assert.equal(findSecret('hello SOMELONGSECRETVALUE12345', { MY_SECRET: 'SOMELONGSECRETVALUE12345' }), 'MY_SECRET');
  assert.equal(findSecret('owner.spores-hack.testnet', { OWNER_ACCOUNT_ID: 'owner.spores-hack.testnet' }), null, 'account names are public');
  const done = '{"type":"done","ok":true}';
  assert.equal(unfitToRecord(`${done}\n{"type":"exit","code":0}\n`), null);
  assert.match(unfitToRecord(`${done}\n`)!, /no exit line/);
  assert.match(unfitToRecord(`${done}\n{"type":"exit","code":1}\n`)!, /code 1/);
  assert.match(unfitToRecord('{"type":"done","ok":false}\n{"type":"exit","code":0}\n')!, /did not all pass/);
});

// --- sale -----------------------------------------------------------------------

const ROUTER = 'router.testnet';
const SELLER = 'owner.testnet';
const BUYER = 'buyer.testnet';
const ROYALTY = 'admin.testnet';
const PRICE = 5n * (NEAR / 10n);
const ROYALTY_CUT = PRICE / 20n;
const NEW_POLICY = { paused: false, budget_per_epoch: NEAR.toString(), max_payment: NEAR.toString(), allow_all_spores: true, allowlist: [], external_allowlist: [] };

/** A tiny market with the real rules of `buy`, `reset_control`, `post_job` and `withdraw`. */
function saleWorld(over: Partial<{ buyerFunds: bigint; err: Record<string, string>; skimSeller: bigint; noEvent: boolean; keepOperator: boolean; moveBalance: bigint; rpcDies: string }> = {}) {
  const s = {
    spore_id: 2,
    active: true,
    owner_id: SELLER,
    operator_id: 'operator.testnet' as string | null,
    operator_gen: 4,
    balance: NEAR.toString(),
    reputation: 1371,
    age: 27,
    degree: 2,
    connections: [[0, '77099'], [6, '249823']],
    policy: { paused: false, budget_per_epoch: NEAR.toString(), max_payment: NEAR.toString(), allow_all_spores: true, allowlist: [], external_allowlist: ['outside.testnet'] } as any,
    listed_price: null as string | null,
    sales: 0,
    posted_jobs: [] as number[],
    serving_jobs: [] as number[],
  };
  const calls: { role: SaleRole; method: string; args: any; deposit: bigint }[] = [];
  const snapshots = new Map<string, any>();
  let n = 0;
  let buyStatus: any = null;
  const bad = (hash: string, err: string): TxResult => ({ hash, ok: false, err: `Smart contract panicked: ${err}`, ret: null, gasTgas: 1, events: [], logBytes: [] });
  const good = (hash: string, events: any[] = [], ret: unknown = null): TxResult => ({ hash, ok: true, err: '', ret, gasTgas: 1, events, logBytes: [] });
  const ownerOf: Record<SaleRole, string> = { seller: SELLER, buyer: BUYER, agent: 'operator.testnet', 'new agent': 'operator2.testnet', keeper: 'keeper.testnet' };
  const chain: SaleChain = {
    timeNs: async () => 1n,
    balanceOf: async () => over.buyerFunds ?? 10n * NEAR,
    prevBlock: async () => 'before-block',
    status: async () => buyStatus,
    view: async (method, args: any = {}, block) => {
      if (over.rpcDies === method) throw new Error('rpc http 503');
      if (method === 'config') return { royalty_bps: 500, royalty_account: null };
      if (method === 'admin') return ROYALTY;
      if (method === 'epoch_info') return { epoch: 30 };
      if (method === 'render_input') return { spore_id: args.spore_id, seed: 'ab'.repeat(32), age: 27, edges: [] };
      if (method === 'spore_summary') return structuredClone(block ? snapshots.get(block) : s);
      throw new Error(`unexpected view ${method}`);
    },
    call: async (role, method, args: any, deposit = 0n) => {
      calls.push({ role, method, args, deposit });
      const hash = `tx${++n}`;
      const forced = over.err?.[method];
      if (forced) return bad(hash, forced);
      const who = ownerOf[role];
      if (method === 'list' || method === 'delist') {
        if (who !== s.owner_id) return bad(hash, 'only the spore owner can do this');
        s.listed_price = method === 'list' ? args.price : null;
        return good(hash);
      }
      if (method === 'buy') {
        if (!s.listed_price) return bad(hash, 'spore is not listed');
        if (deposit !== BigInt(s.listed_price)) return bad(hash, 'attach exactly the listed price');
        snapshots.set('before-block', structuredClone(s));
        const seller = s.owner_id;
        s.owner_id = who;
        s.listed_price = null;
        if (!over.keepOperator) {
          s.operator_id = null;
          s.operator_gen++;
          s.policy = { ...LOCKED };
        }
        s.sales++;
        if (over.moveBalance) s.balance = (BigInt(s.balance) + over.moveBalance).toString();
        snapshots.set('buy-block', structuredClone(s));
        const paid = deposit - ROYALTY_CUT - (over.skimSeller ?? 0n);
        buyStatus = {
          transaction_outcome: { outcome: { receipt_ids: ['r0'] } },
          receipts_outcome: [
            { id: 'r0', block_hash: 'buy-block', outcome: { status: { SuccessValue: '' } } },
            { id: 'r1', outcome: { status: { SuccessValue: '' } } },
            { id: 'r2', outcome: { status: { SuccessValue: '' } } },
          ],
          receipts: [
            { receipt_id: 'r1', receiver_id: seller, predecessor_id: ROUTER, receipt: { Action: { actions: [{ Transfer: { deposit: paid.toString() } }] } } },
            { receipt_id: 'r2', receiver_id: ROYALTY, predecessor_id: ROUTER, receipt: { Action: { actions: [{ Transfer: { deposit: ROYALTY_CUT.toString() } }] } } },
          ],
        };
        return good(hash, over.noEvent ? [] : [{ event: 'spore_sold', data: [{ spore_id: 2, price: deposit.toString(), seller_amount: (deposit - ROYALTY_CUT).toString(), royalty: ROYALTY_CUT.toString() }] }]);
      }
      if (method === 'post_job') return who === s.operator_id ? good(hash, [], 77) : bad(hash, ERR_OLD_KEY);
      if (method === 'withdraw') return who === s.owner_id ? good(hash) : bad(hash, ERR_OLD_OWNER);
      if (method === 'register_operator') {
        if (who !== s.owner_id) return bad(hash, ERR_OLD_OWNER);
        s.operator_id = args.operator_id;
        return good(hash);
      }
      if (method === 'set_policy') {
        if (who !== s.owner_id) return bad(hash, ERR_OLD_OWNER);
        s.policy = args.policy;
        return good(hash);
      }
      throw new Error(`unexpected call ${method}`);
    },
  };
  return { s, chain, calls };
}

async function sell(world: ReturnType<typeof saleWorld>, more: Partial<SaleOpts> = {}) {
  const lines: any[] = [];
  const rec = await runSale(world.chain, (e) => lines.push(e), { run: 'test', router: ROUTER, spore: 2, price: PRICE, buyer: BUYER, newOperator: 'operator2.testnet', newPolicy: NEW_POLICY, probeAgent: true, clearStale: true, ...more });
  return { rec, lines, checks: lines.filter((l) => l.type === 'check') };
}

test('a clean sale passes the 11 checks, in the order the plan lists them', async () => {
  const { rec, checks, lines } = await sell(saleWorld());
  assert.equal(rec.ok, true);
  assert.deepEqual(checks.map((c) => c.name), [
    'The owner lists it at its price',
    'The buy is final and the spore is the buyer’s',
    'The seller was paid 95% (from the receipt)',
    'The royalty account was paid 5% (from the receipt)',
    'The chain logged spore_sold with those amounts',
    'The old agent’s key is refused',
    'The old owner is refused',
    'It arrives locked: no operator, paused, zero budget',
    'Balance, tubes and age came with it',
    'The buyer appoints its agent and sets a policy',
    'The new agent’s key works',
  ]);
  assert.ok(checks.every((c) => c.ok));
  assert.deepEqual(lines.filter((l) => l.type === 'payout').map((l) => [l.role, l.amount]), [['seller', (PRICE - ROYALTY_CUT).toString()], ['royalty', ROYALTY_CUT.toString()]]);
  assert.equal(lines.at(-1).type, 'done');
  assert.equal(JSON.stringify(lines).includes(FAKE_KEY), false);
});

test('ownership in the log flips only after the buy tx is final', async () => {
  const { lines } = await sell(saleWorld());
  const resultAt = lines.findIndex((l) => l.type === 'result' && l.method === 'buy');
  const before = lines.slice(0, resultAt).filter((l) => l.type === 'snapshot');
  assert.ok(before.every((l) => l.owner === SELLER));
  assert.equal(lines.slice(resultAt).find((l) => l.type === 'snapshot').owner, BUYER);
});

test('not enough funds is a failed step before any tx, and nothing needs a reset', async () => {
  let listed = 0;
  let unsold = 0;
  const w = saleWorld({ buyerFunds: PRICE });
  const { rec, checks } = await sell(w, { onListing: () => listed++, onUnsold: () => unsold++ });
  assert.equal(rec.ok, false);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'The buyer can pay');
  assert.equal(checks[0].ok, false);
  assert.equal(w.calls.length, 0);
  assert.equal(listed, 0);
  assert.equal(unsold, 1);
});

test('a refused buy fails with the contract’s words, takes the listing down, and nothing needs a reset', async () => {
  let unsold = 0;
  const w = saleWorld({ err: { buy: 'attach exactly the listed price' } });
  const { rec, checks } = await sell(w, { onUnsold: () => unsold++ });
  assert.equal(rec.ok, false);
  assert.equal(checks.at(-1).actual, 'attach exactly the listed price');
  assert.equal(w.calls.at(-1)!.method, 'delist');
  assert.equal(w.s.listed_price, null);
  assert.equal(unsold, 1);
});

test('an RPC failure mid-run is a failed check, never a success', async () => {
  const { rec, checks } = await sell(saleWorld({ rpcDies: 'epoch_info' }));
  assert.equal(rec.ok, false);
  assert.equal(checks.at(-1).name, 'The scene ran to the end');
  assert.match(checks.at(-1).actual, /503/);
});

for (const [name, over, failing] of [
  ['the seller paid short', { skimSeller: 1n }, 'The seller was paid 95% (from the receipt)'],
  ['no spore_sold event', { noEvent: true }, 'The chain logged spore_sold with those amounts'],
  ['the operator not cleared', { keepOperator: true }, 'The old agent’s key is refused'],
  ['the balance moved', { moveBalance: 1n }, 'Balance, tubes and age came with it'],
] as const) {
  test(`caught: ${name}`, async () => {
    const { rec, checks } = await sell(saleWorld(over));
    assert.equal(rec.ok, false);
    assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.name).slice(0, 1), [failing]);
  });
}

test('a refusal in other words fails the check: only the contract’s exact error counts', async () => {
  const { rec, checks } = await sell(saleWorld({ err: { post_job: 'policy: spore is paused', withdraw: 'a listed spore cannot withdraw; delist it first' } }));
  assert.equal(rec.ok, false);
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed.includes('The old agent’s key is refused'));
  assert.ok(failed.includes('The old owner is refused'));
  assert.equal(checks.find((c) => c.name === 'The old agent’s key is refused').actual, 'policy: spore is paused');
});

test('payoutsTo reads only the router’s successful transfers to that account', () => {
  const st = {
    receipts: [
      { receipt_id: 'a', receiver_id: 'x', predecessor_id: ROUTER, receipt: { Action: { actions: [{ Transfer: { deposit: '5' } }] } } },
      { receipt_id: 'b', receiver_id: 'x', predecessor_id: 'someone.else', receipt: { Action: { actions: [{ Transfer: { deposit: '6' } }] } } },
      { receipt_id: 'c', receiver_id: 'x', predecessor_id: ROUTER, receipt: { Action: { actions: [{ Transfer: { deposit: '7' } }] } } },
    ],
    receipts_outcome: [{ id: 'a', outcome: { status: { SuccessValue: '' } } }, { id: 'c', outcome: { status: { Failure: {} } } }],
  };
  assert.deepEqual(payoutsTo(st, ROUTER, 'x'), [{ id: 'a', deposit: '5', ok: true }, { id: 'c', deposit: '7', ok: false }]);
});

test('sellBack is a real sale back with the first operator and policy; only a stale listing if nothing sold', async () => {
  const w = saleWorld();
  const policy = structuredClone(w.s.policy);
  await sell(w);
  const steps = await sellBack(w.chain, { spore: 2, run: 'test', seller: SELLER, buyer: BUYER, operator: 'operator.testnet', policy, price: PRICE.toString() });
  assert.deepEqual(steps.map((t) => t.method), ['list', 'buy', 'register_operator', 'set_policy']);
  assert.equal(w.s.owner_id, SELLER);
  assert.equal(w.s.operator_id, 'operator.testnet');
  assert.deepEqual(w.s.policy, policy);

  const w2 = saleWorld();
  w2.s.listed_price = PRICE.toString();
  assert.deepEqual((await sellBack(w2.chain, { spore: 2, run: 't', seller: SELLER, buyer: BUYER, operator: 'operator.testnet', policy, price: PRICE.toString() })).map((t) => t.method), ['delist']);
  w2.s.owner_id = 'stranger.testnet';
  await assert.rejects(() => sellBack(w2.chain, { spore: 2, run: 't', seller: SELLER, buyer: BUYER, operator: 'operator.testnet', policy, price: PRICE.toString() }), /neither party/);
});

test('unfitForSale: a spore the seller holds, run by the shared operator, with tubes to keep', () => {
  const fit = { spore_id: 2, active: true, policy: { paused: false }, owner_id: SELLER, operator_id: 'op', connections: [[1, '1'], [3, '1']] };
  const opts = { seller: SELLER, operator: 'op', hasOperatorKey: () => true };
  assert.equal(unfitForSale(fit, opts), null);
  assert.match(unfitForSale({ ...fit, owner_id: ROYALTY }, opts)!, /owned by/);
  assert.match(unfitForSale({ ...fit, operator_id: 'other' }, opts)!, /run by/);
  assert.match(unfitForSale({ ...fit, connections: [[1, '1']] }, opts)!, /fewer than 2/);
  assert.match(unfitForSale({ ...fit, listed_price: '1' }, opts)!, /listed/);
  assert.match(unfitForSale(fit, { ...opts, hasOperatorKey: () => false })!, /no operator key/);
});

test('one scene at a time: scenes share accounts', async () => {
  const slow: SceneDef = { id: 'slow', title: 'slow', command: () => nodeScript('setTimeout(()=>{},2000)'), preconditions: async () => [] };
  const other: SceneDef = { id: 'other', title: 'other', command: () => nodeScript('console.log("{}")'), preconditions: async () => [] };
  const server = createSceneServer({ scenes: [slow, other] });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const post = (id: string) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: `/scenes/${id}/run`, method: 'POST' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(d) }));
      });
      req.on('error', reject);
      req.end();
    });
  try {
    assert.equal((await post('slow')).status, 202);
    const refused = await post('other');
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /slow scene is running/);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
