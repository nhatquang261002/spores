// Owner actions and Buy (Design §6.D.1, §6.F): one form per router call from
// Reference A, each through `canAct` and `TxAction`. Forms prefill from chain
// values (the current policy, the activation minimum) and show the exact call
// before signing. The payout split for List and Buy comes from the router's
// `nft_payout` view, never from a percentage typed here.
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { EpochInfo, Router, RouterConfig } from '../chain/router';
import { actionBar, actionWords, canAct, isAccountId, nearText, parseNear, type Gate, type Life, type OwnerAction, type WalletView } from '../model/actions';
import type { SporeView } from '../model/spore';
import type { SporeStatus } from '../model/types';
import { useWallet } from '../state/wallet';
import { formatNear, shortAccount } from '../ui/format';
import { LoadingBar } from '../ui/states';
import { TxAction, type Draft } from './TxAction';

const GAS = 30;
const GAS_WITHDRAW = 50; // a transfer plus the router's 10 Tgas callback
const GAS_BUY = 100; // as agents/src/run.ts: transfer, control reset, two payouts with callbacks

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mono-s field-hint">{hint}</span>}
    </label>
  );
}

function amount(text: string, what: string): bigint | string {
  try {
    const v = parseNear(text);
    return v > 0n ? v : `${what} must be more than 0.`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** `nft_payout` for a price: the seller's share and the royalty, from the router. */
function usePayout(router: Router, id: number, price: bigint | null, enabled = true) {
  const [state, setState] = useState<{ price: bigint; payout: Record<string, string> } | { error: string } | null>(null);
  useEffect(() => {
    if (!enabled || price === null || price <= 0n) return setState(null);
    let live = true;
    const t = setTimeout(() => {
      router.nftPayout(id, price.toString()).then(
        (r) => live && setState({ price, payout: r.payout }),
        (e) => live && setState({ error: String((e as Error)?.message ?? e) }),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [router, id, price === null ? '' : price.toString(), enabled]);
  return state;
}

function PayoutLine({ payout, owner, verbSeller }: { payout: ReturnType<typeof usePayout>; owner: string; verbSeller: string }) {
  if (!payout) return <LoadingBar ch={24} label="Reading nft_payout" />;
  if ('error' in payout)
    return (
      <span>
        <span className="glyph-warn" aria-hidden="true">✕</span> nft_payout failed: <span className="mono">{payout.error}</span>
      </span>
    );
  const others = Object.entries(payout.payout).filter(([a]) => a !== owner);
  return (
    <span>
      {verbSeller} <span className="mono money">{formatNear(payout.payout[owner] ?? '0')}</span>
      {others.map(([a, v]) => (
        <span key={a}>
          {' '}
          · royalty <span className="mono money">{formatNear(v)}</span> to <span className="mono">{shortAccount(a)}</span>
        </span>
      ))}{' '}
      <span className="unavailable">(the contract’s own figures)</span>
    </span>
  );
}

interface Ctx {
  spore: SporeView;
  router: Router;
  config: RouterConfig | null;
  gate: Gate;
  status: SporeStatus;
  variant: 'primary' | 'secondary';
  onFinal: () => void;
}

function Activate({ spore, router, config, gate, status, variant, onFinal }: Ctx) {
  const id = spore.organism.id;
  const min = config?.min_activation_deposit ?? null;
  const [operator, setOperator] = useState('');
  const [deposit, setDeposit] = useState(min ? nearText(min) : '');
  useEffect(() => {
    if (min && !deposit) setDeposit(nearText(min));
  }, [min]);
  const v = amount(deposit, 'The deposit');
  let draft: Draft;
  if (!min) draft = { error: 'Reading the activation minimum from the contract…' };
  else if (!isAccountId(operator)) draft = { error: 'Enter the operator’s account id (for example operator.spores-hack.testnet).' };
  else if (operator === spore.holding.owner) draft = { error: 'the operator must be a different account from the owner' };
  else if (typeof v === 'string') draft = { error: v };
  else if (v < BigInt(min)) draft = { error: `activation needs at least min_activation_deposit attached (${formatNear(min)})` };
  else draft = { method: 'activate', args: { spore_id: id, operator_id: operator }, deposit: v.toString(), gasTgas: GAS };
  const w = actionWords('activate', status);
  return (
    <TxAction
      router={router}
      sporeId={id}
      verb={w.confirm}
      button={w.button}
      variant={variant}
      gate={gate}
      draft={draft}
      onFinal={onFinal}
      fields={
        <>
          <Field label="Operator account" hint="The account whose function-call key runs the agent. Not the owner.">
            <input className="mono" value={operator} onChange={(e) => setOperator(e.target.value.trim())} spellCheck={false} autoComplete="off" data-autofocus />
          </Field>
          <Field label="Deposit (NEAR)" hint={min ? `At least ${formatNear(min)} (min_activation_deposit)` : undefined}>
            <input className="mono" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
          </Field>
        </>
      }
      consequences={
        <ul>
          <li>The deposit is credited to Spore #{id}’s balance on the router.</li>
          <li>The operator can then post, quote, hire and settle for it, within the policy the contract enforces.</li>
          <li>It stays paused with a zero budget until you set a policy. There is no way back to dormant.</li>
        </ul>
      }
    />
  );
}

function SetPolicy({ spore, router, config, gate, status, variant, onFinal }: Ctx) {
  const id = spore.organism.id;
  const a = spore.agent;
  const [paused, setPaused] = useState(a.paused);
  const [budget, setBudget] = useState(nearText(a.budgetPerEpoch));
  const [maxPay, setMaxPay] = useState(nearText(a.maxPayment));
  const [allowAll, setAllowAll] = useState(a.allowAllSpores);
  const [list, setList] = useState(a.allowlist.join(', '));
  const [external, setExternal] = useState(a.externalAllowlist.join(', '));
  const reset = () => {
    setPaused(status === 'paused' || status === 'awaiting-policy' || status === 'control-reset' ? false : a.paused);
    setBudget(nearText(a.budgetPerEpoch));
    setMaxPay(nearText(a.maxPayment));
    setAllowAll(a.allowAllSpores);
    setList(a.allowlist.join(', '));
    setExternal(a.externalAllowlist.join(', '));
  };

  let draft: Draft;
  const b = (() => {
    try {
      return parseNear(budget);
    } catch (e) {
      return (e as Error).message;
    }
  })();
  const mp = (() => {
    try {
      return parseNear(maxPay);
    } catch (e) {
      return (e as Error).message;
    }
  })();
  const ids = list.split(/[\s,]+/).filter(Boolean);
  const accounts = external.split(/[\s,]+/).filter(Boolean);
  if (typeof b === 'string') draft = { error: `Budget per epoch: ${b}` };
  else if (typeof mp === 'string') draft = { error: `Max payment: ${mp}` };
  else if (ids.some((s) => !/^\d+$/.test(s))) draft = { error: 'Allowed spores: spore ids separated by commas, like 3, 12, 40.' };
  else if (ids.map(Number).includes(id)) draft = { error: 'a spore cannot allowlist itself' };
  else if (ids.map(Number).some((n) => n > 63)) draft = { error: 'allowlist names an unknown spore' };
  else if (accounts.some((s) => !isAccountId(s))) draft = { error: 'External payees: account ids separated by commas.' };
  else if (accounts.length > 8) draft = { error: 'external allowlist too long' };
  else
    draft = {
      method: 'set_policy',
      args: {
        spore_id: id,
        policy: {
          paused,
          budget_per_epoch: b.toString(),
          max_payment: mp.toString(),
          allow_all_spores: allowAll,
          allowlist: [...new Set(ids.map(Number))].sort((x, y) => x - y),
          external_allowlist: accounts,
        },
      },
      deposit: '1',
      gasTgas: GAS,
    };
  const w = actionWords('set-policy', status);
  const base = config ? formatNear(config.base_budget) : null;
  return (
    <TxAction
      router={router}
      sporeId={id}
      verb={w.confirm}
      button={w.button}
      variant={variant}
      gate={gate}
      draft={draft}
      onOpen={reset}
      onFinal={onFinal}
      fields={
        <>
          <label className="field field-check">
            <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
            <span className="body">Paused (the contract refuses the agent’s spending)</span>
          </label>
          <Field label="Budget per epoch (NEAR)">
            <input className="mono" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} data-autofocus />
          </Field>
          <Field label="Max payment (NEAR)">
            <input className="mono" inputMode="decimal" value={maxPay} onChange={(e) => setMaxPay(e.target.value)} />
          </Field>
          <label className="field field-check">
            <input type="checkbox" checked={allowAll} onChange={(e) => setAllowAll(e.target.checked)} />
            <span className="body">Any active spore may be paid</span>
          </label>
          {!allowAll && (
            <Field label="Allowed spores (ids)">
              <input className="mono" value={list} onChange={(e) => setList(e.target.value)} placeholder="3, 12, 40" />
            </Field>
          )}
          <Field label="External payees (accounts, at most 8)" hint="Accounts outside the collection pay_service may pay.">
            <input className="mono" value={external} onChange={(e) => setExternal(e.target.value)} spellCheck={false} />
          </Field>
        </>
      }
      consequences={
        <ul>
          <li>Takes effect at once: the contract checks every payment the agent tries against it.</li>
          <li>
            The agent may spend at most min(budget per epoch, {base ?? 'base'} + trust_gain × R) each epoch (the living allowance).
          </li>
          {a.paused && !paused && <li>This unpauses the spore. There is no separate unpause method.</li>}
        </ul>
      }
    />
  );
}

function Pause({ spore, router, gate, status, variant, onFinal }: Ctx) {
  const id = spore.organism.id;
  const w = actionWords('pause', status);
  return (
    <TxAction
      router={router}
      sporeId={id}
      verb={w.confirm}
      button={w.button}
      variant={variant}
      gate={gate}
      draft={{ method: 'pause', args: { spore_id: id }, deposit: '0', gasTgas: GAS }}
      onFinal={onFinal}
      consequences={
        <ul>
          <li>Sets the policy’s paused flag. The contract refuses the agent’s payments (“policy: spore is paused”) until you set a policy with paused off.</li>
          <li>Budget, lists and operator stay as they are.</li>
        </ul>
      }
    />
  );
}

function RegisterOperator({ spore, router, gate, status, variant, onFinal }: Ctx) {
  const id = spore.organism.id;
  const [operator, setOperator] = useState('');
  let draft: Draft;
  if (!isAccountId(operator)) draft = { error: 'Enter the new operator’s account id.' };
  else if (operator === spore.holding.owner) draft = { error: 'the operator must be a different account from the owner' };
  else draft = { method: 'register_operator', args: { spore_id: id, operator_id: operator }, deposit: '1', gasTgas: GAS };
  const w = actionWords('register-operator', status);
  const current = spore.agent.operator;
  return (
    <TxAction
      router={router}
      sporeId={id}
      verb={w.confirm}
      button={w.button}
      variant={variant}
      gate={gate}
      draft={draft}
      onOpen={() => setOperator('')}
      onFinal={onFinal}
      fields={
        <Field label="New operator account">
          <input className="mono" value={operator} onChange={(e) => setOperator(e.target.value.trim())} spellCheck={false} autoComplete="off" data-autofocus />
        </Field>
      }
      consequences={
        <ul>
          {current && (
            <li>
              <span className="mono">{shortAccount(current)}</span> stops working at once, and its open quotes become void.
            </li>
          )}
          <li>There is no revoke method: replacing the operator is how you revoke one.</li>
        </ul>
      }
    />
  );
}

function Deposit({ spore, router, gate, status, variant, onFinal }: Ctx) {
  const id = spore.organism.id;
  const [text, setText] = useState('');
  const v = amount(text, 'The amount');
  const draft: Draft = typeof v === 'string' ? { error: v } : { method: 'deposit', args: { spore_id: id }, deposit: v.toString(), gasTgas: GAS };
  const w = actionWords('deposit', status);
  return (
    <TxAction
      router={router}
      sporeId={id}
      verb={w.confirm}
      button={w.button}
      variant={variant}
      gate={gate}
      draft={draft}
      onOpen={() => setText('')}
      onFinal={onFinal}
      fields={
        <Field label="Amount (NEAR)" hint={`Balance now ${formatNear(spore.economy.balance)}`}>
          <input className="mono" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} data-autofocus />
        </Field>
      }
      consequences={
        <ul>
          <li>The attached amount is credited to Spore #{id}’s balance. Only the spore’s owner can withdraw it.</li>
          <li>A sale moves the balance to the buyer with the spore.</li>
        </ul>
      }
    />
  );
}

function Withdraw({ spore, router, gate, status, onFinal }: Ctx) {
  const id = spore.organism.id;
  const [text, setText] = useState('');
  const v = amount(text, 'The amount');
  const balance = BigInt(spore.economy.balance);
  let draft: Draft;
  if (typeof v === 'string') draft = { error: v };
  else if (v > balance) draft = { error: `insufficient balance (${formatNear(balance)})` };
  else draft = { method: 'withdraw', args: { spore_id: id, amount: v.toString() }, deposit: '1', gasTgas: GAS_WITHDRAW };
  const w = actionWords('withdraw', status);
  return (
    <TxAction
      router={router}
      sporeId={id}
      verb={w.confirm}
      button={w.button}
      variant="danger"
      gate={gate}
      draft={draft}
      failEvents={['withdraw_failed']}
      onOpen={() => setText('')}
      onFinal={onFinal}
      fields={
        <Field label="Amount (NEAR)" hint={`Balance ${formatNear(balance)}`}>
          <input className="mono" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} data-autofocus />
        </Field>
      }
      consequences={
        <ul>
          <li>
            Pays the amount from the spore’s balance to the owner, <span className="mono">{shortAccount(spore.holding.owner)}</span>. The call has no recipient
            argument.
          </li>
          <li>The agent has that much less to spend. If the transfer bounces, the contract restores the balance and logs the failure.</li>
        </ul>
      }
    />
  );
}

function List({ spore, router, gate, status, variant, onFinal }: Ctx) {
  const id = spore.organism.id;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const v = amount(text, 'The price');
  const payout = usePayout(router, id, typeof v === 'string' ? null : v, open);
  const draft: Draft = typeof v === 'string' ? { error: v } : { method: 'list', args: { spore_id: id, price: v.toString() }, deposit: '1', gasTgas: GAS };
  const w = actionWords('list', status);
  return (
    <TxAction
      router={router}
      sporeId={id}
      verb={w.confirm}
      button={w.button}
      variant={variant}
      gate={gate}
      draft={draft}
      onOpen={() => (setText(''), setOpen(true))}
      onFinal={onFinal}
      fields={
        <Field label="Price (NEAR)" hint={typeof v === 'string' ? undefined : <PayoutLine payout={payout} owner={spore.holding.owner} verbSeller="You get" />}>
          <input className="mono" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} data-autofocus />
        </Field>
      }
      consequences={
        <ul>
          <li>Listing blocks pause and withdraw until you delist.</li>
          <li>Anyone may buy it by attaching exactly the price. The buyer gets the NFT with its balance, tubes and age; its operator is cleared and its policy reset to paused.</li>
        </ul>
      }
    />
  );
}

function Delist({ spore, router, gate, status, variant, onFinal }: Ctx) {
  const id = spore.organism.id;
  const w = actionWords('delist', status);
  return (
    <TxAction
      router={router}
      sporeId={id}
      verb={w.confirm}
      button={w.button}
      variant={variant}
      gate={gate}
      draft={{ method: 'delist', args: { spore_id: id }, deposit: '1', gasTgas: GAS }}
      onFinal={onFinal}
      consequences={
        <ul>
          <li>Spore #{id} is no longer for sale. Pause and withdraw work again.</li>
        </ul>
      }
    />
  );
}

/**
 * Buy (Design §6.F). `balance` is the spore's ledger balance when the page
 * has it; the Marketplace card reads it from `spore_summary` when the dialog
 * opens (one read, on interaction).
 */
export function BuyAction({
  router,
  sporeId,
  owner,
  price,
  balance,
  gate,
  setupHref,
  onFinal,
}: {
  router: Router;
  sporeId: number;
  owner: string;
  price: string;
  balance: string | null;
  gate: Gate;
  setupHref: string;
  onFinal?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<{ balance: string } | { error: string } | null>(null);
  const payout = usePayout(router, sporeId, BigInt(price), open);
  useEffect(() => {
    if (!open || balance !== null) return;
    let live = true;
    router.sporeSummary(sporeId).then(
      (s) => live && setRead(s ? { balance: s.balance } : { error: 'no reading' }),
      (e) => live && setRead({ error: String((e as Error)?.message ?? e) }),
    );
    return () => {
      live = false;
    };
  }, [open, balance, router, sporeId]);
  const bal = balance ?? (read && 'balance' in read ? read.balance : null);
  const w = actionWords('buy', 'active', formatNear(price));
  return (
    <TxAction
      router={router}
      sporeId={sporeId}
      verb={w.confirm}
      button={w.button}
      variant="primary"
      gate={gate}
      draft={{ method: 'buy', args: { spore_id: sporeId }, deposit: price, gasTgas: GAS_BUY }}
      onOpen={() => setOpen(true)}
      onFinal={onFinal}
      fields={
        <p className="body">
          Price <span className="mono money">{formatNear(price)}</span> · <PayoutLine payout={payout} owner={owner} verbSeller="the seller gets" />
        </p>
      }
      consequences={
        <ul>
          <li>
            You get the NFT, its balance (
            {bal !== null ? (
              <span className="mono money">{formatNear(bal)}</span>
            ) : read && 'error' in read ? (
              <span className="mono">Could not read the balance: {read.error}</span>
            ) : (
              <LoadingBar ch={8} label="Reading the balance" />
            )}
            ), its tubes and its age.
          </li>
          <li>Its operator is cleared and its policy is reset to paused with a zero budget. It will not act until you register an operator and set a policy.</li>
          <li>Jobs in flight are refunded.</li>
          <li>Reputation reflects past settled trades; it does not predict future earnings.</li>
        </ul>
      }
      okNote={
        <p className="body">
          Spore #{sporeId} is yours. It is paused until you set a policy. <Link to={setupHref}>Set up Spore #{sporeId} →</Link>
        </p>
      }
    />
  );
}

const ACTIONS: Record<Exclude<OwnerAction, 'buy'>, (c: Ctx) => ReactNode> = {
  activate: Activate,
  'set-policy': SetPolicy,
  pause: Pause,
  'register-operator': RegisterOperator,
  deposit: Deposit,
  withdraw: Withdraw,
  list: List,
  delist: Delist,
};

/** The owner action bar (Design §6.D.1): one primary action and the rest under "More". Buy for anyone else when listed. */
export function OwnerActions({
  spore,
  router,
  config,
  epoch,
  setupHref,
  onChanged,
}: {
  spore: SporeView;
  router: Router;
  config: RouterConfig | null;
  epoch: EpochInfo | null;
  setupHref: string;
  onChanged: () => void;
}) {
  const wallet = useWallet();
  const [more, setMore] = useState(false);
  const view: WalletView = { phase: wallet.phase, accountId: wallet.accountId };
  const owner = wallet.phase === 'connected' && wallet.accountId === spore.holding.owner;
  const listed = spore.holding.listedPrice !== null;
  const status = spore.status.status;
  const bar = actionBar(status, listed, owner);
  const life: Life = { active: spore.organism.active, paused: spore.agent.paused, activeCount: epoch?.active.length, maxActive: config?.max_active };
  if (!bar.primary) return null;

  const ctx = (a: OwnerAction, variant: 'primary' | 'secondary'): Ctx => ({
    spore,
    router,
    config,
    gate: canAct(a, spore.holding, view, life),
    status,
    variant,
    onFinal: onChanged,
  });
  const render = (a: OwnerAction, variant: 'primary' | 'secondary') => {
    if (a === 'buy')
      return (
        <BuyAction
          router={router}
          sporeId={spore.organism.id}
          owner={spore.holding.owner}
          price={spore.holding.listedPrice!}
          balance={spore.economy.balance}
          gate={canAct('buy', spore.holding, view, life)}
          setupHref={setupHref}
          onFinal={onChanged}
        />
      );
    const C = ACTIONS[a];
    return <C {...ctx(a, variant)} />;
  };

  return (
    <div className="owner-actions" role="group" aria-label={owner ? 'Owner actions' : 'Market'}>
      {render(bar.primary, 'primary')}
      {bar.more.length > 0 && (
        <>
          <button type="button" className="btn btn-secondary" aria-expanded={more} aria-controls="owner-more" onClick={() => setMore((m) => !m)}>
            More
          </button>
          {/* Always mounted: a dialog opened from here must survive the list closing. */}
          <ul id="owner-more" className="owner-more" hidden={!more}>
            {bar.more.map((a) => (
              <li key={a}>{render(a, 'secondary')}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
