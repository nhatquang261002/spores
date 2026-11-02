//! Epoch close: graph update, reputation, pool payout and fingerprint in one
//! pure call. The router and `verify` both run exactly this.

use std::collections::{BTreeMap, BTreeSet};

use crate::error::CoreError;
use crate::fingerprint::{canonical, fingerprint};
use crate::graph::{breadth, reputation, update, EdgeMap, RejectMap, SporeId};
use crate::params::Params;
use crate::pool::{distribute, weights, Distribution};

#[derive(Clone, Debug)]
pub struct EpochInput<'a> {
    pub epoch: u64,
    pub prev_fingerprint: [u8; 32],
    pub active: &'a [SporeId],
    /// Conductivity at the start of the epoch.
    pub conductivity: &'a EdgeMap,
    /// Settled volume per edge this epoch, both directions, yoctoNEAR.
    pub flows: &'a EdgeMap,
    /// Rejected deliveries per edge this epoch.
    pub rejects: &'a RejectMap,
    /// Fees collected this epoch.
    pub pool: u128,
}

#[derive(Clone, Debug)]
pub struct EpochOutput {
    pub conductivity: EdgeMap,
    pub breadth: BTreeMap<SporeId, u32>,
    /// Every active spore, zero when it has no edges.
    pub reputation: BTreeMap<SporeId, u128>,
    pub weights: BTreeMap<SporeId, u128>,
    pub distribution: Distribution,
    pub canonical: String,
    pub fingerprint: [u8; 32],
}

/// Closes an epoch. Tubes decay even when there was no flow; an epoch with no
/// flow pays nothing out.
pub fn close_epoch(p: &Params, input: &EpochInput) -> Result<EpochOutput, CoreError> {
    p.validate()?;
    let active: BTreeSet<SporeId> = input.active.iter().copied().collect();
    let edges = input
        .conductivity
        .keys()
        .chain(input.flows.keys())
        .chain(input.rejects.keys());
    for e in edges {
        for id in [e.a(), e.b()] {
            if !active.contains(&id) {
                return Err(CoreError::InactiveSpore(id));
            }
        }
    }
    let conductivity = update(p, input.conductivity, input.flows, input.rejects);
    let mut rep = reputation(&conductivity);
    for id in &active {
        rep.entry(*id).or_insert(0);
    }
    let w = weights(p, input.flows);
    let distribution = distribute(p, input.pool, &w);
    let canonical = canonical(input.epoch, &input.prev_fingerprint, input.active, &conductivity);
    let fingerprint = fingerprint(&canonical);
    Ok(EpochOutput {
        breadth: breadth(input.conductivity, input.flows),
        conductivity,
        reputation: rep,
        weights: w,
        distribution,
        canonical,
        fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fingerprint::GENESIS;
    use crate::graph::Edge;
    use crate::params::NEAR;

    #[test]
    fn rejects_inactive_endpoints() {
        let mut flows = EdgeMap::new();
        flows.insert(Edge::new(1, 99).unwrap(), NEAR);
        let input = EpochInput {
            epoch: 1,
            prev_fingerprint: GENESIS,
            active: &[1, 2],
            conductivity: &EdgeMap::new(),
            flows: &flows,
            rejects: &RejectMap::new(),
            pool: 0,
        };
        assert_eq!(
            close_epoch(&Params::shipped(), &input).unwrap_err(),
            CoreError::InactiveSpore(99)
        );
    }

    #[test]
    fn identical_inputs_give_identical_bytes() {
        let mut flows = EdgeMap::new();
        flows.insert(Edge::new(1, 2).unwrap(), NEAR / 3);
        flows.insert(Edge::new(2, 3).unwrap(), 2 * NEAR);
        let mut d = EdgeMap::new();
        d.insert(Edge::new(1, 3).unwrap(), 900_000);
        let run = || {
            close_epoch(
                &Params::shipped(),
                &EpochInput {
                    epoch: 3,
                    prev_fingerprint: GENESIS,
                    active: &[3, 1, 2],
                    conductivity: &d,
                    flows: &flows,
                    rejects: &RejectMap::new(),
                    pool: NEAR / 50,
                },
            )
            .unwrap()
        };
        let (a, b) = (run(), run());
        assert_eq!(a.canonical, b.canonical);
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(a.distribution, b.distribution);
        assert_eq!(a.distribution.total(), NEAR / 50);
    }
}
