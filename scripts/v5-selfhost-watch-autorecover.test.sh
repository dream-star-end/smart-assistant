#!/usr/bin/env bash
# OCV5-420 watch.sh --auto-recover 行为测试。只跑候选脚本,所有路径指向临时目录,不碰宿主标记。
# 健康用 file:// URL 模拟,让 tier2 的「恢复脚本」真的能把现场变绿。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${WATCH_BIN:-$DIR/v5-selfhost-watch.sh}"
if [[ "$(readlink -f "$BIN")" == /opt/openclaude/v5-selfhost-watch/watch.sh ]]; then
  echo "REFUSE: 不测已安装副本" >&2
  exit 2
fi

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

BASE="$(mktemp -d "${TMPDIR:-/tmp}/v5-watch-autorecover.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

RED='{"ok":false}'
GREEN='{"ok":true,"deps":{"pg":"ok"}}'

setup() {
  C="$BASE/$1"
  mkdir -p "$C/run" "$C/inst" "$C/rel" "$C/backup"
  export WATCH_RUN_DIR="$C/run" WATCH_STATUS="$C/run/watch-status" WATCH_NOTIFY_STATE="$C/run/notify" \
    WATCH_LOG="$C/log" WATCH_DISARM="$C/inst/watch-disarmed" WATCH_MANUAL_RECOVERY="$C/rel/.manual-recovery-required" \
    WATCH_MAINT="$C/run/maint" WATCH_GRACE="$C/run/grace" WATCH_LOCK="$C/run/deploy.lock" \
    WATCH_FAIL_COUNT="$C/run/fail-count" WATCH_INSTALLED_BIN="$C/inst/watch.sh" WATCH_LIVE="$C/live" \
    WATCH_RELEASES_ROOT="$C/rel" WATCH_BACKUP_CURRENT="$C/backup" WATCH_RESTORE="$C/restore.sh" \
    WATCH_MASTER_URL="file://$C/master.json" WATCH_EGRESS_URL="file://$C/egress.json"
  export WATCH_DRY=0 WATCH_SKIP_ACTIONS=0 WATCH_REARM_CHECKS=2 WATCH_REARM_INTERVAL_SEC=0 WATCH_NOTIFY_COOLDOWN_SEC=86400
  export WATCH_STUB_UNIT_MASTER=active WATCH_STUB_UNIT_EGRESS=active WATCH_STUB_MASTER= WATCH_STUB_EGRESS=
  export WATCH_STUB_MASTER_BODY= WATCH_STUB_PG=ok WATCH_STUB_REDIS=ok WATCH_STUB_DOCKER=ok WATCH_STUB_JOURNAL=' ' WATCH_STUB_LOGTAIL=' '
  unset WATCH_STUB_FAIL_LOUD
  cp -- "$BIN" "$WATCH_INSTALLED_BIN"
  printf '%s\n' "$GREEN" >"$C/master.json"
  printf '{"ok":true}\n' >"$C/egress.json"
  printf 'reason=tier1+tier2-failed\n' >"$WATCH_DISARM"
  printf 'until=1\nreason=tier1+tier2-failed\n' >"$WATCH_MANUAL_RECOVERY"
  printf '5\n' >"$WATCH_FAIL_COUNT"
  # 恢复脚本:记一笔,并按 FIXES 决定是否把 master 变绿。
  cat >"$C/restore.sh" <<EOS
#!/bin/sh
echo restored >>"$C/restore.calls"
[ "\${FIXES:-1}" = 1 ] && echo '$GREEN' >"$C/master.json"
exit 0
EOS
  chmod 0755 "$C/restore.sh"
}
ar() { set +e; OUT="$(bash "$BIN" --auto-recover "$@" 2>&1)"; EC=$?; set -e; }
markers_kept() { [[ -f "$WATCH_DISARM" && -f "$WATCH_MANUAL_RECOVERY" ]]; }
restores() { [[ -f "$C/restore.calls" ]] && wc -l <"$C/restore.calls" || echo 0; }

setup w1; ar
if [[ "$EC" == 0 && "$OUT" == *AUTORECOVER_GREEN* && ! -e "$WATCH_DISARM" && ! -e "$WATCH_MANUAL_RECOVERY" \
  && -n "$(find "$C/inst" -name 'watch-disarmed.autorearmed-*')" && -n "$(find "$C/rel" -name '.manual-recovery-required.autocleared-*')" \
  && "$(cat "$WATCH_FAIL_COUNT")" == 0 && "$(grep '^health=' "$WATCH_STATUS")" == health=green && "$(restores)" == 0 ]]; then
  ok "W1 stable green archives manual-recovery + disarm, resets count, no restore"
else bad "W1 ec=$EC out=$OUT"; fi

setup w2; rm -f "$WATCH_DISARM" "$WATCH_MANUAL_RECOVERY"; ar
[[ "$EC" == 0 && "$OUT" == *AUTORECOVER_GREEN* ]] && ok "W2 green without markers is a clean no-op" || bad "W2 ec=$EC out=$OUT"

setup w3; printf '%s\n' "$GREEN" >"$C/master.json"; printf '%s\n' "$RED" >"$C/master.json"; export WATCH_STUB_PG=inactive; ar
if [[ "$EC" == 3 && "$OUT" == *"AUTORECOVER_WAIT class=external-pg"* ]] && markers_kept && [[ "$(restores)" == 0 ]]; then
  ok "W3 external dependency down → wait (rc 3), no rollback, markers kept"
else bad "W3 ec=$EC out=$OUT"; fi

setup w4; printf '%s\n' "$RED" >"$C/master.json"; export WATCH_STUB_FAIL_LOUD=schema; ar
if [[ "$EC" == 3 && "$OUT" == *"class=schema"* ]] && markers_kept && [[ "$(restores)" == 0 ]]; then
  ok "W4 schema class → no rollback (rc 3)"
else bad "W4 ec=$EC out=$OUT"; fi

setup w5; printf '%s\n' "$RED" >"$C/master.json"; ar
if [[ "$EC" == 0 && "$OUT" == *"AUTORECOVER_RESTORED tier2"* && "$(restores)" == 1 && ! -e "$WATCH_DISARM" && ! -e "$WATCH_MANUAL_RECOVERY" ]]; then
  ok "W5 red release fault → two-level fallback restores, then markers archived"
else bad "W5 ec=$EC out=$OUT restores=$(restores)"; fi

setup w6; printf '%s\n' "$RED" >"$C/master.json"; FIXES=0 ar
if [[ "$EC" == 1 && "$OUT" == *AUTORECOVER_STILL_RED* && "$(restores)" == 1 ]] && markers_kept; then
  ok "W6 restore does not help → rc 1, markers kept"
else bad "W6 ec=$EC out=$OUT"; fi

setup w7; printf '%s\n' "$RED" >"$C/master.json"; ar --probe-only
if [[ "$EC" == 1 && "$OUT" == *"probe-only"* && "$(restores)" == 0 ]] && markers_kept; then
  ok "W7 --probe-only never touches the host"
else bad "W7 ec=$EC out=$OUT"; fi

setup w8; ( exec 9<>"$WATCH_LOCK"; flock -n 9; sleep 5 ) & hp=$!; sleep 0.5; ar; wait "$hp" || true
if [[ "$EC" == 75 && "$OUT" == *"SKIP lock"* ]] && markers_kept; then ok "W8 deploy lock held → rc 75, untouched"; else bad "W8 ec=$EC out=$OUT"; fi

setup w9; printf 'until=%s\n' "$(( $(date +%s) + 600 ))" >"$WATCH_MAINT"; ar
if [[ "$EC" == 75 && "$OUT" == *"SKIP window"* ]] && markers_kept; then ok "W9 maintenance window → rc 75"; else bad "W9 ec=$EC out=$OUT"; fi

setup w10; export WATCH_DRY=1; ar
if [[ "$EC" == 75 && "$OUT" == *"SKIP dry"* ]] && markers_kept; then ok "W10 WATCH_DRY=1 → rc 75"; else bad "W10 ec=$EC out=$OUT"; fi

setup w11; printf '{"ok":true,"deps":{"pg":"degraded"}}\n' >"$C/master.json"; ar --probe-only
if [[ "$EC" != 0 ]] && markers_kept; then ok "W11 green without deps.pg=ok is not treated as recovered"; else bad "W11 ec=$EC out=$OUT"; fi

echo "watch-autorecover: pass=$pass fail=$fail"
[[ "$fail" == 0 ]]
