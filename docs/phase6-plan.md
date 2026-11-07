# Phase 6 plan: app (`viz/`), scenes, fast-epoch demo

Status: planning, 2026-11-03. This is the working plan for ROADMAP Phase 6, split into sessions of roughly one sitting each. Every session:
- Starts by reading this file: the "Decisions", "Rules" and "Session log" sections, plus its own session section. UI sessions also read the Design subsections named in their session's **Design:** line, plus the always-on ones in "Rules" (index: Design §12).
- Ends by ticking its checklist, appending to the session log (what ran, what was measured, what is left) and noting any deviation.

If this file and SPEC.md disagree, SPEC.md wins, unless a deviation is logged here with a reason.

Deadline context:
- Submissions close 2026-11-14T23:59Z.
- Phase 7 (README, LICENSE, publish, submit) needs Nov 12–14.
- Sessions S1–S14 should be done by **Nov 12**. If behind, follow "Cut order".

## Goal

A web app where a judge who has never heard of Spores understands, within 10 seconds, that each Spore is an NFT, its agent hires and pays other agents, and settled payments grow tubes. It should also make clear that tubes set reputation and spending power, and that the art is the network. Then the judge can watch the loop in 60–90 s:

**Wake → Hire → Settle → Grow → Reputation → Art evolves → Sell → Control transfers**

Every number on screen comes from chain state, a real run log, or a labeled simulation. Nothing is invented.

## Decisions (user, 2026-11-03)

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | Stack: **Vite + React + TypeScript** in `viz/`, npm | Network and gallery drawn on hand-written canvas, no d3. Node ≥ 23.6, like `agents/` |
| D2 | Injection scene: **unavailable** | No LLM agent is built. The UI card and README say "not implemented". This is a SPEC §7.3 deviation, logged in `docs/results.md` |
| D3 | **Every spore can be active** (64). Revised 2026-11-03: **grow router4** instead of deploying `router5` | router4 already has 64 minted, `supply_cap` 64 and 30 s epochs; only `max_active` (16) is in the way. S3 adds an admin-only, raise-only `max_active` setter and code-only redeploys router4 (same state layout). One router for all Phase 5 and Phase 6 evidence. S2 found the full `epoch_closed` event does not fit NEAR's 16 KB log limit at 64 active (safe up to 22); the team chose (2026-11-03) to **trim the event and cap trading pairs per epoch** in the same redeploy, keeping 64 (fallback in "Cut order": raise to 22 only). The old routers can't be deleted (state over 10 KB, see `docs/results.md`) and stay as they are |
| D4 | Names: on-chain title **`Spore #N`** only | No name code in core. SPEC §5.5 names stay unbuilt and are listed as a deviation |
| D5 | Design: the **Design system and UI/UX** section below (from the team's design brief, 2026-11-03). Revised 2026-11-03: **slime theme, "living culture"** (user choice), with motion added the same day | All UI sessions (S4–S14) follow its tokens, layouts, components and provenance marks. Its Design §13 lists where it departs from the brief. The slime revision changes colour, shape, dividers and motion (§2, §3.1, §3.4, §3.5) but not layout or provenance. Ambient motion in the shell is a logged exception to principle 3 (§13 item 9). `brand/` reads its colours from `tokens.css`, so it follows the theme (the `*-ink` variants stay monochrome) |

## Rules (apply to every session)

- **Testnet only.** No push, no public repo, no account deletion and no submission without an explicit yes each time. Keys go in `.env` only (new keys use the `P6_` prefix).
- **Never invent anything.** No fake data, tx hashes, verification results, metrics or completed features.
- **Label every view with its source:**
  - **LIVE · testnet** (RPC)
  - **LOCAL RUN · <name>** (`out/agents/<run>/` through the dev server)
  - **RECORDED · <run>, <date>** (committed bundle)
  - **SIMULATION** (`spores-sim` output)
- **Label values computed in the browser "derived"** (R recomputed, hiring reason text, D_norm recomputed).
- **Failures stay visible.** When RPC fails, show an error or "stale since <time>". Never silently fall back to recorded or sample data.
- **Transactions:** a tx shows success only after its final outcome. Resubmitting is disabled while a tx is pending.
- **UI sessions (S6–S14) build to the Design section** and make the decisions it doesn't cover with `docs/design-guide.md` (question order, colour/motion/shape rules, anti-patterns, how to change the system, the finish checklist):
  - Always read Design §2 (principles and "Explicitly not used"), §3 (tokens only, no inline colours or new sizes), §4 (provenance marks), §6.0 (global states), §8 (number formats and voice), §9 (accessibility) and §11 (model types and component boundaries), plus the subsections in the session's **Design:** line.
  - Reuse what S4/S5 built: `ui/tokens.*`, `ui/format.ts`, `ui/states.tsx`, `ui/status.tsx`, `ui/motion.ts`, `ui/Tooltip.tsx`, `ui/VeinPulse.tsx`, `ui/TxTray.tsx`, `components/SporeArtwork.tsx`, `model/types.ts`. Component names are the ones in Design §7.
  - Where a session's **Do** list and its Design subsections disagree, Design wins on look, layout, wording and interaction; the **Do** list wins on scope; SPEC and the code win on mechanics (Design "Precedence"). The **Design:** line names the known conflicts.
  - Every state the screen's Design subsection lists is reachable in a test or in the session's manual check.
- **Reuse, do not duplicate.** Use the hiring rules (`agents/src/rules.ts`, imported directly), the epoch math (`spores_core`, through `core-wasm`) and the renderer (`spores_renderer.wasm`). No second implementation of core math in JS.
- **Gates before finishing any session that touched them:**
  - `cargo test --workspace`
  - `cargo clippy --workspace --all-targets` (warning-free)
  - `(cd agents && npm test)`
  - `(cd viz && npm test)`
- README TODOs are filled only from real output (CLAUDE.md rule).

## Architecture

```
viz/                          Vite + React + TS
  src/chain/rpc.ts            browser port of agents/src/near.ts read path (fetch only; rotation; archival fallback)
  src/chain/router.ts         typed views (names from the router ABI; see Reference A)
  src/chain/events.ts         EVENT_JSON parsing (standard "spores" and "nep171")
  src/chain/wallet.ts         wallet integration: @hot-labs/near-connect 0.12.0 (S8 VERIFY, docs/verify-notes.md)
  src/model/types.ts          SporeState, Tube, EpochClose, Decision, Receipt, SceneRun, Source
  src/model/normalize.ts      raw views/events/logs -> model; per-epoch graph history
  src/sources/live.ts         testnet RPC
  src/sources/run.ts          local run dir served by the Vite dev server (/runs/<name>/...)
  src/sources/recorded.ts     committed bundle in viz/public/recorded/<run>/
  src/wasm/renderer.worker.ts spores_renderer.wasm in a Web Worker
  src/wasm/core.ts            core-wasm (replay, state hash)
  src/graph/                  ring layout, canvas draw, epoch tweening, hit testing
  src/pages/                  Overview, Network, MySpores, Market, Activity, Spore/:id, DemoLab
  src/ui/                     tokens.css, components (SourceBadge, TxButton, Stale, Empty, ErrorBox, Tooltip)
core-wasm/                    new crate: C ABI over spores_core (pattern: renderer/src/wasm.rs)
agents/src/scenes/            rogue.ts, sale.ts (from run.ts runSale), wash.ts (stretch)
agents/src/scene-server.ts    127.0.0.1 only; runs scenes with .env keys; streams JSONL over SSE
scripts/demo.sh               the one command (+ --playback <run>)
```

The hiring rule is shared with the agents: a Vite alias (`@rules` → `../agents/src/rules.ts`) imports `score`, `pick` and `dNorm` directly. That file has no imports, so it runs in a browser as is.

---

## Sessions

Each session lists: **Needs** (what must be true first), **Do**, **Files**, and **Done when** (checks that must pass).

### S1. Sim at 64 active, wash data for the UI
**Needs:** nothing.

**Do:**
- Add a `max_active` override to `spores-sim` (CLI flag, default unchanged).
- Rerun `all` and `sweep` at 64 active. Report whether the §9 gate holds: "loses money and cannot reach the honest median R", plus the per-NEAR numbers.
- Extend `sweep.json` with the honest group's net and per-epoch series (attacker and honest: balance, fees, R) so the wash panel can chart them.
- Do not change core math. If core changes after all, regenerate `vectors/core.json` and say so.

**Files:** `sim/src/main.rs`, `sim/src/economy.rs`, `sim/src/report.rs`.

**Done when:**
- `cargo test --workspace` and clippy are clean.
- `out/sweep-64.md` and `out/sweep.json` (with the new fields) exist.
- The session log records gate pass counts at 16 and at 64.

### S2. NEAR limits, close cost at 64, keeper fix
**Needs:** nothing (can run in parallel with S1).

**Do:**
1. **VERIFY** in the current NEAR docs: the max log length per receipt, the max number of logs, the max gas per tx and view call, and the storage price. Write one line per item with a source URL into `docs/verify-notes.md`.
2. Estimate the `epoch_closed` log size at 64 active.
   - The event carries `tubes` (all edges), `flows`, `rejects`, `rebates` and `active`. The worst case is 2016 tubes; the realistic case comes from the S1 sim edge counts.
   - Use a router unit test that builds the event at N tubes and measures its JSON length.
   - If the worst case passes the log limit, say so. If it does not, **stop and report** the real ceiling. Splitting the event changes `verify` and the router, so it needs a decision.
3. Keeper: take `commit_image` off the close path (`agents/src/keeper.ts:45-63`).
   - Close first, then render and commit asynchronously, and never block the next close.
   - This fixes the ~100 s epochs (`docs/results.md`).

**Files:** `docs/verify-notes.md`, `router/src/epoch.rs` (test only), `agents/src/keeper.ts`.

**Done when:**
- The limits are recorded with sources.
- The log-size numbers are in the session log.
- Keeper tests pass. A short testnet run against router4 can be deferred to S3; if so, note it.

### S3. Grow router4 to 64 active, agent load, funding
**Needs:** S1 gate result acceptable, S2 limits OK (or a decision taken on the ceiling).

**Do:**
0. **Router change (the only one this phase).** No state layout change, so it ships as a code-only redeploy of router4.
   - `set_max_active(max_active: u32)` in `router/src/lib.rs`: admin only, raise only (`max_active > config.max_active`), at most `supply_cap`. Emits `config_changed` with the old and new value. It also recounts the escrowed jobs (below) once.
   - **Trim `epoch_closed`** (S2 decision): drop `tubes` and keep the `edges` count. `verify` already recomputes the tubes and only cross-checks them; make that check apply only when the field is present (router4 epochs 1–16 have it).
   - **Cap trading pairs per epoch** at `MAX_EPOCH_PAIRS` (a const, sized by the S2 test so the trimmed event's worst case at 64 active fits with margin). `accept` on a pair not yet in this epoch's flows or rejects is refused (`"epoch pair cap reached: try next epoch"`) when `|flows ∪ rejects| + escrowed jobs ≥ MAX_EPOCH_PAIRS`. Escrowed jobs can settle after the close, so they are counted. The count lives under its own raw storage key (not in the state struct): +1 in `accept`, −1 in `finish_job` for jobs with a provider, recounted by `set_max_active`. Invariant tested: the pairs in any close ≤ the cap.
   - Agents treat the refusal like any failed accept (log it, try next epoch). Known limit for the README: an owner with many spores can hold slots with jobs it never delivers (4 per spore, refunded at the timeout).
   - Unit tests: non-admin, lowering and above `supply_cap` rejected; activation of spore 17 works after the raise; the cap refuses a new pair and allows an existing one; the counter matches the jobs map after random operations (extend the ledger test); the trimmed event at the cap fits the log limit.
   - State layout unchanged, so router4 keeps its state (`REDEPLOY=1` path in `setup.ts:183-189`). Don't touch other doc comments in `router/` without need: every one changes the wasm hash.
   - `MAX_POSTED_JOBS` bounds job storage at `max_active × 4` records, so the router's storage need grows; check its balance against it before raising.
   - `verify` reads only `Config::params()` from the `config` view, so raising `max_active` does not change the replay of epochs 1–16.
1. **Agent load.** 64 one-process agents would run into RPC rate limits (FastNEAR limits after about 17 requests, `docs/results.md`).
   - Add a multi-spore mode to `agent.ts` (one process, N spores), or stagger job posting.
   - Measure requests per epoch.
2. **Funding arithmetic** (write it in the session log): about 5.4 NEAR of storage, plus 64 × (≥ 0.1 NEAR activation + working balance), plus outside/keeper/operators, compared against what the faucet gives. Add a top-up step (balances drain, `docs/results.md` "Open for the team").
3. Setup: `SETUP_PHASE=6` in `agents/src/setup.ts`, against router4 (no init, no mint: all 64 exist).
   - Code-only redeploy of router4, then `set_max_active(64)` from the admin.
   - Operators and keeper FC keys under `P6_` for the spores that are not run yet; spore 5 stays with `buyer` / `operator2`.
   - Script: `scripts/phase6-setup.sh`, idempotent like `phase5-setup.sh`.
4. Record in the session log and `docs/results.md`: the new wasm sha256, the redeploy and `set_max_active` tx hashes. Phase 5 evidence stays valid (it was produced by wasm `640c093f…`; the tx history keeps it), but every place that names router4's current hash must change.
5. Run a dense close on router4 (many spores active, several epochs) and record gas and log size.

**Files:** `router/src/lib.rs`, `router/src/tests.rs`, `agents/src/agent.ts`, `agents/src/run.ts`, `agents/src/setup.ts`, `scripts/phase6-setup.sh`.

**Done when:**
- `cargo test -p spores-router` passes with the new tests.
- Router4 reports `max_active` 64 from its `config` view and has more than 16 active.
- A short run (e.g. 3 epochs, ≥ 16 active) closes every ~30–40 s.
- `spores-verify epochs` still matches on router4 from epoch 1, through the redeploy.
- The session log has gas, log size, requests per epoch and funding.

### S4. Viz scaffold, design tokens, shell, chain layer
**Needs:** nothing. Use router4 (limited to 16 active until S3); the router id comes from config (`VITE_ROUTER`).

**Do:**
- **Scaffold:** `npm create vite` (React + TS) in `viz/`, plus react-router, vitest and @testing-library/react. Keep dependencies few.
- **`tokens.css` + `tokens.ts`:** exactly the tokens in Design §3:
  - Colours, including the 5 palettes copied from `renderer/src/paint.rs` with a comment citing it. Palette index is `seed[31] % 5`.
  - Type: Instrument Serif, Geist and Geist Mono, self-hosted; VERIFY the package names first.
  - Spacing, radius, layers and motion.
- **Shell (Design §5):** top bar (Overview, Network, My Spores, Marketplace, Activity; Demo Lab as a secondary link), `SourceBadge`, `EpochClock`, wallet button placeholder, tx tray, mobile bottom bar, `prefers-reduced-motion` hook, and the global states (Design §6.0).
- **`rpc.ts`:**
  - Endpoints rotated: `https://test.rpc.fastnear.com`, `https://near-testnet.drpc.org`.
  - Old txs fall back to `https://archival-rpc.testnet.near.org`.
  - Backoff and retry as in `agents/src/near.ts:15-46`. CORS was checked OK on all four on 2026-11-03.
  - Uses `fetch`, `atob` and `TextDecoder` only. No Node APIs.
- **`router.ts`:** typed wrappers for the views in Reference A.
- **Polling:** `epoch_info` every ~10 s, plus a refresh at `ends_ns`.
- **Bulk reads:** `nft_tokens` (paged, e.g. 16 per call), `edges()`, `listings()`, `config()`. No per-spore `spore_summary` storm; fetch a summary only on the detail page.
- **Sources:**
  - `live.ts`.
  - `run.ts`: a Vite dev-server middleware serving `out/agents/<run>/` read-only. Only the files listed in Reference C; never `.env` or any path outside `out/`.
  - `recorded.ts`: reads `viz/public/recorded/<run>/`.

**Done when:**
- `npm run dev` shows the shell with a live epoch counter from router4 and the source badge.
- `npm test` covers the rpc rotation/backoff (mock fetch), event parsing and source labeling.

### S5. core-wasm and renderer worker
**Needs:** S4.

**Do:**
- **New crate `core-wasm/`** (workspace member, `cdylib`, C ABI like `renderer/src/wasm.rs`: `alloc`, `dealloc`, call, read result). Exports:
  - `replay(json)`, where the input is `{params, epochs:[{epoch, prev_fingerprint, active, flows, rejects, pool}]}`. It runs `spores_core::epoch::close_epoch` for each epoch, carrying D forward from GENESIS, and returns `[{epoch, fingerprint, tubes}]`.
  - `params` maps from the router `config` view, exactly as `verify/src/main.rs:157-171` does (rebate rule `CappedRebate`).
  - `state_hash(json)`, where the input is `{spore_id, epoch, seed, age, edges}`. It returns the hex from `core/src/state.rs`.
  - JSON goes through `serde_json` in the wrapper crate only; core stays dependency-light. u128 values are decimal strings.
- **Check:** `core-wasm/js/check.mjs` runs the wasm against `vectors/core.json` (`epoch_chains`, `spore_state`).
- **Build script:** `scripts/build-wasm.sh` builds `spores-renderer` and `core-wasm` for `wasm32-unknown-unknown` and copies both into `viz/public/wasm/` (git-ignored; built by `demo.sh` and the README steps).
- **`renderer.worker.ts`:**
  - Input layout per `renderer/src/lib.rs:38-56`: `seed[32] | age u32 | n u32 | n×(id u32, D u64)`, little-endian.
  - Calls `render_into`, then `hash_image`. Returns RGBA for a canvas and the hex image hash.
  - A queue with priority (visible cards first) and an IndexedDB cache keyed by state hash plus `RENDERER_VERSION`.

**Done when:**
- `node core-wasm/js/check.mjs` passes.
- A vitest runs the renderer wasm on `vectors/renderer.json` cases and matches every hash.
- `cargo test --workspace` and clippy are clean.

### S6. Collection gallery
**Needs:** S5.

**Design:** §6.B (header row, `SporeCard` overlays and scrims, state markers, image-hash badge, hover, sort and filter chips, states, mobile, accessibility), §1.5 (states), §3.1.3 (where palette colour may appear), §3.3 (gallery card grid), §5.1 (the gallery is `/market?view=all`, reused by `/mine`). Components (§7): `SporeCard`, `SporeIdentity` / `SporeRef`, `StateMarker`. Conflicts with **Do**, resolved by Design:
- Badge words are `✓ image`, `✕ image`, `○ no commit` and `◷ older commit`.
- Loading is 64 cards showing their real glyphs, each replaced as its render finishes. No skeleton (§2, §6.0).
- Stale is the top-bar badge plus stale value styling (§4.2), not a separate banner.
- Hover extends the bottom scrim with `partners #3 #12 #40`.

**Do:**
- Grid of 64 square cards with the art dominant. Overlay `Spore #N` (serif), epoch, degree, R, active/dormant, owner short id, and listed price.
- The art comes from the worker. While it renders, the on-chain glyph (NEP-177 `media` data URI) is the placeholder, labeled "on-chain glyph".
- **Hash badge per card:**
  - **match** or **mismatch** when the committed image epoch equals the current state epoch.
  - **no commit** otherwise.
  - **older commit (verify on detail page)** when the commit is older.
  - This is a real check, because the hash is computed anyway.
- Hover shows the partner list. Click opens `/spore/:id`.
- States: loading skeleton, RPC error with retry, stale banner, and an empty filter result.

**Done when:**
- Against router4, the 9 active spores render.
- The spore 5 badge agrees with `cargo run --release -p spores-verify -- image --router spores-hack-router4.testnet --closes docs/phase5-closes.txt --spore 5` (`image: match`) when the epochs line up.
- Tests cover the badge logic and the states.

### S7. Network explorer
**Needs:** S5, plus epoch history (close tx hashes from a run, a recorded bundle or a `docs/<router>-closes.txt`).

**Design:** §6.C (geometry, nodes, tubes, Show change, scrubber, interaction, node and tube inspector, legend, mobile bottom sheet, performance, accessibility), §1.2 (the same angles as the art's `ring_pos`), §3.4 (glow only on the selected node and a tube that just grew), §3.5 (epoch-close tween, reduced motion and the truth rule: tubes move only at a close, never on `job_settled`), §4.3 (receipts vs flows only). Components (§7): `NetworkGraph` (`explorer` here; S14 adds `compact`), `EpochScrubber`, `NetworkEdgeDetails`, `ReputationIndicator`, `ConductivityIndicator`. Conflicts with **Do**, resolved by Design:
- Epochs without loaded history are hollow ticks, and their values show `—`.
- The "Table view" toggle (sortable spores and tubes, same selection) is required, not optional: it is the canvas alternative in §9.
- The no-receipts text is "Per-job receipts need the run log. On chain: per-epoch flows only."

**Do:**
- **Layout:** 64-slot ring with angle from id, the same as the art's ring.
  - Nodes sized by R and colored by palette. Active nodes are bright and dormant ones faint.
  - Each node has a bright nucleus and partner rings, in the style of the art.
- **Tubes:** width ∝ `isqrt(D)`, brightness ∝ D. Below `D_min` they are dimmed or not drawn, matching the contract (the threshold comes from `config.d_min`).
- **History:** fetch each close tx. Router4 epochs 1–16 carry `epoch_closed.tubes`; later events don't (S2), so tubes come from replaying every close since epoch 1 with core-wasm, as `verify` does (S5). Current state comes from `edges()`.
  - The epoch scrubber tweens only the tubes that changed.
  - Live updates when `epoch_info.epoch` advances.
- **Interaction:**
  - Pan and zoom (wheel, drag, keyboard), plus a reset button.
  - Clicking a node opens a side panel linking to the detail page.
  - Clicking a tube opens the edge panel:
    - D per epoch, and flows per epoch from `epoch_closed.flows`.
    - Per-job receipts when a run or recorded log has the settle tx hashes.
    - Otherwise the panel says "per-job receipts need the run log; chain has per-epoch flows".
- **Legend:** node, tube width, brightness, color, dormant.
- No decorative edges: only tubes from chain.

**Done when:**
- The scrubber over router4's 16 epochs shows the same tube set as each `epoch_closed.tubes`, and the replay reproduces those tubes (unit test on normalize).
- Hit testing is tested.
- With reduced motion on, there are no tweens.

### S8. Spore detail, wallet, owner actions, My Spores, Market
**Needs:** S5. S7 is helpful.

**Design:** §6.D (two-column layout with sticky art; identity, primary figure `R`, inline secondary figures, connections, agent and policy, market, activity and Technical blocks; mobile order), §6.D.1 (primary and "More" actions per state, disabled actions with the contract's reason, Buy consequences), §6.F (`MarketplaceListing`, purchase flow, list flow with the net from `nft_payout`), §8.3 (fixed tx copy), §1.6 (units), §4.2 (no mark for values the router computes at read time; tooltip only), §5.4 (breadcrumbs), §11 (`canAct(action, holding, wallet)`; wallet identity separate from ownership). Components (§7): `TxAction`, `ConfirmationDialog`, `WalletStatus` (replaces the disabled S4 shell), `BalanceDisplay`, `AllowanceDisplay`, `AgentStatus`, and the `SporeCard` `listing` variant. Conflicts with **Do**, resolved by Design:
- The **Do** list's `TxButton` is `TxAction`. Its states are idle → confirm → signing → pending → ok | failed, plus cancelled, with the §8.3 copy.
- Every action goes through `ConfirmationDialog`, which shows the method, arguments, deposit and consequences.
- While a spore is listed, Pause and Withdraw are shown disabled with the contract's reason, not hidden.
- If S9 hasn't run yet, the detail page's Activity block is `Unavailable`, naming S9 (it reuses `EventFeed` `compact`).

**Do:**
- **Wallet:** **VERIFY** first. Read the current NEAR docs for wallet-selector package names and versions and which wallets support testnet, and record them in `docs/verify-notes.md`. Then implement `wallet.ts`: connect, disconnect, account, sign and send, outcome.
- **Detail page:**
  - Large art, `Spore #N`, epoch, palette name, seed (short).
  - Connections list (D and R share), balance, R, degree, age, operator and `operator_gen`, policy fields, `effective_budget`, `budget_left`, `spent_this_epoch`, sales, transfers, listing.
  - Committed image and state hash.
  - Tooltips:
    - **R** = Σ isqrt(D), one tube at D=1.0 gives 1000.
    - **D** (tube conductivity) = how much settled flow, with decay.
    - **Allowance** = min(owner budget, base + trust_gain × R/1000).
  - Values that are views but computed at read time are shown as such. "Derived" is used only for values the browser computes.
- **Epoch compare:** before/after art from history replay (core-wasm tubes plus age). This is stretch; see Cut order.
- **Owner actions** (Reference A), gated by wallet == owner and state:
  - `activate` (deposit ≥ `config.min_activation_deposit`)
  - `set_policy` (1 yocto; also used to unpause)
  - `pause` (refused while listed)
  - `register_operator` (1 yocto; "revoke" = replace the operator, explained in UI)
  - `deposit`
  - `withdraw` (refused while listed)
  - `list` / `delist` (1 yocto)
  - `buy` (exactly the price; not the owner)
- **`TxButton` state machine:** idle → signing → pending → final ok | failed (contract error string shown verbatim) → explorer link `https://testnet.nearblocks.io/txns/<hash>`. Disabled while pending.
- **My Spores:** `nft_tokens_for_owner`.
- **Market:**
  - `listings()` joined with token data (art, R, degree, age), plus the buy action.
  - Sale history from `spore_sold` events when the source has the hashes; otherwise `sales` counts from `extra`.

**Done when:**
- Unit tests cover action gating and the tx state machine (no success before the final outcome).
- A manual testnet check: list then delist one router4 spore from a wallet, with explorer links recorded in the session log.

### S9. Activity: decision log and receipts
**Needs:** S4 (sources). S7 helps for jump-to-edge.

**Design:** §6.E (sticky filter bar and its kinds, epoch-grouped rows with a sticky header, 52 px collapsed row and kind glyphs, the six parts of `DecisionEntry`, policy refusal rows, close rows with `Verify →`, live-only mode, mobile, accessibility), §6.G (`TransactionReceipt` layout and kinds), §4.3 (evidence ladder), §4.2 (`≈` and `↻` marks), §3.5 (settlement-row motion), §5.5 (receipt → Network edge, epoch → scrubber). Components (§7): `EventFeed` (`full` here; `compact` is reused by S8 and S14), `DecisionEntry`, `JobTimeline` (`job`; S11 reuses it as `scene`), `TransactionReceipt`. Conflicts with **Do**, resolved by Design:
- The "derived reason" is the §6.E summary sentence, prefixed `≈`.
- Recompute shows `↻ matches log` or `↻ differs` (expandable).
- The score caption takes `w`, `w_bps` and the tie rule from the log's `rule` field, not constants.
- A receipt whose tx the app hasn't fetched yet is **Logged** (`○` plus Fetch), never shown as confirmed.

**Do:**
- Parse `decisions.jsonl` (Reference C).
- **Decision card:**
  - consumer, service, attempt, candidates table (price in NEAR, `d`, `d_norm`, score), `w = w_bps/10000`, norm, winner, outcome (`settled`, `rejected`, `accept_failed`, `over_budget`, `low_balance`, `timeout`, `settle_failed`, `reject_failed`), job id, and tx links for post/accept/settle|reject.
  - **Recompute** with `@rules` (`dNorm`, `score`, `pick`) and show "recomputed: matches log" or "differs".
  - **Derived reason**, labeled as derived, e.g. "lowest score; tube D=… cut its score by …% vs quote" or "only candidate".
  - When the close for epoch−1 is loaded, check each candidate's `d` against the previous epoch's tubes (from the event or the replay, see S7).
- **Receipts:** settled jobs from settle tx outcomes (`job_settled{job_id, consumer, provider, price, fee, epoch, auto}`), fetched lazily per tx. Show sender, recipient, amount, fee, epoch, status, edge and explorer link. Clicking a receipt jumps to the Network edge.
- **Other events:** `events.jsonl` items: close, commit_image, sale steps, shocks, idle/resumed, failed txs with `err`.
- **Filters:** spore, epoch, kind, outcome. Use a virtualized list (95+ decisions, 900 events).

**Done when:**
- Tests: all 95 phase5-exit2 decisions recompute to "matches", the same as `spores-sim replay-decisions`; filters work; malformed lines go to an error row and are not dropped.

### S10. Verify button
**Needs:** S5, plus close hashes from the source.

**Design:** §6.G `/verify` (a header naming the router, the epoch range and where the close hashes came from; the progress steps; the results table columns; an image section with the render beside the glyph; a footer listing what was and was not checked), §4.3 (evidence words), §5.1 (`/verify` is secondary, reached from the detail page, close rows and receipts). Components (§7): `VerificationResult` (`full` on `/verify`; `compact` in the detail page's Technical block and on close rows). Result words: `✓ Match`, `✕ Mismatch` (expandable diff) and `! Unable` with its reason.

**Do:** mirror `verify/src/main.rs`.
- **Epochs:**
  1. Read `config` and map it to params.
  2. For each close hash, call RPC `tx` (`wait_until: FINAL`, signer = keeper/admin), check `receiver_id == router`, and take the `epoch_closed` event.
  3. The epochs must start at 1 with no gaps, or the result is "Unable: missing epoch N".
  4. Run core-wasm `replay`.
  5. Compare with the event `fingerprint`, its `prev_fingerprint`, its `tubes` and the `fingerprint(epoch)` view, and finally `epoch_info.prev_fingerprint`.
- **Image** (`verify/src/main.rs:303-344`):
  1. Take tubes at the commit epoch from the replay.
  2. age = commit.epoch − (epoch_info.epoch − summary.age).
  3. `state_hash` vs `commit.state_hash`.
  4. Render, then image hash vs `commit.image_hash`, and `renderer_version`.
- **UI:** a table with one row per epoch (what was checked, which tx, which view), outcome **Match**, **Mismatch** or **Unable to verify** (with reason: archival rate limit, missing tx, RPC down), and progress. Results are never cached as "verified"; each click recomputes.
- **Commit close hashes for judges:**
  - Router4 already has `docs/phase5-closes.txt`.
  - Add `docs/phase6-closes.txt` (the closes after epoch 16, from the Phase 6 runs) so verification works without `out/`. `verify` needs every close since epoch 1, so router4 checks pass both files.

**Done when:**
- Against router4 with `docs/phase5-closes.txt`, the button shows 16× Match and `image: match` for spore 5, the same as the CLI.
- A test with a tampered event gives Mismatch.
- A test with a missing epoch gives Unable.

**Done 2026-11-05; see the session log.** Two steps changed: `docs/phase6-closes.txt` was not added, because `docs/router4-closes.txt` (S7) already holds all 25 closes and the app serves a copy; and the app's list is that one, so the button shows 25 × Match on router4 (the 16-close run of the Done-when was made in Chrome by swapping in `docs/phase5-closes.txt`).

### S11. Scene server and Rogue scene
**Needs:** S3 (router4 at 64 active), S9 (timeline components).

**Design:** §6.H (index with four `DemoSceneCard`s and mode chips; scene page with three columns: Brief with a live preconditions checklist, a Timeline streamed over SSE, and Outcome and Evidence with a one-line verdict; Rogue's two lanes, "Agent attempted" (marked scripted) and "Contract decided"; the decay strip at N, N+1 and N+2 with D values), §5.1 and §5.4 (`/lab`, `/lab/:scene`, breadcrumb `Demo Lab / Rogue agent`), §8.2 (voice: "Refused by the contract"). Components (§7): `DemoSceneCard`, `JobTimeline` `scene`, `TransactionReceipt`. Conflict with **Do**, resolved by Design: the Scene A card uses the §6.H copy and styling (full size, dashed outline, `--text-3` title, link to Rogue, no run button), not the shorter line below.

**Do:**
- **`agents/src/scene-server.ts`** (no new deps, `node:http` like `outside/`):
  - Binds `127.0.0.1` and refuses other hosts.
  - `GET /scenes`, `POST /scenes/:id/run`, `GET /scenes/:id/stream` (SSE of the scene's JSONL), `POST /scenes/:id/reset` (only where safe).
  - Reads `.env`; keys never leave the process.
- **`agents/src/scenes/rogue.ts`** on router4:
  1. Pick a test spore and record its state.
  2. As owner, `set_policy` with a small `budget_per_epoch`, small `max_payment`, `allow_all_spores:false` (allowlist of one spore), and an `external_allowlist` without the attacker.
  3. As operator, run three attempts, each recording the tx hash and the expected error verbatim:
     1. `post_job` → a provider quotes above `max_payment` → `accept` expects `"policy: payment exceeds the per-payment cap"`.
     2. Accepts that sum past the budget expect `"policy: epoch budget exceeded"`.
     3. `pay_service` to an attacker account expects `"policy: payee is not on the external allowlist"`.
  4. Then stop the spore's agent for N epochs and record its tubes decaying from `epoch_closed`, with before/after renders.
- **Demo Lab panel** (shared): purpose, preconditions (checked live), Run, timeline, state diff, receipts, Reset if safe.
  - A scene shows "completed" only if the script exits 0 and every check passed. Otherwise it shows which check failed.
- **Scene A card:** "Unavailable: no LLM agent was built (decision D2). Contract enforcement is shown in the Rogue scene."

**Done when:** (all met, see the session log 2026-11-06)
- The rogue scene runs on router4 with three failed txs carrying the exact error strings and explorer links, plus visible decay.
- The run is saved as a recorded bundle.
- Scene-server tests cover the localhost-only check and SSE framing.

### S12. Sale scene and wash panel
**Needs:** S11.

**Design:** §6.H "Sale specifics" (the 11 checks as numbered steps; ownership flips only when `buy` is final; payouts read from receipts) and "Wash specifics" (the question heading, the primary figure, a worst-cases table that states failures as failures, the fixed sentence, a 2-series chart with attacker in `--warn` and honest in `--text-2`, direct end labels, no legend box; apply the `dataviz` skill when building it), §4.1 (SIMULATION panel: dashed outline, dashed series), §4.2 (nothing simulated is mixed into chain figures). Conflict with the Design text: §6.H's primary figure reads `270 / 270`, but the S1 log has 64×1 (testnet traffic) at **168/270** and 16×1 at 255/270. The figure must name its configuration, and the panel shows every configuration S1 measured, not only the favourable ones.

**Do:**
- **Sale:** move `runSale` (`agents/src/run.ts:139-211`) into `agents/src/scenes/sale.ts` and keep `run.ts` calling it.
  - Checks kept: list → buy (separate buyer account) → payouts seller 95% / royalty 5% from receipts → `spore_sold` event → old operator key `post_job` fails → old owner `withdraw` fails → new policy paused with zero budget → balance, tubes and age unchanged → buyer `register_operator` + `set_policy` → agent resumes.
  - The UI shows each step with its tx link.
  - Handle insufficient funds and RPC failure as failed steps, never as success.
- **Wash panel (SIMULATION):** from a committed copy of the sim output (`viz/public/recorded/sim/`). Content:
  - The gate result (Phase 1: 270/270 in range at 16 active, and the S1 result at 64).
  - Worst nets.
  - The 6 out-of-range gate failures (K=0.5, loop 5, 3 spores).
  - The 93/270 per-NEAR literal failures for tiny loops (≤ 0.05 NEAR).
  - The attacker vs honest per-epoch chart (S1 data).
  - It says plainly: "Receipts and escrow do not stop an attacker controlling both sides; the defense is economic. No universal Sybil resistance is claimed."
- **Stretch:** `scenes/wash.ts` on router4. Two spores, one owner, a loop of size X for E epochs. Report from chain: fees paid, rebates, balance change, R vs the honest median.

**Done when:** (all met, see the session log 2026-11-06; the testnet wash stretch was not built)
- The sale scene passes all checks on router4 and is saved as a recorded bundle.
- The wash panel numbers match `out/phase1-report.md` and the S1 output exactly (test against the committed copy).

### S13. One-command demo and recorded fallback
**Needs:** S3, S4–S12 (at least gallery, network, activity, verify).

**Design:** §4.1 (RECORDED badge plus the 28 px banner, which can't be dismissed), §6.H "Playback" (Replay instead of Run, Reset hidden, recorded relative times with a 4× option, tx links stay live), §6.0 (with the network off, live regions show `ErrorState` or `! Unable`; never a silent switch to recorded data), §5.1 (`?source=recorded&run=` persists across navigation).

**Do:**
- **`scripts/demo.sh`:**
  1. Preflight: `~/.cargo/bin` on PATH, Node ≥ 23.6, `.env` has `P6_` keys and the router id. If not, print `bash scripts/phase6-setup.sh` and exit 1.
  2. `scripts/build-wasm.sh`.
  3. `npm ci` in `agents/` and `viz/`.
  4. Start the run with `node agents/src/run.ts` (router4, seed fixed, waves of wakes, sale@N) plus the scene server and `viz` dev server pointed at the run dir. Open the URL.
  5. Print each stage with "you should see …": wakes, first hires, first close (~30 s), tubes appear, art changes, sale, verify.
  6. At the end, run `spores-verify epochs` and `image` and print their output.
- **Top-up:** if spore balances are below a floor at the start, deposit (owner key).
- **Playback:** `bash scripts/demo.sh --playback <run>` serves the viz with `?source=recorded&run=<run>`.
  - Playback steps through the bundle's epochs on a timer with a persistent **RECORDED · <run>, <date>** banner.
  - Verify still re-checks the recorded close hashes against chain when RPC is up, and shows Unable when it is not.
- **Recorded bundle:** `scripts/record-bundle.sh <run>` copies `run.json`, `report.json`, `decisions.jsonl`, `events.jsonl`, `snapshots/`, `renders/*.png` and a closes list into `viz/public/recorded/<run>/`.
  - It scans for secrets first (`ed25519:` private keys, seed phrases, `.env` values) and fails if any are found.

**Done when:** (met, with the gaps listed in the session log 2026-11-06)
- From a clean checkout, following the README steps, `bash scripts/demo.sh` runs to the end on router4 with ~30–40 s epochs.
- `--playback` works with the network disabled (except Verify, which shows Unable).
- The command and real output are pasted into the session log.

### S14. Overview, polish, accessibility, results doc
**Needs:** S6–S13.

**Design:** §6.A (hero row with `NetworkGraph` `compact`, the fixed serif line and body copy, the primary figure `Epoch N` with four inline figures, the 8-step loop strip and its click targets, the featured-spores rule and eyebrow, recent activity with its empty-state text, the zero-active and RPC-error states, mobile order, the aria summary plus "View as table"), §5.3 (mobile top and bottom bars), §9 (full audit: keyboard paths, live regions, contrast table, reduced transparency), §10 (measure and log JS gzip, wasm sizes, canvas fps and the epoch tween), §13 (add any new departures from the brief). Conflict with **Do**, resolved by Design: "collection health" is the one inline text line under the primary figure, not stat tiles (§2 principle 2). The fresh-eyes pass also checks every screen against §2 "Explicitly not used".

**Do:**
- **Overview:**
  - A three-line loop explainer.
  - Collection health from live counts: active/64, tubes, total D, epoch, payments settled this epoch, treasury.
  - A network preview, recent activity, and a "Watch the loop" entry to the demo.
- **Judge path:** the 60–90 s video script from SPEC §10 maps onto screens in this order: gallery → wake → decision log + art growth → rogue → sale → wash panel.
- **Polish:**
  - Keyboard navigation for nav, cards, graph and dialogs.
  - Focus rings, AA contrast, legible small metadata, reduced motion.
  - Responsive at 1280+, with tablet and phone stacked layouts.
- **Performance:** split state per page, redraw the canvas only for changed tubes, limit worker concurrency (≤ 2).
- **Docs:**
  - `docs/phase6-results.md`: results, measured numbers, deviations (D2 injection, D3 64 active, D4 names, any S2 ceiling).
  - Update README "Try it", "Status" and "Demo" **from real runs only**.
  - Tick ROADMAP Phase 6.

**Done when:** (see the session log 2026-11-07 for what was and wasn't seen) all gates are green, and a fresh-eyes manual pass (Chrome DevTools MCP) finds no broken state and no unlabeled source.

---

## Cut order (if behind)
1. Testnet wash loop (S12 stretch)
2. Epoch art compare (S8)
3. Wallet owner actions other than list, buy and set_policy (scripts still cover the rest)
4. Per-job receipts in pure-live mode
5. Phone layouts
6. 64 active (D3): if the event trim and pair cap slip, raise router4 to 22 only (the largest cap whose untrimmed worst case fits, S2) and say so in the README

Never cut: gallery with real art, network with history, decision log with recompute, Verify, rogue, sale, wash sim panel, demo command with recorded fallback.

## Dependency graph
- S1 and S2 can run in parallel; both feed S3.
- S4 → S5. After S5, S6, S7, S8, S9 and S10 can run in any order (S9 and S10 also need sources).
- S3 + S9 → S11 → S12.
- S3 + S6..S12 → S13 → S14.
- The viz sessions (S4–S10) can proceed against router4 before S3 raises it to 64 active.

---

## Reference A: router interface (router4, wasm `b82f4dcd…` since S3; Phase 5 ran on `640c093f…`)

JSON: `SporeId` u32 is a number; `U128`/`U64` are decimal strings; `epoch` and `job_id` are numbers; hashes are 64-char hex.

**Views:**
- `nft_tokens{from_index?: U128, limit?: u64}` → Token[]. `metadata.extra` is a JSON string with `seed, active, age, degree, reputation, transfers, sales, listed_price, state_hash, image{epoch,state_hash,image_hash,renderer_version}`. `media` is the glyph `data:image/svg+xml;utf8,…`.
  - Measured 26.33 Tgas for all 64 at 9 active; unmeasured at 64 active, so page it.
- `nft_token{token_id}`, `nft_tokens_for_owner{account_id, from_index?, limit?}`, `nft_supply_for_owner`, `nft_total_supply`, `nft_metadata`, `nft_payout{token_id, balance, max_len_payout?}`
- `spore_summary{spore_id}` → `{spore_id, owner_id, active, operator_id, operator_gen, balance, reputation: U64, age, degree, connections:[[n, D]], policy, spent_this_epoch, effective_budget, budget_left, seed, posted_jobs, serving_jobs, transfers, sales, listed_price?, state?:[epoch, hex], image?}`
- `render_input{spore_id}` → `{spore_id, epoch, seed, age, edges:[[n, D as number]]}`
- `edges()` → `[[a, b, D]]` with a<b, as of the last close
- `epoch_info()` → `{epoch, started_ns, ends_ns, prev_fingerprint, active, pool, flows:[[a,b,amt]], rejects:[[a,b,n]]}` (current epoch so far)
- `fingerprint{epoch}`, `config()`, `admin()`, `is_operator{spore_id, account_id}`, `listings()` → `[[id, price]]`
- `image_commit{spore_id}`, `glyph{spore_id}`, `get_job{job_id}`, `list_jobs{from_index?, limit?}` (default 50), `jobs_count`
- `ledger_totals()`, `storage_report()`

**Owner calls** (wallet, full-access key; 1 yocto where noted):
- `activate{spore_id, operator_id}` (deposit ≥ `min_activation_deposit`; operator ≠ owner; the spore stays locked until `set_policy`)
- `register_operator{spore_id, operator_id}` (1y)
- `set_policy{spore_id, policy}` (1y)
- `pause{spore_id}`
- `deposit{spore_id}` (deposit > 0, anyone)
- `withdraw{spore_id, amount}` (1y)
- `list{spore_id, price}` (1y)
- `delist{spore_id}` (1y)
- `buy{spore_id}` (deposit = price)
- `nft_transfer` (1y)

**Policy fields:** `{paused, budget_per_epoch, max_payment, allow_all_spores, allowlist:[u32], external_allowlist:[AccountId] (≤ 8)}`. There is no revoke and no unpause method.

**Operator calls** (FC key): `post_job{spore_id, task(≤256B), max_price}`, `quote{job_id, spore_id, price}`, `accept{job_id, provider_id}` (all policy checks here), `deliver{job_id, result_hash}`, `settle{job_id}`, `reject{job_id}`, `pay_service{spore_id, payee, amount, memo(≤64B)}`.

**Anyone:** `timeout_job{job_id}`, `close_epoch()` (after `ends_ns`).

**Admin:** `commit_image{spore_id, epoch, image_hash, renderer_version}`, `withdraw_treasury`, `mint_genesis`, `set_max_active{max_active}` (1y, raise only, ≤ `supply_cap`; emits `config_changed{field, old, new, escrowed_jobs}`).

**Events** are `EVENT_JSON:{"standard":"spores","version":"1.0.0","event":…,"data":[{…}]}`:
- Spore lifecycle: `spore_activated{spore_id, operator_id, deposit, epoch}`, `operator_registered`, `policy_set`, `spore_paused`
- Ledger: `deposit`, `withdraw`/`withdraw_failed`
- Jobs: `job_posted`, `job_quoted`, `job_accepted`, `job_delivered`, `job_settled{job_id, consumer, provider, price, fee, epoch, auto}`, `job_refunded{…, reason: rejected|timeout|transfer|sale|transfer_reverted}`
- Services: `service_paid{spore_id, payee, amount, memo, epoch}`, `service_payment_failed`
- Epoch: `epoch_closed{epoch, fingerprint, prev_fingerprint, active, flows, rejects, pool, edges(count), rebates, treasury}`. Router4 epochs 1–16 also carry `tubes:[[a,b,D]]`; from S3 on the tubes come from replay (`verify`, core-wasm)
- Market: `spore_listed`, `spore_delisted`, `spore_sold{spore_id, seller, buyer, price, seller_amount, royalty, royalty_account}`, `sale_payment_failed`
- Control and art: `control_reset{spore_id, from, to, reason, operator_gen, refunded_jobs}`, `image_committed`
- NEP-171: `nft_mint`, `nft_transfer` (memo `"sale"` on a sale)

**Policy failures panic** (the tx fails, no event). The exact strings:
- `"policy: spore is paused"`
- `"policy: payee is not on the allowlist"`
- `"policy: payee is not on the external allowlist"`
- `"policy: payment exceeds the per-payment cap"`
- `"policy: epoch budget exceeded"` (this is also the living allowance)
- `"insufficient balance"`
- `"caller is not this spore's operator"`
- `"only the spore owner can do this"`
- `"a listed spore cannot be paused; delist it first"`
- `"a listed spore cannot withdraw; delist it first"`
- `"attach exactly the listed price"`
- `"the owner cannot buy its own spore"`
- `"spore is not listed"`
- `"epoch has not ended yet"`
- `"too many active spores"`
- `"epoch pair cap reached: try next epoch"` (S3: `accept` on a pair not yet in this epoch's flows or rejects once those pairs plus escrowed jobs reach `MAX_EPOCH_PAIRS` = 224)

**Stored vs computed:**
- **Stored:** seed, balance, policy, operator, edges, flows, latest `(epoch, state_hash)`, image commit, fingerprints for every epoch.
- **Computed at read:** age, degree, R, effective budget, glyph, title.
- **Not on chain:** name, palette (`seed[31] % 5`, renderer only), rendered image, past tubes (only in `epoch_closed` logs), finished jobs (only in events), decision logs.

## Reference B: renderer and core
- **Renderer wasm:** `target/wasm32-unknown-unknown/release/spores_renderer.wasm`, 73 kB, no imports.
  - Exports: `memory, alloc(len), dealloc(ptr,len), image_len() = 786432, render_into(in, len, out) -> 0 ok | 1 parse error, hash_image(rgb, out32)`.
  - Input: `seed[32] | age u32 | n u32 | n×(id u32, D u64)` LE, length 40+12n. Output: 512×512 RGB.
  - Speed: ~0.6–1.0 s per image (wasm, one Mac).
- **`image_hash`** = sha256(`"spores/img/v1"` ‖ u32le(RENDERER_VERSION=1) ‖ u32le(512) ‖ u32le(512) ‖ RGB), hex.
- **`state_hash`** = sha256(`spores/state/v1|id|epoch|seedhex|age|n:D|…`) (`core/src/state.rs`).
- **Fingerprint** = sha256(`spores/fp/v1|epoch|prevhex|ids,asc|a:b:D|…`), with zero edges omitted (`core/src/fingerprint.rs`). GENESIS is 32 zero bytes.
- **Hiring:** `score = quote·10000·1e6 / (10000·1e6 + w_bps·D_norm)`, with `w_bps = 40000` (w=4). `D_norm` is relative: `min(d, ref)·1e6/ref`, where ref is the largest candidate d. Pick by lowest score, then lowest price, then lowest id (`agents/src/rules.ts:57-93`, `core/src/hiring.rs`).
- **Allowance:** `min(budget_per_epoch, base_budget + trust_gain·R/1000)`. Shipped values are base 0.1 NEAR and trust_gain 0.2 NEAR.

## Reference C: run logs (`out/agents/<run>/`, git-ignored)
- **`decisions.jsonl`:** `{run, at, epoch, job_id, consumer, service, task_hash, attempt, rule{w_bps, norm}, candidates[{provider, price, d, d_norm, score}], winner, tx{post, accept, settle|reject}, outcome, correct?, cut?, err?, budget_left?, balance?}`
- **`events.jsonl`:** `{at, spore, kind, …}`. Kinds:
  - `tx` (method, args, hash, ok, gas_tgas, err?); keeper `close_epoch` lines add `closed` and `fingerprint`
  - `start`, `margin`, `outside`, `idle`, `resumed`, `priced_out`, `killed`, `stop`, `error`, `shock`, `exit`
  - sale steps with `spore:"sale"`. Known bug: the final `done` line has `spore:<id>` (`run.ts:210`).
- **`snapshots/start.json`** (same shape, read before the first close; served since S13) and **`snapshots/epoch-NNN.json`:** `{label, epoch, fingerprint, epoch_info, edges, ledger, spores{id:{render_input, balance, reputation, degree, owner_id, operator_id, operator_gen, policy, effective_budget, listed_price, sales, state, image}}}`
- **`scene.jsonl`:** a run with a sale keeps the sale's lines in the scene format since S13 (`scenes/sale.ts`), with an `exit` line.
- **Other files:** `run.json` (`sale_spore`: picked at the start, since S13), `report.json` (checks, sale, verify, tx stats), `renders/<label>-spore-<id>.{png,json}`.
- **Committed copies:** `docs/phase5-closes.txt` (16 close hashes for router4), `docs/router4-closes.txt` (all 25 router4 closes, epochs 1–25, from the phase5-exit1/2 and phase6-s3-dense2/3 run logs; `spores-verify epochs` matches all 25; the app serves a copy as `viz/public/closes/spores-hack-router4.testnet.txt`), `docs/img/*` (spore 5 renders, glyph).

## Reference D: sim outputs (`out/`, git-ignored)
- **`sweep.json`:** `{epochs:40, seeds:[1,2,3], cases[722]}` (variants `spec` and `shipped`). Fields: `attacker_spores, fee_bps, k_milli_near, gain, loop_milli_near, k_in_gate_range, blocked, net_near_worst, tube_ratio_worst, rep_ratio_worst, attacker_max_rep, honest_median_rep, gate_pass, literal_pass`.
  - Since S1, also `active` at the top level, plus `attacker_net_near_by_seed`, `honest_net_near_by_seed` and `series` on every case. `series` is `[{seed, attacker, honest}]`, where each group has `balance_delta, fees, rebates, r_max, r_median`, one value per epoch for all 40 epochs. Money is in NEAR and R in `REP_ONE` units. It is filled only for each variant's default fee, K and gain (10 cases per variant) and is empty elsewhere.
  - `--max-active N` and `--jobs N` write suffixed files (`-64`, `-j1`). Only the allowance runs are kept for 64 active (`allowance-64.md`, `allowance-64-j1.md`), because the sweep without the allowance does not match the router. `baseline.json` rows now carry `tubes_mean, tubes_max, flow_edges_max, reject_edges_max, rebated_spores_max`.
- **`wash.json`** (S12, `spores-sim wash`, about 50 s): `{epochs, seeds, note, configs[4], phase1}`. Each config is a traffic level (16×3, 64×3, 16×1, 64×1) with the allowance the router enforces: `active, jobs, cases, gate_pass, loses_money, worst_net_near, worst_r_ratio, loops[10]`; each loop is `spores, loop_milli_near, cases, gate_pass, loses_money, worst_net_near, worst_r_ratio` (null: the honest median is 0) and `default{gate_pass, net_near_worst, attacker_max_rep, honest_median_rep, series[{seed, attacker_r, honest_r, attacker_money}]}` at the shipped fee, K and gain. `phase1` is the 16×3 sweep without the allowance, as first reported: `gate_in_range, gate_all, literal_in_range, literal[], out_of_range_failures[]`. Committed with the five reports it is tested against in `viz/public/recorded/sim/`; rerun and recopy after any change to core or sim.
- **Shipped results** (`out/phase1-report.md`):
  - Gate passes 270/270 in range and 355/361 overall.
  - The 6 gate failures are out of range (K=0.5, loop 5, 3 spores), with very negative net but attacker R just above the honest median.
  - The §9 literal criterion passes 177/270 in range; all 93 failures are tiny loops (0.01/0.05 NEAR, rep ratio up to 12.12).
- **`baseline.json`:** price-only vs tubes. Shipped "tubes rel w=4" vs price-only: price 0.1211 vs 0.0948, failed 25.3% vs 28.2%, unfulfilled 7.1% vs 7.6%, quality 0.746 vs 0.717.
- **`allowance.json`:** shipped 0.1 + 0.2 blocks 1.6% of hires and passes the gate 270/270; base 0.05 gives gate 0/270.

## Reference E: infrastructure facts
- **Routers:**
  - `spores-hack-router4.testnet` (current, admin `deployer.spores-hack.testnet`, 30 s epochs, `max_active` 64 and 64 active since S3; spores 9–63 owned by the deployer; spore 5 owned by `buyer.spores-hack.testnet` and run by `operator2`).
  - `router3.spores-hack.testnet` (Phase 4), `spores-hack-router2.testnet` (Phase 3), `spores-hack-router.testnet` (abandoned v0).
- **Config:** epoch length is fixed at init (router4: 30 s). `max_active` was raised 16 → 64 in S3 by `set_max_active` (`95UsZnqp…`).
- **RPC:**
  - FastNEAR (rate-limits after about 17 requests), dRPC, rpc.testnet, archival-rpc.testnet (old txs, rate-limited).
  - Old txs (S10, `docs/verify-notes.md` "Phase 6 S10"): only `archival-rpc.testnet.fastnear.com` and `archival-rpc.testnet.near.org` have them. Both rate-limit, and both send the 429 without a CORS header, so a browser sees `Failed to fetch`. The regular nodes take 2–30 s to say no.
  - Browser CORS was OK for all four on 2026-11-03.
- **Explorer:** `https://testnet.nearblocks.io/txns/<hash>`.
- **Phase 5 issues to fix:** epochs ~92–122 s (keeper commits on the close path), and balances drain (top-up needed).
- **Node:** v26.7.0 and npm 11.19.0 locally. Packages declare `node >=23.6`. There is no root `package.json`.

---

## Design system and UI/UX (D5)

Written 2026-11-03 from the team's design brief, on top of what the repo actually has. It is the visual and interaction source for S4–S14.

**Precedence:**
- Scope and honesty: the Decisions and Rules above win.
- Look, layout, wording and interaction: this section wins.
- Mechanics: SPEC.md and the code win over both.

**References:** `§N` inside this section means a subsection of this section. SPEC.md sections are always written "SPEC §N".

The product is NFT-first. There are no token pages, prices, charts or launch UI, and none are planned here.

### 1. Product truths that shape the design

These are facts from the code. Every visual rule below follows from one of them.

#### 1.1 The art is a picture of real data

The renderer (`renderer/src/paint.rs`, `sim.rs`) draws:
- **Nucleus:** a white disc at the centre. It is bright when the spore has tubes (degree > 0) and a dim accent disc when it has none.
- **Partner markers:** one ringed marker per partner (accent ring, dark fill, bright core). Each sits at that partner's ring angle.
  - Distance from the centre encodes D: `RING_R − 84·D_norm`, so stronger tubes pull partners inward.
- **Empty slots:** faint grey dots at the ring angle of every spore that is *not* a partner.
- **Tubes:** the Physarum trail between the nucleus and the partners, coloured by one of 5 palettes.
- **Decoration (not data):** 140 grain sparks, a vignette and a 1 px frame inset 9 px.

#### 1.2 Ring geometry is shared and fixed

Spore *N* sits at angle `N × 5.625°`, clockwise from 12 o'clock: spore 0 at the top, 16 at 3 o'clock, 32 at the bottom, 48 at 9 o'clock (`ring_pos`).

**Design rule:** the Network explorer uses the same angles, so spore 7 is in the same direction in every artwork and on the map. This is the product's signature: the map and the art are the same coordinate system.

#### 1.3 Palettes come from the seed

`palette = seed[31] % 5`. Each palette has 6 stops, and stop 3 is the **accent** used for partner rings and the nucleus glow. The palette is identity only; it never carries status. The values are copied exactly in §3.1.3.

#### 1.4 Names

The on-chain title is `Spore #N` (D4). There are no generated names. The prototype sheet `slime_example.png` used invented names (Solriri, Rithimir…); those do not ship.

#### 1.5 States that really exist

| State | How it's known | Source |
| --- | --- | --- |
| **Dormant** | `active:false`. Minted, never activated. There is no deactivate method, so a spore never returns to dormant | `extra.active` |
| **Awaiting policy** | `active:true`, `policy.paused:true`, operator set, `transfers == 0` | `spore_summary` |
| **Active** | `active:true`, `policy.paused:false` | `spore_summary` |
| **Paused** | `active:true`, `policy.paused:true`, after the owner called `pause` | `spore_summary` (and `spore_paused` event if the source has it) |
| **Listed** | `listed_price` present | `extra.listed_price`, `listings()` |
| **Control reset** | after a transfer or sale: operator cleared, policy paused, budget 0 | `control_reset` event; otherwise `transfers > 0` plus paused plus no operator (labelled **derived**) |
| **Decaying** | every tube's D fell at the last close, with no flows into the spore that epoch | **derived** from two consecutive epochs' tubes (event or replay, S7) |
| **Rendering** | the browser is computing the image | worker queue |
| **Activated** (coarse) | `active:true` when the view has no policy: covers awaiting policy, active, paused and control reset. Team decision 2026-11-04 (S6): the bulk views (`nft_tokens`, `epoch_info`) carry no policy, and a `spore_summary` per spore is ruled out (§10), so LIVE gallery cards say `◉ Activated` and the Spore page gives the exact state. Run snapshots carry the policy, so LOCAL RUN / RECORDED cards show the full set | `extra.active` |

There is no "dead", "evolved", "rare" or "level" state, so the UI never shows one.

#### 1.6 Units

| Quantity | Chain form | Display |
| --- | --- | --- |
| D | u128 on the 1e6 scale | `D/1e6`, 2 decimals (`D 0.84`) |
| R | u64 = Σ isqrt(D); one tube at D=1.0 gives 1000 | `R/1000`, 2 decimals (`R 1.43`); the raw integer is in Technical |
| Money | yoctoNEAR strings | NEAR (§8) |

Converting units is display scaling, not "derived". "Derived" means the browser computed something the chain didn't give (§4.2).

#### 1.7 What is not on chain

- Decision logs.
- Finished-job history, which exists only in events, and the client has no indexer.
- Past tube sets, which exist only in `epoch_closed` logs and need the close tx hashes.
- The rendered image.

Screens that need these say what source they need instead of showing blanks (§4.3).

---

### 2. Creative direction

**Concept: a field instrument for a living culture.** The app should feel like the software on a good lab microscope: dark field, specimen in the centre, precise annotations at the edges, nothing that moves unless the specimen did.

**Slime theme (revised 2026-11-03, user choice "living culture"):** the field is the culture dish itself. The base is a warm agar green-black instead of blue-grey; the interface accent is the yolk of *Physarum polycephalum* (`--slime`); the shell's edges are drawn as veins (a thin tube with side branches) instead of flat rules; controls are lopsided pills (`--r-blob`) and panels are uneven cells (`--r-2`); rendered art blooms softly in its own accent. Everything else in this section stands: the layout, the provenance marks, the motion truth rule and the "not used" list below (with the two exceptions it names).

#### Five principles (in priority order)

1. **The specimen leads.** The artwork or the map is the largest thing on any screen that has one. Chrome stays quiet: no borders around art (the art has its own frame), and no cards inside cards.
2. **Annotation, not dashboard.** Numbers sit next to what they describe, set in mono, like labels on a plate. No grids of equal stat tiles. Each screen has **one** primary figure, at most four secondary figures set inline as text, and the rest is on demand.
3. **Alive only when it is alive.** Motion happens on state changes from the chain (epoch close, settlement, render done, tx final). There are no idle pulses, breathing glows or particle drift. The only perpetual motion is the epoch countdown arc and pending-tx spinners, because both measure real elapsed time. **Exception (user, 2026-11-03, slime theme):** the shell itself is a living culture, so ambient motions run all the time: shuttle streaming along the three veins, the veins breathing (swelling and stretching, added 2026-11-04) and a slow breathing of the wordmark nucleus (§3.5). They are confined to the shell (veins and wordmark), never touch data (art, network, figures, rows), and stop under reduced motion. Anything that *means* something still moves only on a confirmed trigger.
4. **Every value shows where it came from.** The provenance language in §4 is part of the visual identity, not a footnote: live, recorded, simulated, derived and unavailable each look different.
5. **Goo is for organisms, mono is for evidence, the doodle hand is for the interface.** Gluten (the gooey display face) appears only on spore names, the wordmark and the one Overview line. Hashes, ids, epochs and amounts are always mono with tabular figures. (Slime type, user 2026-11-04: this replaced "serif for organisms, sans for the interface"; §13 item 12.)

#### Explicitly not used

- Glassmorphism and backdrop blur.
- Gradients as backgrounds.
- Glowing borders. (The art's bloom, §3.4, is not a border: it is a soft shadow in the spore's accent outside the square frame, shown only once real pixels are.)
- Cartoon slime: drips, wobble or jelly animations, glossy highlights, neon green. The theme is the organism, not a toy.
- Purple as a default accent. Violet `#9B8CFF` means *agent activity* only.
- Icon-plus-pill clusters.
- Stock illustrations.
- Hero marketing copy ("the future of…").
- Decorative charts.
- Fake or placeholder metrics.
- Confetti or celebration animations.
- Skeleton shimmer.

---

### 3. Design tokens

All tokens live in `viz/src/ui/tokens.css` as CSS custom properties. TS consumers read them through `viz/src/ui/tokens.ts`, a thin typed map for the canvas code. Names are final; implementations must not invent new colours inline.

#### 3.1 Colour

##### 3.1.1 Base

Slime theme values (2026-11-03). The blue-grey values they replace are in §13.

| Token | Hex | Use |
| --- | --- | --- |
| `--bg` | `#0A0F0B` | page (agar black-green) |
| `--surface` | `#111913` | panels, inspector, dialogs, table header |
| `--surface-2` | `#17211A` | hover row, menu, popover, selected row |
| `--surface-3` | `#1D2A21` | pressed, active segmented item |
| `--line` | `#2A3A2E` | table and list rules (decorative, under 3:1 on purpose) |
| `--line-strong` | `#66796B` | input and control outlines, focus-adjacent outlines (≥ 3:1 on all surfaces) |
| `--text` | `#EEF2E4` | primary (warm off-white) |
| `--text-2` | `#B2BDA8` | secondary |
| `--text-3` | `#87947F` | muted: captions, units, timestamps |
| `--art-bg` | `#06090A` | letterbox behind art while loading. Matches the palettes' darkest stop after vignette |
| `--scrim` | `--art-bg` at 72% | gallery card scrims under the overlay text (§6.B) |
| `--slime` | `#E8C547` | the Physarum yolk. **Interface accent only:** wordmark nucleus, active nav (wavy underline), mobile active tab, focus ring, countdown arc, primary buttons (`--bg` text, 11.5:1), text selection (`--slime-dim`). Never a status, never a link colour in body text |
| `--vein` | `#E8C547` at 36% | the shell's vein dividers (§3.4): under the top bar, above the footer and the mobile bottom bar. Decorative, under 3:1 on purpose |

##### 3.1.2 Semantic

These are fixed and **never** replaced by a spore palette.

| Token | Hex | Meaning | Paired glyph | Paired word |
| --- | --- | --- | --- | --- |
| `--growth` | `#8FE36B` | settled, verified match, tube grew, tx final ok (slime green: the culture grew) | `✓` / solid dot | "Settled", "Match", "Confirmed" |
| `--agent` | `#9B8CFF` | agent action: job posted, quote, hire decision, operator | `◆` | "Agent" |
| `--value` | `#F2A65A` | money: price, balance, fee, royalty, listing (amber, moved off the old `#E6B96B` so it can't be confused with `--slime`) | none (the NEAR unit itself) | "NEAR" |
| `--warn` | `#F06D78` | rejected, policy refusal, tx failed, mismatch | `✕` | "Rejected", "Failed", "Mismatch" |
| `--caution` | `#F2A65A` at a dashed outline | stale data, unable to verify | `!` in a ring | "Stale", "Unable to verify" |

Each has a `-dim` variant at 14% alpha over `--bg` for tinted row backgrounds (`--growth-dim` and so on). It is used **only** behind a row whose status word is visible.

**Contrast** (measured for the slime values; WCAG AA needs 4.5:1 for text). `viz/test/shell.test.tsx` checks every row, so a token change that breaks AA fails the tests:

| Token | on `--bg` | on `--surface` | on `--surface-2` |
| --- | --- | --- | --- |
| `--text` | 17.0 | 15.7 | 14.5 |
| `--text-2` | 9.9 | 9.2 | 8.5 |
| `--text-3` | 6.1 | 5.6 | 5.2 |
| `--slime` | 11.5 | 10.7 | 9.9 |
| `--growth` | 12.3 | 11.4 | 10.5 |
| `--agent` | 7.0 | 6.5 | 6.0 |
| `--value` | 9.6 | 8.9 | 8.2 |
| `--warn` | 6.6 | 6.1 | 5.6 |
| `--line-strong` (non-text) | 4.2 | 3.8 | 3.6 |

Solid buttons put `--bg` text on `--slime` or the status colour; all are ≥ 6.6:1.

**Rule:** status is never conveyed by colour alone. It always comes with a glyph and a word.

##### 3.1.3 Organism palettes

Copied from `renderer/src/paint.rs`. Do not hand-tune these.

| idx | Name | Stop 0 | Stop 1 | Stop 2 | Stop 3 = **accent** | Stop 4 | Stop 5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | yolk | `#060908` | `#083E3C` | `#189678` | `#F0C43C` | `#FFECAA` | `#FFFFF0` |
| 1 | ember | `#0A0606` | `#460A0E` | `#BE2818` | `#FF8C1E` | `#FFD68C` | `#FFFAEB` |
| 2 | violet | `#07050E` | `#28105C` | `#7828C8` | `#F05AC8` | `#FFBEEB` | `#FFF8FF` |
| 3 | toxic | `#050906` | `#0A461E` | `#3CB432` | `#C8F03C` | `#F0FFAA` | `#FCFFEE` |
| 4 | aqua | `#04080E` | `#083264` | `#1482D2` | `#46DCE6` | `#BEFAFA` | `#F5FFFF` |

Exposed as `--pal-<name>-accent` and `--pal-<name>-mid` (stop 2).

**Where palette colour may appear:**
- Inside the art.
- The epoch label on a gallery card (as in the prototype sheet).
- The 8 px identity swatch next to a name.
- Network node rings and tube gradients, and the quote tubes in Activity (§6.E), which draw a real pair's tube.
- The selected-spore outline in the network.

**Where it may not appear:** buttons, status, links, text body, chart series that mean status.

Accent contrast on `--bg` ranges from 6.5 (violet) to 14.8 (toxic), so accent text is legal, but it is used only for the epoch label.

#### 3.2 Typography

**Faces** (self-hosted woff2 under `viz/public/fonts/`, no remote font requests; all are SIL OFL, list them in the README Disclosure). Slime type (user, 2026-11-04): gooey display, doodle interface, mono evidence unchanged.
- **Gluten** variable, `wght` 100–900 (`@fontsource-variable/gluten` 5.3.0, latin `wght` file). Display only: rounded, swollen strokes, like the culture itself. Variable weight is what lets names swell (§3.5).
- **Shantell Sans** variable, `wght` 300–800 plus `INFM` (informality) and `BNCE` (bounce) (`@fontsource-variable/shantell-sans` 5.3.0, latin `full` file, 174 kB). Interface: a marker-pen doodle hand.
- **Geist Mono** 400 / 500. Evidence.
- Instrument Serif stays in `viz/public/fonts/` only because `brand/build.py` outlines the brand wordmark from it; the app no longer loads it. Geist Sans was removed.

**Fallback stacks** (tokens `--font-display`, `--font-sans`, `--font-mono`):
- Display: `Gluten, "Shantell Sans", ui-rounded, "Arial Rounded MT Bold", sans-serif`
- Sans: `"Shantell Sans", ui-rounded, ui-sans-serif, system-ui, sans-serif`
- Mono: `"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace`

**Doodle axes** (`font-variation-settings`, replaced as a whole, so each token names both axes): `--doodle` = `'INFM' 0.5, 'BNCE' 0` for body text, labels and the page default; `--doodle-loud` = `'INFM' 1, 'BNCE' 0.4` for `title`, `heading` and `eyebrow`, where letters hop off the baseline. Reading text never bounces. Gluten and Geist Mono ignore both axes.

| Token | Face | Size / line (px) | Weight | Tracking | Use |
| --- | --- | --- | --- | --- | --- |
| `display-xl` | Display | 72 / 72 | 500 | −0.01em | Spore detail name (≥ md) |
| `display-l` | Display | 48 / 52 | 500 | −0.01em | Overview line; detail name (< md) |
| `display-m` | Display | 30 / 34 | 500 | 0 | inspector and featured spore name |
| `display-s` | Display | 22 / 26 | 500 | 0 | gallery card name |
| `title` | Sans, `--doodle-loud` | 22 / 28 | 600 | −0.005em | page titles |
| `heading` | Sans, `--doodle-loud` | 16 / 24 | 600 | 0 | section headings |
| `body` | Sans, `--doodle` | 14 / 22 | 400 | 0 | default UI text |
| `body-l` | Sans, `--doodle` | 16 / 26 | 400 | 0 | explanatory prose (Demo Lab, empty states), max 68ch |
| `label` | Sans, `--doodle` | 12 / 16 | 500 | +0.04em | form labels, column headers (sentence case, not all caps) |
| `eyebrow` | Sans, `--doodle-loud` | 11 / 16 | 600 | +0.08em, uppercase | at most one per section, above a heading |
| `figure-l` | Mono | 40 / 44 | 400 | −0.02em | the one primary figure per screen |
| `figure` | Mono | 18 / 24 | 400 | 0 | secondary figures |
| `mono` | Mono | 13 / 20 | 400 | 0 | hashes, ids, amounts in tables |
| `mono-s` | Mono | 11 / 16 | 400 | +0.02em | card annotations, axis ticks |

All mono and all numbers use `font-variant-numeric: tabular-nums slashed-zero`.

**Hierarchy rules:**
- One `display-*` per view region.
- The display face never sets numbers, buttons or labels.
- The display face never goes below 22 px.

#### 3.3 Space, grid, size

**Spacing scale** (4 px base): `--s-0: 2`, `--s-1: 4`, `--s-2: 8`, `--s-3: 12`, `--s-4: 16`, `--s-5: 24`, `--s-6: 32`, `--s-7: 48`, `--s-8: 64`, `--s-9: 96`.
- Section gaps are `--s-7`.
- Within a block, use `--s-3` to `--s-4`.

**Breakpoints:** `sm 640`, `md 900`, `lg 1200`, `xl 1480`.

**Page frame:**
- Content max width is 1440 px, with side padding 32 (≥ lg), 24 (md), 16 (< md).
- Prose max width is 680 px.
- Network and Spore detail art are allowed to go full-bleed.

**Grid:** 12 columns with a 24 px gutter (≥ md) and 4 columns with 16 px (< md).

**Navigation:**
- Top bar is 56 px tall, sticky, `--bg` at 100%, with a vein along its bottom edge (§3.4). No blur.
- Mobile bottom bar is 64 px plus the safe-area inset.

**Gallery card:**
- Art is 1:1.
- Column min 232 px: auto-fill `minmax(232px, 1fr)`, giving 6 columns at 1480, 5 at 1280, 3 at 900 and 2 at 375.
- Meta row below the art is 36 px.
- Gap is 24 px (≥ md) and 12 px (< md).

**Inspector panel:** 380 px (≥ lg), 340 px (md); a bottom sheet below md.

**Hit targets:** 40 × 40 px minimum for pointer and 44 × 44 for touch (bottom bar, sheet handles).

#### 3.4 Shape, elevation, glow, layers

**Radius** (slime theme: cells, not boxes):
- `--r-0: 0` for art (the art is square with its own frame; never round it).
- `--r-1: 8` for inputs and selects.
- `--r-blob: 20px 16px 22px 14px / 16px 22px 14px 20px` for buttons, chips, source badges and the skip link: a lopsided pill, like a pseudopod.
- `--r-2: 16px 12px 18px 14px` for panels, menus, dialogs, tooltips and tx rows: an uneven cell wall.
- `--r-full` for avatars and node dots.

There are no other radii, and no rounded card containers around art.

**Veins** (slime theme): the shell's own edges (top bar bottom, footer top, mobile bottom bar top) are a vein, not a 1 px rule: since 2026-11-04 a living tube drawn on a 16 px canvas centred on the edge (`ui/VeinTube.tsx`), the Network map's tube body (`graph/flex.ts`) in yolk: a halo (2.2× width, 12%), the body (`--vein`, 36%) and a core (0.35×, 55%), 2.5 px at rest, thinning to 40% at the ends. It replaced the `--vein-mask` SVG tile. Table, list and form rules stay plain `--line`, because veins there would hurt scanning.

**Elevation:** none for in-flow content. Separation comes from `--surface` vs `--bg` and `--line` rules. Floating layers (menus, popovers, dialogs, toasts) get a single shadow: `0 12px 32px rgba(0,0,0,.55), 0 0 0 1px var(--line)`.

**Glow** is reserved for three things, all derived from the art's own bloom:
- Rendered art (slime theme): once the worker's pixels are shown, the square frame gets a soft shadow in the spore's accent (`0 0 56px −12px`, accent at 50%). `SporeArtwork` sets `--accent` from `paletteOf(seed)`; thumbs and the glyph placeholder get none, so the bloom also says "real pixels".
- The selected node in the network: an accent halo, 12 px blur, 40% alpha.
- A tube that grew at the last close, briefly during the epoch transition.

UI elements never glow.

**Z-index layers:**
- `base 0`, `sticky 10` (top bar, scrubber), `inspector 20`, `popover 30`, `drawer 40` (tx tray, bottom sheet), `dialog 50`, `toast 60`, `skip-link 70`.

#### 3.5 Motion

**Durations:**
- `--t-instant: 0`
- `--t-micro: 120ms` (hover, press)
- `--t-ui: 200ms` (menus, tabs)
- `--t-panel: 320ms` (inspector, sheet, drawer)
- `--t-art: 480ms` (art crossfade)
- `--t-epoch: 900ms` (tube tween at epoch change)
- `--t-pulse: 1600ms` (epoch pulse along the vein), `--t-grow: 1200ms` (veins grow in on load), `--t-stream: 45s` (one leg of the ambient shuttle stream), `--t-breathe: 6s` (one breath of the nucleus, wordmark and veins). Slime theme

**Easing:**
- `--ease-out: cubic-bezier(.2,0,0,1)` for entering.
- `--ease-in: cubic-bezier(.4,0,1,1)` for leaving.
- `--ease-grow: cubic-bezier(.16,1,.3,1)` for tube width and brightness increasing.
- `--ease-decay: cubic-bezier(.4,0,.6,1)`, a slower, even fade for tubes falling.

| Event | Trigger (must be confirmed first) | Motion |
| --- | --- | --- |
| Epoch close | `epoch_info.epoch` advanced **and** the new `edges()` or `epoch_closed` loaded | Tubes tween width and brightness old → new over `--t-epoch`. Growth uses `--ease-grow`; decay uses `--ease-decay` to the new lower value. A tube that dropped below `d_min` fades to 0 and is removed. New tubes draw in from the nucleus side (stroke-dash reveal). The epoch figure flips with no slot-machine roll |
| New art | worker returned pixels **and** hash for the new state | 480 ms crossfade from the previous image. The old image stays until the new one is complete; there is no progressive render |
| Settlement in feed | a source row with a settle tx hash and `ok:true` | the row slides in 8 px with a fade over 200 ms. Nothing else moves |
| Tx progress | wallet callback → RPC final outcome | spinner while pending; on final ok the button morphs to `✓ Confirmed` with a link, with no bounce |
| Countdown | `ends_ns` | a 1 px arc around the epoch figure drains linearly in real time. At 0 it shows "closing…" (dashed arc, static) until a close is observed, because someone has to call `close_epoch` |
| Loading | anything | **no shimmer.** Static placeholders (§6.0) |
| Epoch pulse (slime) | same trigger as "Epoch close": `epoch_info.epoch` went up between two polls of the same source. Never on first load, a source switch or a fall | a bead of yolk with a white core runs along the top-bar vein both ways from the epoch clock over `--t-pulse`, with a brief 4 px glow, then fades (`ui/VeinPulse.tsx`) |
| Veins grow in (slime) | the shell mounts (page load), once | the three veins draw left to right over `--t-grow` |
| Vein tube (slime, ambient) | none: perpetual (principle 3 exception; user, 2026-11-04: "replace the divider animation with the tube animation of the network, I like the tube's one") | each shell vein moves like a Network tube (`graph/flex.ts` `profile`, no sway, so the epoch-pulse bead stays on the centre line): a peristaltic wave (±22% of width, 90 px wavelength) runs along it and reverses every `--t-stream`, and the width breathes ±12% on `--t-breathe`, thinnest at the start of the nucleus's breath; footer and bottom bar 2 s and 4 s behind. Replaced the shuttle-streaming band and the CSS vein breathing (`--vein-tile`/`--vein-swell`). Still under reduced motion |
| Wordmark breathing (slime, ambient) | none: perpetual (principle 3 exception) | the nucleus dot this row first described is gone (§13 item 24); `--t-breathe` (6 s) each way, the wordmark letters swell from weight 460 to 560 (slime type, 2026-11-04) |
| Name swell (slime type) | the loaded epoch went up **and** that spore's R changed since the last load (R moves only at a close). Never on first load or a source switch (the gallery starts empty), never when R stayed put | the spore's name swells to weight 760 (R grew, `--ease-grow`) or thins to 320 (R fell, `--ease-decay`) at 40% of `--t-epoch`, then settles back to 500. Weight never encodes R at rest. `useCloseSwell` in `ui/motion.ts`; gallery card names now, other name sites as they are built |
| Blob hover / press (slime) | pointer hover, press | buttons and source badges morph `--r-blob` → `--r-blob-2` over `--t-ui`; a press squashes the button to 97 × 93% over `--t-micro`. Disabled buttons don't react |
| Ooze in (slime) | a tooltip, panel (empty/error state) or tx row mounts | scale 0.96 × 0.92 → 1 and fade in, starting from the blob radius, over `--t-ui` (tooltip) or `--t-panel` |
| Step playback (S7) | ▶︎ in the Network explorer with Steps on, replaying a step that **happened**: a run-log tx with `ok:true` (or `ok:false`, shown as failed), in log order, time-compressed to 6 s per epoch; from chain history, the epoch's `epoch_closed.flows`/`rejects`, all at once (the chain keeps per-pair totals, not their order) | one short canvas mark per step, coloured by meaning: **post** a violet ripple ◆ at the consumer; **quote** a dashed violet thread provider → consumer; **hire** a solid violet thread consumer → provider with a ◆ head; **deliver** a hollow violet bead provider → consumer; **settle** an amber bead consumer → provider, then a `--growth` ring and ✓ at the provider; **reject** a `--warn` ✕ on the pair; **timeout** a dashed `--text-3` thread; **outside payment** an amber bead leaving the dish; **image commit** a ✓ by the node; **failed tx** a ✕ by the node; **wake** a violet ring closing round the spore. Durations `--t-epoch`, `--t-grow` or `--t-pulse`. The loop rail's chip for that step swells once in its colour (`--t-epoch`). **Tubes never move here**: D changes only at the close that follows |
| Live settlement (S7) | LIVE at Live: a flow that is new or larger, or a reject count that rose, between two `epoch_info` polls of the same epoch (a settlement confirmed on chain since the last poll) | the same settle bead / reject ✕ for each pair, 120 ms apart; the rail's Settle chip swells; a polite announcement ("2 settlements confirmed") |
| Close sweep (S7) | the same trigger as "Epoch close", in the Network explorer | a `--slime` ring sweeps from the dish's centre to its edge over `--t-pulse`, while the tubes tween; the rail's Close then Grow chips swell |
| Living tubes (S7, ambient) | none: perpetual (principle 3 exception, user 2026-11-04: "more flexible, limber, feels like tube expanding") | the Network map's tubes are filled bodies that flare where they meet a spore. A peristaltic wave (±22% of width, 90 px wavelength) runs along each tube and reverses every `--t-stream`, like the veins' shuttle streaming. Widths breathe ±12% on `--t-breathe`, rolling round the ring by the tube's angle. Each curve's control point sways ≤ 3.5 px (inside the 6 px tube hit tolerance), and the dish ring breathes ±1.5 px while the slots stay fixed (§1.2). The mean width stays `1 + 6·isqrt(D)/isqrt(Dmax)`. Nodes (the spore's whole art) breathe in opacity ±10% in the same wave, by their slot angle; their size stays fixed, because tubes start at the art's partner discs. `graph/flex.ts`, `graph/draw.ts`; beads and overlays follow the swayed curve |
| Tube expansion (S7) | the same trigger as "Epoch close": a tube that grew or was born | during the `--t-epoch` tween, a bulge (up to +140% width) runs in from both spores and meets in the middle, then settles at the new width. Decaying tubes don't swell |
| Monitor tick (S7) | a step lands in the step monitor while ▶︎ plays one (or a live settlement arrives) | its tick lands with a swell (2.5 × 1.6 → 1) over `--t-epoch`, `--ease-grow`; the yolk playhead moves to it over `--t-ui` |
| Agent reach (S11) | a scene `step` line for `accept`/`pay_service`: the tx was really sent | a violet pseudopod with an amber bead grows from the spore to its gate over `--t-epoch` and pushes the membrane out while the tx is pending. Pending is real elapsed time: nothing is decided yet |
| Refusal (S11) | that tx's final outcome, `ok:false` | the membrane flashes `--warn` at the gate and relaxes, a ripple and a ✕ land on the wall (the ✕ stays), the pseudopod retreats over `--t-art`; a `✕ Refused` stamp lands in the lanes and by the gate (scale 1.7 → 1 over `--t-panel`, `--ease-grow`, tilted 3°) |
| Allowed (S11) | that tx's final outcome, `ok:true` | the membrane parts at the gate over `--t-grow`, the bead passes through and waits past the wall until the refund tx is final, then returns to the spore |
| Scene close (S11) | a scene `close` line and the view after it | the "Close sweep" ring, tubes tween down over `--t-epoch` with `--ease-decay`, leaving an outline of their width at N; a removed tube fades over `--t-grow`; the art crossfades as "New art" |
| Sale listed (S12) | the `list` tx's final outcome, ok | an amber `for sale` tag lands on the dish's label (`stamp-land`) |
| Sale final (S12) | the `buy` tx's final outcome, ok. While it is pending the price's bead only leaves the buyer and waits at the wall | the old paper label peels off the dish and falls (`--t-grow`, `--ease-in`), the buyer's lands (`--t-art`, `--ease-grow`); the old agent's key line retracts over `--t-grow` leaving a ✕ on the wall; the spore's art dims to 45% and the wall goes to full strength, because paused is chain state |
| Payout (S12) | a `payout` line, read from the buy's receipts | an amber bead, area ∝ amount, runs from the wall to that party over `--t-grow`; its `+amount` lands. No bead without a receipt line |
| Old hands refused (S12) | that tx's final outcome, `ok:false` | as Refusal (S11), but the limb grows from the old owner's corner, from outside the wall: violet for the old agent's key, `--text-2` for the old owner's hand |
| Kept (S12) | check 9 passed: the chain's own blocks either side of the buy agree | a `--growth` bead runs out along each tube over `--t-pulse`; `✓ kept` lands on each plate value. **The tubes themselves don't move:** a sale doesn't touch them |
| New hands (S12) | `register_operator` final, then `set_policy` final, then the new agent's `post_job` final | a thin violet line grows from the buyer over `--t-grow`, thickens at the policy while the art wakes and the wall thins; the first job is a violet ripple from the spore over `--t-pulse` |
| Simulation playback (S12) | the panel loads, a control changes the case, or ↻ Replay. Not a chain event: it replays labelled simulated data, dashed and under a `SIMULATION` chip (§13 item 20) | the chart's two dashed lines draw out epoch by epoch over 8 × `--t-epoch`, with their end labels riding the heads; the schematic loop runs, its width following R, a fee drip leaving it at each spore. It stops at epoch 40 and nothing moves afterwards. Reduced motion: the final frame at once |
| Loop stop (S13) | a story line reaches the next stop: a logged event, in order (below) | the stop's promise gives way to the run's figures (`narrate-in`), and the yolk vein grows to it over `--t-epoch` with a white head. A jump lands without growing |
| Quote (S13) | a `quotes` line: those quote txs are in the log | each quoter's art fades in at its ring slot (`--t-art`), a dashed violet thread runs from it to the spore over `--t-epoch`, staggered 200 ms; the price lands by its id |
| Hired (S13) | the `accept` tx is in the log | the winner's thread becomes a solid violet limb from the spore over `--t-epoch`; the others dim and step back. **No tube yet** |
| Paid (S13) | the `settle` tx is in the log | a hollow bead runs back on `deliver`, then an amber bead to the provider over `--t-grow` and a `--growth` ring there; `−amount` lands on the plate. **The tube still doesn't move** |
| Loop close (S13) | the keeper's `close_epoch` line **and** the snapshot after it | the Close sweep; tubes tween as the Epoch close row, grown ones swelling from both ends; the threads fade out as the tube takes over |
| Allowance (S13) | `rep`: the same close, one line on | the amber arc on the dish's rim moves from the old `effective_budget / budget_per_epoch` to the new over `--t-epoch`, and `may spend` lands on the plate |
| Loop art (S13) | `art` (or a `lapse`): the worker returned the pixels for the snapshot's state | "New art" crossfade; on `art` also a 7% swell and a yolk ripple over `--t-grow`; how it looked when it woke lands in the corner, for comparison |
| Time-lapse (S13) | a `lapse` line: one later close and its snapshot, 1.5 s apart in story pace | the Loop close and Loop art rows at once, for each close before the sale. Labelled by the epoch on the plate; `Real time` plays the logged gaps |
| The loop closes (S13) | the new agent's first tx after the sale is in the log | a thin yolk vein grows from the last stop back to Hire over `--t-pulse`, on the Sale stage's own "New hands" ripple |
| Plate pen (S14) | a story line on the Overview's plate, itself a logged event (`model/plate.ts` `plateTarget`) | a hand-drawn yolk arrow grows from the note to what the line is about over `--t-art` (`--ease-out`), its head lands at the end. Points at a tube only once a close has grown it, at the rim only on the Reputation line, at the label only from the listing on. Gone before the story starts and after it ends, so the finished plate is a clean diagram. No arrow under 900 px, where the note sits directly above the dish. Reduced motion: the finished plate, no arrow |
| Landing scroll (§13 item 23) | the reader's own scroll, no chain event, so it claims nothing about the chain | the specimen's pen arrows draw over `--t-grow` when the plate comes into view; the How it works vein grows with the scroll, and each step's dot fills as it's reached | arrows and vein are simply there, every dot filled |
| Membrane (S11, ambient) | none: perpetual (principle 3 exception, §13 item 19) | the Network tubes' peristalsis and breathing on a closed ring, plus a slow drift of ≤ 0.6% of the dish. Thin (50%) until the owner's limits are on chain and again once the policy is restored. Off under reduced motion |

**Reduced motion** (`prefers-reduced-motion: reduce`, the OS setting only; the footer toggle was removed 2026-11-04, user: "why are we having motion type? just give it motion"):
- All durations become 0 except the countdown arc, which becomes a mono countdown text.
- The epoch pulse is not rendered, and the ambient streaming, vein breathing and nucleus breathing are switched off (`animation: none`), not just shortened.
- Epoch changes swap instantly, and a one-line summary is announced ("Epoch 18 closed · 3 tubes grew · 2 decayed · 1 dropped").
- Scrubber play steps without interpolation. No step particles, close sweep or rail swells: the feed still lists every step and each close is announced in words.

**Truth rule for motion:**
- No animation may start before its trigger is confirmed. A tube never grows on `job_settled`; only on the next close, because D changes only at close.
- An optimistic UI state is never shown for a transaction.

---

### 4. Provenance language (the honesty system)

This is a first-class part of the visual identity. Every view and every number belongs to one of these.

#### 4.1 Source (view level)

A `SourceBadge` sits at the left of the top bar's status cluster and repeats in each page header.

| Source | Badge | Visual cue across the page |
| --- | --- | --- |
| **LIVE · testnet** | solid `--growth` dot + `LIVE` + `testnet · <router-id>` in mono | none extra |
| **LOCAL RUN · <name>** | hollow `--text` ring + `LOCAL RUN` + run name | none extra |
| **RECORDED · <run>, <date>** | `▶︎` glyph + `RECORDED` + run and date | a persistent 28 px banner under the top bar: "Recorded playback of `<run>` from `<date>`. Nothing here is happening now." It cannot be dismissed |
| **SIMULATION** | dashed-outline chip `SIMULATION` | the panel gets a 1 px dashed `--line-strong` outline, and its charts use dashed series lines |

Mixed views (for example LIVE chain plus LOCAL RUN decisions) show **both** badges, each next to the region it governs.

#### 4.2 Value-level marks

| Kind | Mark | Example |
| --- | --- | --- |
| Chain value (view or event) | none; this is the default | `R 1.43` |
| Computed by the chain at read time (age, degree, R, allowance) | none in-line; the tooltip says "computed by the router at read time" | `allowance 0.30 NEAR` |
| **Derived** (computed in the browser) | `≈` prefix in `--text-3` plus the tooltip "derived in your browser from …" | `≈ decaying`, `≈ cut 77%` |
| **Recomputed** (re-ran a rule or replay and compared) | `↻` plus the result word | `↻ matches log` |
| **Simulated** | inside a SIMULATION panel only, never mixed into chain figures | |
| **Unavailable** | an em dash `—` in `--text-3` plus the tooltip saying what is missing | `—` "needs the close tx for epoch 4" |
| **Stale** | the value stays, in `--text-2`, with a `!` ring and "as of 14:02:11" | |

Never use `0`, `n/a` or a blank for an unknown value. Unknown is `—` with a reason.

#### 4.3 Evidence ladder (for receipts and verification)

The labels below are the only words used.

1. **Confirmed on chain:** the final tx outcome was fetched by the app. Shows `✓` in `--growth`, the tx link, and the block height when known.
2. **Logged:** the run log has a hash, but the app hasn't fetched it. Shows a hollow `○` and a "Fetch" action.
3. **Derived:** the `≈` mark (§4.2).
4. **Simulated:** inside SIMULATION panels only.
5. **Unavailable:** `—` plus a reason and, when possible, how to get it ("Load the run log" / "Add close hashes").

---

### 5. Information architecture

#### 5.1 Routes

| Nav | Route | Purpose |
| --- | --- | --- |
| Landing page (not in the nav; §13 item 23) | `/` | the concept in 10 seconds, what we do, how it works, proof, health, the way in |
| Network | `/network` (`?epoch=N&sel=7` or `sel=3-7`) | the map: collection-wide tubes over epochs |
| My Spores | `/mine` | spores owned by the connected wallet, plus owner actions |
| Marketplace | `/market` (`?view=all|listed`) | **the collection gallery** (all 64) plus listings and purchase |
| Activity | `/activity` (`?spore=&from=&to=&outcome=&tube=1`; `?epoch=N` is `from = to = N`; `?view=log` or any `&kind=a,b` opens the full log) | a run's decisions as tubes; the full log: jobs, settlements, policy refusals, closes, receipts |
| (from anywhere) | `/spore/:id` | Spore detail |
| (secondary) | `/lab`, `/lab/:scene` (`loop`, `rogue`, `sale`, `wash`) | Demo Lab; `/lab/loop` is what `scripts/demo.sh` opens |
| (secondary) | `/verify` (`?epoch=N` opens that row; `?spore=N` picks the image, default 5, empty means epochs only) | Verify run (also reachable from the detail page and receipts) |

**Why the gallery lives under Marketplace:** the brief puts "collectible discovery" there, and a separate Collection nav item would add a sixth section. The Overview links "Browse all 64" straight to `/market?view=all`.

**Demo Lab** is not a primary nav item. It is a text link at the right of the top bar ("Demo Lab"), plus the Overview's "Watch the loop" entry. It is the judge path, not part of using the collection.

Every URL is shareable and restores selection, epoch and filters. The source is a query param (`?source=recorded&run=…`) that persists across navigation.

#### 5.2 Desktop top bar (56 px)

```
[mark Spores]  Network  My Spores  Marketplace  Activity        Demo Lab   [● LIVE testnet · router4]  [E 17 ◔ 0:21]  [Connect wallet]
```

- **Logo:** the small-size brand mark (`favicon.svg`) beside "Spores" in the display face, 22 px; the letters breathe slowly (§3.5). It replaced the nucleus dot (§13 item 24).
- **Nav items:** `body` 14/500. The active item is `--text` with a 1.5 px wavy `--slime` underline 8 px below the baseline. Inactive items are `--text-2`.
- **Bottom edge:** a vein (§3.4); a confirmed epoch close sends a pulse along it from the `EpochClock` (§3.5).
- **Status cluster:** `SourceBadge`, `EpochClock` and `WalletStatus` (§7).

#### 5.3 Mobile (< md)

- **Top bar:** wordmark, `EpochClock` and a wallet avatar button. The source badge collapses to its glyph and expands on tap.
- **Bottom bar:** 4 items (Network, Mine, Market, Activity; §13 item 23), each a 20 px line icon plus an 11 px label, with the active item in `--slime`. A vein runs along its top edge.
- **Demo Lab** is reachable from the Overview and from the wallet menu.

#### 5.4 Breadcrumbs

Only on `/spore/:id` and `/lab/:scene`: `Marketplace / Spore #7` (the crumb reflects where the user came from, falling back to Marketplace) and `Demo Lab / Rogue agent`.

#### 5.5 Cross-links between related screens

- **Spore id** (everywhere): `SporeRef`, the palette swatch plus mono `#7`. Click → detail. Hover → a 160 px art preview.
- **Tube** (anywhere a pair appears): Network with the edge selected.
- **Receipt:** the explorer opens in a new tab with ↗.
- **Epoch number:** Network scrubbed to that epoch.

---

### 6. Screens

Each screen covers purpose, primary task, hierarchy, layout, data, states, responsive behaviour and accessibility.

#### 6.0 Global states (apply to every screen)

- **Loading:**
  - Art shows the on-chain glyph (real data) at 100% under a mono caption "on-chain glyph · rendering…", then crossfades.
  - Text values show a 1 px `--line` bar the width of the expected value.
  - There are no spinners for page loads.
- **RPC error:**
  - An inline `ErrorState` in the affected region gives the endpoint tried, the error text and a Retry button.
  - Other regions keep working.
  - The app **never** silently switches to recorded data.
- **Stale:** when polling has failed for more than 30 s, the top-bar badge becomes `! STALE since 14:02:11`, and values keep the stale styling (§4.2).
- **Empty:** `EmptyState` says what would make the region non-empty, in one sentence and one action.

#### 6.A Overview `/`

**Now the landing page, outside the app's nav (§13 item 23).** Its first screen is the line, the plate, the sheet and the timeline; below them the story in `components/LandingStory.tsx`. Where this subsection or item 22 differs, item 23 and the code win.

**Built differently, on purpose (§13 item 22, S14):** the hero is a **plate**, not the live map: on the left a recording of one real spore's life on the loop's own stage, on the right the fixed line, the body copy, a handwritten note with a pen arrow into the stage, and the actions; under both, the eight stops as one yolk vein across the page, which is the strip and the timeline in one. The live map, the primary figure and its inline figures move to the section below ("Right now"), unchanged. The layout below is what was specified; where it differs, §13 item 22 and the code win.

**Purpose:** a judge understands in 10 seconds that each Spore is an NFT whose agent hires others; settled payments grow tubes; tubes set reputation and spending power; the art is the network.

**Primary task:** go to the Network or into the loop demo.

**Desktop layout** (12 columns):

1. **Hero row (≈ 72 vh).**
   - Left 7 columns: `NetworkGraph` in `compact` mode (live, no pan or zoom, click → `/network`), 1:1, bleeding to the left page edge.
   - Right 5 columns, vertically centred:
     - `display-l` serif: **"Sixty-four slime molds that earn, hire and grow by trading with each other."**
     - `body-l` (2 lines): "Each Spore is an NFT with its own agent. When one pays another for work and the job settles, a tube grows between them. Tubes are reputation, reputation is spending power, and the art is drawn from the tubes."
     - The **primary figure**: `figure-l` `Epoch 17` with the countdown arc, and under it, in `body` `--text-2`: `9 of 64 active · 14 tubes · 6 payments settled this epoch (0.084 NEAR)`. These are four secondary figures inline as text, not tiles.
     - Actions: `Explore the network` (primary) and `Watch the loop` (secondary → `/lab`).
2. **The loop strip.**
   - A single horizontal line of 8 steps: Wake → Hire → Settle → Grow → Reputation → Art → Sell → Control transfers.
   - Each step is a `label`, with a 1 px connector line between steps and a dot per step.
   - Hovering a step shows one sentence. Clicking jumps to where it is visible (Hire → Activity filtered to decisions; Grow → Network; Art → a featured spore; Sell → Marketplace; Control transfers → Demo Lab sale).
   - It is a diagram, not a carousel.
3. **Featured spores.**
   - Four `SporeCard`s at a larger size (2 per row at md, 4 at ≥ lg). The rule is stated in the eyebrow: "Highest reputation now".
   - If fewer than 4 spores have R > 0, show those and then "Most recently activated", with the eyebrow changed to say so.
4. **Recent activity:** the last 8 `EventFeed` rows. The source badge for this region is shown. In LIVE-only mode it shows the current epoch's flows from `epoch_info.flows`, labelled "this epoch so far". The empty state reads: "Job and decision history is written by the agents, not stored on chain. Load a run or recorded bundle to see it."

**Mobile:** the graph comes first, square and full-width, then the serif line, figures, actions, the loop strip as a vertical list, featured cards (horizontal scroll with snap), then activity.

**States:**
- With zero active spores, the hero graph shows 64 dormant dots and the line "No spore is active yet. Every tube on this map will come from a settled payment."
- On RPC error, the hero region shows `ErrorState`, and the copy still renders.

**Accessibility:** the compact graph has `role="img"` and an `aria-label` summary ("Network at epoch 17: 9 active spores, 14 tubes; strongest tube #3–#7 D 0.84"), plus a "View as table" link.

#### 6.B Collection gallery (`/market?view=all`, also `/mine`)

**Purpose:** see the organisms; the art dominates.

**Layout:**
- **Header row:** title "Marketplace", a segmented control `All 64 · For sale (n)`, a sort select and filter chips. On the right: the render progress `Rendering 12 / 64` in mono-s, shown only while it is rendering.
- **Grid** per §3.3.

**`SporeCard`:**

```
┌──────────── art 1:1 (own frame) ────────────┐
│ ● Active                         ✓ image    │  ← top: state (left), image-hash badge (right), mono-s 11 px
│                                             │
│                (artwork)                    │
│                                             │
│ Spore #7                       epoch 17     │  ← bottom: serif display-s (left); mono-s, epoch in palette accent
│                         deg 4 · R 1.43      │  ← mono-s --text-2
└─────────────────────────────────────────────┘
  buyer.spores-hack…                0.80 NEAR    ← 36 px meta row below the art: owner (mono-s --text-3), price (mono --value) if listed
```

- Overlays sit inside the art frame at 16 px padding.
- A bottom scrim, a linear gradient from transparent to `--scrim` (`rgba(6,9,10,.72)`) over the lowest 30%, keeps the overlay text legible. A matching top scrim covers the top 18%. Both reach full strength by 80–85% of their height, so the text rows sit on the full scrim (S6 measured it: see the session log). Below md the cards are ~170 px and the text covers more of the art, so the scrims are 36% (top) and 44% (bottom).
- On the art, muted words (`○ Dormant`, `○ no commit`, `◷ older commit`, the `≈` mark and the glyph caption) are `--text-2`, not `--text-3`: under the scrim `--text-3` measured 3.1:1 on the brightest pixel, `--text-2` ≥ 4.3:1 (S6).
- The prototype sheet established the serif name bottom-left and the mono stats bottom-right; that is kept.

**State marker** (top-left): `● Active` (`--growth` dot), `○ Dormant`, `‖ Paused` (`--text-2`), `◌ Awaiting policy`, `≈ ↺ Control reset` (derived), and on LIVE `◉ Activated` (§1.5: the bulk views carry no policy). Listed state shows in the meta row as a price, not as a badge. The `Active` filter chip reads `Activated` on LIVE for the same reason.

**Image-hash badge** (top-right; real check, plan S6):

| Badge | When |
| --- | --- |
| `✓ image` (`--growth`) | committed hash equals the hash the browser just rendered at the same state |
| `✕ image` (`--warn`) | it does not |
| `○ no commit` (`--text-3`) | nothing committed |
| `◷ older commit` (`--text-3`) | commit epoch is before the current state; verify on the detail page |
| `checking…` (`--text-3`, no glyph: a loading state, not a status) | the commit is for the current state and the render has not returned yet (S6) |
| `! renderer vN` (`--caution`) | the commit was made with another `RENDERER_VERSION`, so the hashes can't be compared (S6; has not happened on router4) |

"Same state" means the commit's epoch is the state's epoch **and** its `state_hash` equals the stored one; only a render of exactly that input counts (a previous image's hash never meets a new commit). On the art these words use `--text-2` (scrims above).

**Hover (pointer):**
- The art scales 1.0 → 1.015 over `--t-micro`. There is no lift shadow.
- The bottom scrim extends to show `partners #3 #12 #40` in mono-s.
- The partner markers in the art do not need highlighting; they are already the art.

**Focus:** a 2 px `--slime` outline offset 3 px outside the art.

**Click:** `/spore/:id`. The art element is shared, so it morphs into the detail art position over `--t-panel` (View Transitions API where available; otherwise instant).

**Sort:** id (default), reputation, degree, age, price (listed only), recently active. **Filter chips:** Active, Dormant, Listed, Has tubes, palette (5 swatches), Owned by me (when a wallet is connected). Filters show their count: `Active 9`.

**States:**
- **Loading:** 64 cards with glyphs (real), each replaced as its render finishes. The visible ones are rendered first.
- **Empty filter:** "No spores match Active + ember. Clear filters."
- **For-sale view with no listings:** "Nothing is listed right now. Owners list from a Spore's page." (No fake listings.)
- **RPC error:** the grid is replaced by `ErrorState`.

**Mobile:** 2 columns. The overlay drops `deg · R` and keeps the name and epoch; the meta row shows the price only, and is left out when the spore is not listed. The state marker and the badge wrap onto two lines.

**Accessibility:**
- The grid is a list (`ul`), and each card is one link with an accessible name: "Spore #7, active, epoch 17, degree 4, reputation 1.43, listed 0.80 NEAR, image verified".
- Arrow-key roving focus inside the grid.

#### 6.C Network explorer `/network` (the signature screen)

**Purpose:** see every economic relationship in the collection, and how it grew and decayed epoch by epoch.

**Layout (≥ lg):**
- The canvas fills the viewport below the top bar, minus the 380 px inspector on the right and the 72 px scrubber at the bottom.
- The legend is collapsible at the bottom-left of the canvas.
- Controls sit at the top-right of the canvas: zoom −/+, Reset, Labels (`Selected · All`) and Show change (toggle).

**Geometry (fixed, matching the art, §1.2):**
- 64 slots on a circle. Spore N is at `N·5.625°` clockwise from 12 o'clock. The ring radius is 42% of the canvas's short side.
- A faint `--line` circle traces the ring, and tick marks every 8 slots carry mono-s labels `0 8 16 … 56`.

**Nodes:**
- **Active:** the spore itself (user 2026-11-04: "the node is the spore (NFT) visually", then "I want the spore as the visual and its tube is the tube, not just the spore inside the ring"): its whole art, with no disc or ring. The art is the inspector thumb's input (current seed, age and live tubes), so a node shows the NFT as it is now at every frame; the legend says "the spore's whole art now". The 512 px image is downscaled to 256 px and keyed onto the dish: alpha = ((max channel − 40)/100)², clamped, so the dark ground, grain and far bloom drop out, times a round fade from 80% to 92% of the half side, so the square edge and frame go. It is drawn `screen` at a side of `r·(0.24 + 0.12·√(R/Rmax))` world px (size = R; `organismSide`), so overlapping neighbours add light. The on-chain glyph shows until the render arrives (§7); renders queue at priority 3, behind anything on screen, and come from the image cache after that (`graph/nodeArt.ts`). With motion on, its opacity breathes ±10% in the same wave that rolls round the ring through the tubes (§3.5 "Living tubes"). Paused: drawn at 55% with a dashed hairline round the body. Selected adds a soft accent glow. Without a render input or glyph (no age in the source), the plain node: a bright core 3–9 px (radius `3 + 6·√(R/Rmax)`) in a 1.5 px accent ring.
- **Dormant:** a 2 px `--text-3` dot at 60% opacity, the same as the art's empty slots.
- **Active with no tubes:** an accent ring with a dim core.
- **Paused:** the ring is dashed.
- **Listed:** a small `--value` tick outside the ring. Price shows on hover only.

**Tubes:**
- Each tube is a cubic curve between the two nodes, bowed toward the centre: without art, the cubic form of the quadratic with control point = centre + 0.35 × (midpoint − centre), which gives the organic, art-like curvature. Where a spore shows its art, the tube starts at the partner's disc in that art, so the map tube continues the art's own tube: the renderer puts partner j at slot j's angle, `min(168 − 84·dn/1000, bound_r(deg) − 12)` art px from the nucleus (`artReach`, the renderer's `nodes()`), scaled by the art's side on the map. That end's handle is pushed 1.5× that offset along the vein, so the tube leaves in the vein's direction and then bends into the bowed curve, and the tube starts at the art's vein width (7 art px) and thickens to √D over the first 18% (`taper` in `graph/flex.ts`) instead of flaring. Hit testing, overlays and step beads use the same curve. This is layout, not data.
- The tube is a filled body, not a stroke: it flares to about 1.9× its width where it meets a spore, like a Physarum junction. With motion on, it is alive (§3.5 "Living tubes", "Tube expansion"); under reduced motion it holds still at its true width.
- **Width:** `1 + 6·isqrt(D)/isqrt(Dmax)` px.
- **Brightness:** opacity `0.25 + 0.75·D/Dmax`.
- **Colour:** drawn like the art's veins, in three layers from the renderer palette stops, each a linear gradient between the two endpoints' palettes: a halo (stop 2, 2.2× width, 35%), the body (stop 3, the accent) and a bright core (stop 4, 0.35× width, 90%; skipped under 0.6 px). It carries identity, not status.
- **Below `config.d_min`:** not drawn, matching the contract. Under the Show change toggle, a tube dropped at the last close is drawn once as a 1 px dashed `--text-3` ghost, labelled "dropped below threshold".
- **Only tubes from `edges()`, `epoch_closed.tubes` or the replay of close events.** Nothing decorative and no "suggested" links.

**Show change** (applies to the current versus the previous epoch):
- Grew: `--growth` overlay stroke 1 px above the tube.
- Decayed: no overlay; the tube is simply dimmer. Each close takes 25% off D before adding growth (`decay_bps` 2500).
- Rejected: a `--warn` 1 px tick at the tube's midpoint when that epoch's `epoch_closed.rejects` has the pair. A rejected delivery halves the tube (`reject_bps` 5000, `Params::shipped()`).
- New: a `--growth` dash-reveal.
- Dropped: the ghost described above.

The legend switches to explain these.

**Epoch scrubber (bottom, 72 px):**
- A tick per epoch from 1 to the current one. Each tick's height is the number of flows that epoch, as a real bar from `epoch_closed.flows`. The current tick is at the right, labelled `Live`.
- Controls: drag, ←/→ keys, ▶︎ play (one epoch per 1.2 s), and a `Live` button to return.
- Epochs without loaded history are drawn as hollow ticks, with the tooltip "No close tx for epoch 4 in this source". The scrubber still works; those epochs show "—".
- When the live epoch advances, the scrubber grows a tick, and if the user is at Live the map tweens (§3.5).

**Interaction:**
- **Pan and zoom:** drag and wheel (cursor-anchored, 0.5×–4×), pinch on touch, and the keyboard (arrows pan, +/− zoom, 0 resets).
- **Select a node:** click it, or Tab cycles through active nodes in id order. Its tubes stay at full opacity, everything else drops to 20%, and the inspector shows the node.
- **Select a tube:** click within 6 px of the curve (hit test against the curve, cached per epoch).
- **Escape** clears the selection. **Reset** restores the zoom, the selection and Live.

**Inspector, node:**
- `SporeIdentity` (96 px art thumb, serif name, state, owner).
- Figures: R, degree, balance, allowance left.
- Its tubes as a list sorted by D (partner `SporeRef`, D, a mini bar).
- An "Open Spore" link.

**Inspector, tube:**
- Title `#3 ↔ #7`.
- D now (`figure`).
- A D-by-epoch sparkline (real points only, with gaps where history is missing).
- A flows-by-epoch table: amount and direction from `epoch_closed.flows`, with the epoch linking back to the scrubber.
- **Settlements:** `TransactionReceipt` rows when the source has settle hashes. Otherwise: "Per-job receipts need the run log. On chain: per-epoch flows only."

**Legend:** spore = its own art (the NFT), size = reputation; tube = the art's vein, width = √D, brightness = D; grey dot = dormant; dimmed with a dashed outline = paused; amber tick = listed; with Show change on, green stroke = grew (dashed: new), grey dashes = dropped below threshold, red tick = rejected; and the step marks: violet = agent step, amber bead = payment with ✓ settled, yolk sweep = a close.

**Every step of the loop (S7, user 2026-11-04: "every step of the network can be visually shown"):**
- **Loop rail** (in the inspector, nothing selected): `◌ Wake → ◆ Post → ◆ Quote → ◆ Hire → ◆ Deliver → ✓ Settle → ◎ Close → ✓ Grow`, each with its count for the epoch on screen, plus side counts (✕ reject, ○ timeout, → outside, ✓ image, ✕ failed). A step the source can't see is `—` with the reason: on LIVE, post/quote/hire/deliver need the run log (the chain views keep only settled flows and rejects).
- **Step monitor** under it (user 2026-11-04: "easy to watch visually, not a bunch of text components"). It has one lane per kind of step: Post, Quote, Hire, Deliver and Settle always for a run log, plus any side kinds present. Each step is a tick in its lane at its run-log time within the epoch (x = (t − first step) / (last − first), the same mapping ▶︎ plays with), under an activity trace (steps per 1/48 of the epoch, `--slime`). A yolk playhead sits on the last step played, and a mono axis shows `0 s … N s` of log. One readout line names the newest step, or the one under the pointer. Chain rows (flows, rejects) have no time or order on chain, so they are a **tally**, labelled "unordered: the chain keeps per-pair totals, not their order". The body carries an `aria-label` with the counts per lane, and "Show the log as text" opens the step feed below. The feed is always in the DOM (screen-reader only until opened).
- **Step feed** (text, behind the monitor): one plain sentence per step ("#0 hired #62 for 0.0684 NEAR · escrowed · job 316"), newest first, with its tx link marked `○` (Logged, §4.3), or `epoch_info` for chain flows. Contract errors are quoted verbatim. Chain rejects are an unordered pair ("#3 ↔ #8 · a delivery was rejected"), since who rejected whom is only in the run log.
- **Steps** toggle (on by default) beside Show change: ▶︎ plays each epoch's steps before its close (Design §3.5 "Step playback"); off, play is one epoch per 1.2 s. While an epoch plays, the inspector shows the tubes in force, not the close's results.
- **LIVE at Live:** settlements confirmed between polls play as they arrive (§3.5 "Live settlement").

**Mobile:** the canvas is full-screen, the inspector is a bottom sheet (peek 120 px, then half, then full), the scrubber is a 56 px strip above the tab bar, and Labels defaults to Selected.

**Performance:**
- One canvas at device pixel ratio up to 2. Tube paths are cached per epoch and redrawn only on change, selection or viewport change.
- Hit testing uses a coarse grid. Target 60 fps pan on a 2019 laptop with 2016 tubes.

**Accessibility:**
- The canvas carries `role="application"` with an instructions line.
- Every node and tube is also available in a "Table view" toggle: a sortable table of spores and of tubes, with the same selection.
- Selection changes are announced through a polite live region.

#### 6.D Spore detail `/spore/:id`

**Purpose:** be with one organism. Understand what it is, what it has done and what its owner can do.

**Layout (≥ lg):** two columns.
- **Left (7 columns): sticky art.** Square, max 720 px, top-aligned under the breadcrumb, with no border. Below it:
  - A mono-s caption line: `render v1 · image 7e3a…c901 ✓ matches commit at epoch 17`.
  - The epoch compare control `[ epoch 12 ◀ ▶ epoch 17 ]`: a split slider showing before and after, rendered from replayed tubes. Stretch item; omit if cut.
- **Right (5 columns):**
  1. **Identity:** `display-xl` "Spore #7"; palette swatch plus `violet`; `StateMarker`; mono `seed 3f9a…`; "Owned by `buyer.spores-hack.testnet`" (a "You" chip if it's the wallet).
  2. **Owner action bar** (only when wallet == owner; §6.D.1).
  3. **Primary figure:** `figure-l` `R 1.43`, with one line of explanation in `--text-2`: "Reputation is the sum of √D over its tubes. One full-strength tube is 1.00."
  4. **Secondary figures (inline text):** `Balance 2.31 NEAR · Allowance left 0.18 of 0.30 NEAR · Age 17 epochs · 4 tubes`.
  5. **Connections:** a list sorted by D. Each row has the partner's 32 px art thumbnail, the `SporeRef`, D with a 1 px bar of width ∝ √D, the share of R, and a link to the tube in the Network.
  6. **Agent and policy:**
     - Operator account and `operator_gen`.
     - Policy as a definition list: paused, budget per epoch, max payment, allowed spores ("all" or a list of `SporeRef`), external allowlist (accounts).
     - Effective budget with its formula in a tooltip: `min(owner budget, base + trust_gain × R)`, plus the actual numbers.
     - Spent this epoch.
  7. **Market:** listed price or "Not listed"; sales count; transfers count; last sale (if the source has `spore_sold`).
  8. **Activity:** the last 10 `EventFeed` rows filtered to this spore, plus "All activity for #7 →".
  9. **Technical** (collapsed `<details>`): state hash and epoch, image commit (epoch, state hash, image hash, renderer version), the raw R integer, the raw D per tube, a **Verify this image** button (→ `VerificationResult`), and the `nft_token` JSON.

**Mobile:** the art is full-width at the top, not sticky. The order is identity, actions, then everything else.

##### 6.D.1 Owner actions

These are gated by wallet == owner, plus the conditions below.

| State | Primary action | Secondary (in "More") |
| --- | --- | --- |
| Dormant | **Activate** (deposit ≥ `min_activation_deposit`, choose operator ≠ owner) | Deposit |
| Awaiting policy / Control reset | **Set policy** | Register operator, Deposit, Withdraw, List |
| Active | **Edit policy** | Pause, Register operator ("Replace operator": there is no revoke; replacing it is how you revoke), Deposit, Withdraw, List |
| Paused | **Set policy** (unpausing = set_policy with `paused:false`; there is no unpause method) | the same as Active |
| Listed | **Delist** | Deposit. Pause and Withdraw are shown disabled with the contract's reason: "A listed spore cannot be paused; delist it first." |
| Not owner, listed | **Buy for 0.80 NEAR** | none |

Every action opens a `ConfirmationDialog` stating the exact method, arguments, attached deposit (e.g. "1 yoctoNEAR, required by the contract for security") and effects.

**Buy** adds the transfer consequences in plain words:
- "You get the NFT, its balance (2.31 NEAR), its tubes and its age."
- "Its operator is cleared and its policy is reset to paused with a zero budget. It will not act until you register an operator and set a policy."
- "Jobs in flight are refunded."
- "Reputation reflects past settled trades; it does not predict future earnings."

#### 6.E Activity `/activity` (decision log and receipts)

**Purpose:** why each hire went the way it did, and, one click away, everything else that happened (§13 item 17).

**Layout:**
- **View** (`Decisions` | `Full log`, a run log only; LIVE and a run with no decisions are their log): Decisions is the default. `?view=log`, or any `kind` in the URL, opens the log. Unreadable lines pass every filter, so they show on top in both.
- **Filter bar** (sticky under the top bar): spore (`SporeRef` picker), epoch range, outcome; in Decisions the chip `Tube beat a cheaper quote`, in the log the kinds (Decisions, Settlements, Refunds, Refused / failed, Closes, Market, Images, Agent lifecycle). The source badge(s) sit in the heading row just above it; the top bar's stays in view (§13 item 16).
- **Heading figures (Decisions):** `≈ a tube beat a cheaper quote in 25 of 95 decisions` and `↻ 95 / 95 decisions match the log`, both over the whole run. "Beat a cheaper quote": the winner quoted more than another candidate and still had the lowest score, which only its tube can do.
- **Body:** a virtualized list of `EventFeed` rows grouped by epoch, with a sticky epoch header row: `Epoch 17 · closed 14:02:11 · fingerprint 9c1e…07ab`.

**Decision row (`HireRow`, one 24 px line per quote, at least 52 px):** time, `#8 hired #6` (`picked` unless the accept went through), service and retry, `≈ beat a cheaper quote` where true; one line per candidate in the rule's order, with `◆` on the winner; on the right the job's rail (`JobRail`: Post, Quote, Hire, Deliver as `◆` done, `✕` failed, `◇` not sent, `·` no line) and the outcome word. The row's button is named by its text summary and word.

**`QuoteTube`:** the quote as the Network map's tube (`graph/flex.ts`: same body and vein layers, width from `tubeWidth`, brightness from `tubeAlpha`, against the log's largest D, gradient from the consumer's palette to the provider's). Length is money, on one zero-based scale: the log's largest quote. The live body ends at a node on the effective price; past it the tube fades and thins out at the full quote, the part its strength took off. With no tube there is no body: a bare thread to the node. Candidates that didn't win step back to 55%. At row size widths are ×1.6 and brightness is `0.4 + 0.6·alpha`, keeping their order. Still, not living: only a close changes a tube (§3.5). Decorative (`aria-hidden`); the mono text beside it carries every value. A one-line key sits above the feed.

**Row in the full log (collapsed, 52 px):**

```
14:01:58  ◆ #3 hired #7 · data.fetch · 0.012 NEAR       ✓ Settled    ↗
```

- Time is mono-s.
- The kind glyph is coloured (`◆` agent, `✓` settled, `✕` refused, `◷` close, `◎` image, `⇄` sale).
- The summary is in `body`, the outcome word in its status colour, and the tx link last.

**`DecisionEntry` (expanded inline, progressive disclosure):**

Up front: the sentence, a labelled `JobRail` with the outcome, the two checks and the terminal receipt. Behind `<details>`: **Numbers and rule** (2), **Steps and txs** (5), **Technical** (6).

1. **Summary sentence** (marked derived):
   - "≈ #7 won on effective price: its tube with #3 (D 0.84) cut its 0.012 NEAR quote to an effective 0.0028. #12 quoted 0.009 with no tube."
   - Single candidate: "≈ Only one quote was in when the agent chose." (§13 item 16)
2. **Candidates table** (sorted by score):

   | Provider | Quote | D | D_norm | Effective price (score) |
   | --- | --- | --- | --- | --- |

   - The winner's row has a 2 px `--agent` left rule.
   - A caption shows the actual rule: `score = quote / (1 + w·D_norm), w = 4.00 (w_bps 40000), D_norm relative to the largest candidate D; lowest score wins, ties → lower price → lower id`. The values come from the log's `rule` field, not from constants.
3. **Recompute badge:** `↻ matches log`, or `↻ differs`, which expands to show both values. It is computed with `@rules` (`dNorm`, `score`, `pick`).
4. **Tube check:** "D values match the epoch 16 close" / "differ" / "— needs the epoch 16 close".
5. **Job timeline:** the labelled rail, then behind **Steps and txs** a `JobTimeline` of post → quotes → accept → deliver → settle or reject, with tx links per step.
6. **Technical** (`<details>`): raw JSON line, task hash, attempt, budget left and balance at decision time.

**Policy refusal rows** use `--warn`. The contract's error string is shown verbatim in mono (`policy: epoch budget exceeded`), together with the failed tx link. The row says "Refused by the contract", never "Blocked by the agent".

A contract panic is `Refused`; any other failed tx (an RPC timeout) is `Failed` and never says refused. An accept the agent didn't send (`over_budget`, `low_balance`) is a decision outcome in `--caution`, and its timeline says "Not sent" with what the agent read, because the contract refused nothing.

**Routine lines** (margin changes, skips, RPC reports, snapshots, outside-service calls, agent start and stop, clean exits, `done`) merge into one row per epoch that lists every line. A non-zero exit keeps its own row. Lines that can't be read are `Unreadable` rows on top and pass every filter.

**Close rows** show the fingerprint, the flow count, the tube count, `Verify →` (opens `/verify` at that epoch) and the tx.

**Live-only mode:** the decisions and job-history kinds are disabled in the filter, with the tooltip "Not on chain: written by the agents' run log". Closes appear only if close hashes are available.

**Mobile:** the filter bar collapses into a "Filters (3)" sheet; rows wrap to 2 lines.

**Accessibility:** rows are `<button aria-expanded>`, and the expanded content is a region labelled by the summary.

#### 6.F Marketplace (listings and purchase)

The gallery is the browsing surface (6.B, `view=listed` for sale).

**`MarketplaceListing`** is the card variant for listed spores. Below the art there is a 2-line meta:
- Line 1: price (`figure`, `--value`) and seller (mono-s).
- Line 2: `R 1.43 · 4 tubes · age 17 · 1 prior sale`.

There are no trend arrows, "floor" figures, "hot" labels or ROI.

**Purchase flow:**
1. **Buy** on the card or the detail page opens a `ConfirmationDialog`. It shows the price plus the split from `nft_payout` (seller 95%, royalty 5% to `<royalty account>`, values from the chain view) and the transfer consequences (§6.D.1). The wallet must be connected and must not be the owner.
2. **Wallet signing:** the dialog shows "Waiting for your wallet…". Cancelling returns to the dialog with "Cancelled in wallet. Nothing was sent."
3. **Pending:** "Sent · waiting for final outcome" with the hash as soon as it is known, plus a spinner.
4. **Final ok:** `✓ Purchase confirmed`, with the explorer link and "Spore #7 is yours. It is paused until you set a policy." plus the action **Set up Spore #7 →**.
5. **Final failure:** `✕ Purchase failed` plus the contract error verbatim (for example `attach exactly the listed price`, `spore is not listed`) plus the link. Nothing changes in the UI's ownership display.

**List flow:** the owner enters a price in NEAR. Show the net to the seller (from `nft_payout` for that price) and "Listing blocks pause and withdraw until you delist."

#### 6.G Receipts and verification

**`TransactionReceipt`** has one layout for every kind:

```
✓ Confirmed on chain          job_settled                         Epoch 17
#3 → #7   0.012 NEAR   fee 0.00012 NEAR                     tube #3–#7 →
tx 8Gk2…pQ1x ↗   block 1923…   signer op3.spores-hack.testnet
```

Kinds: payment or settlement, refund (with reason), service payment, sale (seller amount, royalty), policy refusal (error string, no amounts moved), close (fingerprint, flows), image commit.

The evidence level is the first token on the receipt (§4.3).

**`/verify` (Verify run)** mirrors `verify/src/main.rs` (plan S10).

- **Header:** what is being verified ("Every epoch fingerprint of `spores-hack-router4.testnet` from epoch 1 to 16, and the committed image of Spore #5"), the source of the close hashes (`docs/phase5-closes.txt`, the run log or the recorded bundle) and a **Run verification** button. It recomputes each click and nothing is cached as verified.
- **Progress:** `Fetching close 7 / 16`, then `Replaying`, then `Comparing`.
- **Results table:** one row per epoch.

  | Epoch | Fingerprint (replayed) | On chain (event / view) | Prev link | Tubes | Result |
  | --- | --- | --- | --- | --- | --- |

  - Result is `✓ Match`, `✕ Mismatch` (expandable diff) or `! Unable` (with reason: missing epoch N, archival rate limit, RPC down).
- **Image section:** state hash recomputed vs committed, image hash rendered vs committed, renderer version, plus the rendered image beside the glyph.
- **Footer:** "Verification ran in your browser using the same core code as the router (compiled to WebAssembly). It checked: … It did not check: anything not listed above."

**`VerificationResult`** is a compact form for the detail page and receipts: `✓ Match · 16/16 epochs · image matches commit` with a "Details" link.

#### 6.H Demo Lab `/lab`

**Index:**
- An intro line (`body-l`): "Four short demonstrations of what the contract enforces and what the economics do. Each one says whether it runs on testnet now, replays a recording, or shows a simulation."
- Then 4 `DemoSceneCard`s in a 2 × 2 grid (1 column on mobile).
- Each card shows the title, a one-line claim, a mode chip (`LIVE testnet`, `RECORDED`, `SIMULATION`, `Unavailable`), its duration and preconditions met as `n/m`.

**The whole loop** (`/lab/loop`, S13, §13 item 21) stands above the four scenes as one wide card, because it is where to start.
- **It explains itself before anything moves:** the question "What does a Spore actually do?", then the eight stops, each with what it means ("Paying someone grows a tube"). The narrator's first line is on screen in the first frame, and it plays on arrival.
- **One spore through one real run:** the one the run sells. Wake, its first settled hire with its real quotes and reason, the close that counted the payment, the reputation and allowance that followed, the redrawn picture, every later close as a time-lapse, then the sale's own log on the Sale stage, in the same places. As each stop is reached, its promise gives way to the run's figures and a tx link, so the finished column is the whole causal chain with its evidence.
- **A run still going is followed:** the same lines from a log that grows, polled every 3 s. Between lines the status says what the chain is doing ("Waiting for the epoch to close. 41 txs so far."). A lost log is said, and what's on screen stays.
- **On LIVE nothing plays:** the chain has no story, so the stops, a real spore's dish and `▶︎ Watch one real run` wait for a click, which switches the source in the URL and the banner.
- **Truth:** a tube that didn't grow says so, a fall in reputation says so, a run with no settled hire before its sale skips to the sale. The verdict is the run's own `report.json`. Story pace is labelled, as on the scenes, and Real time plays the logged gaps.

**The 4 scenes:**

1. **Prompt injection against a naive agent: Unavailable** (decision D2).
   - The card is shown at full size with a dashed outline and `--text-3` title.
   - Body: "Not built. No LLM agent exists in this project, so there is nothing honest to show. What the contract enforces regardless of what an agent is told is shown in *Rogue agent*."
   - Link: `Go to Rogue agent →`. There is no run button and no mock.
2. **Rogue agent** (`/lab/rogue`, plan S11).
3. **Sale and control transfer** (`/lab/sale`, plan S12).
4. **Wash trading** (`/lab/wash`, SIMULATION; the testnet run is stretch).

**Scene page layout** (the three-column layout below is replaced for Rogue, see §13 item 19: story left, stage pinned right, proof underneath. The content below all still exists; S12 starts from Rogue's layout. Original text kept for reference):
- **Left (4 columns): Brief.**
  - What this shows (2–3 sentences).
  - **Preconditions:** a checklist checked live, e.g. "router4 reachable ✓", "test spore #12 active ✓", "scene server running on 127.0.0.1 ✕ — start it with `bash scripts/demo.sh`".
  - The mode chip.
  - **Run** (disabled until the preconditions pass), **Replay recording** and **Reset** (only where the scene supports it; otherwise the reason is shown).
- **Centre (5 columns): Timeline.** A vertical `JobTimeline`-style list streaming from the scene server's SSE. Each step has a time, an actor, the action, the expected result, the actual result and a tx link.
- **Right (3 columns): Outcome and Evidence.**
  - A state diff (before → after values).
  - Receipts.
  - A single verdict line: **"Completed: 3 of 3 checks passed"** or **"Failed at check 2: expected `policy: epoch budget exceeded`, got `…`"**.

**Rogue specifics:**
- Each attempt shows **two lanes** side by side:
  - *Agent attempted* (`--agent`): "operator key called `accept` for 0.5 NEAR".
  - *Contract decided* (`--warn` or `--growth`): "Refused: `policy: payment exceeds the per-payment cap`".
- This separates what the agent tried from what the chain did. The brief's "model compliance vs contract execution" maps to these two lanes. There is no model here, and the agent's lane says "scripted".
- After the refusals, a decay strip shows the spore's art at epochs N, N+1 and N+2 while its agent is stopped, with D values under each.
- **The stage (S11, §13 item 19):** the spore's art in a dish, the contract as a membrane round it, its real tubes running out through the membrane. Each `accept`/`pay_service` is a violet pseudopod with an amber bead of the amount, pressing on a gate. A narrator line says what just happened; the contract's words appear verbatim under it. An act rail shows where the story is and, in playback, jumps. The primary figure `n / 3 attempts refused` and the verdict appear only when the run is over.

**Sale specifics:** the 11 checks from `runSale` as numbered steps. The ownership card flips from seller to buyer only when the `buy` tx is final. Payouts are read from receipts.
- **The stage (S12, §13 item 20):** the organism stays put; everything round it changes. The ownership card is a **paper label on the dish** (`belongs to` + the account), the one light thing on the dark stage. Its corners hold the parties: seller and buyer at the foot, the royalty account top right (between the other two on a phone). The agent's key is a violet line from its owner's corner through the wall to the spore. The question is "What does a buyer actually get?"; the story is five acts: Listed, Sold, Old hands out, What it kept, New hands.
- **A sale is final, so the story ends sold.** A live run leaves the spore with the buyer. **Reset** then takes the Run button's place, in plain view, and is a second real sale back with its own 5% royalty, then the first operator and policy. Nothing here closes an epoch, so no tube decays.

**Wash specifics** (SIMULATION panel styling, §4.1):
- The question as a heading: "Can one owner pump reputation by trading between their own spores?"
- The gate result as the primary figure, **naming its configuration**. It opens on what testnet actually runs: `168 / 270 in-range cases: attacker loses money and stays below the honest median R`, with `64 active, 1 honest job per spore per epoch (testnet traffic)` under it. All four traffic levels S1 measured stay on screen as selectable rows, `270 / 270`, `270 / 270`, `168 / 270`, `255 / 270`, each with a bar of its failures (replaces the `270 / 270` first written here; see the S12 **Design:** line).
- **The panel can be pushed on (S12, §13 item 20):** a slider for the loop size, 2 or 3 spores, the traffic rows. Any change replays the 40 epochs in the chart and a schematic loop drawn with this case's numbers, and the big line says what this case did: `It pays 0.20 NEAR and gets past the honest median.` with a `✕ Gate failed` stamp, or `…still trails…` with `✓ Gate held`. A stamp names only the case on screen: shipped fee, K and gain, worst of 3 seeds.
- The lines are read the way the gate reads them, worst for the defence at every epoch: highest attacker, lowest honest, smallest loss.
- The worst cases table, including the 6 out-of-range failures and the 93 tiny-loop literal failures, **stated as failures**.
- An attacker vs honest per-epoch chart (dashed series).
- The fixed sentence: "Receipts and escrow do not stop an attacker controlling both sides; the defense is economic. No universal Sybil resistance is claimed."
- Chart rules: the `dataviz` skill is applied at build time. There are 2 series only, attacker in `--warn` and honest in `--text-2`, with a direct label at each line end and no legend box.

**Playback (RECORDED):**
- The banner (§4.1) is shown, the timeline replays in **Story pace** (default: waits squeezed, the whole Rogue run in 39 s, every row keeping its real time) or **Real time** (the logged gaps, 3 min), replacing the 4× option (§13 item 19), and every tx link still works because they are real past txs.
- Run is replaced by **Replay** and Reset is hidden.
- `bash scripts/demo.sh --playback [run]` serves this with the network off; only Verify and tx links need one, and Verify says `! Unable` without it.

---

### 7. Component catalogue

This is a small set. Each component takes typed model objects (§11), never raw RPC JSON. Files are in `viz/src/ui/` (generic) or `viz/src/components/` (domain).

| Component | Responsibility | Variants | States |
| --- | --- | --- | --- |
| `SporeArtwork` | Shows a spore's image from a **render input only** (seed, age, tubes); asks the worker and shows the glyph until done | `full` (detail), `card`, `thumb` (32/96 px, uses a downscaled cache) | glyph-placeholder, rendering, ready, render-error ("Could not render · glyph shown") |
| `SporeIdentity` | Name (serif), id, palette swatch and name, state marker | `inline` (`SporeRef`: swatch + `#7`), `block` | — |
| `SporeCard` | Gallery tile = `SporeArtwork` + overlays + meta row | `default`, `featured` (larger, adds R line), `listing` (`MarketplaceListing`) | loading, hover, focus, selected (in `/mine` bulk) |
| `StateMarker` | Glyph + word for §1.5 states | — | the derived ones show `≈` |
| `NetworkGraph` | Canvas map per §6.C | `compact` (Overview), `explorer` | loading, no-history, error, reduced-motion |
| `EpochScrubber` | Epoch timeline under the graph | — | live, scrubbing, playing, missing epochs |
| `NetworkEdgeDetails` | Tube inspector content | — | with receipts, flows-only |
| `ReputationIndicator` | `R 1.43` + optional bar of √D shares | `figure`, `inline` | — |
| `ConductivityIndicator` | `D 0.84` + 1 px bar (width ∝ √D, max = collection max) | — | below-threshold |
| `BalanceDisplay` | NEAR amount from yocto (BigInt), exact in tooltip | `figure`, `inline` | stale |
| `AllowanceDisplay` | `left 0.18 of 0.30 NEAR` + a thin meter + formula tooltip | — | over-budget (`--warn` word "Spent") |
| `AgentStatus` | Operator, gen, last action time (if the source has it) | — | no operator, awaiting policy |
| `DecisionEntry` | §6.E expanded content | — | matches, differs, unverifiable |
| `JobTimeline` | Ordered steps with tx links | `job`, `scene` | step pending/ok/failed |
| `TransactionReceipt` | §6.G | per kind | evidence levels §4.3 |
| `VerificationResult` | Compact verdict + link | `compact`, `full` (the `/verify` table) | running, match, mismatch, unable |
| `TxAction` (the plan's `TxButton`) | Wallet call state machine: idle → confirm → signing → pending → ok / failed; disabled while busy | `primary`, `secondary`, `danger` (for Withdraw) | each state has fixed copy (§8.3) |
| `WalletStatus` | Connect / account menu (My Spores, Transactions, Disconnect) | — | disconnected, connecting, connected, wrong-network ("Switch to testnet") |
| `SourceBadge` | §4.1 | the 4 sources | stale |
| `EpochClock` | `E 17` + countdown arc to `ends_ns` | — | counting, closing… (past end, no close yet), stale |
| `EventFeed` | Virtualized grouped rows | `compact` (Overview, detail), `full` | empty-with-reason |
| `DemoSceneCard` | §6.H card | the 4 modes | unavailable |
| `LoadingState` / `EmptyState` / `ErrorState` | §6.0 | — | — |
| `ConfirmationDialog` | Method, args, deposit and consequences; focus-trapped | `default`, `danger` | — |
| `Tooltip` | Hover and focus, 400 ms delay, `role=tooltip`, max 280 px | — | — |
| `TxTray` | Bottom-right stack of recent txs (session only) → drawer | — | — |

Not built: a generic `Card`, a `StatTile`, a `Badge` zoo, or a `Chart` wrapper. Use the specific components above.

---

### 8. Content and formatting

#### 8.1 Numbers

- **NEAR:**
  - Format from the yocto string with BigInt. Never use `Number` on yocto.
  - Show up to 4 decimals with trailing zeros trimmed, and at least 2 decimals (`0.012 NEAR`, `2.31 NEAR`, `0.00 NEAR`).
  - Below 0.0001, show `<0.0001 NEAR`.
  - The tooltip shows the exact yocto amount.
- **D, R:** 2 decimals (§1.6).
- **Percentages:** whole numbers, except when below 1 (`0.4%`).
- **Hashes:** `8Gk2…pQ1x` (first 4 and last 4 for base58; first 6 and last 4 for hex), with a copy button and the full value in the tooltip.
- **Accounts:** full if ≤ 28 characters; otherwise middle-truncated, keeping the suffix (`buyer.spores…testnet`).
- **Time:** relative (`2 min ago`) with absolute local time plus UTC in the tooltip. Epoch headers use absolute `14:02:11`.

#### 8.2 Voice

- Short, declarative and specific. Name the mechanism ("the contract refused", "the router computed").
- Never "AI-powered", "revolutionary" or "unlock".
- Never imply returns. Reputation copy always reads as a history, not a forecast.
- Errors from the contract are quoted verbatim in mono, followed by one plain sentence of what to do.

#### 8.3 Fixed transaction copy

| State | Copy |
| --- | --- |
| confirm | `<Action> Spore #N` |
| signing | `Waiting for your wallet…` |
| pending | `Sent · waiting for final outcome` |
| ok | `✓ Confirmed` + link |
| failed | `✕ Failed: <contract error>` + link |
| cancelled | `Cancelled in wallet. Nothing was sent.` |

---

### 9. Accessibility

- WCAG 2.2 AA. The contrast table in §3.1.2 is binding.
- **Focus:** 2 px `--slime` outline with a 2 px offset on everything, never removed (11.5:1 on `--bg`). On art, the outline sits outside the art.
- A skip link goes to the main content.
- Landmarks: `header`, `nav`, `main`, `aside` (inspector).
- **Keyboard paths:**
  - Gallery: roving focus.
  - Network: Tab through active nodes; Enter opens the inspector; arrows pan; +/− zoom; 0 resets; Escape clears.
  - Scrubber: ←/→, Home/End.
  - Dialogs: focus trap and Escape.
- **Canvas alternatives:** a table view for the network; `aria-label` summaries for the art ("Spore #7 artwork: violet palette, 4 tubes, strongest to #3").
- **Live regions:** epoch close summaries, tx state changes and verification results are polite. Tx failure is assertive.
- **Reduced motion:** see §3.5. **Reduced transparency:** scrims become solid `--bg` at 85%.
- **Small text:** mono-s at 11 px is used only for annotations that are also available in larger form (tooltip, detail page). Body never goes below 14 px.
- **Colour independence:** every status has a glyph and a word (§3.1.2). Palettes carry identity and are always paired with the `#N` text.

### 10. Performance budgets

- **JS:** initial load ≤ 180 kB gzip. Routes are split; the wallet bundle loads on the first wallet interaction.
- **Wasm:** renderer 73 kB; core-wasm budget ≤ 250 kB.
- **Render worker:** at most 2 concurrent workers, ~1 s per image. Visible cards go first. IndexedDB cache keyed by `state_hash + RENDERER_VERSION`, so returning visitors render nothing.
- **Network canvas:** 60 fps pan with 2016 tubes, and the epoch tween at ≥ 50 fps.
- **RPC:** the bulk views (`nft_tokens` paged by 16, `edges`, `listings`, `config`) on load, then `epoch_info` every 10 s plus at `ends_ns`. There is no per-spore polling.
- **Crowded map (S14):** past `DENSE_TUBES` (400) the map draws each tube with one layer, 10 points and no glow. Width, brightness and position still come from the data; only the halo and the core go. Without this, 2016 tubes ran at 18 fps.

**Measured, S14 (2026-11-07), Chrome on this Mac, 120 Hz, device pixel ratio 2, an 800 px canvas. This is not the "2019 laptop" §6.C names; no such machine was tried.** Tube rows are the map's own `draw()` in `requestAnimationFrame` with synthetic tubes, so they exclude pan handling and React:

| Measure | Budget | Result |
| --- | --- | --- |
| Initial JS (gzip, files in `index.html`) | ≤ 180 kB | 175.0 kB |
| Overview plate chunk (gzip, lazy) | none | 6.7 kB |
| Landing story chunk (gzip, lazy) | none | 7.9 kB |
| Renderer wasm / core-wasm | 73 kB / ≤ 250 kB | 73.2 kB / 195.0 kB |
| 224 tubes, ambient (the most pairs one epoch can add) | 60 fps | 117 fps |
| 224 tubes, epoch tween with 30 glowing | ≥ 50 fps | 89 fps |
| 400 tubes, full detail (just under the cut) | 60 fps | 86 fps |
| 2016 tubes, ambient | 60 fps | 111 fps (18 fps before the cut) |
| 2016 tubes, epoch tween with 100 tubes marked glowing | ≥ 50 fps | 94 fps (glow not drawn past the cut) |
| Overview, the story playing | none | 117 fps, worst frame 55 ms |
| Overview, compact map (4 live tubes) | none | 120 fps, worst frame 10 ms |

### 11. Future compatibility (architecture only, nothing built)

These keep a later non-NFT product possible without touching the current one.

**Four model types with no cross-imports** (`viz/src/model/types.ts`):
- **`Organism`:** id, seed, palette, age, tubes, reputation. Pure biology; it feeds `SporeArtwork`, `NetworkGraph` and `ReputationIndicator`.
- **`Holding`:** owner, listing, sales, transfers, token metadata. NFT-specific; it feeds `MarketplaceListing` and owner gating.
- **`AgentAuthorization`:** operator, `operator_gen`, policy. Feeds `AgentStatus` and the policy forms.
- **`Economy`:** balance, effective budget, spent, flows. Feeds `BalanceDisplay` and `AllowanceDisplay`.

**Component boundaries:**
- `SporeArtwork` and `NetworkGraph` must not import `Holding`.
- Marketplace components must not import `Economy` internals.
- Owner gating goes through one function, `canAct(action, holding, wallet)`.

**Other rules:**
- Wallet identity (`WalletStatus`) is separate from ownership checks.
- Do not design token screens, token copy or placeholder routes.

### 12. Mapping to Phase 6 sessions

This is the index. Each session's **Design:** line has the full list and the conflicts it resolves. Every UI session also reads the always-on parts listed in "Rules": §2, §3, §4, §6.0, §8, §9 and §11.

| Session | Uses from this spec |
| --- | --- |
| S4 (done) | §3 tokens (`tokens.css` / `tokens.ts`), fonts (VERIFY packages), §5 shell, `SourceBadge`, `EpochClock`, `WalletStatus` shell, `TxTray`, §6.0 states, reduced-motion hook |
| S5 (done) | `SporeArtwork` loading states |
| S6 (done) | §6.B gallery, §1.5, §3.1.3, §3.3, §5.1; `SporeCard`, `SporeIdentity`, `StateMarker`, image-hash badge |
| S7 | §6.C network, §1.2, §3.4 glow, §3.5 epoch motion, §4.3; `NetworkGraph`, `EpochScrubber`, `NetworkEdgeDetails`, `ReputationIndicator`, `ConductivityIndicator`, legend, table view |
| S8 (done) | §6.D detail, §6.D.1 actions, §6.F marketplace, §8.3, §1.6, §5.4, §11 `canAct`; `TxAction`, `ConfirmationDialog`, `WalletStatus`, `BalanceDisplay`, `AllowanceDisplay`, `AgentStatus` |
| S9 (done) | §6.E activity, §6.G receipts, §4.3, §3.5, §5.5; `EventFeed`, `DecisionEntry`, `JobTimeline`, `TransactionReceipt` |
| S10 (done) | §6.G verify, §4.3; `VerificationResult` |
| S11 (done) | §6.H Demo Lab index, scene layout, Rogue; §5.4; §13 item 19; `DemoSceneCard` (in `pages/DemoLab.tsx`), `JobTimeline` `scene`, `SceneStage`, `SceneLanes`, `DecayStrip` |
| S12 (done) | §6.H sale and wash, §3.5, §4.1 SIMULATION styling, §13 item 20; `SaleStage`, `SceneChrome`, `WashChart`, `WashLoop` |
| S13 (done) | §4.1 RECORDED banner, §6.H playback and the whole loop, §6.0, §3.5, §13 item 21; `LoopStage`, `LoopVein` |
| S14 (done) | §6.A Overview, §5.3 mobile, §9 audit, §10 budgets, §2 "Explicitly not used" check, §13 item 22; `NetworkGraph` `compact`, `LoopVein` `across`, `HandArrow`, `OverviewPlate` |

### 13. Where this spec departs from the brief, and why

1. **Prompt-injection scene:** the brief asks for a working scene against a naive LLM agent. Decision D2 (user, 2026-11-03) is that it is unavailable. The card exists and says so (§6.H).
2. **"Elegant serif organism names":** the serif is kept, but the names are `Spore #N` only (D4).
3. **Muted text** is `#7E8C97`, not `#73818B`: the brief's value is 4.21:1 on the elevated surface, below AA.
4. **Gallery placement:** the brief lists a gallery screen and five nav sections without one. The gallery lives in Marketplace (§5.1).
5. **Demo Lab** is reachable but not a primary nav item (§5.1).
6. **"Fading connections when the state indicates decay":** decay is the default every epoch (D loses 25% unless fed), so fading is shown as tubes getting dimmer at each close, and "decaying" as a spore state is **derived** and marked `≈` (§1.5).
7. **Agent status "dormant / active / paused / decaying / newly transferred":** mapped to the states that exist (§1.5). "Newly transferred" is the contract's control reset.
8. **Slime theme** (user, 2026-11-03, after S4/S5): the brief's cool blue-grey base became the "living culture" theme (§2, §3.1.1, §3.4). Replaced values: `--bg #090D12`, `--surface #11171D`, `--surface-2 #151E25`, `--surface-3 #1B252D`, `--line #29333B`, `--line-strong #64717C`, `--text #E8F0F2`, `--text-2 #A8B5C0`, `--text-3 #7E8C97`, `--growth #52E0B0`, `--value`/`--caution #E6B96B`, `--r-1 4`, `--r-2 8`, and 1 px `--line` rules on the shell edges. New: `--slime`, `--slime-dim`, `--vein`, `--vein-mask`, `--r-blob`, the art bloom and `.btn-primary`. `brand/` first kept its old values; the "brand wiring" session then made `brand/build.py` read `tokens.css`, so the kit follows the theme and only the `*-ink` variants stay monochrome.
9. **Ambient motion** (user, 2026-11-03): the brief and principle 3 allow no idle motion. The user chose shuttle streaming on the veins and a breathing nucleus anyway, and on 2026-11-04 asked for the veins to expand and shrink too (vein breathing); they are limited to the shell and stop under reduced motion (§2, §3.5).
10. **The brief text was cut off** after "Prefer a small, consistent component…". The catalogue in §7 follows that intent (a small set, no generic wrappers). If the rest of the brief has more requirements, add them here.
11. **Gallery card details** (S6, 2026-11-04): LIVE cards show `◉ Activated` instead of the exact state (team decision, §1.5); muted words on the art are `--text-2` and the scrims reach full strength over the text rows (measured contrast, §6.B); two badge states were added (`checking…`, `! renderer vN`); `--scrim` became a token.
12. **Slime type** (user, 2026-11-04): asked for typography that "looks like slime (expanding, some doodle)". Chosen from options: Gluten for the display face, Shantell Sans for all interface text, mono unchanged for evidence, and "expanding" as weight swells on real events only. Replaced: Instrument Serif 400/400i (display), Geist 400/500/600 (sans), token `--font-serif` (now `--font-display`), display weight 400 (now 500), principle 5 wording. New: `--doodle`, `--doodle-loud`, the wordmark letter breathing (inside the existing ambient exception, item 9) and the name swell (§3.5). This sits next to the "no wobble or jelly" rule on purpose: nothing wobbles at rest, bounce is a static letter offset on titles only, and swells run once per confirmed close. The `brand/` wordmark is still outlined from Instrument Serif until `brand/build.sh` is moved to Gluten.
13. **Every step shown** (user, 2026-11-04, S7: "don't hesitate to use animations… I want every steps of the network can be visually shown"): the brief's Network screen shows tubes per epoch only. S7 adds the loop rail, the step feed, the Steps toggle and the step, live-settlement and close-sweep motions (§3.5, §6.C). They stay inside principle 3 and the truth rule: every mark is a logged or confirmed step, data never moves at rest, tubes still change only at a close, and all of it is off under reduced motion. Within the existing rules (new §3.5 rows), so no new token or colour; `tokens.ts` `motion` gains `grow` and `pulse`, which mirror `--t-grow`/`--t-pulse`.
14. **Living Network map and step monitor** (user, 2026-11-04): asked for the ring to be "more flexible, limber, feels like tube expanding", and for the log to be "more like the monitor… easy to watch visually, not a bunch of text components". Tubes became flared filled bodies with ambient peristalsis, breathing and sway: a second ambient exception to principle 3 after item 9, limited to the Network canvas and off under reduced motion. Tubes also swell in from both ends when they grow at a close. The step feed became a lane monitor, with the text feed one click away (§3.5, §6.C). Then (same day, "I want the tube and the node is the spore (NFT) visually, and we can have idle motion as well"): nodes show each spore's own art (current state, glyph first) and breathe with the ring; tubes take the art's vein layers. The user confirmed idle motion on the map. Then ("I want the spore as the visual and its tube is the tube, not just the spore inside the ring"): the node is the whole art keyed onto the dish with no disc or ring, and each tube starts at the partner's disc in the art and leaves along its vein (§6.C). Also, ≥ md the Network page now keeps the footer in the frame: the map takes the wheel and the inspector scrolls on its own, so the footer below the fold could not be reached.
15. **Spore detail, wallet and market** (S8, 2026-11-04): the wallet is `@hot-labs/near-connect`, which NEAR's docs now recommend, not wallet-selector (plan S8 VERIFY; `docs/verify-notes.md`). Not built, each shown as `—` with the reason: the epoch compare slider (stretch, Cut order), the detail page's Activity block (S9), "Verify this image" for older commits (S10; a commit for the state shown is checked in the art caption), the last sale (needs `spore_sold` events, S9). `TxAction`'s `danger` variant (Withdraw) has the secondary look and an `alertdialog`, with no colour of its own: `--warn` means a status (§3.1.2). The wallet menu has My Spores, Demo Lab and Disconnect; recent txs stay in the tray rather than a "Transactions" menu item. Owner actions show only on LIVE (a run is not the chain the wallet signs on). The Network page now reads `?sel=7` / `?sel=3-7` once on load (§5.1), so tube links from a Spore page open with the tube selected. New: the gallery's "Owned by me" chip (§6.B), the `listing` card variant with Buy under it (§6.F)
16. **Activity** (S9, 2026-11-05), each chosen because the real logs made the Design's wording untrue or the layout unusable: the filter chip is `Refused / failed`, not "Policy refusals", because the log's contract refusals are mostly job races (`job is not open`, `job has timed out`) and some failures aren't refusals at all (RPC timeouts). The single-candidate sentence is "Only one quote was in when the agent chose", not "Only one provider quoted": in `phase6-s3-dense3` two more quotes landed after the choice, and the timeline marks them "Not a candidate". The source badge moved from the sticky bar to the heading row, and the bar's labels went inline with 32 px controls on desktop (40 px on mobile), taking the bar from 181 px to 89 px at 1440. New, not in the Design: routine lines merge per epoch (§6.E); a `↻ n / n decisions match the log` figure in the heading; a caption under each timeline saying log times can run out of order; a line under the feed accounting for every log line. Rows are buttons, so the collapsed summary uses plain `#7`, with `SporeRef` swatches in the expanded content. The hover preview on `SporeRef` (§5.5) is still not built. The `compact` variant of `EventFeed` is a separate component, `CompactFeed`. `Verify →` links to `/verify?epoch=N`, which S10 must read.
17. **Activity opens on decisions, drawn as tubes** (2026-11-05). User, on the S9 page: "dense and textful… how do we improve it? should we implement it like network page? or should we remove it?", then "ok" to this plan, then "make the bar as a tube". Replaced: a flat, every-line feed as the default, where a first screen at 1440 showed part of one decision and the reason took a click. Kept the plan's "never cut" decision log with recompute; not a second map, because Network already shows flow over time and a map can't show why one quote beat another. The old feed is unchanged as `Full log`, so nothing is dropped. New: `HireRow`, `QuoteTube`, `JobRail`, the `tube=1` and `view=log` params, the two heading figures. Palette colour extends to these tubes (§3.1.3) because they are real pairs' tubes. A decision candidate with an unreadable number is now an `Unreadable` row; before, it could throw while building the feed. The footer accounting line shows in the log only. `/spore/:id`'s Activity links open the log.
18. **Verify** (S10, 2026-11-05). The header leaves out "to N" until a run has happened: a list needn't start at epoch 1, so its length doesn't say how far it reaches. Progress adds `Reading the close list`, a count on `Comparing`, and `Rendering Spore #N`; `Replaying` is in the copy but takes under a frame, so it is not seen in practice (no delay was added to show it). `! Unable` has a fourth reason beside the three named: `archival node unreachable or rate-limited: the browser cannot tell which`, because both archival nodes send their 429 without a CORS header. New, not in the Design: a Spore field (`?spore=`) with Spore #5 as the default; every row expands, not just mismatches, and a `?epoch=N` row opens expanded and is scrolled to; a block naming close txs that could not be used (which epoch they were is unknown); a line for the router head. `VerificationResult` is three exports (`VerificationTable`, `EpochVerification`, `SporeVerification`) rather than one with a `variant` prop. Compact results come from the run in memory (lost on reload, with the run time in a tooltip); a Spore page shows a verdict only for a run of that spore. On mobile the row keeps epoch, fingerprint and result, and opening it shows every check. Not built: a copy button on hashes (§8.1; the full value is in the tooltip or the expanded row), the same gap as earlier screens.
19. **Demo Lab is built for the first 30 seconds** (S11, 2026-11-06). User: "design it for user first with good experience and can understand in first 30s. dont hesitate to use animation and non AI generic design". Replaces the three text columns of §6.H with a **stage**: the question, a narrator line, one button, and a dish where the agent's attempts press on the wall of its contract; the Brief, timeline, state diff, receipts and preconditions all still exist, under "Check it yourself". Changes against this spec: (a) story left and stage pinned right, so the thing happening is never scrolled away; (b) **Gluten on the scene's question and narrator line**, an exception to principle 5 like the Overview's one line: it speaks about the organism; (c) a perpetual **membrane**, a third ambient exception to principle 3 beside the shell and the map, since it is the scene's subject (§3.5); (d) **Story pace** replaces the 4× option, because 4× of 3 min is still 45 s of mostly waiting, and it is labelled; (e) the Rogue card comes first on the index, not the unavailable one, and Sale and Wash say "Not built yet" with the session until S12; (f) new stamp and sketch elements: the stamp pairs a glyph and word like every status, and the card sketches are the mechanism, not illustration. Still in force: no motion before its confirmed trigger, no optimistic state, verdict only on the real exit code, every value from the log.
20. **Sale and wash are built for the first 30 seconds too** (S12, 2026-11-06). User, same words as S11: "design it for user first with good experience and can understand in first 30s. dont hesitate to use animation and non AI generic design". Against this spec: (a) the ownership card is a **paper label on the dish**, in the inverse colours (`--text` ground, `--bg` ink), the only light surface in the app, because it is the one thing a sale changes; an exception to the dark-surface rule, and Gluten on an account word, under the same reasoning as §13 item 19 (b): it names who the organism belongs to; (b) **the wash panel opens on its unfavourable case**, testnet traffic and a 3-spore 0.2 NEAR loop that beats the gate, not on `270 / 270`; (c) **simulation playback** is motion with no chain event behind it, a deliberate exception to the design guide's motion tree, kept honest by the dashed `SIMULATION` styling, and it stops at epoch 40, so it is not ambient; (d) a schematic of the loop sits beside the chart, labelled as a picture: its widths, counts and money are simulated values, single beads are not; (e) the chart has **no legend** (Design already said so; dataviz would keep one): both lines are labelled at their heads, and their dash patterns differ, so identity is never colour alone; (f) on a phone the narrator sits directly above the dish on story scenes, Rogue included, instead of above the controls. Still in force: no motion before its confirmed trigger for anything from the chain, no optimistic state, the verdict only on the real exit code, every value from the log or the simulator's file.
21. **The whole loop is built for the first 30 seconds** (S13, 2026-11-06). User, same words as S11 and S12: "design it for user first with good experience and can understand in first 30s. dont hesitate to use animation and non AI generic design". S13's **Do** only asks that playback "steps through the bundle's epochs on a timer". A timer over the Network page would show a judge a map that changes, with no idea why. Added: (a) a new first scene, `/lab/loop`, the page `scripts/demo.sh` opens, and its story built from the run's logs; (b) **the eight stops as one yolk vein down the page**, in place of an act rail: the promises are readable before anything moves, and the facts that replace them leave a chain of evidence on screen; a thin vein back to Hire closes the loop only when the log shows the new agent working; (c) **the rim of the dish is the allowance**, amber as money, so "tubes set what it may spend" is a thing that moves; (d) a **time-lapse** of the closes before the sale, one exception to pacing by the log, labelled by the epoch on the plate and undone by `Real time`; (e) `/lab` gets a fifth, wide card, and its intro changes; (f) the Sale stage is reused unchanged at the end, so the sale happens where the spore already is. (g) the vein and the stage's tubes have the Network tubes' ambient peristalsis, a further ambient exception beside items 9, 14 and 19, off under reduced motion; (h) on this page `✓ kept` is at the buy, and the Sale stage marks a value only if it is the one the blocks either side of the buy agree on, because closes go on during a real run's sale. Still in force: nothing moves before its confirmed trigger, no optimistic state, tubes move only at a close, the verdict is the run's own report.
22. **The Overview is built for the first 30 seconds** (S14, 2026-11-07). User, same words as S11, S12 and S13: "design it for user first with good experience and can understand in first 30s. dont hesitate to use animation and non AI generic design". §6.A's hero is the live map, but between runs the live router is a nearly empty ring on a clock stuck at `closing…` (seen 2026-11-07: epoch 64, 4 tubes in one corner, 16 h since its end), so the first screen would explain nothing and look broken. Against §6.A: (a) **the hero plays a recording**, one real spore's life on the loop's stage, and says so: a `RECORDED` badge and "A real testnet run, retold in 32 s. It took 4 min." next to the region it governs, with `LIVE` on everything below (§4.1 mixed views); the app's source stays LIVE, so no banner and no switch of source. It never stands in for live data: the "Right now" section reads only the chain and fails on its own. (b) **The live map, `Epoch N` and its inline figures move to "Right now"**, the second section, in §6.A's own 7/5 proportions, with a new honest sentence when nobody is closing epochs ("No run is going… this one has waited 16 h"), after 90 s past its end. (c) **A pen arrow**, the plate's one new element, from a handwritten note to the thing being talked about (§3.5 "Plate pen"), because the question in an animated explainer is always "where do I look?". The note is `title` type in yolk, interface rather than status, and reuses the loop's narrator lines (`narrateLoop`), so there is no second telling to keep true. (d) **The 8-step strip and the timeline are one thing:** `LoopVein` `across`. A click on a stop lands on it and holds there rather than leaving the page, and §6.A's click targets become a link on each stop ("Every hire →", "The map →", "The sale →"), shown on the stop being told, on hover or focus, and on all of them once it ends. (e) **Inline figures say `pairs`, not `payments`:** §6.A's example reads "6 payments settled this epoch", but `epoch_info.flows` keeps one total per pair, so counting them as payments would be untrue. Total D and the treasury are behind "more" (the treasury has no view: it is only in each close's event). (f) On a phone the note and the dish come first and the body copy follows them, not §6.A's order of graph first: the note is what tells you what the dish means. (g) **Nothing here is an ambient exception:** the stages are the same ones already listed (§13 items 14, 21), and the story ends, stays ended, pauses when scrolled away or the tab is hidden, and has a Pause button (WCAG 2.2.2). It announces nothing, since a story playing itself isn't a live region; the same words are in the stops. Still in force: no motion before its confirmed trigger, tubes move only at a close, every value from the log or the chain.
23. **The Overview becomes a landing page and leaves the nav** (2026-11-07). User: "I want the overview turns into landing page and it left the nav bar, also we need to make it has more info about what is us, what do we do, how does it work but only overview". Then a brief to fix the first screen's competing focal points without changing its fonts or identity. Against §5 and §6.A: (a) **`/` has its own frame** (`LandingFrame`): wordmark, section links, `Open the app`; no app nav, wallet, clock or bottom bar. The app's nav has four items and its wordmark goes home. Read as "it leaves the nav bar" and "has no app nav"; if the user meant keeping the bar on `/`, that is one route move in `App.tsx`. (b) **The story below the plate** is new: what a spore is (a real spore with pen labels), what we do, how it works, proof, the live collection, about. Every figure is read from the recording (`model/landing.ts`) or is a result checked against a committed file by a test. Recent activity leaves the page; the Activity page has it. (c) **Gluten on section lines**, at `display-m`: a departure from "only spore names, the wordmark and the one Overview line" (§2 principle 5), because a landing page's sections are its argument. No font changes. (d) **The first screen**: the line runs across the top in one or two lines; beside the stage a sheet names the spore, its state, who holds it and what it has, one list in one alignment, where the stage's own figures used to float. On this page only, the stage has no figures or D labels: they move to the sheet and to tooltips on its spores, which are now links with hover and focus states. A legend names what's drawn, from what the stage code draws. (e) **The timeline** is each stop's name and state, in a word as well as colour; the chosen stop's meaning, figures, gloss of D, R and E, transaction and deep link sit in one panel under it, with Play. A click lands at the stop's end, so its figures are there. On a phone the stops scroll sideways, with the chosen one kept in view. `/lab/loop` keeps its vertical vein and stage figures unchanged. (f) **Two motions with no chain event**, both on scroll and logged in §3.5: the specimen's pen arrows and the How it works vein. Both are decorative and still under reduced motion.
24. **No About section, the brand mark as the logo, no developer text** (2026-11-07). User: "remove about section inside landing page, update the app logo with our brand, remove texts that gives us dev info (waiting for someone to call, testnet run,...)". The FAQ and its limits list left the page, so those disclosures now belong to the README (its Known limits is still a TODO). Visitors no longer read how epochs get closed, shell commands, run ids or RPC method names. What stays on purpose: the `RECORDED` / `LIVE` / `SIMULATION` marks, one "on NEAR testnet" in the landing lede and "Testnet NEAR has no value" on the Balance tooltip, because nothing else now says the money is not real. Same day, user said yes to the deeper pages too: "run log" became "agents' log" or "recording", "router" became "contract" in visible text, method names left tooltips and errors, recordings are named by scene and date instead of run id, and the Demo Lab's live controls and preconditions show only when the scene server answers (`operator`), so a visitor never reads about it. Operators start it from CLAUDE.md's command; the page no longer prints it. Still technical on purpose: the raw `?view=log` lines, the token JSON on the Spore page, contract error strings, the Sale checks' names (they come from the recorded log), and `spores-verify` named once under Proof.

---

## Session log

| Date | Session | Done | Measured / output | Left / notes |
| --- | --- | --- | --- | --- |
| 2026-11-03 | planning | This plan; repo survey; RPC CORS check | CORS OK on 4 endpoints | Start S1 + S2 |
| 2026-11-03 | design | Design section (below) from the design brief: tokens (palettes from `paint.rs`), IA, 8 screens, components, provenance marks; S4 and D5 point to it | Text contrast measured: brief's muted `#73818B` is 4.21:1 on `#151E25`, so `#7E8C97` is used (≥ 4.89:1) | The brief text was cut off in the component section. Fonts' package names are VERIFY in S4 |
| 2026-11-03 | S1 | `spores-sim` gets `--max-active N` (default 16) and `--jobs N` (honest jobs per spore per epoch, default 3; testnet agents default to 1). Non-default runs write suffixed files (`allowance-64.md`, `allowance-64-j1.md`). `sweep.json` gets per-seed nets and per-epoch series; `baseline.json` gets tube and event-list counts. Test `series_match_the_ledger`. No core change; the 16-active default outputs are unchanged | Shipped wash gate (in range) **with the allowance the router enforces**: 16×3 jobs 270/270, **64×3 jobs 270/270**, 16×1 255/270, **64×1 168/270**. Attacker loses money in 270/270 in every config. At 64×1 the honest median R is about 2 (0 in 30 cases), so a 3-spore loop of ≥ 0.2 NEAR/edge/epoch passes it while losing about 0.2 NEAR over 40 epochs. Edge counts at 64×3 (shipped hiring): tubes mean 236, max 292; flow edges max 149; reject edges max 103; rebated spores 64; theoretical max 2016 | Live R is only meaningful against wash loops at about 3 honest jobs per spore per epoch: S3 must weigh `JOBS_PER_EPOCH` against RPC load. The wash panel shows the traffic dependence |
| 2026-11-03 | docs | Merged `docs/phase1-results.md`…`phase5-results.md` into one `docs/results.md` (superseded decisions dropped; deviations renumbered 1–35; the S1 gate table added) and removed the five with `git rm`; repointed every reference (ROADMAP, CLAUDE, README, SPEC, verify-notes, this plan, three code comments, no router file) | Old routers v0, router2 and router3 cannot be deleted directly: 36.9–41.3 KB of non-code state each, over NEAR's 10 KB delete limit | Team decision: leave them as evidence |
| 2026-11-03 | D3 revised | Team chose to grow router4 instead of deploying router5. D3, S3 (new step 0: admin-only raise-only `set_max_active`, code-only redeploy), S4–S13 and References A/E now point at router4; D2 repointed to `docs/results.md` | router4 live `config`: `supply_cap` 64, `max_active` 16, `epoch_len_ns` 30 s; `nft_total_supply` 64. `verify` reads only `Config::params()` from `config`, so the raise doesn't touch epochs 1–16 | S3 does the router change, redeploy and raise; record the new wasm hash and tx hashes. Next: S2 |
| 2026-11-03 | S2 | (1) NEAR limits re-read from live testnet and docs into `docs/verify-notes.md` "Phase 6". (2) Router test `epoch_closed_log_size_at_64_active` in `router/src/tests.rs` (beside the Phase 5 16-active test, not `epoch.rs`): runs a real `close_epoch` with 64 active in the mock, log cap lifted, and measures the event. (3) Keeper: image commits moved off the close path into `agents/src/commits.ts` (`CommitQueue`): render + commit run in the background; `stop()` before each close skips what the close would make stale (logged as `kind: skip`); the keeper waits for the last batch before `done`. `run.ts` counts skips in its check and report | Limits (protocol 88): 16,384 log bytes per receipt in total, 100 logs, 1 PGas per tx, 100 actions per receipt, 1e19 yocto/byte; view gas still open (node-local). `epoch_closed` bytes: sim peak at 64×3 (292 tubes, 149 flows, 103 rejects) 14,015; every pair 129,695; ceiling 889 tubes with no flows, 352 in the sim's mix; **largest `max_active` whose worst case fits: 22**. An oversized event fails the close, and the router can't close again until its code changes. Tests: cargo workspace OK (router 30), clippy clean, agents 16/16 (4 new) | **Stopped for a decision (S2 rule):** 64 active is not safe with the current event. Options: raise router4 to 22 only, or trim the event in S3 (drop `tubes`, which `verify` already recomputes, and cap new trade pairs per epoch). Keeper testnet run deferred to S3. A close can still wait for one in-flight commit tx (same key, sent in order) |
| 2026-11-03 | S2 decision | Team chose option 1: trim `epoch_closed` (drop `tubes`) and cap trading pairs per epoch, keeping 64 active. D3, S3 step 0, S7/S9 and Design (tube history from replay after epoch 16) and Cut order (fallback: 22) updated | Design: cap check at `accept` counts this epoch's pairs plus escrowed jobs (they can settle after the close); counter under a raw storage key so the state layout is unchanged | S3 step 0 implements it; size `MAX_EPOCH_PAIRS` with the S2 test |
| 2026-11-03 | S3 dense run | Run `phase6-s3-dense3` (`scripts/phase6-testnet.sh`, all 64 spores in one agent process, epochs 20–26, seed 1, no shocks) on router4 (wasm `b82f4dcd…`, `max_active` 64). All 9 exit checks PASS: unattended trading for 6 epochs, tubes formed, art changed (46 spores), 123/123 hires replay against `spores_core`, ledger conserved, 25 outside sales against receipts, image commits, `spores-verify epochs` matches epochs 1–25 from the close receipts, spore 0's image regenerated and matches | Close gas 21.61 Tgas avg (max 22.32); `epoch_closed` log 529–2,222 bytes (limit 16,384); pairs per close 0–31 (cap 224). **Seconds between closes 51–80 (epoch length is 30 s)**, so the "closes every ~30–40 s" item of S3 "Done when" is **not met** at 64 active. RPC requests per epoch 294–1,074, of which 172–626 were rate-limited. 853 txs, 76 failed (19 `post_job` "too many unfinished jobs", 14 `accept` and 18 `quote` after a job timed out, 16 `quote` on a job no longer open, 4 free-plan RPC timeouts, 3 `deliver` after timeout). 13 image commits ok, 371 skipped because the next close came first. Report: `out/agents/phase6-s3-dense3/report.md`, `out/phase6/report.md` | Not in this log yet: the funding arithmetic S3 step 2 asks for (not recorded in any file I found, so not guessed). Close interval and RPC rate-limiting at 64 active are open: S11/S13 demo needs fast epochs, decide whether to lower per-epoch RPC load (`QUOTE_FANOUT`, `POST_EVERY`, `RPC_CONCURRENCY`) or accept ~1 close per minute |
| 2026-11-03 | S4 | `viz/` scaffolded with `npm create vite@9.3.3` (react-ts), template demo files removed, oxlint dropped. Deps: react 19.3.1, react-router 8.5.1; dev: vite 8.3.5, vitest 5.1.0, @testing-library/react 16.3.3, jsdom 30.1.3, fake-indexeddb 6.2.7, typescript 7.0.2. Fonts **VERIFY** done: `@fontsource/instrument-serif` 5.3.0, `@fontsource/geist-sans` 5.3.0 and `@fontsource/geist-mono` 5.3.0 (all OFL-1.1); only the latin woff2 files used (serif 400/400i, sans 400/500/600, mono 400/500) are copied into `viz/public/fonts/` with both OFL texts, and the packages are not dependencies. `tokens.css`/`tokens.ts` (Design §3; palettes copied from `paint.rs`, checked by a test that parses `paint.rs`). Shell: top bar, `SourceBadge` (4 sources + stale), `EpochClock` (countdown arc, "closing…" past `ends_ns`, text-only under reduced motion), disabled `WalletStatus` shell ("not built yet, S8"), `TxTray`, mobile bottom bar, RECORDED banner, skip link, footer reduced-motion toggle, global states (`LoadingBar`, `EmptyState`, `ErrorState` naming the endpoint, `Unavailable`). Unbuilt routes say "Not built yet" and name their session. `chain/rpc.ts` (rotation, backoff as `near.ts`, archival fallback for `tx`), `router.ts` (typed views from live router4 output), `events.ts`. Polling `epoch_info` every 10 s plus just after `ends_ns`; stale after 30 s of failures. Sources: `live.ts`, `run.ts` + dev middleware `viz/server/runs.ts` (only Reference C files; also lists runs and `snapshots/`/`renders/`; realpath check against symlinks), `recorded.ts` (`recorded/index.json` + `<run>/files.json`, format for S13). Dev server binds 127.0.0.1; `fs.allow` = `viz/` + `agents/src/rules.ts` (`@rules` alias) | `npm run dev` showed the shell against router4: `E 26`, LIVE · testnet · router4, "closing…" (epoch 26 ended, nobody is closing). Probes: `/runs/` lists 10 runs; `.env`, `agents/src/near.ts` 403; `keeper.log`, `control.json`, encoded and raw `..` paths 404. `npm test`: 35 tests (rpc rotation/backoff/archival with mock fetch, events, source labels, run-file allowlist incl. symlink escape, shell states, polling, format, tokens). Build 88 kB gzip JS (budget 180) | Wallet (S8). Route splitting not needed yet. README "Libraries" TODO must list the three OFL fonts |
| 2026-11-03 | S5 | New crate `core-wasm/` (workspace member, cdylib+rlib; JSON via `serde_json` in the wrapper only): `replay` and `state_hash` over `spores_core`, C ABI `alloc`/`dealloc`/call/`result_ptr`/`result_len`, errors as text (code 1), not traps. `params` accepts the router `config` (mapped as `verify`, `CappedRebate`) or a vectors `params` object. New cargo profile `wasm` (opt-level s, LTO, strip) for core-wasm only; the renderer stays on `release`. `core-wasm/js/check.mjs`. `scripts/build-wasm.sh` builds both, copies them to `viz/public/wasm/` (git-ignored) with `manifest.json` (`renderer_version` read from `renderer/src/lib.rs`, sizes, sha256) and runs both checks. viz: `wasm/renderer.ts` (input encoding per `lib.rs:38-56`, `render_into` + `hash_image`), `renderer.worker.ts`, `renderQueue.ts` (≤ 2 workers, lowest priority first, one render per input, release on unmount), `imageCache.ts` (IndexedDB, RGB + hash, trimmed at 200 entries), `art.ts` (app queue), `core.ts`, and `components/SporeArtwork.tsx` (glyph placeholder "on-chain glyph · rendering…", crossfade, "Could not render · glyph shown", aria-label summary) | core-wasm size: 285 kB on `release`, 224 kB at opt 3 + strip, **195 kB on `wasm`** (budget 250). `node core-wasm/js/check.mjs`: OK (2 epoch chains × 6 epochs: fingerprints, prev, tubes, R; 4 spore states; error text). `renderer/js/check.mjs --wasm`: OK 10/10. vitest: renderer wasm matches all 10 `vectors/renderer.json` image hashes; the TS core wrapper matches both chains (also with the router-config params form) and all states; queue order/dedupe/release/cache; IndexedDB cache; artwork states. In Chrome (dev server, real Worker + IndexedDB): 3 vector cases matched with 2 workers in parallel (716 ms per mature image), a repeat came from the cache in 5 ms. Gates: `cargo test --workspace` OK (core-wasm 5 new), clippy clean, agents 20/20, viz 50/50 | **Deviations:** (1) the image cache key is `r<RENDERER_VERSION>:sha256(encoded render input)`, not the state hash: the image depends only on seed, age and tubes, and historical states have no stored state hash without core-wasm; (2) `replay` also returns the replayed `prev_fingerprint` and `reputation` (needed by S7/S10). Not built: the downscaled `thumb` cache (Design §7); `thumb` scales the full image. `viz/test` needs `scripts/build-wasm.sh` first (it reads `viz/public/wasm/`); S13's `demo.sh` must call it. No commits made |
| 2026-11-03 | design wiring | Each UI session not yet run (S6–S14) now has a **Design:** line naming its Design subsections and §7 components, and resolving where its **Do** list (written before the Design section) disagrees. "Rules" gets the always-on Design parts (§2, §3, §4, §6.0, §8, §9, §11), the list of S4/S5 modules to reuse, and the precedence. Design §12 is now an index and gains S13 | Conflicts resolved in favour of Design: S6 badge words, glyph loading instead of a skeleton, stale via the badge; S7 table view required, hollow ticks for missing epochs; S8 `TxButton` → `TxAction` with a confirm step and `ConfirmationDialog`, disabled actions keep the contract's reason; S9 `≈` summary, `↻` recompute, Logged vs Confirmed; S11 Scene A copy; S14 health as inline text, not tiles | Open: Design §6.H's wash primary figure says `270 / 270`, but S1 measured 64×1 (testnet traffic) at 168/270; the S12 line requires the figure to name its configuration and the panel to show every configuration. S14 still names `docs/phase6-results.md`, although results were merged into `docs/results.md` (not changed here) |
| 2026-11-03 | design audit (S4/S5 vs Design) | Checked the built shell, tokens and `SporeArtwork` against Design §2–§9 and §11 (desktop 1440 and mobile 390 in Chrome). Tokens (§3), source badges (§4.1), RECORDED banner, page frame, bottom bar, EpochClock, global states, §8.1 formats and §8.3 tx copy already matched. Fixed: (1) new `ui/Tooltip.tsx` (§7: hover and focus after 400 ms, tap opens at once, Escape closes, `role=tooltip`, max 280 px); every native `title` replaced (SourceBadge, EpochClock, WalletStatus, `Unavailable`, the artwork error caption); (2) hit targets: nav links 38 → 40 px, mobile source badge 28 → 44 px (§3.3); (3) nav underline 2 px at 8 px below the baseline (`text-underline-offset`) instead of a border at the box edge (§5.2); (4) mobile wallet is an avatar button (§5.3), and the wallet shell uses `aria-disabled`, so its "not built yet" reason is reachable; (5) Demo Lab reachable on mobile from the Overview (§5.3); (6) a stale EpochClock keeps its value with the `!` ring and "as of" (§4.2); (7) RECORDED banner text 12 px (no token) → `body` 14 px (§3.2, §9); (8) serif preloaded for the wordmark | viz 54/54 (4 new: tooltip timing/focus/Escape/tap, `Unavailable`, stale clock, wallet reason); build 88.5 kB gzip JS | The ad-hoc preview grid shown earlier (`out/preview-live-art.png`) was not §6.B: S6 builds `SporeCard` (overlays inside the art, scrims, state marker, hash badge, 36 px meta row). Still open from §7: the downscaled `thumb` cache; `SporeArtwork` does not separate "queued" from "rendering" (the queue reports no start). No commits made |
| 2026-11-03 | branding | New `brand/` kit (guide in `brand/README.md`). Mark = Spore #3's tubes (#8, #25, #46) from the `phase6-s3-dense3` epoch-22 snapshot on router4, drawn in the renderer's ring geometry (64 slots at N×5.625°, partners pulled in by 84·D_norm, tube width ∝ √D); picked as the most evenly spread 3–5-partner spore in the recorded runs (Spore #5 was tried first; its partners all sit within 34° of 12 o'clock). Monochrome only: no palette or status colours in brand marks. Outlined wordmark and lockup (Instrument Serif via fontTools + HarfBuzz kerning), small-size variant (ring line, 1.7× strokes), 1200×630 social card with the real Spore #5 epoch-17 render and its committed image hash. `brand/build.py` + `brand/build.sh` (headless Chrome) rebuild everything; favicon and `apple-touch-icon.png` copied into `viz/public/`, `index.html` gains the touch icon and `theme-color` | Contact sheet checked at 256/180/48/32/24/16 px on dark and white; viz 54/54 | `og:image` meta needs the deployed absolute URL. Project name in the files is the working name "Spores"; the submission name is the team's call. No commits made |
| 2026-11-03 | slime theme | User asked for a slime theme and chose "living culture", app only. `viz/src/ui/tokens.css` + `tokens.ts`: agar green-black base, warm text, `--slime` yolk accent, `--growth` slime green, `--value`/`--caution` amber, `--vein` + `--vein-mask`, `--r-blob`, cell-shaped `--r-2`. `shell.css`: vein dividers on the top bar, footer and bottom bar; yolk nucleus, wavy yolk nav underline, yolk focus ring, countdown arc and mobile active tab; blob buttons and badges; new `.btn-primary`; art bloom in the spore's accent once pixels are shown (`SporeArtwork` sets `--accent`). `index.html` theme-color. Design §2, §3.1, §3.4, §13 and D5 updated | Contrast measured for every text token on `--bg`/`--surface`/`--surface-2` (lowest: `--text-3` 5.2 on `--surface-2`; `--line-strong` 3.6) and locked by a new test. viz 55/55 (1 new); build 88.5 kB gzip JS. Checked in Chrome at 1280 and 390 (bloom checked on a temporary injected frame, not a real render: no screen shows art yet) | Brand kit was still on the old `#090D12`/`#E8F0F2` (since fixed by the "brand wiring" row). S6 is the first screen where the bloom shows on real art |
| 2026-11-03 | brand wiring | `brand/build.py` reads `--bg`, `--text`, `--text-2`, `--text-3`, `--line`, `--slime` and `--pal-violet-accent` from `viz/src/ui/tokens.css` (no hardcoded colours), so the kit follows the slime theme: green-black base, warm ink, yolk `--slime` nucleus in the mark, favicon and wordmark (matching the top bar); `*-ink.svg` stay monochrome. Social card uses the new base and the app's art bloom in Spore #5's violet accent. New `brand/manifest.webmanifest` and `icon-192.png`; `build.sh` copies favicon, manifest, social card, 192/512 icons and the touch icon into `viz/public/`. `index.html`: manifest link, description, static `og:`/`twitter:` tags. New `viz/server/siteMeta.ts` Vite plugin adds absolute `og:image`/`twitter:image`/`og:url` only when `SITE_URL` is set. New `viz/test/brand.test.ts` (public copies byte-identical to `brand/`, favicon/manifest/theme-color on current tokens, linked files exist, SITE_URL tags) | viz 59/59 (4 new), `tsc -b` clean, build 88.5 kB gzip JS; `SITE_URL=https://spores.example vite build` wrote `og:image` `https://spores.example/social-card.png`, a plain build writes none (`dist/` rebuilt plain). Dev server served all six files with the right types; top bar checked in Chrome at 1280 | `SITE_URL` needs the real host once deployed. No commits made |
| 2026-11-03 | slime animation | User asked for animation and picked all four kinds offered: epoch pulse, blob interactions, veins growing in on load, and ambient streaming (the last knowingly against principle 3; logged as a deviation in §2 and §13 item 9). New `ui/VeinPulse.tsx` (`useRiseCount`: counts rises of `epoch_info.epoch`, ignoring the first value and falls; a bead runs both ways from the epoch clock), mounted in the top bar for live sources only. `shell.css`: `vein-grow`, `vein-stream` (shuttle, alternate, the three veins out of step), `nucleus-breathe`, `ooze-in` (tooltips, empty/error panels, tx rows), blob hover morph and press squash. Tokens `--t-pulse`, `--t-grow`, `--t-stream`, `--r-blob-2`. Reduced motion: one-shot durations 0, pulse not rendered, perpetual animations `none`. Design §2, §3.5 and §13 updated | 2 new tests (pulse only on a rise, restarts on each close, never under reduced motion). Built CSS 14.4 kB (4.17 kB gzip). In Chrome at 1280: the veins' grow and stream and the nucleus run; the pulse was checked by freezing an injected copy at 0.4 s, because router4 was stuck at E 26 "closing…" with nobody calling `close_epoch`; with reduced motion on, the computed animations are `none` and panel durations 0 s | The pulse hasn't been seen on a real close yet: check it during the next keeper run. A separate session was editing `viz/` (og meta, manifest, tests) at the same time; the test count (61) includes its tests |
| 2026-11-03 | design guide | New `docs/design-guide.md`: how to decide what the Design section doesn't say. Six questions in order (true? specimen leads? needed? existing token/component? works without colour and motion? budgets?), rules for colour by meaning, a motion trigger tree, shape by kind, type face, unknown values, layout, states and copy, an anti-pattern table, how to change tokens and rules (ask the user for look-level changes; contrast test; Design §13 + log), a finish checklist for UI sessions, and four worked examples. It holds no values; every fact points to a Design subsection. Linked from "Rules" and `CLAUDE.md` | Checked its claims against the spec and code: the hex grep in the checklist finds nothing outside `tokens.css` today | — |
| 2026-11-04 | S6 | Gallery at `/market` (`?view=all` or `listed`, `sort`, `f`, `pal` in the URL; source kept). New: `model/gallery.ts` (state reading per §1.5, `imageBadge`, LIVE and snapshot normalizers, sort/filter), `sources/gallery.ts` (LIVE: `epoch_info` → `nft_tokens` ×4 pages + `edges()` → `epoch_info`, reread if an epoch closed in between, 7 calls, no per-spore views; LOCAL RUN / RECORDED: last `snapshots/epoch-NNN.json`), `state/gallery.ts` (reload once per observed close; a failed refresh keeps the cards, marked `! as of`, beside an `ErrorState`), `components/StateMarker.tsx`, `components/SporeCard.tsx`, `components/gallery.css`, `pages/Market.tsx` (segmented `All · For sale (n)`, sort, filter chips with counts, `Rendering n / m`, roving focus, empty-filter and no-listing states; sim source says it has no spores). `SporeArtwork` reports `key`, `rendererVersion` and failures; `RenderQueue` results carry `rendererVersion`; `AppState.router`; `formatR`; token `--scrim`. **Team decision (asked this session):** LIVE cards show `◉ Activated` (bulk views have no policy; no `spore_summary` storm); Design §1.5, §6.B, §13 item 11 updated | Live router4 (stuck at E 26 "closing…", 64 active): 64 cards, all rendered; badges **6 `✓ image` (spores 16–21), 18 `◷ older commit`, 40 `○ no commit`**, identical to a CLI count from the raw views; a node check rendered spores 16, 17, 21 from `edges()` + `extra` and matched their commits. Spore 5 shows `◷ older commit` (commit epoch 17, state 26); the epoch-17 case is a test: its snapshot render input gives `ac15a3e9…` = the committed hash → `match`, agreeing with `spores-verify image … --spore 5` (that CLI was not rerun this session). Scrim contrast measured on 34 renders (10 vectors + 24 router4 spores) at the card's text rows: at 232 px with the shipped stops, worst pixel `--text` ≥ 7.4, `--text-2` ≥ 5.0, `--text-3` 3.1 (hence `--text-2` on art), violet epoch label 2.9 (1st percentile 6.0); at 173 px (mobile) name ≥ 7.4, wrapped badge line 4.3 (1st percentile 7.2). Chrome at 1440 (5 columns) and 390 (emulated; 2 columns, no overflow), keyboard focus ring + partner list, LOCAL RUN `phase6-s3-dense3` (full state set, filters/sort from the URL), no console errors. viz 79/79 (18 new; mutating the badge comparison fails 2), `tsc -b` clean, build 97.7 kB gzip JS (budget 180), no hex outside `tokens.css`. No Rust or `agents/` change, so cargo and agents gates not rerun | Not seen for real: a close during the session (router4 had no keeper running), so the reload-on-close and the art crossfade on new state are covered by tests only; a mismatch and a listed spore (none on router4; tests only); the View Transition morph (the detail page is S8, which must name its art `spore-art-<id>`). Not built: "Owned by me" chip (needs the wallet, S8), `/mine` (S8), `SporeIdentity` / `SporeRef` (first needed outside a card in S7–S9), the `thumb` cache. The violet epoch label is under 4.5:1 on single bright pixels; it repeats in the accessible name. No commits made |
| 2026-11-04 | slime type | User asked for slime-looking type ("expanding, some doodle"); options chosen: Gluten display, Shantell Sans for all interface text, mono unchanged, swell on real events only. `@fontsource-variable/gluten` 5.3.0 (latin `wght`, 49 kB) and `@fontsource-variable/shantell-sans` 5.3.0 (latin `full` with INFM/BNCE, 174 kB), both OFL-1.1, copied into `viz/public/fonts/` with `OFL-gluten.txt` / `OFL-shantell-sans.txt`; packages not dependencies. Geist Sans woff2 removed; Instrument Serif kept for `brand/build.py` only. `tokens.css`: new faces, `--font-serif` → `--font-display`, `--doodle` / `--doodle-loud`, display weight 500. Wordmark in Gluten, weight breathes 460 ↔ 560 with the nucleus. `useCloseSwell` (`ui/motion.ts`) + gallery card name swell / thin at a close that moved R. Preloads in `index.html` swapped. Design §2 principle 5, §3.2, §3.5, §13 item 12 and the design guide's type rules updated | viz 80/80 (1 new: swell only on epoch rise with changed R, direction, restart); `tsc -b` clean; build 97.8 kB gzip JS. Chrome at 1440 and 500 (Chrome's minimum window; 390 not reachable): fonts load (Gluten 100–900, Shantell 300–800, Geist Mono), gallery and top bar fit, no overflowing controls; swell forced by hand (slowed to 60 s) showed 760 / 320 weights; wordmark weight animating | A real close was not observed in this session, so the swell has not been seen on a live trigger. `brand/` wordmark, favicon and social card are still Instrument Serif (no Python env with fontTools here). README Libraries TODO must now list Gluten, Shantell Sans and Geist Mono instead of Instrument Serif/Geist. No commits made |
| 2026-11-04 | vein breathing | User asked for the divider to animate ("expand, shrink"). The three shell veins now breathe: `@property --vein-tile` / `--vein-swell` animated on `.topbar`, `.footer`, `.bottombar` (`vein-breathe`), read by the vein pseudo-elements (mask tiled from the centre at `--vein-tile`, `scaleY(--vein-swell)`) and by `.vein-pulse`, so the close bead stays on the tube. New token `--t-breathe: 6s`; wordmark and nucleus use it too (were a literal 6s). Reduced motion: the bars' animation is `none`. Design §3.5 (row, durations, reduced motion) and §13 item 9 updated, design guide's ambient count updated | viz 80/80, `tsc -b` clean, build CSS 20.6 kB (5.4 kB gzip), JS unchanged 97.8 kB gzip. Chrome (dev server, LIVE router4): values sampled over time 440–540 px / 0.75–1.6, footer out of step; frozen at both ends by screenshot (`out/vein-swollen.png`, `out/vein-thin.png`); reduced motion gives `none`, 480 px, 1 | Not seen together with a real epoch pulse (router4 still at E 26 with no keeper). No commits made |
| 2026-11-04 | S7 | Network explorer at `/network`, plus a step layer the user asked for ("every steps of the network can be visually shown"; Design §6.C, §3.5 rows "Step playback", "Live settlement", "Close sweep", §13 item 13). New: `docs/router4-closes.txt` (all 25 router4 closes, from the phase5-exit1/2 and phase6-s3-dense2/3 run logs) and its served copy `viz/public/closes/spores-hack-router4.testnet.txt`; `model/network.ts` (frames per epoch, diff at a close, ring geometry = `ring_pos`, `TubeIndex` grid hit testing on the curves, pan/zoom, tween with `--ease-grow`/`--ease-decay`); `model/steps.ts` (run log → wake/post/quote/hire/deliver/settle/reject/timeout/outside/commit/failed/close, linked by job id; flows and rejects per epoch); `sources/network.ts` (LIVE: bulk views, then each close tx archival-first with a localStorage cache, then core-wasm replay of every close; LOCAL RUN / RECORDED: snapshots + events + decisions); `state/network.ts` (`useNetwork`: progressive, follows the app's `epoch_info` poll: new flows between polls are live settlements, a rise is a close); `graph/draw.ts`, `graph/particles.ts`; components `NetworkGraph`, `EpochScrubber`, `NetworkInspector` (`EpochSummary`, `NodeDetails`, `NetworkEdgeDetails` + sparkline), `NetworkTable`, `LoopRail` + `StepFeed`, `indicators` (`ReputationIndicator`, `ConductivityIndicator`, `SporeRef`), `network.css`; `Router.admin()`; `tokens.ts` `motion.grow`/`pulse`. One `spore_summary` on a LIVE node selection (never polled) | `spores-verify epochs --router spores-hack-router4.testnet --closes docs/router4-closes.txt`: **25/25 epochs match**. In Chrome (LIVE router4, stuck at E 26): 25 closes read and cached, the in-browser replay of every close reproduces `edges()` (↻), every closed epoch `✓ Confirmed on chain · ↻ replay matches`; scrubber bars are the real flow counts. LOCAL RUN `phase6-s3-dense3`: ▶︎ played epochs 21→26 with every logged step (e.g. epoch 25: 30 posts, 60 quotes, 14 hires, 13 deliveries, 13 paid pairs, 6 rejects, 15 failed txs with the contract error verbatim), each close swept, tweened and announced ("Epoch 24 closed · 2 new tubes · 1 tube grew · 21 decayed · 3 dropped"); node and tube selection, Show change, table view; 1440 and 390 (emulated, touch: sheet peek → half on tap); reduced motion: play steps every 1.2 s with words only, 10 animation frames in 10 s, feed rows 0 s. Run-log paid pairs vs chain flows (dense3): epochs 21, 22 equal; 23/24 and 25/26 each differ by one pair placed across a close by log time (the inspector says so); epoch 20's 21 flows predate the run log. viz **104/104** (24 new: replay of the 25 real closes vs event tubes, fingerprints and tube counts, a tampered flow mismatches from that epoch on, ↻ vs edges(), hit testing, steps, rail counts, tween, reduced motion schedules no particle, page states, scrubber keys and hollow ticks, table selection, keyboard), `tsc -b` clean, build 120.7 kB gzip JS (budget 180), no hex outside `tokens.css`. No Rust or `agents/` change, so cargo and agents gates not rerun | Not seen for real: a live close and live settlements (router4 had no keeper; both covered by tests only); 60 fps with 2016 tubes (router4 has ≤ 30; not measured); pinch zoom on a real touch device. LIVE shows post/quote/hire/deliver as `—` (no indexer; `list_jobs` polling was considered and not built). A cold LIVE load reads 25 txs from the archival node (slow, then cached per browser). The art thumb in the inspector is the spore now, not the epoch on screen (said in the panel). Run frames without an active list draw every slot as a dormant dot behind the "No tube set" note. No commits made |
| 2026-11-04 | living map, step monitor | User asked for the ring to be "more flexible, limber, feels like tube expanding", for the log to be "more like the monitor" (then: "easy to watch visually, not a bunch of text components"), and could not scroll to the footer. **Map:** new `graph/flex.ts`: tubes are filled bodies that flare at the spores. A peristaltic wave reverses each `--t-stream`, widths breathe on `--t-breathe` rolling round the ring, curves sway ≤ 3.5 px, and the dish breathes. At a close, a tube that grew or was born swells in from both ends (`TweenTube.swell`). Beads and Show-change overlays follow the swayed curve; `draw.ts` lost the dash reveal (`curveLength`) because bodies reveal by range. `tokens.ts` `motion` gains `stream`/`breathe` (mirroring `--t-stream`/`--t-breathe`). **Monitor:** new `components/StepMonitor.tsx` replaces the inspector's text feed: lanes per step kind, ticks at run-log time, activity trace, yolk playhead while ▶︎ plays, one readout line (newest, or hovered), and a tally for chain rows (no time on chain). The text feed is behind "Show the log as text" and is always in the DOM for screen readers. `FeedRow.t`, `epochFeed()`; the feed is no longer capped at 40. **Footer:** ≥ md, `#root` is one 100dvh column on the Network page, so the footer sits in the frame. Design §3.5 (3 rows), §6.C, §13 item 14 and the design guide updated | Chrome at 1440 (dev server, LOCAL RUN `phase6-s3-dense3`): document 781 px = window, no scroll, footer 729–781; map repaints every frame (241 frames in 2 s, worst 17 ms) and pixels change; ▶︎ epoch 21: ticks land lane by lane behind the playhead, readout `+44 s #10 quoted 0.0681 NEAR · job 342`; reduced motion: 0 pixels changed over 1.5 s. viz 113/113 (9 new in `test/monitor.test.tsx`), `tsc -b` clean, build 123.1 kB gzip JS (budget 180), no hex outside `tokens.css` | Not checked: the close swell by eye at full speed (the tween runs, only tested in the model), 390 px mobile (the footer fix is ≥ md only; on mobile the footer is still below the map), 60 fps with 2016 tubes (dense3 has about 30), LIVE source. No Rust or `agents/` change, so cargo and agents gates not rerun. No commits made |
| 2026-11-04 | spore nodes, vein tubes | User: "I want the tube and the node is the spore (NFT) visually, and we can have idle motion as well". New `graph/nodeArt.ts` (`useNodeArt`: on-chain glyph first, then the renderer image of the spore's current seed, age and live tubes, the inspector thumb's input; priority 3; central half downscaled to 128 px). `NodeInfo` gains `art`/`glyph` (from `Network.tsx`), `NodeDraw` gains `art`. `draw.ts`: active nodes are the art in a disc `core + 4` px, accent ring (dashed if paused), breathing ±6% with a halo on the ring's rolling breath; tubes in three vein layers from palette stops 2/3/4. `NODE_HIT_PX` 10 → 14 to cover the disc. Legend: "node = the spore's art now · size = R". §3.5, §6.C and §13 item 14 updated | Chrome 1440, run phase6-s3-dense3: all 64 nodes got art (IndexedDB cache held 64 renders after the first visit); the first render pass showed mostly dark discs with the full image, so the node crops to the central half (no colour change). Zoomed ×3: nuclei and veins legible. Frames over 3 s at 120 Hz: median 8.3 ms, worst 9.4 ms. Motion "Reduce": 0 pixels changed over 3 s. Tests 114/114 (1 new: a node asks once per input at priority 3), `tsc` clean, build 124.2 kB gzip JS (budget 180), no hex outside tokens | On historical frames the node still shows the art now (as the inspector does), not the art at that epoch: the source has no per-epoch age. Not checked: mobile, LIVE source (glyph path), 2016 tubes with 3 layers each. No commits made |
| 2026-11-04 | whole-spore nodes, tubes from the art | User: "node + ring color is spore now, I want the spore as the visual and its tube is the tube, not just the spore inside the ring". `nodeArt.ts`: the whole 512 px art at 256 px, keyed (alpha from brightness, squared, × round fade), no crop. `model/network.ts`: `Curve` is now cubic (plain tubes keep their exact shape); `artReach` (the renderer's partner-disc radius), `slotDir`, `organismSide`, `artEnds`; `tubeCurve(…, ends)` starts a tube at the partner's disc in each art and pushes its handle along the vein; `TubeIndex` takes the same ends. `flex.ts`: cubic sway and tangent; `taper` starts a tube at the art's vein width instead of the flare. `draw.ts`: nodes are the keyed art drawn `screen`, no disc or ring, breathing in opacity; paused = 55% plus a dashed hairline; the ambient halo was dropped (64 of them made a coloured band along the ring); beads ride the same curves. Legend: "node = the spore's whole art now · size = R", "a tube leaves from its partner's disc in the art". §3.5, §6.C and §13 item 14 updated | Chrome 1440, run phase6-s3-dense3: the first try (handles straight along the vein) bowed tubes outward along the ring, so the vein push was added to the plain bowed handle instead; the first key (16–96, linear) left each image's bloom as haze, raised to 40–140 squared. Zoomed in: each tube ends on the partner's disc in the art and starts at the vein's width. Frames over 3 s at 120 Hz (steady): median 8.3 ms, p99 9.2 ms, worst 9.4 ms. Motion "Reduce": 0 pixels changed over 3 s. Tests 117/117 (3 new: `artReach` against the renderer formula, tube ends from the art, the taper), `tsc` clean, build 125.0 kB gzip JS (budget 180), no hex outside tokens | Organisms overlap their neighbours on a full ring (side 49–73 px against 20 px slot spacing at a 485 px canvas); readable at default zoom as a band of webs, detailed from about ×2. Short tubes between near neighbours can S-bend where the vein points away. Not checked: mobile, LIVE source (glyph path: tubes start at the art's discs around the glyph), selection and paused looks in the browser. No commits made |
| 2026-11-04 | legend for art nodes | User: "update legend". `Network.tsx` legend: "spore = its own art (the NFT) · size = R", "tube = the art's vein · width √D · brightness D", "dimmed, dashed outline = paused"; the ring row is gone (nodes have no ring). `network.css`: `.lg-node` is a keyed-spore swatch (radial gradient from `--text` through the aqua palette tokens to transparent), `.lg-tube` tapers at its left end like a tube leaving the vein; `.lg-ring` removed. §6.C legend line updated | Chrome 1440, run phase6-s3-dense3: legend open, rows read as above; the tube row wrapped to three lines at the first wording and was shortened. Tests 117/117, `tsc` clean | No commits made |
| 2026-11-04 | tube veins | User: "replace the divider animation with the tube animation of the network, I like the tube's one". New `ui/VeinTube.tsx`: a canvas on each shell edge (top bar, footer, bottom bar) fills the Network tube body (`fillTube`) in yolk layers, with the map's peristalsis and breathing; `BodyOpts.steps` lets a long tube sample every 6 px (default cap 48 unchanged for the map). `shell.css`: the masked pseudo-element veins, `vein-stream`, `vein-breathe` and the `@property` pair are gone; the canvas keeps the one-time `vein-grow`; the epoch-pulse bead is now a 4 px rounded band on the centre line (no mask, no swell). `--vein-mask` removed from `tokens.css`. §3.4 Veins and the §3.5 rows updated | `tsc -b` clean, viz 117/117. Chrome 1440 (dev server, LIVE router4): top bar and footer canvases paint (bottom bar 0 wide on desktop, skipped); full motion: frames change, rAF 121 fps; reduced motion: no change over 1 s; zoomed ×3 the wave bulges read along the tube (`out/vein-tube-zoom.png`, CSS-zoomed so soft). The browser's saved "Reduce motion" was set back afterwards | Not checked: mobile bottom bar, a real epoch pulse on the new bead. No commits made |
| 2026-11-04 | no motion toggle | User: "why are we having motion type? just give it motion". The footer's Motion select (Follow system / Reduce / Full) and its `spores.reducedMotion` localStorage key are gone; `useReducedMotion()` now returns the OS `prefers-reduced-motion` only, still mirrored on `<html data-reduced-motion>`. The footer keeps only its vein. §3.5 Reduced motion updated | `tsc -b` clean, viz 117/117. Chrome 1440 after reload (OS not reducing): `data-reduced-motion=false`, the veins move, no select in the footer | The OS setting is kept on purpose (§9 accessibility); a stale `spores.reducedMotion` key in a browser is now ignored. No commits made |
| 2026-11-04 | S8 | **VERIFY** (`docs/verify-notes.md` "Phase 6 S8"): NEAR's docs now use `@hot-labs/near-connect` (0.12.0, MIT, no runtime deps; added with `--save-exact`), not wallet-selector; testnet wallets come from its manifest filtered by `features.testnet`. New: `chain/wallet.ts` (connector loaded on first wallet use or to restore an earlier session; `connectorTx`, `hashOf`, `isWrongNetwork`), `state/wallet.tsx` (`WalletProvider`, `useWallet`; closing the picker is not an error), `model/tx.ts` (the `TxAction` machine: ok only from pending + a final outcome read by the app with `tx` wait_until FINAL; `outcomeOf` quotes the panic without NEAR's prefix; `withdraw_failed` counts as failed), `model/actions.ts` (`canAct(action, holding, wallet, life)` with the router's own refusal strings, `actionBar` per §6.D.1, exact `parseNear`/`nearText`, `isAccountId`), `model/spore.ts` (`SporeView` from `spore_summary` + `nft_token`, or a snapshot), `state/spore.ts` (`useSpore`: read on load, at each close and after a confirmed tx; `useConfig` once per router), `ui/ConfirmationDialog.tsx` (focus trap, Escape, inert background, not closable while busy), `components/TxAction.tsx` (method, args, deposit, gas and consequences; pushes to the tray; "Check again" when the outcome can't be read), `components/ownerActions.tsx` (activate, set_policy, pause, register_operator, deposit, withdraw, list, delist, buy; List and Buy show the `nft_payout` split), `components/economy.tsx` (`BalanceDisplay`, `AllowanceDisplay`, `AgentStatus`), `pages/SporeDetail.tsx` + `components/detail.css`, `pages/MySpores.tsx` (`Router.idsOwnedBy`, paged `nft_tokens_for_owner`), real `WalletStatus` (connect, connecting, account menu, wrong network). Marketplace `view=listed` uses the `listing` card with Buy; "Owned by me" chip; `useGallery` keeps the last LIVE read per router so Spore pages and My Spores don't reread the collection; Network reads `?sel=` once. Design §12, §13 item 15 | Chrome 1440 against live router4 (E 26, "closing…", no keeper): `/spore/5` shows R 0.50, balance 0.1147 NEAR, allowance left 0.1994 of 0.1994 NEAR, 2 tubes (#1 D 0.07 54% of R, #18 D 0.05 46%), operator2 gen 3, 1 sale, 1 transfer, the caption `◷ the commit is for epoch 17; the state is epoch 26`; Connect wallet loaded near-connect and listed Meteor, Intear, Ledger, Nightly, Ethereum Wallets and NEAR CLI; closing it left no error. 390 (emulated, touch): no horizontal overflow, art then identity. LOCAL RUN `phase6-s3-dense3` `/spore/40`: snapshot values, the run-only gaps as `—` with reasons, "Owner actions sign on the live router". No console errors. viz **148/148** (31 new in `test/actions.test.tsx`: machine never ok before a final outcome, busy can't close or restart, panic text verbatim, `withdraw_failed`, UNKNOWN_TRANSACTION retried and nothing else, `canAct` refusals, the §6.D.1 bar per state, NEAR parsing, list flow with exact args, deposit text, payout split, pending → confirmed with the explorer link and a reread, contract failure and wallet cancel, unpause through set_policy, Buy consequences and args, seller can't buy, My Spores states, disconnect, wrong network, connect error), `tsc -b` clean, build **140.6 kB gzip** initial JS (budget 180; was 125.0) plus the wallet chunk 15.0 kB gzip loaded on demand, no hex outside `tokens.css`. No Rust or `agents/` change, so cargo and agents gates not rerun | **Not done: the manual testnet check** (list then delist one router4 spore from a wallet, explorer links here). It needs a wallet holding a full-access key of an owner (`deployer` owns 9–63, `buyer` owns 5), which only the team can set up; no wallet tx was signed in this session. Not built (shown as `—` with the reason): epoch compare (stretch), the Activity block (S9), Verify for older commits (S10), the last sale (S9). Not seen for real: a confirmed tx, a contract refusal or the pending spinner in a real wallet (tests only); a live close reloading the page. No commits made |
| 2026-11-05 | S9 | New: `model/decisions.ts` (`recompute` with `@rules`, mirroring `sim/src/replay.rs`; `decisionSummary`, `ruleCaption`, `tubeCheck`), `model/receipts.ts` (`receiptFromTx`, one shape per §6.G kind, `spore_sold` beats the refunds a sale also logs), `model/activity.ts` (`buildActivity`: every log line becomes a row, a timeline step or a merged note; filters; groups; pure `windowRows`), `sources/activity.ts` (tolerant `loadRunActivity`, `fetchReceipt`: archival first, receiver must be the run's router, localStorage cache), `state/activity.ts` (`useActivity`: LOCAL RUN polls every 5 s until `report.json` exists; `useReceiptStore`), `components/EventFeed.tsx` (`EventFeed` windowed against page scroll, no library; `CompactFeed`), `DecisionEntry.tsx`, `JobTimeline.tsx`, `TransactionReceipt.tsx`, `activity.css`, `pages/Activity.tsx`. Spore page: Activity block and last sale from the run log. `linkTo`, `fetchOldTx`, `formatD` moved to shared modules. Fixtures: `viz/test/fixtures/phase5-exit2/` (the real logs, edges from the snapshots, the sale, 11 real tx outcomes from the archival node). Design §5.1, §6.E, §12, §13 item 16 | **Done-when met:** all 95 phase5-exit2 decisions recompute to matches in the viz test, and `spores-sim replay-decisions` says `95 match, 0 differ`; the page shows `↻ 123 / 123` on phase6-s3-dense3, and the CLI says `123 match, 0 differ`. Filters are tested; malformed lines become rows naming file and line and pass every filter. viz **215/215** (67 new), 6 mutations of S9 logic and 1 of the Network fix each fail tests. `tsc -b` clean, build **155.3 kB gzip** initial JS (budget 180; was 140.6), no hex outside `tokens.css`, agents tests pass; no Rust change, so cargo gates not rerun. Chrome 1440 and 390 (emulated, touch) on real logs: 474 rows with 23–45 in the DOM, sticky headers under the bar, no horizontal overflow, the filter sheet, keyboard focus ring, no console errors. **A real Fetch** from the archival node (8 s) turned `○ Logged · ≈ Epoch 11` into `✓ Confirmed · job_settled · Epoch 12`, fee 0.001 NEAR, block 275877206, signer operator.spores-hack.testnet. LIVE on router4: only Closes enabled, close rows Confirmed, `Fetching close 17 / 25` after about 90 s uncached through the rate-limited archival node. **Bug found and fixed, from S8:** the Network's "new source" effect also ran on mount and wiped `?sel=`, so S8's `tube →` links never opened with the tube selected, though the S8 log says they did (its test covered only `parseSelection`); fixed, with two page tests. **Findings in the data:** log-timed epochs can be off by one at a close (above, also `≈` on close-row flow counts). Tube check: phase5-exit1 97/97, phase5-exit2 95/95, phase4-exit1 41/41 (a script over the snapshots; the viz test covers exit2), phase6-s3-dense3 117/123: the 6 show `↻ differ`, e.g. job 331 logged D 62040 against 82719 after the epoch 20 close. 62040 is 75% of 82719, one 25% decay, which suggests the agent read `edges` after the next close while still labelling the decision epoch 21; that cause is inferred, not traced | Not seen for real: the settlement slide-in on a growing log (tests only: no run was in progress), a RECORDED bundle (tests only, S13 makes the first), a chain outcome contradicting a log (test only, none exists), OS-level reduced motion (the duration tokens were forced to 0 in the page, not by the OS setting). `/verify` is still the S10 placeholder, so `Verify →` lands on "Not built yet". Close time on LIVE is `—`: the event has no timestamp. Not built: `SporeRef` hover preview. No wallet tx was signed; the S8 manual testnet check is still open. No commits made |
| 2026-11-05 | Activity redesign | User: the page is "dense and textful", then "ok" to rebuilding it round the hire, then "make the bar as a tube". New: `components/QuoteTube.tsx` (`paintQuoteTube`, a still canvas per quote), `components/HireRow.tsx`; `JobRail` and `RowWord` in `JobTimeline.tsx`; `hireBars`, `hireVerb`, `tubeBeatCheaper` in `model/decisions.ts`; `jobRail`, `parseView`, `writeView`, the `tube` filter, `stats.tubeWins/maxQuote/maxD` in `model/activity.ts`. `VEIN`, `stopOf`, `rgba` moved from `graph/draw.ts` to `graph/flex.ts`, so Activity doesn't pull in the map's renderer. `readDecision` refuses a candidate with an unreadable number. `DecisionEntry` puts the numbers, the txs and the raw line behind `<details>`. Design §3.1.3, §5.1, §6.E, §13 item 17 | **Done-when of S9 still met:** 95/95 recompute in the viz and `spores-sim replay-decisions` says `95 match, 0 differ`; `↻ 123 / 123` on phase6-s3-dense3; bad lines stay rows and show in both views. viz **234/234**, agents 20/20, `tsc -b` clean, initial JS 159.5 kB gzip (budget 180), no hex outside tokens. 14 mutations each fail a test (one first slipped through: a URL with a `kind` and no `view` fell out of the log on clearing it; test added). A first mutation run was killed mid-way and left a mutation in `parseView`; caught by tests, restored, and later runs back up and diff. Chrome at 1440 and 390: no overflow; all 123 dense3 rows appear on scroll, no console errors. **Figures:** a tube beat a cheaper quote in 25 of 95 decisions on phase5-exit2, only 8 of 123 on phase6-s3-dense3. | Not seen for real: a settled decision sliding in on a growing log (test only), RECORDED in Chrome, OS-level reduced motion. Tubes are still, not living like the map's. On mobile the key takes four lines. No commits. |
| 2026-11-05 | S10 | New: `model/verify.ts` (row comparison as in `verify/src/main.rs`, gap rules, verdicts, summary text, failure reasons), `sources/verify.ts` (`loadCloseHashes`, `fetchCloseTx`, `closeFromTx`, `verifyImage`, `runVerification`), `state/verify.tsx` (`VerifyProvider` above the routes, so a run survives navigation; memory only), `components/VerificationResult.tsx`, `verify.css`, `pages/Verify.tsx`. `RenderQueue.request(…, {fresh})` skips the cache read and the dedupe. `Rpc.archivalUrls` (`ARCHIVAL_RPCS`: FastNEAR's archival, then near.org's) replaces `Rpc.archival`. Links: close rows show `Verify →` or that epoch's verdict; the Spore page's Technical block has the button, then the verdict and Details; close and image receipts link to `/verify`. **VERIFY** in `docs/verify-notes.md` "Phase 6 S10". Design §5.1, §12, §13 item 18 | **Done-when met.** In Chrome against live router4 with `docs/phase5-closes.txt` swapped in for the close list: `✓ Match · 16/16 epochs · image matches commit` in 8 s, head not compared (router at 26), no console errors. `spores-verify image` on the same file, archival only: `verified 16 epochs … match`, `image: match`, exit 0, 2 min 15 s; the same state hash `d09c9957…` and image hash `ac15a3e9…`, age 16, 4 tubes, and its 16 fingerprints equal the fixture's events, which the test replays to Match. Tampered event → Mismatch, missing epoch → Unable: tests, and once in Chrome by rewriting real responses (epoch 7's fingerprint changed, epoch 13 removed: 11 Match, 1 Mismatch, 13 Unable, image Unable). Real list in Chrome: **25/25 Match, head Match, image Match**, in 11 s (a later run, 23 s). LOCAL RUN `phase6-s3-dense3` with spore 18: list + log (25 + 6 hashes), both badges, 25/25, the epoch 26 commit matches, 46 s. Spore page button → `✓ Match · 25/25 epochs · image matches commit`, then `✓ Match →` on close rows in Activity after in-app navigation. 390 emulated: no horizontal overflow, 40 px row toggles. viz **287/287** (53 new in `test/verify.test.tsx`, on the 25 real closes with the real Rpc, Router, core-wasm and renderer), 23 of 23 mutations of S10 logic each fail tests. `tsc -b` clean, build **167.15 kB gzip** initial JS (budget 180; 12 kB left), no hex outside `tokens.css`. No Rust or `agents/` change, so cargo and agents gates not rerun | **Found in real use, not by tests:** a duplicate React key (fixed; the page test now fails on any `console.error`), hidden captions on the art (fixed), and that "archival rate limit" can't fire for a 429 a browser can't read (fixed: see Design §13 item 18). **Open, for the team:** (1) `spores-verify` with its default endpoints now takes minutes per old tx, because FastNEAR times out at 30 s for 5 tries before it moves on: my first run had printed nothing after about 7 minutes and was killed. The README's two commands use those defaults, so they need `NEAR_RPCS=https://archival-rpc.testnet.near.org` or a change to the default order (Phase 7; not changed here). (2) `spores-verify` over all 25 closes did **not** finish this session: rate-limited by both archival nodes (exit 2, no verdict), after my repeated runs. The S7 log has its earlier 25/25. (3) FastNEAR's archival endpoint is not in NEAR's provider table, which lists its testnet archival as "Paid Only", and it works without a key today; near.org's calls itself deprecated when it limits. If both go, Verify shows Unable; there is no third source. Heavy use from one address hits the limits: runs were fine at this rate, but a judge's page reload resets nothing on the node. Not seen for real: a RECORDED bundle (test only, S13 makes the first), a real chain mismatch (only rewritten responses; none exists), OS-level reduced motion, a run during a live close (no keeper is running), a walk through the page by keyboard alone (the controls are native links, buttons and an input). No wallet tx was signed; the S8 manual testnet check is still open. No commits made |
| 2026-11-05 | S10 follow-up | Team said yes to changing the CLI's defaults and to relying on FastNEAR's archival node. `verify/src/main.rs`: close txs read archival first (`NEAR_ARCHIVAL_RPCS`, new; default FastNEAR's, then near.org's), views regular first (`NEAR_RPCS`, default FastNEAR, dRPC), each falling back to the other; a curl timeout moves to the next endpoint at once; a failure names what every endpoint said. **Deviation:** `NEAR_RPCS` no longer stops the CLI using archival nodes, because `scripts/phase6-testnet.sh` sets it to regular nodes and `run.ts` runs verify under that, which would have failed on old closes. README commands unchanged and now work as written: 16 closes 21 s, image 17 s; all 25 closes 22 s and 77 s, exit 0 (`match`); with the script's `NEAR_RPCS` 66 s, exit 0; archival unreachable, exit 2 in 71 s. Not rerun: an actual exit run. `cargo test -p spores-verify` 8/8, clippy clean; other crates and `viz/` untouched. Numbers in `docs/verify-notes.md` "Phase 6 S10". |
| 2026-11-06 | S11 | **New, agents:** `src/scenes/rogue.ts` (`runRogue` on a `SceneChain` interface; owner narrows the policy, 3 refused attempts plus one allowed payment, 2 quiet closes, refunds at the deadline, policy always restored; `--reset` for a dead run), `src/scene-server.ts` (`node:http`, binds 127.0.0.1, refuses any peer, Host or Origin that isn't loopback, so another site can't make it sign; each run is a child process; the UI's verdict needs the server's `exit` line), `src/record-scene.ts` (refuses a failed run or any secret; adds the run's closes to the close lists), `test/scenes.test.ts`. **New, viz:** `model/scene.ts` (pure `buildScene` over log lines, `narrate`, `verdictOf`, pacing), `sources/scene.ts`, `state/scene.ts` (`usePlayback`, `useLiveRun`, `useSceneServer`), `graph/stage.ts`, `components/SceneStage.tsx`, `SceneLanes.tsx`, `DecayStrip.tsx`, `lab.css`, `pages/DemoLab.tsx`, `pages/RogueScene.tsx` (both lazy), `test/lab.test.tsx`, `test/fixtures/rogue/`. Design §6.H, §3.5, §12, §13 item 19 | **Done-when met.** Real run `rogue-2026-11-06T02-04-56-137Z` on router4 through the scene server: exit 0, 8/8 checks, 175 s, spore #0, provider #31. Refused, read back with `tx` over RPC outside the app, with the operator as signer: `E3s92QQ…` `policy: payment exceeds the per-payment cap`, `Fat7jVV…` `policy: epoch budget exceeded`, `918spGj…` `policy: payee is not on the external allowlist`. Allowed: `95uP1GN…` 0.02 NEAR, refunded at its deadline. Decay: R 1.30 → 1.13 → 0.78; D #2 137,063 → 102,798 → 77,099; #55 67,577 → 50,683 → removed. Balance 1.2787 NEAR before and after (2 stale jobs were cleared first), policy restored and confirmed by a separate view. Bundle in `viz/public/recorded/`. Closes 26 and 27 added to `docs/router4-closes.txt`: `spores-verify epochs` matches **all 27**, exit 0 in 25 s. **Understanding:** first refusal 8 s after the recording starts, whole story 39 s. viz **327/327**, agents **41/41**, `tsc -b` clean, initial JS **167.71 kB gzip** (budget 180; was 167.15; the Lab is lazy, 18 kB), no hex in `lab.css`. Mutations: 19 of 21 killed at first; one survivor was a weak test (two POSTs never overlapped; fixed, now killed), one was dead logic (removed); 2 more on the HTML fix killed. No Rust changed, so cargo gates not rerun (`spores-verify` was only run). Chrome 1440×727, 1440×800 and 390 emulated, recording and LIVE: all beats seen, no console errors, no horizontal overflow; reduced motion (forced through `matchMedia`, not the OS setting): one frame change when art arrived, then identical. **Found in real use, not by tests:** the dish fell off the fold (layout rebuilt); my strip copy said the art "withers" but the real N+2 render is more elaborate, so the claim was removed; `.verdict` and `.check` collided with other stylesheets (renamed), which widened the phone layout to 446 px; **a bug from S9:** a static host answers a missing file with `index.html` and 200, so any RECORDED bundle without `report.json` failed in Activity and a missing `scene.jsonl` would have parsed as garbage; `RunFiles`, `listRecorded` and `recordedManifest` now treat HTML as 404; **from S4:** the RECORDED banner split its sentence into columns on a phone (flex; now block). | **A live run costs the network:** 2 closes decay every spore's tubes by about 44%. Router4 is at epoch 28 with 20 tubes (29 before), and a run needs a spore with 2 tubes that outlast 2 closes; `scripts/phase6-testnet.sh` regrows them. **The browser's SSE path was seen with the real server and a child replaying the real log, not a second chain run**, to avoid spending 2 more closes; the chain path ran through the same server with `curl`. So **Run was not clicked against testnet in a browser**, and neither Reset nor a dropped connection was seen for real (tests only). A live run that isn't recorded leaves the close list behind, so LIVE Network and Verify would show a gap until its hashes are added. The recording's `events.jsonl` has no `closed`/`fingerprint` on its close lines (added to the script after this run), so give `spores-verify` the close list, not that file. Network and Market on a scene bundle show the honest "no snapshots" error with a link to LIVE; Verify on one was not tried. No keyboard-only walk (controls are native links and buttons). Mobile stage hides the long attacker name and the gate stamps (both remain below). Not built: `scripts/demo.sh` (S13), so the copy names `node agents/src/scene-server.ts`. **Security note:** a `grep` of mine printed truncated `ROUTER_PRIVATE_KEY` and `ROUTER_V0_PRIVATE_KEY` from `.env` into the session transcript (old testnet router accounts); reported to the user. No commits made |
| 2026-11-06 | S12 | **New, agents:** `src/scenes/sale.ts` (`runSale` on a `SaleChain` interface, the one implementation for the scene and `run.ts`'s `sale@N`; 11 checks; payouts from `EXPERIMENTAL_tx_status` receipts; state from the blocks either side of the buy; `sellBack` for Reset, with its txs kept in the run's `reset.jsonl`), `saleScene()` in `scene-server.ts`, which now also runs one scene at a time (they share accounts and nonces). `run.ts` calls `runSale` with hooks for stopping and restarting real agents. **New, sim:** `spores-sim wash` (`report::wash`, Reference D); no core change, vectors unchanged. **New, viz:** `model/sale.ts`, `components/SaleStage.tsx`, `pages/SaleScene.tsx`, `model/wash.ts`, `components/WashChart.tsx`, `WashLoop.tsx`, `pages/WashScene.tsx`, `components/SceneChrome.tsx` (out of `RogueScene`: `ActRail`, `PaceSwitch`, `Checks`, `Preconditions`, `timelineSteps`), `washData` in `sources/recorded.ts`, generic `usePlayback`/`useLiveRun`, `test/sale.test.tsx`, `test/wash.test.tsx`, `test/fixtures/sale/`, `public/recorded/sim/`. Design §3.5, §6.H, §12, §13 item 20, Reference D | **Done-when met.** Real run `sale-2026-11-06T04-37-53-129Z` on router4 through the scene server: exit 0, **11/11 checks**, 58 s, spore #2 (4 tubes), price 0.5 NEAR. Read back with `tx` over RPC outside the app: buy `4hBHtzrZTj8i…` signed by buyer, ok; old key `GAoNeHcAdn7a…` signed by operator, `caller is not this spore's operator`; old owner `GBJDkgEN6cDN…` signed by owner, `only the spore owner can do this`; new agent `2RLXMBaXobNd…` signed by operator2, ok. Payouts from receipts: 0.475 to the seller, 0.025 to the royalty account (the admin). Before and after: balance 0.5044 NEAR, 4 tubes, age 27, R 1.37, unchanged. Bundle in `viz/public/recorded/`. **Wash:** the committed copy matches the reports by test, line by line: 16×3 270/270, 64×3 270/270, 16×1 255/270, **64×1 168/270**, attacker loses money in 270/270 everywhere, worst net −0.0010; Phase 1 gate 270/270 and 355/361, §9 literal 177/270, the 93 failures all ≤ 0.05 NEAR with rep ratio up to 12.12, the 6 out-of-range failures at K=0.5, loop 5, 3 spores. **Understanding:** the sale lands 7 s into the recording, whole story 29 s (real 58 s). **The browser path S11 left open was run for real, for this scene:** Run clicked on LIVE, `sale-2026-11-06T05-06-03-054Z`, 11/11 over SSE, the three receipts turned `✓ Confirmed on chain`, then Reset clicked: `DipAGqNN…` list, `EF3Uid5p…` buy, `8tb2LjMt…` register, `3BbGy22P…` set_policy; spore #2 is back with owner and operator, policy restored, no job left, balance and tubes unchanged, sales 4. viz **383/383**, agents **55/55**, cargo **106/106**, clippy 0 warnings, `tsc -b` clean, initial JS **167.87 kB gzip** (budget 180; was 167.71; Sale 8.66 and Wash 7.13 kB lazy), no hex in `lab.css`. Mutations: 21, 16 killed at first; the 5 survivors were test gaps (a refusal in other words, the check-9 name guard, seed sides that this data can't tell apart), closed and killed. Chrome 1440×800 and 390 emulated, recording, LIVE and Wash: every beat seen, no console errors, no horizontal overflow; reduced motion (forced through `matchMedia`, not the OS setting): frozen canvas, no running animation, all information still there. Keyboard: a real Tab reaches the wash slider with the 2 px `--slime` ring, and an arrow key changes the case (the ring is explicit, since the slider's `appearance: none` styling is custom); the Sale page's keyboard path was not walked. Dataviz validator on `--warn`, `--text-2` over `--surface`: CVD ΔE 8.7, normal vision ΔE 19.7, contrast PASS; lightness band and chroma floor FAIL, because the honest line is a neutral on purpose (Design §6.H); dash patterns and head labels carry identity. **Found in real use, not by tests:** the buyer's margin was wrong (NEAR charges 100 Tgas up front, about 0.101 NEAR): the first real run `sale-2026-11-06T04-36-24-917Z` failed with `NotEnoughBalance` as a failed step, delisted itself and left nothing to reset, which also proved that path for real; margin now 0.12. The idle LIVE stage drew a key line for an agent it hadn't read, while the spore really was with operator2; Reset was hidden in the closed proof; the finished run stayed on stage after a Reset; the phone rules sat before the base rules and overflowed to 468 px; moving the narrator on phones first hid Rogue's, because named grid areas beat `order`; the start line has no tubes, so the first look was an empty dish | **Not built:** the `scenes/wash.ts` testnet stretch (first in Cut order); the panel says so. **`run.ts`'s `sale@N` now goes through `runSale` and has not been run on testnet since the move**, only unit tests on a fake chain; `scripts/phase5-testnet.sh` would be the check, and it costs 8 closes. **Funding:** the buyer needs price + 0.12 NEAR and a run with its Reset costs each side about 0.027 NEAR, the royalties going to the admin; moved 0.3 owner → buyer and 0.2 deployer → buyer. Now owner 0.4194, buyer 0.7448, deployer 0.9055, operator2 0.0832. At about 0.027 NEAR lost per round trip per side (measured over the two rounds), the buyer is the limit: the 0.62 NEAR precondition holds for about 4 more runs before it needs a top-up. **Cosmetic, for the team:** the price (0.50 NEAR) is about what the spore holds (0.5044 NEAR), since the buyer's funds capped it, so a sharp viewer may notice the buyer got its money back; a re-record with a richer buyer or a poorer spore would fix it. **Not seen for real:** a dropped SSE connection or a failing Reset (tests only), the OS-level reduced-motion setting, Rogue's Run in a browser (S11's gap stays open for that scene). D labels can touch a partner's art at the top of the dish, as on Rogue. **Tooling slip:** a cleanup `pkill -f vite` of mine matched more than my own dev server; a dev server on 5199 from another session (if it was still up) and the browser and IDE connections went down at that moment, the cause not proven. Nothing in the repo or on chain was affected. No commits made |
| 2026-11-06 | S13 | **New, agents:** `demo-prep.ts` (picks the spores and the hero, refills from the faucet accounts, tops up, clears the run's expired jobs), `demo-watch.ts` (stages in the terminal, with "you should see"), `record-bundle.ts`, `test/demo.test.ts`. **Changed:** `run.ts` (`sale_spore` picked at the start and named in `run.json`, only the seller's spore, the sale's lines in `scene.jsonl`, stops its children on a signal, verify also reads the committed close list so a clean checkout works; check "tubes formed" now asks whether a tube between the run's spores was born or grew, **replacing** the router-wide count, which fails on a router with older tubes elsewhere); `keeper.ts` (timeouts and commits sent EXECUTED_OPTIMISTIC, none starts within 8 s of an epoch's end, the run's own jobs first); `near.ts` (per-call wait). **New, scripts:** `demo.sh`, `record-bundle.sh`. **New, viz:** `model/loop.ts`, `sources/loop.ts`, `state/loop.ts`, `components/LoopStage.tsx`, `LoopVein.tsx`, `pages/LoopScene.tsx`, `test/loop.test.tsx`, `test/fixtures/loop/` (the final run's logs); `usePlayback` gets `follow`; `snapshots/start.json` is now a served run file; `Verify` says `! Unable` when the chain can't be read; `tubesText`; `/lab` gets the wide card, the Overview placeholder links to `/lab/loop`. Design §3.5, §5.1, §6.H, §12, §13 item 21, Reference C | **Done-when, from a clean copy** (`rsync` without `.git`, `node_modules`, `target`, `out`, `dist`, `viz/public/wasm`; `.env` copied, deleted afterwards): `bash scripts/demo.sh --no-open --exit-at-end`, exit 0, **14/14 checks**, closes 37, 41, 31, 47, 35, 46, 39, 30 s (mean 38; three over 40, so "~30–40 s" is close, not strict), run `demo-20261106T101440Z`, recorded and committed. Real output, stages: `00:06 ✓ Wake 12 agents started. Spore #6 is the one to watch` / `00:12 ✓ Close epoch 55 closed tx CERb87BZ…` / `01:18 ✓ Hire #6 hired #11 at 0.171 NEAR from 1 quote tx 44wpNL7U…` / `01:18 ✓ Settle #6 paid #11 0.171 NEAR tx 22f1zQn7…` / `01:34 ✓ Grow tube #6–#11: D 0 → 473,807` / `01:34 ✓ Reputation R 0.85 → 1.42, may spend 0.270 NEAR → 0.384 NEAR an epoch` / `01:34 ✓ Art redrawn from 3 tubes at age 57` / `03:09 ✓ Sell #6 sold to buyer.spores-hack.testnet for 0.500 NEAR tx HZNJeWxy…` / `04:21 ✓ Control old key refused (caller is not this spore's operator); the buyer’s agent sent pay_service tx 8qDUF9Ev…` / `11:43 ✓ Closes 9 closes` / `11:43 ✓ Report 14 of 14 checks passed` / `spores-verify epochs … verified 63 epochs on spores-hack-router4.testnet: match` / `spores-verify image … --spore 6 … image: match`. `--playback`, with outbound network denied by `sandbox-exec` (a `curl` to RPC under the same profile failed, exit 7): starts in 2 s, exit 0. In Chrome with non-loopback `fetch` rejected: the story plays to its verdict with **no external request**; Verify says `! Unable. Nothing was checked` naming the endpoint. With the network: **`✓ Match · 63/63 epochs · image matches commit`** in 99 s from the recording. **Understanding:** Art stop at 23.1 s, sold at 30.6 s, whole story 47.2 s on the committed recording, with the eight stops readable from the first frame. viz **437/437** (six clean runs in a row), agents **77/77**, `tsc -b` clean, initial JS **168.47 kB gzip** (budget 180), LoopScene 8.7 kB lazy, no hex in `lab.css`. No Rust changed, so cargo gates not rerun (the clean copy built them all and passed the wasm vector checks). Mutations: 25, 21 killed at first; 3 were test gaps, now killed; 1 was my mutation's syntax error, redone and killed. Chrome 1440×800 and 390 emulated: every beat seen including 3 quotes (run 1), no console errors on a recording, no overflow; reduced motion (forced through `matchMedia`, not the OS setting): frames identical, no running animation, all information there; Tab focus shows the 2 px ring. **Five real runs, all kept in `out/agents/`, all closes in the lists:** `090134Z` 13/14, closes 66–92 s, the old tubes check; `091643Z` 14/14, 29–45 s; `093353Z` 14/14, no settled hire before its sale; `095213Z` 13/14 (new agent had no time, 28 s, fixed by 9 closes); `101440Z` above. **Found by running it, not by tests:** keeper timeouts pushed closes to 66–92 s; 185 expired jobs on the router meant `post_job: too many unfinished jobs` on 63 of the run's posts, 0–6 once cleared; the watcher read the tube at the wrong close (`D 0 → 0`, fixed, the page was right); fewest-tubes heroes can't afford quotes (tried, measured, reverted); `✓ kept` next to a value read after later closes; partners struck through as if they had lost a quote; `LIVE testnet ·` with no router; the narrator's line length moved the stops. | **Costs the network:** each real run really sells one spore: spores 1, 2, 3, 4, 5, 6 are now with the buyer, run by operator2. The seller holds 0, 7, 8 among the first 12, so `demo.sh` has about three runs left before it exits with its own message; **sell some back or pick another seller before Phase 7.** Router4 is at epoch 64 with 4 tubes, so the Rogue scene's precondition (2 tubes that outlast 2 closes) likely fails until a run regrows them; not re-checked. `spores-hack-fund6-2` has 6.35 NEAR left, about 1 NEAR per run. **Deviations from Do:** `renders/*.png` stay out of the bundle (about 60 MB; the app redraws them from the snapshots with the same wasm), the scene server starts after the run, not with it (they share accounts and nonces), `npm ci` is skipped when the lockfile hasn't moved (playback must start offline), playback is the story page rather than the Network scrubber (Design §13 item 21), default 9 closes. **Not seen for real:** the final bundle on Network, Market, Activity and Spore (seen on the trial bundle of the same format, then removed); `open` launching a browser and the keep-alive end of `demo.sh` with the scene server (all runs used `--no-open --exit-at-end`); a static host (`vite preview` or real hosting); the OS reduced-motion setting; a browser with the OS network really off (fetch blocked in the page, sandbox on the server); a walk through by keyboard alone; README steps, because the README has no such steps yet (S14). One full viz run had 2 failures whose names I didn't capture, right after a build; one later was the shell test's 8 s lazy-load limit, now raised. A hero agent in `095213Z` sent nothing from 09:52:57 to its sale, cause not traced. No wallet tx signed. No commits made. |
| 2026-11-07 | S14 | **New, viz:** `pages/Overview.tsx`, `pages/overview.css`, `components/OverviewPlate.tsx` (lazy), `components/HandArrow.tsx`, `model/overview.ts` (health, frame, featured, idle), `model/plate.ts` (`overviewDelay`, `plateTarget`, `noteWorthy`, `deepLink`), `test/overview.test.tsx`, `public/robots.txt`. **Changed:** `LoopVein` gets `across` and `deepLink`; `LoopStage` exports `stageAngles`, `loopCast`, `share`; `usePlayback` gets `seekEnd` and `landOnLine`, and `/lab/loop` uses `landOnLine` too, so a paused story shows what the clicked stop says; `NetworkGraph` `compactLabel`; `graph/draw.ts` `slotLabels` and `DENSE_TUBES`; `Network` reads `?view=table`; `SceneClient.list` doesn't knock from a non-loopback page (`canReachFrom`), because the scene server refuses those pages anyway; `a.btn` centred without an underline, globally. Design §3.5, §6.A, §10, §12, §13 item 22; README Try it, Verify, Status, Demo; ROADMAP. **First-30-seconds design:** a plate of one real spore's life, a pen arrow to what the words are about, the eight stops as a timeline across the page, the live collection below it (§13 item 22). | **Gates:** viz **459/459**, agents **77/77**, `cargo test --workspace` 106 passed, 0 failed, clippy 0 warnings, `tsc -b` clean. **Timing on the production build, one reload with the art cached, seen in Chrome:** first note 0.7 s, Art line 17.0 s, `Sold` 22.1 s, last line 32.5 s, from navigation start. That is 2.5 s over the 30 s asked for; the idea is on screen from the first frame and the sale lands well inside it, and I kept the over-run rather than shorten what has to be read. A first visit waits up to 2.5 s more for its first picture (not timed). The first version's sale lines changed every 0.5–0.9 s, too fast to read; the note now holds fifteen lines in all, and a test pins a 1.2 s floor on the real fixture run and the recording's length at ≤ 32 s. **Budgets:** the table in Design §10. Initial JS first came out at about 183 kB, because the page pulled the loop model; `model/plate.ts` loads with the lazy plate. **Fresh eyes:** 23 routes at 1440 and 390 in iframes on the dev server: no page overflow, a source badge on all, no `undefined`/`NaN`. It found a duplicate React key in Activity's run links (a recorded run listed twice, fixed) and 16 refused connections to the scene server (now only on a loopback page, where it's still logged while the server is down). The rest are true states: sim and a Sale recording show the map's `ErrorState` with a link to LIVE; `Not built.` on `/lab` is the injection card. Phone Network controls scroll sideways by design. **§2 "not used":** looked at, none found, on Overview, Network, Activity (recorded), Spore #6, `/lab`, `/verify` and `/lab/loop`. The loaded gallery was looked at only through its cards on the Overview, and Rogue, Sale and Wash only by the script sweep. **A11y:** Lighthouse on `/` (production build, snapshot, desktop): Accessibility 100, Best Practices 100, SEO 100, after adding `robots.txt`. That 100 leaves out `label-content-name-mismatch`, which Lighthouse gives zero weight: the eight stops failed it (WCAG 2.5.3) and now take their name from their visible words, with "Jump to this stop" as a description; the 4 gallery cards still fail it, because their `aria-label` is the summary Design §6.B specifies, which leaves out `partners` and the owner and reorders the rest. **Left open**, it also applies to all 64 cards in the gallery. The last audit no longer lists either, but it ran right after a reload and may have run before they rendered, so it doesn't show them fixed: the stops rest on their name now being their own text; 33 tab stops in `main`, all focusable and each stop's links shown on focus; the 2 px ring measured on each except the 4 cards, whose ring is drawn on their art (S6, not re-measured). Reduced motion, forced through `matchMedia`: opens on the finished plate, no arrow, no running animation, all eight facts readable. **Sizes seen:** 1440×800, 1280×720, 820 and 390 wide with no overflow; the eight stops on the first screen at 1440×800 (bottom at 774 px, with every link showing); at 1280×720 they overran by 70 px before the smaller line, which was not re-measured there. **README from a clean copy** (`rsync` without `.git`, `node_modules`, `target`, `out`, `dist`, wasm, `.env`): `bash scripts/build-wasm.sh` 19 s with its vector checks OK, `npm ci`, `bash scripts/demo.sh --playback --no-open --exit-at-end` exit 0, no keys. **`vite preview`** of the build: the plate plays, and direct loads of `/market`, `/activity`, `/spore/6`, `/lab` and `/verify` render, which narrows S13's static-host gap. Its own SPA fallback did that routing, so a real host still needs one. | **Not seen:** a judge or anyone else watching it for the first time: "understood in 30 s" is a design aim here, not a measurement. The OS reduced-motion setting itself; a keyboard-only walk of the whole app (tab order on the Overview only; Network, gallery and dialogs rest on S6–S8); a screen reader; a real close arriving on the Overview (router4 is idle, so the compact map's tween and the `No run is going` sentence's opposite weren't seen live); a wallet tx; a real host; a 2019 laptop. Stress numbers are `draw()` alone, synthetic. Lighthouse's `llms.txt` suggestion was left alone. **Costs:** no testnet spend this session: `demo.sh` was not run for real, so its README output is S13's. S13's warnings stand: about three real runs before the seller runs out, Rogue's precondition likely fails until a run regrows tubes. **Departures from Do:** results are in `docs/results.md` (the merged file), not `docs/phase6-results.md`; the hero isn't the live map (§13 item 22); no per-changed-tube canvas redraw: the living tubes repaint every frame, and the budgets are met without it. **Left to the team:** README's other TODOs (Phase 7), hosting, the demo video. Temporary preview and dev servers are stopped at the end of the session. No commits made. |
| 2026-11-07 | Landing page and first-screen refinement | User: the Overview becomes a landing page, leaves the nav bar and says what we are, what we do and how it works, "only overview" (the Demo Lab gets its own redo later); then a brief to fix the first screen's competing focal points, keeping fonts and identity. No screenshot came with the brief; its eight stages and owner and deployer labels identify this screen. §13 item 23. **New, viz:** `components/LandingStory.tsx` (lazy), `model/landing.ts`. **Changed:** `App.tsx` (`/` in `LandingFrame`), `ui/Shell.tsx` (`LandingFrame`, `LANDING_SECTIONS`, Overview out of `NAV`, 4-item bottom bar), `pages/Overview.tsx` (recent activity out), `components/OverviewPlate.tsx` (`SporeSheet`, `PlateLegend`, `StopDetail`, stage spots), `model/plate.ts` (`plateSheet`, `STOP_GLOSS`, `shownStop`, `nextStop`), `LoopVein` (`across` is name and state only, `deepLink` removed, `stopWord`), `LoopStage`/`SaleStage` (optional `spots`), `state/scene.ts` (`seekUntil`), `state/loop.ts` (`useStorySource` moved here), `ui/status.tsx` (`waiting for a close` after 90 s), `pages/Pages.tsx`, `pages/overview.css`. **Fixed:** seeking to Sell showed `—` for balance, age and reputation, because the sale's first snapshot hadn't been read; the sheet now keeps the last read. Seeking to a stop showed its promise only; it now lands at the stop's end, with its figures. The pen pointed at the paper label while the note spoke of the royalty; it now points at the royalty account. **Checked:** viz 476/476; initial JS 175.0 kB, `LandingStory` 7.9 kB, plate 6.7 kB; Chrome at 1440×800, 1024×768 and 390×844, no horizontal overflow, no console errors; `/lab/loop` still shows its own figures and vein; reduced motion forced through `matchMedia`: finished plate, full vein, 0 running animations; `/#how` lands on the section; Lighthouse Accessibility/Best Practices/SEO 100 on desktop. **Left:** the team's names, repo link and licence aren't on the page, because none is public or given (Phase 7). `label-content-name-mismatch` now also flags the compact `SourceBadge` (zero weight). Not seen: a first-time viewer, a real OS reduced-motion setting, a screen reader, a real touch device (touch was emulated), hover on the spots beyond scripted events plus one screenshot, a real host. The landing story's fixed results are guarded by a test against `wash.json`, the recording and `report.json`, not re-derived at run time. |
| 2026-11-07 | About out, brand logo, developer text out | §13 item 24. **Changed:** `ui/Shell.tsx` (`BrandLink`: `favicon.svg` beside the name on both bars; `about` out of `LANDING_SECTIONS`; the recorded banner has no run id), `ui/shell.css` (`.brand-mark`, nucleus dot and `nucleus-breathe` removed), `ui/status.tsx` (clock says `ended` past 90 s, short so the bar fits 390 px with the larger logo; its tooltip no longer names `close_epoch`), `components/LandingStory.tsx` (`About` removed, run id and "testnet run" wording out, footer link is "The contract"), `pages/Overview.tsx` ("The network is quiet right now", compact badge), `model/overview.ts` (`durationWords` removed), `components/OverviewPlate.tsx`, `model/plate.ts`, `pages/LoopScene.tsx` and `pages/WashScene.tsx` (shell commands out), `pages/Network.tsx`, `Market.tsx`, `MySpores.tsx` (method names out of error text), `components/LoopRail.tsx`; `brand/README.md`, `docs/design-guide.md`. Checked: `npm test` 476/476, `tsc` clean, Chrome at 1440 on `/` and `/network`. |
| 2026-11-07 | Developer text out of the deeper pages | §13 item 24, second half. **Changed:** `sources/source.ts` (recorded badge shows the date, no run id), `pages/DemoLab.tsx`, `RogueScene.tsx`, `SaleScene.tsx` (`operator`: live controls, preconditions and the live-run warnings only with a reachable server; "Run it live instead" only where `canReachFrom` allows), `components/SceneChrome.tsx` (`Preconditions` loses its server row), `sources/scene.ts` (`START_COMMAND` removed), `pages/LoopScene.tsx` (plain tx labels, verify command out), `pages/WashScene.tsx` (reports named in words), `pages/Activity.tsx` (`bundleName`), `pages/Network.tsx`, `components/NetworkInspector.tsx`, `pages/SporeDetail.tsx`, `pages/Verify.tsx`, `sources/verify.ts` ("the close list", still linking the file), and smaller copy in `LoopRail`, `SceneLanes`, `DecisionEntry`, `StateMarker`, `SporeCard`, `TransactionReceipt`, `economy`, `ownerActions`, `model/loop.ts`, `model/wash.ts`. Tests updated to the new words; no-server cases now assert the controls and any server text are absent. Checked: `npm test`, `tsc`, `vite build`, and Chrome's rendered text on 16 routes (`/lab*`, `/network`, `/activity`, `/market`, `/spore/6`, `/verify`, LIVE and RECORDED). Not checked: the live controls against a real running scene server (covered by tests with a fake client only). |
| 2026-11-07 | Build fix, commit | `npm run build` had been stopping at `tsc -b` on a needless cast in `test/overview.test.tsx:176`, though the previous entry saw `tsc` and `vite build` pass. Removed the cast. All of Phase 6 committed on a new `develop` branch (from `phase5`), nothing pushed. | `npm run build` completes; viz 476/476. Staged files scanned: no `.env`, keys or payload; 92 secret values from `.env` compared, 0 hits. | Phase 6 not closed: real `demo.sh` run on this tree and a rehearsal of the SPEC §10 script are still open. |
