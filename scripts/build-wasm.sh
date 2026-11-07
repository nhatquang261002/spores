#!/usr/bin/env bash
# Builds the two browser wasm modules and copies them into viz/public/wasm/
# (git-ignored), then checks both against the shared vectors:
#   spores_renderer.wasm  release profile: the build vectors/renderer.json is checked against
#   spores_core_wasm.wasm wasm profile (size; Design §10 budget 250 kB)
#   manifest.json         renderer_version (from renderer/src/lib.rs) and each file's size and sha256;
#                         the render worker keys its cache on state hash + renderer_version
# Usage: scripts/build-wasm.sh [--no-check]
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

cargo build --release -p spores-renderer --target wasm32-unknown-unknown
cargo build --profile wasm -p spores-core-wasm --target wasm32-unknown-unknown

out=viz/public/wasm
mkdir -p "$out"
cp target/wasm32-unknown-unknown/release/spores_renderer.wasm "$out/"
cp target/wasm32-unknown-unknown/wasm/spores_core_wasm.wasm "$out/"

version=$(sed -nE 's/^pub const RENDERER_VERSION: u32 = ([0-9]+);.*/\1/p' renderer/src/lib.rs)
[[ -n "$version" ]] || { echo "build-wasm: RENDERER_VERSION not found in renderer/src/lib.rs" >&2; exit 1; }
entry() { printf '"%s": {"bytes": %s, "sha256": "%s"}' "$1" "$(wc -c < "$out/$1" | tr -d ' ')" "$(shasum -a 256 "$out/$1" | cut -d' ' -f1)"; }
printf '{"renderer_version": %s, "files": {%s, %s}}\n' "$version" "$(entry spores_renderer.wasm)" "$(entry spores_core_wasm.wasm)" > "$out/manifest.json"

if [[ "${1:-}" != "--no-check" ]]; then
  node renderer/js/check.mjs --wasm
  node core-wasm/js/check.mjs
fi
cat "$out/manifest.json"
