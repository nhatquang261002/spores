# Results, evidence and deviations from SPEC

One document for Phases 1–5. It replaces `docs/phase1-results.md` to `docs/phase5-results.md` (merged on 2026-11-03; the originals are in git history). Phase 6 work is tracked in `docs/phase6-plan.md`.

Every number here comes from a real run. Superseded decisions are dropped; where a later phase changed an earlier decision, only the current rule is listed, with a note.

Explorer for every hash: `https://testnet.nearblocks.io/txns/<hash>`.

## Contents

- [Deployments](#deployments)
- [Reproduce](#reproduce)
- [Core and sim (Phase 1)](#core-and-sim-phase-1)
- [Spikes: sub-accounts and renderer (Phase 2)](#spikes-sub-accounts-and-renderer-phase-2)
- [Router (Phase 3)](#router-phase-3)
- [Agents, outside service, decision log (Phase 4)](#agents-outside-service-decision-log-phase-4)
- [Epochs, allowance, market, verify (Phase 5)](#epochs-allowance-market-verify-phase-5)
- [Deviations from SPEC](#deviations-from-spec)
- [Incidents](#incidents)
- [Open for the team](#open-for-the-team)
- [Disclosure](#disclosure)

## Deployments

All on testnet; admin `deployer.spores-hack.testnet`.

| Router | Use | Wasm sha256 | State |
| --- | --- | --- | --- |
| `spores-hack-router4.testnet` | **Current.** Phase 5 exit run (14/14); Phase 6 (64 active) | `b82f4dcd37484fca2b58638aff7d1b939baf882891b2dedb31084de84db2f1c5` (504,207 bytes; this tree rebuilds to it), code-only redeploy `C28Zu62jaSzV58BzLMhh9d4VSD6X4qR6sGqLgvva98XN` before the close of epoch 17. Epochs 9–16 ran on `640c093f…` (the Phase 5 tree), epochs 1–8 on `9d2238e0…` | 30 s epochs, `max_active` 64 since `set_max_active` `95UsZnqp6nvLLs5bEqDgcYqyWvQdZGnJWJCnJczqZeU3`; 64 active (9–63 activated in Phase 6 S3, owned by the deployer). Spore 5 owned by `buyer.spores-hack.testnet`, run by `operator2` |
| `router3.spores-hack.testnet` | Phase 4 exit run (6/6) | `418b3f0cbd9fe11eb04a071f1369ab92a078ea9bc1bc640468656f16b80d6425` (the Phase 4 tree) | Kept as evidence. 3 extra closes on 2026-11-03 from an accidental run (Incidents) |
| `spores-hack-router2.testnet` | Phase 3 exit run (83/83) | `0dc71d70f2133d7fef43ebcc324a2ad2fea5bce8db3f1a144f9043adc518be75` | Kept as evidence |
| `spores-hack-router.testnet` | v0, abandoned during the first Phase 3 run | same code as router2 | Unused; its surplus funded Phase 5 |

The three old routers cannot simply be deleted. NEAR refuses to delete an account with more than 10 KB of state, not counting code (nearcore PR #4116), and each holds 37–41 KB (measured 2026-11-03: v0 36,898 bytes, router2 37,044, router3 41,339). Deleting would first mean deploying a state-cleanup contract over each. The team decided (2026-11-03) to leave them.

## Reproduce

The command list is in `CLAUDE.md`. Per phase:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --workspace && cargo clippy --workspace --all-targets
cargo run --release -p spores-sim -- all             # Phase 1 baseline + wash sweep -> out/; exit 1 if the gate fails
cargo run --release -p spores-sim -- allowance       # living-allowance candidates and the wash gate
cargo run --release -p spores-renderer -- check      # renderer vs vectors/renderer.json
cargo build --release -p spores-renderer --target wasm32-unknown-unknown && node renderer/js/check.mjs
(cd agents && npm ci && npm test) && (cd outside && npm test)
bash scripts/phase3-testnet.sh                       # needs a fresh router (deploy-router.sh); about 6 min
bash scripts/phase4-setup.sh && bash scripts/phase4-testnet.sh   # about 6 min
bash scripts/phase5-setup.sh && bash scripts/phase5-testnet.sh   # about 15 min; REDEPLOY=1 = code-only redeploy
cargo run --release -p spores-verify -- epochs --router spores-hack-router4.testnet --closes docs/phase5-closes.txt
cargo run --release -p spores-verify -- image  --router spores-hack-router4.testnet --closes docs/phase5-closes.txt --spore 5
cargo run --release -p spores-sim -- replay-decisions out/phase4/decisions.jsonl
```

`.env` (git-ignored) holds every key. Setup scripts append keys and never print them.

## Core and sim (Phase 1)

`core/` (`spores-core`) is pure integer math with only `sha2` as a dependency. `epoch::close_epoch` is the one call that the router and `verify` both run. `sim/` (`spores-sim`) sends every money decision through `spores-core`, uses floats only for hidden quality and metrics, and asserts ledger conservation every epoch. `vectors/core.json` and `vectors/agents.json` are the shared vectors that every other implementation must match byte for byte. Two runs of `sim all` give byte-identical output.

The SPEC rule changes made here are deviations 1–10 below.

### Baseline: price only vs price with tubes (20 seeds, 16 active)

16 active spores, 4 services, 3 jobs per consumer per epoch, 2 attempts per job, 60 epochs. Shocks: kill the best-value provider at 20, cut the strongest tube at 30, triple the second-best provider's cost at 40. Recovery: epochs until the 3-epoch rolling success rate is within 3 points of the 5 epochs before the shock.

| Mode | Avg price paid (NEAR) | Failed attempts | Unfulfilled jobs | Hired quality | Recover: kill | Recover: cut | Recover: raise |
| --- | --- | --- | --- | --- | --- | --- | --- |
| price only | 0.0948 | 28.2% | 7.6% | 0.717 | 1.0 (19/20) | 0.5 (20/20) | 1.6 (19/20) |
| tubes rel w=1 | 0.1104 | 26.4% | 7.4% | 0.735 | 1.9 (19/20) | 0.8 (20/20) | 1.4 (20/20) |
| tubes rel w=4 (shipped) | 0.1211 | 25.3% | 7.1% | 0.746 | 1.4 (19/20) | 0.7 (20/20) | 1.8 (20/20) |
| tubes abs w=1 | 0.1021 | 28.1% | 7.9% | 0.718 | 1.2 (19/20) | 0.9 (20/20) | 0.5 (19/20) |
| tubes abs w=4 | 0.1083 | 26.9% | 7.7% | 0.730 | 1.9 (20/20) | 0.3 (18/20) | 1.1 (20/20) |
| tubes rel w=4, no reject cut | 0.1151 | 26.2% | 7.4% | 0.738 | 1.4 (18/20) | 0.4 (19/20) | 0.3 (20/20) |
| tubes abs w=1, SPEC params | 0.1011 | 28.5% | 7.9% | 0.714 | 0.7 (18/20) | 0.4 (20/20) | 0.9 (19/20) |

With the shipped rule, tubes cut failed attempts from 28.2% to 25.3% (about 10% relative) and unfulfilled jobs from 7.6% to 7.1%, while the average price paid rises 28%. Recovery after shocks is not faster (about 2 epochs or less either way). The best of the 72 rule variants in `sim tune` reaches 24.5% failed attempts. With the SPEC parameters, tubes do not beat price only (28.5% vs 28.2%).

### Wash-trading sweep (SPEC §9)

Attacker spores 2–3 (1 is rejected as a self-payment), fee_bps 50/100/200, K 0.05/0.1/0.2/0.5 NEAR, gain 0.5e6/1e6/2e6, loop 0.01–5 NEAR per edge per epoch, 3 seeds, 40 epochs, worst case over seeds. The attacker's spores only pay each other.

- **Gate:** attacker net < 0, and the attacker's best spore stays below the honest median R. K is gated over ½×–2× of its default, the same range as fee and gain.
- **§9 literal:** the gate's money condition, plus tube gain and reputation per net NEAR below the honest group's.

At 16 active, 3 jobs, no allowance:

| Variant | Gate (K in range) | Gate (whole grid) | §9 literal (in range) |
| --- | --- | --- | --- |
| SPEC rule | 37/91 | 145/361 | 37/91 |
| shipped | **270/270** | 355/361 | 177/270 |

Shipped, in-range cases:

| Spores | Loop (NEAR/edge/epoch) | Gate | §9 literal | Worst net (NEAR) | Worst tube ratio | Worst rep ratio | Worst R ratio (attacker best / honest median) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 0.01 | 27/27 | 9/27 | -0.0010 | 1.83 | 8.54 | 0.07 |
| 2 | 0.05 | 27/27 | 6/27 | -0.0060 | 0.85 | 2.30 | 0.14 |
| 2 | 0.2 | 27/27 | 27/27 | -0.0300 | 0.29 | 0.63 | 0.19 |
| 2 | 1 | 27/27 | 27/27 | -0.1833 | 0.08 | 0.13 | 0.24 |
| 2 | 5 | 27/27 | 27/27 | -0.9808 | 0.02 | 0.03 | 0.26 |
| 3 | 0.01 | 27/27 | 0/27 | -0.0031 | 3.68 | 12.12 | 0.22 |
| 3 | 0.05 | 27/27 | 0/27 | -0.0180 | 1.72 | 3.27 | 0.39 |
| 3 | 0.2 | 27/27 | 27/27 | -0.0900 | 0.60 | 0.94 | 0.57 |
| 3 | 1 | 27/27 | 27/27 | -0.5500 | 0.16 | 0.20 | 0.73 |
| 3 | 5 | 27/27 | 27/27 | -2.9423 | 0.04 | 0.04 | 0.78 |

Unfavorable results, reported as required:

- **§9 literal fails for tiny loops (≤ 0.05 NEAR per edge per epoch): 93 of 270 in-range cases.** This follows from `R = Σ isqrt(D)`: reputation is concave, so the smallest tube that survives pruning gives the most reputation per NEAR, for honest and attacker spores alike. At those loop sizes the attacker's best spore reaches at most 0.39 of the honest median R.
- **K = 0.5 NEAR (5× default) fails the gate in 6 cases**: 3 attacker spores, a 5 NEAR loop, gain ≤ 1e6. The attacker's best spore reaches R 1.91–2.70 against an honest median of 1.77–2.67, while losing 2.9–11.5 NEAR. K must stay near the job price.
- **Not modelled:** an attacker who also buys real services from honest spores to raise its breadth to 4. That costs real purchases, but it would lift the breadth damping.

### Gate at scale and traffic (Phase 6 S1, 2026-11-03)

`--max-active N` and `--jobs N` (honest jobs per spore per epoch; the testnet agents default to 1). Shipped in-range gate **with the living allowance the router enforces** (`spores-sim allowance`):

| Honest jobs per spore per epoch | 16 active | 64 active |
| --- | --- | --- |
| 3 | 270/270 | 270/270 |
| 1 | 255/270 | 168/270 |

- The attacker loses money in 270/270 cases in every configuration.
- The reputation half of the gate depends on honest traffic per spore. At 64 active and 1 job, the honest median R is about 2 (0 in 30 cases). A 3-spore loop of ≥ 0.2 NEAR/edge/epoch then passes it while losing about 0.2 NEAR over 40 epochs.
- Without the allowance, 64 active with 3 jobs gives 261/270. All 9 failures are at K = 0.2 NEAR with 3-spore loops of 1 or 5 NEAR.

### SPEC §11 tests covered (graph, fee and reputation)

| Test | Where |
| --- | --- |
| Identical bytes across runs | `epoch::identical_inputs_give_identical_bytes`, `economy::same_seed_same_bytes`, sim output diff; across machines and languages: the shared vectors |
| Zero flow prunes in the expected epochs (16 from `d_max`) | `graph::zero_flow_prunes_in_expected_epochs` |
| 100× payment ≠ 100× conductivity, reputation or pool weight | `graph::large_payment_is_saturated`, `graph::reputation_prefers_breadth`, `pool::hundredfold_payment_is_not_hundredfold_weight` |
| No overflow at the largest payment | `graph::no_overflow_at_extreme_payments`, `math::mul_div_wide_*` |
| Fee + forwarded = paid; pool distribution sums to the pool | `fee::fee_plus_forwarded_is_amount`, `pool::proportional_sums_to_pool_with_largest_remainder`, `Distribution::total` |
| Ledger conserved | asserted every epoch in every sim run |
| Wash-trading criterion | `pool::capped_rebate_makes_loops_lose_and_spec_rule_does_not`, `economy::shipped_rule_makes_every_loop_lose`, the sweep |

## Spikes: sub-accounts and renderer (Phase 2)

| Spike | Decision | Evidence level |
| --- | --- | --- |
| Spore sub-accounts (§5.6) | **No-go.** Keep the single router ledger | Desk spike: docs, API surface and the §11 tests. Not run on testnet |
| Fixed-point renderer (§5.5) | **Go.** The slime render is the NFT image; the on-chain glyph is the fallback layer | Built and measured: identical bytes on native arm64, native x86_64 (Rosetta), wasm32 in node and a JS port, 10 cases. **Not yet run on a second physical machine or on Linux** |

### Sub-accounts: why no-go

1. **No custody gain.** The router would have to own every proxy to move funds between spores, escrow jobs and pay fees. Whoever upgrades or compromises the router controls every sub-account exactly as they control the ledger today. The single-ledger risk moves; it does not shrink.
2. **Atomicity.** SPEC §11 requires `buy` to settle NFT, seller payment and royalty all or none, and ledger conservation across an epoch. With balances in separate accounts every move is an asynchronous cross-contract receipt that needs a callback and a rollback path.
3. **Policy has to stay in the router anyway.** Operator keys are function-call keys that cannot attach a deposit. The sub-account would be a passive vault.
4. **Gas and moving parts.** `close_epoch` would become one cross-contract transfer per active spore, plus a proxy to build and keep in sync.

What the docs say (2026-10-31): a contract can add keys to another account only in the batch that creates it. Global contracts (NEP-591) make a per-spore proxy cheap: the publisher burns 10 NEAR per 100 kB once, and a referencing account pays "typically under 0.001 NEAR". Not verified: issuing `UseGlobalContract` inside a contract's own `CreateAccount` batch on testnet. Cost of the decision: the NFT does not own a real account. The README states the single router ledger as the shipped design.

### Renderer

`renderer/` (`spores-renderer`): xoshiro128** PRNG (32-bit, so JS needs only `Math.imul` and shifts); a 4096-angle sine table built by an integer Q60 Taylor series (no libm); a Q8 trail grid, Q16 agents and 3-sensor steering; integer tone curve, palette LUT, box-blur bloom, grain and vignette; a wasm C ABI; and an independent JS port (`js/render.mjs`). Image hash: `sha256("spores/img/v1" | RENDERER_VERSION u32 | 512 u32 | 512 u32 | RGB)`. It hashes pixels, not a PNG, so no encoder is in the trust path.

| Check | Result |
| --- | --- |
| Native Rust (aarch64-apple-darwin) vs vectors | 10/10 (trail hash and image hash) |
| Native Rust (x86_64-apple-darwin under Rosetta) | 10/10 |
| wasm32 in node 26.7 | 10/10 |
| JS port (own sine table, PRNG, pipeline) | 10/10, plus the sine-table hash |
| Negative control | One seed bit, `age` ± 1 or one `D` by 12,000 changes the hash; a `D` change of 1 or 1,000 does not (quantization, below) |
| Timing (one Mac) | native 0.2–0.7 s per image; wasm 0.6–1.0 s; JS 1.2–4.2 s |
| wasm size | 73 kB, no imports |

SPEC §11 art tests: byte-identical repeats (`repeated_renders_are_byte_identical`); across Rust and JS (the vectors); dormant is a faint mark (`dormant_is_a_faint_mark`: < 600 bright pixels vs 14,792 mature); adding an edge changes the image and pruning restores it exactly; young renders smaller than mature with the same seed (footprint 12,364 vs 22,744 cells). Across two physical machines: **partly** (two instruction sets on one machine, plus wasm). The first young-vs-mature attempt failed (71% footprint); the fix confined agents to a disc that grows with degree (`140 + 10*deg` px, at most 215). The test was not loosened.

Limits:

- **The image is not injective in state.** `D` is quantized to `D/1000`, so changes below about 1% of full scale can leave the image unchanged. The state hash stays the authority; the image hash is an additional commitment.
- **Not tested:** a second physical machine, Linux, Windows, Firefox or Safari wasm. Nothing uses floats, libm or platform sort order, but "low risk" is not "checked".
- **Phone render time** is not measured.
- **Changing any renderer constant changes every image hash:** bump `RENDERER_VERSION` and regenerate `vectors/renderer.json`.
- **Art polish is open (Phase 6):** young spores' partner markers can sit outside the thin network; markers of partners in adjacent ring slots overlap.

## Router (Phase 3)

Exit run on `spores-hack-router2.testnet`, 2026-10-31: 83 of 83 steps (`docs/phase3-testnet-run.txt`, full hashes there).

| Exit criterion | Result | Evidence |
| --- | --- | --- |
| Mint | 64 spores in 4 calls of 16 | `u2Cns9XV…`, `FeYwjnwu…`, `5zzU2uJv…`, `xhAF2y2v…` |
| Activate | Spores 0, 1, 2 activated; below-minimum deposit and non-owner rejected | `ByWcqUw2…`, `CrAyTtfo…`, `GGaMdebS…` |
| Transfer lockout | Old operator key and old owner rejected; policy paused with zero budget; tubes, age, reputation and balance kept; job in flight refunded | `B6Bfk3S6…` (transfer), `3ZoN9WoN…`, `6d8xASC4…`, `tfzexnJ9…` |
| Each policy rejection | Per-payment cap, allowlist, epoch budget and pause each reverted `accept`; balance and escrow unchanged | `8Av3vXWn…`, `9m53G7aF…`, `51CWywff…`, `4y7safDk…` |
| First image from chain state | `render_input(0)` → `docs/img/phase3-spore0-epoch2.png`, image hash `22b3bfaa…e301e` | run log |
| Ledger conservation | Unit test over 1,500 random calls; `ledger_totals().conserved == true` on testnet after the run | `ledger_is_conserved_under_random_operations` |

SPEC §11 router tests (unit and testnet, all pass): only the owner can activate, set policy, register an operator, pause or withdraw; after transfer the old operator key and old owner fail, policy is paused with zero budget, and balance, tubes and age are kept; the operator cannot withdraw to itself (FC key: `MethodNameMismatch`; operator full key: "only the spore owner"); budget, allowlist, cap and pause each revert; a restricted key cannot call outside its methods (protocol-level, rejected before inclusion, so the hashes are local); unsettled jobs time out without counting as flow; closing twice or too early fails; the contract's epoch close equals `spores_core::close_epoch` byte for byte. The mock runtime does not enforce `#[private]` or the payable check, so those were checked on testnet.

Measurements on router2 (437,005-byte wasm):

| What | Value |
| --- | --- |
| Storage per minted spore | 565 bytes (36,202 for 64; 0.36 NEAR) |
| Gas: mint 16 spores | 44–77 Tgas (rises with supply) |
| Gas: job calls | post 2.9, quote 2.6, accept 3.0, deliver 2.6, settle 3.2, reject 3.2, timeout 3.1 Tgas |
| Gas: control | activate 2.6, set_policy 2.7, pause 2.6, nft_transfer with one refund 5.6, withdraw incl. callback 5.6 Tgas |
| Gas: close_epoch (3 active, 2 tubes) | 3.3 Tgas |

Wasm size (`twiggy`): a long tail of about 2,700 functions (serde_json, borsh, near-sdk glue, BTreeMap instances). No single cut is worth it.

## Agents, outside service, decision log (Phase 4)

Exit run on `router3.spores-hack.testnet`, 2026-11-02: 8 epochs (6 to 14) unattended, 6 of 6 checks (`out/phase4/`, git-ignored).

| Exit criterion | Result | Evidence |
| --- | --- | --- |
| Agents trade unattended | 9 agent processes, keeper and outside service, no intervention. 47 jobs posted, 41 hires, 26 settled, 13 rejected, 2 accepts failed on balance | closes `D5HU3ucL…` … `HXSiwiqP…` |
| Tubes form | Edges per snapshot 8, 9, 12, 14, 14, 11, 9, 10, 12. Total D rose from 1,219,773 to a peak of 3,851,859, ending at 3,092,492 | snapshots |
| Art changes between epochs | All 9 spores' image hashes differ epoch to epoch; spore 2 `4374b954…` (epoch 6) to `2757693e…` (epoch 14) | `docs/img/phase4-spore2-epoch6.png`, `…epoch14.png` |
| Decision log | 41 lines with candidates, quotes, D, D_norm, score, winner, tx hashes. `replay-decisions`: 41 match, 0 differ | first settled hire: post `9sWPJqgq…`, accept `8LiRQ8C6…`, settle `38xhkVPE…` |
| Outside service | 25 sold, 0 refused, each against an on-chain `service_paid` receipt | first sale `FvtD4M4kLhPdYaSDkz718p5FkXeZ3Cpk1uw1pncs3N5B` |
| Ledger | Conserved at the end (deposited 3.6, paid out 0.37, balances 2.52, escrow 0.68, treasury 0.023 NEAR) | report |

Shocks (targets by value = quality per unit cost, from the run seed):

| Shock | Target | What happened |
| --- | --- | --- |
| Raise ×3, epoch 10 | Spore 3, runner-up by value | Before: quoted 0.053–0.054 NEAR, won 3 of 3. After: quoted 0.152–0.159, won 1 of 5 (the one hire with no other candidate) |
| Cut, epoch 11 | Tube 5–6, the strongest | No hire between 5 and 6 after it. D fell 25% per epoch: 814,107 → 610,581 → 457,936 → 343,452 |
| Kill, epoch 12 | Spore 1, best by value | Never hired again; consumers went to 0, 2, 4 and 7 |

Numbers worth stating plainly:

- **Tubes changed the winner** in 9 of the 26 hires with more than one candidate. Two of three examples were then rejected for a wrong answer: a tube is a record of history, not a guarantee of quality.
- **Rejections:** 13 of 39 deliveries (33%). Hidden quality ran from 50% to 98%.
- **Throughput:** one job in flight per consumer; a job cycle took about 40–60 s and epochs 31–68 s of wall time, so 47 jobs were posted in 8 epochs, not 72.
- **In flight at stop:** 0.68 NEAR in escrow; anyone can `timeout_job` it. One delivered job auto-settled on testnet (job 24, `3FiwACR5…`).
- **Failed calls:** 14 of 346 (8 late quotes, 4 late deliveries, 2 accepts on balance); none on gas or keys.
- **RPC:** FastNEAR's public testnet RPC rate-limits after a burst of about 17 requests (the first smoke run lost 38 of 50 calls to `-429`). Clients rotate FastNEAR and dRPC with backoff; agents wait for `EXECUTED_OPTIMISTIC`, keeper and setup for `FINAL`.
- Smoke runs `smoke1`–`smoke3` (epochs 1–5) ran on the same router first, so the exit run starts at epoch 6 with 8 edges.

Gas on router3 (successful calls, Tgas, avg / max): post_job 2.88 / 3.06, quote 2.54 / 2.72, accept 2.94 / 3.12, deliver 2.57 / 2.73, settle 3.54 / 3.73, reject 3.50 / 3.72, timeout_job 3.54 / 3.69, pay_service 5.69 / 5.77, close_epoch (9 active) 4.01 / 4.90.

## Epochs, allowance, market, verify (Phase 5)

Exit run on `spores-hack-router4.testnet`, 2026-11-02: 14 of 14 checks (`out/phase5/`, git-ignored). The first exit run (`phase5-exit1`) failed the sale (deviation 26).

| Exit criterion | Result | Evidence |
| --- | --- | --- |
| Sale, royalty paid | Spore 5 sold to the buyer for 0.5 NEAR: seller 0.475, royalty 0.025 (500 bps, to the admin); both transfers succeeded | list `3x73GvfiX8v77Hgk7jYpUZaYRiW117aqhmM6x6gwrFnM`, buy `BJUXhpDuHRv5dcfNA7uWQhFLJ6mamxzpeVYRAaoTHjsS` |
| Old operator key fails | `post_job` with the old FC key: "caller is not this spore's operator"; old owner's `withdraw`: "only the spore owner can do this" | `EhbGawHaoT2bDykHYSu4Qy9Z6Q8naecTkui9B4YreFiv`, `6cLHttRhTw95sa1BBYFNdcjn6ZLGsPp3KfzDbCdcenoq` |
| New policy starts paused | Read at the block before and the block of the buy: operator → none, `operator_gen` 1 → 2, paused, zero budget, empty allowlists, listing cleared, `sales` 1 | report |
| Balance, tubes, age intact | Balance 0.272650759 NEAR, tubes `0:401765, 1:917128, 3:444135, 4:92567, 6:822979`, age 11, reputation 3467, identical before and after | report |
| New owner takes over | Buyer registered `operator2.spores-hack.testnet` and set a policy; the agent resumed under operator2 (40 transactions) | `EM7jhdQsViofVu1Gx1YTnnLtZDCAoy4bCFURhjS9npxj`, `7RpEiSYKrEQ7ynBQ9WvEqZrN61A3GLC4eJnNNJ6GX9Ta` |
| `verify` reproduces fingerprints | All 16 closes of router4 (both exit runs) replayed from close receipts alone: 16 of 16 match the event, the stored fingerprint and the chain head | `docs/phase5-closes.txt` |
| `verify` regenerates the sold spore's image | State hash and image hash committed for epoch 17 match the rebuilt state and re-rendered image | state `d09c9957…`, image `ac15a3e9…` |

The six Phase 4 checks also passed in the same run (95 of 95 hires replay), plus 72 of 72 image commits. Image: `docs/img/phase5-spore5-epoch17.png`; on-chain glyph: `docs/img/phase5-spore5-glyph.svg` (983 characters).

Router4 storage after setup: 540,256 bytes (5.40 NEAR).

### Living allowance in sim (20 seeds × 60 epochs, 16 active, owner budget unlimited)

| base (NEAR) | trust_gain (NEAR per R 1000) | Avg price paid | Failed attempts | Unfulfilled jobs | Budget-blocked hires | Hired quality | Wash gate in range | Worst attacker net (NEAR) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | none | 0.1211 | 25.3% | 7.1% | 0.0% | 0.746 | 270/270 | -0.0010 |
| 0.050 | 0.100 | 0.1134 | 25.9% | 26.9% | 21.3% | 0.740 | 0/270 | -0.0010 |
| 0.100 | 0.100 | 0.1194 | 25.2% | 11.4% | 4.7% | 0.745 | 270/270 | -0.0010 |
| 0.050 | 0.200 | 0.1165 | 25.5% | 20.9% | 14.8% | 0.744 | 0/270 | -0.0010 |
| 0.100 (shipped) | 0.200 | 0.1211 | 25.3% | 8.6% | 1.6% | 0.746 | 270/270 | -0.0010 |
| 0.200 | 0.200 | 0.1215 | 25.3% | 7.5% | 0.4% | 0.745 | 270/270 | -0.0010 |

Unfavourable result: a tight allowance (base 0.05 NEAR) fails the wash gate 0/270, though the attacker still loses money in every case. A low base starves honest spores, so their tubes and median reputation fall, while attackers keep trading under the cap by splitting volume. On testnet no hire hit the ceiling in the exit run: reputation lifted it above job prices within a few epochs, so the allowance was enforced but did not bind live. Router tests cover it binding and falling as tubes decay.

### Gas on router4 (9 active, successful calls, Tgas)

| Method | Calls | Avg | Max |
| --- | --- | --- | --- |
| close_epoch (extended event, 9 state hashes) | 8 | 6.26 | 6.35 |
| commit_image | 72 | 2.79 | 2.82 |
| list | 1 | 2.80 | 2.80 |
| buy (with both payout callbacks) | 1 | 11.97 | 11.97 |
| register_operator | 1 | 2.80 | 2.80 |
| set_policy | 1 | 2.88 | 2.88 |

Views called as transactions (9 active, 19 tubes): `glyph` 2.33 Tgas, `nft_token` 2.69 Tgas, `nft_tokens` all 64 26.33 Tgas (68,899 bytes). Not measured: `nft_tokens` with many more tubes; each token's metadata scans all tubes, so cost grows with the tube count.

## Whole loop and one-command demo (Phase 6 S13)

`bash scripts/demo.sh` from a clean copy of the tree (2026-11-06, run `demo-20261106T101440Z` on router4, committed as the recording): exit 0, 14/14 checks, 9 closes 30–47 s apart (mean 38 s against a 30 s epoch), `spores-verify` matched all 63 epochs and spore 6's image. The closes were 66–92 s before the keeper stopped letting timeouts delay them. Spore #6: hired #11 at 0.1715 NEAR, tube D 0 → 473,807, R 0.85 → 1.42, allowance 0.270 → 0.384 NEAR, then sold for 0.50 NEAR. `bash scripts/demo.sh --playback` plays it with no keys and no testnet; in the browser Verify gives `Match · 63/63 epochs · image matches commit` with a network and `Unable` without. Of five real runs, two failed a check (one on a check since replaced, because it counted tubes across the router; one because the new agent had 28 s) and one more passed with no settled hire before its sale. All are in `out/agents/`, and their closes in `docs/router4-closes.txt`. Each real run sells a spore for good, so spores 1–6 are with the buyer.

**Deviations from the plan:** bundles leave out `renders/*.png` (about 60 MB; the app redraws them); the scene server starts after the run, since they share accounts and nonces; playback is a new story page, `/lab/loop`, not only a timer over the Network map; check "tubes formed" now means a tube between the run's spores was born or grew.

## The app (Phase 6 S14)

The full budget table is in `docs/phase6-plan.md` Design §10, measured 2026-11-07 on one Mac in Chrome. Initial JS is 175.3 kB gzip against a 180 kB budget, wasm 73.2 kB and 195.0 kB. The map's `draw()` holds 111 fps at the worst case of 2016 tubes, and 94 fps in an epoch tween, after a one-layer drawing mode past 400 tubes; before that mode it held 18 fps. Those are synthetic tubes on that machine, not the 2019 laptop the design names. Real closes have had 0–31 pairs.

The Overview tells one real spore's life from the committed recording in about 32 s (the sale at 22 s, on one measured reload), labelled as a recording. Below it the live collection reads the chain and fails on its own. Nobody outside the team has watched it, so "understood in 30 s" is a design aim, not a result.

On 2026-11-07 the Overview became the landing page, outside the app's nav: 476/476 viz tests, initial JS 175.0 kB. Design §13 item 23 has what changed and what wasn't seen.

**Deviations from the plan:** the Overview's hero is a recording, not the live map, since between runs the router has almost nothing moving (Design §13 item 22). Its inline figure says pairs, not payments, since `epoch_info.flows` keeps per-pair totals. The treasury has no view, so it is named as unavailable behind "more". Injection stays not built (D2), and spores keep the title `Spore #N` (D4).

## Deviations from SPEC

Numbered once across phases, for the README's disclosure section. SPEC.md has been updated where noted.

### Graph core and sim

| # | SPEC as written | Shipped | Why |
| --- | --- | --- | --- |
| 1 | Fee pool split among active spores by saturated weight (§8.3) | **Capped rebate:** each spore gets back at most `rebate_bps` (5000) of `fee * K / 2` per unit of weight; the rest goes to the treasury | With the SPEC rule the attacker's net was positive in all 54 in-range cases with loops ≤ 0.2 NEAR. With the cap, an edge's two ends get back at most `fee*q*K/(q+K) < fee*q`, so every loop provably loses money, and rebates never exceed the pool |
| 2 | Division rounds down everywhere | Fee rounds **up** | A floored 1% fee is 0 below 100 yocto, so dust payments would grow tubes for free |
| 3 | `u128` with overflow checks | Exact 256-bit `mul_div` for every product-then-divide | No overflow for any `q` up to `u128::MAX`; same bytes on every target |
| 4 | `K = 0.5 NEAR` | `K = 0.1 NEAR` (about one job's price) | At 0.5, honest tubes stayed near the pruning floor (honest mean R ≈ 0.2) while a 3-spore ring reached R ≈ 4 |
| 5 | Edge gain `gain * q/(q+K)` | Times `min(breadth_a, breadth_b, 4) / 4` (breadth = distinct counterparties with a live tube or flow this epoch) | A ring of k spores has breadth ≤ k−1, so its tubes grow at ¼ (k=2) or ½ (k=3) speed |
| 6 | Rejected jobs simply don't count | Each rejected delivery cuts the edge's D by `reject_bps` (5000 = halve) | So a tube remembers reliability, not just past hires (failed attempts 26.2% → 25.3%) |
| 7 | `D_norm` = D normalised to 0..1 | `D / strongest candidate tube`, `w = 4` (agent rule, not consensus) | Scale-free; slightly better than `D / d_max` in the baseline and `tune` |
| 8 | Fingerprint over `epoch, spores, a:b:D` | `spores/fp/v1\|epoch\|prev_fp_hex\|ids\|a:b:D\|...` | Domain tag and version; chaining makes each epoch commit to the whole history |
| 9 | Empty epoch does nothing | Pays nothing, but tubes still decay and spores age | Die-back needs decay without flow (SPEC §8.1) |
| 10 | Wash criterion: lower tube and reputation gain per NEAR (§9) | Gate: loses money and cannot reach the honest median R | What selling a spore with faked history would need. **Needs sign-off** (open item 2) |

Unchanged: `decay_bps = 2500`, `gain = 1e6`, `D_min = 50_000`, `fee_bps = 100`, `R = Σ isqrt(D)`.

### Renderer

| # | SPEC | Built | Why |
| --- | --- | --- | --- |
| 11 | Inputs: seed, edges, reputation, epoch | Seed, edges, **age** | R derives from the edges; `epoch` is global and cannot make a young spore look young, so it is a viz label, not in the hash |
| 12 | Faint-trail mask threshold **rises** with age | Threshold **falls** with age (14/255 at age 0 to 0 at age 30) | As written an old spore would hide more than a young one. Read as a typo; **please confirm** |
| 13 | Ring: 64 dots, brighter for active spores | Dots uniformly dim; slots with a tube skipped | Which spores are active is global state; in the image it would make a committed hash depend on other spores. Brightness belongs to the gallery |
| 14 | (Prototype) name, id, epoch, degree and rep as text | No text in the image | Fonts are not byte-reproducible; the viz overlays text in HTML |
| 15 | (Prototype) float numpy, Gaussian init and bloom, `pow(0.8)`, LANCZOS | Integer equivalents, no upscale | Floats and library resampling are the reproducibility problem; the look is similar, not identical, to `slime.py` |
| 16 | `D` drives size continuously | `D` quantized to `D/1000` | Keeps marker and node maths in small integers |

### Router, agents and market

17. **Pause** blocks `post_job`, `quote`, `accept`, `deliver` and `settle`. `reject` and `timeout_job` stay open because they only return money.
18. **Budget is counted at `accept`**, when money enters escrow. A refund in the same epoch gives the budget back.
19. **Delivered jobs auto-settle at the deadline** (Phase 4, decided with the team; replaces the Phase 3 refund that gave consumers a free option). `timeout_job` on a Delivered job pays the provider minus the fee and emits `job_settled` with `"auto": true`; it adds no flow and no reject. SPEC §6.2 is updated.
20. **Mint and transfer leave the spore locked** (paused, zero budget). Activation does not unlock it; the owner calls `set_policy`.
21. **"Key generation counter" is `operator_gen`.** The router cannot delete keys on the operator's account, so the old key still exists; it is rejected because its account is no longer the operator. If a new owner re-registers the same operator account, that key works again (the new owner's choice; the README should say so). Quotes carry the generation.
22. **The operator must differ from the owner**, so "operator cannot withdraw" is not vacuous. One operator account may run several spores, with one FC key per spore (separate processes cannot share a key's nonce).
23. **No NEP-178 approvals.** Only the owner moves a spore; the market is the router's own `list`/`buy`. NEP-199 `nft_transfer_payout` is owner only, so an outside marketplace cannot sell a spore; royalties are enforced by `buy`.
24. **The router pays its own storage.** Job storage is bounded: 4 unfinished posted jobs per spore, 8 quotes, 256-byte tasks, 128-byte results. Finished jobs are deleted and live on in events.
25. **`pay_service` and `external_allowlist`** (SPEC §6.4 option 2 and §7.1 updated). No fee and no flow (the payee is outside the graph); same cap and epoch budget as jobs; tracked as `paid_out`, so conservation is `deposited - withdrawn - paid_out == balances + escrow + pool + treasury`. A failed transfer restores balance and budget.
26. **`buy` pays seller and royalty from the attached deposit** by two detached transfers. A failed payout goes to the treasury and is counted as deposited, so the ledger stays conserved; the price never enters the spore ledger. The first version returned `seller.and(royalty)`, which the mocked runtime allows and testnet rejects ("Returning joint promise is currently prohibited", `9ZoF7CyM5ykmpvryVQPgWchiWdGEfrjx4EHeWhSBJuuL`). Fixed and redeployed code-only (`EYHMniQ2G3x2aX7Sgd58QCZw1mZN43MY9oZAVwT4uSRj`); the close logic is the same in both wasm builds and `verify` matches all 16 closes.
27. **State hash: latest only.** SPEC §5.5 stores one per close. The router keeps one `(epoch, hash)` per active spore, overwritten at each close, so storage stays bounded. History is recomputed by `verify` from replayed tubes, seed and age.
28. **`epoch_closed` carries the full epoch input** (active set, flows, rejects, pool, previous fingerprint) and the tube count, so `verify` needs only the close receipts, every one since epoch 1. The planned keeper pre-close snapshot was not built; the event records what it would have. Router4 epochs 1–16 also logged the resulting tubes; Phase 6 S3 dropped them because at 64 active the event could pass NEAR's 16 KiB log limit, and an oversized log fails the close (S2). `verify` checks the tubes where they are logged and the count everywhere.
36. **Trading pairs per epoch are capped** (Phase 6 S3, `MAX_EPOCH_PAIRS` = 224). `accept` refuses a pair not yet in this epoch's flows or rejects (`"epoch pair cap reached: try next epoch"`) once those pairs plus every escrowed job reach the cap; escrowed jobs count because they can settle after the close. The pairs held this epoch plus those escrowed jobs could still add never exceed the cap (randomised router test), so a close names at most 224 pairs: 13,794 bytes at 64 active with 27-digit amounts (limit 16,384; 274 pairs would fit). Known limit: an owner with many spores can hold slots with jobs it never delivers (4 per spore, refunded at the timeout). The count lives under a raw storage key (`escrowed_jobs`), outside the state struct, so router4 kept its state layout.
37. **`max_active` can be raised** by the admin (`set_max_active`, 1 yocto, raise only, at most `supply_cap`); SPEC fixed it at init. Router4 went from 16 to 64 (Phase 6 decision D3).
29. **`commit_image` is admin only.** SPEC §5.5's "renderer operator" is the admin account, whose FC key the keeper uses. The router does not check images; `verify` does.
30. **NEP-177 `media` is the on-chain glyph** (`data:image/svg+xml;utf8,…` with `media_hash`), not the rendered image, because nothing hosts the PNGs. The committed `image_hash` sits in `extra`. `base_uri` is unset. The name trait is not implemented (Phase 6 decision D4: titles are `Spore #N` only).
31. **Royalty account** defaults to the admin; router4 uses the default.
32. **Living allowance values:** base 0.1 NEAR, trust_gain 0.2 NEAR per 1000 R (sim table above).
33. **Agent-side rules that differ from sim** (none is a money decision): margin "wins" counted at accept, not settle; hidden quality is integer bps (5000–9800) with the roll `stream(seed, job_id)`; the cut shock is behavioural (the router cannot delete a tube, so it decays 25% per epoch instead of dropping to zero).
34. **Results travel off-chain** in a content-addressed directory (`out/agents/<run>/results/<sha256>.json`); only the hash goes on chain, and the consumer checks the file against it. This ties all agents to one machine.
35. **Task content is rule-generated.** No LLM is used. The injection scene is not implemented (Phase 6 decision D2).

## Incidents

- **Hung RPC call (Phase 3).** The first run, on `spores-hack-router.testnet`, stalled 48 min in `send_tx`: `activate spore 1` had executed but no response came. The helpers now compute the tx hash locally (sha256 of the signed transaction without its signature), time out after 60 s and poll `tx` by hash. Because v0 was left half-configured, the evidence run used a fresh router2.
- **Joint promise in `buy` (Phase 5):** deviation 26.
- **Epoch wall time (Phase 5).** The keeper rendered and committed 9 images one after another before polling again, so epochs took 92–122 s against a 30 s `epoch_len`. Taking commits off the close path is Phase 6 session S2.
- **Close out of gas at 64 active (Phase 6 S3).** The keeper attached a job call's 10 Tgas to `close_epoch`; the first close with 64 active (epoch 17 on router4) ran out (`BPzggjwVAKwU9LxAK9Ym7YHHqEaGJG1ix329UeNR9avN`, 11.42 Tgas burnt, state unchanged). The keeper now attaches 300 Tgas (`CLOSE_GAS_TGAS`); the close then burnt about 20.5 Tgas.
- **Accidental run on router3 (Phase 6 S3, 2026-11-03 07:47Z).** Checking `run.ts` for syntax with `node src/run.ts --help` started a real run: with no `ROUTER` set it defaults to router3, so spores 0–8 traded there for about 2 minutes (3 closes, among them `E3oTPv88QJB3XXUYNZftPPthanfQn5Di5PcKkdqCfoqW`, and about 130 job transactions) before it was killed. The Phase 4 transactions are unchanged, but router3's state moved on 3 epochs and a few jobs were left in escrow (refundable by `timeout_job`). Logs: `out/agents/accidental-router3-20261103T0747Z/`. `run.ts` now refuses unknown options.
- **Balances drain.** 18 accepts failed on "insufficient balance" in the Phase 5 run. `agent.ts` now skips a hire when the balance is below the quote (`low_balance`); this fix has not yet run on testnet.

Funding history: router2 and v0 were faucet accounts (10 NEAR each). Router3 setup moved 4.5 NEAR from router2's surplus (`BDRTurMR…`), 2.0 NEAR from the deployer (`5CSJTpgd…`) and 1.3 NEAR from the buyer (`46C1uTux…`); spores activated with 0.4 NEAR. Router4 is a faucet account; the owner and buyer were topped up from v0's surplus (4.610 NEAR, `5LGkxcdgN9Ja4aoMFMe6sfvkwuiZNKj999HYYWTrTirx`; 0.051 NEAR, `DHL5bcJoP1eP2i2Ez7jQ5BJwz8qSDVUyLpTsvaqfVzen`; plus 0.005 and 0.001 NEAR); spores activated with 0.5 NEAR; `operator2` created with 0.1 NEAR.

## Open for the team

1. **Tubes vs price only.** Tubes win on reliability by a small margin and cost 28% more on price; in the sim a failed attempt only costs a retry. Options: (a) ship as "reliability at a price premium", (b) give failures a cost in the sim and re-measure, (c) keep iterating the rule.
2. **Gate criterion** (deviation 10): confirm "loses money and cannot reach the honest median R", or ask for a reputation formula that meets §9 literally (for example linear capped `R = Σ min(D, cap)`, which gives up the breadth bonus).
3. **Renderer mask direction** (deviation 12): confirm the typo reading.
4. **Second physical machine** for the renderer `check`.
5. **Live traffic vs wash resistance at 64 active** (Phase 6 S1): at 1 honest job per spore per epoch the gate is 168/270. `JOBS_PER_EPOCH` has to be weighed against RPC load.
6. **Balances drain** (fees, treasury share, the outside service). The fast-epoch demo needs bigger deposits or a top-up step. Router4's ledger at the end of Phase 5: balances 3.91 NEAR, treasury 0.074, paid out 0.52, conserved.
7. **Spore 5 on router4** is owned by the buyer and run by operator2; a later run needs operator2's key or a sale back.
8. **`verify` needs old close transactions.** After a few days only archival nodes have them, and they are rate-limited (`docs/verify-notes.md` "Phase 6 S10"). The CLI now asks archival nodes first for close txs (2026-11-05, after the regular nodes had stalled it for minutes per tx), so the README's commands need no setting: 16 closes 21 s, all 25 22–77 s. If both archival nodes stop answering it stops at the first unreadable tx with an error naming every endpoint (71 s when tried), and `NEAR_ARCHIVAL_RPCS` points it at another node. The close hashes are kept in `docs/phase5-closes.txt` (16) and `docs/router4-closes.txt` (all 25).
9. **Throughput:** one job in flight per consumer, with a cycle longer than an epoch. Two in parallel per consumer doubles RPC load.

## Disclosure

- Dates: Phase 1 on 2026-10-29; Phases 2 and 3 on 2026-10-31; Phases 4 and 5 on 2026-11-02. CLAUDE.md lists what must be disclosed as pre-window work (`slime.py`, the 2026-10-26 `slime-router.html` sketch, Phase 0 and 1). `slime.py` is the prototype the renderer was ported from.
- Recorded as written with Claude Code (Q-005): the renderer (Rust and JS, Phase 2), `router/` and `scripts/` (Phase 3). The older docs do not record this for `core/`, `sim/`, `agents/`, `outside/` and `verify/`; the team must confirm it for the README's Q-005 list.
- Dependencies: `sha2` (core, renderer); `serde_json` (sim, renderer CLI, tests); `near-sdk` 5.30.0 and `near-contract-standards` 5.30.0 (router); `near-api-js` 7.4.0 (agents). No image or PRNG crate; `outside/` and `verify/` add no dependencies.
- Tools: `cargo-near` 0.22.0, `near-cli-rs` 0.30.1, `twiggy` 0.8.0 (size analysis only).
