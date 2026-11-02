# Spores: Development Roadmap

Derived from `SPEC.md` (§12 plan, §11 tests, §14 rules, §15 cut order). If the two disagree, `SPEC.md` wins. Dates are UTC. Build window: **2026-11-01 to 2026-11-14**; the repo must be public before **2026-11-14T23:59Z**.

Standing rules for every phase: testnet only; read the current NEAR docs before each integration (everything marked **VERIFY** in the spec); tests before contracts; no push, public repo, X post or submission without an explicit yes; README `TODO`s are filled only from real runs.

## Phase 0: Pre-build (2026-10-29 to 2026-10-31)

- [x] Re-read https://nearhackathon.com/HACKATHON.md (dates, rules, submission API, tracks).
- [x] Read current NEAR docs and record answers next to each **VERIFY**: Rust contract SDK and version, NEP-171 requirements, NEP-199 payouts, contract randomness API, function-call access key limits, view gas limits, storage cost for 64 spores, whether a contract can control a sub-account's keys.
- [x] Create a testnet account for the deployer and one for each of owner / operator / buyer test roles. Keys in env vars only.
- [x] Decide repo layout (`sim/`, `router/`, `renderer/`, `agents/`, `outside/`, `viz/`, `verify/`) and `.gitignore` with `.env`.

**Exit:** a short `docs/verify-notes.md` (or equivalent) with one line of evidence per VERIFY item. The pre-window question is answered by Q-001, so no Discord question is needed.

Before window work starts: make the baseline commit and `pre-hackathon` tag (Q-003). The repo has no commits yet, so the tag does not exist. Needs the team's call on what counts as baseline, since Q-001 treats only commits before 2026-10-19 as baseline.

## Phase 1: Graph core and `sim` (Days 1-3: Nov 1-3)

Focus: pure integer code, written once and reused by `sim`, contract and `verify`.

Results and design changes: `docs/phase1-results.md`.

- [x] Pure functions with tests first: edge update `D' = D - D*decay_bps/10000 + gain*q/(q+K)`, pruning at `D_min`, `isqrt` reputation, fee split, pool distribution by saturated weight, canonical string and `sha256` fingerprint (§8). (`core/`; pool rule, fee rounding, breadth damping and rejection cut revised.)
- [x] Shared test vectors (JSON) so the Rust contract, `sim` and `verify` must agree byte for byte. (`vectors/core.json`)
- [x] Overflow test at the largest allowed payment (`gain * q`, q about 1e25). (256-bit `mul_div`, tested to `u128::MAX`)
- [x] `sim` economy: 64 spores, at most 16 active, providers with hidden quality, rule-based hiring `score = quote / (1 + w * D_norm)`, margin rules.
- [x] Baseline: price-only vs price-plus-tubes under identical seeds and shocks. Record average price paid, failed jobs, delivered quality, epochs to recover. (Tubes win modestly on reliability, lose on price: open decision.)
- [x] Wash-trading sweep: 1-3 attacker spores across `fee_bps`, `K`, `gain`, loop size. (Gate passes 270/270 in range; §9 per-NEAR wording fails for tiny loops: open decision.)

**Gate (blocking):** the §9 criterion holds (attacker net result negative; tube and reputation gain per NEAR lower than an honest spore's). If any case fails, retune and rerun before building anything else. Report every baseline result, including unfavorable ones. If tubes do not beat price-only, change the rule and rerun before the demo.

## Phase 2: Spikes and doc reading (Days 3-4: Nov 3-4)

Results and decisions: `docs/phase2-results.md`.

- [x] Spore sub-account spike (§5.6), half a day. Go only if every §11 test still passes; no-go keeps the single ledger. Record the decision. (**No-go**, desk spike: no custody gain, breaks atomic `buy`, policy stays in the router. Not run on testnet.)
- [x] Renderer spike (§5.5), half a day: port the Physarum sim to fixed point with a fixed PRNG and sin/cos tables; check byte-identical output across two machines and across Rust and JS. (**Go**: `renderer/`, 10 cases identical on native arm64, native x86_64, wasm32 and a JS port. A second physical machine is still to run: `docs/phase2-results.md`.)

**Gate:** go/no-go for each spike written down. If the renderer is not reproducible, the on-chain glyph becomes the NFT image, the slime render stays a gallery presentation layer, and the README says so.

## Phase 3: Router contract and renderer (Days 4-6: Nov 4-6)

Results, testnet evidence and deviations: `docs/phase3-results.md`.

- [x] Spore NFTs (NEP-171) with transfer logic: clear operator and bump key generation, reset policy to paused with zero budget, keep balance/edges/age/name, refund in-flight jobs. (`router/src/nft.rs`; a reverted `nft_transfer_call` resets again. Name trait not built yet.)
- [x] Ledger keyed by spore id: `deposit`, owner-only `withdraw`, operator cannot withdraw to itself.
- [x] `mint_genesis`, `activate`, `set_policy`, `register_operator`, `pause`, `is_operator`, `spore_summary`.
- [x] Policy enforcement in the contract: budget per epoch, allowlist, per-payment cap, pause. Operator keys are function-call keys limited to job and pay methods. (Checked at `accept`; FC key limits shown on testnet.)
- [x] Job escrow: `post_job`, `quote`, `accept`, `deliver`, `settle`, `reject`, timeout refund. Only settled jobs count as flow. (Delivered-but-unsettled jobs refund at the deadline per §6.2: decision for the team.)
- [x] Renderer with shared vectors; dormant mark, young vs mature size, edge add/prune changes the image. (Phase 2 tests; `spores-render state` renders `render_input` from chain; one epoch of decay alone changes the image.)
- [x] Pulled forward from Phase 5: minimal `close_epoch` (graph update, pool payout, fingerprint), so budgets reset and tubes exist.

**Exit:** on testnet, mint, activate, transfer lockout and each policy rejection work; first image generated from chain state. Ledger-conservation test passes. **Met 2026-10-31:** 83/83 steps on `spores-hack-router2.testnet` (`docs/phase3-testnet-run.txt`).

## Phase 4: Agents, outside service, decision log (Days 6-8: Nov 6-8)

Results, testnet evidence and deviations: `docs/phase4-results.md`.

- [x] Agent runtime: one process per active spore, operator key from env, bid / deliver / pay using the same rules as `sim`. (`agents/`, TypeScript; margins, demand and RNG moved into `spores-core` and ported against `vectors/agents.json`; one function-call key per spore.)
- [x] Decision log per hire: candidates, quotes, tube strengths, winner. (`decisions.jsonl`; `spores-sim replay-decisions` re-checks every hire against `spores_core::hiring::pick`.)
- [x] Outside service (§6.4): check for a partner API that takes on-chain payment; otherwise run our own gated by `is_operator` and a settled-payment receipt. State in the README which one shipped. (Our own, `outside/`, paid through the new router method `pay_service` and the policy's `external_allowlist`. README still to say so.)
- [x] Shock commands: kill agent, cut tube, raise price. (`agents/src/shock.ts`; cut is behavioural, since the router cannot delete a tube.)
- [x] Also: delivered-but-unsettled jobs auto-settle at the deadline (no flow), replacing Phase 3 deviation 4.

**Exit:** agents trade unattended for several epochs; tubes form; the rendered art changes between epochs. **Met 2026-11-02:** 8 epochs, 6/6 checks on `router3.spores-hack.testnet` (`out/agents/phase4-exit1/report.md`).

## Phase 5: Epochs, allowance, market (Days 8-10: Nov 8-10)

- [ ] `close_epoch` (anyone, after duration; twice or too early fails; empty epoch does nothing), graph update, fee pool distribution, fingerprint and state hash stored per epoch. (All but the per-spore state hash landed in Phase 3.) Also a treasury withdrawal.
- [ ] `commit_image` and the `verify` script (fingerprint replay and image regeneration).
- [ ] Living allowance `min(owner_budget, base + trust_gain * R)`; drops as tubes decay.
- [ ] Market: `list`, `delist`, `buy` atomic (NFT, seller, royalty); listing freezes withdraw and pause. Check NEP-199 payouts.
- [ ] On-chain SVG glyph within view gas limit at 16 active spores.

**Exit:** the sale scene runs end to end: old operator key fails, new policy starts paused, royalty paid, balance/tubes/age intact, new owner re-registers an operator and the agent resumes. `verify` reproduces fingerprints.

## Phase 6: Viz, scenes, demo (Days 10-12: Nov 10-12)

- [ ] `viz` on chain state: collection ring gallery, live network, decision log, receipts with explorer links, verify button.
- [ ] Scenes: injection (naive LLM agent, labeled as such, record whether the model complied), rogue agent, sale, wash-trading attacker.
- [ ] One-command fast-epoch demo (about 30 s epochs) with expected output printed, plus a recorded fallback run.
- [ ] Art polish (cut last among optional items).
- [ ] End-to-end test: scripted 5-epoch run with a mid-run sale and an injected job, unattended; `verify` reproduces every fingerprint and the sold spore's image.
- [ ] Removal test (§3): drop any track whose feature fails.

**Exit:** a 60-90 s recording is possible from the script in §10.

## Phase 7: README, publish, submit (Days 12-14: Nov 12-14)

- [ ] Fill every README `TODO` from real runs: commands, expected output, baseline table, sweep table, chain stats, contract ids, transaction links, build-status table, limits, disclosure (renderer prototype, `slime-router.html`, anything else pre-11-01).
- [ ] Day 13: choose tracks from what actually runs and what a judge can reproduce.
- [ ] Re-read the live HACKATHON.md and diff it against the local copy; confirm nothing changed (it already changed once between 2026-10-29 and 2026-10-31).
- [ ] `LICENSE` file added (team picks; Q-014). Libraries, templates and AI-generated code listed in the README (Q-005). `hackathon-submission` tag set and the diff from `pre-hackathon` linked in the README (Q-003).
- [ ] Demo video recorded (screenshots alone are not enough, Q-012). Hosted demo, if any, stays up to 2026-11-18, ideally 2026-11-25.
- [ ] Scan the tree for secrets; confirm `.env` is ignored and no payload is committed.
- [ ] **Needs explicit yes:** push, make repo public.
- [ ] **Team provides:** demo post on X (team publishes), project name, lead name, email, team size, mainnet payout account, repo URL, demo post URL, description, consent.
- [ ] **Needs explicit yes:** print the full submission payload, wait for confirmation, then submit once.

**Exit:** repo public before 2026-11-14T23:59Z; submission accepted. Aim to finish by Nov 14 12:00Z to leave margin.

## Cut order if behind (SPEC §15)

1. Stretch items (counter-offers, broker volume discount, NEAR Intents payment, investor agent).
2. Broker and extra roles.
3. Outside-service access gate.
4. Spore-account spike.

Never cut: art from state, transfer semantics, market and royalties, living allowance, bidding, wash-trading result.

## Top risks

| Risk                                                              | Where it bites | Mitigation                                                   |
| ----------------------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| Wash-trading criterion fails                                      | Phase 1        | Retune before any contract work; it is a blocking gate       |
| Renderer not byte-reproducible                                    | Phase 2        | Fall back to on-chain glyph as the image; disclose in README |
| Tubes do not beat price-only                                      | Phase 1        | Change the hiring rule and rerun; report all results         |
| Testnet slow or flaky at demo                                     | Phase 6        | Recorded fallback run, fast-epoch mode                       |
| VERIFY item turns out different (randomness, NEP-199, key limits) | Phases 0, 3    | Read docs in Phase 0; adjust design early                    |
| Pre-window work disallowed                                        | Phase 0        | Ask in Discord now; rebuild from scratch in window if needed |
| Running out of time                                               | All            | Follow cut order; keep Phase 7 time-boxed to 2 days          |
