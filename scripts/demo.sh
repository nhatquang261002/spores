#!/usr/bin/env bash
# The one command.
#
#   bash scripts/demo.sh                     a real run on testnet, followed in the browser
#   bash scripts/demo.sh --playback [run]    a committed recording: no keys, no testnet
#
# Options: --epochs N (default 9), --spores N (default 12), --port N, --no-open,
# --exit-at-end (stop instead of leaving the app and the scene server up).
#
# A real run spends testnet gas, closes real epochs and really sells one spore,
# which stays with the buyer. Keys come from .env and are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

PLAYBACK=0 RUN_ARG="" EPOCHS=9 SPORES=12 PORT="" OPEN=1 EXIT_AT_END=0
while [ $# -gt 0 ]; do
  case "$1" in
    --playback) PLAYBACK=1; if [ $# -gt 1 ] && [ "${2#--}" = "$2" ]; then RUN_ARG=$2; shift; fi ;;
    --epochs) EPOCHS=$2; shift ;;
    --spores) SPORES=$2; shift ;;
    --port) PORT=$2; shift ;;
    --no-open) OPEN=0 ;;
    --exit-at-end) EXIT_AT_END=1 ;;
    -h|--help) sed -n 2,11p "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)"; exit 2 ;;
  esac
  shift
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then B=$'\e[1m' D=$'\e[2m' Y=$'\e[33m' R=$'\e[0m'; else B="" D="" Y="" R=""; fi
ok()   { echo "  ✓ $1"; }
head() { echo; echo "  ${B}$1${R}"; }
die()  { echo "  ✕ $1"; [ $# -gt 1 ] && echo "    ${B}$2${R}"; exit 1; }

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
trap 'echo; exit 130' INT TERM

mkdir -p out/demo

echo
echo "  ${Y}●${R} ${B}Spores${R}  ${D}the whole loop, $([ $PLAYBACK = 1 ] && echo 'from a recording' || echo 'live on NEAR testnet')${R}"

head "Getting ready"
command -v node >/dev/null || die "Node is not installed" "install Node 23.6 or newer"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>23||(a===23&&b>=6)?0:1)' || die "Node $(node -v) is too old: this needs 23.6 or newer" "install Node 23.6 or newer"
ok "node $(node -v)"

if [ $PLAYBACK = 0 ]; then
  command -v cargo >/dev/null || die "cargo not found on PATH or in ~/.cargo/bin" "install Rust from rustup.rs"
  ok "$(cargo --version | cut -d' ' -f1,2)"
  SETUP="bash scripts/phase6-setup.sh"
  [ -f .env ] || die "no .env: a real run signs with testnet keys" "$SETUP"
  ROUTER=$(grep '^PHASE5_ROUTER_ACCOUNT_ID=' .env | tail -1 | cut -d= -f2 || true)
  [ -n "$ROUTER" ] || die ".env has no PHASE5_ROUTER_ACCOUNT_ID" "$SETUP"
  grep -q '^P6_KEEPER_FC_PRIVATE_KEY=' .env || die ".env has no P6_ keys" "$SETUP"
  ok ".env has P6_ keys, router $ROUTER"
fi

install_deps() {
  # Skipped when the lockfile hasn't moved: playback has to start with the network off.
  if [ ! -f "$1/node_modules/.package-lock.json" ] || [ "$1/package-lock.json" -nt "$1/node_modules/.package-lock.json" ]; then
    (cd "$1" && npm ci --silent) > "out/demo/npm-$1.log" 2>&1 || die "npm ci failed in $1, see out/demo/npm-$1.log"
    ok "installed $1 packages"
  fi
}
install_deps viz

if [ $PLAYBACK = 0 ] || [ ! -f viz/public/wasm/manifest.json ]; then
  bash scripts/build-wasm.sh > out/demo/build-wasm.log 2>&1 || die "wasm build failed, see out/demo/build-wasm.log"
  ok "wasm built and checked against the shared vectors"
fi

free_port() { node -e 'const n=require("net");const t=p=>{const s=n.createServer();s.once("error",()=>t(p+1));s.once("listening",()=>s.close(()=>console.log(p)));s.listen(p,"127.0.0.1")};t(+process.argv[1])' "$1"; }

start_app() {
  [ -n "$PORT" ] || PORT=$(free_port 5173)
  (cd viz && exec npx --no-install vite --port "$PORT" --strictPort) > out/demo/viz.log 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then ok "app on http://127.0.0.1:$PORT"; return; fi
    sleep 0.5
  done
  die "the app did not start, see out/demo/viz.log"
}

show() {
  echo
  echo "  ${B}Open this:${R}  ${Y}$1${R}"
  if [ $OPEN = 1 ]; then
    if command -v open >/dev/null; then open "$1" || true; elif command -v xdg-open >/dev/null; then xdg-open "$1" >/dev/null 2>&1 || true; fi
  fi
}

# --- playback ------------------------------------------------------------------
if [ $PLAYBACK = 1 ]; then
  ENTRY=$(RUN_ARG="$RUN_ARG" node -e '
    const all = JSON.parse(require("fs").readFileSync("viz/public/recorded/index.json", "utf8"));
    const want = process.env.RUN_ARG;
    const loops = all.filter((b) => (want ? b.run === want : b.scene === "loop")).sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!loops[0]) { console.error(want ? `no recording called ${want}. There are: ${all.map((b) => b.run).join(", ")}` : "no recording of the whole loop in this checkout"); process.exit(1); }
    console.log(`${loops[0].run} ${loops[0].date} ${loops[0].scene ?? ""}`);
  ') || die "nothing to play"
  read -r RUN DATE SCENE <<<"$ENTRY"
  ok "recording $RUN, $DATE"
  start_app
  PAGE=/lab/loop
  { [ "$SCENE" = rogue ] || [ "$SCENE" = sale ]; } && PAGE=/lab/$SCENE
  show "http://127.0.0.1:$PORT$PAGE?source=recorded&run=$RUN&date=$DATE"
  echo
  echo "  ${D}Everything on that page is read from viz/public/recorded/$RUN. Nothing is happening now.${R}"
  echo "  ${D}Verify still re-checks its closes against the chain when there is a network, and says Unable when not.${R}"
  [ $EXIT_AT_END = 1 ] && exit 0
  echo "  ${D}Ctrl-C to stop.${R}"
  wait
  exit 0
fi

# --- a real run ----------------------------------------------------------------
install_deps agents
cargo build --release -q -p spores-renderer -p spores-sim -p spores-verify > out/demo/build.log 2>&1 || die "cargo build failed, see out/demo/build.log"
ok "renderer, sim and verify built"

PLAN=$(ROUTER="$ROUTER" KEY_PREFIX=P6_,P5_ node agents/src/demo-prep.ts --spores "$SPORES")
read -r SPORE_LIST HERO < <(node -e 'const p=JSON.parse(process.argv[1]);console.log(p.spores,p.hero)' "$PLAN")
ok "spores $SPORE_LIST will trade; Spore #$HERO is the one to watch"

RUN=demo-$(date -u +%Y%m%dT%H%M%SZ)
export ROUTER KEY_PREFIX=P6_,P5_
export NEAR_RPCS=${NEAR_RPCS:-https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://testnet-rpc.intea.rs}
export QUOTE_FANOUT=${QUOTE_FANOUT:-3} RPC_CONCURRENCY=${RPC_CONCURRENCY:-8} CONTROL_EVERY=${CONTROL_EVERY:-1000}
export POST_EVERY=${POST_EVERY:-1} BUY_EVERY=${BUY_EVERY:-4} JOBS_PER_EPOCH=${JOBS_PER_EPOCH:-1} POLL_MS=${POLL_MS:-3000}

start_app

head "The run"
node agents/src/run.ts --spores "$SPORE_LIST" --epochs "$EPOCHS" --seed 1 --run "$RUN" --shocks "sale@${SALE_AT:-5}" --sale-spore "$HERO" --per-process "$SPORES" > "out/demo/$RUN.log" 2>&1 &
RUN_PID=$!
PIDS+=("$RUN_PID")
for _ in $(seq 1 120); do
  [ -f "out/agents/$RUN/run.json" ] && break
  kill -0 "$RUN_PID" 2>/dev/null || die "the run stopped before it began, see out/demo/$RUN.log"
  sleep 0.5
done
[ -f "out/agents/$RUN/run.json" ] || die "the run did not start in a minute, see out/demo/$RUN.log"
ok "run $RUN started, log in out/demo/$RUN.log"
show "http://127.0.0.1:$PORT/lab/loop?source=run&run=$RUN"
echo
STATUS=0
node agents/src/demo-watch.ts "$RUN" --pid "$RUN_PID" || STATUS=$?
wait "$RUN_PID" 2>/dev/null || true

head "Checking it, from the chain"
node agents/src/record-bundle.ts "$RUN" --closes-only | sed 's/^/  /'
NAME=$(echo "$ROUTER" | grep -oE 'router[0-9]*')
CLOSES=docs/$NAME-closes.txt
SOLD=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sale_spore ?? "")' "out/agents/$RUN/run.json")
echo "  ${D}\$ spores-verify epochs --router $ROUTER --closes $CLOSES${R}"
target/release/spores-verify epochs --router "$ROUTER" --closes "$CLOSES" 2>&1 | tail -3 | sed 's/^/  /' || STATUS=1
echo "  ${D}\$ spores-verify image --router $ROUTER --closes $CLOSES --spore $SOLD${R}"
target/release/spores-verify image --router "$ROUTER" --closes "$CLOSES" --spore "$SOLD" 2>&1 | tail -4 | sed 's/^/  /' || STATUS=1

echo
if [ "$STATUS" = 0 ]; then
  echo "  ✓ ${B}Done.${R} To keep it as a recording: ${B}bash scripts/record-bundle.sh $RUN${R}"
else
  echo "  ✕ ${B}The run failed a check.${R} The report: out/agents/$RUN/report.md"
fi
[ $EXIT_AT_END = 1 ] && exit "$STATUS"

# Started only now: scenes and the run share accounts and nonces.
node agents/src/scene-server.ts > out/demo/scene-server.log 2>&1 &
PIDS+=($!)
ok "scene server on 127.0.0.1:8790, so the Demo Lab can run scenes live"
echo "  ${D}The app stays up. Ctrl-C to stop.${R}"
wait
