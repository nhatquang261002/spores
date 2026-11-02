//! Ledger keyed by spore id (SPEC §5.2): anyone deposits, only the owner
//! withdraws, and only to the owner's own account. The admin withdraws the
//! treasury, only to itself.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, Gas, NearToken, Promise};

use crate::types::{emit, SporeId};
use crate::{Router, RouterExt};

const GAS_FOR_ON_WITHDRAW: Gas = Gas::from_tgas(10);

#[near]
impl Router {
    /// Anyone may fund a spore; the attached deposit is credited to its balance.
    #[payable]
    pub fn deposit(&mut self, spore_id: SporeId) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach the amount to deposit");
        let s = self.spore_mut(spore_id);
        s.balance += amount;
        let balance = s.balance;
        self.deposited += amount;
        emit(
            "deposit",
            json!({ "spore_id": spore_id, "from": env::predecessor_account_id(), "amount": U128(amount) }),
        );
        U128(balance)
    }

    /// Owner only, 1 yoctoNEAR. Pays `amount` from the spore's balance to the
    /// owner. There is no recipient argument, so an operator (or anyone else)
    /// cannot withdraw to itself. Refused while listed. If the transfer fails
    /// the balance is restored.
    #[payable]
    pub fn withdraw(&mut self, spore_id: SporeId, amount: U128) -> Promise {
        assert_one_yocto();
        let owner = self.require_owner(spore_id);
        let amount = amount.0;
        require!(amount > 0, "amount must be positive");
        let s = self.spore_mut(spore_id);
        require!(s.listing.is_none(), "a listed spore cannot withdraw; delist it first");
        require!(s.balance >= amount, "insufficient balance");
        s.balance -= amount;
        self.withdrawn += amount;
        emit(
            "withdraw",
            json!({ "spore_id": spore_id, "to": owner, "amount": U128(amount) }),
        );
        Promise::new(owner.clone()).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_WITHDRAW)
                .on_withdraw(spore_id, owner, U128(amount)),
        )
    }

    /// Admin only, 1 yoctoNEAR. Pays `amount` of the treasury (the pool share
    /// not rebated, SPEC §8.3) to the admin. Restored if the transfer fails.
    #[payable]
    pub fn withdraw_treasury(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let admin = env::predecessor_account_id();
        require!(admin == self.admin, "only the admin can withdraw the treasury");
        require!(amount.0 > 0 && amount.0 <= self.treasury, "amount must be in 1..=treasury");
        self.treasury -= amount.0;
        self.withdrawn += amount.0;
        emit("treasury_withdraw", json!({ "to": admin, "amount": amount }));
        Promise::new(admin).transfer(NearToken::from_yoctonear(amount.0)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_WITHDRAW)
                .on_treasury_withdraw(amount),
        )
    }

    #[private]
    pub fn on_treasury_withdraw(&mut self, amount: U128) -> bool {
        if near_sdk::is_promise_success() {
            return true;
        }
        self.treasury += amount.0;
        self.withdrawn -= amount.0;
        emit("treasury_withdraw_failed", json!({ "amount": amount }));
        false
    }

    #[private]
    pub fn on_withdraw(&mut self, spore_id: SporeId, owner_id: AccountId, amount: U128) -> bool {
        if near_sdk::is_promise_success() {
            return true;
        }
        self.spore_mut(spore_id).balance += amount.0;
        self.withdrawn -= amount.0;
        emit(
            "withdraw_failed",
            json!({ "spore_id": spore_id, "to": owner_id, "amount": amount }),
        );
        false
    }
}
