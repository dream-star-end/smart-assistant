#!/usr/bin/env bash
# Read-only admission on the build host, before taking the production mutation lease.

v5_host_admission_busy_reason() {
  local load="" rest="" f pid cmd rc name
  local reasons=() args=()
  { read -r load rest <"${V5_HOST_ADMISSION_LOADAVG:-/proc/loadavg}"; } 2>/dev/null || load=""
  if [[ ! "$load" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    reasons+=("load1=unreadable")
  elif awk -v l="$load" 'BEGIN { exit !(l >= 8) }'; then
    reasons+=("load1=$load>=8")
  fi
  for f in "${V5_HOST_ADMISSION_LOCK_DIR:-/var/lock}"/oc-test-*.lock; do
    [[ -f "$f" && ! -L "$f" ]] || continue
    # Open an existing file read-only. flock's pathname form could create a file
    # if it disappeared between the check and the probe.
    rc=0
    ( flock -n -E 75 9 ) 2>/dev/null 9<"$f" || rc=$?
    [[ "$rc" == 75 ]] || continue
    name="${f##*/oc-test-}"
    reasons+=("test-mutex:${name%.lock}")
  done
  for f in "${V5_HOST_ADMISSION_PROC_ROOT:-/proc}"/[0-9]*/cmdline; do
    pid="${f%/cmdline}"; pid="${pid##*/}"
    [[ "$pid" != "$$" && "$pid" != "${BASHPID:-}" ]] || continue
    args=()
    { mapfile -d '' -t args <"$f"; } 2>/dev/null || continue
    (( ${#args[@]} > 0 )) || continue
    cmd=" ${args[*]} "
    if [[ "$cmd" =~ [[:space:]/]npm(-cli\.js)?[[:space:]]+(test|run[[:space:]]+(test|check:v5)[^[:space:]]*)[[:space:]] ]]; then
      reasons+=("pid$pid:${BASH_REMATCH[0]//[[:space:]]/ }")
    fi
  done
  (( ${#reasons[@]} == 0 )) || printf '%s' "${reasons[*]:0:6}"
  return 0
}

v5_host_admission_wait() {
  local started now reason
  started="$(date +%s)"
  while :; do
    reason="$(v5_host_admission_busy_reason)"
    now="$(date +%s)"
    if [[ -z "$reason" ]]; then
      printf '  主机空闲，候选构建准入等了 %ss\n' "$((now - started))" >&2
      return 0
    fi
    if (( now - started >= ${V5_HOST_ADMISSION_TIMEOUT_S:-900} )); then
      printf '✗ 主机持续繁忙 %ss，候选构建不发车：%s\n' "$((now - started))" "$reason" >&2
      return 1
    fi
    printf '  ⏳ 主机繁忙，候选构建暂不发车（已等 %ss）：%s\n' "$((now - started))" "$reason" >&2
    sleep "${V5_HOST_ADMISSION_POLL_S:-15}" || return 1
  done
}

v5_host_admission_for_mode() {
  [[ "${DRY:-0}" != 1 ]] || return 0
  case "${MODE:-}" in
    deploy|dist) v5_host_admission_wait ;;
    canary) [[ -n "${CANARY_RELEASE:-}" ]] || v5_host_admission_wait ;;
    *) return 0 ;;
  esac
}
