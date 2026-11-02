//! Tube conductivity update (SPEC §8.1) and reputation (§8.2).

use std::collections::BTreeMap;

use crate::error::CoreError;
use crate::math::{isqrt, mul_div, BPS, ONE};
use crate::params::Params;

pub type SporeId = u32;

/// An unordered pair of distinct spores, stored with `a < b`. The derived
/// ordering sorts by `a`, then `b`, numerically; every map of edges iterates in
/// that order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Edge {
    a: SporeId,
    b: SporeId,
}

impl Edge {
    pub fn new(x: SporeId, y: SporeId) -> Result<Self, CoreError> {
        match x.cmp(&y) {
            core::cmp::Ordering::Less => Ok(Edge { a: x, b: y }),
            core::cmp::Ordering::Greater => Ok(Edge { a: y, b: x }),
            core::cmp::Ordering::Equal => Err(CoreError::SelfEdge(x)),
        }
    }

    pub fn a(&self) -> SporeId {
        self.a
    }

    pub fn b(&self) -> SporeId {
        self.b
    }

    pub fn other(&self, id: SporeId) -> Option<SporeId> {
        if id == self.a {
            Some(self.b)
        } else if id == self.b {
            Some(self.a)
        } else {
            None
        }
    }
}

/// Conductivity per edge, or settled volume per edge, depending on use.
pub type EdgeMap = BTreeMap<Edge, u128>;

/// `floor(ONE * q / (q + K))`: the edge's saturated weight, in `0..=ONE`
/// (`ONE` only if `q + K` saturates u128, far above total NEAR supply).
pub fn saturation(q: u128, k: u128) -> u128 {
    frac(ONE, q, q.saturating_add(k))
}

/// `floor(x * num / den)` for `num <= den`, which always fits.
fn frac(x: u128, num: u128, den: u128) -> u128 {
    mul_div(x, num, den).expect("num <= den and den > 0")
}

/// Distinct counterparties per spore: edges with `D > 0` before the update,
/// plus edges with settled flow this epoch.
pub fn breadth(conductivity: &EdgeMap, flows: &EdgeMap) -> BTreeMap<SporeId, u32> {
    let mut out: BTreeMap<SporeId, u32> = BTreeMap::new();
    let live = conductivity.iter().filter(|(_, d)| **d > 0).map(|(e, _)| e);
    let flowing = flows
        .iter()
        .filter(|(e, q)| **q > 0 && conductivity.get(e).copied().unwrap_or(0) == 0)
        .map(|(e, _)| e);
    for e in live.chain(flowing) {
        *out.entry(e.a).or_default() += 1;
        *out.entry(e.b).or_default() += 1;
    }
    out
}

/// `gain * q / (q + K)`, then scaled by `min(breadth_a, breadth_b, B) / B`
/// when breadth damping is on.
pub fn edge_gain(p: &Params, q: u128, breadth_a: u32, breadth_b: u32) -> u128 {
    if q == 0 {
        return 0;
    }
    let g = frac(p.gain, q, q.saturating_add(p.k));
    if p.breadth_full == 0 {
        return g;
    }
    let full = p.breadth_full;
    let have = breadth_a.min(breadth_b).min(full);
    frac(g, have as u128, full as u128)
}

/// `D - floor(D * decay_bps / 10000)`.
pub fn decayed(p: &Params, d: u128) -> u128 {
    d - frac(d, p.decay_bps as u128, BPS)
}

/// Rejected deliveries per edge in one epoch.
pub type RejectMap = BTreeMap<Edge, u32>;

/// At most this many rejections per edge per epoch are applied.
pub const MAX_REJECTS: u32 = 64;

/// One edge's next conductivity: decay, plus growth from settled flow, then
/// `reject_bps` of what remains is cut once per rejected delivery, then pruned
/// to zero below `d_min`.
pub fn next_conductivity(p: &Params, d: u128, q: u128, breadth_a: u32, breadth_b: u32, rejects: u32) -> u128 {
    let mut next = decayed(p, d) + edge_gain(p, q, breadth_a, breadth_b);
    for _ in 0..rejects.min(MAX_REJECTS) {
        next -= frac(next, p.reject_bps as u128, BPS);
    }
    if next < p.d_min {
        0
    } else {
        next
    }
}

/// Applies one epoch of decay, growth and rejection cuts to every edge with
/// conductivity or flow. Pruned edges are removed from the result.
pub fn update(p: &Params, conductivity: &EdgeMap, flows: &EdgeMap, rejects: &RejectMap) -> EdgeMap {
    let reach = breadth(conductivity, flows);
    let width = |id: SporeId| reach.get(&id).copied().unwrap_or(0);
    let mut keys: Vec<Edge> = conductivity.keys().chain(flows.keys()).copied().collect();
    keys.sort_unstable();
    keys.dedup();
    let mut out = EdgeMap::new();
    for e in keys {
        let d = conductivity.get(&e).copied().unwrap_or(0);
        let q = flows.get(&e).copied().unwrap_or(0);
        let r = rejects.get(&e).copied().unwrap_or(0);
        let next = next_conductivity(p, d, q, width(e.a), width(e.b), r);
        if next > 0 {
            out.insert(e, next);
        }
    }
    out
}

/// `R_i = sum over edges of i of isqrt(D_e)`, scale `REP_ONE`. Spores without
/// edges are absent.
pub fn reputation(conductivity: &EdgeMap) -> BTreeMap<SporeId, u128> {
    let mut out: BTreeMap<SporeId, u128> = BTreeMap::new();
    for (e, d) in conductivity {
        let r = isqrt(*d);
        *out.entry(e.a).or_default() += r;
        *out.entry(e.b).or_default() += r;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::NEAR;

    fn spec() -> Params {
        Params::spec()
    }

    #[test]
    fn edge_orders_and_rejects_self() {
        assert_eq!(Edge::new(7, 3).unwrap(), Edge::new(3, 7).unwrap());
        assert_eq!(Edge::new(7, 3).unwrap().a(), 3);
        assert_eq!(Edge::new(4, 4), Err(CoreError::SelfEdge(4)));
        assert!(Edge::new(2, 10).unwrap() < Edge::new(3, 4).unwrap());
    }

    #[test]
    fn update_matches_spec_formula() {
        let p = spec();
        // D = 1.0, q = K: 1e6 - 250_000 + 1e6 * 0.5 = 1_250_000
        assert_eq!(next_conductivity(&p, ONE, p.k, 1, 1, 0), 1_250_000);
        // No flow: pure decay.
        assert_eq!(next_conductivity(&p, ONE, 0, 1, 1, 0), 750_000);
        // New edge with q = 3K: gain * 3/4.
        assert_eq!(next_conductivity(&p, 0, 3 * p.k, 1, 1, 0), 750_000);
        // Below D_min prunes.
        assert_eq!(next_conductivity(&p, 60_000, 0, 1, 1, 0), 0);
    }

    #[test]
    fn rejections_cut_the_tube() {
        let p = Params::shipped();
        assert_eq!(p.reject_bps, 5_000);
        // 1e6 decays to 750_000, plus 500_000 from q = K: 1_250_000, halved per reject.
        let q = p.k;
        assert_eq!(next_conductivity(&p, ONE, q, 4, 4, 1), 625_000);
        assert_eq!(next_conductivity(&p, ONE, q, 4, 4, 2), 312_500);
        assert_eq!(next_conductivity(&p, ONE, q, 4, 4, 5), 0);
        assert_eq!(next_conductivity(&p, ONE, q, 4, 4, u32::MAX), 0);
        // The spec rule has no rejection cut.
        assert_eq!(next_conductivity(&spec(), ONE, 0, 1, 1, 3), 750_000);
    }

    #[test]
    fn zero_flow_prunes_in_expected_epochs() {
        let p = spec();
        // From the saturated steady state D_max = 4e6, 0.75^n * 4e6 < 5e4 first
        // holds at n = 16 (0.75^15 * 4e6 = 53_454).
        let mut d = p.d_max();
        let mut epochs = 0;
        while d > 0 {
            d = next_conductivity(&p, d, 0, 0, 0, 0);
            epochs += 1;
        }
        assert_eq!(epochs, 16);
    }

    #[test]
    fn large_payment_is_saturated() {
        let p = spec();
        let small = edge_gain(&p, NEAR / 10, 1, 1);
        let big = edge_gain(&p, 10 * NEAR, 1, 1);
        assert!(big < 6 * small, "100x payment gave {}x gain", big / small);
        assert!(big < p.gain);
    }

    #[test]
    fn no_overflow_at_extreme_payments() {
        let mut p = spec();
        p.gain = u64::MAX as u128;
        for q in [10u128.pow(25), 10u128.pow(33), u128::MAX - 1, u128::MAX] {
            let g = edge_gain(&p, q, 1, 1);
            assert!(g <= p.gain);
            let _ = next_conductivity(&p, p.d_max(), q, 1, 1, 1);
        }
        assert_eq!(saturation(10u128.pow(33), p.k), ONE - 1);
        assert_eq!(saturation(u128::MAX, p.k), ONE);
    }

    #[test]
    fn breadth_damps_narrow_edges() {
        let mut p = spec();
        p.breadth_full = 4;
        let full = edge_gain(&p, p.k, 4, 9);
        assert_eq!(full, 500_000);
        assert_eq!(edge_gain(&p, p.k, 2, 9), 250_000);
        assert_eq!(edge_gain(&p, p.k, 1, 1), 125_000);
    }

    #[test]
    fn breadth_counts_live_edges_and_new_flows_once() {
        let mut d = EdgeMap::new();
        d.insert(Edge::new(1, 2).unwrap(), 100);
        d.insert(Edge::new(1, 3).unwrap(), 0);
        let mut q = EdgeMap::new();
        q.insert(Edge::new(1, 2).unwrap(), 5);
        q.insert(Edge::new(1, 4).unwrap(), 5);
        q.insert(Edge::new(1, 5).unwrap(), 0);
        let b = breadth(&d, &q);
        assert_eq!(b.get(&1), Some(&2));
        assert_eq!(b.get(&2), Some(&1));
        assert_eq!(b.get(&3), None);
        assert_eq!(b.get(&4), Some(&1));
    }

    #[test]
    fn reputation_prefers_breadth() {
        // One edge at D = 4 vs four edges at D = 1, same total D.
        let mut heavy = EdgeMap::new();
        heavy.insert(Edge::new(0, 1).unwrap(), 4 * ONE);
        let mut broad = EdgeMap::new();
        for j in 1..=4 {
            broad.insert(Edge::new(0, j).unwrap(), ONE);
        }
        assert_eq!(reputation(&heavy)[&0], 2_000);
        assert_eq!(reputation(&broad)[&0], 4_000);
    }
}
