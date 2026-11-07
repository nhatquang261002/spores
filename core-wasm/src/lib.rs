//! `spores-core-wasm`: the browser's copy of the epoch math, compiled from
//! `spores-core` itself so `viz` never re-implements it in JS.
//!
//! Two calls, JSON in and JSON out (u128 values are decimal strings):
//! - `replay`: `{params, epochs: [{epoch, prev_fingerprint?, active, flows,
//!   rejects, pool}]}`. Runs `spores_core::close_epoch` for each epoch in
//!   order, carrying the tubes forward from an empty graph and the fingerprint
//!   from GENESIS, as `verify` does. Returns `[{epoch, prev_fingerprint,
//!   fingerprint, tubes: [[a, b, D]], reputation: [[id, R]]}]`, where
//!   `prev_fingerprint` is the replayed one (callers compare it with the
//!   event's). Flows and rejects listed twice for one pair are summed, so
//!   per-payment lists work too.
//! - `state_hash`: `{spore_id, epoch, seed, age, edges: [[n, D]]}` →
//!   `{state_hash, canonical}` (`core/src/state.rs`).
//!
//! `params` is the router's `config` view, mapped exactly as `verify` maps it
//! (rebate rule `CappedRebate`), or a `params` object of `vectors/core.json`
//! (with `pool_rule`).
//!
//! wasm ABI (the pattern of `renderer/src/wasm.rs`): `alloc`/`dealloc` for the
//! input, then `replay(ptr, len)` or `state_hash(ptr, len)`, which return 0
//! (the result is JSON) or 1 (the result is an error message); read the result
//! with `result_ptr()` and `result_len()`. It stays valid until the next call.

use std::cell::RefCell;

use serde_json::{json, Value};
use spores_core::fingerprint::{hex, GENESIS};
use spores_core::{close_epoch, Edge, EdgeMap, EpochInput, Params, PoolRule, RejectMap, SporeId};

fn num(v: &Value, what: &str) -> Result<u128, String> {
    match v {
        Value::String(s) => s.parse().map_err(|_| format!("{what}: not a number: {s}")),
        Value::Number(n) => n.as_u64().map(u128::from).ok_or_else(|| format!("{what}: not a u64: {n}")),
        other => Err(format!("{what}: expected a number, got {other}")),
    }
}

fn small<T: TryFrom<u128>>(v: &Value, what: &str) -> Result<T, String> {
    T::try_from(num(v, what)?).map_err(|_| format!("{what}: out of range"))
}

fn unhex32(s: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 || !s.is_ascii() {
        return Err(format!("not 32 bytes of hex: {s}"));
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|_| format!("bad hex: {s}"))?;
    }
    Ok(out)
}

/// `Params` from the router's `config` view or a vectors `params` object.
pub fn params(v: &Value) -> Result<Params, String> {
    let u = |k: &str| small::<u32>(&v[k], k);
    let pool_rule = match v.get("pool_rule") {
        None => PoolRule::CappedRebate { rebate_bps: u("rebate_bps")? },
        Some(r) => match r["rule"].as_str() {
            Some("capped_rebate") => PoolRule::CappedRebate { rebate_bps: small(&r["rebate_bps"], "pool_rule.rebate_bps")? },
            Some("proportional") => PoolRule::Proportional,
            other => return Err(format!("unknown pool_rule {other:?}")),
        },
    };
    let p = Params {
        decay_bps: u("decay_bps")?,
        gain: num(&v["gain"], "gain")?,
        k: num(&v["k"], "k")?,
        d_min: num(&v["d_min"], "d_min")?,
        fee_bps: u("fee_bps")?,
        pool_rule,
        breadth_full: u("breadth_full")?,
        reject_bps: u("reject_bps")?,
    };
    p.validate().map_err(|e| e.to_string())?;
    Ok(p)
}

/// `[[a, b, x]]` → edge → x, summing pairs listed more than once.
fn edge_sums(v: &Value, what: &str) -> Result<EdgeMap, String> {
    let mut m = EdgeMap::new();
    for t in v.as_array().ok_or_else(|| format!("{what}: expected a list of [a, b, x]"))? {
        let e = Edge::new(small(&t[0], what)?, small(&t[1], what)?).map_err(|e| format!("{what}: {e}"))?;
        let x = num(&t[2], what)?;
        let slot = m.entry(e).or_insert(0);
        *slot = slot.checked_add(x).ok_or_else(|| format!("{what}: overflow"))?;
    }
    Ok(m)
}

fn tubes_json(m: &EdgeMap) -> Value {
    m.iter().map(|(e, d)| json!([e.a(), e.b(), d.to_string()])).collect()
}

/// Replays a run of consecutive epochs from GENESIS. See the crate docs.
pub fn replay(input: &Value) -> Result<Value, String> {
    let p = params(&input["params"]).map_err(|e| format!("params: {e}"))?;
    let epochs = input["epochs"].as_array().ok_or("epochs: expected a list")?;
    let mut d = EdgeMap::new();
    let mut prev = GENESIS;
    let mut last: Option<u64> = None;
    let mut out = Vec::with_capacity(epochs.len());
    for ev in epochs {
        let epoch = ev["epoch"].as_u64().ok_or("epoch: expected a number")?;
        if let Some(l) = last {
            if Some(epoch) != l.checked_add(1) {
                return Err(format!("epochs must be consecutive: {epoch} after {l}"));
            }
        }
        let active: Vec<SporeId> = ev["active"]
            .as_array()
            .ok_or_else(|| format!("epoch {epoch}: active: expected a list"))?
            .iter()
            .map(|x| small(x, "active"))
            .collect::<Result<_, _>>()?;
        let flows = edge_sums(&ev["flows"], "flows").map_err(|e| format!("epoch {epoch}: {e}"))?;
        let rejects: RejectMap = edge_sums(&ev["rejects"], "rejects")
            .map_err(|e| format!("epoch {epoch}: {e}"))?
            .into_iter()
            .map(|(e, n)| u32::try_from(n).map(|n| (e, n)).map_err(|_| format!("epoch {epoch}: rejects: out of range")))
            .collect::<Result<_, _>>()?;
        let pool = num(&ev["pool"], "pool").map_err(|e| format!("epoch {epoch}: {e}"))?;
        let o = close_epoch(
            &p,
            &EpochInput { epoch, prev_fingerprint: prev, active: &active, conductivity: &d, flows: &flows, rejects: &rejects, pool },
        )
        .map_err(|e| format!("epoch {epoch}: {e}"))?;
        out.push(json!({
            "epoch": epoch,
            "prev_fingerprint": hex(&prev),
            "fingerprint": hex(&o.fingerprint),
            "tubes": tubes_json(&o.conductivity),
            "reputation": o.reputation.iter().map(|(id, r)| json!([id, r.to_string()])).collect::<Vec<_>>(),
        }));
        d = o.conductivity;
        prev = o.fingerprint;
        last = Some(epoch);
    }
    Ok(Value::Array(out))
}

/// The per-spore state hash. See the crate docs.
pub fn state_hash(input: &Value) -> Result<Value, String> {
    let id: SporeId = small(&input["spore_id"], "spore_id")?;
    let epoch = input["epoch"].as_u64().ok_or("epoch: expected a number")?;
    let seed = unhex32(input["seed"].as_str().ok_or("seed: expected hex")?)?;
    let age: u32 = small(&input["age"], "age")?;
    let edges: Vec<(SporeId, u128)> = input["edges"]
        .as_array()
        .ok_or("edges: expected a list of [n, D]")?
        .iter()
        .map(|t| Ok((small(&t[0], "edges")?, num(&t[1], "edges")?)))
        .collect::<Result<_, String>>()?;
    Ok(json!({
        "state_hash": hex(&spores_core::state::state_hash(id, epoch, &seed, age, &edges)),
        "canonical": spores_core::state::canonical(id, epoch, &seed, age, &edges),
    }))
}

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Parses `len` bytes at `input`, runs `f` and stores its JSON (or error text).
///
/// # Safety
/// `input` must point to `len` readable bytes.
unsafe fn call(input: *const u8, len: usize, f: fn(&Value) -> Result<Value, String>) -> i32 {
    let bytes = std::slice::from_raw_parts(input, len);
    let (code, out) = match serde_json::from_slice::<Value>(bytes).map_err(|e| format!("bad JSON: {e}")).and_then(|v| f(&v)) {
        Ok(v) => (0, v.to_string()),
        Err(e) => (1, e),
    };
    RESULT.with(|r| *r.borrow_mut() = out.into_bytes());
    code
}

pub mod wasm {
    //! C ABI. Buffers come from `alloc`, so there is no shared state besides
    //! the last result.
    use super::{call, RESULT};

    #[no_mangle]
    pub extern "C" fn alloc(len: usize) -> *mut u8 {
        let mut v = Vec::<u8>::with_capacity(len);
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    /// # Safety
    /// `ptr` and `len` must come from a matching `alloc` call.
    #[no_mangle]
    pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }

    /// Epoch replay; 0 = ok (result is JSON), 1 = error (result is the message).
    ///
    /// # Safety
    /// `input` must point to `len` readable bytes.
    #[no_mangle]
    pub unsafe extern "C" fn replay(input: *const u8, len: usize) -> i32 {
        call(input, len, super::replay)
    }

    /// State hash; 0 = ok (result is JSON), 1 = error (result is the message).
    ///
    /// # Safety
    /// `input` must point to `len` readable bytes.
    #[no_mangle]
    pub unsafe extern "C" fn state_hash(input: *const u8, len: usize) -> i32 {
        call(input, len, super::state_hash)
    }

    #[no_mangle]
    pub extern "C" fn result_ptr() -> *const u8 {
        RESULT.with(|r| r.borrow().as_ptr())
    }

    #[no_mangle]
    pub extern "C" fn result_len() -> usize {
        RESULT.with(|r| r.borrow().len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../vectors/core.json")).unwrap()
    }

    /// The vectors' epoch chains as replay input (their `payments` are per-payment flows).
    fn chain_input(chain: &Value) -> Value {
        let epochs: Vec<Value> = chain["epochs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                json!({"epoch": e["epoch"], "prev_fingerprint": e["prev_fingerprint"], "active": chain["active"],
                       "flows": e["payments"], "rejects": e["rejects"], "pool": e["pool"]})
            })
            .collect();
        json!({"params": chain["params"], "epochs": epochs})
    }

    #[test]
    fn replays_the_vector_chains() {
        let v = vectors();
        for chain in v["epoch_chains"].as_array().unwrap() {
            let out = replay(&chain_input(chain)).unwrap();
            let want = chain["epochs"].as_array().unwrap();
            assert_eq!(out.as_array().unwrap().len(), want.len());
            for (got, want) in out.as_array().unwrap().iter().zip(want) {
                assert_eq!(got["fingerprint"], want["expect"]["fingerprint"]);
                assert_eq!(got["prev_fingerprint"], want["prev_fingerprint"]);
                assert_eq!(got["tubes"], want["expect"]["conductivity"]);
                assert_eq!(got["reputation"], want["expect"]["reputation"]);
            }
        }
    }

    #[test]
    fn router_config_maps_to_the_shipped_params() {
        let config = json!({"supply_cap": 64, "max_active": 64, "decay_bps": 2500, "gain": "1000000",
            "k": "100000000000000000000000", "d_min": "50000", "fee_bps": 100, "rebate_bps": 5000,
            "breadth_full": 4, "reject_bps": 5000, "royalty_account": null});
        assert_eq!(params(&config).unwrap(), Params::shipped());
        assert_eq!(params(&vectors()["params"]["spec"]).unwrap(), Params::spec());
        assert!(params(&json!({"decay_bps": 0})).is_err());
    }

    #[test]
    fn hashes_the_vector_states() {
        for s in vectors()["spore_state"].as_array().unwrap() {
            let input = json!({"spore_id": s["id"], "epoch": s["epoch"], "seed": s["seed"], "age": s["age"], "edges": s["edges"]});
            let out = state_hash(&input).unwrap();
            assert_eq!(out["state_hash"], s["state_hash"]);
            assert_eq!(out["canonical"], s["canonical"]);
        }
    }

    #[test]
    fn refuses_bad_input() {
        let p = vectors()["params"]["shipped"].clone();
        let ep = |e: u64, active: Value, flows: Value| json!({"epoch": e, "active": active, "flows": flows, "rejects": [], "pool": "0"});
        let gap = json!({"params": p, "epochs": [ep(1, json!([1, 2]), json!([])), ep(3, json!([1, 2]), json!([]))]});
        assert_eq!(replay(&gap).unwrap_err(), "epochs must be consecutive: 3 after 1");
        let inactive = json!({"params": p, "epochs": [ep(1, json!([1, 2]), json!([[1, 9, "5"]]))]});
        assert_eq!(replay(&inactive).unwrap_err(), "epoch 1: spore 9 is not active");
        let no_pool = json!({"params": p, "epochs": [{"epoch": 1, "active": [], "flows": [], "rejects": []}]});
        assert!(replay(&no_pool).unwrap_err().contains("pool"));
        assert!(state_hash(&json!({"spore_id": 1, "epoch": 1, "seed": "zz", "age": 0, "edges": []})).is_err());
    }

    #[test]
    fn abi_round_trip() {
        let input = br#"{"spore_id":7,"epoch":0,"seed":"0b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186","age":0,"edges":[]}"#;
        let code = unsafe { wasm::state_hash(input.as_ptr(), input.len()) };
        let out = unsafe { std::slice::from_raw_parts(wasm::result_ptr(), wasm::result_len()) };
        assert_eq!(code, 0);
        let v: Value = serde_json::from_slice(out).unwrap();
        assert_eq!(v["state_hash"], "721fde33283d094203beb9c1abc6cb66ba16eb5920c23d218f2acde598142501");
        let code = unsafe { wasm::replay(b"{".as_ptr(), 1) };
        let out = unsafe { std::slice::from_raw_parts(wasm::result_ptr(), wasm::result_len()) };
        assert_eq!(code, 1);
        assert!(std::str::from_utf8(out).unwrap().starts_with("bad JSON"));
    }
}
