//! Living allowance (SPEC §7.2): `min(owner_budget, base + trust_gain * R)`.

use crate::math::{mul_div, REP_ONE};

/// `trust_gain` is yoctoNEAR of extra budget per `REP_ONE` of reputation.
pub fn effective_budget(owner_budget: u128, base_budget: u128, trust_gain: u128, reputation: u128) -> u128 {
    let earned = mul_div(trust_gain, reputation, REP_ONE).unwrap_or(u128::MAX);
    owner_budget.min(base_budget.saturating_add(earned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_exceeds_either_bound_and_drops_with_reputation() {
        let owner = 1_000;
        let mut last = u128::MAX;
        for r in (0..=10_000u128).rev().step_by(500) {
            let b = effective_budget(owner, 100, 50, r);
            assert!(b <= owner && b <= 100 + 50 * r / REP_ONE);
            assert!(b <= last);
            last = b;
        }
        assert_eq!(effective_budget(owner, 100, 50, 0), 100);
        assert_eq!(effective_budget(owner, 100, u128::MAX, u128::MAX), owner);
    }
}
