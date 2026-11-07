#!/usr/bin/env bash
# Phase 3 exit run on testnet: mint, activate, operator function-call key
# limits, each policy rejection, job escrow, epoch close, first image from chain
# state, transfer lockout, timeout refund, ledger conservation.
#
# Needs a router freshly deployed by scripts/deploy-router.sh (no spore active yet)
# and .env with OWNER/OPERATOR/BUYER/DEPLOYER/ROUTER keys plus OPERATOR_FC_PRIVATE_KEY:
# a function-call key on the operator account limited to the router's job methods.
# Prints one line per step (PASS/FAIL, tx hash, gas) and writes out/phase3/run.log.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=out/phase3
LOG=$OUT/run.log
. scripts/near-lib.sh
: >"$LOG"

OWN=$OWNER_ACCOUNT_ID OWN_K=$OWNER_PRIVATE_KEY
OP=$OPERATOR_ACCOUNT_ID FC_K=$OPERATOR_FC_PRIVATE_KEY OP_FULL_K=$OPERATOR_PRIVATE_KEY
BUY=$BUYER_ACCOUNT_ID BUY_K=$BUYER_PRIVATE_KEY
DEP=$DEPLOYER_ACCOUNT_ID DEP_K=$DEPLOYER_PRIVATE_KEY

cent() { echo "${1}0000000000000000000000"; } # hundredths of a NEAR in yoctoNEAR
policy() { # policy <budget> <cap> <allow_all> <allowlist json>
  jq -cn --arg b "$1" --arg c "$2" --argjson all "$3" --argjson l "$4" \
    '{paused: false, budget_per_epoch: $b, max_payment: $c, allow_all_spores: $all, allowlist: $l}'
}
setp() { jq -cn --argjson id "$1" --argjson p "$2" '{spore_id: $id, policy: $p}'; }
summary() { view spore_summary "{\"spore_id\":$1}"; }
field() { summary "$1" | jq -r "$2"; }
plus() { python3 -c "import sys; print(int(sys.argv[1]) + int(sys.argv[2]))" "$1" "$2"; } # exact u128 sums
OPEN=$(policy "$(cent 20)" "$(cent 5)" true '[]')

# op <step> <method> <json>: the agent's call, signed with the operator's function-call key.
op() { must_succeed "$1" "$OP" "$FC_K" "$2" "$3"; }
op_fail() { must_fail "$1" "$2" "$OP" "$FC_K" "$3" "$4"; }
post() { op "$3" post_job "{\"spore_id\":$1,\"task\":\"summarize the feed\",\"max_price\":\"$2\"}"; JOB=$TX_RET; }
quote() { op "quote on job $1 by spore $2" quote "{\"job_id\":$1,\"spore_id\":$2,\"price\":\"$3\"}"; }
accept() { op "accept job $1 from spore $2" accept "{\"job_id\":$1,\"provider_id\":$2}"; }
deliver() { op "deliver job $1" deliver "{\"job_id\":$1,\"result_hash\":\"sha256:5f2a\"}"; }
trade() { # trade <consumer> <provider> <price>
  post "$1" "$3" "post_job by spore $1"
  quote "$JOB" "$2" "$3"
  accept "$JOB" "$2"
  deliver "$JOB"
  op "settle job $JOB" settle "{\"job_id\":$JOB}"
}

echo "router $ROUTER, $(date -u +%FT%TZ)" | tee -a "$LOG"
if [ "$(field 0 .active)" = true ]; then
  echo "spore 0 is already active: this run needs a freshly deployed router" >&2
  exit 2
fi

# 1. Mint the 64-spore collection; measure storage per spore.
s0=$(view storage_report | jq -r .storage_bytes)
n0=$(view nft_total_supply | jq -r .)
while [ "$(view nft_total_supply | jq -r .)" -lt 64 ]; do
  have=$(view nft_total_supply | jq -r .)
  if [ "$have" = 0 ]; then
    owners=$(jq -cn --arg o "$OWN" --arg b "$BUY" --arg d "$DEP" '[$o, $o, $o, $o, $b] + [range(11) | $d]')
  else
    owners=$(jq -cn --arg d "$DEP" '[range(16) | $d]')
  fi
  must_succeed "mint_genesis 16 more (have $have)" "$DEP" "$DEP_K" mint_genesis "{\"owners\":$owners}" '0 NEAR' '300 Tgas'
done
s1=$(view storage_report | jq -r .storage_bytes)
n1=$(view nft_total_supply | jq -r .)
if [ "$n1" -gt "$n0" ]; then per=$(((s1 - s0) / (n1 - n0))); else per="n/a"; fi
check "64 spores minted" "supply $n1; $per bytes per spore over $((n1 - n0)) mints; storage now $s1 bytes" test "$n1" = 64
must_fail "mint by a non-admin" "only the admin can mint" "$OWN" "$OWN_K" mint_genesis '{"owners":[]}'

# 2. Activation and owner control.
must_fail "activate below the minimum deposit" "min_activation_deposit" \
  "$OWN" "$OWN_K" activate "{\"spore_id\":0,\"operator_id\":\"$OP\"}" '0.05 NEAR'
must_fail "activate by a non-owner" "only the spore owner" \
  "$BUY" "$BUY_K" activate "{\"spore_id\":0,\"operator_id\":\"$OP\"}" '0.3 NEAR'
for id in 0 1 2; do
  must_succeed "activate spore $id (0.3 NEAR)" "$OWN" "$OWN_K" activate "{\"spore_id\":$id,\"operator_id\":\"$OP\"}" '0.3 NEAR'
done
op_fail "operator before set_policy: spore is locked" "policy: spore is paused" post_job '{"spore_id":0,"task":"x","max_price":"1"}'
must_fail "set_policy without 1 yocto" "Requires attached deposit of exactly 1 yoctoNEAR" \
  "$OWN" "$OWN_K" set_policy "$(setp 0 "$OPEN")" '0 NEAR'
must_fail "set_policy by a non-owner" "only the spore owner" "$BUY" "$BUY_K" set_policy "$(setp 0 "$OPEN")" '1 yoctoNEAR'
for id in 0 1 2; do
  must_succeed "set_policy spore $id: 0.2/epoch, cap 0.05, any" "$OWN" "$OWN_K" set_policy "$(setp $id "$OPEN")" '1 yoctoNEAR'
done
must_succeed "deposit 0.1 NEAR to spore 1 (anyone)" "$DEP" "$DEP_K" deposit '{"spore_id":1}' '0.1 NEAR'

# 3. What the operator's function-call key cannot do (enforced by the protocol).
must_fail "FC key calls set_policy (not in its list)" "MethodNameMismatch" "$OP" "$FC_K" set_policy "$(setp 0 "$OPEN")" '0 NEAR'
must_fail "FC key calls withdraw (not in its list)" "MethodNameMismatch" "$OP" "$FC_K" withdraw '{"spore_id":0,"amount":"1"}' '0 NEAR'
must_fail "FC key attaches a deposit" "DepositWithFunctionCall" "$OP" "$FC_K" post_job '{"spore_id":0,"task":"x","max_price":"1"}' '1 yoctoNEAR'
must_fail "operator's full key: withdraw" "only the spore owner" "$OP" "$OP_FULL_K" withdraw '{"spore_id":0,"amount":"1"}' '1 yoctoNEAR'
must_fail "stranger calls private on_withdraw" "is private" \
  "$BUY" "$BUY_K" on_withdraw "{\"spore_id\":0,\"owner_id\":\"$BUY\",\"amount\":\"1\"}"

# 4. Escrowed jobs settle (epoch 1): 0 hires 1, 2 hires 0.
trade 0 1 "$(cent 4)"
trade 2 0 "$(cent 4)"
pool=$(view epoch_info | jq -r .pool)
check "fee pool after two settles" "pool $pool = 2 x 1% of 0.04 NEAR" test "$pool" = "800000000000000000000"

# 5. Each policy rule rejects the payment on chain and moves nothing.
post 0 "$(cent 10)" "post_job for the policy checks"
P=$JOB
quote "$P" 1 "$(cent 6)"
bal0=$(field 0 .balance)
must_fail "accept over the per-payment cap" "policy: payment exceeds the per-payment cap" "$OP" "$FC_K" accept "{\"job_id\":$P,\"provider_id\":1}"
quote "$P" 1 "$(cent 4)"
must_succeed "owner: allowlist only spore 2" "$OWN" "$OWN_K" set_policy "$(setp 0 "$(policy "$(cent 20)" "$(cent 5)" false '[2]')")" '1 yoctoNEAR'
must_fail "accept a payee not on the allowlist" "policy: payee is not on the allowlist" "$OP" "$FC_K" accept "{\"job_id\":$P,\"provider_id\":1}"
must_succeed "owner: budget 0.05/epoch (0.04 spent)" "$OWN" "$OWN_K" set_policy "$(setp 0 "$(policy "$(cent 5)" "$(cent 5)" true '[]')")" '1 yoctoNEAR'
must_fail "accept over the epoch budget" "policy: epoch budget exceeded" "$OP" "$FC_K" accept "{\"job_id\":$P,\"provider_id\":1}"
must_succeed "owner: open policy again" "$OWN" "$OWN_K" set_policy "$(setp 0 "$OPEN")" '1 yoctoNEAR'
must_succeed "owner: pause spore 0" "$OWN" "$OWN_K" pause '{"spore_id":0}'
must_fail "accept while paused" "policy: spore is paused" "$OP" "$FC_K" accept "{\"job_id\":$P,\"provider_id\":1}"
check "rejected payments moved nothing" "balance of spore 0 unchanged, escrow 0" \
  test "$(field 0 .balance)/$(view ledger_totals | jq -r .escrow)" = "$bal0/0"
must_succeed "owner: unpause (set_policy)" "$OWN" "$OWN_K" set_policy "$(setp 0 "$OPEN")" '1 yoctoNEAR'

# 6. Epoch close (anyone), and the tubes it creates.
must_succeed "close_epoch (anyone)" "$DEP" "$DEP_K" close_epoch '{}'
FP1=$(jq -r . <<<"$TX_RET")
must_fail "close_epoch again at once" "epoch has not ended yet" "$BUY" "$BUY_K" close_epoch '{}'
check "fingerprint stored for epoch 1" "$FP1" test "$(view fingerprint '{"epoch":1}' | jq -r .)" = "$FP1"
edges=$(view edges | jq -c .)
check "tubes after epoch 1" "$edges" test "$(view edges | jq length)" = 2

# 7. First image from chain state: spore 0 (two tubes) and spore 3 (dormant).
cargo build --release -q -p spores-renderer
for id in 0 3; do
  view render_input "{\"spore_id\":$id}" >"$OUT/render_input_$id.json"
  line=$(target/release/spores-render state "$OUT/render_input_$id.json" "$OUT/spore$id.png")
  check "render spore $id from chain state" "$line -> $OUT/spore$id.png" test -s "$OUT/spore$id.png"
done

# 8. Epoch 2: reject refunds; an unfinished job times out and refunds.
# (A fresh job: an open job expires 60 s after posting.)
post 0 "$(cent 10)" "post_job by spore 0 (will be rejected)"
R=$JOB
quote "$R" 1 "$(cent 4)"
accept "$R" 1
deliver "$R"
bal0=$(field 0 .balance)
op "reject job $R (refund, tube cut at close)" reject "{\"job_id\":$R}"
check "reject refunded 0.04" "balance +0.04" test "$(field 0 .balance)" = "$(plus "$bal0" "$(cent 4)")"
post 1 "$(cent 10)" "post_job by spore 1 (will time out)"
T=$JOB
quote "$T" 0 "$(cent 3)"
accept "$T" 0
must_fail "timeout_job too early" "job has not timed out" "$DEP" "$DEP_K" timeout_job "{\"job_id\":$T}"
echo "waiting 65 s for the 60 s job deadline..." | tee -a "$LOG"
sleep 65
op_fail "deliver after the deadline" "job has timed out" deliver "{\"job_id\":$T,\"result_hash\":\"h\"}"
bal1=$(field 1 .balance)
must_succeed "timeout_job (anyone) refunds the consumer" "$DEP" "$DEP_K" timeout_job "{\"job_id\":$T}"
check "timeout refunded 0.03 to spore 1" "balance +0.03" test "$(field 1 .balance)" = "$(plus "$bal1" "$(cent 3)")"

# 9. Transfer: old operator key and old owner locked out, history stays, jobs in flight refunded.
post 0 "$(cent 10)" "post_job by spore 0 (in flight at transfer)"
J=$JOB
quote "$J" 2 "$(cent 4)"
accept "$J" 2
before=$(summary 0)
must_succeed "owner transfers spore 0 to buyer (NEP-171)" "$OWN" "$OWN_K" nft_transfer "{\"receiver_id\":\"$BUY\",\"token_id\":\"0\"}" '1 yoctoNEAR'
after=$(summary 0)
op_fail "old operator key: post_job" "caller is not this spore's operator" post_job '{"spore_id":0,"task":"x","max_price":"1"}'
op_fail "old operator key: quote" "caller is not this spore's operator" quote "{\"job_id\":$J,\"spore_id\":0,\"price\":\"1\"}"
must_fail "old owner: withdraw" "only the spore owner" "$OWN" "$OWN_K" withdraw '{"spore_id":0,"amount":"1"}' '1 yoctoNEAR'
must_fail "old owner: set_policy" "only the spore owner" "$OWN" "$OWN_K" set_policy "$(setp 0 "$OPEN")" '1 yoctoNEAR'
check "owner is now the buyer" "$(jq -r .owner_id <<<"$after")" test "$(jq -r .owner_id <<<"$after")" = "$BUY"
check "policy reset to paused, zero budget" "$(jq -c .policy <<<"$after")" \
  test "$(jq -c '[.policy.paused, .policy.budget_per_epoch, .operator_id]' <<<"$after")" = '[true,"0",null]'
check "tubes, age, reputation unchanged" "$(jq -c '[.connections, .age, .reputation]' <<<"$after")" \
  test "$(jq -c '[.connections, .age, .reputation]' <<<"$after")" = "$(jq -c '[.connections, .age, .reputation]' <<<"$before")"
check "balance kept, own escrow refunded" "before $(jq -r .balance <<<"$before") after $(jq -r .balance <<<"$after")" \
  test "$(jq -r .balance <<<"$after")" = "$(plus "$(jq -r .balance <<<"$before")" "$(cent 4)")"
check "job in flight refunded and removed" "get_job $J = null" test "$(view get_job "{\"job_id\":$J}")" = null
must_succeed "new owner withdraws 0.05 NEAR" "$BUY" "$BUY_K" withdraw "{\"spore_id\":0,\"amount\":\"$(cent 5)\"}" '1 yoctoNEAR'
check "withdraw callback saw a successful transfer" "on_withdraw returned $TX_RET" test "$TX_RET" = true

# 10. Ledger and storage.
lt=$(view ledger_totals | jq -c .)
check "ledger conserved" "$lt" test "$(jq -r .conserved <<<"$lt")" = true
sr=$(view storage_report | jq -c .)
check "router solvent (storage + ledger covered)" "$sr" test "$(jq -r .solvent <<<"$sr")" = true

echo "PASS $PASSES  FAIL $FAILURES" | tee -a "$LOG"
[ "$FAILURES" = 0 ]
