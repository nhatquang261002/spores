#!/usr/bin/env bash
# Saves a finished run as a committed RECORDED bundle in viz/public/recorded/<run>/
# and lists it in recorded/index.json. Scans for secrets
# first and refuses a run that failed a check. Scene runs use record-scene.ts.
# Usage: bash scripts/record-bundle.sh <run>
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -eq 1 ] || { echo "usage: bash scripts/record-bundle.sh <run>   (a directory in out/agents/)"; exit 2; }
exec node agents/src/record-bundle.ts "$1"
