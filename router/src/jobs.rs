//! Job escrow (SPEC §6.2) with owner policy enforced at `accept` (§7.1).
//!
//! post_job (consumer) -> quote (providers) -> accept (consumer; policy checks,
//! price moves into escrow) -> deliver (provider) -> settle (fee to the pool,
//! the rest to the provider, volume counts as flow) or reject (refund, the
//! edge's tube is cut at epoch close). After the deadline anyone may call
//! `timeout_job`: an open or accepted job refunds the consumer; a delivered
//! one the consumer never settled or rejected is paid to the provider
//! (auto-settle, fee to the pool) but does not count as flow. Only explicitly
//! settled jobs count as flow.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};
use spores_core::fee::split_payment;

use crate::types::{emit, Job, JobStatus, Quote, SporeId, MAX_POSTED_JOBS, MAX_QUOTES, MAX_RESULT_BYTES, MAX_TASK_BYTES};
use crate::{edge_key, Router, RouterExt};

#[near]
impl Router {
    /// Consumer's operator. Holds no money; quotes arrive on it until it is
    /// accepted or times out.
    pub fn post_job(&mut self, spore_id: SporeId, task: String, max_price: U128) -> u64 {
        self.require_operator(spore_id);
        require!(task.len() <= MAX_TASK_BYTES, "task is too long");
        require!(max_price.0 > 0, "max_price must be positive");
        let s = self.spore(spore_id);
        require!(!s.policy.paused, "policy: spore is paused");
        require!(s.posted.len() < MAX_POSTED_JOBS, "too many unfinished jobs");
        let id = self.next_job_id;
        self.next_job_id += 1;
        let now = env::block_timestamp();
        let deadline = now + self.config.job_timeout_ns.0;
        self.spore_mut(spore_id).posted.push(id);
        emit(
            "job_posted",
            json!({ "job_id": id, "consumer": spore_id, "max_price": max_price, "task": task, "deadline_ns": U64(deadline) }),
        );
        self.jobs.insert(
            id,
            Job {
                id,
                consumer: spore_id,
                task,
                max_price,
                status: JobStatus::Open,
                quotes: Vec::new(),
                provider: None,
                price: U128(0),
                result_hash: None,
                posted_ns: U64(now),
                accepted_epoch: 0,
                deadline_ns: U64(deadline),
            },
        );
        id
    }

    /// Provider's operator. Quoting again replaces the earlier quote.
    pub fn quote(&mut self, job_id: u64, spore_id: SporeId, price: U128) {
        self.require_operator(spore_id);
        let provider = self.spore(spore_id);
        require!(!provider.policy.paused, "policy: spore is paused");
        let operator_gen = provider.operator_gen;
        let now = env::block_timestamp();
        let job = self.job_mut(job_id);
        require!(job.status == JobStatus::Open, "job is not open");
        require!(now < job.deadline_ns.0, "job has timed out");
        require!(job.consumer != spore_id, "a spore cannot trade with itself");
        require!(price.0 > 0 && price.0 <= job.max_price.0, "price must be in 1..=max_price");
        let q = Quote { provider: spore_id, price, operator_gen };
        match job.quotes.iter_mut().find(|q| q.provider == spore_id) {
            Some(old) => *old = q,
            None => {
                require!(job.quotes.len() < MAX_QUOTES, "too many quotes on this job");
                job.quotes.push(q);
            }
        }
        emit("job_quoted", json!({ "job_id": job_id, "provider": spore_id, "price": price }));
    }

    /// Consumer's operator. Every owner-policy check happens here, then the
    /// quoted price moves from the consumer's balance into escrow.
    pub fn accept(&mut self, job_id: u64, provider_id: SporeId) {
        let job = self.job(job_id).clone();
        let consumer = job.consumer;
        self.require_operator(consumer);
        require!(job.status == JobStatus::Open, "job is not open");
        let now = env::block_timestamp();
        require!(now < job.deadline_ns.0, "job has timed out");
        let quote = job
            .quotes
            .iter()
            .find(|q| q.provider == provider_id)
            .unwrap_or_else(|| env::panic_str("no quote from that provider"));
        let price = quote.price.0;
        let p = self.spore(provider_id);
        require!(p.active, "provider is not active");
        require!(
            p.operator.is_some() && p.operator_gen == quote.operator_gen,
            "quote is stale: the provider's operator changed"
        );
        require!(!p.policy.paused, "provider is paused");
        self.check_payment(consumer, provider_id, price);

        let epoch = self.epoch;
        self.charge(consumer, price);
        self.escrow += price;
        self.spore_mut(provider_id).serving.push(job_id);
        let deadline = now + self.config.job_timeout_ns.0;
        let job = self.job_mut(job_id);
        job.status = JobStatus::Accepted;
        job.provider = Some(provider_id);
        job.price = U128(price);
        job.quotes.clear();
        job.accepted_epoch = epoch;
        job.deadline_ns = U64(deadline);
        emit(
            "job_accepted",
            json!({ "job_id": job_id, "consumer": consumer, "provider": provider_id, "price": U128(price), "epoch": epoch }),
        );
    }

    /// Provider's operator, before the deadline.
    pub fn deliver(&mut self, job_id: u64, result_hash: String) {
        let job = self.job(job_id);
        require!(job.status == JobStatus::Accepted, "job is not awaiting delivery");
        require!(env::block_timestamp() < job.deadline_ns.0, "job has timed out");
        let provider = job.provider.expect("accepted job has a provider");
        self.require_operator(provider);
        require!(!self.spore(provider).policy.paused, "policy: spore is paused");
        require!(
            !result_hash.is_empty() && result_hash.len() <= MAX_RESULT_BYTES,
            "result_hash must be 1..=128 bytes"
        );
        emit(
            "job_delivered",
            json!({ "job_id": job_id, "provider": provider, "result_hash": result_hash }),
        );
        let job = self.job_mut(job_id);
        job.status = JobStatus::Delivered;
        job.result_hash = Some(result_hash);
    }

    /// Consumer's operator. Pays the provider minus the fee (rounded up) and
    /// records the full price as settled flow on the edge.
    pub fn settle(&mut self, job_id: u64) {
        let job = self.job(job_id).clone();
        require!(job.status == JobStatus::Delivered, "job has not been delivered");
        self.require_operator(job.consumer);
        require!(!self.spore(job.consumer).policy.paused, "policy: spore is paused");
        let provider = job.provider.expect("delivered job has a provider");
        *self.flows.entry(edge_key(job.consumer, provider)).or_default() += job.price.0;
        self.pay_provider(&job, false);
    }

    /// Consumer's operator. Refunds the consumer and counts a rejected
    /// delivery on the edge. Allowed while paused: it only returns money.
    pub fn reject(&mut self, job_id: u64) {
        let job = self.job(job_id).clone();
        require!(job.status == JobStatus::Delivered, "job has not been delivered");
        self.require_operator(job.consumer);
        let provider = job.provider.expect("delivered job has a provider");
        let r = self.rejects.entry(edge_key(job.consumer, provider)).or_default();
        *r = r.saturating_add(1);
        self.refund(&job, "rejected");
    }

    /// Anyone, after the deadline. An open job is dropped and an accepted one
    /// refunded. A delivered one is paid to the provider minus the fee, so a
    /// consumer cannot keep a result for free, but it does not count as flow:
    /// only an explicit settle grows a tube.
    pub fn timeout_job(&mut self, job_id: u64) {
        let job = self.job(job_id).clone();
        require!(env::block_timestamp() >= job.deadline_ns.0, "job has not timed out");
        if job.status == JobStatus::Delivered {
            self.pay_provider(&job, true);
        } else {
            self.refund(&job, "timeout");
        }
    }
}

impl Router {
    pub(crate) fn job(&self, id: u64) -> &Job {
        self.jobs.get(&id).unwrap_or_else(|| env::panic_str("unknown job"))
    }

    fn job_mut(&mut self, id: u64) -> &mut Job {
        self.jobs.get_mut(&id).unwrap_or_else(|| env::panic_str("unknown job"))
    }

    /// Panics with a `policy:` message if the consumer may not pay `price` to `provider`.
    fn check_payment(&self, consumer: SporeId, provider: SporeId, price: u128) {
        let p = &self.spore(consumer).policy;
        require!(!p.paused, "policy: spore is paused");
        require!(
            p.allow_all_spores || p.allowlist.contains(&provider),
            "policy: payee is not on the allowlist"
        );
        self.check_limits(consumer, price);
    }

    /// The payee-independent rules every payment obeys: per-payment cap, epoch
    /// budget (the living allowance), balance.
    pub(crate) fn check_limits(&self, payer: SporeId, amount: u128) {
        let s = self.spore(payer);
        let p = &s.policy;
        require!(amount <= p.max_payment.0, "policy: payment exceeds the per-payment cap");
        require!(
            s.spent_in(self.epoch).saturating_add(amount) <= self.effective_budget(payer),
            "policy: epoch budget exceeded"
        );
        require!(s.balance >= amount, "insufficient balance");
    }

    /// SPEC §7.2: `min(owner budget, base + trust_gain * R / 1000)`, with `R`
    /// from the tubes after the last close, so it drops as tubes decay.
    pub(crate) fn effective_budget(&self, id: SporeId) -> u128 {
        let owner_budget = self.spore(id).policy.budget_per_epoch.0;
        self.config.allowance().effective(owner_budget, self.traits(id).reputation as u128)
    }

    /// Debits `amount` from the payer's balance and counts it against this
    /// epoch's budget. Call only after the checks pass.
    pub(crate) fn charge(&mut self, payer: SporeId, amount: u128) {
        let epoch = self.epoch;
        let s = self.spore_mut(payer);
        if s.spent_epoch != epoch {
            s.spent = 0;
            s.spent_epoch = epoch;
        }
        s.spent += amount;
        s.balance -= amount;
    }

    /// Releases a delivered job's escrow: the fee (rounded up) to the pool and
    /// the rest to the provider. Flow is the caller's business.
    fn pay_provider(&mut self, job: &Job, auto: bool) {
        let provider = job.provider.expect("delivered job has a provider");
        let price = job.price.0;
        let split = split_payment(price, self.config.fee_bps).unwrap_or_else(|e| env::panic_str(&e.to_string()));
        self.escrow -= price;
        self.spore_mut(provider).balance += split.forwarded;
        self.pool += split.fee;
        self.finish_job(job);
        emit(
            "job_settled",
            json!({
                "job_id": job.id, "consumer": job.consumer, "provider": provider,
                "price": U128(price), "fee": U128(split.fee), "epoch": self.epoch, "auto": auto,
            }),
        );
    }

    /// Returns any escrow to the consumer (and gives back the budget it used
    /// this epoch), then deletes the job.
    pub(crate) fn refund(&mut self, job: &Job, reason: &str) {
        let escrowed = if job.status == JobStatus::Open { 0 } else { job.price.0 };
        if escrowed > 0 {
            self.escrow -= escrowed;
            let epoch = self.epoch;
            let s = self.spore_mut(job.consumer);
            s.balance += escrowed;
            if job.accepted_epoch == epoch && s.spent_epoch == epoch {
                s.spent = s.spent.saturating_sub(escrowed);
            }
        }
        self.finish_job(job);
        emit(
            "job_refunded",
            json!({
                "job_id": job.id, "consumer": job.consumer, "provider": job.provider,
                "amount": U128(escrowed), "reason": reason,
            }),
        );
    }

    fn finish_job(&mut self, job: &Job) {
        self.jobs.remove(&job.id);
        self.spore_mut(job.consumer).posted.retain(|&j| j != job.id);
        if let Some(p) = job.provider {
            self.spore_mut(p).serving.retain(|&j| j != job.id);
        }
    }
}
