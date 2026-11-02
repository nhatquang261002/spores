//! Exact integer helpers. Every division rounds down unless the name says `ceil`.

/// Fixed-point scale for conductivity `D`, saturation weights and `D_norm`.
pub const ONE: u128 = 1_000_000;
/// Basis points.
pub const BPS: u128 = 10_000;
/// Reputation scale: `isqrt(ONE)`, so one edge at `D = ONE` adds `REP_ONE`.
pub const REP_ONE: u128 = 1_000;

/// Floor of the square root.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // Newton's method from a starting point at or above the root decreases
    // monotonically to floor(sqrt(n)).
    let bits = 128 - n.leading_zeros();
    let mut x: u128 = 1 << bits.div_ceil(2);
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// Full 256-bit product of two u128 values as `(high, low)`.
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    const M: u128 = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & M);
    let (b1, b0) = (b >> 64, b & M);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & M) + (p10 & M);
    let lo = (p00 & M) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// `(a * b / d, a * b % d)` computed exactly in 256 bits.
/// `None` if `d == 0` or the quotient does not fit in u128.
pub fn mul_div_rem(a: u128, b: u128, d: u128) -> Option<(u128, u128)> {
    if d == 0 {
        return None;
    }
    if let Some(p) = a.checked_mul(b) {
        return Some((p / d, p % d));
    }
    let (hi, lo) = mul_wide(a, b);
    if hi >= d {
        return None;
    }
    // Restoring long division of (hi, lo) by d; rem < d holds between steps.
    let mut rem = hi;
    let mut quot: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        quot <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            quot |= 1;
        }
    }
    Some((quot, rem))
}

/// `floor(a * b / d)`, exact for any inputs whose result fits in u128.
pub fn mul_div(a: u128, b: u128, d: u128) -> Option<u128> {
    mul_div_rem(a, b, d).map(|(q, _)| q)
}

/// `ceil(a * b / d)`.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    let (q, r) = mul_div_rem(a, b, d)?;
    if r == 0 {
        Some(q)
    } else {
        q.checked_add(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isqrt_small_and_boundaries() {
        for n in 0u128..10_000 {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n, "n={n}");
        }
        for k in [1u128, 2, 3, 1 << 32, (1 << 64) - 1] {
            assert_eq!(isqrt(k * k), k);
            assert_eq!(isqrt(k * k - 1), k - 1);
        }
        assert_eq!(isqrt(u128::MAX), u64::MAX as u128);
    }

    #[test]
    fn mul_div_matches_direct_when_no_overflow() {
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        for _ in 0..10_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let a = (x >> 3) as u128;
            let b = (x.rotate_left(17) >> 40) as u128;
            let d = ((x >> 20) as u128) | 1;
            assert_eq!(mul_div_rem(a, b, d), Some((a * b / d, a * b % d)));
        }
    }

    #[test]
    fn mul_div_wide_path() {
        let a = 1u128 << 127;
        assert_eq!(mul_div(a, 4, 8), Some(1 << 126));
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
        // (2^128 - 1)^2 / 2^127 overflows.
        assert_eq!(mul_div(u128::MAX, u128::MAX, 1 << 127), None);
        // 1e25 * 1e20 / 3e20: the product 1e45 does not fit u128.
        let q = mul_div(10u128.pow(25), 10u128.pow(20), 3 * 10u128.pow(20)).unwrap();
        assert_eq!(q, 10u128.pow(25) / 3);
        assert_eq!(mul_div(1, 1, 0), None);
    }

    #[test]
    fn mul_div_wide_identity() {
        // q * d + r == a * b, checked in 256 bits.
        let mut x: u128 = 0x1234_5678_9ABC_DEF0_0FED_CBA9_8765_4321;
        for _ in 0..2_000 {
            x = x
                .wrapping_mul(0x2545_F491_4F6C_DD1D_9E37_79B9_7F4A_7C15)
                .wrapping_add(1);
            let a = x;
            let b = x.rotate_left(61) >> 8;
            let d = (x.rotate_left(29) | 1).max(b / 2 + 1);
            if let Some((q, r)) = mul_div_rem(a, b, d) {
                assert!(r < d);
                let (h1, l1) = mul_wide(q, d);
                let (l2, c) = l1.overflowing_add(r);
                assert_eq!((h1 + c as u128, l2), mul_wide(a, b));
            }
        }
    }

    #[test]
    fn ceil_rounds_up_only_with_remainder() {
        assert_eq!(mul_div_ceil(10, 3, 3), Some(10));
        assert_eq!(mul_div_ceil(10, 1, 3), Some(4));
        assert_eq!(mul_div_ceil(1, 100, 10_000), Some(1));
        assert_eq!(mul_div_ceil(0, 100, 10_000), Some(0));
    }
}
