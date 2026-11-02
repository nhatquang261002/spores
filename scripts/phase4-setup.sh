#!/usr/bin/env bash
# Phase 4 testnet setup: build the router wasm, then create, deploy and fund the
# Phase 4 router (router3.<parent>), the outside-service account, 9 active
# spores and the per-spore operator keys (agents/src/setup.ts). Idempotent.
# Keys go to the git-ignored .env and are never printed. Exits 2 with the
# shortfall if an account lacks the testnet NEAR for a step.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
(cd router && cargo near build non-reproducible-wasm --profile contract >/dev/null 2>&1)
shasum -a 256 target/near/spores_router/spores_router.wasm
[ -d agents/node_modules ] || (cd agents && npm ci --silent)
node agents/src/setup.ts
