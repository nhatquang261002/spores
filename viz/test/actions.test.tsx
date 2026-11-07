// S8: the wallet call state machine (no success before the final outcome),
// final-outcome parsing (the contract's error verbatim), action gating
// (`canAct`, the §6.D.1 bar), amount and account parsing, and the screens:
// Spore detail with owner actions, Buy on the Marketplace, My Spores and the
// wallet menu, all against a fake router and a fake wallet.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { RpcError } from '../src/chain/rpc';
import type { EpochInfo, Router, SporeSummary, Token, TokenExtra } from '../src/chain/router';
import { connectorTx, hashOf, isWrongNetwork, type WalletClient } from '../src/chain/wallet';
import { finalOutcome } from '../src/components/TxAction';
import { actionBar, canAct, isAccountId, nearText, parseNear, type WalletView } from '../src/model/actions';
import { sporeFromLive, shareOfR } from '../src/model/spore';
import { IDLE, isBusy, isWalletCancel, outcomeOf, txCopy, txReduce, type TxMachine, type TxOutcome } from '../src/model/tx';
import { parseSelection } from '../src/pages/Network';
import { RenderQueueContext } from '../src/wasm/art';
import type { RenderQueue } from '../src/wasm/renderQueue';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const NEAR = 10n ** 24n;
const near = (n: number) => ((BigInt(Math.round(n * 1000)) * NEAR) / 1000n).toString();
const OWNER = 'buyer.spores-hack.testnet';
const OTHER = 'someone.testnet';

// --- the state machine ------------------------------------------------------

const ok: TxOutcome = { hash: 'H', ok: true, events: [] };
const run = (...events: Parameters<typeof txReduce>[1][]): TxMachine => events.reduce(txReduce, IDLE);

describe('tx state machine (Design §7 TxAction, §8.3)', () => {
  it('reaches ok only through pending and a final outcome', () => {
    expect(run({ type: 'open' }, { type: 'sign' }).phase).toBe('signing');
    // a final outcome while signing (no hash yet) is ignored
    expect(run({ type: 'open' }, { type: 'sign' }, { type: 'final', outcome: ok }).phase).toBe('signing');
    // a hash alone is pending, not ok
    const pending = run({ type: 'open' }, { type: 'sign' }, { type: 'sent', hash: 'H' });
    expect(pending).toEqual({ phase: 'pending', hash: 'H' });
    expect(txReduce(pending, { type: 'final', outcome: ok }).phase).toBe('ok');
    // from idle or confirm nothing can jump to ok
    expect(run({ type: 'final', outcome: ok }).phase).toBe('idle');
    expect(run({ type: 'open' }, { type: 'final', outcome: ok }).phase).toBe('confirm');
  });

  it('a failed outcome keeps the contract error and the hash', () => {
    const m = run({ type: 'open' }, { type: 'sign' }, { type: 'sent', hash: 'H' }, { type: 'final', outcome: { hash: 'H', ok: false, error: 'spore is not listed', events: [] } });
    expect(m).toMatchObject({ phase: 'failed', hash: 'H', error: 'spore is not listed' });
    expect(txCopy(m, 'Buy', 7)).toBe('✕ Failed: spore is not listed');
  });

  it('wallet refusals are cancelled, other wallet errors are failures', () => {
    expect(run({ type: 'open' }, { type: 'sign' }, { type: 'walletError', error: 'User rejected', cancelled: true }).phase).toBe('cancelled');
    expect(run({ type: 'open' }, { type: 'sign' }, { type: 'walletError', error: 'boom', cancelled: false })).toEqual({ phase: 'failed', error: 'boom' });
    expect(isWalletCancel(new Error('User rejected the request'))).toBe(true);
    expect(isWalletCancel(new Error('Wallet closed'))).toBe(true);
    expect(isWalletCancel(new Error('Request cancelled'))).toBe(true);
    expect(isWalletCancel(new Error('network timeout'))).toBe(false);
  });

  it('is busy while signing and pending: it cannot be closed or started again', () => {
    const signing = run({ type: 'open' }, { type: 'sign' });
    expect(isBusy(signing)).toBe(true);
    expect(txReduce(signing, { type: 'close' })).toBe(signing);
    expect(txReduce(signing, { type: 'open' })).toBe(signing);
    expect(txReduce(signing, { type: 'sign' })).toBe(signing);
    const pending = txReduce(signing, { type: 'sent', hash: 'H' });
    expect(txReduce(pending, { type: 'close' })).toBe(pending);
    // a failed read of the outcome is still pending: the result is not known
    expect(txReduce(pending, { type: 'checkFailed', error: 'rpc down' })).toEqual({ phase: 'pending', hash: 'H', checkError: 'rpc down' });
  });

  it('uses the fixed copy', () => {
    expect(txCopy({ phase: 'confirm' }, 'List', 7)).toBe('List Spore #7');
    expect(txCopy({ phase: 'signing' }, 'List', 7)).toBe('Waiting for your wallet…');
    expect(txCopy({ phase: 'pending' }, 'List', 7)).toBe('Sent · waiting for final outcome');
    expect(txCopy({ phase: 'ok' }, 'List', 7)).toBe('✓ Confirmed');
    expect(txCopy({ phase: 'cancelled' }, 'List', 7)).toBe('Cancelled in wallet. Nothing was sent.');
  });
});

// --- final outcomes ---------------------------------------------------------

const ev = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'spores', version: '1.0.0', event, data: [data] })}`;
const txResult = (status: object, logs: string[] = []) => ({
  status,
  transaction: { hash: 'TXHASH' },
  transaction_outcome: { id: 'TXHASH', outcome: { logs: [] } },
  receipts_outcome: [{ id: 'R1', outcome: { logs } }],
});

describe('final outcome', () => {
  it('quotes the contract panic verbatim, without NEAR’s prefix', () => {
    const o = outcomeOf(
      txResult({ Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: a listed spore cannot be paused; delist it first' } } } } }),
    );
    expect(o).toMatchObject({ hash: 'TXHASH', ok: false, error: 'a listed spore cannot be paused; delist it first' });
  });
  it('reads success and the router’s events', () => {
    const o = outcomeOf(txResult({ SuccessValue: '' }, [ev('spore_listed', { spore_id: 3, price: '1' })]));
    expect(o.ok).toBe(true);
    expect(o.events.map((e) => e.event)).toEqual(['spore_listed']);
  });
  it('withdraw_failed means the withdraw did not happen', () => {
    const r = txResult({ SuccessValue: 'ZmFsc2U=' }, [ev('withdraw', {}), ev('withdraw_failed', {})]);
    expect(outcomeOf(r, ['withdraw_failed'])).toMatchObject({ ok: false, error: 'withdraw_failed (logged by the router)' });
    expect(outcomeOf(r).ok).toBe(true);
  });
  it('refuses a result that is not final', () => {
    expect(() => outcomeOf({ transaction: { hash: 'x' } })).toThrow(/no final status/);
    expect(() => outcomeOf({ transaction: { hash: 'x' }, status: { Started: null } })).toThrow(/not final/);
  });
  it('retries a tx the node has not seen yet, and nothing else', async () => {
    let n = 0;
    const tx = vi.fn(async () => {
      if (n++ < 2) throw new RpcError('https://rpc', 'UNKNOWN_TRANSACTION: unknown', 'rpc', 'UNKNOWN_TRANSACTION');
      return txResult({ SuccessValue: '' });
    });
    const router = { rpc: { tx } } as unknown as Router;
    await expect(finalOutcome(router, 'H', OWNER, [], 6, async () => {})).resolves.toMatchObject({ ok: true });
    expect(tx).toHaveBeenCalledTimes(3);
    const bad = { rpc: { tx: async () => Promise.reject(new RpcError('https://rpc', 'http 400', 'rpc', 'PARSE_ERROR')) } } as unknown as Router;
    await expect(finalOutcome(bad, 'H', OWNER, [], 6, async () => {})).rejects.toThrow('http 400');
  });
});

// --- gating -----------------------------------------------------------------

const as = (accountId: string | null, phase: WalletView['phase'] = 'connected'): WalletView => ({ phase: accountId ? phase : 'disconnected', accountId });
const life = { active: true, paused: false };

describe('canAct (Design §11) and the action bar (§6.D.1)', () => {
  const listed = { owner: OWNER, listedPrice: near(0.8) };
  const unlisted = { owner: OWNER, listedPrice: null };
  it('needs a testnet wallet', () => {
    expect(canAct('list', unlisted, as(null), life)).toEqual({ ok: false, reason: 'Connect a wallet to act.', contract: false });
    expect(canAct('buy', listed, as(null), life)).toMatchObject({ reason: 'Connect a wallet to buy.' });
    expect(canAct('list', unlisted, as('owner.near', 'wrong-network'), life)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a testnet account/) });
  });
  it('refuses with the router’s own words', () => {
    expect(canAct('list', unlisted, as(OTHER), life)).toEqual({ ok: false, reason: 'only the spore owner can do this', contract: true });
    expect(canAct('pause', listed, as(OWNER), life)).toMatchObject({ reason: 'a listed spore cannot be paused; delist it first', contract: true });
    expect(canAct('withdraw', listed, as(OWNER), life)).toMatchObject({ reason: 'a listed spore cannot withdraw; delist it first' });
    expect(canAct('buy', listed, as(OWNER), life)).toMatchObject({ reason: 'the owner cannot buy its own spore' });
    expect(canAct('buy', unlisted, as(OTHER), life)).toMatchObject({ reason: 'spore is not listed' });
    expect(canAct('delist', unlisted, as(OWNER), life)).toMatchObject({ reason: 'spore is not listed' });
    expect(canAct('activate', unlisted, as(OWNER), life)).toMatchObject({ reason: 'spore is already active' });
    expect(canAct('activate', unlisted, as(OWNER), { active: false, paused: true, activeCount: 64, maxActive: 64 })).toMatchObject({ reason: 'too many active spores' });
    expect(canAct('register-operator', unlisted, as(OWNER), { active: false, paused: true })).toMatchObject({ reason: 'spore is not active' });
  });
  it('allows what the router allows', () => {
    expect(canAct('buy', listed, as(OTHER), life).ok).toBe(true);
    expect(canAct('delist', listed, as(OWNER), life).ok).toBe(true);
    expect(canAct('deposit', listed, as(OWNER), life).ok).toBe(true);
    expect(canAct('activate', unlisted, as(OWNER), { active: false, paused: true, activeCount: 63, maxActive: 64 }).ok).toBe(true);
  });
  it('picks the primary action by state', () => {
    expect(actionBar('dormant', false, true)).toEqual({ primary: 'activate', more: ['deposit'] });
    expect(actionBar('awaiting-policy', false, true).primary).toBe('set-policy');
    expect(actionBar('control-reset', false, true).more).toEqual(['register-operator', 'deposit', 'withdraw', 'list']);
    expect(actionBar('active', false, true)).toEqual({ primary: 'set-policy', more: ['pause', 'register-operator', 'deposit', 'withdraw', 'list'] });
    expect(actionBar('paused', false, true).more).not.toContain('pause');
    // listed: Delist first; Pause and Withdraw stay visible (shown disabled with the reason)
    expect(actionBar('active', true, true)).toEqual({ primary: 'delist', more: ['deposit', 'pause', 'withdraw'] });
    expect(actionBar('active', true, false)).toEqual({ primary: 'buy', more: [] });
    expect(actionBar('active', false, false)).toEqual({ primary: null, more: [] });
  });
});

describe('amounts and accounts', () => {
  it('parses NEAR exactly, never through Number', () => {
    expect(parseNear('0.8')).toBe(8n * 10n ** 23n);
    expect(parseNear('1')).toBe(NEAR);
    expect(parseNear('.5')).toBe(5n * 10n ** 23n);
    expect(parseNear('0.000000000000000000000001')).toBe(1n);
    expect(() => parseNear('0.0000000000000000000000001')).toThrow(/24 decimals/);
    expect(() => parseNear('-1')).toThrow();
    expect(() => parseNear('1e3')).toThrow();
    expect(() => parseNear('')).toThrow();
    expect(nearText(near(0.1))).toBe('0.1');
    expect(nearText('1')).toBe('0.000000000000000000000001');
    expect(nearText(parseNear('2.3065'))).toBe('2.3065');
  });
  it('checks account ids', () => {
    expect(isAccountId('operator2.spores-hack.testnet')).toBe(true);
    expect(isAccountId('a'.repeat(64))).toBe(true);
    expect(isAccountId('Bad.testnet')).toBe(false);
    expect(isAccountId('a..testnet')).toBe(false);
    expect(isAccountId('x')).toBe(false);
    expect(isWrongNetwork('alice.near')).toBe(true);
    expect(isWrongNetwork('alice.testnet')).toBe(false);
  });
  it('builds the connector call and reads its hash', () => {
    expect(connectorTx(OWNER, 'r.testnet', { method: 'list', args: { spore_id: 3, price: '1' }, deposit: '1', gasTgas: 30 })).toEqual({
      network: 'testnet',
      signerId: OWNER,
      receiverId: 'r.testnet',
      actions: [{ type: 'FunctionCall', params: { methodName: 'list', args: { spore_id: 3, price: '1' }, gas: '30000000000000', deposit: '1' } }],
    });
    expect(hashOf({ transaction: { hash: 'abc' } })).toBe('abc');
    expect(() => hashOf({})).toThrow(/no transaction hash/);
  });
  it('reads Network selections from the URL', () => {
    expect(parseSelection('7')).toEqual({ kind: 'node', id: 7 });
    expect(parseSelection('7-3')).toEqual({ kind: 'tube', k: 3 * 1024 + 7 });
    expect(parseSelection('3-3')).toBeNull();
    expect(parseSelection('64')).toBeNull();
    expect(parseSelection(null)).toBeNull();
  });
});

// --- screens ----------------------------------------------------------------

const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const info = (epoch: number, active: number[] = [3, 5]): EpochInfo => ({
  epoch,
  started_ns: ns(Date.now() - 5_000),
  ends_ns: ns(Date.now() + 25_000),
  prev_fingerprint: '0'.repeat(64),
  active,
  pool: '0',
  flows: [],
  rejects: [],
});
const seed = (n: number) => '1a'.repeat(31) + n.toString(16).padStart(2, '0');
const policy = { paused: false, budget_per_epoch: near(1.5), max_payment: near(0.5), allow_all_spores: true, allowlist: [], external_allowlist: ['outside.spores-hack.testnet'] };

function summary(over: Partial<SporeSummary> = {}): SporeSummary {
  return {
    spore_id: 3,
    owner_id: OWNER,
    active: true,
    operator_id: 'operator2.spores-hack.testnet',
    operator_gen: 3,
    balance: near(2.31),
    reputation: '1430',
    age: 17,
    degree: 2,
    connections: [
      [5, '640000'],
      [12, '90000'],
    ],
    policy,
    spent_this_epoch: near(0.12),
    effective_budget: near(0.3),
    budget_left: near(0.18),
    seed: seed(3),
    posted_jobs: [1],
    serving_jobs: [],
    transfers: 1,
    sales: 1,
    listed_price: null,
    state: [26, 'ab'.repeat(32)],
    image: { epoch: 26, state_hash: 'ab'.repeat(32), image_hash: 'h3', renderer_version: 1 },
    ...over,
  };
}
const extra = (id: number, x: Partial<TokenExtra> = {}): TokenExtra => ({
  seed: seed(id),
  active: true,
  age: 5,
  degree: 0,
  reputation: 0,
  transfers: 0,
  sales: 0,
  listed_price: null,
  state_hash: null,
  image: null,
  ...x,
});
const token = (id: number, owner = OWNER, x: Partial<TokenExtra> = {}): Token => ({
  token_id: String(id),
  owner_id: owner,
  metadata: { title: `Spore #${id}`, description: null, media: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>", media_hash: null, extra: JSON.stringify(extra(id, x)) },
});
const parsed = (t: Token) => ({ id: Number(t.token_id), owner_id: t.owner_id, title: t.metadata.title!, glyph: t.metadata.media, extra: JSON.parse(t.metadata.extra!) });

const CONFIG = {
  supply_cap: 64,
  max_active: 64,
  epoch_len_ns: '30000000000',
  job_timeout_ns: '1',
  min_activation_deposit: near(0.1),
  decay_bps: 2500,
  gain: '1000000',
  k: near(0.5),
  d_min: '50000',
  fee_bps: 100,
  rebate_bps: 0,
  breadth_full: 0,
  reject_bps: 5000,
  base_budget: near(0.1),
  trust_gain: near(0.2),
  royalty_bps: 500,
  royalty_account: 'royalty.testnet',
};

function fakeRouter(o: { summary?: () => SporeSummary; tx?: () => Promise<any>; owned?: Record<string, number[]> } = {}) {
  const calls = { summary: 0, tx: [] as string[] };
  const router = {
    id: 'spores-hack-router4.testnet',
    epochInfo: async () => info(26),
    sporeSummary: async () => (calls.summary++, (o.summary ?? (() => summary()))()),
    nftToken: async (id: number) => token(id),
    config: async () => CONFIG,
    nftPayout: async (_id: number, price: string) => ({
      payout: { [OWNER]: ((BigInt(price) * 95n) / 100n).toString(), 'royalty.testnet': ((BigInt(price) * 5n) / 100n).toString() },
    }),
    allTokens: async () => [token(3), token(5, OTHER, { listed_price: near(0.8), sales: 1, reputation: 1089, age: 19 }), token(12)].map(parsed),
    edges: async () => [
      [3, 5, '640000'],
      [3, 12, '90000'],
    ],
    idsOwnedBy: async (acct: string) => o.owned?.[acct] ?? [],
    rpc: {
      tx: async (hash: string) => {
        calls.tx.push(hash);
        const r = await (o.tx ? o.tx() : txResult({ SuccessValue: '' }));
        return { ...r, transaction: { hash } }; // the node answers for the hash it was asked about
      },
    },
  } as unknown as Router;
  return { router, calls };
}

function fakeWallet(account: string, send: WalletClient['send'] = async () => 'SENTHASH') {
  return { restore: async () => null, connect: async () => account, disconnect: async () => {}, send: vi.fn(send) };
}

const queue = {
  request: async (input: { seed: string }) => ({ rgb: new Uint8Array(3), imageHash: `h${parseInt(input.seed.slice(62), 16)}`, source: 'worker', rendererVersion: 1 }),
};

async function renderAt(url: string, router: Router, wallet: WalletClient) {
  await act(async () => {
    render(
      <RenderQueueContext.Provider value={async () => queue as unknown as RenderQueue}>
        <MemoryRouter initialEntries={[url]}>
          <App router={router} wallet={wallet} />
        </MemoryRouter>
      </RenderQueueContext.Provider>,
    );
  });
  await settle();
}
const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function connect() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Connect wallet' })[0]);
  await settle();
}
const dialog = () => screen.getByRole('dialog');

describe('Spore detail (Design §6.D)', () => {
  it('shows identity, R as the one primary figure, inline figures, connections and Technical', async () => {
    await renderAt('/spore/3', fakeRouter().router, fakeWallet(OTHER));
    expect(screen.getByRole('heading', { level: 1, name: 'Spore #3' })).toBeTruthy();
    expect(screen.getByText('R 1.43')).toBeTruthy();
    expect(document.querySelectorAll('.figure-l')).toHaveLength(1);
    expect(screen.getByText('2.31 NEAR')).toBeTruthy();
    expect(screen.getByText('left 0.18 of 0.30 NEAR')).toBeTruthy();
    expect(screen.getByText('Age 17 epochs')).toBeTruthy();
    // connections by D, with the share of R (isqrt(640000) = 800 of 1430)
    const rows = [...document.querySelectorAll('.connections li')].map((li) => li.textContent);
    expect(rows[0]).toContain('#5');
    expect(rows[0]).toContain('D 0.64');
    expect(rows[0]).toContain('56% of R');
    expect(rows[1]).toContain('#12');
    // the art caption is the real image check (the commit is for this state, and h3 is what renders)
    expect(document.querySelector('.art-caption')?.textContent).toContain('✓ matches commit at epoch 26');
    expect(document.querySelector('.token-json')?.textContent).toContain('"token_id": "3"');
    // no wallet, not listed: no action bar at all
    expect(screen.queryByRole('group', { name: 'Owner actions' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Market' })).toBeNull();
    // the breadcrumb falls back to the Marketplace
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Marketplace')).toBeTruthy();
  });

  it('shows the RPC error with a retry, and an unknown id says so', async () => {
    let fail = true;
    const { router } = fakeRouter({
      summary: () => {
        if (fail) throw new RpcError('https://test.rpc.fastnear.com', 'http 503', 'retryable');
        return summary();
      },
    });
    await renderAt('/spore/3', router, fakeWallet(OTHER));
    expect(screen.getByRole('alert').textContent).toContain('https://test.rpc.fastnear.com');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(screen.getByText('R 1.43')).toBeTruthy();
    cleanup();
    await renderAt('/spore/99', router, fakeWallet(OTHER));
    expect(screen.getByText('No such spore')).toBeTruthy();
  });

  it('an owner of a listed spore gets Delist, with Pause and Withdraw disabled by the contract’s reason', async () => {
    await renderAt('/spore/3', fakeRouter({ summary: () => summary({ listed_price: near(0.8) }) }).router, fakeWallet(OWNER));
    await connect();
    const bar = screen.getByRole('group', { name: 'Owner actions' });
    expect(within(bar).getByRole('button', { name: 'Delist' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'More' }));
    const pause = within(bar).getByRole('button', { name: 'Pause' });
    expect(pause.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(pause);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('tooltip').textContent).toBe('a listed spore cannot be paused; delist it first');
    expect(within(bar).getByRole('button', { name: 'Withdraw' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('You')).toBeTruthy();
  });

  it('lists: the dialog shows the exact call and the nft_payout split; success only after the final outcome', async () => {
    let release!: (r: any) => void;
    const f = fakeRouter({ tx: () => new Promise((r) => (release = r)) });
    const wallet = fakeWallet(OWNER);
    await renderAt('/spore/3', f.router, wallet);
    await connect();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'List for sale' }));
    expect(within(dialog()).getByRole('heading', { name: 'List Spore #3' })).toBeTruthy();
    // nothing to sign until the form is valid
    expect(within(dialog()).getByRole('button', { name: 'Sign in wallet' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog()).getByLabelText(/Price/), { target: { value: '0.8' } });
    await settle(350);
    expect(dialog().textContent).toContain('{"spore_id":3,"price":"800000000000000000000000"}');
    expect(dialog().textContent).toContain('1 yoctoNEAR, required by the contract for security');
    expect(dialog().textContent).toContain('You get 0.76 NEAR · royalty 0.04 NEAR to royalty.testnet');
    expect(dialog().textContent).toContain('Listing blocks pause and withdraw until you delist.');
    const before = f.calls.summary;
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Sign in wallet' }));
    await settle();
    expect(wallet.send).toHaveBeenCalledWith(OWNER, 'spores-hack-router4.testnet', { method: 'list', args: { spore_id: 3, price: near(0.8) }, deposit: '1', gasTgas: 30 });
    // sent, outcome not read yet: pending, never confirmed
    expect(dialog().textContent).toContain('Sent · waiting for final outcome');
    expect(dialog().textContent).not.toContain('✓ Confirmed');
    expect(within(dialog()).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.querySelector('.tx-tray')?.textContent).toContain('Sent · waiting for final outcome');
    await act(async () => release(txResult({ SuccessValue: '' }, [ev('spore_listed', {})])));
    await settle();
    expect(dialog().textContent).toContain('✓ Confirmed');
    expect(within(dialog()).getByRole('link', { name: "tx SENTHASH ↗" }).getAttribute('href')).toBe('https://testnet.nearblocks.io/txns/SENTHASH');
    expect(f.calls.tx).toEqual(['SENTHASH']);
    expect(f.calls.summary).toBeGreaterThan(before); // the page reads the spore again
    expect(document.querySelector('.tx-tray')?.textContent).toContain('✓ Confirmed');
  });

  it('shows a contract refusal verbatim, and a wallet refusal as cancelled', async () => {
    const f = fakeRouter({
      summary: () => summary({ listed_price: near(0.8) }),
      tx: async () => txResult({ Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: spore is not listed' } } } } }),
    });
    let refuse = false;
    const wallet = fakeWallet(OWNER, async () => {
      if (refuse) throw new Error('User rejected the request');
      return 'H2';
    });
    await renderAt('/spore/3', f.router, wallet);
    await connect();
    fireEvent.click(screen.getByRole('button', { name: 'Delist' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Sign in wallet' }));
    await settle();
    expect(dialog().textContent).toContain('✕ Failed: spore is not listed');
    expect(dialog().textContent).toContain('The transaction failed, so the spore did not change.');
    refuse = true;
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    await settle();
    expect(dialog().textContent).toContain('Cancelled in wallet. Nothing was sent.');
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a paused spore’s primary action is Set policy, which unpauses', async () => {
    const wallet = fakeWallet(OWNER);
    await renderAt('/spore/3', fakeRouter({ summary: () => summary({ policy: { ...policy, paused: true } }) }).router, wallet);
    await connect();
    fireEvent.click(screen.getByRole('button', { name: 'Set policy' }));
    const box = within(dialog());
    expect((box.getByRole('checkbox', { name: /Paused/ }) as HTMLInputElement).checked).toBe(false);
    expect(dialog().textContent).toContain('This unpauses the spore. There is no separate unpause method.');
    fireEvent.click(box.getByRole('button', { name: 'Sign in wallet' }));
    await settle();
    expect(wallet.send.mock.calls[0][2]).toEqual({ method: 'set_policy', args: { spore_id: 3, policy: { ...policy, paused: false } }, deposit: '1', gasTgas: 30 });
  });
});

describe('Marketplace listings and Buy (Design §6.F)', () => {
  it('shows listing cards with price, seller and stats, and Buy states the consequences', async () => {
    const wallet = fakeWallet(OWNER);
    await renderAt('/market?view=listed', fakeRouter().router, wallet);
    expect(document.querySelector('.card-listing-stats')?.textContent).toBe('R 1.09 · 1 tube · age 19 · 1 prior sale');
    expect(screen.getByRole('button', { name: 'Buy for 0.80 NEAR' }).getAttribute('aria-disabled')).toBe('true'); // no wallet yet
    await connect();
    fireEvent.click(screen.getByRole('button', { name: 'Buy for 0.80 NEAR' }));
    await settle(350);
    const text = dialog().textContent!;
    expect(text).toContain('Buy Spore #5');
    expect(text).toContain('You get the NFT, its balance (2.31 NEAR), its tubes and its age.');
    expect(text).toContain('Jobs in flight are refunded.');
    expect(text).toContain('it does not predict future earnings');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Sign in wallet' }));
    await settle();
    expect(wallet.send.mock.calls[0][2]).toEqual({ method: 'buy', args: { spore_id: 5 }, deposit: near(0.8), gasTgas: 100 });
    expect(dialog().textContent).toContain('Spore #5 is yours. It is paused until you set a policy.');
    expect(within(dialog()).getByRole('link', { name: 'Set up Spore #5 →' }).getAttribute('href')).toBe('/spore/5');
  });

  it('the seller cannot buy its own listing', async () => {
    await renderAt('/market?view=listed', fakeRouter().router, fakeWallet(OTHER));
    await connect();
    const buy = screen.getByRole('button', { name: 'Buy for 0.80 NEAR' });
    expect(buy.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(buy);
    expect(screen.getByRole('tooltip').textContent).toBe('the owner cannot buy its own spore');
  });
});

describe('My Spores and the wallet menu', () => {
  beforeEach(() => localStorage.clear());

  it('asks for a wallet, then shows what the router says it owns', async () => {
    await renderAt('/mine', fakeRouter({ owned: { [OWNER]: [3, 12] } }).router, fakeWallet(OWNER));
    expect(screen.getByText('Connect a wallet to see the spores it owns')).toBeTruthy();
    await connect();
    await settle();
    const cards = [...document.querySelectorAll<HTMLAnchorElement>('a.spore-card')].map((a) => a.dataset.id);
    expect(cards).toEqual(['3', '12']);
    expect(screen.getByText(/owns 2 spores on/)).toBeTruthy();
  });

  it('an account with no spores gets the empty state, and the menu disconnects', async () => {
    await renderAt('/mine', fakeRouter().router, fakeWallet(OTHER));
    await connect();
    await settle();
    expect(screen.getByText(`${OTHER} owns no spores on router4`)).toBeTruthy();
    expect(localStorage.getItem('spores.wallet')).toBe('1');
    fireEvent.click(screen.getAllByRole('button', { name: OTHER })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect' }));
    await settle();
    expect(screen.getByText('Connect a wallet to see the spores it owns')).toBeTruthy();
    expect(localStorage.getItem('spores.wallet')).toBeNull();
  });

  it('a mainnet account is the wrong network, and a run source does not read ownership', async () => {
    await renderAt('/mine', fakeRouter().router, fakeWallet('alice.near'));
    await connect();
    expect(screen.getAllByText('Switch to testnet').length).toBeGreaterThan(0);
    cleanup();
    await renderAt('/mine?source=run&run=x', fakeRouter().router, fakeWallet(OWNER));
    expect(screen.getByText('My Spores reads the live router')).toBeTruthy();
  });

  it('closing the wallet picker is not an error', async () => {
    const wallet = { ...fakeWallet(OWNER), connect: async () => Promise.reject(new Error('User rejected')) };
    await renderAt('/mine', fakeRouter().router, wallet);
    await connect();
    expect(screen.queryByText(/Could not connect/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Connect wallet' })[0].hasAttribute('disabled')).toBe(false);
  });

  it('shows a connect error from the wallet', async () => {
    const wallet = { ...fakeWallet(OWNER), connect: async () => Promise.reject(new Error('no wallet installed')) };
    await renderAt('/mine', fakeRouter().router, wallet);
    await connect();
    expect(screen.getAllByText(/no wallet installed/).length).toBeGreaterThan(0);
  });
});

describe('detail model', () => {
  it('maps spore_summary without inventing values', () => {
    const v = sporeFromLive(summary({ state: [25, 'old'] }), null, { epoch: 26 }, 1);
    expect(v.image.stateHash).toBeNull(); // the stored state is for another epoch
    expect(v.status).toEqual({ status: 'active', derived: false });
    expect(v.organism.tubes).toEqual([
      [5, '640000'],
      [12, '90000'],
    ]);
    const reset = sporeFromLive(summary({ operator_id: null, policy: { ...policy, paused: true } }), null, { epoch: 26 }, 1);
    expect(reset.status).toEqual({ status: 'control-reset', derived: true });
    expect(shareOfR('1000000', 1000)).toBe(1);
    expect(shareOfR('640000', 0)).toBe(0);
  });
});
