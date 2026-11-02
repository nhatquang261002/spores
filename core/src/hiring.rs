//! Rule-based provider choice (SPEC §6.3): `score = quote / (1 + w * D_norm)`.

use crate::graph::SporeId;
use crate::math::{mul_div, BPS, ONE};

/// What `D_norm` is measured against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Norm {
    /// `min(D / reference, 1)`, e.g. `reference = Params::d_max()`.
    Absolute(u128),
    /// `D` over the strongest candidate tube. Scale-free, but a consumer's only
    /// tube always counts in full, so rejections stop mattering.
    Relative,
}

/// The shipped rule (SPEC §6.3): `w = 4`, `D_norm` relative to the strongest
/// candidate tube.
pub const SHIPPED_W_BPS: u32 = 40_000;
pub const SHIPPED_NORM: Norm = Norm::Relative;

/// `min(d, reference) / reference` in `0..=ONE`; zero when `reference` is 0.
pub fn d_norm(d: u128, reference: u128) -> u128 {
    if reference == 0 {
        return 0;
    }
    mul_div(d.min(reference), ONE, reference).expect("d <= reference")
}

/// Effective price: `floor(quote / (1 + w * D_norm))`, with `w = w_bps / 10000`.
pub fn score(quote: u128, d: u128, reference: u128, w_bps: u32) -> u128 {
    let denom = BPS * ONE + w_bps as u128 * d_norm(d, reference);
    mul_div(quote, BPS * ONE, denom).expect("denominator >= numerator")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quote {
    pub provider: SporeId,
    pub price: u128,
    /// Conductivity of the tube between consumer and provider.
    pub d: u128,
}

/// Index of the winning quote: lowest score, then lowest price, then lowest
/// provider id.
pub fn pick(quotes: &[Quote], w_bps: u32, norm: Norm) -> Option<usize> {
    let reference = match norm {
        Norm::Absolute(r) => r,
        Norm::Relative => quotes.iter().map(|q| q.d).max().unwrap_or(0),
    };
    quotes
        .iter()
        .enumerate()
        .min_by_key(|(_, q)| (score(q.price, q.d, reference, w_bps), q.price, q.provider))
        .map(|(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_tube_halves_price_at_w_one() {
        assert_eq!(score(1_000, 0, 0, 10_000), 1_000);
        assert_eq!(score(1_000, 500, 500, 10_000), 500);
        assert_eq!(score(1_000, 900, 500, 10_000), 500);
        assert_eq!(score(1_000, 250, 500, 10_000), 666);
        assert_eq!(score(1_000, 500, 500, 0), 1_000);
    }

    #[test]
    fn pick_breaks_ties_deterministically() {
        let qs = [
            Quote {
                provider: 5,
                price: 100,
                d: 0,
            },
            Quote {
                provider: 2,
                price: 100,
                d: 0,
            },
            Quote {
                provider: 9,
                price: 150,
                d: 80_000,
            },
        ];
        assert_eq!(pick(&qs, 0, Norm::Relative), Some(1));
        // With tubes, 150 / 2 = 75 beats 100.
        assert_eq!(pick(&qs, 10_000, Norm::Relative), Some(2));
        assert_eq!(pick(&qs, 10_000, Norm::Absolute(80_000)), Some(2));
        // A weak tube against a large reference is not enough: 150 / 1.1 > 100.
        assert_eq!(pick(&qs, 10_000, Norm::Absolute(800_000)), Some(1));
        assert_eq!(pick(&[], 10_000, Norm::Relative), None);
    }
}
