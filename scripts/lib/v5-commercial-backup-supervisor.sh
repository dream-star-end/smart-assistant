#!/usr/bin/env bash
# Execution supervision only: all lease ownership/qualification stays in the official helpers.
backup_start() {
  local raw=""
  IFS= read -r -d '' raw 2>/dev/null <"/proc/$1/stat" || [[ -n "$raw" ]] || return 1
  raw="${raw##*) }"; set -- $raw
  [[ $# -ge 20 ]] || return 1
  printf '%s' "${20}"
}
backup_same() { [[ "$(backup_start "$1")" == "$2" ]] && kill -0 "$1" 2>/dev/null; }
backup_live() {
  local raw="" state
  backup_same "$1" "$2" || return 1
  IFS= read -r -d '' raw 2>/dev/null <"/proc/$1/stat" || [[ -n "$raw" ]] || return 1
  raw="${raw##*) }"; state="${raw%% *}"
  [[ "$state" != Z && "$state" != X && "$state" != x && "$state" != T && "$state" != t ]]
}
backup_kill_body() {
  # The body is this invocation's dedicated process group; an unreaped leader keeps its identity.
  if backup_same "$1" "$2"; then kill -KILL -- "-$1" 2>/dev/null || true; fi
}
backup_remove_marker() {
  if [[ ! -L "$MARKER" ]] && grep -q "^pid=$1 " "$MARKER" 2>/dev/null; then rm -f -- "$MARKER"; fi
}
backup_watch() { # private-dir supervisor-pid supervisor-start
  local state="$1" parent="$2" start="$3" body="" body_start=""
  : >"$state/ready"
  while :; do
    if [[ -s "$state/body" ]]; then read -r body body_start <"$state/body"; fi
    if ! backup_live "$parent" "$start" || ! qualify_lease; then
      if [[ -n "$body" ]]; then
        backup_kill_body "$body" "$body_start"
        backup_remove_marker "$body"
      fi
      return 1
    fi
    [[ -z "$body" ]] || backup_live "$body" "$body_start" || return 0
    sleep 1
  done
}
backup_supervise() {
  local state parent_start watch watch_start body="" body_start="" completed="" rc=1
  state=$(mktemp -d "${LOCK_FILE}.supervisor.XXXXXX") || return 1
  parent_start=$(backup_start "$$") || return 1
  # Start the independent guardian before creating a body. It closes the backup lock fd.
  ( exec 9>&-; exec setsid bash "$0" __watch "$state" "$$" "$parent_start" ) &
  watch=$!; watch_start=$(backup_start "$watch") || return 1
  backup_supervisor_cleanup() {
    if [[ -n "$body" ]]; then backup_kill_body "$body" "$body_start"; backup_remove_marker "$body"; fi
    if backup_same "$watch" "$watch_start"; then kill -KILL "$watch" 2>/dev/null || true; fi
    wait "$watch" 2>/dev/null || true
    rm -rf -- "$state"
  }
  trap backup_supervisor_cleanup EXIT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  trap 'exit 130' INT
  while [[ ! -e "$state/ready" ]]; do
    backup_live "$watch" "$watch_start" || return 1
    sleep 0.02
  done
  # A gate prevents the spawn->identity-write window from starting pg_dump after parent death.
  set -m
  V5CB_SUPERVISOR_PID=$$ V5CB_GUARDIAN_PID=$watch bash "$0" __body "$state" "$$" "$parent_start" &
  body=$!
  set +m
  body_start=$(backup_start "$body") || return 1
  printf '%s %s\n' "$body" "$body_start" >"$state/body"
  : >"$state/go"
  if wait -n -p completed "$body" "$watch"; then rc=0; else rc=$?; fi
  if [[ "$completed" == "$watch" ]]; then
    backup_kill_body "$body" "$body_start"
    wait "$body" 2>/dev/null || true
    rc=1
  fi
  backup_remove_marker "$body"
  body=""
  backup_supervisor_cleanup
  trap - EXIT INT TERM HUP
  return "$rc"
}
