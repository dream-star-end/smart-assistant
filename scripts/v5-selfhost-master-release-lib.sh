#!/usr/bin/env bash
# v5-selfhost-master-release-lib.sh — 阶段 1:只建不可变 master release,不切 live。
# 由 deploy-v5-selfhost.sh source。禁止在已有 rel-* 里 npm ci;半成品永不叫 rel-*。
# 日志一律 stderr,避免将来落入命令替换。

# 独立于 runtime-releases。不要跟 /var/lib/openclaude-v5-selfhost/runtime-releases 混用。
MASTER_RELEASES_ROOT="${MASTER_RELEASES_ROOT:-/opt/openclaude/openclaude-v5-selfhost-releases}"
MASTER_LIVE_LINK="${MASTER_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}"
MASTER_RELEASE_COMPLETE_SCHEMA_VERSION=2
# 内部变量无条件清空,不继承环境。继承的 MASTER_STAGING 曾让 --status 的 EXIT
# 无边界 rm -rf 任意目录(含 git 工作树 / 仍被 bind 的 release)。
MASTER_STAGING=""
MASTER_STAGING_DEV=""
MASTER_STAGING_INO=""
# 发布门的私有 TMPDIR(tsx 编译缓存落在里面)。同样不继承环境,理由同 MASTER_STAGING。
MASTER_GATE_TMPDIR=""
MASTER_GATE_TMP_PREFIX="${MASTER_GATE_TMP_PREFIX:-/tmp/oc-selfhost-gate-tmp}"
BUILT_MASTER_RELEASE="${BUILT_MASTER_RELEASE:-}"
MASTER_DEPS_MODE="${MASTER_DEPS_MODE:-}"
MASTER_DEPS_ELAPSED_S="${MASTER_DEPS_ELAPSED_S:-}"
MASTER_FRONTEND_ELAPSED_S="${MASTER_FRONTEND_ELAPSED_S:-}"
BREAKGLASS_ROOT="${BREAKGLASS_ROOT:-/opt/openclaude/v5-selfhost-breakglass}"
CUTOVER_GRACE_FILE="${CUTOVER_GRACE_FILE:-/run/openclaude-v5-selfhost/cutover-grace-until}"
CUTOVER_GRACE_SEC="${CUTOVER_GRACE_SEC:-90}"
CUTOVER_HAS_MIGRATION="${CUTOVER_HAS_MIGRATION:-0}"
CUTOVER_MIGRATION_FILES="${CUTOVER_MIGRATION_FILES:-}"
CUTOVER_UNIT_SNAP="${CUTOVER_UNIT_SNAP:-}"
SURVIVOR_STATE="${SURVIVOR_STATE:-/run/openclaude-v5-selfhost/cutover-survivor.state}"
SURVIVOR_COMMITTED="${SURVIVOR_COMMITTED:-/run/openclaude-v5-selfhost/cutover-survivor.committed}"

source "$(dirname "${BASH_SOURCE[0]}")/lib/v5-selfhost-host-log-policy.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/v5-selfhost-cutover-units.sh"

mlog() { echo "$*" >&2; }

# 只允许删除「本进程创建、仍是同一 inode」的 ${MASTER_RELEASES_ROOT}/.staging-*。
# 任何规范化失败 / 越界 / inode 漂移 → 拒绝 rm。
cleanup_master_staging() {
  local candidate canon root_canon parent parent_dev root_dev st_dev st_ino
  local live_canon worktree_canon
  # 门的临时测试库、临时目录跟 staging 同生命周期:所有失败路径(含 EXIT trap)都经过这里。
  # 测试库要用 staging 里的 node_modules/pg 删,所以排在删 staging 之前。
  master_gate_db_drop
  cleanup_master_gate_tmpdir
  candidate="${MASTER_STAGING:-}"
  MASTER_STAGING=""
  if [[ -z "$candidate" ]]; then
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  if [[ ! -d "$candidate" ]]; then
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  canon="$(readlink -f -- "$candidate" 2>/dev/null || true)"
  root_canon="$(readlink -f -- "$MASTER_RELEASES_ROOT" 2>/dev/null || true)"
  if [[ -z "$canon" || -z "$root_canon" || ! -d "$canon" || ! -d "$root_canon" ]]; then
    mlog "cleanup: 无法规范化 staging/releases root,拒绝 rm candidate=$candidate"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  case "$canon" in
    "${root_canon}"/.staging-*) ;;
    *)
      mlog "cleanup: 拒绝 rm 非 ${root_canon}/.staging-* 路径: $canon"
      MASTER_STAGING_DEV=""
      MASTER_STAGING_INO=""
      return 0
      ;;
  esac
  if [[ "$canon" == "$root_canon" ]]; then
    mlog "cleanup: 拒绝 rm releases root"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  live_canon="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
  worktree_canon="$(readlink -f -- "${REPO_ROOT:-}" 2>/dev/null || true)"
  if [[ -n "$live_canon" && "$canon" == "$live_canon" ]]; then
    mlog "cleanup: 拒绝 rm live 目标 $canon"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  if [[ -n "$worktree_canon" && "$canon" == "$worktree_canon" ]]; then
    mlog "cleanup: 拒绝 rm 工作树 $canon"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  parent="$(dirname -- "$canon")"
  if [[ "$parent" != "$root_canon" ]]; then
    mlog "cleanup: parent=$parent 不是 releases root,拒绝 rm"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  parent_dev="$(stat -c '%d' -- "$parent" 2>/dev/null || true)"
  root_dev="$(stat -c '%d' -- "$root_canon" 2>/dev/null || true)"
  if [[ -z "$parent_dev" || "$parent_dev" != "$root_dev" ]]; then
    mlog "cleanup: parent/dev 与 releases root 不一致,拒绝 rm"
    MASTER_STAGING_DEV=""
    MASTER_STAGING_INO=""
    return 0
  fi
  st_dev="$(stat -c '%d' -- "$canon" 2>/dev/null || true)"
  st_ino="$(stat -c '%i' -- "$canon" 2>/dev/null || true)"
  if [[ -n "${MASTER_STAGING_DEV:-}" && -n "${MASTER_STAGING_INO:-}" ]]; then
    if [[ "$st_dev" != "$MASTER_STAGING_DEV" || "$st_ino" != "$MASTER_STAGING_INO" ]]; then
      mlog "cleanup: inode/dev 与创建时不一致,拒绝 rm (now=$st_dev:$st_ino want=$MASTER_STAGING_DEV:$MASTER_STAGING_INO)"
      MASTER_STAGING_DEV=""
      MASTER_STAGING_INO=""
      return 0
    fi
  fi
  mlog "  清理未完成的 staging: $canon"
  rm -rf -- "$canon"
  MASTER_STAGING_DEV=""
  MASTER_STAGING_INO=""
}

# ── 发布门 tsx 编译缓存按次隔离(OCV5-357)──────────────────────────────
# tsx 把编译结果缓存在 os.tmpdir()/tsx-<euid>,键里含源文件绝对路径,所以每个
# .staging-* 都会写一整份副本;tsx 自己只删 8 天前的条目,而且每次查找都线性扫描
# 整个目录清单。release 8(2026-10-09)时 /tmp/tsx-0 有 2.5GB / 12.8 万个文件,
# 冷编译从 12s 拖到 34s,OCV5-187 callback payload hash WS 证明的 30s 上限被打穿。
# 做法:staging 里的门全部用本次构建私有的 TMPDIR,构建结束(成功或失败)就删;
# 进程被 kill -9 留下的目录由下一次构建按 pid 清掉。门本身和超时都不改。
create_master_gate_tmpdir() {
  sweep_stale_master_gate_tmpdirs
  MASTER_GATE_TMPDIR="$(mktemp -d "${MASTER_GATE_TMP_PREFIX}.$$.XXXXXX")" || {
    MASTER_GATE_TMPDIR=""
    return 1
  }
  chmod 0700 -- "$MASTER_GATE_TMPDIR"
}

# 只删本进程(名字里的 pid == $$)建的、不是符号链接的目录。
cleanup_master_gate_tmpdir() {
  local d="${MASTER_GATE_TMPDIR:-}"
  MASTER_GATE_TMPDIR=""
  [[ -n "$d" ]] || return 0
  case "$d" in
    "${MASTER_GATE_TMP_PREFIX}.$$."*) ;;
    *)
      mlog "cleanup: 拒绝 rm 非本次构建的门临时目录: $d"
      return 0
      ;;
  esac
  [[ -d "$d" && ! -L "$d" ]] || return 0
  rm -rf -- "$d"
}

# 上一次构建被 kill -9 时 EXIT trap 不会跑。pid 还在(/proc/<pid> 存在)的一律不碰。
sweep_stale_master_gate_tmpdirs() {
  local d pid uid
  uid="$(id -u)"
  for d in "${MASTER_GATE_TMP_PREFIX}".*; do
    [[ -d "$d" && ! -L "$d" ]] || continue
    [[ "$(stat -c '%u' -- "$d" 2>/dev/null || true)" == "$uid" ]] || continue
    pid="${d#"${MASTER_GATE_TMP_PREFIX}".}"
    pid="${pid%%.*}"
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$pid" != "$$" && ! -e "/proc/$pid" ]] || continue
    mlog "  清理残留的门临时目录(pid $pid 已退出): $d"
    rm -rf -- "$d"
  done
}

# ── Box 门假失败治理(OCV5-557)──────────────────────────────────────────
# FINDINGS-20261021:7 天 16 次 Box 相关门失败,没有一次是真缺陷。根因两类:门里的绝对时间窗口
# 在负载 20–45 时越界;门共用的 openclaude_test 被别的会话的 integ 测试重建、加锁。这里只管调度和记录:
#   - Box 门前先等后台 runtime 构建收尾(不并行),再等主机空闲(load1<8、没有别的会话在跑全量测试),有上限;
#   - 每班列车一个临时测试库,门跑完即删;共享测试库只用来连到同一实例,绝不重置或删除;
#   - 每次跑门前按负载算等待倍数 clamp(load1/8, 1, 3) 传给门,写进 summary;
#   - 门失败时只看门自己打印的 [gate-failure] 行:全部在白名单里才重跑一次,两次日志都留,重跑写进 summary。
# 门的断言、计数都不在这里;倍数只放大门里的等待预算,上限 3 倍。
MASTER_BOX_GATE_LOAD_MAX=8          # 16 核的一半(用户 2026-10-21 定),不读环境变量
MASTER_GATE_LOAD_SCALE_MAX=3        # 同上
MASTER_GATE_IDLE_TIMEOUT_S="${MASTER_GATE_IDLE_TIMEOUT_S:-900}"
MASTER_GATE_IDLE_POLL_S="${MASTER_GATE_IDLE_POLL_S:-15}"
MASTER_GATE_LOADAVG="${MASTER_GATE_LOADAVG:-/proc/loadavg}"
MASTER_GATE_TEST_LOCK_DIR="${MASTER_GATE_TEST_LOCK_DIR:-/var/lock}"
MASTER_GATE_PROC_ROOT="${MASTER_GATE_PROC_ROOT:-/proc}"
MASTER_GATE_ATTEMPT_DIR="${MASTER_GATE_ATTEMPT_DIR:-}"
MASTER_GATE_LOAD_SCALE=1
# 门打印的 [gate-failure] 行(去掉前缀后)整行匹配其一才算已知假失败。
MASTER_GATE_FLAKY_SIGNATURES=(
  'Query read timeout'
  'relation "agent_containers" does not exist'
  'BOX_SUCCESS_GATE_DEADLINE'
  '\[box-incident-proofs\] LARGE_LINE_CLOSE_still-running'
  '\[box-incident-proofs\] LARGE_LINE_REFUSED_HOST_LEFT_RUNNING'
  # 一次 stop 都没收到(calls 里只有 idle-proof);收到两次 stop 是真失败,不在这里
  '\[box-incident-proofs\] CONFIG_PARKED_TURN_NOT_STOPPED_(/internal/box/idle-proof(,/internal/box/idle-proof)*)?'
  'SEARCH_CLI_PROCESS_FAILED exit=null'
)
# success recovery 的 supervisor 在 worker 失败时报这一行;它本身不是原因,原因看 worker 的那行。
MASTER_GATE_FLAKY_WRAPPER='BOX_SUCCESS_GATE_WORKER code=1 signal=none'
# 临时测试库(本进程建,只有 gateTestDb.mjs 认得的登记才能删)。
MASTER_GATE_DB_URL=""
MASTER_GATE_DB_NAME=""
MASTER_GATE_DB_STAGING=""

master_gate_base_dsn() {
  printf '%s' "${OC_V5_PROOF_TEST_DATABASE_URL:-postgres://test:test@127.0.0.1:55432/openclaude_test}"
}

master_gate_load1() {
  local a="" rest=""
  read -r a rest <"$MASTER_GATE_LOADAVG" 2>/dev/null || a=""
  [[ "$a" =~ ^[0-9]+(\.[0-9]+)?$ ]] && printf '%s' "$a"
  return 0
}

# 等待倍数 = clamp(load1/8, 1, 3),两位小数;读不到负载按 1。
master_gate_load_scale() {
  local l
  l="$(master_gate_load1)"
  if [[ -z "$l" ]]; then printf '1.00'; return 0; fi
  awk -v l="$l" -v d="$MASTER_BOX_GATE_LOAD_MAX" -v m="$MASTER_GATE_LOAD_SCALE_MAX" \
    'BEGIN { s = l / d; if (s < 1) s = 1; if (s > m) s = m; printf "%.2f", s }'
}

# 主机不空闲的原因(空闲时什么都不打印):负载、被持有的 test-mutex 锁、npm test 类进程。
# 锁只用 flock -n 试探后立即放开,不新建锁文件;进程只读 /proc/<pid>/cmdline,不 pgrep/pkill。
master_gate_busy_reason() {
  local l f name rc pid cmd reasons=() args=()
  l="$(master_gate_load1)"
  if [[ -z "$l" ]]; then
    reasons+=("load1=unreadable")
  elif awk -v l="$l" -v m="$MASTER_BOX_GATE_LOAD_MAX" 'BEGIN { exit !(l >= m) }'; then
    reasons+=("load1=$l>=$MASTER_BOX_GATE_LOAD_MAX")
  fi
  for f in "$MASTER_GATE_TEST_LOCK_DIR"/oc-test-*.lock; do
    [[ -f "$f" && ! -L "$f" ]] || continue
    rc=0
    flock -n -E 75 "$f" true 2>/dev/null || rc=$?
    [[ "$rc" == 75 ]] || continue
    name="${f##*/oc-test-}"
    reasons+=("test-mutex:${name%.lock}")
  done
  for f in "$MASTER_GATE_PROC_ROOT"/[0-9]*/cmdline; do
    pid="${f%/cmdline}"
    pid="${pid##*/}"
    [[ "$pid" != "$$" && "$pid" != "${BASHPID:-}" ]] || continue
    args=()
    mapfile -d '' -t args <"$f" 2>/dev/null || continue
    (( ${#args[@]} > 0 )) || continue
    cmd=" ${args[*]} "
    if [[ "$cmd" =~ [[:space:]/]npm(-cli\.js)?[[:space:]]+(test|run[[:space:]]+(test|check:v5)[^[:space:]]*)[[:space:]] ]]; then
      reasons+=("pid$pid:${BASH_REMATCH[0]//[[:space:]]/ }")
    fi
  done
  (( ${#reasons[@]} == 0 )) || printf '%s' "${reasons[*]:0:6}"
  return 0
}

master_gate_wait_host_idle() { # <why> → rc 1 when still busy after MASTER_GATE_IDLE_TIMEOUT_S
  local why="$1" t0 now reason=""
  t0="$(date +%s)"
  while :; do
    reason="$(master_gate_busy_reason)"
    [[ -n "$reason" ]] || break
    now="$(date +%s)"
    if (( now - t0 >= MASTER_GATE_IDLE_TIMEOUT_S )); then
      tsum_note "hostIdle.$why.timeout" "$reason" 2>/dev/null || :
      mlog "✗ 主机持续繁忙 $((now - t0))s(上限 ${MASTER_GATE_IDLE_TIMEOUT_S}s),$why 不发车:$reason"
      return 1
    fi
    mlog "  ⏳ 主机繁忙,$why 暂不发车(已等 $((now - t0))s):$reason"
    sleep "$MASTER_GATE_IDLE_POLL_S"
  done
  now="$(date +%s)"
  tsum_note "hostIdle.$why.waitSec" "$((now - t0))" 2>/dev/null || :
  tsum_note "hostIdle.$why.load1" "$(master_gate_load1)" 2>/dev/null || :
  mlog "  主机空闲(load1=$(master_gate_load1) < $MASTER_BOX_GATE_LOAD_MAX,没有别的会话在跑全量测试),$why 等了 $((now - t0))s"
  return 0
}

master_gate_db_create() { # <staging>
  local staging="$1" url
  ( cd "$staging" && OC_V5_GATE_BASE_DSN="$(master_gate_base_dsn)" node scripts/lib/gateTestDb.mjs sweep ) \
    || mlog "  (清扫残留的门测试库失败,不影响本次)"
  url="$(cd "$staging" && OC_V5_GATE_BASE_DSN="$(master_gate_base_dsn)" node scripts/lib/gateTestDb.mjs create "$$")" || return 1
  [[ "$url" =~ /(ocv5_gate_[0-9]+_[0-9a-f]{12}_test)$ ]] || return 1
  MASTER_GATE_DB_URL="$url"
  MASTER_GATE_DB_NAME="${BASH_REMATCH[1]}"
  MASTER_GATE_DB_STAGING="$staging"
  tsum_note gateDb "$MASTER_GATE_DB_NAME" 2>/dev/null || :
  mlog "  本班列车独立测试库 $MASTER_GATE_DB_NAME(Box 门跑完即删;共享测试库不再给 Box 门用)"
}

# 失败路径也走这里(cleanup_master_staging 在删 staging 之前调用)。删不掉只告警:下一班按登记清扫。
master_gate_db_drop() {
  local name="$MASTER_GATE_DB_NAME" staging="$MASTER_GATE_DB_STAGING"
  MASTER_GATE_DB_URL=""
  MASTER_GATE_DB_NAME=""
  MASTER_GATE_DB_STAGING=""
  [[ -n "$name" ]] || return 0
  if [[ -d "$staging" ]] && ( cd "$staging" && OC_V5_GATE_BASE_DSN="$(master_gate_base_dsn)" \
      node scripts/lib/gateTestDb.mjs drop "$name" ); then
    mlog "  已删除本班列车测试库 $name"
  else
    mlog "  ⚠ 删除测试库 $name 失败;下一班列车会按登记清扫"
  fi
  return 0
}

master_gate_attempt_log() { # <gate> <attempt>
  local gate="$1" n="$2" dir tid=""
  if declare -F tsum_train_id >/dev/null; then tid="$(tsum_train_id)"; fi
  if [[ -n "$MASTER_GATE_ATTEMPT_DIR" ]]; then
    dir="$MASTER_GATE_ATTEMPT_DIR"
  elif [[ -n "$tid" ]]; then
    dir="${OC_V5_TRAIN_SUMMARY_DIR:-${OC_V5_LEASE_LOG_DIR:-/opt/openclaude/tmp/lease-trains}}"
  else
    dir=/opt/openclaude/tmp/box-gate-attempts
  fi
  mkdir -p -- "$dir" || return 1
  printf '%s/%s.%s.attempt%s.log' "$dir" "${tid:-manual-$$-$(date -u +%Y%m%dT%H%M%SZ)}" "$gate" "$n"
}

# 已知假失败:门打印了至少一条 [gate-failure],每条都在白名单里(或是 success recovery 包装行),
# 且至少一条在白名单里。打印第一条白名单签名。别的失败(断言、清理、超总时限、被信号杀)一律不重试。
master_gate_flaky_signature() { # <attempt-log>
  local line re sig="" known
  local -a lines=()
  mapfile -t lines < <(sed -n 's/^\[gate-failure\] //p' "$1" 2>/dev/null)
  (( ${#lines[@]} > 0 )) || return 1
  for line in "${lines[@]}"; do
    known=0
    for re in "${MASTER_GATE_FLAKY_SIGNATURES[@]}"; do
      if [[ "$line" =~ ^(${re})$ ]]; then
        known=1
        [[ -n "$sig" ]] || sig="$line"
        break
      fi
    done
    [[ "$known" == 1 || "$line" == "$MASTER_GATE_FLAKY_WRAPPER" ]] || return 1
  done
  [[ -n "$sig" ]] || return 1
  printf '%s' "$sig"
}

# 失败尝试的首错签名(第一条 [gate-failure] 行;没有就记退出码),写进 train summary 时首跑与重跑分开(OCV5-583)。
master_gate_first_failure() { # <attempt-log> <rc>
  local line=""
  line="$(sed -n '/^\[gate-failure\] /{s/^\[gate-failure\] //p;q;}' "$1" 2>/dev/null)" || line=""
  [[ -n "$line" ]] || line="rc=$2 (no [gate-failure] line)"
  printf '%s' "${line:0:200}"
}

# 跑一道可重跑的门:最多两次,第二次只在第一次是已知假失败时才跑。rc 0 = 某一次通过。
master_gate_retryable() { # <gate> <command...>
  local gate="$1" n log first="" rcf rc sig
  shift
  for n in 1 2; do
    MASTER_GATE_LOAD_SCALE="$(master_gate_load_scale)"
    if [[ "$n" == 1 ]]; then
      tsum_note "loadScale.$gate" "$MASTER_GATE_LOAD_SCALE" 2>/dev/null || :
    else
      tsum_note "loadScale.$gate.retry" "$MASTER_GATE_LOAD_SCALE" 2>/dev/null || :
    fi
    log="$(master_gate_attempt_log "$gate" "$n")" || { mlog "✗ [$gate] 建不了尝试日志目录"; return 1; }
    [[ "$n" == 2 && -n "$first" ]] && log="${first%.attempt1.log}.attempt2.log"
    [[ "$n" == 1 ]] && first="$log"
    rcf="$(mktemp "${MASTER_GATE_TMPDIR:-/tmp}/gate-rc.XXXXXX")" || return 1
    mlog "  [$gate] 第 $n 次,等待倍数 ×$MASTER_GATE_LOAD_SCALE(load1=$(master_gate_load1)),日志 $log"
    { rc=0; "$@" 2>&1 || rc=$?; printf '%s\n' "$rc" >"$rcf"; } | tee -- "$log" >&2
    rc="$(cat -- "$rcf" 2>/dev/null)"
    rm -f -- "$rcf"
    [[ "$rc" =~ ^[0-9]+$ ]] || rc=1
    [[ "$rc" == 0 ]] || tsum_note "gateFailure.$gate.attempt$n" "$(master_gate_first_failure "$log" "$rc")" 2>/dev/null || :
    if [[ "$rc" == 0 ]]; then
      if [[ "$n" == 2 ]]; then
        tsum_note "retry.$gate.result" passed 2>/dev/null || :
        mlog "  [$gate] 重跑通过(第 1 次的已知假失败见 $first)"
      fi
      return 0
    fi
    if [[ "$n" == 2 ]]; then
      tsum_note "retry.$gate.result" failed 2>/dev/null || :
      mlog "✗ [$gate] 重跑仍失败,按硬失败处理"
      return 1
    fi
    if ! sig="$(master_gate_flaky_signature "$log")"; then
      mlog "  [$gate] 失败原因不在已知假失败白名单里 → 不重跑"
      return 1
    fi
    tsum_note "retry.$gate" "$sig" 2>/dev/null || :
    tsum_note "retry.$gate.attempt1Log" "$log" 2>/dev/null || :
    mlog "  ⟳ [$gate] 已知假失败「$sig」→ 等主机空闲后重跑一次(第 1 次日志保留在 $log)"
    master_gate_wait_host_idle "retry.$gate" || return 1
  done
}

# 商业版 release_artifact_digest 的本地化抄本(无 SSH)。.complete 不计入。
release_artifact_digest() { # <absolute-release-root>
  local root="$1"
  [[ -d "$root" && ! -L "$root" ]] || {
    echo "FATAL: release artifact root 非真实目录:$root" >&2
    return 1
  }
  python3 - "$root" <<'PY'
import hashlib
import os
import stat
import sys

root = os.fsencode(os.path.abspath(sys.argv[1]))
if not os.path.isdir(root) or os.path.islink(root):
    raise SystemExit("FATAL: release artifact root is not a real directory")

def identity(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid,
            st.st_size, st.st_mtime_ns, st.st_ctime_ns)

def snapshot_tree():
    root_stat = os.lstat(root)
    if not stat.S_ISDIR(root_stat.st_mode):
        raise RuntimeError("release artifact root changed type")
    rows = []

    def collect(directory, prefix=b""):
        with os.scandir(directory) as scan:
            for entry in scan:
                name = entry.name
                rel = name if not prefix else prefix + b"/" + name
                if rel == b".complete":
                    continue
                st = entry.stat(follow_symlinks=False)
                mode = st.st_mode
                if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode)):
                    raise RuntimeError(f"non-regular release entry: {os.fsdecode(rel)!r}")
                rows.append((rel, entry.path, identity(st)))
                if stat.S_ISDIR(mode):
                    collect(entry.path, rel)

    collect(root)
    rows.sort(key=lambda item: item[0])
    return identity(root_stat), rows

root_before, entries = snapshot_tree()
digest = hashlib.sha256(b"openclaude-release-artifact-v2\0")

def field(value):
    if isinstance(value, str):
        value = value.encode("ascii")
    digest.update(len(value).to_bytes(8, "big"))
    digest.update(value)

root_stat = os.lstat(root)
if identity(root_stat) != root_before:
    raise RuntimeError("release artifact root changed before digest")
field(b"D")
field(b"")
field(str(stat.S_IMODE(root_stat.st_mode)))
field(str(root_stat.st_uid))
field(str(root_stat.st_gid))

for rel, absolute, before in entries:
    st = os.lstat(absolute)
    if identity(st) != before:
        raise RuntimeError(f"release entry changed during digest: {os.fsdecode(rel)!r}")
    mode = st.st_mode
    kind = b"F" if stat.S_ISREG(mode) else b"D" if stat.S_ISDIR(mode) else b"L"
    field(kind)
    field(rel)
    field(str(stat.S_IMODE(mode)))
    field(str(st.st_uid))
    field(str(st.st_gid))
    if kind == b"F":
        field(str(st.st_size))
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(absolute, flags)
        if identity(os.fstat(fd)) != before:
            os.close(fd)
            raise RuntimeError(f"release file changed before open: {os.fsdecode(rel)!r}")
        with os.fdopen(fd, "rb", buffering=1024 * 1024) as fh:
            while chunk := fh.read(1024 * 1024):
                digest.update(chunk)
            if identity(os.fstat(fh.fileno())) != before:
                raise RuntimeError(f"release file changed while open: {os.fsdecode(rel)!r}")
    elif kind == b"L":
        field(os.readlink(absolute))
    if identity(os.lstat(absolute)) != before:
        raise RuntimeError(f"release entry changed while hashing: {os.fsdecode(rel)!r}")

root_after, entries_after = snapshot_tree()
before_signature = [(rel, before) for rel, _absolute, before in entries]
after_signature = [(rel, after) for rel, _absolute, after in entries_after]
if root_after != root_before or after_signature != before_signature:
    raise RuntimeError("release tree changed during digest")

print(digest.hexdigest())
PY
}

# 只收紧 nlink==1 的文件 + 子目录。禁止改共享 inode(会污染 donor / 工作树)。
# tsx 缓存写在 /tmp/tsx-${euid},不写 node_modules,0444 不会让 tsx 起不来。
# 保留原可执行位:nlink==1 且已有 +x 的文件用 0555,否则后续从该 rel 硬链 donor 时
# staging 内 tsc/vite 会 Permission denied。
harden_unique_release_tree() { # <staging-root>
  local root="$1"
  [[ -d "$root" && ! -L "$root" ]] || return 1
  chown 0:0 -- "$root" || return 1
  # 根目录先保持可写,以便随后落 .complete;子目录去写位。
  find "$root" -mindepth 1 -type d -print0 | xargs -0 -r chmod 0555
  find "$root" -type f -links 1 -perm /111 -print0 | xargs -0 -r chmod 0555
  find "$root" -type f -links 1 ! -perm /111 -print0 | xargs -0 -r chmod 0444
}

# 从已 harden 的 donor 硬链过来后,tsc/vite 可能是 0444。不能 chmod 共享 inode。
# 把不可执行的工具链文件拆成 staging 私有副本再 +x,donor 不变。
break_hardlink_restore_exec() { # <staging>
  local staging="$1"
  python3 - "$staging" <<'PY'
import os
import shutil
import stat
import sys

root = os.path.abspath(sys.argv[1])
broken = 0
scan_roots = [os.path.join(root, "node_modules")]
pkg = os.path.join(root, "packages")
if os.path.isdir(pkg):
    for name in os.listdir(pkg):
        cand = os.path.join(pkg, name, "node_modules")
        if os.path.isdir(cand):
            scan_roots.append(cand)
bin_dirs = []
for start in scan_roots:
    for dirpath, dirnames, _filenames in os.walk(start, followlinks=False):
        if os.path.basename(dirpath) == ".bin":
            bin_dirs.append(dirpath)
            dirnames[:] = []
for bdir in bin_dirs:
    try:
        names = os.listdir(bdir)
    except OSError:
        continue
    for name in names:
        path = os.path.join(bdir, name)
        try:
            real = os.path.realpath(path)
            st = os.stat(real)
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode):
            continue
        if st.st_mode & 0o111:
            continue
        tmp = real + ".exectmp.%d" % os.getpid()
        shutil.copy2(real, tmp)
        os.chmod(tmp, 0o0555)
        os.replace(tmp, real)
        broken += 1
sys.stderr.write("broke-hardlink-exec=%d bin_dirs=%d\n" % (broken, len(bin_dirs)))
PY
}

write_strong_release_marker_local() { # <release-root> <full-sha> <short-sha> <builtAt> <schema>
  local root="$1" full_sha="$2" short_sha="$3" built_at="$4" schema="$5"
  local metadata_sha artifact_sha marker_tmp root_uid root_gid root_mode marker_uid marker_gid marker_mode
  [[ "$full_sha" =~ ^[0-9a-f]{40}$ && "$short_sha" =~ ^[0-9a-f]{7,40}$ \
    && "$full_sha" == "$short_sha"* && "$built_at" =~ ^[0-9]{8}-[0-9]{6}$ \
    && "$schema" =~ ^[1-9][0-9]*$ ]] || {
    echo 'FATAL: strong release identity 参数非法' >&2
    return 1
  }
  [[ -d "$root" && ! -L "$root" ]] || {
    echo 'FATAL: strong release root 非法' >&2
    return 1
  }
  host_log_policy_require_bundle "$root" || return $?
  chown 0:0 -- "$root" || return 1
  chmod go-w -- "$root" || return 1
  read -r root_uid root_gid root_mode < <(stat -Lc '%u %g %a' -- "$root")
  [[ "$root_uid" == 0 && "$root_gid" == 0 && $((8#$root_mode & 8#22)) -eq 0 ]] || {
    echo "FATAL: strong release root ownership/mode 不可信:$root" >&2
    return 1
  }
  test -f "$root/package.json"
  test -d "$root/node_modules"
  test -d "$root/node_modules/tsx"
  test -f "$root/VERSION.json"
  test -f "$root/packages/web-react/dist/index.html"
  test -f "$root/deploy/v5/release-metadata.json"
  grep -q 'name="oc-build"' "$root/packages/web-react/dist/index.html" \
    || { echo 'FATAL: dist/index.html 缺 oc-build meta' >&2; return 1; }
  [[ "$(jq -er '.commit | select(type == "string")' "$root/VERSION.json")" == "$short_sha" ]] || {
    echo 'FATAL: VERSION.commit 与 pinned source short SHA 不一致' >&2
    return 1
  }
  metadata_sha="$(sha256sum -- "$root/deploy/v5/release-metadata.json" | cut -d' ' -f1)"
  artifact_sha="$(release_artifact_digest "$root")"
  [[ "$metadata_sha" =~ ^[0-9a-f]{64}$ && "$artifact_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  marker_tmp="${root}.complete.$$"
  if ! jq -n \
    --argjson schemaVersion "$schema" \
    --arg sourceCommit "$full_sha" \
    --arg builtAt "$built_at" \
    --arg metadataSha256 "$metadata_sha" \
    --arg artifactSha256 "$artifact_sha" \
    '{schemaVersion:$schemaVersion,sourceCommit:$sourceCommit,builtAt:$builtAt,
      metadataSha256:$metadataSha256,artifactSha256:$artifactSha256,
      flavorGuardGeneration:1,hostLogPolicyGeneration:1}' >"$marker_tmp"; then
    rm -f -- "$marker_tmp"
    return 1
  fi
  chmod 0644 "$marker_tmp" || { rm -f -- "$marker_tmp"; return 1; }
  chown 0:0 "$marker_tmp" || { rm -f -- "$marker_tmp"; return 1; }
  mv -f -- "$marker_tmp" "$root/.complete" || { rm -f -- "$marker_tmp"; return 1; }
  read -r marker_uid marker_gid marker_mode < <(stat -Lc '%u %g %a' -- "$root/.complete")
  [[ "$marker_uid" == 0 && "$marker_gid" == 0 && "$marker_mode" == 644 ]] || {
    echo "FATAL: strong release marker ownership/mode 不可信:$root/.complete" >&2
    return 1
  }
  [[ "$(release_artifact_digest "$root")" == "$artifact_sha" ]] || {
    echo "FATAL: strong release tree changed while publishing marker:$root" >&2
    return 1
  }
}

release_dir_is_poisoned() { # <dir>
  local cand="$1"
  case "$cand" in
    *.poisoned) return 0 ;;
  esac
  [[ -e "$cand/.poisoned" || -e "${cand}.poisoned" ]]
}

# stdout 只打印 donor 绝对路径;找不到则 rc=1。日志走 stderr。
# 禁止用工作树当默认 donor(阶段 1 有毒 rel 就是这样来的);禁止 *.poisoned。
find_master_release_donor() { # <staging-lock>
  local staging_lock="$1" cand pinned
  [[ -f "$staging_lock" ]] || return 1
  if [[ "${FORCE_NPM_CI:-0}" == 1 ]]; then
    mlog "  --force-npm-ci:跳过硬链 donor"
    return 1
  fi
  pinned="${OC_V5_MASTER_DONOR:-}"
  if [[ -n "$pinned" ]]; then
    if release_dir_is_poisoned "$pinned"; then
      mlog "  拒绝有毒 donor pin: $pinned"
      return 1
    fi
    [[ -f "$pinned/.complete" && ! -L "$pinned/.complete" ]] || return 1
    [[ -d "$pinned/node_modules" && ! -L "$pinned/node_modules" ]] || return 1
    [[ -f "$pinned/package-lock.json" ]] || return 1
    if cmp -s "$staging_lock" "$pinned/package-lock.json"; then
      mlog "  donor=OC_V5_MASTER_DONOR $pinned"
      printf '%s\n' "$pinned"
      return 0
    fi
    mlog "  OC_V5_MASTER_DONOR lock 不匹配,忽略 $pinned"
  fi
  # 优先上一份合法 live(绝不用工作树、绝不用 .poisoned)。
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    cand="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
    if [[ -n "$cand" ]] && ! release_dir_is_poisoned "$cand" \
      && [[ -f "$cand/.complete" && ! -L "$cand/.complete" ]] \
      && [[ -d "$cand/node_modules" && ! -L "$cand/node_modules" ]] \
      && [[ -f "$cand/package-lock.json" ]] \
      && cmp -s "$staging_lock" "$cand/package-lock.json"; then
      mlog "  donor=live $cand"
      printf '%s\n' "$cand"
      return 0
    fi
    if [[ -n "$cand" ]]; then
      mlog "  live donor 不可用(缺 .complete / lock 不匹配 / poisoned),继续找其它完整 release"
    fi
  fi
  if [[ -d "$MASTER_RELEASES_ROOT" ]]; then
    while IFS= read -r cand; do
      [[ -n "$cand" ]] || continue
      if release_dir_is_poisoned "$cand"; then
        continue
      fi
      [[ -f "$cand/.complete" && ! -L "$cand/.complete" ]] || continue
      [[ -d "$cand/node_modules" && ! -L "$cand/node_modules" ]] || continue
      [[ -f "$cand/package-lock.json" ]] || continue
      if cmp -s "$staging_lock" "$cand/package-lock.json"; then
        mlog "  donor=已有 release $cand"
        printf '%s\n' "$cand"
        return 0
      fi
    done < <(find "$MASTER_RELEASES_ROOT" -mindepth 1 -maxdepth 1 -type d \
      -name 'rel-*' ! -name '*.poisoned' -printf '%T@\t%p\n' \
      | sort -nr | cut -f2-)
  fi
  if [[ "${OC_V5_ALLOW_WORKTREE_DONOR:-0}" == 1 ]] \
    && [[ -d "${REPO_ROOT:-}/node_modules" && -f "${REPO_ROOT:-}/package-lock.json" ]] \
    && cmp -s "$staging_lock" "$REPO_ROOT/package-lock.json"; then
    mlog "  donor=工作树 $REPO_ROOT (OC_V5_ALLOW_WORKTREE_DONOR=1;绝不 chmod 其共享 inode)"
    printf '%s\n' "$REPO_ROOT"
    return 0
  fi
  return 1
}

# OCV5-581: L0 发车预检(只读)。构建前一次报出全部确定性前置缺口,不再等列车跑到对应的门才逐个暴露。
# 不替代任何门:迁移门、Box 门、磁盘门照常在原位置再跑一遍。
# shellcheck source=scripts/lib/v5-release-preflight.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/v5-release-preflight.sh"

selfhost_release_preflight() { # <target-sha>
  local target="$1" live from=""
  live="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
  if [[ -n "$live" && -f "$live/.complete" ]]; then
    from="$(jq -r '.sourceCommit // empty' "$live/.complete" 2>/dev/null || true)"
  fi
  mlog "── L0 发车预检(只读:不建库、不加锁、不写标记;OCV5-581)target=${target:0:12} ──"
  rpf_reset
  rpf_check_source_pin "$REPO_ROOT" "$target"
  rpf_check_workspace_links "$REPO_ROOT" 1
  rpf_check_migrations "$REPO_ROOT" "$from" "$target"
  rpf_check_proof_db "$REPO_ROOT" gate-db "$(master_gate_base_dsn)"
  rpf_check_disk "$RPF_MIN_FREE_KB" "$live" "$MASTER_RELEASES_ROOT" "${OC_HOTCFG_RELEASES_ROOT:-$MASTER_RELEASES_ROOT}" "${TMPDIR:-/tmp}"
  tsum_note preflight "$(rpf_summary)" 2>/dev/null || :
  if rpf_report >&2; then
    mlog "  ✓ L0 发车预检通过"
  elif [[ "${DRY:-0}" == 1 ]]; then
    mlog "  [dry-run] L0 发车预检未通过;正式发车会在这里拒绝"
  else
    die "L0 发车预检未通过:上面每条 ✗ 都要先处理(只读检查,未构建、live 未改)。"
  fi
}

assert_master_releases_disk() {
  local parent avail_kb
  parent="$(dirname -- "$MASTER_RELEASES_ROOT")"
  mkdir -p -- "$parent"
  avail_kb="$(df -Pk -- "$parent" | awk 'NR==2 {print $4}')"
  [[ "$avail_kb" =~ ^[0-9]+$ ]] || die "无法读取磁盘剩余空间"
  # 一份冷装表观 ~1.8G + staging 峰值,留 8G 余量(RPF_MIN_FREE_KB,与 L0 预检同一阈值)。
  if (( avail_kb < RPF_MIN_FREE_KB )); then
    die "根盘可用 ${avail_kb}KiB < 8GiB,拒绝构建 master release。补救:先腾空间。"
  fi
}

write_master_version_json() { # <staging> <short-sha>
  local staging="$1" short_sha="$2" built_iso tmp
  built_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$staging/VERSION.json.tmp.$$"
  jq -n \
    --arg tag "v5-$short_sha" \
    --arg commit "$short_sha" \
    --arg channel "v5" \
    --arg builtAt "$built_iso" \
    '{tag:$tag,commit:$commit,channel:$channel,builtAt:$builtAt}' >"$tmp" \
    || { rm -f -- "$tmp"; return 1; }
  chmod 0644 "$tmp"
  chown 0:0 "$tmp"
  mv -f -- "$tmp" "$staging/VERSION.json"
}

# 构建一份可运行的 master release。不装 unit、不切 symlink、不迁库、不重启。
# 成功后 BUILT_MASTER_RELEASE 指向 rel-* 绝对路径。
# ── web-react dist 复用(2026-10-08 devflow-opt)──
# 实测每次 selfhost --deploy 都重建前端 ~200s(其中 vite 14s,其余是 tsc -b),哪怕本次只改了后端。
# 构建是确定性的(oc-build = index.html 内容哈希),所以「全部构建输入逐字节相同」时,上一份 release
# 的 dist 就是本次会构建出的 dist,tsc -b 的结论也相同 —— 复用不削门。
#
# 输入口径(任何一项变 → key 变 → 照常构建):
#   packages/web-react 整棵 tree(源码、配置、自身 lock、public、vite.config)
#   packages/protocol 整棵 tree(@openclaude/protocol 依赖)
#   packages/mcp-memory/src(web-react 唯一越包相对 import:mcp-memory/src/toolNames)
#   根 package-lock.json / package.json(依赖版本)
#   本文件自身(构建步骤一变就作废所有旧 key)
#   node --version
#   构建进程环境里会进产物的变量:VITE_*(Vite 编译期内联)、NODE_ENV、BROWSERSLIST*
# donor 必须是完整封存的 release:.complete 结构合法、根 0:0 且不可组/他写、release_artifact_digest
# 复算等于 .complete.artifactSha256(覆盖 dist 与复用记录本身);再对 dist 重算摘要比对记录。不信任裸存在。
# OC_V5_FORCE_WEB_BUILD=1 强制重建。
WEB_DIST_REUSE_RECORD=".web-dist-reuse.json"
WEB_DIST_REUSE_SCHEMA="web-dist-reuse-v1"
WEB_DIST_KEY_PATHS=(
  packages/web-react
  packages/protocol
  packages/mcp-memory/src
  package-lock.json
  package.json
  scripts/v5-selfhost-master-release-lib.sh
)

master_web_dist_key() { # <full-sha> → stdout 64-hex;任一输入取不到 → rc=1(调用方照常构建)
  local sha="$1" p oid parts node_ver
  parts="$WEB_DIST_REUSE_SCHEMA"
  for p in "${WEB_DIST_KEY_PATHS[@]}"; do
    oid="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${sha}:${p}" 2>/dev/null)" || return 1
    [[ "$oid" =~ ^[0-9a-f]{40}$ ]] || return 1
    parts+=$'\n'"$p $oid"
  done
  node_ver="$(node --version 2>/dev/null)" || return 1
  parts+=$'\n'"node $node_ver"
  # 只取名字合法的变量,按字节序排序;值原样进 key(不打印)。
  parts+=$'\n'"env"$'\n'"$(env | LC_ALL=C grep -E '^(VITE_[A-Za-z0-9_]*|NODE_ENV|BROWSERSLIST[A-Za-z0-9_]*)=' | LC_ALL=C sort || true)"
  printf '%s' "$parts" | sha256sum | cut -d' ' -f1
}

web_dist_digest() { # <dist-dir> → stdout 64-hex(相对路径 + 内容;拒绝符号链接)
  local dist="$1"
  [[ -d "$dist" && ! -L "$dist" ]] || return 1
  [[ -z "$(find "$dist" -type l -print -quit)" ]] || return 1
  ( cd "$dist" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum ) | sha256sum | cut -d' ' -f1
}

# stdout 只打印可复用 dist 的 release 绝对路径;找不到 rc=1。日志走 stderr。
# 候选:live 优先,其次最近的已封存 rel-*(最多 8 份);拒绝 .poisoned / 缺 .complete / 记录不符 / 摘要不符。
web_dist_donor_sealed() { # <release-root> → rc 0 = 完整封存且未被改动
  local rel="$1" marker schema commit art root_uid root_gid root_mode got
  marker="$rel/.complete"
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  schema="$(jq -er '.schemaVersion' "$marker" 2>/dev/null)" || return 1
  commit="$(jq -er '.sourceCommit' "$marker" 2>/dev/null)" || return 1
  art="$(jq -er '.artifactSha256' "$marker" 2>/dev/null)" || return 1
  [[ "$schema" == "$MASTER_RELEASE_COMPLETE_SCHEMA_VERSION" && "$commit" =~ ^[0-9a-f]{40}$ && "$art" =~ ^[0-9a-f]{64}$ ]] || return 1
  read -r root_uid root_gid root_mode < <(stat -Lc '%u %g %a' -- "$rel") || return 1
  [[ "$root_uid" == 0 && "$root_gid" == 0 && $((8#$root_mode & 8#22)) -eq 0 ]] || return 1
  got="$(release_artifact_digest "$rel" 2>/dev/null)" || return 1
  [[ "$got" == "$art" ]]
}

find_web_dist_donor() { # <key>
  local key="$1" cand rec rkey rdigest got live=""
  [[ "$key" =~ ^[0-9a-f]{64}$ ]] || return 1
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    live="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
  fi
  while IFS= read -r cand; do
    [[ -n "$cand" && -d "$cand" && ! -L "$cand" ]] || continue
    release_dir_is_poisoned "$cand" && continue
    [[ -f "$cand/.complete" && ! -L "$cand/.complete" ]] || continue
    rec="$cand/$WEB_DIST_REUSE_RECORD"
    [[ -f "$rec" && ! -L "$rec" ]] || continue
    rkey="$(jq -er --arg s "$WEB_DIST_REUSE_SCHEMA" 'select(.schema == $s) | .key' "$rec" 2>/dev/null)" || continue
    [[ "$rkey" == "$key" ]] || continue
    rdigest="$(jq -er '.distDigest' "$rec" 2>/dev/null)" || continue
    [[ "$rdigest" =~ ^[0-9a-f]{64}$ ]] || continue
    grep -q 'name="oc-build"' "$cand/packages/web-react/dist/index.html" 2>/dev/null || continue
    got="$(web_dist_digest "$cand/packages/web-react/dist")" || continue
    if [[ "$got" != "$rdigest" ]]; then
      mlog "  web dist donor 摘要不符,跳过 $cand(recorded=${rdigest:0:12} got=${got:0:12})"
      continue
    fi
    # 最后做最贵的一步:整份 release 的封存复核(key 匹配的候选通常只有 live 一份)。
    if ! web_dist_donor_sealed "$cand"; then
      mlog "  web dist donor 封存复核失败(.complete/属主/artifactSha256 不符),跳过 $cand"
      continue
    fi
    printf '%s\n' "$cand"
    return 0
  done < <(
    [[ -n "$live" ]] && printf '%s\n' "$live"
    if [[ -d "$MASTER_RELEASES_ROOT" ]]; then
      find "$MASTER_RELEASES_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'rel-*' ! -name '*.poisoned' \
        -printf '%T@\t%p\n' | sort -nr | cut -f2- | grep -vxF -- "${live:-/nonexistent}" | head -8
    fi
  )
  return 1
}

write_web_dist_reuse_record() { # <staging> <key-or-empty> <mode> <full-sha> [donor]
  local staging="$1" key="$2" mode="$3" sha="$4" donor="${5:-}" digest
  [[ "$key" =~ ^[0-9a-f]{64}$ ]] || return 0   # 取不到 key 的构建不登记,下次照常构建
  digest="$(web_dist_digest "$staging/packages/web-react/dist")" || return 1
  jq -n --arg schema "$WEB_DIST_REUSE_SCHEMA" --arg key "$key" --arg digest "$digest" \
    --arg mode "$mode" --arg sha "$sha" --arg donor "$donor" \
    '{schema: $schema, key: $key, distDigest: $digest, mode: $mode, sourceCommit: $sha, donor: $donor}' \
    > "$staging/$WEB_DIST_REUSE_RECORD"
}

# OCV5-545:把 check-architecture.ts --json 的计数记进列车 summary.json(只记录,读不到就记 unreadable)。
master_note_architecture() { # <report.json>
  local counts v
  counts="$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const total = Object.values(r.byRule || {}).reduce((n, x) => n + x, 0);
    console.log([total, r.identities, (r.grown || []).length, (r.stale || []).length, r.unmapped,
      Math.round(r.seconds)].join(" "));
  ' "$1" 2>/dev/null)" || counts=""
  if [[ -z "$counts" ]]; then
    tsum_note arch.report unreadable 2>/dev/null || :
    return 0
  fi
  local names=(violations identities grown stale unmapped seconds) i=0
  for v in $counts; do
    tsum_note "arch.${names[i]}" "$v" 2>/dev/null || :
    i=$((i + 1))
  done
  mlog "  architecture: violations/identities/grown/stale/unmapped/seconds = $counts"
}

build_master_release() {
  local full_sha short_sha ts staging reldir donor t0 t1 build_id web_key web_donor
  BUILT_MASTER_RELEASE=""
  MASTER_DEPS_MODE=""
  MASTER_DEPS_ELAPSED_S=""
  MASTER_FRONTEND_ELAPSED_S=""
  MASTER_FRONTEND_MODE=""

  # Explicit invocation pin; build-master-only keeps the no-argument HEAD snapshot.
  full_sha="${1:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
  [[ "$full_sha" =~ ^[0-9a-f]{40}$ ]] || die "source commit 不是 40 位 hex: $full_sha"
  short_sha="$(git -C "$REPO_ROOT" rev-parse --short=9 "$full_sha")"
  ts="$(date -u +%Y%m%d-%H%M%S)"
  staging="$MASTER_RELEASES_ROOT/.staging-${short_sha}-$$-${ts}"
  reldir="$MASTER_RELEASES_ROOT/rel-${short_sha}-${ts}"

  mlog "── build_master_release staging→$reldir (pinned $short_sha) ──"
  if [[ "${DRY:-0}" == 1 ]]; then
    mlog "  [dry-run] git archive $full_sha → $staging; 硬链或 npm ci; staging vite; .complete; mv -T → $reldir"
    BUILT_MASTER_RELEASE="$reldir"
    return 0
  fi

  # Shared tsx cache belongs to live services and other work; only private gate dirs are cleaned.
  assert_master_releases_disk
  command -v python3 >/dev/null 2>&1 || die "缺少 python3(算 artifact digest 需要)"
  command -v npm >/dev/null 2>&1 || die "缺少 npm"
  command -v jq >/dev/null 2>&1 || die "缺少 jq"
  [[ ! -e "$reldir" ]] || die "目标已存在,拒绝覆盖: $reldir"
  # OCV5-583 资源准入前移:主机忙(负载、被持有的 test-mutex、别的会话在跑全量测试)时,以前先建候选
  # (archive + 依赖)再在 Box 门前等最多 900s;现在先在这里等,超时就在建任何东西之前放弃。
  # Box 门前那次等待保留(构建期间可能又忙起来),通常立即通过。
  master_gate_wait_host_idle admission \
    || die "发车准入:主机持续繁忙超过 ${MASTER_GATE_IDLE_TIMEOUT_S}s,未建候选(live 未改)"

  mkdir -p -- "$MASTER_RELEASES_ROOT"
  chown 0:0 -- "$MASTER_RELEASES_ROOT"
  chmod 0755 -- "$MASTER_RELEASES_ROOT"
  [[ -d "$MASTER_RELEASES_ROOT" && ! -L "$MASTER_RELEASES_ROOT" ]] \
    || die "MASTER_RELEASES_ROOT 必须是普通目录: $MASTER_RELEASES_ROOT"

  mkdir -p -- "$staging" || die "无法创建 staging $staging"
  MASTER_STAGING="$(readlink -f -- "$staging")"
  [[ -n "$MASTER_STAGING" && -d "$MASTER_STAGING" ]] || die "staging 规范化失败: $staging"
  MASTER_STAGING_DEV="$(stat -c '%d' -- "$MASTER_STAGING")"
  MASTER_STAGING_INO="$(stat -c '%i' -- "$MASTER_STAGING")"
  staging="$MASTER_STAGING"
  if ! git -C "$REPO_ROOT" archive --format=tar "$full_sha" | tar -x -C "$staging"; then
    cleanup_master_staging
    die "git archive/解包失败"
  fi
  [[ -f "$staging/package-lock.json" ]] || {
    cleanup_master_staging
    die "archive 后缺 package-lock.json"
  }
  [[ -f "$staging/deploy/v5/release-metadata.json" ]] || {
    cleanup_master_staging
    die "archive 后缺 deploy/v5/release-metadata.json"
  }

  tsum_mark B 2>/dev/null || :
  t0="$(date +%s)"
  donor="$(find_master_release_donor "$staging/package-lock.json" || true)"
  if [[ -n "$donor" && -d "$donor/node_modules" ]]; then
    if ! cp -al -- "$donor/node_modules" "$staging/node_modules"; then
      cleanup_master_staging
      die "cp -al node_modules 失败(donor=$donor)"
    fi
    MASTER_DEPS_MODE="hardlink"
    mlog "  lock 未变 → 硬链复用 node_modules ← $donor"
    if ! break_hardlink_restore_exec "$staging"; then
      cleanup_master_staging
      die "拆硬链恢复 staging 可执行位失败(donor=$donor)"
    fi
  else
    mlog "  lock 变化/无 donor/--force-npm-ci → 在 staging 内 npm ci(绝不写 rel-*)"
    if ! ( cd "$staging" && npm ci --no-audit --no-fund ); then
      cleanup_master_staging
      die "staging npm ci 失败"
    fi
    MASTER_DEPS_MODE="npm-ci"
  fi
  t1="$(date +%s)"
  MASTER_DEPS_ELAPSED_S="$((t1 - t0))"
  mlog "  deps elapsed=${MASTER_DEPS_ELAPSED_S}s mode=$MASTER_DEPS_MODE"
  [[ -d "$staging/node_modules/tsx" ]] || {
    cleanup_master_staging
    die "staging 缺 node_modules/tsx"
  }
  if ! create_master_gate_tmpdir; then
    cleanup_master_staging
    die "无法创建发布门私有 TMPDIR(${MASTER_GATE_TMP_PREFIX}.$$.*)"
  fi
  mlog "  发布门 TMPDIR=$MASTER_GATE_TMPDIR(tsx 缓存只属于本次构建,门跑完即删)"
  tsum_mark C.box-success-recovery 2>/dev/null || :
  # OCV5-557:Box 门不与后台 runtime 构建并行,也不在主机繁忙时发车(见上方「Box 门假失败治理」)。
  if declare -F await_runtime_release_bg >/dev/null; then
    t0="$(date +%s)"
    await_runtime_release_bg
    tsum_note runtimeWaitBeforeBoxSec "$(( $(date +%s) - t0 ))" 2>/dev/null || :
  fi
  if ! master_gate_wait_host_idle box-gates; then
    cleanup_master_staging
    die "Box 门发车前主机持续繁忙超过 ${MASTER_GATE_IDLE_TIMEOUT_S}s(负载 >= ${MASTER_BOX_GATE_LOAD_MAX} 或别的会话在跑全量测试,原因见上;live 未改)"
  fi
  if [[ ! -f "$staging/scripts/lib/gateTestDb.mjs" ]] || ! master_gate_db_create "$staging"; then
    cleanup_master_staging
    die "建本班列车独立测试库失败(live 未改)"
  fi
  mlog "  Box success recovery behavioral gate @ pinned staging(封存前;已封存 rel 的切流/回退不跑这道门)"
  if [[ ! -f "$staging/scripts/check-v5-box-success-recovery.ts" ]]; then
    cleanup_master_staging
    die "新候选缺 scripts/check-v5-box-success-recovery.ts"
  fi
  # 本机已核 loopback 实例只由 selfhost wrapper 显式提供;门连的是上面新建的本班列车测试库。
  # 两道 DB 门的命令写在这里(check-v5-incident-regressions 只认 build_master_release 里的调用),
  # 显式去掉 OC_V5_PROOF_TEST_DATABASE_URL:success recovery 门里它优先于 TEST_DATABASE_URL,留着就连回共享库。
  master_gate_box_success_recovery() {
    ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" env -u NODE_OPTIONS -u NODE_PATH -u OC_V5_PROOF_TEST_DATABASE_URL \
        OC_V5_GATE_LOAD_SCALE="$MASTER_GATE_LOAD_SCALE" TEST_DATABASE_URL="$MASTER_GATE_DB_URL" \
        npx --no-install tsx scripts/check-v5-box-success-recovery.ts --candidate-sha "$full_sha" )
  }
  if ! master_gate_retryable box-success-recovery master_gate_box_success_recovery; then
    cleanup_master_staging
    die "pinned Box success recovery behavioral gate 失败"
  fi
  tsum_mark C.box-continuation 2>/dev/null || :
  mlog "  Box multitool continuation gate @ pinned staging(封存前;已封存 rel 的切流/回退不跑这道门)"
  if [[ ! -f "$staging/scripts/check-v5-box-continuation.ts" ]]; then
    cleanup_master_staging
    die "新候选缺 scripts/check-v5-box-continuation.ts"
  fi
  if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" env -u NODE_OPTIONS -u NODE_PATH -u DATABASE_URL -u TEST_DATABASE_URL \
      npx --no-install tsx scripts/check-v5-box-continuation.ts --expect-sha "$full_sha" ); then
    cleanup_master_staging
    die "pinned Box multitool continuation gate 失败"
  fi
  tsum_mark C.box-incident-proofs 2>/dev/null || :
  mlog "  Box incident proofs gate (OCV5-488) @ pinned staging(封存前;已封存 rel 的切流/回退不跑这道门)"
  if [[ ! -f "$staging/scripts/check-v5-box-incident-proofs.ts" ]]; then
    cleanup_master_staging
    die "新候选缺 scripts/check-v5-box-incident-proofs.ts"
  fi
  # 与 success recovery 门同一个本班列车测试库;Box 只在 exec 端点模拟。之后的门不用库,随即删掉。
  master_gate_box_incident_proofs() {
    ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" env -u NODE_OPTIONS -u NODE_PATH -u OC_V5_PROOF_TEST_DATABASE_URL \
        OC_V5_GATE_LOAD_SCALE="$MASTER_GATE_LOAD_SCALE" TEST_DATABASE_URL="$MASTER_GATE_DB_URL" \
        npx --no-install tsx scripts/check-v5-box-incident-proofs.ts --expect-sha "$full_sha" )
  }
  if ! master_gate_retryable box-incident-proofs master_gate_box_incident_proofs; then
    cleanup_master_staging
    die "pinned Box incident proofs gate (OCV5-488) 失败"
  fi
  master_gate_db_drop
  tsum_mark C.cursor-sand 2>/dev/null || :
  mlog "  Cursor Sand InferenceService contract gate @ pinned staging"
  if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" npx --no-install tsx scripts/check-v5-cursor-sand-inference.ts ); then
    cleanup_master_staging
    die "pinned Cursor Sand InferenceService contract gate 失败"
  fi
  tsum_mark C.ccb-mcp 2>/dev/null || :
  mlog "  CCB MCP availability contract gate @ pinned staging"
  master_gate_ccb_mcp() {
    ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" OC_V5_GATE_LOAD_SCALE="$MASTER_GATE_LOAD_SCALE" \
        npx --no-install tsx scripts/check-v5-ccb-mcp-availability.ts )
  }
  if ! master_gate_retryable ccb-mcp master_gate_ccb_mcp; then
    cleanup_master_staging
    die "pinned CCB MCP availability contract gate 失败"
  fi
  tsum_mark C.delegate-billing 2>/dev/null || :
  mlog "  delegate engine billing requestId contract gate @ pinned staging"
  if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" npx --no-install tsx scripts/check-v5-delegate-billing-requestid.ts ); then
    cleanup_master_staging
    die "pinned delegate engine billing requestId contract gate 失败"
  fi
  tsum_mark C.callback-ws 2>/dev/null || :
  mlog "  callback payload hash WS proof @ pinned staging"
  if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" node scripts/check-v5-callback-payload-hash.mjs ); then
    cleanup_master_staging
    die "pinned callback payload hash WS proof 失败"
  fi
  tsum_mark C.cron-submit 2>/dev/null || :
  mlog "  cron submit durability + execution-heartbeat proof @ pinned staging"
  if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" npx --no-install tsx scripts/check-v5-cron-submit-boundary.ts ); then
    cleanup_master_staging
    die "pinned cron submit durability boundary gate 失败"
  fi
  tsum_mark C.session-rootfix 2>/dev/null || :
  mlog "  session unavailable / data-safety rootfix contract gate @ pinned staging"
  if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" npx --no-install tsx scripts/check-v5-session-unavailable-rootfix.ts ); then
    cleanup_master_staging
    die "pinned session unavailable / data-safety rootfix contract gate 失败"
  fi
  tsum_mark C.host-log-policy 2>/dev/null || :
  mlog "  host log policy filesystem/logrotate gate @ pinned staging"
  if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" bash scripts/v5-selfhost-host-log-policy.test.sh ); then
    cleanup_master_staging
    die "pinned host log policy filesystem/logrotate gate 失败"
  fi
  # OCV5-545(第三阶段 P0b 列车步骤):架构护栏在 pinned staging 跑报告期,计数写进 summary.json。
  # 报告期不拦新增违规(和 PR CI 的 architecture job 一致);检查器 fail-closed(解析失败、modules.json
  # 或基线不合法,退出 2)照样让列车失败。转强制期时这里改 --enforce。
  tsum_mark C.architecture 2>/dev/null || :
  mlog "  architecture guardrails (report period) @ pinned staging"
  if [[ ! -f "$staging/scripts/check-architecture.ts" ]]; then
    cleanup_master_staging
    die "新候选缺 scripts/check-architecture.ts"
  fi
  if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" npx --no-install tsx scripts/check-architecture.ts \
      --json "$MASTER_GATE_TMPDIR/architecture.json" ); then
    cleanup_master_staging
    die "pinned architecture guardrails 失败(检查器 fail-closed)"
  fi
  master_note_architecture "$MASTER_GATE_TMPDIR/architecture.json"
  # OCV5-404:committed 后会把本 release 的 watch.sh 装到宿主,所以它的判定逻辑与停用/重新武装
  # 行为必须先在 pinned staging 上过一遍。测试只写 mktemp 目录,不碰宿主标记与安装副本。
  # OCV5-418:门禁失败 stay 路径(survivor kept-failed / 维护窗口 / 列车 failed / 告警)同样先在 staging 跑。
  # OCV5-420:中途退出 / 补偿失败的列车终态(recovery_required、不结算搭车)同样先在 staging 跑。
  # OCV5-420 二期:autorecover(不等人,自动恢复/重跑/升级派 AI)与 watch.sh --auto-recover 同样先在 staging 跑。
  tsum_mark C.watch-gate 2>/dev/null || :
  mlog "  selfhost watch selftest + disarm-observe / lock / rearm / gate-fail-stay behavior @ pinned staging"
  # OCV5-447:清单只在 scripts/v5-selfhost-watch-gate.sh 一处,PR CI(v5-selfhost-gates.yml)跑同一份。
  if [[ ! -f "$staging/scripts/v5-selfhost-watch-gate.sh" ]]; then
    cleanup_master_staging
    die "新候选缺 scripts/v5-selfhost-watch-gate.sh"
  fi
  if ! ( cd "$staging" && TMPDIR="$MASTER_GATE_TMPDIR" bash scripts/v5-selfhost-watch-gate.sh \
      --log-dir "$MASTER_GATE_TMPDIR/watch-gate" ); then
    cleanup_master_staging
    die "pinned selfhost watch gate 失败(失败的脚本与日志尾见上方 FAIL 行)"
  fi
  cleanup_master_gate_tmpdir

  tsum_mark D 2>/dev/null || :
  t0="$(date +%s)"
  web_key="$(master_web_dist_key "$full_sha" || true)"
  web_donor=""
  if [[ -n "$web_key" && "${OC_V5_FORCE_WEB_BUILD:-0}" != 1 ]]; then
    web_donor="$(find_web_dist_donor "$web_key" || true)"
  fi
  if [[ -n "$web_donor" ]]; then
    mlog "  web-react 构建输入未变(key=${web_key:0:12})→ 复用 $web_donor 的 dist(摘要已复核)"
    if [[ -e "$staging/packages/web-react/dist" ]] \
      || ! cp -a -- "$web_donor/packages/web-react/dist" "$staging/packages/web-react/dist"; then
      cleanup_master_staging
      die "复用 web dist 失败(donor=$web_donor)"
    fi
    MASTER_FRONTEND_MODE="reused"
  else
    [[ -n "$web_key" ]] || mlog "  web dist key 取不到 → 照常构建"
    mlog "  web-react official build @ staging(不碰工作树 dist)"
    if ! ( cd "$staging" && NODE_OPTIONS='--max-old-space-size=4096' npm run build --workspace packages/web-react ); then
      cleanup_master_staging
      die "staging web-react 构建失败"
    fi
    MASTER_FRONTEND_MODE="built"
  fi
  t1="$(date +%s)"
  MASTER_FRONTEND_ELAPSED_S="$((t1 - t0))"
  mlog "  frontend elapsed=${MASTER_FRONTEND_ELAPSED_S}s mode=$MASTER_FRONTEND_MODE"
  [[ -f "$staging/packages/web-react/dist/index.html" ]] || {
    cleanup_master_staging
    die "构建后缺 staging dist/index.html"
  }
  build_id="$(grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$staging/packages/web-react/dist/index.html" \
    | grep -o '[0-9a-f]\{8,32\}' | head -1 || true)"
  [[ -n "$build_id" ]] || {
    cleanup_master_staging
    die "staging dist/index.html 缺 oc-build meta"
  }
  mlog "  dist oc-build=$build_id"
  if ! write_web_dist_reuse_record "$staging" "$web_key" "$MASTER_FRONTEND_MODE" "$full_sha" "$web_donor"; then
    cleanup_master_staging
    die "写 $WEB_DIST_REUSE_RECORD 失败"
  fi

  tsum_mark P.mcp-bundle 2>/dev/null || :
  # openclaude-memory MCP server 预编译 CJS(dist/ 被 gitignore,git archive 不带产物,
  # 必须在 staging 构建;缺产物则引擎回落 tsx ~7s 冷启动路径,故 fail-loud)。
  if [[ -f "$staging/packages/mcp-memory/scripts/build-oc-memory-mcp.sh" ]]; then
    mlog "  build oc-memory MCP bundle @ staging"
    if ! ( cd "$staging" && bash packages/mcp-memory/scripts/build-oc-memory-mcp.sh ); then
      cleanup_master_staging
      die "staging oc-memory MCP bundle 构建失败"
    fi
    [[ -s "$staging/packages/mcp-memory/dist/oc-memory-mcp.cjs" ]] || {
      cleanup_master_staging
      die "构建后缺 staging packages/mcp-memory/dist/oc-memory-mcp.cjs"
    }
  fi

  tsum_mark P.seal 2>/dev/null || :
  # 构建期缓存不进 artifact。rm 只丢掉本树的目录项;硬链文件 nlink>1 时 donor 仍在。
  rm -rf -- \
    "$staging/node_modules/.vite" \
    "$staging/node_modules/.cache" \
    "$staging/packages/web-react/node_modules/.vite" \
    "$staging/packages/web-react/node_modules/.cache"

  if ! write_master_version_json "$staging" "$short_sha"; then
    cleanup_master_staging
    die "写 VERSION.json 失败"
  fi
  write_flavor_manifest "$staging" selfhost "$full_sha" \
    || { cleanup_master_staging; die "写 flavor.manifest.json 失败"; }
  if ! harden_unique_release_tree "$staging"; then
    cleanup_master_staging
    die "harden unique files 失败"
  fi
  if ! write_strong_release_marker_local "$staging" "$full_sha" "$short_sha" "$ts" \
    "$MASTER_RELEASE_COMPLETE_SCHEMA_VERSION"; then
    cleanup_master_staging
    die "写 .complete / digest 失败"
  fi
  if ! mv -T -- "$staging" "$reldir"; then
    cleanup_master_staging
    die "mv -T staging→rel 失败"
  fi
  MASTER_STAGING=""
  MASTER_STAGING_DEV=""
  MASTER_STAGING_INO=""
  BUILT_MASTER_RELEASE="$reldir"
  mlog "  ✓ master release 就绪: $reldir deps=${MASTER_DEPS_MODE}/${MASTER_DEPS_ELAPSED_S}s frontend=${MASTER_FRONTEND_ELAPSED_S}s/${MASTER_FRONTEND_MODE}"
}

cmd_build_master_only() {
  log "══ v5 selfhost --build-master-only(只建不切) ══"
  [[ "$REPO_ROOT" == /opt/openclaude/openclaude-v5-selfhost ]] \
    || die "必须在 /opt/openclaude/openclaude-v5-selfhost 内执行"
  require_cmd git
  require_cmd npm
  require_cmd jq
  require_cmd python3
  require_cmd tar
  require_cmd find
  require_cmd sha256sum
  build_master_release
  [[ -n "$BUILT_MASTER_RELEASE" ]] || die "build_master_release 未设置 BUILT_MASTER_RELEASE"
  if [[ "${DRY:-0}" == 1 ]]; then
    log "✓ dry-run 结束(未落盘): $BUILT_MASTER_RELEASE"
    return 0
  fi
  [[ -f "$BUILT_MASTER_RELEASE/.complete" ]] || die "缺 .complete: $BUILT_MASTER_RELEASE"
  log "  path=$BUILT_MASTER_RELEASE"
  log "  sourceCommit=$(jq -er '.sourceCommit' "$BUILT_MASTER_RELEASE/.complete")"
  log "  depsMode=$MASTER_DEPS_MODE elapsed=${MASTER_DEPS_ELAPSED_S}s frontend=${MASTER_FRONTEND_ELAPSED_S}s"
  log "✓ build-master-only 完成(未改 unit / 未切 symlink / 未重启)"
}

# ── 阶段 2 静态门 + 不起 HTTP 的 tsx 自检 ────────────────────────────────

unit_template_working_directory() { # <unit-file>
  awk -F= '/^WorkingDirectory=/{print $2; exit}' "$1"
}

assert_unit_templates_live_wd() { # <dir-with-unit-files>
  local dir="${1:-}" f wd
  [[ -n "$dir" && -d "$dir" ]] \
    || die "assert_unit_templates_live_wd 必须传入目录(候选 release 内 deploy/v5-selfhost 或 snapshot),禁止默认读工作树"
  for f in "${dir}/${V5_UNIT}" "${dir}/${V5_EGRESS_UNIT}"; do
    [[ -f "$f" && ! -L "$f" ]] || die "缺 unit 模板普通文件: $f"
    wd="$(unit_template_working_directory "$f")"
    [[ "$wd" == *-live ]] || die "unit 模板 $f WorkingDirectory='$wd' 必须以 -live 结尾。禁止改回工作树。"
    [[ "$wd" == "$MASTER_LIVE_LINK" ]] \
      || die "unit 模板 $f WorkingDirectory='$wd' 必须等于 $MASTER_LIVE_LINK"
  done
  # 双槽 egress 模板(可选,旧 release 没有):存在则同样必须钉 live WD,且 service 必须
  # 直跑 node --import tsx(npx 会 fork,LISTEN_PID 不匹配 → fd 丢失 → 槽自 bind EADDRINUSE)。
  f="${dir}/${V5_EGRESS_SLOT_SERVICE_TPL:-openclaude-v5-selfhost-egress@.service}"
  if [[ -f "$f" ]]; then
    [[ ! -L "$f" ]] || die "双槽 egress 模板不能是 symlink: $f"
    wd="$(unit_template_working_directory "$f")"
    [[ "$wd" == "$MASTER_LIVE_LINK" ]] \
      || die "双槽 egress 模板 $f WorkingDirectory='$wd' 必须等于 $MASTER_LIVE_LINK"
    grep -Eq '^ExecStart=/usr/bin/node --import tsx ' "$f" \
      || die "双槽 egress 模板 $f ExecStart 必须是 /usr/bin/node --import tsx …(不可经 npx)"
    [[ -f "${dir}/${V5_EGRESS_SLOT_SOCKET_TPL:-openclaude-v5-selfhost-egress@.socket}" ]] \
      || die "有双槽 service 模板却缺 .socket 模板: $dir"
  fi
}

assert_old_deploy_fail_closed() {
  die "仓库 master/egress unit 模板已改指 $MASTER_LIVE_LINK。旧 --$MODE 会装 live WD 但仍走 tuple-only+工作树 saga(审计 blocker 2)。已 fail-closed。
补救: 用 --cutover 完成不可分割翻转;或 --build-master-only 只建不切。禁止 --deploy/--bootstrap 直至 joint saga 合入。"
}

assert_master_release_static_gate() { # <rel> [expected-full-sha]
  local rel="$1" expected="${2:-}" marker schema commit built meta art got ver_commit root_uid root_gid root_mode
  [[ -d "$rel" && ! -L "$rel" ]] || die "静态门: release 不是普通目录: $rel"
  if release_dir_is_poisoned "$rel"; then
    die "静态门: 拒绝有毒 release: $rel"
  fi
  marker="$rel/.complete"
  [[ -f "$marker" && ! -L "$marker" ]] || die "静态门: 缺 .complete: $rel"
  schema="$(jq -er '.schemaVersion' "$marker")"
  commit="$(jq -er '.sourceCommit' "$marker")"
  built="$(jq -er '.builtAt' "$marker")"
  meta="$(jq -er '.metadataSha256' "$marker")"
  art="$(jq -er '.artifactSha256' "$marker")"
  [[ "$schema" == "$MASTER_RELEASE_COMPLETE_SCHEMA_VERSION" ]] \
    || die "静态门: schemaVersion=$schema 期望 $MASTER_RELEASE_COMPLETE_SCHEMA_VERSION"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "静态门: sourceCommit 不是 40 位 hex"
  [[ "$built" =~ ^[0-9]{8}-[0-9]{6}$ ]] || die "静态门: builtAt 非法: $built"
  [[ "$meta" =~ ^[0-9a-f]{64}$ && "$art" =~ ^[0-9a-f]{64}$ ]] \
    || die "静态门: digest 字段非法"
  if [[ -n "$expected" ]]; then
    [[ "$commit" == "$expected" ]] || die "静态门: sourceCommit=$commit 与预期 $expected 不一致"
  fi
  [[ -d "$rel/node_modules/tsx" ]] || die "静态门: 缺 node_modules/tsx"
  [[ -f "$rel/packages/web-react/dist/index.html" ]] || die "静态门: 缺 dist/index.html"
  grep -q 'name="oc-build"' "$rel/packages/web-react/dist/index.html" \
    || die "静态门: dist/index.html 缺 oc-build"
  [[ -f "$rel/deploy/v5/release-metadata.json" ]] || die "静态门: 缺 release-metadata.json"
  [[ -f "$rel/VERSION.json" ]] || die "静态门: 缺 VERSION.json"
  ver_commit="$(jq -er '.commit | select(type == "string")' "$rel/VERSION.json")"
  [[ "$commit" == "$ver_commit"* ]] || die "静态门: VERSION.commit=$ver_commit 不是 sourceCommit 前缀"
  read -r root_uid root_gid root_mode < <(stat -Lc '%u %g %a' -- "$rel")
  [[ "$root_uid" == 0 && "$root_gid" == 0 && $((8#$root_mode & 8#22)) -eq 0 ]] \
    || die "静态门: release 根 ownership/mode 不可信 uid=$root_uid gid=$root_gid mode=$root_mode"
  got="$(release_artifact_digest "$rel")"
  [[ "$got" == "$art" ]] || die "静态门: artifactSha256 复算不匹配 expected=$art got=$got"
  host_log_policy_generation "$rel" >/dev/null || die "静态门: host log policy generation/bundle 不合法"
  mlog "  ✓ 静态门通过 $rel sourceCommit=${commit:0:9} digest=${art:0:12}…"
}

# 不起 HTTP、不 import gateway/registerCommercial。只证明该树自带的 tsx 能跑,
# 并对入口文件做 --check(语法/transform,不执行 top-level)。
assert_master_release_tsx_selfcheck() { # <rel>
  local rel="$1" out
  [[ -d "$rel/node_modules/tsx" ]] || die "tsx 自检: 缺 $rel/node_modules/tsx"
  out="$(cd "$rel" && npx --no-install tsx -e 'console.log("tsx-ok")')"
  [[ "$out" == "tsx-ok" ]] || die "tsx 自检失败(期望 tsx-ok): $out"
  # 只 transform、不 import 入口(cli/src/index.ts 会 parseAsync, commercial 会连 PG)。
  # node --import tsx --check 在 Node 20 对 .ts 报 ERR_UNKNOWN_FILE_EXTENSION,不用。
  out="$(cd "$rel" && npx --no-install tsx -e '
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
for (const f of [
  "packages/cli/src/index.ts",
  "packages/cli/src/commands/gateway.ts",
  "packages/commercial/src/index.ts",
  "packages/commercial/src/egress/main.ts",
  "packages/commercial/src/db/pgSessionsBackend.ts",
]) {
  transformSync(readFileSync(f, "utf8"), { loader: "ts", format: "esm", target: "es2022" });
}
console.log("transform-ok");
')"
  [[ "$out" == "transform-ok" ]] || die "tsx transform 自检失败: $out"
  mlog "  ✓ tsx 自检通过(无 HTTP)"
}

# OCV5-450: the detector lives in scripts/lib/v5-migration-ddl.sh (shared with the PR precheck).
# shellcheck source=scripts/lib/v5-migration-ddl.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/v5-migration-ddl.sh"

# git object 必须存在;diff 非 0 必须 fail-closed。禁止 || true 把坏 SHA 变成「无 migration」。
git_migration_name_diff() { # <from-commit> <to-commit>
  local from="$1" to="$2"
  [[ "$from" =~ ^[0-9a-f]{7,40}$ ]] || { mlog "迁移门: from 非法"; return 1; }
  [[ "$to" =~ ^[0-9a-f]{7,40}$ ]] || { mlog "迁移门: to 非法"; return 1; }
  git -C "$REPO_ROOT" cat-file -e "${from}^{commit}" \
    || { mlog "迁移门: from 不是存在的 commit: $from"; return 1; }
  git -C "$REPO_ROOT" cat-file -e "${to}^{commit}" \
    || { mlog "迁移门: to 不是存在的 commit: $to"; return 1; }
  git -C "$REPO_ROOT" diff --name-only "$from" "$to" -- '**/migrations/**'
}

# 只读比对 DB schema_migrations.version 与候选 requiredMigrations。不 apply。
# stdout: 缺失的 version 名,一行一个。查询失败 → rc 1。
read_required_migration_gap() { # <rel>
  local rel="$1" meta applied required
  meta="$rel/deploy/v5/release-metadata.json"
  [[ -f "$meta" ]] || { mlog "迁移门: 缺 $meta"; return 1; }
  if ! jq -e '.requiredMigrations | type == "array"' "$meta" >/dev/null 2>&1; then
    mlog "迁移门: requiredMigrations 不是数组(或字段缺失)。fail-closed。"
    return 1
  fi
  required="$(jq -er '.requiredMigrations[]' "$meta")" || {
    mlog "迁移门: 读取 requiredMigrations 失败"
    return 1
  }
  if ! command -v psql >/dev/null 2>&1; then
    mlog "迁移门: 缺 psql,无法只读查 schema_migrations"
    return 1
  fi
  if ! applied="$(sudo -u postgres psql -X -d "${PG_DB:-openclaude_v5_selfhost}" -tAc \
    "SELECT version FROM schema_migrations" 2>/dev/null)"; then
    mlog "迁移门: 只读查询 schema_migrations 失败(fail-closed)"
    return 1
  fi
  python3 - "$required" "$applied" <<'PY'
import sys
required = [x.strip() for x in sys.argv[1].splitlines() if x.strip()]
applied = set(x.strip() for x in sys.argv[2].splitlines() if x.strip())
missing = [x for x in required if x not in applied]
sys.stdout.write("\n".join(missing))
if missing:
    sys.stdout.write("\n")
PY
}

classify_pending_migration_file() { # <rel> <path-or-basename>
  local rel="$1" f="$2" base hit meta
  meta="$rel/deploy/v5/release-metadata.json"
  case "$f" in
    packages/commercial/src/db/migrations/*.sql)
      base="$(basename "$f" .sql)"
      ;;
    *.sql)
      base="$(basename "$f" .sql)"
      f="packages/commercial/src/db/migrations/${base}.sql"
      ;;
    *)
      if [[ "$f" == *_* && "$f" != */* ]]; then
        base="$f"
        f="packages/commercial/src/db/migrations/${base}.sql"
      else
        mlog "  迁移门: 跳过非 commercial runner 路径 $f"
        return 0
      fi
      ;;
  esac
  jq -e --arg n "$base" '.requiredMigrations | index($n) != null' "$meta" >/dev/null \
    || die "迁移门: $base 未列入 $meta requiredMigrations。拒绝 apply/翻转。"
  if [[ -f "$rel/$f" ]]; then
    if hit="$(sql_file_has_breaking_ddl "$rel/$f")"; then
      if [[ "${OC_V5_ALLOW_BREAKING_MIGRATION:-0}" == 1 ]]; then
        mlog "  ⚠ 破坏性 DDL 被 OC_V5_ALLOW_BREAKING_MIGRATION=1 放行: $f ($hit)"
      else
        die "迁移门: $f 命中破坏性 DDL($hit)。默认拒绝。确要放行设 OC_V5_ALLOW_BREAKING_MIGRATION=1(会写入日志)。"
      fi
    fi
  fi
}

# 显式判定本批次是否含 migration;破坏性 DDL 默认拒绝。
# 权威: DB schema_migrations 与候选 requiredMigrations 的缺口(不依赖工作树 .complete)。
# git diff 仅在存在 live 运行身份时做,且 fail-closed。
# 设置 CUTOVER_HAS_MIGRATION / CUTOVER_MIGRATION_FILES。
gate_cutover_migrations() { # <rel>
  local rel="$1" from_commit to_commit changed f gap live_root
  CUTOVER_HAS_MIGRATION=0
  CUTOVER_MIGRATION_FILES=""
  to_commit="$(jq -er '.sourceCommit' "$rel/.complete")"
  [[ "$to_commit" =~ ^[0-9a-f]{40}$ ]] || die "迁移门: to_commit 非法"
  git -C "$REPO_ROOT" cat-file -e "${to_commit}^{commit}" \
    || die "迁移门: to_commit 不是存在的 commit: $to_commit"

  if ! gap="$(read_required_migration_gap "$rel")"; then
    die "迁移门: requiredMigrations↔schema_migrations 缺口比对失败。fail-closed,不翻转。"
  fi
  if [[ -n "$gap" ]]; then
    CUTOVER_HAS_MIGRATION=1
    CUTOVER_MIGRATION_FILES="$gap"
    mlog "  迁移门: DB 缺口 HAS_MIGRATION=1 missing:"
    mlog "$gap"
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      classify_pending_migration_file "$rel" "$f"
    done <<<"$gap"
  else
    mlog "  迁移门: requiredMigrations 均已在 schema_migrations"
  fi

  from_commit=""
  if [[ -L "$MASTER_LIVE_LINK" ]]; then
    live_root="$(readlink -f "$MASTER_LIVE_LINK" 2>/dev/null || true)"
    if [[ -n "$live_root" && -f "$live_root/.complete" ]]; then
      from_commit="$(jq -er '.sourceCommit' "$live_root/.complete")"
    fi
  fi
  # 禁止把工作树 .complete 当运行证明。无 live 时只信 DB 缺口。
  if [[ -n "$from_commit" ]]; then
    [[ "$from_commit" =~ ^[0-9a-f]{40}$ ]] || die "迁移门: live sourceCommit 非法"
    git -C "$REPO_ROOT" cat-file -e "${from_commit}^{commit}" \
      || die "迁移门: live sourceCommit 不是存在的 commit: $from_commit"
    if ! changed="$(git_migration_name_diff "$from_commit" "$to_commit")"; then
      die "迁移门: git diff $from_commit..$to_commit 失败。fail-closed,禁止当成无 migration。"
    fi
    if [[ -n "$changed" ]]; then
      CUTOVER_HAS_MIGRATION=1
      if [[ -n "$CUTOVER_MIGRATION_FILES" ]]; then
        CUTOVER_MIGRATION_FILES="${CUTOVER_MIGRATION_FILES}"$'\n'"$changed"
      else
        CUTOVER_MIGRATION_FILES="$changed"
      fi
      mlog "  迁移门: live..候选 git diff 含 **/migrations/**"
      mlog "$changed"
      while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        classify_pending_migration_file "$rel" "$f"
      done <<<"$changed"
    fi
  else
    mlog "  迁移门: 无 live 运行身份,不以工作树 .complete 当 from;HAS_MIGRATION 只由 DB 缺口决定"
  fi

  if [[ "$CUTOVER_HAS_MIGRATION" == 1 ]]; then
    mlog "  ✓ 迁移门: 分类通过(含 migration 时 apply 必须与翻转同一把锁、同一窗口)"
  else
    mlog "  迁移门: HAS_MIGRATION=0"
  fi
}

resolve_cutover_release() { # uses CUTOVER_RELEASE / HEAD
  local head cand
  head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  if [[ -n "${CUTOVER_RELEASE:-}" ]]; then
    [[ "$CUTOVER_RELEASE" == /* ]] || die "--release 必须是绝对路径"
    [[ -d "$CUTOVER_RELEASE" && ! -L "$CUTOVER_RELEASE" ]] || die "--release 不是普通目录: $CUTOVER_RELEASE"
    if release_dir_is_poisoned "$CUTOVER_RELEASE"; then
      die "拒绝有毒 --release: $CUTOVER_RELEASE"
    fi
    printf '%s\n' "$CUTOVER_RELEASE"
    return 0
  fi
  [[ -d "$MASTER_RELEASES_ROOT" ]] || die "无 releases 根: $MASTER_RELEASES_ROOT"
  cand=""
  while IFS= read -r cand; do
    [[ -n "$cand" ]] || continue
    if release_dir_is_poisoned "$cand"; then
      continue
    fi
    [[ -f "$cand/.complete" ]] || continue
    if [[ "$(jq -er '.sourceCommit' "$cand/.complete" 2>/dev/null || true)" == "$head" ]]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done < <(find "$MASTER_RELEASES_ROOT" -mindepth 1 -maxdepth 1 -type d \
    -name 'rel-*' ! -name '*.poisoned' -printf '%T@\t%p\n' | sort -nr | cut -f2-)
  die "找不到 sourceCommit==HEAD($head) 的完整 master release。补救: 先 --build-master-only。"
}

atomic_flip_live_symlink() { # <target-abs-rel>  失败只 return,不 exit
  local target="$1" tmp
  [[ "$target" == "$MASTER_RELEASES_ROOT"/rel-* ]] || { mlog "live 目标不在 releases 根下: $target"; return 1; }
  [[ -d "$target" && ! -L "$target" ]] || { mlog "live 目标不是普通目录: $target"; return 1; }
  tmp="${MASTER_LIVE_LINK}.newlink.$$"
  rm -f -- "$tmp"
  ln -s -- "$target" "$tmp" || return 1
  if ! mv -T -- "$tmp" "$MASTER_LIVE_LINK"; then
    rm -f -- "$tmp"
    return 1
  fi
}

write_prev_release_file() { # <path-or-none>
  local val="$1" tmp
  tmp="$MASTER_RELEASES_ROOT/.prev-release.tmp.$$"
  mkdir -p -- "$MASTER_RELEASES_ROOT" || return 1
  printf '%s\n' "$val" >"$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -f -- "$tmp" "$MASTER_RELEASES_ROOT/.prev-release" || { rm -f -- "$tmp"; return 1; }
}

write_cutover_grace() {
  local until_ts
  until_ts=$(( $(date +%s) + CUTOVER_GRACE_SEC ))
  mkdir -p -- "$(dirname -- "$CUTOVER_GRACE_FILE")" || return 1
  printf 'until=%s\n' "$until_ts" >"$CUTOVER_GRACE_FILE" || return 1
}

# 一级回滚目标:canonicalize 真实路径、必须在 releases 根内、复算 strong digest。
canonicalize_prev_release() { # <raw> → stdout canon
  local raw="$1" canon root expected got
  [[ -n "$raw" && "$raw" != "none" && "$raw" != "NONE" ]] || return 1
  canon="$(readlink -f -- "$raw" 2>/dev/null || true)"
  [[ -n "$canon" && -d "$canon" && ! -L "$canon" ]] || return 1
  root="$(readlink -f -- "$MASTER_RELEASES_ROOT" 2>/dev/null || true)"
  [[ -n "$root" ]] || return 1
  case "$canon" in
    "${root}"/rel-*) ;;
    *)
      mlog "prev 不在 releases 根内: $canon"
      return 1
      ;;
  esac
  [[ "$canon" != *.poisoned ]] || return 1
  [[ -f "$canon/.complete" && ! -L "$canon/.complete" ]] || return 1
  expected="$(jq -er '.artifactSha256' "$canon/.complete" 2>/dev/null || true)"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  got="$(release_artifact_digest "$canon")" || return 1
  [[ "$got" == "$expected" ]] || { mlog "prev digest 复算不匹配 $canon"; return 1; }
  printf '%s\n' "$canon"
}

fsync_path() { # <file-or-dir>
  python3 - "$1" <<'PY'
import os, sys
p = sys.argv[1]
fd = os.open(p, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

# 从已过 digest 的候选 release 快照 unit 到 root-owned 临时目录。危险窗口只读这份。

# 解析已验证的工作树 unit 备份(二级回滚目标)。不更新任何指针。
resolve_worktree_unit_backup() {
  local cur real wd_m wd_e
  cur="${BREAKGLASS_ROOT}/unit-backups/worktree-current"
  if [[ -L "$cur" ]]; then
    real="$(readlink -f -- "$cur" 2>/dev/null || true)"
  elif [[ -d "$cur" && ! -L "$cur" ]]; then
    real="$cur"
  else
    return 1
  fi
  [[ -n "$real" && -d "$real" && ! -L "$real" ]] || return 1
  [[ -f "$real/${V5_UNIT}" && ! -L "$real/${V5_UNIT}" ]] || return 1
  [[ -f "$real/${V5_EGRESS_UNIT}" && ! -L "$real/${V5_EGRESS_UNIT}" ]] || return 1
  [[ "$(stat -c '%s' -- "$real/${V5_UNIT}")" -gt 0 ]] || return 1
  [[ "$(stat -c '%s' -- "$real/${V5_EGRESS_UNIT}")" -gt 0 ]] || return 1
  wd_m="$(unit_template_working_directory "$real/${V5_UNIT}")"
  wd_e="$(unit_template_working_directory "$real/${V5_EGRESS_UNIT}")"
  [[ "$wd_m" == /opt/openclaude/openclaude-v5-selfhost ]] || return 1
  [[ "$wd_e" == /opt/openclaude/openclaude-v5-selfhost ]] || return 1
  grep -q '^ExecStart=' "$real/${V5_UNIT}" || return 1
  grep -q '^ExecStart=' "$real/${V5_EGRESS_UNIT}" || return 1
  printf '%s\n' "$real"
}

# caller-provided 输出变量,不用会清 errexit 的命令替换。
# 每个写步骤显式检查。首次(installed WD=工作树):校验后原子更新 worktree-current。
# 后续(installed WD=live):只写 forensics 快照,不覆盖 worktree-current;
# dest_var 返回已有的工作树备份,供二级回滚使用。
backup_installed_units_for_cutover() { # <out-var>
  local dest_var="$1" ts dest wd_m wd_e tmp_link wt
  [[ "$dest_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  ts="$(date -u +%Y%m%d-%H%M%S)" || return 1
  dest="${BREAKGLASS_ROOT}/unit-backups/pre-cutover-${ts}"
  mkdir -p -- "$dest" || return 1
  cp -a -- "/etc/systemd/system/${V5_UNIT}" "$dest/" || return 1
  cp -a -- "/etc/systemd/system/${V5_EGRESS_UNIT}" "$dest/" || return 1
  # 双槽 egress 模板(已装才备;forensics 用,恢复脚本不依赖它们)。
  local sf
  for sf in "${V5_EGRESS_SLOT_SOCKET_TPL:-openclaude-v5-selfhost-egress@.socket}" \
            "${V5_EGRESS_SLOT_SERVICE_TPL:-openclaude-v5-selfhost-egress@.service}"; do
    if [[ -f "/etc/systemd/system/$sf" ]]; then
      cp -a -- "/etc/systemd/system/$sf" "$dest/" || return 1
    fi
  done
  if [[ -n "${UNIT_DIR:-}" && -f "${UNIT_DIR}/${V5_UNIT}" ]]; then
    cp -a -- "${UNIT_DIR}/${V5_UNIT}" "$dest/repo-${V5_UNIT}" || return 1
    cp -a -- "${UNIT_DIR}/${V5_EGRESS_UNIT}" "$dest/repo-${V5_EGRESS_UNIT}" || return 1
  fi
  [[ -f "$dest/${V5_UNIT}" && ! -L "$dest/${V5_UNIT}" ]] || return 1
  [[ -f "$dest/${V5_EGRESS_UNIT}" && ! -L "$dest/${V5_EGRESS_UNIT}" ]] || return 1
  [[ "$(stat -c '%s' -- "$dest/${V5_UNIT}")" -gt 0 ]] || return 1
  [[ "$(stat -c '%s' -- "$dest/${V5_EGRESS_UNIT}")" -gt 0 ]] || return 1
  wd_m="$(unit_template_working_directory "$dest/${V5_UNIT}")"
  wd_e="$(unit_template_working_directory "$dest/${V5_EGRESS_UNIT}")"
  grep -q '^ExecStart=' "$dest/${V5_UNIT}" || return 1
  grep -q '^ExecStart=' "$dest/${V5_EGRESS_UNIT}" || return 1
  printf 'backup=%s\ninstalled_master=%s\ninstalled_egress=%s\nwd_master=%s\nwd_egress=%s\n' \
    "$dest" "/etc/systemd/system/${V5_UNIT}" "/etc/systemd/system/${V5_EGRESS_UNIT}" \
    "$wd_m" "$wd_e" \
    >"$dest/MANIFEST.txt" || return 1
  fsync_path "$dest/${V5_UNIT}" || return 1
  fsync_path "$dest/${V5_EGRESS_UNIT}" || return 1
  fsync_path "$dest/MANIFEST.txt" || return 1
  fsync_path "$dest" || return 1
  mkdir -p -- "${BREAKGLASS_ROOT}/unit-backups" || return 1

  if [[ "$wd_m" == /opt/openclaude/openclaude-v5-selfhost \
     && "$wd_e" == /opt/openclaude/openclaude-v5-selfhost ]]; then
    tmp_link="${BREAKGLASS_ROOT}/unit-backups/worktree-current.new.$$"
    ln -sfn -- "$dest" "$tmp_link" || return 1
    mv -Tf -- "$tmp_link" "${BREAKGLASS_ROOT}/unit-backups/worktree-current" || {
      rm -f -- "$tmp_link"
      return 1
    }
    printf -v "$dest_var" '%s' "$dest"
    return 0
  fi

  if [[ "$wd_m" == "$MASTER_LIVE_LINK" && "$wd_e" == "$MASTER_LIVE_LINK" ]]; then
    # 二级补偿/幸存者必须用「本次切流前」这份 forensics。禁止再把 dest_var
    # 指回陈旧 worktree-current(2026-08-29 11:21 用 Aug18 工作树 unit 拉倒 18790)。
    mlog "  当前 unit 已是 live WD;forensics=$dest (本次切流备份,不改 worktree-current)"
    printf -v "$dest_var" '%s' "$dest"
    return 0
  fi

  mlog "backup: installed WD 既不是工作树也不是 live master='$wd_m' egress='$wd_e'"
  return 1
}

dist_oc_build() { # <rel>
  grep -o 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$1/packages/web-react/dist/index.html" \
    | grep -o '[0-9a-f]\{8,32\}' | head -1
}

run_migrations_from_release() { # <rel>  失败 return 1,不 exit(调用方走统一补偿)
  local rel="$1" url migration_pgoptions
  url="$(read_env_db_url)" || return 1
  assert_connected_db "$url" || return 1
  [[ -d "$rel/node_modules" ]] || { mlog "release 无 node_modules,无法跑 migration"; return 1; }
  migration_pgoptions="${PGOPTIONS:+${PGOPTIONS} }-c openclaude.migration_profile=v5-selfhost"
  if ! ( cd "$rel" && env PGOPTIONS="$migration_pgoptions" DATABASE_URL="$url" REDIS_URL="$REDIS_URL" \
      COMMERCIAL_ENABLED=1 COMMERCIAL_AUTO_MIGRATE=1 \
      npx --no-install tsx packages/commercial/src/db/migrate.ts ); then
    mlog "对着 release 跑 migration 失败。不翻转。不回滚 schema。"
    return 1
  fi
}


# Bootstrap the new executor even when the installed live worker predates the flag.
# Only the typed, exact-source registration can authorize this local CLI state.
cutover_adopt_inflight_request() { # <captured HEAD>
  local head="$1" views bind selected owner
  [[ "$DRY" == 1 ]] && return 0
  [[ "${PG_DB:-}" == openclaude_v5_selfhost ]] || return 2
  if [[ -z "${LEASE_TRAIN_ID:-}" ]]; then
    [[ "${ALLOW_INFLIGHT:-0}" == 0 ]] && return 0
    return 2
  fi
  lease_train_load_lib || return 2
  lease_valid_train_id "$LEASE_TRAIN_ID" && lease_valid_sha "$head" || return 2
  [[ "$head" == "$LEASE_TARGET_SHA" ]] || return 2
  views="$(lease_policy_views_sql deploy:selfhost)" || return 2
  bind="$(lease_inflight_bind_sql "$LEASE_TRAIN_ID" "$head" "deploy:$$")" || return 2
  # Validate the complete immutable binding before claiming or changing metadata.
  selected="$(lease_tx <<SQL
.bail on
BEGIN IMMEDIATE;
$views
$bind
SELECT count(*) FROM _li_selected;
ROLLBACK;
SQL
)" || return 2
  if [[ "$selected" == 0 ]]; then
    [[ "${ALLOW_INFLIGHT:-0}" == 0 ]] && return 0
    return 2
  fi
  [[ "$selected" =~ ^[1-9][0-9]*$ ]] || return 2
  owner="$(train_field "$LEASE_TRAIN_ID" owner)" || return 2
  [[ "$owner" =~ ^worker:[1-9][0-9]*$ ]] || return 2
  release_policy_lock_is_owned || return 86
  [[ "${LEASE_TRAIN_ACTIVE:-0}" == 1 ]] || lease_train_begin "$head"
  lease_tx <<SQL || return 2
.bail on
BEGIN IMMEDIATE;
$views
INSERT INTO _lp_guard SELECT CASE WHEN (SELECT count(*) FROM train
 WHERE id='$(lease_q "$LEASE_TRAIN_ID")' AND resource='deploy:selfhost'
 AND target_sha='$head' AND status='building' AND executor_pid=$$
 AND owner='$(lease_q "$owner")')=1 THEN 1 ELSE 0 END;
$bind
COMMIT;
SQL
  lease_inflight_train_allowed "$LEASE_TRAIN_ID" "$head" || return 2
  ALLOW_INFLIGHT=1
  log "  --allow-inflight: adopted exact-source registered permission; 用户 11:48 授权个人版不等在途请求"
}

# OCV5-513: wait after the build, before arming recovery or changing live units.
# This is an idle snapshot, not an admission fence; new arrivals can still race.
cutover_wait_for_user_idle() {
  local counts started=$SECONDS deadline=$((SECONDS + 600))
  if [[ "${ALLOW_INFLIGHT:-0}" == 1 ]]; then
    [[ "${PG_DB:-}" == openclaude_v5_selfhost ]] || { cutover_clog "  ✗ --allow-inflight 仅用于 selfhost"; return 1; }
    if [[ "$DRY" != 1 ]]; then
      if ! lease_train_load_lib || ! lease_inflight_train_allowed "${LEASE_TRAIN_ID:-}" "${LEASE_TARGET_SHA:-}"; then
        cutover_clog "  ✗ --allow-inflight 缺少正式列车的精确源授权;拒绝切换"
        return 1
      fi
    fi
    cutover_clog "  --allow-inflight: 跳过个人版600s空闲/在途检查;用户已接受在途回合可能中断"
    return 0
  fi
  if [[ "$DRY" == 1 ]]; then
    cutover_clog "  [dry-run] 切换前等待全部用户回合结束(只读,最多 600s;不查询数据库)"
    return 0
  fi
  while :; do
    if ! counts="$(psql_as_postgres -d "dbname=$PG_DB connect_timeout=5" -qAt -c "
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT
  (SELECT count(*) FROM turn_dispatches WHERE status IN ('admitted','accepted','rejecting')),
  (SELECT count(*) FROM request_finalize_journal j
   WHERE j.state NOT IN ('aborted','committed') AND NOT EXISTS (
     SELECT 1 FROM turn_dispatches d WHERE d.dispatch_id=j.dispatch_id
       AND d.status='terminal' AND d.terminal_at IS NOT NULL));
COMMIT;")"; then
      cutover_clog "  ✗ 无法只读确认用户空闲;拒绝切换,旧 master 继续运行"
      return 1
    fi
    if [[ ! "$counts" =~ ^[0-9]+\|[0-9]+$ ]]; then
      cutover_clog "  ✗ 空闲查询结果无效;拒绝切换,旧 master 继续运行"
      return 1
    fi
    cutover_clog "  idle snapshot UTC=$(date -u +%FT%TZ) open_dispatches=${counts%|*} unclassified_journals=${counts#*|} elapsed=$((SECONDS - started))s"
    [[ "$counts" == '0|0' ]] && return 0
    if (( SECONDS >= deadline )); then
      cutover_clog "  ✗ 等待空闲 600s 超时;拒绝切换,旧 master 继续运行"
      return 1
    fi
    sleep 5
  done
}
