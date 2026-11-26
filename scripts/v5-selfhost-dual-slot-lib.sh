# shellcheck shell=bash
# OCV5-854: V5 selfhost blue-green Master dual-slot library + fenced tiered cutover gate.
#
# Locked contract:
#   - Frontdoor : 127.0.0.1:18790, control /run/openclaude-v5-selfhost/frontdoor.sock,
#                 state /var/lib/openclaude-v5-selfhost/frontdoor-state.json
#   - Slot A    : OC_SLOT=A, port 18791, private 18896,
#                 drain /run/openclaude-v5-selfhost/remote-v4-drain-A.sock,
#                 workdir /opt/openclaude/openclaude-v5-selfhost-slot-A
#   - Slot B    : OC_SLOT=B, port 18795, private 18897,
#                 drain /run/openclaude-v5-selfhost/remote-v4-drain-B.sock,
#                 workdir /opt/openclaude/openclaude-v5-selfhost-slot-B
#   - Control VIP: 127.0.0.1:18894 (handoff via deploy_state.desired_control_slot)
#
# Private control endpoints (18896/18897, auth via stdin curl -K - header x-oc-egress-secret):
#   POST /internal/v5/deploy/refresh-desired
#   GET  /internal/v5/cutover-readiness
#   POST /internal/v5/cutover-fence   {"enabled":true|false}
#   POST /internal/v5/drain-ws

[[ -n "${__OC_SELFHOST_DUAL_SLOT_LIB_LOADED:-}" ]] && return 0
__OC_SELFHOST_DUAL_SLOT_LIB_LOADED=1

_SELFHOST_DS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${_SELFHOST_DS_LIB_DIR}/v5-selfhost-remote-relay-lib.sh" ]]; then
  # shellcheck source=scripts/v5-selfhost-remote-relay-lib.sh
  source "${_SELFHOST_DS_LIB_DIR}/v5-selfhost-remote-relay-lib.sh"
fi

V5_FRONTDOOR_UNIT="${V5_FRONTDOOR_UNIT:-openclaude-v5-selfhost-frontdoor.service}"
V5_MASTER_SLOT_TPL="${V5_MASTER_SLOT_TPL:-openclaude-v5-selfhost@.service}"
V5_FRONTDOOR_CONTROL_SOCKET="${OC_FRONTDOOR_CONTROL_SOCKET:-/run/openclaude-v5-selfhost/frontdoor.sock}"
V5_FRONTDOOR_STATE_FILE="${OC_FRONTDOOR_STATE_FILE:-/var/lib/openclaude-v5-selfhost/frontdoor-state.json}"
V5_MIGRATION_STATE_FILE="${OC_SELFHOST_MIGRATION_STATE_FILE:-/var/lib/openclaude-v5-selfhost/dual-slot-migration.json}"
V5_DUAL_SLOT_RECOVERY_LOCK="${OC_SELFHOST_DUAL_SLOT_RECOVERY_LOCK:-/var/lib/openclaude-v5-selfhost/dual-slot-recovery-required.json}"
V5_SLOT_LINK_PREFIX="${V5_SLOT_LINK_PREFIX:-/opt/openclaude/openclaude-v5-selfhost-slot}"
V5_SLOT_DRAIN_SOCK_PREFIX="${V5_SLOT_DRAIN_SOCK_PREFIX:-/run/openclaude-v5-selfhost/remote-v4-drain}"
SELFHOST_LAST_FRONTDOOR_SLOT=""

selfhost_ds_log() {
  if declare -F cutover_clog >/dev/null 2>&1; then
    cutover_clog "$*"
  else
    printf '%s\n' "$*" >&2
  fi
}

selfhost_valid_slot() { [[ "${1:-}" == "A" || "${1:-}" == "B" ]]; }

selfhost_master_other_slot() {
  case "${1:-}" in
    A) printf 'B' ;;
    B) printf 'A' ;;
    *) return 1 ;;
  esac
}

selfhost_master_slot_unit() {
  selfhost_valid_slot "${1:-}" || return 1
  printf '%s' "${V5_MASTER_SLOT_TPL/@./@$1.}"
}

selfhost_master_slot_port() {
  case "${1:-}" in
    A) printf '%s' "${OC_FRONTDOOR_SLOT_A_PORT:-18791}" ;;
    B) printf '%s' "${OC_FRONTDOOR_SLOT_B_PORT:-18795}" ;;
    *) return 1 ;;
  esac
}

selfhost_master_slot_priv_port() {
  case "${1:-}" in
    A) printf '%s' "${OC_SELFHOST_SLOT_A_PRIV_PORT:-18896}" ;;
    B) printf '%s' "${OC_SELFHOST_SLOT_B_PRIV_PORT:-18897}" ;;
    *) return 1 ;;
  esac
}

selfhost_master_slot_drain_sock() {
  selfhost_valid_slot "${1:-}" || return 1
  printf '%s-%s.sock' "$V5_SLOT_DRAIN_SOCK_PREFIX" "$1"
}

selfhost_master_slot_link() {
  selfhost_valid_slot "${1:-}" || return 1
  printf '%s-%s' "$V5_SLOT_LINK_PREFIX" "$1"
}

selfhost_master_slot_is_active() {
  local unit
  unit="$(selfhost_master_slot_unit "${1:-}")" || return 1
  [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" == "active" ]]
}

selfhost_frontdoor_is_active() {
  [[ "$(systemctl is-active "$V5_FRONTDOOR_UNIT" 2>/dev/null || true)" == "active" ]]
}

# B03: Dual-slot mode is active ONLY when frontdoor is active AND at least one
# @A/@B slot is active (never fooled by a leftover stopped/orphan slot unit).
selfhost_master_dual_slot_active() {
  if [[ "${OC_SELFHOST_DUAL_SLOT_ACTIVE:-}" == "1" ]]; then return 0; fi
  if [[ "${OC_SELFHOST_DUAL_SLOT_ACTIVE:-}" == "0" ]]; then return 1; fi
  selfhost_frontdoor_is_active && (selfhost_master_slot_is_active A || selfhost_master_slot_is_active B)
}
selfhost_is_dual_slot_active() { selfhost_master_dual_slot_active; }

selfhost_read_egress_secret() {
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

selfhost_write_json_atomic() { # <dest> <json_string>
  local dest="$1" body="$2" dir tmp
  dir="$(dirname -- "$dest")"
  mkdir -p -- "$dir" || return 1
  tmp="$(mktemp "${dest}.tmp.XXXXXX")" || return 1
  printf '%s\n' "$body" >"$tmp" || { rm -f -- "$tmp"; return 1; }
  chmod 0644 "$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -Tf -- "$tmp" "$dest" || { rm -f -- "$tmp"; return 1; }
}

# B11: Persist recovery lock on uncertain state (rc=79) so outer scripts or
# subsequent deploys never overwrite/auto-flip until operator resolves it.
selfhost_mark_dual_slot_recovery_required() { # <reason> [detail]
  local reason="${1:-unknown}" detail="${2:-}" json
  json="$(jq -cn --arg r "$reason" --arg d "$detail" --arg at "$(date -u +%FT%TZ)" \
    '{reason:$r,detail:$d,writtenAt:$at}')" || json="{\"reason\":\"${reason}\"}"
  selfhost_write_json_atomic "$V5_DUAL_SLOT_RECOVERY_LOCK" "$json" || true
  selfhost_ds_log "  ✗ recovery_required 已持久化锁标记 ${V5_DUAL_SLOT_RECOVERY_LOCK} (reason=${reason})"
}

# B03/B13: Strict non-empty JSON HTTP probe (NEVER pipes empty curl output into jq).
selfhost_http_json_check() { # <url> <jq_expr> [jq_extra_args...]
  local url="$1" expr="$2"; shift 2
  local body
  body="$(curl -fsS --max-time 3 "$url" 2>/dev/null)" || return 1
  [[ -n "$body" ]] || return 1
  printf '%s\n' "$body" | jq -e "$@" "$expr" >/dev/null 2>&1
}

selfhost_frontdoor_http() { # <method> <path> [json_body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "${OC_SELFHOST_FRONTDOOR_HTTP_CMD:-}" ]]; then
    "$OC_SELFHOST_FRONTDOOR_HTTP_CMD" "$method" "$path" "$body"
    return $?
  fi
  [[ -S "$V5_FRONTDOOR_CONTROL_SOCKET" ]] || return 75
  if [[ -n "$body" ]]; then
    curl -fsS --max-time 5 --unix-socket "$V5_FRONTDOOR_CONTROL_SOCKET" \
      -X "$method" -H 'Content-Type: application/json' \
      --data-raw "$body" "http://localhost${path}"
  else
    curl -fsS --max-time 5 --unix-socket "$V5_FRONTDOOR_CONTROL_SOCKET" \
      -X "$method" "http://localhost${path}"
  fi
}

selfhost_frontdoor_status() { selfhost_frontdoor_http GET /status; }

selfhost_frontdoor_read_slot() {
  local body s
  body="$(selfhost_frontdoor_status 2>/dev/null)" || return 1
  [[ -n "$body" ]] || return 1
  printf '%s\n' "$body" | jq -e '.ok == true' >/dev/null 2>&1 || return 1
  s="$(printf '%s\n' "$body" | jq -r '.slot // empty' 2>/dev/null || true)"
  selfhost_valid_slot "$s" || return 1
  printf '%s' "$s"
}

# B03: Poll frontdoor.sock until GET /status returns non-empty JSON with .ok==true and valid .slot.
selfhost_wait_frontdoor_ready() { # [timeout_s]
  local timeout_s="${1:-15}" started=$SECONDS s
  local deadline=$((started + timeout_s))
  while :; do
    if s="$(selfhost_frontdoor_read_slot 2>/dev/null)" && selfhost_valid_slot "$s"; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      selfhost_ds_log "  ✗ frontdoor 控制口 (${V5_FRONTDOOR_CONTROL_SOCKET}) 在 ${timeout_s}s 内未就绪"
      return 1
    fi
    sleep "${OC_SELFHOST_FRONTDOOR_WAIT_POLL_SEC:-0.2}"
  done
}

# B11: Always read back GET /status after POST /switch (even on lost ACK/timeout)
# so callers know frontdoor's authoritative slot and never split-brain.
selfhost_frontdoor_switch_verified() { # <A|B>
  local target="$1" sw_rc=0 actual=""
  selfhost_valid_slot "$target" || return 2
  SELFHOST_LAST_FRONTDOOR_SLOT=""
  selfhost_frontdoor_http POST /switch "{\"slot\":\"$target\"}" >/dev/null 2>&1 || sw_rc=$?
  actual="$(selfhost_frontdoor_read_slot || true)"
  SELFHOST_LAST_FRONTDOOR_SLOT="$actual"
  if [[ "$actual" == "$target" ]]; then
    return 0
  fi
  selfhost_ds_log "  ✗ frontdoor /switch(${target}) 未确认 (post_rc=${sw_rc}, status_slot=${actual:-<unreachable>})"
  return 1
}
selfhost_frontdoor_switch() { selfhost_frontdoor_switch_verified "$1"; }

# N01: Pass x-oc-egress-secret via curl -K - stdin (never in process argv).
# Prints "<http_code>\n<body>" on stdout.
selfhost_priv_control_call() { # <slot> <method> <path> [json_body]
  local slot="$1" method="$2" path="$3" body="${4:-}" port secret tmp code cfg
  port="$(selfhost_master_slot_priv_port "$slot")" || return 2
  if [[ -n "${OC_SELFHOST_PRIV_CONTROL_CMD:-}" ]]; then
    "$OC_SELFHOST_PRIV_CONTROL_CMD" "$slot" "$method" "$path" "$body"
    return $?
  fi
  secret="$(selfhost_read_egress_secret || true)"
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
  code="$(printf '%s' "$cfg" | curl -sS --max-time 5 -K - -o "$tmp" -w '%{http_code}' \
    -X "$method" "${extra[@]}" "http://127.0.0.1:${port}${path}" 2>/dev/null || printf '000')"
  printf '%s\n' "$code"
  cat "$tmp" 2>/dev/null || true
  rm -f -- "$tmp"
}

selfhost_slot_set_fence() { # <slot> <true|false>
  local slot="$1" enabled="$2" raw code body
  [[ "$enabled" == "true" || "$enabled" == "false" ]] || return 2
  raw="$(selfhost_priv_control_call "$slot" POST /internal/v5/cutover-fence "{\"enabled\":${enabled}}" || printf '000\n')"
  code="${raw%%$'\n'*}"
  body="${raw#*$'\n'}"
  if [[ "$code" == "200" && -n "$body" ]] && printf '%s\n' "$body" | jq -e --argjson e "$enabled" '.ok == true and .fencing == $e' >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$code" == "404" ]]; then
    return 75
  fi
  selfhost_ds_log "  ✗ slot ${slot} cutover-fence(${enabled}) 失败 (code=${code} body=${body:0:120})"
  return 1
}

# B11: Actively disable fence on slot AND read back GET /internal/v5/cutover-readiness
# to positively verify .fencing == false (handles lost ACK on earlier fence=true).
selfhost_slot_unfence_and_verify() { # <slot>
  local slot="$1" raw code body
  selfhost_slot_set_fence "$slot" false >/dev/null 2>&1 || true
  raw="$(selfhost_priv_control_call "$slot" GET /internal/v5/cutover-readiness || printf '000\n')"
  code="${raw%%$'\n'*}"
  body="${raw#*$'\n'}"
  if [[ "$code" == "404" ]]; then
    return 0
  fi
  if [[ "$code" == "200" && -n "$body" ]] \
     && printf '%s\n' "$body" | jq -e '.ok == true and .fencing == false' >/dev/null 2>&1; then
    return 0
  fi
  selfhost_ds_log "  ✗ 无法确认旧槽 ${slot} 已解除 fence (code=${code} body=${body:0:120})"
  return 1
}

selfhost_master_current_slot() {
  local s
  if s="$(selfhost_frontdoor_read_slot 2>/dev/null)" && selfhost_valid_slot "$s"; then
    printf '%s' "$s"; return 0
  fi
  if [[ -r "$V5_FRONTDOOR_STATE_FILE" ]]; then
    s="$(jq -r '.slot // empty' "$V5_FRONTDOOR_STATE_FILE" 2>/dev/null || true)"
    if selfhost_valid_slot "$s"; then printf '%s' "$s"; return 0; fi
  fi
  if selfhost_master_slot_is_active A && ! selfhost_master_slot_is_active B; then printf 'A'; return 0; fi
  if selfhost_master_slot_is_active B && ! selfhost_master_slot_is_active A; then printf 'B'; return 0; fi
  printf 'A'
}

selfhost_master_active_unit() {
  if selfhost_master_dual_slot_active; then
    local slot; slot="$(selfhost_master_current_slot)"
    selfhost_master_slot_unit "$slot"
  else
    printf '%s' "${V5_UNIT:-openclaude-v5-selfhost.service}"
  fi
}

selfhost_master_active_drain_sock() {
  if [[ -n "${OC_REMOTE_V4_DRAIN_SOCKET:-}" ]]; then
    printf '%s' "$OC_REMOTE_V4_DRAIN_SOCKET"
    return 0
  fi
  if selfhost_master_dual_slot_active; then
    local slot sock
    slot="$(selfhost_master_current_slot)"
    sock="$(selfhost_master_slot_drain_sock "$slot")"
    if [[ -S "$sock" || ! -S "${V5_SLOT_DRAIN_SOCK_PREFIX}.sock" ]]; then
      printf '%s' "$sock"
      return 0
    fi
  fi
  printf '%s.sock' "$V5_SLOT_DRAIN_SOCK_PREFIX"
}

selfhost_healthz_18790_ok() {
  if [[ -n "${OC_SELFHOST_HEALTHZ_CMD:-}" ]]; then
    "$OC_SELFHOST_HEALTHZ_CMD"
    return $?
  fi
  selfhost_http_json_check "http://127.0.0.1:${V5_PORT:-18790}/healthz" \
    '.ok == true and .runtime.controlPlaneEnabled == true and .runtime.leadership.state == "leader"'
}

# ── Systemd unit generators (B02: trusted per-slot launcher) ─────────────

render_selfhost_frontdoor_unit() {
  local live_link="${MASTER_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}"
  cat <<EOF
[Unit]
Description=OpenClaude v5 Selfhost Local Frontdoor (127.0.0.1:18790 -> slot A/B)
After=network.target openclaude-v5-selfhost-boot-guard.service
Wants=openclaude-v5-selfhost-boot-guard.service

[Service]
Type=simple
User=root
WorkingDirectory=${live_link}
Environment="OC_FRONTDOOR_HOST=127.0.0.1"
Environment="OC_FRONTDOOR_PORT=${V5_PORT:-18790}"
Environment="OC_FRONTDOOR_SLOT_A_PORT=${OC_FRONTDOOR_SLOT_A_PORT:-18791}"
Environment="OC_FRONTDOOR_SLOT_B_PORT=${OC_FRONTDOOR_SLOT_B_PORT:-18795}"
Environment="OC_FRONTDOOR_CONTROL_SOCKET=${V5_FRONTDOOR_CONTROL_SOCKET}"
Environment="OC_FRONTDOOR_STATE_FILE=${V5_FRONTDOOR_STATE_FILE}"
ExecStart=/usr/bin/node ${live_link}/scripts/v5-selfhost-frontdoor.mjs
Restart=always
RestartSec=1
KillMode=control-group
TimeoutStopSec=10
SendSIGKILL=yes
RuntimeDirectory=openclaude-v5-selfhost
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
StateDirectory=openclaude-v5-selfhost
StateDirectoryMode=0700
StandardOutput=append:/var/log/openclaude-v5-selfhost-frontdoor.log
StandardError=append:/var/log/openclaude-v5-selfhost-frontdoor.log
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
}

render_selfhost_master_slot_unit() {
  local slot_prefix="${V5_SLOT_LINK_PREFIX}"
  local drain_prefix="${V5_SLOT_DRAIN_SOCK_PREFIX}"
  local env_file="${V5_ENV:-/etc/openclaude/commercial-v5-selfhost.env}"
  local home_dir="${V5_HOME:-/root/.openclaude-v5-selfhost}"
  cat <<EOF
[Unit]
# OCV5-854: V5 selfhost blue-green Master slot (%i = A|B).
# WorkingDirectory points to immutable slot symlink (never the git worktree).
# N1: NEVER add After=openclaude-v5-selfhost-remote-relay@{A,B}.service here:
# systemd job_compare() would block candidate Master start on an outgoing relay slot's
# stop/retirement lifecycle. Cold-boot safety is enforced by persisted remote-relay-state.json
# + Master anti-split-brain external routing + active slot symlink auto-recovery.
Description=OpenClaude Gateway (v5 selfhost, slot %i)
After=network.target postgresql.service redis-server.service docker.service openclaude.service openclaude-v5-selfhost-boot-guard.service
Wants=postgresql.service redis-server.service docker.service openclaude-v5-selfhost-boot-guard.service

[Service]
Type=simple
User=root
WorkingDirectory=${slot_prefix}-%i
EnvironmentFile=${env_file}
Environment="PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="OPENCLAUDE_HOME=${home_dir}"
Environment="NODE_ENV=production"
Environment="V5_SLOT_DRAIN_SOCK_PREFIX=${drain_prefix}"
Environment="OC_V3_CCB_BASELINE_DIR=${slot_prefix}-%i/packages/commercial/agent-sandbox/ccb-baseline"
ExecStartPre=/usr/bin/bash ${slot_prefix}-%i/scripts/lib/assert-flavor.sh identity --effector ${slot_prefix}-%i/scripts/lib
# B02: v5-selfhost-slot-exec.sh runs AFTER EnvironmentFile= and authoritatively
# exports OC_SLOT, OPENCLAUDE_GATEWAY_PORT, OC_REMOTE_V4_DRAIN_SOCKET, disable flags.
ExecStart=/usr/bin/bash ${slot_prefix}-%i/scripts/v5-selfhost-slot-exec.sh %i
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=15
SendSIGKILL=yes
StandardOutput=append:/var/log/openclaude-v5-selfhost-%i.log
StandardError=append:/var/log/openclaude-v5-selfhost-%i.log
LimitNOFILE=65536
StateDirectory=openclaude-v5-selfhost
StateDirectoryMode=0700

[Install]
WantedBy=multi-user.target
EOF
}

install_selfhost_dual_slot_units() { # [systemd_dir]
  local dst_dir="${1:-/etc/systemd/system}" tmp_fd tmp_slot
  mkdir -p -- "$dst_dir" || return 1
  tmp_fd="$(mktemp "${dst_dir}/.${V5_FRONTDOOR_UNIT}.XXXXXX")" || return 1
  tmp_slot="$(mktemp "${dst_dir}/.${V5_MASTER_SLOT_TPL}.XXXXXX")" || { rm -f -- "$tmp_fd"; return 1; }
  if ! render_selfhost_frontdoor_unit >"$tmp_fd" || ! render_selfhost_master_slot_unit >"$tmp_slot"; then
    rm -f -- "$tmp_fd" "$tmp_slot"; return 1
  fi
  chmod 0644 "$tmp_fd" "$tmp_slot" || { rm -f -- "$tmp_fd" "$tmp_slot"; return 1; }
  mv -Tf -- "$tmp_fd" "${dst_dir}/${V5_FRONTDOOR_UNIT}" || { rm -f -- "$tmp_fd" "$tmp_slot"; return 1; }
  mv -Tf -- "$tmp_slot" "${dst_dir}/${V5_MASTER_SLOT_TPL}" || { rm -f -- "$tmp_slot"; return 1; }
  return 0
}

atomic_flip_slot_symlink() { # <A|B> <target-abs-rel>
  local slot="$1" target="$2" link tmp
  selfhost_valid_slot "$slot" || return 1
  [[ -n "$target" && -d "$target" && ! -L "$target" ]] || return 1
  link="$(selfhost_master_slot_link "$slot")" || return 1
  tmp="${link}.newlink.$$"
  rm -f -- "$tmp"
  ln -s -- "$target" "$tmp" || return 1
  mv -Tf -- "$tmp" "$link" || { rm -f -- "$tmp"; return 1; }
}

# ── PG deploy_state real CAS helpers (B11) ───────────────────────────────
# openclaude_v5_selfhost.deploy_state PK is `singleton boolean` (singleton=true)
# and phase CHECK is ('stable','canary','finalizing','aborting').

selfhost_psql_rw() {
  if declare -F selfhost_psql_rw_override >/dev/null 2>&1; then
    selfhost_psql_rw_override "$@"
    return $?
  fi
  su - postgres -c "psql -X -v ON_ERROR_STOP=1 -qAt -d $(printf '%q' "${PG_DB:-openclaude_v5_selfhost}")"
}

selfhost_psql_ro() {
  if declare -F psql_as_postgres >/dev/null 2>&1; then
    psql_as_postgres -d "dbname=${PG_DB:-openclaude_v5_selfhost} connect_timeout=5" -qAt "$@"
  else
    su - postgres -c "psql -X -v ON_ERROR_STOP=1 -qAt -d $(printf '%q' "${PG_DB:-openclaude_v5_selfhost}")"
  fi
}

selfhost_sql_esc() { printf '%s' "${1//\'/\'\'}"; }

# Prints: active_slot|desired_leader_slot|desired_control_slot|phase|lock_version|active_release|generation|operation_id
selfhost_deploy_state_read() {
  if declare -F selfhost_deploy_state_read_override >/dev/null 2>&1; then
    selfhost_deploy_state_read_override
    return $?
  fi
  selfhost_psql_ro -c "
SELECT active_slot || '|' || desired_leader_slot || '|' || desired_control_slot
    || '|' || phase || '|' || lock_version || '|' || COALESCE(active_release, '')
    || '|' || generation || '|' || COALESCE(operation_id, '')
  FROM deploy_state
 WHERE singleton = true;"
}

selfhost_deploy_state_read_lock_version() {
  local row a dl dc ph lv ar gen op
  row="$(selfhost_deploy_state_read)" || return 1
  IFS='|' read -r a dl dc ph lv ar gen op <<<"$row"
  [[ "$lv" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s' "$lv"
}

selfhost_deploy_state_cas_switch() { # <expect_lv> <new_slot> <new_rel> <op_id>
  local expect_lv="$1" new_slot="$2" new_rel="$3" op_id="${4:-selfhost-cutover-$$}" got
  [[ "$expect_lv" =~ ^[1-9][0-9]*$ ]] || return 1
  selfhost_valid_slot "$new_slot" || return 1
  local rel_q op_q want_lv=$(( expect_lv + 1 ))
  rel_q="$(selfhost_sql_esc "$new_rel")"
  op_q="$(selfhost_sql_esc "$op_id")"
  got="$(selfhost_psql_rw <<SQL
UPDATE deploy_state
   SET previous_active_release = active_release,
       active_slot             = '${new_slot}',
       candidate_slot          = '${new_slot}',
       active_release          = '${rel_q}',
       candidate_release       = '${rel_q}',
       desired_leader_slot     = '${new_slot}',
       desired_control_slot    = '${new_slot}',
       phase                   = 'finalizing',
       transition_step         = 1,
       operation_id            = '${op_q}',
       generation              = generation + 1,
       lock_version            = lock_version + 1,
       updated_at              = now()
 WHERE singleton = true
   AND lock_version = ${expect_lv}
RETURNING lock_version;
SQL
)" || return 1
  [[ "$got" == "$want_lv" ]] || {
    selfhost_ds_log "  ✗ deploy_state CAS(finalizing) 冲突或 0 行受影响 (expect=${expect_lv} want=${want_lv} got=${got:-<empty>})"
    return 1
  }
  printf '%s\n' "$got"
}

selfhost_deploy_state_cas_stable() { # <expect_lv> <slot> <rel>
  local expect_lv="$1" slot="$2" rel="$3" got
  [[ "$expect_lv" =~ ^[1-9][0-9]*$ ]] || return 1
  selfhost_valid_slot "$slot" || return 1
  local rel_q want_lv=$(( expect_lv + 1 ))
  rel_q="$(selfhost_sql_esc "$rel")"
  got="$(selfhost_psql_rw <<SQL
UPDATE deploy_state
   SET active_slot          = '${slot}',
       candidate_slot       = NULL,
       active_release       = '${rel_q}',
       candidate_release    = NULL,
       desired_leader_slot  = '${slot}',
       desired_control_slot = '${slot}',
       phase                = 'stable',
       transition_step      = 0,
       operation_id         = NULL,
       lock_version         = lock_version + 1,
       updated_at           = now()
 WHERE singleton = true
   AND lock_version = ${expect_lv}
RETURNING lock_version;
SQL
)" || return 1
  [[ "$got" == "$want_lv" ]] || {
    selfhost_ds_log "  ✗ deploy_state CAS(stable) 冲突或 0 行受影响 (expect=${expect_lv} want=${want_lv} got=${got:-<empty>})"
    return 1
  }
  printf '%s\n' "$got"
}

selfhost_deploy_state_cas_revert() { # <expect_lv> <old_slot> [old_rel]
  local expect_lv="$1" old_slot="$2" old_rel="${3:-}" got
  [[ "$expect_lv" =~ ^[1-9][0-9]*$ ]] || return 1
  selfhost_valid_slot "$old_slot" || return 1
  local rel_expr="previous_active_release" want_lv=$(( expect_lv + 1 ))
  if [[ -n "$old_rel" ]]; then
    rel_expr="'$(selfhost_sql_esc "$old_rel")'"
  fi
  got="$(selfhost_psql_rw <<SQL
UPDATE deploy_state
   SET active_slot          = '${old_slot}',
       candidate_slot       = NULL,
       active_release       = ${rel_expr},
       candidate_release    = NULL,
       desired_leader_slot  = '${old_slot}',
       desired_control_slot = '${old_slot}',
       phase                = 'stable',
       transition_step      = 0,
       operation_id         = NULL,
       lock_version         = lock_version + 1,
       updated_at           = now()
 WHERE singleton = true
   AND lock_version = ${expect_lv}
RETURNING lock_version;
SQL
)" || return 1
  [[ "$got" == "$want_lv" ]] || {
    selfhost_ds_log "  ✗ deploy_state CAS(revert) 冲突或 0 行受影响 (expect=${expect_lv} want=${want_lv} got=${got:-<empty>})"
    return 1
  }
  printf '%s\n' "$got"
}

# ── B05: Docker liveness + bound_ip/port/host_uuid + containerLinkEnabled ─

selfhost_docker_container_running() { # <container_id_or_name>
  local ref="$1" out
  [[ -n "$ref" ]] || return 1
  if [[ -n "${OC_SELFHOST_DOCKER_INSPECT_CMD:-}" ]]; then
    out="$("$OC_SELFHOST_DOCKER_INSPECT_CMD" "$ref" 2>/dev/null || true)"
  else
    out="$(docker inspect -f '{{.State.Running}}' "$ref" 2>/dev/null || true)"
  fi
  [[ "$out" == "true" ]]
}

# Prints 9 columns (backwards-compatible with legacy 6-column test mocks):
#   non_acc|total_acc|cand_surv_acc|rem_bind_strict|block_j_strict|cand_refs|rem_bind_v4_cand|rem_j_v4_cand|rem_v4_refs
# Matches packages/commercial/src/ws/containerLinkEndpoint.ts:13-33:
#   - ac.bound_ip IS NOT NULL AND host(ac.bound_ip) <> ''
#   - ac.port IS NOT NULL AND ac.port > 0
#   - ac.host_id IS NULL AND (ac.host_uuid IS NULL OR compute_hosts.name = 'self')
#   - strict COALESCE(..., FALSE) IS TRUE so NULL runtime_kind never vanishes.
selfhost_query_tiered_idle_pg() {
  local meta_row has_rab="false" has_ac="false" has_ch="false" has_rab_v4="false" has_rab_proto="false" has_rfj_4state="false"
  local host_cond="ac.host_uuid IS NULL" local_ac_cte="" open_rab_cte="" rfj_open_cond="" rfj_v4_cond="FALSE"
  meta_row="$(psql_as_postgres -d "dbname=$PG_DB connect_timeout=5" -qAt -c "
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL jit = off;
SELECT
  (to_regclass('public.remote_agent_bindings') IS NOT NULL)::text,
  (to_regclass('public.agent_containers') IS NOT NULL)::text,
  (to_regclass('public.compute_hosts') IS NOT NULL)::text,
  (
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'remote_agent_bindings' AND column_name = 'driver_id')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'remote_agent_bindings' AND column_name = 'container_db_id')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'remote_agent_bindings' AND column_name = 'uid')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'remote_agent_bindings' AND column_name = 'docker_id')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'remote_agent_bindings' AND column_name = 'operation_id')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'remote_agent_bindings' AND column_name = 'generation')
  )::text,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'remote_agent_bindings' AND column_name = 'remote_protocol_version')::text,
  EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = to_regclass('public.request_finalize_journal')
       AND c.contype = 'c'
       AND c.convalidated IS TRUE
       AND pg_get_constraintdef(c.oid) = 'CHECK ((state = ANY (ARRAY[''inflight''::text, ''finalizing''::text, ''committed''::text, ''aborted''::text])))'
  )::text;
COMMIT;" 2>/dev/null || printf 'err')"
  IFS='|' read -r has_rab has_ac has_ch has_rab_v4 has_rab_proto has_rfj_4state <<<"$meta_row"
  for _b in "$has_rab" "$has_ac" "$has_ch" "$has_rab_v4" "$has_rab_proto" "$has_rfj_4state"; do
    [[ "$_b" == "true" || "$_b" == "false" ]] || return 1
  done

  if [[ "$has_ch" == "true" ]]; then
    host_cond="(ac.host_uuid IS NULL OR EXISTS (SELECT 1 FROM public.compute_hosts ch WHERE ch.id = ac.host_uuid AND ch.name = 'self'))"
  fi
  if [[ "$has_ac" == "true" ]]; then
    local_ac_cte="
  SELECT ac.id, ac.user_id,
         COALESCE(NULLIF(ac.container_internal_id, ''), NULLIF(ac.docker_id, '')) AS ref,
         COALESCE(NULLIF(ac.docker_id, ''), NULLIF(ac.container_internal_id, '')) AS match_docker_id
    FROM public.agent_containers ac
   WHERE ac.state = 'active'
     AND ac.runtime_channel = 'v5'
     AND ac.runtime_kind = 'docker'
     AND ac.host_id IS NULL
     AND ${host_cond}
     AND ac.bound_ip IS NOT NULL
     AND host(ac.bound_ip) <> ''
     AND ac.port IS NOT NULL
     AND ac.port > 0
     AND COALESCE(NULLIF(ac.container_internal_id, ''), NULLIF(ac.docker_id, '')) IS NOT NULL"
  else
    local_ac_cte="SELECT NULL::bigint AS id, NULL::bigint AS user_id, NULL::text AS ref, NULL::text AS match_docker_id WHERE FALSE"
  fi

  if [[ "$has_rab" == "true" && "$has_ac" == "true" && "$has_rab_v4" == "true" ]]; then
    local proto_cond="FALSE"
    [[ "$has_rab_proto" == "true" ]] && proto_cond="b.remote_protocol_version = 4"
    open_rab_cte="
  SELECT b.operation_id::text AS operation_id_text,
         b.generation::text AS generation_text,
         COALESCE(b.driver_id IS NOT NULL AND ${proto_cond} AND b.container_db_id IS NOT NULL AND lac.id IS NOT NULL AND b.docker_id = lac.match_docker_id, FALSE) AS is_v4_surv,
         lac.ref AS container_ref
    FROM public.remote_agent_bindings b
    LEFT JOIN local_ac lac ON lac.id = b.container_db_id AND lac.user_id = b.uid
   WHERE b.state <> 'released'"
    rfj_v4_cond="COALESCE(
      j.state = 'inflight'
      AND j.ctx->>'remoteNativeBillingRecovery' = 'remote-native-v4'
      AND NULLIF(j.ctx#>>'{remoteDriverV4,scope,operationId}', '') IS NOT NULL
      AND NULLIF(j.ctx#>>'{remoteDriverV4,scope,generation}', '') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM open_rab b
         WHERE b.is_v4_surv IS TRUE
           AND b.operation_id_text = j.ctx#>>'{remoteDriverV4,scope,operationId}'
           AND b.generation_text = j.ctx#>>'{remoteDriverV4,scope,generation}'
      )
      AND EXISTS (
        SELECT 1 FROM open_dispatches d
         WHERE d.dispatch_id = j.dispatch_id
           AND d.is_survivable IS TRUE
      ),
      FALSE
    )"
  elif [[ "$has_rab" == "true" ]]; then
    open_rab_cte="
  SELECT NULL::text AS operation_id_text,
         NULL::text AS generation_text,
         FALSE AS is_v4_surv,
         NULL::text AS container_ref
    FROM public.remote_agent_bindings b
   WHERE b.state <> 'released'"
  else
    open_rab_cte="SELECT NULL::text AS operation_id_text, NULL::text AS generation_text, FALSE AS is_v4_surv, NULL::text AS container_ref WHERE FALSE"
  fi

  # When the validated 4-state CHECK constraint guarantees state IN (inflight,finalizing,committed,aborted),
  # predicate j.state IN ('inflight','finalizing') hits partial index idx_rfj_stuck directly (~1ms vs 3x Seq Scan + JIT).
  # If a future migration adds a 5th state (changing the CHECK constraint) or a test DB lacks it, fail closed to NOT IN.
  if [[ "$has_rfj_4state" == "true" ]]; then
    rfj_open_cond="j.state IN ('inflight', 'finalizing')"
  else
    rfj_open_cond="j.state NOT IN ('aborted', 'committed')"
  fi

  psql_as_postgres -d "dbname=$PG_DB connect_timeout=5" -qAt -c "
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL jit = off;
WITH local_ac AS MATERIALIZED (
  ${local_ac_cte}
),
open_dispatches AS MATERIALIZED (
  SELECT d.dispatch_id, d.user_id, d.status,
         COALESCE(d.status = 'accepted' AND d.runtime_kind = 'docker' AND d.agent_container_id IS NOT NULL AND lac.id IS NOT NULL, FALSE) AS is_survivable,
         lac.ref AS container_ref
    FROM turn_dispatches d
    LEFT JOIN local_ac lac ON lac.id = d.agent_container_id AND lac.user_id = d.user_id
   WHERE d.status IN ('admitted', 'rejecting', 'accepted')
),
open_rab AS MATERIALIZED (
  ${open_rab_cte}
),
open_rfj AS MATERIALIZED (
  SELECT j.request_id, j.state, j.dispatch_id,
         (j.ctx ? 'remoteNativeBillingRecovery') AS has_rem_recovery,
         (${rfj_v4_cond}) AS is_v4_surv
    FROM request_finalize_journal j
   WHERE ${rfj_open_cond}
)
SELECT
  (SELECT count(*) FROM open_dispatches WHERE status IN ('admitted','rejecting')),
  (SELECT count(*) FROM open_dispatches WHERE status = 'accepted'),
  (SELECT count(*) FROM open_dispatches WHERE is_survivable IS TRUE),
  (SELECT count(*) FROM open_rab WHERE is_v4_surv IS NOT TRUE),
  (SELECT count(*) FROM open_rfj j
    WHERE j.is_v4_surv IS NOT TRUE
      AND ((j.has_rem_recovery AND j.state IN ('inflight','finalizing'))
        OR j.state = 'finalizing'
        OR (j.state NOT IN ('aborted','committed')
            AND NOT EXISTS (SELECT 1 FROM open_dispatches d WHERE d.dispatch_id = j.dispatch_id AND d.is_survivable IS TRUE)
            AND NOT EXISTS (SELECT 1 FROM turn_dispatches d WHERE d.dispatch_id = j.dispatch_id AND d.status = 'terminal' AND d.terminal_at IS NOT NULL)))),
  COALESCE((SELECT string_agg(container_ref, ',') FROM open_dispatches WHERE is_survivable IS TRUE), ''),
  (SELECT count(*) FROM open_rab WHERE is_v4_surv IS TRUE),
  (SELECT count(*) FROM open_rfj WHERE is_v4_surv IS TRUE),
  concat_ws(',',
    NULLIF(COALESCE((SELECT string_agg(container_ref, ',') FROM open_rab WHERE is_v4_surv IS TRUE), ''), ''),
    NULLIF(COALESCE((SELECT string_agg(d.container_ref, ',') FROM open_rfj j JOIN open_dispatches d ON d.dispatch_id = j.dispatch_id WHERE j.is_v4_surv IS TRUE AND d.is_survivable IS TRUE), ''), ''));
COMMIT;"
}

# Evaluates PG tiered snapshot + local Docker Running check (supports both legacy 6-col & new 9-col format).
# Sets SELFHOST_PG_BLOCKING_STRICT, SELFHOST_PG_VERIFIED_REMOTE_V4_SURV,
# SELFHOST_PG_BLOCKING (= STRICT + VERIFIED_REMOTE_V4_SURV for fail-closed default),
# SELFHOST_PG_VERIFIED_SURV, SELFHOST_PG_SUMMARY.
selfhost_eval_pg_blocking_once() {
  local row non_acc total_acc cand_surv rem_bind_strict block_j_strict cand_refs=""
  local rem_bind_v4_cand="" rem_j_v4_cand="" rem_v4_refs=""
  SELFHOST_PG_BLOCKING=1
  SELFHOST_PG_BLOCKING_STRICT=1
  SELFHOST_PG_VERIFIED_SURV=0
  SELFHOST_PG_VERIFIED_REMOTE_V4_SURV=0
  SELFHOST_PG_SUMMARY="query-error"
  if ! row="$(selfhost_query_tiered_idle_pg)"; then return 1; fi
  if [[ ! "$row" =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+(\|.*)?$ ]]; then return 1; fi
  IFS='|' read -r non_acc total_acc cand_surv rem_bind_strict block_j_strict cand_refs rem_bind_v4_cand rem_j_v4_cand rem_v4_refs <<<"$row"
  rem_bind_v4_cand="${rem_bind_v4_cand:-0}"
  rem_j_v4_cand="${rem_j_v4_cand:-0}"
  [[ "$rem_bind_v4_cand" =~ ^[0-9]+$ && "$rem_j_v4_cand" =~ ^[0-9]+$ ]] || return 1

  local verified_surv=0 dead_local=0
  if (( cand_surv > 0 )); then
    if [[ -z "$cand_refs" ]]; then
      dead_local="$cand_surv"
    else
      local IFS_SAVE="$IFS" ref checked=0
      IFS=',' read -ra _refs <<<"$cand_refs"
      IFS="$IFS_SAVE"
      for ref in "${_refs[@]}"; do
        [[ -n "$ref" ]] || continue
        checked=$(( checked + 1 ))
        if selfhost_docker_container_running "$ref"; then
          verified_surv=$(( verified_surv + 1 ))
        else
          dead_local=$(( dead_local + 1 ))
        fi
      done
      (( checked < cand_surv )) && dead_local=$(( dead_local + cand_surv - checked ))
    fi
  fi
  local non_surv=$(( total_acc - verified_surv ))
  (( non_surv < 0 )) && non_surv=0

  local rem_v4_total=$(( rem_bind_v4_cand + rem_j_v4_cand ))
  local verified_rem_v4=0 dead_rem_v4=0
  if (( rem_v4_total > 0 )); then
    if [[ -z "$rem_v4_refs" ]]; then
      dead_rem_v4="$rem_v4_total"
    else
      local IFS_SAVE="$IFS" rref rchecked=0
      IFS=',' read -ra _rrefs <<<"$rem_v4_refs"
      IFS="$IFS_SAVE"
      for rref in "${_rrefs[@]}"; do
        [[ -n "$rref" ]] || continue
        rchecked=$(( rchecked + 1 ))
        if selfhost_docker_container_running "$rref"; then
          verified_rem_v4=$(( verified_rem_v4 + 1 ))
        else
          dead_rem_v4=$(( dead_rem_v4 + 1 ))
        fi
      done
      (( rchecked < rem_v4_total )) && dead_rem_v4=$(( dead_rem_v4 + rem_v4_total - rchecked ))
    fi
  fi
  (( verified_rem_v4 > rem_v4_total )) && verified_rem_v4="$rem_v4_total"

  SELFHOST_PG_VERIFIED_SURV="$verified_surv"
  SELFHOST_PG_VERIFIED_REMOTE_V4_SURV="$verified_rem_v4"
  SELFHOST_PG_BLOCKING_STRICT=$(( non_acc + non_surv + rem_bind_strict + block_j_strict + dead_rem_v4 ))
  SELFHOST_PG_BLOCKING=$(( SELFHOST_PG_BLOCKING_STRICT + verified_rem_v4 ))
  SELFHOST_PG_SUMMARY="non_acc=${non_acc} total_acc=${total_acc} verified_surv=${verified_surv} dead_docker=${dead_local} blocking_acc=${non_surv} remote_bind_strict=${rem_bind_strict} block_journal_strict=${block_j_strict} rem_v4_surv=${verified_rem_v4} rem_v4_dead=${dead_rem_v4}"
  return 0
}

# OCV5-855: Bidirectional attestation that independent remote-relay keeps v4 alive across Master flip.
# Returns 0 ONLY when ALL conditions hold (fail-closed otherwise):
#   1) old_slot /internal/v5/cutover-readiness reports ok, remoteRelayExternal, remoteRelayHealthy, non-empty remoteRelayInstanceId
#   2) cand_slot (if given) reports ok, remoteRelayExternal, remoteRelayHealthy, and EXACT same remoteRelayInstanceId
#   3) Direct probe of V5_REMOTE_RELAY_ACTIVE_SOCK reports healthy + accepting + EXACT same instanceId
SELFHOST_REMOTE_RELAY_INSTANCE_ID=""
selfhost_check_remote_relay_independent() { # <old_slot> [cand_slot]
  local old_slot="$1" cand_slot="${2:-}" raw code body old_inst
  SELFHOST_REMOTE_RELAY_INSTANCE_ID=""
  selfhost_valid_slot "$old_slot" || return 1

  raw="$(selfhost_priv_control_call "$old_slot" GET /internal/v5/cutover-readiness || printf '000\n')"
  code="${raw%%$'\n'*}"
  if [[ "$raw" == *$'\n'* ]]; then body="${raw#*$'\n'}"; else body=""; fi
  [[ "$code" == "200" && -n "$body" ]] || return 1
  if ! printf '%s\n' "$body" | jq -e '.ok == true and .remoteRelayExternal == true and .remoteRelayHealthy == true and (.remoteRelayInstanceId | type == "string" and length > 0)' >/dev/null 2>&1; then
    return 1
  fi
  old_inst="$(printf '%s\n' "$body" | jq -r '.remoteRelayInstanceId')"

  if [[ -n "$cand_slot" ]]; then
    selfhost_valid_slot "$cand_slot" || return 1
    local c_raw c_code c_body cand_inst
    c_raw="$(selfhost_priv_control_call "$cand_slot" GET /internal/v5/cutover-readiness || printf '000\n')"
    c_code="${c_raw%%$'\n'*}"
    if [[ "$c_raw" == *$'\n'* ]]; then c_body="${c_raw#*$'\n'}"; else c_body=""; fi
    [[ "$c_code" == "200" && -n "$c_body" ]] || return 1
    if ! printf '%s\n' "$c_body" | jq -e '.ok == true and .remoteRelayExternal == true and .remoteRelayHealthy == true and (.remoteRelayInstanceId | type == "string" and length > 0)' >/dev/null 2>&1; then
      return 1
    fi
    cand_inst="$(printf '%s\n' "$c_body" | jq -r '.remoteRelayInstanceId')"
    [[ "$cand_inst" == "$old_inst" ]] || return 1
  fi

  declare -F remote_relay_probe_health >/dev/null 2>&1 || return 1
  local relay_inst
  relay_inst="$(remote_relay_probe_health "${V5_REMOTE_RELAY_ACTIVE_SOCK:-/run/openclaude-v5-selfhost/remote-relay-active.sock}" 2>/dev/null)" || return 1
  [[ -n "$relay_inst" && "$relay_inst" == "$old_inst" ]] || return 1

  SELFHOST_REMOTE_RELAY_INSTANCE_ID="$relay_inst"
  return 0
}

# B7: Single strict survivability verifier used by BOTH pre-switch tiered gate AND
# post-switch old-slot drain. Re-verifies containerLinkEnabled==true on BOTH old & cand
# slots (fail-closed if cand_slot omitted/invalid or either slot false/404/unreachable),
# and additionally verifies 3-way remote-relay attestation when remote-v4 items exist.
SELFHOST_SURV_GATES_LOCAL_OK=0
SELFHOST_SURV_GATES_REMOTE_V4_OK=0
selfhost_verify_survivable_gates() { # <old_slot> <cand_slot> [fresh_old_body]
  local old_slot="$1" cand_slot="${2:-}" old_body="${3:-}"
  local raw code c_raw c_code c_body old_inst="" cand_inst="" relay_inst=""
  SELFHOST_SURV_GATES_LOCAL_OK=0
  SELFHOST_SURV_GATES_REMOTE_V4_OK=0
  selfhost_valid_slot "$old_slot" || return 1
  selfhost_valid_slot "$cand_slot" || return 1

  if [[ -z "$old_body" ]]; then
    raw="$(selfhost_priv_control_call "$old_slot" GET /internal/v5/cutover-readiness || printf '000\n')"
    code="${raw%%$'\n'*}"
    if [[ "$raw" == *$'\n'* ]]; then old_body="${raw#*$'\n'}"; else old_body=""; fi
    [[ "$code" == "200" && -n "$old_body" ]] || return 1
  fi
  printf '%s\n' "$old_body" | jq -e '.ok == true and .containerLinkEnabled == true' >/dev/null 2>&1 || return 1

  c_raw="$(selfhost_priv_control_call "$cand_slot" GET /internal/v5/cutover-readiness || printf '000\n')"
  c_code="${c_raw%%$'\n'*}"
  if [[ "$c_raw" == *$'\n'* ]]; then c_body="${c_raw#*$'\n'}"; else c_body=""; fi
  [[ "$c_code" == "200" && -n "$c_body" ]] || return 1
  printf '%s\n' "$c_body" | jq -e '.ok == true and .containerLinkEnabled == true' >/dev/null 2>&1 || return 1
  SELFHOST_SURV_GATES_LOCAL_OK=1

  if printf '%s\n' "$old_body" | jq -e '.remoteRelayExternal == true and .remoteRelayHealthy == true and (.remoteRelayInstanceId | type == "string" and length > 0)' >/dev/null 2>&1 \
     && printf '%s\n' "$c_body" | jq -e '.remoteRelayExternal == true and .remoteRelayHealthy == true and (.remoteRelayInstanceId | type == "string" and length > 0)' >/dev/null 2>&1; then
    old_inst="$(printf '%s\n' "$old_body" | jq -r '.remoteRelayInstanceId')"
    cand_inst="$(printf '%s\n' "$c_body" | jq -r '.remoteRelayInstanceId')"
    if [[ -n "$old_inst" && "$cand_inst" == "$old_inst" ]] && declare -F remote_relay_probe_health >/dev/null 2>&1; then
      if relay_inst="$(remote_relay_probe_health "${V5_REMOTE_RELAY_ACTIVE_SOCK:-/run/openclaude-v5-selfhost/remote-relay-active.sock}" 2>/dev/null)" \
         && [[ -n "$relay_inst" && "$relay_inst" == "$old_inst" ]]; then
        SELFHOST_SURV_GATES_REMOTE_V4_OK=1
        SELFHOST_REMOTE_RELAY_INSTANCE_ID="$relay_inst"
      fi
    fi
  fi
  return 0
}

selfhost_cutover_wait_for_safe_window() { # [--strict] [--slot=<A|B>] [--candidate-slot=<A|B>]
  local force_strict=0 explicit_slot="" cand_slot="" arg
  for arg in "$@"; do
    case "$arg" in
      --strict) force_strict=1 ;;
      --slot=*) explicit_slot="${arg#--slot=}" ;;
      --candidate-slot=*) cand_slot="${arg#--candidate-slot=}" ;;
    esac
  done
  local timeout_s="${OC_SELFHOST_IDLE_WAIT_TIMEOUT_SEC:-600}"
  local poll_s="${OC_SELFHOST_IDLE_WAIT_POLL_SEC:-5}"
  local started=$SECONDS deadline=$((SECONDS + timeout_s))
  local dual_mode=0
  if (( force_strict == 0 )) && (selfhost_master_dual_slot_active || [[ "${OC_SELFHOST_ALLOW_SURVIVABLE_CUTOVER:-0}" == "1" ]]); then
    dual_mode=1
  fi

  if [[ "${ALLOW_INFLIGHT:-0}" == 1 ]]; then
    [[ "${PG_DB:-}" == openclaude_v5_selfhost || "${OC_SELFHOST_TEST_ALLOW_INFLIGHT:-0}" == 1 ]] \
      || { selfhost_ds_log "  ✗ --allow-inflight 仅用于 selfhost"; return 1; }
    if [[ "${DRY:-0}" != 1 && "${OC_SELFHOST_TEST_ALLOW_INFLIGHT:-0}" != 1 ]]; then
      if ! lease_train_load_lib || ! lease_inflight_train_allowed "${LEASE_TRAIN_ID:-}" "${LEASE_TARGET_SHA:-}"; then
        selfhost_ds_log "  ✗ --allow-inflight 缺少正式列车的精确源授权;拒绝切换"; return 1
      fi
    fi
    selfhost_ds_log "  --allow-inflight: 跳过个人版${timeout_s}s空闲/在途检查;用户已接受在途回合可能中断"
    return 0
  fi

  if [[ "${DRY:-0}" == 1 ]]; then
    selfhost_ds_log "  [dry-run] 切换前分级空闲门禁(dual_mode=${dual_mode}, 最多 ${timeout_s}s;不查询数据库)"
    return 0
  fi

  local old_slot="$explicit_slot"
  if (( dual_mode == 1 )) && [[ -z "$old_slot" ]]; then
    old_slot="$(selfhost_master_current_slot)"
  fi

  while :; do
    if ! selfhost_eval_pg_blocking_once; then
      selfhost_ds_log "  ✗ 无法只读确认分级空闲门禁;拒绝切换,旧 master 继续运行"
      return 1
    fi

    local non_surv_mem=0 readiness_state="skip-legacy" allow_survivable="$dual_mode" remote_relay_independent=0
    if (( dual_mode == 1 )); then
      local raw_resp http_code body cl_old="false" cl_new="true"
      raw_resp="$(selfhost_priv_control_call "$old_slot" GET /internal/v5/cutover-readiness || printf '000\n')"
      http_code="${raw_resp%%$'\n'*}"
      body="${raw_resp#*$'\n'}"
      if [[ "$http_code" == "200" && -n "$body" ]]; then
        if printf '%s\n' "$body" | jq -e '.ok == true and (.nonSurvivableInFlight | type == "number")' >/dev/null 2>&1; then
          non_surv_mem="$(printf '%s\n' "$body" | jq -r '.nonSurvivableInFlight | floor')"
          # B05: Require explicit containerLinkEnabled == true on old slot (fail-closed if false/absent)
          if printf '%s\n' "$body" | jq -e '.containerLinkEnabled == true' >/dev/null 2>&1; then
            cl_old="true"
          else
            allow_survivable=0
          fi
          readiness_state="ok(nonSurvivableInFlight=${non_surv_mem},cl_old=${cl_old})"
        else
          non_surv_mem=1; readiness_state="invalid-json"
        fi
      elif [[ "$http_code" == "404" ]]; then
        allow_survivable=0; readiness_state="legacy-404-strict-idle"
      else
        non_surv_mem=1; readiness_state="http-${http_code}"
      fi

      # B05 + B7: When candidate slot is specified, use unified selfhost_verify_survivable_gates
      # so pre-switch gate and post-switch old-slot drain enforce the exact same attestation.
      if (( allow_survivable == 1 )); then
        if selfhost_valid_slot "$cand_slot"; then
          if selfhost_verify_survivable_gates "$old_slot" "$cand_slot" "$body"; then
            cl_new="true"
            remote_relay_independent="$SELFHOST_SURV_GATES_REMOTE_V4_OK"
          else
            cl_new="false"
            allow_survivable=0
            remote_relay_independent=0
          fi
          readiness_state+=",cl_new=${cl_new}"
        elif selfhost_check_remote_relay_independent "$old_slot"; then
          remote_relay_independent=1
        fi
      fi
    fi

    local blocking_total
    if (( allow_survivable == 1 && remote_relay_independent == 1 )); then
      blocking_total=$(( SELFHOST_PG_BLOCKING_STRICT + non_surv_mem ))
    elif (( allow_survivable == 1 )); then
      blocking_total=$(( SELFHOST_PG_BLOCKING + non_surv_mem ))
    else
      blocking_total=$(( SELFHOST_PG_BLOCKING + SELFHOST_PG_VERIFIED_SURV + non_surv_mem ))
    fi

    selfhost_ds_log "  tiered-idle UTC=$(date -u +%FT%TZ) dual=${dual_mode} allow_surv=${allow_survivable} rem_relay_indep=${remote_relay_independent} ${SELFHOST_PG_SUMMARY} mem_probe=${readiness_state} elapsed=$((SECONDS - started))s"

    if (( blocking_total == 0 )); then
      if (( allow_survivable == 1 && (SELFHOST_PG_VERIFIED_SURV > 0 || SELFHOST_PG_VERIFIED_REMOTE_V4_SURV > 0) )); then
        selfhost_ds_log "  ✓ 分级门禁放行: ${SELFHOST_PG_VERIFIED_SURV} 个本机 Docker Running 的 v5 accepted 回合 + ${SELFHOST_PG_VERIFIED_REMOTE_V4_SURV} 个独立 remote-relay 保活的 v4 绑定/inflight 记账将无感延续 (rem_relay_indep=${remote_relay_independent}, 其余阻断项全 0)"
      fi
      return 0
    fi

    if (( SECONDS >= deadline )); then
      selfhost_ds_log "  ✗ 分级空闲门禁 ${timeout_s}s 超时(blocking=${blocking_total});拒绝切换,旧 master 继续运行"
      return 1
    fi
    sleep "$poll_s"
  done
}

# ── Blue-green Master orchestration (B03, B04, B11) ──────────────────────

selfhost_wait_slot_standby_ready() { # <slot> [timeout_s]
  local slot="$1" timeout_s="${2:-${OC_SELFHOST_STANDBY_TIMEOUT_SEC:-180}}" port priv i
  [[ "$timeout_s" =~ ^[1-9][0-9]*$ ]] || timeout_s=180
  port="$(selfhost_master_slot_port "$slot")" || return 1
  priv="$(selfhost_master_slot_priv_port "$slot")" || return 1
  for (( i = 1; i <= timeout_s; i++ )); do
    if selfhost_http_json_check "http://127.0.0.1:${port}/healthz" '.ok == true' \
       && selfhost_http_json_check "http://127.0.0.1:${priv}/healthz" '.ok == true and (.slot == $s or .leadership.slot == $s)' --arg s "$slot"; then
      return 0
    fi
    sleep "${OC_SELFHOST_STANDBY_POLL_SEC:-1}"
  done
  selfhost_ds_log "  ✗ standby 槽 ${slot} (${port}/${priv}) 在 ${timeout_s}s 内未就绪"
  return 1
}

selfhost_wait_slot_leader_vip() { # <slot> [timeout_ms]
  local slot="$1" timeout_ms="${2:-30000}" started_ms now_ms raw code body
  started_ms=$(( $(date +%s) * 1000 ))
  while :; do
    raw="$(selfhost_priv_control_call "$slot" GET /internal/v5/cutover-readiness || printf '000\n')"
    code="${raw%%$'\n'*}"
    body="${raw#*$'\n'}"
    if [[ "$code" == "200" && -n "$body" ]] \
       && printf '%s\n' "$body" | jq -e '.ok == true and .role == "leader" and .vipOwner == true' >/dev/null 2>&1; then
      return 0
    fi
    now_ms=$(( $(date +%s) * 1000 ))
    if (( now_ms - started_ms >= timeout_ms )); then
      selfhost_ds_log "  ✗ 槽 ${slot} 在 ${timeout_ms}ms 内未达成 role=leader && vipOwner=true (last code=${code} body=${body:0:180})"
      return 1
    fi
    sleep 0.2
  done
}

# B04 + B7: After frontdoor switches away from old_slot and drain-ws succeeds, wait
# for BOTH old_slot nonSurvivableInFlight == 0 AND PG blocking counts == 0.
# Whenever ANY survivable local or remote-v4 items exist, unconditionally re-verify
# BOTH old_slot AND new_slot containerLinkEnabled==true (and 3-way remote-relay
# attestation for v4 items). Missing new_slot with live survivable items fails closed!
selfhost_wait_old_slot_drained() { # <old_slot> [new_slot] [timeout_s]
  local slot="$1" new_slot="${2:-}" timeout_s="${3:-}"
  [[ -n "$timeout_s" ]] || timeout_s="${OC_SELFHOST_OLD_SLOT_DRAIN_TIMEOUT_SEC:-60}"
  local started=$SECONDS deadline=$((SECONDS + timeout_s)) raw code body inflight mem_ok=0
  while :; do
    mem_ok=0
    raw="$(selfhost_priv_control_call "$slot" GET /internal/v5/cutover-readiness || printf '000\n')"
    code="${raw%%$'\n'*}"
    if [[ "$raw" == *$'\n'* ]]; then body="${raw#*$'\n'}"; else body=""; fi
    if [[ "$code" == "404" ]]; then
      mem_ok=1
    elif [[ "$code" == "200" && -n "$body" ]] \
         && printf '%s\n' "$body" | jq -e '.ok == true and (.nonSurvivableInFlight | type == "number")' >/dev/null 2>&1; then
      inflight="$(printf '%s\n' "$body" | jq -r '.nonSurvivableInFlight | floor')"
      if (( inflight == 0 )); then
        mem_ok=1
      else
        selfhost_ds_log "  master-dual-slot: 等待旧槽 ${slot} 在途流完成 (nonSurvivableInFlight=${inflight}, elapsed=$((SECONDS - started))s)"
      fi
    fi

    if (( mem_ok == 1 )); then
      if [[ "${ALLOW_INFLIGHT:-0}" == 1 ]]; then
        return 0
      fi
      if selfhost_eval_pg_blocking_once; then
        local blocking_now="$SELFHOST_PG_BLOCKING_STRICT"
        if (( SELFHOST_PG_VERIFIED_SURV > 0 || SELFHOST_PG_VERIFIED_REMOTE_V4_SURV > 0 )); then
          local fresh_old=""
          [[ "$code" == "200" ]] && fresh_old="$body"
          selfhost_verify_survivable_gates "$slot" "$new_slot" "$fresh_old" || true
          if (( SELFHOST_SURV_GATES_LOCAL_OK != 1 )); then
            blocking_now=$(( blocking_now + SELFHOST_PG_VERIFIED_SURV + SELFHOST_PG_VERIFIED_REMOTE_V4_SURV ))
          elif (( SELFHOST_PG_VERIFIED_REMOTE_V4_SURV > 0 && SELFHOST_SURV_GATES_REMOTE_V4_OK != 1 )); then
            blocking_now=$(( blocking_now + SELFHOST_PG_VERIFIED_REMOTE_V4_SURV ))
          fi
        fi
        if (( blocking_now == 0 )); then
          return 0
        fi
      fi
      selfhost_ds_log "  master-dual-slot: 等待停槽前 PG 阻断项归零 (${SELFHOST_PG_SUMMARY} local_ok=${SELFHOST_SURV_GATES_LOCAL_OK} v4_ok=${SELFHOST_SURV_GATES_REMOTE_V4_OK}, elapsed=$((SECONDS - started))s)"
    fi

    if (( SECONDS >= deadline )); then
      selfhost_ds_log "  ✗ 旧槽 ${slot} 在 ${timeout_s}s 内未排空 (mem_ok=${mem_ok} pg_blocking=${SELFHOST_PG_BLOCKING:-?} pg_strict=${SELFHOST_PG_BLOCKING_STRICT:-?} local_ok=${SELFHOST_SURV_GATES_LOCAL_OK} v4_ok=${SELFHOST_SURV_GATES_REMOTE_V4_OK} code=${code})"
      return 1
    fi
    sleep "${OC_SELFHOST_DRAIN_POLL_SEC:-0.5}"
  done
}

# B11: Verified rollback — ONLY stop candidate @NEW after proving frontdoor==OLD,
# deploy_state==OLD/stable, pre-reopen hook (e.g. first-migration external relay teardown),
# verified remote-v4 reopen, OLD fencing==false, OLD leader&VIP, and 18790/healthz green.
# If ANY check fails, keep BOTH slots running, persist recovery lock, return 79.
selfhost_dual_slot_verified_rollback() { # <old_slot> <new_slot> <old_rel> [remote_relay_indep]
  local old_slot="$1" new_slot="$2" old_rel="$3" remote_relay_indep="${4:-0}"
  local new_unit cur_lv fd_ok=0 ds_ok=0 hook_ok=1 reopen_ok=0 lv_ok=0 hz_ok=0 unfence_ok=0
  new_unit="$(selfhost_master_slot_unit "$new_slot")"
  selfhost_ds_log "  master-dual-slot: 启动已校验回滚 (${new_slot} -> ${old_slot})"

  if selfhost_frontdoor_switch_verified "$old_slot"; then fd_ok=1; fi
  if cur_lv="$(selfhost_deploy_state_read_lock_version)" \
     && selfhost_deploy_state_cas_revert "$cur_lv" "$old_slot" "$old_rel" >/dev/null; then
    ds_ok=1
  fi
  selfhost_priv_control_call "$new_slot" POST /internal/v5/deploy/refresh-desired >/dev/null 2>&1 || true
  selfhost_priv_control_call "$old_slot" POST /internal/v5/deploy/refresh-desired >/dev/null 2>&1 || true

  # Only tear down external relay / reopen / unfence @OLD once frontdoor & deploy_state are
  # confirmed reverted to @OLD (otherwise @NEW may still serve traffic).
  if (( fd_ok == 1 && ds_ok == 1 )); then
    if [[ -n "${SELFHOST_PRE_REOPEN_OLD_HOOK:-}" ]] && declare -F "$SELFHOST_PRE_REOPEN_OLD_HOOK" >/dev/null 2>&1; then
      if ! "$SELFHOST_PRE_REOPEN_OLD_HOOK" "$old_slot"; then
        hook_ok=0
      fi
    fi
    if (( hook_ok == 1 )); then
      if (( remote_relay_indep == 0 )) && declare -F remote_v4_cutover_reopen >/dev/null 2>&1; then
        if OC_REMOTE_V4_DRAIN_SOCKET="$(selfhost_master_slot_drain_sock "$old_slot")" remote_v4_cutover_reopen; then
          reopen_ok=1
        fi
      else
        reopen_ok=1
      fi
      if (( reopen_ok == 1 )); then
        if selfhost_slot_unfence_and_verify "$old_slot"; then unfence_ok=1; fi
      fi
    fi
  fi
  if selfhost_wait_slot_leader_vip "$old_slot" 15000; then lv_ok=1; fi
  if selfhost_healthz_18790_ok; then hz_ok=1; fi

  if (( fd_ok == 1 && ds_ok == 1 && hook_ok == 1 && reopen_ok == 1 && unfence_ok == 1 && lv_ok == 1 && hz_ok == 1 )); then
    selfhost_ds_log "  ✓ 已核实旧槽 ${old_slot} 恢复接管 (frontdoor+deploy_state+reopen+unfence+leader/VIP+18790 全绿), 安全停候选槽 ${new_unit}"
    systemctl stop "$new_unit" 2>/dev/null || true
    return 1
  fi
  selfhost_mark_dual_slot_recovery_required "rollback_verification_failed" \
    "fd=${fd_ok} ds=${ds_ok} hook=${hook_ok} reopen=${reopen_ok} unfence=${unfence_ok} leader_vip=${lv_ok} healthz=${hz_ok} old=${old_slot} new=${new_slot}"
  return 79
}

# B04 + B11: Zero-vacuum blue-green flip sequence.
selfhost_master_dual_slot_flip() { # <rel>
  local rel="${1:-$(readlink -f -- "${MASTER_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}" 2>/dev/null || true)}"
  [[ -n "$rel" && -d "$rel" ]] || { selfhost_ds_log "  ✗ dual-slot flip: 无效 release=${rel:-<empty>}"; return 1; }

  local old_slot new_slot old_unit new_unit old_rel op_id lv_before lv_mid
  old_slot="$(selfhost_master_current_slot)"
  new_slot="$(selfhost_master_other_slot "$old_slot")" || return 1
  old_unit="$(selfhost_master_slot_unit "$old_slot")"
  new_unit="$(selfhost_master_slot_unit "$new_slot")"
  old_rel="$(readlink -f -- "$(selfhost_master_slot_link "$old_slot")" 2>/dev/null || true)"
  op_id="${LEASE_TRAIN_ID:-selfhost-flip-$$}"

  # 1) Offline preheat candidate @NEW (old slot serves normally during cold start)
  selfhost_ds_log "  master-dual-slot: [1/5] 离线预热候选槽 ${new_slot} (${new_unit}) → ${rel} (旧槽 ${old_slot} 正常服务)"
  atomic_flip_slot_symlink "$new_slot" "$rel" || { selfhost_ds_log "  ✗ 写 slot-${new_slot} symlink 失败"; return 1; }
  if ! systemctl start "$new_unit"; then
    selfhost_ds_log "  ✗ 启动候选槽 ${new_unit} 失败;旧槽 ${old_slot} 保持不受影响"
    return 1
  fi
  if ! selfhost_wait_slot_standby_ready "$new_slot"; then
    systemctl stop "$new_unit" 2>/dev/null || true
    return 1
  fi

  # B11: Safe abort before switch — tear down any pre-reopen hook (e.g. first-migration external relay),
  # verify old slot remote-v4 reopened, and verify old slot fencing==false BEFORE stopping @NEW!
  local remote_relay_indep=0
  _abort_before_switch() {
    local reason="${1:-pre_switch_abort}"
    if [[ -n "${SELFHOST_PRE_REOPEN_OLD_HOOK:-}" ]] && declare -F "$SELFHOST_PRE_REOPEN_OLD_HOOK" >/dev/null 2>&1; then
      if ! "$SELFHOST_PRE_REOPEN_OLD_HOOK" "$old_slot"; then
        return 79
      fi
    fi
    if (( remote_relay_indep == 0 )) && declare -F remote_v4_cutover_reopen >/dev/null 2>&1; then
      if ! OC_REMOTE_V4_DRAIN_SOCKET="$(selfhost_master_slot_drain_sock "$old_slot")" remote_v4_cutover_reopen; then
        selfhost_mark_dual_slot_recovery_required "remote_v4_reopen_failed" "reason=${reason} old=${old_slot} new=${new_slot}"
        return 79
      fi
    fi
    if ! selfhost_slot_unfence_and_verify "$old_slot"; then
      selfhost_mark_dual_slot_recovery_required "unfence_verify_failed" "reason=${reason} old=${old_slot} new=${new_slot}"
      return 79
    fi
    systemctl stop "$new_unit" 2>/dev/null || true
    return 1
  }

  # 2) Open admission fence on @OLD + drain remote-v4 on @OLD (skip drain if independent remote-relay keeps v4 alive)
  selfhost_ds_log "  master-dual-slot: [2/5] 对旧槽 ${old_slot} 开启 cutover-fence 与 remote-v4 校验"
  local fence_rc=0
  selfhost_slot_set_fence "$old_slot" true || fence_rc=$?
  if (( fence_rc == 0 )); then
    :
  elif (( fence_rc == 75 )); then
    selfhost_ds_log "  · 旧槽 ${old_slot} 尚无 cutover-fence 端点(404),分级门禁将按 fail-closed 严格空闲退避"
  else
    # B11: Uncertain fence write (e.g., lost ACK after server applied true) -> actively unfence & verify!
    _abort_before_switch "fence_enable_uncertain"
    return $?
  fi
  if selfhost_check_remote_relay_independent "$old_slot" "$new_slot"; then
    remote_relay_indep=1
    selfhost_ds_log "  ✓ 独立 remote-relay (instanceId=${SELFHOST_REMOTE_RELAY_INSTANCE_ID}) 双向证真健康，跳过旧槽 ${old_slot} 的 remote_v4_cutover_drain"
  elif declare -F remote_v4_cutover_drain >/dev/null 2>&1; then
    if ! OC_REMOTE_V4_DRAIN_SOCKET="$(selfhost_master_slot_drain_sock "$old_slot")" remote_v4_cutover_drain; then
      _abort_before_switch "remote_v4_drain_failed"
      return $?
    fi
  fi

  # 3) Run tiered idle gate UNDER active fence (checking containerLinkEnabled on BOTH old & new slots)
  selfhost_ds_log "  master-dual-slot: [3/5] 在 fence 生效下校验分级空闲门禁"
  if ! selfhost_cutover_wait_for_safe_window --slot="$old_slot" --candidate-slot="$new_slot"; then
    _abort_before_switch "tiered_idle_gate_failed"
    return $?
  fi

  # 4) Atomic switch: real PG CAS (with uncertain readback) -> frontdoor /switch + readback -> refresh-desired -> leader+VIP
  selfhost_ds_log "  master-dual-slot: [4/5] 真实 CAS deploy_state + 切 frontdoor ${old_slot}->${new_slot}"
  if ! lv_before="$(selfhost_deploy_state_read_lock_version)"; then
    selfhost_ds_log "  ✗ 无法读取 deploy_state.lock_version;取消切流"
    _abort_before_switch "ds_read_failed"
    return $?
  fi
  if ! lv_mid="$(selfhost_deploy_state_cas_switch "$lv_before" "$new_slot" "$rel" "$op_id")"; then
    # B11: Read back PG deploy_state to distinguish unapplied vs applied-with-lost-ACK
    local rb_row rb_slot rb_ph rb_lv rb_op
    if rb_row="$(selfhost_deploy_state_read)"; then
      IFS='|' read -r rb_slot _ _ rb_ph rb_lv _ _ rb_op <<<"$rb_row"
      if [[ "$rb_lv" == "$lv_before" && "$rb_slot" == "$old_slot" ]]; then
        _abort_before_switch "ds_cas_unapplied"
        return $?
      elif [[ "$rb_slot" == "$new_slot" || "$rb_op" == "$op_id" ]]; then
        selfhost_dual_slot_verified_rollback "$old_slot" "$new_slot" "$old_rel" "$remote_relay_indep"
        return $?
      fi
    fi
    selfhost_mark_dual_slot_recovery_required "ds_cas_uncertain" "old=${old_slot} new=${new_slot} lv_before=${lv_before}"
    return 79
  fi

  if ! selfhost_frontdoor_switch_verified "$new_slot"; then
    if [[ "$SELFHOST_LAST_FRONTDOOR_SLOT" == "$new_slot" ]]; then
      selfhost_ds_log "  · frontdoor 读回已为 ${new_slot},继续核对"
    else
      selfhost_dual_slot_verified_rollback "$old_slot" "$new_slot" "$old_rel" "$remote_relay_indep"
      return $?
    fi
  fi

  selfhost_priv_control_call "$old_slot" POST /internal/v5/deploy/refresh-desired >/dev/null 2>&1 || true
  selfhost_priv_control_call "$new_slot" POST /internal/v5/deploy/refresh-desired >/dev/null 2>&1 || true

  if ! selfhost_wait_slot_leader_vip "$new_slot" 30000; then
    selfhost_dual_slot_verified_rollback "$old_slot" "$new_slot" "$old_rel" "$remote_relay_indep"
    return $?
  fi

  # 5) Drain browser WS (4509) on @OLD (verify .ok==true) -> wait @OLD mem+PG drained -> CAS stable -> stop @OLD
  selfhost_ds_log "  master-dual-slot: [5/5] 排空旧槽 ${old_slot} 浏览器 WS(4509) 与在途流,并提交 stable"
  local drain_resp drain_code drain_body
  drain_resp="$(selfhost_priv_control_call "$old_slot" POST /internal/v5/drain-ws || printf '000\n')"
  drain_code="${drain_resp%%$'\n'*}"
  drain_body="${drain_resp#*$'\n'}"
  if [[ "$drain_code" != "200" || -z "$drain_body" ]] \
     || ! printf '%s\n' "$drain_body" | jq -e '.ok == true' >/dev/null 2>&1; then
    selfhost_mark_dual_slot_recovery_required "drain_ws_failed" "old=${old_slot} code=${drain_code} body=${drain_body:0:120}"
    return 79
  fi
  selfhost_ds_log "  master-dual-slot: 旧槽 ${old_slot} drain-ws ok ${drain_body:0:120}"

  if ! selfhost_wait_old_slot_drained "$old_slot" "$new_slot"; then
    selfhost_mark_dual_slot_recovery_required "old_slot_drain_timeout" "old=${old_slot} new=${new_slot}"
    return 79
  fi

  if ! selfhost_deploy_state_cas_stable "$lv_mid" "$new_slot" "$rel" >/dev/null; then
    selfhost_mark_dual_slot_recovery_required "ds_cas_stable_failed" "old=${old_slot} new=${new_slot} lv_mid=${lv_mid}"
    return 79
  fi
  if ! systemctl enable "$new_unit" >/dev/null 2>&1; then
    selfhost_mark_dual_slot_recovery_required "enable_new_unit_failed" "unit=${new_unit}"
    return 79
  fi
  if ! systemctl disable "$old_unit" >/dev/null 2>&1; then
    selfhost_mark_dual_slot_recovery_required "disable_old_unit_failed" "unit=${old_unit}"
    return 79
  fi
  if ! systemctl stop "$old_unit" >/dev/null 2>&1; then
    selfhost_mark_dual_slot_recovery_required "stop_old_unit_failed" "unit=${old_unit}"
    return 79
  fi
  selfhost_ds_log "  ✓ master-dual-slot: 切流完成 ${old_slot} -> ${new_slot} (${new_unit})"
  return 0
}

# B03: Safe first-time migration from legacy single-slot (OC_SLOT=A on 18790/18896)
# to frontdoor + @B (18795/18897): receives real pre-flip prev_live from caller,
# preheats @B offline first, polls frontdoor.sock ready, and restores prev_live + legacy on ANY failure.
selfhost_master_migrate_legacy_to_dual_slot() { # <rel> [prev_live]
  local rel="${1:-$(readlink -f -- "${MASTER_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}" 2>/dev/null || true)}"
  local prev_live="${2:-${CUTOVER_PREV_LIVE:-}}"
  [[ -n "$rel" && -d "$rel" ]] || { selfhost_ds_log "  ✗ legacy->dual-slot 迁移: 无效 release"; return 1; }
  if [[ -z "$prev_live" || "$prev_live" == "none" ]]; then
    prev_live="$(readlink -f -- "${MASTER_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}" 2>/dev/null || printf '%s' "$rel")"
  fi
  local legacy_unit="${V5_UNIT:-openclaude-v5-selfhost.service}"
  local legacy_enabled="false" lv_before lv_mid op_id="selfhost-migrate-$$"
  if systemctl is-enabled "$legacy_unit" >/dev/null 2>&1; then legacy_enabled="true"; fi

  selfhost_ds_log "  master-dual-slot: 首次迁移 legacy(A) -> frontdoor + @B (rel=${rel}, prev=${prev_live})"
  selfhost_write_json_atomic "$V5_MIGRATION_STATE_FILE" \
    "{\"phase\":\"migrating\",\"legacyUnit\":\"${legacy_unit}\",\"legacyEnabled\":${legacy_enabled},\"prevLive\":\"${prev_live}\",\"targetRel\":\"${rel}\",\"startedAt\":\"$(date -u +%FT%TZ)\"}" \
    || return 1

  install_selfhost_dual_slot_units /etc/systemd/system || return 1
  systemctl daemon-reload || return 1

  atomic_flip_slot_symlink B "$rel" || return 1
  if ! systemctl start "$(selfhost_master_slot_unit B)"; then
    systemctl stop "$(selfhost_master_slot_unit B)" 2>/dev/null || true
    systemctl reset-failed "$(selfhost_master_slot_unit B)" 2>/dev/null || true
    selfhost_ds_log "  ✗ 预热 @B 失败;legacy 零触碰"; rm -f -- "$V5_MIGRATION_STATE_FILE"; return 1
  fi
  if ! selfhost_wait_slot_standby_ready B; then
    systemctl stop "$(selfhost_master_slot_unit B)" 2>/dev/null || true
    rm -f -- "$V5_MIGRATION_STATE_FILE"; return 1
  fi

  if ! selfhost_cutover_wait_for_safe_window --strict; then
    systemctl stop "$(selfhost_master_slot_unit B)" 2>/dev/null || true
    rm -f -- "$V5_MIGRATION_STATE_FILE"; return 1
  fi

  _migrate_rollback() {
    local cur_lv i
    selfhost_ds_log "  master-dual-slot: 迁移失败 → 回滚至 legacy ${legacy_unit} (prev=${prev_live})"
    systemctl stop "$V5_FRONTDOOR_UNIT" 2>/dev/null || true
    systemctl stop "$(selfhost_master_slot_unit B)" 2>/dev/null || true
    if [[ -n "$prev_live" && -d "$prev_live" ]] && declare -F atomic_flip_live_symlink >/dev/null 2>&1; then
      atomic_flip_live_symlink "$prev_live" || true
    fi
    if cur_lv="$(selfhost_deploy_state_read_lock_version)"; then
      selfhost_deploy_state_cas_revert "$cur_lv" A "$prev_live" >/dev/null 2>&1 || true
    fi
    if [[ "$legacy_enabled" == "true" ]]; then
      systemctl enable "$legacy_unit" >/dev/null 2>&1 || true
    fi
    systemctl start "$legacy_unit" 2>/dev/null || true
    for (( i = 1; i <= 30; i++ )); do
      if selfhost_healthz_18790_ok; then
        selfhost_ds_log "  ✓ 回滚至 legacy ${legacy_unit} 后 18790 真实健康确认"
        rm -f -- "$V5_MIGRATION_STATE_FILE"
        return 1
      fi
      sleep "${OC_SELFHOST_MIGRATE_HEALTH_POLL_SEC:-1}"
    done
    selfhost_mark_dual_slot_recovery_required "migration_rollback_unhealthy" "prev=${prev_live}"
    return 79
  }

  if ! lv_before="$(selfhost_deploy_state_read_lock_version)" \
     || ! lv_mid="$(selfhost_deploy_state_cas_switch "$lv_before" B "$rel" "$op_id")"; then
    _migrate_rollback; return $?
  fi
  if ! selfhost_write_json_atomic "$V5_FRONTDOOR_STATE_FILE" "{\"slot\":\"B\",\"generation\":1,\"switchedAt\":\"$(date -u +%FT%TZ)\"}"; then
    _migrate_rollback; return $?
  fi

  systemctl stop "$legacy_unit" || { _migrate_rollback; return $?; }
  if ! systemctl start "$V5_FRONTDOOR_UNIT"; then
    _migrate_rollback; return $?
  fi
  if ! selfhost_wait_frontdoor_ready 15; then
    _migrate_rollback; return $?
  fi
  if ! selfhost_frontdoor_switch_verified B; then
    _migrate_rollback; return $?
  fi
  selfhost_priv_control_call B POST /internal/v5/deploy/refresh-desired >/dev/null 2>&1 || true
  if ! selfhost_wait_slot_leader_vip B 30000 || ! selfhost_healthz_18790_ok; then
    _migrate_rollback; return $?
  fi
  if ! selfhost_deploy_state_cas_stable "$lv_mid" B "$rel" >/dev/null; then
    _migrate_rollback; return $?
  fi
  if ! systemctl enable "$V5_FRONTDOOR_UNIT" "$(selfhost_master_slot_unit B)" >/dev/null 2>&1 \
     || ! systemctl disable "$legacy_unit" >/dev/null 2>&1; then
    _migrate_rollback; return $?
  fi
  rm -f -- "$V5_MIGRATION_STATE_FILE"
  selfhost_ds_log "  ✓ master-dual-slot: 已完成 legacy(A) -> frontdoor + @B 迁移"
  return 0
}

# B03: Rollback from dual-slot to an older release without frontdoor.mjs:
# verify PG revert succeeds BEFORE stopping dual-slot services.
selfhost_master_rollback_to_legacy() { # <old_rel>
  local old_rel="$1" legacy_unit="${V5_UNIT:-openclaude-v5-selfhost.service}" cur_lv
  selfhost_ds_log "  master-dual-slot: 目标 release (${old_rel}) 不含 frontdoor → 回退至 legacy ${legacy_unit}"
  if ! cur_lv="$(selfhost_deploy_state_read_lock_version)" \
     || ! selfhost_deploy_state_cas_revert "$cur_lv" A "$old_rel" >/dev/null; then
    selfhost_mark_dual_slot_recovery_required "rollback_to_legacy_pg_failed" "old_rel=${old_rel}"
    return 79
  fi
  systemctl stop "$V5_FRONTDOOR_UNIT" 2>/dev/null || true
  systemctl stop "$(selfhost_master_slot_unit A)" "$(selfhost_master_slot_unit B)" 2>/dev/null || true
  systemctl disable "$V5_FRONTDOOR_UNIT" "$(selfhost_master_slot_unit A)" "$(selfhost_master_slot_unit B)" >/dev/null 2>&1 || true
  systemctl enable "$legacy_unit" >/dev/null 2>&1 || true
  systemctl restart "$legacy_unit" || return 1
}

selfhost_master_restart_or_flip() { # [rel]
  # B11: Fail closed immediately if a previous uncertain dual-slot operation wrote recovery lock.
  if [[ -f "$V5_DUAL_SLOT_RECOVERY_LOCK" ]]; then
    selfhost_ds_log "  ✗ recovery_required 锁存在 (${V5_DUAL_SLOT_RECOVERY_LOCK}); 拒绝自动翻槽,需人工核实后清除"
    return 79
  fi
  local live_rel rel
  live_rel="$(readlink -f -- "${MASTER_LIVE_LINK:-/opt/openclaude/openclaude-v5-selfhost-live}" 2>/dev/null || true)"
  if [[ "${HOTCFG_SAGA_ROLLING_BACK:-0}" == "1" && -n "$live_rel" ]]; then
    rel="$live_rel"
  else
    rel="${1:-${live_rel:-${CUTOVER_REL:-}}}"
  fi
  if selfhost_master_dual_slot_active; then
    if [[ -n "$rel" && ! -f "$rel/scripts/v5-selfhost-frontdoor.mjs" ]]; then
      selfhost_master_rollback_to_legacy "$rel"
      return $?
    fi
    selfhost_master_dual_slot_flip "$rel"
  elif [[ "${OC_SELFHOST_ENABLE_DUAL_SLOT_MIGRATE:-0}" == "1" ]]; then
    selfhost_master_migrate_legacy_to_dual_slot "$rel" "${CUTOVER_PREV_LIVE:-}"
  else
    systemctl restart "${V5_UNIT:-openclaude-v5-selfhost.service}"
  fi
}

selfhost_master_describe_topology() {
  local out="" s
  selfhost_frontdoor_is_active && out="frontdoor"
  for s in A B; do
    selfhost_master_slot_is_active "$s" && out="${out:+$out,}slot$s"
  done
  [[ "$(systemctl is-active "${V5_UNIT:-openclaude-v5-selfhost.service}" 2>/dev/null || true)" == active ]] \
    && out="${out:+$out,}legacy"
  printf '%s' "${out:-none}"
}
