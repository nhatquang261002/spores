//! Paying a service outside the collection (SPEC §6.4 option 2, §7.1): the
//! operator pays an account the owner put on `external_allowlist`, within the
//! same per-payment cap and epoch budget as a job. The `service_paid` event is
//! the receipt the service checks before it delivers; `memo` carries the
//! service's nonce. No fee and no flow: the payee is not part of the graph.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

use crate::types::{emit, SporeId, MAX_MEMO_BYTES};
use crate::{Router, RouterExt};

const GAS_FOR_ON_SERVICE_PAID: Gas = Gas::from_tgas(10);

#[near]
impl Router {
    /// Spore's operator. Pays `amount` from the spore's balance to `payee`.
    /// If the transfer fails the balance and budget are restored.
    pub fn pay_service(&mut self, spore_id: SporeId, payee: AccountId, amount: U128, memo: String) -> Promise {
        self.require_operator(spore_id);
        let amount = amount.0;
        require!(amount > 0, "amount must be positive");
        require!(memo.len() <= MAX_MEMO_BYTES, "memo too long");
        let p = &self.spore(spore_id).policy;
        require!(!p.paused, "policy: spore is paused");
        require!(
            p.external_allowlist.contains(&payee),
            "policy: payee is not on the external allowlist"
        );
        self.check_limits(spore_id, amount);
        self.charge(spore_id, amount);
        self.paid_out += amount;
        let epoch = self.epoch;
        emit(
            "service_paid",
            json!({ "spore_id": spore_id, "payee": payee, "amount": U128(amount), "memo": memo, "epoch": epoch }),
        );
        Promise::new(payee.clone()).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_SERVICE_PAID)
                .on_service_paid(spore_id, payee, U128(amount), epoch),
        )
    }

    #[private]
    pub fn on_service_paid(&mut self, spore_id: SporeId, payee: AccountId, amount: U128, epoch: u64) -> bool {
        if near_sdk::is_promise_success() {
            return true;
        }
        let current = self.epoch;
        let s = self.spore_mut(spore_id);
        s.balance += amount.0;
        if epoch == current && s.spent_epoch == current {
            s.spent = s.spent.saturating_sub(amount.0);
        }
        self.paid_out -= amount.0;
        emit(
            "service_payment_failed",
            json!({ "spore_id": spore_id, "payee": payee, "amount": amount }),
        );
        false
    }
}
