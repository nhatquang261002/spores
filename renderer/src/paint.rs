//! Integer image pipeline: trail -> tone map -> palette -> bloom -> grain ->
//! vignette -> overlays. RGB u8, row-major, N*N*3 bytes. The JS port mirrors it.

use crate::rng::Rng;
use crate::sim::{dn1000, nodes, ring_pos, RING_R};
use crate::trig::Tables;
use crate::{isqrt_u64, Spore, C, N};

type Rgb = [i32; 3];

/// Palette stops at positions 0..=255: yolk, ember, violet, toxic, aqua.
const STOPS_POS: [i32; 6] = [0, 41, 107, 184, 235, 255];
const PALETTES: [[Rgb; 6]; 5] = [
    [
        [6, 9, 8],
        [8, 62, 60],
        [24, 150, 120],
        [240, 196, 60],
        [255, 236, 170],
        [255, 255, 240],
    ],
    [
        [10, 6, 6],
        [70, 10, 14],
        [190, 40, 24],
        [255, 140, 30],
        [255, 214, 140],
        [255, 250, 235],
    ],
    [
        [7, 5, 14],
        [40, 16, 92],
        [120, 40, 200],
        [240, 90, 200],
        [255, 190, 235],
        [255, 248, 255],
    ],
    [
        [5, 9, 6],
        [10, 70, 30],
        [60, 180, 50],
        [200, 240, 60],
        [240, 255, 170],
        [252, 255, 238],
    ],
    [
        [4, 8, 14],
        [8, 50, 100],
        [20, 130, 210],
        [70, 220, 230],
        [190, 250, 250],
        [245, 255, 255],
    ],
];
const AGE_FULL: i32 = 30;
const MASK_MAX: i32 = 14;
const BLOOM_R: usize = 6;

pub fn palette_index(sp: &Spore) -> usize {
    sp.seed[31] as usize % 5
}

fn palette_lut(p: usize) -> Vec<Rgb> {
    let stops = &PALETTES[p];
    (0..256)
        .map(|i| {
            let mut k = 0;
            while k < 4 && i > STOPS_POS[k + 1] {
                k += 1;
            }
            let (t0, t1) = (STOPS_POS[k], STOPS_POS[k + 1]);
            let span = t1 - t0;
            let mut c = [0; 3];
            for (j, v) in c.iter_mut().enumerate() {
                *v = (stops[k][j] * span + (stops[k + 1][j] - stops[k][j]) * (i - t0)) / span;
            }
            c
        })
        .collect()
}

/// Concave tone curve, roughly x^0.8: (3x + sqrt(255x)) / 4.
fn tone_lut() -> Vec<i32> {
    (0..256)
        .map(|i| (3 * i + isqrt_u64(i as u64 * 255) as i32) / 4)
        .collect()
}

/// Box blur, edge-clamped, running sum; sums divided by the window width, floored.
fn box_blur(src: &[u8], r: usize) -> Vec<u8> {
    let w = 2 * r + 1;
    let mut tmp = vec![0u8; src.len()];
    let mut out = vec![0u8; src.len()];
    for ch in 0..3 {
        for y in 0..N {
            let px = |x: i32| src[(y * N + x.clamp(0, N as i32 - 1) as usize) * 3 + ch] as i32;
            let mut sum: i32 = (-(r as i32)..=r as i32).map(px).sum();
            for x in 0..N as i32 {
                tmp[(y * N + x as usize) * 3 + ch] = (sum / w as i32) as u8;
                sum += px(x + r as i32 + 1) - px(x - r as i32);
            }
        }
        for x in 0..N {
            let px = |y: i32| tmp[(y.clamp(0, N as i32 - 1) as usize * N + x) * 3 + ch] as i32;
            let mut sum: i32 = (-(r as i32)..=r as i32).map(px).sum();
            for y in 0..N as i32 {
                out[(y as usize * N + x) * 3 + ch] = (sum / w as i32) as u8;
                sum += px(y + r as i32 + 1) - px(y - r as i32);
            }
        }
    }
    out
}

fn blend(img: &mut [u8], x: i32, y: i32, col: Rgb, alpha: i32) {
    if alpha <= 0 || x < 0 || y < 0 || x >= N as i32 || y >= N as i32 {
        return;
    }
    let o = (y as usize * N + x as usize) * 3;
    for (j, c) in col.iter().enumerate() {
        img[o + j] = ((img[o + j] as i32 * (255 - alpha) + c * alpha) / 255) as u8;
    }
}

/// Distance from pixel (x, y) to (cx, cy) in 1/16 pixel.
fn dist16(x: i32, y: i32, cx: i32, cy: i32) -> i32 {
    isqrt_u64(256 * ((x - cx) * (x - cx) + (y - cy) * (y - cy)) as u64) as i32
}

/// Filled disc, radius in 1/16 px, 1 px linear edge.
fn disc(img: &mut [u8], cx: i32, cy: i32, r16: i32, col: Rgb, alpha: i32) {
    let m = r16 / 16 + 2;
    for y in cy - m..=cy + m {
        for x in cx - m..=cx + m {
            let cov = (r16 - dist16(x, y, cx, cy) + 8).clamp(0, 16);
            blend(img, x, y, col, alpha * cov / 16);
        }
    }
}

/// Outline of the given width (1/16 px) centred on radius `r16`.
fn ring(img: &mut [u8], cx: i32, cy: i32, r16: i32, width16: i32, col: Rgb, alpha: i32) {
    let m = (r16 + width16) / 16 + 2;
    for y in cy - m..=cy + m {
        for x in cx - m..=cx + m {
            let cov = (width16 / 2 + 8 - (dist16(x, y, cx, cy) - r16).abs()).clamp(0, 16);
            blend(img, x, y, col, alpha * cov / 16);
        }
    }
}

pub fn paint(sp: &Spore, trail: &[i32], t: &Tables) -> Vec<u8> {
    let deg = sp.edges.len();
    let pal = palette_index(sp);
    let lut = palette_lut(pal);
    let accent = PALETTES[pal][3];
    let tone = tone_lut();
    let age = (sp.age as i32).min(AGE_FULL);
    let mask = MASK_MAX - MASK_MAX * age / AGE_FULL;

    let mut img = vec![0u8; N * N * 3];
    for (i, &tr) in trail.iter().enumerate() {
        let v = (tr * 255 / (24 * 256)).min(255);
        let idx = if v < mask { 0 } else { tone[v as usize] };
        for j in 0..3 {
            img[i * 3 + j] = lut[idx as usize][j] as u8;
        }
    }

    // Bloom: two box-blur passes, screen-blended at 55%.
    let bloom = box_blur(&box_blur(&img, BLOOM_R), BLOOM_R);
    for i in 0..img.len() {
        let a = img[i] as i32;
        let bb = bloom[i] as i32 * 55 / 100;
        img[i] = (255 - (255 - a) * (255 - bb) / 255) as u8;
    }

    // Grain (second RNG stream), then vignette.
    let mut grng = Rng::from_bytes(&sp.seed[16..32]);
    let d2max = (N as i32 * 72 / 100) * (N as i32 * 72 / 100);
    for y in 0..N as i32 {
        for x in 0..N as i32 {
            let u = grng.next_u32();
            let noise = ((u >> 29) & 7) as i32 + ((u >> 26) & 7) as i32 - 7;
            let d2 = (x - C) * (x - C) + (y - C) * (y - C);
            let m = (287 - 256 * d2 / d2max).clamp(51, 256);
            let o = (y as usize * N + x as usize) * 3;
            for j in 0..3 {
                img[o + j] = ((img[o + j] as i32 + noise).clamp(0, 255) * m / 256) as u8;
            }
        }
    }

    // Overlays.
    let has: Vec<u32> = sp.edges.iter().map(|e| e.0 & 63).collect();
    for i in 0..64u32 {
        if !has.contains(&i) {
            let (x, y) = ring_pos(t, i, RING_R);
            disc(&mut img, x, y, 20, [150, 160, 155], 70);
        }
    }
    for _ in 0..140 {
        let x = (grng.next_u32() % N as u32) as i32;
        let y = (grng.next_u32() % N as u32) as i32;
        let r16 = 16 + (grng.next_u32() % 32) as i32;
        let a = 25 + (grng.next_u32() % 66) as i32;
        disc(&mut img, x, y, r16, [255, 255, 255], a);
    }
    let ns = nodes(sp, t);
    for (nd, &(_, d)) in ns[1..].iter().zip(&sp.edges) {
        let r0 = 90 + 66 * dn1000(d) / 1000;
        ring(&mut img, nd.x, nd.y, r0 + 74, 16, accent, 90);
        disc(&mut img, nd.x, nd.y, r0, [6, 8, 8], 200);
        ring(&mut img, nd.x, nd.y, r0, 24, accent, 255);
        disc(&mut img, nd.x, nd.y, 29, [255, 250, 235], 255);
    }
    // Nucleus glow: alpha 200 * (1 - d2/R2)^2 inside 40 px (dormant: 70).
    let (glow, rg2) = (if deg == 0 { 70 } else { 200 }, 40 * 40);
    for y in C - 40..=C + 40 {
        for x in C - 40..=C + 40 {
            let d2 = (x - C) * (x - C) + (y - C) * (y - C);
            if d2 < rg2 {
                let q = (rg2 - d2) as i64;
                blend(
                    &mut img,
                    x,
                    y,
                    accent,
                    (glow as i64 * q * q / (rg2 as i64 * rg2 as i64)) as i32,
                );
            }
        }
    }
    if deg > 0 {
        disc(&mut img, C, C, 106, [255, 252, 240], 255);
        ring(&mut img, C, C, 160, 16, [255, 252, 240], 200);
    } else {
        disc(&mut img, C, C, 56, accent, 150);
    }
    // Frame: 1 px square outline, 9 px in from the edge.
    let e = N as i32 / 2 - 9;
    for k in -e..=e {
        for (x, y) in [(C + k, C - e), (C + k, C + e), (C - e, C + k), (C + e, C + k)] {
            blend(&mut img, x, y, [255, 255, 255], 40);
        }
    }
    img
}
