//! Baseline and wash-trading sweep, written as Markdown tables plus JSON.

use std::fmt::Write;

use serde_json::{json, Value};
use spores_core::allowance::Allowance;
use spores_core::{Params, PoolRule, NEAR};

use crate::economy::{run, Attack, Config, EpochStats, Mode, Scale, Series, Shocks};

const SHOCKS: Shocks = Shocks {
    kill: Some(20),
    cut: Some(30),
    raise: Some(40),
};
const BASELINE_EPOCHS: u64 = 60;

pub fn params_json(p: &Params) -> Value {
    let rule = match p.pool_rule {
        PoolRule::Proportional => json!({"rule": "proportional"}),
        PoolRule::CappedRebate { rebate_bps } => json!({"rule": "capped_rebate", "rebate_bps": rebate_bps}),
    };
    json!({
        "decay_bps": p.decay_bps,
        "gain": p.gain.to_string(),
        "k": p.k.to_string(),
        "d_min": p.d_min.to_string(),
        "fee_bps": p.fee_bps,
        "pool_rule": rule,
        "breadth_full": p.breadth_full,
        "reject_bps": p.reject_bps,
    })
}

pub fn params_line(p: &Params) -> String {
    let rule = match p.pool_rule {
        PoolRule::Proportional => "proportional (SPEC §8.3 as written)".to_string(),
        PoolRule::CappedRebate { rebate_bps } => format!("capped rebate {rebate_bps} bps"),
    };
    format!(
        "decay_bps={} gain={} K={:.3} NEAR D_min={} fee_bps={} pool={} breadth_full={} reject_bps={}",
        p.decay_bps,
        p.gain,
        p.k as f64 / NEAR as f64,
        p.d_min,
        p.fee_bps,
        rule,
        p.breadth_full,
        p.reject_bps
    )
}

fn near(yocto: u128) -> f64 {
    yocto as f64 / NEAR as f64
}

fn mean(xs: impl Iterator<Item = f64>) -> f64 {
    let (s, n) = xs.fold((0.0, 0usize), |(s, n), x| (s + x, n + 1));
    if n == 0 {
        0.0
    } else {
        s / n as f64
    }
}

/// Epochs from the shock until the 3-epoch rolling success rate is back
/// within 3 points of its 5-epoch pre-shock mean. `None` if not before `until`.
fn recovery(stats: &[EpochStats], at: u64, until: u64) -> Option<u64> {
    let s = |t: u64| stats[t as usize].success_rate();
    let pre = mean((at - 5..at).map(s));
    (at..until.saturating_sub(2))
        .find(|t| mean((*t..*t + 3).map(s)) >= pre - 0.03)
        .map(|t| t - at)
}

pub struct Baseline {
    pub markdown: String,
    pub json: Value,
}

/// The hiring rule agents ship with: `D_norm` relative to the strongest
/// candidate tube, `w = 4`. Chosen from `tune`; see docs/how-it-works.md §9.1.
pub const SHIPPED_HIRING: Mode = Mode::TubesRelative {
    w_bps: spores_core::hiring::SHIPPED_W_BPS,
};

pub fn baseline(seeds: u64, scale: Scale) -> Baseline {
    let Scale { active, jobs } = scale;
    let variants: Vec<(&str, Params, Mode)> = vec![
        ("price only", Params::shipped(), Mode::PriceOnly),
        (
            "tubes rel w=1",
            Params::shipped(),
            Mode::TubesRelative { w_bps: 10_000 },
        ),
        ("tubes rel w=4 (shipped)", Params::shipped(), SHIPPED_HIRING),
        ("tubes abs w=1", Params::shipped(), Mode::tubes(10_000)),
        ("tubes abs w=4", Params::shipped(), Mode::tubes(40_000)),
        (
            "tubes rel w=4, no reject cut",
            Params {
                reject_bps: 0,
                ..Params::shipped()
            },
            SHIPPED_HIRING,
        ),
        ("tubes abs w=1, SPEC params", Params::spec(), Mode::tubes(10_000)),
    ];
    let shocks = [
        ("kill", SHOCKS.kill.unwrap()),
        ("cut", SHOCKS.cut.unwrap()),
        ("raise", SHOCKS.raise.unwrap()),
    ];
    let ends = [SHOCKS.cut.unwrap(), SHOCKS.raise.unwrap(), BASELINE_EPOCHS];

    let mut md = String::new();
    writeln!(
        md,
        "{} seeds x {} epochs, {} active spores, 4 services, {} jobs per consumer per epoch, 2 attempts per job. \
         Shocks: kill the best-value provider at epoch {}, cut the strongest tube at {}, triple the second-best provider's cost at {}. \
         Recovery: epochs until the 3-epoch rolling success rate is within 3 points of the 5 epochs before the shock (mean over seeds that recovered).\n",
        seeds, BASELINE_EPOCHS, active, jobs, shocks[0].1, shocks[1].1, shocks[2].1
    )
    .unwrap();
    md.push_str("| Mode | Avg price paid (NEAR) | Failed attempts | Unfulfilled jobs | Hired quality | Recover: kill | Recover: cut | Recover: raise | Tubes mean / max | Flow edges max | Reject edges max | Rebated spores max |\n");
    md.push_str("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
    let mut rows = Vec::new();
    for (label, params, mode) in &variants {
        let (mut paid, mut settled, mut attempts, mut failures, mut jobs, mut unfulfilled, mut quality) =
            (0u128, 0u64, 0u64, 0u64, 0u64, 0u64, 0.0f64);
        let mut rec: Vec<Vec<Option<u64>>> = vec![Vec::new(); 3];
        let mut fingerprints = Vec::new();
        let (mut edges_sum, mut epochs_n) = (0usize, 0usize);
        let mut maxes = [0usize; 4]; // tubes, flow edges, reject edges, rebated spores
        for seed in 1..=seeds {
            let mut cfg = Config::new(*params, *mode, seed);
            cfg.epochs = BASELINE_EPOCHS;
            cfg.shocks = SHOCKS;
            scale.apply(&mut cfg);
            let r = run(&cfg);
            for s in &r.stats {
                edges_sum += s.edges;
                epochs_n += 1;
                for (m, x) in maxes.iter_mut().zip([s.edges, s.flow_edges, s.reject_edges, s.rebated_spores]) {
                    *m = (*m).max(x);
                }
                paid += s.paid;
                settled += s.settled as u64;
                attempts += s.attempts as u64;
                failures += s.failures as u64;
                jobs += s.jobs as u64;
                unfulfilled += s.unfulfilled as u64;
                quality += s.hired_quality;
            }
            for (i, (_, at)) in shocks.iter().enumerate() {
                rec[i].push(recovery(&r.stats, *at, ends[i]));
            }
            fingerprints.push(r.last_fingerprint);
        }
        let avg_price = near(paid) / settled as f64;
        let fail = failures as f64 / attempts as f64;
        let unf = unfulfilled as f64 / jobs as f64;
        let q = quality / attempts as f64;
        let rec_cells: Vec<String> = rec
            .iter()
            .map(|v| {
                let ok: Vec<f64> = v.iter().flatten().map(|x| *x as f64).collect();
                format!("{:.1} ({}/{})", mean(ok.iter().copied()), ok.len(), v.len())
            })
            .collect();
        writeln!(
            md,
            "| {} | {:.4} | {:.1}% | {:.1}% | {:.3} | {} | {} | {} | {:.1} / {} | {} | {} | {} |",
            label,
            avg_price,
            100.0 * fail,
            100.0 * unf,
            q,
            rec_cells[0],
            rec_cells[1],
            rec_cells[2],
            edges_sum as f64 / epochs_n as f64,
            maxes[0],
            maxes[1],
            maxes[2],
            maxes[3]
        )
        .unwrap();
        rows.push(json!({
            "tubes_mean": edges_sum as f64 / epochs_n as f64,
            "tubes_max": maxes[0],
            "flow_edges_max": maxes[1],
            "reject_edges_max": maxes[2],
            "rebated_spores_max": maxes[3],
            "mode": label,
            "params": params_json(params),
            "avg_price_near": avg_price,
            "failed_attempt_rate": fail,
            "unfulfilled_job_rate": unf,
            "hired_quality": q,
            "recovery_epochs": rec.iter().map(|v| v.iter().map(|x| json!(x)).collect::<Vec<_>>()).collect::<Vec<_>>(),
            "last_fingerprints": fingerprints,
        }));
    }
    Baseline {
        markdown: md,
        json: json!({"seeds": seeds, "epochs": BASELINE_EPOCHS, "active": active, "jobs_per_consumer": jobs, "rows": rows}),
    }
}

/// Hiring-rule tuning grid: one row per (norm, w, reject_bps, decay_bps),
/// same shocks and seeds as the baseline. Norm is `rel` (strongest candidate
/// tube) or the absolute reference as a share of `d_max` in bps.
pub fn tune(seeds: u64) -> String {
    let mut md = String::from(
        "| norm | w | reject_bps | decay_bps | Avg price | Failed attempts | Unfulfilled | Hired quality |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n",
    );
    let mut rows: Vec<(Mode, u32, u32)> = vec![(Mode::PriceOnly, 0, 2_500)];
    for w in [10_000, 40_000, 100_000] {
        for norm in [None, Some(10_000), Some(5_000), Some(2_500)] {
            for reject in [0, 5_000, 10_000] {
                for decay in [1_000, 2_500] {
                    let mode = match norm {
                        None => Mode::TubesRelative { w_bps: w },
                        Some(ref_bps) => Mode::Tubes { w_bps: w, ref_bps },
                    };
                    rows.push((mode, reject, decay));
                }
            }
        }
    }
    for (mode, reject_bps, decay_bps) in rows {
        let params = Params {
            reject_bps,
            decay_bps,
            ..Params::shipped()
        };
        let (norm, w) = match mode {
            Mode::PriceOnly => ("price only".to_string(), 0),
            Mode::Tubes { w_bps, ref_bps } => (ref_bps.to_string(), w_bps),
            Mode::TubesRelative { w_bps } => ("rel".to_string(), w_bps),
        };
        let (mut paid, mut settled, mut attempts, mut failures, mut jobs, mut unfulfilled, mut quality) =
            (0u128, 0u64, 0u64, 0u64, 0u64, 0u64, 0.0f64);
        for seed in 1..=seeds {
            let mut cfg = Config::new(params, mode, seed);
            cfg.epochs = BASELINE_EPOCHS;
            cfg.shocks = SHOCKS;
            for s in &run(&cfg).stats {
                paid += s.paid;
                settled += s.settled as u64;
                attempts += s.attempts as u64;
                failures += s.failures as u64;
                jobs += s.jobs as u64;
                unfulfilled += s.unfulfilled as u64;
                quality += s.hired_quality;
            }
        }
        writeln!(
            md,
            "| {} | {} | {} | {} | {:.4} | {:.1}% | {:.1}% | {:.3} |",
            norm,
            w as f64 / 10_000.0,
            reject_bps,
            decay_bps,
            near(paid) / settled as f64,
            100.0 * failures as f64 / attempts as f64,
            100.0 * unfulfilled as f64 / jobs as f64,
            quality / attempts as f64
        )
        .unwrap();
    }
    md
}

pub struct Sweep {
    pub markdown: String,
    pub full_markdown: String,
    pub json: Value,
    pub shipped_pass: bool,
}

struct Case {
    variant: &'static str,
    spores: u32,
    fee_bps: u32,
    k_milli: u128,
    gain: u128,
    volume_milli: u128,
    net: f64,
    tube_ratio: f64,
    rep_ratio: f64,
    /// Highest per-spore mean R among the attacker's spores (worst seed).
    att_max_rep: f64,
    /// Median per-spore mean R among honest spores (worst seed).
    honest_median: f64,
    blocked: Option<String>,
    /// K within ½×–2× of the variant's default, the same range as fee and gain.
    in_range: bool,
    /// Whole-run net (rebates minus fees) per seed, NEAR.
    attacker_net_by_seed: Vec<f64>,
    honest_net_by_seed: Vec<f64>,
    /// Per-epoch series per seed (attacker, honest); only kept for the
    /// variant's default fee, K and gain, to keep `sweep.json` small.
    series: Vec<(u64, Series, Series)>,
}

impl Case {
    fn rep_vs_median(&self) -> f64 {
        ratio(self.att_max_rep, self.honest_median)
    }

    /// Gate: the loop loses money and no attacker spore reaches the honest
    /// median reputation.
    fn pass(&self) -> bool {
        self.blocked.is_some() || (self.net < 0.0 && self.att_max_rep < self.honest_median)
    }

    /// SPEC §9 as written: also lower tube and reputation gain per NEAR.
    fn literal_pass(&self) -> bool {
        self.blocked.is_some() || (self.net < 0.0 && self.tube_ratio < 1.0 && self.rep_ratio < 1.0)
    }
}

const SWEEP_EPOCHS: u64 = 40;
const SWEEP_SEEDS: [u64; 3] = [1, 2, 3];
const FEES: [u32; 3] = [50, 100, 200];
const KS_MILLI: [u128; 4] = [50, 100, 200, 500];
const GAINS: [u128; 3] = [500_000, 1_000_000, 2_000_000];
const VOLUMES_MILLI: [u128; 5] = [10, 50, 200, 1_000, 5_000];

fn ratio(a: f64, h: f64) -> f64 {
    if a.is_infinite() {
        f64::INFINITY
    } else if h <= 0.0 {
        if a <= 0.0 {
            0.0
        } else {
            f64::INFINITY
        }
    } else {
        a / h
    }
}

#[allow(clippy::too_many_arguments)]
fn sweep_case(
    variant: &'static str,
    base: Params,
    spores: u32,
    fee_bps: u32,
    k_milli: u128,
    gain: u128,
    volume_milli: u128,
    allowance: Option<Allowance>,
    scale: Scale,
) -> Case {
    let params = Params {
        fee_bps,
        k: k_milli * NEAR / 1_000,
        gain,
        ..base
    };
    let mut c = Case {
        variant,
        spores,
        fee_bps,
        k_milli,
        gain,
        volume_milli,
        net: f64::NEG_INFINITY,
        tube_ratio: 0.0,
        rep_ratio: 0.0,
        att_max_rep: 0.0,
        honest_median: f64::INFINITY,
        blocked: None,
        in_range: base.k / 2 <= params.k && params.k <= base.k * 2,
        attacker_net_by_seed: Vec::new(),
        honest_net_by_seed: Vec::new(),
        series: Vec::new(),
    };
    let keep_series = fee_bps == base.fee_bps && params.k == base.k && gain == base.gain;
    for seed in SWEEP_SEEDS {
        let mut cfg = Config::new(params, SHIPPED_HIRING, seed);
        cfg.epochs = SWEEP_EPOCHS;
        cfg.allowance = allowance;
        scale.apply(&mut cfg);
        cfg.attack = Some(Attack {
            spores,
            volume: volume_milli * NEAR / 1_000,
            payments: 4,
        });
        let r = run(&cfg);
        if let Some(e) = r.attack_error {
            c.blocked = Some(e);
            return c;
        }
        c.attacker_net_by_seed.push(r.attacker_net as f64 / NEAR as f64);
        c.honest_net_by_seed.push(r.honest_net as f64 / NEAR as f64);
        if keep_series {
            c.series.push((seed, r.attacker_series.clone(), r.honest_series.clone()));
        }
        // Worst case over seeds.
        c.net = c.net.max(r.attacker_net as f64 / NEAR as f64);
        c.tube_ratio = c
            .tube_ratio
            .max(ratio(r.attacker.tube_per_near(), r.honest_group.tube_per_near()));
        c.rep_ratio = c
            .rep_ratio
            .max(ratio(r.attacker.rep_per_near(), r.honest_group.rep_per_near()));
        c.att_max_rep = c.att_max_rep.max(r.attacker.max_rep());
        c.honest_median = c.honest_median.min(r.honest_group.median_rep());
    }
    c
}

fn fmt_ratio(x: f64) -> String {
    if x.is_infinite() {
        "inf".into()
    } else {
        format!("{x:.2}")
    }
}

fn series_json(s: &Series) -> Value {
    json!({
        "balance_delta": s.balance_delta,
        "fees": s.fees,
        "rebates": s.rebates,
        "r_max": s.r_max,
        "r_median": s.r_median,
    })
}

pub fn sweep(scale: Scale) -> Sweep {
    let Scale { active, jobs } = scale;
    let variants: [(&'static str, Params); 2] = [("spec", Params::spec()), ("shipped", Params::shipped())];
    let mut cases = Vec::new();
    for (name, base) in variants {
        cases.push(sweep_case(name, base, 1, 100, 500, 1_000_000, 1_000, None, scale));
        for spores in [2, 3] {
            for fee in FEES {
                for k in KS_MILLI {
                    for gain in GAINS {
                        for v in VOLUMES_MILLI {
                            cases.push(sweep_case(name, base, spores, fee, k, gain, v, None, scale));
                        }
                    }
                }
            }
        }
    }

    let mut md = String::new();
    writeln!(
        md,
        "{active} active spores, {jobs} honest jobs per spore per epoch. Grid: attacker spores 1-3, fee_bps {:?}, K {:?} milliNEAR, gain {:?}, loop volume {:?} milliNEAR per edge per epoch; \
         seeds {:?}, {} epochs, metrics over the second half, worst case over seeds. The attacker's spores only trade with each other.\n\n\
         - **Gate**: attacker net < 0 (rebates minus fees) AND the attacker's best spore stays below the honest median reputation \
         (R ratio < 1). Gated over K within ½×–2× of the variant's default, the same range as fee and gain; other K values are reported.\n\
         - **§9 literal**: attacker net < 0 AND attacker tube gain per NEAR < honest AND attacker reputation per NEAR < honest \
         (ratio columns are attacker / honest; NEAR = fees minus rebates on the group's own edges).\n",
        FEES, KS_MILLI, GAINS, VOLUMES_MILLI, SWEEP_SEEDS, SWEEP_EPOCHS
    )
    .unwrap();
    for (name, base) in variants {
        let mine: Vec<&Case> = cases.iter().filter(|c| c.variant == name).collect();
        let count = |f: &dyn Fn(&Case) -> bool| mine.iter().filter(|c| f(c)).count();
        let in_range = count(&|c| c.in_range);
        writeln!(
            md,
            "**{name}** ({}): gate {}/{in_range} in range, {}/{} over the whole grid; §9 literal {}/{in_range} in range, {}/{} overall.\n",
            params_line(&base),
            count(&|c| c.in_range && c.pass()),
            count(&|c| c.pass()),
            mine.len(),
            count(&|c| c.in_range && c.literal_pass()),
            count(&|c| c.literal_pass()),
            mine.len()
        )
        .unwrap();
        if let Some(b) = mine.iter().find_map(|c| c.blocked.clone()) {
            writeln!(
                md,
                "1 attacker spore: blocked, the router rejects the self-payment (`{b}`).\n"
            )
            .unwrap();
        }
        let out_fail: Vec<String> = mine
            .iter()
            .filter(|c| !c.in_range && !c.pass())
            .map(|c| {
                format!(
                    "K={} fee={} gain={} loop={}",
                    c.k_milli as f64 / 1_000.0,
                    c.fee_bps,
                    c.gain,
                    c.volume_milli as f64 / 1_000.0
                )
            })
            .collect();
        if !out_fail.is_empty() {
            let shown = out_fail.iter().take(6).cloned().collect::<Vec<_>>().join("; ");
            let more = if out_fail.len() > 6 {
                "; ... (see sweep-full.md)"
            } else {
                ""
            };
            writeln!(
                md,
                "Gate failures outside the range ({}): {shown}{more}.\n",
                out_fail.len()
            )
            .unwrap();
        }
        md.push_str("In-range cases:\n\n");
        md.push_str("| Spores | Loop (NEAR/edge/epoch) | Gate | §9 literal | Worst net (NEAR) | Worst tube ratio | Worst rep ratio | Worst R ratio (attacker best / honest median) |\n");
        md.push_str("| --- | --- | --- | --- | --- | --- | --- | --- |\n");
        for spores in [2, 3] {
            for v in VOLUMES_MILLI {
                let g: Vec<&&Case> = mine
                    .iter()
                    .filter(|c| c.in_range && c.spores == spores && c.volume_milli == v)
                    .collect();
                let pass = g.iter().filter(|c| c.pass()).count();
                let lit = g.iter().filter(|c| c.literal_pass()).count();
                let net = g.iter().map(|c| c.net).fold(f64::NEG_INFINITY, f64::max);
                let tr = g.iter().map(|c| c.tube_ratio).fold(0.0, f64::max);
                let rr = g.iter().map(|c| c.rep_ratio).fold(0.0, f64::max);
                let mr = g.iter().map(|c| c.rep_vs_median()).fold(0.0, f64::max);
                writeln!(
                    md,
                    "| {} | {} | {}/{n} | {}/{n} | {:+.4} | {} | {} | {} |",
                    spores,
                    v as f64 / 1_000.0,
                    pass,
                    lit,
                    net,
                    fmt_ratio(tr),
                    fmt_ratio(rr),
                    fmt_ratio(mr),
                    n = g.len()
                )
                .unwrap();
            }
        }
        md.push('\n');
    }

    let mut full = String::from("| Variant | Spores | fee_bps | K (NEAR) | gain | Loop (NEAR) | Net (NEAR) | Tube ratio | Rep ratio | Max attacker R | Honest median R | Gate | §9 literal |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
    let mut rows = Vec::new();
    let yes = |b: bool| if b { "yes" } else { "NO" };
    for c in &cases {
        writeln!(
            full,
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {:.2} | {:.2} | {} | {} |",
            c.variant,
            c.spores,
            c.fee_bps,
            c.k_milli as f64 / 1_000.0,
            c.gain,
            c.volume_milli as f64 / 1_000.0,
            if c.blocked.is_some() {
                "blocked".into()
            } else {
                format!("{:+.5}", c.net)
            },
            fmt_ratio(c.tube_ratio),
            fmt_ratio(c.rep_ratio),
            c.att_max_rep,
            if c.honest_median.is_finite() {
                c.honest_median
            } else {
                0.0
            },
            yes(c.pass()),
            yes(c.literal_pass())
        )
        .unwrap();
        rows.push(json!({
            "variant": c.variant,
            "attacker_spores": c.spores,
            "fee_bps": c.fee_bps,
            "k_milli_near": c.k_milli.to_string(),
            "gain": c.gain.to_string(),
            "loop_milli_near": c.volume_milli.to_string(),
            "blocked": c.blocked,
            "net_near_worst": if c.blocked.is_some() { Value::Null } else { json!(c.net) },
            "tube_ratio_worst": if c.tube_ratio.is_finite() { json!(c.tube_ratio) } else { json!("inf") },
            "rep_ratio_worst": if c.rep_ratio.is_finite() { json!(c.rep_ratio) } else { json!("inf") },
            "attacker_max_rep": c.att_max_rep,
            "honest_median_rep": if c.honest_median.is_finite() { json!(c.honest_median) } else { Value::Null },
            "k_in_gate_range": c.in_range,
            "gate_pass": c.pass(),
            "literal_pass": c.literal_pass(),
            "attacker_net_near_by_seed": c.attacker_net_by_seed,
            "honest_net_near_by_seed": c.honest_net_by_seed,
            "series": c.series.iter().map(|(seed, a, h)| json!({
                "seed": seed,
                "attacker": series_json(a),
                "honest": series_json(h),
            })).collect::<Vec<_>>(),
        }));
    }
    let shipped_pass = cases
        .iter()
        .filter(|c| c.variant == "shipped" && c.in_range)
        .all(Case::pass);
    Sweep {
        markdown: md,
        full_markdown: full,
        json: json!({
            "epochs": SWEEP_EPOCHS,
            "seeds": SWEEP_SEEDS,
            "active": active,
            "jobs_per_consumer": jobs,
            "series_note": "per-epoch series (every epoch, not only the measurement window) are kept only for each variant's default fee, K and gain; money in NEAR, R in units of REP_ONE",
            "cases": rows
        }),
        shipped_pass,
    }
}

/// Living-allowance candidates (base, trust_gain) in milliNEAR; `None` is the
/// Phase 1 run with no ceiling.
const ALLOWANCES_MILLI: [Option<(u128, u128)>; 6] = [
    None,
    Some((50, 100)),
    Some((100, 100)),
    Some((50, 200)),
    Some((100, 200)),
    Some((200, 200)),
];

pub struct AllowanceReport {
    pub markdown: String,
    pub json: Value,
    /// The wash gate passes in range with `Allowance::shipped()`.
    pub gate_pass: bool,
}

/// Shipped params and hiring with each allowance candidate: the baseline
/// metrics (same seeds and shocks) plus the in-range wash-trading gate.
pub fn allowance(seeds: u64, scale: Scale) -> AllowanceReport {
    let Scale { active, jobs } = scale;
    let p = Params::shipped();
    let mut md = String::new();
    writeln!(
        md,
        "{active} active spores, {jobs} honest jobs per spore per epoch. Shipped params and hiring, owner budget unlimited, so the ceiling `base + trust_gain * R / {}` binds. \
         Baseline: {} seeds x {} epochs with the Phase 1 shocks. Wash gate: the in-range shipped grid (2-3 attacker spores, \
         fee, K and gain within the shipped range, every loop volume), worst case over seeds {:?}.\n",
        spores_core::math::REP_ONE,
        seeds,
        BASELINE_EPOCHS,
        SWEEP_SEEDS
    )
    .unwrap();
    md.push_str("| base (NEAR) | trust_gain (NEAR per R 1000) | Avg price paid | Failed attempts | Unfulfilled jobs | Budget-blocked hires | Hired quality | Wash gate in range | Worst attacker net (NEAR) |\n");
    md.push_str("| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
    let mut rows = Vec::new();
    let mut gate_pass = false;
    for cand in ALLOWANCES_MILLI {
        let a = cand.map(|(b, g)| Allowance {
            base_budget: b * NEAR / 1_000,
            trust_gain: g * NEAR / 1_000,
        });
        let (mut paid, mut settled, mut attempts, mut failures, mut jobs, mut unfulfilled, mut blocked, mut quality) =
            (0u128, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0.0f64);
        for seed in 1..=seeds {
            let mut cfg = Config::new(p, SHIPPED_HIRING, seed);
            cfg.epochs = BASELINE_EPOCHS;
            cfg.shocks = SHOCKS;
            cfg.allowance = a;
            scale.apply(&mut cfg);
            for s in &run(&cfg).stats {
                paid += s.paid;
                settled += s.settled as u64;
                attempts += s.attempts as u64;
                failures += s.failures as u64;
                jobs += s.jobs as u64;
                unfulfilled += s.unfulfilled as u64;
                blocked += s.budget_blocked as u64;
                quality += s.hired_quality;
            }
        }
        let mut cases = Vec::new();
        for spores in [2, 3] {
            for fee in FEES {
                for k in KS_MILLI {
                    for gain in GAINS {
                        for v in VOLUMES_MILLI {
                            let c = sweep_case("shipped", p, spores, fee, k, gain, v, a, scale);
                            if c.in_range {
                                cases.push(c);
                            }
                        }
                    }
                }
            }
        }
        let pass = cases.iter().filter(|c| c.pass()).count();
        let worst_net = cases.iter().map(|c| c.net).fold(f64::NEG_INFINITY, f64::max);
        let shipped = a == Some(Allowance::shipped());
        if shipped {
            gate_pass = pass == cases.len();
        }
        let (base_cell, gain_cell) = match cand {
            None => ("none".to_string(), "none".to_string()),
            Some((b, g)) => (
                format!("{:.3}{}", b as f64 / 1e3, if shipped { " (shipped)" } else { "" }),
                format!("{:.3}", g as f64 / 1e3),
            ),
        };
        let row = (
            near(paid) / settled.max(1) as f64,
            failures as f64 / attempts.max(1) as f64,
            unfulfilled as f64 / jobs.max(1) as f64,
            blocked as f64 / jobs.max(1) as f64,
            quality / attempts.max(1) as f64,
        );
        writeln!(
            md,
            "| {base_cell} | {gain_cell} | {:.4} | {:.1}% | {:.1}% | {:.1}% | {:.3} | {pass}/{} | {:.4} |",
            row.0,
            100.0 * row.1,
            100.0 * row.2,
            100.0 * row.3,
            row.4,
            cases.len(),
            worst_net
        )
        .unwrap();
        rows.push(json!({
            "base_budget_milli": cand.map(|c| c.0 as u64),
            "trust_gain_milli": cand.map(|c| c.1 as u64),
            "avg_price_near": row.0,
            "failed_attempt_rate": row.1,
            "unfulfilled_job_rate": row.2,
            "budget_blocked_rate": row.3,
            "hired_quality": row.4,
            "gate_pass": pass,
            "gate_cases": cases.len(),
            "worst_attacker_net_near": worst_net,
            "shipped": shipped,
        }));
    }
    AllowanceReport {
        markdown: md,
        json: json!({"seeds": seeds, "epochs": BASELINE_EPOCHS, "active": active, "jobs_per_consumer": jobs, "rows": rows}),
        gate_pass,
    }
}

/// The Demo Lab's wash panel (`sim wash`): the wash gate
/// with the allowance the router enforces, at each traffic level S1 measured,
/// with the per-epoch series of the default fee, K and gain, plus the Phase 1
/// sweep's shipped results as first reported. Nothing here is a new rule: the
/// counts are the ones `allowance` reports for the shipped row.
pub fn wash() -> Value {
    let round = |v: &[f64], places: i32| -> Vec<f64> {
        let f = 10f64.powi(places);
        v.iter().map(|x| (x * f).round() / f).collect()
    };
    let p = Params::shipped();
    let a = Some(Allowance::shipped());
    let mut configs = Vec::new();
    for (active, jobs) in [(16u32, 3u32), (64, 3), (16, 1), (64, 1)] {
        let scale = Scale { active, jobs };
        let mut cases = Vec::new();
        for spores in [2, 3] {
            for fee in FEES {
                for k in KS_MILLI {
                    for gain in GAINS {
                        for v in VOLUMES_MILLI {
                            let c = sweep_case("shipped", p, spores, fee, k, gain, v, a, scale);
                            if c.in_range {
                                cases.push(c);
                            }
                        }
                    }
                }
            }
        }
        let mut loops = Vec::new();
        for spores in [2, 3] {
            for v in VOLUMES_MILLI {
                let group: Vec<&Case> = cases.iter().filter(|c| c.spores == spores && c.volume_milli == v).collect();
                let default = group.iter().find(|c| !c.series.is_empty()).expect("the default fee, K and gain are in range");
                loops.push(json!({
                    "spores": spores,
                    "loop_milli_near": v as u64,
                    "cases": group.len(),
                    "gate_pass": group.iter().filter(|c| c.pass()).count(),
                    "loses_money": group.iter().filter(|c| c.net < 0.0).count(),
                    "worst_net_near": group.iter().map(|c| c.net).fold(f64::NEG_INFINITY, f64::max),
                    "worst_r_ratio": group.iter().map(|c| c.rep_vs_median()).fold(0.0, f64::max),
                    "default": {
                        "gate_pass": default.pass(),
                        "net_near_worst": default.net,
                        "attacker_max_rep": default.att_max_rep,
                        "honest_median_rep": default.honest_median,
                        "series": default.series.iter().map(|(seed, att, honest)| json!({
                            "seed": seed,
                            "attacker_r": round(&att.r_max, 3),
                            "honest_r": round(&honest.r_median, 3),
                            "attacker_money": round(&att.balance_delta, 6),
                        })).collect::<Vec<_>>(),
                    },
                }));
            }
        }
        configs.push(json!({
            "active": active,
            "jobs": jobs,
            "cases": cases.len(),
            "gate_pass": cases.iter().filter(|c| c.pass()).count(),
            "loses_money": cases.iter().filter(|c| c.net < 0.0).count(),
            "worst_net_near": cases.iter().map(|c| c.net).fold(f64::NEG_INFINITY, f64::max),
            "worst_r_ratio": cases.iter().map(|c| c.rep_vs_median()).fold(0.0, f64::max),
            "loops": loops,
        }));
    }

    // Phase 1 as reported: 16 active, 3 jobs, no allowance, the whole grid.
    let sweep = sweep(Scale::DEFAULT);
    // The whole grid counts the blocked 1-spore row, as the report does; the in-range table doesn't.
    let all: Vec<&Value> = sweep.json["cases"].as_array().unwrap().iter().filter(|c| c["variant"] == "shipped").collect();
    let in_range: Vec<&&Value> = all.iter().filter(|c| c["k_in_gate_range"] == true && c["blocked"].is_null()).collect();
    let count = |cs: &[&&Value], key: &str| cs.iter().filter(|c| c[key] == true).count();
    let all_refs: Vec<&&Value> = all.iter().collect();
    let out_of_range: Vec<Value> = all
        .iter()
        .filter(|c| c["k_in_gate_range"] == false && c["gate_pass"] == false)
        .map(|c| {
            json!({
                "spores": c["attacker_spores"], "fee_bps": c["fee_bps"], "k_milli_near": c["k_milli_near"], "gain": c["gain"],
                "loop_milli_near": c["loop_milli_near"], "net_near_worst": c["net_near_worst"],
                "attacker_max_rep": c["attacker_max_rep"], "honest_median_rep": c["honest_median_rep"],
            })
        })
        .collect();
    let mut literal = Vec::new();
    for spores in [2u64, 3] {
        for v in VOLUMES_MILLI {
            let group: Vec<&&Value> = in_range
                .iter()
                .copied()
                .filter(|c| c["attacker_spores"] == spores && c["loop_milli_near"].as_str() == Some(v.to_string().as_str()))
                .collect();
            literal.push(json!({
                "spores": spores,
                "loop_milli_near": v as u64,
                "cases": group.len(),
                "literal_pass": count(&group, "literal_pass"),
                "worst_rep_ratio": group.iter().filter_map(|c| c["rep_ratio_worst"].as_f64()).fold(0.0, f64::max),
                "worst_tube_ratio": group.iter().filter_map(|c| c["tube_ratio_worst"].as_f64()).fold(0.0, f64::max),
            }));
        }
    }
    json!({
        "epochs": SWEEP_EPOCHS,
        "seeds": SWEEP_SEEDS,
        "note": "per-epoch series: fee, K and gain at their shipped defaults; R in units of REP_ONE, money in NEAR. Phase 1 block: 16 active, 3 jobs, no allowance, as in phase1-report.md",
        "configs": configs,
        "phase1": {
            "gate_in_range": { "pass": count(&in_range, "gate_pass"), "cases": in_range.len() },
            "gate_all": { "pass": count(&all_refs, "gate_pass"), "cases": all.len() },
            "literal_in_range": { "pass": count(&in_range, "literal_pass"), "cases": in_range.len() },
            "literal": literal,
            "out_of_range_failures": out_of_range,
        },
    })
}
