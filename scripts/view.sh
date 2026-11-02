#!/usr/bin/env bash
# Read-only view call against testnet RPC: scripts/view.sh <contract> <method> [json-args]
# Prints the method's JSON result. No keys involved.
set -euo pipefail
RPC="${NEAR_RPC:-https://test.rpc.fastnear.com}"
args_b64=$(printf '%s' "${3:-{\}}" | base64 | tr -d '\n')
curl -sf --max-time 30 "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args_b64\"}}" \
  | jq -e 'if .result.result then (.result.result | implode | fromjson) else error(.error // .result.error | tostring) end'
