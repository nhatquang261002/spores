"""Builds the Spores brand SVGs and HTML sources into brand/.

Needs fontTools, brotli and uharfbuzz (`pip install fonttools brotli uharfbuzz`).
Raster files come from brand/build.sh, which runs this and then headless Chrome.

The mark is Spore #3's tubes in the epoch-22 snapshot of the Phase 6 dense run
on router4 (out/agents/phase6-s3-dense3/snapshots/epoch-022.json), drawn in the renderer's
ring geometry (renderer/src/sim.rs: RING_R = 168 on a 512 canvas, spore N at
N * 5.625 degrees clockwise from 12 o'clock, partners pulled in by 84 * D_norm).
"""

import base64
import io
import json
import math
import re
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "brand"


def app_tokens():
    """Every `--name: #hex;` in the app's tokens.css, so the brand follows the app."""
    css = (ROOT / "viz/src/ui/tokens.css").read_text()
    return {m[1]: m[2].upper() for m in re.finditer(r"--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;", css)}


TOK = app_tokens()
BG, TEXT, TEXT_2, TEXT_3, LINE = (TOK[k] for k in ("bg", "text", "text-2", "text-3", "line"))
SLIME = TOK["slime"]  # the app's wordmark nucleus; the brand's nucleus too
PAPER = "#FFFFFF"  # light-background variants are monochrome: yolk on white is under 2:1

# The mark: Spore #3, epoch-22 snapshot (phase6-s3-dense3). Partner id -> D (1e6 scale).
MARK_SPORE = 3
MARK_TUBES = {8: 230_662, 25: 63_018, 46: 126_037}
MARK_BENDS = {8: 16, 25: -14, 46: 12}

# The social card: Spore #5 at epoch 17 (phase5-exit2), the sold spore, and its committed image.
SPORE = 5
EPOCH = 17
TUBES = 4
IMAGE_HASH = "ac15a3e9eaaac7cedb069c0c677bb534ebbee62e54986c86d5e5586410058cfe"
ART = ROOT / "docs/img/phase5-spore5-epoch17.png"

C, RING_R = 256, 168


def ring_pos(sid, r):
    a = math.radians((sid & 63) * 5.625)
    return C + r * math.sin(a), C - r * math.cos(a)


def dn(d):
    return min(d, 1_000_000) / 1_000_000


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def tube_path(x, y, bend, w0, w1):
    """A gently S-curved strand from the nucleus to (x, y): width w1 along its
    length, swelling to w0 where it joins the nucleus, as Physarum tubes do."""
    nx, ny = -(y - C), x - C
    n = math.hypot(nx, ny) or 1
    nx, ny = nx / n * bend, ny / n * bend
    p0, p3 = (C, C), (x, y)
    p1 = (C + (x - C) / 3 + nx, C + (y - C) / 3 + ny)
    p2 = (C + 2 * (x - C) / 3 - nx, C + 2 * (y - C) / 3 - ny)
    left, right = [], []
    steps = 32
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        px, py = (u**3 * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t**3 * p3[k]
                  for k in (0, 1))
        tx, ty = (3 * u * u * (p1[k] - p0[k]) + 6 * u * t * (p2[k] - p1[k]) + 3 * t * t * (p3[k] - p2[k])
                  for k in (0, 1))
        tn = math.hypot(tx, ty) or 1
        h = (w1 + (w0 - w1) * u ** 4) / 2
        left.append((px - ty / tn * h, py + tx / tn * h))
        right.append((px + ty / tn * h, py - tx / tn * h))
    pts = left + right[::-1]
    return "M" + "L".join(f"{f(a)} {f(b)}" for a, b in pts) + "Z"


def mark_body(ink, bg, dots=True, weight=1.0, nucleus=None):
    """Mark contents on a 512 canvas. weight > 1 thickens everything for small sizes."""
    parts = []
    if dots:
        for i in range(64):
            if i in MARK_TUBES or i == MARK_SPORE:
                continue
            x, y = ring_pos(i, RING_R)
            parts.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="{f(4.5 * weight)}"/>')
        dots_svg = f'<g fill="{ink}" fill-opacity=".42">{"".join(parts)}</g>'
    else:
        dots_svg = (f'<circle cx="{C}" cy="{C}" r="{RING_R}" fill="none" stroke="{ink}" '
                    f'stroke-opacity=".42" stroke-width="{f(5 * weight)}"/>')
    tubes, markers = [], []
    for pid, d in sorted(MARK_TUBES.items(), key=lambda t: t[1]):
        x, y = ring_pos(pid, RING_R - 84 * dn(d))
        s = math.sqrt(dn(d))  # tube width follows sqrt(D), as in the network view
        w1 = (9 + 16 * s) * weight
        w0 = w1 * 3
        tubes.append(f'<path d="{tube_path(x, y, MARK_BENDS[pid], w0, w1)}"/>')
        markers.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="{f(15 * weight)}" fill="{bg}" '
                       f'stroke="{ink}" stroke-width="{f(5 * weight)}"/>'
                       f'<circle cx="{f(x)}" cy="{f(y)}" r="{f(5.5 * weight)}" fill="{ink}"/>')
    return (dots_svg
            + f'<g fill="{ink}">{"".join(tubes)}</g>'
            + "".join(markers)
            + f'<circle cx="{C}" cy="{C}" r="{f(32 * weight)}" fill="{nucleus or ink}"/>')


def mark_svg(ink, bg, *, nucleus=None, size=None, fill_bg=False, dots=True, weight=1.0, pad=56, radius=0):
    vb = f"{-pad} {-pad} {512 + 2 * pad} {512 + 2 * pad}"
    wh = f' width="{size}" height="{size}"' if size else ""
    back = (f'<rect x="{-pad}" y="{-pad}" width="{512 + 2 * pad}" height="{512 + 2 * pad}" '
            f'rx="{radius}" fill="{bg}"/>') if fill_bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"{wh}>'
            f'<title>Spores</title>{back}{mark_body(ink, bg, dots, weight, nucleus)}</svg>\n')


def load_font(path):
    font = TTFont(path)
    font.flavor = None
    buf = io.BytesIO()
    font.save(buf)
    return font, buf.getvalue()


def shaped_path(text, path, px):
    """Outlines `text` at `px` font size with HarfBuzz kerning; baseline at y=0."""
    font, data = load_font(path)
    upm = font["head"].unitsPerEm
    hbf = hb.Font(hb.Face(data))
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hbf, buf, {"kern": True, "liga": True})
    gs = font.getGlyphSet()
    order = font.getGlyphOrder()
    k = px / upm
    pen = SVGPathPen(gs, ntos=lambda v: f(v))
    x = 0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        tp = TransformPen(pen, (k, 0, 0, -k, (x + pos.x_offset) * k, -pos.y_offset * k))
        gs[order[info.codepoint]].draw(tp)
        x += pos.x_advance
    return pen.getCommands(), x * k


SERIF = ROOT / "viz/public/fonts/instrument-serif-latin-400-normal.woff2"


def wordmark_svg(ink, px=96, pad=None, nucleus=None):
    """Design §5.2: "Spores" in Instrument Serif plus a nucleus dot of 8/22 em,
    gap 8/22 em, centred where the app's flex row centres it (0.34 em)."""
    d, adv = shaped_path("Spores", SERIF, px)
    pad = px * 0.25 if pad is None else pad
    dot = px * 8 / 22
    gap = px * 8 / 22
    asc, desc = px * 0.72, px * 0.24  # cap height and the p descender, rounded up
    w = pad * 2 + dot + gap + adv
    h = pad * 2 + asc + desc
    by = pad + asc
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f(w)} {f(h)}">'
            f'<title>Spores</title>'
            f'<circle cx="{f(pad + dot / 2)}" cy="{f(by - px * 0.34)}" r="{f(dot / 2)}" fill="{nucleus or ink}"/>'
            f'<path transform="translate({f(pad + dot + gap)} {f(by)})" fill="{ink}" d="{d}"/>'
            f'</svg>\n')


def lockup_svg(ink, bg, px=96, nucleus=None):
    """Mark at 1.5x the cap height beside the outlined name."""
    d, adv = shaped_path("Spores", SERIF, px)
    m = px * 1.5
    gap = px * 0.42
    pad = px * 0.3
    w = pad * 2 + m + gap + adv
    h = pad * 2 + m
    cy = pad + m / 2
    k = m / 512
    by = cy + px * 0.34
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f(w)} {f(h)}">'
            f'<title>Spores</title>'
            f'<g transform="translate({f(pad)} {f(pad)}) scale({k:.5f})">{mark_body(ink, bg, weight=1.5, nucleus=nucleus)}</g>'
            f'<path transform="translate({f(pad + m + gap)} {f(by)})" fill="{ink}" d="{d}"/>'
            f'</svg>\n')


def social_card_html():
    art = base64.b64encode(ART.read_bytes()).decode()
    word = wordmark_svg(TEXT, px=40, pad=0, nucleus=SLIME)
    short = f"{IMAGE_HASH[:6]}…{IMAGE_HASH[-4:]}"
    fonts = "../../viz/public/fonts"
    return f"""<!doctype html>
<!-- Source of brand/social-card.png (1200x630). Rendered by brand/build.sh. -->
<html><head><meta charset="utf-8"><style>
@font-face {{ font-family: "Instrument Serif"; src: url({fonts}/instrument-serif-latin-400-normal.woff2) format("woff2"); }}
@font-face {{ font-family: "Geist Mono"; src: url({fonts}/geist-mono-latin-400-normal.woff2) format("woff2"); }}
html, body {{ margin: 0; width: 1200px; height: 630px; background: {BG}; overflow: hidden; }}
body {{ display: grid; grid-template-columns: 630px 1fr; color: {TEXT}; }}
/* the app's art bloom (shell.css): real pixels glow in the spore's accent (violet) */
.art {{ width: 566px; height: 566px; margin: 32px;
        box-shadow: 0 0 56px -12px color-mix(in srgb, {TOK["pal-violet-accent"]} 50%, transparent); }}
.col {{ display: flex; flex-direction: column; justify-content: space-between; padding: 64px 64px 56px 10px; }}
.word svg {{ height: 46px; display: block; }}
h1 {{ font: 400 46px/52px "Instrument Serif", Georgia, serif; letter-spacing: -0.01em; margin: 0; max-width: 470px; }}
.ev {{ font: 400 15px/24px "Geist Mono", ui-monospace, monospace; color: {TEXT_2};
       font-variant-numeric: tabular-nums slashed-zero; border-top: 1px solid {LINE}; padding-top: 16px; }}
.ev b {{ font-weight: 400; color: {TEXT}; }}
.ev span {{ color: {TEXT_3}; }}
</style></head><body>
<img class="art" src="data:image/png;base64,{art}" alt="">
<div class="col">
  <div class="word">{word}</div>
  <h1>Sixty-four slime molds that earn, hire and grow by trading with each other.</h1>
  <div class="ev">
    <b>Spore #{SPORE}</b> · epoch {EPOCH} · {TUBES} tubes<br>
    <span>image</span> {short} <span>committed on chain</span><br>
    <span>NEAR testnet ·</span> spores-hack-router4.testnet
  </div>
</div>
</body></html>
"""


def manifest():
    return json.dumps({
        "name": "Spores",
        "short_name": "Spores",
        "description": "Sixty-four slime molds that earn, hire and grow by trading with each other.",
        "start_url": "/",
        "display": "standalone",
        "background_color": BG,
        "theme_color": BG,
        "icons": [
            {"src": "/favicon.svg", "type": "image/svg+xml", "sizes": "any"},
            {"src": "/icon-192.png", "type": "image/png", "sizes": "192x192"},
            {"src": "/icon-512.png", "type": "image/png", "sizes": "512x512"},
        ],
    }, indent=2) + "\n"


def main():
    w = lambda name, s: (OUT / name).write_text(s)
    w("mark.svg", mark_svg(TEXT, BG, nucleus=SLIME))
    w("mark-ink.svg", mark_svg(BG, PAPER))
    w("mark-tile.svg", mark_svg(TEXT, BG, nucleus=SLIME, fill_bg=True, pad=72))
    w("wordmark.svg", wordmark_svg(TEXT, nucleus=SLIME))
    w("wordmark-ink.svg", wordmark_svg(BG))
    w("lockup.svg", lockup_svg(TEXT, BG, nucleus=SLIME))
    w("lockup-ink.svg", lockup_svg(BG, PAPER))
    # Small sizes: the 64 dots become one ring line and strokes thicken.
    favicon = mark_svg(TEXT, BG, nucleus=SLIME, fill_bg=True, dots=False, weight=1.7, pad=40, radius=96)
    w("favicon.svg", favicon)
    w("manifest.webmanifest", manifest())
    (OUT / "src").mkdir(exist_ok=True)
    w("src/social-card.html", social_card_html())


if __name__ == "__main__":
    main()
