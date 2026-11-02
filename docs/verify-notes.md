# VERIFY notes (Phase 0)

Checked 2026-10-29 against the live docs, crates.io/npm and read-only testnet RPC. One line of evidence per item. Re-check versions on 2026-11-01 before scaffolding; anything marked **open** is still unverified.

## Rules

| Item | Answer | Evidence |
| --- | --- | --- |
| HACKATHON.md | 2026-10-29: live copy was byte-identical to the local one (15915 bytes). **Stale as of 2026-10-31:** the local copy is 18999 bytes and the live copy is 19923 bytes. Live adds a Telegram row, a NEAR Builders partner row and "Partner notes" (Rhea; Agent Market: list your agent so it can earn). Re-diff before submitting | `curl https://nearhackathon.com/HACKATHON.md` + `diff` against the local file |
| Pre-window code (SPEC §14, §16.8) | Allowed from the 2026-10-19 announcement; earlier commits are baseline. Disclose in README. Separate baseline from window work with a `pre-hackathon` tag or branch (Q-003) | HACKATHON.md Q-001: "Yes, from the announcement on 2026-10-19 ... Earlier commits are baseline."; Q-003: "tags pre-hackathon and hackathon-submission, plus a README section linking the diff" |
| Testnet eligibility | Testnet-only is eligible for all tracks | HACKATHON.md Q-010 |

The Discord question in SPEC §14 is answered by Q-001 in the published rules; asking in Discord is now optional.

## Contract toolchain (SPEC §4)

| Item | Answer | Evidence |
| --- | --- | --- |
| Rust SDK | `near-sdk` 5.30.0 (2026-10-27); `near-contract-standards` 5.30.0 | crates.io API `max_stable_version: 5.30.0` |
| Build tool | `cargo-near` 0.22.0 (0.23.0-rc.2 is pre-release). `cargo near build non-reproducible-wasm` for dev, `reproducible-wasm` (Docker, committed `Cargo.lock`) for release | near-sdk-rs README: "`cargo-near` is an easy and recommended way to build and deploy Rust contracts" |
| Rust toolchain | MSRV 1.95.0, target `wasm32-unknown-unknown`. Quickstart says "tested with 1.86.0": conflict, use >= 1.95 and test a build early. **2026-10-31:** a rustc 1.97.1 build via cargo-near 0.22.0 deploys and runs on testnet | near-sdk-rs README: "Minimum supported Rust version (MSRV) is 1.95.0" |
| Scaffold | `cargo near new <name>`; deploy with `near deploy <acct> ./target/near/<name>.wasm` | https://docs.near.org/smart-contracts/quickstart |

## Spore NFTs and market (SPEC §5.1, §5.3, §5.4)

| Item | Answer | Evidence |
| --- | --- | --- |
| NEP-171 methods | `nft_transfer(receiver_id, token_id, approval_id, memo)`, `nft_transfer_call(..., msg)`, `nft_token(token_id)`, `nft_resolve_transfer(owner_id, receiver_id, token_id, approved_account_ids)`; receiver implements `nft_on_transfer` | https://github.com/near/NEPs/blob/master/neps/nep-0171.md |
| NEP-171 deposit | Both transfer methods require exactly 1 yoctoNEAR | NEP-171: "Caller of the method must attach a deposit of 1 yoctoⓃ for security purposes" |
| NEP-171 events | `EVENT_JSON:{"standard":"nep171","version":"1.2.0","event":"nft_mint"\|"nft_transfer"\|...}` | NEP-171 events section |
| Custom transfer logic | Use `near-contract-standards::NonFungibleToken`, hand-write `impl NonFungibleTokenCore` and wrap `self.tokens.nft_transfer(...)` with the §5.3 transfer semantics. Resolved 2026-10-31: `internal_transfer` emits `nft_transfer` (near-contract-standards 5.30.0 `core_impl.rs`); `internal_mint` charges the attached deposit for storage, so the router uses `internal_mint_with_refund(.., None)` and emits `nft_mint` itself | near-sdk-rs `examples/non-fungible-token/nft/src/lib.rs` |
| NEP-177 metadata | `media`, `media_hash` (base64 sha256, required with `media`), `reference`, `reference_hash`, `extra` (string, may be JSON) | https://github.com/near/NEPs/blob/master/neps/nep-0177.md |
| NEP-181 enumeration | `nft_total_supply`, `nft_tokens`, `nft_supply_for_owner`, `nft_tokens_for_owner` | https://github.com/near/NEPs/blob/master/neps/nep-0181.md |
| NEP-199 payouts | `nft_payout(token_id, balance, max_len_payout)` and `nft_transfer_payout(receiver_id, token_id, approval_id, memo, balance, max_len_payout)` return `{payout: {account: U128}}`. Not in `near-contract-standards`: implement ourselves. Marketplaces are the intended callers but not obliged to call it | NEP-199 (Final): payout "MUST be no longer than ... `max_len_payout`" |
| Marketplace display of `media` | Not documented. Paras prepends `base_uri` to `media`, so a `data:` SVG in `media` breaks if `base_uri` is set. Leave `base_uri` unset if `media` is ever a data URI. **Open** | https://docs.paras.id/nft-metadata |
| Randomness for seed | `env::random_seed_array() -> [u8; 32]`, block VRF-based, same value for the whole block. The block producer can predict it and skip blocks. That is acceptable for an art seed with no money at stake; say so in the README | https://docs.near.org/smart-contracts/security/random: "Only the validator mining the transaction can predict" |

## Gas and storage (SPEC §5.1, §5.5)

| Item | Answer | Evidence |
| --- | --- | --- |
| Prepaid gas per transaction | 1 PGas (1000 TGas) since protocol 83. Some docs pages still say 300 TGas (stale) | https://docs.near.org/protocol/transactions/gas; live testnet `EXPERIMENTAL_protocol_config`: `max_total_prepaid_gas = 1000000000000000`, protocol 88 |
| View-call gas | Per-node setting (`max_gas_burnt_view`, RPC-only override). Public provider values are not documented. **Open:** measure glyph view gas on the RPC we use | nearcore `client_config.rs`: "The value only affects the RPCs." |
| Storage price | 1e19 yocto per byte (100 kB per NEAR) | docs storage-staking page; live testnet `storage_amount_per_byte = 10000000000000000000` |
| 64-spore storage | **Measured 2026-10-31:** 565 bytes per spore (36,202 bytes for 64, 0.36 NEAR); contract code 437 KB = 4.38 NEAR (`docs/phase3-results.md`). Was: **Open.** Measure with `env::storage_usage()` before and after `mint_genesis`. Risk to design for: per-epoch state hashes for all 64 spores are 2 kB/epoch, so 1000 demo epochs come to about 20 NEAR. Store hashes for active spores only, or keep a rolling window | storage-staking page recommends measuring with `env::storage_usage()` |

## Policy and keys (SPEC §5.3, §5.6, §7.1)

| Item | Answer | Evidence |
| --- | --- | --- |
| Function-call keys | One receiver contract, optional method list (empty = any method), allowance pays gas only. **Cannot attach any deposit, not even 1 yocto.** When the allowance runs out the key is unusable and must be replaced. Method names: at most 256 bytes each, 2000 bytes in total | https://docs.near.org/protocol/access-keys: "do not allow to attach NEAR tokens"; nomicon RuntimeSpec/Actions |
| Testnet check (2026-10-31) | A function-call key calling a method outside its list is rejected before inclusion with `InvalidAccessKeyError.MethodNameMismatch`; attaching 1 yocto gives `InvalidAccessKeyError.DepositWithFunctionCall` (`docs/phase3-testnet-run.txt`) | |
| Design impact | Agent payments must be ledger moves inside the router with no attached deposit; this already matches §5.2. NFT transfer, `buy` and `deposit` need a full-access (owner) key. The router cannot delete keys on the operator's account, so "old operator key stops working" is enforced by clearing the registered operator id, not by key deletion. Make sure the §5.3 "key generation counter" means exactly that | as above |
| Contract-controlled sub-accounts (§5.6) | A contract can add or delete keys on a new sub-account only in the same batch that starts with `CreateAccount`; after that it has no control unless it deployed a contract there exposing key methods. Account creation costs 0.007 NEAR plus storage. **The spike would need a proxy contract per spore.** Expect no-go unless it is cheap | nomicon RuntimeSpec/Actions: AddKey/DeleteKey require `predecessor_id == receiver_id` unless the first action is `CreateAccount`; docs anatomy/actions: "Accounts do NOT have control over their sub-accounts" |
| Update 2026-10-31 (Phase 2) | Global contracts make the per-spore proxy cheap (publisher burns 10 NEAR per 100 kB once; a referencing account pays under 0.001 NEAR; `near-sdk` has `Promise::use_global_contract`). Cost was not the blocker. **No-go** on other grounds (no custody gain, no atomic `buy`). Contract-initiated `UseGlobalContract` in a `CreateAccount` batch is **unverified** | https://docs.near.org/smart-contracts/global-contracts; https://docs.rs/near-sdk/latest/near_sdk/struct.Promise.html; `docs/phase2-results.md` |
| Contract key API | `Promise::create_account`, `add_full_access_key`, `add_access_key_allowance(pk, allowance, receiver, "m1,m2")`, `delete_key` (`add_access_key` deprecated) | https://docs.rs/near-sdk/latest/near_sdk/struct.Promise.html |

## Off-chain tooling (SPEC §6)

| Item | Answer | Evidence |
| --- | --- | --- |
| CLI | near-cli-rs (`near`) 0.30.1. JS `near-cli` was archived 2024-10-04. Install: `brew install near` or `npm i -g near-cli-rs@latest` | https://github.com/near/near-cli-rs/releases; https://github.com/near/near-cli |
| Create a testnet account | `near account create-account sponsor-by-faucet-service <id>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create` | https://docs.near.org/tools/near-cli |
| Export a key to env | `near account export-account <id> using-private-key network-config testnet` | near-cli-rs GUIDE.en.md |
| Testnet RPC | Use `https://test.rpc.fastnear.com` (FastNEAR). `rpc.testnet.near.org` is deprecated and rate-limited (30 req/min) | https://docs.near.org/api/rpc/providers; near.org blog 2025-05-19 deprecation post |
| Agent client library | TS: `near-api-js` 7.4.0 (single package, replaces `@near-js/*`) or `near-kit` 0.20.2; the docs list both. Python: `py-near` 1.2.22 | https://docs.near.org/tools/near-api |
| Outside service (§6.4) | NEAR AI Cloud bills by account, prepaid credits and API key; no per-call on-chain payment. No listed partner found that takes per-call on-chain payment, so option 2 applies: run our own service gated by `is_operator` | https://docs.near.ai/cloud/quickstart |

## Local machine (2026-10-29)

Not installed: `rustc`, `cargo`, `cargo-near`, `near`. Installed: node 26.7.0, npm 11.19.0, uv 0.12.16, system python3 3.9.6 (no numpy; `slime.py` needs numpy and Pillow, use `uv`).

## Repo layout (decided)

```
core/       Rust crate, no near-sdk: graph update, isqrt, fee split, pool split, canonical string, fingerprint
router/     NEAR contract (near-sdk), depends on core
renderer/   Rust crate, fixed-point Physarum; native + wasm32 build used by viz and verify
vectors/    shared JSON test vectors (core and renderer)
sim/        economy simulation; links core so its bytes match the contract by construction
agents/     TypeScript, one process per active spore (near-api-js)
outside/    TypeScript paid service gated by is_operator
viz/        web page, renderer via wasm
verify/     fingerprint replay and image regeneration (Rust CLI on core + renderer)
docs/       these notes and decision records
```

`slime.py` and `slime_example.png` stay at the root as the disclosed pre-hackathon prototype. Directories are created when their first file lands (git does not track empty directories).

## Still open

- Testnet accounts: created 2026-10-29. Parent `spores-hack.testnet` via the faucet (10 NEAR; the third try succeeded after two 429s, tx 2DsXEerXKhmaRXtiXbjm8vVW3YvQa4TK3gBnvs238EFH). Sub-accounts funded from the parent and confirmed by RPC `view_account`: `deployer.spores-hack.testnet` 3 NEAR, `owner.spores-hack.testnet` 2, `operator.spores-hack.testnet` 1, `buyer.spores-hack.testnet` 2. Parent keeps about 2 NEAR. Keys are in the git-ignored `.env` (mode 600) as `<ROLE>_ACCOUNT_ID` / `<ROLE>_PRIVATE_KEY`, and also in the macOS keychain. Note the operator key is full-access for now; Phase 3 should replace it with a function-call key limited to the router.
- Items marked **Open** above. Each one is resolved by a measurement in Phases 2-3.
