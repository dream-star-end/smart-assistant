#!/usr/bin/env bash
# Shared read-only admission snapshot for the selfhost worker and build gates.
MASTER_BOX_GATE_LOAD_MAX=8  # 16 cores / 2; existing OCV5-557 admission threshold
MASTER_GATE_LOADAVG="${MASTER_GATE_LOADAVG:-/proc/loadavg}"
MASTER_GATE_TEST_LOCK_DIR="${MASTER_GATE_TEST_LOCK_DIR:-/var/lock}"
MASTER_GATE_PROC_ROOT="${MASTER_GATE_PROC_ROOT:-/proc}"

master_gate_load1() {
  local a="" rest=""
  read -r a rest <"$MASTER_GATE_LOADAVG" 2>/dev/null || a=""
  [[ "$a" =~ ^[0-9]+(\.[0-9]+)?$ ]] && printf '%s' "$a"
  return 0
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
