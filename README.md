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

Requirements: <!-- TODO: node/rust versions as actually used --> and a NEAR testnet account.

Each step is "do X, see Y". Fill in the commands and outputs from a real run, and re-run every step before publishing.

1. Install and configure. <!-- TODO: commands --> You should see: <!-- TODO -->
2. Run the demo in fast-epoch mode. <!-- TODO: command --> You should see: <!-- TODO: dormant spores waking, agents trading, epoch close within ~30 s -->
3. Open the viz. <!-- TODO: command or URL --> You should see: the collection gallery, a live network where tube thickness tracks payment flow, and a decision log for each hire.
4. Watch a spore grow. <!-- TODO: command --> You should see: its image change between epochs as tubes thicken, and `verify` regenerate the same image from chain state.
5. Trigger the shock. <!-- TODO: command --> You should see: the targeted agent removed, the network rerouting and the art changing over the following epochs.
6. Run the injection test. <!-- TODO: command --> You should see: the agent attempt to send funds to the attacker, the router reject it, and the failed receipt. The agent is deliberately naive and the model's output is shown.
7. Trigger the rogue agent. <!-- TODO: command --> You should see: an over-budget payment and a non-allowlisted payment rejected, and the spore's tubes decaying and its art shrinking.
8. Run the wash-trading attacker. <!-- TODO: command --> You should see: the attacker's balance fall by more than it gains, and its spores' art barely change.
9. List and buy a spore. <!-- TODO: command --> You should see: the NFT move to a second account, the seller and royalty paid, the old operator's next payment fail, the new owner's policy start paused, and balance, connections and age unchanged.
10. Verify an epoch yourself. See below.

## Verify an epoch

```
cargo run --release -p spores-verify -- epochs --router spores-hack-router4.testnet --closes docs/phase5-closes.txt
cargo run --release -p spores-verify -- image  --router spores-hack-router4.testnet --closes docs/phase5-closes.txt --spore 5
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
| Graph model, reputation and fingerprint | TODO |
| Router, ledger and policy | TODO |
| Spore NFT and transfer semantics | TODO |
| Fixed-point renderer, image commits, glyph and gallery | TODO |
| Market and royalties | Built and run on testnet: list, buy with royalty, old operator locked out, new owner takes over (`docs/phase5-results.md`) |
| Agents, job escrow and outside service | TODO |
| Living allowance | Built and enforced on every payment; values from the sim (`docs/phase5-results.md`). It did not bind in the testnet run |
| Visualization | TODO |
| Baseline and wash-trading results | TODO |

## Demo

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
