#!/usr/bin/env bash
# v5-lease-center-selftest.sh — Lease Center P1 验收(design-v2 §7),全部在隔离沙箱内:
#   隔离 lease.db / 假 git 仓库(origin + 工作树)/ 假 live symlink + .complete / 假 survivor state
#   / 假 deploy 桩(记录启动次数,可按 phase 停住)/ 假 oc-task(记录评论,可注入"写成功响应丢失")。
# 用法: scripts/v5-lease-center-selftest.sh [--keep]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEEP=0; [[ "${1:-}" == --keep ]] && KEEP=1
T="$(mktemp -d /tmp/lease-selftest.XXXXXX)"
kill_stubs() { local p c; for p in /proc/[0-9]*; do c="$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null || true)"; [[ "$c" == *"$T/bin/fake-deploy.sh"* || ( "$c" == "sleep 3600 " && "$(readlink "$p/cwd" 2>/dev/null)" == "$T"* ) ]] && kill "$(basename "$p")" 2>/dev/null; done; sleep 0.2; return 0; }
cleanup() { kill_stubs; [[ "$KEEP" == 1 ]] && { echo "sandbox kept: $T"; return; }; rm -rf "$T"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $*"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $*" >&2; }
assert_eq() { [[ "$1" == "$2" ]] && ok "$3 ($1)" || bad "$3: got '$1' want '$2'"; }

# ---------- 沙箱 ----------
mkdir -p "$T/run" "$T/lib" "$T/logs" "$T/bin" "$T/releases"
export OC_V5_LEASE_DB="$T/lib/lease.db"
export OC_V5_LEASE_LOCK="$T/run/lease-db.lock"
export OC_V5_LEASE_WORKER_LOCK="$T/run/lease-worker.lock"
export OC_V5_SELFHOST_DEPLOY_LOCK="$T/run/deploy.lock"
export OC_V5_LEASE_LIVE_LINK="$T/live"
export OC_V5_LEASE_SURVIVOR_STATE="$T/run/cutover-survivor.state"
export OC_V5_LEASE_SURVIVOR_COMMITTED="$T/run/cutover-survivor.committed"
export OC_V5_LEASE_REPO_ROOT="$T/wt"
export OC_V5_LEASE_BRANCH="feat/test"
export OC_V5_LEASE_LOG_DIR="$T/logs"
export OC_V5_LEASE_DEPLOY_BIN="$T/bin/fake-deploy.sh"
export OC_V5_LEASE_TASK_CLI="$T/bin/fake-oc-task"
export OC_V5_LEASE_TRAIN_PLANNED_STALE_SECONDS=1
export OC_V5_LEASE_CUTOVER_GRACE_FILE="$T/run/cutover-grace-until"
export OC_USER_ID=3
unset OC_SESSION_KEY OC_V5_LEASE_CALLBACK_URL

# 假仓库:origin(bare)+ 工作树,3 个 commit:c0(已上线) c1 c2
git init -q --bare "$T/origin.git"
git init -q -b feat/test "$T/wt"; git -C "$T/wt" config user.email t@t; git -C "$T/wt" config user.name t
mk() { echo "$1" >"$T/wt/$1"; git -C "$T/wt" add -A; git -C "$T/wt" commit -qm "$1"; git -C "$T/wt" rev-parse HEAD; }
C0="$(mk c0)"; C1="$(mk c1)"; C2="$(mk c2)"
git -C "$T/wt" remote add origin "$T/origin.git"; git -C "$T/wt" push -q origin feat/test
UNPUSHED="$(mk c3-unpushed)"   # 本地有、origin 没有;放到侧分支,工作树 HEAD 回到已 push 的 tip
git -C "$T/wt" branch -q unpushed "$UNPUSHED"; git -C "$T/wt" reset -q --hard "$C2"

# 假 live:rel-0 → sourceCommit c0,survivor committed
set_live() { # <sha> <phase>
  local rel="$T/releases/rel-$1"; mkdir -p "$rel"
  jq -cn --arg s "$1" '{sourceCommit:$s}' >"$rel/.complete"
  ln -sfn "$rel" "$T/live.new" && mv -T "$T/live.new" "$T/live"
  jq -cn --arg p "$2" '{phase:$p}' >"$OC_V5_LEASE_SURVIVOR_STATE"
  [[ "$2" == committed ]] && touch "$OC_V5_LEASE_SURVIVOR_COMMITTED" || rm -f "$OC_V5_LEASE_SURVIVOR_COMMITTED"
}
set_live "$C0" committed

# 假 deploy 桩:计数 + 按 FAKE_DEPLOY_MODE 行为
cat >"$T/bin/fake-deploy.sh" <<'EOF'
#!/usr/bin/env bash
set -u
T="$(dirname "$(dirname "$0")")"
echo "$$ $*" >>"$T/deploy-starts.log"
train=""; target=""
for a in "$@"; do case "$a" in --lease-train=*) train="${a#*=}";; --target-sha=*) target="${a#*=}";; esac; done
mode="$(cat "$T/fake-deploy.mode" 2>/dev/null || echo commit)"
# 持锁(fd 8 继承)期间 sleep 一下模拟构建
[[ "$mode" == hang ]] || sleep "${FAKE_DEPLOY_SLEEP:-1}"
case "$mode" in
  commit)
    rel="$T/releases/rel-$target"; mkdir -p "$rel"; jq -cn --arg s "$target" '{sourceCommit:$s}' >"$rel/.complete"
    ln -sfn "$rel" "$T/live.new" && mv -T "$T/live.new" "$T/live"
    jq -cn '{phase:"committed"}' >"$T/run/cutover-survivor.state"; touch "$T/run/cutover-survivor.committed"
    sqlite3 "$T/lib/lease.db" "UPDATE train SET status='committed', rel_path='$rel', finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id='$train';"
    ;;
  stuck-smoked)   # 只切了 symlink,survivor 停在 mutating(未 committed),进程退出
    rel="$T/releases/rel-$target"; mkdir -p "$rel"; jq -cn --arg s "$target" '{sourceCommit:$s}' >"$rel/.complete"
    ln -sfn "$rel" "$T/live.new" && mv -T "$T/live.new" "$T/live"
    jq -cn '{phase:"mutating"}' >"$T/run/cutover-survivor.state"; rm -f "$T/run/cutover-survivor.committed"
    ;;
  hang) cd "$T" && exec sleep 3600 ;;
  fail)   # 门禁拒绝:自己标 failed 退出(真 deploy 的 EXIT trap 行为)
    sqlite3 "$T/lib/lease.db" "UPDATE train SET status='failed', reason='fake gate refused', finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id='$train';
      INSERT INTO event(subject_id,event,actor,detail,created_at) VALUES('$train','train-failed','deploy:$$','fake gate refused',strftime('%Y-%m-%dT%H:%M:%SZ','now'));"
    exit 1 ;;
esac
EOF
chmod +x "$T/bin/fake-deploy.sh"

# 假 oc-task:comment 写 $T/comments/<ticket>.md;get 输出该文件;FAKE_TASK_DROP_RESPONSE=1 → 写成功但 exit 1
cat >"$T/bin/fake-oc-task" <<'EOF'
#!/usr/bin/env bash
T="$(dirname "$(dirname "$0")")"; mkdir -p "$T/comments"
case "$1 $2" in
  "ticket comment") tk="$3"; shift 3; body="$2"; printf '%s\n---\n' "$body" >>"$T/comments/$tk.md"
     [[ -f "$T/task.drop-once" ]] && { rm -f "$T/task.drop-once"; echo "simulated: connection reset after write" >&2; exit 1; }; echo '{"ok":true}' ;;
  "ticket get") cat "$T/comments/$3.md" 2>/dev/null; echo '{"ok":true}' ;;
  *) echo '{"ok":false}'; exit 4 ;;
esac
EOF
chmod +x "$T/bin/fake-oc-task"

LEASE="$SCRIPT_DIR/oc-lease.sh"; WORKER="$SCRIPT_DIR/v5-lease-worker.sh"
starts() { [[ -f "$T/deploy-starts.log" ]] && wc -l <"$T/deploy-starts.log" || echo 0; }
q() { sqlite3 -noheader "$OC_V5_LEASE_DB" "$1"; }
comments() { grep -c '^🎫\|^⏰\|^🚨' "$T/comments/$1.md" 2>/dev/null || echo 0; }
wait_train_done() { for _ in $(seq 1 40); do [[ -z "$(q "SELECT id FROM train WHERE status NOT IN ('committed','failed','recovery_required');")" ]] && return 0; sleep 0.25; done; return 1; }
reset_db() { rm -f "$OC_V5_LEASE_DB"* "$T/deploy-starts.log"; rm -rf "$T/comments"; echo commit >"$T/fake-deploy.mode"; }

echo "═══ T1 两条 ride + 两个并发 tick → 启动 1 次;committed 后两条 satisfied,面板各 1 条 ═══"
reset_db; set_live "$C0" committed
"$LEASE" register --resource deploy:selfhost --mode ride --sha "$C1" --ticket OCV5-901 --owner s1 >/dev/null
"$LEASE" register --resource deploy:selfhost --mode ride --sha "$C2" --ticket OCV5-902 --owner s2 >/dev/null
assert_eq "$(q "SELECT COUNT(*) FROM lease WHERE status='registered';")" 2 "两条 registered"
FAKE_DEPLOY_SLEEP=2 "$WORKER" >/dev/null 2>&1 & FAKE_DEPLOY_SLEEP=2 "$WORKER" >/dev/null 2>&1 & wait
assert_eq "$(starts)" 1 "并发 tick 只发一班"
wait_train_done || bad "train 未在时限内终态"
"$WORKER" >/dev/null 2>&1   # 结算 + 投递
assert_eq "$(q "SELECT COUNT(*) FROM lease WHERE status='satisfied';")" 2 "两条 satisfied"
assert_eq "$(q "SELECT COUNT(*) FROM outbox WHERE kind='satisfied' AND status='delivered';")" 2 "两条 outbox delivered"
assert_eq "$(comments OCV5-901)$(comments OCV5-902)" "11" "面板各恰 1 条评论"
assert_eq "$(q "SELECT COUNT(*) FROM outbox WHERE transport_id NOT GLOB 'lsc-[0-9a-f]*';")" 0 "transport_id 合法字符"
"$WORKER" >/dev/null 2>&1; assert_eq "$(starts)" 1 "结算后再 tick 不重发"

echo "═══ T2 live 已含 SHA → 不发车、register 直接返回;未 push sha → 拒绝 ═══"
reset_db; set_live "$C2" committed
out="$("$LEASE" register --resource deploy:selfhost --mode ride --sha "$C1" --owner s1)"; rc=$?
assert_eq "$rc" 0 "已上线 register exit 0"; grep -q "已上线" <<<"$out" && ok "提示已上线" || bad "缺已上线提示"
assert_eq "$(q "SELECT COUNT(*) FROM lease;")" 0 "未建 lease"
"$WORKER" >/dev/null 2>&1; assert_eq "$(starts)" 0 "不发车"
set +e; "$LEASE" register --resource deploy:selfhost --mode ride --sha "$UNPUSHED" --owner s1 >/dev/null 2>&1; rc=$?; set -e
assert_eq "$rc" 3 "未 push sha 被拒 exit 3"

echo "═══ T3 在 planned 后 / spawn 后 / committed 前 kill worker → 无二次启动、无丢结算 ═══"
reset_db; set_live "$C0" committed
"$LEASE" register --resource deploy:selfhost --mode ride --sha "$C2" --ticket OCV5-903 --owner s1 >/dev/null
# a) planned 后崩(dry 不 spawn 模拟:插 planned 无 pid)→ 超 1s 后对账 failed,再 tick 才发新一班
OC_V5_LEASE_DRY=1 "$WORKER" >/dev/null 2>&1
assert_eq "$(q "SELECT COUNT(*) FROM train WHERE status='planned';")" 1 "planned 留下无 pid"
"$WORKER" >/dev/null 2>&1; assert_eq "$(starts)" 0 "planned 未超时不发第二班"
sleep 2.2; "$WORKER" >/dev/null 2>&1   # PLANNED_STALE=1s,sqlite 秒级时间戳,留 >1s 余量
assert_eq "$(q "SELECT status FROM train ORDER BY seq LIMIT 1;")" failed "planned 超时 → failed"
assert_eq "$(starts)" 1 "对账后同 tick 发出新一班"
# b) spawn 后 worker 死:执行器还在跑(hang),再 tick 不重发
wait_train_done || true; kill_stubs
reset_db; set_live "$C0" committed; echo hang >"$T/fake-deploy.mode"
"$LEASE" register --resource deploy:selfhost --mode ride --sha "$C2" --ticket OCV5-904 --owner s1 >/dev/null
"$WORKER" >/dev/null 2>&1; assert_eq "$(starts)" 1 "发车"
"$WORKER" >/dev/null 2>&1; "$WORKER" >/dev/null 2>&1; assert_eq "$(starts)" 1 "执行器在跑,后续 tick 不重发"
pid="$(q "SELECT executor_pid FROM train WHERE status='building';")"; kill "$pid" 2>/dev/null || true; sleep 0.5
# c) 执行器死、live 未变(未 committed 到 target)→ failed(live committed 但 ≠ target),不 satisfied
"$WORKER" >/dev/null 2>&1
assert_eq "$(q "SELECT status FROM train WHERE executor_pid=$pid;")" failed "执行器死且 live≠target → 该班 failed"
assert_eq "$(q "SELECT COUNT(*) FROM train WHERE status='building';")" 1 "ride 仍 pending → 同 tick 重新发一班(新 train)"
assert_eq "$(q "SELECT COUNT(*) FROM lease WHERE status='satisfied';")" 0 "未结算"
kill_stubs
# d) 同 target 一班已 failed(门禁拒绝)→ 老 ride 转 failed 并回调,不再自动重发;新 ride 才允许再发一班
reset_db; set_live "$C0" committed; echo fail >"$T/fake-deploy.mode"
"$LEASE" register --resource deploy:selfhost --mode ride --sha "$C2" --ticket OCV5-908 --owner s1 >/dev/null
"$WORKER" >/dev/null 2>&1; wait_train_done || true; sleep 1.1
"$WORKER" >/dev/null 2>&1
assert_eq "$(starts)" 1 "同 target 上一班 failed → 不自动重发"
assert_eq "$(q "SELECT status FROM lease;")" failed "老 ride → failed"
assert_eq "$(q "SELECT status||':'||kind FROM outbox;")" "delivered:failed" "failed 回调已投面板"
assert_eq "$(comments OCV5-908)" 1 "面板恰 1 条失败评论"
"$WORKER" >/dev/null 2>&1; assert_eq "$(starts)" 1 "再 tick 仍不发"
sleep 1.1; "$LEASE" register --resource deploy:selfhost --mode ride --sha "$C2" --ticket OCV5-909 --owner s2 >/dev/null
"$WORKER" >/dev/null 2>&1; assert_eq "$(starts)" 2 "新 ride(人工决定)→ 允许再发一班"
wait_train_done || true; kill_stubs

echo "═══ T4 deploy.lock 被外部持有 → 不发车;桩只切 symlink 未 committed → 不结算、下班不发 ═══"
reset_db; set_live "$C0" committed; echo commit >"$T/fake-deploy.mode"
"$LEASE" register --resource deploy:selfhost --mode ride --sha "$C1" --ticket OCV5-905 --owner s1 >/dev/null
( exec 9>"$OC_V5_SELFHOST_DEPLOY_LOCK"; flock 9; sleep 3 ) & holder=$!; sleep 0.3
"$WORKER" >/dev/null 2>&1; assert_eq "$(starts)" 0 "锁被持有不发车"
wait $holder
echo "until=$(( $(date -u +%s) + 600 ))" >"$OC_V5_LEASE_CUTOVER_GRACE_FILE"
"$WORKER" >/dev/null 2>&1; assert_eq "$(starts)" 0 "grace 未到期不发车"
echo "until=$(( $(date -u +%s) - 600 ))" >"$OC_V5_LEASE_CUTOVER_GRACE_FILE"
"$WORKER" >/dev/null 2>&1; assert_eq "$(starts)" 1 "grace 文件残留但已过期 → 正常发车"
wait_train_done || true; kill_stubs
reset_db; set_live "$C0" committed; echo stuck-smoked >"$T/fake-deploy.mode"
"$LEASE" register --resource deploy:selfhost --mode ride --sha "$C1" --ticket OCV5-906 --owner s1 >/dev/null
"$WORKER" >/dev/null 2>&1; wait_train_done || true; sleep 1.2; "$WORKER" >/dev/null 2>&1
assert_eq "$(readlink -f "$T/live")" "$T/releases/rel-$C2" "symlink 已切到 tip(列车固定发 origin tip)"
assert_eq "$(q "SELECT status FROM train ORDER BY seq DESC LIMIT 1;")" recovery_required "survivor 非 committed → recovery_required"
assert_eq "$(q "SELECT COUNT(*) FROM lease WHERE status='satisfied';")" 0 "仅切 symlink 不算 satisfied"
"$WORKER" >/dev/null 2>&1; assert_eq "$(starts)" 1 "recovery_required 阻止再发车"
assert_eq "$(q "SELECT COUNT(*) FROM outbox WHERE kind='train_alert';")" 1 "train 告警入 outbox"
"$LEASE" train resolve --id "$(q "SELECT id FROM train ORDER BY seq DESC LIMIT 1;")" --as committed --reason "test manual confirm" --actor tester >/dev/null
jq -cn '{phase:"committed"}' >"$OC_V5_LEASE_SURVIVOR_STATE"; touch "$OC_V5_LEASE_SURVIVOR_COMMITTED"
"$WORKER" >/dev/null 2>&1
assert_eq "$(q "SELECT COUNT(*) FROM lease WHERE status='satisfied';")" 1 "人工 resolve+survivor committed 后结算"

echo "═══ T5 SQLITE_BUSY 3s + 面板写成功响应丢失 → 无虚假 satisfied;恢复后事件不丢、评论不重复 ═══"
reset_db; set_live "$C2" committed
"$LEASE" register --resource deploy:selfhost --mode ride --sha "$C1" --ticket OCV5-907 --owner s1 >/dev/null 2>&1 || true
# live 已含 C1 → register 直接返回,不建 lease;改为先建 lease 再切 live
reset_db; set_live "$C0" committed
"$LEASE" register --resource deploy:selfhost --mode ride --sha "$C1" --ticket OCV5-907 --owner s1 >/dev/null
set_live "$C1" committed
touch "$T/task.drop-once"
python3 - "$OC_V5_LEASE_DB" <<'PY' & busy=$!
import sqlite3, sys, time
c = sqlite3.connect(sys.argv[1], isolation_level=None)
c.execute("BEGIN IMMEDIATE"); c.execute("UPDATE lease SET updated_at=updated_at")
time.sleep(3); c.execute("COMMIT")
PY
sleep 0.3
"$WORKER" >"$T/logs/t5.log" 2>&1 || true
wait $busy
st="$(q "SELECT status FROM lease;")"
[[ "$st" == satisfied || "$st" == registered ]] && ok "BUSY 期间状态合法($st),无虚假授权" || bad "BUSY 期间状态异常 $st"
"$WORKER" >/dev/null 2>&1
assert_eq "$(q "SELECT status FROM lease;")" satisfied "恢复后结算"
assert_eq "$(q "SELECT attempts||':'||status FROM outbox WHERE kind='satisfied';")" "1:pending" "首投响应丢失 → attempts=1 仍 pending(退避中)"
q "UPDATE outbox SET next_attempt_at=strftime('%Y-%m-%dT%H:%M:%SZ','now');"   # 模拟退避到点
"$WORKER" >/dev/null 2>&1
assert_eq "$(q "SELECT status FROM outbox WHERE kind='satisfied';")" delivered "outbox 最终 delivered"
assert_eq "$(comments OCV5-907)" 1 "响应丢失重投后面板仍只 1 条评论(transport_id 幂等)"

echo
echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" == 0 ]]
