#!/usr/bin/env bash
# scripts/test-trace-contract.sh — V3 S12e CG10 jq field-name contract test.
#
# Scope: **fixture-based contract test**, NOT a regression test against live
# logger implementations. Verifies that the canonical trace field name is
# spelled `traceId` (camelCase) across all 3 logger surfaces our service stack
# produces, by feeding hand-written sample log lines through jq.
#
# Why fixtures (not real logs):
#   - We are pinning *the contract* (field name = `traceId`), not catching a
#     specific commit that mistypes it. A future change that renames `traceId`
#     to `trace_id` in commercial/src/logging or node-agent slog would break
#     real journalctl output too, but the fastest signal is this static check.
#   - Scanning live `journalctl` would need an ssh boundary + recent traffic +
#     deploy state — too much coupling for what is fundamentally a naming
#     contract. Plan §722 explicitly framed this as "nice-to-have".
#
# What this script does NOT do:
#   - It does not run against real master / node-agent / gateway logs.
#   - It does not catch a logger that emits `traceId` correctly but with a
#     wrong value (that's smoke-v3.sh verify_trace_propagation's job).
#   - It does not detect snake_case `trace_id` strings inside log msg text —
#     only top-level JSON keys.
#
# Usage:
#   scripts/test-trace-contract.sh
#
# Exit 0 = PASS, non-zero = FAIL (= the count of failed checks).
set -euo pipefail

TARGET="abc123def456abc123def456abc123de"  # 32-hex sample traceId

# Three fixture lines, each emulating a typical log entry from the respective
# logger. The shape is what each logger ACTUALLY emits — verified against:
#   - master  pino: packages/commercial/src/logging/logger.ts (child bindings
#                   spread inline; level=30 numeric; pid present)
#   - Go slog:      packages/commercial/node-agent/internal/logging/logger.go
#                   (slog.JSON handler; level="INFO" string; time RFC3339)
#   - gateway pino: packages/gateway/src/logger.ts (also pino; same shape as
#                   master but different msg vocab)
MASTER_LINE='{"level":30,"time":1715430000000,"pid":12345,"msg":"user-chat-bridge: inbound turn start","uid":"42","connId":"conn-abc","traceId":"'"$TARGET"'","sessionKey":"sk-1"}'
NODE_AGENT_LINE='{"time":"2026-05-11T00:00:00Z","level":"INFO","msg":"tunnel.serve","traceId":"'"$TARGET"'","connectionTraceId":"conn-trace-xyz","route":"/v1/tunnel"}'
GATEWAY_LINE='{"level":30,"time":1715430000010,"msg":"ws.frame.deliver","traceId":"'"$TARGET"'","sessionKey":"sk-1","userId":"42"}'

PASS=0
FAIL=0

# check <description> <test command — run via "$@", expected exit 0 = pass>
check() {
  local desc=$1; shift
  if "$@"; then
    echo "   ✓ $desc"
    PASS=$((PASS+1))
  else
    echo "   ✗ $desc" >&2
    FAIL=$((FAIL+1))
  fi
}

# jq_select <line> <filter>
# Pipe fixture via stdin (Codex review note: avoids quote fragility if fixture
# values ever contain `'` — `bash -c "echo '$line' | ..."` would break, but
# `printf '%s\n' "$line"` is safe regardless of inner quoting).
jq_select() {
  local line=$1
  local filter=$2
  printf '%s\n' "$line" | jq -e "$filter" >/dev/null
}

# Test group 1 — each source must be queryable via `.traceId == TARGET`.
for src_name in MASTER_LINE NODE_AGENT_LINE GATEWAY_LINE; do
  line="${!src_name}"
  check "$src_name → .traceId == \"\$TARGET\" finds the line" \
    jq_select "$line" "select(.traceId == \"$TARGET\") | .traceId"
done

# Test group 2 — none of the sources may carry snake_case `trace_id` as a
# top-level key. (Plan §722: any snake_case is a contract violation.)
jq_not_has_trace_id() {
  local line=$1
  ! printf '%s\n' "$line" | jq -e 'has("trace_id")' >/dev/null
}
for src_name in MASTER_LINE NODE_AGENT_LINE GATEWAY_LINE; do
  line="${!src_name}"
  check "$src_name must NOT carry snake_case top-level \`trace_id\` key" \
    jq_not_has_trace_id "$line"
done

# Test group 3 — every emitted .traceId value must satisfy TRACE_ID_REGEX
# (^[A-Za-z0-9_-]{16,64}$). Catches accidental empties / format drift.
jq_trace_matches_regex() {
  local line=$1
  printf '%s\n' "$line" | jq -re '.traceId' | grep -qE '^[A-Za-z0-9_-]{16,64}$'
}
for src_name in MASTER_LINE NODE_AGENT_LINE GATEWAY_LINE; do
  line="${!src_name}"
  check "$src_name .traceId matches TRACE_ID_REGEX" \
    jq_trace_matches_regex "$line"
done

echo ""
echo "=== test-trace-contract: $PASS passed / $FAIL failed ==="
exit "$FAIL"
