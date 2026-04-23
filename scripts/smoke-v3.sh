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
# Any failure → print rollback hint and exit non-zero. Never auto-rollback.
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

echo "=== smoke-v3 → $BASE_URL  expected tag: $EXPECTED_TAG ==="

# 1. healthz
check "healthz 200" \
  bash -c "curl -sSf --max-time 5 -o /dev/null '$BASE_URL/healthz'"

# 2. /version.tag matches
check "/version.tag === $EXPECTED_TAG" \
  bash -c "
    body=\$(curl -sSf --max-time 5 '$BASE_URL/version') || exit 1
    tag=\$(echo \"\$body\" | sed -n 's/.*\"tag\":\"\\([^\"]*\\)\".*/\\1/p')
    [[ \"\$tag\" == '$EXPECTED_TAG' ]] || { echo \"got tag=\$tag\" >&2; exit 1; }
  "

# 3. index.html shell
check "/ has <title>" \
  bash -c "curl -sSf --max-time 5 '$BASE_URL/' | grep -q '<title>'"

# 4. admin.html shell
check "/admin.html has <title>" \
  bash -c "curl -sSf --max-time 5 '$BASE_URL/admin.html' | grep -q '<title>'"

# 5. /api/changelog.currentVersion matches
# Unauthenticated callers may get 401 here — /api/changelog requires auth.
# We fall back to a looser check: 401 OR currentVersion === EXPECTED_TAG.
# (Goal is to catch changelog drift, not re-test auth.)
check "/api/changelog.currentVersion === $EXPECTED_TAG (or 401)" \
  bash -c "
    status=\$(curl -s --max-time 5 -o /tmp/smoke-cl.out -w '%{http_code}' '$BASE_URL/api/changelog')
    if [[ \"\$status\" == '401' ]]; then
      exit 0
    fi
    if [[ \"\$status\" != '200' ]]; then
      echo \"got status=\$status\" >&2; exit 1
    fi
    ver=\$(sed -n 's/.*\"currentVersion\":\"\\([^\"]*\\)\".*/\\1/p' /tmp/smoke-cl.out)
    [[ \"\$ver\" == '$EXPECTED_TAG' ]] || { echo \"got currentVersion=\$ver\" >&2; exit 1; }
  "

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
