# How Spores works, and the evidence

The [README](../README.md) is the short version. This is the design as built, with the evidence behind each claim: the math, the contract, the renderer, the agents, verification, the app, every testnet run, the simulation results (the unfavourable ones included) and every place the build departs from [SPEC.md](../SPEC.md), the design as first written.

Every number here comes from a real run or a test in this repository. Transactions can be opened at `https://testnet.nearblocks.io/txns/<hash>`, or read with no browser or keys through RPC (the README shows the command).

## Contents

1. [The loop](#1-the-loop)
2. [One integer core](#2-one-integer-core)
3. [The router contract](#3-the-router-contract)
4. [Art: a reproducible Physarum renderer](#4-art-a-reproducible-physarum-renderer)
5. [Agents, keeper and the outside service](#5-agents-keeper-and-the-outside-service)
6. [Verification](#6-verification)
7. [The app](#7-the-app)
8. [Testnet evidence](#8-testnet-evidence)
9. [Simulation results](#9-simulation-results)
10. [Where the build departs from SPEC.md](#10-where-the-build-departs-from-specmd)
11. [NEAR facts checked against the docs](#11-near-facts-checked-against-the-docs)
12. [Incidents, and what changed because of them](#12-incidents-and-what-changed-because-of-them)

## 1. The loop

```
owner sets policy ──► agent (operator key) pays via router ──► tubes thicken / decay
      ▲                living allowance gates payments                  │
      │                                                                 ▼
 spore NFT carries                                          the art IS the network;
 control, money, history,                                    reputation sets the allowance
 access                                                                 │
      ▲                                                                 │
      └──── spores are listed, bought and sold at a price history sets ◄──┘
```

Each part has to earn its place. The removal test, run on what was built:

| Remove | What breaks | Evidence that it's real |
| --- | --- | --- |
| The NFT | The agent has no owner, the money no holder and the art no home | On a sale, control, policy and operator move with the token while balance, tubes and age stay (`buy` `HZNJeWxy…`, old key refused `DY9sTYpe…`) |
| Tube-weighted hiring | The art is decoration and history has no value | Phase 4: tubes changed the winner in 9 of 26 contested hires. Every logged hire replays against `spores_core`, 30 of 30 in the recorded run |
| Living allowance and policy | An owner can't safely let an agent spend | Refused in receipts (`E3s92QQj…`, `Fat7jVV7…`, `918spGjv…`). 11 of 30 hires in the recording were skipped on the limit |
| The market | The spore's value never meets a price | 8 `buy` calls with royalty on testnet. Buyer and seller are both ours |

## 2. One integer core

`core/` (`spores-core`) is the only implementation of the economy's math. The router runs it on chain, `sim` runs it in the simulation, `spores-verify` runs it to replay the chain, and the browser runs it as wasm (`core-wasm/`, 195 kB). It has no floats and no chain dependency, and its only dependency is `sha2`. Because every consumer links the same code, the contract's epoch close equals `spores_core::close_epoch` byte for byte, by construction and by test.

`vectors/core.json` and `vectors/agents.json` are shared test vectors. The TypeScript agents port the hiring, margin, demand and RNG rules (`agents/src/rules.ts`) and are checked against `agents.json`; core-wasm is checked against `core.json`. Two runs of `sim all` give byte-identical output.

### The rules

| What | Rule |
| --- | --- |
| Tube update at each close | `D' = D - D*decay_bps/10000 + gain * q/(q+K) * min(breadth, B)/B`, where `q` is the settled flow on the edge this epoch and breadth is the number of distinct partners of the less connected end. Edges below `D_min` are pruned. Edges iterate in lexicographic order |
| Rejection | Each rejected delivery halves the edge's `D` (`reject_bps` 5000), so a tube remembers reliability as well as hires |
| Reputation | `R = Σ isqrt(D_e)` over a spore's tubes: concave, so breadth beats volume |
| Fee | 1% of each settled payment, rounded **up**, so dust payments can't grow tubes for free |
| Fee pool | A capped rebate: each spore gets back at most `rebate_bps` (5000) of `fee * K / 2` per unit of weight, and the rest goes to the treasury. An edge's two ends get back at most `fee*q*K/(q+K) < fee*q`, so **every wash loop provably loses money** |
| Living allowance | `effective budget = min(owner budget, base + trust_gain * R / 1000)` |
| Hiring score | `quote / (1 + w * D_norm)`, `w = 4`, `D_norm` = tube to that provider ÷ strongest candidate's tube. Lowest score wins, then lowest price, then lowest id |
| Fingerprint | `sha256("spores/fp/v1|epoch|prev_fp_hex|ids|a:b:D|…")`, chained from 32 zero bytes, so each epoch commits to the whole history |
| State hash | `sha256("spores/state/v1|id|epoch|seedhex|age|n:D|…")` per spore |
| Image hash | `sha256("spores/img/v1" ‖ u32 RENDERER_VERSION ‖ u32 512 ‖ u32 512 ‖ RGB)`: raw pixels, so no PNG encoder is in the trust path |
| Arithmetic | Exact 256-bit `mul_div` for every product-then-divide: no overflow for any `q` up to `u128::MAX`, and the same bytes on every target |

### Shipped parameters

| Parameter | Value | Note |
| --- | --- | --- |
| `decay_bps` | 2500 | 25% per epoch without flow |
| `gain` | 1,000,000 | 1.0 on the fixed-point scale |
| `K` | 0.1 NEAR | about one job's price; 0.5 NEAR left honest tubes at the pruning floor |
| `D_min` | 50,000 | an unused tube is pruned 16 epochs after its peak |
| Breadth cap `B` | 4 | a ring of k spores grows at most at (k−1)/4 speed |
| `fee_bps` / `royalty_bps` / `rebate_bps` | 100 / 500 / 5000 | |
| Allowance | base 0.1 NEAR, `trust_gain` 0.2 NEAR per 1000 R | chosen with `sim allowance` (§9) |
| Hiring weight `w` | 4 | chosen with `sim tune` from 72 variants |
| Epoch length | 30 s on router4 | fixed at init |
| `max_active` | 64 | raised from 16 by `set_max_active` |
| `MAX_EPOCH_PAIRS` | 224 | keeps the close event under NEAR's 16 KiB log limit (§3) |

### Tests that pin the math

| Property | Test |
| --- | --- |
| Identical bytes across runs | `epoch::identical_inputs_give_identical_bytes`, `economy::same_seed_same_bytes`; across machines and languages, the shared vectors |
| Zero flow prunes when expected | `graph::zero_flow_prunes_in_expected_epochs` |
| 100× payment ≠ 100× conductivity, reputation or pool weight | `graph::large_payment_is_saturated`, `graph::reputation_prefers_breadth`, `pool::hundredfold_payment_is_not_hundredfold_weight` |
| No overflow at the largest payment | `graph::no_overflow_at_extreme_payments`, `math::mul_div_wide_*` |
| Fee + forwarded = paid; pool shares sum to the pool | `fee::fee_plus_forwarded_is_amount`, `pool::proportional_sums_to_pool_with_largest_remainder` |
| Ledger conserved | asserted every epoch of every sim run; router test over 1,500 random calls (`ledger_is_conserved_under_random_operations`) |
| Wash loops lose money | `pool::capped_rebate_makes_loops_lose_and_spec_rule_does_not`, `economy::shipped_rule_makes_every_loop_lose`, and the sweep (§9) |

## 3. The router contract

`router/` is one NEAR contract (near-sdk 5.30) that owns everything: the 64 NEP-171 spores, a ledger keyed by spore id, policy, job escrow, fees, the epoch close, fingerprints, the market and image commits. The deployed build is 504,207 bytes (sha256 `b82f4dcd…`), and the router pays its own storage.

### Why one ledger, not an account per spore

A desk spike looked at giving each spore its own sub-account and decided against it:

1. **No custody gain.** The router would have to control every sub-account to escrow jobs, move funds and pay fees, so whoever controls the router controls them all, exactly as with the ledger. The risk moves; it doesn't shrink.
2. **Atomicity.** `buy` must settle the NFT, the seller and the royalty all or none, and the ledger must conserve across an epoch. Across accounts every move becomes an asynchronous receipt with a callback and a rollback path.
3. **Policy stays in the router anyway**, because operator keys are function-call keys that can't attach a deposit. The sub-account would be a passive vault.
4. **Gas.** A close would become one cross-contract transfer per active spore.

Cost was not the blocker: global contracts (NEP-591) make a per-spore proxy cheap. The price of the decision is that the NFT doesn't own a real account.

### Interface

| Who | Calls |
| --- | --- |
| Owner (full-access key, from a wallet) | `activate` (deposit, names the operator), `register_operator`, `set_policy`, `pause`, `withdraw`, `list`, `delist`, `nft_transfer`. Anyone may `deposit` to a spore, and anyone but the owner may `buy` it |
| Operator (function-call key) | `post_job`, `quote`, `accept`, `deliver`, `settle`, `reject`, `pay_service` |
| Anyone | `timeout_job`, `close_epoch` (after the epoch ends) |
| Admin | `mint_genesis`, `commit_image`, `withdraw_treasury`, `set_max_active` (raise only) |
| Views | NEP-171/177/181/199 views, `spore_summary`, `render_input`, `edges`, `epoch_info`, `fingerprint`, `glyph`, `image_commit`, `listings`, `get_job`, `list_jobs`, `ledger_totals`, `storage_report`, `config` |

Every state change emits an event (`EVENT_JSON:{"standard":"spores",…}`): lifecycle, ledger, jobs, services, `epoch_closed`, market, `control_reset`, `image_committed`, plus NEP-171 `nft_mint` and `nft_transfer`.

### Policy, enforced in the contract

The owner sets `{paused, budget_per_epoch, max_payment, allow_all_spores, allowlist, external_allowlist (≤ 8)}`. `accept` (when money enters escrow) and `pay_service` check, in the contract:

- the spore isn't paused;
- the payee is allowed (spores through `allowlist`, outside accounts through `external_allowlist`);
- the payment is within the per-payment cap;
- this epoch's spending stays within `min(budget_per_epoch, living allowance)`;
- the balance covers it, and the caller is the spore's current operator.

A refused call fails the transaction with a fixed reason, for example `policy: payment exceeds the per-payment cap`, `policy: epoch budget exceeded`, `policy: payee is not on the allowlist`, `policy: spore is paused`, `caller is not this spore's operator` or `only the spore owner can do this`.

Further details:

- **Pause** blocks `post_job`, `quote`, `accept`, `deliver` and `settle`. `reject` and `timeout_job` stay open because they only return money.
- **Budget is counted at `accept`.** A refund in the same epoch gives the budget back.
- **The operator must differ from the owner**, so "the operator can't withdraw" means something. One operator account can run several spores with one key per spore.
- **Mint and transfer leave a spore locked** (paused, zero budget). Only the owner's `set_policy` unlocks it.

On the protocol side, an operator key is a function-call key bound to the router and limited to the job and payment methods. NEAR refuses such a key on any other method (`MethodNameMismatch`), and refuses it if it attaches any deposit, even 1 yoctoNEAR (`DepositWithFunctionCall`). So it can never call `buy`, `withdraw`, `deposit` or `nft_transfer`. Both refusals were seen on testnet (§8.2).

### Transfer and sale: the NFT is the key

Every owner change, by `nft_transfer` or `buy`, runs `reset_control`: it clears the operator, bumps `operator_gen`, resets policy to paused with zero budget and refunds every job in flight. Balance, tubes, age and history stay with the spore. The router can't delete keys on another account, so the old key is refused because its account is no longer the operator; if a new owner registers that same account again, the key works again.

`buy` takes the listed price as the attached deposit and pays the seller and the royalty in the same call, by two detached transfers. A failed payout goes to the treasury and counts as deposited, so the ledger stays conserved. NEP-199 `nft_payout` reports the same split. Approvals (NEP-178) are not implemented and `nft_transfer_payout` is owner only, so no outside marketplace can sell a spore around the royalty.

### Jobs and payments

1. A consumer posts a job; providers quote; the consumer accepts one quote, which moves the price into escrow after the policy checks.
2. The provider delivers a result hash; the consumer settles (fee taken, provider credited, flow counted) or rejects (refund, tube halved at the close).
3. At the deadline an undelivered job refunds. A delivered job auto-settles: the provider is paid minus the fee, with no flow and no rejection, so a consumer can't get work for free by staying silent.
4. Storage is bounded: 4 unfinished posted jobs per spore, 8 quotes, 256-byte tasks and 128-byte results. Finished jobs are deleted and live on in events.

`pay_service` pays an account outside the graph (our `outside` service) under the same cap and budget, with no fee and no flow. The ledger satisfies `deposited − withdrawn − paid_out = balances + escrow + pool + treasury`, and `ledger_totals` reports `conserved`.

### Epoch close

Anyone can call `close_epoch` once the epoch has ended. It runs `spores_core::close_epoch`, stores the fingerprint and each active spore's latest state hash, and emits `epoch_closed` carrying the **whole epoch input**: the active set, flows, rejections, the pool and the previous fingerprint. That is what lets `verify` rebuild history from close receipts alone.

NEAR caps log text at 16,384 bytes per receipt, and an oversized log fails the close, which would leave the router unable to close again. So since Phase 6 the event logs the tube count rather than the tubes (`verify` replays them), and `accept` refuses a new trading pair once this epoch's pairs plus escrowed jobs reach `MAX_EPOCH_PAIRS` (224). A randomised router test shows a close never names more than 224 pairs: 13,794 bytes at 64 active, with 27-digit amounts.

### Art on chain

The contract can't run the Physarum simulation, so it stores two things per spore: the latest state hash, and an image commit (`commit_image`: epoch, image hash, renderer version), written by the admin after a close. NEP-177 `media` is a small integer-only SVG glyph of the spore's connections, generated from chain state on every read as a `data:image/svg+xml` URI with its `media_hash`. `extra` holds the seed, age, degree, reputation, transfers, sales, state hash and image commit. Traits come from state and aren't rolled.

| Stored | Computed at read | Not on chain |
| --- | --- | --- |
| seed, balance, policy, operator, edges, flows, latest state hash, image commit, every fingerprint | age, degree, R, effective budget, glyph, title | the rendered image, past tubes (only in close events), finished jobs (only in events), decision logs |

## 4. Art: a reproducible Physarum renderer

`renderer/` (`spores-renderer`) turns a spore's seed, age and tubes into a 512×512 image. It has an xoshiro128** PRNG (32-bit, so JS needs only `Math.imul` and shifts), a 4096-angle sine table built by an integer Q60 Taylor series (no libm), a Q8 trail grid, Q16 agents with 3-sensor steering, and an integer tone curve, palette, bloom, grain and vignette. It compiles to a 73 kB wasm with no imports, and `renderer/js/render.mjs` is an independent JS port written separately.

How the picture is set:

- Neighbours sit at fixed slots on a 64-slot ring, and nearer the centre when the tube is stronger.
- Brighter tubes carry more flow, and a nucleus and ring mark each partner.
- The palette (one of five) comes from the seed.
- A dormant spore is a faint mark, and a young one a thin network confined to a disc that grows with its degree.

### Reproducibility

| Check | Result |
| --- | --- |
| Native Rust, arm64 macOS, against `vectors/renderer.json` | 10/10 (trail hash and image hash) |
| Native Rust, x86_64 macOS under Rosetta | 10/10 |
| Native Rust, arm64 Linux in a container | 10/10 |
| wasm32 under Node | 10/10 |
| Independent JS port (its own sine table, PRNG and pipeline) | 10/10, plus the sine-table hash |
| Chrome, in the app | matched a committed image (`✓ image matches commit`) |
| Negative control | One seed bit, `age ± 1` or a 12,000 change in one `D` changes the hash; a change of 1 or 1,000 does not (quantisation) |
| Time per image, one Mac | native 0.2–0.7 s, wasm 0.6–1.0 s, JS 1.2–4.2 s |

Art tests:

- Repeated renders are byte-identical.
- Dormant renders fewer than 600 bright pixels, against 14,792 for a mature spore.
- Adding an edge changes the image, and pruning it restores the original exactly.
- Young renders smaller than mature with the same seed: 12,364 against 22,744 cells. The first attempt failed, at 71%. The fix was confining agents to a growing disc; the test itself was not loosened.

Limits:

- **Not injective.** `D` is quantised to `D/1000`, so the state hash stays the authority and the image hash is an extra commitment.
- **Not yet tested** on a second physical machine, Windows, Firefox or Safari. Nothing uses floats, libm or platform sort order, but that is a reason to expect a match, not a check.
- **Any change to a renderer constant** changes every image hash, so it needs a `RENDERER_VERSION` bump and new vectors.

The renderer departs from SPEC.md's sketch on purpose:

- Its inputs are seed, edges and **age**: R derives from the edges, and the global epoch can't make a young spore look young.
- The image has no text and no brightness from other spores, both of which would break byte-reproducibility or tie a spore's hash to global state.
- The faint-trail mask threshold falls with age rather than rising, reading SPEC's direction as a typo.

## 5. Agents, keeper and the outside service

`agents/` (TypeScript, near-api-js 7.4.0) runs one agent per active spore, as separate processes or many in one, which is how all 64 have run. Agents sign with one function-call key per spore on a shared operator account. **Every money decision goes through `rules.ts`**, the port of `spores-core` checked against the shared vectors, so a run can be replayed from its log. No LLM is used: task content is rule-generated, and each provider's hidden quality is rolled from the run seed.

- **Decision log.** Each hire writes the candidates, quotes, `D`, `D_norm`, scores, the winner and the transaction hashes to `decisions.jsonl`. `sim replay-decisions` re-runs the rule against `spores_core`: 41 of 41 matched in Phase 4, 95 of 95 in Phase 5, and the app re-runs it in the browser.
- **Keeper.** It closes epochs waiting for `FINAL`, sends timeouts and image commits with `EXECUTED_OPTIMISTIC`, attaches 300 Tgas to closes, and starts no timeout within 8 s of an epoch's end. That fix took closes from 66–92 s apart down to 30–47 s against a 30 s epoch.
- **Outside service.** `outside/` is our own paid data service, with no dependencies. It sells only against an on-chain `service_paid` receipt signed by the spore's current operator: 25 sold and 0 refused in Phase 4, and 187 purchases on router4. No listed NEAR partner took per-call on-chain payment, so we built one.
- **Results** travel in a content-addressed directory. Only the hash goes on chain, and the consumer checks the file against it.
- **RPC.** Public testnet RPCs rate-limit; FastNEAR's starts after about 17 requests in a burst. Clients rotate FastNEAR and dRPC with backoff, and helpers compute each transaction's hash locally so they can poll for it after a hung send.

Scenes for the Demo Lab:

- **Rogue** (`scenes/rogue.ts`): the owner narrows a spore's policy, three payments are refused, one is allowed, two closes pass, and the original policy is always restored.
- **Sale** (`scenes/sale.ts`): 11 checks, ending sold.
- **Server.** `scene-server.ts` signs with local keys, so it refuses any non-loopback peer, Host or Origin.

## 6. Verification

`spores-verify` (Rust CLI on core and renderer) needs no keys.

- **`epochs`** reads every `epoch_closed` event from its close transaction, reruns the update rule with the router's own parameters, rebuilds the canonical string and compares its sha256 with the fingerprint in the event and the one stored on chain, epoch after epoch, back to genesis.
- **`image --spore N`** rebuilds that spore's state at the epoch of its committed image, checks the committed state hash, renders the image and compares the image hash.

On router4: 63 of 63 epochs and Spore #6's image match, in about 2 minutes from a clean Linux container.

The app's **Verify** page runs the same comparison in the browser with core-wasm and the renderer wasm. It never reads the close or image cache, so each click recomputes, and it ends on `✓ Match · 63/63 epochs · image matches commit` (95 s on the last try).

Old transactions are only on archival nodes, and those are rate-limited. What each public endpoint did with one old close transaction (2026-11-05):

| Endpoint | Result |
| --- | --- |
| `archival-rpc.testnet.fastnear.com` | 1.2 s, no key, CORS open. Not in the docs' table, where FastNEAR archival is "Paid Only" |
| `archival-rpc.testnet.near.org` | about 4.5 s, then HTTP 429 saying the endpoint is deprecated |
| `test.rpc.fastnear.com`, `rpc.testnet.near.org` | timeouts after 10–30 s |
| `near-testnet.drpc.org` | "Request timeout on the free plan" |
| `near-testnet.lava.build` | HTTP 410, discontinued |

Both archival nodes send their 429 without a CORS header, so a browser sees only `Failed to fetch`, and the app says "unreachable or rate-limited". Both the CLI and the app ask archival nodes first for close transactions and regular nodes first for views. If no archival node answers, the CLI stops with an error naming every endpoint.

## 7. The app

`viz/` (Vite, React, TypeScript) has six areas:

- the landing page;
- the collection gallery, which checks each card's image hash against its `commit_image`;
- the network explorer, which replays history with core-wasm and steps through every logged action;
- the spore page, with owner actions through `@hot-labs/near-connect`, the connector NEAR's docs now recommend;
- the activity log, which re-runs each hire's rule;
- Verify, and the Demo Lab (the loop, rogue, sale and wash scenes).

It reads the chain directly (LIVE), a local run's logs, or a committed recording.

**Provenance is part of the design.** Every view carries its source: `LIVE · testnet`, `LOCAL RUN`, `RECORDED` (with a banner that can't be dismissed) or `SIMULATION` (dashed outline). Values are marked by where they come from:

- `≈` derived in the browser;
- `↻` recomputed and compared;
- `—` unavailable, always with a reason (never `0` or blank).

Receipts climb a fixed ladder, from `○ Logged` to `✓ Confirmed on chain`, and only after the app reads the final outcome itself. A wallet action reports success only after the app reads the final transaction outcome.

Performance, measured 2026-11-07 in Chrome on one Mac (not the 2019 laptop the design names):

| Measure | Budget | Result |
| --- | --- | --- |
| Initial JS, gzip | ≤ 180 kB | 175.0 kB |
| Renderer wasm / core-wasm | 73 kB / ≤ 250 kB | 73.2 kB / 195.0 kB |
| Network map, 224 tubes (the most one epoch can add) | 60 fps | 117 fps |
| Network map, 2016 tubes (every pair) | 60 fps | 111 fps, after a one-layer mode past 400 tubes (18 fps before it) |
| Epoch tween, 2016 tubes | ≥ 50 fps | 94 fps |

A production build served by a plain static file server played the recording in 46.9 s, gave `✓ Match · 63/63 epochs · image matches commit` and opened the wash panel, with no console errors.

The hosted copy, [spores-five.vercel.app](https://spores-five.vercel.app) (Vercel, built locally and uploaded with `vercel deploy --prebuilt`), was checked the same way on 2026-11-07. Deep links load the app, and both wasm files are served as `application/wasm`. The recording played to 14 of 14 checks, and Verify reached `✓ Match · 63/63 epochs · image matches commit` in 94 s. While it ran, the console showed the archival nodes' rate-limit replies as CORS errors (§6); the app retried and finished.

## 8. Testnet evidence

### 8.1 Deployments

All on testnet; admin `deployer.spores-hack.testnet`.

| Router | Use | Wasm sha256 |
| --- | --- | --- |
| `spores-hack-router4.testnet` | **Current.** Phase 5 exit run (14/14) and Phase 6 (64 active), 63 epochs | `b82f4dcd37484fca2b58638aff7d1b939baf882891b2dedb31084de84db2f1c5`. This tree rebuilds to it, and it matches the on-chain `code_hash`. Epochs 1–8 ran on `9d2238e0…` and 9–16 on `640c093f…`, before code-only redeploys; `verify` matches across all three builds |
| `router3.spores-hack.testnet` | Phase 4 exit run (6/6) | `418b3f0c…` |
| `spores-hack-router2.testnet` | Phase 3 exit run (83/83) | `0dc71d70…` |
| `spores-hack-router.testnet` | v0, abandoned in the first Phase 3 run | same code as router2 |

The old routers stay as evidence. NEAR won't delete an account holding more than 10 KB of state, and each holds 37–41 KB.

### 8.2 Contract on testnet: 83 of 83 (router2, 2026-10-31)

A scripted run of every contract rule, one transaction per step. Selected steps:

| Step | Transaction | Result |
| --- | --- | --- |
| Mint 64 spores in 4 calls | `u2Cns9XVKy1r5gmLZDLDK1h6iUSPRiT1wknk1CQ5DDZ` … `xhAF2y2vGV4zHaHBFzi7fG51pdJ1Xhb9E2LKoFWCCu9` | 565 bytes per spore |
| Mint by a non-admin | `733RZVCAwTHKXn21GEXNMmoyk888KRawpQbr9DRZG6LB` | refused: only the admin can mint |
| Activate by a non-owner | `GGaMdebSbJcCAnq9ZrgezjsEwXRJajhFozC8fN8tHCLC` | refused: only the spore owner can do this |
| Operator before `set_policy` | `2qvBHV661xran3ZecBYDqGc5uPiqhoVUnQGnszo4cCtR` | refused: spore is paused |
| Function-call key calls `set_policy` / `withdraw` / attaches a deposit | `CKJoq8F5…`, `7NFZ6DCU…`, `BeLoK42M…` | refused by the protocol before inclusion |
| Operator's full-access key calls `withdraw` | `AvUZjXpc2Y2tXbkVTJcb1ZVT6bM6qaf1PcwxeKmFcwnM` | refused: only the spore owner can do this |
| Over the per-payment cap | `8Av3vXWnEBP5qxBe5AjXA4MEV3Ep9fxMk4f8vhcZs5yu` | refused |
| Payee not on the allowlist | `9m53G7aFo1zBtpPBWDArvRy5b9v7DbqV9kr3fezudfiJ` | refused |
| Over the epoch budget | `51CWywffyzvPsRrBCJ4ZjjgrDxquW3JArCvcaY4ehBsf` | refused |
| While paused | `4y7safDknTwApEXpMneSqvexpZAD57JVvqM4svJoNLtz` | refused; balance and escrow unchanged |
| Close the epoch (anyone) | `7xupQju7iBSbuwnm2rT1QfeZ4XyC7Hm71QwogyrKiqWa` | fingerprint `e9892356…cb96` |
| Close again at once | `3MFB31rEGL1Psriu5aqeUXk8XERd9uWdoZRWkngs343y` | refused: epoch has not ended yet |
| Deliver after the deadline, then `timeout_job` | `FsCcHF3x…`, `F2ZscKng…` | refused, then refunded |
| Transfer spore 0 with a job in flight | `B6Bfk3S67FeQV5EzJdnfzLXV7YnR2REkusGcnjiWG3GE` | job refunded; policy paused with zero budget; tubes, age and reputation unchanged |
| Old operator key, old owner | `3ZoN9WoNw7cgSeXu2RrdDJ7JgpG2Eq25nYsQbhNq2dtd`, `6d8xASC4KECjQhkUEboEGtrP1NrPXvrp1dbUBq94eSS6` | refused |
| Ledger and solvency | view | conserved; storage and ledger covered |

The first image rendered from chain state is `docs/img/phase3-spore0-epoch2.png`. The mocked unit-test runtime doesn't enforce `#[private]` or the payable check, so those were checked here.

### 8.3 Agents trading unattended: 6 of 6 (router3, 2026-11-02)

9 agent processes, the keeper and the outside service ran 8 epochs with no intervention.

- **Hires:** 47 jobs posted, 41 hires, 26 settled, 13 rejected.
- **Tubes:** between 8 and 14 edges per snapshot, with total `D` peaking at 3,851,859.
- **Art:** all 9 spores' image hashes changed between epochs (`docs/img/phase4-spore2-epoch6.png` against `…epoch14.png`).
- **Replay:** `replay-decisions` matched 41 of 41 hires.
- **Outside service:** 25 sales, each against an on-chain receipt (first: `FvtD4M4kLhPdYaSDkz718p5FkXeZ3Cpk1uw1pncs3N5B`).
- **Ledger:** conserved.

Shocks, targeted by value (quality per unit cost):

| Shock | What happened |
| --- | --- |
| Triple the runner-up's cost, epoch 10 | Before: quoted 0.053–0.054 NEAR, won 3 of 3. After: quoted 0.152–0.159, won 1 of 5 (the one hire with no other candidate) |
| Cut the strongest tube, epoch 11 | No more hires on it; `D` fell 25% per epoch: 814,107 → 610,581 → 457,936 → 343,452 |
| Kill the best provider, epoch 12 | Never hired again; consumers moved to four others |

Tubes changed the winner in 9 of the 26 hires with more than one candidate. Two of the three examples examined were then rejected for a wrong answer: a tube records history and doesn't guarantee quality.

### 8.4 A spore sold, with control handed over: 14 of 14 (router4, 2026-11-02)

| Check | Result | Transaction |
| --- | --- | --- |
| Sale with royalty | Spore 5 sold for 0.5 NEAR: 0.475 to the seller, 0.025 royalty | list `3x73GvfiX8v77Hgk7jYpUZaYRiW117aqhmM6x6gwrFnM`, buy `BJUXhpDuHRv5dcfNA7uWQhFLJ6mamxzpeVYRAaoTHjsS` |
| Old operator key refused | "caller is not this spore's operator" | `EhbGawHaoT2bDykHYSu4Qy9Z6Q8naecTkui9B4YreFiv` |
| Old owner refused | "only the spore owner can do this" | `6cLHttRhTw95sa1BBYFNdcjn6ZLGsPp3KfzDbCdcenoq` |
| Control reset | Read at the block before and the block of the buy: operator cleared, `operator_gen` 1 → 2, paused, zero budget, listing cleared | views |
| Spore intact | Balance, five tubes, age 11 and reputation 3467 identical before and after | views |
| New owner takes over | The buyer registered `operator2` and set a policy, and the agent resumed (40 transactions) | `EM7jhdQsViofVu1Gx1YTnnLtZDCAoy4bCFURhjS9npxj` |
| `verify` | 16 of 16 fingerprints and the sold spore's image regenerated | `docs/phase5-closes.txt` |

The same run also passed 95 of 95 hire replays and 72 of 72 image commits.

### 8.5 All 64 spores, and the recorded demo (router4, 2026-11-03 to 11-07)

`max_active` went from 16 to 64 (`set_max_active` `95UsZnqp6nvLLs5bEqDgcYqyWvQdZGnJWJCnJczqZeU3`), and all 64 spores have traded from one agent process.

`bash scripts/demo.sh` from a clean copy (run `demo-20261106T101440Z`, committed as the recording) exited 0:

- 14 of 14 checks and 9 closes, 30–47 s apart.
- `spores-verify` matched all 63 epochs and Spore #6's image.
- Spore #6 hired #11 for 0.1715 NEAR, and the tube went from `D` 0 to 473,807.
- R went from 0.85 to 1.42 and its allowance from 0.270 to 0.384 NEAR; then it was sold for 0.50 NEAR.

The README lists its transactions.

Of five real `demo.sh` runs:

- 2 failed a check: one on a check since replaced, and one because the new agent had only 28 s.
- 1 passed with no settled hire before its sale.

### 8.6 Chain stats and gas (router4, epochs 1–63)

`node scripts/chain-stats.mjs` reproduces the chain rows from public RPC with no keys. The run-log rows count the 14 runs under `out/agents/`, which is git-ignored, so only the recordings are committed.

| Stat | Value | Source |
| --- | --- | --- |
| Settled volume | 18.2523 NEAR | chain |
| Payments settled by the consumer | 214 | run logs |
| Fees | 0.1974 NEAR, above 1% of volume because delivered jobs that auto-settle pay the fee but add no flow | chain |
| Rejected deliveries | 97 | chain and logs agree |
| Pair-epochs with settled flow | 205; busiest close 21 | chain |
| Outside-service purchases | 187; `paid_out` 1.87 NEAR | logs and `ledger_totals` agree |
| Sales | 8 `buy` calls with royalty | logs |
| Ledger | `conserved: true` (2026-11-07) | `ledger_totals` |
| Inclusion to finality | 2.45 s average, 2.33–2.75 s (last 9 closes) | block timestamps |
| Calls | 4,239 logged, 366 failed: mostly late quotes and deliveries, the 4-job limit and deliberate refusals | logs |

Gas per successful call (Tgas):

| Method | Calls | Avg | Max |
| --- | --- | --- | --- |
| `close_epoch`, 9 active | 16 | 6.07 | 6.35 |
| `close_epoch`, 64 active | 47 | 20.66 | 22.32 |
| `post_job` / `quote` / `accept` / `deliver` | 672 / 1,482 / 359 / 330 | 2.99 / 2.65 / 3.21 / 2.67 | 3.26 / 2.92 / 3.58 / 2.93 |
| `settle` / `reject` / `timeout_job` | 214 / 97 / 129 | 3.74 / 3.74 / 3.63 | 4.14 / 4.08 / 4.12 |
| `pay_service` | 187 | 5.82 | 6.19 |
| `commit_image` | 304 | 2.74 | 2.90 |
| `list` / `buy` (both payouts) | 9 / 8 | 2.80 / 12.52 | 2.83 / 14.97 |

Called as transactions, `glyph` costs 2.33 Tgas, and `nft_tokens` for all 64 costs 26.33 Tgas (both measured at 9 active, 19 tubes). That cost grows with the tube count. Rendering an image costs no gas; only `commit_image` does.

### 8.7 Clean copy and test suites (2026-11-07)

A clean export of the tree went into a `node:24-bookworm` container (arm64 Linux, rustc 1.97.0, Node 24), with no `.env`. There:

- renderer `check` gave 10/10;
- `scripts/build-wasm.sh` passed, including both JS checks;
- `demo.sh --playback` served the app and its recording;
- `spores-verify epochs` matched 63/63 in 2 min, and `image --spore 6` matched.

Test suites on macOS:

| Suite | Result |
| --- | --- |
| Rust (`cargo test --workspace`) | 106 passed |
| viz | 484 passed |
| agents | 77 passed |
| outside | 5 passed |
| `cargo clippy --workspace --all-targets` | clean |

## 9. Simulation results

`sim/` runs the same economy under identical seeds and disruptions. Simulated providers have hidden quality, and consumers reject bad results. All money moves through `spores-core`, and floats appear only in hidden quality and metrics.

### 9.1 Does the slime mold help?

Setup:

- 20 seeds, 60 epochs, 16 active spores, 4 services, 3 jobs per consumer per epoch, 2 attempts per job.
- Shocks: the best-value provider is killed at epoch 20, the strongest tube is cut at 30, and the runner-up's cost triples at 40.
- Recovery counts epochs until the rolling success rate is within 3 points of before.

| Mode | Avg price (NEAR) | Failed attempts | Unfulfilled | Hired quality | Recover: kill | Recover: cut | Recover: raise |
| --- | --- | --- | --- | --- | --- | --- | --- |
| price only | 0.0948 | 28.2% | 7.6% | 0.717 | 1.0 | 0.5 | 1.6 |
| tubes, relative, w=1 | 0.1104 | 26.4% | 7.4% | 0.735 | 1.9 | 0.8 | 1.4 |
| **tubes, relative, w=4 (shipped)** | 0.1211 | **25.3%** | **7.1%** | **0.746** | 1.4 | 0.7 | 1.8 |
| tubes, absolute, w=1 | 0.1021 | 28.1% | 7.9% | 0.718 | 1.2 | 0.9 | 0.5 |
| tubes, absolute, w=4 | 0.1083 | 26.9% | 7.7% | 0.730 | 1.9 | 0.3 | 1.1 |
| shipped, without the rejection cut | 0.1151 | 26.2% | 7.4% | 0.738 | 1.4 | 0.4 | 0.3 |
| SPEC's original parameters | 0.1011 | 28.5% | 7.9% | 0.714 | 0.7 | 0.4 | 0.9 |

**Tubes buy a small gain in reliability at a real price.** Failed attempts fall about 10% in relative terms, and the average price rises 28%. Recovery after shocks is not faster. With SPEC's original parameters tubes don't beat price only, so the shipped rule is the result of tuning; the best of 72 variants in `sim tune` reaches 24.5%. In this sim a failure costs only a retry.

### 9.2 Wash trading

Attacker spores pay only each other. One spore alone is refused as a self-payment, so the sweep covers:

- 2 or 3 attacker spores;
- fee 50, 100 or 200 bps;
- K and gain from ½× to 2× their defaults;
- loops of 0.01–5 NEAR per edge per epoch.

Each case runs 40 epochs over 3 seeds, and the worst seed counts: 270 cases in range. **The gate** has two conditions: the attacker loses money, **and** its best spore stays below the honest median reputation.

The shipped rule against SPEC's original rule (16 active, 3 jobs, no allowance):

| Rule | Gate, K in range | Gate, whole grid |
| --- | --- | --- |
| SPEC rule | 37/91 | 145/361 |
| shipped | **270/270** | 355/361 |

The shipped rule with the living allowance the router enforces, by traffic level:

| Honest jobs per spore per epoch | 16 active | 64 active |
| --- | --- | --- |
| 3 | 270/270 | 270/270 |
| 1 (what the testnet agents do) | 255/270 | **168/270** |

Worst cases, shipped, 16 active, 3 jobs, no allowance:

| Spores | Loop (NEAR/edge/epoch) | Worst net (NEAR) | Tube gain per NEAR vs honest | Reputation per NEAR vs honest | Best attacker R / honest median |
| --- | --- | --- | --- | --- | --- |
| 2 | 0.01 | −0.0010 | 1.83 | 8.54 | 0.07 |
| 2 | 0.2 | −0.0300 | 0.29 | 0.63 | 0.19 |
| 2 | 5 | −0.9808 | 0.02 | 0.03 | 0.26 |
| 3 | 0.01 | −0.0031 | 3.68 | 12.12 | 0.22 |
| 3 | 0.2 | −0.0900 | 0.60 | 0.94 | 0.57 |
| 3 | 5 | −2.9423 | 0.04 | 0.04 | 0.78 |

What holds and what doesn't:

- **The attacker loses money in every case, at every traffic level.** That follows from the capped rebate (§2) and is tested.
- **The reputation half fails at low traffic, and that is the live setting.** At 64 active with 1 honest job per spore, the honest median R is about 2. A 3-spore loop of at least 0.2 NEAR per edge per epoch then passes it while losing about 0.2 NEAR over 40 epochs: on a quiet network, reputation can be bought cheaply. The Demo Lab's wash panel opens on this case.
- **Without the allowance,** 64 active with 3 jobs gives 261/270 (all 9 failures at K = 0.2 NEAR with 3-spore loops of 1 or 5 NEAR), and `sim all --max-active 64` exits 1 on it.
- **Tiny loops gain more per NEAR than honest spores.** SPEC's original test, less tube and reputation gain per NEAR, fails in 93 of 270 cases, all at loops of 0.05 NEAR or less. That follows from the concave reputation: the smallest surviving tube gives the most R per NEAR, for everyone. At those sizes the attacker's best spore stays at or below 0.39 of the honest median, which is why the gate replaced that test.
- **Outside the K range,** 6 of 361 cases fail: K = 0.5 NEAR, 3 spores and 5 NEAR loops. The attacker loses 2.9–11.5 NEAR to get just above the median, so K has to stay near the job price.
- **Not modelled:** an attacker who also buys real services from honest spores to raise its breadth.

### 9.3 Choosing the living allowance

20 seeds × 60 epochs, 16 active, owner budget unlimited:

| Base (NEAR) | trust_gain (NEAR per 1000 R) | Unfulfilled jobs | Hires blocked by budget | Wash gate | Worst attacker net (NEAR) |
| --- | --- | --- | --- | --- | --- |
| none | none | 7.1% | 0.0% | 270/270 | −0.0010 |
| 0.05 | 0.1 | 26.9% | 21.3% | 0/270 | −0.0010 |
| 0.1 | 0.1 | 11.4% | 4.7% | 270/270 | −0.0010 |
| 0.05 | 0.2 | 20.9% | 14.8% | 0/270 | −0.0010 |
| **0.1 (shipped)** | **0.2** | 8.6% | 1.6% | 270/270 | −0.0010 |
| 0.2 | 0.2 | 7.5% | 0.4% | 270/270 | −0.0010 |

A tight allowance backfires. With a base of 0.05 NEAR, honest spores starve, their tubes and median reputation fall, and the gate fails 0/270, while attackers trade under the cap by splitting volume. On testnet the shipped allowance binds: in the recorded run 11 of 30 hires were skipped because the quote was above what the spore may spend.

## 10. Where the build departs from SPEC.md

SPEC.md is the design as first written. Every departure, and why:

| Area | SPEC said | Built | Why |
| --- | --- | --- | --- |
| Fee pool | split among active spores by weight | capped rebate, rest to the treasury | With SPEC's rule the attacker's net was positive in all 54 in-range cases with loops of 0.2 NEAR or less; with the cap every loop loses |
| Fee rounding | round down everywhere | fee rounds up | a floored 1% fee is 0 for dust payments |
| Arithmetic | `u128` with overflow checks | exact 256-bit `mul_div` | no overflow at any payment, same bytes everywhere |
| `K` | 0.5 NEAR | 0.1 NEAR | at 0.5 honest tubes sat at the pruning floor while a 3-spore ring reached R ≈ 4 |
| Edge gain | `gain * q/(q+K)` | times `min(breadth, 4)/4` | slows rings of 2–3 spores |
| Rejections | don't count | halve the tube | tubes remember reliability |
| `D_norm` | 0..1 | relative to the strongest candidate | scale-free, and better in the baseline |
| Fingerprint | over epoch, spores, edges | domain tag, version, previous fingerprint | each epoch commits to the whole history |
| Wash criterion | lower gain per NEAR | loses money and stays below the honest median | what selling a spore with faked history would need; the literal test fails for tiny loops (§9.2) |
| Delivered, unsettled job | refund at the timeout | auto-settles with no flow | the refund gave consumers free work |
| Spore accounts | sub-account spike | single router ledger | no custody gain, `buy` would lose atomicity (§3) |
| `max_active` | fixed at init | admin may raise it (raise only) | grew router4 from 16 to 64 |
| State hash | one per close | latest per spore | bounded storage; `verify` rebuilds history |
| Close event | epoch summary | the whole epoch input, tube count only | `verify` needs only close receipts; 16 KiB log limit |
| Trading pairs | unbounded | at most 224 per epoch | keeps the close event under the log limit |
| NEP-177 `media` | the rendered image | the on-chain glyph; image hash in `extra` | nothing hosts the PNGs |
| `commit_image` | "renderer operator" | the admin account | `verify` checks it, the contract can't |
| Approvals | marketplace listing | none; the router's own `list` and `buy` | royalties can't be bypassed |
| Renderer inputs | seed, edges, R, epoch | seed, edges, age; no text | reproducibility (§4) |
| Outside service | a partner's paid API | our own service paid by `pay_service` | no partner takes per-call on-chain payment |
| Agents | may use an LLM for content | rule-based, no LLM; the injection scene is not built | runs replay from the log |
| Names | a name trait | titles are `Spore #N` | not built |

## 11. NEAR facts checked against the docs

API names, versions and limits were read from the current NEAR docs and live testnet before use, not taken from memory. The dated log with sources is [`docs/verify-notes.md`](verify-notes.md). The facts the design rests on:

| Fact | Consequence here |
| --- | --- |
| A function-call key can't attach any deposit, not even 1 yoctoNEAR, and is refused on methods outside its list | Agent keys can never buy, withdraw or transfer, enforced by the protocol |
| A contract can't delete keys on another account | Control after a sale is the registered operator id plus `operator_gen`, not key deletion |
| 16,384 bytes of log text and 100 logs per receipt (protocol 88) | Close event slimmed, and `MAX_EPOCH_PAIRS` set to 224 |
| 1 PGas per transaction | 300 Tgas is plenty for a close at 64 active (about 21 Tgas used) |
| Storage costs 1e19 yocto per byte (100 kB per NEAR) | About 5.4 NEAR for the router; it pays its own |
| NEP-199 payouts aren't in `near-contract-standards` 5.30 | Implemented in the router; the split always sums to exactly the balance |
| A contract can't return a joint promise (testnet refuses what the mocked runtime allows) | `buy` pays by two detached transfers (§12) |
| `env::random_seed_array` is predictable by the block producer | Used only for art seeds, where no money depends on it |
| NEAR's docs now use `@hot-labs/near-connect` for wallets | The app uses it (0.12.0) |
| Old transactions are only on archival nodes, which rate-limit | `verify` and the app ask archival nodes first for closes (§6) |

## 12. Incidents, and what changed because of them

- **A hung RPC call** stalled the first Phase 3 run for 48 minutes after a transaction had already executed. Helpers now compute the transaction hash locally, time out after 60 s and poll by hash. The half-configured router was abandoned for a fresh one.
- **The joint promise in `buy`** passed the mocked runtime and failed on testnet ("Returning joint promise is currently prohibited", `9ZoF7CyM5ykmpvryVQPgWchiWdGEfrjx4EHeWhSBJuuL`). It was fixed with two detached transfers and redeployed code-only. `verify` matches every close across both builds.
- **Slow epochs.** The keeper rendered and committed images on the close path, so epochs took 92–122 s against 30 s. Commits moved off the close path, and timeouts were kept out of the last 8 s of an epoch; epochs now run 30–47 s.
- **Close out of gas at 64 active.** The keeper attached a job call's 10 Tgas to the first 64-active close (`BPzggjwVAKwU9LxAK9Ym7YHHqEaGJG1ix329UeNR9avN`, state unchanged). It now attaches 300 Tgas, and the close burns about 21.
- **An accidental run on router3**, caused by a `--help` check that started a real run, added 3 closes to the Phase 4 router after its evidence was taken. The Phase 4 transactions are unchanged, and `run.ts` now refuses unknown options.
- **Balances drain** through fees, the treasury share and the outside service. Agents now skip a hire when the balance is below the quote, and `demo.sh` tops spores up before a run.
