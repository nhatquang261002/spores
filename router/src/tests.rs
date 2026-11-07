//! Contract tests for SPEC §11 (spore NFT, policy, jobs, epochs, ledger) in the
//! mocked runtime. What the mock cannot show (function-call key method lists,
//! deposits on non-payable methods, real promise execution) is checked on
//! testnet by `scripts/phase3-testnet.sh`.

use std::panic::{catch_unwind, AssertUnwindSafe};

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::NonFungibleTokenMetadataProvider;
use near_sdk::json_types::U128;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult, RuntimeFeesConfig};
use sha2::{Digest, Sha256};
use spores_core::{Edge, EdgeMap, EpochInput, RejectMap};

use super::*;
use crate::types::{hex, MAX_EPOCH_PAIRS};

const NEAR: u128 = spores_core::NEAR;
const EPOCH: u64 = 1_000;
const TIMEOUT: u64 = 400;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn open_policy() -> Policy {
    Policy {
        paused: false,
        budget_per_epoch: U128(NEAR),
        max_payment: U128(NEAR / 2),
        allow_all_spores: true,
        allowlist: vec![],
        external_allowlist: vec![acc("outside.near")],
    }
}

/// Runs `f` and returns its panic message; fails the test if `f` succeeds.
fn fails(f: impl FnOnce()) -> String {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(()) => panic!("expected the call to fail"),
        Err(e) => e
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default(),
    }
}

fn assert_fails(expected: &str, f: impl FnOnce()) {
    let msg = fails(f);
    assert!(msg.contains(expected), "expected {expected:?}, got {msg:?}");
}

struct World {
    r: Router,
    now: u64,
}

impl World {
    fn context(who: &str, deposit: u128, now: u64) -> near_sdk::VMContext {
        VMContextBuilder::new()
            .current_account_id(acc("router.near"))
            .predecessor_account_id(acc(who))
            .signer_account_id(acc(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(now)
            .account_balance(NearToken::from_near(1_000))
            .random_seed([7; 32])
            .build()
    }

    /// Four spores: 0 and 1 owned by alice, 2 by bob, 3 by carol. 0, 1 and 2
    /// are active (operators op0, op1, op2) with 2 NEAR each and an open policy.
    fn new() -> Self {
        testing_env!(Self::context("admin.near", 0, 0));
        let config = Config {
            supply_cap: 4,
            max_active: 3,
            epoch_len_ns: near_sdk::json_types::U64(EPOCH),
            job_timeout_ns: near_sdk::json_types::U64(TIMEOUT),
            // The owner budget binds here; the living allowance has its own test.
            base_budget: U128(1_000 * NEAR),
            ..Config::shipped()
        };
        let mut w = World { r: Router::new(acc("admin.near"), Some(config)), now: 0 };
        w.call("admin.near", 0)
            .mint_genesis(vec![acc("alice.near"), acc("alice.near"), acc("bob.near"), acc("carol.near")]);
        for (id, owner) in [(0, "alice.near"), (1, "alice.near"), (2, "bob.near")] {
            w.call(owner, 2 * NEAR).activate(id, acc(&format!("op{id}.near")));
            w.call(owner, 1).set_policy(id, open_policy());
        }
        w
    }

    fn call(&mut self, who: &str, deposit: u128) -> &mut Router {
        testing_env!(Self::context(who, deposit, self.now));
        &mut self.r
    }

    fn view(&mut self) -> &mut Router {
        self.call("viewer.near", 0)
    }

    fn op(id: SporeId) -> String {
        format!("op{id}.near")
    }

    fn post(&mut self, consumer: SporeId, max_price: u128) -> u64 {
        self.call(&Self::op(consumer), 0).post_job(consumer, "summarize".into(), U128(max_price))
    }

    /// Posts, quotes and accepts; returns the escrowed job id.
    fn hire(&mut self, consumer: SporeId, provider: SporeId, price: u128) -> u64 {
        let job = self.post(consumer, price);
        self.call(&Self::op(provider), 0).quote(job, provider, U128(price));
        self.call(&Self::op(consumer), 0).accept(job, provider);
        job
    }

    fn trade(&mut self, consumer: SporeId, provider: SporeId, price: u128) -> u64 {
        let job = self.hire(consumer, provider, price);
        self.call(&Self::op(provider), 0).deliver(job, "sha256:00".into());
        self.call(&Self::op(consumer), 0).settle(job);
        job
    }

    fn balance(&mut self, id: SporeId) -> u128 {
        self.view().spore_summary(id).unwrap().balance.0
    }

    fn close(&mut self) -> String {
        self.now += EPOCH;
        self.call("anyone.near", 0).close_epoch()
    }

    fn assert_conserved(&mut self) {
        let t = self.view().ledger_totals();
        assert!(t.conserved, "ledger not conserved: {:?}", (t.deposited, t.withdrawn, t.balances, t.escrow, t.pool, t.treasury));
        let escrowed: u128 = self
            .r
            .jobs
            .values()
            .filter(|j| j.status != JobStatus::Open)
            .map(|j| j.price.0)
            .sum();
        assert_eq!(escrowed, self.r.escrow, "escrow counter disagrees with jobs");
        let with_provider = self.r.jobs.values().filter(|j| j.provider.is_some()).count() as u64;
        assert_eq!(self.r.escrowed_jobs(), with_provider, "escrowed-job counter disagrees with jobs");
        for (id, s) in self.r.spores.iter().enumerate() {
            for j in &s.posted {
                assert_eq!(self.r.jobs.get(j).map(|j| j.consumer), Some(id as u32), "dangling posted job");
            }
            for j in &s.serving {
                assert_eq!(self.r.jobs.get(j).and_then(|j| j.provider), Some(id as u32), "dangling serving job");
            }
        }
    }
}

/// 64 spores owned by `owner{i}.near`, the first `active` active with 2 NEAR
/// and an open policy, under `max_active`. Starts from a fresh mocked chain:
/// `testing_env!` keeps storage from the previous call on the thread.
fn big_world(max_active: u32, active: u32) -> World {
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::default());
    testing_env!(World::context("admin.near", 0, 0));
    let config = Config {
        supply_cap: 64,
        max_active,
        epoch_len_ns: near_sdk::json_types::U64(EPOCH),
        job_timeout_ns: near_sdk::json_types::U64(TIMEOUT),
        base_budget: U128(1_000 * NEAR),
        ..Config::shipped()
    };
    let mut w = World { r: Router::new(acc("admin.near"), Some(config)), now: 0 };
    w.call("admin.near", 0).mint_genesis((0..64).map(|i| acc(&format!("owner{i}.near"))).collect());
    for id in 0..active {
        let owner = format!("owner{id}.near");
        w.call(&owner, 2 * NEAR).activate(id, acc(&World::op(id)));
        w.call(&owner, 1).set_policy(id, open_policy());
    }
    w
}

// ---- mint and ownership -------------------------------------------------------

#[test]
fn mint_is_admin_only_capped_and_seeds_follow_the_formula() {
    let mut w = World::new();
    assert_fails("only the admin can mint", || {
        w.call("alice.near", 0).mint_genesis(vec![acc("alice.near")]);
    });
    assert_fails("supply cap reached", || {
        w.call("admin.near", 0).mint_genesis(vec![acc("alice.near")]);
    });
    let mut seeds = std::collections::BTreeSet::new();
    for id in 0..4u32 {
        let s = w.r.spores.get(id).unwrap().clone();
        let mut h = Sha256::new();
        h.update(id.to_le_bytes());
        h.update(s.mint_randomness);
        assert_eq!(s.seed, <[u8; 32]>::from(h.finalize()));
        seeds.insert(s.seed);
    }
    assert_eq!(seeds.len(), 4);
    let carol = w.view().spore_summary(3).unwrap();
    assert!(!carol.active && carol.policy == Policy::locked() && carol.operator_id.is_none());
}

#[test]
fn only_the_owner_can_activate_set_policy_register_pause_or_withdraw() {
    let mut w = World::new();
    for who in ["bob.near", "op0.near", "admin.near"] {
        assert_fails("only the spore owner", || w.call(who, 1).set_policy(0, open_policy()));
        assert_fails("only the spore owner", || w.call(who, 1).register_operator(0, acc("x.near")));
        assert_fails("only the spore owner", || w.call(who, 0).pause(0));
        assert_fails("only the spore owner", || {
            let _ = w.call(who, 1).withdraw(0, U128(1));
        });
        assert_fails("only the spore owner", || w.call(who, NEAR).activate(3, acc("x.near")));
    }
    w.call("alice.near", 0).pause(0);
    assert!(w.view().spore_summary(0).unwrap().policy.paused);
}

#[test]
fn control_methods_need_one_yocto_so_a_function_call_key_cannot_use_them() {
    let mut w = World::new();
    assert_fails("Requires attached deposit of exactly 1 yoctoNEAR", || {
        w.call("alice.near", 0).set_policy(0, open_policy())
    });
    assert_fails("Requires attached deposit of exactly 1 yoctoNEAR", || {
        w.call("alice.near", 0).register_operator(0, acc("x.near"))
    });
    assert_fails("Requires attached deposit of exactly 1 yoctoNEAR", || {
        let _ = w.call("alice.near", 0).withdraw(0, U128(1));
    });
    assert_fails("Requires attached deposit of exactly 1 yoctoNEAR", || {
        w.call("alice.near", 0).nft_transfer(acc("carol.near"), "0".into(), None, None)
    });
}

#[test]
fn activation_rules() {
    let mut w = World::new();
    assert_fails("min_activation_deposit", || w.call("carol.near", NEAR / 20).activate(3, acc("op3.near")));
    assert_fails("different account from the owner", || w.call("carol.near", NEAR).activate(3, acc("carol.near")));
    assert_fails("already active", || w.call("alice.near", NEAR).activate(0, acc("op0.near")));
    assert_fails("too many active spores", || w.call("carol.near", NEAR).activate(3, acc("op3.near")));
    let s = w.view().spore_summary(0).unwrap();
    assert_eq!((s.active, s.balance.0, s.operator_gen), (true, 2 * NEAR, 1));
    assert!(w.view().is_operator(0, acc("op0.near")));
    assert!(!w.view().is_operator(0, acc("op1.near")));
    assert!(!w.view().is_operator(3, acc("op3.near")));
    assert_eq!(w.view().epoch_info().active, vec![0, 1, 2]);
}

#[test]
fn set_max_active_is_admin_only_raise_only_and_capped_by_supply() {
    let mut w = big_world(16, 16);
    assert_fails("too many active spores", || w.call("owner16.near", NEAR).activate(16, acc("op16.near")));
    assert_fails("only the admin", || w.call("owner0.near", 1).set_max_active(64));
    assert_fails("exactly 1 yoctoNEAR", || w.call("admin.near", 0).set_max_active(64));
    assert_fails("can only be raised", || w.call("admin.near", 1).set_max_active(16));
    assert_fails("can only be raised", || w.call("admin.near", 1).set_max_active(8));
    assert_fails("cannot exceed supply_cap", || w.call("admin.near", 1).set_max_active(65));
    assert_eq!(w.view().config().max_active, 16);

    w.call("admin.near", 1).set_max_active(64);
    let log = near_sdk::test_utils::get_logs().pop().unwrap();
    assert!(log.contains(r#""event":"config_changed""#) && log.contains(r#""old":16,"new":64"#), "{log}");
    assert_eq!(w.view().config().max_active, 64);
    // The 17th spore can now start, and it trades.
    w.call("owner16.near", NEAR).activate(16, acc("op16.near"));
    w.call("owner16.near", 1).set_policy(16, open_policy());
    w.trade(16, 3, NEAR / 10);
    w.close();
    assert_eq!(w.view().epoch_info().active.len(), 17);
    assert!(w.view().spore_summary(16).unwrap().degree == 1);
    w.assert_conserved();
}

#[test]
fn set_max_active_recounts_the_escrowed_jobs() {
    let mut w = big_world(16, 4);
    w.hire(0, 1, NEAR / 10);
    let j = w.hire(2, 3, NEAR / 10);
    w.call("op3.near", 0).deliver(j, "h".into());
    w.post(1, NEAR / 10);
    // A router deployed before the counter existed reads it as absent (0).
    w.r.set_escrowed_jobs(0);
    w.call("admin.near", 1).set_max_active(17);
    assert_eq!(w.r.escrowed_jobs(), 2, "open jobs hold no escrow");
    w.assert_conserved();
}

/// Fills this epoch's flows with `n` pairs among spores 10..63, none touching 0..9.
fn fill_pairs(w: &mut World, n: usize) {
    let pairs = (10..64u32).flat_map(|a| (a + 1..64).map(move |b| (a, b)));
    for k in pairs.take(n) {
        w.r.flows.insert(k, NEAR / 100);
    }
    w.r.pool += NEAR * n as u128 / 10_000;
    w.r.deposited += NEAR * n as u128 / 10_000;
}

#[test]
fn the_pair_cap_refuses_a_new_pair_and_allows_an_existing_one() {
    let mut w = big_world(64, 64);
    fill_pairs(&mut w, MAX_EPOCH_PAIRS as usize - 2);
    w.trade(0, 1, NEAR / 10); // a new pair: now cap - 1 pairs
    let escrowed = w.hire(2, 3, NEAR / 10); // a new pair, escrowed: the cap is reached
    let bal = w.balance(4);
    let job = w.post(4, NEAR / 10);
    w.call("op5.near", 0).quote(job, 5, U128(NEAR / 10));
    assert_fails("epoch pair cap reached: try next epoch", || w.call("op4.near", 0).accept(job, 5));
    assert_eq!(w.balance(4), bal, "a refused accept moves nothing");
    assert_eq!(w.view().get_job(job).unwrap().status, JobStatus::Open);
    // A pair already in the flows (or the rejects) is still allowed.
    w.trade(1, 0, NEAR / 10);
    let r = w.hire(10, 11, NEAR / 10);
    w.call("op11.near", 0).deliver(r, "h".into());
    w.call("op10.near", 0).reject(r);
    // The escrowed job settles after the close and takes its pair into the next epoch.
    w.call("op3.near", 0).deliver(escrowed, "h".into());
    w.close();
    let ev = epoch_closed_event();
    assert_eq!(ev["flows"].as_array().unwrap().len() as u64, MAX_EPOCH_PAIRS - 1);
    w.call("op2.near", 0).settle(escrowed);
    assert_eq!(w.r.epoch_pairs(), 1);
    // The next epoch has room again.
    w.trade(4, 5, NEAR / 10);
    w.assert_conserved();
}

/// Random hires, deliveries, settlements, rejections, timeouts and closes
/// among 64 active spores, many per epoch: no close names more than
/// `MAX_EPOCH_PAIRS` pairs, the cap is reached, and the counter stays right.
#[test]
fn no_close_names_more_pairs_than_the_cap() {
    let mut w = big_world(64, 64);
    let mut x: u64 = 0xD1B5_4A32_D192_ED03;
    let mut rnd = move |n: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % n
    };
    let (mut refused, mut busiest, mut fullest) = (0, 0u64, 0u64);
    for step in 1..=6_000 {
        let live: Vec<Job> = w.r.jobs.values().cloned().collect();
        let job = (!live.is_empty()).then(|| live[rnd(live.len() as u64) as usize].clone());
        let r = catch_unwind(AssertUnwindSafe(|| match (rnd(8), job) {
            (0..=3, _) | (4..=6, None) => {
                let a = rnd(64) as u32;
                let b = (a + 1 + rnd(63) as u32) % 64;
                w.hire(a, b, NEAR / 1_000);
            }
            (4..=6, Some(j)) => match j.status {
                JobStatus::Open => w.call("anyone.near", 0).timeout_job(j.id),
                JobStatus::Accepted => w.call(&World::op(j.provider.unwrap()), 0).deliver(j.id, "h".into()),
                JobStatus::Delivered if rnd(4) > 0 => w.call(&World::op(j.consumer), 0).settle(j.id),
                JobStatus::Delivered => w.call(&World::op(j.consumer), 0).reject(j.id),
            },
            (_, j) => {
                w.now += 1 + rnd(5);
                w.call("anyone.near", 0).timeout_job(j.map_or(0, |j| j.id))
            }
        }));
        if let Err(e) = r {
            refused += e.downcast_ref::<String>().is_some_and(|m| m.contains("epoch pair cap")) as u32;
        }
        // The pairs this epoch has, plus those escrowed jobs may still add
        // (now or after a close), never exceed the cap.
        let mut held: std::collections::BTreeSet<EdgeKey> = w.r.flows.keys().chain(w.r.rejects.keys()).copied().collect();
        held.extend(w.r.jobs.values().filter_map(|j| j.provider.map(|p| edge_key(j.consumer, p))));
        assert!(held.len() as u64 <= MAX_EPOCH_PAIRS, "{} pairs held", held.len());
        fullest = fullest.max(w.r.epoch_pairs() + w.r.escrowed_jobs());
        if step % 1_500 == 0 {
            w.close();
            let ev = epoch_closed_event();
            let mut named: Vec<(u32, u32, u128)> = triples(&ev["flows"]);
            named.extend(triples(&ev["rejects"]));
            let mut pairs: Vec<(u32, u32)> = named.iter().map(|t| (t.0, t.1)).collect();
            pairs.sort();
            pairs.dedup();
            assert!(pairs.len() as u64 <= MAX_EPOCH_PAIRS, "a close named {} pairs", pairs.len());
            busiest = busiest.max(pairs.len() as u64);
        }
        w.assert_conserved();
    }
    // Escrowed jobs hold room, so a close names fewer pairs than the cap.
    assert!(refused > 0 && fullest >= MAX_EPOCH_PAIRS, "the mix never reached the cap: {refused} refusals, fullest {fullest}");
    assert!(busiest > MAX_EPOCH_PAIRS / 2, "the busiest close named only {busiest} pairs");
}

// ---- ledger ---------------------------------------------------------------------

#[test]
fn deposit_and_owner_only_withdraw_to_the_owner() {
    let mut w = World::new();
    assert_eq!(w.call("stranger.near", NEAR).deposit(0).0, 3 * NEAR);
    assert_fails("attach the amount", || {
        w.call("alice.near", 0).deposit(0);
    });
    // The operator cannot withdraw, to itself or anywhere: there is no recipient argument.
    assert_fails("only the spore owner", || {
        let _ = w.call("op0.near", 1).withdraw(0, U128(NEAR));
    });
    assert_fails("insufficient balance", || {
        let _ = w.call("alice.near", 1).withdraw(0, U128(4 * NEAR));
    });
    let _ = w.call("alice.near", 1).withdraw(0, U128(NEAR));
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, acc("alice.near"), "funds go to the owner");
    assert_eq!(w.balance(0), 2 * NEAR);
    w.assert_conserved();

    // A failed transfer restores the balance.
    testing_env!(
        World::context("router.near", 0, w.now),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    assert!(!w.r.on_withdraw(0, acc("alice.near"), U128(NEAR)));
    assert_eq!(w.balance(0), 3 * NEAR);
    w.assert_conserved();
    // `#[private]` is enforced in the wasm entry point, not in a direct Rust
    // call, so the testnet script checks that a stranger cannot call it.
}

// ---- policy ---------------------------------------------------------------------

#[test]
fn each_policy_rule_rejects_the_payment_and_moves_nothing() {
    let mut w = World::new();
    let before = (w.balance(0), w.r.escrow);

    // Per-payment cap: cap 0.5 NEAR.
    let job = w.post(0, NEAR);
    w.call("op1.near", 0).quote(job, 1, U128(NEAR / 2 + 1));
    assert_fails("policy: payment exceeds the per-payment cap", || w.call("op0.near", 0).accept(job, 1));

    // Allowlist: only spore 2.
    let mut p = open_policy();
    p.allow_all_spores = false;
    p.allowlist = vec![2];
    w.call("alice.near", 1).set_policy(0, p);
    w.call("op1.near", 0).quote(job, 1, U128(NEAR / 4));
    assert_fails("policy: payee is not on the allowlist", || w.call("op0.near", 0).accept(job, 1));
    w.call("alice.near", 1).set_policy(0, open_policy());

    // Pause, after the quote is in.
    w.call("alice.near", 0).pause(0);
    assert_fails("policy: spore is paused", || w.call("op0.near", 0).accept(job, 1));
    assert_fails("policy: spore is paused", || {
        w.post(0, NEAR);
    });
    assert_eq!((w.balance(0), w.r.escrow), before, "a rejected payment moves nothing");
    w.call("alice.near", 1).set_policy(0, open_policy());

    // Budget: 1 NEAR per epoch; two 0.4 payments fit, a third does not.
    w.call("op0.near", 0).accept(job, 1);
    w.hire(0, 2, 2 * NEAR / 5);
    let third = w.post(0, NEAR);
    w.call("op1.near", 0).quote(third, 1, U128(2 * NEAR / 5));
    assert_fails("policy: epoch budget exceeded", || w.call("op0.near", 0).accept(third, 1));
    assert_eq!(w.view().spore_summary(0).unwrap().budget_left.0, NEAR - NEAR / 4 - 2 * NEAR / 5);

    // The next epoch has a fresh budget. (The open job expired at the close, so post again.)
    w.close();
    let fresh = w.post(0, NEAR);
    w.call("op1.near", 0).quote(fresh, 1, U128(2 * NEAR / 5));
    w.call("op0.near", 0).accept(fresh, 1);
    w.assert_conserved();
}

#[test]
fn balance_limits_spending_even_within_policy() {
    let mut w = World::new();
    let mut p = open_policy();
    p.budget_per_epoch = U128(100 * NEAR);
    p.max_payment = U128(100 * NEAR);
    w.call("alice.near", 1).set_policy(0, p);
    let job = w.post(0, 5 * NEAR);
    w.call("op1.near", 0).quote(job, 1, U128(3 * NEAR));
    assert_fails("insufficient balance", || w.call("op0.near", 0).accept(job, 1));
}

// ---- jobs -----------------------------------------------------------------------

#[test]
fn settle_pays_provider_minus_fee_and_counts_flow() {
    let mut w = World::new();
    let price = NEAR / 10 + 1;
    w.trade(0, 2, price);
    let fee = spores_core::fee::split_payment(price, 100).unwrap().fee;
    assert_eq!(fee, NEAR / 1000 + 1, "fee rounds up");
    assert_eq!(w.balance(0), 2 * NEAR - price);
    assert_eq!(w.balance(2), 2 * NEAR + price - fee);
    let e = w.view().epoch_info();
    assert_eq!(e.pool.0, fee);
    assert_eq!(e.flows, vec![(0, 2, U128(price))]);
    assert_eq!(w.view().jobs_count(), 0, "finished jobs are deleted");
    w.assert_conserved();
}

#[test]
fn only_settled_jobs_count_as_flow() {
    let mut w = World::new();
    // Rejected: refunded, counted as a rejection, no flow.
    let job = w.hire(0, 1, NEAR / 10);
    w.call("op1.near", 0).deliver(job, "h".into());
    w.call("op0.near", 0).reject(job);
    // Timed out after acceptance: refunded, no flow.
    let late = w.hire(0, 2, NEAR / 10);
    assert_fails("job has not timed out", || w.call("anyone.near", 0).timeout_job(late));
    w.now += TIMEOUT;
    assert_fails("job has timed out", || w.call("op2.near", 0).deliver(late, "h".into()));
    w.call("anyone.near", 0).timeout_job(late);
    // Delivered but never settled: auto-settled at the deadline. The provider
    // is paid and the fee taken, but it is not flow, so no tube grows.
    let ignored = w.hire(1, 2, NEAR / 10);
    w.call("op2.near", 0).deliver(ignored, "h".into());
    w.now += TIMEOUT;
    w.call("anyone.near", 0).timeout_job(ignored);
    let fee = spores_core::fee::split_payment(NEAR / 10, 100).unwrap().fee;

    assert_eq!(w.balance(0), 2 * NEAR);
    assert_eq!(w.balance(1), 2 * NEAR - NEAR / 10);
    assert_eq!(w.balance(2), 2 * NEAR + NEAR / 10 - fee);
    let e = w.view().epoch_info();
    assert!(e.flows.is_empty(), "auto-settle is not flow");
    assert_eq!(e.pool.0, fee);
    assert_eq!(e.rejects, vec![(0, 1, 1)]);
    assert_eq!(w.view().spore_summary(0).unwrap().spent_this_epoch.0, 0, "refunds give the budget back");
    w.assert_conserved();
}

#[test]
fn job_methods_check_roles_and_states() {
    let mut w = World::new();
    assert_fails("caller is not this spore's operator", || {
        w.call("op1.near", 0).post_job(0, "x".into(), U128(1));
    });
    assert_fails("caller is not this spore's operator", || {
        w.call("alice.near", 0).post_job(0, "x".into(), U128(1));
    });
    assert_fails("spore is not active", || {
        w.call("op3.near", 0).post_job(3, "x".into(), U128(1));
    });
    assert_fails("task is too long", || {
        w.call("op0.near", 0).post_job(0, "x".repeat(257), U128(1));
    });
    let job = w.post(0, NEAR / 10);
    assert_fails("cannot trade with itself", || w.call("op0.near", 0).quote(job, 0, U128(1)));
    assert_fails("price must be in 1..=max_price", || w.call("op1.near", 0).quote(job, 1, U128(NEAR)));
    assert_fails("caller is not this spore's operator", || w.call("op2.near", 0).quote(job, 1, U128(1)));
    assert_fails("no quote from that provider", || w.call("op0.near", 0).accept(job, 1));
    w.call("op1.near", 0).quote(job, 1, U128(NEAR / 10));
    assert_fails("caller is not this spore's operator", || w.call("op1.near", 0).accept(job, 1));
    assert_fails("job is not awaiting delivery", || w.call("op1.near", 0).deliver(job, "h".into()));
    w.call("op0.near", 0).accept(job, 1);
    assert_fails("job is not open", || w.call("op2.near", 0).quote(job, 2, U128(1)));
    assert_fails("caller is not this spore's operator", || w.call("op2.near", 0).deliver(job, "h".into()));
    assert_fails("job has not been delivered", || w.call("op0.near", 0).settle(job));
    w.call("op1.near", 0).deliver(job, "h".into());
    assert_fails("caller is not this spore's operator", || w.call("op1.near", 0).settle(job));
    w.call("op0.near", 0).settle(job);
    assert_fails("unknown job", || w.call("op0.near", 0).settle(job));
    for _ in 0..crate::types::MAX_POSTED_JOBS {
        w.post(0, 1);
    }
    assert_fails("too many unfinished jobs", || {
        w.post(0, 1);
    });
    w.assert_conserved();
}

// ---- transfer semantics (SPEC §5.3) --------------------------------------------------

#[test]
fn transfer_locks_out_the_old_operator_and_owner_and_refunds_jobs_in_flight() {
    let mut w = World::new();
    // History: a tube 0-2 and some age.
    w.trade(0, 2, NEAR / 10);
    w.close();
    // In flight: 0 pays 2 (escrowed), 1 pays 0 (escrowed), and 0 has quoted on 2's open job.
    let as_consumer = w.hire(0, 2, NEAR / 5);
    let as_provider = w.hire(1, 0, NEAR / 5);
    w.call("op0.near", 0).deliver(as_provider, "h".into());
    let open = w.post(2, NEAR);
    w.call("op0.near", 0).quote(open, 0, U128(NEAR / 10));

    let before = w.view().spore_summary(0).unwrap();
    let (bal1, edges) = (w.balance(1), w.view().edges());
    w.call("alice.near", 1).nft_transfer(acc("carol.near"), "0".into(), None, None);
    let after = w.view().spore_summary(0).unwrap();

    assert_eq!(after.owner_id, acc("carol.near"));
    assert_eq!(after.policy, Policy::locked(), "policy resets to paused with zero budget");
    assert!(after.operator_id.is_none());
    assert_eq!(after.operator_gen, before.operator_gen + 1);
    assert_eq!(after.balance.0, before.balance.0 + NEAR / 5, "balance stays; its own escrow comes back");
    assert_eq!(w.balance(1), bal1 + NEAR / 5, "the payer of the job it was serving is refunded");
    assert_eq!(
        (after.age, after.connections.clone(), after.reputation),
        (before.age, before.connections.clone(), before.reputation)
    );
    assert_eq!(w.view().edges(), edges);
    assert!(w.view().get_job(as_consumer).is_none() && w.view().get_job(as_provider).is_none());
    assert_eq!(w.r.escrow, 0);
    assert_eq!(after.transfers, 1);

    assert_fails("caller is not this spore's operator", || {
        w.post(0, 1);
    });
    assert!(!w.view().is_operator(0, acc("op0.near")));
    assert_fails("only the spore owner", || {
        let _ = w.call("alice.near", 1).withdraw(0, U128(1));
    });
    assert_fails("only the spore owner", || w.call("alice.near", 1).set_policy(0, open_policy()));
    // Not the owner, and approvals (NEP-178) are off, so no one else can move it.
    assert_fails("Approval extension is disabled", || {
        w.call("alice.near", 1).nft_transfer(acc("bob.near"), "0".into(), None, None)
    });

    // The new owner takes over; the old quote on spore 2's job is void.
    w.call("carol.near", 1).register_operator(0, acc("op9.near"));
    w.call("carol.near", 1).set_policy(0, open_policy());
    assert_fails("quote is stale", || w.call("op2.near", 0).accept(open, 0));
    w.call("op9.near", 0).quote(open, 0, U128(NEAR / 10));
    w.call("op2.near", 0).accept(open, 0);
    w.call("op9.near", 0).post_job(0, "x".into(), U128(1));
    let _ = w.call("carol.near", 1).withdraw(0, U128(NEAR));
    w.assert_conserved();
}

#[test]
fn a_reverted_transfer_call_clears_what_the_receiver_set() {
    let mut w = World::new();
    let _ = w
        .call("alice.near", 1)
        .nft_transfer_call(acc("market.near"), "0".into(), None, None, "".into());
    // While it held the spore, the receiver registered its own operator and opened the policy.
    w.call("market.near", 1).register_operator(0, acc("evil.near"));
    w.call("market.near", 1).set_policy(0, open_policy());
    assert!(w.view().is_operator(0, acc("evil.near")));
    // nft_on_transfer returned true: give the token back.
    testing_env!(
        World::context("router.near", 0, w.now),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(b"true".to_vec())]
    );
    let kept = w.r.nft_resolve_transfer(acc("alice.near"), acc("market.near"), "0".into(), None);
    assert!(!kept);
    let s = w.view().spore_summary(0).unwrap();
    assert_eq!(s.owner_id, acc("alice.near"));
    assert!(s.operator_id.is_none() && s.policy == Policy::locked());
    assert_eq!(s.transfers, 0);
    w.assert_conserved();
}

// ---- epochs ---------------------------------------------------------------------

#[test]
fn close_too_early_or_twice_fails_and_an_empty_epoch_pays_nothing() {
    let mut w = World::new();
    w.now += EPOCH - 1;
    assert_fails("epoch has not ended yet", || {
        w.call("anyone.near", 0).close_epoch();
    });
    w.now += 1;
    let balances: Vec<u128> = (0..4).map(|i| w.balance(i)).collect();
    let fp1 = w.call("anyone.near", 0).close_epoch();
    assert_fails("epoch has not ended yet", || {
        w.call("anyone.near", 0).close_epoch();
    });
    assert_eq!((0..4).map(|i| w.balance(i)).collect::<Vec<_>>(), balances);
    assert_eq!(w.r.treasury, 0);
    assert_eq!(w.view().fingerprint(1), Some(fp1));
    assert_eq!(w.view().epoch_info().epoch, 2);
    assert_eq!(w.view().spore_summary(0).unwrap().age, 1);
    w.assert_conserved();
}

#[test]
fn epoch_close_matches_spores_core_byte_for_byte() {
    let mut w = World::new();
    w.trade(0, 1, NEAR / 10);
    w.trade(1, 2, NEAR / 4);
    w.trade(2, 0, NEAR / 20);
    let job = w.hire(0, 2, NEAR / 10);
    w.call("op2.near", 0).deliver(job, "h".into());
    w.call("op0.near", 0).reject(job);

    // The same epoch computed directly by core.
    let info = w.view().epoch_info();
    let flows: EdgeMap = info.flows.iter().map(|(a, b, q)| (Edge::new(*a, *b).unwrap(), q.0)).collect();
    let rejects: RejectMap = info.rejects.iter().map(|(a, b, r)| (Edge::new(*a, *b).unwrap(), *r)).collect();
    let expected = spores_core::close_epoch(
        &Config::shipped().params(),
        &EpochInput {
            epoch: 1,
            prev_fingerprint: spores_core::fingerprint::GENESIS,
            active: &[0, 1, 2],
            conductivity: &EdgeMap::new(),
            flows: &flows,
            rejects: &rejects,
            pool: info.pool.0,
        },
    )
    .unwrap();
    let balances: Vec<u128> = (0..3).map(|i| w.balance(i)).collect();
    let fp = w.close();

    assert_eq!(fp, spores_core::fingerprint::hex(&expected.fingerprint));
    let got: Vec<(u32, u32, u128)> = w.view().edges().into_iter().map(|(a, b, d)| (a, b, d.0)).collect();
    let want: Vec<(u32, u32, u128)> = expected.conductivity.iter().map(|(e, d)| (e.a(), e.b(), *d)).collect();
    assert_eq!(got, want);
    assert!(!got.is_empty());
    for i in 0..3u32 {
        let rebate = expected.distribution.payouts.get(&i).copied().unwrap_or(0);
        assert_eq!(w.balance(i), balances[i as usize] + rebate);
    }
    assert_eq!(w.r.treasury, expected.distribution.treasury);
    assert_eq!(w.view().epoch_info().prev_fingerprint, fp);
    w.assert_conserved();
}

/// NEAR's limit on the total log bytes of one receipt (`max_total_log_length`,
/// testnet protocol 88, see `docs/verify-notes.md`). `close_epoch` writes one
/// log, the `epoch_closed` event.
const LOG_LIMIT: usize = 16_384;

/// The `epoch_closed` log of a close with spores `0..active` active and `pairs`
/// pairs that each hold a tube, settled volume and rejections. Pairs are taken
/// from the highest ids down (mostly two-digit ids, and the first 63 touch
/// every spore, so every spore gets a rebate) and values are long for their
/// kind, so lengths are upper bounds for these counts: 27-digit flows (about
/// 123 NEAR per pair per epoch), 1000 rejections per pair and a pool of 1% of
/// the flows.
fn epoch_closed_log(active: u32, pairs: usize) -> String {
    assert!(pairs <= (active * (active - 1) / 2) as usize);
    let mut w = big_world(active, active);
    let all = (0..active).rev().flat_map(|b| (0..b).rev().map(move |a| (a, b)));
    for k in all.take(pairs) {
        w.r.edges.insert(k, 3_999_999);
        w.r.flows.insert(k, 123_456_789_012_345_678_901_234_567);
        w.r.rejects.insert(k, 1_000);
    }
    w.r.pool = w.r.flows.values().sum::<u128>() / 100;
    w.r.deposited += w.r.pool;

    // The mock enforces its own log limit; lift it so oversized events can be measured.
    let mut vm = near_sdk::test_vm_config();
    vm.limit_config.max_total_log_length = u64::MAX / 2;
    w.now += EPOCH;
    testing_env!(World::context("anyone.near", 0, w.now), vm, RuntimeFeesConfig::test());
    w.r.close_epoch();
    let logs = near_sdk::test_utils::get_logs();
    assert_eq!(logs.len(), 1);
    logs.into_iter().next().unwrap()
}

/// Phase 6: the trimmed `epoch_closed` (no tubes list) at 64 active fits NEAR's
/// log limit with at least 10% to spare at `MAX_EPOCH_PAIRS`, and would not
/// without a cap. Run with `--nocapture` for the sizes in `docs/phase6-plan.md`.
#[test]
fn epoch_closed_log_size_at_64_active() {
    let len = |p: usize| epoch_closed_log(64, p).len();
    let at_cap = len(MAX_EPOCH_PAIRS as usize);
    let worst = len(2016);
    let all: Vec<usize> = (1..=2016).collect();
    let max_pairs = all.partition_point(|&p| len(p) <= LOG_LIMIT);
    eprintln!(
        "epoch_closed bytes (limit {LOG_LIMIT}), 64 active: at MAX_EPOCH_PAIRS={MAX_EPOCH_PAIRS} {at_cap}; \
         every pair {worst}; most pairs that fit {max_pairs}"
    );
    assert!(at_cap * 10 <= LOG_LIMIT * 9, "under 10% margin at the cap: {at_cap} bytes");
    assert!(worst > LOG_LIMIT, "no cap would be needed");
}

// ---- art from chain state ------------------------------------------------------------

#[test]
fn render_input_from_chain_state_drives_the_renderer() {
    let mut w = World::new();
    let to_spore = |r: views::RenderInput| {
        let seed: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&r.seed[2 * i..2 * i + 2], 16).unwrap()).collect();
        spores_renderer::Spore::new(seed.try_into().unwrap(), r.age, r.edges)
    };
    let dormant = to_spore(w.view().render_input(0));
    assert!(dormant.edges.is_empty());
    w.trade(0, 1, NEAR / 10);
    w.trade(0, 2, NEAR / 10);
    w.trade(1, 2, NEAR / 10);
    w.close();
    let grown = to_spore(w.view().render_input(0));
    assert_eq!(grown.edges.iter().map(|e| e.0).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(grown.age, 1);
    let (a, b) = (spores_renderer::render(&dormant), spores_renderer::render(&grown));
    assert_ne!(spores_renderer::image_hash(&a), spores_renderer::image_hash(&b));

    // Phase 2 open point: does one epoch of decay alone move the image? The
    // smallest live tube is D_min = 50_000, so 25% decay moves D by at least
    // 12_500, above the ~1% the renderer's D/1000 quantization hides.
    w.close();
    let decayed = to_spore(w.view().render_input(0));
    assert!(decayed.edges.iter().zip(&grown.edges).all(|(d, g)| d.1 < g.1));
    let c = spores_renderer::render(&decayed);
    assert_ne!(spores_renderer::image_hash(&b), spores_renderer::image_hash(&c));
}

// ---- ledger conservation ---------------------------------------------------------------

/// SPEC §11: the ledger total is conserved across epochs with fees, refunds,
/// withdrawals (including failed ones) and transfers, under a long random mix
/// of calls. Failing calls are part of the mix; each must leave the ledger whole.
#[test]
fn ledger_is_conserved_under_random_operations() {
    let mut w = World::new();
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = move |n: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % n
    };
    let owners = ["alice.near", "alice.near", "bob.near", "carol.near"];
    let (mut ok, mut settled, mut treasury_out) = (0, 0, 0);
    for step in 0..1_800 {
        let a = rnd(3) as u32;
        let price = (1 + rnd(40)) as u128 * NEAR / 100;
        let live: Vec<Job> = w.r.jobs.values().cloned().collect();
        let job = (!live.is_empty()).then(|| live[rnd(live.len() as u64) as usize].clone());
        // Usually the right caller, sometimes a wrong one.
        let who = |right: SporeId, wrong: u64| World::op(if wrong == 0 { (right + 1) % 3 } else { right });
        let r = catch_unwind(AssertUnwindSafe(|| match (rnd(12), job) {
            (0 | 1, _) | (2..=5, None) => {
                w.post(a, price);
            }
            (2..=5, Some(j)) => match j.status {
                JobStatus::Open if j.quotes.is_empty() || rnd(2) == 0 => {
                    let p = (j.consumer + 1 + rnd(2) as u32) % 3;
                    w.call(&World::op(p), 0).quote(j.id, p, U128(price.min(j.max_price.0)))
                }
                JobStatus::Open => {
                    let p = j.quotes[rnd(j.quotes.len() as u64) as usize].provider;
                    w.call(&who(j.consumer, rnd(8)), 0).accept(j.id, p)
                }
                JobStatus::Accepted => w.call(&who(j.provider.unwrap(), rnd(8)), 0).deliver(j.id, "h".into()),
                JobStatus::Delivered if rnd(3) > 0 => {
                    w.call(&who(j.consumer, rnd(8)), 0).settle(j.id);
                    settled += 1;
                }
                JobStatus::Delivered => w.call(&who(j.consumer, rnd(8)), 0).reject(j.id),
            },
            // Small clock steps: a job needs several calls before its deadline,
            // and an epoch (1000) closes every ~70 of these steps.
            (6, j) => {
                w.now += 1 + rnd(30);
                w.call("anyone.near", 0).timeout_job(j.map_or(0, |j| j.id))
            }
            (7, _) => {
                w.call("anyone.near", price).deposit(a);
            }
            (8, _) => {
                let _ = w.call(owners[a as usize], 1).withdraw(a, U128(price));
                if rnd(3) == 0 {
                    testing_env!(
                        World::context("router.near", 0, w.now),
                        near_sdk::test_vm_config(),
                        RuntimeFeesConfig::test(),
                        Default::default(),
                        vec![PromiseResult::Failed]
                    );
                    w.r.on_withdraw(a, acc(owners[a as usize]), U128(price));
                }
            }
            (9, _) => {
                w.now += 1 + rnd(30);
                w.call("anyone.near", 0).close_epoch();
            }
            (11, _) if rnd(3) == 0 => {
                let payee = if rnd(4) == 0 { "stranger.near" } else { "outside.near" };
                let _ = w.call(&who(a, rnd(8)), 0).pay_service(a, acc(payee), U128(price / 4), "n".into());
                if rnd(3) == 0 {
                    testing_env!(
                        World::context("router.near", 0, w.now),
                        near_sdk::test_vm_config(),
                        RuntimeFeesConfig::test(),
                        Default::default(),
                        vec![PromiseResult::Failed]
                    );
                    let epoch = w.r.epoch;
                    w.r.on_service_paid(a, acc(payee), U128(price / 4), epoch);
                }
            }
            (10, _) if step % 25 == 12 => {
                // Sell a spore to someone else and buy it back, sometimes with a
                // payout transfer that fails and lands in the treasury.
                let (from, to) = (owners[a as usize], "dave.near");
                w.call(from, 1).list(a, U128(price));
                w.call(to, price).buy(a);
                w.call(to, 1).list(a, U128(price));
                w.call(from, price).buy(a);
                if rnd(2) == 0 {
                    testing_env!(
                        World::context("router.near", 0, w.now),
                        near_sdk::test_vm_config(),
                        RuntimeFeesConfig::test(),
                        Default::default(),
                        vec![PromiseResult::Failed]
                    );
                    w.r.on_sale_paid(a, acc(from), U128(price / 2), "seller".into());
                }
                w.call(from, 1).register_operator(a, acc(&World::op(a)));
                w.call(from, 1).set_policy(a, open_policy());
            }
            (11, _) if w.r.treasury > 0 && rnd(2) == 0 => {
                let amount = price.min(w.r.treasury);
                let _ = w.call("admin.near", 1).withdraw_treasury(U128(amount));
                treasury_out += 1;
                if rnd(3) == 0 {
                    testing_env!(
                        World::context("router.near", 0, w.now),
                        near_sdk::test_vm_config(),
                        RuntimeFeesConfig::test(),
                        Default::default(),
                        vec![PromiseResult::Failed]
                    );
                    w.r.on_treasury_withdraw(U128(amount));
                }
            }
            (10, _) if step % 25 == 0 => {
                // Hand a spore to someone else and back, re-registering its operator.
                let (from, to) = (owners[a as usize], "dave.near");
                w.call(from, 1).nft_transfer(acc(to), a.to_string(), None, None);
                w.call(to, 1).nft_transfer(acc(from), a.to_string(), None, None);
                w.call(from, 1).register_operator(a, acc(&World::op(a)));
                w.call(from, 1).set_policy(a, open_policy());
            }
            _ => w.call(owners[a as usize], 1).set_policy(a, open_policy()),
        }));
        ok += r.is_ok() as u32;
        w.assert_conserved();
    }
    let t = w.view().ledger_totals();
    assert!(ok > 500, "too few calls succeeded to mean much: {ok}");
    assert!(settled > 30, "too few settlements: {settled}");
    assert!(
        (t.treasury.0 > 0 || treasury_out > 0) && t.withdrawn.0 > 0,
        "the mix exercised fees and withdrawals"
    );
    assert!(treasury_out > 0, "the mix exercised treasury withdrawals");
    assert!(t.paid_out.0 > 0, "the mix exercised service payments");
    assert!(w.r.spores.iter().any(|s| s.sales > 0), "the mix exercised sales");
}

// ---- outside service ------------------------------------------------------------

#[test]
fn pay_service_pays_an_allowlisted_account_within_policy() {
    let mut w = World::new();
    let _ = w.call("op0.near", 0).pay_service(0, acc("outside.near"), U128(NEAR / 10), "nonce-1".into());
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, acc("outside.near"), "funds go to the payee");
    assert_eq!(w.balance(0), 2 * NEAR - NEAR / 10);
    let s = w.view().spore_summary(0).unwrap();
    assert_eq!(s.spent_this_epoch.0, NEAR / 10, "counts against the epoch budget");
    let e = w.view().epoch_info();
    assert!(e.flows.is_empty() && e.pool.0 == 0, "no fee and no flow");
    assert_eq!(w.view().ledger_totals().paid_out.0, NEAR / 10);
    w.assert_conserved();

    // A failed transfer restores the balance and the budget.
    testing_env!(
        World::context("router.near", 0, w.now),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    let epoch = w.r.epoch;
    assert!(!w.r.on_service_paid(0, acc("outside.near"), U128(NEAR / 10), epoch));
    assert_eq!(w.balance(0), 2 * NEAR);
    assert_eq!(w.view().spore_summary(0).unwrap().spent_this_epoch.0, 0);
    assert_eq!(w.view().ledger_totals().paid_out.0, 0);
    w.assert_conserved();
}

#[test]
fn pay_service_rejections_move_nothing() {
    let mut w = World::new();
    let before = w.balance(0);
    let pay = |w: &mut World, who: &str, payee: &str, amount: u128, memo: &str| {
        let _ = w.call(who, 0).pay_service(0, acc(payee), U128(amount), memo.into());
    };
    assert_fails("caller is not this spore's operator", || pay(&mut w, "op1.near", "outside.near", 1, ""));
    assert_fails("caller is not this spore's operator", || pay(&mut w, "alice.near", "outside.near", 1, ""));
    assert_fails("policy: payee is not on the external allowlist", || {
        pay(&mut w, "op0.near", "op0.near", NEAR / 10, "")
    });
    assert_fails("policy: payment exceeds the per-payment cap", || {
        pay(&mut w, "op0.near", "outside.near", NEAR / 2 + 1, "")
    });
    assert_fails("amount must be positive", || pay(&mut w, "op0.near", "outside.near", 0, ""));
    assert_fails("memo too long", || pay(&mut w, "op0.near", "outside.near", 1, &"x".repeat(65)));
    // Budget is shared with jobs: 1 NEAR per epoch.
    w.hire(0, 1, NEAR / 2);
    pay(&mut w, "op0.near", "outside.near", 2 * NEAR / 5, "");
    assert_fails("policy: epoch budget exceeded", || pay(&mut w, "op0.near", "outside.near", NEAR / 5, ""));
    w.call("alice.near", 0).pause(0);
    assert_fails("policy: spore is paused", || pay(&mut w, "op0.near", "outside.near", 1, ""));
    assert_eq!(w.balance(0), before - NEAR / 2 - 2 * NEAR / 5);
    w.assert_conserved();

    // Too many external payees.
    let mut p = open_policy();
    p.external_allowlist = (0..9).map(|i| acc(&format!("svc{i}.near"))).collect();
    assert_fails("external allowlist too long", || w.call("alice.near", 1).set_policy(0, p));
}

#[test]
fn transfer_clears_the_external_allowlist_and_the_old_operator() {
    let mut w = World::new();
    w.call("alice.near", 1).nft_transfer(acc("dave.near"), "0".into(), None, None);
    let s = w.view().spore_summary(0).unwrap();
    assert!(s.policy.external_allowlist.is_empty() && s.policy.paused);
    assert_fails("caller is not this spore's operator", || {
        let _ = w.call("op0.near", 0).pay_service(0, acc("outside.near"), U128(1), "".into());
    });
    // The new owner registers the same operator: still paused, and the old payee is gone.
    w.call("dave.near", 1).register_operator(0, acc("op0.near"));
    assert_fails("policy: spore is paused", || {
        let _ = w.call("op0.near", 0).pay_service(0, acc("outside.near"), U128(1), "".into());
    });
    let mut p = open_policy();
    p.external_allowlist = vec![];
    w.call("dave.near", 1).set_policy(0, p);
    assert_fails("policy: payee is not on the external allowlist", || {
        let _ = w.call("op0.near", 0).pay_service(0, acc("outside.near"), U128(1), "".into());
    });
}

#[test]
fn policy_json_without_external_allowlist_still_parses() {
    let p: Policy = near_sdk::serde_json::from_str(
        r#"{"paused":false,"budget_per_epoch":"1","max_payment":"1","allow_all_spores":true,"allowlist":[]}"#,
    )
    .unwrap();
    assert!(p.external_allowlist.is_empty());
}

// ---- market (SPEC §5.4) ----------------------------------------------------------------

/// `(receiver, amount)` of every plain transfer the last call created.
fn transfers_out() -> Vec<(AccountId, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                near_sdk::mock::MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

fn failed_callback(w: &World) {
    testing_env!(
        World::context("router.near", 0, w.now),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
}

#[test]
fn only_the_owner_can_list_or_delist_and_a_listing_freezes_withdraw_and_pause() {
    let mut w = World::new();
    assert_fails("only the spore owner", || w.call("bob.near", 1).list(0, U128(NEAR)));
    assert_fails("exactly 1 yoctoNEAR", || w.call("alice.near", 0).list(0, U128(NEAR)));
    assert_fails("price must be positive", || w.call("alice.near", 1).list(0, U128(0)));
    w.call("alice.near", 1).list(0, U128(3 * NEAR));
    assert_eq!(w.view().listings(), vec![(0, U128(3 * NEAR))]);
    assert_eq!(w.view().spore_summary(0).unwrap().listed_price, Some(U128(3 * NEAR)));
    assert_fails("a listed spore cannot withdraw", || {
        let _ = w.call("alice.near", 1).withdraw(0, U128(1));
    });
    assert_fails("a listed spore cannot be paused", || w.call("alice.near", 0).pause(0));
    assert_fails("only the spore owner", || w.call("bob.near", 1).delist(0));
    w.call("alice.near", 1).delist(0);
    assert!(w.view().listings().is_empty());
    assert_fails("spore is not listed", || w.call("alice.near", 1).delist(0));
    // Delisting restores both.
    let _ = w.call("alice.near", 1).withdraw(0, U128(1));
    w.call("alice.near", 0).pause(0);

    // A plain transfer drops the listing, so the new owner is not bound by it.
    w.call("alice.near", 1).list(1, U128(NEAR));
    w.call("alice.near", 1).nft_transfer(acc("carol.near"), "1".into(), None, None);
    assert!(w.view().listings().is_empty());
    assert_fails("spore is not listed", || {
        w.call("bob.near", NEAR).buy(1);
    });
    w.assert_conserved();
}

#[test]
fn buy_moves_the_spore_resets_control_and_splits_the_price() {
    let mut w = World::new();
    w.trade(0, 2, NEAR / 10);
    w.close();
    let as_consumer = w.hire(0, 2, NEAR / 5);
    let as_provider = w.hire(1, 0, NEAR / 5);
    let before = w.view().spore_summary(0).unwrap();
    let (edges, totals, bal1) = (w.view().edges(), w.view().ledger_totals(), w.balance(1));

    w.call("alice.near", 1).list(0, U128(3 * NEAR));
    assert_fails("attach exactly the listed price", || {
        w.call("bob.near", 3 * NEAR - 1).buy(0);
    });
    assert_fails("attach exactly the listed price", || {
        w.call("bob.near", 3 * NEAR + 1).buy(0);
    });
    assert_fails("the owner cannot buy its own spore", || {
        w.call("alice.near", 3 * NEAR).buy(0);
    });
    w.call("bob.near", 3 * NEAR).buy(0);
    let paid = transfers_out();
    let royalty = 3 * NEAR * 500 / 10_000;
    assert_eq!(paid, vec![(acc("alice.near"), 3 * NEAR - royalty), (acc("admin.near"), royalty)]);
    assert_eq!(paid.iter().map(|p| p.1).sum::<u128>(), 3 * NEAR, "seller and royalty sum to the price");
    let logs = near_sdk::test_utils::get_logs();
    assert!(logs.iter().any(|l| l.contains("\"event\":\"nft_transfer\"")), "standard transfer event");
    assert!(logs.iter().any(|l| l.contains("\"event\":\"spore_sold\"")));

    let after = w.view().spore_summary(0).unwrap();
    assert_eq!(after.owner_id, acc("bob.near"));
    assert_eq!(after.policy, Policy::locked(), "policy resets to paused with zero budget");
    assert!(after.operator_id.is_none());
    assert_eq!(after.operator_gen, before.operator_gen + 1);
    assert_eq!(after.balance.0, before.balance.0 + NEAR / 5, "balance stays; its own escrow comes back");
    assert_eq!(w.balance(1), bal1 + NEAR / 5, "the payer of the job it was serving is refunded");
    assert_eq!(
        (after.age, after.connections.clone(), after.reputation),
        (before.age, before.connections.clone(), before.reputation)
    );
    assert_eq!((after.transfers, after.sales, after.listed_price), (1, 1, None));
    assert_eq!(w.view().edges(), edges);
    assert!(w.view().get_job(as_consumer).is_none() && w.view().get_job(as_provider).is_none());
    let t = w.view().ledger_totals();
    assert_eq!(t.deposited, totals.deposited, "the price never enters the ledger");

    assert_fails("caller is not this spore's operator", || {
        w.post(0, 1);
    });
    assert_fails("only the spore owner", || {
        let _ = w.call("alice.near", 1).withdraw(0, U128(1));
    });
    w.call("bob.near", 1).register_operator(0, acc("op9.near"));
    w.call("bob.near", 1).set_policy(0, open_policy());
    w.call("op9.near", 0).post_job(0, "x".into(), U128(1));
    w.assert_conserved();

    // A payout to an account that no longer exists ends in the treasury.
    let treasury = w.r.treasury;
    failed_callback(&w);
    assert!(!w.r.on_sale_paid(0, acc("alice.near"), U128(NEAR), "seller".into()));
    assert_eq!(w.r.treasury, treasury + NEAR);
    w.assert_conserved();
}

#[test]
fn nft_payout_splits_like_buy_and_transfer_payout_resets_control() {
    let mut w = World::new();
    let p = w.view().nft_payout("0".into(), U128(1_000), None);
    assert_eq!(
        p.payout.into_iter().collect::<Vec<_>>(),
        vec![(acc("admin.near"), U128(50)), (acc("alice.near"), U128(950))]
    );
    let p = w.view().nft_payout("0".into(), U128(19), Some(10));
    assert_eq!(p.payout.len(), 1, "a zero royalty is left out");
    assert_fails("payout is longer than max_len_payout", || {
        w.view().nft_payout("0".into(), U128(1_000), Some(1));
    });
    let p = w.call("alice.near", 1).nft_transfer_payout(acc("bob.near"), "0".into(), None, None, U128(1_000), Some(10));
    assert_eq!(p.payout.values().map(|v| v.0).sum::<u128>(), 1_000);
    let s = w.view().spore_summary(0).unwrap();
    assert_eq!((s.owner_id, s.policy, s.operator_id), (acc("bob.near"), Policy::locked(), None));
    assert_fails("Approval extension is disabled", || {
        w.call("alice.near", 1).nft_transfer_payout(acc("carol.near"), "0".into(), None, None, U128(1), None);
    });
}

// ---- living allowance (SPEC §7.2) -------------------------------------------------------

#[test]
fn the_living_allowance_caps_spending_and_drops_as_tubes_decay() {
    let mut w = World::new();
    w.r.config.base_budget = U128(NEAR / 10);
    w.r.config.trust_gain = U128(NEAR / 5);
    let eff = |w: &mut World| w.view().spore_summary(0).unwrap().effective_budget.0;
    assert_eq!(eff(&mut w), NEAR / 10, "no tubes: the base budget");
    assert_fails("policy: epoch budget exceeded", || {
        w.hire(0, 1, NEAR / 10 + 1);
    });
    w.trade(0, 1, NEAR / 10);
    assert_fails("policy: epoch budget exceeded", || {
        w.hire(0, 2, 1);
    });
    assert_fails("policy: epoch budget exceeded", || {
        let _ = w.call("op0.near", 0).pay_service(0, acc("outside.near"), U128(1), "n".into());
    });
    w.trade(1, 0, NEAR / 10);
    w.trade(2, 0, NEAR / 10);
    w.close();
    let s = w.view().spore_summary(0).unwrap();
    let r = s.reputation.0 as u128;
    assert!(r > 0);
    assert_eq!(s.effective_budget.0, NEAR / 10 + NEAR / 5 * r / 1_000);
    assert!(s.effective_budget.0 <= open_policy().budget_per_epoch.0);
    assert_eq!(s.budget_left, s.effective_budget);

    // No new flow: tubes decay, then prune, and the ceiling falls back to base.
    let mut last = s.effective_budget.0;
    for _ in 0..15 {
        w.close();
        let b = eff(&mut w);
        assert!(b <= last, "the allowance never grows without flow");
        last = b;
    }
    assert_eq!(last, NEAR / 10);

    // An owner budget below the ceiling binds instead.
    w.call("alice.near", 1).set_policy(0, Policy { budget_per_epoch: U128(NEAR / 20), ..open_policy() });
    assert_eq!(eff(&mut w), NEAR / 20);
}

// ---- art: state hashes, image commits, glyph (SPEC §5.5) --------------------------------

fn seed_of(hex_seed: &str) -> [u8; 32] {
    crate::types::unhex32(hex_seed, "seed")
}

#[test]
fn commit_image_binds_a_render_to_the_stored_state_hash() {
    let mut w = World::new();
    assert_fails("no state hash yet", || {
        w.call("admin.near", 0).commit_image(0, 1, "00".repeat(32), 1)
    });
    w.trade(0, 1, NEAR / 10);
    w.trade(0, 2, NEAR / 10);
    w.close();
    let (epoch, state_hex) = w.view().spore_summary(0).unwrap().state.unwrap();
    assert_eq!(epoch, 2);
    let ri = w.view().render_input(0);
    let seed = seed_of(&ri.seed);
    let conns: Vec<(SporeId, u128)> = ri.edges.iter().map(|(n, d)| (*n, *d as u128)).collect();
    assert_eq!(state_hex, hex(&spores_core::state::state_hash(0, ri.epoch, &seed, ri.age, &conns)));
    assert!(w.view().spore_summary(3).unwrap().state.is_none(), "dormant spores have no state hash");

    let img = spores_renderer::render(&spores_renderer::Spore::new(seed, ri.age, ri.edges.clone()));
    let h = hex(&spores_renderer::image_hash(&img));
    assert_fails("only the admin", || {
        w.call("alice.near", 0).commit_image(0, 2, h.clone(), spores_renderer::RENDERER_VERSION)
    });
    assert_fails("epoch does not match", || {
        w.call("admin.near", 0).commit_image(0, 1, h.clone(), spores_renderer::RENDERER_VERSION)
    });
    assert_fails("image_hash must be 64 hex digits", || {
        w.call("admin.near", 0).commit_image(0, 2, "zz".into(), 1)
    });
    w.call("admin.near", 0).commit_image(0, 2, h.clone(), spores_renderer::RENDERER_VERSION);
    let c = w.view().image_commit(0).unwrap();
    assert_eq!((c.epoch, c.state_hash.clone(), c.image_hash.clone()), (2, state_hex.clone(), h.clone()));

    // The next close moves the state on; the old commit stays until replaced.
    w.close();
    assert_ne!(w.view().spore_summary(0).unwrap().state.unwrap().1, state_hex);
    assert_eq!(w.view().image_commit(0).unwrap().image_hash, h);
}

#[test]
fn metadata_serves_the_glyph_with_its_hash_and_it_matches_core() {
    let mut w = World::new();
    w.trade(0, 1, NEAR / 10);
    w.close();
    let ri = w.view().render_input(0);
    let conns: Vec<(SporeId, u128)> = ri.edges.iter().map(|(n, d)| (*n, *d as u128)).collect();
    let svg = w.view().glyph(0);
    assert_eq!(svg, spores_core::glyph::glyph_svg(0, &seed_of(&ri.seed), ri.age, true, &conns));
    let m = w.view().nft_token("0".into()).unwrap().metadata.unwrap();
    let media = m.media.unwrap();
    assert_eq!(media, format!("data:image/svg+xml;utf8,{svg}"));
    assert_eq!(m.media_hash.unwrap().0, Sha256::digest(svg.as_bytes()).to_vec());
    assert!(w.view().nft_metadata().base_uri.is_none());
    // Dormant spore 3: the faint mark.
    assert!(!w.view().glyph(3).contains("<line"));
    assert_eq!(w.view().nft_tokens(None, None).len(), 4);
}

// ---- verify from the event log ------------------------------------------------------------

fn epoch_closed_event() -> near_sdk::serde_json::Value {
    let line = near_sdk::test_utils::get_logs()
        .into_iter()
        .find(|l| l.contains("\"event\":\"epoch_closed\""))
        .expect("epoch_closed logged");
    let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&line["EVENT_JSON:".len()..]).unwrap();
    v["data"][0].clone()
}

fn triples(v: &near_sdk::serde_json::Value) -> Vec<(u32, u32, u128)> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let n = |x: &near_sdk::serde_json::Value| x.as_u64().map(|v| v as u128).unwrap_or_else(|| x.as_str().unwrap().parse().unwrap());
            (n(&t[0]) as u32, n(&t[1]) as u32, n(&t[2]))
        })
        .collect()
}

#[test]
fn the_epoch_closed_event_alone_replays_every_fingerprint() {
    let mut w = World::new();
    let params = w.r.config.params();
    let mut d = EdgeMap::new();
    let mut prev = spores_core::fingerprint::GENESIS;
    for round in 0..4u32 {
        w.trade(0, 1, NEAR / 10 * (round as u128 + 1));
        if round != 2 {
            w.trade(1, 2, NEAR / 3);
            let job = w.hire(2, 0, NEAR / 20);
            w.call("op0.near", 0).deliver(job, "h".into());
            w.call("op2.near", 0).reject(job);
        }
        let fp = w.close();
        let ev = epoch_closed_event();
        let edge = |(a, b, x): (u32, u32, u128)| (Edge::new(a, b).unwrap(), x);
        let flows: EdgeMap = triples(&ev["flows"]).into_iter().map(edge).collect();
        let rejects: RejectMap = triples(&ev["rejects"]).into_iter().map(|t| (edge(t).0, t.2 as u32)).collect();
        let active: Vec<u32> = ev["active"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u32).collect();
        let pool: u128 = ev["pool"].as_str().unwrap().parse().unwrap();
        assert_eq!(ev["prev_fingerprint"].as_str().unwrap(), hex(&prev));
        let out = spores_core::close_epoch(
            &params,
            &EpochInput {
                epoch: ev["epoch"].as_u64().unwrap(),
                prev_fingerprint: prev,
                active: &active,
                conductivity: &d,
                flows: &flows,
                rejects: &rejects,
                pool,
            },
        )
        .unwrap();
        assert_eq!(hex(&out.fingerprint), fp);
        assert_eq!(ev["fingerprint"].as_str().unwrap(), fp);
        // Phase 6 logs the tube count only; the tubes come from the replay.
        assert!(ev.get("tubes").is_none());
        assert_eq!(ev["edges"].as_u64().unwrap() as usize, out.conductivity.len());
        assert_eq!(w.view().fingerprint(ev["epoch"].as_u64().unwrap()), Some(fp));
        d = out.conductivity;
        prev = out.fingerprint;
    }
}

#[test]
fn the_largest_epoch_closed_event_fits_the_log_limit() {
    // 64 active spores and the most pairs a close can name, each trading,
    // rejecting and holding a tube, with 27-digit amounts.
    let log = epoch_closed_log(64, MAX_EPOCH_PAIRS as usize);
    // Live testnet limits (EXPERIMENTAL_protocol_config, protocol 88).
    assert!(log.len() < LOG_LIMIT, "{} bytes", log.len());
    assert!(!log.contains(r#""tubes""#));
}

// ---- treasury --------------------------------------------------------------------------------

#[test]
fn the_admin_withdraws_the_treasury_and_a_failed_transfer_restores_it() {
    let mut w = World::new();
    w.trade(0, 1, NEAR / 2);
    w.close();
    let t = w.r.treasury;
    assert!(t > 0);
    assert_fails("only the admin", || {
        let _ = w.call("alice.near", 1).withdraw_treasury(U128(1));
    });
    assert_fails("exactly 1 yoctoNEAR", || {
        let _ = w.call("admin.near", 0).withdraw_treasury(U128(1));
    });
    assert_fails("amount must be in 1..=treasury", || {
        let _ = w.call("admin.near", 1).withdraw_treasury(U128(t + 1));
    });
    let _ = w.call("admin.near", 1).withdraw_treasury(U128(t));
    assert_eq!(transfers_out(), vec![(acc("admin.near"), t)]);
    assert_eq!(w.r.treasury, 0);
    w.assert_conserved();
    failed_callback(&w);
    assert!(!w.r.on_treasury_withdraw(U128(t)));
    assert_eq!(w.r.treasury, t);
    w.assert_conserved();
}
