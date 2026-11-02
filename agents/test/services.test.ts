import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTask, deliver, encodeTask, makeTask, profile, serviceOf, solve } from '../src/services.ts';

test('tasks are deterministic, decodable and fit 256 bytes', () => {
  for (let s = 0; s < 3; s++) {
    const a = makeTask(1n, s, 4, 2, 0, 0);
    assert.deepEqual(makeTask(1n, s, 4, 2, 0, 0), a);
    const text = encodeTask(a);
    assert.ok(Buffer.byteLength(text) <= 256, text);
    assert.deepEqual(decodeTask(text), a);
  }
  assert.equal(decodeTask('{"s":"nope"}'), null);
  assert.equal(decodeTask('not json'), null);
});

test('solvers', () => {
  assert.equal(solve({ s: 'price', t: 0, c: 0, j: 0, a: 0, x: [5, 1, 9, 3, 7] }), '5');
  assert.equal(solve({ s: 'summary', t: 0, c: 0, j: 0, a: 0, x: 'b a b c a b d' }), 'b,a,c');
  assert.equal(solve({ s: 'classify', t: 0, c: 0, j: 0, a: 0, x: 97 }), 'prime');
  assert.equal(solve({ s: 'classify', t: 0, c: 0, j: 0, a: 0, x: 98 }), 'even');
  assert.equal(solve({ s: 'classify', t: 0, c: 0, j: 0, a: 0, x: 99 }), 'odd');
});

test('profiles in range and quality drives correctness', () => {
  for (let id = 0; id < 9; id++) {
    const p = profile(1n, id);
    assert.ok(p.cost >= 30n * 10n ** 21n && p.cost <= 150n * 10n ** 21n);
    assert.ok(p.qualityBps >= 5_000 && p.qualityBps <= 9_800);
    assert.ok(serviceOf(id) >= 0 && serviceOf(id) < 3);
  }
  const task = makeTask(1n, 0, 0, 1, 0, 0);
  let right = 0;
  for (let job = 0; job < 2_000; job++) right += deliver(1n, job, task, 7_000).correct ? 1 : 0;
  assert.ok(right > 1_300 && right < 1_500, `${right}`);
  assert.equal(deliver(1n, 3, task, 10_000).answer, solve(task));
  assert.notEqual(deliver(1n, 3, task, 0).answer, solve(task));
});
