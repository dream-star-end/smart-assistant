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

# 原子落盘:写临时文件 → fsync → rename → fsync 目录。executor 被杀后仍可读。
# 用 python3 -c 而不是 python3 -,这样 stdin 仍可接收要写入的内容。
atomic_write_file() {
  local dest="$1"
  python3 -c '
import os, sys
dest = sys.argv[1]
data = sys.stdin.buffer.read()
if not data:
    raise SystemExit("atomic_write_file: empty")
parent = os.path.dirname(dest) or "."
os.makedirs(parent, exist_ok=True)
tmp = "%s.tmp.%d" % (dest, os.getpid())
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
fd = -1
try:
    fd = os.open(tmp, flags, 0o644)
    written = 0
    while written < len(data):
        n = os.write(fd, data[written:])
        if n <= 0:
            raise OSError("short write")
        written += n
    os.fsync(fd)
finally:
    if fd >= 0:
        os.close(fd)
try:
    os.replace(tmp, dest)
except Exception as exc:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise SystemExit("atomic_write_file: %s" % exc)
dirfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(dirfd)
finally:
    os.close(dirfd)
' "$dest"
}

phase_is_legal() {
  [[ "$1" =~ ^[a-z0-9-]+$ ]]
}

# 已动过 installed unit、但尚未 smoked / durable committed 的中间态。
# executor 消失时即使旧进程健康绿也必须二级恢复。
phase_is_uncommitted_mutation() {
  case "$1" in
    mutated|units-partial|units-installed|reloaded|grace|migrated|symlink-flipped|restarted)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# 健康绿可以「不恢复」的 phase:尚未动 unit,或已 smoked/committed。
phase_health_may_skip_restore() {
  case "$1" in
    ''|armed|pre-install|pre-mutation|smoked|committed)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

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

write_state() {
  local pid="$1" backup="$2" phase="${3:-armed}" armed_at="${4:-}"
  phase_is_legal "$phase" || { log "拒绝写入非法 phase=$phase"; return 1; }
  mkdir -p -- "$(dirname -- "$SURVIVOR_STATE")"
  if [[ -z "$armed_at" ]]; then
    armed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  printf 'phase=%s\nexecutor_pid=%s\nbackup_dir=%s\narmed_at=%s\n' \
    "$phase" "$pid" "$backup" "$armed_at" \
    | atomic_write_file "$SURVIVOR_STATE"
}

set_phase() {
  local phase="$1" pid backup armed_at
  phase_is_legal "$phase" || { log "拒绝写入非法 phase=$phase"; return 1; }
  [[ -f "$SURVIVOR_STATE" && ! -L "$SURVIVOR_STATE" ]] || {
    log "无 state 文件,无法持久化 phase=$phase"
    return 1
  }
  pid="$(parse_state executor_pid || true)"
  backup="$(parse_state backup_dir || true)"
  armed_at="$(parse_state armed_at || true)"
  write_state "$pid" "$backup" "$phase" "$armed_at"
  [[ "$(parse_state phase || true)" == "$phase" ]] || {
    log "phase 落盘后读回不匹配 want=$phase"
    return 1
  }
  log "phase 已落盘 $phase"
}

write_committed_marker() {
  mkdir -p -- "$(dirname -- "$SURVIVOR_COMMITTED")" || return 1
  printf 'committed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    | atomic_write_file "$SURVIVOR_COMMITTED" || return 1
  [[ -f "$SURVIVOR_COMMITTED" && ! -L "$SURVIVOR_COMMITTED" ]] || return 1
  grep -q '^committed_at=' "$SURVIVOR_COMMITTED" || return 1
}

do_restore() {
  local backup
  log "执行首次二级恢复"
  if [[ -n "$SURVIVOR_RESTORE_CMD" ]]; then
    # shellcheck disable=SC2086
    eval "$SURVIVOR_RESTORE_CMD"
    return
  fi
  backup="$(parse_state backup_dir || true)"
  if [[ -n "$backup" ]]; then
    log "restore --backup-dir=$backup"
    bash "$SURVIVOR_RESTORE" --backup-dir "$backup"
    return
  fi
  log "state 无 backup_dir,走 restore 默认路径"
  bash "$SURVIVOR_RESTORE"
}

maybe_restore() {
  local phase
  if [[ -f "$SURVIVOR_COMMITTED" ]]; then
    log "已 committed,不恢复"
    return 0
  fi
  phase="$(parse_state phase || true)"
  if phase_is_uncommitted_mutation "$phase"; then
    log "phase=${phase} 尚未 smoked/committed,executor 已消失,无视健康直接二级恢复"
    do_restore
    return
  fi
  if ! phase_health_may_skip_restore "$phase"; then
    log "未知 phase=${phase:-none},fail-closed 二级恢复"
    do_restore
    return
  fi
  if compound_health_green; then
    log "phase=${phase:-none} 复合健康绿,不恢复"
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
  if ! write_committed_marker; then
    log "committed marker 写入失败,拒绝报告已解除武装"
    return 1
  fi
  if [[ -f "$SURVIVOR_STATE" && ! -L "$SURVIVOR_STATE" ]]; then
    set_phase committed || log "committed marker 已写入,phase 更新失败(marker 仍为权威)"
  fi
  systemctl stop openclaude-v5-selfhost-cutover-watch.service 2>/dev/null || true
  systemctl stop openclaude-v5-selfhost-cutover-timeout.timer 2>/dev/null || true
  systemctl stop openclaude-v5-selfhost-cutover-timeout.service 2>/dev/null || true
  log "已解除武装"
}

selftest() {
  local base pid watch_pid i rc
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
  watch_pid=$!
  sleep 1
  kill -9 "$pid" || true
  wait "$pid" 2>/dev/null || true
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

  echo "===== survivor 场景: 尚未 mutation 时健康绿 → 不恢复 ====="
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
  echo "PASS survivor: 尚未 mutation 时不恢复"

  echo "===== survivor 场景: 健康绿且已 committed 不恢复 ====="
  rm -f -- "$base/restored"
  printf 'committed_at=test\n' >"$SURVIVOR_COMMITTED"
  write_state 999999999 "$base/backup" smoked
  "$0" --watch >"$base/watch-committed-green.log" 2>&1 || true
  if [[ -f "$base/restored" ]]; then
    echo "FAIL 健康绿且已 committed 仍恢复"
    return 1
  fi
  echo "PASS survivor: 健康绿且已 committed 不恢复"

  echo "===== survivor 场景: phase=smoked + 健康绿 → 不恢复 ====="
  rm -f -- "$base/restored" "$base/committed"
  write_state 999999999 "$base/backup" smoked
  "$0" --watch >"$base/watch-smoked.log" 2>&1 || true
  if [[ -f "$base/restored" ]]; then
    echo "FAIL smoked 后健康绿仍恢复"
    return 1
  fi
  grep -q '复合健康绿,不恢复' "$base/watch-smoked.log"
  echo "PASS survivor: smoked 后健康绿不恢复"

  echo "===== survivor 场景: phase=units-installed + executor 消失 + 健康绿 → 必须恢复 ====="
  rm -f -- "$base/restored" "$base/committed"
  export SURVIVOR_HEALTH_CMD='true'
  write_state 999999999 "$base/backup" units-installed
  rc=0
  "$0" --watch >"$base/watch-b2.log" 2>&1 || rc=$?
  echo "B2_REPRO_RC=$rc"
  echo "B2_REPRO_LOG:"
  cat "$base/watch-b2.log"
  if [[ ! -f "$base/restored" ]]; then
    echo "FAIL units-installed + 健康绿 未恢复"
    return 1
  fi
  grep -q RESTORED "$base/restored"
  grep -q '无视健康直接二级恢复' "$base/watch-b2.log"
  echo "restored=yes"
  echo "PASS survivor: units-installed + 健康绿 → 已恢复"

  echo "===== survivor 场景: --disarm 写 committed marker 失败必须非 0 ====="
  rm -f -- "$base/restored"
  # 把 committed 路径变成目录,atomic write 无法写成普通文件。
  rm -f -- "$base/committed"
  mkdir -p -- "$base/committed"
  rc=0
  "$0" --disarm >"$base/disarm-fail.log" 2>&1 || rc=$?
  echo "DISARM_FAIL_RC=$rc"
  echo "DISARM_FAIL_LOG:"
  cat "$base/disarm-fail.log"
  if [[ "$rc" -eq 0 ]]; then
    echo "FAIL --disarm 在 marker 写失败时仍返回 0"
    return 1
  fi
  grep -q 'committed marker 写入失败' "$base/disarm-fail.log"
  echo "PASS survivor: --disarm 写失败可被 cutover 察觉 rc=$rc"
  rmdir -- "$base/committed" 2>/dev/null || rm -rf -- "$base/committed"

  echo "SURVIVOR_SELFTEST_ALL_PASS"
}

usage() {
  cat <<'EOF'
用法: cutover-survivor.sh --watch|--recover|--arm PID BACKUP|--disarm|--selftest|--set-phase PHASE
  --watch      监视 executor;消失后按 phase 决定是否二级恢复
  --recover    超时/OnFailure 入口:与 --watch 相同的 phase-aware 恢复判定
  --arm        写 state 并用 systemd-run 武装 watch+timeout(仅 cutover 真窗口)
  --disarm     原子 fsync 写 committed marker;写失败必须非 0
  --set-phase  把已武装 state 的 phase 原子落盘(覆盖第一个 unit 前必须先写 mutated)
  --selftest   假 phase + 故意 kill 模拟 executor,不碰真 unit
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
  --set-phase)
    [[ $# -ge 2 ]] || { usage >&2; exit 2; }
    set_phase "$2"
    ;;
  --selftest) selftest ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
