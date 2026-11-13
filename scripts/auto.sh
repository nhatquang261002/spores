#!/usr/bin/env bash
# Start, stop and check the open-ended supervisor (agents/src/auto.ts): the
# keeper closes epochs and the agents trade on router5, with no one watching.
#
#   bash scripts/auto.sh start [--spores 12] [--cycle-hours 6] [--min-keeper-near 1] [--min-operator-near 1] [--min-free-gb 1]
#   bash scripts/auto.sh status
#   bash scripts/auto.sh logs          # follow out/auto/auto.log
#   bash scripts/auto.sh stop
#
# `start` runs it in the background under caffeinate (the Mac stays awake while
# it runs). It spends testnet gas from the keeper and operator accounts until stopped, and stops
# itself below their balance floors and the disk floor. Keys come from .env.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
mkdir -p out/auto out/agents
PIDFILE=out/auto/auto.pid

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-status}" in
  start)
    shift
    running && { echo "already running (pid $(cat "$PIDFILE")): bash scripts/auto.sh status"; exit 1; }
    [ -f .env ] || { echo "no .env: run scripts/phase6-setup.sh"; exit 1; }
    [ -d agents/node_modules ] || (cd agents && npm ci --silent)
    nohup node agents/src/auto.ts "$@" > out/auto/nohup.log 2>&1 &
    echo $! > "$PIDFILE"
    # Keeps the Mac awake for as long as that pid lives; ends with it.
    command -v caffeinate >/dev/null && { nohup caffeinate -i -w "$(cat "$PIDFILE")" > /dev/null 2>&1 & }
    sleep 3
    running || { echo "it exited at once:"; tail -5 out/auto/nohup.log; exit 1; }
    echo "started (pid $(cat "$PIDFILE")). bash scripts/auto.sh status | logs | stop"
    ;;
  stop)
    running || { echo "not running"; exit 0; }
    kill "$(cat "$PIDFILE")"
    for _ in $(seq 1 40); do running || break; sleep 0.5; done
    running && { echo "still stopping (it waits for its processes): check again"; exit 1; }
    rm -f "$PIDFILE"
    echo "stopped"
    ;;
  status)
    if running; then echo "running, pid $(cat "$PIDFILE")"; else echo "NOT running"; fi
    [ -f out/auto/status.json ] && cat out/auto/status.json
    echo "--- last log lines"
    tail -5 out/auto/auto.log 2>/dev/null || echo "(no log yet)"
    ;;
  logs)
    tail -f out/auto/auto.log
    ;;
  *)
    echo "usage: bash scripts/auto.sh start|stop|status|logs"; exit 2
    ;;
esac
