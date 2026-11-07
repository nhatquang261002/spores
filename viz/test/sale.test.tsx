// S12: the Sale scene against the real run (test/fixtures/sale, a copy of the
// run's scene.jsonl on router4). The owner flips only on the buy's final outcome,
// payouts come only from receipt lines, and nothing reads as done before the log
// says so.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { partyAnchors, saleCastOf } from '../src/components/SaleStage';
import { metrics } from '../src/graph/stage';
import { buildSale, narrateSale, SALE_ACTS, SALE_CHECKS, saleDelay, saleRows } from '../src/model/sale';
import { durationMs, parseSceneLog, type SceneLine } from '../src/model/scene';
import type { Source } from '../src/model/types';
import { SaleScene } from '../src/pages/SaleScene';
import { SceneClient, type ServerScene } from '../src/sources/scene';
import { AppContext, type AppState } from '../src/state/source';
import { RenderQueueContext } from '../src/wasm/art';

const TEXT = readFileSync(path.join(__dirname, 'fixtures/sale/scene.jsonl'), 'utf8');
const LINES = parseSceneLog(TEXT);
const upTo = (pred: (l: SceneLine) => boolean) => LINES.slice(0, LINES.findIndex(pred) + 1);
const before = (pred: (l: SceneLine) => boolean) => LINES.slice(0, LINES.findIndex(pred));
const isBuyResult = (l: SceneLine) => l.type === 'result' && l.method === 'buy';
const isBuyStep = (l: SceneLine) => l.type === 'step' && l.method === 'buy';
const SELLER = 'owner.spores-hack.testnet';
const BUYER = 'buyer.spores-hack.testnet';
const OLD_KEY = "caller is not this spore's operator";
const OLD_OWNER = 'only the spore owner can do this';

/** The log with one line changed. */
const patched = (pred: (l: SceneLine) => boolean, change: object) => LINES.map((l) => (pred(l) ? { ...l, ...change } : l));

describe('buildSale on the real run', () => {
  const s = buildSale(LINES);

  it('completes only with every check passed and the real exit line', () => {
    expect(s.checks).toHaveLength(11);
    expect(s.checks.every((c) => c.ok)).toBe(true);
    expect(s.verdict).toEqual({ status: 'completed', line: 'Completed: 11 of 11 checks passed', failed: null });
    expect(buildSale(LINES.filter((l) => l.type !== 'exit')).verdict.status).toBe('running');
  });

  it('the numbered steps are the run’s own 11 checks, in order, each under its act', () => {
    expect(s.checks.map((c) => c.name)).toEqual(SALE_CHECKS.map((c) => c.name));
    const acts = new Set(SALE_ACTS.map((a) => a.key));
    expect(SALE_CHECKS.every((c) => acts.has(c.act))).toBe(true);
    // Each check lands inside the act the docket shows it under.
    let act = '';
    for (const l of LINES) {
      if (l.type === 'act') act = l.act;
      if (l.type === 'check') expect(SALE_CHECKS[l.n - 1].act).toBe(act);
    }
    expect(saleRows(s).every((r) => r.state === 'ok')).toBe(true);
    expect(saleRows(buildSale([])).every((r) => r.state === 'future')).toBe(true);
  });

  it('reads the payouts from the receipt lines: 95% to the seller, 5% royalty', () => {
    expect(s.payouts.seller).toMatchObject({ to: SELLER, amount: '475000000000000000000000', ok: true });
    expect(s.payouts.royalty).toMatchObject({ to: 'deployer.spores-hack.testnet', amount: '25000000000000000000000', ok: true });
    expect(BigInt(s.payouts.seller!.amount!) + BigInt(s.payouts.royalty!.amount!)).toBe(BigInt(s.start!.price));
  });

  it('has the refusals in the contract’s exact words, with real txs', () => {
    expect(s.oldKey).toMatchObject({ state: 'failed', err: OLD_KEY, expected: OLD_KEY });
    expect(s.oldOwner).toMatchObject({ state: 'failed', err: OLD_OWNER, expected: OLD_OWNER });
    for (const t of [s.oldKey, s.oldOwner, s.probe]) expect(t!.tx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{40,}$/);
    expect(s.probe!.state).toBe('ok');
  });

  it('shows from the chain’s two blocks what moved and what didn’t', () => {
    const { before: a, after: b } = s.diff!;
    expect([a.owner, b.owner]).toEqual([SELLER, BUYER]);
    expect(a.operator).toBe('operator.spores-hack.testnet');
    expect(b.operator).toBeNull();
    expect(b.policy.paused).toBe(true);
    expect(b.policy.budget_per_epoch).toBe('0');
    for (const k of ['balance', 'age', 'reputation', 'connections']) expect(b[k]).toEqual(a[k]);
    expect(a.connections.length).toBeGreaterThanOrEqual(2);
  });

  it('never says a spore is intact unless check 9 passed', () => {
    expect(s.intact).toBe(true);
    expect(buildSale(before((l) => l.type === 'check' && l.n === 9)).intact).toBe(false);
    const lied = buildSale(patched((l) => l.type === 'check' && l.n === 9, { ok: false, actual: 'balance 1' }));
    expect(lied.intact).toBe(false);
    expect(lied.verdict.status).toBe('failed');
    expect(lied.verdict.line).toContain('Failed at check 9');
    expect(narrateSale(buildSale(upTo((l) => l.type === 'check' && l.n === 9)))).toContain('kept all it grew');
    expect(narrateSale(buildSale(patched((l) => l.type === 'check' && l.n === 9, { ok: false }).slice(0, LINES.findIndex((l) => l.type === 'check' && l.n === 9) + 1)))).toContain('do not match');
  });
});

describe('the owner flips only on the buy’s final outcome', () => {
  it('listing changes nothing, a pending buy changes nothing', () => {
    expect(buildSale(before(isBuyStep))).toMatchObject({ owner: SELLER, listed: true, sold: false, buying: false });
    expect(buildSale(upTo(isBuyStep))).toMatchObject({ owner: SELLER, listed: true, sold: false, buying: true });
    expect(buildSale(upTo(isBuyResult))).toMatchObject({ owner: BUYER, listed: false, sold: true, buying: false });
  });

  it('a failed buy leaves the owner, however the rest of the log reads', () => {
    const failed = buildSale(patched(isBuyResult, { ok: false, err: 'attach exactly the listed price' }));
    expect(failed.owner).toBe(SELLER);
    expect(failed.sold).toBe(false);
  });

  it('no money moves before a receipt line says so', () => {
    expect(buildSale(upTo(isBuyResult)).payouts).toEqual({ seller: null, royalty: null });
    expect(buildSale(upTo((l) => l.type === 'payout')).payouts.royalty).toBeNull();
  });

  it('the old agent runs it until the sale; nobody runs it until the buyer says; then the new one', () => {
    const cast = (lines: SceneLine[]) => saleCastOf(buildSale(lines), null)!.operator;
    expect(cast(before(isBuyStep))).toBe('operator.spores-hack.testnet');
    expect(cast(upTo(isBuyResult))).toBeNull();
    expect(cast(upTo((l) => l.type === 'result' && l.method === 'register_operator'))).toBe('operator2.spores-hack.testnet');
  });

  it('the spore is locked from the sale until the buyer’s policy is final', () => {
    const at = (p: (l: SceneLine) => boolean) => buildSale(upTo(p));
    expect(at(isBuyResult)).toMatchObject({ sold: true, unlocked: false });
    expect(at((l) => l.type === 'result' && l.method === 'set_policy')).toMatchObject({ unlocked: true });
  });
});

describe('the story', () => {
  it('fits the first half minute: sold in under 10 s, the whole run in under 35', () => {
    const toBuy = durationMs(upTo(isBuyResult), 'story', saleDelay);
    expect(toBuy).toBeLessThan(10_000);
    const all = durationMs(LINES, 'story', saleDelay);
    expect(all).toBeLessThan(35_000);
    expect(all).toBeGreaterThan(15_000);
    // Real time is what the log says: the story only shortens the waiting.
    expect(durationMs(LINES, 'real', saleDelay)).toBeGreaterThan(all);
  });

  it('says what just happened, in order, with amounts from the log', () => {
    const says: string[] = [];
    for (let i = 1; i <= LINES.length; i++) {
      const line = narrateSale(buildSale(LINES.slice(0, i)));
      if (says.at(-1) !== line) says.push(line);
    }
    expect(says[0]).toContain('Spore #2');
    expect(says).toContain('Its owner puts it up for 0.50 NEAR.');
    expect(says).toContain('0.475 NEAR goes to the seller.');
    expect(says).toContain('Refused. That key opens nothing now.');
    expect(says).toContain('Refused. That money went with the spore.');
    expect(says.at(-1)).toBe('Same spore. New hands.');
    expect(says.indexOf('Refused. That key opens nothing now.')).toBeGreaterThan(says.indexOf('0.475 NEAR goes to the seller.'));
  });

  it('never calls a wrong outcome a refusal', () => {
    const accepted = patched((l) => l.type === 'result' && l.id === LINES.find((x) => x.type === 'step' && x.actor === 'agent')!.id, { ok: true, err: '' });
    const i = accepted.findIndex((l) => l.type === 'result' && l.method === 'post_job');
    expect(narrateSale(buildSale(accepted.slice(0, i + 1)))).toBe('The contract did not refuse as it should have.');
    const other = patched((l) => l.type === 'result' && l.method === 'withdraw', { err: 'something else' });
    const j = other.findIndex((l) => l.type === 'result' && l.method === 'withdraw');
    expect(narrateSale(buildSale(other.slice(0, j + 1)))).toBe('The contract did not refuse as it should have.');
  });

  it('a refusal in other words isn’t the refusal this step needed', () => {
    const lines = patched((l) => l.type === 'result' && l.method === 'post_job' && !l.ok, { err: 'policy: spore is paused' });
    const i = lines.findIndex((l) => l.type === 'result' && l.method === 'post_job');
    expect(narrateSale(buildSale(lines.slice(0, i + 1)))).toBe('The contract did not refuse as it should have.');
  });

  it('only the check about what it kept can say it kept it, or that it didn’t', () => {
    const lines = upTo((l) => l.type === 'check' && l.n === 8);
    const dead = buildSale([...lines, { type: 'check', n: 9, name: 'The scene ran to the end', ok: false, expected: 'no error', actual: 'rpc http 503' }]);
    expect(dead.intact).toBe(false);
    expect(narrateSale(dead)).not.toContain('do not match');
  });

  it('a dead script or a non-zero exit is a failure, never a completion', () => {
    expect(buildSale([...LINES.slice(0, 5), { type: 'fatal', error: 'rpc http 503' }]).verdict).toMatchObject({ status: 'failed', line: 'Failed: rpc http 503' });
    expect(buildSale(patched((l) => l.type === 'exit', { code: 1 })).verdict.line).toBe('Failed: the script exited with code 1');
    expect(narrateSale(buildSale(patched((l) => l.type === 'exit', { code: 1 })))).toBe('This run failed. The reason is below.');
  });

  it('a check that failed early can’t pass for a later one', () => {
    const lines: SceneLine[] = [LINES[0], { type: 'check', n: 1, name: 'The buyer can pay', ok: false, expected: 'at least 1', actual: '0' }, { type: 'done', ok: false, passed: 0, total: 1 }];
    const s = buildSale(lines);
    expect(s.verdict.line).toBe('Failed at check 1: expected at least 1, got 0');
    expect(saleRows(s)[0]).toMatchObject({ name: 'The buyer can pay', state: 'failed' });
    expect(saleRows(s)[1].state).toBe('future');
  });

  it('keeps unreadable lines visible', () => {
    expect(buildSale(parseSceneLog(`not json\n${JSON.stringify(LINES[0])}`)).bad).toEqual(['not json']);
  });
});

describe('the stage’s geometry', () => {
  it('keeps the parties’ lines clear of their words, on any stage', () => {
    for (const [w, h] of [[780, 720], [390, 560], [1000, 500]]) {
      const a = partyAnchors(w, h, metrics(w, h));
      expect(a.seller.x).toBeLessThan(w / 2);
      expect(a.buyer.x).toBeGreaterThan(w / 2);
      expect(a.seller.y).toBeLessThanOrEqual(h - 92);
      expect(a.buyer.y).toBeLessThanOrEqual(h - 92);
    }
  });
});

// --- the page -------------------------------------------------------------------

class FakeEventSource {
  readonly url: string;
  listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  closed = false;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(name: string, f: (e: MessageEvent<string>) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), f]);
  }
  emit(name: string, data = '{}') {
    for (const f of this.listeners.get(name) ?? []) f({ data } as MessageEvent<string>);
  }
  close() {
    this.closed = true;
  }
}

const READY: ServerScene = {
  id: 'sale',
  title: 'Sale and control transfer',
  running: false,
  run: null,
  preconditions: [
    { key: 'keys', label: 'Testnet keys in .env', ok: true },
    { key: 'spore', label: 'Spore #2 ready to sell', ok: true, pick: { spore: 2, provider: -1 } },
  ],
  reset: { blocked: 'Nothing to reset: no spore is with the buyer because of this scene.' },
};
const SOLD: ServerScene = {
  ...READY,
  preconditions: [{ key: 'clean', label: 'No spore left with the buyer by an earlier run', ok: false, detail: 'Run r sold spore 2. Use Reset to sell it back.' }],
  reset: { blocked: null },
};

function fakeClient(answer: ServerScene | Error, reset: () => Promise<Response> = async () => new Response('{"ok":true}')) {
  const sources: FakeEventSource[] = [];
  const posts: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(String(url));
      return String(url).endsWith('/reset') ? reset() : new Response('{"run":"r"}', { status: 202 });
    }
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify({ scenes: [answer] }));
  }) as typeof fetch;
  const client = new SceneClient('http://server.test', fetchFn, (u) => {
    const es = new FakeEventSource(u);
    sources.push(es);
    return es as unknown as EventSource;
  });
  return { client, sources, posts };
}

const LIVE: Source = { kind: 'live', network: 'testnet', router: 'spores-hack-router4.testnet' };
const RECORDED: Source = { kind: 'recorded', run: 'sale-real', date: '2026-11-06' };

function stubFiles() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u === '/recorded/index.json') return new Response(JSON.stringify([{ run: 'sale-real', date: '2026-11-06', scene: 'sale' }]));
      if (u === '/recorded/sale-real/scene.jsonl') return new Response(TEXT);
      return new Response('', { status: 404 });
    }),
  );
}

function fakeRouter(owner = SELLER, operator: string | null = 'operator.spores-hack.testnet') {
  return {
    id: 'spores-hack-router4.testnet',
    rpc: {},
    sporeSummary: vi.fn(async () => ({ owner_id: owner, operator_id: operator, connections: [[0, '77099']], balance: '504461724250000000000000', reputation: 1371, age: 27 })),
    renderInput: vi.fn(async (id: number) => ({ spore_id: id, seed: 'a'.repeat(64), age: 1, edges: [] })),
  };
}

function page(client: SceneClient, source: Source, router = fakeRouter()) {
  const state = {
    source,
    sourceError: null,
    reducedMotion: true,
    router: source.kind === 'live' ? router : null,
    epoch: { info: { epoch: 28 }, error: null, staleSince: null, retry: () => {} },
  } as unknown as AppState;
  return render(
    <RenderQueueContext.Provider value={() => Promise.reject(new Error('no renderer in this test'))}>
      <AppContext.Provider value={state}>
        <MemoryRouter initialEntries={['/lab/sale']}>
          <Routes>
            <Route path="/lab/sale" element={<SaleScene client={client} />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    </RenderQueueContext.Provider>,
  );
}

describe('Sale page', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  let rect: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stubFiles();
    window.scrollTo = vi.fn() as never;
    errors = vi.spyOn(console, 'error');
    // jsdom lays nothing out; the stage's words need a size to be placed.
    rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 780, height: 720, top: 0, left: 0, right: 780, bottom: 720, x: 0, y: 0, toJSON: () => ({}) });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    errors.mockRestore();
    rect.mockRestore();
  });
  const keyErrors = () => errors.mock.calls.filter((c: unknown[]) => /unique "key"|not wrapped in act/.test(String(c[0])));

  it('on LIVE it offers the recording first, shows the spore the chain has, and lists the 11 steps', async () => {
    const { client } = fakeClient(READY);
    page(client, LIVE);
    expect(await screen.findByText('What does a buyer actually get?')).toBeTruthy();
    expect((await screen.findByRole('link', { name: /Watch it happen/ })).getAttribute('href')).toContain('source=recorded');
    expect(await screen.findByText(/Spore #2 has 1 tube/)).toBeTruthy();
    const steps = screen.getByRole('list', { name: 'The 11 checks' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(11);
    expect(screen.getAllByText(/not reached yet/)).toHaveLength(11);
    expect(screen.queryByText(/checks passed/)).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Run it live on testnet' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('the idle stage names the owner and the agent the chain has, and no agent if it names none', async () => {
    const { client } = fakeClient(READY);
    page(client, LIVE, fakeRouter(BUYER, null));
    await screen.findByText(/Spore #2 has 1 tube/);
    await waitFor(() => expect(document.querySelector('.party-seller')?.textContent).toContain(BUYER));
    expect(document.querySelector('.party-agent')).toBeNull();
    expect(document.querySelector('.dish-label-name')?.textContent).toBe('buyer');
  });

  it('with no server there is no run, and no word about a server', async () => {
    const { client } = fakeClient(new Error('down'));
    page(client, LIVE);
    await screen.findByRole('heading', { name: 'What does a buyer actually get?' });
    expect(screen.queryByText(/scene-server|scene server/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Run it live/ })).toBeNull();
  });

  it('a spore left with the buyer: Reset takes the run’s place, in plain view, and only once', async () => {
    let finish = (_: Response) => {};
    const { client, posts } = fakeClient(SOLD, () => new Promise((r) => (finish = r)));
    page(client, LIVE);
    const reset = await screen.findByRole('button', { name: 'Reset: sell it back' });
    expect(screen.queryByRole('button', { name: 'Run it live on testnet' })).toBeNull();
    expect(screen.getByText(/second real sale/, { selector: '.scene-controls .scene-why' })).toBeTruthy();
    fireEvent.click(reset);
    const busy = await screen.findByRole('button', { name: 'Selling it back…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    expect(posts).toEqual(['http://server.test/scenes/sale/reset']);
    await act(async () => finish(new Response('{"ok":true}')));
  });

  it('after a reset the finished run leaves the stage: the chain has moved on', async () => {
    const { client, sources } = fakeClient({ ...SOLD, running: true, run: 'r' });
    page(client, LIVE);
    await waitFor(() => expect(sources).toHaveLength(1));
    act(() => {
      LINES.forEach((l) => sources[0].emit('scene', JSON.stringify(l)));
      sources[0].emit('end');
    });
    expect(screen.getByText('Same spore. New hands.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset: sell it back' }));
    expect(await screen.findByText(/Spore #2 has 1 tube/)).toBeTruthy();
    expect(screen.queryByText('Same spore. New hands.')).toBeNull();
    expect(screen.queryByText(/checks passed on testnet/)).toBeNull();
  });

  it('a failed reset says so; nothing pretends it worked', async () => {
    const { client } = fakeClient(SOLD, async () => new Response(JSON.stringify({ error: 'buy failed: attach exactly the listed price' }), { status: 500 }));
    page(client, LIVE);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset: sell it back' }));
    expect((await screen.findByRole('alert')).textContent).toContain('buy failed: attach exactly the listed price');
  });

  it('a live run: the label flips only when the buy’s outcome arrives, and "completed" waits for the exit line', async () => {
    const { client, sources, posts } = fakeClient(READY);
    page(client, LIVE);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Run it live on testnet' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Run it live on testnet' }));
    await waitFor(() => expect(sources).toHaveLength(1));
    expect(posts).toEqual(['http://server.test/scenes/sale/run']);
    const feed = (lines: SceneLine[]) => act(() => lines.forEach((l) => sources[0].emit('scene', JSON.stringify(l))));
    const label = () => document.querySelector('.dish-label:not(.is-peeling) .dish-label-name')?.textContent;

    feed(upTo(isBuyStep));
    expect(screen.getByText('A buyer attaches 0.50 NEAR. Nothing moves until the chain says so.')).toBeTruthy();
    expect(label()).toBe('owner');
    expect(document.querySelector('.price-tag')?.textContent).toContain('0.50 NEAR');

    const i = LINES.findIndex(isBuyStep);
    feed([LINES[i + 1]]);
    expect(LINES[i + 1].type).toBe('result');
    expect(label()).toBe('buyer');
    expect(document.querySelector('.price-tag')).toBeNull();

    feed(LINES.slice(i + 2, -1));
    expect(screen.queryByText(/checks passed on testnet/)).toBeNull();
    expect(screen.getByText(/Running on testnet/)).toBeTruthy();
    feed(LINES.slice(-1));
    expect(await screen.findByText('Completed: 11 of 11 checks passed')).toBeTruthy();
    expect(screen.getByText('11 / 11')).toBeTruthy();
    expect(sources[0].closed).toBe(false);
  });

  it('a recording plays by itself to the end, with the contract’s words in the proof', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client } = fakeClient(new Error('down'));
    page(client, RECORDED);
    // Each line sets the next one's timer, so each needs its own turn.
    for (let i = 0; i < LINES.length + 2; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
    }
    expect(screen.getByText('Same spore. New hands.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '↻ Watch again' })).toBeTruthy();
    expect(screen.getByText('Completed: 11 of 11 checks passed')).toBeTruthy();
    expect(document.querySelector('.scene-proof')!.textContent).toContain(OLD_KEY);
    expect(keyErrors()).toEqual([]);
  });

  it('a seek lands on an act, not on a guess', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client } = fakeClient(new Error('down'));
    page(client, RECORDED);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await screen.findByRole('button', { name: 'Jump to: New hands' });
    fireEvent.click(screen.getByRole('button', { name: 'Jump to: New hands' }));
    expect(screen.getByRole('button', { name: '↻ Watch again' })).toBeTruthy();
    expect(screen.getByText('Same spore. New hands.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Jump to: Old hands out' }));
    expect(document.querySelector('.dish-label:not(.is-peeling) .dish-label-name')?.textContent).toBe('buyer');
    fireEvent.click(screen.getByRole('button', { name: 'Jump to: Listed' }));
    expect(document.querySelector('.dish-label:not(.is-peeling) .dish-label-name')?.textContent).toBe('owner');
  });
});
