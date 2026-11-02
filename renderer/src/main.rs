//! `spores-render vectors | check | hashes | png <case> <out.png> | state <render_input.json> <out.png>`

use spores_renderer::{cases, hex, image_hash, render, sin_table_hash, trail, trail_hash, N, RENDERER_VERSION};
use std::{fs, process::exit};

const VECTORS: &str = "vectors/renderer.json";

fn case_json(name: &str, sp: &spores_renderer::Spore) -> String {
    let rgb = render(sp);
    let edges: Vec<String> = sp.edges.iter().map(|(i, d)| format!("[{i},{d}]")).collect();
    format!(
        "    {{\"name\":\"{name}\",\"seed\":\"{}\",\"age\":{},\"edges\":[{}],\"trail_hash\":\"{}\",\"image_hash\":\"{}\"}}",
        hex(&sp.seed),
        sp.age,
        edges.join(","),
        hex(&trail_hash(&trail(sp))),
        hex(&image_hash(&rgb))
    )
}

fn vectors_text() -> String {
    let cs: Vec<String> = cases::all().iter().map(|(n, s)| case_json(n, s)).collect();
    format!(
        "{{\n  \"renderer_version\": {RENDERER_VERSION},\n  \"n\": {N},\n  \"sin_table_hash\": \"{}\",\n  \"cases\": [\n{}\n  ]\n}}\n",
        hex(&sin_table_hash()),
        cs.join(",\n")
    )
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 == 1 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

/// Minimal PNG writer (stored deflate blocks) so the tool needs no image crate.
fn png(rgb: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(rgb.len() + N);
    for row in rgb.chunks(N * 3) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let mut z = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, b) in blocks.iter().enumerate() {
        z.push((i == blocks.len() - 1) as u8);
        z.extend((b.len() as u16).to_le_bytes());
        z.extend((!(b.len() as u16)).to_le_bytes());
        z.extend_from_slice(b);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    z.extend(((b << 16) | a).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut chunk = |kind: &[u8; 4], data: &[u8]| {
        out.extend((data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend(&body);
        out.extend(crc32(&body).to_be_bytes());
    };
    let mut ihdr = (N as u32).to_be_bytes().to_vec();
    ihdr.extend((N as u32).to_be_bytes());
    ihdr.extend([8, 2, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("vectors") => {
            fs::write(VECTORS, vectors_text()).unwrap();
            println!("wrote {VECTORS}");
        }
        Some("check") => {
            if fs::read_to_string(VECTORS).unwrap() == vectors_text() {
                println!("rust native: all {} cases match {VECTORS}", cases::all().len());
            } else {
                eprintln!("MISMATCH against {VECTORS}");
                exit(1);
            }
        }
        Some("hashes") => {
            for (n, s) in cases::all() {
                println!("{n:20} {}", hex(&image_hash(&render(&s))));
            }
        }
        Some("state") if args.len() == 3 => {
            // `render_input` view output from the router: {"seed": hex, "age": n, "edges": [[id, D], ...]}.
            let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&args[1]).unwrap()).unwrap();
            let hexs = v["seed"].as_str().expect("seed");
            assert_eq!(hexs.len(), 64, "seed must be 32 bytes of hex");
            let seed: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&hexs[2 * i..2 * i + 2], 16).unwrap()).collect();
            let edges: Vec<(u32, u64)> = v["edges"]
                .as_array()
                .expect("edges")
                .iter()
                .map(|e| (e[0].as_u64().unwrap() as u32, e[1].as_u64().unwrap()))
                .collect();
            let sp = spores_renderer::Spore::new(seed.try_into().unwrap(), v["age"].as_u64().expect("age") as u32, edges);
            let rgb = render(&sp);
            fs::write(&args[2], png(&rgb)).unwrap();
            println!(
                "renderer v{RENDERER_VERSION} age {} edges {} image_hash {}",
                sp.age,
                sp.edges.len(),
                hex(&image_hash(&rgb))
            );
        }
        Some("png") if args.len() == 3 => {
            let (_, s) = cases::all()
                .into_iter()
                .find(|(n, _)| *n == args[1])
                .expect("unknown case");
            fs::write(&args[2], png(&render(&s))).unwrap();
        }
        _ => {
            eprintln!("usage: spores-render vectors | check | hashes | png <case> <out.png> | state <render_input.json> <out.png>");
            exit(2);
        }
    }
}
