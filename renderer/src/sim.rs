//! Fixed-point Physarum simulation. Everything is i32/u32/u64 integer math;
//! the JS port in `renderer/js/render.mjs` follows this file line by line.
//!
//! Units: trail is Q8 (256 = 1.0), capped at `CAP`. Agent position is Q16
//! pixels, heading is 1/4096 turn. Random draws happen in a fixed order:
//! init draws 4 words per agent (angle, u1, u2, heading); each step then draws
//! one word per agent (turn direction) plus one more only when the agent
//! leaves the disc.

use crate::rng::Rng;
use crate::trig::{Tables, TURN};
use crate::{isqrt_u64, Spore, C, N};

pub const RING_R: i32 = 168;
const BOUND_MAX: i32 = 215;
const CAP: i32 = 40 * 256;
const SA: usize = 391; // sensor angle, 0.6 rad
const TU: usize = 222; // turn angle, 0.34 rad
const NODE_R: i32 = 5;
const AGENT_BASE: usize = 3300;
const AGENT_PER_DEG: usize = 2300;
const AGENT_MAX: usize = 26000;
const STEPS_BASE: usize = 150;
const STEPS_PER_DEG: usize = 22;
const STEPS_MAX: usize = 600;

pub struct Node {
    pub x: i32,
    pub y: i32,
    /// Trail deposited per step, Q8.
    pub strength: i32,
}

/// Position of collection slot `id` on a ring of radius `r` around the centre.
pub fn ring_pos(t: &Tables, id: u32, r: i32) -> (i32, i32) {
    let a = ((id as usize & 63) * 64 + TURN - 1024) & (TURN - 1);
    (C + ((r * t.cos(a)) >> 16), C + ((r * t.sin[a]) >> 16))
}

/// Tube strength normalised to 0..=1000 (D is on the 1e6 scale).
pub fn dn1000(d: u64) -> i32 {
    (d.min(1_000_000) / 1000) as i32
}

pub fn reputation(sp: &Spore) -> u64 {
    sp.edges.iter().map(|&(_, d)| isqrt_u64(d)).sum()
}

/// Agents stay inside a disc that grows with degree: a young spore reads small.
pub fn bound_r(deg: usize) -> i32 {
    (140 + 10 * deg as i32).min(BOUND_MAX)
}

pub fn nodes(sp: &Spore, t: &Tables) -> Vec<Node> {
    let rep_bonus = (reputation(sp) * 256 / 3500).min(512) as i32;
    let mut v = vec![Node {
        x: C,
        y: C,
        strength: 1075 + rep_bonus,
    }];
    for &(id, d) in &sp.edges {
        let dn = dn1000(d);
        let (x, y) = ring_pos(t, id, (RING_R - 84 * dn / 1000).min(bound_r(sp.edges.len()) - 12));
        v.push(Node {
            x,
            y,
            strength: 410 + 410 * dn / 1000,
        });
    }
    v
}

pub fn agents_and_steps(deg: usize) -> (usize, usize) {
    (
        (AGENT_BASE + AGENT_PER_DEG * deg).min(AGENT_MAX),
        (STEPS_BASE + STEPS_PER_DEG * deg).min(STEPS_MAX),
    )
}

/// Run the simulation and return the N*N trail grid (Q8). A spore with no
/// edges has no network: all zeros.
pub fn simulate(sp: &Spore, t: &Tables) -> Vec<i32> {
    let mut trail = vec![0i32; N * N];
    if sp.edges.is_empty() {
        return trail;
    }
    let mut rng = Rng::from_bytes(&sp.seed[0..16]);
    let nodes = nodes(sp, t);
    let (n_agents, steps) = agents_and_steps(sp.edges.len());
    let bound = bound_r(sp.edges.len());
    let init_r = (bound * 95 / 100) as u64;

    let mut ax = vec![0i32; n_agents];
    let mut ay = vec![0i32; n_agents];
    let mut ah = vec![0usize; n_agents];
    for i in 0..n_agents {
        let ang = rng.next_u32() as usize & (TURN - 1);
        let u1 = (rng.next_u32() >> 16) as u64;
        let u2 = (rng.next_u32() >> 16) as u64;
        let r = ((init_r * u1 * u2) >> 32) as i32;
        ax[i] = (C + ((r * t.cos(ang)) >> 16)) << 16;
        ay[i] = (C + ((r * t.sin[ang]) >> 16)) << 16;
        ah[i] = rng.next_u32() as usize & (TURN - 1);
    }

    let mut next = vec![0i32; N * N];
    let at = |trail: &[i32], x: i32, y: i32| {
        trail[(y.clamp(0, N as i32 - 1) as usize) * N + x.clamp(0, N as i32 - 1) as usize]
    };
    for _ in 0..steps {
        for nd in &nodes {
            for y in (nd.y - NODE_R).max(0)..=(nd.y + NODE_R).min(N as i32 - 1) {
                for x in (nd.x - NODE_R).max(0)..=(nd.x + NODE_R).min(N as i32 - 1) {
                    if (x - nd.x) * (x - nd.x) + (y - nd.y) * (y - nd.y) <= NODE_R * NODE_R {
                        let c = &mut trail[y as usize * N + x as usize];
                        *c = (*c + nd.strength).min(CAP);
                    }
                }
            }
        }
        for i in 0..n_agents {
            let h = ah[i];
            let (px, py) = (ax[i] >> 16, ay[i] >> 16);
            let sample = |hh: usize| at(&trail, px + t.sense_dx[hh], py + t.sense_dy[hh]);
            let f = sample(h);
            let l = sample((h + TURN - SA) & (TURN - 1));
            let r = sample((h + SA) & (TURN - 1));
            let rand_right = rng.next_u32() & 1 == 1;
            let mut h = h;
            if f < l && f < r {
                h = if rand_right { h + TU } else { h + TURN - TU };
            } else if l > f && l > r {
                h = h + TURN - TU;
            } else if r > f && r > l {
                h += TU;
            }
            h &= TURN - 1;
            let nx = ax[i] + t.step_dx[h];
            let ny = ay[i] + t.step_dy[h];
            let (qx, qy) = (nx >> 16, ny >> 16);
            if (qx - C) * (qx - C) + (qy - C) * (qy - C) > bound * bound {
                h = rng.next_u32() as usize & (TURN - 1);
            } else {
                ax[i] = nx;
                ay[i] = ny;
            }
            ah[i] = h;
            let c = &mut trail[(ay[i] >> 16) as usize * N + (ax[i] >> 16) as usize];
            *c = (*c + 256).min(CAP);
        }
        // Diffuse and decay: t' = (0.55 t + 0.45 blur) * 0.90, blur = [1 2 1; 2 4 2; 1 2 1] / 16.
        // Max intermediate: (10240*880 + 163840*45) * 90 = 1.47e9 < 2^31.
        for y in 0..N as i32 {
            for x in 0..N as i32 {
                let g = |dx: i32, dy: i32| at(&trail, x + dx, y + dy);
                let blur16 = g(-1, -1)
                    + 2 * g(0, -1)
                    + g(1, -1)
                    + 2 * g(-1, 0)
                    + 4 * g(0, 0)
                    + 2 * g(1, 0)
                    + g(-1, 1)
                    + 2 * g(0, 1)
                    + g(1, 1);
                next[y as usize * N + x as usize] =
                    (trail[y as usize * N + x as usize] * 880 + blur16 * 45) * 90 / 160_000;
            }
        }
        std::mem::swap(&mut trail, &mut next);
    }
    trail
}
