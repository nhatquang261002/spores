import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutcome } from '../src/near.ts';

const ev = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'spores', version: '1.0.0', event, data: [data] })}`;

test('success: return value, gas and events', () => {
  const r = parseOutcome('H', {
    result: {
      status: { SuccessValue: Buffer.from('7').toString('base64') },
      transaction: { hash: 'H' },
      transaction_outcome: { outcome: { gas_burnt: 1e12 } },
      receipts_outcome: [{ outcome: { gas_burnt: 2.5e12, logs: [ev('job_posted', { job_id: 7 }), 'plain log'] } }],
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.ret, 7);
  assert.equal(r.gasTgas, 3.5);
  assert.deepEqual(r.events.map((e) => e.event), ['job_posted']);
});

test('contract panic surfaces the message', () => {
  const r = parseOutcome('H', {
    result: {
      status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: policy: epoch budget exceeded' } } } } },
      transaction: { hash: 'H' },
      transaction_outcome: { outcome: { gas_burnt: 1 } },
      receipts_outcome: [],
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.err, 'Smart contract panicked: policy: epoch budget exceeded');
});

test('rejected before inclusion keeps the local hash', () => {
  const r = parseOutcome('LOCAL', { error: { cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: 'NotEnoughAllowance' } } } });
  assert.equal(r.ok, false);
  assert.equal(r.hash, 'LOCAL(not included)');
  assert.match(r.err, /NotEnoughAllowance/);
});
