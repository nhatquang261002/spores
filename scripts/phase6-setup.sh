#!/usr/bin/env bash
# Phase 6 setup: grow router4 to 64 active spores.
# Builds the router wasm; with REDEPLOY=1 deploys it to router4 as code only
# (state kept); raises max_active to 64 from the admin; funds the deployer and
# the operator from faucet accounts; activates spores 9-63 with the Phase 5
# policy; adds their P6_ function-call keys. TOPUP=1 also refills spores below
# SPORE_MIN and the operator's gas float. Idempotent (agents/src/setup.ts with
# SETUP_PHASE=6). Keys go to the git-ignored .env and are never printed. Exits
# 2 with the shortfall if the faucet accounts cannot cover a step.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
(cd router && cargo near build non-reproducible-wasm --profile contract >/dev/null 2>&1)
shasum -a 256 target/near/spores_router/spores_router.wasm
[ -d agents/node_modules ] || (cd agents && npm ci --silent)
SETUP_PHASE=6 node agents/src/setup.ts
