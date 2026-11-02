//! Epoch close (SPEC §8.5). The graph update, pool payout and fingerprint are
//! one call to `spores_core::close_epoch`, the function `sim` and `verify` run.
//!
//! The `epoch_closed` event carries the whole input (active set, flows,
//! rejects, pool) and the resulting tubes, so `verify` can replay every
//! fingerprint from the close receipts alone. Its size is bounded by the
//! active cap: at 16 active spores it stays far under the 16 KiB log limit.
//! After the close each active spore's state hash for the new epoch is stored
//! (latest only; older ones follow from the logged tubes).

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};
use spores_core::{Edge, EdgeMap, EpochInput, RejectMap, SporeId};

use crate::types::{emit, hex};
use crate::{EdgeKey, Router, RouterExt};

fn edge(k: &EdgeKey) -> Edge {
    Edge::new(k.0, k.1).expect("stored edge keys have a < b")
}

#[near]
impl Router {
    /// Anyone, once `epoch_len_ns` has passed since the epoch started. Tubes
    /// decay even with no flow; an epoch with no fees pays nothing out. Returns
    /// the fingerprint in hex.
    pub fn close_epoch(&mut self) -> String {
        let now = env::block_timestamp();
        require!(
            now >= self.epoch_started_ns + self.config.epoch_len_ns.0,
            "epoch has not ended yet"
        );
        let conductivity: EdgeMap = self.edges.iter().map(|(k, d)| (edge(k), *d)).collect();
        let flows: EdgeMap = self.flows.iter().map(|(k, q)| (edge(k), *q)).collect();
        let rejects: RejectMap = self.rejects.iter().map(|(k, r)| (edge(k), *r)).collect();
        let out = spores_core::close_epoch(
            &self.config.params(),
            &EpochInput {
                epoch: self.epoch,
                prev_fingerprint: self.prev_fingerprint,
                active: &self.active,
                conductivity: &conductivity,
                flows: &flows,
                rejects: &rejects,
                pool: self.pool,
            },
        )
        .unwrap_or_else(|e| env::panic_str(&e.to_string()));

        for (id, amount) in &out.distribution.payouts {
            self.spore_mut(*id).balance += amount;
        }
        self.treasury += out.distribution.treasury;
        let pool = std::mem::take(&mut self.pool);
        self.edges = out.conductivity.iter().map(|(e, d)| ((e.a(), e.b()), *d)).collect();
        let flows: Vec<(SporeId, SporeId, U128)> =
            std::mem::take(&mut self.flows).into_iter().map(|((a, b), q)| (a, b, U128(q))).collect();
        let rejects: Vec<(SporeId, SporeId, u32)> =
            std::mem::take(&mut self.rejects).into_iter().map(|((a, b), n)| (a, b, n)).collect();
        self.fingerprints.insert(self.epoch, out.fingerprint);
        let prev = std::mem::replace(&mut self.prev_fingerprint, out.fingerprint);
        let fp = hex(&out.fingerprint);
        let payouts: Vec<(u32, U128)> = out.distribution.payouts.iter().map(|(id, a)| (*id, U128(*a))).collect();
        let tubes: Vec<(SporeId, SporeId, U128)> = self.edges.iter().map(|((a, b), d)| (*a, *b, U128(*d))).collect();
        emit(
            "epoch_closed",
            json!({
                "epoch": self.epoch, "fingerprint": fp, "prev_fingerprint": hex(&prev),
                "active": self.active, "flows": flows, "rejects": rejects, "pool": U128(pool),
                "edges": tubes.len(), "tubes": tubes, "rebates": payouts, "treasury": U128(out.distribution.treasury),
            }),
        );
        self.epoch += 1;
        self.epoch_started_ns = now;
        self.store_state_hashes();
        fp
    }
}

impl Router {
    /// Writes `(epoch, state_hash)` for every active spore at the current epoch.
    fn store_state_hashes(&mut self) {
        let epoch = self.epoch;
        for id in self.active.clone() {
            let conns = self.connections(id);
            let s = self.spore_mut(id);
            let age = (epoch - s.activated_epoch).min(u32::MAX as u64) as u32;
            let h = spores_core::state::state_hash(id, epoch, &s.seed, age, &conns);
            s.state = Some((epoch, h));
        }
    }
}
