# Phase 3: router contract and first image from chain state

Status on 2026-10-31. Every Phase 3 item in ROADMAP is built, and the exit run passed on testnet: 83 of 83 steps (`docs/phase3-testnet-run.txt`).

| Exit criterion (ROADMAP) | Result | Evidence |
| --- | --- | --- |
| Mint on testnet | 64 spores minted in 4 calls of 16 | `u2Cns9XV…`, `FeYwjnwu…`, `5zzU2uJv…`, `xhAF2y2v…` |
| Activate | Spores 0, 1, 2 activated; below-minimum deposit and non-owner rejected | `ByWcqUw2…`, `CrAyTtfo…`, `GGaMdebS…` |
| Transfer lockout | Old operator key and old owner rejected; policy paused with zero budget; tubes, age, reputation and balance kept; job in flight refunded | `B6Bfk3S6…` (transfer), `3ZoN9WoN…`, `6d8xASC4…`, `tfzexnJ9…` |
| Each policy rejection | Per-payment cap, allowlist, epoch budget and pause each reverted `accept`; balance and escrow unchanged | `8Av3vXWn…`, `9m53G7aF…`, `51CWywff…`, `4y7safDk…` |
| First image from chain state | `render_input(0)` → `spores-render state` → `docs/img/phase3-spore0-epoch2.png`, image hash `22b3bfaa…e301e` | run log step "render spore 0" |
| Ledger conservation test | Unit test over 1,500 random calls (failing ones included); `ledger_totals().conserved == true` on testnet after the run | `ledger_is_conserved_under_random_operations`; run log |

Full hashes are in the run log; explorer: `https://testnet.nearblocks.io/txns/<hash>`. Router: `spores-hack-router2.testnet`, admin `deployer.spores-hack.testnet`, wasm sha256 `0dc71d70f2133d7fef43ebcc324a2ad2fea5bce8db3f1a144f9043adc518be75` (`non-reproducible-wasm` build).

## Reproduce

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test -p spores-router                    # 16 contract tests, about 60 s (the random ledger test dominates)
cargo clippy --workspace --all-targets         # warning-free
bash scripts/deploy-router.sh                  # needs a fresh, funded account in ROUTER_ACCOUNT_ID
bash scripts/phase3-testnet.sh                 # about 6 min; writes out/phase3/
```

The run needs `.env` (git-ignored) with the role accounts' keys and `OPERATOR_FC_PRIVATE_KEY`: a function-call key on the operator account, receiver = the router, methods `post_job, quote, accept, deliver, settle, reject, timeout_job`, allowance 0.25 NEAR. It was added with `near account add-key <operator> grant-function-call-access --allowance '0.25 NEAR' --contract-account-id <router> --function-names post_job,quote,accept,deliver,settle,reject,timeout_job autogenerate-new-keypair save-to-legacy-keychain network-config testnet …`.

## What was built

`router/` (crate `spores-router`, near-sdk 5.30.0, near-contract-standards 5.30.0):

- `nft.rs`: NEP-171 core, NEP-177 metadata (built from state on each read), NEP-181 enumeration. Every owner change resets control (§5.3): the operator is cleared, `operator_gen` increments, policy becomes paused with zero budget, and every job in flight is refunded to its payer. Balance, tubes, age and history stay. A reverted `nft_transfer_call` resets control again, because the receiver owned the spore during `nft_on_transfer` and could have registered its own operator.
- `ledger.rs`: `deposit` (anyone), `withdraw` (owner only, 1 yocto, pays the owner; no recipient argument, so an operator cannot withdraw to itself; the balance is restored if the transfer fails).
- `lib.rs`: `mint_genesis` (admin), `activate` (owner, minimum deposit), `register_operator`, `set_policy` (owner, 1 yocto), `pause` (owner, no deposit so any owner key can stop the agent).
- `jobs.rs`: `post_job`, `quote`, `accept`, `deliver`, `settle`, `reject`, `timeout_job`. Policy is checked at `accept`, where money moves into escrow. `settle` takes the fee (core `split_payment`, rounded up) into the pool and records the full price as flow. `reject` refunds and counts a rejection on the edge. Only settled jobs count as flow.
- `epoch.rs`: `close_epoch` (see deviation 1).
- `views.rs`: `spore_summary`, `is_operator`, `render_input`, `epoch_info`, `edges`, `fingerprint`, `get_job`, `list_jobs`, `ledger_totals`, `storage_report`, `config`, `admin`.
- NEP-297 events (`standard: "spores"`) for every state change, for the viz and the decision log.

Renderer: new CLI subcommand `spores-render state <render_input.json> <out.png>`. No output bytes changed, so `RENDERER_VERSION` stays 1 and `check` still passes on native, wasm and JS.

Scripts: `scripts/view.sh` (RPC view), `scripts/near-lib.sh` (sign with near-cli, send with RPC `send_tx`; failed calls also get a hash), `scripts/deploy-router.sh`, `scripts/phase3-testnet.sh`.

## SPEC §11 tests, status

| Test | Where | Status |
| --- | --- | --- |
| Only the owner can activate, set policy, register an operator, pause or withdraw | unit `only_the_owner_can_…`; testnet | Pass |
| After transfer: old operator key fails, old owner cannot withdraw or set policy, policy paused with zero budget, balance/tubes/age kept, in-flight jobs refunded | unit `transfer_locks_out_…`; testnet | Pass |
| Operator cannot withdraw to itself | unit; testnet (FC key: `MethodNameMismatch`; operator full key: "only the spore owner") | Pass |
| Budget, allowlist, per-payment cap and pause each revert | unit; testnet | Pass |
| A restricted key cannot call anything outside its methods | testnet only (protocol-level): `MethodNameMismatch` for `set_policy` and `withdraw`, `DepositWithFunctionCall` for a deposit | Pass. These are rejected before inclusion, so the hashes are local, not on chain |
| Unsettled jobs refund after timeout and do not count as flow | unit `only_settled_jobs_count_as_flow`; testnet | Pass |
| Close twice or too early fails; an empty epoch pays nothing | unit; testnet (twice) | Pass |
| Ledger conserved across epochs incl. fees, refunds, withdrawals (and failed withdrawals) | unit (random mix); testnet view | Pass. Royalties are Phase 5 |
| Contract epoch close equals `spores_core::close_epoch` byte for byte | unit `epoch_close_matches_spores_core_…` | Pass |
| A chain state renders; adding tubes changes the image; one epoch of decay alone changes it | unit `render_input_from_chain_state_…`; testnet render | Pass |
| `buy` atomic, listing freezes, royalty, effective budget, glyph, `commit_image` | Phase 5 | Not started |

The mock runtime does not enforce `#[private]` or the payable check, so those were checked on testnet ("stranger calls private on_withdraw").

## Measurements (testnet)

| What | Value |
| --- | --- |
| Contract code | 437,005 bytes wasm (profile `contract`: opt z, LTO, strip); with init state 437,630 bytes = 4.38 NEAR of storage |
| Storage per minted spore | 565 bytes (36,202 bytes for 64; 0.36 NEAR), which closes the verify-notes open item |
| Storage after the run | 474,049 bytes; `storage_report.solvent = true` |
| Gas: mint 16 spores | 44–77 Tgas (rises with supply because enumeration sets grow) |
| Gas: job calls | post 2.9, quote 2.6, accept 3.0, deliver 2.6, settle 3.2, reject 3.2, timeout 3.1 Tgas |
| Gas: control | activate 2.6, set_policy 2.7, pause 2.6, nft_transfer (with refund of one job) 5.6, withdraw incl. callback 5.6 Tgas |
| Gas: close_epoch (3 active, 2 tubes) | 3.3 Tgas |
| Tubes after epoch 1 | (0,1) and (0,2) at D = 71,428: `1e6 · 0.04/(0.04+0.1)` = 285,714, times breadth damping 1/4 (spores 1 and 2 each had one counterparty). Reputation of spore 0 = 2 · isqrt(71,428) = 534 |

Where the 437 KB goes (`twiggy`, symbolized build): a long tail of about 2,700 functions (serde_json, borsh, near-sdk glue, BTreeMap instances). The largest single items are sha256 (8 KB) and float formatting from `core::fmt` (11 KB). No single cut is worth it now.

## Deviations from SPEC and ROADMAP, and decisions for the team

1. **`close_epoch` pulled forward from Phase 5, minimal form.** "Budget per epoch" needs epochs to end, and an image from chain state needs tubes. It runs `spores_core::close_epoch` and stores the fingerprint per epoch. Per-spore state hashes, `commit_image`, the living allowance and the treasury withdrawal are still Phase 5.
2. **Pause** blocks `post_job`, `quote`, `accept`, `deliver` and `settle` for that spore. `reject` and `timeout_job` stay open because they only return money.
3. **Budget is counted at `accept`** (when money enters escrow). A refund in the same epoch (reject, timeout, transfer) gives the budget back.
4. **Delivered but never settled → refunded at the deadline**, as SPEC §6.2 says. This gives the consumer a free option to keep a result and pay nothing; the provider's protection is reputation only. Please confirm or change (e.g. auto-settle at the deadline).
5. **Mint and transfer both leave the spore locked** (paused, zero budget). Activation does not unlock it; the owner calls `set_policy`.
6. **"Key generation counter"** is `operator_gen`. The router cannot delete keys on the operator's account (verify-notes), so the old key still exists; the router rejects it because its account is no longer the registered operator. If a new owner re-registers the same operator account, that key works again; that is the new owner's choice, and the README should say so. Quotes carry the generation, so a quote by a cleared operator cannot be accepted.
7. **The operator must differ from the owner**, so "operator cannot withdraw" is not vacuous. One operator account may run several spores (the testnet run used one for spores 0–2).
8. **No NEP-178 approvals.** Only the owner can move a spore. External marketplaces therefore cannot list it; the market is the router's own `list`/`buy` (Phase 5). NEP-199 payouts are still open.
9. **The router pays its own storage** (mint, jobs). Job storage is bounded: 4 unfinished posted jobs per spore, 8 quotes, 256-byte tasks, 128-byte results; finished jobs are deleted and live on in the event log.
10. **The treasury has no withdraw method yet.** The rest of the fee pool accumulates as a ledger entry (0.000514 NEAR after this run).
11. **NEP-177 `media` is empty** until `commit_image` (Phase 5). `extra` carries seed, active, age, degree, reputation and transfers. The name trait is not implemented.
12. **Art polish (Phase 6):** when two partners sit in adjacent ring slots their markers overlap (spores 1 and 2 in the sample image).

## Incidents

- **A hung RPC call.** The first run (router `spores-hack-router.testnet`) stalled for 48 min in `send_tx`: `activate spore 1` had executed on chain but no response came back. The helper now computes the transaction hash locally (sha256 of the signed transaction without its 65-byte signature; checked against the RPC's hash), times out after 60 s and polls `tx` by hash. Because that router was left half-configured, the evidence run used a fresh `spores-hack-router2.testnet` with its own function-call key. The first router (about 5.6 NEAR, mostly storage) is unused. Deleting it would return the funds to a beneficiary; not done without a yes.
- **Two testnet accounts were created via the faucet** (`spores-hack-router.testnet`, `spores-hack-router2.testnet`, 10 NEAR each), because the 437 KB contract needs about 4.4 NEAR and the deployer has 3. Keys are in `.env` (`ROUTER_*`, `ROUTER_V0_*`) and in `~/.near-credentials/testnet/` (mode 600). The operator account now has two function-call keys (one per router) besides its full-access key.

## Disclosure

All of `router/` and `scripts/` is new work from 2026-10-31, written with Claude Code (Q-005). New dependencies: `near-sdk` 5.30.0, `near-contract-standards` 5.30.0 (router); `serde_json` moved from dev to normal dependency in the renderer for the CLI. Tools: `cargo-near` 0.22.0, `near-cli-rs` 0.30.1, `twiggy` 0.8.0 (size analysis only).
