//! Spores router (SPEC §4): one contract owns the spore NFTs (NEP-171), the
//! ledger keyed by spore id, owner policy, job escrow and the epoch close.
//! All graph, fee and pool math is `spores-core`, the same code `sim` and
//! `verify` run.
//!
//! Money leaves the ledger only through `withdraw` (owner only, to the owner)
//! and `pay_service` (operator, only to a payee on the owner's
//! `external_allowlist`, within the same budget and cap as a job). Agents act through a registered operator account whose key should be
//! a function-call key limited to the job methods; those methods take no
//! deposit, because a function-call key cannot attach one. Owner methods that
//! change control require 1 yoctoNEAR, which only a full-access key can attach.

mod epoch;
mod jobs;
mod ledger;
mod nft;
mod service;
mod types;
mod views;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::NonFungibleToken;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, BorshStorageKey, PanicOnDefault};
use sha2::{Digest, Sha256};

pub use crate::types::{Config, Job, JobStatus, Policy, Quote, Spore, SporeId};
use crate::types::{emit, MAX_EXTERNAL_PAYEES, MAX_SUPPLY};

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Owners,
    Enumeration,
    Spores,
    Jobs,
    Fingerprints,
}

/// Edge key `(a, b)` with `a < b`.
pub type EdgeKey = (SporeId, SporeId);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Router {
    admin: AccountId,
    config: Config,
    tokens: NonFungibleToken,
    /// Indexed by spore id; ids are minted in order from 0.
    spores: Vector<Spore>,
    /// Active spore ids, ascending.
    active: Vec<SporeId>,
    epoch: u64,
    epoch_started_ns: u64,
    prev_fingerprint: [u8; 32],
    /// Conductivity `D` after the last close.
    edges: BTreeMap<EdgeKey, u128>,
    /// Settled volume this epoch, both directions.
    flows: BTreeMap<EdgeKey, u128>,
    /// Rejected deliveries this epoch.
    rejects: BTreeMap<EdgeKey, u32>,
    pool: u128,
    treasury: u128,
    escrow: u128,
    /// Ledger conservation:
    /// `deposited - withdrawn - paid_out == sum(balances) + escrow + pool + treasury`.
    deposited: u128,
    withdrawn: u128,
    /// Paid by `pay_service` to accounts outside the collection.
    paid_out: u128,
    jobs: IterableMap<u64, Job>,
    next_job_id: u64,
    fingerprints: LookupMap<u64, [u8; 32]>,
}

pub(crate) fn edge_key(x: SporeId, y: SporeId) -> EdgeKey {
    require!(x != y, "a spore cannot trade with itself");
    (x.min(y), x.max(y))
}

#[near]
impl Router {
    #[init]
    pub fn new(admin: AccountId, config: Option<Config>) -> Self {
        let config = config.unwrap_or_else(Config::shipped);
        if let Err(e) = config.validate() {
            env::panic_str(&e);
        }
        Router {
            tokens: NonFungibleToken::new(
                StorageKey::Owners,
                env::current_account_id(),
                None::<StorageKey>,
                Some(StorageKey::Enumeration),
                None::<StorageKey>,
            ),
            admin,
            config,
            spores: Vector::new(StorageKey::Spores),
            active: Vec::new(),
            epoch: 1,
            epoch_started_ns: env::block_timestamp(),
            prev_fingerprint: spores_core::fingerprint::GENESIS,
            edges: BTreeMap::new(),
            flows: BTreeMap::new(),
            rejects: BTreeMap::new(),
            pool: 0,
            treasury: 0,
            escrow: 0,
            deposited: 0,
            withdrawn: 0,
            paid_out: 0,
            jobs: IterableMap::new(StorageKey::Jobs),
            next_job_id: 0,
            fingerprints: LookupMap::new(StorageKey::Fingerprints),
        }
    }

    /// Admin only. Mints the next spores in id order to `owners`, dormant and
    /// locked. `seed = sha256(id u32 LE || block random seed)`; the block
    /// producer can predict that seed, which is acceptable for art with no
    /// money attached (docs/verify-notes.md).
    pub fn mint_genesis(&mut self, owners: Vec<AccountId>) -> Vec<SporeId> {
        require!(env::predecessor_account_id() == self.admin, "only the admin can mint");
        let first = self.spores.len();
        require!(
            first as u64 + owners.len() as u64 <= self.config.supply_cap as u64,
            "supply cap reached"
        );
        debug_assert!(self.config.supply_cap <= MAX_SUPPLY);
        let randomness = env::random_seed_array();
        let mut ids = Vec::with_capacity(owners.len());
        for (i, owner) in owners.into_iter().enumerate() {
            let id = first + i as u32;
            let mut h = Sha256::new();
            h.update(id.to_le_bytes());
            h.update(randomness);
            self.spores.push(Spore {
                seed: h.finalize().into(),
                mint_randomness: randomness,
                active: false,
                activated_epoch: 0,
                operator: None,
                operator_gen: 0,
                policy: Policy::locked(),
                balance: 0,
                spent: 0,
                spent_epoch: 0,
                posted: Vec::new(),
                serving: Vec::new(),
                transfers: 0,
            });
            // The router pays for its own storage (`storage_report`), so no
            // deposit is charged; the standard mint event is emitted here.
            let token = self.tokens.internal_mint_with_refund(id.to_string(), owner, None, None);
            NftMint { owner_id: &token.owner_id, token_ids: &[&token.token_id], memo: None }.emit();
            ids.push(id);
        }
        ids
    }

    /// Owner only. Starts the spore's life: registers the operator account and
    /// credits the attached deposit (at least `min_activation_deposit`) to the
    /// spore's balance. Policy is untouched, so a fresh spore stays paused with
    /// zero budget until the owner calls `set_policy`.
    #[payable]
    pub fn activate(&mut self, spore_id: SporeId, operator_id: AccountId) {
        let owner = self.require_owner(spore_id);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit >= self.config.min_activation_deposit.0,
            "activation needs at least min_activation_deposit attached"
        );
        require!(operator_id != owner, "the operator must be a different account from the owner");
        require!(!self.spore(spore_id).active, "spore is already active");
        require!(
            (self.active.len() as u32) < self.config.max_active,
            "too many active spores"
        );
        let epoch = self.epoch;
        let s = self.spore_mut(spore_id);
        s.active = true;
        s.activated_epoch = epoch;
        s.operator = Some(operator_id.clone());
        s.operator_gen += 1;
        s.balance += deposit;
        self.deposited += deposit;
        let at = self.active.partition_point(|&x| x < spore_id);
        self.active.insert(at, spore_id);
        emit(
            "spore_activated",
            json!({ "spore_id": spore_id, "operator_id": operator_id, "deposit": U128(deposit), "epoch": epoch }),
        );
    }

    /// Owner only, 1 yoctoNEAR. Replaces the operator; the old one stops working
    /// at once and its open quotes become void.
    #[payable]
    pub fn register_operator(&mut self, spore_id: SporeId, operator_id: AccountId) {
        assert_one_yocto();
        let owner = self.require_owner(spore_id);
        require!(operator_id != owner, "the operator must be a different account from the owner");
        let s = self.spore_mut(spore_id);
        require!(s.active, "spore is not active");
        s.operator = Some(operator_id.clone());
        s.operator_gen += 1;
        let gen = s.operator_gen;
        emit(
            "operator_registered",
            json!({ "spore_id": spore_id, "operator_id": operator_id, "operator_gen": gen }),
        );
    }

    /// Owner only, 1 yoctoNEAR.
    #[payable]
    pub fn set_policy(&mut self, spore_id: SporeId, policy: Policy) {
        assert_one_yocto();
        self.require_owner(spore_id);
        require!(policy.allowlist.len() < MAX_SUPPLY as usize, "allowlist too long");
        for &id in &policy.allowlist {
            require!(id != spore_id, "a spore cannot allowlist itself");
            require!(id < self.spores.len(), "allowlist names an unknown spore");
        }
        require!(
            policy.external_allowlist.len() <= MAX_EXTERNAL_PAYEES,
            "external allowlist too long"
        );
        self.spore_mut(spore_id).policy = policy.clone();
        emit("policy_set", json!({ "spore_id": spore_id, "policy": policy }));
    }

    /// Owner only. No deposit needed, so any key the owner holds can stop the agent.
    pub fn pause(&mut self, spore_id: SporeId) {
        self.require_owner(spore_id);
        self.spore_mut(spore_id).policy.paused = true;
        emit("spore_paused", json!({ "spore_id": spore_id }));
    }
}

impl Router {
    pub(crate) fn spore(&self, id: SporeId) -> &Spore {
        self.spores.get(id).unwrap_or_else(|| env::panic_str("unknown spore"))
    }

    pub(crate) fn spore_mut(&mut self, id: SporeId) -> &mut Spore {
        self.spores.get_mut(id).unwrap_or_else(|| env::panic_str("unknown spore"))
    }

    pub(crate) fn owner_of(&self, id: SporeId) -> AccountId {
        self.tokens
            .owner_by_id
            .get(&id.to_string())
            .unwrap_or_else(|| env::panic_str("unknown spore"))
    }

    /// Panics unless the caller owns the spore; returns the owner.
    pub(crate) fn require_owner(&self, id: SporeId) -> AccountId {
        let owner = self.owner_of(id);
        require!(env::predecessor_account_id() == owner, "only the spore owner can do this");
        owner
    }

    /// Panics unless the caller is the spore's registered operator and the
    /// spore is active.
    pub(crate) fn require_operator(&self, id: SporeId) {
        let s = self.spore(id);
        require!(s.active, "spore is not active");
        require!(
            s.operator.as_ref() == Some(&env::predecessor_account_id()),
            "caller is not this spore's operator"
        );
    }
}
