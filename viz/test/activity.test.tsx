// S9: the Activity feed against the real phase5-exit2 logs (test/fixtures, a
// copy of out/agents/phase5-exit2): every decision recomputes like `spores-sim
// replay-decisions`, D values against the keeper's snapshots, filters, bad
// lines kept as rows; and receipts parsed from real tx outcomes (fetched from
// the archival node once and stored), never confirmed before a fetch.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError, type Rpc } from '../src/chain/rpc';
import type { Router } from '../src/chain/router';
import { CompactFeed } from '../src/components/EventFeed';
import { JobTimeline } from '../src/components/JobTimeline';
import { paintQuoteTube, type QuoteTubeSpec } from '../src/components/QuoteTube';
import {
  activeFilters,
  buildActivity,
  closeRow,
  filterRows,
  groupRows,
  jobRail,
  jobSteps,
  kindCounts,
  parseFilter,
  parseView,
  readLines,
  windowRows,
  writeFilter,
  writeView,
  type ActivityFilter,
} from '../src/model/activity';
import { byScore, decisionSummary, hireBars, hireVerb, readDecision, recompute, ruleCaption, tubeBeatCheaper, tubeCheck, type Decision } from '../src/model/decisions';
import { tubesFromTuples, type PairKey } from '../src/model/network';
import { receiptFromTx } from '../src/model/receipts';
import { Activity as ActivityPage } from '../src/pages/Activity';
import { parseEpochParam } from '../src/pages/Network';
import { fetchReceipt } from '../src/sources/activity';
import { linkTo, parseSource } from '../src/sources/source';
import { AppContext, type AppState } from '../src/state/source';
import type { EpochState } from '../src/state/epoch';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const dir = path.join(__dirname, 'fixtures/phase5-exit2');
const file = (n: string) => readFileSync(path.join(dir, n), 'utf8');
const DECISIONS = file('decisions.jsonl');
const EVENTS = file('events.jsonl');
const RUN = JSON.parse(file('run.json'));
const EDGES: Record<string, [number, number, string][]> = JSON.parse(file('edges.json'));
const SALE = JSON.parse(file('report.json')).sale;
const TXS: Record<string, any> = JSON.parse(file('txs.json'));

const tubesAt = new Map<number, Map<PairKey, number>>(Object.entries(EDGES).map(([k, e]) => [Number(k) - 1, tubesFromTuples(e)]));
const build = (over: Partial<Parameters<typeof buildActivity>[0]> = {}) =>
  buildActivity({ decisions: DECISIONS, events: EVENTS, startEpoch: RUN.start_epoch, router: RUN.router, sale: SALE, tubesAt, ...over });
const decisions = DECISIONS.trim().split('\n').map((l) => readDecision(JSON.parse(l)) as Decision);
const NONE: ActivityFilter = { spore: null, from: null, to: null, kinds: [], outcome: null };

describe('recompute (the same verdict as spores-sim replay-decisions)', () => {
  it('all 95 phase5-exit2 decisions match', () => {
    expect(decisions).toHaveLength(95);
    expect(decisions.map((d) => recompute(d).status).filter((s) => s !== 'matches')).toEqual([]);
    expect(build().stats).toMatchObject({ matches: 95, decisions: 95 });
  });

  it('catches a changed score, D_norm or winner, and names both values', () => {
    const d = decisions.find((x) => x.candidates.length > 1)!;
    const other = d.candidates.find((c) => c.provider !== d.winner)!.provider;
    const r = recompute({ ...d, winner: other });
    expect(r).toEqual({ status: 'differs', diffs: [{ what: 'winner', logged: `#${other}`, recomputed: `#${d.winner}` }] });
    const c0 = d.candidates[0];
    const bent = recompute({ ...d, candidates: [{ ...c0, score: '1' }, ...d.candidates.slice(1)] });
    expect(bent.status).toBe('differs');
    expect(bent.status === 'differs' && bent.diffs[0]).toMatchObject({ what: `#${c0.provider} score`, logged: '1', recomputed: c0.score });
  });

  it('uses the log`s rule, not constants: another w changes the scores', () => {
    const d = decisions.find((x) => x.candidates.some((c) => c.d !== '0'))!;
    expect(recompute({ ...d, rule: { w_bps: 10_000, norm: 'relative' } }).status).toBe('differs');
    expect(ruleCaption(d.rule)).toBe('score = quote / (1 + w·D_norm), w = 4.00 (w_bps 40000), D_norm relative to the largest candidate D; lowest score wins, ties → lower price → lower id');
    expect(ruleCaption({ w_bps: 20_000, norm: { absolute: '500000' } })).toContain('w = 2.00 (w_bps 20000), D_norm relative to D 0.50');
  });

  it('a rule it can`t read or a number that doesn`t parse is unverifiable, not a match', () => {
    const d = decisions[0];
    expect(recompute({ ...d, rule: { w_bps: 40_000, norm: 'other' } }).status).toBe('unverifiable');
    expect(recompute({ ...d, candidates: [{ ...d.candidates[0], price: 'x' }] }).status).toBe('unverifiable');
  });
});

describe('the derived sentence (Design §6.E)', () => {
  const base = { ...decisions[0], consumer: 3, winner: 7 };
  const c = (provider: number, price: string, d: string, score: string) => ({ provider, price, d, d_norm: d === '0' ? '0' : '1000000', score });
  it('single candidate', () => {
    expect(decisionSummary({ ...base, candidates: [c(7, '12000000000000000000000', '0', '12000000000000000000000')] })).toBe('Only one quote was in when the agent chose.');
  });
  it('the winner`s tube cut its quote; the runner-up has none', () => {
    const s = decisionSummary({ ...base, candidates: [c(7, '120000000000000000000000', '840000', '24000000000000000000000'), c(12, '90000000000000000000000', '0', '90000000000000000000000')] });
    expect(s).toBe('#7 won on effective price: its tube with #3 (D 0.84) cut its 0.12 NEAR quote to an effective 0.024 NEAR. #12 quoted 0.09 NEAR with no tube.');
  });
  it('the winner has no tube; the runner-up`s tube is named', () => {
    const s = decisionSummary({ ...base, candidates: [c(7, '50000000000000000000000', '0', '50000000000000000000000'), c(12, '500000000000000000000000', '100000', '100000000000000000000000')] });
    expect(s).toBe('#7 won on its 0.05 NEAR quote, with no tube. #12 quoted 0.50 NEAR, an effective 0.10 NEAR with its tube (D 0.10).');
  });
  it('sorts by the rule: score, then price, then id', () => {
    const sorted = byScore([c(9, '20', '0', '10'), c(4, '10', '0', '10'), c(1, '10', '0', '10'), c(2, '5', '0', '5')]);
    expect(sorted.map((x) => x.provider)).toEqual([2, 1, 4, 9]);
  });
});

describe('a decision as bars', () => {
  const YOCTO = 10n ** 24n;
  const c = (provider: number, price: bigint, d: string, score: bigint) => ({ provider, price: String(price), d, d_norm: d === '0' ? '0' : '1000000', score: String(score) });
  const base = { ...decisions[0], consumer: 3, winner: 7 };
  // #7 quotes 0.10 with a tube (effective 0.02); #12 quotes 0.05 with none; #9 quotes 0.20.
  const d = { ...base, candidates: [c(9, YOCTO / 5n, '0', YOCTO / 5n), c(12, YOCTO / 20n, '0', YOCTO / 20n), c(7, YOCTO / 10n, '840000', YOCTO / 50n)] };

  it('a tube beat a cheaper quote: 25 of the real 95, by the price and the score', () => {
    expect(decisions.filter(tubeBeatCheaper)).toHaveLength(25);
    expect(build().stats.tubeWins).toBe(25);
    expect(tubeBeatCheaper(d)).toBe(true);
    // The cheapest quote winning, or a tube with no cheaper rival, isn't this.
    expect(tubeBeatCheaper({ ...d, winner: 12 })).toBe(false);
    expect(tubeBeatCheaper({ ...d, candidates: [d.candidates[0], d.candidates[2]] })).toBe(false);
    expect(tubeBeatCheaper({ ...d, winner: null })).toBe(false);
  });

  it('bars follow the rule`s order on one zero-based scale; the winner is the log`s', () => {
    const bars = hireBars(d, YOCTO / 5n, 840_000);
    expect(bars.map((b) => b.candidate.provider)).toEqual([7, 12, 9]);
    expect(bars.map((b) => b.won)).toEqual([true, false, false]);
    expect(bars.map((b) => b.tube)).toEqual([true, false, false]);
    expect(bars[0]).toMatchObject({ quote: 0.5, effective: 0.1 });
    expect(bars[1]).toMatchObject({ quote: 0.25, effective: 0.25 });
    expect(bars[2]).toMatchObject({ quote: 1, effective: 1 });
    expect(hireBars(d, 0n, 0)[0].quote).toBe(0);
    // The map's own tube: width and brightness √D, against the log's largest D.
    expect(bars[0]).toMatchObject({ width: 7, alpha: 1 });
    expect(bars[1]).toMatchObject({ width: 1, alpha: 0.45 });
    expect(hireBars(d, YOCTO / 5n, 3_360_000)[0].width).toBeCloseTo(4, 1);
    expect(build().stats.maxD).toBe(Math.max(...decisions.flatMap((x) => x.candidates.map((c) => Number(c.d)))));
    expect(BigInt(build().stats.maxQuote)).toBe(decisions.flatMap((x) => x.candidates).reduce((m, x) => (BigInt(x.price) > m ? BigInt(x.price) : m), 0n));
  });

  it('the verb: only an accept that went through hired anyone', () => {
    expect(hireVerb({ ...d, tx: { accept: 'A' }, outcome: 'settled' })).toBe('#3 hired #7');
    expect(hireVerb({ ...d, tx: { accept: 'A' }, outcome: 'accept_failed' })).toBe('#3 picked #7');
    expect(hireVerb({ ...d, tx: {}, outcome: 'over_budget' })).toBe('#3 picked #7');
    expect(hireVerb({ ...d, winner: null })).toBe('#3 hired no one');
  });

  it('a candidate with an unreadable number is a bad line, not a crash', () => {
    const bad = JSON.stringify({ ...JSON.parse(DECISIONS.split('\n')[0]), job_id: 9999, candidates: [{ provider: 1, price: 'x', d: '0', d_norm: '0', score: '1' }] });
    const rows = build({ decisions: `${DECISIONS}${bad}\n` }).rows;
    expect(rows.find((r) => r.kind === 'unreadable')?.summary).toBe('decisions.jsonl line 96: a candidate has an unreadable number');
    expect(rows.filter((r) => r.kind === 'decision')).toHaveLength(95);
  });
});

describe('the quote tube', () => {
  /** Records what is painted, with each path's x range. */
  function fake() {
    const fills: { style: unknown; xs: number[] }[] = [];
    const strokes: { xs: number[] }[] = [];
    const arcs: { x: number; r: number }[] = [];
    let xs: number[] = [];
    const ctx = {
      fillStyle: '' as unknown,
      strokeStyle: '',
      lineWidth: 0,
      lineCap: '',
      setTransform() {},
      clearRect() {},
      beginPath() { xs = []; },
      moveTo(x: number) { xs.push(x); },
      lineTo(x: number) { xs.push(x); },
      closePath() {},
      stroke() { strokes.push({ xs }); },
      fill() { fills.push({ style: this.fillStyle, xs }); },
      arc(x: number, _y: number, r: number) { arcs.push({ x, r }); },
      createLinearGradient: () => ({ addColorStop() {} }),
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, strokes, arcs };
  }
  const spec: QuoteTubeSpec = { quote: 1, effective: 0.25, tube: true, width: 5, alpha: 1, won: true, from: 0, to: 3 };

  it('a tube: a body up to the effective price, a node there, then it fades out at the quote', () => {
    const f = fake();
    paintQuoteTube(f.ctx, 206, 32, spec);
    // Halo, body and core, as the map draws them, all ending at the node.
    const body = f.fills.filter((x) => typeof x.style === 'object');
    expect(body).toHaveLength(3);
    for (const b of body) expect(Math.max(...b.xs)).toBeCloseTo(53, 1);
    expect(f.arcs).toHaveLength(1);
    expect(f.arcs[0].x).toBeCloseTo(53, 1);
    // The faded part runs from the node to the quote, and nothing is a bare thread.
    const fade = f.fills.find((x) => typeof x.style === 'string' && x.xs.length > 0)!;
    expect(Math.min(...fade.xs)).toBeCloseTo(53, 1);
    expect(Math.max(...fade.xs)).toBeCloseTo(203, 0);
    expect(f.strokes).toHaveLength(0);
  });
  it('a stronger tube paints wider than a weak one', () => {
    const half = (width: number) => {
      const f = fake();
      const ys: number[] = [];
      const ctx = f.ctx as unknown as { lineTo: (x: number, y: number) => void };
      ctx.lineTo = (_x, y) => { ys.push(y); };
      paintQuoteTube(f.ctx, 206, 32, { ...spec, width });
      return Math.max(...ys);
    };
    expect(half(7)).toBeGreaterThan(half(2));
  });
  it('no tube: no body at all, only the thin line up to the quote and the node', () => {
    const f = fake();
    paintQuoteTube(f.ctx, 206, 32, { ...spec, tube: false, effective: 0.5, quote: 0.5, width: 1, alpha: 0.25 });
    expect(f.fills.filter((x) => typeof x.style === 'object')).toHaveLength(0);
    expect(f.strokes).toHaveLength(1);
    expect(f.strokes[0].xs[0]).toBe(0);
    expect(f.strokes[0].xs[1]).toBeCloseTo(103, 0);
    expect(f.arcs[0].x).toBeCloseTo(103, 0);
  });
  it('a zero width paints nothing', () => {
    const f = fake();
    paintQuoteTube(f.ctx, 0, 32, spec);
    expect(f.fills.length + f.strokes.length + f.arcs.length).toBe(0);
  });
});

describe('tube check', () => {
  const lookup = (e: number) => tubesAt.get(e);
  it('all 95 decisions read the tubes of the close before them', () => {
    expect(decisions.map((d) => tubeCheck(d, lookup).status).filter((s) => s !== 'match')).toEqual([]);
    expect(tubeCheck(decisions[0], lookup)).toEqual({ status: 'match', epoch: decisions[0].epoch - 1 });
  });
  it('says differ with both values, and needs when the source has no such close', () => {
    const d = decisions.find((x) => x.candidates.some((c) => c.d !== '0'))!;
    const c = d.candidates.find((x) => x.d !== '0')!;
    const out = tubeCheck({ ...d, candidates: [{ ...c, d: '1' }] }, lookup);
    expect(out).toEqual({ status: 'differ', epoch: d.epoch - 1, diffs: [{ provider: c.provider, logged: '1', close: c.d }] });
    expect(tubeCheck(d, () => null)).toEqual({ status: 'needs', epoch: d.epoch - 1 });
  });
});

describe('rows from the run log', () => {
  const a = build();
  const counts = kindCounts(a.rows);

  it('keeps every decision and a row per settle, refund, close, image and failed tx', () => {
    expect(counts.get('decision')).toBe(95);
    // 57 settle + 27 pay_service + auto-settled timeouts
    const auto = a.rows.filter((r) => r.word === 'Auto-settled').length;
    expect(counts.get('settlement')).toBe(57 + 27 + auto);
    expect(counts.get('close')).toBe(8);
    expect(counts.get('image')).toBe(72);
    expect(counts.get('unreadable')).toBeUndefined();
    // 20 quote + 18 accept + the sale's post_job and withdraw lockout checks
    expect(counts.get('refusal')).toBe(20 + 18 + 2);
    expect(a.stats).toMatchObject({ decisionLines: 95, eventLines: 895 });
  });

  it('the sale: the spore comes from the report, and the lockouts are refused by the contract', () => {
    const market = a.rows.filter((r) => r.kind === 'market');
    expect(market.map((r) => r.word).filter(Boolean)).toEqual(['Listed', 'Sold']);
    expect(market.every((r) => r.spores.includes(5))).toBe(true);
    const sold = market.find((r) => r.word === 'Sold')!;
    expect(sold.summary).toBe('#5 sold · 0.50 NEAR · to buyer.spores-hack.testnet');
    const lock = a.rows.find((r) => r.kind === 'refusal' && r.summary.includes('old operator key'))!;
    expect(lock.summary).toBe('Refused by the contract: #5 post_job (old operator key posts a job (must fail))');
    expect(lock.receipt?.error).toBe("caller is not this spore's operator");
    expect(lock.spores).toContain(5);
  });

  it('a failure that isn`t a contract panic never reads "refused"', () => {
    const line = JSON.stringify({ at: '2026-11-03T00:00:00Z', spore: 3, kind: 'tx', method: 'quote', args: { job_id: 1, spore_id: 3 }, hash: 'H', ok: false, err: '{"message":"Request timeout"}' });
    const r = buildActivity({ decisions: '', events: line, startEpoch: 1, router: null }).rows[0];
    expect(r.word).toBe('Failed');
    expect(r.summary).toBe('Tx failed: #3 quote');
    expect(r.receipt?.kind).toBe('failed');
  });

  it('only says "hired" after an accept went through', () => {
    const failed = a.rows.find((r) => r.outcome === 'accept_failed' && r.kind === 'decision')!;
    expect(failed.summary).toMatch(/^#\d+ picked #\d+/);
    const settled = a.rows.find((r) => r.outcome === 'settled' && r.kind === 'decision')!;
    expect(settled.summary).toMatch(/^#\d+ hired #\d+/);
  });

  it('a settle row takes pair and price from its decision, and stays Logged', () => {
    const d = decisions.find((x) => x.outcome === 'settled')!;
    const r = a.rows.find((x) => x.tx === d.tx.settle && x.kind === 'settlement')!;
    const price = d.candidates.find((c) => c.provider === d.winner)!.price;
    expect(r.spores).toEqual([d.consumer, d.winner]);
    expect(r.receipt).toMatchObject({ evidence: 'logged', from: d.consumer, to: d.winner, amount: price });
    expect(r.receipt?.fee).toBeUndefined();
  });

  it('epochs: log time between close lines; a close belongs to the epoch it closed', () => {
    const closes = a.rows.filter((r) => r.kind === 'close');
    expect(closes.map((r) => r.epoch).sort((x, y) => x! - y!)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    const c = closes.find((r) => r.epoch === 9)!;
    expect(c.receipt).toMatchObject({ fingerprint: 'dcf6b86d2c47abf755b623d1d5bf79963fc7c37e9ae8959ad8da4ca1257a21f2', tubes: tubesAt.get(9)!.size, flowsDerived: true });
    expect(c.summary).toContain('Epoch 9 closed · ≈');
  });

  it('job steps not listed as rows are counted, in a timeline or as without a decision', () => {
    const tx = EVENTS.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'tx' && ['post_job', 'quote', 'accept', 'deliver', 'settle', 'reject', 'timeout_job'].includes(e.method) && e.spore !== 'sale' && (e.method !== 'post_job' || e.ok));
    expect(a.stats.inTimelines + a.stats.withoutDecision).toBe(tx.length);
  });

  it('routine notes merge into one row per epoch and keep every line', () => {
    const groups = groupRows(a.rows, a.rows);
    const merged = groups.flatMap((g) => g.rows).filter((r) => r.key.startsWith('notes:'));
    expect(merged.length).toBeGreaterThan(0);
    expect(merged.map((r) => r.summary).join(' ')).toMatch(/\d+ margin changes/);
    const raw = merged.reduce((n, r) => n + r.raw.length, 0);
    const single = a.rows.filter((r) => r.note && !merged.some((m) => m.raw.includes(r.raw[0]))).length;
    const lines = EVENTS.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => ['margin', 'outside', 'start', 'stop', 'exit', 'done'].includes(e.kind)).length;
    expect(raw + single).toBe(lines);
  });

  it('an abnormal exit is not routine', () => {
    const line = JSON.stringify({ at: '2026-11-03T00:00:00Z', spore: 'run', kind: 'exit', name: 'agent-3', code: 1 });
    expect(buildActivity({ decisions: '', events: line, startEpoch: 1, router: null }).rows[0]).toMatchObject({ summary: 'agent-3 exited with code 1', word: 'Exited', tone: 'warn' });
  });
});

describe('job timeline', () => {
  const a = build();
  it('a settled job: post, quotes, accept, deliver, settle, each with its tx', () => {
    const d = decisions.find((x) => x.outcome === 'settled' && x.candidates.length > 1)!;
    const steps = jobSteps(d, a);
    expect(steps[0]).toMatchObject({ key: 'post', state: 'ok', tx: d.tx.post });
    expect(steps.filter((s) => s.key.startsWith('quote')).length).toBeGreaterThanOrEqual(d.candidates.length);
    expect(steps.find((s) => s.key.startsWith('accept'))).toMatchObject({ state: 'ok', tx: d.tx.accept });
    expect(steps.find((s) => s.key.startsWith('settle'))).toMatchObject({ state: 'ok', tx: d.tx.settle });
    expect(steps.some((s) => s.key.startsWith('deliver'))).toBe(true);
  });
  it('a quote the agent didn`t choose from says so', () => {
    const d = decisions.find((x) => x.candidates.length === 1)!;
    const other = 63;
    const line = { at: d.at, spore: other, kind: 'tx', method: 'quote', args: { job_id: d.job_id, spore_id: other, price: '5' }, hash: 'Late', ok: true };
    const steps = jobSteps(d, { jobLines: new Map([[d.job_id, [line]]]), postLines: new Map() });
    expect(steps.find((s) => s.key === 'quote:Late')!.note).toContain('Not a candidate');
  });

  it('a refused accept quotes the contract`s words verbatim', () => {
    const d = decisions.find((x) => x.outcome === 'accept_failed')!;
    const s = jobSteps(d, a).find((x) => x.key.startsWith('accept'))!;
    expect(s).toMatchObject({ state: 'failed', err: 'insufficient balance', tx: d.tx.accept });
  });
  it('an accept the agent didn`t send says so, and doesn`t claim the contract refused', () => {
    const d = { ...decisions[0], outcome: 'over_budget', budget_left: '100000000000000000000000', tx: { post: decisions[0].tx.post } };
    const none = jobSteps(d, { jobLines: new Map(), postLines: new Map() });
    const s = none.find((x) => x.key === 'accept')!;
    expect(s.state).toBe('skipped');
    expect(s.note).toContain('Not sent: the agent read budget left 0.10 NEAR');
    expect(s.note).not.toMatch(/refused/i);
  });
  it('the rail: four stages, from the job`s own lines', () => {
    const states = (o: string) => {
      const d = decisions.find((x) => x.outcome === o)!;
      return jobRail(d, jobSteps(d, a)).map((s) => s.state);
    };
    expect(states('settled')).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(states('accept_failed')).toEqual(['ok', 'ok', 'failed', 'none']);
    const d = { ...decisions[0], outcome: 'over_budget', tx: { post: decisions[0].tx.post } };
    const none = { jobLines: new Map(), postLines: new Map() };
    // Quotes come from the decision's candidates when the event log has no line; an accept never sent is not a failure.
    expect(jobRail(d, jobSteps(d, none)).map((s) => s.state)).toEqual(['ok', 'ok', 'skipped', 'none']);
    expect(jobRail({ ...d, candidates: [] }, jobSteps({ ...d, candidates: [] }, none))[1].state).toBe('none');
  });
  it('draws state with a glyph and a word, and a tx as Logged', () => {
    const { container } = render(<JobTimeline steps={[{ key: 'a', label: '#1 accepts #2', state: 'failed', err: 'insufficient balance', tx: 'HashHashHash' }]} />);
    expect(container.textContent).toContain('✕');
    expect(container.textContent).toContain('insufficient balance');
    expect(container.querySelector('a')!.textContent).toContain('○');
    expect(container.querySelector('a')!.getAttribute('aria-label')).toContain('logged tx');
  });
});

describe('malformed lines', () => {
  it('become rows, name the file and line, and pass every filter', () => {
    const lines = DECISIONS.trim().split('\n');
    const bad = [lines[0], '{not json', JSON.stringify({ at: 'x', epoch: 1 }), ...lines.slice(1)].join('\n');
    const a = build({ decisions: bad, events: EVENTS.replace(/\n/, '\n{"at":"nope","kind":"tx"}\n') });
    const rows = a.rows.filter((r) => r.kind === 'unreadable');
    expect(rows.map((r) => r.summary)).toEqual([
      'decisions.jsonl line 2: not JSON',
      'decisions.jsonl line 3: no valid `at`',
      'events.jsonl line 2: no valid `at` or `kind`',
    ]);
    expect(rows[0].raw[0].text).toBe('{not json');
    // The good lines are all still there.
    expect(a.rows.filter((r) => r.kind === 'decision')).toHaveLength(95);
    const only = filterRows(a.rows, { ...NONE, spore: 63, kinds: ['close'], outcome: 'settled' });
    expect(only.filter((r) => r.kind === 'unreadable')).toHaveLength(3);
    expect(groupRows(only, a.rows)[0]).toMatchObject({ key: 'unreadable', unreadable: true });
  });
  it('readLines skips blank lines and keeps line numbers', () => {
    expect(readLines('{"a":1}\n\n{"b":2}\n', 'f').map((l) => l.line)).toEqual([1, 3]);
  });
  it('a missing file is named, not treated as empty', () => {
    expect(build({ decisions: null }).missing).toEqual(['decisions.jsonl']);
  });
});

describe('filters', () => {
  const a = build();
  it('by spore, epoch, kind and outcome', () => {
    const bySpore = filterRows(a.rows, { ...NONE, spore: 5 });
    expect(bySpore.length).toBeGreaterThan(0);
    expect(bySpore.every((r) => r.spores.includes(5))).toBe(true);
    const byEpoch = filterRows(a.rows, { ...NONE, from: 11, to: 12 });
    expect(new Set(byEpoch.map((r) => r.epoch))).toEqual(new Set([11, 12]));
    expect(filterRows(a.rows, { ...NONE, kinds: ['decision'] })).toHaveLength(95);
    const out = filterRows(a.rows, { ...NONE, kinds: ['decision'], outcome: 'accept_failed' });
    expect(out).toHaveLength(18);
    expect(filterRows(a.rows, { ...NONE, kinds: ['decision'], outcome: 'settled' })).toHaveLength(57);
    expect(filterRows(a.rows, { ...NONE, kinds: ['decision', 'close'], from: 9, to: 9 }).some((r) => r.kind === 'close')).toBe(true);
  });
  it('round-trips through the URL and keeps the source', () => {
    const q = new URLSearchParams('source=run&run=x&spore=5&from=10&to=12&kind=decision,close,nope&outcome=settled');
    const f = parseFilter(q);
    expect(f).toEqual({ spore: 5, from: 10, to: 12, kinds: ['decision', 'close'], outcome: 'settled' });
    expect(activeFilters(f)).toBe(4);
    const back = writeFilter(q, { ...f, spore: null, outcome: null });
    expect(back.get('source')).toBe('run');
    expect(back.has('spore')).toBe(false);
    expect(back.get('kind')).toBe('decision,close');
    expect(parseFilter(new URLSearchParams('epoch=17'))).toMatchObject({ from: 17, to: 17 });
    expect(parseFilter(new URLSearchParams('spore=abc')).spore).toBeNull();
  });
  it('the tube filter, the view and their URLs', () => {
    expect(filterRows(a.rows, { ...NONE, tube: true })).toHaveLength(25);
    expect(parseFilter(new URLSearchParams('tube=1')).tube).toBe(true);
    expect(parseFilter(new URLSearchParams('tube=0')).tube).toBeUndefined();
    expect(activeFilters({ ...NONE, tube: true })).toBe(1);
    expect(writeFilter(new URLSearchParams('tube=1&run=x'), NONE).toString()).toBe('run=x');
    expect(parseView(new URLSearchParams(''))).toBe('decisions');
    expect(parseView(new URLSearchParams('view=log'))).toBe('log');
    expect(parseView(new URLSearchParams('kind=market'))).toBe('log');
    const toLog = writeView(new URLSearchParams('run=x&spore=5&tube=1'), 'log');
    expect(toLog.toString()).toBe('run=x&spore=5&view=log');
    expect(writeView(new URLSearchParams('run=x&spore=5&view=log&kind=close'), 'decisions').toString()).toBe('run=x&spore=5');
  });
  it('the header reads the epoch`s close even when filters hide its row', () => {
    const groups = groupRows(filterRows(a.rows, { ...NONE, kinds: ['decision'] }), a.rows);
    const g = groups.find((x) => x.epoch === 10)!;
    expect(g.rows.every((r) => r.kind === 'decision')).toBe(true);
    expect(g.close?.receipt?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
  it('groups newest first, rows newest first', () => {
    const groups = groupRows(a.rows, a.rows);
    const epochs = groups.map((g) => g.epoch);
    expect(epochs).toEqual([...epochs].sort((x, y) => y! - x!));
    for (const g of groups) for (let i = 1; i < g.rows.length; i++) expect(g.rows[i - 1].at! >= g.rows[i].at!).toBe(true);
  });
});

describe('the row window', () => {
  const groups = [
    { key: 'a', rows: Array.from({ length: 100 }, (_, i) => ({ key: `a${i}` })) },
    { key: 'b', rows: Array.from({ length: 100 }, (_, i) => ({ key: `b${i}` })) },
  ];
  it('renders only rows near the view and keeps the total height', () => {
    const w = windowRows(groups, () => 50, 40, 1000, 2000);
    const a = w.get('a')!;
    expect(a.from).toBe(19);
    expect(a.to).toBe(40);
    expect(a.top + a.bottom + (a.to - a.from) * 50).toBe(100 * 50);
    expect(w.get('b')).toEqual({ from: 0, to: 0, top: 5000, bottom: 0 });
    const far = windowRows(groups, () => 50, 40, 6000, 7000);
    expect(far.get('a')).toEqual({ from: 0, to: 0, top: 5000, bottom: 0 });
    expect(far.get('b')!.from).toBeGreaterThan(0);
  });
  it('measured heights count', () => {
    const tall = windowRows(groups, (k) => (k === 'a0' ? 1000 : 50), 40, 0, 500);
    expect(tall.get('a')).toMatchObject({ from: 0, to: 1 });
  });
});

describe('receipts from real tx outcomes', () => {
  it('settle: job_settled with price, fee and epoch', () => {
    const r = receiptFromTx(TXS.settle, 123);
    expect(r).toMatchObject({ evidence: 'confirmed', kind: 'settlement', event: 'job_settled', from: 5, to: 6, amount: '136800000000000000000000', fee: '1368000000000000000000', epoch: 10, auto: false, signer: 'operator.spores-hack.testnet' });
    expect(r.block).toEqual({ hash: TXS.settle.transaction_outcome.block_hash, height: 123 });
    expect(r.tx).toBe('FjKuFLGR8eztbobqiCEB2U6sqJ2ab5v3GCA7m698ib9j');
  });
  it('reject: job_refunded with its reason', () => {
    expect(receiptFromTx(TXS.reject)).toMatchObject({ kind: 'refund', event: 'job_refunded', from: 4, to: 5, reason: 'rejected' });
  });
  it('timeout of a delivered job: auto-settled', () => {
    expect(receiptFromTx(TXS.timeout_delivered)).toMatchObject({ kind: 'settlement', auto: true, from: 6, to: 7 });
  });
  it('timeout of an open job: refund of 0 with no provider', () => {
    expect(receiptFromTx(TXS.timeout_other)).toMatchObject({ kind: 'refund', amount: '0', to: null, reason: 'timeout' });
  });
  it('pay_service: the payee and memo', () => {
    expect(receiptFromTx(TXS.pay_service)).toMatchObject({ kind: 'service', from: 0, payee: 'outside.spores-hack.testnet', amount: '10000000000000000000000' });
  });
  it('buy: the sale, not the job refunds or the transfer logged with it', () => {
    const r = receiptFromTx(TXS.buy);
    expect(r).toMatchObject({ kind: 'sale', event: 'spore_sold', spore: 5, seller: 'owner.spores-hack.testnet', buyer: 'buyer.spores-hack.testnet', amount: '500000000000000000000000' });
    expect(BigInt(r.sellerAmount!) + BigInt(r.royalty!)).toBe(BigInt(r.amount!));
  });
  it('list: a market receipt', () => {
    expect(receiptFromTx(TXS.list)).toMatchObject({ kind: 'market', event: 'spore_listed', spore: 5 });
  });
  it('commit_image: hashes and renderer version', () => {
    expect(receiptFromTx(TXS.commit_image)).toMatchObject({ kind: 'image', spore: 0, epoch: 10, imageHash: 'c3003680d92543ebc4fe7ce3f228cda94d6aabdbfdab638bcd2b83be8f371663' });
  });
  it('close_epoch: the fingerprint and counts', () => {
    expect(receiptFromTx(TXS.close_epoch)).toMatchObject({ kind: 'close', epoch: 9, fingerprint: 'dcf6b86d2c47abf755b623d1d5bf79963fc7c37e9ae8959ad8da4ca1257a21f2', signer: 'deployer.spores-hack.testnet' });
  });
  it('a refused accept: the contract`s error verbatim, no prefix, no amounts', () => {
    const r = receiptFromTx(TXS.accept_refused);
    expect(r).toMatchObject({ kind: 'refusal', event: 'accept', error: 'insufficient balance' });
    expect(r.amount).toBeUndefined();
  });
  it('a bounced payout is shown beside the receipt', () => {
    const tx = structuredClone(TXS.buy);
    tx.receipts_outcome[0].outcome.logs.push('EVENT_JSON:{"standard":"spores","version":"1.0.0","event":"sale_payment_failed","data":[{"spore_id":5,"role":"royalty"}]}');
    expect(receiptFromTx(tx).warnings?.[0]).toContain('sale_payment_failed');
  });
});

const rpcFor = (results: Record<string, any>) => {
  const call = vi.fn(async (method: string, params: any) => {
    if (method === 'block') return { header: { height: 276000000 } };
    const r = results[params.tx_hash];
    if (!r) throw new RpcError('https://node', `UNKNOWN_TRANSACTION: ${params.tx_hash}`, 'rpc', 'UNKNOWN_TRANSACTION');
    return r;
  });
  return { archivalUrls: [], call } as unknown as Rpc & { call: typeof call };
};

describe('fetchReceipt', () => {
  it('confirms only what the named router received, and caches it', async () => {
    const h = TXS.settle.transaction.hash;
    const rpc = rpcFor({ [h]: TXS.settle });
    const r = await fetchReceipt(rpc, h, null, 'spores-hack-router4.testnet');
    expect(r).toMatchObject({ evidence: 'confirmed', block: { height: 276000000 } });
    expect(JSON.parse(localStorage.getItem(`spores.receipt.v1.${h}`)!).evidence).toBe('confirmed');
    await expect(fetchReceipt(rpc, h, null, 'other.testnet')).rejects.toThrow(/was sent to spores-hack-router4.testnet, not other.testnet/);
  });
  it('a failed block read still confirms the outcome', async () => {
    const h = TXS.settle.transaction.hash;
    const rpc = { archivalUrls: [], call: vi.fn(async (m: string) => {
      if (m === 'block') throw new Error('rate limited');
      return TXS.settle;
    }) } as unknown as Rpc;
    expect((await fetchReceipt(rpc, h, 'x', null)).block?.height).toBeNull();
  });
});

// --- the page ---------------------------------------------------------------

const EPOCH: EpochState = { info: null, error: null, staleSince: null, observedAt: null, retry: () => {} } as unknown as EpochState;

function serve(over: Record<string, string | null> = {}) {
  const files: Record<string, string | null> = {
    '/runs/x/run.json': file('run.json'),
    '/runs/x/decisions.jsonl': DECISIONS,
    '/runs/x/events.jsonl': EVENTS,
    '/runs/x/report.json': file('report.json'),
    '/runs/x/snapshots/': JSON.stringify(Object.keys(EDGES).map((e) => `epoch-${e.padStart(3, '0')}.json`)),
    ...Object.fromEntries(
      Object.entries(EDGES).map(([e, edges]) => [`/runs/x/snapshots/epoch-${e.padStart(3, '0')}.json`, JSON.stringify({ epoch: Number(e), fingerprint: '', epoch_info: { epoch: Number(e), active: [] }, edges, spores: {} })]),
    ),
    ...over,
  };
  const fn = vi.fn(async (url: string) => {
    const body = files[String(url)];
    if (body === undefined || body === null) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mount(url: string, app: Partial<AppState> = {}, rpc?: Rpc) {
  const source = parseSource(url.includes('?') ? url.slice(url.indexOf('?')) : '');
  const state: AppState = { source, sourceError: null, epoch: EPOCH, router: null, reducedMotion: true, ...app };
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AppContext.Provider value={state}>
        <ActivityPage rpc={rpc ?? ({ archivalUrls: [], call: vi.fn() } as unknown as Rpc)} />
      </AppContext.Provider>
    </MemoryRouter>,
  );
}

const RUN_URL = '/activity?source=run&run=x';

describe('Activity page: a run', () => {
  it('lists rows grouped by epoch with the fingerprint header and the recompute total, virtualized', async () => {
    serve();
    const { container } = mount(`${RUN_URL}&view=log`);
    await screen.findByText(/95 \/ 95 decisions match the log/);
    expect(screen.getByRole('heading', { name: /Epoch 16/ }).textContent).toMatch(/closed .* fingerprint [0-9a-f]{6}…/);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBe(9);
    // 1000+ rows in the log; only a window of them in the DOM.
    const rendered = container.querySelectorAll('.ev-row').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
    expect(screen.getByText(/95 decision lines, 895 event lines/)).toBeTruthy();
  });

  it('expands a decision into its six parts: nothing confirmed before a fetch', async () => {
    serve();
    mount(`${RUN_URL}&kind=decision&outcome=settled`);
    const row = (await screen.findAllByRole('button', { name: /hired/ }))[0];
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const region = screen.getByRole('region', { name: /hired/ });
    const w = within(region);
    expect(region.querySelector('.decision-summary')!.textContent).toMatch(/^≈ /);
    expect(w.getByRole('table')).toBeTruthy();
    expect(region.querySelector('.is-winner')).toBeTruthy();
    expect(region.querySelector('.decision-rule')!.textContent).toContain('w_bps 40000');
    expect(w.getByText(/matches log/)).toBeTruthy();
    expect(w.getByText(/D values match the epoch \d+ close/)).toBeTruthy();
    expect(region.querySelectorAll('.job-step').length).toBeGreaterThan(3);
    expect(w.getByText('Technical')).toBeTruthy();
    expect(w.getByText('Logged')).toBeTruthy();
    expect(w.queryByText(/Confirmed on chain/)).toBeNull();
    expect(w.getByRole('button', { name: 'Fetch' })).toBeTruthy();
  });

  it('Fetch: Logged → Confirmed only after the final outcome, with the fee and a tube link', async () => {
    serve();
    const d = decisions.find((x) => x.tx.settle === TXS.settle.transaction.hash)!;
    const rpc = rpcFor({ [TXS.settle.transaction.hash]: TXS.settle });
    mount(`${RUN_URL}&kind=settlement&spore=${d.consumer}&from=${d.epoch}&to=${d.epoch}`, {}, rpc);
    const row = (await screen.findAllByRole('button', { name: new RegExp(`#${d.consumer} paid #${d.winner}`) }))[0];
    fireEvent.click(row);
    const region = screen.getByRole('region', { name: /paid/ });
    const receipt = within(region);
    expect(receipt.getByText('Logged')).toBeTruthy();
    expect(region.textContent).not.toContain('Confirmed on chain');
    fireEvent.click(receipt.getByRole('button', { name: 'Fetch' }));
    await receipt.findByText(/Confirmed on chain/);
    expect(region.textContent).toContain('job_settled');
    expect(region.textContent).toContain('fee');
    expect(region.textContent).toContain('0.0013 NEAR');
    expect(region.textContent).toContain('block 276000000');
    expect(region.textContent).toContain('signer operator.spores-hack.testnet');
    expect(receipt.getByRole('link', { name: /tube #5–#6/ }).getAttribute('href')).toBe('/network?source=run&run=x&epoch=10&sel=5-6');
    expect(receipt.getByRole('link', { name: /Epoch 10/ }).getAttribute('href')).toBe('/network?source=run&run=x&epoch=10');
    expect(receipt.queryByRole('button', { name: 'Fetch' })).toBeNull();
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });

  it('a failed fetch stays Logged and names the endpoint, with Retry', async () => {
    serve();
    const d = decisions.find((x) => x.tx.settle === TXS.settle.transaction.hash)!;
    mount(`${RUN_URL}&kind=settlement&spore=${d.consumer}&from=${d.epoch}&to=${d.epoch}`, {}, rpcFor({}));
    fireEvent.click((await screen.findAllByRole('button', { name: new RegExp(`#${d.consumer} paid #${d.winner}`) }))[0]);
    const region = screen.getByRole('region', { name: /paid/ });
    fireEvent.click(within(region).getByRole('button', { name: 'Fetch' }));
    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('https://node');
    expect(alert.textContent).toContain('UNKNOWN_TRANSACTION');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(region.textContent).toContain('Logged');
    expect(region.textContent).not.toContain('Confirmed on chain');
  });

  it('a chain outcome that contradicts the log says so', async () => {
    serve();
    const a = build();
    const row = a.rows.find((r) => r.tx === TXS.settle.transaction.hash && r.kind === 'settlement')!;
    const failed = { ...TXS.accept_refused, transaction: { ...TXS.accept_refused.transaction, hash: row.tx } };
    mount(`${RUN_URL}&kind=settlement&spore=5&from=10&to=10`, {}, rpcFor({ [row.tx!]: failed }));
    fireEvent.click((await screen.findAllByRole('button', { name: /#5 paid #6/ }))[0]);
    const region = screen.getByRole('region', { name: /paid/ });
    fireEvent.click(within(region).getByRole('button', { name: 'Fetch' }));
    await within(region).findByText(/The log and the chain disagree/);
    expect(region.textContent).toContain('insufficient balance');
    expect(region.textContent).toContain('No amounts moved.');
  });

  it('a refusal row says the contract refused and quotes it; a close row links Verify', async () => {
    serve();
    mount(`${RUN_URL}&kind=refusal,close&from=10&to=10`);
    const rows = await screen.findAllByRole('button', { name: /Refused by the contract/ });
    fireEvent.click(rows[0]);
    const region = screen.getByRole('region', { name: /Refused by the contract/ });
    expect(region.textContent).toContain('Refused by the contract:');
    expect(region.querySelector('.receipt .tone-warn')!.textContent).toMatch(/job is not open|insufficient balance/);
    expect(screen.getByRole('link', { name: 'Verify →' }).getAttribute('href')).toBe('/verify?source=run&run=x&epoch=10');
  });

  it('filters from the URL and from the bar; the empty case clears them', async () => {
    serve();
    const { container } = mount(`${RUN_URL}&kind=decision`);
    await screen.findByText(/95 \/ 95/);
    const pressed = screen.getByRole('button', { name: /Decisions/ });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(pressed.textContent).toContain('95');
    const words = () => [...container.querySelectorAll('.ev-row')].map((r) => r.className);
    expect(words().every((c) => c.includes('kind-decision'))).toBe(true);
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'accept_failed' } });
    await waitFor(() => expect(container.querySelectorAll('.ev-row').length).toBe(18));
    fireEvent.change(screen.getByLabelText('To epoch'), { target: { value: '1' } });
    await screen.findByText('No rows match these filters');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(container.querySelectorAll('.ev-row').length).toBeGreaterThan(18));
  });

  it('shows a bad line as a row even with filters on', async () => {
    serve({ '/runs/x/decisions.jsonl': `${DECISIONS}{broken\n` });
    mount(`${RUN_URL}&kind=close`);
    await screen.findByRole('button', { name: /decisions.jsonl line 96: not JSON/ });
    expect(screen.getByRole('heading', { name: /1 line that can’t be read/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /line 96/ }));
    expect(screen.getByRole('region', { name: /line 96/ }).textContent).toContain('{broken');
  });

  it('a run with only an event log says the decisions are missing', async () => {
    serve({ '/runs/x/decisions.jsonl': null });
    mount(RUN_URL);
    await screen.findByText(/This run has no/);
    expect(screen.getByText('decisions.jsonl', { selector: '.mono' })).toBeTruthy();
    expect(screen.queryByText(/decisions match the log/)).toBeNull();
  });

  it('a run that can`t be read is an error with Retry, never another source', async () => {
    serve({ '/runs/x/run.json': null });
    mount(RUN_URL);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('the logs of x');
    expect(alert.textContent).toContain('/runs/x/run.json');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('a settlement that arrives on a later read slides in; a first load doesn`t animate', async () => {
    serve({ '/runs/x/report.json': null });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = mount(`${RUN_URL}&kind=settlement`);
      await screen.findByText(/95 \/ 95/);
      expect(container.querySelector('.is-fresh')).toBeNull();
      const late = '{"at":"2026-11-02T10:00:00.000Z","spore":5,"kind":"tx","method":"settle","args":{"job_id":106},"hash":"NewSettleHash","ok":true}';
      serve({ '/runs/x/report.json': null, '/runs/x/events.jsonl': `${EVENTS}${late}\n` });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      await waitFor(() => expect(container.querySelector('.is-fresh')).toBeTruthy());
      expect(screen.getByText('1 new settlement in the log')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Activity page: the decisions view', () => {
  it('opens on decisions: bars, the two figures, no kind chips and no other rows', async () => {
    serve();
    const { container } = mount(RUN_URL);
    await screen.findByText(/a tube beat a cheaper quote in 25 of 95 decisions/);
    expect(screen.getByText(/95 \/ 95 decisions match the log/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Decisions' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('button', { name: /Settlements/ })).toBeNull();
    const rows = [...container.querySelectorAll('.ev-row')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.className.includes('kind-decision'))).toBe(true);
    // Epochs 10 to 17 have decisions; each header still reads its close.
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBe(8);
    expect(screen.getByRole('heading', { name: /Epoch 16/ }).textContent).toMatch(/fingerprint/);
    expect(screen.queryByText(/lines in decisions.jsonl/)).toBeNull();
  });

  it('a row draws one bar per quote with real widths, and names itself for a screen reader', async () => {
    serve();
    const d = decisions.find((x) => tubeBeatCheaper(x))!;
    const { container } = mount(`${RUN_URL}&spore=${d.consumer}&from=${d.epoch}&to=${d.epoch}&tube=1`);
    const row = (await screen.findAllByRole('button', { name: new RegExp(`#${d.consumer} (hired|picked) #${d.winner}`) }))[0];
    const line = row.closest('.ev-row')!;
    expect(line.querySelectorAll('.hire-bar').length).toBe(d.candidates.length);
    expect(line.querySelectorAll('.hire-bar.is-winner').length).toBe(1);
    expect(line.querySelector('.is-winner .hire-num')!.textContent).toContain('quote');
    expect(line.querySelectorAll('canvas.hire-tube').length).toBe(d.candidates.length);
    expect(line.querySelector('canvas.hire-tube')!.getAttribute('aria-hidden')).toBe('true');
    expect(line.textContent).toContain('beat a cheaper quote');
    expect(line.querySelectorAll('.job-rail-stage').length).toBe(4);
    expect(row.getAttribute('aria-label')).toContain(row.closest('.ev-row')!.querySelector('.ev-word')!.textContent!.replace(/^. /, ''));
    expect(container.querySelector('.hire-key')!.textContent).toContain('the price the rule compares');
  });

  it('expands to the sentence, rail, checks and receipt, with the rest one click away and nothing confirmed', async () => {
    serve();
    mount(`${RUN_URL}&outcome=settled`);
    fireEvent.click((await screen.findAllByRole('button', { name: /hired/ }))[0]);
    const region = screen.getByRole('region', { name: /hired/ });
    expect(region.querySelector('.decision-summary')!.textContent).toMatch(/^≈ /);
    expect(region.querySelector('.job-rail.is-labelled')!.textContent).toContain('Deliver');
    expect(within(region).getByText(/matches log/)).toBeTruthy();
    expect(within(region).getByText('Logged')).toBeTruthy();
    expect(region.textContent).not.toContain('Confirmed on chain');
    const closed = [...region.querySelectorAll('details')].filter((x) => !x.open).map((x) => x.querySelector('summary')!.textContent);
    expect(closed[0]).toBe('Numbers and rule');
    expect(closed[1]).toMatch(/^Steps and txs \(\d+\)$/);
    expect(closed[2]).toBe('Technical');
  });

  it('the tube chip keeps the 25, and the outcome list holds decision outcomes only', async () => {
    serve();
    const { container } = mount(RUN_URL);
    await screen.findByText(/25 of 95/);
    const outcomes = [...(screen.getByLabelText('Outcome') as HTMLSelectElement).options].map((o) => o.value);
    expect(outcomes).not.toContain('timeout');
    const chip = screen.getByRole('button', { name: 'Tube beat a cheaper quote' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tube beat a cheaper quote' }).getAttribute('aria-pressed')).toBe('true'));
    const groups = container.querySelectorAll('.ev-group');
    expect(groups.length).toBeGreaterThan(0);
    await waitFor(() => expect(container.querySelectorAll('.ev-row').length).toBeLessThanOrEqual(25));
    expect([...container.querySelectorAll('.ev-row')].every((r) => r.textContent!.includes('beat a cheaper quote'))).toBe(true);
  });

  it('a settled decision that arrives on a later read slides in; a first load doesn`t animate', async () => {
    serve({ '/runs/x/report.json': null });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = mount(RUN_URL);
      await screen.findByText(/25 of 95/);
      expect(container.querySelector('.is-fresh')).toBeNull();
      const line = { ...JSON.parse(DECISIONS.split('\n').find((l) => l.includes('"settled"'))!), job_id: 9999, at: '2026-11-09T00:00:00.000Z', epoch: 18 };
      serve({ '/runs/x/report.json': null, '/runs/x/decisions.jsonl': `${DECISIONS}${JSON.stringify(line)}\n` });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      await waitFor(() => expect(container.querySelector('.ev-row.is-fresh .hire-bar')).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
  });

  it('a bad line still shows, on top, in the default view', async () => {
    serve({ '/runs/x/decisions.jsonl': `${DECISIONS}{broken\n` });
    mount(RUN_URL);
    await screen.findByRole('button', { name: /decisions.jsonl line 96: not JSON/ });
    expect(screen.getAllByRole('heading', { level: 2 })[0].textContent).toContain('1 line that can’t be read');
  });

  it('the full log is one click away, keeps every row kind, and clearing the last kind stays there', async () => {
    serve();
    const { container } = mount(RUN_URL);
    await screen.findByText(/25 of 95/);
    fireEvent.click(screen.getByRole('link', { name: 'Full log' }));
    const chip = await screen.findByRole('button', { name: /Settlements/ });
    expect(screen.getByRole('link', { name: 'Full log' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByText(/95 decision lines, 895 event lines/)).toBeTruthy();
    expect(screen.queryByText(/a tube beat a cheaper quote in/)).toBeNull();
    expect(container.querySelector('.hire-bar')).toBeNull();
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByRole('button', { name: /Settlements/ }).getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: /Settlements/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Settlements/ }).getAttribute('aria-pressed')).toBe('false'));
    expect(screen.getByRole('link', { name: 'Full log' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('link', { name: 'Decisions' }));
    await waitFor(() => expect(container.querySelector('.hire-bar')).toBeTruthy());
  });

  it('a link with a kind opens the log, and clearing that kind stays there', async () => {
    serve();
    const { container } = mount(`${RUN_URL}&spore=5&kind=market`);
    await screen.findByRole('button', { name: /#5 sold/ });
    expect(screen.getByRole('link', { name: 'Full log' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: /^Market/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Market/ }).getAttribute('aria-pressed')).toBe('false'));
    expect(screen.getByRole('link', { name: 'Full log' }).getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('.hire-bar')).toBeNull();
  });

  it('a run with no decisions has no such view; LIVE either', async () => {
    serve({ '/runs/x/decisions.jsonl': null });
    mount(RUN_URL);
    await screen.findByText(/This run has no/);
    expect(screen.queryByRole('link', { name: 'Full log' })).toBeNull();
    expect(screen.getByRole('button', { name: /Closes/ })).toBeTruthy();
  });
});

describe('Activity page: RECORDED', () => {
  it('reads a bundle by its manifest, under its own badge', async () => {
    const names = Object.keys(EDGES).map((e) => `snapshots/epoch-${e.padStart(3, '0')}.json`);
    const files: Record<string, string> = {
      '/recorded/x/run.json': file('run.json'),
      '/recorded/x/decisions.jsonl': DECISIONS,
      '/recorded/x/events.jsonl': EVENTS,
      '/recorded/x/report.json': file('report.json'),
      '/recorded/x/files.json': JSON.stringify(names),
      ...Object.fromEntries(Object.entries(EDGES).map(([e, edges]) => [`/recorded/x/snapshots/epoch-${e.padStart(3, '0')}.json`, JSON.stringify({ epoch: Number(e), fingerprint: '', epoch_info: { epoch: Number(e), active: [] }, edges, spores: {} })])),
    };
    const fn = vi.fn(async (u: string) => (files[String(u)] === undefined ? new Response('', { status: 404 }) : new Response(files[String(u)])));
    vi.stubGlobal('fetch', fn);
    mount('/activity?source=recorded&run=x&date=2026-11-10&kind=decision&from=11&to=11');
    await screen.findByText(/95 \/ 95/);
    expect(screen.getByText('RECORDED')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /hired/ })[0]);
    expect(screen.getByText(/D values match the epoch 10 close/)).toBeTruthy();
    expect(fn.mock.calls.every(([u]) => String(u).startsWith('/recorded/x/'))).toBe(true);
  });
});

const fakeLive = (over: Partial<Router> = {}) => ({ id: 'spores-hack-router4.testnet', admin: async () => 'deployer.spores-hack.testnet', rpc: { archivalUrls: [], call: vi.fn() }, ...over }) as unknown as Router;
const closes = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/router4-closes.json'), 'utf8')) as { hash: string; signer: string; epoch_closed: any }[];

describe('Activity page: LIVE', () => {
  const LIST = '/closes/spores-hack-router4.testnet.txt';

  it('close rows only, Confirmed with no Fetch; the job kinds are disabled and say why', async () => {
    const two = closes.slice(14, 16);
    two.forEach((c) => localStorage.setItem(`spores.close.v1.${c.hash}`, JSON.stringify(c.epoch_closed)));
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (String(u) === LIST ? new Response(two.map((c) => c.hash).join('\n')) : new Response('[]', { status: 404 }))));
    mount('/activity', { router: fakeLive() });
    const row = await screen.findByRole('button', { name: /Epoch 16 closed/ });
    expect(screen.getByRole('button', { name: /Epoch 15 closed/ })).toBeTruthy();
    const dec = screen.getByRole('button', { name: /Decisions/ }) as HTMLButtonElement;
    expect(dec.disabled).toBe(true);
    expect(dec.textContent).toContain('—');
    expect((screen.getByRole('button', { name: /Closes/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Decisions and job history are not on chain/)).toBeTruthy();
    fireEvent.click(row);
    const region = screen.getByRole('region', { name: /Epoch 16 closed/ });
    expect(region.textContent).toContain('Confirmed on chain');
    expect(region.textContent).toContain('epoch_closed');
    expect(within(region).queryByRole('button', { name: 'Fetch' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Verify →' })[0].getAttribute('href')).toBe('/verify?epoch=16');
    expect(screen.queryByText(/decisions match/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Full log' })).toBeNull();
    expect(screen.queryByText(/a tube beat/)).toBeNull();
  });

  it('no close list: says what would fill it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    mount('/activity', { router: fakeLive() });
    await screen.findByText('No close hashes for this router');
    expect(screen.getByText('/closes/spores-hack-router4.testnet.txt')).toBeTruthy();
  });

  it('a close that can`t be read leaves the others and shows the error', async () => {
    const c = closes[0];
    localStorage.setItem(`spores.close.v1.${c.hash}`, JSON.stringify(c.epoch_closed));
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (String(u) === LIST ? new Response(`${c.hash}\nMissingHash`) : new Response('', { status: 404 }))));
    const call = vi.fn(async () => {
      throw new RpcError('https://node', 'UNKNOWN_TRANSACTION', 'rpc');
    });
    mount('/activity', { router: fakeLive({ rpc: { archivalUrls: [], call } as unknown as Rpc }) });
    await screen.findByRole('button', { name: /Epoch 1 closed/ });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('a close tx');
    expect(alert.textContent).toContain('https://node');
  });
});

describe('compact feed', () => {
  it('lists its rows with words and tx links, each opening in Activity', () => {
    const rows = build().rows.filter((r) => r.kind === 'market');
    render(
      <MemoryRouter>
        <CompactFeed rows={rows} more="/activity?spore=5" />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /#5 sold/ });
    expect(link.getAttribute('href')).toBe('/activity?spore=5');
    expect(screen.getByText('Sold')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /opens the explorer/ }).length).toBe(rows.length);
  });
});

describe('links and the close row', () => {
  it('linkTo keeps the source', () => {
    expect(linkTo('/network', '', { sel: '3-7' })).toBe('/network?sel=3-7');
    expect(linkTo('/network', '?source=run&run=x', { epoch: 4 })).toBe('/network?source=run&run=x&epoch=4');
    expect(linkTo('/spore/7', '?source=run&run=x')).toBe('/spore/7?source=run&run=x');
  });
  it('Network reads ?epoch= once; junk is the live end', () => {
    expect(parseEpochParam('17')).toBe(17);
    expect(parseEpochParam(null)).toBe('end');
    expect(parseEpochParam('0')).toBe('end');
    expect(parseEpochParam('x')).toBe('end');
  });
  it('a LIVE close row carries the event`s own counts', () => {
    const ev = closes[15].epoch_closed;
    const r = closeRow(ev, closes[15].hash);
    expect(r.receipt).toMatchObject({ evidence: 'confirmed', epoch: 16, flows: ev.flows.length, tubes: ev.edges, fingerprint: ev.fingerprint });
    expect(r.at).toBeNull();
  });
});
