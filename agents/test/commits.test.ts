import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommitQueue } from '../src/commits.ts';

/** A queue whose commits wait for `release()`, recording what was sent and skipped. */
function harness() {
  const sent: string[] = [];
  const skipped: string[] = [];
  const started: string[] = [];
  let release: () => void = () => {};
  const q = new CommitQueue<string>(
    async (item, live) => {
      started.push(item);
      await new Promise<void>((r) => (release = r));
      if (live()) sent.push(item);
      else skipped.push(`${item} (after render)`);
    },
    (item) => skipped.push(item),
  );
  const tick = () => new Promise((r) => setImmediate(r));
  return { q, sent, skipped, started, tick, release: async () => { release(); await tick(); } };
}

test('a batch commits every item in order', async () => {
  const h = harness();
  h.q.run(['a', 'b', 'c']);
  await h.tick();
  for (let i = 0; i < 3; i++) await h.release();
  await h.q.idle();
  assert.deepEqual(h.sent, ['a', 'b', 'c']);
  assert.deepEqual(h.skipped, []);
});

test('stop before a close skips the rest and the in-flight item does not send', async () => {
  const h = harness();
  h.q.run(['a', 'b', 'c']);
  await h.tick();
  await h.release(); // a sent, b in flight
  h.q.stop();
  await h.release(); // b finishes its render but is stale
  await h.q.idle();
  assert.deepEqual(h.sent, ['a']);
  assert.deepEqual(h.skipped, ['b (after render)', 'c']);
  assert.deepEqual(h.started, ['a', 'b']);
});

test('a newer batch supersedes the older one and runs after it', async () => {
  const h = harness();
  h.q.run(['e1-a', 'e1-b']);
  await h.tick();
  h.q.run(['e2-a']);
  await h.release(); // e1-a was in flight when e2 arrived: stale
  await h.release(); // e2-a
  await h.q.idle();
  assert.deepEqual(h.sent, ['e2-a']);
  assert.deepEqual(h.skipped, ['e1-a (after render)', 'e1-b']);
});

test('a failing commit does not stop the queue', async () => {
  const sent: number[] = [];
  const q = new CommitQueue<number>(async (n) => {
    if (n === 1) throw new Error('rpc down');
    sent.push(n);
  }, () => {});
  q.run([0, 1, 2]);
  await q.idle();
  assert.deepEqual(sent, [0, 2]);
});
