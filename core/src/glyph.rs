//! On-chain glyph (SPEC §5.5): a small integer-only SVG of one spore's tubes
//! drawn as straight lines on the 64-slot ring. The router serves it as NEP-177
//! `media`; the Physarum render is the off-chain layer.
//!
//! Slot positions use the same angles as the renderer's `ring_pos` (slot 0 at
//! the top, clockwise, Q16 sine). The output has no `#`, `%` or `"`, so it can
//! sit in a `data:image/svg+xml;utf8,` URI and in JSON without escaping.

use std::fmt::Write;

use crate::graph::SporeId;

pub const SIZE: i32 = 256;
const C: i32 = SIZE / 2;
const RING_R: i32 = 100;
const SLOTS: i32 = 64;

/// `sin(2*pi*k/64)` in Q16 for `k` in `0..=16`; equal to the renderer's
/// `sin_table()[64 * k]` (checked in the renderer tests).
pub const QUARTER_SIN: [i32; 17] = [
    0, 6424, 12785, 19024, 25080, 30893, 36410, 41576, 46341, 50660, 54491, 57798, 60547, 62714, 64277, 65220, 65536,
];

fn sin64(s: i32) -> i32 {
    let s = s.rem_euclid(SLOTS);
    let r = (s % 16) as usize;
    match s / 16 {
        0 => QUARTER_SIN[r],
        1 => QUARTER_SIN[16 - r],
        2 => -QUARTER_SIN[r],
        _ => -QUARTER_SIN[16 - r],
    }
}

/// Position of spore `id` on a ring of radius `r` around the centre.
pub fn ring_pos(id: SporeId, r: i32) -> (i32, i32) {
    let s = (id as i32 & 63) - 16;
    (C + ((r * sin64(s + 16)) >> 16), C + ((r * sin64(s)) >> 16))
}

/// Tube strength on 0..=1000 (D is on the 1e6 scale), as in the renderer.
fn dn1000(d: u128) -> i32 {
    (d.min(1_000_000) / 1000) as i32
}

/// `active` false draws the dormant mark: the ring and a faint outline only.
pub fn glyph_svg(id: SporeId, seed: &[u8; 32], age: u32, active: bool, edges: &[(SporeId, u128)]) -> String {
    let mut nb: Vec<(SporeId, u128)> = edges.iter().copied().filter(|&(n, d)| n != id && d > 0).collect();
    nb.sort_unstable();
    let (r, g, b) = (
        80 + seed[0] as u32 % 160,
        80 + seed[1] as u32 % 160,
        80 + seed[2] as u32 % 160,
    );
    let mut s = String::with_capacity(400 + nb.len() * 140);
    write!(
        s,
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {SIZE} {SIZE}'>\
<rect width='{SIZE}' height='{SIZE}' fill='rgb(11,13,10)'/>\
<circle cx='{C}' cy='{C}' r='{RING_R}' fill='none' stroke='rgb(42,47,39)'/>"
    )
    .unwrap();
    let (x0, y0) = ring_pos(id, RING_R);
    if active {
        for &(n, d) in &nb {
            let dn = dn1000(d);
            let (x, y) = ring_pos(n, RING_R);
            write!(
                s,
                "<line x1='{x0}' y1='{y0}' x2='{x}' y2='{y}' stroke='rgb({r},{g},{b})' stroke-width='{}' stroke-opacity='.{:02}' stroke-linecap='round'/>\
<circle cx='{x}' cy='{y}' r='3' fill='rgb({r},{g},{b})'/>",
                1 + dn / 250,
                30 + 69 * dn / 1000
            )
            .unwrap();
        }
        let size = 4 + age.min(40) / 5;
        write!(s, "<circle cx='{x0}' cy='{y0}' r='{size}' fill='rgb({r},{g},{b})'/>").unwrap();
    } else {
        write!(s, "<circle cx='{x0}' cy='{y0}' r='4' fill='none' stroke='rgb({r},{g},{b})' stroke-opacity='.35'/>").unwrap();
    }
    s.push_str("</svg>");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_sit_on_the_ring_starting_at_the_top() {
        assert_eq!(ring_pos(0, RING_R), (C, C - RING_R));
        assert_eq!(ring_pos(16, RING_R), (C + RING_R, C));
        assert_eq!(ring_pos(32, RING_R), (C, C + RING_R));
        assert_eq!(ring_pos(48, RING_R), (C - RING_R, C));
        assert_eq!(ring_pos(64, RING_R), ring_pos(0, RING_R));
    }

    #[test]
    fn deterministic_uri_safe_and_reacts_to_edges() {
        let seed = [9; 32];
        let a = glyph_svg(3, &seed, 7, true, &[(10, 600_000), (40, 80_000)]);
        assert_eq!(a, glyph_svg(3, &seed, 7, true, &[(40, 80_000), (10, 600_000)]));
        assert!(!a.contains('#') && !a.contains('%') && !a.contains('"'));
        assert_eq!(a.matches("<line").count(), 2);
        let pruned = glyph_svg(3, &seed, 7, true, &[(10, 600_000)]);
        assert_ne!(a, pruned);
        assert_eq!(pruned.matches("<line").count(), 1);
    }

    #[test]
    fn dormant_is_a_faint_mark_and_young_is_smaller() {
        let seed = [1; 32];
        let dormant = glyph_svg(3, &seed, 0, false, &[(10, 600_000)]);
        assert!(!dormant.contains("<line") && dormant.contains("stroke-opacity='.35'"));
        assert!(glyph_svg(3, &seed, 0, true, &[]).contains("r='4' fill"));
        assert!(glyph_svg(3, &seed, 40, true, &[]).contains("r='12' fill"));
    }

    #[test]
    fn worst_case_stays_small() {
        // 16 active spores: at most 15 tubes per spore.
        let edges: Vec<(SporeId, u128)> = (0..15).map(|i| (i * 4 + 1, 1_000_000)).collect();
        assert!(glyph_svg(0, &[255; 32], 1_000_000, true, &edges).len() < 4096);
    }
}
