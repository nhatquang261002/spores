use crate::error::CoreError;
use crate::math::{mul_div_ceil, BPS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeSplit {
    pub fee: u128,
    pub forwarded: u128,
}

/// Splits a settled payment into the router fee and the amount credited to the
/// provider. The fee rounds up, so splitting a payment into dust cannot dodge
/// it: any nonzero payment with `fee_bps > 0` pays at least 1 yoctoNEAR.
pub fn split_payment(amount: u128, fee_bps: u32) -> Result<FeeSplit, CoreError> {
    if fee_bps as u128 > BPS {
        return Err(CoreError::BadParams("fee_bps must be <= 10000"));
    }
    let fee = mul_div_ceil(amount, fee_bps as u128, BPS).ok_or(CoreError::Overflow)?;
    Ok(FeeSplit {
        fee,
        forwarded: amount - fee,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::NEAR;

    #[test]
    fn fee_plus_forwarded_is_amount() {
        for amount in [0, 1, 99, 100, 101, 12_345, NEAR, u128::MAX] {
            for bps in [0, 1, 100, 250, 10_000] {
                let s = split_payment(amount, bps).unwrap();
                assert_eq!(s.fee + s.forwarded, amount);
            }
        }
    }

    #[test]
    fn fee_rounds_up() {
        assert_eq!(split_payment(1, 100).unwrap().fee, 1);
        assert_eq!(split_payment(100, 100).unwrap().fee, 1);
        assert_eq!(split_payment(101, 100).unwrap().fee, 2);
        assert_eq!(split_payment(NEAR, 100).unwrap().fee, NEAR / 100);
        assert_eq!(split_payment(5, 0).unwrap().fee, 0);
    }

    #[test]
    fn rejects_bad_bps() {
        assert!(split_payment(1, 10_001).is_err());
    }
}
