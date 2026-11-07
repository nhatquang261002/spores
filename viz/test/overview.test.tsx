// S14: the Overview against the real run the plate plays (test/fixtures/loop) and the
// real shape of the bulk views. The plate fits in 30 seconds, its arrow only ever points
// at what the current line is about, and the health line says what the chain has.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochInfo, Router } from '../src/chain/router';
import { handPath } from '../src/components/HandArrow';
import type { Gallery, GallerySpore } from '../src/model/gallery';
import { buildLoop, LOOP_ACTS, loopLines, loopRows, narrateLoop, type LoopAct, type LoopRun } from '../src/model/loop';
import type { Decision } from '../src/model/decisions';
import { narrateSale } from '../src/model/sale';
import { featuredOf, frameOfGallery, healthLine, healthOf, idleFor, IDLE_AFTER_MS, mapSummary } from '../src/model/overview';
import { deepLink, nextStop, noteWorthy, overviewDelay, plateSheet, plateTarget, shownStop, STOP_GLOSS } from '../src/model/plate';
import { hireExample, landingFacts } from '../src/model/landing';
import { LoopChain, LoopVein, stopWord } from '../src/components/LoopVein';
import { durationMs, parseSceneLog } from '../src/model/scene';
import type { Source } from '../src/model/types';
import { Overview } from '../src/pages/Overview';
import { AppContext, type AppState } from '../src/state/source';
import { RenderQueueContext } from '../src/wasm/art';

const DIR = path.join(__dirname, 'fixtures/loop');
const read = (f: string) => readFileSync(path.join(DIR, f), 'utf8');
const jsonl = (f: string) => read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const RUN: LoopRun = {
  run: JSON.parse(read('run.json')),
  events: jsonl('events.jsonl'),
  decisions: jsonl('decisions.jsonl'),
  snapshots: readdirSync(path.join(DIR, 'snapshots')).sort().map((f) => JSON.parse(read(`snapshots/${f}`))),
  scene: parseSceneLog(read('scene.jsonl')),
  report: JSON.parse(read('report.json')),
};
const LINES = loopLines(RUN);

const spore = (id: number, opts: { rep?: number; tubes?: [number, string][]; age?: number; active?: boolean } = {}): GallerySpore =>
  ({
    organism: { id, seed: 'ab'.repeat(32), palette: 0, age: opts.age ?? 10, tubes: opts.tubes ?? [], reputation: opts.rep ?? 0, active: opts.active ?? true, epoch: 7 },
    holding: { owner: 'o.testnet', listedPrice: null, sales: 0, transfers: 0, title: `Spore #${id}`, media: null },
    status: { status: 'activated', derived: false },
    image: { stateEpoch: 7, commit: null, input: { seed: 'ab'.repeat(32), age: 10, edges: [] } },
    glyph: null,
    pairsThisEpoch: 0,
  }) as unknown as GallerySpore;

const gallery = (spores: GallerySpore[], epoch = 7): Gallery => ({ epoch, spores, readAt: 1, coarseStatus: true });
const info = (over: Partial<EpochInfo> = {}): EpochInfo => ({ epoch: 7, started_ns: '0', ends_ns: String(1000 * 1e6), prev_fingerprint: 'x', active: [], pool: '0', flows: [], rejects: [], ...over });

describe('the plate', () => {
  it('tells the whole recording inside 32 seconds, each line still long enough to read', () => {
    expect(durationMs(LINES, 'story', overviewDelay)).toBeLessThanOrEqual(32_000);
    for (const type of ['wake', 'hired', 'paid', 'closed', 'rep', 'art']) {
      expect(overviewDelay(LINES.find((l) => l.type === type)!)).toBeGreaterThanOrEqual(2000);
    }
  });

  it('reaches the art before the viewer has waited 20 seconds', () => {
    const upToArt = LINES.slice(0, LINES.findIndex((l) => l.type === 'art') + 1);
    expect(durationMs(upToArt, 'story', overviewDelay)).toBeLessThan(20_000);
  });

  it('points at what each line is about, and never at a tube before its close', () => {
    const seen = new Set<string>();
    for (let i = 1; i <= LINES.length; i++) {
      const s = buildLoop(LINES.slice(0, i));
      const t = plateTarget(s);
      if (!t) continue;
      seen.add(t.at);
      if (t.at === 'tube') {
        expect(s.growth).toBeTruthy();
        expect(t.id).toBe(s.growth!.partner);
      }
      if (t.at === 'peer') expect(t.id).toBe(s.job!.winner);
    }
    expect([...seen].sort()).toEqual(['buyer', 'hero', 'label', 'peer', 'rim', 'royalty', 'seller', 'tube']);
  });

  it('holds each note long enough to read, and still says the sale and the refusal', () => {
    const notes: { text: string; at: number }[] = [];
    let at = 0;
    for (let i = 1; i <= LINES.length; i++) {
      const s = buildLoop(LINES.slice(0, i));
      const text = narrateLoop(s, narrateSale);
      if (s.beat !== 'none' && noteWorthy(s) && notes.at(-1)?.text !== text) notes.push({ text, at });
      at += overviewDelay(LINES[i - 1]);
    }
    notes.forEach((n, i) => {
      // The last one stays on screen: the story has ended.
      const next = notes[i + 1]?.at ?? Infinity;
      expect(next - n.at, n.text).toBeGreaterThanOrEqual(1200);
    });
    const all = notes.map((n) => n.text).join(' ');
    for (const words of ['classify', 'hires #11', 'pays', 'grew a new tube', 'picture', 'Sold', 'Refused', 'new hands']) expect(all).toContain(words);
    expect(notes.length).toBeLessThanOrEqual(16);
  });

  it('points at nothing before the story and after it: the finished plate is a diagram', () => {
    expect(plateTarget(buildLoop([]))).toBeNull();
    expect(plateTarget(buildLoop(LINES))).toBeNull();
  });

  it('gives every stop somewhere to see it for real', () => {
    for (const a of LOOP_ACTS) {
      const d = deepLink(a.key as LoopAct, 6);
      expect(d.path.startsWith('/')).toBe(true);
      expect(d.word.length).toBeGreaterThan(0);
    }
    expect(deepLink('hire', 6).path).toBe('/activity');
    expect(deepLink('grow', 6).path).toBe('/network');
    expect(deepLink('art', 6).path).toBe('/spore/6');
    expect(deepLink('art', null).path).toBe('/market');
    expect(deepLink('sell', 6).path).toBe('/market');
    expect(deepLink('control', 6).path).toBe('/lab/sale');
  });

  it('draws the same hand twice, and the arrow lands on its target', () => {
    const a = handPath({ x: 500, y: 300 }, { x: 100, y: 120 }, 40, 'a line');
    expect(handPath({ x: 500, y: 300 }, { x: 100, y: 120 }, 40, 'a line')).toEqual(a);
    expect(a.shaft.endsWith('L100.0 120.0')).toBe(true);
    expect(a.head).toContain('L100.0 120.0');
    expect(handPath({ x: 500, y: 300 }, { x: 100, y: 120 }, 40, 'another').shaft).not.toEqual(a.shaft);
  });
});

describe('the sheet beside the plate', () => {
  const at = (pred: (s: ReturnType<typeof buildLoop>) => boolean) => {
    for (let i = 1; i <= LINES.length; i++) {
      const s = buildLoop(LINES.slice(0, i));
      if (pred(s)) return s;
    }
    throw new Error('the story never reached that');
  };

  it('never shows a blank where the story already knows the value, even as the sale opens', () => {
    for (let i = 1; i <= LINES.length; i++) {
      const sheet = plateSheet(buildLoop(LINES.slice(0, i)));
      if (!sheet) continue;
      for (const v of [sheet.owner, sheet.balance, sheet.reputation, sheet.seed]) expect(v, `line ${i}`).toBeTruthy();
      expect(Number.isFinite(sheet.tubes)).toBe(true);
      expect(Number.isFinite(sheet.age)).toBe(true);
    }
    const opening = plateSheet(at((s) => s.saleStarted))!;
    expect(opening.balance).not.toBe('—');
  });

  it('follows the sale: active, for sale, locked, then active under the buyer', () => {
    expect(plateSheet(at((s) => !!s.frame && !s.saleStarted))!.status.word).toBe('Active');
    const listed = plateSheet(at((s) => s.sale.listed))!;
    expect(listed.status.word).toBe('For sale');
    expect(listed.status.why).toContain('0.50 NEAR');
    const sold = plateSheet(at((s) => s.sale.sold))!;
    expect(sold.status.word).toBe('Locked');
    expect(sold.owner).toBe('buyer.spores-hack.testnet');
    expect(sold.previousOwner).toBe('owner.spores-hack.testnet');
    expect(sold.agent).toBeNull();
    expect(sold.allowance).toBeNull();
    const after = plateSheet(buildLoop(LINES))!;
    expect(after.status.word).toBe('Active');
    expect(after.agent).toBe('operator2.spores-hack.testnet');
  });

  it('puts the sale\'s money with the account it went to, only once a receipt says so', () => {
    const sold = plateSheet(at((s) => s.sale.sold))!;
    expect(sold.previousDelta).toBeNull();
    const end = plateSheet(buildLoop(LINES))!;
    expect(end.ownerDelta).toBe('−0.50 NEAR');
    expect(end.previousDelta).toBe('+0.475 NEAR');
    expect(end.royalty).toEqual({ account: 'deployer.spores-hack.testnet', bps: 500, got: '+0.025 NEAR' });
  });
});

describe('the timeline', () => {
  it('a stop chosen lands where it has said everything: every stop has its figures there', () => {
    const start = (a: string) => LINES.findIndex((l) => l.type === 'act' && l.act === a);
    for (const a of LOOP_ACTS) {
      const next = nextStop(a.key);
      const lines = next ? LINES.slice(0, start(next)) : LINES;
      const s = buildLoop(lines);
      const rows = loopRows(s, !!s.checks);
      expect(shownStop(rows).key, a.key).toBe(a.key);
      expect(rows.find((r) => r.key === a.key)!.fact, a.key).toBeTruthy();
    }
    expect(nextStop('control')).toBeNull();
  });

  it('explains every stop, and shows the first before the story starts', () => {
    for (const a of LOOP_ACTS) expect(STOP_GLOSS[a.key].length).toBeGreaterThan(20);
    expect(shownStop(loopRows(buildLoop([]), false)).key).toBe('wake');
  });

  it('says each stop\'s state in a word, not only a colour', () => {
    const row = { key: 'hire', word: 'Hire', promise: '', fact: null, tx: null } as const;
    expect(stopWord({ ...row, state: 'past' }).word).toBe('done');
    expect(stopWord({ ...row, state: 'now' }).word).toBe('now');
    expect(stopWord({ ...row, state: 'future' }).word).toBe('to come');
    expect(stopWord({ ...row, state: 'past', warn: true }).word).toBe('failed');
  });

  it('across the page each stop is a name and a state, with the detail left to the panel', () => {
    const rows = loopRows(buildLoop(LINES), true);
    const { unmount } = render(<LoopVein rows={rows} returned={false} reducedMotion onSeek={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(8);
    expect(screen.getByRole('button', { name: /^Hire/ }).textContent).toBe('Hire✓ done');
    expect(screen.queryByRole('link')).toBeNull();
    unmount();
    // The Demo Lab's chain beside the stage keeps its figures and links.
    render(<LoopChain rows={rows} />);
    expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
    expect(screen.getByText(/the only quote/)).toBeTruthy();
    cleanup();
  });
});

describe('the landing page\'s evidence', () => {
  const facts = landingFacts(RUN)!;

  it('reads its figures from the run, not from the page', () => {
    expect(facts.hero).toBe(6);
    expect(facts.specimen.epoch).toBe(60);
    expect(facts.strongest!.id).toBe(11);
    expect(facts.growth).toMatchObject({ partner: 11, before: 0, after: 473807 });
    expect(facts.tubeHistory!.points[0]).toEqual({ epoch: 55, d: 0 });
    expect(facts.tubeHistory!.points.some((p) => p.d === 473807)).toBe(true);
    expect(facts.checks).toEqual({ passed: facts.checks!.total, total: facts.checks!.total });
    expect(facts.replay).toBe('replayed 30 decisions: 30 match, 0 differ');
  });

  it('shows a hire where history beat price, if the run has one, and the score really is the lowest', () => {
    const h = facts.hire!;
    expect(h.beatCheaper).toBe(true);
    const winner = h.quotes.find((q) => q.won)!;
    expect(winner.tube).toBe(true);
    expect(h.quotes.some((q) => BigInt(q.price) < BigInt(winner.price))).toBe(true);
    for (const q of h.quotes) expect(BigInt(winner.score) <= BigInt(q.score)).toBe(true);
    expect(hireExample([] as Decision[])).toBeNull();
  });

  it('quotes the sale and the contract\'s refusals as logged', () => {
    const s = facts.sale!;
    expect([s.price, s.sellerGot, s.royaltyGot]).toEqual(['500000000000000000000000', '475000000000000000000000', '25000000000000000000000']);
    expect(s.refusedKey!.err).toBe("caller is not this spore's operator");
    expect(s.refusedOwner!.err).toBe('only the spore owner can do this');
  });

  it('three different pictures, none after the sale', () => {
    expect(facts.arts.map((f) => f.epoch)).toEqual([55, 58, 60]);
  });

  it('says less rather than guess when a run has no spore to follow', () => {
    expect(landingFacts({ ...RUN, run: {}, report: null, decisions: [], snapshots: [], scene: [] })).toBeNull();
  });

  it('the fixed results on the page match what\'s committed', () => {
    const report = JSON.parse(read('report.json'));
    expect(report.verify.epochs.out.match(/^epoch \d+: \w+ match/gm)).toHaveLength(63);
    const wash = JSON.parse(readFileSync(path.join(__dirname, '../public/recorded/sim/wash.json'), 'utf8'));
    const j1 = wash.configs.find((c: { active: number; jobs: number }) => c.active === 64 && c.jobs === 1);
    expect([j1.cases, j1.gate_pass, j1.loses_money]).toEqual([270, 168, 270]);
    const rogue = readFileSync(path.join(__dirname, '../public/recorded/rogue-2026-11-06T02-04-56-137Z/scene.jsonl'), 'utf8');
    for (const err of ['policy: payment exceeds the per-payment cap', 'policy: epoch budget exceeded', 'policy: payee is not on the external allowlist']) expect(rogue).toContain(err);
  });
});

describe('collection health', () => {
  const g = gallery([spore(1, { rep: 900, tubes: [[2, '810000']] }), spore(2, { rep: 900, tubes: [[1, '810000']] }), spore(3, { active: false })]);

  it('counts each tube once, and says pairs, because the chain keeps per-pair totals', () => {
    const h = healthOf(g, info({ flows: [[1, 2, '100000000000000000000000']], rejects: [[1, 2, 2]] }));
    expect(h).toMatchObject({ active: 2, of: 3, tubes: 1, pairs: 1, rejected: 2 });
    expect(h.totalD).toBe(810000n);
    expect(healthLine(h)).toEqual(['2 of 3 active', '1 tube', '1 pair paid 0.10 NEAR this epoch']);
  });

  it('leaves out this epoch\'s money when the source has no epoch_info or a newer one', () => {
    expect(healthLine(healthOf(g, null))).toEqual(['2 of 3 active', '1 tube']);
    expect(healthOf(g, info({ epoch: 8, flows: [[1, 2, '1']] })).pairs).toBeNull();
  });

  it('never shows a guessed D: unknown D is zero tubes, not a number', () => {
    expect(healthOf(gallery([spore(1)]), null).totalD).toBe(0n);
  });

  it('says plainly that nothing has settled yet', () => {
    expect(healthLine(healthOf(g, info()))[2]).toBe('no payment settled this epoch yet');
  });

  it('builds the map frame from the same read, with no extra fetch', () => {
    const f = frameOfGallery(g, info(), 'edges');
    expect(f.kind).toBe('live');
    expect(f.tubes!.size).toBe(1);
    expect(f.active).toEqual([1, 2]);
    expect(f.reputation!.get(1)).toBe(900);
  });

  it('summarises the map for screen readers (Design §6.A)', () => {
    expect(mapSummary(g)).toBe('Network at epoch 7: 2 active spores, 1 tube; strongest tube #1–#2 D 0.81');
    expect(mapSummary(gallery([spore(5, { active: false })]))).toBe('Network at epoch 7: 0 active spores, 0 tubes.');
  });

  it('calls an epoch idle only after the keeper has clearly gone', () => {
    const i = info();
    expect(idleFor(null, 5000)).toBeNull();
    expect(idleFor(i, 1000 + IDLE_AFTER_MS)).toBeNull();
    expect(idleFor(i, 1000 + IDLE_AFTER_MS + 1)).toBe(IDLE_AFTER_MS + 1);
  });
});

describe('featured spores', () => {
  const ranked = [spore(1, { rep: 100 }), spore(2, { rep: 900 }), spore(3, { rep: 500 }), spore(4, { rep: 300 }), spore(5, { rep: 200 })];

  it('takes the four highest reputations and says so', () => {
    const f = featuredOf(gallery(ranked));
    expect(f.eyebrow).toBe('Highest reputation now');
    expect(f.spores.map((s) => s.organism.id)).toEqual([2, 3, 4, 5]);
  });

  it('fills up with the youngest, and the eyebrow changes to say it', () => {
    const f = featuredOf(gallery([spore(1, { rep: 100 }), spore(2, { age: 30 }), spore(3, { age: 2 }), spore(4, { age: 9 }), spore(5, { age: 50 })]));
    expect(f.eyebrow).toBe('Highest reputation now, then most recently activated');
    expect(f.spores.map((s) => s.organism.id)).toEqual([1, 3, 4, 2]);
  });

  it('with no reputation at all, says only the rule it used, and skips dormant spores', () => {
    const f = featuredOf(gallery([spore(1, { age: 3 }), spore(2, { active: false, age: 1 })]));
    expect(f.eyebrow).toBe('Most recently activated');
    expect(f.spores.map((s) => s.organism.id)).toEqual([1]);
  });
});

// The page, with its data faked at the network edge.
function page(state: Partial<AppState>, router: Partial<Router> | null, url = '/') {
  const app: AppState = { source: { kind: 'live', router: 'r.testnet' } as Source, sourceError: null, epoch: { info: null, lastOkAt: null, error: null, staleSince: null, retry: () => {} }, router: router as Router, reducedMotion: true, ...state };
  const queue = { request: () => Promise.reject(new Error('no renderer here')) };
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AppContext.Provider value={app}>
        <RenderQueueContext.Provider value={(() => Promise.resolve(queue)) as never}>
          <Routes>
            <Route path="/" element={<Overview />} />
          </Routes>
        </RenderQueueContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );
}

// The shape `allTokens` returns (chain/router.ts `SporeToken`).
const token = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  owner_id: 'o.testnet',
  title: `Spore #${id}`,
  glyph: null,
  extra: { seed: 'ab'.repeat(32), age: 5, active: true, listed_price: null, reputation: 0, sales: 0, transfers: 0, state_hash: 'cd'.repeat(32), image: null, ...over },
});

describe('the page', () => {
  beforeEach(() => {
    // Only the recording is served: the live region must not depend on it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps the words on screen when the chain can\'t be read, and names what failed', async () => {
    const down = new Error('rpc down');
    const router = { epochInfo: () => Promise.reject(down), allTokens: () => Promise.reject(down), edges: () => Promise.reject(down), config: () => Promise.reject(down) };
    page({}, router as never);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Sixty-four slime molds');
    expect(await screen.findByText(/Could not load the network/)).toBeTruthy();
    expect(screen.getByText(/Each Spore is an NFT with its own agent/)).toBeTruthy();
  });

  it('says what we are, what we do and how it works, even with no recording to read', async () => {
    const router = { epochInfo: () => Promise.reject(new Error('x')), allTokens: () => Promise.reject(new Error('x')), edges: () => Promise.reject(new Error('x')), config: () => Promise.reject(new Error('x')) };
    page({}, router as never);
    for (const name of [/A Spore is an NFT/, /We give an agent an owner/, /One loop, enforced by one contract/, /Don’t take our word/]) {
      expect(await screen.findByRole('heading', { level: 2, name })).toBeTruthy();
    }
    expect(screen.queryByRole('heading', { level: 2, name: /What this is, and what it isn’t/ })).toBeNull();
    expect(document.getElementById('about')).toBeNull();
    expect(await screen.findByText(/aren’t available right now, so only the words are here/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Verify it yourself' }).getAttribute('href')).toBe('/verify');
  });

  it('never fills the live region with the recording: no recording means it says so', async () => {
    const router = { epochInfo: () => Promise.reject(new Error('x')), allTokens: () => Promise.reject(new Error('x')), edges: () => Promise.reject(new Error('x')), config: () => Promise.reject(new Error('x')) };
    page({}, router as never);
    expect(await screen.findByText('No recording to play')).toBeTruthy();
  });

  it('with zero active spores, says what would change that', async () => {
    const zero = info({ epoch: 3, ends_ns: String((Date.now() + 20_000) * 1e6) });
    const tokens = [token(1, { active: false }), token(2, { active: false })];
    const router = { epochInfo: async () => zero, allTokens: async () => tokens, edges: async () => [], config: async () => ({}) };
    page({ epoch: { info: zero, lastOkAt: 1, error: null, staleSince: null, retry: () => {} } }, router as never);
    expect(await screen.findByText(/No spore is active yet. Every tube on this map will come from a settled payment/)).toBeTruthy();
    expect(screen.getByText('Epoch 3')).toBeTruthy();
  });

  it('says the network is quiet when an epoch has long been over', async () => {
    const old = info({ epoch: 9, ends_ns: String((Date.now() - 3 * 3_600_000) * 1e6) });
    const tokens = [token(1, { reputation: 900 }), token(2, { reputation: 900 })];
    const edges = [[1, 2, '810000']];
    const router = { epochInfo: async () => old, allTokens: async () => tokens, edges: async () => edges, config: async () => ({}) };
    page({ epoch: { info: old, lastOkAt: 1, error: null, staleSince: null, retry: () => {} } }, router as never);
    const region = (await screen.findByText(/The network is quiet right now/)).closest('section')!;
    expect(region.textContent).not.toMatch(/close_epoch|scripts\/|testnet/);
    expect(await within(region).findByText(/2 of 2 active · 1 tube/)).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'View as table' }).getAttribute('href')).toContain('view=table');
  });
});

describe('the scene server is only asked from its own machine', () => {
  it('a hosted page never knocks on a loopback server', async () => {
    const { canReachFrom, SceneClient } = await import('../src/sources/scene');
    expect(canReachFrom('http://127.0.0.1:8790', 'spores.example')).toBe(false);
    expect(canReachFrom('http://127.0.0.1:8790', '127.0.0.1')).toBe(true);
    expect(canReachFrom('http://127.0.0.1:8790', 'localhost')).toBe(true);
    expect(canReachFrom('https://scenes.example', 'spores.example')).toBe(true);
    expect(canReachFrom('http://127.0.0.1:8790', undefined)).toBe(true);
    vi.stubGlobal('location', { hostname: 'spores.example' });
    const f = vi.fn();
    await expect(new SceneClient('http://127.0.0.1:8790', f as never).list()).rejects.toThrow(/own machine/);
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
