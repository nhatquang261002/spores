//! Per-spore state hash (SPEC §5.5): what `commit_image` binds an image to.
//!
//! Format, fields joined with `|`:
//! `spores/state/v1|<id>|<epoch>|<seed hex>|<age>|<neighbor>:<D>|...`
//! Neighbors ascending, zero edges and self-edges omitted. `epoch` is the epoch
//! the state belongs to (the one that starts after the close), `age` is
//! `epoch - activated_epoch`.

use std::fmt::Write;

use crate::fingerprint::{fingerprint, hex};
use crate::graph::SporeId;

pub const DOMAIN: &str = "spores/state/v1";

pub fn canonical(id: SporeId, epoch: u64, seed: &[u8; 32], age: u32, edges: &[(SporeId, u128)]) -> String {
    let mut nb: Vec<(SporeId, u128)> = edges.iter().copied().filter(|&(n, d)| n != id && d > 0).collect();
    nb.sort_unstable();
    let mut s = String::with_capacity(112 + nb.len() * 16);
    write!(s, "{DOMAIN}|{id}|{epoch}|{}|{age}", hex(seed)).unwrap();
    for (n, d) in nb {
        write!(s, "|{n}:{d}").unwrap();
    }
    s
}

pub fn state_hash(id: SporeId, epoch: u64, seed: &[u8; 32], age: u32, edges: &[(SporeId, u128)]) -> [u8; 32] {
    fingerprint(&canonical(id, epoch, seed, age, edges))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_sorts_neighbors_and_drops_zero_and_self_edges() {
        let seed = [0xab; 32];
        let s = canonical(5, 12, &seed, 3, &[(9, 70_000), (2, 1_000_000), (4, 0), (5, 9)]);
        assert_eq!(s, format!("spores/state/v1|5|12|{}|3|2:1000000|9:70000", "ab".repeat(32)));
    }

    #[test]
    fn edge_order_does_not_matter_and_any_field_changes_the_hash() {
        let seed = [7; 32];
        let a = state_hash(1, 4, &seed, 2, &[(3, 60_000), (2, 80_000)]);
        assert_eq!(a, state_hash(1, 4, &seed, 2, &[(2, 80_000), (3, 60_000)]));
        assert_ne!(a, state_hash(1, 5, &seed, 2, &[(2, 80_000), (3, 60_000)]));
        assert_ne!(a, state_hash(1, 4, &seed, 3, &[(2, 80_000), (3, 60_000)]));
        assert_ne!(a, state_hash(1, 4, &seed, 2, &[(2, 80_001), (3, 60_000)]));
    }
}
