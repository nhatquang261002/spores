//! Spores renderer: integer-only Physarum image from chain state.
//!
//! One pure function, `render(&Spore) -> Vec<u8>`, gives the same bytes on every
//! target (native, wasm32) and in the JS port. Inputs are the spore's seed, its
//! age in epochs and its edge list `(neighbour id, D)`. See `docs/results.md`.

pub mod cases;
pub mod paint;
pub mod rng;
pub mod sim;
pub mod trig;
pub mod wasm;

use sha2::{Digest, Sha256};

/// Bump on any change that alters output bytes; it is part of the image hash.
pub const RENDERER_VERSION: u32 = 1;
/// Image side in pixels (square, RGB).
pub const N: usize = 512;
pub const C: i32 = N as i32 / 2;

/// Everything the image depends on.
#[derive(Clone, Debug)]
pub struct Spore {
    pub seed: [u8; 32],
    /// Epochs since activation.
    pub age: u32,
    /// `(neighbour id, D)`, any order; `new` sorts by id.
    pub edges: Vec<(u32, u64)>,
}

impl Spore {
    pub fn new(seed: [u8; 32], age: u32, mut edges: Vec<(u32, u64)>) -> Self {
        edges.sort();
        Spore { seed, age, edges }
    }

    /// Byte layout shared with the JS and wasm callers:
    /// seed[32] | age u32 | n u32 | n * (id u32, d u64), all little-endian.
    pub fn from_bytes(b: &[u8]) -> Option<Self> {
        if b.len() < 40 {
            return None;
        }
        let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let n = u32_at(36) as usize;
        if b.len() != 40 + 12 * n {
            return None;
        }
        let edges = (0..n)
            .map(|i| {
                let o = 40 + 12 * i;
                (u32_at(o), u64::from_le_bytes(b[o + 4..o + 12].try_into().unwrap()))
            })
            .collect();
        Some(Spore::new(b[0..32].try_into().unwrap(), u32_at(32), edges))
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut v = self.seed.to_vec();
        v.extend(self.age.to_le_bytes());
        v.extend((self.edges.len() as u32).to_le_bytes());
        for &(id, d) in &self.edges {
            v.extend(id.to_le_bytes());
            v.extend(d.to_le_bytes());
        }
        v
    }
}

pub fn isqrt_u64(n: u64) -> u64 {
    if n < 2 {
        return n;
    }
    let mut x = 1u64 << (64 - n.leading_zeros()).div_ceil(2);
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// Render to N*N*3 RGB bytes.
pub fn render(sp: &Spore) -> Vec<u8> {
    let t = trig::Tables::new(2, 11);
    paint::paint(sp, &sim::simulate(sp, &t), &t)
}

/// Trail grid after the simulation (the intermediate the vectors also pin).
pub fn trail(sp: &Spore) -> Vec<i32> {
    sim::simulate(sp, &trig::Tables::new(2, 11))
}

/// sha256("spores/img/v1" | version u32 | N u32 | N u32 | rgb), the value for `commit_image`.
pub fn image_hash(rgb: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"spores/img/v1");
    h.update(RENDERER_VERSION.to_le_bytes());
    h.update((N as u32).to_le_bytes());
    h.update((N as u32).to_le_bytes());
    h.update(rgb);
    h.finalize().into()
}

pub fn trail_hash(trail: &[i32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"spores/trail/v1");
    for v in trail {
        h.update(v.to_le_bytes());
    }
    h.finalize().into()
}

pub fn sin_table_hash() -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"spores/sin/v1");
    for v in trig::sin_table() {
        h.update(v.to_le_bytes());
    }
    h.finalize().into()
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
