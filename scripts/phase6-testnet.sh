#!/usr/bin/env bash
# Phase 6 dense run on router4 (docs/phase6-plan.md S3): every active spore
# trades, all of them in one agent process (--per-process) that shares its RPC
# reads, with a limited quote fan-out (the router keeps 8 quotes per job) and
# a cap on concurrent RPC requests. The report adds per-close seconds, gas,
# log bytes, pairs and RPC requests per epoch, and runs spores-verify over
# every close of the router. Needs scripts/phase6-setup.sh.
# Output: out/agents/<run>/ and a copy of the report in out/phase6/.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
RUN=${RUN:-phase6-$(date -u +%Y%m%dT%H%M%SZ)}
EPOCHS=${EPOCHS:-3}
SPORES=${SPORES:-0-63}
ROUTER=$(grep '^PHASE5_ROUTER_ACCOUNT_ID=' .env | tail -1 | cut -d= -f2)
[ -n "$ROUTER" ] || { echo "PHASE5_ROUTER_ACCOUNT_ID missing from .env: run scripts/phase5-setup.sh first"; exit 2; }
[ -d agents/node_modules ] || (cd agents && npm ci --silent)
mkdir -p out/phase6
status=0
# Public testnet RPCs without a key (docs.near.org/api/rpc/providers, 2026-11-03).
ROUTER="$ROUTER" KEY_PREFIX=P6_,P5_ \
  NEAR_RPCS=${NEAR_RPCS:-https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://testnet-rpc.intea.rs} \
  QUOTE_FANOUT=${QUOTE_FANOUT:-2} RPC_CONCURRENCY=${RPC_CONCURRENCY:-8} CONTROL_EVERY=${CONTROL_EVERY:-1000} \
  POST_EVERY=${POST_EVERY:-2} BUY_EVERY=${BUY_EVERY:-16} JOBS_PER_EPOCH=${JOBS_PER_EPOCH:-1} POLL_MS=${POLL_MS:-3000} \
  node agents/src/run.ts --spores "$SPORES" --epochs "$EPOCHS" --seed 1 --run "$RUN" --shocks "${SHOCKS:-}" --per-process "${PER_PROCESS:-64}" || status=$?
cp "out/agents/$RUN/report.md" "out/agents/$RUN/report.json" out/phase6/ 2>/dev/null || true
echo "run dir: out/agents/$RUN (exit $status)"
exit $status
