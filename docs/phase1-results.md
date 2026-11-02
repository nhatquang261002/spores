# Phase 1: graph core and sim

Status on 2026-10-29: core and sim built, 34 tests green, wash-trading gate **passes** with the shipped parameters. The tube-vs-price baseline is only a **modest** win; see "Open" at the end.

## Reproduce

```sh
export PATH="$HOME/.cargo/bin:$PATH"          # rustc 1.97.1
cargo test --workspace                          # 34 tests, incl. shared vectors
cargo run --release -p spores-sim -- all        # baseline + sweep, a few seconds; exit 1 if the gate fails
cargo run --release -p spores-sim -- tune       # hiring-rule tuning grid (stdout)
cargo run --release -p spores-sim -- vectors    # regenerate vectors/core.json
```

`all` writes `out/phase1-report.md`, `out/baseline.json`, `out/sweep.json` and `out/sweep-full.md` (every case). Two runs give byte-identical output. `vectors/core.json` sha256 at the time of writing: `af97af8d6e5e96722b72bd68e32ccda5f39b92fba6e602893bd5091faae275b9`.

## Layout

- `core/` (`spores-core`): pure integer math with no chain dependency; only `sha2` as a dependency. `math` (isqrt, 256-bit `mul_div`), `graph` (edge update, breadth, rejection cut, reputation), `fee`, `pool`, `fingerprint`, `hiring`, `allowance`, `epoch::close_epoch` (one call that the router and `verify` both run).
- `sim/` (`spores-sim`): economy simulation; every money decision goes through `spores-core`, floats only in hidden quality and metrics. Ledger conservation is asserted every epoch.
- `vectors/core.json`: shared vectors (isqrt, mul_div, fee, saturation, edge update, hiring score, two 6-epoch chains with fingerprints). `core/tests/vectors.rs` checks them; the router, `verify` and any JS port must match them byte for byte.

## Changes from SPEC.md and why

Each change came from a sim result or a counterexample. `Params::spec()` keeps the original rule so the sweep can compare the two.

| # | SPEC as written | Shipped | Why |
| --- | --- | --- | --- |
| 1 | Fee pool split among active spores by saturated weight (§8.3) | **Capped rebate**: each spore gets back at most `rebate_bps` (5000) of `fee * K / 2` per unit of weight; the rest goes to the treasury | Fees per unit of weight are always at least `fee*K/2`, so a loop of small payments earns more from the pool than it pays. Measured with the SPEC rule: attacker net **positive** in all 54 in-range cases with loops of 0.2 NEAR or less. With the cap, an edge's two ends get back at most `fee*q*K/(q+K) < fee*q`, so every loop loses money: provably, and in 360/360 sweep cases. The same bound shows rebates never exceed the pool. |
| 2 | Division rounds down everywhere | Fee rounds **up** | A floored 1% fee is 0 for payments under 100 yocto, so dust payments would grow tubes for free. |
| 3 | `u128` with overflow checks; test `gain*q` at q ≈ 1e25 | Exact 256-bit `mul_div` for every product-then-divide | No overflow for any `q` up to `u128::MAX`; same bytes on every target. |
| 4 | `K = 0.5 NEAR` | `K = 0.1 NEAR` (about one job's price) | With jobs near 0.1 NEAR, K = 0.5 left honest tubes near the pruning floor (honest mean R ≈ 0.2 in the first run) while a 3-spore wash ring reached R ≈ 4. At K = 0.5 the shipped rule still fails 6 sweep cases (below). Rule of thumb: keep K near the typical job price. |
| 5 | Edge gain `gain * q/(q+K)` | Times `min(breadth_a, breadth_b, 4) / 4`, where breadth = distinct counterparties with a live tube or flow this epoch | A wash ring of k spores has breadth at most k-1, so its tubes grow at 1/4 (k=2) or 1/2 (k=3) speed. Spores trading with 4 or more partners grow at full speed. This keeps attacker reputation below the honest median. |
| 6 | Rejected jobs simply don't count | Each rejected delivery cuts the edge's D by `reject_bps` (5000 = halve) | Without it a tube remembers past hires, not reliability. Lowers failed attempts from 26.2% to 25.3% at the same w (baseline table). Tubes are pairwise, so a rejection only weakens the rejecter's own tube to that provider (and the provider's R). |
| 7 | `D_norm` = D normalised to 0..1 | `D / strongest candidate tube`, `w = 4` (agent rule, not consensus) | Scale-free, and slightly better than `D / d_max` in the baseline and the tuning grid. |
| 8 | Fingerprint over `epoch, spores, a:b:D` | `spores/fp/v1\|epoch\|prev_fp_hex\|ids\|a:b:D\|...` | Domain tag and version; chaining the previous fingerprint makes each epoch commit to the whole history. Ids numeric ascending. |
| 9 | Empty epoch does nothing | Empty epoch pays nothing, but tubes still decay | Die-back needs decay without flow. |

Unchanged: `decay_bps = 2500`, `gain = 1e6`, `D_min = 50_000`, `fee_bps = 100`, `R = Σ isqrt(D)`, the living allowance formula (`core/src/allowance.rs`).

## Results (real run, 20 seeds)

Tables copied from `out/phase1-report.md`.

### Baseline: price only vs price with tubes

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

Reading: with the shipped rule, tubes cut failed attempts from 28.2% to 25.3% (about 10% relative) and unfulfilled jobs from 7.6% to 7.1%, while the average price paid rises 28%. Recovery after shocks is not faster (about 2 epochs or less either way). The best of the 72 rule variants in the tuning grid reaches 24.5% failed attempts (relative norm, w=10, reject 5000, decay 1000). With the SPEC parameters, tubes do not beat price only (28.5% vs 28.2%).

### Wash-trading sweep (SPEC §9)

Attacker spores 2-3 (1 is rejected as a self-payment), fee_bps 50/100/200, K 0.05/0.1/0.2/0.5 NEAR, gain 0.5e6/1e6/2e6, loop 0.01-5 NEAR per edge per epoch, 3 seeds, worst case over seeds. The attacker's spores only pay each other.

- **Gate**: attacker net < 0 and the attacker's best spore stays below the honest median R. K is gated over ½×–2× of its default, the same range as fee and gain.
- **§9 literal**: the gate's money condition, plus tube gain and reputation per net NEAR below the honest group's.

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

- **§9 literal fails for tiny loops (≤ 0.05 NEAR per edge per epoch): 93 of 270 in-range cases.** This follows from `R = Σ isqrt(D)`: reputation is concave, so the smallest tube that survives pruning gives the most reputation per NEAR, for honest and attacker spores alike. At those loop sizes the attacker's best spore reaches at most 0.39 of the honest median R. The gate uses "loses money and cannot reach the honest median" because that is what selling a spore with faked history would need. SPEC asked for the per-NEAR comparison, so this change of criterion needs sign-off.
- **K = 0.5 NEAR (5× default) fails the gate in 6 cases**: 3 attacker spores, a 5 NEAR loop, gain ≤ 1e6. The attacker's best spore reaches R 1.91–2.70 against an honest median of 1.77–2.67, while losing 2.9–11.5 NEAR. K must stay near the job price.
- Not modelled: an attacker who also buys real services from honest spores to raise its breadth to 4. That costs real purchases, but it would lift the breadth damping.

## SPEC §11 tests covered (graph, fee and reputation)

| Test | Where |
| --- | --- |
| Identical bytes across runs | `epoch::identical_inputs_give_identical_bytes`, `economy::same_seed_same_bytes`, sim output diff. Across machines and languages: the shared vectors |
| Zero flow prunes in the expected epochs (16 from `d_max`) | `graph::zero_flow_prunes_in_expected_epochs` |
| 100× payment ≠ 100× conductivity, reputation or pool weight | `graph::large_payment_is_saturated`, `graph::reputation_prefers_breadth`, `pool::hundredfold_payment_is_not_hundredfold_weight` |
| No overflow at the largest payment | `graph::no_overflow_at_extreme_payments` (q up to `u128::MAX`, gain up to `u64::MAX`), `math::mul_div_wide_*` |
| Fee + forwarded = paid; pool distribution sums to the pool | `fee::fee_plus_forwarded_is_amount`, `pool::proportional_sums_to_pool_with_largest_remainder`, `Distribution::total` in the vectors and the sim |
| Ledger conserved | asserted every epoch in every sim run |
| Wash-trading criterion | `pool::capped_rebate_makes_loops_lose_and_spec_rule_does_not`, `economy::shipped_rule_makes_every_loop_lose`, the sweep |

## Open (needs a decision)

1. **Tubes vs price only.** ROADMAP says to change the rule and rerun if tubes do not win. They win on reliability by a small margin and lose on price. In the sim a failed attempt only costs a retry, because rejected jobs are refunded. Options: (a) ship as is and describe tubes as "reliability at a price premium", (b) give failures a cost in the sim (deadline, lost value) and re-measure, (c) keep iterating on the rule.
2. **Gate criterion.** Confirm the switch from "reputation per NEAR" to "loses money and cannot reach the honest median" (reason above), or ask for a reputation formula that also meets the literal criterion (for example a linear capped `R = Σ min(D, cap)` instead of `isqrt`, which gives up the breadth bonus).
