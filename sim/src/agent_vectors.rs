//! Shared test vectors for the off-chain agents (`vectors/agents.json`): the
//! RNG, hiring choice, quote and margin rules and the demand draw. The
//! TypeScript port in `agents/` must reproduce every value. u64 and u128
//! values are decimal strings.

use serde_json::{json, Value};
use spores_core::hiring::{d_norm, pick, score, Norm, Quote, SHIPPED_NORM, SHIPPED_W_BPS};
use spores_core::market::{job_service, next_margin, quote_price, MARGIN_MAX, MARGIN_MIN, MARGIN_START, MARGIN_STEP};
use spores_core::rng::{stream, Rng};
use spores_core::NEAR;

fn norm_json(n: Norm) -> Value {
    match n {
        Norm::Absolute(r) => json!({"absolute": r.to_string()}),
        Norm::Relative => json!("relative"),
    }
}

pub fn generate() -> Value {
    let rng_seeds = [0u64, 1, 42, u64::MAX];
    let rng: Vec<Value> = rng_seeds
        .iter()
        .map(|s| {
            let mut r = Rng::new(*s);
            let out: Vec<String> = (0..4).map(|_| r.next_u64().to_string()).collect();
            json!({"seed": s.to_string(), "next_u64": out})
        })
        .collect();

    let stream_keys: [&[u64]; 5] = [&[], &[1], &[1, 2, 3], &[7, 0, 5, 1, 0], &[u64::MAX, 0, 9, 9, 9]];
    let streams: Vec<Value> = stream_keys
        .iter()
        .map(|k| {
            let mut r = stream(k);
            let out: Vec<String> = (0..3).map(|_| r.next_u64().to_string()).collect();
            let below = stream(k).below(10_000);
            json!({"keys": k.iter().map(|x| x.to_string()).collect::<Vec<_>>(), "next_u64": out, "below_10000": below.to_string()})
        })
        .collect();

    let mut scores = Vec::new();
    for (quote, d, reference, w) in [
        (1_000u128, 0u128, 0u128, 10_000u32),
        (1_000, 500, 500, 10_000),
        (1_000, 900, 500, 10_000),
        (1_000, 250, 500, 10_000),
        (120 * NEAR / 1_000, 1_234_567, 4_000_000, 40_000),
        (u128::MAX / 2, 3_999_999, 4_000_000, 40_000),
    ] {
        scores.push(json!({
            "quote": quote.to_string(), "d": d.to_string(), "reference": reference.to_string(), "w_bps": w,
            "d_norm": d_norm(d, reference).to_string(), "score": score(quote, d, reference, w).to_string(),
        }));
    }

    let q = |provider, price: u128, d: u128| Quote { provider, price, d };
    let pick_sets: Vec<(Vec<Quote>, u32, Norm)> = vec![
        (vec![], SHIPPED_W_BPS, SHIPPED_NORM),
        (vec![q(5, 100, 0), q(2, 100, 0), q(9, 150, 80_000)], 0, Norm::Relative),
        (vec![q(5, 100, 0), q(2, 100, 0), q(9, 150, 80_000)], 10_000, Norm::Relative),
        (vec![q(5, 100, 0), q(2, 100, 0), q(9, 150, 80_000)], 10_000, Norm::Absolute(800_000)),
        (vec![q(4, 0, 0), q(1, 0, 0)], SHIPPED_W_BPS, SHIPPED_NORM),
        (
            vec![
                q(3, 96 * NEAR / 1_000, 0),
                q(6, 144 * NEAR / 1_000, 2_100_000),
                q(0, 180 * NEAR / 1_000, 3_900_000),
            ],
            SHIPPED_W_BPS,
            SHIPPED_NORM,
        ),
        // Equal scores: lower price wins, then lower id.
        (vec![q(8, 200, 1_000), q(7, 100, 0), q(1, 100, 0)], 10_000, Norm::Relative),
    ];
    let picks: Vec<Value> = pick_sets
        .iter()
        .map(|(qs, w, n)| {
            json!({
                "quotes": qs.iter().map(|x| json!({"provider": x.provider, "price": x.price.to_string(), "d": x.d.to_string()})).collect::<Vec<_>>(),
                "w_bps": w, "norm": norm_json(*n),
                "winner": pick(qs, *w, *n),
            })
        })
        .collect();

    let quotes: Vec<Value> = [(30 * NEAR / 1_000, MARGIN_START), (150 * NEAR / 1_000, MARGIN_MAX), (7, 2_500), (1, MARGIN_MIN)]
        .iter()
        .map(|(c, m)| json!({"cost": c.to_string(), "margin_bps": m, "quote": quote_price(*c, *m).to_string()}))
        .collect();

    // Down to the floor, up to the cap, then one hold and one step down.
    let mut wins = vec![0u32; 8];
    wins.extend([2u32, 3, 1, 5].iter().cycle().take(40));
    wins.extend([1, 0]);
    let mut m = MARGIN_START;
    let margins: Vec<u32> = wins
        .iter()
        .map(|w| {
            m = next_margin(m, *w);
            m
        })
        .collect();

    let mut demand = Vec::new();
    for (seed, t, c, j, services, own) in [(1u64, 0u64, 0u64, 0u64, 3u32, 0u32), (1, 5, 4, 0, 3, 1), (1, 5, 4, 1, 3, 1), (99, 12, 8, 0, 3, 2), (7, 3, 2, 0, 4, 2), (7, 3, 2, 2, 2, 0)] {
        demand.push(json!({"seed": seed.to_string(), "epoch": t.to_string(), "consumer": c.to_string(), "j": j.to_string(), "services": services, "own": own, "service": job_service(seed, t, c, j, services, own)}));
    }

    json!({
        "shipped": {"w_bps": SHIPPED_W_BPS, "norm": norm_json(SHIPPED_NORM)},
        "margin": {"start": MARGIN_START, "min": MARGIN_MIN, "max": MARGIN_MAX, "step": MARGIN_STEP},
        "rng": rng,
        "stream": streams,
        "score": scores,
        "pick": picks,
        "quote_price": quotes,
        "next_margin": {"start": MARGIN_START, "wins": wins, "margins": margins},
        "job_service": demand,
    })
}
