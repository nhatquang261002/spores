//! Baseline and wash-trading sweep, written as Markdown tables plus JSON.

use std::fmt::Write;

use serde_json::{json, Value};
use spores_core::{Params, PoolRule, NEAR};

use crate::economy::{run, Attack, Config, EpochStats, Mode, Shocks};

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
/// candidate tube, `w = 4`. Chosen from `tune`; see docs/phase1-results.md.
pub const SHIPPED_HIRING: Mode = Mode::TubesRelative {
    w_bps: spores_core::hiring::SHIPPED_W_BPS,
};

pub fn baseline(seeds: u64) -> Baseline {
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
        "{} seeds x {} epochs, 16 active spores, 4 services, 3 jobs per consumer per epoch, 2 attempts per job. \
         Shocks: kill the best-value provider at epoch {}, cut the strongest tube at {}, triple the second-best provider's cost at {}. \
         Recovery: epochs until the 3-epoch rolling success rate is within 3 points of the 5 epochs before the shock (mean over seeds that recovered).\n",
        seeds, BASELINE_EPOCHS, shocks[0].1, shocks[1].1, shocks[2].1
    )
    .unwrap();
    md.push_str("| Mode | Avg price paid (NEAR) | Failed attempts | Unfulfilled jobs | Hired quality | Recover: kill | Recover: cut | Recover: raise |\n");
    md.push_str("| --- | --- | --- | --- | --- | --- | --- | --- |\n");
    let mut rows = Vec::new();
    for (label, params, mode) in &variants {
        let (mut paid, mut settled, mut attempts, mut failures, mut jobs, mut unfulfilled, mut quality) =
            (0u128, 0u64, 0u64, 0u64, 0u64, 0u64, 0.0f64);
        let mut rec: Vec<Vec<Option<u64>>> = vec![Vec::new(); 3];
        let mut fingerprints = Vec::new();
        for seed in 1..=seeds {
            let mut cfg = Config::new(*params, *mode, seed);
            cfg.epochs = BASELINE_EPOCHS;
            cfg.shocks = SHOCKS;
            let r = run(&cfg);
            for s in &r.stats {
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
            "| {} | {:.4} | {:.1}% | {:.1}% | {:.3} | {} | {} | {} |",
            label,
            avg_price,
            100.0 * fail,
            100.0 * unf,
            q,
            rec_cells[0],
            rec_cells[1],
            rec_cells[2]
        )
        .unwrap();
        rows.push(json!({
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
        json: json!({"seeds": seeds, "epochs": BASELINE_EPOCHS, "rows": rows}),
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

fn sweep_case(
    variant: &'static str,
    base: Params,
    spores: u32,
    fee_bps: u32,
    k_milli: u128,
    gain: u128,
    volume_milli: u128,
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
    };
    for seed in SWEEP_SEEDS {
        let mut cfg = Config::new(params, SHIPPED_HIRING, seed);
        cfg.epochs = SWEEP_EPOCHS;
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

pub fn sweep() -> Sweep {
    let variants: [(&'static str, Params); 2] = [("spec", Params::spec()), ("shipped", Params::shipped())];
    let mut cases = Vec::new();
    for (name, base) in variants {
        cases.push(sweep_case(name, base, 1, 100, 500, 1_000_000, 1_000));
        for spores in [2, 3] {
            for fee in FEES {
                for k in KS_MILLI {
                    for gain in GAINS {
                        for v in VOLUMES_MILLI {
                            cases.push(sweep_case(name, base, spores, fee, k, gain, v));
                        }
                    }
                }
            }
        }
    }

    let mut md = String::new();
    writeln!(
        md,
        "Grid: attacker spores 1-3, fee_bps {:?}, K {:?} milliNEAR, gain {:?}, loop volume {:?} milliNEAR per edge per epoch; \
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
        }));
    }
    let shipped_pass = cases
        .iter()
        .filter(|c| c.variant == "shipped" && c.in_range)
        .all(Case::pass);
    Sweep {
        markdown: md,
        full_markdown: full,
        json: json!({"epochs": SWEEP_EPOCHS, "seeds": SWEEP_SEEDS, "cases": rows}),
        shipped_pass,
    }
}
