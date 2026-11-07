#!/usr/bin/env bash
# Phase 5 exit run on testnet: the agents trade on the Phase 5 router
# for 8 epochs while the keeper commits an image of every spore after each
# close; at the third epoch the sale scene runs (list, buy with royalty, old
# operator key and old owner refused, new owner registers operator2, the agent
# resumes). The report runs spores-verify over every close of the router and
# regenerates the sold spore's committed image. Needs scripts/phase5-setup.sh.
# Output: out/agents/<run>/ and a copy of the report in out/phase5/.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
RUN=${RUN:-phase5-$(date -u +%Y%m%dT%H%M%SZ)}
EPOCHS=${EPOCHS:-8}
ROUTER=$(grep '^PHASE5_ROUTER_ACCOUNT_ID=' .env | tail -1 | cut -d= -f2)
[ -n "$ROUTER" ] || { echo "PHASE5_ROUTER_ACCOUNT_ID missing from .env: run scripts/phase5-setup.sh first"; exit 2; }
[ -d agents/node_modules ] || (cd agents && npm ci --silent)
mkdir -p out/phase5
status=0
ROUTER="$ROUTER" KEY_PREFIX=P5_ node agents/src/run.ts --spores 0-8 --epochs "$EPOCHS" --seed 1 --run "$RUN" --shocks "${SHOCKS:-sale@3}" || status=$?
cp "out/agents/$RUN/report.md" "out/agents/$RUN/report.json" out/phase5/ 2>/dev/null || true
cp "out/agents/$RUN/decisions.jsonl" "out/agents/$RUN/events.jsonl" out/phase5/ 2>/dev/null || true
echo "run dir: out/agents/$RUN (exit $status)"
exit $status
