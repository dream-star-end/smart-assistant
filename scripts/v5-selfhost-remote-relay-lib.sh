# shellcheck shell=bash
# OCV5-855: V5 selfhost independent blue-green remote-relay orchestration library.
#
# Locked contract:
#   - Unit template : openclaude-v5-selfhost-remote-relay@.service (slot %i = A|B)
#   - Slot sockets  : /run/openclaude-v5-selfhost/remote-relay-{A,B}.sock
#   - Active symlink: /run/openclaude-v5-selfhost/remote-relay-active.sock -> remote-relay-{A,B}.sock
#   - State file    : /var/lib/openclaude-v5-selfhost/remote-relay-state.json
#   - Auth          : x-oc-egress-secret passed strictly via stdin `curl -K -` (never argv)
#   - Endpoints     : GET /healthz, POST /drain-begin, POST /drain

[[ -n "${__OC_SELFHOST_REMOTE_RELAY_LIB_LOADED:-}" ]] && return 0
__OC_SELFHOST_REMOTE_RELAY_LIB_LOADED=1

V5_REMOTE_RELAY_SLOT_TPL="${V5_REMOTE_RELAY_SLOT_TPL:-openclaude-v5-selfhost-remote-relay@.service}"
V5_REMOTE_RELAY_SOCK_PREFIX="${V5_REMOTE_RELAY_SOCK_PREFIX:-${OC_REMOTE_RELAY_SLOT_SOCK_PREFIX:-/run/openclaude-v5-selfhost/remote-relay}}"
V5_REMOTE_RELAY_ACTIVE_SOCK="${V5_REMOTE_RELAY_ACTIVE_SOCK:-${OC_REMOTE_RELAY_SOCKET:-/run/openclaude-v5-selfhost/remote-relay-active.sock}}"
V5_REMOTE_RELAY_STATE_FILE="${V5_REMOTE_RELAY_STATE_FILE:-${OC_REMOTE_RELAY_STATE_FILE:-/var/lib/openclaude-v5-selfhost/remote-relay-state.json}}"
V5_REMOTE_RELAY_LOG="${V5_REMOTE_RELAY_LOG:-/var/log/openclaude-v5-selfhost-remote-relay.log}"

remote_relay_log() {
  if declare -F cutover_clog >/dev/null 2>&1; then
    cutover_clog "$*"
  else
    printf '%s\n' "$*" >&2
  fi
}

remote_relay_valid_slot() { [[ "${1:-}" == "A" || "${1:-}" == "B" ]]; }

remote_relay_other_slot() {
  case "${1:-}" in
    A) printf 'B' ;;
    B) printf 'A' ;;
    *) return 1 ;;
  esac
}

remote_relay_slot_unit() { # <A|B>
  remote_relay_valid_slot "${1:-}" || return 1
  printf '%s' "${V5_REMOTE_RELAY_SLOT_TPL/@./@$1.}"
}

remote_relay_slot_sock() { # <A|B>
  remote_relay_valid_slot "${1:-}" || return 1
  printf '%s-%s.sock' "$V5_REMOTE_RELAY_SOCK_PREFIX" "$1"
}

remote_relay_slot_is_active() { # <A|B>
  local unit
  unit="$(remote_relay_slot_unit "${1:-}")" || return 1
  [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" == "active" ]]
}

remote_relay_any_slot_active() {
  remote_relay_slot_is_active A || remote_relay_slot_is_active B
}

remote_relay_live_release_has_unit() {
  local live
  live="$(readlink -f -- "${MASTER_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}" 2>/dev/null || true)"
  [[ -n "$live" && -f "$live/deploy/v5-selfhost/$V5_REMOTE_RELAY_SLOT_TPL" ]]
}

# Atomically install remote-relay@.service template from <dir> (returns 0 on install, 2 if absent).
install_remote_relay_slot_unit_from() { # <src-dir>
  local dir="$1" src dst_dir tmp
  src="${dir}/${V5_REMOTE_RELAY_SLOT_TPL}"
  [[ -f "$src" ]] || return 2
  if [[ "${DRY:-0}" == 1 ]]; then
    remote_relay_log "  [dry-run] install $src → ${V5_SYSTEMD_DIR:-/etc/systemd/system}/${V5_REMOTE_RELAY_SLOT_TPL}"
    return 0
  fi
  dst_dir="${V5_SYSTEMD_DIR:-/etc/systemd/system}"
  mkdir -p -- "$dst_dir" || return 1
  tmp="$(mktemp "${dst_dir}/.${V5_REMOTE_RELAY_SLOT_TPL}.XXXXXX")" || return 1
  if ! cp -- "$src" "$tmp" || ! chmod 0644 "$tmp" || ! mv -Tf -- "$tmp" "${dst_dir}/${V5_REMOTE_RELAY_SLOT_TPL}"; then
    rm -f -- "$tmp"
    return 1
  fi
  return 0
}

remote_relay_read_egress_secret() {
  if declare -F selfhost_read_egress_secret >/dev/null 2>&1; then
    selfhost_read_egress_secret
    return $?
  fi
  if [[ -n "${OC_EGRESS_SECRET:-}" ]]; then
    printf '%s' "$OC_EGRESS_SECRET"
    return 0
  fi
  local env_file="${V5_ENV:-/etc/openclaude/commercial-v5-selfhost.env}"
  [[ -r "$env_file" ]] || return 1
  local line val
  line="$(grep -E '^OC_EGRESS_SECRET=' "$env_file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  val="${line#OC_EGRESS_SECRET=}"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  [[ -n "$val" ]] || return 1
  printf '%s' "$val"
}

remote_relay_mark_recovery() { # <reason> [detail]
  local reason="$1" detail="${2:-}"
  if declare -F selfhost_mark_dual_slot_recovery_required >/dev/null 2>&1; then
    selfhost_mark_dual_slot_recovery_required "$reason" "$detail"
  else
    remote_relay_log "  ✗ recovery_required (${reason}): ${detail}"
  fi
}

# B10: fsync a file or directory (uses fsync_path if available, else python3 os.fsync).
remote_relay_fsync_path() { # <path>
  local p="$1"
  if declare -F fsync_path >/dev/null 2>&1; then
    fsync_path "$p"
    return $?
  fi
  python3 -B - "$p" <<'PY'
import os, sys
p = sys.argv[1]
flags = os.O_RDONLY | (getattr(os, "O_DIRECTORY", 0) if os.path.isdir(p) else 0)
fd = os.open(p, flags)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

# B10: Persistent active slot state file helpers (fsync temp file BEFORE rename + fsync dir AFTER).
remote_relay_write_state_atomic() { # <A|B> <instanceId>
  local slot="$1" inst="$2" dir tmp json
  remote_relay_valid_slot "$slot" || return 1
  [[ -n "$inst" ]] || return 1
  json="$(jq -cn --arg s "$slot" --arg id "$inst" --arg at "$(date -u +%FT%TZ)" \
    '{version:1,migrated:true,activeSlot:$s,instanceId:$id,switchedAt:$at}')" || return 1
  dir="$(dirname -- "$V5_REMOTE_RELAY_STATE_FILE")"
  mkdir -p -- "$dir" || return 1
  tmp="$(mktemp "${V5_REMOTE_RELAY_STATE_FILE}.tmp.XXXXXX")" || return 1
  if ! printf '%s\n' "$json" >"$tmp" \
     || ! chmod 0644 "$tmp" \
     || ! remote_relay_fsync_path "$tmp" \
     || ! mv -Tf -- "$tmp" "$V5_REMOTE_RELAY_STATE_FILE" \
     || ! remote_relay_fsync_path "$dir"; then
    rm -f -- "$tmp"
    return 1
  fi
  return 0
}

remote_relay_restore_state_atomic() { # <existed:0|1> <prev_content>
  local existed="$1" content="$2" dir tmp
  dir="$(dirname -- "$V5_REMOTE_RELAY_STATE_FILE")"
  if [[ "$existed" != "1" ]]; then
    rm -f -- "$V5_REMOTE_RELAY_STATE_FILE"
    [[ -d "$dir" ]] && remote_relay_fsync_path "$dir" 2>/dev/null || true
    return 0
  fi
  mkdir -p -- "$dir" || return 1
  tmp="$(mktemp "${V5_REMOTE_RELAY_STATE_FILE}.rb.XXXXXX")" || return 1
  if ! printf '%s\n' "$content" >"$tmp" \
     || ! chmod 0644 "$tmp" \
     || ! remote_relay_fsync_path "$tmp" \
     || ! mv -Tf -- "$tmp" "$V5_REMOTE_RELAY_STATE_FILE" \
     || ! remote_relay_fsync_path "$dir"; then
    rm -f -- "$tmp"
    return 1
  fi
}

remote_relay_read_state_slot() {
  [[ -r "$V5_REMOTE_RELAY_STATE_FILE" && ! -L "$V5_REMOTE_RELAY_STATE_FILE" ]] || return 1
  local s
  s="$(jq -r '.activeSlot // empty' "$V5_REMOTE_RELAY_STATE_FILE" 2>/dev/null || true)"
  remote_relay_valid_slot "$s" || return 1
  printf '%s' "$s"
}

remote_relay_active_symlink_slot() {
  [[ -L "$V5_REMOTE_RELAY_ACTIVE_SOCK" ]] || return 1
  local target base
  target="$(readlink -- "$V5_REMOTE_RELAY_ACTIVE_SOCK" 2>/dev/null || true)"
  base="$(basename -- "$target")"
  case "$base" in
    remote-relay-A.sock) printf 'A' ;;
    remote-relay-B.sock) printf 'B' ;;
    *) return 1 ;;
  esac
}

# Prints "<http_code>\n<body>" on stdout. Never exposes secret in process argv.
remote_relay_http() { # <sock> <method> <path> [json_body]
  local sock="$1" method="$2" path="$3" body="${4:-}" secret tmp code cfg
  if [[ -n "${OC_SELFHOST_REMOTE_RELAY_HTTP_CMD:-}" ]]; then
    "$OC_SELFHOST_REMOTE_RELAY_HTTP_CMD" "$sock" "$method" "$path" "$body"
    return $?
  fi
  [[ -S "$sock" ]] || return 75
  secret="$(remote_relay_read_egress_secret || true)"
  tmp="$(mktemp)" || return 1
  local -a extra=()
  cfg=""
  if [[ -n "$secret" ]]; then
    local esc="${secret//\\/\\\\}"
    esc="${esc//\"/\\\"}"
    cfg+="header = \"x-oc-egress-secret: ${esc}\""$'\n'
  fi
  if [[ -n "$body" ]]; then
    cfg+='header = "Content-Type: application/json"'$'\n'
    extra+=(--data-raw "$body")
  fi
  code="$(printf '%s' "$cfg" | curl -sS --max-time "${OC_REMOTE_RELAY_HTTP_TIMEOUT_SEC:-5}" \
    --unix-socket "$sock" -K - -o "$tmp" -w '%{http_code}' \
    -X "$method" "${extra[@]}" "http://localhost${path}" 2>/dev/null || printf '000')"
  printf '%s\n' "$code"
  cat "$tmp" 2>/dev/null || true
  rm -f -- "$tmp"
}

# B6: Probes GET /healthz on <sock>:
#   - 0  : 200 + ok + role=="remote-relay" + remoteRuntimeReady + accepting (+ runtimeState!="disabled"/"error") -> prints instanceId
#   - 76 : 200 + ok + role=="remote-relay" + runtimeState=="disabled" + remoteRuntimeReady==false (intentionally disabled)
#   - 1  : 503 / runtimeState=="error" / timeout / invalid JSON (fail-closed)
remote_relay_probe_health() { # <sock> [expected_slot]
  local sock="$1" expected_slot="${2:-}" raw code body inst_id
  raw="$(remote_relay_http "$sock" GET /healthz 2>/dev/null)" || return 1
  code="${raw%%$'\n'*}"
  if [[ "$raw" == *$'\n'* ]]; then
    body="${raw#*$'\n'}"
  else
    body=""
  fi
  [[ "$code" == "200" && -n "$body" ]] || return 1
  if printf '%s\n' "$body" | jq -e --arg s "$expected_slot" \
    '.ok == true and .role == "remote-relay" and .runtimeState == "disabled" and .remoteRuntimeReady == false and ($s == "" or .slot == $s)' \
    >/dev/null 2>&1; then
    return 76
  fi
  if printf '%s\n' "$body" | jq -e --arg s "$expected_slot" \
    '.ok == true and .role == "remote-relay" and .remoteRuntimeReady == true and .accepting == true and ((.runtimeState // "ready") == "ready") and ($s == "" or .slot == $s) and (.instanceId | type == "string" and length > 0)' \
    >/dev/null 2>&1; then
    inst_id="$(printf '%s\n' "$body" | jq -r '.instanceId')"
    [[ -n "$inst_id" ]] || return 1
    printf '%s' "$inst_id"
    return 0
  fi
  return 1
}

# Checks if slot's /healthz explicitly reports draining==true (legitimate online self-drain).
remote_relay_slot_is_draining() { # <A|B>
  local slot="$1" sock raw code body
  sock="$(remote_relay_slot_sock "$slot")" || return 1
  raw="$(remote_relay_http "$sock" GET /healthz 2>/dev/null)" || return 1
  code="${raw%%$'\n'*}"
  if [[ "$raw" == *$'\n'* ]]; then body="${raw#*$'\n'}"; else body=""; fi
  [[ "$code" == "200" && -n "$body" ]] \
    && printf '%s\n' "$body" | jq -e '.ok == true and .role == "remote-relay" and .draining == true' >/dev/null 2>&1
}

remote_relay_drain_begin() { # <A|B> [exit_when_drained:true|false]
  local slot="$1" exit_flag="${2:-false}" sock payload raw code body
  sock="$(remote_relay_slot_sock "$slot")" || return 1
  if [[ "$exit_flag" == "true" ]]; then
    payload='{"exitWhenDrained":true}'
  else
    payload='{}'
  fi
  raw="$(remote_relay_http "$sock" POST /drain-begin "$payload" 2>/dev/null)" || return 1
  code="${raw%%$'\n'*}"
  if [[ "$raw" == *$'\n'* ]]; then body="${raw#*$'\n'}"; else body=""; fi
  [[ "$code" == "200" && -n "$body" ]] && printf '%s\n' "$body" | jq -e '.ok == true' >/dev/null 2>&1
}

remote_relay_reopen() { # <sock>
  local sock="$1" raw code body
  raw="$(remote_relay_http "$sock" POST /reopen '{}' 2>/dev/null)" || return 1
  code="${raw%%$'\n'*}"
  if [[ "$raw" == *$'\n'* ]]; then body="${raw#*$'\n'}"; else body=""; fi
  [[ "$code" == "200" && -n "$body" ]] \
    && printf '%s\n' "$body" | jq -e '.ok == true and .draining == false' >/dev/null 2>&1
}

remote_relay_drain_blocking() { # <sock> [release_idle_lanes:0|1]
  local sock="$1" release_idle="${2:-0}" payload='{}' raw code body
  if [[ "$release_idle" == "1" ]]; then
    payload='{"releaseIdleLanes":true,"keepClosedForRestart":true}'
  fi
  raw="$(OC_REMOTE_RELAY_HTTP_TIMEOUT_SEC="${OC_REMOTE_RELAY_DRAIN_HTTP_TIMEOUT_SEC:-630}" \
    remote_relay_http "$sock" POST /drain "$payload" 2>/dev/null)" || return 1
  code="${raw%%$'\n'*}"
  if [[ "$raw" == *$'\n'* ]]; then body="${raw#*$'\n'}"; else body=""; fi
  [[ "$code" == "200" && -n "$body" ]] && printf '%s\n' "$body" | jq -e '.ok == true and .drained == true' >/dev/null 2>&1
}

remote_relay_atomic_switch_symlink() { # <A|B>
  local target_slot="$1" target_sock active_dir link_target tmp
  remote_relay_valid_slot "$target_slot" || return 1
  target_sock="$(remote_relay_slot_sock "$target_slot")" || return 1
  active_dir="$(dirname -- "$V5_REMOTE_RELAY_ACTIVE_SOCK")"
  mkdir -p -- "$active_dir" || return 1
  if [[ "$(dirname -- "$target_sock")" == "$active_dir" ]]; then
    link_target="$(basename -- "$target_sock")"
  else
    link_target="$target_sock"
  fi
  tmp="${active_dir}/.$(basename -- "$V5_REMOTE_RELAY_ACTIVE_SOCK").tmp.$$.$RANDOM"
  rm -f -- "$tmp"
  ln -sfn -- "$link_target" "$tmp" || return 1
  mv -Tf -- "$tmp" "$V5_REMOTE_RELAY_ACTIVE_SOCK" || { rm -f -- "$tmp"; return 1; }
}

remote_relay_restore_symlink() { # <cur_slot> <prev_link>
  local cur="$1" prev_link="$2"
  if [[ -n "$cur" ]]; then
    remote_relay_atomic_switch_symlink "$cur" || true
  elif [[ -n "$prev_link" ]]; then
    local rdir rtmp
    rdir="$(dirname -- "$V5_REMOTE_RELAY_ACTIVE_SOCK")"
    rtmp="${rdir}/.$(basename -- "$V5_REMOTE_RELAY_ACTIVE_SOCK").rb.$$.$RANDOM"
    if ln -sfn -- "$prev_link" "$rtmp" 2>/dev/null; then
      mv -Tf -- "$rtmp" "$V5_REMOTE_RELAY_ACTIVE_SOCK" 2>/dev/null || rm -f -- "$rtmp"
    fi
  else
    rm -f -- "$V5_REMOTE_RELAY_ACTIVE_SOCK"
  fi
}

# Returns 0 (+ prints instanceId), 76 (intentionally disabled, immediate), or 1 (timeout/error).
remote_relay_wait_slot_ready() { # <A|B> [timeout_s]
  local slot="$1" timeout_s="${2:-${OC_REMOTE_RELAY_READY_TIMEOUT_SEC:-90}}"
  local poll_s="${OC_REMOTE_RELAY_READY_POLL_SEC:-1}" sock inst probe_rc started deadline
  remote_relay_valid_slot "$slot" || return 1
  [[ "$timeout_s" =~ ^[1-9][0-9]*$ ]] || timeout_s=90
  sock="$(remote_relay_slot_sock "$slot")" || return 1
  started=$SECONDS
  deadline=$((started + timeout_s))
  while :; do
    probe_rc=0
    inst="$(remote_relay_probe_health "$sock" "$slot" 2>/dev/null)" || probe_rc=$?
    if (( probe_rc == 0 )) && [[ -n "$inst" ]]; then
      printf '%s' "$inst"
      return 0
    fi
    if (( probe_rc == 76 )); then
      return 76
    fi
    if (( SECONDS >= deadline )); then
      remote_relay_log "  ✗ remote-relay slot ${slot} (${sock}) 在 ${timeout_s}s 内未就绪"
      return 1
    fi
    sleep "$poll_s"
  done
}

# B2: Rollback to older release without remote-relay@.service template.
# NEVER swallows systemctl stop failures (marks recovery_required and returns 79).
remote_relay_stop_all_for_legacy_rollback() {
  local s unit st
  remote_relay_log "  remote-relay: live release 无独立中继模板 → 停止 A/B 槽并清理 active symlink 与 state 文件"
  for s in A B; do
    unit="$(remote_relay_slot_unit "$s")"
    st="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [[ "$st" == "active" || "$st" == "activating" || "$st" == "deactivating" ]]; then
      if [[ "$st" == "active" ]]; then
        remote_relay_drain_begin "$s" >/dev/null 2>&1 || true
      fi
      if ! systemctl stop "$unit"; then
        remote_relay_log "  ✗ 回滚停用 remote-relay 槽 ${s} (${unit}) 失败"
        remote_relay_mark_recovery "remote_relay_rollback_stop_failed" "unit=${unit}"
        return 79
      fi
    fi
    systemctl disable "$unit" >/dev/null 2>&1 || true
  done
  rm -f -- "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$V5_REMOTE_RELAY_STATE_FILE"
  return 0
}

remote_relay_slot_flip() {
  local cur="" target new_svc old_svc st prev_link="" new_inst="" active_inst="" wait_rc=0
  local prev_state_existed=0 prev_state_content=""
  if ! remote_relay_live_release_has_unit; then
    remote_relay_stop_all_for_legacy_rollback
    return $?
  fi

  # B3 + B9: If both A and B are active (either a prior slot still online self-draining a long
  # turn, or an interrupted previous flip), NEVER pick by timestamp!
  # Attest the authoritative slot via active.sock target + /healthz + persistent state.json.
  if remote_relay_slot_is_active A && remote_relay_slot_is_active B; then
    local auth_slot="" state_slot="" auth_inst="" other_slot="" other_svc=""
    auth_slot="$(remote_relay_active_symlink_slot || true)"
    if [[ -n "$auth_slot" ]]; then
      auth_inst="$(remote_relay_probe_health "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$auth_slot" 2>/dev/null || true)"
    fi
    if [[ -e "$V5_REMOTE_RELAY_STATE_FILE" || -L "$V5_REMOTE_RELAY_STATE_FILE" ]]; then
      state_slot="$(remote_relay_read_state_slot || printf 'CORRUPT')"
    fi
    if [[ -z "$auth_slot" || -z "$auth_inst" ]] || [[ -n "$state_slot" && "$state_slot" != "$auth_slot" ]]; then
      remote_relay_log "  ✗ remote-relay A/B 同时 active 且无法唯一证真权威槽 (symlink=${auth_slot:-<none>} probe=${auth_inst:-<fail>} state=${state_slot:-<absent>})，保留两槽不动"
      remote_relay_mark_recovery "remote_relay_both_slots_ambiguous" \
        "symlink=${auth_slot:-<none>} state=${state_slot:-<absent>} probe=${auth_inst:-<fail>}"
      return 79
    fi
    other_slot="$(remote_relay_other_slot "$auth_slot")" || return 79
    other_svc="$(remote_relay_slot_unit "$other_slot")"
    if remote_relay_slot_is_draining "$other_slot"; then
      # B3: Legitimate retiring slot still finishing a long turn in online self-drain.
      # NEVER force-stop it; wait bounded for it to self-exit cleanly before reusing the slot.
      local wait_max="${OC_REMOTE_RELAY_DEACTIVATING_WAIT_SEC:-1900}"
      local wait_poll="${OC_REMOTE_RELAY_DEACTIVATING_POLL_SEC:-2}"
      local wait_deadline=$((SECONDS + wait_max))
      remote_relay_log "  remote-relay: 权威槽 ${auth_slot} 运行中，旧槽 ${other_slot} 正在在线排空长回合，有界等待其自退 (最多 ${wait_max}s)…"
      while remote_relay_slot_is_active "$other_slot"; do
        if (( SECONDS >= wait_deadline )); then
          remote_relay_log "  ✗ remote-relay 旧槽 ${other_slot} 在线排空超限 (${wait_max}s)，保留两槽运行不强杀"
          return 1
        fi
        sleep "$wait_poll"
      done
    else
      remote_relay_log "  remote-relay: A/B 同时 active，已证真权威槽为 ${auth_slot} (instanceId=${auth_inst})，先排空并停未完成槽 ${other_slot}"
      remote_relay_drain_begin "$other_slot" true >/dev/null 2>&1 || true
      if ! systemctl stop "$other_svc"; then
        remote_relay_mark_recovery "remote_relay_stop_orphan_slot_failed" "auth=${auth_slot} other=${other_slot}"
        return 79
      fi
    fi
    cur="$auth_slot"
    target="$other_slot"
  elif remote_relay_slot_is_active A; then
    cur=A; target=B
  elif remote_relay_slot_is_active B; then
    cur=B; target=A
  else
    cur=""; target=A
  fi

  new_svc="$(remote_relay_slot_unit "$target")"
  st="$(systemctl is-active "$new_svc" 2>/dev/null || true)"
  if [[ "$st" == "deactivating" ]]; then
    local wait_max="${OC_REMOTE_RELAY_DEACTIVATING_WAIT_SEC:-1900}"
    local wait_poll="${OC_REMOTE_RELAY_DEACTIVATING_POLL_SEC:-2}"
    local wait_deadline=$((SECONDS + wait_max))
    remote_relay_log "  remote-relay: 目标槽 ${target} 仍在 deactivating，有界等待其退出 (最多 ${wait_max}s)…"
    while [[ "$(systemctl is-active "$new_svc" 2>/dev/null || true)" == "deactivating" ]]; do
      if (( SECONDS >= wait_deadline )); then
        remote_relay_log "  ✗ remote-relay 目标槽 ${target} deactivating 超时 (${wait_max}s)"
        return 1
      fi
      sleep "$wait_poll"
    done
  fi

  remote_relay_log "  remote-relay: 启动新槽 ${target} (${new_svc})${cur:+, 当前槽 ${cur}}"
  if ! systemctl start "$new_svc"; then
    [[ -r "$V5_REMOTE_RELAY_LOG" ]] && tail -n 40 "$V5_REMOTE_RELAY_LOG" >&2 || true
    systemctl stop "$new_svc" 2>/dev/null || true
    return 1
  fi

  wait_rc=0
  new_inst="$(remote_relay_wait_slot_ready "$target")" || wait_rc=$?
  # B6: Handle intentionally-disabled (rc=76) distinctly from broken/error (rc=1)
  if (( wait_rc == 76 )); then
    systemctl stop "$new_svc" 2>/dev/null || true
    if [[ -z "$cur" && ! -e "$V5_REMOTE_RELAY_STATE_FILE" ]]; then
      remote_relay_log "  · remote-relay 功能未启用（disabled），跳过中继切槽"
      return 0
    fi
    if [[ -n "$cur" ]]; then
      remote_relay_log "  remote-relay: 功能被禁用（disabled），先阻塞排空旧活跃槽 ${cur} 再停槽"
      if ! remote_relay_drain_blocking "$(remote_relay_slot_sock "$cur")" 1; then
        remote_relay_log "  ✗ remote-relay 禁用切出前排空旧槽 ${cur} 失败，保留旧槽运行"
        return 1
      fi
      old_svc="$(remote_relay_slot_unit "$cur")"
      if ! systemctl stop "$old_svc"; then
        remote_relay_mark_recovery "remote_relay_disable_stop_old_failed" "unit=${old_svc}"
        return 79
      fi
      systemctl disable "$old_svc" >/dev/null 2>&1 || true
    fi
    rm -f -- "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$V5_REMOTE_RELAY_STATE_FILE"
    remote_relay_log "  · remote-relay 已排空旧槽并安全停用（disabled）"
    return 0
  fi
  if (( wait_rc != 0 )); then
    [[ -r "$V5_REMOTE_RELAY_LOG" ]] && tail -n 40 "$V5_REMOTE_RELAY_LOG" >&2 || true
    systemctl stop "$new_svc" 2>/dev/null || true
    return 1
  fi

  # B10: Verify new slot is boot-enabled BEFORE committing active.sock, persisted state, or
  # disabling old slot! Failure here leaves cur untouched and returns non-zero (never swallowed).
  local new_enabled=""
  if ! systemctl enable "$new_svc" >/dev/null 2>&1; then
    remote_relay_log "  ✗ systemctl enable ${new_svc} 失败，中止切槽（旧槽 ${cur:-none} 保持不变）"
    systemctl stop "$new_svc" 2>/dev/null || true
    return 1
  fi
  new_enabled="$(systemctl is-enabled "$new_svc" 2>/dev/null || true)"
  if [[ "$new_enabled" != "enabled" ]]; then
    remote_relay_log "  ✗ systemctl is-enabled ${new_svc} 返回 '${new_enabled:-<empty>}'（期望 enabled），中止切槽"
    systemctl disable "$new_svc" >/dev/null 2>&1 || true
    systemctl stop "$new_svc" 2>/dev/null || true
    return 1
  fi

  [[ -L "$V5_REMOTE_RELAY_ACTIVE_SOCK" ]] && prev_link="$(readlink -- "$V5_REMOTE_RELAY_ACTIVE_SOCK" 2>/dev/null || true)"
  if [[ -r "$V5_REMOTE_RELAY_STATE_FILE" && ! -L "$V5_REMOTE_RELAY_STATE_FILE" ]]; then
    prev_state_existed=1
    prev_state_content="$(cat -- "$V5_REMOTE_RELAY_STATE_FILE" 2>/dev/null || true)"
  fi

  if ! remote_relay_atomic_switch_symlink "$target"; then
    systemctl disable "$new_svc" >/dev/null 2>&1 || true
    systemctl stop "$new_svc" 2>/dev/null || true
    return 1
  fi
  if ! active_inst="$(remote_relay_probe_health "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$target" 2>/dev/null)" || [[ "$active_inst" != "$new_inst" ]]; then
    remote_relay_log "  ✗ remote-relay active symlink 切向 ${target} 后探活失败或 instanceId 不一致 (want=${new_inst} got=${active_inst:-<none>})，原子回滚"
    remote_relay_restore_symlink "$cur" "$prev_link"
    remote_relay_restore_state_atomic "$prev_state_existed" "$prev_state_content" || true
    systemctl disable "$new_svc" >/dev/null 2>&1 || true
    systemctl stop "$new_svc" 2>/dev/null || true
    return 1
  fi
  # B10: Persist authoritative migrated/activeSlot state atomically (fsync file + dir) after verified probe.
  if ! remote_relay_write_state_atomic "$target" "$active_inst"; then
    remote_relay_log "  ✗ 持久化 ${V5_REMOTE_RELAY_STATE_FILE} 失败，原子回滚 active symlink"
    remote_relay_restore_symlink "$cur" "$prev_link"
    remote_relay_restore_state_atomic "$prev_state_existed" "$prev_state_content" || true
    systemctl disable "$new_svc" >/dev/null 2>&1 || true
    systemctl stop "$new_svc" 2>/dev/null || true
    return 1
  fi

  if [[ -n "$cur" ]]; then
    old_svc="$(remote_relay_slot_unit "$cur")"
    # B3 + N1: Retire old slot via online self-drain (`exitWhenDrained: true`) WITHOUT issuing
    # a systemd stop job — old slot keeps live SSH turns running indefinitely past 30m if needed
    # and exits 0 cleanly once all in-flight RPCs, relays & PG journals finish, and NEVER blocks
    # candidate Master startup via systemd job ordering.
    remote_relay_log "  remote-relay: 新槽 ${target} 已启用并接管 active symlink，向旧槽 ${cur} 发在线排空自退 (/drain-begin exitWhenDrained=true) 并取消旧槽自启"
    if ! remote_relay_drain_begin "$cur" true; then
      remote_relay_log "  · 警告：向旧槽 ${cur} 发 /drain-begin 失败（可能已退出）"
    fi
    systemctl disable "$old_svc" >/dev/null 2>&1 || true
  fi
  remote_relay_log "  ✓ remote-relay: 切槽完成 ${cur:-none} -> ${target} (instanceId=${active_inst})"
  return 0
}

remote_relay_old_master_reports_external() {
  declare -F selfhost_master_dual_slot_active >/dev/null 2>&1 || return 1
  selfhost_master_dual_slot_active || return 1
  local slot raw code body
  slot="$(selfhost_master_current_slot)" || return 1
  raw="$(selfhost_priv_control_call "$slot" GET /internal/v5/cutover-readiness 2>/dev/null || printf '000\n')"
  code="${raw%%$'\n'*}"
  if [[ "$raw" == *$'\n'* ]]; then body="${raw#*$'\n'}"; else body=""; fi
  [[ "$code" == "200" && -n "$body" ]] \
    && printf '%s\n' "$body" | jq -e '.ok == true and .remoteRelayExternal == true' >/dev/null 2>&1
}

# B2: Unified egress -> remote-relay -> Master orchestration covering:
#   1) Reverse rollback (target lacks remote-relay unit): blocking drain + releaseIdleLanes FIRST,
#      flip Master back (reopen external relay & verify on failure!), THEN stop relay (rc=79 on stop fail).
#   2) First migration (no active relay & old Master not external): fence+drain old in-process Master FIRST, start relay, THEN flip Master.
#   3) Steady-state blue-green: egress_slot_flip -> remote_relay_slot_flip -> selfhost_master_restart_or_flip.
selfhost_flip_egress_relay_and_master() {
  egress_slot_flip || return $?

  # Case 1: Reverse rollback to legacy release without independent remote-relay
  if ! remote_relay_live_release_has_unit; then
    local s m_rc=0
    local -a drained_slots=()
    _rollback_reopen_external() {
      local ds reopen_fail=0
      for ds in "${drained_slots[@]}"; do
        if ! remote_relay_reopen "$(remote_relay_slot_sock "$ds")"; then
          remote_relay_log "  ✗ 反向回滚中止后无法确认外部 remote-relay 槽 ${ds} 已 reopen"
          reopen_fail=1
        fi
      done
      if (( reopen_fail == 1 )); then
        remote_relay_mark_recovery "remote_relay_rollback_reopen_failed" "slots=${drained_slots[*]}"
        return 79
      fi
      return 0
    }
    for s in A B; do
      if remote_relay_slot_is_active "$s"; then
        remote_relay_log "  remote-relay: [反向回滚] 切回老 Master 前先对外部中继槽 ${s} 执行阻塞 /drain (releaseIdleLanes=true)"
        if ! remote_relay_drain_blocking "$(remote_relay_slot_sock "$s")" 1; then
          remote_relay_log "  ✗ 外部 remote-relay 槽 ${s} 阻塞排空失败，中止反向回滚（reopen 已关闭槽，不触碰 active.sock）"
          _rollback_reopen_external || return 79
          return 1
        fi
        drained_slots+=("$s")
      fi
    done
    selfhost_master_restart_or_flip || m_rc=$?
    if (( m_rc != 0 )); then
      if (( m_rc != 79 && ${#drained_slots[@]} > 0 )); then
        _rollback_reopen_external || return 79
      fi
      return "$m_rc"
    fi
    remote_relay_stop_all_for_legacy_rollback || return $?
    return 0
  fi

  # Case 2: First-time migration from in-process Master to external remote-relay
  if ! remote_relay_any_slot_active && ! remote_relay_old_master_reports_external; then
    local is_dual=0 old_slot="" drain_sock="" fenced=0 fence_rc=0 flip_rc=0 m_rc=0
    if declare -F selfhost_master_dual_slot_active >/dev/null 2>&1 && selfhost_master_dual_slot_active; then
      is_dual=1
      old_slot="$(selfhost_master_current_slot)"
      drain_sock="$(selfhost_master_slot_drain_sock "$old_slot")"
    elif declare -F selfhost_master_active_drain_sock >/dev/null 2>&1; then
      drain_sock="$(selfhost_master_active_drain_sock)"
    fi

    _first_migrate_abort() {
      local reopen_sock="$drain_sock"
      if declare -F remote_v4_cutover_reopen >/dev/null 2>&1; then
        OC_REMOTE_V4_DRAIN_SOCKET="$reopen_sock" remote_v4_cutover_reopen || true
      fi
      if (( is_dual == 1 && fenced == 1 )); then
        if ! selfhost_slot_unfence_and_verify "$old_slot"; then
          remote_relay_mark_recovery "first_migrate_unfence_failed" "old=${old_slot}"
          return 79
        fi
      fi
      return 1
    }

    remote_relay_log "  remote-relay: [首次迁移] 启动独立中继前，先对旧进程内 Master 开启 fence 并排空 remote-v4"
    if (( is_dual == 1 )); then
      selfhost_slot_set_fence "$old_slot" true || fence_rc=$?
      if (( fence_rc == 0 )); then
        fenced=1
      elif (( fence_rc == 75 )); then
        remote_relay_log "  · 旧 Master 槽 ${old_slot} 无 cutover-fence(404)，直接执行 remote_v4_cutover_drain"
      else
        fenced=1
        _first_migrate_abort
        return $?
      fi
    fi
    if declare -F remote_v4_cutover_drain >/dev/null 2>&1; then
      if ! OC_REMOTE_V4_DRAIN_SOCKET="$drain_sock" remote_v4_cutover_drain; then
        _first_migrate_abort
        return $?
      fi
    fi

    remote_relay_slot_flip || flip_rc=$?
    if (( flip_rc != 0 )); then
      if (( flip_rc == 79 )); then return 79; fi
      local ab_rc=0; _first_migrate_abort || ab_rc=$?
      if (( ab_rc == 79 )); then return 79; fi
      return "$flip_rc"
    fi

    selfhost_master_restart_or_flip || m_rc=$?
    if (( m_rc != 0 )); then
      if (( is_dual == 0 && m_rc != 79 )) && declare -F remote_v4_cutover_reopen >/dev/null 2>&1; then
        OC_REMOTE_V4_DRAIN_SOCKET="$drain_sock" remote_v4_cutover_reopen || true
      fi
      return "$m_rc"
    fi
    return 0
  fi

  # Case 3: Steady-state blue-green (external remote-relay already active)
  remote_relay_slot_flip || return $?
  selfhost_master_restart_or_flip
}

remote_relay_describe_topology() {
  local out="" s
  for s in A B; do
    remote_relay_slot_is_active "$s" && out="${out:+$out,}slot$s"
  done
  printf '%s' "${out:-none}"
}
