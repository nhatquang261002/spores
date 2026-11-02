//! Shared test vectors for the core math (`vectors/core.json`). Any other
//! implementation (router contract, `verify`, a JS port) must reproduce every
//! value byte for byte. u128 values are decimal strings.

use serde_json::{json, Value};
use spores_core::allowance::{effective_budget, Allowance};
use spores_core::fee::split_payment;
use spores_core::glyph::glyph_svg;
use spores_core::market::royalty_split;
use spores_core::state;
use spores_core::fingerprint::{hex, GENESIS};
use spores_core::graph::{next_conductivity, saturation};
use spores_core::hiring::score;
use spores_core::math::{isqrt, mul_div, mul_div_ceil};
use spores_core::{close_epoch, Edge, EdgeMap, EpochInput, Params, RejectMap, NEAR};

use crate::report::params_json;

fn edges_json(m: &EdgeMap) -> Value {
    Value::Array(m.iter().map(|(e, v)| json!([e.a(), e.b(), v.to_string()])).collect())
}

/// Six spores, six epochs with a fixed flow and rejection schedule (epoch 3 is
/// empty).
fn epoch_chain(p: &Params) -> Value {
    let active = [3u32, 11, 17, 25, 40, 63];
    let schedule: [&[(u32, u32, u128)]; 6] = [
        &[
            (3, 11, NEAR / 10),
            (11, 17, NEAR / 4),
            (17, 25, NEAR / 20),
            (25, 3, NEAR / 10),
        ],
        &[
            (3, 11, NEAR / 5),
            (3, 17, NEAR / 10),
            (11, 40, 2 * NEAR),
            (40, 63, NEAR / 50),
        ],
        &[
            (3, 11, NEAR / 10),
            (11, 17, NEAR / 4),
            (17, 25, NEAR / 20),
            (25, 63, 7 * NEAR / 100),
            (3, 63, 1),
        ],
        &[],
        &[
            (3, 11, NEAR / 3),
            (11, 63, 10 * NEAR),
            (17, 40, 123_456_789_000_000_000_000_001),
        ],
        &[(3, 25, NEAR / 8)],
    ];
    let reject_schedule: [&[(u32, u32, u32)]; 6] =
        [&[], &[(3, 11, 1)], &[(11, 17, 2), (40, 63, 1)], &[], &[(3, 11, 1)], &[]];
    let mut d = EdgeMap::new();
    let mut prev = GENESIS;
    let mut epochs = Vec::new();
    for (t, (pays, rejected)) in schedule.iter().zip(reject_schedule).enumerate() {
        let mut flows = EdgeMap::new();
        let mut pool = 0u128;
        for (a, b, q) in pays.iter() {
            *flows.entry(Edge::new(*a, *b).unwrap()).or_default() += q;
            pool += split_payment(*q, p.fee_bps).unwrap().fee;
        }
        let rejects: RejectMap = rejected
            .iter()
            .map(|(a, b, n)| (Edge::new(*a, *b).unwrap(), *n))
            .collect();
        let input = EpochInput {
            epoch: t as u64,
            prev_fingerprint: prev,
            active: &active,
            conductivity: &d,
            flows: &flows,
            rejects: &rejects,
            pool,
        };
        let out = close_epoch(p, &input).unwrap();
        epochs.push(json!({
            "epoch": t,
            "prev_fingerprint": hex(&prev),
            "conductivity_in": edges_json(&d),
            "payments": pays.iter().map(|(a, b, q)| json!([a, b, q.to_string()])).collect::<Vec<_>>(),
            "rejects": rejected.iter().map(|(a, b, n)| json!([a, b, n])).collect::<Vec<_>>(),
            "pool": pool.to_string(),
            "expect": {
                "conductivity": edges_json(&out.conductivity),
                "reputation": out.reputation.iter().map(|(id, r)| json!([id, r.to_string()])).collect::<Vec<_>>(),
                "payouts": out.distribution.payouts.iter().map(|(id, v)| json!([id, v.to_string()])).collect::<Vec<_>>(),
                "treasury": out.distribution.treasury.to_string(),
                "canonical": out.canonical,
                "fingerprint": hex(&out.fingerprint),
            }
        }));
        d = out.conductivity;
        prev = out.fingerprint;
    }
    json!({"params": params_json(p), "active": active, "epochs": epochs})
}

pub fn generate() -> Value {
    let spec = Params::spec();
    let shipped = Params::shipped();
    let big = 10u128.pow(25);

    let isqrt_cases: Vec<Value> = [
        0u128,
        1,
        2,
        3,
        4,
        15,
        16,
        17,
        999_999,
        1_000_000,
        4_000_000,
        1 << 64,
        10u128.pow(30),
        u128::MAX,
    ]
    .iter()
    .map(|n| json!({"n": n.to_string(), "root": isqrt(*n).to_string()}))
    .collect();

    let md_cases: Vec<Value> = [
        (7u128, 3u128, 2u128),
        (1_000_000, big, big + NEAR / 2),
        (u128::MAX, u128::MAX, u128::MAX),
        (1 << 127, 6, 7),
        (big, big, 3 * big),
    ]
    .iter()
    .map(|(a, b, d)| {
        json!({
            "a": a.to_string(), "b": b.to_string(), "d": d.to_string(),
            "floor": mul_div(*a, *b, *d).map(|x| x.to_string()),
            "ceil": mul_div_ceil(*a, *b, *d).map(|x| x.to_string()),
        })
    })
    .collect();

    let mut fee_cases = Vec::new();
    for amount in [0u128, 1, 99, 100, 101, NEAR / 10 + 7, big] {
        for bps in [0u32, 1, 100, 250] {
            let s = split_payment(amount, bps).unwrap();
            fee_cases.push(json!({"amount": amount.to_string(), "fee_bps": bps, "fee": s.fee.to_string(), "forwarded": s.forwarded.to_string()}));
        }
    }

    let sat_cases: Vec<Value> = [0u128, 1, NEAR / 100, NEAR / 2, NEAR, big, u128::MAX]
        .iter()
        .map(|q| json!({"q": q.to_string(), "k": spec.k.to_string(), "w": saturation(*q, spec.k).to_string()}))
        .collect();

    let mut update_cases = Vec::new();
    for (name, p) in [("spec", &spec), ("shipped", &shipped)] {
        for (d, q, ba, bb, rejects) in [
            (0u128, NEAR / 2, 1u32, 1u32, 0u32),
            (1_000_000, NEAR / 2, 4, 6, 0),
            (1_000_000, NEAR / 2, 2, 6, 0),
            (1_000_000, NEAR / 2, 4, 6, 1),
            (1_000_000, NEAR / 10, 4, 6, 3),
            (4_000_000, 0, 0, 0, 0),
            (60_000, 0, 3, 3, 0),
            (66_000, 1, 4, 4, 0),
            (3_999_999, big, 9, 2, 0),
            (3_999_999, big, 9, 9, 1_000),
        ] {
            update_cases.push(json!({
                "params": name, "d": d.to_string(), "q": q.to_string(), "breadth_a": ba, "breadth_b": bb, "rejects": rejects,
                "next": next_conductivity(p, d, q, ba, bb, rejects).to_string(),
            }));
        }
    }

    let mut hiring_cases = Vec::new();
    for (quote, d, d_best) in [
        (NEAR / 10, 0u128, 0u128),
        (NEAR / 10, 0, 1_000_000),
        (NEAR / 10, 1_000_000, 4_000_000),
        (NEAR / 10, 4_000_000, 4_000_000),
        (12_345, 2_000_001, 3_000_000),
    ] {
        for w in [0u32, 5_000, 10_000, 40_000] {
            hiring_cases.push(json!({
                "quote": quote.to_string(), "d": d.to_string(), "d_best": d_best.to_string(), "w_bps": w,
                "score": score(quote, d, d_best, w).to_string(),
            }));
        }
    }

    let royalty_cases: Vec<Value> = [(0u128, 500u32), (19, 500), (1_000, 500), (NEAR / 2 + 1, 500), (big, 250), (u128::MAX, 500), (7, 10_000)]
        .iter()
        .map(|(price, bps)| {
            let (seller, royalty) = royalty_split(*price, *bps).unwrap();
            json!({"price": price.to_string(), "royalty_bps": bps, "seller": seller.to_string(), "royalty": royalty.to_string()})
        })
        .collect();

    let shipped_allowance = Allowance::shipped();
    let allowance_cases: Vec<Value> = [
        (u128::MAX, 0u128),
        (u128::MAX, 1_000),
        (u128::MAX, 3_456),
        (NEAR / 4, 3_456),
        (0, 2_000),
        (u128::MAX, u128::MAX),
    ]
    .iter()
    .map(|(owner, r)| {
        json!({
            "owner_budget": owner.to_string(), "reputation": r.to_string(),
            "base_budget": shipped_allowance.base_budget.to_string(), "trust_gain": shipped_allowance.trust_gain.to_string(),
            "effective": effective_budget(*owner, shipped_allowance.base_budget, shipped_allowance.trust_gain, *r).to_string(),
        })
    })
    .collect();

    let mut seed = [0u8; 32];
    for (i, b) in seed.iter_mut().enumerate() {
        *b = (i as u8).wrapping_mul(37).wrapping_add(11);
    }
    // (id, epoch, age, active, edges)
    type SporeCase = (u32, u64, u32, bool, Vec<(u32, u128)>);
    let spore_cases: [SporeCase; 4] = [
        (7, 0, 0, false, vec![]),
        (7, 3, 0, true, vec![]),
        (7, 12, 9, true, vec![(40, 1_200_000), (3, 50_000), (63, 999_999)]),
        (63, 99, 41, true, (0..15).map(|i| (i * 4, 60_000 * (i as u128 + 1))).collect()),
    ];
    let state_cases: Vec<Value> = spore_cases
        .iter()
        .map(|(id, epoch, age, active, edges)| {
            json!({
                "id": id, "epoch": epoch, "seed": hex(&seed), "age": age, "active": active,
                "edges": edges.iter().map(|(n, d)| json!([n, d.to_string()])).collect::<Vec<_>>(),
                "canonical": state::canonical(*id, *epoch, &seed, *age, edges),
                "state_hash": hex(&state::state_hash(*id, *epoch, &seed, *age, edges)),
                "glyph": glyph_svg(*id, &seed, *age, *active, edges),
            })
        })
        .collect();

    json!({
        "version": 1,
        "about": "Generated by `cargo run -p spores-sim -- vectors` from spores-core. Every implementation of the core must reproduce each value exactly. u128 values are decimal strings; null means overflow.",
        "params": {"spec": params_json(&spec), "shipped": params_json(&shipped)},
        "isqrt": isqrt_cases,
        "mul_div": md_cases,
        "fee": fee_cases,
        "saturation": sat_cases,
        "edge_update": update_cases,
        "hiring_score": hiring_cases,
        "epoch_chains": [epoch_chain(&spec), epoch_chain(&shipped)],
        "royalty_split": royalty_cases,
        "allowance": allowance_cases,
        "spore_state": state_cases,
    })
}
