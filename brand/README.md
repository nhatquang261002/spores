# Spores brand

The brand comes from the product. The app is "a field instrument for a living culture". The mark is a real spore drawn in the renderer's own geometry, and its colours are the app's own tokens: `build.py` reads them from `viz/src/ui/tokens.css`, so the brand follows the app's theme. This file covers the assets. Tokens, type scale and UI rules stay in Design §3–§9 and are not repeated here.

## Assets

| File | What | Use |
| --- | --- | --- |
| `mark.svg` | Full mark, light ink, transparent | Dark backgrounds, 48 px and up |
| `mark-ink.svg` | Full mark, dark ink, transparent | Light backgrounds, 48 px and up |
| `mark-tile.svg`, `avatar-400.png` | Full mark on `--bg`, square | Profile pictures (X, GitHub, NEAR), slides |
| `favicon.svg`, `icon-32.png`, `icon-180.png`, `icon-192.png`, `icon-512.png` | Small-size mark on a rounded `--bg` tile | Browser tab, home screen, app icons |
| `manifest.webmanifest` | Web app manifest (name, icons, `--bg` as theme and background) | Served by the app |
| `wordmark.svg`, `wordmark-ink.svg` | Nucleus dot + "Spores", outlined | Where the app top bar's wordmark appears outside the app |
| `lockup.svg`, `lockup-ink.svg` | Mark + "Spores", outlined | README header, title slides, the demo video's first frame |
| `social-card.png` (source `src/social-card.html`) | 1200×630 card | `og:image`, link previews, the X demo post |

## In the app

- **Served files:** `build.sh` copies these into `viz/public/`: `favicon.svg`, `manifest.webmanifest`, `social-card.png`, `icon-192.png`, `icon-512.png`, and `icon-180.png` as `apple-touch-icon.png`. `viz/index.html` links the favicon, touch icon and manifest, and sets `theme-color` to `--bg`.
- **Logo:** both top bars show `favicon.svg`, the small-size mark, beside "Spores" set live in CSS (`.wordmark`, `.brand-mark`). The bar is under 48 px, so it uses the small mark rather than `lockup.svg`, and it has no nucleus dot, as the rule below requires.
- **Link previews:** `index.html` carries the static `og:` and `twitter:` title, description and card type. The absolute `og:image`, `twitter:image` and `og:url` are added at build time by `viz/server/siteMeta.ts`, only when `SITE_URL` is set: `SITE_URL=https://<host> npx vite build`. Link previews ignore relative image URLs, so without it no image tag is written.
- **Drift check:** `viz/test/brand.test.ts` fails if a copy in `viz/public/` differs from `brand/`, if the favicon, manifest or `theme-color` don't use the current `--bg`, `--text` and `--slime`, or if `index.html` links a missing file. After any token change, rerun `brand/build.sh`.

## The mark

The mark is **Spore #3** as recorded in the epoch-22 snapshot of the Phase 6 dense run on `spores-hack-router4.testnet` (`out/agents/phase6-s3-dense3/snapshots/epoch-022.json`). It has tubes to #8 (D 0.23), #25 (D 0.06) and #46 (D 0.13). Of all spores with 3–5 partners in the recorded runs, its partners are the most evenly spread around the ring, which is why it was picked.

It uses the renderer's coordinate system (`renderer/src/sim.rs`):
- **Ring:** 64 slots. Spore *N* sits at `N × 5.625°` clockwise from 12 o'clock, on radius 168 of a 512 canvas. Empty slots are dots, as in every artwork. The spore's own slot (#3) and its partners' slots are left out.
- **Partners:** ringed markers (open ring, bright core), pulled inward by `84 × D_norm`, the same rule the art uses.
- **Tubes:** width follows √D, as in the Network view. Each tube swells where it meets the nucleus.
- **Nucleus:** a solid disc at the centre.

So the mark is a true picture of the product: spore 8 is up and to the right in the mark, just as it is in every artwork and on the network map.

**Small sizes** (`favicon.svg` and the icons): the 64 dots merge into one ring line and every stroke is 1.7× thicker. Use this version below 48 px; use the full mark above it.

**Clear space:** at least the nucleus diameter on every side. The viewBoxes already include it.

## Wordmark and lockup

- **Wordmark:** "Spores" in Instrument Serif 400 with an 8/22 em nucleus dot and an 8/22 em gap. It is the app's top-bar wordmark (Design §5.2) at any size. The glyphs are outlined with HarfBuzz kerning, so the SVG doesn't need the font installed.
- **Lockup:** the full mark at 1.5× the cap height, then the name.
- Don't set "Spores" in another face, add a tagline inside the lockup, or use both the dot and the mark together.

## Colour

- **On dark** (the default): ink `--text` on `--bg`, with the nucleus in `--slime`, the yolk accent the app's wordmark nucleus uses. The values are read from `tokens.css` at build time (currently `#EEF2E4`, `#0A0F0B`, `#E8C547`).
- **On white** (`*-ink.svg`): monochrome `--bg` ink, because yolk on white is under 2:1.
- **No palette colour:** the five organism palettes (yolk, ember, violet, toxic, aqua) belong to individual spores (Design §3.1.3), so the brand marks never use them. Colour enters brand material only through a real spore's rendered art.
- **No status colour:** the semantic colours (`--growth`, `--agent`, `--value`, `--warn`) mean status in the app and never decorate brand material.

## Imagery

- **Real renders only.** Use renders from the shipped renderer with a provenance line in mono: spore, epoch, image hash, network and router. `social-card.png` shows Spore #5 at epoch 17, the spore that was sold on testnet. Its image hash `ac15a3e9…8cfe` was committed by `commit_image` (tx `6qdNvM7AC4bgwcG1fSHb7oXs5BjCA5JGgSLwmwQjTUZk`), and `verify image` reproduced it (`docs/how-it-works.md` §8.4).
- **Not allowed:** mock-ups, generated illustrations, stock imagery, or the `slime.py` prototype sheet with its invented names. Design §2 "Explicitly not used" applies too: no glows, gradients, blur or celebration effects.

## Voice

- **Copy rules:** follow Design §8.2. Keep it short, declarative and specific, and name the mechanism. Don't write "AI-powered", "revolutionary" or "unlock", and never imply returns.
- **The one line:** "Sixty-four slime molds that earn, hire and grow by trading with each other." It is the Overview line (Design §6.A) and the social card's line. Use it as written.

## Rebuild

```
python3 -m venv /tmp/brandvenv && /tmp/brandvenv/bin/pip install fonttools brotli uharfbuzz
PYTHON=/tmp/brandvenv/bin/python bash brand/build.sh
```

- **`build.py`** writes the SVGs and `src/social-card.html`. The tube data and the card's spore are constants at its top.
- **`build.sh`** rasterizes the PNGs with headless Chrome (`CHROME=` overrides the path) and copies the served files into `viz/public/`. Then run `(cd viz && npm test)`.

## Licences and naming

- **Fonts:** the outlined wordmark is derived from Instrument Serif (SIL OFL 1.1, `viz/public/fonts/OFL-instrument-serif.txt`). The OFL allows outlining glyphs into artwork. The README's "Libraries and AI-generated code" section already has to name the font.
- **Name:** these files use the project's working name, "Spores". The submission's project name is the team's call (CLAUDE.md hard rules). If it changes, edit `build.py` and rebuild.
- **`og:image`:** it needs the deployed absolute URL, so set `SITE_URL` when building for the host (see "In the app").
