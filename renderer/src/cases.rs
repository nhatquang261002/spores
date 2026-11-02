//! Fixed render cases shared by the tests, the CLI and `vectors/renderer.json`.

use crate::Spore;
use sha2::{Digest, Sha256};

pub const MATURE_EDGES: [(u32, u64); 8] = [
    (3, 880_000),
    (12, 430_000),
    (19, 990_000),
    (28, 260_000),
    (35, 670_000),
    (41, 510_000),
    (52, 340_000),
    (58, 150_000),
];

pub fn seed_for(label: &str) -> [u8; 32] {
    Sha256::digest(format!("spores/renderer/test-seed|{label}")).into()
}

/// First seed derived from `label` whose palette index is `p`.
pub fn seed_with_palette(label: &str, p: usize) -> [u8; 32] {
    (0u32..)
        .map(|i| seed_for(&format!("{label}|{i}")))
        .find(|s| s[31] as usize % 5 == p)
        .unwrap()
}

pub fn all() -> Vec<(String, Spore)> {
    let s7 = seed_with_palette("spore-7", 0);
    let mut v = vec![
        ("dormant".to_string(), Spore::new(s7, 0, vec![])),
        (
            "young".to_string(),
            Spore::new(s7, 4, vec![(19, 240_000), (35, 160_000)]),
        ),
        ("mature".to_string(), Spore::new(s7, 41, MATURE_EDGES.to_vec())),
        (
            "mature_minus_edge".to_string(),
            Spore::new(s7, 41, MATURE_EDGES[..7].to_vec()),
        ),
        ("mature_plus_edge".to_string(), {
            let mut e = MATURE_EDGES.to_vec();
            e.push((60, 700_000));
            Spore::new(s7, 41, e)
        }),
    ];
    for p in 0..5 {
        let edges = (0..5 + p as u32)
            .map(|k| (3 + 11 * k, 200_000 + 130_000 * (k as u64 * 7 % 6)))
            .collect();
        v.push((
            format!("palette{p}"),
            Spore::new(seed_with_palette("pal", p), 20 + 5 * p as u32, edges),
        ));
    }
    v
}
