#!/usr/bin/env bash
# Phase 4 exit run on testnet: the agents trade unattended for 8
# epochs on the Phase 4 router with the outside service, the keeper and the
# three scripted shocks (raise the runner-up's cost, cut the strongest tube,
# kill the best-value provider). Checks the exit criteria and replays every
# hire against spores_core. Needs scripts/phase4-setup.sh to have run.
# Output: out/agents/<run>/ (logs, decisions.jsonl, snapshots, renders,
# report.md) and a copy of the report in out/phase4/.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
RUN=${RUN:-phase4-$(date -u +%Y%m%dT%H%M%SZ)}
EPOCHS=${EPOCHS:-8}
[ -d agents/node_modules ] || (cd agents && npm ci --silent)
mkdir -p out/phase4
status=0
node agents/src/run.ts --spores 0-8 --epochs "$EPOCHS" --seed 1 --run "$RUN" --shocks raise@4,cut@5,kill@6 || status=$?
cp "out/agents/$RUN/report.md" "out/agents/$RUN/report.json" out/phase4/ 2>/dev/null || true
cp "out/agents/$RUN/decisions.jsonl" out/phase4/ 2>/dev/null || true
echo "run dir: out/agents/$RUN (exit $status)"
exit $status
