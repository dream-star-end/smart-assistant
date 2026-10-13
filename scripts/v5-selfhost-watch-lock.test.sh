#!/usr/bin/env bash
# Regression: best-effort armed callers must not disable lock/IO guards.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${WATCH_BIN:-$DIR/v5-selfhost-watch.sh}"
[[ "$(readlink -f "$BIN")" != /opt/openclaude/v5-selfhost-watch/watch.sh ]] || exit 2
base=$(mktemp -d /tmp/v5-watch-lock-test.XXXXXX)
trap 'rm -rf "$base"' EXIT
export WATCH_RUN_DIR="$base/run" WATCH_STATUS="$base/run/status" WATCH_NOTIFY_STATE="$base/run/notify" WATCH_LOG="$base/log"
mkdir -p "$WATCH_RUN_DIR"
export WATCH_DISARM="$base/disarm" WATCH_MANUAL_RECOVERY="$base/manual" WATCH_MAINT="$base/maint" WATCH_GRACE="$base/grace" WATCH_LOCK="$base/deploy.lock" WATCH_FAIL_COUNT="$base/fail-count"
export WATCH_DRY=1 WATCH_SKIP_ACTIONS=1 WATCH_STUB_UNIT_MASTER=active WATCH_STUB_UNIT_EGRESS=active WATCH_STUB_MASTER=ok WATCH_STUB_EGRESS=ok
export WATCH_NOTIFY_COOLDOWN_SEC=86400 WATCH_NOW_OVERRIDE=1700000000
source "$BIN"
count() { grep -c 'watch-status recovery_armed=' "$WATCH_LOG" 2>/dev/null || true; }
exec 8>"$WATCH_RUN_DIR/.watch-status.lock"
flock 8
watch_once
[[ ! -e "$WATCH_STATUS" && ! -e "$WATCH_NOTIFY_STATE" && "$(count)" == 0 ]]
flock -u 8
printf 'PASS status lock timeout: no status/notification, armed exit unchanged\n'
exec 7>"$WATCH_RUN_DIR/.watch-notify.lock"
flock 7
watch_once
[[ -s "$WATCH_STATUS" && ! -e "$WATCH_NOTIFY_STATE" && "$(count)" == 0 ]]
flock -u 7
printf 'PASS notification lock timeout: no notification/fingerprint\n'
# Eight real armed ticks race from an empty notification state.
for i in {1..8}; do watch_once & done
wait
[[ -s "$WATCH_NOTIFY_STATE" && "$(count)" == 1 ]]
printf 'PASS concurrent same-fingerprint ticks: exactly one status log\n'
watch_once
[[ "$(count)" == 1 ]]
printf 'PASS cooldown after contention\n'
# An IO fault must fail the state operation even in best-effort call context.
old_status=$WATCH_STATUS
export WATCH_STATUS="$base/nonexistent/sub/status"
mkdir -p "$base/nonexistent"; touch "$base/nonexistent/sub"
rc=0
write_watch_status true '' true green || rc=$?
[[ "$rc" != 0 && ! -e "$WATCH_STATUS" ]]
export WATCH_STATUS=$old_status
[[ ! -e "$WATCH_DISARM" && ! -e "$WATCH_MANUAL_RECOVERY" ]]
printf 'PASS IO failure explicit; no marker created\n'
printf 'LOCK_CASES pass=5 fail=0\n'
