//! Epoch fee pool payout (SPEC §8.3, revised).
//!
//! Why the revision: fees collected per unit of saturated weight are always at
//! least `fee * K / 2` (because `q / (q + K) <= q / K`), and are far higher when
//! honest edges carry more than `K`. Splitting the whole pool by weight
//! therefore pays a closed loop of small payments more than its fees.
//! `CappedRebate` pays each spore at most `rebate * fee * K / 2` per unit of
//! weight. On an edge with volume `q` the two ends together get back at most
//! `fee * q * K / (q + K)`, which is less than the `fee * q` paid, so a loop
//! between one owner's spores always loses money. The same bound shows the
//! rebates never exceed the pool, so the remainder goes to the treasury.

use std::collections::BTreeMap;

use crate::graph::{saturation, EdgeMap, SporeId};
use crate::math::{mul_div, mul_div_rem, BPS, ONE};
use crate::params::{Params, PoolRule};

/// `w_i = sum over edges of i of floor(ONE * q / (q + K))`.
pub fn weights(p: &Params, flows: &EdgeMap) -> BTreeMap<SporeId, u128> {
    let mut out: BTreeMap<SporeId, u128> = BTreeMap::new();
    for (e, q) in flows {
        let w = saturation(*q, p.k);
        if w == 0 {
            continue;
        }
        *out.entry(e.a()).or_default() += w;
        *out.entry(e.b()).or_default() += w;
    }
    out
}

/// Largest cap a spore with weight `w` can receive under `CappedRebate`:
/// `floor(floor(K * w / ONE) * fee_bps * rebate_bps / (2 * 10000^2))`.
pub fn rebate_cap(p: &Params, w: u128) -> u128 {
    let PoolRule::CappedRebate { rebate_bps } = p.pool_rule else {
        return u128::MAX;
    };
    let volume = mul_div(p.k, w, ONE).unwrap_or(u128::MAX);
    let rate = p.fee_bps as u128 * rebate_bps as u128;
    mul_div(volume, rate, 2 * BPS * BPS).unwrap_or(u128::MAX)
}

/// Splits `amount` in proportion to `weights` by largest remainder, so the
/// shares sum to exactly `amount`. Ties go to the lower spore id. Returns an
/// empty map when the total weight is zero.
pub fn split_proportional(amount: u128, weights: &BTreeMap<SporeId, u128>) -> BTreeMap<SporeId, u128> {
    let total: u128 = weights.values().sum();
    let mut out = BTreeMap::new();
    if total == 0 || amount == 0 {
        return out;
    }
    let mut given = 0u128;
    let mut remainders: Vec<(u128, SporeId)> = Vec::with_capacity(weights.len());
    for (id, w) in weights {
        let (share, rem) = mul_div_rem(amount, *w, total).expect("share <= amount");
        given += share;
        remainders.push((rem, *id));
        out.insert(*id, share);
    }
    // Highest remainder first, then lowest id.
    remainders.sort_unstable_by(|x, y| y.0.cmp(&x.0).then(x.1.cmp(&y.1)));
    let left = amount - given;
    for (_, id) in remainders.iter().take(left as usize) {
        *out.get_mut(id).expect("present") += 1;
    }
    out.retain(|_, v| *v > 0);
    out
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Distribution {
    pub payouts: BTreeMap<SporeId, u128>,
    pub treasury: u128,
}

impl Distribution {
    pub fn total(&self) -> u128 {
        self.payouts.values().sum::<u128>() + self.treasury
    }
}

/// Pays out the epoch pool. `payouts + treasury == pool` always.
pub fn distribute(p: &Params, pool: u128, weights: &BTreeMap<SporeId, u128>) -> Distribution {
    match p.pool_rule {
        PoolRule::Proportional => {
            let payouts = split_proportional(pool, weights);
            let paid: u128 = payouts.values().sum();
            Distribution {
                payouts,
                treasury: pool - paid,
            }
        }
        PoolRule::CappedRebate { .. } => {
            let caps: BTreeMap<SporeId, u128> = weights
                .iter()
                .map(|(id, w)| (*id, rebate_cap(p, *w)))
                .filter(|(_, c)| *c > 0)
                .collect();
            let wanted = caps.values().fold(0u128, |a, c| a.saturating_add(*c));
            if wanted <= pool {
                Distribution {
                    payouts: caps,
                    treasury: pool - wanted,
                }
            } else {
                // Unreachable when every payment paid `fee_bps` (see module
                // docs); kept so a mid-epoch parameter change cannot overdraw.
                let payouts = split_proportional(pool, &caps);
                let paid: u128 = payouts.values().sum();
                Distribution {
                    payouts,
                    treasury: pool - paid,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fee::split_payment;
    use crate::graph::Edge;
    use crate::params::NEAR;

    fn flows(items: &[(u32, u32, u128)]) -> EdgeMap {
        items.iter().map(|(a, b, q)| (Edge::new(*a, *b).unwrap(), *q)).collect()
    }

    #[test]
    fn proportional_sums_to_pool_with_largest_remainder() {
        let w: BTreeMap<SporeId, u128> = [(1, 1), (2, 1), (3, 1)].into_iter().collect();
        let s = split_proportional(10, &w);
        assert_eq!(s.values().sum::<u128>(), 10);
        assert_eq!(s[&1], 4);
        assert_eq!(s[&2], 3);
        assert_eq!(s[&3], 3);
        assert!(split_proportional(10, &BTreeMap::new()).is_empty());
    }

    #[test]
    fn empty_epoch_distributes_nothing() {
        for p in [Params::spec(), Params::shipped()] {
            let d = distribute(&p, 0, &BTreeMap::new());
            assert!(d.payouts.is_empty());
            assert_eq!(d.treasury, 0);
        }
    }

    #[test]
    fn hundredfold_payment_is_not_hundredfold_weight() {
        let p = Params::shipped();
        let small = weights(&p, &flows(&[(0, 1, NEAR / 10)]))[&0];
        let big = weights(&p, &flows(&[(0, 1, 10 * NEAR)]))[&0];
        assert!(big < 6 * small);
    }

    /// Fees and rebates for a closed loop of `loop_q` on each edge of a k-cycle.
    fn closed_loop(p: &Params, k: u32, loop_q: u128, other: &EdgeMap) -> (u128, u128) {
        let mut f = other.clone();
        let mut fees = 0u128;
        for i in 0..k {
            let e = Edge::new(100 + i, 100 + (i + 1) % k).unwrap();
            *f.entry(e).or_default() += loop_q;
            fees += split_payment(loop_q, p.fee_bps).unwrap().fee;
        }
        let honest_fees: u128 = other.values().map(|q| split_payment(*q, p.fee_bps).unwrap().fee).sum();
        let d = distribute(p, fees + honest_fees, &weights(p, &f));
        assert_eq!(d.total(), fees + honest_fees);
        let back: u128 = (0..k).map(|i| d.payouts.get(&(100 + i)).copied().unwrap_or(0)).sum();
        (fees, back)
    }

    #[test]
    fn capped_rebate_makes_loops_lose_and_spec_rule_does_not() {
        // Honest traffic well above K on a few edges.
        let honest = flows(&[(1, 2, 5 * NEAR), (2, 3, 5 * NEAR), (3, 4, 5 * NEAR)]);
        let small = NEAR / 20;
        let (fees, back) = closed_loop(&Params::spec(), 3, small, &honest);
        assert!(back > fees, "spec rule: expected the loop to profit");
        for rebate_bps in [5_000, 10_000] {
            let p = Params {
                pool_rule: PoolRule::CappedRebate { rebate_bps },
                ..Params::spec()
            };
            for q in [1, 1_000, NEAR / 1000, NEAR / 20, NEAR, 1000 * NEAR] {
                for k in [2, 3] {
                    let (fees, back) = closed_loop(&p, k, q, &honest);
                    assert!(back < fees, "rebate {rebate_bps} k {k} q {q}: {back} >= {fees}");
                }
            }
        }
    }
}
