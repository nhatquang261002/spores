//! Canonical epoch string and fingerprint (SPEC §8.4).
//!
//! Format, fields joined with `|`:
//! `spores/fp/v1|<epoch>|<prev fingerprint hex>|<active ids, comma-separated>|<a>:<b>:<D>|...`
//! Ids are decimal, active ids ascending, edges ascending by `(a, b)` with
//! `a < b`, zero edges omitted. Chaining the previous fingerprint makes each
//! epoch commit to the whole history; genesis uses 32 zero bytes.

use std::fmt::Write;

use sha2::{Digest, Sha256};

use crate::graph::{EdgeMap, SporeId};

pub const DOMAIN: &str = "spores/fp/v1";
pub const GENESIS: [u8; 32] = [0; 32];

pub fn canonical(epoch: u64, prev: &[u8; 32], active: &[SporeId], conductivity: &EdgeMap) -> String {
    let mut ids = active.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let mut s = String::with_capacity(96 + ids.len() * 3 + conductivity.len() * 16);
    write!(s, "{DOMAIN}|{epoch}|{}|", hex(prev)).unwrap();
    for (i, id) in ids.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        write!(s, "{id}").unwrap();
    }
    for (e, d) in conductivity {
        if *d > 0 {
            write!(s, "|{}:{}:{}", e.a(), e.b(), d).unwrap();
        }
    }
    s
}

pub fn fingerprint(canonical: &str) -> [u8; 32] {
    Sha256::digest(canonical.as_bytes()).into()
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Edge;

    #[test]
    fn canonical_is_sorted_and_stable() {
        let mut d = EdgeMap::new();
        d.insert(Edge::new(9, 2).unwrap(), 1_250_000);
        d.insert(Edge::new(2, 3).unwrap(), 50_000);
        d.insert(Edge::new(10, 11).unwrap(), 0);
        let s = canonical(7, &GENESIS, &[9, 3, 2, 3, 10, 11], &d);
        assert_eq!(
            s,
            format!("spores/fp/v1|7|{}|2,3,9,10,11|2:3:50000|2:9:1250000", "0".repeat(64))
        );
        assert_eq!(fingerprint(&s), fingerprint(&s.clone()));
    }

    #[test]
    fn sha256_known_answer() {
        assert_eq!(
            hex(&fingerprint("abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
