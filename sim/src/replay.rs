//! `replay-decisions FILE`: re-checks every hire in an agent decision log
//! (`decisions.jsonl`, one JSON object per line) against
//! `spores_core::hiring`. The agents run a TypeScript port of the rule, so this
//! is the cross-check that the port chose what the Rust rule would have.

use serde_json::Value;
use spores_core::hiring::{d_norm, pick, score, Norm, Quote};

fn num(v: &Value, what: &str) -> Result<u128, String> {
    match v {
        Value::String(s) => s.parse().map_err(|_| format!("{what}: not a number: {s}")),
        Value::Number(n) => n.as_u64().map(u128::from).ok_or_else(|| format!("{what}: not a u64: {n}")),
        _ => Err(format!("{what}: missing")),
    }
}

fn norm(v: &Value) -> Result<Norm, String> {
    match v {
        Value::String(s) if s == "relative" => Ok(Norm::Relative),
        Value::Object(o) if o.contains_key("absolute") => Ok(Norm::Absolute(num(&o["absolute"], "norm.absolute")?)),
        _ => Err(format!("unknown norm {v}")),
    }
}

/// Checks one decision; `Ok` carries nothing, `Err` says what differs.
pub fn check(d: &Value) -> Result<(), String> {
    let rule = &d["rule"];
    let w_bps = num(&rule["w_bps"], "rule.w_bps")? as u32;
    let norm = norm(&rule["norm"])?;
    let cands = d["candidates"].as_array().ok_or("candidates missing")?;
    let mut quotes = Vec::with_capacity(cands.len());
    for c in cands {
        quotes.push(Quote {
            provider: num(&c["provider"], "provider")? as u32,
            price: num(&c["price"], "price")?,
            d: num(&c["d"], "d")?,
        });
    }
    let reference = match norm {
        Norm::Absolute(r) => r,
        Norm::Relative => quotes.iter().map(|q| q.d).max().unwrap_or(0),
    };
    for (c, q) in cands.iter().zip(&quotes) {
        let (want_n, want_s) = (d_norm(q.d, reference), score(q.price, q.d, reference, w_bps));
        if num(&c["d_norm"], "d_norm")? != want_n || num(&c["score"], "score")? != want_s {
            return Err(format!(
                "provider {}: logged d_norm/score {}/{} but core gives {want_n}/{want_s}",
                q.provider, c["d_norm"], c["score"]
            ));
        }
    }
    let want = pick(&quotes, w_bps, norm).map(|i| quotes[i].provider);
    let got = if d["winner"].is_null() {
        None
    } else {
        Some(num(&d["winner"], "winner")? as u32)
    };
    if want != got {
        return Err(format!("winner {got:?} but core picks {want:?}"));
    }
    Ok(())
}

/// Returns (checked, failures as "line N: reason").
pub fn replay(text: &str) -> (usize, Vec<String>) {
    let mut checked = 0;
    let mut failures = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        checked += 1;
        let result = serde_json::from_str::<Value>(line).map_err(|e| e.to_string()).and_then(|d| check(&d));
        if let Err(e) = result {
            failures.push(format!("line {}: {e}", i + 1));
        }
    }
    (checked, failures)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"rule":{"w_bps":10000,"norm":"relative"},"candidates":[{"provider":5,"price":"100","d":"0","d_norm":"0","score":"100"},{"provider":9,"price":"150","d":"80000","d_norm":"1000000","score":"75"}],"winner":9}"#;

    #[test]
    fn accepts_a_matching_decision_and_rejects_a_wrong_winner() {
        assert_eq!(replay(GOOD), (1, vec![]));
        let bad = GOOD.replace("\"winner\":9", "\"winner\":5");
        let (n, f) = replay(&bad);
        assert_eq!(n, 1);
        assert!(f[0].contains("core picks Some(9)"), "{f:?}");
        let bad_score = GOOD.replace("\"score\":\"75\"", "\"score\":\"74\"");
        assert_eq!(replay(&bad_score).1.len(), 1);
        let empty = r#"{"rule":{"w_bps":40000,"norm":"relative"},"candidates":[],"winner":null}"#;
        assert_eq!(replay(empty), (1, vec![]));
    }
}
