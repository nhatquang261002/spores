#!/usr/bin/env bash
# Rebuilds brand/: SVGs from build.py, then PNGs with headless Chrome.
# PYTHON must have fonttools, brotli and uharfbuzz; CHROME overrides the browser path.
set -euo pipefail
cd "$(dirname "$0")"
PYTHON="${PYTHON:-python3}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$PYTHON" build.py

shot() { # <absolute source path> <out.png> <w> <h> [transparent]
  local bg=()
  [ "${5:-}" = transparent ] && bg=(--default-background-color=00000000)
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$TMP/profile" \
    --force-device-scale-factor=1 --window-size="$3,$4" ${bg[@]+"${bg[@]}"} \
    --screenshot="$PWD/$2" "file://$1" >/dev/null 2>&1
}

wrap() { # <svg> <size> <css background> -> page that fills the window with the svg
  local html="$TMP/$(basename "$1" .svg)-$2.html"
  printf '<html><body style="margin:0;background:%s"><img src="file://%s" style="display:block;width:%spx;height:%spx"></body></html>' \
    "$3" "$PWD/$1" "$2" "$2" > "$html"
  echo "$html"
}

shot "$PWD/src/social-card.html" social-card.png 1200 630
for s in 512 192 180 32; do
  shot "$(wrap favicon.svg "$s" transparent)" "icon-$s.png" "$s" "$s" transparent
done
BG="$(sed -n 's/^  --bg: *\(#[0-9a-fA-F]*\);.*/\1/p' ../viz/src/ui/tokens.css)"
shot "$(wrap mark-tile.svg 400 "$BG")" avatar-400.png 400 400

# What the app serves (viz/index.html, manifest.webmanifest). viz/test/brand.test.ts
# fails if these drift from tokens.css or from brand/.
PUB=../viz/public
cp favicon.svg manifest.webmanifest social-card.png icon-192.png icon-512.png "$PUB/"
cp icon-180.png "$PUB/apple-touch-icon.png"
echo "brand/: $(ls *.svg *.png | tr '\n' ' ')"
