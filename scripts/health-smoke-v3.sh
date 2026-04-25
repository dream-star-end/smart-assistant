#!/usr/bin/env bash
# M8.2 / P2-19 — Minimal liveness smoke for claudeai.chat. Distinct from
# scripts/smoke-v3.sh (which is deploy-verification, binds EXPECTED_TAG).
# This script is "is the live URL responding to humans" — no tag binding.
#
# Run from systemd timer every 5 min on the v3 VM. Wrapped by
# health-smoke-v3-runner.sh which handles alert dispatch on failure.
#
# Usage:
#   health-smoke-v3.sh [BASE_URL]
#   BASE_URL defaults to https://claudeai.chat
#
# Exit codes:
#   0 — all checks passed
#   1 — at least one check failed (printable details on stderr)

set -euo pipefail

BASE_URL="${1:-https://claudeai.chat}"

curl_check() {
  # $1 = path, $2 = description, $3 = optional grep pattern body must match
  local path=$1 desc=$2 body_pat=${3:-}
  local code body
  body=$(curl -fsSL --max-time 10 -w '\n__HTTP_CODE__:%{http_code}' "$BASE_URL$path" 2>/dev/null) || {
    echo "FAIL: $desc — curl errored (no response / DNS / TLS / 4xx-5xx)" >&2
    return 1
  }
  code=${body##*__HTTP_CODE__:}
  body=${body%__HTTP_CODE__:*}
  if [ "$code" != "200" ]; then
    echo "FAIL: $desc — got HTTP $code" >&2
    return 1
  fi
  if [ -n "$body_pat" ] && ! echo "$body" | grep -q "$body_pat"; then
    echo "FAIL: $desc — body missing pattern '$body_pat'" >&2
    return 1
  fi
  return 0
}

ok=1
curl_check "/healthz" "/healthz returns 200" || ok=0
curl_check "/" "/ returns 200 with <title>" "<title>" || ok=0

if [ "$ok" -eq 1 ]; then
  exit 0
else
  exit 1
fi
