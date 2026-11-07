// Money and agent figures for one spore (Design §7): `BalanceDisplay`,
// `AllowanceDisplay` and `AgentStatus`. Amounts come from yocto strings
// (BigInt, §8.1); the exact yocto is in the tooltip. The allowance is
// computed by the contract at read time, which the tooltip says (§4.2: no
// in-line mark for that).
import type { RouterConfig } from '../chain/router';
import type { SporeEconomy } from '../model/spore';
import type { AgentAuthorization, SporeStatus } from '../model/types';
import { formatClock, formatNear, formatR, shortAccount } from '../ui/format';
import { Unavailable } from '../ui/states';
import { Tooltip } from '../ui/Tooltip';

export function BalanceDisplay({ yocto, variant = 'inline', staleAt }: { yocto: string; variant?: 'figure' | 'inline'; staleAt?: number | null }) {
  return (
    <Tooltip content={<span className="mono">{yocto} yoctoNEAR{staleAt != null ? ` · as of ${formatClock(staleAt)}` : ''}</span>}>
      <span className={`${variant === 'figure' ? 'figure' : 'mono'} money${staleAt != null ? ' is-stale' : ''}`}>
        {staleAt != null && (
          <span className="glyph-caution" aria-hidden="true">
            !
          </span>
        )}
        {formatNear(yocto)}
      </span>
    </Tooltip>
  );
}

/** "min(1.50, 0.10 + 0.20 × 1.09) = 0.32 NEAR": the router's formula with its numbers (Reference B). */
export function allowanceFormula(budgetPerEpoch: string, reputation: number, config: Pick<RouterConfig, 'base_budget' | 'trust_gain'> | null): string {
  const budget = formatNear(budgetPerEpoch).replace(' NEAR', '');
  if (!config) return `min(owner budget ${budget}, base + trust_gain × R)`;
  const base = formatNear(config.base_budget).replace(' NEAR', '');
  const gain = formatNear(config.trust_gain).replace(' NEAR', '');
  return `min(${budget}, ${base} + ${gain} × ${formatR(reputation)})`;
}

/** `left 0.18 of 0.30 NEAR` + a thin meter; `✕ Spent` once nothing is left of a non-zero allowance. */
export function AllowanceDisplay({
  economy,
  formula,
  paused,
}: {
  economy: SporeEconomy;
  /** From `allowanceFormula`. */
  formula: string;
  paused: boolean;
}) {
  const total = BigInt(economy.effectiveBudget);
  const left = economy.budgetLeft === null ? null : BigInt(economy.budgetLeft);
  const tip = (
    <>
      Allowance = <span className="mono">{formula}</span> = <span className="mono">{formatNear(total)}</span> per epoch, computed by the contract at read
      time. {paused && 'The policy is paused, so the agent cannot spend it.'}
    </>
  );
  const frac = left === null || total === 0n ? 0 : Number((left * 1000n) / total) / 1000;
  return (
    <span className="allowance">
      <Tooltip content={tip}>
        <span className="mono">
          {left === null ? (
            <>
              left <Unavailable reason="This recording has no per-epoch spend, only the effective budget." /> of {formatNear(total)}
            </>
          ) : left === 0n && total > 0n ? (
            <>
              <span className="word-warn">
                <span aria-hidden="true">✕</span> Spent
              </span>{' '}
              · 0.00 of {formatNear(total)}
            </>
          ) : (
            <>
              left {formatNear(left).replace(' NEAR', '')} of {formatNear(total)}
            </>
          )}
        </span>
      </Tooltip>
      {left !== null && (
        <span className="allowance-meter" aria-hidden="true">
          <span style={{ width: `${Math.round(frac * 100)}%` }} />
        </span>
      )}
    </span>
  );
}

/** Operator and its generation (`operator_gen` counts registrations; a transfer clears the operator). */
export function AgentStatus({ agent, status }: { agent: AgentAuthorization; status: SporeStatus }) {
  if (status === 'dormant') return <span className="body unavailable">No agent: the spore was never activated.</span>;
  if (!agent.operator)
    return (
      <span className="body">
        <span className="mono">No operator</span>
        <span className="unavailable"> · {status === 'control-reset' ? 'cleared by a transfer or sale; the owner registers a new one' : 'none registered'}</span>
      </span>
    );
  return (
    <span className="body agent-status">
      <span className="glyph-agent" aria-hidden="true">
        ◆
      </span>{' '}
      <Tooltip content={<span className="mono">{agent.operator}</span>}>
        <span className="mono">{shortAccount(agent.operator)}</span>
      </Tooltip>{' '}
      <span className="mono unavailable">gen {agent.operatorGen}</span>
      {status === 'awaiting-policy' && <span className="unavailable"> · awaiting the owner’s policy</span>}
    </span>
  );
}
