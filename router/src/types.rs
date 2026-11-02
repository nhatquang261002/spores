//! Stored records, config and the NEP-297 event helper.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, AccountId};
use spores_core::allowance::Allowance;
use spores_core::{Params, PoolRule};

pub type SporeId = u32;

/// Jobs a spore may have posted and not yet finished, so contract-paid job
/// storage stays bounded at `max_active * MAX_POSTED_JOBS` records.
pub const MAX_POSTED_JOBS: usize = 4;
pub const MAX_QUOTES: usize = 8;
pub const MAX_TASK_BYTES: usize = 256;
pub const MAX_RESULT_BYTES: usize = 128;
pub const MAX_EXTERNAL_PAYEES: usize = 8;
pub const MAX_MEMO_BYTES: usize = 64;
/// The renderer's collection ring has 64 slots.
pub const MAX_SUPPLY: u32 = 64;

/// Owner policy, enforced in the router (SPEC §7.1).
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub paused: bool,
    /// Spend allowed per epoch, counted when a quote is accepted into escrow.
    pub budget_per_epoch: U128,
    /// Largest single payment.
    pub max_payment: U128,
    /// Any active spore may be paid. When false only `allowlist` may.
    pub allow_all_spores: bool,
    pub allowlist: Vec<SporeId>,
    /// Accounts outside the collection `pay_service` may pay (SPEC §6.4, §7.1
    /// "approved external payees"). Absent in JSON means none.
    #[serde(default)]
    pub external_allowlist: Vec<AccountId>,
}

impl Policy {
    /// Paused with zero budget: a fresh mint, and every spore right after a transfer.
    pub fn locked() -> Self {
        Policy {
            paused: true,
            budget_per_epoch: U128(0),
            max_payment: U128(0),
            allow_all_spores: false,
            allowlist: Vec::new(),
            external_allowlist: Vec::new(),
        }
    }
}

#[near(serializers=[borsh])]
#[derive(Clone, Debug)]
pub struct Spore {
    /// `sha256(id u32 LE || mint_randomness)`.
    pub seed: [u8; 32],
    pub mint_randomness: [u8; 32],
    pub active: bool,
    pub activated_epoch: u64,
    pub operator: Option<AccountId>,
    /// Bumped whenever the operator changes or is cleared; quotes carry it.
    pub operator_gen: u32,
    pub policy: Policy,
    pub balance: u128,
    /// Spent in `spent_epoch`; reset lazily when the epoch moves on.
    pub spent: u128,
    pub spent_epoch: u64,
    /// Unfinished jobs this spore posted (as consumer).
    pub posted: Vec<u64>,
    /// Escrowed jobs this spore is providing.
    pub serving: Vec<u64>,
    pub transfers: u32,
    /// Asking price while listed (SPEC §5.4). Listing blocks `withdraw` and `pause`.
    pub listing: Option<u128>,
    pub sales: u32,
    /// `(epoch, state hash)` written at each close for active spores: what
    /// `commit_image` binds an image to (`spores_core::state`).
    pub state: Option<(u64, [u8; 32])>,
    pub image: Option<ImageCommit>,
}

/// An off-chain render committed against a state hash (SPEC §5.5). The router
/// does not check the image; `verify` regenerates it.
#[near(serializers=[borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageCommit {
    pub epoch: u64,
    pub state_hash: [u8; 32],
    pub image_hash: [u8; 32],
    pub renderer_version: u32,
}

impl Spore {
    pub fn spent_in(&self, epoch: u64) -> u128 {
        if self.spent_epoch == epoch {
            self.spent
        } else {
            0
        }
    }
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobStatus {
    Open,
    Accepted,
    Delivered,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    pub provider: SporeId,
    pub price: U128,
    /// The provider's `operator_gen` when it quoted; a quote from a cleared
    /// operator cannot be accepted.
    pub operator_gen: u32,
}

/// A job in flight. Finished jobs are deleted; their outcome is in the event log.
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug)]
pub struct Job {
    pub id: u64,
    pub consumer: SporeId,
    pub task: String,
    pub max_price: U128,
    pub status: JobStatus,
    pub quotes: Vec<Quote>,
    pub provider: Option<SporeId>,
    pub price: U128,
    pub result_hash: Option<String>,
    pub posted_ns: U64,
    pub accepted_epoch: u64,
    /// Open: `posted + timeout`. Escrowed: `accepted + timeout`. After it
    /// anyone may call `timeout_job`: an open or accepted job refunds the
    /// consumer, a delivered one settles to the provider without flow.
    pub deadline_ns: U64,
}

/// Contract parameters, fixed at init.
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub supply_cap: u32,
    pub max_active: u32,
    pub epoch_len_ns: U64,
    pub job_timeout_ns: U64,
    pub min_activation_deposit: U128,
    pub decay_bps: u32,
    pub gain: U128,
    pub k: U128,
    pub d_min: U128,
    pub fee_bps: u32,
    pub rebate_bps: u32,
    pub breadth_full: u32,
    pub reject_bps: u32,
    /// Living allowance (SPEC §7.2): the epoch budget is
    /// `min(owner budget, base_budget + trust_gain * R / 1000)`.
    #[serde(default = "default_base_budget")]
    pub base_budget: U128,
    #[serde(default = "default_trust_gain")]
    pub trust_gain: U128,
    /// Share of each `buy` paid to `royalty_account` (the admin when unset).
    #[serde(default = "default_royalty_bps")]
    pub royalty_bps: u32,
    #[serde(default)]
    pub royalty_account: Option<AccountId>,
}

fn default_base_budget() -> U128 {
    U128(Allowance::shipped().base_budget)
}

fn default_trust_gain() -> U128 {
    U128(Allowance::shipped().trust_gain)
}

fn default_royalty_bps() -> u32 {
    500
}

impl Config {
    /// `Params::shipped()` with 64 spores, 16 active, 10-minute epochs and jobs.
    pub fn shipped() -> Self {
        let p = Params::shipped();
        let PoolRule::CappedRebate { rebate_bps } = p.pool_rule else {
            unreachable!("shipped params use the capped rebate")
        };
        Config {
            supply_cap: 64,
            max_active: 16,
            epoch_len_ns: U64(600_000_000_000),
            job_timeout_ns: U64(600_000_000_000),
            min_activation_deposit: U128(spores_core::NEAR / 10),
            decay_bps: p.decay_bps,
            gain: U128(p.gain),
            k: U128(p.k),
            d_min: U128(p.d_min),
            fee_bps: p.fee_bps,
            rebate_bps,
            breadth_full: p.breadth_full,
            reject_bps: p.reject_bps,
            base_budget: default_base_budget(),
            trust_gain: default_trust_gain(),
            royalty_bps: default_royalty_bps(),
            royalty_account: None,
        }
    }

    pub fn allowance(&self) -> Allowance {
        Allowance {
            base_budget: self.base_budget.0,
            trust_gain: self.trust_gain.0,
        }
    }

    pub fn params(&self) -> Params {
        Params {
            decay_bps: self.decay_bps,
            gain: self.gain.0,
            k: self.k.0,
            d_min: self.d_min.0,
            fee_bps: self.fee_bps,
            pool_rule: PoolRule::CappedRebate { rebate_bps: self.rebate_bps },
            breadth_full: self.breadth_full,
            reject_bps: self.reject_bps,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        self.params().validate().map_err(|e| e.to_string())?;
        if self.supply_cap == 0 || self.supply_cap > MAX_SUPPLY {
            return Err(format!("supply_cap must be in 1..={MAX_SUPPLY}"));
        }
        if self.max_active == 0 || self.max_active > self.supply_cap {
            return Err("max_active must be in 1..=supply_cap".into());
        }
        if self.epoch_len_ns.0 == 0 || self.job_timeout_ns.0 == 0 {
            return Err("epoch_len_ns and job_timeout_ns must be positive".into());
        }
        if self.royalty_bps > 10_000 {
            return Err("royalty_bps must be <= 10000".into());
        }
        Ok(())
    }
}

/// NEP-297 event: `EVENT_JSON:{"standard":"spores","version":"1.0.0","event":..,"data":[..]}`.
pub fn emit(event: &str, data: Value) {
    let body = json!({ "standard": "spores", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{}", serde_json::to_string(&body).unwrap()));
}

pub fn hex(bytes: &[u8]) -> String {
    spores_core::fingerprint::hex(bytes)
}

/// 64 lowercase or uppercase hex digits to 32 bytes; panics with `what` otherwise.
pub fn unhex32(s: &str, what: &str) -> [u8; 32] {
    let b = s.as_bytes();
    if b.len() != 64 {
        env::panic_str(&format!("{what} must be 64 hex digits"));
    }
    let digit = |c: u8| match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => env::panic_str(&format!("{what} must be 64 hex digits")),
    };
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = digit(b[2 * i]) << 4 | digit(b[2 * i + 1]);
    }
    out
}
