# Phase 2: spikes

Status on 2026-10-31. Two go/no-go decisions, written down as ROADMAP asks.

| Spike | Decision | Evidence level |
| --- | --- | --- |
| Spore sub-accounts (§5.6) | **No-go.** Keep the single router ledger. | Desk spike: docs, API surface and the §11 tests. **Not run on testnet.** |
| Fixed-point renderer (§5.5) | **Go.** The slime render is the NFT image; the on-chain glyph stays the fallback layer. | Built and measured: native arm64, native x86_64 (Rosetta), wasm32 in node and a JS port give identical bytes on 10 cases. **Not yet run on a second physical machine or on Linux.** |

## Reproduce

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --workspace                                   # includes renderer properties + shared vectors
cargo run --release -p spores-renderer -- check          # native Rust vs vectors/renderer.json
cargo build --release -p spores-renderer --target wasm32-unknown-unknown
node renderer/js/check.mjs                               # JS port and the wasm build vs the same vectors
cargo run --release -p spores-renderer -- png mature out/render/mature.png   # look at one
cargo run --release -p spores-renderer -- vectors        # regenerate vectors/renderer.json after ANY renderer change
```

Second machine: clone, run the first four commands, and compare `shasum -a 256 vectors/renderer.json` and the `check` output. Both should say every case matches; `spores-render hashes` prints the image hashes to compare by eye. `vectors/renderer.json` sha256 at the time of writing: `9c329d9b40b5b05303f778133936832d48b50ba16184abd6fc449f1cce6687b5`.

## Spike 1: spore sub-accounts (NO-GO)

Question (§5.6): give each active spore a real NEAR account whose keys the router controls, so the NFT transfers a real account and the single-ledger risk shrinks.

What the docs say (read 2026-10-31):

- A contract can add or delete keys on another account only in the same batch that starts with `CreateAccount` (nomicon RuntimeSpec/Actions, recorded in `docs/verify-notes.md`). After that it has no control unless it deployed a contract there that exposes key methods.
- So each spore would need a proxy contract. That part is **cheaper than Phase 0 assumed**: global contracts (NEP-591) let an account reference shared code. The docs say the publisher pays 10 NEAR per 100 kB, burned, once; an account that only references the code pays "typically under 0.001 NEAR". `near-sdk` has `Promise::use_global_contract` and `use_global_contract_by_account_id`. Account creation is about 0.007 NEAR per verify-notes.
- **Not verified:** that a contract can issue `UseGlobalContract` inside its own `CreateAccount` batch on testnet. The docs page covers CLI and `near-api-rs` only. This was not tested because the decision below does not depend on it.

Why no-go, in order of weight:

1. **No custody gain.** The router would have to own every proxy to move funds between spores, escrow jobs and pay fees. Whoever upgrades or compromises the router controls every sub-account exactly as they control the ledger today. The single-ledger risk (README "Known limits") does not shrink; it moves.
2. **Atomicity.** SPEC §11 requires `buy` to settle NFT, seller payment and royalty "all or none", and ledger conservation across an epoch. With balances in separate accounts every move is a cross-contract receipt. NEAR calls are asynchronous and not atomic, so each step needs a callback and a rollback path, and "conserved" has to be checked while receipts are in flight. Today these are plain integer updates inside one call.
3. **Policy has to stay in the router anyway.** Operator keys are function-call keys that cannot attach a deposit (verify-notes). Budget, allowlist, cap and pause are enforced in the router, so the agent calls the router, not the proxy. The sub-account would be a passive vault.
4. **Gas and moving parts.** `close_epoch` pays rebates to every active spore; that becomes up to 16 cross-contract transfers per epoch, plus a proxy to build, test and keep in sync. This is not worth it when the cut order (SPEC §15) puts this spike first to go.

What this costs us: the NFT does not "own a real account". The README states the single router ledger keyed by spore id as the design that shipped (README line 32 and 40 TODOs).

Go condition if revisited: a proxy that holds funds only and exposes `transfer(to, amount)` callable by the router, a testnet run of the create+use-global batch, and a design for `buy` that survives a failed leg. None of that is planned.

## Spike 2: fixed-point renderer (GO)

### What was built

`renderer/` (crate `spores-renderer`, about 1200 lines Rust + JS in total):

- `rng.rs` xoshiro128** (32-bit, so JS needs only `Math.imul` and shifts); seed bytes 0-15 drive the simulation, 16-31 drive grain and dust.
- `trig.rs` sine table built with an integer-only Q60 Taylor series on `i128`, symmetric quarter wave, 4096 angles, Q16 values. No libm anywhere.
- `sim.rs` the Physarum simulation: Q8 trail grid with cap, Q16 agent positions, heading in 1/4096 turn, 3-sensor steering, 3x3 diffusion and decay. Random draws happen in a fixed documented order.
- `paint.rs` tone curve, palette LUT, two-pass box-blur bloom, grain, vignette, ring dots, dust, partner markers, nucleus, frame. Integer anti-aliasing from `isqrt`.
- `wasm.rs` C ABI (`alloc`, `render_into`, `hash_image`) used by the JS cross-check and later by `viz`.
- `js/render.mjs` independent JS port; `js/check.mjs` compares JS and wasm against `vectors/renderer.json`.
- Image hash for `commit_image`: `sha256("spores/img/v1" | RENDERER_VERSION u32 | N u32 | N u32 | RGB bytes)`. It hashes pixels, not a PNG, so no encoder is in the trust path. The CLI's PNG writer is for looking only.
- Output is 512 x 512 RGB. Scaling for display is the viz's job.

### Results (real runs)

| Check | Result |
| --- | --- |
| Native Rust (aarch64-apple-darwin) vs vectors | 10/10 cases match: trail hash and image hash |
| Native Rust (x86_64-apple-darwin, run under Rosetta) vs vectors | 10/10 |
| wasm32 build run in node 26.7 (render in wasm, hash both in wasm and in JS) vs vectors | 10/10 |
| JS port (own sine table, own PRNG, own pipeline) vs vectors | 10/10, plus sine-table hash |
| Negative control | Changing the seed by one bit, `age` by one, or one `D` by 12 000 changes the hash in the JS port; a change of 1 or 1 000 in `D` does not (see limits) |
| Timing (this machine) | native 0.2-0.7 s per image; wasm 0.6-1.0 s; JS 1.2-4.2 s |
| wasm size | 73 kB (release, unstripped, no wasm-opt) |

The 10 cases: dormant, young, mature, mature minus one edge, mature plus one edge, and five palettes at different degrees and ages.

SPEC §11 art tests, status:

| Test | Status |
| --- | --- |
| Byte-identical across repeated runs | `repeated_renders_are_byte_identical` |
| Across two machines | **Partly.** Two instruction sets (arm64, x86_64) on one machine, plus wasm. A second physical machine or Linux has not been run. |
| Across Rust and JS, shared vectors | Done (above) |
| Dormant is a faint mark | `dormant_is_a_faint_mark`: no trail at all, fewer than 600 bright pixels against 14 792 for the mature case |
| Adding an edge changes the image; pruning restores the thinner network | `adding_an_edge_changes_the_image_and_pruning_restores_the_thinner_one` (restores the earlier image exactly) |
| Young renders visibly smaller than mature, same seed | `young_spore_renders_smaller_than_mature_with_the_same_seed`: network footprint 12 364 vs 22 744 cells, bright pixels 7 555 vs 14 792 |
| On-chain glyph under the view gas limit | Not part of this spike (Phase 5) |
| `commit_image` hash reproduced by `verify` | Not part of this spike (Phase 5). `image_hash` is defined and pinned. |

A first version failed the young-vs-mature test (footprint 71% of mature, and visibly as wide in the picture). The fix was to confine agents to a disc that grows with degree (`140 + 10*deg` px, at most 215) and clamp partner markers inside it. The test was not loosened.

### Differences from SPEC §5.5, and why

| # | SPEC | Built | Why |
| --- | --- | --- | --- |
| 1 | Inputs: seed, edges, reputation, epoch | Seed, edges, **age** | Reputation is derived from the edges (`sum isqrt(D)`). `epoch` is the same for every spore, so it cannot make a young spore look young; age (epochs since activation, stored per spore per §5.3) can. The epoch is a label for the viz, so it is not in the hash. |
| 2 | "Faint trail below a threshold that **rises** with age is masked" | Threshold **falls** with age: 14/255 at age 0 to 0 at age 30 | As written, an old spore would hide more than a young one, which contradicts the stated goal that a young spore reads small. Read as a typo; please confirm. |
| 3 | Ring: 64 dots, brighter for active spores | Dots drawn uniformly dim, slots with a tube skipped | Which spores are active is global state, not part of this spore's state hash. Putting it in the image would make a committed hash depend on other spores. Active brightness belongs to the gallery layer. |
| 4 | (Prototype) name, `#id`, epoch, degree and rep as text | No text in the image | Fonts are not byte-reproducible across platforms. The viz overlays text in HTML. |
| 5 | Prototype: float numpy, Gaussian init, `pow(0.8)`, Gaussian bloom, LANCZOS upscale | Integer equivalents: product-of-uniforms init, `(3x + sqrt(255x)) / 4` tone curve, box-blur bloom, no upscale | Floats and library resampling are the reproducibility problem. The look is similar, not identical, to `slime.py`. |
| 6 | `D` drives size continuously | `D` is quantized to `D/1000` (0..1000) before it reaches the picture | Keeps marker and node maths in small integers. |

### Limits and open points

- **The image is not injective in state.** Because of `D/1000` quantization, small changes in `D` (below roughly 1% of full scale) can leave the image unchanged. The state hash stays the authority; the image hash is an additional commitment. How often a real epoch of decay and flow moves the image has not been measured; do that in Phase 3 with chain state.
- **Not yet tested:** a second physical machine, Linux, Windows, Firefox/Safari WASM. The risk is low because nothing uses floats, libm or platform sort order, but "low" is not "checked".
- **Render time on a phone or a slow JS path** has not been measured. Wasm at about 1 s on this machine is acceptable for the gallery if images are cached; 16 active spores re-render every epoch.
- **Art is not final.** Young spores' partner markers can sit outside the thin network, and the palette look has not been reviewed against `slime_example.png` side by side. This is Phase 6 polish.
- **Changing any renderer constant changes every image hash.** Bump `RENDERER_VERSION` (also stored in the hash) and regenerate `vectors/renderer.json`; `commit_image` already carries `renderer_version`. Nothing is committed on-chain yet, so version 1 was edited in place during this spike (the young/mature tuning above).
- **Decision for the team:** the gate says "if the renderer is not reproducible, the on-chain glyph becomes the NFT image". It is reproducible on the machines available, so the plan stays: slime render as the image, glyph as the on-chain fallback. Confirm once a second machine has run `check`.

### Pre-window disclosure

`slime.py` (pre-window prototype, already disclosed in CLAUDE.md) is what this was ported from. The Rust and JS renderer is new work from 2026-10-31 and was written with Claude Code (Q-005). Dependencies added: `sha2` (already used by `core`), `serde_json` for tests. No image or PRNG crate.
