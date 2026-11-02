//! Provider pricing and consumer demand (SPEC §6.3), shared by `sim` and the
//! live agents so both follow the same rules.

use crate::math::BPS;
use crate::rng::stream;

pub const MARGIN_START: u32 = 2_000;
pub const MARGIN_MIN: u32 = 500;
pub const MARGIN_MAX: u32 = 6_000;
pub const MARGIN_STEP: u32 = 250;

/// `quote = cost * (1 + margin)`, rounded down.
pub fn quote_price(cost: u128, margin_bps: u32) -> u128 {
    cost * (BPS + margin_bps as u128) / BPS
}

/// End-of-epoch margin update: up one step after two or more wins, down one
/// step after none, within `MARGIN_MIN..=MARGIN_MAX`.
pub fn next_margin(margin_bps: u32, wins: u32) -> u32 {
    if wins >= 2 {
        (margin_bps + MARGIN_STEP).min(MARGIN_MAX)
    } else if wins == 0 {
        margin_bps.saturating_sub(MARGIN_STEP).max(MARGIN_MIN)
    } else {
        margin_bps
    }
}

/// The service a consumer's `j`-th job of epoch `t` asks for: uniform over
/// every service except the consumer's own. Needs `services >= 2`.
pub fn job_service(seed: u64, t: u64, consumer: u64, j: u64, services: u32, own: u32) -> u32 {
    let draw = stream(&[seed, t, consumer, j, 0]).below(services as u64 - 1) as u32;
    if draw >= own {
        draw + 1
    } else {
        draw
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn margin_moves_one_step_within_bounds() {
        assert_eq!(next_margin(MARGIN_START, 2), MARGIN_START + MARGIN_STEP);
        assert_eq!(next_margin(MARGIN_START, 1), MARGIN_START);
        assert_eq!(next_margin(MARGIN_START, 0), MARGIN_START - MARGIN_STEP);
        assert_eq!(next_margin(MARGIN_MAX, 5), MARGIN_MAX);
        assert_eq!(next_margin(MARGIN_MIN, 0), MARGIN_MIN);
        assert_eq!(next_margin(100, 0), MARGIN_MIN);
    }

    #[test]
    fn quote_adds_margin_rounding_down() {
        assert_eq!(quote_price(1_000, 2_000), 1_200);
        assert_eq!(quote_price(7, 2_500), 8);
    }

    #[test]
    fn job_service_never_picks_own() {
        for own in 0..4 {
            for t in 0..50 {
                let s = job_service(9, t, 3, 0, 4, own);
                assert!(s < 4 && s != own);
            }
        }
    }
}
