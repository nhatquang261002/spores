import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUOTES, quoters } from '../src/quoters.ts';

const providers = Array.from({ length: 21 }, (_, i) => 3 * i + 1);

test('fan-out 0 keeps everyone (Phase 4 and 5 behaviour)', () => {
  assert.deepEqual(quoters(providers, 5, 1n, () => 0n, 0), providers);
});

test('tube neighbours first, then k seeded picks, never more than MAX_QUOTES', () => {
  const tubes = new Map([[4, 900n], [7, 100n], [10, 500n]]);
  const d = (p: number) => tubes.get(p) ?? 0n;
  const q = quoters(providers, 42, 1n, d, 3);
  assert.equal(q.length, 6);
  for (const p of [4, 7, 10]) assert.ok(q.includes(p));
  // Deterministic, so the consumer computes the same list as every provider.
  assert.deepEqual(quoters([...providers].reverse(), 42, 1n, d, 3), q);
  // Another job draws other picks.
  const others = (id: number) => quoters(providers, id, 1n, d, 3).filter((p) => !tubes.has(p));
  assert.notDeepEqual(others(42), others(43));
});

test('many neighbours leave room for k new ones', () => {
  const d = (p: number) => BigInt(p);
  const q = quoters(providers, 1, 1n, d, 2);
  assert.equal(q.length, MAX_QUOTES);
  // The six strongest tubes are the six highest ids.
  for (const p of providers.slice(-6)) assert.ok(q.includes(p));
});

test('fewer providers than the fan-out: all of them', () => {
  assert.deepEqual(quoters([2, 5], 9, 1n, () => 0n, 3), [2, 5]);
});
