//! Deterministic randomness for the simulation: the integer generator lives in
//! `spores_core::rng`; floats (hidden quality, dice) stay here.

pub use spores_core::rng::{stream, Rng};

pub trait Unit {
    /// Uniform in `[0, 1)`.
    fn unit(&mut self) -> f64;
}

impl Unit for Rng {
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}
