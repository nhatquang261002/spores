#!/usr/bin/env bash
# Build the router wasm and deploy it, with init, to $ROUTER_ACCOUNT_ID on testnet.
# Demo timings: 30 s epochs, 60 s job timeout; graph, fee and pool values are Params::shipped().
# `new` can run only once per account: a re-run needs a fresh account.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/near-lib.sh

(cd router && cargo near build non-reproducible-wasm --profile contract)
WASM=target/near/spores_router/spores_router.wasm
shasum -a 256 "$WASM"

ARGS=$(jq -cn --arg admin "$DEPLOYER_ACCOUNT_ID" '{admin: $admin, config: {
  supply_cap: 64, max_active: 16,
  epoch_len_ns: "30000000000", job_timeout_ns: "60000000000",
  min_activation_deposit: "100000000000000000000000",
  decay_bps: 2500, gain: "1000000", k: "100000000000000000000000", d_min: "50000",
  fee_bps: 100, rebate_bps: 5000, breadth_full: 4, reject_bps: 5000}}')

near contract deploy "$ROUTER" use-file "$WASM" with-init-call new json-args "$ARGS" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet \
  sign-with-plaintext-private-key "$ROUTER_PRIVATE_KEY" send 2>&1 |
  grep -E 'Transaction ID|succeeded|Error|panicked'
view config | jq -c
view storage_report | jq -c
