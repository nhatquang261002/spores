//! Read-only views: summaries for buyers and agents, the renderer's input,
//! jobs, the graph, and ledger and storage checks.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId};
use spores_core::math::isqrt;

use crate::art::ImageCommitView;
use crate::types::{hex, Config, Job, Policy, SporeId};
use crate::{Router, RouterExt};

#[near(serializers=[json])]
pub struct SporeSummary {
    pub spore_id: SporeId,
    pub owner_id: AccountId,
    pub active: bool,
    pub operator_id: Option<AccountId>,
    pub operator_gen: u32,
    pub balance: U128,
    /// `sum isqrt(D)` over the spore's tubes, scale 1000 per `D = 1.0`.
    pub reputation: U64,
    /// Epochs since activation.
    pub age: u64,
    pub degree: u32,
    /// `(neighbour, D)` ascending by neighbour.
    pub connections: Vec<(SporeId, U128)>,
    pub policy: Policy,
    pub spent_this_epoch: U128,
    /// The living allowance: `min(owner budget, base + trust_gain * R / 1000)`.
    pub effective_budget: U128,
    /// `effective_budget` minus what was spent this epoch.
    pub budget_left: U128,
    pub seed: String,
    pub posted_jobs: Vec<u64>,
    pub serving_jobs: Vec<u64>,
    pub transfers: u32,
    pub sales: u32,
    pub listed_price: Option<U128>,
    /// `(epoch, state hash hex)` stored at the last close.
    pub state: Option<(u64, String)>,
    pub image: Option<ImageCommitView>,
}

/// Exactly the renderer's inputs (`spores_renderer::Spore`): seed, age and
/// `(neighbour, D)` pairs.
#[near(serializers=[json])]
pub struct RenderInput {
    pub spore_id: SporeId,
    pub epoch: u64,
    pub seed: String,
    pub age: u32,
    pub edges: Vec<(SporeId, u64)>,
}

#[near(serializers=[json])]
pub struct EpochInfo {
    pub epoch: u64,
    pub started_ns: U64,
    pub ends_ns: U64,
    pub prev_fingerprint: String,
    pub active: Vec<SporeId>,
    pub pool: U128,
    pub flows: Vec<(SporeId, SporeId, U128)>,
    pub rejects: Vec<(SporeId, SporeId, u32)>,
}

#[near(serializers=[json])]
pub struct LedgerTotals {
    pub deposited: U128,
    pub withdrawn: U128,
    pub paid_out: U128,
    pub balances: U128,
    pub escrow: U128,
    pub pool: U128,
    pub treasury: U128,
    /// `deposited - withdrawn - paid_out == balances + escrow + pool + treasury`.
    pub conserved: bool,
}

#[near(serializers=[json])]
pub struct StorageReport {
    pub storage_bytes: U64,
    pub storage_cost: U128,
    pub account_balance: U128,
    /// What the ledger owes spores, escrow, pool and treasury.
    pub ledger: U128,
    /// The account can pay its storage and every ledger entry at once.
    pub solvent: bool,
}

pub(crate) struct Traits {
    pub active: bool,
    pub age: u64,
    pub degree: u32,
    pub reputation: u64,
}

#[near]
impl Router {
    pub fn config(&self) -> Config {
        self.config.clone()
    }

    pub fn admin(&self) -> AccountId {
        self.admin.clone()
    }

    pub fn epoch_info(&self) -> EpochInfo {
        EpochInfo {
            epoch: self.epoch,
            started_ns: U64(self.epoch_started_ns),
            ends_ns: U64(self.epoch_started_ns + self.config.epoch_len_ns.0),
            prev_fingerprint: hex(&self.prev_fingerprint),
            active: self.active.clone(),
            pool: U128(self.pool),
            flows: self.flows.iter().map(|((a, b), q)| (*a, *b, U128(*q))).collect(),
            rejects: self.rejects.iter().map(|((a, b), r)| (*a, *b, *r)).collect(),
        }
    }

    /// For the outside service (SPEC §6.4): true when `account_id` is the
    /// active spore's current operator.
    pub fn is_operator(&self, spore_id: SporeId, account_id: AccountId) -> bool {
        self.spores
            .get(spore_id)
            .is_some_and(|s| s.active && s.operator.as_ref() == Some(&account_id))
    }

    pub fn spore_summary(&self, spore_id: SporeId) -> Option<SporeSummary> {
        let s = self.spores.get(spore_id)?;
        let t = self.traits(spore_id);
        let spent = s.spent_in(self.epoch);
        Some(SporeSummary {
            spore_id,
            owner_id: self.owner_of(spore_id),
            active: s.active,
            operator_id: s.operator.clone(),
            operator_gen: s.operator_gen,
            balance: U128(s.balance),
            reputation: U64(t.reputation),
            age: t.age,
            degree: t.degree,
            connections: self.connections(spore_id).into_iter().map(|(n, d)| (n, U128(d))).collect(),
            policy: s.policy.clone(),
            spent_this_epoch: U128(spent),
            effective_budget: U128(self.effective_budget(spore_id)),
            budget_left: U128(self.effective_budget(spore_id).saturating_sub(spent)),
            seed: hex(&s.seed),
            posted_jobs: s.posted.clone(),
            serving_jobs: s.serving.clone(),
            transfers: s.transfers,
            sales: s.sales,
            listed_price: s.listing.map(U128),
            state: s.state.map(|(e, h)| (e, hex(&h))),
            image: s.image.as_ref().map(ImageCommitView::from),
        })
    }

    pub fn render_input(&self, spore_id: SporeId) -> RenderInput {
        let s = self.spore(spore_id);
        RenderInput {
            spore_id,
            epoch: self.epoch,
            seed: hex(&s.seed),
            age: self.traits(spore_id).age.min(u32::MAX as u64) as u32,
            edges: self
                .connections(spore_id)
                .into_iter()
                .map(|(n, d)| (n, d.min(u64::MAX as u128) as u64))
                .collect(),
        }
    }

    pub fn get_job(&self, job_id: u64) -> Option<Job> {
        self.jobs.get(&job_id).cloned()
    }

    /// Jobs in flight, in storage order.
    pub fn list_jobs(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Job> {
        self.jobs
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .cloned()
            .collect()
    }

    pub fn jobs_count(&self) -> u32 {
        self.jobs.len()
    }

    /// Every tube after the last close: `(a, b, D)` with `a < b`.
    pub fn edges(&self) -> Vec<(SporeId, SporeId, U128)> {
        self.edges.iter().map(|((a, b), d)| (*a, *b, U128(*d))).collect()
    }

    pub fn fingerprint(&self, epoch: u64) -> Option<String> {
        self.fingerprints.get(&epoch).map(|f| hex(f))
    }

    /// Sums every spore balance, so it reads all spores; fine for a view at 64.
    pub fn ledger_totals(&self) -> LedgerTotals {
        let balances: u128 = self.spores.iter().map(|s| s.balance).sum();
        let held = balances + self.escrow + self.pool + self.treasury;
        LedgerTotals {
            deposited: U128(self.deposited),
            withdrawn: U128(self.withdrawn),
            paid_out: U128(self.paid_out),
            balances: U128(balances),
            escrow: U128(self.escrow),
            pool: U128(self.pool),
            treasury: U128(self.treasury),
            conserved: self.deposited - self.withdrawn - self.paid_out == held,
        }
    }

    /// The contract pays for its own storage (spores, jobs), so its balance
    /// must cover storage plus everything the ledger owes.
    pub fn storage_report(&self) -> StorageReport {
        let bytes = env::storage_usage();
        let cost = bytes as u128 * env::storage_byte_cost().as_yoctonear();
        let balance = env::account_balance().as_yoctonear();
        let ledger = self.deposited - self.withdrawn - self.paid_out;
        StorageReport {
            storage_bytes: U64(bytes),
            storage_cost: U128(cost),
            account_balance: U128(balance),
            ledger: U128(ledger),
            solvent: balance >= cost.saturating_add(ledger),
        }
    }
}

impl Router {
    /// `(neighbour, D)` for every tube of `id`, ascending by neighbour.
    pub(crate) fn connections(&self, id: SporeId) -> Vec<(SporeId, u128)> {
        let mut v: Vec<(SporeId, u128)> = self
            .edges
            .iter()
            .filter_map(|((a, b), d)| match (*a == id, *b == id) {
                (true, _) => Some((*b, *d)),
                (_, true) => Some((*a, *d)),
                _ => None,
            })
            .collect();
        v.sort_unstable();
        v
    }

    pub(crate) fn traits(&self, id: SporeId) -> Traits {
        let s = self.spore(id);
        let conns = self.connections(id);
        Traits {
            active: s.active,
            age: if s.active { self.epoch - s.activated_epoch } else { 0 },
            degree: conns.len() as u32,
            reputation: conns.iter().map(|(_, d)| isqrt(*d)).sum::<u128>() as u64,
        }
    }
}
