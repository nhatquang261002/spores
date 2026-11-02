//! Epoch close (SPEC §8.5). The graph update, pool payout and fingerprint are
//! one call to `spores_core::close_epoch`, the function `sim` and `verify` run.
//! Pulled forward from Phase 5 in minimal form: per-epoch budgets, tubes and
//! the art all need epochs to move. Per-spore state hashes and `commit_image`
//! are still Phase 5.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};
use spores_core::{Edge, EdgeMap, EpochInput, RejectMap};

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
        self.flows.clear();
        self.rejects.clear();
        self.fingerprints.insert(self.epoch, out.fingerprint);
        self.prev_fingerprint = out.fingerprint;
        let fp = hex(&out.fingerprint);
        let payouts: Vec<(u32, U128)> = out.distribution.payouts.iter().map(|(id, a)| (*id, U128(*a))).collect();
        emit(
            "epoch_closed",
            json!({
                "epoch": self.epoch, "fingerprint": fp, "edges": self.edges.len(),
                "pool": U128(pool), "rebates": payouts, "treasury": U128(out.distribution.treasury),
            }),
        );
        self.epoch += 1;
        self.epoch_started_ns = now;
        fp
    }
}
