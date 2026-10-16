#!/usr/bin/env bash
# Selfhost watch / autorecover behaviour gate (OCV5-447).
#
# The one list of watch-related behaviour tests. The release train runs it on
# pinned staging before the release's watch.sh is installed on the host
# (scripts/v5-selfhost-master-release-lib.sh), and PR CI runs the same list
# (.github/workflows/v5-selfhost-gates.yml), so a watch change goes red on the
# PR instead of after a ~15 minute train.
#
# Every test writes only under mktemp dirs and never touches the host markers
# or the installed watch copy.
#
# Usage: v5-selfhost-watch-gate.sh [--log-dir DIR] [--list]
#   --list     print the test list and exit
#   --log-dir  keep one log per test there (default: a private mktemp dir)
# Exit: 0 all passed; 1 a test failed (its last 20 log lines go to stderr); 2 usage.
set -uo pipefail

WATCH_GATE_TESTS=(
  v5-selfhost-watch-selftest.sh
  v5-selfhost-watch-disarm-observe.test.sh
  v5-selfhost-watch-lock.test.sh
  v5-selfhost-watch-rearm.test.sh
  v5-selfhost-watch-sync.test.sh
  v5-selfhost-watch-alert.test.sh
  v5-selfhost-gate-fail-stay.test.sh
  v5-selfhost-train-recovery.test.sh
  v5-selfhost-watch-autorecover.test.sh
  v5-selfhost-autorecover.test.sh
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
log_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) printf '%s\n' "${WATCH_GATE_TESTS[@]}"; exit 0 ;;
    --log-dir) log_dir="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$log_dir" ]]; then
  log_dir="$(mktemp -d "${TMPDIR:-/tmp}/v5-selfhost-watch-gate.XXXXXX")"
fi
mkdir -p -- "$log_dir" || { echo "cannot create log dir $log_dir" >&2; exit 2; }

for t in "${WATCH_GATE_TESTS[@]}"; do
  log="$log_dir/$t.log"
  started=$(date +%s)
  if ! ( cd "$REPO_ROOT" && bash "scripts/$t" >"$log" 2>&1 ); then
    echo "FAIL $t ($(( $(date +%s) - started ))s) log=$log" >&2
    tail -n 20 "$log" >&2 || true
    exit 1
  fi
  echo "PASS $t ($(( $(date +%s) - started ))s)"
done
echo "WATCH_GATE_ALL_PASS ${#WATCH_GATE_TESTS[@]}"
