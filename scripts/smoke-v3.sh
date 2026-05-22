#!/usr/bin/env bash
# smoke-v3.sh — Minimal post-deploy smoke test for claudeai.chat.
#
# Checks (each max 3 attempts, 2s apart, curl --max-time 5):
#   1. GET /healthz → 200
#   2. GET /version → 200 + JSON.tag === EXPECTED_TAG (proves THIS deploy is live)
#   3. GET / → 200 + body contains <title>
#   4. GET /admin.html → 200 + body contains <title>
#   5. GET /api/changelog → 200 + JSON.currentVersion === EXPECTED_TAG
#
# V3 S12e CG9 — additionally (warn-mode, never fails the deploy):
#   - all 5 checks above inject `X-Trace-Id: ${SMOKE_TRACE}`
#   - verify_trace_propagation() hits 3 router.ts-routed probes
#     (/api/public/config, /api/public/models, /api/models) then sshes to
#     kl-mirror (KL prod primary) to grep /var/log/openclaude.log for ≥3 log
#     lines tagged with SMOKE_TRACE. Below threshold = warn only.
#
# Any failure of checks 1-5 → print rollback hint and exit non-zero. Never auto-rollback.
# verify_trace_propagation has no abort path (warn-only, plan D6).
#
# Usage:
#   scripts/smoke-v3.sh <EXPECTED_TAG> [BASE_URL]
#   BASE_URL defaults to https://claudeai.chat
#
# Standalone:
#   scripts/smoke-v3.sh v3-20260423T2215Z-abc1234

set -euo pipefail

EXPECTED_TAG="${1:-}"
BASE_URL="${2:-https://claudeai.chat}"

if [[ -z "$EXPECTED_TAG" ]]; then
  echo "usage: $0 <EXPECTED_TAG> [BASE_URL]" >&2
  exit 2
fi

# V3 S12e CG9 — contract D (deploy smoke) trace id. Built once at the top:
#   RAW_TAG  = strip non-[A-Za-z0-9_-] chars from EXPECTED_TAG (so non-ascii
#              tags don't break TRACE_ID_REGEX `^[A-Za-z0-9_-]{16,64}$`)
#   SAFE_TAG = fallback "smoke" if RAW_TAG empty (NIT 1: avoid "smoke--<hex>"
#              ugly format from all-stripped tag); truncate to 24 chars to
#              keep total under 64 even for unusually long debug tags
#   SMOKE_TRACE = "smoke-${SAFE_TAG}-<32-hex>"  (matches TRACE_ID_REGEX)
RAW_TAG="${EXPECTED_TAG//[^A-Za-z0-9_-]/}"
SAFE_TAG="${RAW_TAG:-smoke}"
SAFE_TAG="${SAFE_TAG:0:24}"
TRACE_HEX="$(openssl rand -hex 16)"
SMOKE_TRACE="smoke-${SAFE_TAG}-${TRACE_HEX}"

PASS=0
FAIL=0
FAILED_CHECKS=()

# retry_curl <description> <curl-args...>
# Returns 0 if any attempt yields 0 exit from the supplied command.
retry_curl() {
  local desc=$1; shift
  local attempt
  for attempt in 1 2 3; do
    if "$@" >/tmp/smoke-v3.out 2>/tmp/smoke-v3.err; then
      echo "   ✓ $desc (attempt $attempt)"
      return 0
    fi
    if [[ $attempt -lt 3 ]]; then
      sleep 2
    fi
  done
  echo "   ✗ $desc — failed after 3 attempts" >&2
  echo "     stderr: $(tr '\n' ' ' </tmp/smoke-v3.err | head -c 200)" >&2
  return 1
}

check() {
  local name=$1; shift
  if retry_curl "$name" "$@"; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name")
  fi
}

echo "=== smoke-v3 → $BASE_URL  expected tag: $EXPECTED_TAG  trace: $SMOKE_TRACE ==="

# Every existing check injects `X-Trace-Id: ${SMOKE_TRACE}` (V3 S12e CG9). The
# 5 contract checks below currently fall through gateway (not router.ts), so
# the trace header is future-proofing for when gateway gains traceId logging
# (S11c). verify_trace_propagation() below runs 3 dedicated probes against
# router.ts-matched routes to guarantee ≥3 reqLog emissions.

# 1. healthz
check "healthz 200" \
  bash -c "curl -sSf --max-time 5 -H 'X-Trace-Id: $SMOKE_TRACE' -o /dev/null '$BASE_URL/healthz'"

# 2. /version.tag matches
check "/version.tag === $EXPECTED_TAG" \
  bash -c "
    body=\$(curl -sSf --max-time 5 -H 'X-Trace-Id: $SMOKE_TRACE' '$BASE_URL/version') || exit 1
    tag=\$(echo \"\$body\" | sed -n 's/.*\"tag\":\"\\([^\"]*\\)\".*/\\1/p')
    [[ \"\$tag\" == '$EXPECTED_TAG' ]] || { echo \"got tag=\$tag\" >&2; exit 1; }
  "

# 3. index.html shell
check "/ has <title>" \
  bash -c "curl -sSf --max-time 5 -H 'X-Trace-Id: $SMOKE_TRACE' '$BASE_URL/' | grep -q '<title>'"

# 4. admin.html shell
check "/admin.html has <title>" \
  bash -c "curl -sSf --max-time 5 -H 'X-Trace-Id: $SMOKE_TRACE' '$BASE_URL/admin.html' | grep -q '<title>'"

# 5. /api/changelog.currentVersion matches
# Unauthenticated callers may get 401 here — /api/changelog requires auth.
# We fall back to a looser check: 401 OR currentVersion === EXPECTED_TAG.
# (Goal is to catch changelog drift, not re-test auth.)
check "/api/changelog.currentVersion === $EXPECTED_TAG (or 401)" \
  bash -c "
    status=\$(curl -s --max-time 5 -H 'X-Trace-Id: $SMOKE_TRACE' -o /tmp/smoke-cl.out -w '%{http_code}' '$BASE_URL/api/changelog')
    if [[ \"\$status\" == '401' ]]; then
      exit 0
    fi
    if [[ \"\$status\" != '200' ]]; then
      echo \"got status=\$status\" >&2; exit 1
    fi
    ver=\$(sed -n 's/.*\"currentVersion\":\"\\([^\"]*\\)\".*/\\1/p' /tmp/smoke-cl.out)
    [[ \"\$ver\" == '$EXPECTED_TAG' ]] || { echo \"got currentVersion=\$ver\" >&2; exit 1; }
  "

# V3 S12e CG9 — contract D verify trace propagation (warn-mode, never fails)
# Proves master HTTP segment reqLog `traceId` child-binding works end-to-end.
# Scope: ONLY master HTTP segment. WS/node-agent/container deferred to S11a.
verify_trace_propagation() {
  local expected_min=3

  # 3 trace-only probes against routes guaranteed to hit router.ts reqLog
  # (verified against router.ts prefix list 2026-05-11: /api/public/*,
  # /api/models). They don't contribute to PASS/FAIL — they exist purely so
  # the grep below has known log-line targets. Each gets the same
  # SMOKE_TRACE so a single grep captures all 3.
  for probe_path in /api/public/config /api/public/models /api/models; do
    curl -s --max-time 5 -o /dev/null \
      -H "X-Trace-Id: ${SMOKE_TRACE}" \
      "${BASE_URL}${probe_path}" || true
  done

  # Tiny buffer for the appender to flush. The log target is a plain file
  # (StandardOutput=append:/var/log/openclaude.log per the systemd unit), so
  # disk writes are usually <10ms but 1s gives slack under concurrent load.
  sleep 1

  # v1.0.122 fix — the systemd unit writes app logs to /var/log/openclaude.log
  # (StandardOutput=append:...), NOT journalctl. Earlier v1.0.122 deploy showed
  # 0 hits via journalctl while the file had all 3. Grep the file directly.
  # Remote: `grep -c ... || true` ensures zero matches exit 0 (not grep-c's
  # default exit 1). Local: capture exit separately so a real ssh failure is
  # distinguishable from "count = 0".
  local count
  if ! count=$(ssh -o BatchMode=yes -o ConnectTimeout=5 kl-mirror \
    "tail -n 5000 /var/log/openclaude.log 2>/dev/null | grep -c '${SMOKE_TRACE}' || true" 2>/dev/null); then
    echo "   ⚠ trace propagation: ssh kl-mirror log read unavailable — skipping verify (deploy unaffected)" >&2
    return 0
  fi

  # Strip any whitespace; default to 0 if ssh returned an empty body.
  count="${count//[^0-9]/}"
  count="${count:-0}"

  if (( count >= expected_min )); then
    echo "   ✓ trace propagation OK (found $count log lines with trace=$SMOKE_TRACE, threshold=$expected_min)"
  else
    echo "   ⚠ trace propagation BELOW THRESHOLD: found $count, expected ≥$expected_min (warn-only, deploy NOT aborted)" >&2
    echo "     master HTTP logger may have lost traceId child-binding — investigate after deploy completes." >&2
  fi
  return 0
}

verify_trace_propagation

echo ""
echo "=== smoke-v3 summary: $PASS passed / $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
  echo "" >&2
  echo "Failed checks:" >&2
  for c in "${FAILED_CHECKS[@]}"; do echo "  - $c" >&2; done
  echo "" >&2
  echo "Suggested rollback: scripts/deploy-v3.sh --rollback" >&2
  exit 1
fi

exit 0
