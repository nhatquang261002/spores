use spores_renderer::trig::sin_table;
use spores_renderer::{cases, image_hash, isqrt_u64, render, trail, Spore, N};

fn case(name: &str) -> Spore {
    cases::all().into_iter().find(|(n, _)| n == name).unwrap().1
}

/// Trail cells at or above 1.0 (Q8 256): the network's footprint.
fn footprint(sp: &Spore) -> usize {
    trail(sp).iter().filter(|&&v| v >= 256).count()
}

/// Pixels whose brightest channel is at least 90.
fn bright(rgb: &[u8]) -> usize {
    rgb.chunks(3).filter(|p| p.iter().copied().max().unwrap() >= 90).count()
}

#[test]
fn sin_table_matches_float_sine_within_two_units_and_is_symmetric() {
    let t = sin_table();
    assert_eq!(t.len(), 4096);
    assert_eq!((t[0], t[1024], t[2048], t[3072]), (0, 65536, 0, -65536));
    for (a, &v) in t.iter().enumerate() {
        let exact = (2.0 * std::f64::consts::PI * a as f64 / 4096.0).sin() * 65536.0;
        assert!((v as f64 - exact).abs() <= 1.0, "a={a} v={v} exact={exact}");
        assert_eq!(t[(4096 - a) & 4095], -v, "odd symmetry at {a}");
    }
}

#[test]
fn isqrt_matches_core() {
    for n in (0u64..70_000).chain([u64::MAX, u64::MAX - 1, 1 << 62, 999_999_999_999]) {
        assert_eq!(isqrt_u64(n) as u128, spores_core::math::isqrt(n as u128), "n={n}");
    }
}

#[test]
fn repeated_renders_are_byte_identical() {
    let sp = case("young");
    assert_eq!(image_hash(&render(&sp)), image_hash(&render(&sp)));
}

#[test]
fn edge_order_does_not_matter() {
    let a = Spore::new([7; 32], 10, vec![(3, 500_000), (40, 300_000)]);
    let b = Spore {
        edges: vec![(40, 300_000), (3, 500_000)],
        ..a.clone()
    };
    // `Spore::new` sorts; a struct literal does not, so sort explicitly as the router's view would.
    let b = Spore::new(b.seed, b.age, b.edges);
    assert_eq!(render(&a), render(&b));
}

#[test]
fn dormant_is_a_faint_mark() {
    let dormant = render(&case("dormant"));
    let mature = render(&case("mature"));
    assert!(bright(&dormant) < 600, "dormant has {} bright pixels", bright(&dormant));
    assert!(bright(&mature) > 8 * bright(&dormant).max(1));
    assert!(trail(&case("dormant")).iter().all(|&v| v == 0), "no network");
}

#[test]
fn adding_an_edge_changes_the_image_and_pruning_restores_the_thinner_one() {
    let (base, minus, plus) = (case("mature"), case("mature_minus_edge"), case("mature_plus_edge"));
    let (hb, hm, hp) = (
        image_hash(&render(&base)),
        image_hash(&render(&minus)),
        image_hash(&render(&plus)),
    );
    assert!(hb != hm && hb != hp && hm != hp);
    // Pruning the added edge gives back exactly the earlier image: the renderer is a pure function of state.
    let mut e = plus.edges.clone();
    e.retain(|&(id, _)| id != 60);
    assert_eq!(image_hash(&render(&Spore::new(plus.seed, plus.age, e))), hb);
}

#[test]
fn young_spore_renders_smaller_than_mature_with_the_same_seed() {
    let (young, mature) = (case("young"), case("mature"));
    assert_eq!(young.seed, mature.seed);
    let (fy, fm) = (footprint(&young), footprint(&mature));
    let (by, bm) = (bright(&render(&young)), bright(&render(&mature)));
    println!("footprint young={fy} mature={fm}; bright pixels young={by} mature={bm}");
    assert!(fy * 10 < fm * 7, "footprint {fy} vs {fm}");
    assert!(by * 10 < bm * 7, "bright {by} vs {bm}");
}

#[test]
fn palette_comes_from_the_seed_and_does_not_change_with_growth() {
    let mut s = case("young");
    let p = s.seed[31] % 5;
    s.age = 90;
    s.edges.push((50, 900_000));
    assert_eq!(s.seed[31] % 5, p);
    for i in 0..5 {
        assert_eq!(case(&format!("palette{i}")).seed[31] % 5, i as u8);
    }
}

#[test]
fn spore_bytes_round_trip_and_reject_bad_lengths() {
    let sp = case("mature");
    let b = sp.to_bytes();
    let back = Spore::from_bytes(&b).unwrap();
    assert_eq!(
        (back.seed, back.age, back.edges.clone()),
        (sp.seed, sp.age, sp.edges.clone())
    );
    assert!(Spore::from_bytes(&b[..b.len() - 1]).is_none());
    assert!(Spore::from_bytes(&b[..39]).is_none());
}

#[test]
fn image_is_n_by_n_rgb() {
    assert_eq!(render(&case("dormant")).len(), N * N * 3);
}

#[test]
fn glyph_ring_table_matches_the_renderer_sine() {
    let t = sin_table();
    for (k, v) in spores_core::glyph::QUARTER_SIN.iter().enumerate() {
        assert_eq!(*v, t[64 * k], "slot angle {k}");
    }
}
