// Owner actions (Design §6.D.1) and the one gate every action goes through,
// `canAct(action, holding, wallet, life)` (Design §11). Refusals use the
// router's own words where the router would refuse (router/src/lib.rs,
// ledger.rs, market.rs), so a disabled button says what the contract says.
import type { Holding, SporeStatus } from './types';

export type OwnerAction = 'activate' | 'set-policy' | 'pause' | 'register-operator' | 'deposit' | 'withdraw' | 'list' | 'delist' | 'buy';

/** The wallet as far as gating cares (identity only; ownership is decided here). */
export interface WalletView {
  phase: 'disconnected' | 'connecting' | 'connected' | 'wrong-network';
  accountId: string | null;
}

/** What the spore's own state allows. */
export interface Life {
  active: boolean;
  paused: boolean;
  /** Spores active now and the router's cap, for `activate` ("too many active spores"). */
  activeCount?: number;
  maxActive?: number;
}

export type Gate = { ok: true } | { ok: false; reason: string; /** The reason is the router's panic text, verbatim. */ contract: boolean };

const OK: Gate = { ok: true };
const no = (reason: string, contract = false): Gate => ({ ok: false, reason, contract });

const OWNER_ONLY: OwnerAction[] = ['activate', 'set-policy', 'pause', 'register-operator', 'withdraw', 'list', 'delist'];

export function canAct(action: OwnerAction, holding: Pick<Holding, 'owner' | 'listedPrice'>, wallet: WalletView, life: Life): Gate {
  if (wallet.phase === 'disconnected') return no(action === 'buy' ? 'Connect a wallet to buy.' : 'Connect a wallet to act.');
  if (wallet.phase === 'connecting') return no('Connecting to the wallet…');
  if (wallet.phase === 'wrong-network' || !wallet.accountId) return no(`${wallet.accountId} is not a testnet account. This app acts on testnet only.`);
  const isOwner = wallet.accountId === holding.owner;
  const listed = holding.listedPrice !== null;
  if (OWNER_ONLY.includes(action) && !isOwner) return no('only the spore owner can do this', true);
  switch (action) {
    case 'buy':
      if (isOwner) return no('the owner cannot buy its own spore', true);
      if (!listed) return no('spore is not listed', true);
      return OK;
    case 'activate':
      if (life.active) return no('spore is already active', true);
      if (life.activeCount !== undefined && life.maxActive !== undefined && life.activeCount >= life.maxActive) return no('too many active spores', true);
      return OK;
    case 'register-operator':
      return life.active ? OK : no('spore is not active', true);
    case 'pause':
      return listed ? no('a listed spore cannot be paused; delist it first', true) : OK;
    case 'withdraw':
      return listed ? no('a listed spore cannot withdraw; delist it first', true) : OK;
    case 'delist':
      return listed ? OK : no('spore is not listed', true);
    case 'set-policy':
    case 'list':
    case 'deposit':
      return OK;
  }
}

export interface ActionBar {
  primary: OwnerAction | null;
  /** Under "More", in this order; listed spores show Pause and Withdraw disabled with the reason. */
  more: OwnerAction[];
}

const NONE: ActionBar = { primary: null, more: [] };

/**
 * Design §6.D.1, by state. Only the owner gets a bar; anyone else gets Buy
 * when the spore is listed. `owner` false covers "no wallet".
 */
export function actionBar(status: SporeStatus, listed: boolean, owner: boolean): ActionBar {
  if (!owner) return listed ? { primary: 'buy', more: [] } : NONE;
  if (listed) return { primary: 'delist', more: ['deposit', 'pause', 'withdraw'] };
  switch (status) {
    case 'dormant':
      return { primary: 'activate', more: ['deposit'] };
    case 'awaiting-policy':
    case 'control-reset':
      return { primary: 'set-policy', more: ['register-operator', 'deposit', 'withdraw', 'list'] };
    case 'active':
      return { primary: 'set-policy', more: ['pause', 'register-operator', 'deposit', 'withdraw', 'list'] };
    case 'paused':
      // Unpausing is set_policy with paused off: there is no unpause method.
      return { primary: 'set-policy', more: ['register-operator', 'deposit', 'withdraw', 'list'] };
    case 'activated':
      // The bulk views' coarse reading; the detail page reads spore_summary, so this does not reach a bar.
      return NONE;
  }
}

/** Button words. `confirm` is the dialog title's verb: `${confirm} Spore #N` (Design §8.3). */
export function actionWords(a: OwnerAction, status: SporeStatus, price?: string): { button: string; confirm: string } {
  switch (a) {
    case 'activate':
      return { button: 'Activate', confirm: 'Activate' };
    case 'set-policy':
      return status === 'active' ? { button: 'Edit policy', confirm: 'Edit the policy of' } : { button: 'Set policy', confirm: 'Set the policy of' };
    case 'pause':
      return { button: 'Pause', confirm: 'Pause' };
    case 'register-operator':
      return status === 'active' || status === 'paused'
        ? { button: 'Replace operator', confirm: 'Replace the operator of' }
        : { button: 'Register operator', confirm: 'Register an operator for' };
    case 'deposit':
      return { button: 'Deposit', confirm: 'Deposit into' };
    case 'withdraw':
      return { button: 'Withdraw', confirm: 'Withdraw from' };
    case 'list':
      return { button: 'List for sale', confirm: 'List' };
    case 'delist':
      return { button: 'Delist', confirm: 'Delist' };
    case 'buy':
      return { button: price ? `Buy for ${price}` : 'Buy', confirm: 'Buy' };
  }
}

const YOCTO = 10n ** 24n;

/**
 * A NEAR amount typed by a person → yocto. Up to 24 decimals, no sign, no
 * exponent; never through Number (Design §8.1).
 */
export function parseNear(text: string): bigint {
  const t = text.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!t || !m || (m[1] === '' && !m[2])) throw new Error('Enter an amount in NEAR, like 0.5');
  const frac = m[2] ?? '';
  if (frac.length > 24) throw new Error('NEAR has 24 decimals at most');
  return BigInt(m[1] || '0') * YOCTO + BigInt(frac.padEnd(24, '0') || '0');
}

/** NEAR account id rules (nomicon: 2–64 chars, lowercase, digits, `-_` separators, `.` between parts). */
export function isAccountId(s: string): boolean {
  return s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
}

/** yocto → the exact NEAR amount as typed text (`0.1`, `2.3065`), no rounding: for prefilled inputs. */
export function nearText(yocto: string | bigint): string {
  const v = BigInt(yocto);
  const frac = (v % YOCTO).toString().padStart(24, '0').replace(/0+$/, '');
  return frac ? `${v / YOCTO}.${frac}` : String(v / YOCTO);
}
