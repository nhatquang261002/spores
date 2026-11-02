//! `spores-verify` (SPEC §10): checks the router's epoch history and committed
//! images using chain data only, with the same `spores-core` and
//! `spores-renderer` code the router and `sim` run.
//!
//! ```text
//! spores-verify epochs --router <account> --closes <file>... [--signer <account>]
//! spores-verify image  --router <account> --closes <file>... --spore <id> [--signer <account>]
//! ```
//!
//! `--closes` takes keeper `events.jsonl` files (their `close_epoch` lines) or
//! files with one transaction hash per line. Each close transaction is fetched
//! by RPC, its `epoch_closed` event (the epoch's full input) is replayed with
//! `spores_core::close_epoch` under the router's `config`, and the result is
//! compared with the event and with the router's `fingerprint(epoch)` view.
//! The closes must run from the router's first epoch (1) without gaps.
//!
//! `image` rebuilds the spore's state at the epoch of its `image_commit` from
//! the replayed tubes, checks the committed state hash, renders it and
//! compares the image hash.
//!
//! RPC: `NEAR_RPCS` (comma-separated) or FastNEAR, dRPC, then NEAR's archival
//! node, which still has transactions the others have garbage-collected.
//! Requests go through `curl`.

use std::collections::BTreeMap;
use std::process::{Command, ExitCode};
use std::thread::sleep;
use std::time::Duration;

use serde_json::{json, Value};
use spores_core::fingerprint::{hex, GENESIS};
use spores_core::{close_epoch, Edge, EdgeMap, EpochInput, Params, PoolRule, RejectMap, SporeId};

const DEFAULT_RPCS: [&str; 3] = [
    "https://test.rpc.fastnear.com",
    "https://near-testnet.drpc.org",
    "https://archival-rpc.testnet.near.org",
];

struct Rpc {
    urls: Vec<String>,
}

impl Rpc {
    fn from_env() -> Self {
        let urls = std::env::var("NEAR_RPCS")
            .ok()
            .map(|s| s.split(',').map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).collect::<Vec<_>>())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_RPCS.iter().map(|s| s.to_string()).collect());
        Rpc { urls }
    }

    /// Tries each endpoint in turn; retries one endpoint with backoff on rate
    /// limits and garbled responses, moves on for any other error (for example
    /// a transaction a non-archival node no longer has).
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({ "jsonrpc": "2.0", "id": "verify", "method": method, "params": params }).to_string();
        let mut last = String::new();
        for url in &self.urls {
            for attempt in 0..5u32 {
                let out = Command::new("curl")
                    .args(["-s", "-m", "30", "-H", "content-type: application/json", "--data-binary", &body, url])
                    .output()
                    .map_err(|e| format!("cannot run curl: {e}"))?;
                let text = String::from_utf8_lossy(&out.stdout);
                let Ok(v) = serde_json::from_str::<Value>(&text) else {
                    last = format!("{url}: unreadable response {:.80}", text.trim());
                    sleep(Duration::from_millis(500 << attempt));
                    continue;
                };
                if let Some(r) = v.get("result") {
                    if let Some(e) = r.get("error") {
                        return Err(format!("{url}: {e}"));
                    }
                    return Ok(r.clone());
                }
                let err = v.get("error").map(|e| e.to_string()).unwrap_or_else(|| text.to_string());
                last = format!("{url}: {err}");
                if err.contains("429") || err.contains("TOO_MANY") || err.contains("TIMEOUT") {
                    sleep(Duration::from_millis(500 << attempt));
                    continue;
                }
                break;
            }
        }
        Err(last)
    }

    fn view(&self, contract: &str, method: &str, args: Value) -> Result<Value, String> {
        let r = self.call(
            "query",
            json!({
                "request_type": "call_function", "finality": "final", "account_id": contract,
                "method_name": method, "args_base64": base64(args.to_string().as_bytes()),
            }),
        )?;
        let bytes: Vec<u8> = r["result"]
            .as_array()
            .ok_or_else(|| format!("{method}: no result"))?
            .iter()
            .map(|b| b.as_u64().unwrap_or(0) as u8)
            .collect();
        serde_json::from_slice(&bytes).map_err(|e| format!("{method}: {e}"))
    }

    fn tx(&self, hash: &str, signer: &str) -> Result<Value, String> {
        self.call("tx", json!({ "tx_hash": hash, "sender_account_id": signer, "wait_until": "FINAL" }))
    }
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                s.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

fn num(v: &Value) -> Result<u128, String> {
    match v {
        Value::String(s) => s.parse().map_err(|_| format!("not a number: {s}")),
        Value::Number(n) => n.as_u64().map(u128::from).ok_or_else(|| format!("not a u64: {n}")),
        other => Err(format!("not a number: {other}")),
    }
}

fn unhex32(s: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 {
        return Err(format!("not 32 bytes of hex: {s}"));
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|_| format!("bad hex: {s}"))?;
    }
    Ok(out)
}

fn edge_map(v: &Value) -> Result<EdgeMap, String> {
    let mut m = EdgeMap::new();
    for t in v.as_array().ok_or("expected a list of [a, b, x]")? {
        let e = Edge::new(num(&t[0])? as SporeId, num(&t[1])? as SporeId).map_err(|e| e.to_string())?;
        m.insert(e, num(&t[2])?);
    }
    Ok(m)
}

/// The router's `Config::params()`, from its `config` view.
fn params(config: &Value) -> Result<Params, String> {
    let u = |k: &str| num(&config[k]).map(|x| x as u32);
    let p = Params {
        decay_bps: u("decay_bps")?,
        gain: num(&config["gain"])?,
        k: num(&config["k"])?,
        d_min: num(&config["d_min"])?,
        fee_bps: u("fee_bps")?,
        pool_rule: PoolRule::CappedRebate { rebate_bps: u("rebate_bps")? },
        breadth_full: u("breadth_full")?,
        reject_bps: u("reject_bps")?,
    };
    p.validate().map_err(|e| e.to_string())?;
    Ok(p)
}

/// Close transaction hashes from keeper logs or plain hash lists, in file order, deduplicated.
fn close_hashes(files: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for f in files {
        let text = std::fs::read_to_string(f).map_err(|e| format!("{f}: {e}"))?;
        for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let hash = if line.starts_with('{') {
                let v: Value = serde_json::from_str(line).map_err(|e| format!("{f}: {e}"))?;
                if v["method"] != "close_epoch" || v["ok"] != true {
                    continue;
                }
                v["hash"].as_str().map(str::to_string)
            } else {
                Some(line.to_string())
            };
            if let Some(h) = hash {
                if !out.contains(&h) {
                    out.push(h);
                }
            }
        }
    }
    Ok(out)
}

fn epoch_closed_event(tx: &Value) -> Option<Value> {
    for r in tx["receipts_outcome"].as_array()? {
        for log in r["outcome"]["logs"].as_array()? {
            let Some(body) = log.as_str().and_then(|l| l.strip_prefix("EVENT_JSON:")) else { continue };
            let Ok(ev) = serde_json::from_str::<Value>(body) else { continue };
            if ev["standard"] == "spores" && ev["event"] == "epoch_closed" {
                return Some(ev["data"][0].clone());
            }
        }
    }
    None
}

struct Replay {
    /// Tubes in force during epoch `e` (after the close of `e - 1`).
    tubes_during: BTreeMap<u64, EdgeMap>,
    epochs: usize,
    mismatches: usize,
}

fn replay(rpc: &Rpc, router: &str, signer: &str, files: &[String]) -> Result<Replay, String> {
    let p = params(&rpc.view(router, "config", json!({}))?)?;
    let hashes = close_hashes(files)?;
    if hashes.is_empty() {
        return Err("no close_epoch transactions in --closes".into());
    }
    let mut events: BTreeMap<u64, (String, Value)> = BTreeMap::new();
    for h in &hashes {
        let tx = rpc.tx(h, signer).map_err(|e| format!("tx {h}: {e}"))?;
        if tx["transaction"]["receiver_id"] != router {
            return Err(format!("tx {h} was sent to {}, not {router}", tx["transaction"]["receiver_id"]));
        }
        let ev = epoch_closed_event(&tx).ok_or_else(|| format!("tx {h}: no epoch_closed event"))?;
        let e = ev["epoch"].as_u64().ok_or_else(|| format!("tx {h}: event has no epoch"))?;
        if events.insert(e, (h.clone(), ev)).is_some() {
            return Err(format!("two closes for epoch {e}"));
        }
    }
    let first = *events.keys().next().unwrap();
    if first != 1 {
        return Err(format!("the closes must start at the router's first epoch (1); the earliest given is {first}"));
    }

    let mut d = EdgeMap::new();
    let mut prev = GENESIS;
    let mut r = Replay { tubes_during: BTreeMap::from([(1, EdgeMap::new())]), epochs: 0, mismatches: 0 };
    for (expected, (e, (hash, ev))) in (1u64..).zip(&events) {
        if *e != expected {
            return Err(format!("no close for epoch {expected} (next given is {e})"));
        }
        let active: Vec<SporeId> = ev["active"]
            .as_array()
            .ok_or("event has no active list (a router from before Phase 5?)")?
            .iter()
            .map(|x| num(x).map(|n| n as SporeId))
            .collect::<Result<_, _>>()?;
        let flows = edge_map(&ev["flows"])?;
        let rejects: RejectMap = edge_map(&ev["rejects"])?.into_iter().map(|(k, n)| (k, n as u32)).collect();
        let out = close_epoch(
            &p,
            &EpochInput {
                epoch: *e,
                prev_fingerprint: prev,
                active: &active,
                conductivity: &d,
                flows: &flows,
                rejects: &rejects,
                pool: num(&ev["pool"])?,
            },
        )
        .map_err(|err| format!("epoch {e}: {err}"))?;
        let fp = hex(&out.fingerprint);
        let on_chain = rpc.view(router, "fingerprint", json!({ "epoch": e }))?;
        let mut bad = Vec::new();
        if ev["prev_fingerprint"].as_str() != Some(hex(&prev).as_str()) {
            bad.push("prev fingerprint");
        }
        if ev["fingerprint"].as_str() != Some(fp.as_str()) {
            bad.push("event fingerprint");
        }
        if on_chain.as_str() != Some(fp.as_str()) {
            bad.push("stored fingerprint");
        }
        if edge_map(&ev["tubes"])? != out.conductivity {
            bad.push("tubes");
        }
        if bad.is_empty() {
            println!("epoch {e}: {fp} match ({} flows, {} tubes, close {hash})", flows.len(), out.conductivity.len());
        } else {
            r.mismatches += 1;
            println!("epoch {e}: replay {fp} MISMATCH in {} (close {hash})", bad.join(", "));
        }
        r.epochs += 1;
        d = out.conductivity;
        prev = out.fingerprint;
        r.tubes_during.insert(e + 1, d.clone());
    }
    let head = rpc.view(router, "epoch_info", json!({}))?;
    if head["epoch"].as_u64() == Some(r.epochs as u64 + 1) && head["prev_fingerprint"].as_str() != Some(hex(&prev).as_str()) {
        r.mismatches += 1;
        println!("router head: prev_fingerprint {} MISMATCH", head["prev_fingerprint"]);
    }
    Ok(r)
}

fn verify_image(rpc: &Rpc, router: &str, spore: SporeId, r: &Replay) -> Result<bool, String> {
    let commit = rpc.view(router, "image_commit", json!({ "spore_id": spore }))?;
    if commit.is_null() {
        return Err(format!("spore {spore} has no committed image"));
    }
    let epoch = commit["epoch"].as_u64().ok_or("commit has no epoch")?;
    let tubes = r
        .tubes_during
        .get(&epoch)
        .ok_or_else(|| format!("the image is for epoch {epoch}; pass closes up to epoch {}", epoch - 1))?;
    let summary = rpc.view(router, "spore_summary", json!({ "spore_id": spore }))?;
    let current = rpc.view(router, "epoch_info", json!({}))?["epoch"].as_u64().ok_or("no epoch")?;
    let activated = current - summary["age"].as_u64().ok_or("no age")?;
    let age = (epoch - activated) as u32;
    let seed = unhex32(summary["seed"].as_str().ok_or("no seed")?)?;
    let conns: Vec<(SporeId, u128)> = tubes.iter().filter_map(|(e, d)| e.other(spore).map(|n| (n, *d))).collect();

    let state = hex(&spores_core::state::state_hash(spore, epoch, &seed, age, &conns));
    let edges: Vec<(u32, u64)> = conns.iter().map(|(n, d)| (*n, (*d).min(u64::MAX as u128) as u64)).collect();
    let rgb = spores_renderer::render(&spores_renderer::Spore::new(seed, age, edges));
    let image = hex(&spores_renderer::image_hash(&rgb));
    let version = commit["renderer_version"].as_u64().unwrap_or(0) as u32;

    let mut ok = true;
    for (what, mine, theirs) in [
        ("state hash", state.as_str(), commit["state_hash"].as_str().unwrap_or("")),
        ("image hash", image.as_str(), commit["image_hash"].as_str().unwrap_or("")),
    ] {
        let m = mine == theirs;
        ok &= m;
        println!("spore {spore} epoch {epoch} {what}: {mine} {}", if m { "match" } else { "MISMATCH" });
    }
    if version != spores_renderer::RENDERER_VERSION {
        ok = false;
        println!(
            "spore {spore}: committed with renderer v{version}, this build is v{} MISMATCH",
            spores_renderer::RENDERER_VERSION
        );
    }
    println!("spore {spore}: age {age}, {} tubes, renderer v{}", conns.len(), spores_renderer::RENDERER_VERSION);
    Ok(ok)
}

fn usage() -> ExitCode {
    eprintln!(
        "usage: spores-verify epochs --router <account> --closes <file>... [--signer <account>]\n       \
         spores-verify image  --router <account> --closes <file>... --spore <id> [--signer <account>]"
    );
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().cloned() else { return usage() };
    let (mut router, mut signer, mut spore, mut closes) = (None, None, None, Vec::new());
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--router" => router = args.get(i + 1).cloned(),
            "--signer" => signer = args.get(i + 1).cloned(),
            "--spore" => spore = args.get(i + 1).and_then(|s| s.parse::<SporeId>().ok()),
            "--closes" => {
                while i + 1 < args.len() && !args[i + 1].starts_with("--") {
                    closes.push(args[i + 1].clone());
                    i += 1;
                }
                i += 1;
                continue;
            }
            _ => return usage(),
        }
        i += 2;
    }
    let Some(router) = router else { return usage() };
    if closes.is_empty() || (cmd == "image" && spore.is_none()) || !(cmd == "epochs" || cmd == "image") {
        return usage();
    }
    let rpc = Rpc::from_env();
    let run = || -> Result<bool, String> {
        // The keeper's function-call key is on the admin account.
        let signer = match signer {
            Some(s) => s,
            None => rpc.view(&router, "admin", json!({}))?.as_str().ok_or("no admin")?.to_string(),
        };
        let r = replay(&rpc, &router, &signer, &closes)?;
        let epochs_ok = r.mismatches == 0;
        println!("verified {} epochs on {router}: {}", r.epochs, if epochs_ok { "match" } else { "MISMATCH" });
        if cmd == "image" {
            let image_ok = verify_image(&rpc, &router, spore.unwrap(), &r)?;
            println!("image: {}", if image_ok { "match" } else { "MISMATCH" });
            return Ok(epochs_ok && image_ok);
        }
        Ok(epochs_ok)
    };
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_answers() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"{\"spore_id\":3}"), "eyJzcG9yZV9pZCI6M30=");
    }

    #[test]
    fn close_hashes_reads_keeper_logs_and_plain_lists() {
        let dir = std::env::temp_dir().join(format!("spores-verify-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("events.jsonl");
        std::fs::write(
            &log,
            "{\"method\":\"close_epoch\",\"hash\":\"A\",\"ok\":true}\n\
             {\"method\":\"close_epoch\",\"hash\":\"B\",\"ok\":false}\n\
             {\"method\":\"settle\",\"hash\":\"C\",\"ok\":true}\n\
             {\"method\":\"close_epoch\",\"hash\":\"A\",\"ok\":true}\n",
        )
        .unwrap();
        let list = dir.join("closes.txt");
        std::fs::write(&list, "D\n\nA\n").unwrap();
        let files = [log.display().to_string(), list.display().to_string()];
        assert_eq!(close_hashes(&files).unwrap(), vec!["A", "D"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn params_follow_the_router_config_view() {
        let config = json!({
            "decay_bps": 2500, "gain": "1000000", "k": "100000000000000000000000", "d_min": "50000",
            "fee_bps": 100, "rebate_bps": 5000, "breadth_full": 4, "reject_bps": 5000,
        });
        assert_eq!(params(&config).unwrap(), Params::shipped());
    }
}
