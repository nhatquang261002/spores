# Phase 4: agents, outside service, decision log

Status on 2026-11-02. Every Phase 4 item in ROADMAP is built. The exit run passed on testnet: 8 epochs unattended, 6 of 6 checks (`out/agents/phase4-exit1/report.md`, copied to `out/phase4/`).

| Exit criterion (ROADMAP) | Result | Evidence |
| --- | --- | --- |
| Agents trade unattended for several epochs | 9 agent processes, keeper and outside service ran 8 epochs (6 to 14) with no intervention. 47 jobs posted, 41 hires, 26 settled, 13 rejected, 2 accepts failed on balance | epoch closes `D5HU3ucL…` … `HXSiwiqP…` (all 8 in `events.jsonl`) |
| Tubes form | Edges per snapshot: 8, 9, 12, 14, 14, 11, 9, 10, 12. Total D rose from 1,219,773 to a peak of 3,851,859 and ended at 3,092,492 | `snapshots/`, report |
| The rendered art changes between epochs | All 9 spores' image hashes differ from epoch to epoch; spore 2: `4374b954…` (epoch 6) to `2757693e…` (epoch 14) | `docs/img/phase4-spore2-epoch6.png`, `docs/img/phase4-spore2-epoch14.png` |
| Decision log per hire | 41 lines in `decisions.jsonl`: candidates, quotes, D, D_norm, score, winner, tx hashes. `spores-sim replay-decisions`: 41 match, 0 differ | first settled hire: post `9sWPJqgq…`, accept `8LiRQ8C6…`, settle `38xhkVPE…` |
| Outside service | Our own service (§6.4 option 2): 25 sold, 0 refused, every sale against an on-chain `service_paid` receipt | first sale `FvtD4M4kLhPdYaSDkz718p5FkXeZ3Cpk1uw1pncs3N5B` |
| Shock commands | Raise at epoch 10, cut at 11, kill at 12; effects below | `events.jsonl` (`kind: shock`) |
| Ledger | `ledger_totals().conserved == true` at the end (deposited 3.6, paid out 0.37, balances 2.52, escrow 0.68, treasury 0.023 NEAR) | report |

Explorer: `https://testnet.nearblocks.io/txns/<hash>`. Router: `router3.spores-hack.testnet`, admin `deployer.spores-hack.testnet`, wasm sha256 `418b3f0cbd9fe11eb04a071f1369ab92a078ea9bc1bc640468656f16b80d6425` (`non-reproducible-wasm` build; the source in this tree rebuilds to the same hash).

## Reproduce

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --workspace && cargo clippy --workspace --all-targets
(cd agents && npm ci && npm test) && (cd outside && npm test)
bash scripts/phase4-setup.sh          # idempotent; creates router3 + outside, mints, activates 0-8, adds keys to .env
bash scripts/phase4-testnet.sh        # about 6 min; writes out/agents/<run>/ and out/phase4/
cargo run --release -p spores-sim -- replay-decisions out/phase4/decisions.jsonl
node agents/src/shock.ts out/agents/<run> kill 4     # manual shocks during a run: kill <id> | raise <id> <x> | cut <a> <b>
```

`.env` needs the Phase 0 role keys. Setup appends `PHASE4_ROUTER_ACCOUNT_ID`, `PHASE4_ROUTER_PRIVATE_KEY`, `OUTSIDE_ACCOUNT_ID`, `OUTSIDE_PRIVATE_KEY`, `SPORE_<0..8>_FC_PRIVATE_KEY`, `KEEPER_ACCOUNT_ID` and `KEEPER_FC_PRIVATE_KEY`. Keys are written, never printed.

## What was built

- **Shared rules in `spores-core`.**
  - `core/src/market.rs`: `quote_price`, `next_margin`, `job_service` and the margin constants, moved out of `sim`.
  - `core/src/rng.rs`: the SplitMix64 RNG and `stream`.
  - `hiring::SHIPPED_W_BPS` and `SHIPPED_NORM`.
  - `sim` now calls these functions. Its output (`baseline.json`, `sweep.json`, `sweep-full.md`, `phase1-report.md`, console) and `vectors/core.json` are byte-identical to before the move.
- **`vectors/agents.json`.** Written by `spores-sim vectors`. Covers RNG streams, `d_norm`, `score`, `pick` (ties included), `quote_price`, a `next_margin` sequence that hits both bounds, and `job_service`. The TypeScript port must match it value for value.
- **`spores-sim replay-decisions FILE`.** Re-runs `spores_core::hiring::pick` and recomputes D_norm and score for every logged hire. It exits non-zero on any mismatch.
- **Router (`router/src/service.rs`, `jobs.rs`, `types.rs`).**
  - `pay_service(spore_id, payee, amount, memo)`.
  - `Policy.external_allowlist` (`#[serde(default)]`, at most 8).
  - A `paid_out` counter in `ledger_totals` and `storage_report`.
  - Auto-settle of delivered jobs in `timeout_job`.
  - `check_payment` is split into `check_limits` and `charge`, so jobs and service payments share the cap, budget and balance rules.
  - 20 contract tests, 4 of them new. The random ledger test now runs 1,800 calls, including service payments, failed service transfers and auto-settles.
- **`agents/` (TypeScript, near-api-js 7.4.0, Node 26 runs `.ts` directly).**
  - `rules.ts`: BigInt port of the core rules.
  - `near.ts`: signs locally with the nonce tracked in-process and a cached block hash, sends `send_tx`, and has the hung-RPC guard from `scripts/near-lib.sh` (hash computed locally, 60 s timeout, then poll by hash). It rotates RPC endpoints.
  - `services.ts`: three simulated services (price data, summarizer, classifier), with seeded tasks, a solver, and hidden provider quality.
  - `agent.ts`: one process per spore. It quotes, hires, delivers, settles or rejects, buys from the outside service, and goes idle if it loses control.
  - `keeper.ts`: closes epochs, times out jobs, and snapshots chain state after each close.
  - `shock.ts`: the shock commands.
  - `run.ts`: the one-command run, with renders, report and exit checks.
  - `setup.ts`: idempotent testnet setup.
  - 12 tests.
- **`outside/`.** Our own paid data feed, `GET /offer` and `POST /redeem`, with no dependencies. `receipt.ts` is a pure receipt check with 5 tests: replayed nonce, wrong payee, underpayment, non-operator signer, and forged, foreign or failed transactions.
- **Scripts.** `scripts/phase4-setup.sh` and `scripts/phase4-testnet.sh`.

## Shocks in the exit run

Targets follow sim. Value is quality per unit cost, computed from the run seed.

| Shock | Target | What happened |
| --- | --- | --- |
| Raise ×3, epoch 10 | Spore 3, the runner-up by value (cost 0.045 NEAR, quality 58.9%) | Before: quoted 0.053-0.054 NEAR and won 3 of 3. After: quoted 0.152-0.159 NEAR and won 1 of 5, the one hire with no other candidate |
| Cut, epoch 11 | Tube 5-6, the strongest at that moment | No hire between 5 and 6 after the cut. D fell 25% per epoch with no new flow: 814,107 → 610,581 → 457,936 → 343,452. It is still above `d_min`, and needs about 7 more epochs to be pruned |
| Kill, epoch 12 | Spore 1, the best by value (cost 0.042 NEAR, quality 75.2%) | The process stopped. Spore 1 was never hired again; consumers went to 0, 2, 4 and 7 |

## Numbers worth stating plainly

- **Tubes changed the winner** in 9 of the 26 hires that had more than one candidate: the winner was not the cheapest quote. Two of the three examples above were rejected for a wrong answer, so a tube is no guarantee of quality, only of history. This fits the open Phase 1 decision (tubes trade price for reliability).
- **Rejections:** 13 of 39 deliveries (33%). Hidden quality runs from 50% to 98%. Spore 6 alone was rejected 4 times.
- **Throughput.**
  - Each consumer keeps one job in flight. A job cycle (post, wait for quotes, accept, deliver, settle) took about 40-60 s. Epochs took 31-68 s of wall time (the keeper closes at least 1 s after `ends_ns`).
  - So 47 jobs were posted in 8 epochs, not 72.
  - Hires per epoch fell from 12 to between 1 and 6. Part of that is the cycle time; part is balances. Spores 5 and 8 ended at 0.06 NEAR, after 2 accepts failed on balance.
  - Money leaves the spores through fees, the treasury share, and the outside service (0.01 NEAR per purchase, about every third epoch per spore).
- **In flight at stop:** 0.68 NEAR was still in escrow when the run stopped. Anyone can call `timeout_job` on those jobs: undelivered ones refund the consumer, delivered ones auto-settle.
- **Auto-settle on testnet:** 1 delivered job was auto-settled by the keeper (`timeout_job` on job 24, `3FiwACR5…`).
- **Failed calls:** 14 of 346. 8 quotes landed after the job closed, 4 deliveries came after the deadline, and 2 accepts hit insufficient balance. No call failed on gas or keys.

Gas per call on testnet (successful calls, Tgas):

| Method | Calls | Avg | Max |
| --- | --- | --- | --- |
| post_job | 47 | 2.88 | 3.06 |
| quote | 119 | 2.54 | 2.72 |
| accept | 42 | 2.94 | 3.12 |
| deliver | 41 | 2.57 | 2.73 |
| settle | 26 | 3.54 | 3.73 |
| reject | 13 | 3.50 | 3.72 |
| timeout_job | 10 | 3.54 | 3.69 |
| pay_service | 26 | 5.69 | 5.77 |
| close_epoch (9 active) | 8 | 4.01 | 4.90 |

## Deviations from SPEC and ROADMAP, and decisions

1. **Auto-settle at the deadline.** This replaces Phase 3 deviation 4, as decided with the team. `timeout_job` on a Delivered job pays the provider minus the fee, and emits `job_settled` with `"auto": true`. It adds no flow and no reject. SPEC §6.2 is updated.
2. **`pay_service` and `external_allowlist`** (SPEC §6.4 option 2 and §7.1 are updated).
   - It charges no fee and adds no flow: the payee is outside the graph.
   - It counts against the same per-payment cap and epoch budget as jobs.
   - Money paid out is tracked as `paid_out`, so conservation is `deposited - withdrawn - paid_out == balances + escrow + pool + treasury`.
   - A failed transfer restores the balance and the budget (`service_payment_failed`).
3. **Router account.** It is `router3.spores-hack.testnet`, a sub-account the parent can create, not `spores-hack-router3.testnet` as the plan said. Router2 stays as the Phase 3 evidence.
4. **Funding.** As agreed, 4.5 NEAR was moved out of router2's surplus (`BDRTurMR…`; it stays solvent: 6.45 NEAR against 4.74 NEAR storage plus 0.95 NEAR ledger). Another 2.0 NEAR came from the deployer (`5CSJTpgd…`) and 1.3 NEAR from the buyer (`46C1uTux…`), both to the owner. Each spore was activated with 0.4 NEAR.
5. **Keys.** There is one function-call key per spore on the shared operator account, because separate processes cannot share an access key's nonce. Each key is limited to the router; methods `post_job, quote, accept, deliver, settle, reject, timeout_job, pay_service`; 1 NEAR allowance. The allowance is charged at the gas buy price and credited back on refund (docs.near.org access keys), so 10 Tgas per call holds very little of it. The keeper key is on the deployer account, limited to `close_epoch, timeout_job`.
6. **Margin "wins" are counted at hire (accept).** Sim counts them at a successful settle. A provider cannot see whether its delivery was settled or rejected without reading events.
7. **Hidden quality is integer basis points** (5000-9800), and the correctness roll is `stream(seed, job_id)`. Sim uses floats (0.5-0.98) and a per-attempt roll. Neither is a money decision.
8. **Cut is behavioural.** The router has no method to delete a tube. Cut pairs stop trading, and an in-flight delivery between them is rejected. The tube then decays 25% per epoch, so it falls more slowly than sim's cut to zero.
9. **Results travel off-chain** in a content-addressed directory (`out/agents/<run>/results/<sha256>.json`). Only the hash goes on chain, and the consumer checks the file against it. That ties all agents to one machine. A networked result store is Phase 6 or later.
10. **RPC.**
    - FastNEAR's public testnet RPC rate-limits after a burst of about 17 requests. The first smoke run lost 38 of 50 calls to `-429`.
    - Clients now rotate between FastNEAR and dRPC (`near-testnet.drpc.org`, listed on docs.near.org/api/rpc/providers), and retry with backoff.
    - Agents wait for `EXECUTED_OPTIMISTIC`; the keeper and setup wait for `FINAL`.
11. **Task content is rule-generated.** No LLM is used in Phase 4. The injection scene with an LLM agent is Phase 6.
12. **Fixed after the exit run, not covered by it:**
    - An epoch change dropped a consumer's queued retry after a rejection. Fixed in `agent.ts` `onNewEpoch`.
    - The doc comment on `Job.deadline_ns` (`router/src/types.rs`) still says a timeout refunds the consumer. It stays until the next deploy, because the comment is embedded in the wasm ABI and changing it would change the deployed hash.
13. **Smoke runs on the same router** (`smoke1`-`smoke3`, epochs 1-5) came before the exit run. Their state carried over: the exit run starts at epoch 6 with 8 edges.

## Open for the team

- The throughput limit (one job in flight per consumer, cycle longer than an epoch) is fine for the demo. Running two jobs in parallel per consumer is possible, but it doubles the RPC load.
- The spores' balances drain over long runs: the outside service, fees and the treasury share all take money out. The fast-epoch demo (Phase 6) needs either larger deposits or an owner top-up step.
