#!/usr/bin/env bash
# OCV5-420 autorecover 控制器测试:真 lease lib + 临时 sqlite;systemd-run / systemctl / 看护 / oc-task
# 全部打桩(systemd-run 同步执行),时间用 AR_NOW_OVERRIDE 推进。不碰宿主 lease.db 与标记。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${LEASE_LIB_SCRIPT:-$DIR/v5-lease-lib.sh}"
WORKER="${LEASE_WORKER_SCRIPT:-$DIR/v5-lease-worker.sh}"
AR="${AUTORECOVER_SCRIPT:-$DIR/v5-selfhost-autorecover.sh}"
command -v sqlite3 >/dev/null || { echo "SKIP: 需要 sqlite3" >&2; exit 2; }

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

BASE="$(mktemp -d "${TMPDIR:-/tmp}/v5-autorecover.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT
fn_of() { awk -v n="$2() {" 'index($0, n) == 1 {f=1} f {print} f && /^}/ {exit}' "$1"; }

# systemd-run 桩:跳过 -- 选项,同步执行命令。systemctl 桩:is-active 读 $C/active.<unit>。
mkdir -p "$BASE/bin"
cat >"$BASE/bin/systemd-run" <<'EOS'
#!/usr/bin/env bash
while [[ "${1:-}" == --* ]]; do shift; done
exec "$@"
EOS
cat >"$BASE/bin/systemctl" <<'EOS'
#!/usr/bin/env bash
[[ "$1" == is-active ]] || exit 0
[[ -f "$C/active.$2" ]] && { echo active; exit 0; }
echo inactive; exit 3
EOS
chmod 0755 "$BASE/bin/"*

setup() {
  C="$BASE/$1"
  mkdir -p "$C/state" "$C/watch" "$C/rel"
  export C
  export OC_V5_LEASE_DB="$C/lease.db" OC_V5_LEASE_LIVE_LINK="$C/live"
  export OC_V5_AUTORECOVER_DIR="$C/state" OC_V5_AUTORECOVER_WATCH_BIN="$C/watch/watch.sh"
  export OC_V5_AUTORECOVER_ALERT_BIN="$C/watch/alert.sh"
  export OC_V5_AUTORECOVER_MANUAL_RECOVERY="$C/rel/.manual-recovery-required" OC_V5_AUTORECOVER_DISARM="$C/watch/watch-disarmed"
  export OC_V5_AUTORECOVER_SYSTEMD_RUN="$BASE/bin/systemd-run" OC_V5_AUTORECOVER_SYSTEMCTL="$BASE/bin/systemctl"
  # 看护桩:按 $C/watch.rc 返回,记录参数。
  cat >"$C/watch/watch.sh" <<EOS
#!/usr/bin/env bash
echo "\$*" >>"$C/watch.calls"
rc=\$(cat "$C/watch.rc" 2>/dev/null || echo 0)
[[ "\$rc" == 0 ]] && rm -f "$C/rel/.manual-recovery-required" "$C/watch/watch-disarmed"
echo "AUTORECOVER_RC_\$rc"
exit "\$rc"
EOS
  printf '#!/bin/sh\necho "$*" >>"%s/alert.calls"\n' "$C" >"$C/watch/alert.sh"
  chmod 0755 "$C/watch/watch.sh" "$C/watch/alert.sh"
  echo 0 >"$C/watch.rc"
  ( export OC_V5_LEASE_DB; source "$LIB"; lease_init_db )
}

# 子 shell 里加载真 lib + worker 的 transition_with_outbox + 控制器,再跑一拍。
{
  echo 'set -euo pipefail'
  echo 'source "$H_LIB"'
  echo 'RESOURCE=deploy:selfhost ACTOR=worker:test'
  echo 'wlog() { echo "$*" >>"$C/worker.log"; }'
  echo 'lease_body_failed() { echo "FAILED-BODY $*"; }'
  echo 'lease_deploy_process_running() { [[ -f "$C/deploy.running" ]]; }'
  cat <<'EOS'
task_cli() {
  shift
  echo "$*" >>"$C/task.calls"
  case "$1 $2" in
    'ticket create') [[ -f "$C/create.fail" ]] && { echo 'gateway down' >&2; return 3; }
      echo '{"ok":true,"ticket":{"identifier":"OCV5-900","version":1}}' ;;
    'ticket approve') [[ -f "$C/approve.fail" ]] && { echo 'gateway down' >&2; return 3; }; echo '{"ok":true}' ;;
    'ticket get') if [[ -f "$C/get.ready" ]]; then echo '{"ok":true,"ticket":{"identifier":"OCV5-900","status":"ready","version":2}}'
      else echo '{"ok":true,"ticket":{"identifier":"OCV5-900","status":"backlog","version":2}}'; fi ;;
    *) echo '{"ok":true}' ;;
  esac
}
EOS
  fn_of "$WORKER" transition_with_outbox
  echo 'source "$H_AR"'
  echo 'autorecover_tick || echo "TICK_RC=$?"'
} >"$BASE/harness.sh"
tick() { # <epoch>
  set +e
  OUT="$(AR_NOW_OVERRIDE="$1" H_LIB="$LIB" H_AR="$AR" bash "$BASE/harness.sh" 2>&1)"
  EC=$?
  set -e
}
sql() { sqlite3 -noheader "$C/lease.db" "$@"; }
add_train() { # <id> <status> <target>
  sql "INSERT INTO train(id,resource,target_sha,status,owner,created_at,updated_at) VALUES('$1','deploy:selfhost','$3','$2','deploy:1',strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'));"
}
add_ride() { # <id> <want>
  sql "INSERT INTO lease(id,resource,mode,status,owner,owner_uid,want_sha,ticket_ref,created_at,updated_at) VALUES('$1','deploy:selfhost','ride','registered','cc3-test','3','$2','OCV5-1',strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'));"
}
inc() { sed -n "s/^$1=//p" "$C/state/incident.env" 2>/dev/null | tail -n1 || true; }
calls() { [[ -f "$C/watch.calls" ]] && wc -l <"$C/watch.calls" || echo 0; }
T1="$(printf 'a%.0s' {1..40})"

setup a1; tick 1000
[[ "$EC" == 0 && ! -f "$C/state/incident.env" && "$(calls)" == 0 ]] && ok "A1 no incident → nothing" || bad "A1 out=$OUT"

# ── 中途被打断的列车:绿 → 结成 failed,搭车保持 registered(下一 tick 自动重发),事件结束 ──
setup a2; add_train tr-a2 recovery_required "$T1"; add_ride ls-a2 "$T1"
tick 1000; s1="$(inc attempts)"
tick 1010
st="$(sql "SELECT status FROM train WHERE id='tr-a2';")"; ev="$(sql "SELECT actor FROM event WHERE subject_id='tr-a2' AND event='autorecover-resolved';")"
ride="$(sql "SELECT status FROM lease WHERE id='ls-a2';")"
tick 1040
if [[ "$s1" == 1 && "$st" == failed && "$ev" == autorecover && "$ride" == registered && ! -f "$C/state/incident.env" \
  && -n "$(ls "$C/state/history/" 2>/dev/null)" && "$(grep -c autorecover_closed "$C/alert.calls")" == 1 && ! -f "$C/task.calls" ]]; then
  ok "A2 interrupted train auto-resolved after green; ride stays registered for auto re-run; incident closed"
else bad "A2 attempts=$s1 st=$st ev=$ev ride=$ride inc=$(cat "$C/state/incident.env" 2>/dev/null) out=$OUT"; fi
open="$(sql "SELECT COUNT(*) FROM train WHERE resource='deploy:selfhost' AND status NOT IN ('committed','failed');")"
[[ "$open" == 0 ]] && ok "A3 no open train left → dispatch is unblocked" || bad "A3 open=$open"

# ── 同 target 自动重跑超限:搭车失败回调 + 升级开单并批准 ──
setup a4; add_train tr-old1 failed "$T1"; add_train tr-old2 failed "$T1"
sql "INSERT INTO event(subject_id,event,actor,detail,created_at) VALUES('tr-old1','autorecover-resolved','autorecover','x',strftime('%Y-%m-%dT%H:%M:%SZ','now')),('tr-old2','autorecover-resolved','autorecover','x',strftime('%Y-%m-%dT%H:%M:%SZ','now'));"
add_train tr-a4 recovery_required "$T1"; add_ride ls-a4 "$T1"
tick 1000; tick 1010
ride="$(sql "SELECT status FROM lease WHERE id='ls-a4';")"; ob="$(sql "SELECT kind FROM outbox WHERE lease_id='ls-a4';")"
if [[ "$ride" == failed && "$ob" == failed && "$(inc ticket)" == OCV5-900 ]] && grep -q '^ticket create' "$C/task.calls" \
  && grep -q '^ticket approve OCV5-900 --expected-version 1 --owner agent:autorecover' "$C/task.calls"; then
  ok "A4 re-run budget exceeded → ride fails with callback, P1 ticket created and approved for AI"
else bad "A4 ride=$ride ob=$ob ticket=$(inc ticket) calls=$(cat "$C/task.calls" 2>/dev/null) out=$OUT"; fi
grep -q -- '--priority P1' "$C/task.calls" && ok "A5 escalation ticket is P1" || bad "A5 $(cat "$C/task.calls")"

# ── 标记 + 一直红:退避 0/300/900,3 次后只探测,升级一次;最后转绿 → 自愈留言 ──
setup a6; printf 'reason=x\n' >"$C/watch/watch-disarmed"; echo 1 >"$C/watch.rc"
tick 1000; a=$(calls)        # 第 1 次
tick 1010; b=$(calls)        # 读结果;退避 300 未到
tick 1310; c=$(calls)        # 第 2 次
tick 1320; tick 2200; d=$(calls)   # 900 未到
tick 2220; e=$(calls)        # 第 3 次
tick 2230; tk="$(inc ticket)"
tick 3130; f=$(calls); probe="$(tail -n1 "$C/watch.calls")"
if [[ "$a $b $c $d $e $f" == "1 1 2 2 3 4" && "$tk" == OCV5-900 && "$probe" == "--auto-recover --probe-only" \
  && "$(grep -c '^ticket create' "$C/task.calls")" == 1 && "$(head -n1 "$C/watch.calls")" == "--auto-recover" ]]; then
  ok "A6 backoff 0/300/900, escalate once after 3 failed restores, then probe-only"
else bad "A6 calls=$a,$b,$c,$d,$e,$f ticket=$tk probe=$probe tasks=$(cat "$C/task.calls" 2>/dev/null)"; fi
echo 0 >"$C/watch.rc"; tick 4030; tick 4040; tick 4050
if [[ ! -f "$C/state/incident.env" ]] && grep -q '^ticket comment OCV5-900' "$C/task.calls" && grep -q '现场已恢复' "$C/task.calls"; then
  ok "A7 later recovery closes the incident and comments 现场已恢复 on the escalation ticket"
else bad "A7 inc=$(cat "$C/state/incident.env" 2>/dev/null) tasks=$(cat "$C/task.calls")"; fi

setup a8; printf 'reason=x\n' >"$C/watch/watch-disarmed"; echo 75 >"$C/watch.rc"
tick 1000; tick 1010; at="$(inc attempts)"; tick 1020; c=$(calls)
[[ "$at" == 0 && "$c" == 2 ]] && ok "A8 rc 75 (lock/window) is not counted and retried next tick" || bad "A8 attempts=$at calls=$c"

setup a9; printf 'reason=x\n' >"$C/watch/watch-disarmed"; touch "$C/deploy.running"; tick 1000
[[ "$(calls)" == 0 && -f "$C/state/incident.env" ]] && ok "A9 deploy running → incident opened but no action" || bad "A9 calls=$(calls)"

setup a10; printf 'reason=x\n' >"$C/watch/watch-disarmed"; touch "$C/active.openclaude-v5-selfhost-cutover-watch.service"; tick 1000
[[ "$(calls)" == 0 ]] && ok "A10 cutover survivor active → no action" || bad "A10 calls=$(calls)"

setup a11; printf 'reason=x\n' >"$C/watch/watch-disarmed"; echo 3 >"$C/watch.rc"
tick 1000; tick 1010; tick 2810; tk="$(inc ticket)"
[[ "$tk" == OCV5-900 ]] && ok "A11 dependency-wait incident escalates after 30 min" || bad "A11 ticket=$tk out=$OUT"

setup a12; add_train tr-a12 recovery_required "$T1"; rm -f "$C/watch/watch.sh"; tick 1000
[[ "$(inc need_escalate)" == missing-watch ]] && ok "A12 missing installed watch → escalation flagged, no crash" || bad "A12 out=$OUT"

# ── Codex r1:预算超限只失败本 target 包含的搭车,之后登记的修复提交不受影响 ──
setup a15; T2="$(printf 'b%.0s' {1..40})"
add_train tr-o1 failed "$T1"; add_train tr-o2 failed "$T1"
sql "INSERT INTO event(subject_id,event,actor,detail,created_at) VALUES('tr-o1','autorecover-resolved','autorecover','x',strftime('%Y-%m-%dT%H:%M:%SZ','now')),('tr-o2','autorecover-resolved','autorecover','x',strftime('%Y-%m-%dT%H:%M:%SZ','now'));"
add_train tr-a15 recovery_required "$T1"; add_ride ls-a15a "$T1"; add_ride ls-a15b "$T2"
tick 1000; tick 1010
a="$(sql "SELECT status FROM lease WHERE id='ls-a15a';")"; b="$(sql "SELECT status FROM lease WHERE id='ls-a15b';")"
[[ "$a" == failed && "$b" == registered ]] && ok "A15 budget exceeded fails only rides contained in that target; a newer fix ride stays" || bad "A15 a=$a b=$b"

# ── Codex r1:批准失败要重试 ──
setup a16; printf 'reason=x\n' >"$C/watch/watch-disarmed"; echo 1 >"$C/watch.rc"; touch "$C/approve.fail"
tick 1000; tick 1010; tick 2810; n1="$(grep -c '^ticket approve' "$C/task.calls" || true)"; ap1="$(inc approved)"
rm -f "$C/approve.fail"; tick 2820; n2="$(grep -c '^ticket approve' "$C/task.calls" || true)"
if [[ "$n1" == 1 && "$ap1" == 0 && "$n2" == 2 && "$(inc approved)" == 1 ]] && grep -q '^ticket approve OCV5-900 --expected-version 2' "$C/task.calls"; then
  ok "A16 failed approve is retried (re-reading the version) until it succeeds"
else bad "A16 n1=$n1 ap1=$ap1 n2=$n2 approved=$(inc approved) calls=$(grep '^ticket' "$C/task.calls")"; fi

# ── Codex r1:触发消失也不能丢掉未完成的升级 ──
setup a17; add_train tr-p1 failed "$T1"; add_train tr-p2 failed "$T1"
sql "INSERT INTO event(subject_id,event,actor,detail,created_at) VALUES('tr-p1','autorecover-resolved','autorecover','x',strftime('%Y-%m-%dT%H:%M:%SZ','now')),('tr-p2','autorecover-resolved','autorecover','x',strftime('%Y-%m-%dT%H:%M:%SZ','now'));"
add_train tr-a17 recovery_required "$T1"; add_ride ls-a17 "$T1"; touch "$C/create.fail"
tick 1000; tick 1010; tick 1040; kept1=$([[ -f "$C/state/incident.env" ]] && echo y || echo n)
rm -f "$C/create.fail"; tick 1070
hist="$(ls "$C/state/history/"*.env 2>/dev/null | head -n1)"
tk="$(sed -n 's/^ticket=//p' "$hist" 2>/dev/null | tail -n1 || true)"; ap="$(sed -n 's/^approved=//p' "$hist" 2>/dev/null | tail -n1 || true)"
closed=$([[ -f "$C/state/incident.env" ]] && echo n || echo y)
if [[ "$kept1" == y && "$tk" == OCV5-900 && "$ap" == 1 && "$closed" == y ]] && grep -q '^ticket comment OCV5-900' "$C/task.calls" \
  && grep -q 'rerun-budget' "$C/task.calls"; then
  ok "A17 incident is kept until the escalation ticket is created and approved, then closed with a note that releases stay stopped"
else bad "A17 kept1=$kept1 tk=$tk ap=$ap closed=$closed"; fi

# ── Codex r2:批准其实已成功(响应丢失)→ 读到非 backlog 即视为已批准,事件能结束 ──
setup a18; printf 'reason=x\n' >"$C/watch/watch-disarmed"; echo 1 >"$C/watch.rc"; touch "$C/approve.fail" "$C/get.ready"
tick 1000; tick 1010; tick 2810; ap="$(inc approved)"
echo 0 >"$C/watch.rc"; tick 3800; tick 3810; tick 3820
[[ "$ap" == 1 && ! -f "$C/state/incident.env" ]] && ok "A18 approve lost-response (ticket already ready) counts as approved; incident closes" || bad "A18 ap=$ap inc=$(cat "$C/state/incident.env" 2>/dev/null)"

setup a13; printf 'reason=x\n' >"$C/watch/watch-disarmed"; OC_V5_AUTORECOVER=off tick 1000
[[ "$(calls)" == 0 && ! -f "$C/state/incident.env" ]] && ok "A13 OC_V5_AUTORECOVER=off → no-op" || bad "A13 calls=$(calls)"

# 隔离护栏:只调 ar_enabled,不跑 tick,不会碰宿主默认路径。
g1="$(env -u OC_V5_AUTORECOVER_DIR LEASE_DB=/tmp/x.db bash -c "wlog(){ :; }; source '$AR'; ar_enabled && echo on || echo off")"
g2="$(env -u OC_V5_AUTORECOVER_DIR LEASE_DB=/var/lib/openclaude-v5-selfhost/lease.db bash -c "wlog(){ :; }; source '$AR'; ar_enabled && echo on || echo off")"
g3="$(OC_V5_AUTORECOVER_DIR=/tmp/y LEASE_DB=/tmp/x.db bash -c "wlog(){ :; }; source '$AR'; ar_enabled && echo on || echo off")"
[[ "$g1 $g2 $g3" == "off on on" ]] && ok "A14 redirected lease DB without redirected state dir → disabled (test isolation)" || bad "A14 $g1 $g2 $g3"

# ── OCV5-616: rc=75 锁跳过不按 1800s 墙钟误建单,有界上限 7200s 兜底,释锁后恢复/失败仍按原规则 ──
setup a19; printf 'reason=schema\n' >"$C/watch/watch-disarmed"; echo 75 >"$C/watch.rc"
tick 1000; tick 1010; tick 2810; tick 2820
tk19="$(inc ticket)"; at19="$(inc attempts)"; ls19="$(inc lock_skip_since)"
echo 0 >"$C/watch.rc"; tick 2850; tick 2860; tick 2870
if [[ -z "$tk19" && "$at19" == 0 && "$ls19" == 1000 && ! -f "$C/task.calls" && ! -f "$C/state/incident.env" \
  && -n "$(ls "$C/state/history/"*.env 2>/dev/null)" ]]; then
  ok "A19 continuous rc=75 past 1800s (<7200s) does not escalate; later recovery archives incident cleanly"
else bad "A19 tk=$tk19 at=$at19 ls=$ls19 tasks=$(cat "$C/task.calls" 2>/dev/null) inc=$(cat "$C/state/incident.env" 2>/dev/null)"; fi

setup a20; printf 'reason=schema\n' >"$C/watch/watch-disarmed"; echo 75 >"$C/watch.rc"
tick 1000; tick 1010; tick 2810; tick 2820
tk_mid="$(inc ticket)"
tick 8200
tk20="$(inc ticket)"; ap20="$(inc approved)"; at20="$(inc attempts)"
echo 0 >"$C/watch.rc"; tick 8230; tick 8240; tick 8250
if [[ -z "$tk_mid" && "$tk20" == OCV5-900 && "$ap20" == 1 && "$at20" == 0 ]] \
  && grep -q '恢复锁持续占用超过 7200s 未能执行自动恢复' "$C/task.calls" \
  && grep -q '已做:恢复动作 0 次,最后结果 rc=75' "$C/task.calls" \
  && [[ ! -f "$C/state/incident.env" ]] && grep -q '^ticket comment OCV5-900' "$C/task.calls"; then
  ok "A20 continuous rc=75 >= AR_LOCK_SKIP_MAX_SEC (7200s) escalates with 0 actions and lock-hold reason; later recovery closes"
else bad "A20 mid=$tk_mid tk=$tk20 ap=$ap20 at=$at20 tasks=$(cat "$C/task.calls" 2>/dev/null)"; fi

setup a20b; printf 'reason=schema\n' >"$C/watch/watch-disarmed"; echo 75 >"$C/watch.rc"
AR_LOCK_SKIP_MAX_SEC=600 tick 1000; AR_LOCK_SKIP_MAX_SEC=600 tick 1010; AR_LOCK_SKIP_MAX_SEC=600 tick 1600
if [[ "$(inc ticket)" == OCV5-900 && "$(inc attempts)" == 0 ]] \
  && grep -q '恢复锁持续占用超过 600s 未能执行自动恢复' "$C/task.calls"; then
  ok "A20b custom AR_LOCK_SKIP_MAX_SEC=600 triggers bounded lock-skip escalation"
else bad "A20b tk=$(inc ticket) at=$(inc attempts) tasks=$(cat "$C/task.calls" 2>/dev/null)"; fi

setup a21; printf 'reason=x\n' >"$C/watch/watch-disarmed"; echo 75 >"$C/watch.rc"
tick 1000; tick 1010
echo 3 >"$C/watch.rc"; tick 2500; tick 2510; tick 2810
tk21_early="$(inc ticket)"; lsec21="$(inc lock_skip_sec)"
tick 4300
tk21="$(inc ticket)"; ap21="$(inc approved)"; at21="$(inc attempts)"
if [[ -z "$tk21_early" && "$lsec21" == 1500 && "$tk21" == OCV5-900 && "$ap21" == 1 && "$at21" == 2 ]] \
  && grep -q '已做:恢复动作 2 次,最后结果 rc=3' "$C/task.calls" \
  && grep -q '已扣除锁跳过 1500s' "$C/task.calls"; then
  ok "A21 after lock release, effective unconverged time (excluding 1500s skip) escalates at +1800s"
else bad "A21 early=$tk21_early lsec=$lsec21 tk=$tk21 ap=$ap21 at=$at21 tasks=$(cat "$C/task.calls" 2>/dev/null)"; fi

setup a22; printf 'reason=x\n' >"$C/watch/watch-disarmed"; echo 75 >"$C/watch.rc"
tick 1000; tick 1010
echo 1 >"$C/watch.rc"
tick 2000; tick 2010
tick 2300; tick 2310
tick 3210; tick 3220
if [[ "$(inc ticket)" == OCV5-900 && "$(inc attempts)" == 3 ]] \
  && grep -q '两级兜底已自动重试 3 次仍未恢复' "$C/task.calls" \
  && grep -q '已做:恢复动作 3 次,最后结果 rc=1' "$C/task.calls"; then
  ok "A22 after lock release, 3 failed real attempts still escalate by AR_RESTORE_MAX without rc=75 inflation"
else bad "A22 tk=$(inc ticket) at=$(inc attempts) tasks=$(cat "$C/task.calls" 2>/dev/null)"; fi

setup a23; printf 'reason=schema\n' >"$C/watch/watch-disarmed"; echo 75 >"$C/watch.rc"
printf 'id=ar-legacy\nstarted=1000\nattempts=0\nlast=0\nreasons=watch-disarmed\nlast_rc=75\nlast_out=AUTORECOVER_SKIP lock\n' >"$C/state/incident.env"
tick 2810; tick 2820
tk23_early="$(inc ticket)"
tick 8200
if [[ -z "$tk23_early" && "$(inc ticket)" == OCV5-900 && "$(inc attempts)" == 0 ]] \
  && grep -q '恢复锁持续占用超过 7200s' "$C/task.calls"; then
  ok "A23 legacy incident.env without lock_skip_* fields is backward-compatible"
else bad "A23 early=$tk23_early tk=$(inc ticket) at=$(inc attempts) tasks=$(cat "$C/task.calls" 2>/dev/null)"; fi

# ── OCV5-818 Stage 4: 发布列车 / survivor 阻塞期间不空耗 1800s 升级时钟,仍受 AR_LOCK_SKIP_MAX_SEC 上限约束 ──
setup a24; printf 'reason=deps-pg\n' >"$C/watch/watch-disarmed"; echo 1 >"$C/watch.rc"
tick 1000; tick 1010            # attempt 1 → rc=1
tick 1310; tick 1320            # attempt 2 → rc=1
touch "$C/deploy.running"
tick 2000; tick 2810; tick 4200 # 37 分钟发布列车占住不抢分支
rm -f "$C/deploy.running"
echo 0 >"$C/watch.rc"
tick 4242                       # wall-clock 3242s (>1800s), 但扣除 2242s 发布阻塞后有效 1000s → 不升级,立即发第 3 次
tk24_mid="$(inc ticket)"; lsec24="$(inc lock_skip_sec)"; at24="$(inc attempts)"
tick 4252; tick 4262
if [[ -z "$tk24_mid" && "$lsec24" == 2242 && "$at24" == 3 && ! -f "$C/task.calls" && ! -f "$C/state/incident.env" ]]; then
  ok "A24 long deploy train (>30m) is excluded from 1800s escalation clock; attempt 3 recovers with zero false tickets"
else
  bad "A24 mid_tk=$tk24_mid lsec=$lsec24 at=$at24 tasks=$(cat "$C/task.calls" 2>/dev/null) inc=$(cat "$C/state/incident.env" 2>/dev/null)"
fi

setup a25; printf 'reason=deps-pg\n' >"$C/watch/watch-disarmed"; echo 1 >"$C/watch.rc"
touch "$C/active.openclaude-v5-selfhost-cutover-watch.service"
tick 1000; tick 2900            # survivor 占住 1900s (>1800s, <7200s) → 不升级
tk25_early="$(inc ticket)"
rm -f "$C/active.openclaude-v5-selfhost-cutover-watch.service"
tick 3000                       # survivor 结束 → 扣除 2000s, 启动第 1 次恢复
lsec25="$(inc lock_skip_sec)"; at25="$(inc attempts)"; tk25_after="$(inc ticket)"
# 发布持续卡死超 AR_LOCK_SKIP_MAX_SEC 仍触发有界升级
setup a25b; printf 'reason=deps-pg\n' >"$C/watch/watch-disarmed"; touch "$C/deploy.running"
AR_LOCK_SKIP_MAX_SEC=600 tick 1000; AR_LOCK_SKIP_MAX_SEC=600 tick 1600
if [[ -z "$tk25_early" && -z "$tk25_after" && "$lsec25" == 2000 && "$at25" == 1 \
  && "$(inc ticket)" == OCV5-900 ]] && grep -q '恢复锁持续占用超过 600s' "$C/task.calls"; then
  ok "A25 survivor wait excluded from 1800s clock; stuck deploy still escalates at AR_LOCK_SKIP_MAX_SEC"
else
  bad "A25 early=$tk25_early after=$tk25_after lsec=$lsec25 at=$at25 b_tk=$(inc ticket) tasks=$(cat "$C/task.calls" 2>/dev/null)"
fi

setup a26; printf 'reason=deps-pg\n' >"$C/watch/watch-disarmed"; echo 1 >"$C/watch.rc"
tick 1000                       # attempt 1 写了 AR_RESULT(rc=1), 下拍还没读时发布启动
touch "$C/deploy.running"
tick 1330; tick 3530            # 2200s 发布阻塞期间 AR_RESULT 留在盘上
rm -f "$C/deploy.running"
tick 3540                       # 先结算 2210s wait 再读 AR_RESULT, 不因陈旧 last=1000 丢掉等待时长
if [[ "$(inc lock_skip_sec)" == 2210 && -z "$(inc ticket)" ]]; then
  ok "A26 pending AR_RESULT across deploy wait preserves full wait duration without stale-last truncation"
else
  bad "A26 lsec=$(inc lock_skip_sec) tk=$(inc ticket) inc=$(cat "$C/state/incident.env" 2>/dev/null)"
fi

# ── OCV5-818 Stage 4 (Audit #4 Order 1): 待消费 rc=75 + deploy.running 重叠不得重复计费误开 P1 ──
setup a27; printf 'reason=deps-pg\n' >"$C/watch/watch-disarmed"; echo 75 >"$C/watch.rc"
tick 1000                       # 发动作(last=1000), AR_RESULT 写入 rc=75
touch "$C/deploy.running"
tick 1010                       # 发布开始(wait 开窗 1010)
rm -f "$C/deploy.running"
tick 4700                       # 实际只过 3700s(<7200s); 区间并集 [1000,4700] 不得算成 3690+3700=7390
if [[ -z "$(inc ticket)" && ! -f "$C/task.calls" && "$(inc attempts)" == 0 \
  && "$(inc lock_skip_sec)" == 0 && "$(inc lock_skip_since)" == 1000 ]]; then
  ok "A27 overlapping pending rc=75 and deploy wait merges as interval union (3700s, no double-count escalation)"
else
  bad "A27 tk=$(inc ticket) at=$(inc attempts) lsec=$(inc lock_skip_sec) lsince=$(inc lock_skip_since) tasks=$(cat "$C/task.calls" 2>/dev/null)"
fi

# ── OCV5-818 Stage 4 (Audit #4 Order 2): 反向交接 rc=75 → rc=1 待消费 → deploy.running 不得用旧 last 截掉发布等待 ──
setup a28; printf 'reason=deps-pg\n' >"$C/watch/watch-disarmed"; echo 75 >"$C/watch.rc"
tick 1000; tick 1010            # 消费 rc=75 → lock_skip_since=1000, last=0
echo 1 >"$C/watch.rc"
tick 2000                       # 发动作(last=2000), AR_RESULT 写入 rc=1
touch "$C/deploy.running"
tick 2010                       # 发布开始,保留 lock_skip_since=1000 并标记 had_wait=1
rm -f "$C/deploy.running"
tick 5000                       # 发布结束消费 rc=1: 按 now=5000 结算整段 4000s,不截成 last=2000(1000s)
if [[ -z "$(inc ticket)" && "$(inc lock_skip_sec)" == 4000 && "$(inc lock_skip_since)" == 0 ]]; then
  ok "A28 reverse handoff (rc=75 then pending rc=1 then deploy wait) credits full 4000s without truncation"
else
  bad "A28 tk=$(inc ticket) lsec=$(inc lock_skip_sec) lsince=$(inc lock_skip_since) inc=$(cat "$C/state/incident.env" 2>/dev/null)"
fi

# ── OCV5-818 Stage 4 (Audit #5): 前两次失败 + 第三次待消费 rc=75 遇发布阻塞不得用未结算 attempts 误开 P1 ──
setup a29; printf 'reason=deps-pg\n' >"$C/watch/watch-disarmed"; echo 1 >"$C/watch.rc"
tick 1000; tick 1010            # 第 1 次失败 (settled=1, last_rc=1)
tick 1310; tick 1320            # 第 2 次失败 (settled=2, last_rc=1)
echo 75 >"$C/watch.rc"
tick 2220                       # 第 3 次发出 (attempts=3), AR_RESULT=75 尚未消费
touch "$C/deploy.running"
tick 2230                       # 遇发布阻塞: settled_attempts=2 < 3, 绝不能凭旧 last_rc=1 误开 P1
tk29_during="$(inc ticket)"
rm -f "$C/deploy.running"
tick 2500                       # 解阻消费 rc=75 → attempts 退回 2, 仍不开单
if [[ -z "$tk29_during" && -z "$(inc ticket)" && ! -f "$C/task.calls" && "$(inc attempts)" == 2 ]]; then
  ok "A29 unsettled 3rd attempt (pending rc=75) during deploy wait does not trigger false AR_RESTORE_MAX escalation"
else
  bad "A29 during=$tk29_during tk=$(inc ticket) at=$(inc attempts) tasks=$(cat "$C/task.calls" 2>/dev/null)"
fi

# ── OCV5-818 Stage 4 (Audit R2 #5): 动作在 is-active 瞬时窗口写完 rc=75 并退出,ar_settled_attempts 仍必须判为未结算(2而非3) ──
setup a30; printf 'reason=deps-pg\n' >"$C/watch/watch-disarmed"
printf 'id=ar-race\nstarted=1000\nattempts=3\nlast=2220\nlast_rc=1\nlast_out=AUTORECOVER_STILL_RED\nlock_skip_sec=0\nlock_skip_since=0\n' >"$C/state/incident.env"
cat >"$C/race-systemctl" <<EOS
#!/usr/bin/env bash
if [[ "\$1" == is-active && "\$2" == openclaude-v5-selfhost-autorecover-action.service ]]; then
  # 模拟动作恰在 is-active 观察窗口内原子发布 AR_RESULT(rc=75) 并退出
  printf 'rc=75\nout=AUTORECOVER_SKIP lock\nat=2230\n' >"$C/state/action.result"
  echo inactive; exit 3
fi
echo inactive; exit 3
EOS
chmod 0755 "$C/race-systemctl"
touch "$C/deploy.running"
OC_V5_AUTORECOVER_SYSTEMCTL="$C/race-systemctl" tick 2230
if [[ -z "$(inc ticket)" && ! -f "$C/task.calls" && -f "$C/state/action.result" ]]; then
  ok "A30 action finishing with rc=75 mid-check during deploy wait still counts as settled=2 (race-free order)"
else
  bad "A30 tk=$(inc ticket) tasks=$(cat "$C/task.calls" 2>/dev/null) res=$([[ -f "$C/state/action.result" ]] && echo y || echo n)"
fi

echo "autorecover: pass=$pass fail=$fail"
[[ "$fail" == 0 ]]
