#!/usr/bin/env bash
# 停用观察的 PATH 行为测试。只跑候选脚本，不跑已安装副本，不碰宿主标记。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${WATCH_BIN:-$DIR/v5-selfhost-watch.sh}"
LIVE_BIN=/opt/openclaude/v5-selfhost-watch/watch.sh
LIVE_MARKER=/opt/openclaude/v5-selfhost-watch/watch-disarmed

case "$BIN" in
  "$LIVE_BIN")
    echo "REFUSE: 不测已安装副本" >&2
    exit 2
    ;;
esac
if [[ ! -f "$BIN" ]]; then
  echo "REFUSE: 缺少候选 $BIN" >&2
  exit 2
fi
if [[ "${WATCH_DISARM:-}" == "$LIVE_MARKER" ]]; then
  echo "REFUSE: WATCH_DISARM 指向宿主标记" >&2
  exit 2
fi

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

BASE="$(mktemp -d /tmp/v5-watch-observe.XXXXXX)"
trap 'rm -rf "$BASE"' EXIT
BINDIR="$BASE/bin"
mkdir -p "$BINDIR" "$BASE/run" "$BASE/releases"

export TRACE="$BASE/trace"
export CURL_BODY="$BASE/body"
export WATCH_LIVE="$BASE/live"
: >"$TRACE"
printf '%s\n' '{"ok":true}' >"$CURL_BODY"

cat >"$BINDIR/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"${TRACE:?}"
case "${1:-}" in
  is-active)
    echo active
    exit 0
    ;;
  *)
    echo "MUTATION systemctl $*" >>"${TRACE:?}"
    exit 99
    ;;
esac
EOF
cat >"$BINDIR/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"${TRACE:?}"
cat "${CURL_BODY:?}"
exit 0
EOF
cat >"$BINDIR/ln" <<'EOF'
#!/usr/bin/env bash
printf 'ln %s\n' "$*" >>"${TRACE:?}"
echo "MUTATION ln $*" >>"${TRACE:?}"
exit 99
EOF
cat >"$BINDIR/mv" <<'EOF'
#!/usr/bin/env bash
printf 'mv %s\n' "$*" >>"${TRACE:?}"
for a in "$@"; do
  case "$a" in
    *watch-disarmed*|*manual-recovery*required*|*/live|*/live/*)
      echo "MUTATION mv $a" >>"${TRACE:?}"
      exit 99
      ;;
  esac
done
exec /bin/mv "$@"
EOF
chmod 0755 "$BINDIR/systemctl" "$BINDIR/curl" "$BINDIR/ln" "$BINDIR/mv"

export PATH="$BINDIR:/usr/bin:/bin"
unset WATCH_STUB_MASTER WATCH_STUB_EGRESS WATCH_STUB_MASTER_BODY WATCH_STUB_UNIT_MASTER \
  WATCH_STUB_UNIT_EGRESS WATCH_STUB_PG WATCH_STUB_REDIS WATCH_STUB_DOCKER WATCH_STUB_FAIL_LOUD \
  WATCH_STUB_JOURNAL WATCH_STUB_LOGTAIL || true
export WATCH_DRY=0
export WATCH_SKIP_ACTIONS=0
export WATCH_FAIL_THRESHOLD=5
export WATCH_NOTIFY_COOLDOWN_SEC=86400
export WATCH_NOW_OVERRIDE=1700000000
export WATCH_LOG="$BASE/watch.log"
export WATCH_RUN_DIR="$BASE/run"
export WATCH_STATUS="$BASE/run/watch-status"
export WATCH_NOTIFY_STATE="$BASE/run/watch-notify-state"
export WATCH_LOCK="$BASE/run/deploy.lock"
export WATCH_MAINT="$BASE/run/planned-maintenance"
export WATCH_GRACE="$BASE/run/cutover-grace-until"
export WATCH_FAIL_COUNT="$BASE/run/health-fail-count"
export WATCH_DISARM="$BASE/watch-disarmed"
export WATCH_MANUAL_RECOVERY="$BASE/releases/.manual-recovery-required"
export WATCH_RELEASES_ROOT="$BASE/releases"
export WATCH_BACKUP_CURRENT="$BASE/backup"
export WATCH_RESTORE=/bin/false
export WATCH_MASTER_URL="http://127.0.0.1:9/healthz"
export WATCH_EGRESS_URL="http://127.0.0.1:9/egress"
printf '4\n' >"$WATCH_FAIL_COUNT"
printf 'until=1\n' >"$WATCH_GRACE"
# 过期维护标记。观察分支不得调用会删它的维护函数。
printf 'until=1\nowner=1\n' >"$WATCH_MAINT"

ident() { stat -c '%i %y' "$1"; }
sha() { sha256sum "$1" | awk '{print $1}'; }

run_once() {
  set +e
  bash "$BIN" --once
  RUN_EC=$?
  set -e
}

assert_no_mutation() {
  local label="$1"
  if grep -q 'MUTATION' "$TRACE"; then
    bad "$label mutation"
    grep 'MUTATION' "$TRACE" || true
    return 1
  fi
  if grep -E 'systemctl (restart|stop|start)|atomic_flip|watch-disarmed' "$TRACE" >/dev/null; then
    bad "$label trace"
    return 1
  fi
  return 0
}

assert_probes() {
  local label="$1"
  grep -q '^curl ' "$TRACE" || { bad "$label 无 curl"; return 1; }
  grep -q '^systemctl is-active ' "$TRACE" || { bad "$label 无 is-active"; return 1; }
  return 0
}

status_get() {
  local key="$1"
  awk -F= -v k="$key" '$1==k {print substr($0, index($0, "=")+1); exit}' "$WATCH_STATUS"
}

notify_count() {
  grep -c 'watch-status recovery_armed=' "$WATCH_LOG" || true
}

# --- 1 marker + green ---
printf 'reason=deps-pg\n' >"$WATCH_DISARM"
before_i="$(ident "$WATCH_DISARM")"
before_s="$(sha "$WATCH_DISARM")"
: >"$TRACE"
: >"$WATCH_LOG"
printf '%s\n' '{"ok":true}' >"$CURL_BODY"
run_once
if [[ "$RUN_EC" == 0 ]] \
  && [[ "$(status_get recovery_armed)" == "false" ]] \
  && [[ "$(status_get suppression_reason)" == "marker:deps-pg" ]] \
  && [[ "$(status_get observation_executed)" == "true" ]] \
  && [[ "$(status_get health)" == "green" ]] \
  && [[ -n "$(status_get checked_at)" ]] \
  && [[ "$(ident "$WATCH_DISARM")" == "$before_i" ]] \
  && [[ "$(sha "$WATCH_DISARM")" == "$before_s" ]] \
  && [[ "$(tr -d '[:space:]' <"$WATCH_FAIL_COUNT")" == "4" ]] \
  && [[ ! -e "$WATCH_MANUAL_RECOVERY" ]] \
  && [[ -f "$WATCH_MAINT" ]] \
  && ! grep -q 'healthy' "$WATCH_STATUS" \
  && ! grep -q 'disarmed 标记存在,退出' "$WATCH_LOG" \
  && assert_probes "D1" \
  && assert_no_mutation "D1"; then
  ok "D1 marker green exit=0 probes=1 fail_count=4"
else
  bad "D1 marker green ec=$RUN_EC status=$(cat "$WATCH_STATUS" 2>/dev/null || true)"
fi

# --- 2 cooldown holds while still green ---
n1="$(notify_count)"
: >"$TRACE"
run_once
n2="$(notify_count)"
if [[ "$RUN_EC" == 0 && "$n1" == "1" && "$n2" == "1" ]] \
  && [[ "$(status_get health)" == "green" ]] \
  && [[ "$(sha "$WATCH_DISARM")" == "$before_s" ]] \
  && assert_probes "D2" \
  && assert_no_mutation "D2"; then
  ok "D2 second green notify=$n2"
else
  bad "D2 cooldown n1=$n1 n2=$n2 ec=$RUN_EC"
fi

# --- 3 green → red pierces cooldown ---
printf '%s\n' '{"ok":false}' >"$CURL_BODY"
: >"$TRACE"
run_once
n3="$(notify_count)"
if [[ "$RUN_EC" == 0 && "$n3" == "2" ]] \
  && [[ "$(status_get health)" == "red" ]] \
  && [[ "$(status_get recovery_armed)" == "false" ]] \
  && [[ "$(status_get observation_executed)" == "true" ]] \
  && [[ "$(sha "$WATCH_DISARM")" == "$before_s" && "$(ident "$WATCH_DISARM")" == "$before_i" ]] \
  && [[ "$(tr -d '[:space:]' <"$WATCH_FAIL_COUNT")" == "4" ]] \
  && grep -q 'health=red' "$WATCH_LOG" \
  && assert_probes "D3" \
  && assert_no_mutation "D3"; then
  ok "D3 green-to-red notify=$n3"
else
  bad "D3 pierce n3=$n3 ec=$RUN_EC"
fi

# --- 4 manual only ---
rm -f -- "$WATCH_DISARM" "$WATCH_NOTIFY_STATE" "$WATCH_LOG"
printf 'until=1\nreason=schema\nwritten=2000-01-01T00:00:00Z\n' >"$WATCH_MANUAL_RECOVERY"
man_i="$(ident "$WATCH_MANUAL_RECOVERY")"
man_s="$(sha "$WATCH_MANUAL_RECOVERY")"
printf '%s\n' '{"ok":true}' >"$CURL_BODY"
: >"$TRACE"
run_once
if [[ "$RUN_EC" == 0 ]] \
  && [[ ! -e "$WATCH_DISARM" ]] \
  && [[ "$(status_get recovery_armed)" == "false" ]] \
  && [[ "$(status_get suppression_reason)" == "manual:schema" ]] \
  && [[ "$(status_get health)" == "green" ]] \
  && [[ "$(status_get observation_executed)" == "true" ]] \
  && [[ "$(ident "$WATCH_MANUAL_RECOVERY")" == "$man_i" ]] \
  && [[ "$(sha "$WATCH_MANUAL_RECOVERY")" == "$man_s" ]] \
  && [[ "$(tr -d '[:space:]' <"$WATCH_FAIL_COUNT")" == "4" ]] \
  && assert_probes "D4" \
  && assert_no_mutation "D4"; then
  ok "D4 manual-only"
else
  bad "D4 manual-only ec=$RUN_EC reason=$(status_get suppression_reason)"
fi

# --- 5 both markers ---
printf 'reason=deps-pg\n' >"$WATCH_DISARM"
rm -f -- "$WATCH_NOTIFY_STATE" "$WATCH_LOG"
both_m="$(ident "$WATCH_DISARM") $(sha "$WATCH_DISARM")"
both_a="$(ident "$WATCH_MANUAL_RECOVERY") $(sha "$WATCH_MANUAL_RECOVERY")"
printf '%s\n' '{"ok":false}' >"$CURL_BODY"
: >"$TRACE"
run_once
if [[ "$RUN_EC" == 0 ]] \
  && [[ "$(status_get recovery_armed)" == "false" ]] \
  && [[ "$(status_get suppression_reason)" == "marker:deps-pg,manual:schema" ]] \
  && [[ "$(status_get health)" == "red" ]] \
  && [[ "$(status_get observation_executed)" == "true" ]] \
  && [[ "$(ident "$WATCH_DISARM") $(sha "$WATCH_DISARM")" == "$both_m" ]] \
  && [[ "$(ident "$WATCH_MANUAL_RECOVERY") $(sha "$WATCH_MANUAL_RECOVERY")" == "$both_a" ]] \
  && [[ -f "$WATCH_MAINT" ]] \
  && assert_probes "D5" \
  && assert_no_mutation "D5"; then
  ok "D5 dual-marker"
else
  bad "D5 dual reason=$(status_get suppression_reason) ec=$RUN_EC"
fi

echo "OBSERVE_CASES pass=$pass fail=$fail"
if [[ "$fail" != 0 ]]; then
  exit 1
fi
echo "OBSERVE_TEST_ALL_PASS"
