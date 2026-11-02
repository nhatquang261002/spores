# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## State of the repo

Phase 1 (graph core and `sim`), Phase 2 (spikes), Phase 3 (router contract, testnet exit run 83/83 on `spores-hack-router2.testnet`) and Phase 4 (agents, outside service, decision log; 8-epoch exit run 6/6 on `router3.spores-hack.testnet`) are done; see `docs/phase1-results.md` to `docs/phase4-results.md` for results, open decisions and every deviation from SPEC.md. Phase 2 decisions: spore sub-accounts **no-go** (single router ledger stays); fixed-point renderer **go** (reproducible on the machines tried; a second physical machine still has to run `check`). NEAR HACKATHON: per HACKATHON.md Q-001 the window runs from the 2026-10-19 announcement to 2026-11-14 (earlier commits are baseline; disclose pre-window work), and the submission API accepts submissions only 2026-11-01 to 2026-11-14. No git commits yet, so the `pre-hackathon` tag (Q-003) does not exist; ask the team what counts as baseline before creating it. HACKATHON.md changed between 2026-10-29 and 2026-10-31 (see `docs/verify-notes.md`): diff it against the live copy before relying on it.

Rust workspace (rustc 1.97 lives in `~/.cargo/bin`, which is not on the default PATH):

```
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --workspace                        # core unit tests + shared vectors + sim tests
cargo clippy --workspace --all-targets        # must stay warning-free
cargo run --release -p spores-sim -- all      # baseline + wash sweep -> out/ (exit 1 if the gate fails)
cargo run --release -p spores-sim -- vectors  # regenerate vectors/core.json after any core change
cargo run --release -p spores-renderer -- check   # native renderer vs vectors/renderer.json
cargo build --release -p spores-renderer --target wasm32-unknown-unknown && node renderer/js/check.mjs  # wasm + JS port vs the same vectors
cargo run --release -p spores-renderer -- vectors # regenerate vectors/renderer.json after ANY renderer change (and bump RENDERER_VERSION)
cargo test -p spores-router                   # contract unit tests (mocked runtime); plain `cargo build` of the router is blocked by near-sdk on purpose
(cd router && cargo near build non-reproducible-wasm --profile contract)   # router wasm -> target/near/spores_router/
scripts/view.sh <contract> <method> '<json>'  # read-only view via testnet RPC
bash scripts/deploy-router.sh                 # build + deploy + init to $ROUTER_ACCOUNT_ID (fresh account only)
bash scripts/phase3-testnet.sh                # Phase 3 exit run against a fresh router -> out/phase3/
(cd agents && npm ci && npm test) && (cd outside && npm test)   # TS rules vs vectors/agents.json, client, services, receipt checks
bash scripts/phase4-setup.sh                  # idempotent Phase 4 testnet setup (router3, outside, spores 0-8, per-spore FC keys -> .env)
bash scripts/phase4-testnet.sh                # Phase 4 exit run: 9 agents + keeper + outside, 8 epochs, shocks -> out/agents/<run>/
cargo run --release -p spores-sim -- replay-decisions <decisions.jsonl>   # re-check every logged hire against spores_core
```

- `core/` (`spores-core`): pure integer math, no chain dependency. `Params::shipped()` is the shipped rule set; `Params::spec()` is SPEC as first written, kept for comparison. `epoch::close_epoch` is the single call the router and `verify` must run.
- `sim/` (`spores-sim`): economy simulation linking `core`; writes `out/` (git-ignored).
- `renderer/` (`spores-renderer`): integer-only Physarum image renderer (512x512 RGB), a wasm32 C ABI, and `js/render.mjs`, an independent JS port. Any change to its output bytes needs a `RENDERER_VERSION` bump and regenerated `vectors/renderer.json`. `image_hash` hashes raw pixels, never a PNG. Needs the `wasm32-unknown-unknown` target for the wasm check.
- `router/` (`spores-router`): the NEAR contract (near-sdk 5.30). NFTs, ledger, policy (incl. `external_allowlist`), job escrow (delivered jobs auto-settle at the deadline), `pay_service`, `close_epoch` via `spores_core::close_epoch`. Wasm is about 437 KB (about 4.4 NEAR of storage); the router pays its own storage. Testnet scripts in `scripts/` read keys from `.env` only.
- `vectors/core.json`: shared vectors; any other implementation must match byte for byte. Changing core math means regenerating it and saying so. `vectors/agents.json` (same command) covers the RNG, hiring, margin and demand rules the TypeScript agents port.
- `agents/` (TypeScript, near-api-js 7.4.0, Node >= 23.6 runs `.ts` directly): one process per active spore (`agent.ts`), `keeper.ts` (epoch close, timeouts, snapshots), `run.ts` (one-command run, renders, exit checks), `shock.ts`, `setup.ts`. Money decisions only through `rules.ts` (the port of `spores-core`). Public testnet RPCs rate-limit: clients rotate FastNEAR and dRPC (`NEAR_RPCS`).
- `outside/`: our own paid data service (SPEC §6.4 option 2), sold only against a router `service_paid` receipt signed by the spore's current operator. No dependencies.
- The deployed Phase 4 router is built from this tree (wasm sha256 `418b3f0c…`); a change to any doc comment in `router/` changes the embedded ABI and so the wasm hash.

Other files:

- `SPEC.md`: the design for "Spores", an NFT collection of living slime molds on NEAR testnet. It is the source of truth for architecture, mechanics, planned tests and the build plan.
- `README.md`: a **draft** submission README. Every `TODO` in it must be filled only from output of a real run. Never replace a TODO with a number, command or result that was not actually produced, and don't publish it with TODOs left.
- `HACKATHON.md`: the organizer's instructions for the coding agent (rules, submission API, tracks). The live copy is https://nearhackathon.com/HACKATHON.md; re-read it before submitting.
- `slime.py`: the pre-window prototype art renderer (float, not reproducible; the real one is `renderer/`). `slime_example.png` is a sample render sheet.

## Hard rules (from SPEC.md §14 and HACKATHON.md)

- Testnet only. No mainnet deploys, transactions or spends without an explicit yes.
- No `git push`, no making the repo public, no X posts, and no submission to `nearhackathon.com/api/applications` without an explicit yes. For a submission, print the full payload first and wait for confirmation.
- Never guess or placeholder-fill the submission fields only the team can supply (project name, lead name, email, team size, tracks, payout account, repo URL, demo post URL, description, consent). Q-014 needs a `LICENSE` file before the repo is public; the team picks the license.
- Read the current NEAR docs before generating code for any integration. SPEC.md marks unverified API names, versions and addresses as **VERIFY**; do not trust the spec or memory for them.
- Secrets go in environment variables only. Keep `.env` in `.gitignore`. Never commit keys, seed phrases or the submission payload.
- Work from before 2026-11-01 (`slime.py`, the 2026-10-26 `slime-router.html` sketch, Phase 0 and 1 from 2026-10-29) must be disclosed in the README's Disclosure section, and libraries and AI-generated code listed (Q-005).
- NEAR Intents has no testnet (Q-007), so any Intents use is mainnet and needs an explicit yes.

## Planned architecture (SPEC.md §4)

Components: `router` (Rust NEAR contract), `agents` (off-chain TypeScript or Python, one per active spore), `outside` (paid service agents buy from), `sim` (off-chain economy simulation), `renderer` (fixed-point Physarum renderer, Rust/WASM), `viz` (web page), `verify` (script).

Ideas that span components:

- **Single `router` contract** owns everything: NEP-171 spore NFTs, the per-spore ledger, policy, job escrow, fees, graph update, fingerprints, market and image-hash commits. Money lives in the router's ledger keyed by spore id (a sub-account design is a half-day spike, §5.6).
- **Graph core is pure integer math.** Per-epoch edge update is `D' = D - D*decay_bps/10000 + gain*q/(q+K)`. Reputation is `R = Σ isqrt(D_e)`. Edges iterate in lexicographic order, with no floats and division rounding down. The epoch fingerprint is `sha256` of the canonical string (§8.4). `sim` and the contract must produce identical bytes, so write them as pure functions with tests first.
- **Hiring score** is `quote / (1 + w * D_norm)`. All money decisions are rule-based so runs reproduce from the log; an LLM may only handle task content.
- **Policy is enforced in the contract, not agent code.** Budget, allowlist, per-payment cap, pause, and operator keys that are function-call keys only. The effective budget is `min(owner_budget, base + trust_gain * R)`. Transfer clears the operator, resets policy to paused with zero budget, and refunds in-flight jobs. Balance, edges, age and name stay with the spore.
- **Art has two layers.** The contract stores the state hash and a committed `image_hash` (`commit_image`), and emits a small integer-only SVG glyph. The visible Physarum image is rendered off-chain by deterministic fixed-point code shared by `viz` and `verify`. If byte-reproducibility fails in the day-4 spike, ship the on-chain glyph as the image and say so in the README.
- **Wash-trading defense is economic** (fee, saturation `q/(q+K)`, `isqrt` reputation, fixed supply). The acceptance criterion in §9 must be checked in `sim` before building further. Report all baseline results even if they are unfavorable.

Defaults to tune in `sim`: 64 spores, at most 16 active, `decay_bps=2500`, `gain=1_000_000`, `K=0.5 NEAR`, `D_min=50_000`, `fee_bps=100`, `royalty_bps=500`.

## slime.py (prototype renderer)

Run it with preset names as arguments. Each preset writes `v2-<tag>.png` to the current directory:

```
python slime.py mature young spore ember violet toxic aqua
```

Presets (in `PRESETS`): `(token_id, {neighbor_id: D}, epoch, palette)`.

- Requires `numpy` and `Pillow`.
- Fonts are hardcoded to Linux paths (`/usr/share/fonts/truetype/dejavu/...`). On macOS, point them at a local TTF or it will fail with `OSError`.
- It is a **prototype, not the spec'd renderer**. It uses float numpy, `np.random.default_rng` and `sin/cos`, so output is not guaranteed byte-identical across machines. The seed uses a stand-in string, `demo-mint-randomness`. The real renderer must be fixed-point with a fixed PRNG and sin/cos tables, and be tested against shared vectors across Rust and JS (§5.5, §11).
- It treats `D` on the 1e6 fixed-point scale (`D/1e6` is the normalized strength, `isqrt(D)` sums to reputation). The ring has 64 slots (`ring_pos`), matching the collection size.
