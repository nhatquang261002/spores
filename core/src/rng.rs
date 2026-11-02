//! Deterministic randomness shared by `sim` and the off-chain agents (task
//! draws, hidden quality). Not consensus code: the router never calls it.

/// SplitMix64.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }

    pub fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            let j = self.below(i as u64 + 1) as usize;
            v.swap(i, j);
        }
    }
}

/// Derives an independent stream from a tuple of keys, so the same job gets
/// the same dice in every hiring mode (common random numbers).
pub fn stream(keys: &[u64]) -> Rng {
    let mut r = Rng::new(0x05EE_D0F5_7095);
    let mut acc = 0u64;
    for k in keys {
        acc = r.next_u64() ^ k.wrapping_mul(0xD6E8_FEB8_6659_FD93) ^ acc.rotate_left(17);
        r = Rng::new(acc);
    }
    r
}
