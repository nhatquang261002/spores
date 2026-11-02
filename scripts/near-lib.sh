# Shared helpers for testnet scripts. Source from the repo root.
# Keys come from the git-ignored .env (environment variables only) and are never printed.
# Each call is signed by near-cli-rs (`save-to-file`) and sent with RPC `send_tx`
# (wait_until FINAL), so failed calls also get a transaction hash.

export PATH="$HOME/.cargo/bin:$PATH"
set -a
. ./.env
set +a
ROUTER=${ROUTER:-$ROUTER_ACCOUNT_ID}
RPC=${NEAR_RPC:-https://test.rpc.fastnear.com}
EXPLORER=https://testnet.nearblocks.io/txns
OUT=${OUT:-out/testnet}
mkdir -p "$OUT"
LOG=${LOG:-$OUT/run.log}
PASSES=0
FAILURES=0

view() { scripts/view.sh "$ROUTER" "$1" "${2:-{\}}"; }

# Transaction hash of a base64 signed ed25519 transaction: base58(sha256(borsh(tx))),
# where the signed bytes are borsh(tx) followed by a 65-byte signature.
tx_hash() {
  python3 -c '
import base64, hashlib, sys
b = base64.b64decode(sys.argv[1])[:-65]
n = int.from_bytes(hashlib.sha256(b).digest(), "big")
a = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
s = ""
while n:
    n, r = divmod(n, 58)
    s = a[r] + s
print(s)' "$1"
}

# tx <signer> <private key> <method> <json args> [deposit] [gas] [receiver]
# Sets TX_HASH, TX_OK (1 or 0), TX_ERR, TX_GAS (total gas burnt, Tgas) and TX_RET.
tx() {
  local signer=$1 key=$2 method=$3 args=$4 deposit=${5:-0 NEAR} gas=${6:-100 Tgas} receiver=${7:-$ROUTER}
  local dir res
  dir=$(mktemp -d)
  if ! near contract call-function as-transaction "$receiver" "$method" json-args "$args" \
    prepaid-gas "$gas" attached-deposit "$deposit" sign-as "$signer" network-config testnet \
    sign-with-plaintext-private-key "$key" save-to-file "$dir/stx.json" >/dev/null 2>&1; then
    rm -rf "$dir"
    TX_HASH="" TX_OK=0 TX_ERR="signing failed" TX_GAS=0 TX_RET=""
    return 0
  fi
  local stx hash i
  stx=$(jq -r .signed_transaction_as_base64 "$dir/stx.json")
  rm -rf "$dir"
  hash=$(tx_hash "$stx")
  # An RPC call once hung for 48 min with the transaction already executed, so
  # time out and then poll the status by hash.
  res=$(jq -n --arg t "$stx" '{jsonrpc:"2.0",id:1,method:"send_tx",params:{signed_tx_base64:$t,wait_until:"FINAL"}}' |
    curl -s --max-time 60 "$RPC" -H 'content-type: application/json' -d @-) || res=""
  for i in 1 2 3 4 5 6; do
    if jq -e '.result.status' >/dev/null 2>&1 <<<"$res" || jq -e '.error.cause.name == "INVALID_TRANSACTION"' >/dev/null 2>&1 <<<"$res"; then break; fi
    sleep 5
    res=$(jq -n --arg h "$hash" --arg s "$signer" '{jsonrpc:"2.0",id:1,method:"tx",params:{tx_hash:$h,sender_account_id:$s,wait_until:"FINAL"}}' |
      curl -s --max-time 30 "$RPC" -H 'content-type: application/json' -d @-) || res=""
  done
  TX_HASH=$(jq -r '.result.transaction.hash // empty' <<<"$res")
  [ -n "$TX_HASH" ] || TX_HASH="$hash(not included)"
  TX_OK=$(jq -r 'if .result.status.SuccessValue != null then 1 else 0 end' <<<"$res")
  # A contract panic, an action error, or an RPC-level rejection (e.g. a key not allowed to call the method).
  TX_ERR=$(jq -r '[.. | .ExecutionError? // empty][0] // (.result.status.Failure // .error.data // .error // empty | tostring)' <<<"$res")
  TX_GAS=$(jq -r '[.result.transaction_outcome.outcome.gas_burnt, (.result.receipts_outcome[]?.outcome.gas_burnt)] | map(select(. != null)) | add // 0 | . / 1e12 | (. * 100 | round) / 100' <<<"$res")
  TX_RET=$(jq -r '.result.status.SuccessValue // empty' <<<"$res" | base64 -d 2>/dev/null || true)
}

record() { # record <PASS|FAIL> <step> <detail>
  local line
  line=$(printf '%-4s | %-48s | %s | %s Tgas | %s' "$1" "$2" "${TX_HASH:--}" "${TX_GAS:-0}" "$3")
  echo "$line" | tee -a "$LOG"
  if [ "$1" = PASS ]; then PASSES=$((PASSES + 1)); else FAILURES=$((FAILURES + 1)); fi
}

# must_succeed <step> <tx args...>
must_succeed() {
  local step=$1
  shift
  tx "$@"
  if [ "$TX_OK" = 1 ]; then record PASS "$step" "ok ${TX_RET:0:80}"; else record FAIL "$step" "unexpected failure: $TX_ERR"; fi
}

# must_fail <step> <expected error substring> <tx args...>
must_fail() {
  local step=$1 expect=$2
  shift 2
  tx "$@"
  if [ "$TX_OK" = 1 ]; then
    record FAIL "$step" "succeeded but should have failed"
  elif [[ "$TX_ERR" == *"$expect"* ]]; then
    record PASS "$step" "rejected: $TX_ERR"
  else
    record FAIL "$step" "failed with an unexpected error: $TX_ERR"
  fi
}

# check <step> <condition description> <bash test...>
check() {
  local step=$1 what=$2
  shift 2
  TX_HASH="" TX_GAS=0
  if "$@"; then record PASS "$step" "$what"; else record FAIL "$step" "NOT: $what"; fi
}
