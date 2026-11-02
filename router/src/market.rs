//! Market (SPEC §5.4): the owner lists a spore at a price, anyone buys it by
//! attaching exactly that price. `buy` moves the NFT and runs the §5.3 reset
//! in one call; the seller and royalty transfers are paid from the attached
//! deposit and never touch the spore ledger. A failed payout transfer (a
//! deleted account) is booked to the treasury so the router stays solvent and
//! the ledger stays conserved.
//!
//! NEP-199 (`nft_payout`, `nft_transfer_payout`) reports the same split. With
//! no approvals (NEP-178) only the owner can call `nft_transfer_payout`, so
//! the royalty is enforced by `buy`, not by outside marketplaces.

use std::collections::BTreeMap;

use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, Gas, NearToken, Promise};
use spores_core::market::royalty_split;

use crate::types::{emit, SporeId};
use crate::{Router, RouterExt};

const GAS_FOR_ON_SALE_PAID: Gas = Gas::from_tgas(10);

#[near(serializers=[json])]
pub struct Payout {
    pub payout: BTreeMap<AccountId, U128>,
}

#[near]
impl Router {
    /// Owner only, 1 yoctoNEAR. Lists (or re-prices) the spore. While listed it
    /// cannot `withdraw` or `pause`, so the buyer gets the balance it saw.
    #[payable]
    pub fn list(&mut self, spore_id: SporeId, price: U128) {
        assert_one_yocto();
        let owner = self.require_owner(spore_id);
        require!(price.0 > 0, "price must be positive");
        self.spore_mut(spore_id).listing = Some(price.0);
        emit("spore_listed", json!({ "spore_id": spore_id, "owner_id": owner, "price": price }));
    }

    /// Owner only, 1 yoctoNEAR.
    #[payable]
    pub fn delist(&mut self, spore_id: SporeId) {
        assert_one_yocto();
        let owner = self.require_owner(spore_id);
        let s = self.spore_mut(spore_id);
        require!(s.listing.is_some(), "spore is not listed");
        s.listing = None;
        emit("spore_delisted", json!({ "spore_id": spore_id, "owner_id": owner }));
    }

    /// Anyone but the owner, attaching exactly the listed price. Transfers the
    /// spore, clears its operator, locks its policy and refunds its jobs in
    /// flight (SPEC §5.3), then pays the seller `price - royalty` and the
    /// royalty account `price * royalty_bps / 10000` (rounded down). The two
    /// payouts are detached promises: NEAR does not let a method return a
    /// joint promise (`a.and(b)`), and the mocked test runtime does not catch it.
    #[payable]
    pub fn buy(&mut self, spore_id: SporeId) {
        let buyer = env::predecessor_account_id();
        let seller = self.owner_of(spore_id);
        require!(buyer != seller, "the owner cannot buy its own spore");
        let price = self.spore(spore_id).listing.unwrap_or_else(|| env::panic_str("spore is not listed"));
        require!(
            env::attached_deposit().as_yoctonear() == price,
            "attach exactly the listed price"
        );
        let (to_seller, royalty) =
            royalty_split(price, self.config.royalty_bps).unwrap_or_else(|| env::panic_str("bad royalty_bps"));
        let royalty_account = self.royalty_account();

        self.tokens.internal_transfer(&seller, &buyer, &spore_id.to_string(), None, Some("sale".to_string()));
        let s = self.spore_mut(spore_id);
        s.transfers += 1;
        s.sales += 1;
        self.reset_control(spore_id, &seller, &buyer, "sale");
        emit(
            "spore_sold",
            json!({
                "spore_id": spore_id, "seller": seller, "buyer": buyer, "price": U128(price),
                "seller_amount": U128(to_seller), "royalty": U128(royalty), "royalty_account": royalty_account,
            }),
        );

        let pay = |to: &AccountId, amount: u128, role: &str| {
            Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_SALE_PAID)
                    .on_sale_paid(spore_id, to.clone(), U128(amount), role.to_string()),
            )
        };
        pay(&seller, to_seller, "seller").detach();
        if royalty > 0 {
            pay(&royalty_account, royalty, "royalty").detach();
        }
    }

    /// A payout transfer that failed (the account was deleted) leaves the money
    /// on the router; it goes to the treasury so the ledger accounts for it.
    #[private]
    pub fn on_sale_paid(&mut self, spore_id: SporeId, to: AccountId, amount: U128, role: String) -> bool {
        if near_sdk::is_promise_success() {
            return true;
        }
        self.treasury += amount.0;
        self.deposited += amount.0;
        emit(
            "sale_payment_failed",
            json!({ "spore_id": spore_id, "to": to, "amount": amount, "role": role }),
        );
        false
    }

    /// NEP-199: how a sale of `token_id` for `balance` is split between the
    /// owner and the royalty account. Sums exactly to `balance`.
    pub fn nft_payout(&self, token_id: String, balance: U128, max_len_payout: Option<u32>) -> Payout {
        let id: SporeId = token_id.parse().unwrap_or_else(|_| env::panic_str("unknown spore"));
        let owner = self.owner_of(id);
        let (to_owner, royalty) =
            royalty_split(balance.0, self.config.royalty_bps).unwrap_or_else(|| env::panic_str("bad royalty_bps"));
        let mut payout: BTreeMap<AccountId, u128> = BTreeMap::new();
        *payout.entry(owner).or_default() += to_owner;
        if royalty > 0 {
            *payout.entry(self.royalty_account()).or_default() += royalty;
        }
        if let Some(max) = max_len_payout {
            require!(payout.len() as u32 <= max, "payout is longer than max_len_payout");
        }
        Payout { payout: payout.into_iter().map(|(a, v)| (a, U128(v))).collect() }
    }

    /// NEP-199. Owner only (no approvals), 1 yoctoNEAR: transfers like
    /// `nft_transfer` (with the §5.3 reset) and returns the payout split.
    #[payable]
    pub fn nft_transfer_payout(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        balance: U128,
        max_len_payout: Option<u32>,
    ) -> Payout {
        assert_one_yocto();
        let payout = self.nft_payout(token_id.clone(), balance, max_len_payout);
        self.nft_transfer(receiver_id, token_id, approval_id, memo);
        payout
    }

    /// Spores listed for sale: `(spore_id, price)` ascending by id.
    pub fn listings(&self) -> Vec<(SporeId, U128)> {
        self.spores
            .iter()
            .enumerate()
            .filter_map(|(id, s)| s.listing.map(|p| (id as SporeId, U128(p))))
            .collect()
    }
}

impl Router {
    pub(crate) fn royalty_account(&self) -> AccountId {
        self.config.royalty_account.clone().unwrap_or_else(|| self.admin.clone())
    }
}
