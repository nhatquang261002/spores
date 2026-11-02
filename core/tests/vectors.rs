//! Checks spores-core against the shared vectors in `vectors/core.json`.

use serde_json::Value;
use spores_core::allowance::{effective_budget, Allowance};
use spores_core::fee::split_payment;
use spores_core::glyph::glyph_svg;
use spores_core::market::royalty_split;
use spores_core::state;
use spores_core::fingerprint::hex;
use spores_core::graph::{next_conductivity, saturation};
use spores_core::hiring::score;
use spores_core::math::{isqrt, mul_div, mul_div_ceil};
use spores_core::{close_epoch, Edge, EdgeMap, EpochInput, Params, PoolRule, RejectMap};

fn load() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/core.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors/core.json")).unwrap()
}

fn n(v: &Value) -> u128 {
    v.as_str().expect("decimal string").parse().unwrap()
}

fn u(v: &Value) -> u32 {
    v.as_u64().unwrap() as u32
}

fn params(v: &Value) -> Params {
    let rule = &v["pool_rule"];
    Params {
        decay_bps: u(&v["decay_bps"]),
        gain: n(&v["gain"]),
        k: n(&v["k"]),
        d_min: n(&v["d_min"]),
        fee_bps: u(&v["fee_bps"]),
        pool_rule: match rule["rule"].as_str().unwrap() {
            "proportional" => PoolRule::Proportional,
            "capped_rebate" => PoolRule::CappedRebate {
                rebate_bps: u(&rule["rebate_bps"]),
            },
            other => panic!("unknown pool rule {other}"),
        },
        breadth_full: u(&v["breadth_full"]),
        reject_bps: u(&v["reject_bps"]),
    }
}

fn edges(v: &Value) -> EdgeMap {
    v.as_array()
        .unwrap()
        .iter()
        .map(|t| (Edge::new(u(&t[0]), u(&t[1])).unwrap(), n(&t[2])))
        .collect()
}

fn pairs(v: &Value) -> Vec<(u32, u128)> {
    v.as_array().unwrap().iter().map(|t| (u(&t[0]), n(&t[1]))).collect()
}

#[test]
fn named_params_match_code() {
    let v = load();
    assert_eq!(params(&v["params"]["spec"]), Params::spec());
    assert_eq!(params(&v["params"]["shipped"]), Params::shipped());
}

#[test]
fn scalar_vectors() {
    let v = load();
    for c in v["isqrt"].as_array().unwrap() {
        assert_eq!(isqrt(n(&c["n"])), n(&c["root"]));
    }
    for c in v["mul_div"].as_array().unwrap() {
        let (a, b, d) = (n(&c["a"]), n(&c["b"]), n(&c["d"]));
        assert_eq!(mul_div(a, b, d), c["floor"].as_str().map(|s| s.parse().unwrap()));
        assert_eq!(mul_div_ceil(a, b, d), c["ceil"].as_str().map(|s| s.parse().unwrap()));
    }
    for c in v["fee"].as_array().unwrap() {
        let s = split_payment(n(&c["amount"]), u(&c["fee_bps"])).unwrap();
        assert_eq!((s.fee, s.forwarded), (n(&c["fee"]), n(&c["forwarded"])));
    }
    for c in v["saturation"].as_array().unwrap() {
        assert_eq!(saturation(n(&c["q"]), n(&c["k"])), n(&c["w"]));
    }
    for c in v["edge_update"].as_array().unwrap() {
        let p = params(&v["params"][c["params"].as_str().unwrap()]);
        let got = next_conductivity(
            &p,
            n(&c["d"]),
            n(&c["q"]),
            u(&c["breadth_a"]),
            u(&c["breadth_b"]),
            u(&c["rejects"]),
        );
        assert_eq!(got, n(&c["next"]), "{c}");
    }
    for c in v["hiring_score"].as_array().unwrap() {
        assert_eq!(
            score(n(&c["quote"]), n(&c["d"]), n(&c["d_best"]), u(&c["w_bps"])),
            n(&c["score"])
        );
    }
}

#[test]
fn epoch_chain_vectors() {
    let v = load();
    for chain in v["epoch_chains"].as_array().unwrap() {
        let p = params(&chain["params"]);
        let active: Vec<u32> = chain["active"].as_array().unwrap().iter().map(u).collect();
        let mut prev = [0u8; 32];
        let mut d = EdgeMap::new();
        for ep in chain["epochs"].as_array().unwrap() {
            assert_eq!(hex(&prev), ep["prev_fingerprint"].as_str().unwrap());
            assert_eq!(d, edges(&ep["conductivity_in"]));
            let mut flows = EdgeMap::new();
            let mut pool = 0u128;
            for pay in ep["payments"].as_array().unwrap() {
                let q = n(&pay[2]);
                *flows.entry(Edge::new(u(&pay[0]), u(&pay[1])).unwrap()).or_default() += q;
                pool += split_payment(q, p.fee_bps).unwrap().fee;
            }
            assert_eq!(pool, n(&ep["pool"]));
            let rejects: RejectMap = ep["rejects"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| (Edge::new(u(&t[0]), u(&t[1])).unwrap(), u(&t[2])))
                .collect();
            let out = close_epoch(
                &p,
                &EpochInput {
                    epoch: ep["epoch"].as_u64().unwrap(),
                    prev_fingerprint: prev,
                    active: &active,
                    conductivity: &d,
                    flows: &flows,
                    rejects: &rejects,
                    pool,
                },
            )
            .unwrap();
            let e = &ep["expect"];
            assert_eq!(out.canonical, e["canonical"].as_str().unwrap());
            assert_eq!(hex(&out.fingerprint), e["fingerprint"].as_str().unwrap());
            assert_eq!(out.conductivity, edges(&e["conductivity"]));
            assert_eq!(out.reputation.into_iter().collect::<Vec<_>>(), pairs(&e["reputation"]));
            assert_eq!(
                out.distribution.payouts.into_iter().collect::<Vec<_>>(),
                pairs(&e["payouts"])
            );
            assert_eq!(out.distribution.treasury, n(&e["treasury"]));
            d = out.conductivity;
            prev = out.fingerprint;
        }
    }
}

#[test]
fn market_allowance_state_and_glyph_vectors() {
    let v = load();
    for c in v["royalty_split"].as_array().unwrap() {
        let (seller, royalty) = royalty_split(n(&c["price"]), u(&c["royalty_bps"])).unwrap();
        assert_eq!((seller, royalty), (n(&c["seller"]), n(&c["royalty"])));
        assert_eq!(seller + royalty, n(&c["price"]));
    }
    for c in v["allowance"].as_array().unwrap() {
        let b = effective_budget(n(&c["owner_budget"]), n(&c["base_budget"]), n(&c["trust_gain"]), n(&c["reputation"]));
        assert_eq!(b, n(&c["effective"]));
    }
    let shipped = Allowance::shipped();
    assert_eq!(n(&v["allowance"][0]["base_budget"]), shipped.base_budget);
    assert_eq!(n(&v["allowance"][0]["trust_gain"]), shipped.trust_gain);
    let cases = v["spore_state"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let seed_hex = c["seed"].as_str().unwrap();
        let mut seed = [0u8; 32];
        for (i, b) in seed.iter_mut().enumerate() {
            *b = u8::from_str_radix(&seed_hex[2 * i..2 * i + 2], 16).unwrap();
        }
        let id = u(&c["id"]);
        let epoch = c["epoch"].as_u64().unwrap();
        let age = u(&c["age"]);
        let edges = pairs(&c["edges"]);
        assert_eq!(state::canonical(id, epoch, &seed, age, &edges), c["canonical"].as_str().unwrap());
        assert_eq!(hex(&state::state_hash(id, epoch, &seed, age, &edges)), c["state_hash"].as_str().unwrap());
        let active = c["active"].as_bool().unwrap();
        assert_eq!(glyph_svg(id, &seed, age, active, &edges), c["glyph"].as_str().unwrap());
    }
}
