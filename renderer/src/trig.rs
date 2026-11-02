//! Integer sine table. No libm: the table comes from a Q60 Taylor series on
//! i128, so Rust, wasm and the JS port (BigInt) compute identical values.
//!
//! Angles are in 1/4096 of a turn. Values are Q16 (65536 = 1.0).

pub const TURN: usize = 4096;
pub const QUARTER: usize = 1024;
/// floor(pi * 2^60)
const PI_Q60: i128 = 0x3243_F6A8_885A_308D;

/// sin(2*pi*k/4096) in Q60 for k in 0..=1024.
fn sin_q60(k: i128) -> i128 {
    let x = PI_Q60 * k / 2048;
    let x2 = (x * x) >> 60;
    let mut term = x;
    let mut sum = x;
    let mut n: i128 = 1;
    loop {
        term = ((term * x2) >> 60) / ((2 * n) * (2 * n + 1));
        if term == 0 {
            break;
        }
        if n % 2 == 1 {
            sum -= term;
        } else {
            sum += term;
        }
        n += 1;
    }
    sum
}

/// Q16 sine for the whole turn, built from the first quadrant by symmetry.
pub fn sin_table() -> Vec<i32> {
    let quarter: Vec<i32> = (0..=QUARTER as i128)
        .map(|k| ((sin_q60(k) + (1 << 43)) >> 44) as i32)
        .collect();
    (0..TURN)
        .map(|a| {
            let r = a & (QUARTER - 1);
            let v = if (a >> 10) & 1 == 0 {
                quarter[r]
            } else {
                quarter[QUARTER - r]
            };
            if a >> 11 == 0 {
                v
            } else {
                -v
            }
        })
        .collect()
}

/// Lookup tables derived once from the sine table.
pub struct Tables {
    pub sin: Vec<i32>,
    /// Per-heading move in Q16 pixels (cos/sin times the step length).
    pub step_dx: Vec<i32>,
    pub step_dy: Vec<i32>,
    /// Per-heading sensor offset in whole pixels, rounded.
    pub sense_dx: Vec<i32>,
    pub sense_dy: Vec<i32>,
}

impl Tables {
    pub fn new(step_px: i32, sense_px: i32) -> Self {
        let sin = sin_table();
        let cos = |a: usize| sin[(a + QUARTER) & (TURN - 1)];
        let round16 = |v: i32| (v + 32768) >> 16;
        Tables {
            step_dx: (0..TURN).map(|a| cos(a) * step_px).collect(),
            step_dy: (0..TURN).map(|a| sin[a] * step_px).collect(),
            sense_dx: (0..TURN).map(|a| round16(cos(a) * sense_px)).collect(),
            sense_dy: (0..TURN).map(|a| round16(sin[a] * sense_px)).collect(),
            sin,
        }
    }

    pub fn cos(&self, a: usize) -> i32 {
        self.sin[(a + QUARTER) & (TURN - 1)]
    }
}
