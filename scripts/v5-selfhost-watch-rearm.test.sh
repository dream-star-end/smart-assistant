#!/usr/bin/env bash
# OCV5-404 --rearm 行为测试。只跑候选脚本，所有路径指向临时目录，不碰宿主标记。
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

BASE="$(mktemp -d /tmp/v5-watch-rearm.XXXXXX)"
trap 'rm -rf "$BASE"' EXIT

setup() {
  C="$BASE/$1"
  mkdir -p "$C/run" "$C/inst" "$C/rel"
  export WATCH_RUN_DIR="$C/run" WATCH_STATUS="$C/run/watch-status" WATCH_NOTIFY_STATE="$C/run/notify" \
    WATCH_LOG="$C/log" WATCH_DISARM="$C/inst/watch-disarmed" WATCH_MANUAL_RECOVERY="$C/rel/.manual-recovery-required" \
    WATCH_MAINT="$C/run/maint" WATCH_GRACE="$C/run/grace" WATCH_LOCK="$C/run/deploy.lock" \
    WATCH_FAIL_COUNT="$C/run/fail-count" WATCH_INSTALLED_BIN="$C/inst/watch.sh" WATCH_LIVE="$C/live" \
    WATCH_RELEASES_ROOT="$C/rel" WATCH_RESTORE=/bin/false WATCH_BACKUP_CURRENT="$C/backup"
  export WATCH_DRY=0 WATCH_SKIP_ACTIONS=1 WATCH_REARM_CHECKS=3 WATCH_REARM_INTERVAL_SEC=0 WATCH_NOTIFY_COOLDOWN_SEC=86400
  export WATCH_STUB_UNIT_MASTER=active WATCH_STUB_UNIT_EGRESS=active WATCH_STUB_MASTER=ok WATCH_STUB_EGRESS=ok
  export WATCH_STUB_MASTER_BODY='{"ok":true,"deps":{"pg":"ok"}}' WATCH_STUB_PG=ok WATCH_STUB_REDIS=ok WATCH_STUB_DOCKER=ok
  cp -- "$BIN" "$WATCH_INSTALLED_BIN"
  printf 'reason=deps-pg\n' >"$WATCH_DISARM"
  printf '4\n' >"$WATCH_FAIL_COUNT"
  MARK_ID="$(marker_id)"
}

marker_id() { echo "$(stat -c '%i %Y %s' "$WATCH_DISARM") $(sha256sum <"$WATCH_DISARM")"; }
archives() { find "$(dirname -- "$WATCH_DISARM")" -maxdepth 1 -name 'watch-disarmed.rearmed-*' | wc -l; }

rearm() {
  set +e
  OUT="$(bash "$BIN" --rearm 2>&1)"
  EC=$?
  set -e
}

# 拒绝必须什么都不改：标记身份、失败计数、无归档、无状态文件。
assert_refused() {
  local label="$1" pat="$2"
  if [[ "$EC" == 1 && "$OUT" == *REARM_REFUSED*"$pat"* && "$(marker_id)" == "$MARK_ID" \
    && "$(cat "$WATCH_FAIL_COUNT")" == 4 && "$(archives)" == 0 && ! -e "$WATCH_STATUS" ]]; then
    ok "$label"
  else
    bad "$label ec=$EC out=$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-240)"
  fi
}

setup r1
rearm
arch="$(find "$C/inst" -maxdepth 1 -name 'watch-disarmed.rearmed-*' | head -n1)"
if [[ "$EC" == 0 && "$OUT" == *REARM_OK* && ! -e "$WATCH_DISARM" && -n "$arch" && "$(cat "$arch")" == reason=deps-pg \
  && "$(cat "$WATCH_FAIL_COUNT")" == 0 && "$(grep '^recovery_armed=' "$WATCH_STATUS")" == recovery_armed=true \
  && "$(grep '^health=' "$WATCH_STATUS")" == health=green && "$(stat -c %a "$WATCH_LOCK")" == 600 ]] \
  && grep -q 'rearm: 已重新武装' "$WATCH_LOG"; then
  ok "R1 green rearm archives marker, resets count, status armed"
else
  bad "R1 ec=$EC out=$OUT"
fi

# 武装后的下一拍：绿走「复合健康绿」，红从 0 开始计数且不进 tier。
set +e; bash "$BIN" --once >/dev/null 2>&1; e1=$?; set -e
WATCH_STUB_MASTER=down
set +e; bash "$BIN" --once >/dev/null 2>&1; e2=$?; set -e
WATCH_STUB_MASTER=ok
if [[ "$e1" == 0 && "$e2" == 0 ]] && grep -q '复合健康绿' "$WATCH_LOG" && [[ "$(cat "$WATCH_FAIL_COUNT")" == 1 ]] \
  && grep -q '复合健康红 count=1/' "$WATCH_LOG" && ! grep -q 'tier1' "$WATCH_LOG" && [[ ! -e "$WATCH_DISARM" ]]; then
  ok "R2 armed ticks: green clears, red counts from 0 without tier"
else
  bad "R2 e1=$e1 e2=$e2 count=$(cat "$WATCH_FAIL_COUNT")"
fi

setup r3; WATCH_STUB_MASTER=down; rearm; assert_refused "R3 master red" "复合健康红"
setup r4; WATCH_STUB_MASTER_BODY='{"ok":true,"deps":{"pg":"down"}}'; rearm; assert_refused "R4 deps.pg not ok" "deps.pg"
setup r5; printf 'reason=schema\n' >"$WATCH_MANUAL_RECOVERY"; rearm; assert_refused "R5 manual-recovery present" "manual-recovery"

setup r6
st="$(python3 -c 'import sys
t=open("/proc/%s/stat"%sys.argv[1]).read(); print(t[t.rfind(")")+2:].split()[19])' "$$")"
: >"$WATCH_LOCK"
printf 'pid=%s started=%s starttime=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$st" >"${WATCH_LOCK}.holder"
rearm; assert_refused "R6 live deploy lock" "发布锁活"

setup r7; printf 'until=%s\n' "$(( $(date +%s) + 600 ))" >"$WATCH_GRACE"; rearm; assert_refused "R7 cutover grace" "grace"
setup r8; printf 'until=%s\nowner=%s\n' "$(( $(date +%s) + 600 ))" "$$" >"$WATCH_MAINT"; rearm; assert_refused "R8 maintenance" "维护"
setup r9; printf '\n# drift\n' >>"$WATCH_INSTALLED_BIN"; rearm; assert_refused "R9 installed copy differs" "不一致"
setup r10; export WATCH_DRY=1; rearm; assert_refused "R10 dry mode" "WATCH_DRY=1"; export WATCH_DRY=0

setup r11
mv -- "$WATCH_DISARM" "$C/real-marker"; ln -s "$C/real-marker" "$WATCH_DISARM"
real_id="$(stat -c '%i %Y %s' "$C/real-marker") $(sha256sum <"$C/real-marker")"
rearm
if [[ "$EC" == 1 && "$OUT" == *REARM_REFUSED*普通文件* && -L "$WATCH_DISARM" && "$(archives)" == 0 \
  && "$(stat -c '%i %Y %s' "$C/real-marker") $(sha256sum <"$C/real-marker")" == "$real_id" ]]; then
  ok "R11 symlink marker refused"
else
  bad "R11 ec=$EC out=$OUT"
fi

setup r12; rm -f -- "$WATCH_DISARM"; rearm
if [[ "$EC" == 0 && "$OUT" == *REARM_NOOP* && "$(cat "$WATCH_FAIL_COUNT")" == 4 ]]; then ok "R12 no marker is a no-op"; else bad "R12 ec=$EC out=$OUT"; fi

setup r13
for i in 1 2 3 4; do (bash "$BIN" --rearm >"$C/out.$i" 2>&1; echo "$?" >"$C/ec.$i") & done
wait
oks="$(cat "$C"/out.* | grep -c REARM_OK || true)"
if [[ "$oks" == 1 && "$(archives)" == 1 && ! -e "$WATCH_DISARM" ]]; then
  ok "R13 concurrent rearm archives exactly once"
else
  bad "R13 oks=$oks archives=$(archives)"
fi

setup r14; WATCH_STUB_MASTER_BODY='{"ok":true}'; rearm; assert_refused "R14 healthz without deps.pg" "deps.pg"

setup r15
: >"$WATCH_LOCK"; chmod 0600 "$WATCH_LOCK"
exec 7<>"$WATCH_LOCK"; flock 7
rearm; assert_refused "R15 deploy lock held by another process" "发布锁被占用"
flock -u 7; exec 7<&-

setup r16; export WATCH_REARM_INTERVAL_SEC=1
( sleep 0.5; printf 'reason=schema\n' >"$WATCH_MANUAL_RECOVERY" ) &
rearm; wait
rm -f -- "$WATCH_MANUAL_RECOVERY"; export WATCH_REARM_INTERVAL_SEC=0
assert_refused "R16 manual-recovery appearing mid-check" "manual-recovery"

# --rearm 运行期间 deploy 拿不到发布锁(deploy 用 flock -n 轮询)。
setup r17; export WATCH_REARM_INTERVAL_SEC=1
: >"$WATCH_LOCK"; chmod 0600 "$WATCH_LOCK"
( bash "$BIN" --rearm >"$C/out" 2>&1 ) &
rp=$!
sleep 0.6
if flock -n "$WATCH_LOCK" true; then during=free; else during=held; fi
wait "$rp"
if flock -n "$WATCH_LOCK" true; then after=free; else after=held; fi
export WATCH_REARM_INTERVAL_SEC=0
if [[ "$during" == held && "$after" == free ]] && grep -q REARM_OK "$C/out"; then
  ok "R17 deploy lock held for the whole rearm, released after"
else
  bad "R17 during=$during after=$after out=$(tr '\n' ' ' <"$C/out" | cut -c1-200)"
fi

# 归档失败:计数恢复原值,标记不变。
setup r18
mkdir -p "$C/bin"
printf '#!/bin/sh\nexit 1\n' >"$C/bin/mv"; chmod 0755 "$C/bin/mv"
set +e; OUT="$(PATH="$C/bin:$PATH" bash "$BIN" --rearm 2>&1)"; EC=$?; set -e
if [[ "$EC" == 1 && "$OUT" == *REARM_REFUSED*归档* && "$(marker_id)" == "$MARK_ID" && "$(cat "$WATCH_FAIL_COUNT")" == 4 && "$(archives)" == 0 ]]; then
  ok "R18 failed archive restores the fail count"
else
  bad "R18 ec=$EC count=$(cat "$WATCH_FAIL_COUNT") out=$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)"
fi

echo "REARM_CASES pass=$pass fail=$fail"
(( fail == 0 )) && echo REARM_TEST_ALL_PASS
(( fail == 0 ))
