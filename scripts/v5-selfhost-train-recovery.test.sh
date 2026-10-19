#!/usr/bin/env bash
# OCV5-420 列车终态测试:本班已动 unit 却在中途退出、或补偿本身失败时,deploy 必须把列车记
# recovery_required(暂停发车、需人工 train resolve),并且 worker 不得把现网当 committed 去结算搭车。
# 从 deploy-v5-selfhost.sh / v5-lease-lib.sh 抽函数在临时目录执行;survivor 用仓库真脚本,
# systemctl / alert.sh / 写库全部打桩,不碰宿主状态。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="${DEPLOY_SCRIPT:-$DIR/deploy-v5-selfhost.sh}"
LEASE_LIB="${LEASE_LIB_SCRIPT:-$DIR/v5-lease-lib.sh}"
SURVIVOR_SRC="${SURVIVOR_SCRIPT:-$DIR/v5-selfhost-cutover-survivor.sh}"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

fn_of() { awk -v n="$2() {" 'index($0, n) == 1 {f=1} f {print} f && /^}/ {exit}' "$1"; }
BASE="$(mktemp -d "${TMPDIR:-/tmp}/v5-train-recovery.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

mkdir -p "$BASE/bin"
printf '#!/bin/sh\nexit 0\n' >"$BASE/bin/systemctl"
chmod 0755 "$BASE/bin/systemctl"
install -m 0755 "$SURVIVOR_SRC" "$BASE/survivor.sh"

{
  # Load the production libraries before the existing observation-only stubs.
  # This includes actual owner guards, terminal functions and JSON merge SQL.
  printf 'SCRIPT_DIR=%q\n' "$DIR"
  printf 'source %q\n' "$DIR/v5-lease-lib.sh"
  printf 'source %q\n' "$DIR/lib/v5-selfhost-release-policy.sh"
  echo 'log() { echo "$*"; }'
  echo 'die() { echo "DIE $*"; exit 1; }'
  echo 'lease_now() { echo 2026-10-14T00:00:00Z; }'
  echo "lease_q() { printf '%s' \"\${1//\\'/\\'\\'}\"; }"
  echo 'lease_event_sql() { echo "EVENT $1 $2 $3"; }'
  echo 'lease_tx() { cat >>"$LEASE_SQL_LOG"; }'
  echo 'lease_sql() { printf "%s\n" "${FAKE_RIDE_TICKET:-}"; }'
  echo 'lease_body_train_alert() { echo "BODY $1 $2 $3"; }'
  echo 'lease_outbox_sql() { echo "OUTBOX key=$1 subject=$2 kind=$3 target_kind=$4 target=$5 body=$6"; }'
  for f in cutover_clog cutover_survivor_script cutover_persist_phase cutover_disarm_survivor cutover_compensate \
    deploy_alert; do
    body="$(fn_of "$DEPLOY" "$f")"
    [[ -n "$body" ]] || { echo "missing function $f" >&2; exit 1; }
    printf '%s\n' "$body"
  done
} >"$BASE/fns.sh"

setup() {
  C="$BASE/$1"
  mkdir -p "$C/watch" "$C/run" "$C/rel"
  export C PATH="$BASE/bin:$PATH"
  export OC_V5_RELEASE_POLICY_CONTEXT="$C/run/release-policy/unresolved.json"
  export OC_V5_LEASE_DB="$C/run/lease.db"
  export CUTOVER_LOG="$C/cutover.log" LEASE_SQL_LOG="$C/lease.sql"
  export SURVIVOR_STATE="$C/run/survivor.state" SURVIVOR_COMMITTED="$C/run/survivor.committed"
  export CUTOVER_SURVIVOR_SCRIPT="$BASE/survivor.sh" V5_WATCH_DIR="$C/watch"
  export MASTER_LIVE_LINK="$C/live" LEASE_LIVE_LINK="$C/live"
  export LEASE_SURVIVOR_STATE="$SURVIVOR_STATE"
  export OC_V5_LEASE_LIVE_LINK="$C/live"
  export OC_V5_LEASE_SURVIVOR_STATE="$SURVIVOR_STATE"
  export OC_V5_LEASE_SURVIVOR_COMMITTED="$SURVIVOR_COMMITTED"
  unset FAKE_RIDE_TICKET
  printf '{"sourceCommit":"%s"}\n' "$(printf 'c%.0s' {1..40})" >"$C/rel/.complete"
  ln -sfn "$C/rel" "$C/live"
  printf '#!/bin/sh\necho "$*" >>"%s/alert.calls"\n' "$C" >"$C/watch/alert.sh"
  chmod 0755 "$C/watch/alert.sh"
}
state() { printf 'phase=%s\nexecutor_pid=999999999\nbackup_dir=%s/backup\narmed_at=x\n' "$1" "$C" >"$SURVIVOR_STATE"; }
run() { set +e; OUT="$(bash -c ". '$BASE/fns.sh'; $*" 2>&1)"; EC=$?; set -e; }
FIN='LEASE_TRAIN_ACTIVE=1 LEASE_TRAIN_ID=tr-test; lease_train_finish failed "deploy 进程退出 rc=143 未到 committed"'
st_of() { sed -n "s/.*SET status='\([a-z_]*\)'.*/\1/p" "$LEASE_SQL_LOG" | head -n1; }

# ── 终态判定 ──
setup r1; state symlink-flipped; FAKE_RIDE_TICKET=OCV5-999 run "CUTOVER_MUTATED=1; $FIN"
sql="$(cat "$LEASE_SQL_LOG")"; calls="$(cat "$C/alert.calls" 2>/dev/null || true)"
if [[ "$(st_of)" == recovery_required ]]; then ok "R1a interrupted mid-mutation (KEY=VALUE phase=symlink-flipped) → recovery_required"
else bad "R1a st=$(st_of) out=$OUT"; fi
if [[ "$sql" == *"OUTBOX key=train:tr-test:recovery_required subject=tr-test kind=train_alert target_kind=ticket target=OCV5-999"* \
  && "$sql" == *"BODY tr-test recovery_required"* && "$sql" == *"phase=symlink-flipped"* ]] \
  && [[ "$(grep -n OUTBOX "$LEASE_SQL_LOG" | cut -d: -f1)" -lt "$(grep -n '^COMMIT;' "$LEASE_SQL_LOG" | cut -d: -f1)" ]]; then
  ok "R1b train_alert outbox written in the same transaction, to the open ride's ticket"
else bad "R1b sql=$sql"; fi
[[ "$calls" == *"--event deploy_recovery_required --severity critical"* && "$calls" == *"--flush"* ]] \
  && ok "R1c critical deploy_recovery_required watch alert" || bad "R1c calls=$calls"

setup r2; state symlink-flipped; run "CUTOVER_MUTATED=1; $FIN"
[[ "$(cat "$LEASE_SQL_LOG")" == *"target_kind=log target=-"* ]] && ok "R2 no open ride → alert goes to log" || bad "R2 sql=$(cat "$LEASE_SQL_LOG")"

setup r3; state committed; run "CUTOVER_MUTATED=1; $FIN"
if [[ "$(st_of)" == failed && "$(cat "$LEASE_SQL_LOG")" != *OUTBOX* && ! -e "$C/alert.calls" ]]; then
  ok "R3 clean compensation (survivor disarmed → committed) stays failed, no alert"
else bad "R3 st=$(st_of)"; fi

setup r4; state symlink-flipped; run "CUTOVER_MUTATED=0; $FIN"
[[ "$(st_of)" == failed ]] && ok "R4 stale phase from an earlier train is ignored when this run never touched units" || bad "R4 st=$(st_of)"

setup r5; state kept-failed; run "CUTOVER_MUTATED=1; $FIN"
[[ "$(st_of)" == failed ]] && ok "R5 kept-failed (OCV5-418 stay) stays failed" || bad "R5 st=$(st_of)"

setup r6; printf '{"phase":"restarted"}\n' >"$SURVIVOR_STATE"; run "CUTOVER_MUTATED=1; $FIN"
[[ "$(st_of)" == recovery_required ]] && ok "R6 legacy JSON state still read" || bad "R6 st=$(st_of)"

setup r7; state committed; run "CUTOVER_MUTATED=1 CUTOVER_RECOVERY_REQUIRED=1; $FIN"
[[ "$(st_of)" == recovery_required ]] && ok "R7 failed compensation flag wins over phase=committed" || bad "R7 st=$(st_of)"

setup r8; rm -f "$SURVIVOR_STATE"; run "CUTOVER_MUTATED=1; $FIN"
[[ "$(st_of)" == recovery_required ]] && ok "R8 mutated but state unreadable → recovery_required (fail-closed)" || bad "R8 st=$(st_of)"

setup r9; state symlink-flipped; run "LEASE_TRAIN_ACTIVE=1 LEASE_TRAIN_ID=tr-ok; lease_train_finish committed done"
[[ "$(st_of)" == committed && ! -e "$C/alert.calls" ]] && ok "R9 committed path unchanged" || bad "R9 st=$(st_of)"

# ── 补偿失败 ──
COMP='CUTOVER_SURVIVOR_ARMED=1 CUTOVER_MUTATED=1 CUTOVER_REL=x CUTOVER_BACKUP=y'
setup c1; state symlink-flipped
run "$COMP; cutover_rollback_inplace() { return 1; }; cutover_compensate smoke; echo \"rc=\$? flag=\$CUTOVER_RECOVERY_REQUIRED\""
if [[ "$OUT" == *"rc=1 flag=1"* && "$(sed -n 's/^phase=//p' "$SURVIVOR_STATE")" == compensate-failed && -e "$SURVIVOR_COMMITTED" ]]; then
  ok "C1 failed rollback → flag set, survivor disarmed, phase=compensate-failed"
else bad "C1 out=$OUT phase=$(cat "$SURVIVOR_STATE")"; fi
run 'lease_live_committed_sha'
[[ "$EC" != 0 && -z "$OUT" ]] && ok "C2 worker does not treat live as committed after a failed rollback (no ride settle)" || bad "C2 ec=$EC out=$OUT"

setup c3; state symlink-flipped
run "$COMP; cutover_rollback_inplace() { return 0; }; cutover_compensate smoke; echo \"rc=\$? flag=\${CUTOVER_RECOVERY_REQUIRED:-0}\""
if [[ "$OUT" == *"rc=1 flag=0"* && "$(sed -n 's/^phase=//p' "$SURVIVOR_STATE")" == committed ]]; then
  ok "C3 successful rollback keeps the old outcome (phase=committed, plain failed)"
else bad "C3 out=$OUT phase=$(cat "$SURVIVOR_STATE")"; fi
run 'lease_live_committed_sha'
[[ "$EC" == 0 && "$OUT" == "$(printf 'c%.0s' {1..40})" ]] && ok "C4 after a clean rollback the worker still settles normally" || bad "C4 ec=$EC out=$OUT"

# ── survivor 不因 compensate-failed 去二次恢复(committed marker 在)──
setup s1; state compensate-failed; printf 'committed_at=x\n' >"$SURVIVOR_COMMITTED"
set +e; sout="$(SURVIVOR_HEALTH_CMD=false SURVIVOR_LIVE_WD_CMD=false SURVIVOR_RESTORE_CMD="touch '$C/restored'" "$BASE/survivor.sh" --recover 2>&1)"; set -e
[[ ! -e "$C/restored" ]] && ok "S1 survivor does not re-restore after compensate-failed (marker present)" || bad "S1 $sout"

echo "train-recovery: pass=$pass fail=$fail"
[[ "$fail" == 0 ]]
