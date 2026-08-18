#!/usr/bin/env bash
# 首次 cutover 窗口专用宿主侧 survivor。不依赖 selfhost 网关、不依赖调用连接。
# 由 systemd-run 拉起,与会话/gateway 脱钩。shell trap 挡不住 SIGKILL,这个可以。
# 成功提交后必须 --disarm。长期看护仍保持 dry/disabled,本脚本只覆盖本次窗口。
set -euo pipefail

SURVIVOR_STATE="${SURVIVOR_STATE:-/run/openclaude-v5-selfhost/cutover-survivor.state}"
SURVIVOR_COMMITTED="${SURVIVOR_COMMITTED:-/run/openclaude-v5-selfhost/cutover-survivor.committed}"
SURVIVOR_RESTORE="${SURVIVOR_RESTORE:-/opt/openclaude/v5-selfhost-breakglass/restore-worktree-units.sh}"
SURVIVOR_POLL_SEC="${SURVIVOR_POLL_SEC:-2}"
SURVIVOR_MAX_LOOPS="${SURVIVOR_MAX_LOOPS:-900}"
SURVIVOR_HEALTH_CMD="${SURVIVOR_HEALTH_CMD:-}"
SURVIVOR_RESTORE_CMD="${SURVIVOR_RESTORE_CMD:-}"
SURVIVOR_MASTER_URL="${SURVIVOR_MASTER_URL:-http://127.0.0.1:18790/healthz}"
SURVIVOR_EGRESS_URL="${SURVIVOR_EGRESS_URL:-http://172.31.0.1:18892/internal/v5/egress-health}"
SURVIVOR_MASTER_UNIT="${SURVIVOR_MASTER_UNIT:-openclaude-v5-selfhost.service}"
SURVIVOR_EGRESS_UNIT="${SURVIVOR_EGRESS_UNIT:-openclaude-v5-selfhost-egress.service}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) survivor: $*"; }

parse_state() {
  local key="$1"
  [[ -f "$SURVIVOR_STATE" && ! -L "$SURVIVOR_STATE" ]] || return 1
  awk -F= -v k="$key" '$1==k {print substr($0, index($0,"=")+1); exit}' "$SURVIVOR_STATE"
}

pid_alive() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -d "/proc/${pid}" ]]
}

compound_health_green() {
  if [[ -n "$SURVIVOR_HEALTH_CMD" ]]; then
    # shellcheck disable=SC2086
    eval "$SURVIVOR_HEALTH_CMD"
    return
  fi
  local st
  st="$(systemctl is-active "$SURVIVOR_MASTER_UNIT" 2>/dev/null || true)"
  [[ "$st" == "active" ]] || return 1
  st="$(systemctl is-active "$SURVIVOR_EGRESS_UNIT" 2>/dev/null || true)"
  [[ "$st" == "active" ]] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1
  local hz eg
  hz="$(curl -fsS --max-time 5 "$SURVIVOR_MASTER_URL" 2>/dev/null || true)"
  echo "$hz" | jq -e '.ok==true and .runtime.controlPlaneEnabled==true and .runtime.leadership.state=="leader"' >/dev/null 2>&1 \
    || return 1
  eg="$(curl -fsS --max-time 5 "$SURVIVOR_EGRESS_URL" 2>/dev/null || true)"
  echo "$eg" | jq -e '.ok==true' >/dev/null 2>&1
}

do_restore() {
  log "执行首次二级恢复"
  if [[ -n "$SURVIVOR_RESTORE_CMD" ]]; then
    # shellcheck disable=SC2086
    eval "$SURVIVOR_RESTORE_CMD"
    return
  fi
  bash "$SURVIVOR_RESTORE"
}

maybe_restore() {
  if [[ -f "$SURVIVOR_COMMITTED" ]]; then
    log "已 committed,不恢复"
    return 0
  fi
  if compound_health_green; then
    log "复合健康绿,不恢复"
    return 0
  fi
  do_restore
}

watch_loop() {
  local i pid
  for ((i = 0; i < SURVIVOR_MAX_LOOPS; i++)); do
    if [[ -f "$SURVIVOR_COMMITTED" ]]; then
      log "committed,解除监视"
      exit 0
    fi
    pid="$(parse_state executor_pid || true)"
    if pid_alive "$pid"; then
      sleep "$SURVIVOR_POLL_SEC"
      continue
    fi
    log "executor pid=${pid:-?} 已消失"
    maybe_restore
    exit $?
  done
  log "监视超时"
  maybe_restore
}

write_state() {
  local pid="$1" backup="$2" phase="${3:-armed}"
  mkdir -p -- "$(dirname -- "$SURVIVOR_STATE")"
  printf 'phase=%s\nexecutor_pid=%s\nbackup_dir=%s\narmed_at=%s\n' \
    "$phase" "$pid" "$backup" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"$SURVIVOR_STATE"
}

arm_via_systemd() { # <executor-pid> <backup-dir>
  local pid="$1" backup="$2" timeout_s="${SURVIVOR_TIMEOUT_SEC:-1200}"
  write_state "$pid" "$backup" armed
  rm -f -- "$SURVIVOR_COMMITTED"
  systemd-run --unit=openclaude-v5-selfhost-cutover-watch \
    --collect \
    --property=Description='v5-selfhost cutover window watch survivor' \
    --property=Restart=no \
    --setenv=SURVIVOR_STATE="$SURVIVOR_STATE" \
    --setenv=SURVIVOR_COMMITTED="$SURVIVOR_COMMITTED" \
    --setenv=SURVIVOR_RESTORE="$SURVIVOR_RESTORE" \
    /opt/openclaude/v5-selfhost-breakglass/cutover-survivor.sh --watch
  systemd-run --unit=openclaude-v5-selfhost-cutover-timeout \
    --on-active="${timeout_s}s" \
    --collect \
    --property=Description='v5-selfhost cutover window timeout survivor' \
    --setenv=SURVIVOR_STATE="$SURVIVOR_STATE" \
    --setenv=SURVIVOR_COMMITTED="$SURVIVOR_COMMITTED" \
    --setenv=SURVIVOR_RESTORE="$SURVIVOR_RESTORE" \
    /opt/openclaude/v5-selfhost-breakglass/cutover-survivor.sh --recover
  log "已武装 watch + timeout=${timeout_s}s backup=$backup executor=$pid"
}

disarm() {
  mkdir -p -- "$(dirname -- "$SURVIVOR_COMMITTED")"
  printf 'committed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$SURVIVOR_COMMITTED"
  systemctl stop openclaude-v5-selfhost-cutover-watch.service 2>/dev/null || true
  systemctl stop openclaude-v5-selfhost-cutover-timeout.timer 2>/dev/null || true
  systemctl stop openclaude-v5-selfhost-cutover-timeout.service 2>/dev/null || true
  log "已解除武装"
}

selftest() {
  local base pid
  base="$(mktemp -d /tmp/v5-selfhost-survivor-selftest.XXXXXX)"
  echo "SURVIVOR_SELFTEST_DIR=$base"
  export SURVIVOR_STATE="$base/state"
  export SURVIVOR_COMMITTED="$base/committed"
  export SURVIVOR_POLL_SEC=1
  export SURVIVOR_MAX_LOOPS=30
  export SURVIVOR_HEALTH_CMD='false'
  export SURVIVOR_RESTORE_CMD="printf RESTORED\\\\n >>'$base/restored'"

  echo "===== survivor 场景: 假 executor 被 kill 且健康未绿 → 必须恢复 ====="
  sleep 120 &
  pid=$!
  write_state "$pid" "$base/backup" armed
  "$0" --watch >"$base/watch.log" 2>&1 &
  local watch_pid=$!
  sleep 1
  kill -9 "$pid" || true
  wait "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    if [[ -f "$base/restored" ]]; then
      break
    fi
    sleep 1
  done
  wait "$watch_pid" 2>/dev/null || true
  if [[ ! -f "$base/restored" ]]; then
    echo "FAIL survivor 未执行恢复"
    echo "watch.log:"
    cat "$base/watch.log" || true
    return 1
  fi
  grep -q RESTORED "$base/restored"
  echo "PASS survivor: executor 被 SIGKILL 且健康未绿 → 已恢复"
  echo "restored=$(cat "$base/restored")"

  echo "===== survivor 场景: 已 committed 则不恢复 ====="
  rm -f -- "$base/restored" "$base/committed"
  sleep 120 &
  pid=$!
  write_state "$pid" "$base/backup" armed
  printf 'committed_at=test\n' >"$SURVIVOR_COMMITTED"
  kill -9 "$pid" || true
  wait "$pid" 2>/dev/null || true
  "$0" --watch >"$base/watch2.log" 2>&1 || true
  if [[ -f "$base/restored" ]]; then
    echo "FAIL committed 后仍恢复"
    return 1
  fi
  echo "PASS survivor: committed 后不恢复"

  echo "===== survivor 场景: executor 消失但健康绿 → 不恢复 ====="
  rm -f -- "$base/restored" "$base/committed"
  export SURVIVOR_HEALTH_CMD='true'
  sleep 120 &
  pid=$!
  write_state "$pid" "$base/backup" armed
  kill -9 "$pid" || true
  wait "$pid" 2>/dev/null || true
  "$0" --watch >"$base/watch3.log" 2>&1 || true
  if [[ -f "$base/restored" ]]; then
    echo "FAIL 健康绿仍恢复"
    return 1
  fi
  echo "PASS survivor: 健康绿不恢复"
  echo "SURVIVOR_SELFTEST_ALL_PASS"
}

usage() {
  cat <<'EOF'
用法: cutover-survivor.sh --watch|--recover|--arm PID BACKUP|--disarm|--selftest
  --watch     监视 executor;非正常消失且健康未绿 → 二级恢复
  --recover   超时/OnFailure 入口:未 committed 且健康未绿 → 二级恢复
  --arm       写 state 并用 systemd-run 武装 watch+timeout(仅 cutover 真窗口)
  --disarm    写 committed 并停 transient unit
  --selftest  假 phase + 故意 kill 模拟 executor,不碰真 unit
EOF
}

case "${1:-}" in
  --watch) watch_loop ;;
  --recover) maybe_restore ;;
  --arm)
    [[ $# -ge 3 ]] || { usage >&2; exit 2; }
    arm_via_systemd "$2" "$3"
    ;;
  --disarm) disarm ;;
  --selftest) selftest ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
