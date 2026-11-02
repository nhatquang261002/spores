//! One simulated run of the spore economy. Every money decision (quote choice,
//! fee, graph update, pool payout) goes through `spores_core`; floats appear
//! only in hidden provider quality and in the metrics.

use std::collections::BTreeMap;

use spores_core::allowance::Allowance;
use spores_core::fee::split_payment;
use spores_core::fingerprint::{hex, GENESIS};
use spores_core::graph::{edge_gain, reputation, saturation};
use spores_core::hiring::{pick, Norm, Quote};
use spores_core::market::{job_service, next_margin, quote_price, MARGIN_START};
use spores_core::math::{BPS, ONE, REP_ONE};
use spores_core::{close_epoch, Edge, EdgeMap, EpochInput, Params, RejectMap, SporeId, NEAR};

use crate::rng::{stream, Rng, Unit};

pub const START_BALANCE: u128 = 1_000 * NEAR;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    PriceOnly,
    /// `D_norm = min(D / (d_max * ref_bps / 10000), 1)`.
    Tubes {
        w_bps: u32,
        ref_bps: u32,
    },
    /// `D_norm = D / strongest candidate tube`.
    TubesRelative {
        w_bps: u32,
    },
}

impl Mode {
    pub const fn tubes(w_bps: u32) -> Self {
        Mode::Tubes { w_bps, ref_bps: 10_000 }
    }

    fn rule(self, p: &Params) -> (u32, Norm) {
        match self {
            Mode::PriceOnly => (0, Norm::Relative),
            Mode::Tubes { w_bps, ref_bps } => (w_bps, Norm::Absolute(p.d_max() * ref_bps as u128 / BPS)),
            Mode::TubesRelative { w_bps } => (w_bps, Norm::Relative),
        }
    }
}

/// Epochs at which each scripted shock fires.
#[derive(Clone, Copy, Debug, Default)]
pub struct Shocks {
    /// The best-value provider's agent stops (no quotes, no jobs).
    pub kill: Option<u64>,
    /// The strongest tube is cut to zero.
    pub cut: Option<u64>,
    /// The second-best-value provider's cost triples.
    pub raise: Option<u64>,
}

/// One owner's spores paying each other in a loop every epoch.
#[derive(Clone, Copy, Debug)]
pub struct Attack {
    pub spores: u32,
    /// Settled volume per loop edge per epoch, yoctoNEAR.
    pub volume: u128,
    /// Payments per edge per epoch.
    pub payments: u32,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub params: Params,
    pub mode: Mode,
    pub seed: u64,
    pub epochs: u64,
    pub collection: u32,
    pub active: u32,
    pub services: u32,
    pub jobs_per_consumer: u32,
    pub attempts: u32,
    pub shocks: Shocks,
    pub attack: Option<Attack>,
    /// Living-allowance ceiling on each spore's settled spend per epoch
    /// (owner budget unlimited). `None` reproduces the Phase 1 runs.
    pub allowance: Option<Allowance>,
}

impl Config {
    pub fn new(params: Params, mode: Mode, seed: u64) -> Self {
        Config {
            params,
            mode,
            seed,
            epochs: 60,
            collection: 64,
            active: 16,
            services: 4,
            jobs_per_consumer: 3,
            attempts: 2,
            shocks: Shocks::default(),
            attack: None,
            allowance: None,
        }
    }
}

#[derive(Clone, Debug)]
struct Agent {
    service: u32,
    cost: u128,
    quality: f64,
    margin_bps: u32,
    alive: bool,
    wins: u32,
}

impl Agent {
    fn quote(&self) -> u128 {
        quote_price(self.cost, self.margin_bps)
    }
}

#[derive(Clone, Debug, Default)]
pub struct EpochStats {
    pub jobs: u32,
    pub attempts: u32,
    pub failures: u32,
    pub unfulfilled: u32,
    pub settled: u32,
    /// Hires skipped because the payment would exceed the allowance.
    pub budget_blocked: u32,
    pub paid: u128,
    pub hired_quality: f64,
    pub fees: u128,
    pub rebates: u128,
    pub edges: usize,
}

impl EpochStats {
    pub fn success_rate(&self) -> f64 {
        if self.attempts == 0 {
            1.0
        } else {
            1.0 - self.failures as f64 / self.attempts as f64
        }
    }
}

/// Costs and gains on the edges inside one group of spores, over the
/// measurement window (second half of the run). Money in NEAR, `D` in units of
/// `ONE`, reputation in units of `REP_ONE`.
#[derive(Clone, Debug, Default)]
pub struct Group {
    pub epochs: u32,
    pub fees: f64,
    pub rebates: f64,
    pub tube_gain: f64,
    /// Sum over epochs and over the group's spores of `R`.
    pub rep: f64,
    /// Sum over epochs of `R`, per spore.
    pub rep_by_spore: BTreeMap<SporeId, f64>,
}

impl Group {
    pub fn net_cost(&self) -> f64 {
        self.fees - self.rebates
    }

    fn per_near(&self, x: f64) -> f64 {
        if self.net_cost() <= 0.0 {
            f64::INFINITY
        } else {
            x / self.net_cost()
        }
    }

    /// Tube conductivity added per NEAR of net cost.
    pub fn tube_per_near(&self) -> f64 {
        self.per_near(self.tube_gain)
    }

    /// Reputation held per NEAR of net cost (both summed over spores and
    /// epochs, so the ratio is per spore-epoch).
    pub fn rep_per_near(&self) -> f64 {
        self.per_near(self.rep)
    }

    /// Each spore's mean `R` over the window, ascending.
    fn spore_means(&self) -> Vec<f64> {
        let mut v: Vec<f64> = self
            .rep_by_spore
            .values()
            .map(|r| r / self.epochs.max(1) as f64)
            .collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v
    }

    pub fn median_rep(&self) -> f64 {
        let v = self.spore_means();
        if v.is_empty() {
            0.0
        } else if v.len() % 2 == 1 {
            v[v.len() / 2]
        } else {
            (v[v.len() / 2 - 1] + v[v.len() / 2]) / 2.0
        }
    }

    pub fn max_rep(&self) -> f64 {
        self.spore_means().last().copied().unwrap_or(0.0)
    }
}

#[derive(Clone, Debug)]
pub struct Run {
    pub stats: Vec<EpochStats>,
    pub attacker: Group,
    pub honest_group: Group,
    /// Rebates received minus fees paid on the attacker's loop, whole run, yocto.
    pub attacker_net: i128,
    /// Set when the attack could not run (a one-spore loop is a self-payment).
    pub attack_error: Option<String>,
    /// Fingerprint of the last epoch; it commits to the whole graph history.
    pub last_fingerprint: String,
}

pub fn run(cfg: &Config) -> Run {
    let p = cfg.params;
    let mut rng = Rng::new(cfg.seed);

    // Active spores are a seeded sample of the collection.
    let mut ids: Vec<SporeId> = (0..cfg.collection).collect();
    rng.shuffle(&mut ids);
    let mut active: Vec<SporeId> = ids[..cfg.active as usize].to_vec();
    let k = cfg.attack.map_or(0, |a| a.spores) as usize;
    let mut attackers: Vec<SporeId> = active[..k].to_vec();
    attackers.sort_unstable();
    let mut honest: Vec<SporeId> = active[k..].to_vec();
    honest.sort_unstable();
    active.sort_unstable();

    let mut agents: BTreeMap<SporeId, Agent> = BTreeMap::new();
    for (i, id) in honest.iter().enumerate() {
        let cost_milli = 30 + rng.below(121) as u128; // 0.030 to 0.150 NEAR
        agents.insert(
            *id,
            Agent {
                service: i as u32 % cfg.services,
                cost: cost_milli * NEAR / 1_000,
                quality: 0.5 + 0.48 * rng.unit(),
                margin_bps: MARGIN_START,
                alive: true,
                wins: 0,
            },
        );
    }
    // Shock targets: best and second-best quality per unit of cost.
    let mut by_value: Vec<SporeId> = honest.clone();
    by_value.sort_by(|a, b| {
        let v = |id: &SporeId| agents[id].quality / agents[id].cost as f64;
        v(b).partial_cmp(&v(a)).unwrap().then(a.cmp(b))
    });
    let (star, runner_up) = (by_value[0], by_value[1]);

    let mut attack_edges: Vec<(SporeId, SporeId, u128)> = Vec::new();
    let mut attack_error = None;
    if let Some(a) = cfg.attack {
        match attackers.len() {
            0 => {}
            1 => attack_error = Edge::new(attackers[0], attackers[0]).err().map(|e| e.to_string()),
            2 => {
                attack_edges.push((attackers[0], attackers[1], a.volume / 2));
                attack_edges.push((attackers[1], attackers[0], a.volume - a.volume / 2));
            }
            n => {
                for i in 0..n {
                    attack_edges.push((attackers[i], attackers[(i + 1) % n], a.volume));
                }
            }
        }
    }

    let mut balances: BTreeMap<SporeId, u128> = active.iter().map(|id| (*id, START_BALANCE)).collect();
    let total_money = START_BALANCE * active.len() as u128;
    let mut treasury = 0u128;
    let mut conductivity = EdgeMap::new();
    let mut prev = GENESIS;
    let mut stats = Vec::with_capacity(cfg.epochs as usize);
    let mut attacker = Group::default();
    let mut honest_group = Group::default();
    let mut attacker_net: i128 = 0;
    let (w_bps, norm) = cfg.mode.rule(&p);

    for t in 0..cfg.epochs {
        if cfg.shocks.kill == Some(t) {
            agents.get_mut(&star).unwrap().alive = false;
        }
        if cfg.shocks.cut == Some(t) {
            let strongest = conductivity
                .iter()
                .max_by(|x, y| x.1.cmp(y.1).then(y.0.cmp(x.0)))
                .map(|(e, _)| *e);
            if let Some(e) = strongest {
                conductivity.remove(&e);
            }
        }
        if cfg.shocks.raise == Some(t) {
            agents.get_mut(&runner_up).unwrap().cost *= 3;
        }

        let mut st = EpochStats::default();
        let mut flows = EdgeMap::new();
        let mut rejects = RejectMap::new();
        let mut edge_fees: BTreeMap<Edge, u128> = BTreeMap::new();
        let mut pool = 0u128;
        let rep = reputation(&conductivity);
        let cap = |id: SporeId| {
            cfg.allowance
                .map_or(u128::MAX, |a| a.effective(u128::MAX, rep.get(&id).copied().unwrap_or(0)))
        };
        let mut spent: BTreeMap<SporeId, u128> = BTreeMap::new();
        let mut pay = |from: SporeId, to: SporeId, amount: u128, flows: &mut EdgeMap| -> u128 {
            let e = Edge::new(from, to).expect("distinct spores");
            let split = split_payment(amount, p.fee_bps).expect("valid fee");
            let bal = balances.get_mut(&from).unwrap();
            *bal = bal.checked_sub(amount).expect("payer has funds");
            *balances.get_mut(&to).unwrap() += split.forwarded;
            *flows.entry(e).or_default() += amount;
            *edge_fees.entry(e).or_default() += split.fee;
            pool += split.fee;
            split.fee
        };

        for &c in &honest {
            if !agents[&c].alive {
                continue;
            }
            let own = agents[&c].service;
            for j in 0..cfg.jobs_per_consumer {
                let service = job_service(cfg.seed, t, c as u64, j as u64, cfg.services, own);
                st.jobs += 1;
                let mut tried: Vec<SporeId> = Vec::new();
                let mut done = false;
                for attempt in 0..cfg.attempts {
                    let quotes: Vec<Quote> = honest
                        .iter()
                        .filter(|id| **id != c && !tried.contains(id))
                        .filter(|id| agents[*id].alive && agents[*id].service == service)
                        .map(|id| Quote {
                            provider: *id,
                            price: agents[id].quote(),
                            d: conductivity.get(&Edge::new(c, *id).unwrap()).copied().unwrap_or(0),
                        })
                        .collect();
                    let Some(i) = pick(&quotes, w_bps, norm) else { break };
                    let q = quotes[i];
                    let used = spent.get(&c).copied().unwrap_or(0);
                    if used + q.price > cap(c) {
                        st.budget_blocked += 1;
                        break;
                    }
                    tried.push(q.provider);
                    let quality = agents[&q.provider].quality;
                    st.attempts += 1;
                    st.hired_quality += quality;
                    let roll = stream(&[cfg.seed, t, c as u64, j as u64, 1 + attempt as u64]).unit();
                    if roll < quality {
                        pay(c, q.provider, q.price, &mut flows);
                        *spent.entry(c).or_default() += q.price;
                        agents.get_mut(&q.provider).unwrap().wins += 1;
                        st.settled += 1;
                        st.paid += q.price;
                        done = true;
                        break;
                    }
                    st.failures += 1;
                    *rejects.entry(Edge::new(c, q.provider).unwrap()).or_default() += 1;
                }
                if !done {
                    st.unfulfilled += 1;
                }
            }
        }

        let mut attack_fees = 0u128;
        if let Some(a) = cfg.attack {
            for &(from, to, volume) in &attack_edges {
                let parts = a.payments.max(1) as u128;
                for i in 0..parts {
                    let used = spent.get(&from).copied().unwrap_or(0);
                    let amount = (volume / parts + u128::from(i < volume % parts)).min(cap(from) - used);
                    if amount > 0 {
                        *spent.entry(from).or_default() += amount;
                        attack_fees += pay(from, to, amount, &mut flows);
                    }
                }
            }
        }

        let out = close_epoch(
            &p,
            &EpochInput {
                epoch: t,
                prev_fingerprint: prev,
                active: &active,
                conductivity: &conductivity,
                flows: &flows,
                rejects: &rejects,
                pool,
            },
        )
        .expect("valid epoch");
        for (id, amount) in &out.distribution.payouts {
            *balances.get_mut(id).unwrap() += amount;
        }
        treasury += out.distribution.treasury;
        st.fees = pool;
        st.rebates = pool - out.distribution.treasury;
        st.edges = out.conductivity.len();

        let attacker_rebates: u128 = attackers
            .iter()
            .map(|id| out.distribution.payouts.get(id).copied().unwrap_or(0))
            .sum();
        attacker_net += attacker_rebates as i128 - attack_fees as i128;

        if t >= cfg.epochs / 2 {
            let is_attacker = |id: SporeId| attackers.binary_search(&id).is_ok();
            let width = |id: SporeId| out.breadth.get(&id).copied().unwrap_or(0);
            for (e, q) in &flows {
                let group = match (is_attacker(e.a()), is_attacker(e.b())) {
                    (true, true) => &mut attacker,
                    (false, false) => &mut honest_group,
                    _ => continue,
                };
                let w_e = saturation(*q, p.k) as f64;
                let rebate: f64 = [e.a(), e.b()]
                    .iter()
                    .map(|id| {
                        let w_i = out.weights.get(id).copied().unwrap_or(0) as f64;
                        let paid = out.distribution.payouts.get(id).copied().unwrap_or(0) as f64;
                        if w_i > 0.0 {
                            paid * w_e / w_i
                        } else {
                            0.0
                        }
                    })
                    .sum();
                group.fees += edge_fees[e] as f64 / NEAR as f64;
                group.rebates += rebate / NEAR as f64;
                group.tube_gain += edge_gain(&p, *q, width(e.a()), width(e.b())) as f64 / ONE as f64;
            }
            for (id, r) in &out.reputation {
                let r = *r as f64 / REP_ONE as f64;
                let group = if is_attacker(*id) {
                    &mut attacker
                } else {
                    &mut honest_group
                };
                group.rep += r;
                *group.rep_by_spore.entry(*id).or_default() += r;
            }
            attacker.epochs += 1;
            honest_group.epochs += 1;
        }

        for a in agents.values_mut() {
            a.margin_bps = next_margin(a.margin_bps, a.wins);
            a.wins = 0;
        }

        let held: u128 = balances.values().sum();
        assert_eq!(held + treasury, total_money, "ledger not conserved at epoch {t}");

        conductivity = out.conductivity;
        prev = out.fingerprint;
        stats.push(st);
    }

    Run {
        stats,
        attacker,
        honest_group,
        attacker_net,
        attack_error,
        last_fingerprint: hex(&prev),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_bytes() {
        let mut cfg = Config::new(Params::shipped(), Mode::tubes(10_000), 7);
        cfg.epochs = 20;
        cfg.shocks = Shocks {
            kill: Some(5),
            cut: Some(8),
            raise: Some(12),
        };
        let a = run(&cfg);
        let b = run(&cfg);
        assert_eq!(a.last_fingerprint, b.last_fingerprint);
        assert_eq!(a.attacker_net, b.attacker_net);
        cfg.seed = 8;
        assert_ne!(run(&cfg).last_fingerprint, a.last_fingerprint);
    }

    #[test]
    fn one_spore_attack_is_a_rejected_self_payment() {
        let mut cfg = Config::new(Params::shipped(), Mode::tubes(10_000), 1);
        cfg.epochs = 4;
        cfg.attack = Some(Attack {
            spores: 1,
            volume: NEAR,
            payments: 4,
        });
        let r = run(&cfg);
        assert!(r.attack_error.unwrap().contains("cannot trade with itself"));
        assert_eq!(r.attacker_net, 0);
    }

    #[test]
    fn shipped_rule_makes_every_loop_lose() {
        for spores in [2, 3] {
            for volume in [NEAR / 50, NEAR / 2, 5 * NEAR] {
                let mut cfg = Config::new(Params::shipped(), Mode::tubes(10_000), 3);
                cfg.epochs = 12;
                cfg.attack = Some(Attack {
                    spores,
                    volume,
                    payments: 4,
                });
                assert!(run(&cfg).attacker_net < 0);
            }
        }
    }
}
