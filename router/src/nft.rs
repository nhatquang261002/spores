//! Spore NFTs: NEP-171 core, NEP-177 metadata and NEP-181 enumeration, with
//! the transfer semantics of SPEC §5.3 run inside every transfer.
//!
//! No approvals (NEP-178): only the owner can move a spore, so every path that
//! changes the owner goes through `nft_transfer`, `nft_transfer_call` or the
//! revert in `nft_resolve_transfer`, and each one resets control.

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::core::{
    ext_nft_receiver, ext_nft_resolver, NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{Token, TokenId};
use near_sdk::json_types::{Base64VecU8, U128};
use sha2::{Digest, Sha256};
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, AccountId, Gas, PromiseOrValue};

use crate::art::ImageCommitView;
use crate::types::{emit, hex, Policy, SporeId};
use crate::{Router, RouterExt};

/// The resolver may have to refund jobs again after a reverted transfer.
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(30);

fn parse_id(token_id: &str) -> SporeId {
    token_id.parse().unwrap_or_else(|_| env::panic_str("unknown spore"))
}

#[near]
impl NonFungibleTokenCore for Router {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        let id = parse_id(&token_id);
        let sender = env::predecessor_account_id();
        let (old_owner, _) = self.tokens.internal_transfer(&sender, &receiver_id, &token_id, approval_id, memo);
        self.spore_mut(id).transfers += 1;
        self.reset_control(id, &old_owner, &receiver_id, "transfer");
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        assert_one_yocto();
        let id = parse_id(&token_id);
        let sender = env::predecessor_account_id();
        let (old_owner, old_approvals) =
            self.tokens.internal_transfer(&sender, &receiver_id, &token_id, approval_id, memo);
        self.spore_mut(id).transfers += 1;
        self.reset_control(id, &old_owner, &receiver_id, "transfer");
        ext_nft_receiver::ext(receiver_id.clone())
            .with_unused_gas_weight(1)
            .nft_on_transfer(sender, old_owner.clone(), token_id.clone(), msg)
            .then(
                ext_nft_resolver::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .with_unused_gas_weight(0)
                    .nft_resolve_transfer(old_owner, receiver_id, token_id, old_approvals),
            )
            .into()
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        let id: SporeId = token_id.parse().ok()?;
        Some(Token { token_id, owner_id, metadata: Some(self.token_metadata(id)), approved_account_ids: None })
    }
}

#[near]
impl NonFungibleTokenResolver for Router {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let transferred = self.tokens.nft_resolve_transfer(
            previous_owner_id.clone(),
            receiver_id.clone(),
            token_id.clone(),
            approved_account_ids,
        );
        if !transferred {
            // The receiver owned the spore while `nft_on_transfer` ran and could
            // have registered an operator or set a policy. Clear them again.
            let id = parse_id(&token_id);
            self.spore_mut(id).transfers -= 1;
            self.reset_control(id, &receiver_id, &previous_owner_id, "transfer_reverted");
        }
        transferred
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Router {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Spores".to_string(),
            symbol: "SPORE".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}

#[near]
impl NonFungibleTokenEnumeration for Router {
    fn nft_total_supply(&self) -> U128 {
        U128(self.spores.len() as u128)
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let start = from_index.map_or(0, |i| i.0).min(self.spores.len() as u128) as u32;
        (start..self.spores.len())
            .take(limit.unwrap_or(u64::MAX).min(u32::MAX as u64) as usize)
            .filter_map(|id| self.nft_token(id.to_string()))
            .collect()
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.ids_of(&account_id).len() as u128)
    }

    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.ids_of(&account_id)
            .into_iter()
            .skip(from_index.map_or(0, |i| i.0).min(usize::MAX as u128) as usize)
            .take(limit.unwrap_or(u64::MAX).min(usize::MAX as u64) as usize)
            .filter_map(|id| self.nft_token(id.to_string()))
            .collect()
    }
}

impl Router {
    /// SPEC §5.3: clear the operator (bumping its generation, which voids its
    /// quotes), reset policy to paused with zero budget, drop any listing and
    /// refund every job in flight to its payer. Balance, tubes, age and history
    /// stay with the spore.
    pub(crate) fn reset_control(&mut self, id: SporeId, from: &AccountId, to: &AccountId, reason: &str) {
        let s = self.spore_mut(id);
        s.listing = None;
        s.operator = None;
        s.operator_gen += 1;
        s.policy = Policy::locked();
        let in_flight: Vec<u64> = s.posted.iter().chain(&s.serving).copied().collect();
        let operator_gen = s.operator_gen;
        for job_id in &in_flight {
            if let Some(job) = self.jobs.get(job_id).cloned() {
                self.refund(&job, reason);
            }
        }
        emit(
            "control_reset",
            json!({
                "spore_id": id, "from": from, "to": to, "reason": reason,
                "operator_gen": operator_gen, "refunded_jobs": in_flight,
            }),
        );
    }

    fn ids_of(&self, account_id: &AccountId) -> Vec<SporeId> {
        let Some(set) = self.tokens.tokens_per_owner.as_ref().and_then(|m| m.get(account_id)) else {
            return Vec::new();
        };
        let mut ids: Vec<SporeId> = set.iter().filter_map(|t| t.parse().ok()).collect();
        ids.sort_unstable();
        ids
    }

    /// NEP-177 metadata built from state on every read. `media` is the
    /// on-chain glyph as a `data:` URI (no `base_uri`, so marketplaces that
    /// prepend it leave it alone) with its sha256 as `media_hash`. The
    /// committed Physarum render's hash is in `extra`.
    fn token_metadata(&self, id: SporeId) -> TokenMetadata {
        let t = self.traits(id);
        let s = self.spore(id);
        let svg = self.glyph_svg(id);
        let media_hash: [u8; 32] = Sha256::digest(svg.as_bytes()).into();
        let extra = json!({
            "seed": hex(&s.seed),
            "active": t.active,
            "age": t.age,
            "degree": t.degree,
            "reputation": t.reputation,
            "transfers": s.transfers,
            "sales": s.sales,
            "listed_price": s.listing.map(U128),
            "state_hash": s.state.map(|(_, h)| hex(&h)),
            "image": s.image.as_ref().map(ImageCommitView::from),
        });
        TokenMetadata {
            title: Some(format!("Spore #{id}")),
            description: Some("A slime mold whose tubes are its settled trades on the Spores router.".to_string()),
            media: Some(format!("data:image/svg+xml;utf8,{svg}")),
            media_hash: Some(Base64VecU8::from(media_hash.to_vec())),
            copies: Some(1),
            extra: Some(extra.to_string()),
            ..Default::default()
        }
    }
}
