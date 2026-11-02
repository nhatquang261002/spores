//! xoshiro128** (32-bit), chosen because every operation maps to `Math.imul`
//! and unsigned shifts in JS. State comes from 16 bytes of the spore seed.

#[derive(Clone)]
pub struct Rng {
    s: [u32; 4],
}

impl Rng {
    /// `bytes` is 16 bytes, read as four little-endian words. An all-zero state
    /// (a fixed point of the generator) is replaced by `s0 = 1`. Eight outputs
    /// are discarded so close seeds diverge.
    pub fn from_bytes(bytes: &[u8]) -> Self {
        let mut s = [0u32; 4];
        for (i, w) in s.iter_mut().enumerate() {
            *w = u32::from_le_bytes([bytes[4 * i], bytes[4 * i + 1], bytes[4 * i + 2], bytes[4 * i + 3]]);
        }
        if s == [0; 4] {
            s[0] = 1;
        }
        let mut r = Rng { s };
        for _ in 0..8 {
            r.next_u32();
        }
        r
    }

    pub fn next_u32(&mut self) -> u32 {
        let s = &mut self.s;
        let result = s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = s[1] << 9;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = s[3].rotate_left(11);
        result
    }
}
