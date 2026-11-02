// The TypeScript rules must reproduce vectors/agents.json (written by
// `cargo run -p spores-sim -- vectors`) value for value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as r from '../src/rules.ts';

const v = JSON.parse(readFileSync(new URL('../../vectors/agents.json', import.meta.url), 'utf8'));
const big = (s: string) => BigInt(s);
const norm = (n: any): r.Norm => (n === 'relative' ? 'relative' : { absolute: BigInt(n.absolute) });

test('constants', () => {
  assert.equal(v.shipped.w_bps, r.SHIPPED_W_BPS);
  assert.deepEqual(norm(v.shipped.norm), r.SHIPPED_NORM);
  assert.deepEqual(v.margin, { start: r.MARGIN_START, min: r.MARGIN_MIN, max: r.MARGIN_MAX, step: r.MARGIN_STEP });
});

test('rng', () => {
  for (const c of v.rng) {
    const g = new r.Rng(big(c.seed));
    assert.deepEqual(c.next_u64.map(() => g.nextU64().toString()), c.next_u64);
  }
  for (const c of v.stream) {
    const keys = c.keys.map(big);
    const g = r.stream(keys);
    assert.deepEqual(c.next_u64.map(() => g.nextU64().toString()), c.next_u64);
    assert.equal(r.stream(keys).below(10_000n).toString(), c.below_10000);
  }
});

test('score and d_norm', () => {
  for (const c of v.score) {
    assert.equal(r.dNorm(big(c.d), big(c.reference)).toString(), c.d_norm);
    assert.equal(r.score(big(c.quote), big(c.d), big(c.reference), c.w_bps).toString(), c.score);
  }
});

test('pick', () => {
  for (const c of v.pick) {
    const qs = c.quotes.map((q: any) => ({ provider: q.provider, price: big(q.price), d: big(q.d) }));
    assert.equal(r.pick(qs, c.w_bps, norm(c.norm)), c.winner);
  }
});

test('quote price and margin', () => {
  for (const c of v.quote_price) assert.equal(r.quotePrice(big(c.cost), c.margin_bps).toString(), c.quote);
  let m = v.next_margin.start;
  const got = v.next_margin.wins.map((w: number) => (m = r.nextMargin(m, w)));
  assert.deepEqual(got, v.next_margin.margins);
});

test('job service', () => {
  for (const c of v.job_service) {
    assert.equal(r.jobService(big(c.seed), big(c.epoch), big(c.consumer), big(c.j), c.services, c.own), c.service);
  }
});
