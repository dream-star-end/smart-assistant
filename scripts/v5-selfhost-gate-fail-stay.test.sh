#!/usr/bin/env bash
# OCV5-418 门禁失败留在新版(stay)行为测试。从 deploy-v5-selfhost.sh 抽出函数,在临时目录里跑,
# survivor 用仓库真脚本,systemctl / alert.sh / lease 写库全部打桩,不碰宿主状态。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="${DEPLOY_SCRIPT:-$DIR/deploy-v5-selfhost.sh}"
SURVIVOR_SRC="${SURVIVOR_SCRIPT:-$DIR/v5-selfhost-cutover-survivor.sh}"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

fn() { awk -v n="$1() {" 'index($0, n) == 1 {f=1} f {print} f && /^}/ {exit}' "$DEPLOY"; }
BASE="$(mktemp -d "${TMPDIR:-/tmp}/v5-gate-fail-stay.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

mkdir -p "$BASE/bin"
# 假 systemctl:只记录,绝不碰宿主 unit。
printf '#!/bin/sh\necho "systemctl $*" >>"%s/systemctl.log"\nexit 0\n' "$BASE" >"$BASE/bin/systemctl"
chmod 0755 "$BASE/bin/systemctl"
install -m 0755 "$SURVIVOR_SRC" "$BASE/survivor.sh"

{
  echo 'log() { echo "$*"; }'
  echo 'die() { echo "DIE $*"; exit 1; }'
  echo 'lease_now() { echo 2026-10-14T00:00:00Z; }'
  echo "lease_q() { printf '%s' \"\${1//\\'/\\'\\'}\"; }"
  echo 'lease_event_sql() { echo "EVENT $1 $2 $3 $4"; }'
  echo 'lease_tx() { cat >>"$LEASE_SQL_LOG"; }'
  echo 'SELFHOST_POLICY_FILE="$OC_V5_SELFHOST_POLICY_FILE"'
  echo 'cutover_compensate() { echo "COMPENSATE $1" >>"$C/compensate.log"; return 1; }'
  for f in cutover_clog cutover_fail cutover_survivor_script cutover_persist_phase selfhost_policy_get \
    gate_fail_policy stay_window_sec gate_fail_drill_armed cutover_gate_against_release \
    write_stay_maintenance clear_stay_maintenance deploy_alert cutover_keep_failed lease_train_finish \
    proc_starttime_of activate_tuple_joint; do
    body="$(fn "$f")"
    [[ -n "$body" ]] || { echo "missing function $f" >&2; exit 1; }
    printf '%s\n' "$body"
  done
} >"$BASE/fns.sh"

setup() {
  C="$BASE/$1"
  mkdir -p "$C/watch" "$C/run" "$C/releases/rel-new"
  export C PATH="$BASE/bin:$PATH"
  export CUTOVER_LOG="$C/cutover.log" LEASE_SQL_LOG="$C/lease.sql"
  export SURVIVOR_STATE="$C/run/survivor.state" SURVIVOR_COMMITTED="$C/run/survivor.committed"
  export CUTOVER_SURVIVOR_SCRIPT="$BASE/survivor.sh"
  export V5_WATCH_DIR="$C/watch" V5_WATCH_MAINT="$C/run/planned-maintenance"
  export OC_V5_SELFHOST_POLICY_FILE="$C/policy.env" MASTER_RELEASES_ROOT="$C/releases"
  unset OC_V5_SELFHOST_ON_GATE_FAIL OC_V5_SELFHOST_STAY_WINDOW_SEC OC_V5_SELFHOST_GATE_FAIL_DRILL_SHA
  printf '{"sourceCommit":"%s"}\n' "$(printf 'a%.0s' {1..40})" >"$C/releases/rel-new/.complete"
  printf 'phase=symlink-flipped\nexecutor_pid=999999999\nbackup_dir=%s/backup\narmed_at=x\n' "$C" >"$SURVIVOR_STATE"
  printf '#!/bin/sh\necho "$*" >>"%s/alert.calls"\n' "$C" >"$C/watch/alert.sh"
  chmod 0755 "$C/watch/alert.sh"
  : >"$C/compensate.log"
  : >"$BASE/systemctl.log"
}
policy() { printf '%s\n' "$@" >"$C/policy.env"; chmod 0600 "$C/policy.env"; }
run() { set +e; OUT="$(bash -c ". '$BASE/fns.sh'; $*" 2>&1)"; EC=$?; set -e; }
SHA_A="$(printf 'a%.0s' {1..40})"
SHA_B="$(printf 'b%.0s' {1..40})"

# ── 策略解析 ──
setup p1; run 'gate_fail_policy'
[[ "$EC" == 0 && "$OUT" == rollback ]] && ok "P1 default policy is rollback" || bad "P1 ec=$EC out=$OUT"
setup p2; policy OC_V5_SELFHOST_ON_GATE_FAIL=stay; run 'gate_fail_policy'
[[ "$OUT" == stay ]] && ok "P2 policy file stay" || bad "P2 out=$OUT"
setup p3; policy OC_V5_SELFHOST_ON_GATE_FAIL=stay; chmod 0664 "$C/policy.env"; run 'gate_fail_policy 2>/dev/null'
[[ "$OUT" == rollback ]] && ok "P3 group-writable policy file ignored" || bad "P3 out=$OUT"
setup p4; policy OC_V5_SELFHOST_ON_GATE_FAIL=yolo; run 'gate_fail_policy 2>/dev/null'
[[ "$OUT" == rollback ]] && ok "P4 invalid value falls back to rollback" || bad "P4 out=$OUT"
setup p5; policy OC_V5_SELFHOST_ON_GATE_FAIL=stay; run 'OC_V5_SELFHOST_ON_GATE_FAIL=rollback gate_fail_policy'
[[ "$OUT" == rollback ]] && ok "P5 env overrides policy file" || bad "P5 out=$OUT"
setup p6; policy 'OC_V5_SELFHOST_ON_GATE_FAIL=stay; touch /tmp/pwn'; run 'gate_fail_policy 2>/dev/null'
[[ "$OUT" == rollback ]] && ok "P6 policy file is parsed, not executed" || bad "P6 out=$OUT"
setup p7; run 'stay_window_sec'; a="$OUT"; policy OC_V5_SELFHOST_STAY_WINDOW_SEC=600; run 'stay_window_sec'; b="$OUT"
policy OC_V5_SELFHOST_STAY_WINDOW_SEC=0; run 'stay_window_sec'
[[ "$a" == 7200 && "$b" == 600 && "$OUT" == 7200 ]] && ok "P7 window default 2h, configurable, invalid → 2h" || bad "P7 $a $b $OUT"

# ── 门禁包装 ──
SMOKE_OK='cutover_smoke_against_release() { return 0; }'
SMOKE_BAD='cutover_smoke_against_release() { cutover_fail "cutover smoke: 用户契约门禁(C1–C3)失败"; return 1; }'
setup g1; run "$SMOKE_OK; cutover_gate_against_release '$C/releases/rel-new' && echo \"rc0 [\$CUTOVER_GATE_FAILED]\""
[[ "$EC" == 0 && "$OUT" == *"rc0 []"* ]] && ok "G1 passing gate passes" || bad "G1 ec=$EC out=$OUT"
setup g2; run "$SMOKE_BAD; cutover_gate_against_release '$C/releases/rel-new'"
[[ "$EC" != 0 ]] && ok "G2 rollback policy: failing gate still fails (compensation path unchanged)" || bad "G2 ec=$EC out=$OUT"
setup g3; policy OC_V5_SELFHOST_ON_GATE_FAIL=stay
run "$SMOKE_BAD; cutover_gate_against_release '$C/releases/rel-new' && echo \"rc0 [\$CUTOVER_GATE_FAILED] [\$CUTOVER_LAST_FAIL]\""
[[ "$EC" == 0 && "$OUT" == *"rc0 [smoke] [cutover smoke: 用户契约门禁(C1–C3)失败]"* ]] \
  && ok "G3 stay policy: failing gate returns 0 with CUTOVER_GATE_FAILED=smoke + detail" || bad "G3 ec=$EC out=$OUT"
setup g4; policy OC_V5_SELFHOST_ON_GATE_FAIL=stay "OC_V5_SELFHOST_GATE_FAIL_DRILL_SHA=$SHA_A"
run "$SMOKE_OK; cutover_gate_against_release '$C/releases/rel-new' && echo \"rc0 [\$CUTOVER_GATE_FAILED]\""
[[ "$EC" == 0 && "$OUT" == *"rc0 [drill]"* && "$OUT" == *门禁失败演练* ]] && ok "G4 drill on exact sha forces a failure after the real gate passed" || bad "G4 ec=$EC out=$OUT"
setup g5; policy OC_V5_SELFHOST_ON_GATE_FAIL=stay "OC_V5_SELFHOST_GATE_FAIL_DRILL_SHA=$SHA_B"
run "$SMOKE_OK; cutover_gate_against_release '$C/releases/rel-new' && echo \"rc0 [\$CUTOVER_GATE_FAILED]\""
[[ "$EC" == 0 && "$OUT" == *"rc0 []"* ]] && ok "G5 drill bound to another sha is inert" || bad "G5 ec=$EC out=$OUT"
setup g6; policy "OC_V5_SELFHOST_GATE_FAIL_DRILL_SHA=$SHA_A"
run "$SMOKE_OK; cutover_gate_against_release '$C/releases/rel-new'"
[[ "$EC" == 99 ]] && ok "G6 drill under rollback policy fails the gate (compensation runs)" || bad "G6 ec=$EC out=$OUT"
setup g7; policy OC_V5_SELFHOST_ON_GATE_FAIL=stay "OC_V5_SELFHOST_GATE_FAIL_DRILL_SHA=$SHA_A"
run "$SMOKE_BAD; cutover_gate_against_release '$C/releases/rel-new' && echo \"rc0 [\$CUTOVER_GATE_FAILED]\""
[[ "$EC" == 0 && "$OUT" == *"rc0 [smoke]"* ]] && ok "G7 real failure wins over drill label" || bad "G7 ec=$EC out=$OUT"

# ── joint saga:stay 时 saga 不回滚运行面;rollback 时照旧回滚 ──
# 假 saga 复刻 lib 契约:同一 shell eval restart/smoke;smoke 失败 → HOTCFG_SAGA_ROLLING_BACK=1 + 回滚 + 再 smoke。
FAKE_SAGA='oc_hotcfg_activate_saga() {
  eval "$9" || return 1
  if ! eval "${10}"; then echo SAGA_ROLLBACK >>"$C/saga.log"; export HOTCFG_SAGA_ROLLING_BACK=1; eval "${10}"; return 1; fi
  echo SAGA_COMMIT >>"$C/saga.log"; }
egress_then_master_restart_cmd() { printf true; }
cutover_smoke_healthz_only() { echo HEALTHZ_ONLY >>"$C/saga.log"; }
RUNTIME_IMAGE_ID=img BUILT_RUNTIME_RELEASE=r BUILT_BUNDLE_REV=b OC_HOTCFG_HISTORY="$C/hist/h"'
setup j1; policy OC_V5_SELFHOST_ON_GATE_FAIL=stay
run "$FAKE_SAGA; $SMOKE_BAD; activate_tuple_joint '$C/releases/rel-new' none && echo \"rc0 [\$CUTOVER_GATE_FAILED]\""
[[ "$EC" == 0 && "$OUT" == *"rc0 [smoke]"* && "$(cat "$C/saga.log")" == SAGA_COMMIT ]] \
  && ok "J1 stay: saga keeps the new runtime (no rollback) and flags the gate failure" || bad "J1 ec=$EC out=$OUT saga=$(cat "$C/saga.log" 2>/dev/null)"
setup j2
run "$FAKE_SAGA; $SMOKE_BAD; activate_tuple_joint '$C/releases/rel-new' none"
[[ "$EC" != 0 && "$(tr '\n' ' ' <"$C/saga.log")" == "SAGA_ROLLBACK HEALTHZ_ONLY " ]] \
  && ok "J2 rollback: saga rolls back and re-smokes healthz only" || bad "J2 ec=$EC saga=$(cat "$C/saga.log" 2>/dev/null)"

# ── stay 收尾 ──
setup k1; policy OC_V5_SELFHOST_ON_GATE_FAIL=stay
LEASE_ENV='LEASE_TRAIN_ACTIVE=1 LEASE_TRAIN_ID=tr-test MASTER_LIVE_LINK=/nonexistent CUTOVER_SURVIVOR_ARMED=1'
run "$LEASE_ENV; CUTOVER_GATE_FAILED=smoke; CUTOVER_LAST_FAIL='cutover smoke: 用户契约门禁(C1–C3)失败'; t0=\$(date +%s); cutover_keep_failed '$C/releases/rel-new'; echo \"rc=\$? t0=\$t0\""
t0="$(sed -n 's/.*t0=\([0-9]*\).*/\1/p' <<<"$OUT")"
until_ts="$(sed -n 's/^until=//p' "$V5_WATCH_MAINT" 2>/dev/null || true)"
sql="$(cat "$LEASE_SQL_LOG" 2>/dev/null || true)"
calls="$(cat "$C/alert.calls" 2>/dev/null || true)"
if [[ "$OUT" == *"rc=1"* && "$(sed -n 's/^phase=//p' "$SURVIVOR_STATE")" == kept-failed && ! -e "$SURVIVOR_COMMITTED" ]]; then
  ok "K1a survivor phase=kept-failed, no committed marker, cutover returns failure"
else bad "K1a out=$OUT phase=$(cat "$SURVIVOR_STATE")"; fi
grep -q 'stop openclaude-v5-selfhost-cutover-watch.service' "$BASE/systemctl.log" \
  && ok "K1b survivor disarmed via --disarm-kept" || bad "K1b systemctl=$(cat "$BASE/systemctl.log")"
if [[ "$until_ts" =~ ^[0-9]+$ && -n "$t0" ]] && (( until_ts - t0 >= 7190 && until_ts - t0 <= 7210 )) \
  && grep -qx 'source=deploy-gate-fail-stay' "$V5_WATCH_MAINT"; then
  ok "K1c 2h planned-maintenance window written for the watch"
else bad "K1c until=$until_ts t0=$t0 maint=$(cat "$V5_WATCH_MAINT" 2>/dev/null)"; fi
if [[ "$sql" == *"SET status='failed'"* && "$sql" == *"gate-failed-kept-live=$C/releases/rel-new"* \
  && "$sql" == *"rel_path='$C/releases/rel-new'"* && "$sql" == *"EVENT tr-test train-failed deploy:"* ]]; then
  ok "K1d train recorded failed with reason gate-failed-kept-live=<rel> by the deploy executor"
else bad "K1d sql=$sql"; fi
if [[ "$calls" == *"--event deploy_gate_failed_kept --severity critical --live $C/releases/rel-new"* && "$calls" == *"--flush"* ]]; then
  ok "K1e critical deploy_gate_failed_kept alert enqueued and flushed"
else bad "K1e calls=$calls"; fi
[[ ! -s "$C/compensate.log" ]] && ok "K1f no compensation on stay" || bad "K1f $(cat "$C/compensate.log")"

setup k2; printf 'until=%s\nowner=\n' "$(( $(date +%s) + 99999 ))" >"$V5_WATCH_MAINT"; before="$(cat "$V5_WATCH_MAINT")"
run "CUTOVER_GATE_FAILED=smoke; cutover_keep_failed '$C/releases/rel-new'"
[[ "$(cat "$V5_WATCH_MAINT")" == "$before" ]] && ok "K2 a later existing maintenance window is kept" || bad "K2 maint=$(cat "$V5_WATCH_MAINT")"

setup k3; chmod 0644 "$BASE/survivor.sh"
run "CUTOVER_GATE_FAILED=smoke; cutover_keep_failed '$C/releases/rel-new'; echo \"kept=[\$CUTOVER_KEPT_FAILED_REL]\""
chmod 0755 "$BASE/survivor.sh"
if grep -q 'COMPENSATE persist-phase-kept-failed' "$C/compensate.log" && [[ ! -e "$V5_WATCH_MAINT" && "$OUT" == *"kept=[]"* ]]; then
  ok "K3 cannot persist kept-failed → falls back to the original compensation"
else bad "K3 out=$OUT comp=$(cat "$C/compensate.log")"; fi

setup k4; run "LEASE_TRAIN_ACTIVE=1 LEASE_TRAIN_ID=tr-x MASTER_LIVE_LINK=/nonexistent; lease_train_finish failed 'deploy 进程退出 rc=1'"
[[ "$(cat "$LEASE_SQL_LOG")" == *"rel_path=NULL"* ]] && ok "K4 ordinary failure still records no rel_path" || bad "K4 sql=$(cat "$LEASE_SQL_LOG")"

# ── 维护窗口撤销只认本机制写的 ──
setup m1; printf 'until=9999999999\nsource=deploy-gate-fail-stay\n' >"$V5_WATCH_MAINT"; run 'clear_stay_maintenance'
a=$([[ -e "$V5_WATCH_MAINT" ]] && echo kept || echo gone)
printf 'until=9999999999\nowner=123\n' >"$V5_WATCH_MAINT"; run 'clear_stay_maintenance'
b=$([[ -e "$V5_WATCH_MAINT" ]] && echo kept || echo gone)
[[ "$a" == gone && "$b" == kept ]] && ok "M1 committed clears only the stay window, never a human one" || bad "M1 a=$a b=$b"

# ── 发布锁 holder starttime 读的是 deploy 进程本身 ──
setup l1
run 'proc_starttime_of $$; awk "{print \$22}" /proc/$$/stat'
mapfile -t st <<<"$OUT"
[[ "${st[0]}" =~ ^[0-9]+$ && "${st[0]}" == "${st[1]}" ]] && ok "L1 proc_starttime_of reads the given pid" || bad "L1 out=$OUT"
grep -q 'starttime="$(proc_starttime_of "$$")"' "$DEPLOY" && ! grep -v '^[[:space:]]*#' "$DEPLOY" | grep -q 'os.getpid()' \
  && ok "L2 lock holder records the deploy shell's own starttime" || bad "L2 lock holder still reads a child pid"

# ── 接线 ──
cut="$(fn cmd_cutover)"
keep_n="$(grep -c 'cutover_keep_failed "$rel"' <<<"$cut" || true)"
first_keep="$(grep -n 'cutover_keep_failed "$rel"' <<<"$cut" | head -n1 | cut -d: -f1)"
committed_ln="$(grep -n 'cutover_persist_phase "committed"' <<<"$cut" | cut -d: -f1)"
marker_ln="$(grep -n 'persist_selfhost_model_authority_cutover' <<<"$cut" | cut -d: -f1)"
if [[ "$keep_n" == 2 && -n "$first_keep" && -n "$committed_ln" && "$first_keep" -lt "$committed_ln" && "$committed_ln" -lt "$marker_ln" ]] \
  && grep -A2 'cutover_keep_failed "$rel"' <<<"$cut" | grep -q 'return 1'; then
  ok "W1 both smoke paths divert to keep_failed and return before committed / model-authority marker / GC"
else bad "W1 keep=$keep_n first=$first_keep committed=$committed_ln marker=$marker_ln"; fi
grep -q 'else cutover_gate_against_release' "$DEPLOY" && grep -q 'ROLLING_BACK:-}\\" == 1 ]]; then cutover_smoke_healthz_only' "$DEPLOY" \
  && ok "W2 joint forward smoke uses the gate wrapper; saga rollback smoke unchanged" || bad "W2 smoke_cmd wiring"

# ── survivor 自测(含 kept-failed 场景),systemctl 已打桩 ──
set +e; sout="$("$BASE/survivor.sh" --selftest 2>&1)"; sec=$?; set -e
[[ "$sec" == 0 && "$sout" == *SURVIVOR_SELFTEST_ALL_PASS* && "$sout" == *"kept-failed 健康红也不恢复"* ]] \
  && ok "S1 survivor selftest incl. kept-failed" || bad "S1 ec=$sec $(tail -n 5 <<<"$sout")"

echo "gate-fail-stay: pass=$pass fail=$fail"
[[ "$fail" == 0 ]]
