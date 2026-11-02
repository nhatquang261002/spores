import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReceipt, type Expect } from '../src/receipt.ts';

const ROUTER = 'router.testnet';
const ev = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'spores', version: '1.0.0', event, data: [data] })}`;
const paid = (over: object = {}) => ev('service_paid', { spore_id: 3, payee: 'outside.testnet', amount: '100', memo: 'n1', epoch: 2, ...over });

function tx(logs: string[], over: object = {}) {
  return {
    result: {
      status: { SuccessValue: '' },
      transaction: { receiver_id: ROUTER, signer_id: 'op.testnet', hash: 'H', ...over },
      receipts_outcome: [{ outcome: { executor_id: ROUTER, logs } }],
    },
  };
}

const expect = (over: Partial<Expect> = {}): Expect => ({
  router: ROUTER,
  payee: 'outside.testnet',
  signerId: 'op.testnet',
  sporeId: 3,
  offer: { nonce: 'n1', sporeId: 3, price: 100n, open: true },
  isOperator: true,
  ...over,
});

test('a good receipt passes', () => {
  assert.equal(checkReceipt(tx([paid()]), expect()), null);
});

test('replayed nonce is refused', () => {
  assert.equal(checkReceipt(tx([paid()]), expect({ offer: { nonce: 'n1', sporeId: 3, price: 100n, open: false } })), 'nonce already redeemed');
  assert.equal(checkReceipt(tx([paid()]), expect({ offer: undefined })), 'unknown nonce');
});

test('wrong payee, underpayment, other spore', () => {
  assert.equal(checkReceipt(tx([paid({ payee: 'evil.testnet' })]), expect()), 'paid to another account');
  assert.equal(checkReceipt(tx([paid({ amount: '99' })]), expect()), 'underpaid');
  assert.equal(checkReceipt(tx([paid({ spore_id: 4 })]), expect()), 'paid by another spore');
  assert.equal(checkReceipt(tx([paid()]), expect({ offer: { nonce: 'n1', sporeId: 5, price: 100n, open: true } })), 'nonce was issued to another spore');
});

test('non-operator signer is refused', () => {
  assert.equal(checkReceipt(tx([paid()]), expect({ isOperator: false })), "signer is not the spore's current operator");
  assert.equal(checkReceipt(tx([paid()], { signer_id: 'other.testnet' }), expect()), 'transaction was signed by someone else');
});

test('failed, foreign or forged receipts are refused', () => {
  const failed = tx([paid()]);
  (failed.result as any).status = { Failure: {} };
  assert.equal(checkReceipt(failed, expect()), 'transaction did not succeed');
  assert.equal(checkReceipt(tx([paid()], { receiver_id: 'fake-router.testnet' }), expect()), 'transaction did not call the router');
  // An event logged by another contract does not count.
  const forged = tx([]);
  forged.result.receipts_outcome.push({ outcome: { executor_id: 'fake-router.testnet', logs: [paid()] } });
  assert.equal(checkReceipt(forged, expect()), 'no service_paid event for this nonce');
  assert.equal(checkReceipt(tx([paid(), ev('service_payment_failed', {})]), expect()), 'the transfer to us failed');
  assert.equal(checkReceipt(tx([paid({ memo: 'other' })]), expect()), 'no service_paid event for this nonce');
});
