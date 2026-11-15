#!/usr/bin/env bash
# OpenClaude V5 selfhost harness autosave wrapper (OCV5-751).
# Guards .git ownership before running git as the agent uid/gid, commits and
# pushes dirty changes, logs failures to syslog, and writes an atomic JSON
# status receipt for v5-selfhost-watch.sh.
set -euo pipefail

AUTOSAVE_CONTAINER="${AUTOSAVE_CONTAINER:-oc-v5-u3}"
AUTOSAVE_REPO_DIR="${AUTOSAVE_REPO_DIR:-/home/agent/.openclaude}"
AUTOSAVE_AGENT_UID="${AUTOSAVE_AGENT_UID:-1000}"
AUTOSAVE_AGENT_GID="${AUTOSAVE_AGENT_GID:-1000}"
AUTOSAVE_REMOTE="${AUTOSAVE_REMOTE:-origin}"
AUTOSAVE_BRANCH="${AUTOSAVE_BRANCH:-main}"
AUTOSAVE_STATUS_FILE="${AUTOSAVE_STATUS_FILE:-/var/lib/openclaude-v5-selfhost/harness-autosave-status.json}"
AUTOSAVE_LOCK_FILE="${AUTOSAVE_LOCK_FILE:-/run/openclaude-v5-selfhost/harness-autosave.lock}"
AUTOSAVE_DOCKER_BIN="${AUTOSAVE_DOCKER_BIN:-docker}"
AUTOSAVE_LOGGER_BIN="${AUTOSAVE_LOGGER_BIN:-logger}"
AUTOSAVE_NOW_ISO="${AUTOSAVE_NOW_ISO:-}"

usage() {
  cat <<'EOF'
Usage: v5-selfhost-harness-autosave.sh [--once|--status|-h|--help]
  --once    Acquire lock, verify/heal .git ownership, add/commit/push as agent uid/gid, write status JSON (default).
  --status  Print status JSON if present, otherwise { "installed": false }.
  -h,--help Show this help message.
EOF
}

now_iso() {
  if [[ -n "$AUTOSAVE_NOW_ISO" ]]; then
    printf '%s\n' "$AUTOSAVE_NOW_ISO"
  else
    date -u +%Y-%m-%dT%H:%M:%SZ
  fi
}

sanitize_err() {
  printf '%s' "${1:-}" \
    | tr '\r\n\t' '   ' \
    | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' \
    | cut -c1-300
}

log_fail() {
  local msg="$1"
  printf '%s [oc-autosave-fail] %s\n' "$(now_iso)" "$msg" >&2
  if command -v "$AUTOSAVE_LOGGER_BIN" >/dev/null 2>&1 || [[ -x "$AUTOSAVE_LOGGER_BIN" ]]; then
    "$AUTOSAVE_LOGGER_BIN" -t oc-autosave-fail "$msg" || true
  fi
}

git_agent() {
  "$AUTOSAVE_DOCKER_BIN" exec -u "${AUTOSAVE_AGENT_UID}:${AUTOSAVE_AGENT_GID}" "$AUTOSAVE_CONTAINER" \
    git -C "$AUTOSAVE_REPO_DIR" "$@"
}

write_status_json() {
  local checked_at="$1"
  local last_ok_at="$2"
  local last_commit_at="$3"
  local last_commit_sha="$4"
  local dirty_count="$5"
  local dirty_since="$6"
  local non_agent_entries="$7"
  local last_healed_at="$8"
  local last_healed_count="$9"
  local last_fail_at="${10}"
  local last_error="${11}"
  local consecutive_failures="${12}"

  local status_dir tmp_file
  status_dir="$(dirname -- "$AUTOSAVE_STATUS_FILE")"
  mkdir -p -- "$status_dir"
  tmp_file="$(mktemp -p "$status_dir" .harness-autosave-status.XXXXXX)"
  if ! jq -n \
    --arg checkedAt "$checked_at" \
    --arg lastOkAt "$last_ok_at" \
    --arg lastCommitAt "$last_commit_at" \
    --arg lastCommitSha "$last_commit_sha" \
    --argjson dirtyCount "$dirty_count" \
    --arg dirtySince "$dirty_since" \
    --argjson nonAgentGitEntries "$non_agent_entries" \
    --arg lastHealedAt "$last_healed_at" \
    --argjson lastHealedCount "$last_healed_count" \
    --arg lastFailAt "$last_fail_at" \
    --arg lastError "$last_error" \
    --argjson consecutiveFailures "$consecutive_failures" \
    '{
      schema: 1,
      checkedAt: $checkedAt,
      lastOkAt: (if $lastOkAt == "" then null else $lastOkAt end),
      lastCommitAt: (if $lastCommitAt == "" then null else $lastCommitAt end),
      lastCommitSha: (if $lastCommitSha == "" then null else $lastCommitSha end),
      dirtyCount: $dirtyCount,
      dirtySince: (if $dirtySince == "" then null else $dirtySince end),
      nonAgentGitEntries: $nonAgentGitEntries,
      lastHealedAt: (if $lastHealedAt == "" then null else $lastHealedAt end),
      lastHealedCount: $lastHealedCount,
      lastFailAt: (if $lastFailAt == "" then null else $lastFailAt end),
      lastError: (if $lastError == "" then null else $lastError end),
      consecutiveFailures: $consecutiveFailures
    }' >"$tmp_file"; then
    rm -f -- "$tmp_file"
    return 1
  fi
  if ! chmod 0644 -- "$tmp_file" || ! mv -T -- "$tmp_file" "$AUTOSAVE_STATUS_FILE"; then
    rm -f -- "$tmp_file"
    return 1
  fi
}

cmd_status() {
  if [[ -f "$AUTOSAVE_STATUS_FILE" && ! -L "$AUTOSAVE_STATUS_FILE" ]]; then
    cat -- "$AUTOSAVE_STATUS_FILE"
  else
    printf '{ "installed": false }\n'
  fi
}

cmd_once() {
  mkdir -p -- "$(dirname -- "$AUTOSAVE_LOCK_FILE")"
  exec 9>"$AUTOSAVE_LOCK_FILE"
  if ! flock -n 9; then
    exit 0
  fi

  local err_tmp
  err_tmp="$(mktemp)"
  trap 'rm -f -- "'"$err_tmp"'"' EXIT

  local checked_at
  checked_at="$(now_iso)"

  local prev_last_ok_at="" prev_last_commit_at="" prev_last_commit_sha=""
  local prev_dirty_since="" prev_last_healed_at="" prev_last_healed_count=0
  local prev_last_fail_at="" prev_consecutive_failures=0

  if [[ -f "$AUTOSAVE_STATUS_FILE" && ! -L "$AUTOSAVE_STATUS_FILE" ]]; then
    prev_last_ok_at="$(jq -r '.lastOkAt // empty' "$AUTOSAVE_STATUS_FILE" 2>/dev/null || true)"
    prev_last_commit_at="$(jq -r '.lastCommitAt // empty' "$AUTOSAVE_STATUS_FILE" 2>/dev/null || true)"
    prev_last_commit_sha="$(jq -r '.lastCommitSha // empty' "$AUTOSAVE_STATUS_FILE" 2>/dev/null || true)"
    prev_dirty_since="$(jq -r '.dirtySince // empty' "$AUTOSAVE_STATUS_FILE" 2>/dev/null || true)"
    prev_last_healed_at="$(jq -r '.lastHealedAt // empty' "$AUTOSAVE_STATUS_FILE" 2>/dev/null || true)"
    prev_last_healed_count="$(jq -r '(.lastHealedCount // 0) | if type == "number" then floor else 0 end' "$AUTOSAVE_STATUS_FILE" 2>/dev/null || echo 0)"
    prev_last_fail_at="$(jq -r '.lastFailAt // empty' "$AUTOSAVE_STATUS_FILE" 2>/dev/null || true)"
    prev_consecutive_failures="$(jq -r '(.consecutiveFailures // 0) | if type == "number" then floor else 0 end' "$AUTOSAVE_STATUS_FILE" 2>/dev/null || echo 0)"
  fi
  [[ "$prev_last_healed_count" =~ ^[0-9]+$ ]] || prev_last_healed_count=0
  [[ "$prev_consecutive_failures" =~ ^[0-9]+$ ]] || prev_consecutive_failures=0

  local healed_this_run=0

  fail_and_exit() {
    local err_msg="$1"
    local non_agent_entries="${2:-0}"
    local dirty_count=0 porcelain_out="" rc=0 dirty_since="" healed_at="" healed_count=0 consec=0

    set +e
    porcelain_out="$(git_agent status --porcelain 2>/dev/null)"
    rc=$?
    set -e
    if (( rc == 0 )) && [[ -n "$porcelain_out" ]]; then
      dirty_count="$(printf '%s\n' "$porcelain_out" | grep -c . || true)"
    fi

    if (( dirty_count > 0 )); then
      if [[ -n "$prev_dirty_since" ]]; then
        dirty_since="$prev_dirty_since"
      else
        dirty_since="$checked_at"
      fi
    fi

    if (( healed_this_run > 0 )); then
      healed_at="$checked_at"
      healed_count="$healed_this_run"
    else
      healed_at="$prev_last_healed_at"
      healed_count="$prev_last_healed_count"
    fi

    consec=$(( prev_consecutive_failures + 1 ))
    log_fail "$err_msg"
    write_status_json \
      "$checked_at" \
      "$prev_last_ok_at" \
      "$prev_last_commit_at" \
      "$prev_last_commit_sha" \
      "$dirty_count" \
      "$dirty_since" \
      "$non_agent_entries" \
      "$healed_at" \
      "$healed_count" \
      "$checked_at" \
      "$err_msg" \
      "$consec" || true
    exit 1
  }

  local find_out="" find_rc=0 non_agent_count=0
  set +e
  find_out="$("$AUTOSAVE_DOCKER_BIN" exec -u 0 "$AUTOSAVE_CONTAINER" find "$AUTOSAVE_REPO_DIR/.git" ! -user "$AUTOSAVE_AGENT_UID" -print 2>"$err_tmp")"
  find_rc=$?
  set -e
  if (( find_rc != 0 )); then
    fail_and_exit "$(sanitize_err "ownership check failed (exit $find_rc): $(cat "$err_tmp")")" 0
  fi
  if [[ -n "$find_out" ]]; then
    non_agent_count="$(printf '%s\n' "$find_out" | grep -c . || true)"
  fi

  if (( non_agent_count > 0 )); then
    log_fail "detected ${non_agent_count} non-uid-${AUTOSAVE_AGENT_UID} entries in ${AUTOSAVE_REPO_DIR}/.git; healing ownership"
    local chown_rc=0 recheck_out="" recheck_rc=0 remaining=0
    set +e
    "$AUTOSAVE_DOCKER_BIN" exec -u 0 "$AUTOSAVE_CONTAINER" find "$AUTOSAVE_REPO_DIR/.git" ! -user "$AUTOSAVE_AGENT_UID" -exec chown -h "${AUTOSAVE_AGENT_UID}:${AUTOSAVE_AGENT_GID}" {} + >/dev/null 2>"$err_tmp"
    chown_rc=$?
    set -e
    if (( chown_rc != 0 )); then
      local chown_err
      chown_err="$(sanitize_err "ownership heal failed (exit $chown_rc): $(cat "$err_tmp")")"
      set +e
      recheck_out="$("$AUTOSAVE_DOCKER_BIN" exec -u 0 "$AUTOSAVE_CONTAINER" find "$AUTOSAVE_REPO_DIR/.git" ! -user "$AUTOSAVE_AGENT_UID" -print 2>/dev/null)"
      recheck_rc=$?
      set -e
      if (( recheck_rc == 0 )); then
        if [[ -n "$recheck_out" ]]; then
          remaining="$(printf '%s\n' "$recheck_out" | grep -c . || true)"
        else
          remaining=0
        fi
      else
        remaining="$non_agent_count"
      fi
      fail_and_exit "$chown_err" "$remaining"
    fi

    set +e
    recheck_out="$("$AUTOSAVE_DOCKER_BIN" exec -u 0 "$AUTOSAVE_CONTAINER" find "$AUTOSAVE_REPO_DIR/.git" ! -user "$AUTOSAVE_AGENT_UID" -print 2>"$err_tmp")"
    recheck_rc=$?
    set -e
    if (( recheck_rc != 0 )); then
      fail_and_exit "$(sanitize_err "ownership recheck failed (exit $recheck_rc): $(cat "$err_tmp")")" "$non_agent_count"
    fi
    if [[ -n "$recheck_out" ]]; then
      remaining="$(printf '%s\n' "$recheck_out" | grep -c . || true)"
    fi
    if (( remaining > 0 )); then
      fail_and_exit "$(sanitize_err "ownership heal incomplete: ${remaining} non-uid-${AUTOSAVE_AGENT_UID} entries remain in ${AUTOSAVE_REPO_DIR}/.git")" "$remaining"
    fi
    healed_this_run="$non_agent_count"
  fi

  local rc=0 diff_rc=0
  set +e
  git_agent add -A >/dev/null 2>"$err_tmp"
  rc=$?
  set -e
  if (( rc != 0 )); then
    fail_and_exit "$(sanitize_err "git add -A failed (exit $rc): $(cat "$err_tmp")")" 0
  fi

  set +e
  git_agent diff --cached --quiet >/dev/null 2>"$err_tmp"
  diff_rc=$?
  set -e
  if (( diff_rc == 1 )); then
    local commit_msg
    commit_msg="autosave $(date +%F_%T)"
    set +e
    git_agent commit -q -m "$commit_msg" >/dev/null 2>"$err_tmp"
    rc=$?
    set -e
    if (( rc != 0 )); then
      fail_and_exit "$(sanitize_err "git commit failed (exit $rc): $(cat "$err_tmp")")" 0
    fi
  elif (( diff_rc != 0 )); then
    fail_and_exit "$(sanitize_err "git diff --cached --quiet failed (exit $diff_rc): $(cat "$err_tmp")")" 0
  fi

  set +e
  git_agent push -q "$AUTOSAVE_REMOTE" "$AUTOSAVE_BRANCH" >/dev/null 2>"$err_tmp"
  rc=$?
  set -e
  if (( rc != 0 )); then
    fail_and_exit "$(sanitize_err "git push failed (exit $rc): $(cat "$err_tmp")")" 0
  fi

  local commit_sha="" commit_at="" porcelain_out="" dirty_count=0
  set +e
  commit_sha="$(git_agent rev-parse HEAD 2>"$err_tmp")"
  rc=$?
  set -e
  if (( rc != 0 )); then
    fail_and_exit "$(sanitize_err "git rev-parse HEAD failed (exit $rc): $(cat "$err_tmp")")" 0
  fi
  commit_sha="$(printf '%s' "$commit_sha" | tr -d '\r\n')"

  set +e
  commit_at="$(git_agent log -1 --format=%cI HEAD 2>"$err_tmp")"
  rc=$?
  set -e
  if (( rc != 0 )); then
    fail_and_exit "$(sanitize_err "git log failed (exit $rc): $(cat "$err_tmp")")" 0
  fi
  commit_at="$(printf '%s' "$commit_at" | tr -d '\r\n')"

  set +e
  porcelain_out="$(git_agent status --porcelain 2>"$err_tmp")"
  rc=$?
  set -e
  if (( rc != 0 )); then
    fail_and_exit "$(sanitize_err "git status --porcelain failed (exit $rc): $(cat "$err_tmp")")" 0
  fi
  if [[ -n "$porcelain_out" ]]; then
    dirty_count="$(printf '%s\n' "$porcelain_out" | grep -c . || true)"
  fi

  local dirty_since="" healed_at="" healed_count=0
  if (( dirty_count > 0 )); then
    if [[ -n "$prev_dirty_since" ]]; then
      dirty_since="$prev_dirty_since"
    else
      dirty_since="$checked_at"
    fi
  fi

  if (( healed_this_run > 0 )); then
    healed_at="$checked_at"
    healed_count="$healed_this_run"
  else
    healed_at="$prev_last_healed_at"
    healed_count="$prev_last_healed_count"
  fi

  write_status_json \
    "$checked_at" \
    "$checked_at" \
    "$commit_at" \
    "$commit_sha" \
    "$dirty_count" \
    "$dirty_since" \
    0 \
    "$healed_at" \
    "$healed_count" \
    "$prev_last_fail_at" \
    "" \
    0
}

main() {
  local mode="once"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --once) mode="once"; shift ;;
      --status) mode="status"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
  done
  case "$mode" in
    once) cmd_once ;;
    status) cmd_status ;;
  esac
}

main "$@"
