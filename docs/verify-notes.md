# NEAR docs checks

Every NEAR API, version and limit this project relies on was checked against the live docs, crates.io/npm or read-only testnet RPC before it was used, not taken from memory. One line of evidence per item, dated. What the design does because of them: [how-it-works.md §11](how-it-works.md#11-near-facts-checked-against-the-docs). Items marked **open** were never settled.

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
| 64-spore storage | **Measured 2026-10-31:** 565 bytes per spore (36,202 bytes for 64, 0.36 NEAR); contract code 437 KB = 4.38 NEAR at the time. Was: **Open.** Measure with `env::storage_usage()` before and after `mint_genesis`. Risk to design for: per-epoch state hashes for all 64 spores are 2 kB/epoch, so 1000 demo epochs come to about 20 NEAR. Store hashes for active spores only, or keep a rolling window | storage-staking page recommends measuring with `env::storage_usage()` |

## Policy and keys (SPEC §5.3, §5.6, §7.1)

| Item | Answer | Evidence |
| --- | --- | --- |
| Function-call keys | One receiver contract, optional method list (empty = any method), allowance pays gas only. **Cannot attach any deposit, not even 1 yocto.** When the allowance runs out the key is unusable and must be replaced. Method names: at most 256 bytes each, 2000 bytes in total | https://docs.near.org/protocol/access-keys: "do not allow to attach NEAR tokens"; nomicon RuntimeSpec/Actions |
| Testnet check (2026-10-31) | A function-call key calling a method outside its list is rejected before inclusion with `InvalidAccessKeyError.MethodNameMismatch`; attaching 1 yocto gives `InvalidAccessKeyError.DepositWithFunctionCall` ([how-it-works.md §8.2](how-it-works.md#82-contract-on-testnet-83-of-83-router2-2026-10-31)) | |
| Design impact | Agent payments must be ledger moves inside the router with no attached deposit; this already matches §5.2. NFT transfer, `buy` and `deposit` need a full-access (owner) key. The router cannot delete keys on the operator's account, so "old operator key stops working" is enforced by clearing the registered operator id, not by key deletion. Make sure the §5.3 "key generation counter" means exactly that | as above |
| Contract-controlled sub-accounts (§5.6) | A contract can add or delete keys on a new sub-account only in the same batch that starts with `CreateAccount`; after that it has no control unless it deployed a contract there exposing key methods. Account creation costs 0.007 NEAR plus storage. **The spike would need a proxy contract per spore.** Expect no-go unless it is cheap | nomicon RuntimeSpec/Actions: AddKey/DeleteKey require `predecessor_id == receiver_id` unless the first action is `CreateAccount`; docs anatomy/actions: "Accounts do NOT have control over their sub-accounts" |
| Update 2026-10-31 (Phase 2) | Global contracts make the per-spore proxy cheap (publisher burns 10 NEAR per 100 kB once; a referencing account pays under 0.001 NEAR; `near-sdk` has `Promise::use_global_contract`). Cost was not the blocker. **No-go** on other grounds (no custody gain, no atomic `buy`). Contract-initiated `UseGlobalContract` in a `CreateAccount` batch is **unverified** | https://docs.near.org/smart-contracts/global-contracts; https://docs.rs/near-sdk/latest/near_sdk/struct.Promise.html; [how-it-works.md §3](how-it-works.md#why-one-ledger-not-an-account-per-spore) |
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

## Phase 6 (checked 2026-11-03)

Re-read from live testnet before growing to 64 active spores. All values are unchanged since Phase 5.

| Item | Answer | Evidence |
| --- | --- | --- |
| Log length per receipt | 16,384 bytes of log text in total, across all logs of one receipt. Splitting `epoch_closed` into several logs in the same receipt therefore does not help | `EXPERIMENTAL_protocol_config` (protocol 88, `https://rpc.testnet.near.org`, 2026-11-03): `limit_config.max_total_log_length = 16384`; field meaning: https://docs.rs/near-parameters/latest/near_parameters/vm/struct.LimitConfig.html |
| Logs per receipt | 100 | same call: `limit_config.max_number_logs = 100` |
| Gas per transaction | 1 PGas prepaid and burnt (`max_total_prepaid_gas` = `max_gas_burnt` = 1e15); 100 actions per receipt | same call: `max_total_prepaid_gas = 1000000000000000`, `max_gas_burnt = 1000000000000000`, `max_actions_per_receipt = 100` |
| View-call gas | Still **open**: a per-node RPC setting, not part of the protocol config. Unset, the node uses its genesis value. Not published by FastNEAR or dRPC | https://github.com/near/nearcore/blob/master/core/chain-configs/src/client_config.rs (`max_gas_burnt_view`: "only affects the RPCs") |
| Storage price | 1e19 yocto per byte (100 kB per NEAR) | same call: `storage_amount_per_byte = 10000000000000000000`; https://docs.near.org/protocol/storage/storage-staking ("1E19 yoctoNEAR per byte") |
| `epoch_closed` at 64 active | **Does not fit in the worst case.** Router test `epoch_closed_log_size_at_64_active` (flows up to 9.99 NEAR per edge per epoch): the sim's peak at 64 active (292 tubes, 149 flow edges, 103 reject edges) is 14,015 bytes; every pair a tube, flow and reject is 129,695 bytes. Ceilings: 889 tubes with no flows, 352 tubes in the sim's mix. The largest `max_active` whose worst case fits is 22. A close whose event is over the limit fails, so the router could not close again until its code changes | `cargo test -p spores-router epoch_closed_log_size -- --nocapture` |

## Phase 6 S8: wallet (checked 2026-11-04)

| Item | Answer | Evidence |
| --- | --- | --- |
| Recommended package | NEAR's current docs use **`@hot-labs/near-connect`** (`new NearConnector({ network: "testnet" })`, `connector.connect()`, `connector.wallet()`, `wallet.signAndSendTransaction({ receiverId, actions })`), not `@near-wallet-selector/*`. `@near-wallet-selector/core` is at 10.1.4 (last published 2025-12-04); near-connect at **0.12.0** (2026-10-26), MIT, no runtime dependencies (the `@near-js/*` imports in its `.d.ts` are types only) | https://docs.near.org/web3-apps/tutorials/wallet-login; `npm view @hot-labs/near-connect`, `npm view @near-wallet-selector/core` (2026-11-04); `build/NearConnector.d.ts`, `build/types/index.d.ts` in the 0.12.0 tarball |
| API used | `NearConnector({ network, features, autoConnect, footerBranding })`, `connect(): Promise<NearWalletBase>`, `disconnect()`, `getConnectedWallet(): {wallet, accounts}`, `wallet(): Promise<NearWalletBase>`, `NearWalletBase.getAccounts({network})`, `signAndSendTransaction({network?, signerId?, receiverId, actions}): Promise<FinalExecutionOutcome>`. Actions accept the wallet-selector shape `{type:"FunctionCall", params:{methodName, args, gas, deposit}}` (gas and deposit as strings). The app still reads the final outcome itself with `tx` (`wait_until: FINAL`) | the 0.12.0 type declarations (above) |
| Wallets with testnet | Wallets come from a remote manifest (`https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json`, version 1.1.0 on 2026-11-04), filtered by `features: { testnet: true, signAndSendTransaction: true }`. `testnet: true`: Meteor, Intear, Ledger, Nightly, WalletConnect (needs a project id, so it is dropped), Unity, Ethereum Wallets, NEAR CLI. Not marked for testnet: HOT, MyNearWallet, OKX, Trezu, Hana; NEAR Mobile is `testnet: false`. The picker in Chrome (router4 app, 2026-11-04) listed Meteor, Intear, Ledger, Nightly, Ethereum Wallets and NEAR CLI | manifest fetched with curl; Chrome check in the S8 session log |
| Closing the picker | `connect()` rejects with `User rejected`; the app treats it as no error | Chrome, 2026-11-04 |

## Phase 6 S10: old transactions from a browser (checked 2026-11-05)

Provider list: https://docs.near.org/api/rpc/providers. One old close tx (epoch 3 of router4) asked of each endpoint with `wait_until: FINAL`.

| Endpoint | In the docs' testnet table | What it did |
| --- | --- | --- |
| `archival-rpc.testnet.near.org` | Public, archival, "Severely rate limited" | About 4.5 s per tx at first, then HTTP 429: `WARNING! THIS ENDPOINT IS DEPRECATED! STOP USING IT NOW! Switch to https://fastnear.com or alternative RPC providers`. The docs page says nothing about a deprecation |
| `archival-rpc.testnet.fastnear.com` | **Not listed.** The table's FastNEAR row is `test.rpc.fastnear.com`, archival "Paid Only" | 1.2 s, no key, `access-control-allow-origin: *`. Limits later: `Rate limits exceeded. For higher rate limits get a subscription` |
| `test.rpc.fastnear.com` | Public, archival "Paid Only" | `TIMEOUT_ERROR` after 10–30 s |
| `near-testnet.drpc.org` | Public, not archival | About 2.3 s: `Request timeout on the free plan` |
| `rpc.testnet.near.org` | Not listed | HTTP 408 `TIMEOUT_ERROR` after 14 s |
| `near-testnet.lava.build` | Not listed (Lava has no public testnet URL there) | HTTP 410 `This endpoint has been discontinued` |

- Both archival nodes send their 429 without `access-control-allow-origin` (Chrome: "blocked by CORS policy"), so `fetch` rejects with `Failed to fetch` and the page can't read the status. The app says "unreachable or rate-limited" for this.
- The app uses FastNEAR's archival, then near.org's (`ARCHIVAL_RPCS`). The FastNEAR URL was found by trying it, not from the docs, and "Paid Only" may come to apply: treat it as working today, not as promised.
- The app and, since the follow-up below, `spores-verify` send only close `tx` reads there first; views stay on the regular nodes. Before that, `spores-verify` with `NEAR_RPCS` set to an archival node sent its views there too, which is how it reached the limit after 25 txs and 8 views.
- Decision (2026-11-05): keep using FastNEAR's archival node, and change the CLI's defaults to match the app.
- CLI follow-up, measured the same day against router4 with no `NEAR_RPCS`: README `epochs` over 16 closes 21 s, `image` 17 s; all 25 closes 22 s and 77 s, `image --spore 5` over 25 in 79 s, all exit 0 and `match`. With the `NEAR_RPCS` of `scripts/phase6-testnet.sh`, which used to leave no archival node at all: 25 closes in 66 s, exit 0. Archival unreachable (`NEAR_ARCHIVAL_RPCS=http://127.0.0.1:9`): exit 2 after 71 s, naming all three endpoints.
- The docs ask not to load-test shared endpoints. Each Verify run is one request per close plus one view per epoch, at most 2 and 3 at a time.

## Phase 5 (checked 2026-11-02)

| Item | Answer | Evidence |
| --- | --- | --- |
| NEP-199 payouts | `nft_payout(token_id, balance, max_len_payout: Option<u32>) -> {payout: {account: U128}}` and `nft_transfer_payout(receiver_id, token_id, approval_id: Option<u64>, memo, balance, max_len_payout)`. The payout "MUST be no longer than" `max_len_payout`, the balances "MUST add up to less than or equal to" `balance`, and financial contracts "MUST NOT set their maximum length below 10". Still not in `near-contract-standards` 5.30.0, so the router implements both. Its split always sums to exactly `balance` | https://github.com/near/NEPs/blob/master/neps/nep-0199.md |
| Log limits | 100 logs and 16,384 bytes of log text per receipt on live testnet (protocol 88). The extended `epoch_closed` event at the worst case the active cap allows (16 spores, all 120 pairs trading) stays under it: router test `the_largest_epoch_closed_event_fits_the_log_limit` | `EXPERIMENTAL_protocol_config`: `runtime_config.wasm_config.limit_config.max_number_logs = 100`, `max_total_log_length = 16384` |
| Archival testnet RPC | The only public one is `https://archival-rpc.testnet.near.org` ("severely rate limited"). FastNEAR's archival is paid; dRPC and Intear are not archival. (Superseded by "Phase 6 S10" above: `spores-verify` now reads close txs from archival nodes first, including FastNEAR's, which answers without a key today.) | https://docs.near.org/api/rpc/providers; `status` call to the archival node answered (protocol 88) |
| near-sdk 5.30 base64 | `near_sdk::base64` re-exports base64 0.22 (`Engine` API); `Base64VecU8` serializes `media_hash` | `cargo tree -p spores-router`; near-sdk `src/lib.rs:1667` |
| Faucet account | `near account create-account sponsor-by-faucet-service <id> use-manually-provided-public-key <pk> network-config testnet create` (near-cli-rs 0.30.1) gave `spores-hack-router4.testnet` 10 NEAR; the key was generated by `setup.ts` and only the public key passed to the CLI | `near ... --help`; Phase 5 setup log |
