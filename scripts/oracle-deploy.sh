#!/usr/bin/env bash
# Deploys the open-ended supervisor (agents/src/auto.ts) to a plain Ubuntu VM
# (an Oracle Always Free instance) as a systemd service that restarts on crash
# and on reboot. Testnet only.
#
#   HOST=ubuntu@<ip> bash scripts/oracle-deploy.sh            # deploy and start
#   HOST=ubuntu@<ip> START=0 bash scripts/oracle-deploy.sh    # deploy, don't start
#   HOST=ubuntu@<ip> bash scripts/oracle-deploy.sh status     # service state and last log lines
#   HOST=ubuntu@<ip> bash scripts/oracle-deploy.sh stop
#
# Copies only agents/ and outside/ and a .env holding the names the worker
# reads: ids, the function-call keys, and the owner/buyer/funder keys that
# demo-prep needs to top up spores. Never the deployer, router, operator or
# outside full-access keys. Values are never printed. Do not run it while
# scripts/auto.sh runs on this machine: two supervisors share the same keys.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${HOST:?set HOST=user@ip}"
KEY=${KEY:-$HOME/.ssh/spores-oracle}
START=${START:-1}
RUSER=${HOST%@*}
SSHO=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
remote() { ssh "${SSHO[@]}" "$HOST" "$@"; }

case "${1:-deploy}" in
  status) remote 'systemctl is-active spores-auto; cat ~/spores/out/auto/status.json 2>/dev/null; echo ---; tail -6 ~/spores/out/auto/auto.log 2>/dev/null'; exit 0 ;;
  stop) remote 'sudo systemctl stop spores-auto && echo stopped'; exit 0 ;;
  deploy) ;;
  *) echo "usage: HOST=user@ip bash scripts/oracle-deploy.sh [deploy|status|stop]"; exit 2 ;;
esac

[ -f .env ] || { echo "no .env"; exit 1; }
if [ -f out/auto/auto.pid ] && kill -0 "$(cat out/auto/auto.pid)" 2>/dev/null; then echo "scripts/auto.sh is running here: stop it first"; exit 1; fi

ALLOW='^(PHASE5_ROUTER_ACCOUNT_ID|KEEPER_ACCOUNT_ID|DEPLOYER_ACCOUNT_ID|OPERATOR_ACCOUNT_ID|OPERATOR2_ACCOUNT_ID|OUTSIDE_ACCOUNT_ID|OWNER_ACCOUNT_ID|BUYER_ACCOUNT_ID|OWNER_PRIVATE_KEY|BUYER_PRIVATE_KEY|P6_FUND_[0-9]+_PRIVATE_KEY|P[567]_KEEPER_FC_PRIVATE_KEY|P[567]_OPERATOR2_FC_PRIVATE_KEY|P[567]_SPORE_[0-9]+_FC_PRIVATE_KEY)='
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
grep -E "$ALLOW" .env > "$TMP"
echo "env: $(wc -l < "$TMP" | tr -d ' ') variables selected (values not shown)"

echo "node on the VM:"
remote 'if command -v node >/dev/null && node -e "process.exit(+process.versions.node.split(\".\")[0]>=24?0:1)"; then node -v; else curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null 2>&1 && sudo apt-get install -y nodejs >/dev/null 2>&1 && node -v; fi'

remote 'mkdir -p ~/spores/out'
rsync -az --delete -e "ssh ${SSHO[*]}" --exclude node_modules --exclude test agents outside "$HOST":spores/
rsync -e "ssh ${SSHO[*]}" "$TMP" "$HOST":spores/.env
remote 'chmod 600 ~/spores/.env && cd ~/spores/agents && npm ci --omit=dev --silent && echo "deps installed"'

remote "sudo tee /etc/systemd/system/spores-auto.service >/dev/null" <<UNIT
[Unit]
Description=Spores keeper and agents (testnet)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUSER
WorkingDirectory=/home/$RUSER/spores
Environment=AUTO_HOLD_ON_STOP=1
ExecStart=/usr/bin/node agents/src/auto.ts
Restart=always
RestartSec=10
KillMode=control-group
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
UNIT
remote 'sudo systemctl daemon-reload && sudo systemctl enable spores-auto >/dev/null 2>&1'
if [ "$START" = 1 ]; then
  remote 'sudo systemctl restart spores-auto && sleep 5 && systemctl is-active spores-auto'
  echo "started. HOST=$HOST bash scripts/oracle-deploy.sh status"
else
  echo "deployed, not started: ssh in and run: sudo systemctl start spores-auto"
fi
