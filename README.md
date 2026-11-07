# Spores

> **DRAFT.** Written before the build. Every `TODO` marks something that must be filled from what actually runs. Do not publish this file with TODOs left in, and do not replace a TODO with a number or command that was not produced by a real run.

Built for NEAR HACKATHON. The organizers' window runs from the 2026-10-19 announcement to 2026-11-14 (Q-001); submissions are open 2026-11-01 to 2026-11-14. Work before 2026-11-01 is listed under Disclosure. Tracks: `nfts` (main), `security`, `swarms`, `agents` <!-- TODO: confirm on day 13; drop any track whose feature does not run -->

## What it is

Spores is an NFT collection of living slime molds. Each spore starts out dormant. When its owner gives it an agent, the spore starts trading small services with other spores, and every settled payment thickens a tube between the two, modelled on how the slime mold *Physarum polycephalum* strengthens tubes that carry flow. Tubes with no traffic decay.

The NFT's image is the real picture of that spore's trading network, rendered from on-chain state. It grows, shrinks and changes as the spore lives, and anyone can regenerate it from committed state and check its hash.

The NFT is also the key. Whoever holds it controls the agent, owns the money it earns, owns the spore's history, and can use its access rights. The spore's history sets how much its agent may spend, so the art is a credential as well as a picture. Spores are bought and sold on a built-in market that pays a royalty on every resale.

## The problem

1. An agent that holds money needs an owner, and ownership has to be transferable without handing over keys by hand.
2. Agents that choose providers by price alone ignore track record, and track records are usually kept off-chain where nobody can check them.
3. Agents need hard spending limits, or one bad prompt can drain them.
4. Any reputation signal invites fake activity, so it has to be shown to resist it.
5. Generative NFT art is usually random and then frozen, so it records nothing.

Here the NFT is the agent's account and its history in one tradeable asset. Spending limits are enforced in the contract and grow only as a spore earns trust. Payment history becomes a verifiable, decaying signal that agents use and that the art displays, and a wash-trading attacker is shown to lose money.

## How NEAR is used

| Feature | Use |
| --- | --- |
| NEP-171 NFTs | One NFT per spore. Transfer is implemented so it clears the old operator and resets policy <!-- TODO: confirm NEP-171 details --> |
| Dynamic on-chain metadata | Traits and a vector glyph are generated from chain state on every read: NEP-177 `media` is the glyph as a `data:image/svg+xml` URI with its `media_hash`, and the `glyph` view returns it (2.33 Tgas on testnet). The hash of the Physarum render is committed on-chain with `commit_image` after every epoch <!-- TODO: name trait; how wallets display it --> |
| Royalties | The router's own `buy` pays the seller and a 5% royalty in the same call (tested on testnet: 0.475 + 0.025 NEAR for a 0.5 NEAR sale). NEP-199 `nft_payout` reports the same split; approvals (NEP-178) are off, so outside marketplaces cannot sell a spore and `nft_transfer_payout` is owner only |
| Sub-accounts | One operator account per active spore for the agent runtime <!-- TODO: say whether spores are also real sub-accounts (spike result) --> |
| Function-call access keys | Operators can only call the allowed router methods, with an allowance <!-- TODO: confirm exact key limits --> |
| Native NEAR | Deposits, withdrawals, market sales and payments to external services |
| Testnet explorer | Every claim below links to real transactions |

## How it works

1. **Mint.** The collection is minted at genesis. Each spore has a seed that sets its colour and starting pattern. Dormant spores render as faint marks.
2. **Activate.** The owner activates a spore with a deposit, sets policy and registers an operator account for the agent. The balance lives in the router's ledger under the spore id <!-- TODO: update if spores became real sub-accounts -->.
3. **Hire.** A consumer posts a job and providers quote. The consumer scores quotes as `quote / (1 + w*D_norm)`, where `D_norm` is the connection strength to the provider, and accepts the best one. The payment moves into escrow.
4. **Deliver and settle.** The provider delivers a result hash and the consumer settles or rejects. Settling takes the fee and credits the provider. Only settled jobs count as flow. Rejected and timed-out jobs refund.
5. **Grow.** At epoch close, each edge's conductivity `D` is updated in integer math: `D' = D - D*decay + gain * q/(q+K)`. Weak edges are pruned. The edge list is hashed (sha256) into a fingerprint. The fee pool is split by saturated flow.
6. **Allowance.** A spore's reputation `R` sets its ceiling: `min(owner budget, base + gain * R)`. Neglected spores lose it as their tubes decay.
7. **Trade.** `list`, `buy` and `delist` run on the router. A buy moves the NFT, pays the seller and pays the royalty in one call. On transfer the old operator key stops working, policy resets to paused with zero budget, and balance, connections and age stay with the spore.

Full design: [SPEC.md](SPEC.md).

## The art

The image is a slime mold render: a dark background, a glowing organic network grown by a Physarum simulation seeded by the spore's token and fed by its state, in one of five palettes chosen from the seed. Neighbors sit at fixed places on the collection ring and nearer the centre when their tube is stronger. Tubes that carry more flow render brighter, and a nucleus and a ring on each trading partner mark who is connected. A young spore renders as a thin, unfinished network and a mature one as a branched, looping one.

The contract cannot run the simulation, so the art has two layers: the contract stores each spore's state hash and a committed image hash, and generates a small vector glyph of the spore's connections into its metadata. The renderer is deterministic fixed-point code, so anyone can regenerate an image from state and compare its hash. The contract guarantees the state; the image hash is committed by this project's renderer and is checkable by anyone. Traits are computed from state (degree, age, reputation tier), not rolled. The viz also draws the whole collection as one network.

<!-- TODO: embed example images from real spores at different ages once they exist, and state whether the renderer reproduced byte-for-byte across machines (spike result). -->

## Policy (security model)

Set by the spore owner and enforced in the router contract, not in agent code:

- Budget per epoch, capped by the living allowance
- Allowlist of counterparties
- Per-payment cap
- Owner-only `pause`
- Operators hold restricted function-call keys, never full-access keys

Known limits: <!-- TODO: list what is NOT covered, e.g. compromised owner key, malicious allowlisted payee, router bugs. State whether funds sit in one contract's ledger. -->

## Try it

There are two ways in. The recording needs no keys and no testnet; the real run needs funded testnet keys and spends gas.

Requirements: Rust with the `wasm32-unknown-unknown` target (built with rustc 1.97) and Node 23.6 or newer, because the agents run TypeScript directly.

### Watch a real run, recorded

```sh
bash scripts/build-wasm.sh   # the renderer and core as wasm, then their checks against the shared vectors
(cd viz && npm ci)
bash scripts/demo.sh --playback
```

You should see the app open on a recording of a real testnet run, badged `RECORDED`, with Spore #6 going through the whole loop in about 47 s: it wakes, hires #11 for 0.1715 NEAR, the tube to #11 goes from D 0 to 473,807, its reputation rises from 0.85 to 1.42, what it may spend goes up, its picture redraws, it is sold to a buyer for 0.50 NEAR, and the old key is refused. Then **Check it against the chain** replays all 63 epochs in your browser. That check reads testnet, so it says `! Unable` if you are offline. Everything else plays offline.

The app's first page tells the same story in about 32 s, then shows what the collection is doing right now.

### Run it for real

This spends testnet gas, closes real epochs and **really sells one spore**, which stays with the buyer. It takes about 12 minutes. It signs as the router's owner and operators, so it needs their keys in a git-ignored `.env`, which is not in this repository. Without them, watch the recording and check it with the `spores-verify` commands below, which need no keys.

```sh
bash scripts/phase6-setup.sh # with those keys: funds and registers what the run needs; safe to run again
bash scripts/demo.sh
```

The terminal prints each stage with what to look for, and the browser follows along at `/lab/loop`. A real run printed:

```
00:06 ✓ Wake      12 agents started. Spore #6 is the one to watch
00:12 ✓ Close     epoch 55 closed
01:18 ✓ Hire      #6 hired #11 at 0.171 NEAR from 1 quote
01:18 ✓ Settle    #6 paid #11 0.171 NEAR
01:34 ✓ Grow      tube #6–#11: D 0 → 473,807
01:34 ✓ Reputation R 0.85 → 1.42, may spend 0.270 NEAR → 0.384 NEAR an epoch
01:34 ✓ Art       redrawn from 3 tubes at age 57
03:09 ✓ Sell      #6 sold to buyer.spores-hack.testnet for 0.500 NEAR
04:21 ✓ Control   old key refused (caller is not this spore's operator); the buyer's agent sent pay_service
11:43 ✓ Closes    9 closes
11:43 ✓ Report    14 of 14 checks passed
spores-verify epochs: verified 63 epochs on spores-hack-router4.testnet: match
spores-verify image --spore 6: image: match
```

### The other scenes

With those same keys, `node agents/src/scene-server.ts` serves the Demo Lab's scenes at `/lab`. It only answers pages on the same machine.

Both story scenes also play from their recordings without keys.

- **Rogue agent** (`/lab/rogue`). You should see the owner narrow a spore's policy, three payments refused by the contract with their failed receipts, one allowed, and its tubes decaying over two real closes. It needs a spore with two tubes that outlast two closes, and the page says when the router has none.
- **Sale** (`/lab/sale`). You should see the NFT move to a second account, the seller and royalty paid, the old operator's next payment refused, and balance, tubes and age unchanged. It really sells a spore.
- **Wash trading** (`/lab/wash`) is a simulation panel, labelled as one, from `cargo run --release -p spores-sim -- wash`. It opens on the case the defence loses.
- **Prompt injection** is **not implemented**: no LLM agent exists in this project, and the Demo Lab card says so.
- **Shocks** (remove an agent, raise a cost, cut a tube) were run on the Phase 4 router with `bash scripts/phase4-testnet.sh`; see `docs/results.md`.

## Verify an epoch

```
cargo run --release -p spores-verify -- epochs --router spores-hack-router4.testnet --closes docs/router4-closes.txt
cargo run --release -p spores-verify -- image  --router spores-hack-router4.testnet --closes docs/router4-closes.txt --spore 6
```

The script reads each epoch's `epoch_closed` event from its close transaction (payments, rejections, fee pool and active set), reruns the update rule with the router's own parameters, rebuilds the canonical string and compares its sha256 with the fingerprint in the event and the one stored on-chain. `image` rebuilds a spore's state at the epoch of its committed image, checks the committed state hash, renders it and compares the image hash. On the Phase 5 run it printed one `epoch N: <fingerprint> match` line per epoch, then `verified 16 epochs on spores-hack-router4.testnet: match` and `image: match`. Old transactions are only on NEAR's rate-limited archival RPC, so a late replay is slow.

## Does the slime mold help?

We ran the same economy under identical seeds and disruptions in two modes: price only, and price with connections. Simulated providers have hidden quality and consumers reject bad results.

<!-- TODO: table from the real runs. Do not fill from expectation.
| Metric | Price only | + connections |
| Average price paid | | |
| Failed jobs | | |
| Result quality | | |
| Epochs to recover after a shock | | |
Report every result, even if connections do not win. -->

## Wash trading

<!-- TODO: sweep table from the real runs: attacker spores (1-3), fee, K, gain, loop size -> net result and connection gain per NEAR spent versus an honest spore. State plainly that receipts and escrow do not stop an attacker who controls both sides, and that the defense is economic. -->

## Chain stats

<!-- TODO: from real runs: payments settled, total fees, time to finality, gas per call, gas to generate an image -->

## Deployed (testnet)

<!-- TODO: contract account ids, a few example transaction links, example spore NFTs -->

## Status

| Item | State |
| --- | --- |
| Graph model, reputation and fingerprint | Built. `spores-core` is the one implementation: the router, `sim`, `verify` and the browser all run it, checked against shared vectors |
| Router, ledger and policy | Built and run on testnet: `spores-hack-router4.testnet`, 64 spores active, refusals seen in real receipts (`docs/results.md`) |
| Spore NFT and transfer semantics | Built and run on testnet: NEP-171 and NEP-199; a transfer clears the operator, pauses the policy and keeps balance, tubes and age |
| Fixed-point renderer, image commits, glyph and gallery | Built. Rust, wasm and the JS port match the shared vectors on the machines tried; a second physical machine has not run the check yet |
| Market and royalties | Built and run on testnet: list, buy with royalty, old operator locked out, new owner takes over (`docs/results.md`) |
| Agents, job escrow and outside service | Built and run on testnet: rule-based hiring, replayed against `spores-core` from the log. No LLM agent exists |
| Living allowance | Built and enforced on every payment; values from the sim (`docs/results.md`). It did not bind in the testnet run |
| Visualization | Built: landing page, gallery, network, spore page with wallet actions, activity, browser verify, Demo Lab. No wallet transaction has been signed from it yet, and it has not been run from a static host |
| Baseline and wash-trading results | Run; `docs/results.md`. The attacker loses money in all 270 cases, but the reputation half of the gate holds in only 168 of 270 at 64 active with testnet-level traffic (1 job per spore per epoch), and 270 of 270 at 3 jobs |

## Demo

Locally: `bash scripts/demo.sh --playback` (above) needs no keys and no testnet.

<!-- TODO (team supplies): link to the public demo post on X (video attached, tags @NEARProtocol and #NEARHackathon), and a hosted demo URL if there is one. A local-only demo needs the video plus the reproducible steps above (Q-012). Keep any hosted demo up until 2026-11-18, ideally 2026-11-25. -->

## Disclosure

Everything below predates 2026-11-01. All of it falls inside the organizers' window (2026-10-19 to 2026-11-14, Q-001) unless a date below says otherwise.

- `slime.py` and `slime_example.png`: prototype art renderer. <!-- TODO (team): date written; if before 2026-10-19 it is baseline. -->
- A browser sketch of the pixel-based visualization (`slime-router.html`), made on 2026-10-26. <!-- TODO: say whether it was rebuilt from scratch or reused, and which parts. -->
- Phase 0 and 1, finished 2026-10-29: `core/`, `sim/`, `vectors/`, `docs/`. <!-- TODO: link the diff between the `pre-hackathon` tag and `hackathon-submission` (Q-003) once both tags exist. -->

## Libraries and AI-generated code

Code in this repository was written with Claude Code (AI-generated, reviewed by the team). <!-- TODO: list libraries and templates from Cargo.lock / package.json at the end. Mark which are the team's own pre-hackathon libraries (Q-005). -->

## Limitations

<!-- TODO: be specific. Candidates: testnet only; scripted rogue agent; deliberately naive injection target; small active set; funds held in one contract's ledger; the outside service we run is ours, not a partner's. -->

## Repository layout

<!-- TODO: fill from the real tree -->

## License

<!-- TODO: team decides the license; a LICENSE file must exist before the repo goes public (Q-014, MIT is fine). -->
