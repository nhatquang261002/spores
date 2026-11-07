# Spores: Spec

Status: design only. Everything runs on **testnet**. Anything marked **VERIFY** must be checked against the current NEAR docs before it is built; do not trust this file or model memory for API names, versions or addresses.

## 1. Idea

Spores is an NFT collection of living slime molds. Each spore starts out dormant. Give it an agent and it starts trading services with other spores, and every settled payment thickens a tube between the two spores, as flow thickens tubes in the slime mold *Physarum*. Tubes with no traffic decay. The image of each NFT is the real picture of that spore's trading network, drawn from on-chain state. It grows, shrinks and changes as the spore lives, and anyone can regenerate and check it.

The NFT is also the key. Whoever holds it controls the agent, owns the money the agent earns, owns the spore's history, and holds the right to use the spore's access. The spore's history also sets how much its agent is allowed to spend, so the art is a credential as well as a picture.

## 2. Focuses and priorities

| Focus | Weight | Tracks | Done when |
| --- | --- | --- | --- |
| **C. Spores: NFT, art, market** | ~40% | `nfts` | A spore is activated, grows through real trades, is sold on the market with a royalty, and its art regenerates identically from committed state (image hash matches) |
| A. Agents | ~25% | `agents`, `swarms` | Agents trade unattended, and a baseline run shows what tube weighting changes |
| B. Policy | ~20% | `security` | Rogue, injected and wash-trading attacks are rejected or shown to lose money, on-chain |
| README, video, submission | ~15% | - | A judge can follow the README end to end |

Order: graph core, `sim` and wash-trading analysis; router with spores; renderer; agents; policy and living allowance; market and gallery.

## 3. Closed loop and removal test

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

Re-check at the end of the build; drop any track whose feature fails its test:
- No NFT: the agent has no owner, the money has no holder and the art has no home.
- No tube-weighted hiring: the art is decoration and history has no value.
- No living allowance or policy: an owner cannot safely let an agent spend.
- No market: the spore's value never meets a price.

## 4. Components

| Component | Kind | Responsibility |
| --- | --- | --- |
| `router` | NEAR contract (Rust, **VERIFY** SDK) | Spore NFTs (NEP-171), ledger, policy, job escrow, fee, flow, epoch close, graph update, fingerprint, market, state hash, glyph, image-hash commits |
| `agents` | Off-chain processes (TypeScript or Python) | Each runs one active spore's operator account and key; bids, delivers, pays |
| `outside` | Paid service (6.4) | Something agents buy that is not another agent; sells only to active spores |
| `sim` | Off-chain simulation of the economy | Tunes parameters, produces the baseline and the wash-trading analysis |
| `renderer` | Fixed-point Physarum renderer (Rust/WASM) | Turns spore state into the image; shared by `viz` and `verify` |
| `viz` | Web page (reworked `slime-router.html`) | Live network, decision log, receipts, collection gallery, market |
| `verify` | Script | Replays an epoch from chain history and checks the fingerprint; regenerates an NFT image from state and compares |

## 5. Focus C: Spores

### 5.1 Collection and lifecycle
- **Supply:** a fixed collection, 64 by default (**VERIFY** storage cost), minted at genesis to accounts chosen by the deployer. Supply is fixed, which limits how many spores an attacker can hold.
- **Seed:** each spore gets `seed = sha256(token_id || mint_randomness)` (**VERIFY** the contract randomness API). The seed sets the spore's hue and its starting pattern, so no two begin alike.
- **Dormant:** a spore has no operator, no edges and no spending power. It renders as a faint dormant mark.
- **Activate:** `activate(spore, operator)` by the owner, with a minimum deposit, registers the agent's operator account and starts the spore's life.
- **Alive:** settled payments grow tubes; the art changes each epoch.
- **Die back:** tubes with no flow decay to zero, so a neglected spore shrinks back toward dormancy. It stays owned and can be revived.

At most 16 spores are active at once in the demo (120 possible edges); the rest of the collection stays dormant.

### 5.2 What a spore grants

| Right | How it works |
| --- | --- |
| **Control** | The owner sets policy, registers the operator account whose key the agent runs on, pauses and revokes. Owner only. |
| **Money** | Payments between spores are entries in the router's ledger keyed by spore id. The balance is the agent's earnings. `deposit(spore)` funds it; `withdraw(spore, amount)` is owner-only. |
| **History** | Tubes are keyed by spore id, not by account. Connections, reputation, age and name stay with the spore when sold. |
| **Allowance** | The spore's reputation sets its agent's spending ceiling (7.2). |
| **Access** | The outside service sells only to active spores and checks the current operator through a router view. |
| **Royalties** | Resales on the market pay a royalty to the royalty account (5.4). |

### 5.3 Transfer semantics
Spore NFTs use the standard NEP-171 transfer methods (**VERIFY** requirements), implemented in the router so transfer can run extra logic. On transfer:
1. The operator registration and key authorization are cleared (key generation counter increments). The old operator key stops working immediately.
2. Policy resets to paused with zero budget. The new owner sets policy and registers an operator before the agent can spend.
3. Balance, tubes, reputation, age and name stay with the spore; withdraw rights move to the new owner.
4. Jobs in flight are refunded to their payers, so a sale cannot strand or steal an open job.

### 5.4 Market and royalties
- `list(spore, price)`, `delist(spore)` and `buy(spore)`. A buy settles atomically in one call: NFT moves, seller is paid, royalty is paid, transfer semantics (5.3) run.
- `royalty_bps` (start at 500) goes to the royalty account. Check NEP-199 payout support so external marketplaces can honor it (**VERIFY**). Built (Phase 5): the royalty account defaults to the admin; seller and royalty are paid from the buyer's attached deposit by two detached transfers (NEAR forbids returning a joint promise), and a failed payout goes to the treasury. `nft_payout` reports the same split; with approvals off, `nft_transfer_payout` is owner only, so royalties are enforced by `buy`.
- Listing freezes withdrawals and pausing for that spore until it is delisted or sold, so a spore cannot be emptied just before a sale.
- `spore_summary(spore)` is a read-only view for buyers: balance, reputation, age, active connections, current policy.

### 5.5 Art
The visible image is a slime mold render: a dark background, a glowing organic network grown by an agent-based Physarum simulation, and a palette chosen per spore. Because a contract cannot run that simulation, the art has two layers.

**Visible image (rendered off-chain, deterministic):**
- A renderer runs the simulation in fixed-point integer math with a fixed PRNG and fixed sine/cosine tables, compiled once (Rust or WASM) and used by both the viz and `verify`. The same state must give byte-identical output on every machine.
- **Inputs, all from chain state:** the spore's seed, its edge list with conductivities, its reputation and the epoch.
- **Layout:** each neighbor sits at an angle set by its id on the collection ring, and nearer the centre when its tube is stronger.
- **Growth:** food strength at each neighbor follows tube strength; agent count and step count scale with degree, so a young spore renders as a thin, unfinished network and a mature one as a branched, looping one. Tubes that carry more flow render brighter, from dark through the palette's mid tones to its accent and finally pale at busy hubs. Faint trail below a threshold that rises with age is masked, so a young spore reads small (tune in the renderer spike).
- **Dormant:** a single faint mark with no network.
- **Palette:** one of five (yolk, ember, violet, toxic, aqua), derived from the seed, so the collection varies at a glance. The palette is part of the seed and does not change as the spore grows.
- **Details:** a bright nucleus at the spore, a glowing ring on each trading partner, sparse dust and a thin frame, all deterministic from state and seed; film grain uses the seeded PRNG.
- **Ring:** the 64 collection positions are drawn as dots, brighter for active spores.

**On-chain proof layer:**
- At each epoch close the contract stores the spore's state hash. A renderer operator commits `image_hash` for that state with `commit_image(spore, epoch, image_hash, renderer_version)`. Built (Phase 5): only the latest `(epoch, state hash)` per active spore is stored (`spores_core::state`); older ones follow from the `epoch_closed` events, which carry each epoch's full input. The renderer operator is the admin (the keeper's key).
- `verify` recomputes the image from state and compares it with the committed hash. The contract guarantees the state; it does not itself check the image, so the README says the image hash is committed by the project's renderer and is checkable by anyone.
- The contract also generates a small vector glyph (an SVG of the spore's edges as straight lines on the ring, integers only) into the metadata, so a minimal verifiable picture exists fully on-chain (**VERIFY** view gas limits).

**Common to both:**
- **Earned traits** in the metadata, computed from state and not rolled: degree, age in epochs, reputation tier, peak reputation, number of epochs sold through.
- **Name:** derived from the hash of the spore's neighborhood and a frozen syllable table.
- **Gallery:** the viz draws the whole collection on the same ring with all tubes, so the collection looks like one living mycelium.
- **Metadata:** `media` points to the renderer's image with its hash; wallets and marketplaces that cannot load it still show the on-chain glyph (**VERIFY** how marketplaces read metadata). Built (Phase 5): until the viz hosts the renders, `media` is the glyph as a `data:image/svg+xml;utf8,` URI with `media_hash`, and the committed image hash is in `extra`.

**Spike (day 4, half a day):** port the simulation to fixed-point and check byte-identical output across two machines and across Rust and JS. If it cannot be made reproducible in time, ship the on-chain vector glyph as the image and keep the slime render as the gallery's presentation layer, and say so in the README.

### 5.6 Spore accounts (spike)
Time-boxed to half a day on days 3-4: give each active spore a real NEAR sub-account whose keys are controlled by the router, so the NFT transfers a real account and funds and the single-ledger risk shrinks (**VERIFY** that a contract can control a sub-account's keys safely, and the storage and gas cost). Go if all tests in section 11 still pass; no-go keeps the ledger. The README states whichever design shipped.

### 5.7 Methods (sketch)
`mint_genesis`, NEP-171 transfer and views, `activate`, `set_policy`, `register_operator`, `pause`, `deposit`, `withdraw`, `post_job`, `quote`, `accept`, `deliver`, `settle`, `reject`, `list`, `delist`, `buy`, `spore_summary`, `close_epoch`, `is_operator`.

## 6. Focus A: Agents

### 6.1 Roles
Price data, summarizer, classifier, scraper, translator, result checker and a broker who resells bundles. One per active spore. Services are small and cheap; the point is the payments.

### 6.2 Job lifecycle
1. Consumer posts a job; providers quote.
2. Consumer accepts a quote: the payment moves into router escrow.
3. Provider delivers with a result hash.
4. Consumer settles or rejects before a timeout. Settling takes the fee and credits the provider. Rejecting refunds the consumer. At the timeout, a job not yet delivered refunds the consumer; a delivered job the consumer never settled or rejected is auto-settled (fee to the pool, the rest to the provider), so a consumer cannot keep a result for free (changed in Phase 4, `docs/results.md`).

Only explicitly settled jobs count as flow; an auto-settled job pays but grows no tube.

### 6.3 Decision rules (no fixed script)
- **Provider:** quote = `cost * (1 + margin)`. Margin rises after a win streak and falls after losses, within bounds.
- **Consumer:** picks the provider with the best score:

```
score = quote / (1 + w * D_norm)
```

  `D_norm` is the tube between consumer and provider divided by the consumer's strongest tube among the candidates (0..1), so the rule does not depend on the absolute scale of flows. `w = 4` (tuned in `sim`, `docs/results.md`). Strong tubes lower the effective price; price competition stops any tube locking in forever. Ties go to the lower price, then the lower spore id.
- Task content may use an LLM. Every money decision uses the rules above, so a run reproduces from its log.
- **Decision log:** each hire records candidates, quotes, tube strengths and the winner, shown in the viz.

### 6.4 Outside service (**VERIFY** all)
At least one service that is not another agent, paid in NEAR through the router. In order of preference:
1. A partner API that accepts on-chain payment (check NEAR AI Cloud and the listed partners, including Agent Market (`docs.market.near.ai`, where agents are listed, hired and paid per job) and OutLayer; it may bill by account or API key and not per on-chain call).
2. A small service we run that checks the router's `is_operator` view, then returns data after verifying a settled-payment receipt. Say in the README that we run it.

Shipped: option 2 (`outside/`, Phase 4). No listed partner takes per-call on-chain payment (`docs/verify-notes.md`). Agents pay it with the router's `pay_service(spore_id, payee, amount, memo)`, which checks the payee against the owner's `external_allowlist` and the same cap and epoch budget as a job, transfers the NEAR and emits `service_paid`; the service delivers only against that event (`docs/results.md`).

### 6.5 Proving the tubes matter
Run the same economy under identical seeds and disruptions in two modes: price only, and price with tubes. Providers in `sim` have hidden quality, and consumers reject bad results. Report average price paid, failed jobs, quality of delivered results and epochs to recover after a shock. Report every result even if tubes do not win; if they do not, change the rule and rerun before the demo. Build `sim` first (days 1-3) and tune `w`, `gain`, `decay_bps` and the margin rules there, before any contract exists.

### 6.6 Shock controls
Scripted commands to kill an agent, cut a tube and raise a provider's price. The demo shows the network rerouting and the art changing over the following epochs.

## 7. Focus B: Policy

### 7.1 Owner policy
Set by the spore owner, enforced in the router, not in agent code:
- Budget per epoch; payments beyond it revert.
- Counterparty allowlist: other spores (`allow_all_spores` or `allowlist`) and approved external payees (`external_allowlist`, at most 8 accounts, used by `pay_service`). A transfer resets both.
- Per-payment cap.
- `pause(spore)`, owner only.
- Operator keys are function-call access keys limited to the router's job and pay methods with an allowance, never full-access keys (**VERIFY** access key limits).
- Secrets in environment variables only; `.env` in `.gitignore`; no keys, seed phrases or personal-data payloads in the repo.

### 7.2 Living allowance
The owner's budget is a request, not a grant. The effective per-epoch budget is:

```
effective = min(owner_budget, base_budget + trust_gain * R)
```

`R` is the spore's reputation (8.2), and `trust_gain` is per 1000 of `R` (one tube at `D = 1.0`). Shipped: `base_budget` 0.1 NEAR, `trust_gain` 0.2 NEAR, from `spores-sim allowance`; a 0.05 NEAR base starved honest spores until a wash ring out-ranked their median (`docs/results.md`). A new spore starts at `base_budget`, which is small. A spore with broad, sustained flow earns a higher ceiling, and a neglected one loses it as its tubes decay. A buyer pays for that ceiling when buying a spore with history.

### 7.3 Demo scenes
- **Injection:** a real LLM-driven agent is given a job whose description tells it to send funds to an attacker. For a reproducible run the agent is configured as a deliberately naive one, and the README labels it so. The router rejects the payment regardless of what the model does, and the failed receipt and the model's output are both shown. Include a recorded run, and record honestly whether the model complied.
- **Rogue:** a scripted agent attempts an over-budget payment and a payment to a non-allowlisted account. Each fails on-chain and the spore's tubes decay, so its art visibly shrinks.
- **Sale:** a spore is listed and bought. The old operator key's next call fails, the new owner's policy starts paused, balance, tubes and age are still there, the royalty is paid, and the new owner configures an operator and the agent resumes.
- **Wash trading:** see section 9.

README must list what policy does not cover (compromised owner key, malicious allowlisted payee, router bugs).

## 8. Core mechanics

### 8.1 Graph model (on-chain, integer math)
Nodes: active spores. Edges: unordered pairs. Per-edge conductivity `D`, fixed point, scale 1_000_000. Per epoch, for each edge with settled volume `q` (yoctoNEAR, both directions):

```
D' = D - D * decay_bps / 10000 + gain * q / (q + K) * min(breadth_a, breadth_b, B) / B
D' = D' - D' * reject_bps / 10000      (once per rejected delivery on the edge, at most 64)
```

- `q / (q + K)` saturates, so one large payment cannot dominate.
- `breadth` is the number of distinct counterparties with a live tube or settled flow this epoch. With `B = 4`, a wash ring of k spores (breadth at most k-1) grows tubes at 1/4 (k=2) or 1/2 (k=3) speed.
- A rejected delivery halves the tube (`reject_bps = 5000`), so tubes remember reliability, not just past hires.
- Edges with `D' < D_min` are pruned to 0. Tubes decay even in an epoch with no flow.
- No floats. Division rounds down, except the fee, which rounds up. Edges iterate in ascending numeric order of `(a, b)` with `a < b`, so every run gives identical bytes.
- Every product-then-divide uses an exact 256-bit `mul_div`, so no payment up to `u128::MAX` overflows (tested).

Shipped values (tuned in `sim`, `docs/results.md`): `decay_bps = 2500`, `gain = 1_000_000`, `K = 0.1 NEAR` (about one job's price; 0.5 NEAR left honest tubes at the pruning floor), `D_min = 50_000`, `B = 4`, `reject_bps = 5000`. The code is `core/` (`spores-core`).

### 8.2 Reputation
`R_i = sum over edges e of spore i of isqrt(D_e)` in fixed point. The square root rewards many distinct connections over one heavy connection. `R` sets the body size in the art, the living allowance and the summary. Hiring uses the pairwise `D`, not `R`.

### 8.3 Fee pool
The router takes `fee_bps` (start at 100, rounded up) of each settled payment into the epoch pool. At close each active spore with weight `w_i = sum over edges of spore i of q_e / (q_e + K)` (saturated flow, not raw flow) is credited a rebate of `w_i * K * fee * rebate_bps / 2` (`rebate_bps = 5000`); the rest of the pool goes to the treasury. An empty epoch distributes nothing.

Why not split the whole pool by weight, as first written: fees per unit of weight are always at least `fee * K / 2`, so a loop of small payments earned more from the pool than it paid (attacker net positive in every small-loop sweep case). With the cap, the two ends of an edge with volume `q` get back at most `fee * q * K / (q + K) < fee * q`, so a loop always loses money, and the rebates never exceed the pool.

### 8.4 Fingerprint
Canonical string: `spores/fp/v1|<epoch>|<previous fingerprint hex>|<active ids ascending, comma-separated>|<a>:<b>:<D>|...` with edges sorted by (a, b), zero edges omitted, genesis previous fingerprint = 32 zero bytes. `fingerprint = sha256(canonical)`, stored on-chain per epoch; chaining makes each epoch commit to the whole history. Shared vectors: `vectors/core.json`. Anyone can replay an epoch's settled payments, rerun 8.1 and compare; `verify` does this.

### 8.5 Epochs
Length is block-timestamp based: 10 minutes normally, about 30 seconds in demo mode. `close_epoch()` is callable by anyone after the duration.

## 9. Wash-trading defense

Attack: a holder of one or more spores pays their own spores in a loop to inflate tubes, reputation, allowance and fee-pool share, which would also fake the art.

Defenses, all in the contract:
- Every settled payment costs the fee.
- Saturation (`q / (q + K)`) caps what a single edge can contribute to tubes and to pool weight.
- Reputation uses `isqrt` over edges, so pumping one pair adds little.
- Supply is fixed, so an attacker's number of distinct counterparties is bounded by the spores they own.
- Only settled jobs with a delivery count.

Receipts and escrow do not stop an attacker who controls both sides; the defense is economic, and the README says so.

Acceptance criterion, checked in `sim` and again on testnet: for an attacker holding 1 to 3 active spores, across a sweep of `fee_bps`, `K`, `gain` and loop sizes around the defaults, the attacker's net result (pool share gained minus fees paid) is negative, and their tube and reputation gain per NEAR spent is lower than an honest spore's. If any case fails, retune before building further. The demo scene runs the attacker and shows the money lost and the art barely changing.

Phase 1 result (`docs/results.md`): a one-spore loop is rejected as a self-payment; with the shipped rules every 2-3 spore loop loses money (360/360 cases), and no attacker spore reaches the honest median reputation (270/270 cases with K at ½×–2× of default). The per-NEAR part fails for tiny loops (≤ 0.05 NEAR per edge per epoch, 93/270 cases) because `isqrt` reputation makes the smallest surviving tube the most efficient per NEAR for everyone. **Proposed, pending sign-off:** gate on "loses money and cannot reach the honest median reputation" and keep reporting the per-NEAR numbers.

## 10. Evaluation and demo

- Baseline: two modes, real numbers (6.5).
- Wash-trading result: the sweep table (9).
- Art check: `verify` regenerates a spore's image from chain state and compares its hash with the committed `image_hash`.
- Chain stats from real runs: payments settled, total fees in NEAR, time to finality, gas per call, gas for generating the on-chain glyph.
- Receipts: click a tube to see the settled payments behind it with testnet explorer links. A verify button recomputes the epoch fingerprint from chain data.
- One command runs a fast-epoch demo, prints the expected output and links the transactions. Include a recorded fallback run in case testnet is slow.
- Video (60-90 s): the collection gallery and a spore waking (10 s), hiring with the decision log and the art growing (20 s), shock and reroute (12 s), injection rejected (13 s), spore listed, bought, royalty paid, old key locked out (25 s), wash attacker losing money (10 s).

## 11. Tests (write before the contracts)

Graph, fee and reputation (pure functions):
- Identical bytes across runs and machines.
- With zero flow, an edge reaches pruning in the expected number of epochs.
- A payment 100x larger does not give 100x the conductivity, reputation or pool weight.
- No overflow at the largest allowed payment.
- Fee plus forwarded amount equals the paid amount; pool distribution sums to the pool.
- Wash-trading sweep meets the criterion in section 9.

Art:
- The fixed-point renderer gives byte-identical images across repeated runs, across two machines and across Rust and JS, using shared test vectors.
- A dormant spore renders as a faint mark; adding an edge changes the image; pruning the edge restores a thinner network.
- A young spore (low degree) renders visibly smaller than a mature one with the same seed.
- The on-chain glyph is deterministic and stays under the view gas limit at the maximum number of active spores.
- `commit_image` stores a hash that `verify` reproduces from state.

Spore NFT and market:
- Only the owner can activate, set policy, register an operator, pause or withdraw.
- After transfer: old operator key fails, old owner cannot withdraw or set policy, policy is paused with zero budget, balance, tubes and age are unchanged, in-flight jobs refunded.
- `buy` settles atomically: NFT, seller payment and royalty all happen or none do; royalty and seller amounts sum to the price.
- A listed spore cannot withdraw or be paused; delisting restores that.
- Operator cannot withdraw to itself.

Policy:
- Budget, allowlist, per-payment cap and pause each revert correctly.
- Effective budget never exceeds the owner budget or the living ceiling, and drops as tubes decay.
- A restricted key cannot call anything outside its allowed methods.

Jobs and epochs: unsettled jobs refund after timeout and do not count as flow; close twice or too early fails; empty epoch does nothing; ledger total is conserved across a full epoch including fees, royalties and refunds.

End to end: a scripted 5-epoch run with a mid-run sale and an injected job completes unattended, and `verify` reproduces every fingerprint and the sold spore's image.

## 12. Plan (solo)

| Days | Work | Done when |
| --- | --- | --- |
| 1-3 | `sim`, graph, reputation, fee math as pure code with tests; baseline; wash-trading sweep | Tests green; criterion in section 9 met |
| 3-4 | Spore-account spike (5.6); read NEP-171, NEP-199, randomness and access key docs | Go or no-go recorded |
| 4-6 | Router: spore NFTs, ledger, policy, job escrow, operator keys; fixed-point renderer spike and test vectors | Mint, activate, transfer lockout and policy rejections work on testnet; first image generated from state |
| 6-8 | Agent bidding, delivery and payments, outside service, decision log | Agents trade unattended; tubes form; art changes |
| 8-10 | Epoch close, fee pool, living allowance, market and royalties | Sale scene runs end to end |
| 10-12 | Gallery and viz on chain state, injection, rogue and wash scenes, art polish, demo script | 60-90 s recording possible |
| 12-14 | README filled from real runs, public repo, demo post, submission | See section 14 |

## 13. Tracks

Target: `nfts` (main), `security`, `swarms`, `agents`. Decide on day 13 from what runs and what a judge can reproduce from the README. Apply the removal test in section 3 to each claim.

## 14. Submission checklist and rules

Rules come from https://nearhackathon.com/HACKATHON.md. Re-read it before submitting, since dates, rules and links may change. Discord: `https://discord.gg/nearprotocol`.

- Pre-window code is answered by Q-001: allowed from the 2026-10-19 announcement, earlier commits are baseline. Separate baseline from window work with a `pre-hackathon` tag (or a dedicated branch) and a `hackathon-submission` tag, and link the diff in the README (Q-003). Disclose anything that predates 2026-11-01 (the `slime-router.html` sketch from 2026-10-26, Phase 0 and 1) in the README.
- Repo public before 2026-11-14T23:59:00Z, with a `LICENSE` file (Q-014; MIT is fine) that stays through judging. README for a machine reader: what it is, the problem, "do X, see Y" steps, no marketing. List libraries, templates and AI-generated code (Q-005). Fill every `TODO` in the README draft only from real runs.
- Demo post on X written and published by the team, saying it was built at NEAR HACKATHON, tagging @NEARProtocol and #NEARHackathon (@NearLegion and @NearBuilders optional), with the demo video attached. A local-only demo is accepted only with a public repo, a reproducible README and a video; screenshots are not enough (Q-012). A hosted demo is a plus: keep it up to 2026-11-18, ideally 2026-11-25.
- One submission, only after the exact payload is printed and confirmed. The API accepts submissions only from 2026-11-01T00:00Z to 2026-11-14T23:59Z (403 outside, do not retry). Generate `requestId` once and reuse it on retries; send exactly the documented fields (no `website`); body at most 12000 bytes; a 409 means ask the team, never change the link or email to get around it. Do not commit the payload.

Values only the team can provide (never guessed or placeholder-filled): project name, lead name, contact email, team size, tracks, mainnet NEAR payout account, repo URL, demo post URL, description, consent to the contact notice (read verbatim from HACKATHON.md).

Hard rules for the coding agent:
- Testnet only. No mainnet deploys, transactions or spends without an explicit yes.
- No push, no making the repo public, no X posts and no submission without an explicit yes.
- Read the NEAR docs for every integration before generating code against it.
- Do not commit secrets or the submission payload.

## 15. Stretch and cut order

Stretch, only after section 12 is done and passing:
- One round of counter-offers, and a broker that pools spores' demand for a volume discount from the outside service.
- One payment into the outside service through NEAR Intents (read the Intents docs first; keep only if it works end to end). Intents has no testnet (Q-007): it is mainnet only, with separate dev accounts, tiny amounts and `dry: true` quotes, so it needs an explicit yes under the testnet-only rule and defaults to cut.
- An investor agent that ranks spores by earnings per epoch against asking price and buys the best one.

Cut order if behind: stretch items, then broker and extra roles, then the outside-service access gate, then the spore-account spike. The core (art from state, transfer semantics, market and royalties, living allowance, bidding, wash-trading result) stays. Art polish is cut last among the optional items, because the art is half of the pitch.

## 16. Open questions

1. Whether the slime render can be made byte-reproducible in fixed point in time (5.5 spike), and whether the on-chain glyph fits view gas limits.
2. Contract randomness API for the seed (5.1).
3. Ledger versus spore sub-accounts (5.6): decided by the spike.
4. Whether wallets and marketplaces display on-chain generated art and honor NEP-199 payouts (5.4, 5.5).
5. Which outside service can take an on-chain payment (6.4).
6. Collection size and active cap: 64 and 16 by default; fewer gives a thinner network, more raises storage and gas.
7. Demo epoch length, fee level and royalty level: high enough that balances and prices matter, low enough that agents still trade.
8. ~~Whether pre-start work is allowed (section 14).~~ Answered by Q-001: yes, from 2026-10-19; disclose it.
