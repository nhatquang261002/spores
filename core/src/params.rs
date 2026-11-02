use crate::error::CoreError;
use crate::math::BPS;

/// One NEAR in yoctoNEAR.
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// How the epoch fee pool is paid out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolRule {
    /// SPEC §8.3 as first written: the whole pool is split by saturated weight.
    /// Kept for comparison only; the wash-trading sweep shows it pays attackers.
    Proportional,
    /// Each spore is paid `rebate_bps` of the break-even rate `fee * K / 2` per
    /// unit of saturated weight; the rest of the pool goes to the treasury.
    /// With `rebate_bps <= 10_000` a closed loop always loses money (see `pool`).
    CappedRebate { rebate_bps: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Params {
    /// Share of `D` lost per epoch, in basis points.
    pub decay_bps: u32,
    /// `D` added per epoch by a fully saturated edge (scale `ONE`).
    pub gain: u128,
    /// Saturation constant in yoctoNEAR: an edge with `q = K` gets half the gain.
    pub k: u128,
    /// Edges whose updated `D` falls below this are pruned to zero.
    pub d_min: u128,
    /// Router fee on each settled payment, rounded up.
    pub fee_bps: u32,
    pub pool_rule: PoolRule,
    /// Breadth damping: an edge gains in full only when both ends trade with at
    /// least this many distinct spores. 0 disables damping.
    pub breadth_full: u32,
    /// Share of an edge's `D` cut per rejected delivery on it. 0 disables.
    pub reject_bps: u32,
}

impl Params {
    /// The values in SPEC §8 as written, with the original pool rule and no damping.
    pub const fn spec() -> Self {
        Params {
            decay_bps: 2_500,
            gain: 1_000_000,
            k: NEAR / 2,
            d_min: 50_000,
            fee_bps: 100,
            pool_rule: PoolRule::Proportional,
            breadth_full: 0,
            reject_bps: 0,
        }
    }

    /// The defaults the router ships with. `K` is about one job's price: with
    /// `K = 0.5 NEAR` and jobs near 0.1 NEAR, honest tubes stayed near the
    /// pruning floor and a small wash ring out-ranked every honest spore.
    /// A rejected delivery halves the tube, so tubes remember reliability and
    /// not just past hires.
    pub const fn shipped() -> Self {
        Params {
            k: NEAR / 10,
            pool_rule: PoolRule::CappedRebate { rebate_bps: 5_000 },
            breadth_full: 4,
            reject_bps: 5_000,
            ..Self::spec()
        }
    }

    pub fn validate(&self) -> Result<(), CoreError> {
        if self.decay_bps == 0 || self.decay_bps as u128 > BPS {
            return Err(CoreError::BadParams("decay_bps must be in 1..=10000"));
        }
        if self.gain == 0 || self.gain > u64::MAX as u128 {
            return Err(CoreError::BadParams("gain must be in 1..=u64::MAX"));
        }
        if self.k == 0 {
            return Err(CoreError::BadParams("k must be positive"));
        }
        if self.fee_bps as u128 > BPS {
            return Err(CoreError::BadParams("fee_bps must be <= 10000"));
        }
        if self.reject_bps as u128 > BPS {
            return Err(CoreError::BadParams("reject_bps must be <= 10000"));
        }
        if let PoolRule::CappedRebate { rebate_bps } = self.pool_rule {
            if rebate_bps as u128 > BPS {
                return Err(CoreError::BadParams("rebate_bps must be <= 10000"));
            }
        }
        Ok(())
    }

    /// Steady-state `D` of an edge saturated every epoch: `gain / decay`.
    pub fn d_max(&self) -> u128 {
        self.gain * BPS / self.decay_bps as u128
    }
}

impl Default for Params {
    fn default() -> Self {
        Self::shipped()
    }
}
