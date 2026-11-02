#!/usr/bin/env bash
# Phase 5 testnet setup: build the router wasm, then create and deploy the
# Phase 5 router (spores-hack-router4.testnet, a faucet account), top up the
# owner and buyer from the abandoned v0 router's surplus above storage, create
# operator2 (the buyer's operator after the sale), activate 9 spores and add
# the P5_ function-call keys (agents/src/setup.ts with SETUP_PHASE=5).
# Idempotent. Keys go to the git-ignored .env and are never printed. Exits 2
# with the shortfall if an account lacks the testnet NEAR for a step.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
(cd router && cargo near build non-reproducible-wasm --profile contract >/dev/null 2>&1)
shasum -a 256 target/near/spores_router/spores_router.wasm
[ -d agents/node_modules ] || (cd agents && npm ci --silent)
SETUP_PHASE=5 node agents/src/setup.ts
