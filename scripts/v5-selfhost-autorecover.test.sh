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
    'ticket create') echo '{"ok":true,"ticket":{"identifier":"OCV5-900","version":1}}' ;;
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
inc() { sed -n "s/^$1=//p" "$C/state/incident.env" 2>/dev/null | tail -n1; }
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
if [[ ! -f "$C/state/incident.env" ]] && grep -q '^ticket comment OCV5-900' "$C/task.calls" && grep -q '已自愈' "$C/task.calls"; then
  ok "A7 later recovery closes the incident and comments 已自愈 on the escalation ticket"
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

setup a13; printf 'reason=x\n' >"$C/watch/watch-disarmed"; OC_V5_AUTORECOVER=off tick 1000
[[ "$(calls)" == 0 && ! -f "$C/state/incident.env" ]] && ok "A13 OC_V5_AUTORECOVER=off → no-op" || bad "A13 calls=$(calls)"

# 隔离护栏:只调 ar_enabled,不跑 tick,不会碰宿主默认路径。
g1="$(env -u OC_V5_AUTORECOVER_DIR LEASE_DB=/tmp/x.db bash -c "wlog(){ :; }; source '$AR'; ar_enabled && echo on || echo off")"
g2="$(env -u OC_V5_AUTORECOVER_DIR LEASE_DB=/var/lib/openclaude-v5-selfhost/lease.db bash -c "wlog(){ :; }; source '$AR'; ar_enabled && echo on || echo off")"
g3="$(OC_V5_AUTORECOVER_DIR=/tmp/y LEASE_DB=/tmp/x.db bash -c "wlog(){ :; }; source '$AR'; ar_enabled && echo on || echo off")"
[[ "$g1 $g2 $g3" == "off on on" ]] && ok "A14 redirected lease DB without redirected state dir → disabled (test isolation)" || bad "A14 $g1 $g2 $g3"

echo "autorecover: pass=$pass fail=$fail"
[[ "$fail" == 0 ]]
