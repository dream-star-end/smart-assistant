#!/usr/bin/env bash
# OCV5-931 Layer 1: Idempotent installer and verifier for host systemd control-plane QoS
# and cgroup v2 memory_recursiveprot ancestor-chain protection.
#
# Safety guarantees:
#   - Default mode is --dry-run (zero filesystem writes, zero systemctl calls).
#   - --apply writes persistent files atomically (mktemp + chmod 0644 + mv -Tf) BEFORE
#     cleaning up managed QoS runtime drop-in files under /run/systemd/system.control.
#   - NEVER runs `systemctl revert` and NEVER restarts/stops/enables any service.
#   - Preserves unrelated drop-ins (e.g. openclaude.service.d/selfheal.conf) and
#     non-QoS runtime drop-in files (e.g. 50-TasksMax.conf).
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DEPLOY_DIR="${REPO_ROOT}/deploy/v5-selfhost"
QOS_SRC_DIR="${DEPLOY_DIR}/qos"
DROPIN_NAME="10-v5-selfhost-qos.conf"

MODE_DRY_RUN=0
MODE_APPLY=0
MODE_VERIFY=0
SYSTEMD_DIR="/etc/systemd/system"
RUNTIME_CONTROL_DIR="/run/systemd/system.control"
CGROUP_ROOT="/sys/fs/cgroup"
TSC_QUEUE_SCRIPT="/run/v5-tsc-queue.py"
SKIP_RELOAD=0
SKIP_UNIT_TEMPLATES=0

# Exact byte thresholds for cgroup v2 verification (1 MiB = 1048576, 1 GiB = 1073741824)
BYTES_64M=67108864
BYTES_128M=134217728
BYTES_256M=268435456
BYTES_512M=536870912
BYTES_768M=805306368
BYTES_1024M=1073741824
BYTES_1536M=1610612736
BYTES_2304M=2415919104
BYTES_4608M=4831838208
BYTES_7G=7516192768
BYTES_9G=9663676416

# Repo filename (git-safe, no backslashes) -> systemd unit name (with \x2d escapes).
# Single quotes keep \x2d strictly literal.
DROPIN_MAPPINGS=(
  'system.slice.conf|system.slice'
  'system-openclaude-v5-selfhost.slice.conf|system-openclaude\x2dv5\x2dselfhost.slice'
  'system-openclaude-v5-selfhost-egress.slice.conf|system-openclaude\x2dv5\x2dselfhost\x2degress.slice'
  'system-openclaude-v5-selfhost-remote-relay.slice.conf|system-openclaude\x2dv5\x2dselfhost\x2dremote\x2drelay.slice'
  'system-postgresql.slice.conf|system-postgresql.slice'
  'user.slice.conf|user.slice'
  'user-0.slice.conf|user-0.slice'
  'postgresql@16-main.service.conf|postgresql@16-main.service'
  'redis-server.service.conf|redis-server.service'
  'openclaude.service.conf|openclaude.service'
  'cloudflared-oc.service.conf|cloudflared-oc.service'
  'ssh.service.conf|ssh.service'
)

# Static unit templates updated only when both source exists and target is already installed.
STATIC_UNIT_TEMPLATES=(
  'cloudflared-v5-selfhost.service'
  'openclaude-v5-selfhost-egress@.service'
  'openclaude-v5-selfhost-remote-relay@.service'
  'openclaude-v5-selfhost.service'
)

# Temporary runtime drop-in directories owned by OCV5-931 migration.
MANAGED_RUNTIME_DIRS=(
  'cloudflared-oc.service.d'
  'cloudflared-v5-selfhost.service.d'
  'openclaude-v5-selfhost-egress@A.service.d'
  'openclaude-v5-selfhost-egress@B.service.d'
  'openclaude-v5-selfhost-frontdoor.service.d'
  'openclaude-v5-selfhost@A.service.d'
  'openclaude-v5-selfhost@B.service.d'
  'openclaude.service.d'
  'postgresql@16-main.service.d'
  'redis-server.service.d'
  'user-0.slice.d'
)

# Only these QoS property drop-in files are removed from MANAGED_RUNTIME_DIRS;
# unrelated runtime property files (e.g. 50-TasksMax.conf) are preserved untouched.
MANAGED_RUNTIME_QOS_FILES=(
  '50-CPUWeight.conf'
  '50-IOWeight.conf'
  '50-MemoryLow.conf'
  '50-MemoryMin.conf'
  '50-MemoryHigh.conf'
  '50-MemoryMax.conf'
  '50-MemorySwapMax.conf'
)

usage() {
  cat <<'EOF'
Usage: install-v5-selfhost-qos.sh [OPTIONS]

Modes (default: --dry-run):
  --dry-run                    Print planned changes without writing files or reloading systemd
  --apply                      Atomically install persistent QoS slice, drop-ins, and unit templates
  --verify                     Verify persistent files, clean runtime control dir, and cgroup v2 hierarchy

Options:
  --systemd-dir <dir>          Systemd persistent unit dir (default: /etc/systemd/system)
  --runtime-control-dir <dir>  Systemd runtime control dir (default: /run/systemd/system.control)
  --cgroup-root <dir>          cgroup v2 mount root (default: /sys/fs/cgroup)
  --tsc-queue-script <path>    Legacy tsc queue script path (default: /run/v5-tsc-queue.py)
  --skip-reload                Skip `systemctl daemon-reload` and live systemd inspection
  --skip-unit-templates        Skip syncing unit template files (frontdoor, master@, egress@, relay@, cloudflared)
  -h, --help                   Show this help
EOF
}

log() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }

require_arg_value() {
  local flag="$1" val="${2:-}"
  [[ -n "$val" ]] || die "missing value for ${flag}"
}

parse_args() {
  while (( $# > 0 )); do
    case "$1" in
      --dry-run) MODE_DRY_RUN=1; shift ;;
      --apply) MODE_APPLY=1; shift ;;
      --verify) MODE_VERIFY=1; shift ;;
      --systemd-dir) require_arg_value "$1" "${2:-}"; SYSTEMD_DIR="$2"; shift 2 ;;
      --systemd-dir=*) SYSTEMD_DIR="${1#*=}"; require_arg_value "--systemd-dir" "$SYSTEMD_DIR"; shift ;;
      --runtime-control-dir) require_arg_value "$1" "${2:-}"; RUNTIME_CONTROL_DIR="$2"; shift 2 ;;
      --runtime-control-dir=*) RUNTIME_CONTROL_DIR="${1#*=}"; require_arg_value "--runtime-control-dir" "$RUNTIME_CONTROL_DIR"; shift ;;
      --cgroup-root) require_arg_value "$1" "${2:-}"; CGROUP_ROOT="$2"; shift 2 ;;
      --cgroup-root=*) CGROUP_ROOT="${1#*=}"; require_arg_value "--cgroup-root" "$CGROUP_ROOT"; shift ;;
      --tsc-queue-script) require_arg_value "$1" "${2:-}"; TSC_QUEUE_SCRIPT="$2"; shift 2 ;;
      --tsc-queue-script=*) TSC_QUEUE_SCRIPT="${1#*=}"; require_arg_value "--tsc-queue-script" "$TSC_QUEUE_SCRIPT"; shift ;;
      --skip-reload) SKIP_RELOAD=1; shift ;;
      --skip-unit-templates) SKIP_UNIT_TEMPLATES=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1 (use --help)" ;;
    esac
  done

  if (( MODE_DRY_RUN == 1 && MODE_APPLY == 1 )); then
    die "--dry-run and --apply are mutually exclusive"
  fi
  if (( MODE_DRY_RUN == 0 && MODE_APPLY == 0 && MODE_VERIFY == 0 )); then
    MODE_DRY_RUN=1
  fi
}

file_mode_octal() {
  local path="$1"
  stat -c '%a' -- "$path" 2>/dev/null || true
}

atomic_install_file() { # <src> <dst>
  local src="$1" dst="$2" dst_dir base tmp
  [[ -f "$src" ]] || die "missing source file: ${src}"

  if [[ -f "$dst" ]] && cmp -s -- "$src" "$dst" && [[ "$(file_mode_octal "$dst")" == "644" ]]; then
    log "unchanged: ${dst}"
    return 0
  fi

  if (( MODE_APPLY == 0 )); then
    log "[dry-run] would install ${dst} (from ${src})"
    return 0
  fi

  dst_dir="$(dirname -- "$dst")"
  base="$(basename -- "$dst")"
  mkdir -p -- "$dst_dir" || die "failed to mkdir ${dst_dir}"
  tmp="$(mktemp "${dst_dir}/.${base}.tmp.XXXXXX")" || die "failed to mktemp in ${dst_dir}"
  if ! cp -- "$src" "$tmp" || ! chmod 0644 "$tmp" || ! mv -Tf -- "$tmp" "$dst"; then
    rm -f -- "$tmp"
    die "failed atomic install: ${dst}"
  fi
  log "installed: ${dst}"
}

install_persistent_qos_files() {
  local slice_src="${DEPLOY_DIR}/oc-host-cmd.slice"
  local slice_dst="${SYSTEMD_DIR}/oc-host-cmd.slice"
  atomic_install_file "$slice_src" "$slice_dst"

  local entry src_name unit_name src_path dst_path
  for entry in "${DROPIN_MAPPINGS[@]}"; do
    src_name="${entry%%|*}"
    unit_name="${entry#*|}"
    src_path="${QOS_SRC_DIR}/${src_name}"
    dst_path="${SYSTEMD_DIR}/${unit_name}.d/${DROPIN_NAME}"
    atomic_install_file "$src_path" "$dst_path"
  done
}

sync_unit_templates() {
  if (( SKIP_UNIT_TEMPLATES == 1 )); then
    log "skip unit templates (--skip-unit-templates)"
    return 0
  fi

  local dual_slot_lib="${REPO_ROOT}/scripts/v5-selfhost-dual-slot-lib.sh"
  [[ -f "$dual_slot_lib" ]] || die "missing dual-slot lib: ${dual_slot_lib}"
  # shellcheck source=scripts/v5-selfhost-dual-slot-lib.sh
  source "$dual_slot_lib"

  local fd_dst="${SYSTEMD_DIR}/${V5_FRONTDOOR_UNIT}"
  local slot_dst="${SYSTEMD_DIR}/${V5_MASTER_SLOT_TPL}"
  local fd_rendered slot_rendered fd_same=0 slot_same=0
  fd_rendered="$(render_selfhost_frontdoor_unit)"
  slot_rendered="$(render_selfhost_master_slot_unit)"

  if [[ -f "$fd_dst" ]] && [[ "$(file_mode_octal "$fd_dst")" == "644" ]] \
     && cmp -s -- "$fd_dst" <(printf '%s\n' "$fd_rendered"); then
    fd_same=1
  fi
  if [[ -f "$slot_dst" ]] && [[ "$(file_mode_octal "$slot_dst")" == "644" ]] \
     && cmp -s -- "$slot_dst" <(printf '%s\n' "$slot_rendered"); then
    slot_same=1
  fi

  if (( fd_same == 1 && slot_same == 1 )); then
    log "unchanged: ${fd_dst}"
    log "unchanged: ${slot_dst}"
  elif (( MODE_APPLY == 0 )); then
    (( fd_same == 0 )) && log "[dry-run] would render unit template ${fd_dst}"
    (( slot_same == 0 )) && log "[dry-run] would render unit template ${slot_dst}"
  else
    install_selfhost_dual_slot_units "$SYSTEMD_DIR" || die "install_selfhost_dual_slot_units failed"
    log "installed: ${fd_dst}"
    log "installed: ${slot_dst}"
  fi

  local unit src dst
  for unit in "${STATIC_UNIT_TEMPLATES[@]}"; do
    src="${DEPLOY_DIR}/${unit}"
    dst="${SYSTEMD_DIR}/${unit}"
    if [[ ! -f "$src" ]]; then
      warn "missing static unit template source: ${src}"
      continue
    fi
    if [[ ! -f "$dst" ]]; then
      log "skip (not installed): ${dst}"
      continue
    fi
    atomic_install_file "$src" "$dst"
  done
}

is_managed_runtime_qos_file() {
  local name="$1" f
  for f in "${MANAGED_RUNTIME_QOS_FILES[@]}"; do
    [[ "$name" == "$f" ]] && return 0
  done
  return 1
}

cleanup_runtime_dropins() {
  [[ -n "$RUNTIME_CONTROL_DIR" && "$RUNTIME_CONTROL_DIR" != "/" ]] \
    || die "refusing unsafe --runtime-control-dir: '${RUNTIME_CONTROL_DIR}'"

  local d dir f target
  for d in "${MANAGED_RUNTIME_DIRS[@]}"; do
    dir="${RUNTIME_CONTROL_DIR}/${d}"
    [[ -d "$dir" ]] || continue

    local removed_any=0
    for f in "${MANAGED_RUNTIME_QOS_FILES[@]}"; do
      target="${dir}/${f}"
      if [[ -e "$target" || -L "$target" ]]; then
        removed_any=1
        if (( MODE_APPLY == 0 )); then
          log "[dry-run] would remove runtime QoS drop-in: ${target}"
        else
          rm -f -- "$target" || die "failed to remove runtime QoS drop-in: ${target}"
          log "removed runtime QoS drop-in: ${target}"
        fi
      fi
    done

    if (( MODE_APPLY == 0 )); then
      if (( removed_any == 1 )); then
        local has_other=0 entry base
        shopt -s nullglob dotglob
        for entry in "${dir}"/*; do
          base="$(basename -- "$entry")"
          if ! is_managed_runtime_qos_file "$base"; then
            has_other=1
            break
          fi
        done
        shopt -u nullglob dotglob
        if (( has_other == 0 )); then
          log "[dry-run] would rmdir empty runtime drop-in dir: ${dir}"
        else
          log "[dry-run] would preserve runtime drop-in dir with non-QoS files: ${dir}"
        fi
      fi
    else
      if rmdir -- "$dir" 2>/dev/null; then
        log "removed empty runtime drop-in dir: ${dir}"
      elif (( removed_any == 1 )); then
        log "preserved non-empty runtime drop-in dir (contains non-QoS files): ${dir}"
      fi
    fi
  done
}

tsc_queue_service_state() {
  if ! command -v systemctl >/dev/null 2>&1; then
    printf 'unavailable'
    return 0
  fi
  local state
  state="$(systemctl is-active v5-selfhost-tsc-queue.service 2>/dev/null || true)"
  state="${state//$'\r'/}"
  state="${state//$'\n'/}"
  state="${state//[[:space:]]/}"
  if [[ -z "$state" ]]; then
    printf 'unknown'
    return 0
  fi
  printf '%s' "$state"
}

tsc_queue_service_confirmed_stopped() {
  local state="$1"
  [[ "$state" == "inactive" || "$state" == "failed" ]]
}

cleanup_tsc_queue_script() {
  if [[ ! -e "$TSC_QUEUE_SCRIPT" && ! -L "$TSC_QUEUE_SCRIPT" ]]; then
    return 0
  fi

  local state
  state="$(tsc_queue_service_state)"
  if ! tsc_queue_service_confirmed_stopped "$state"; then
    warn "v5-selfhost-tsc-queue.service state is '${state}' (not confirmed inactive/failed); leaving ${TSC_QUEUE_SCRIPT} untouched"
    return 0
  fi

  if (( MODE_APPLY == 0 )); then
    log "[dry-run] would remove legacy tsc queue script: ${TSC_QUEUE_SCRIPT}"
    return 0
  fi

  rm -f -- "$TSC_QUEUE_SCRIPT" || die "failed to remove ${TSC_QUEUE_SCRIPT}"
  log "removed legacy tsc queue script: ${TSC_QUEUE_SCRIPT}"
}

reload_systemd() {
  if (( SKIP_RELOAD == 1 )); then
    log "skip daemon-reload (--skip-reload)"
    return 0
  fi

  if (( MODE_APPLY == 0 )); then
    log "[dry-run] would run: systemctl daemon-reload"
    return 0
  fi

  command -v systemctl >/dev/null 2>&1 || die "systemctl not found (pass --skip-reload for offline runs)"
  systemctl daemon-reload || die "systemctl daemon-reload failed"
  log "reloaded systemd manager configuration (daemon-reload; no services restarted)"

  # Best-effort diagnostic readout of active slices after daemon-reload.
  # On systemd 255, daemon-reload re-realizes cgroup v2 CPU/IO/Memory attributes immediately;
  # OOMScoreAdjust takes effect on the unit's next process start.
  local u
  for u in \
    'system.slice' \
    'system-openclaude\x2dv5\x2dselfhost.slice' \
    'system-postgresql.slice' \
    'user.slice' \
    'user-0.slice'; do
    local props
    props="$(systemctl show "$u" \
      -p CPUWeight -p IOWeight -p MemoryMin -p MemoryLow -p MemoryHigh -p MemoryMax \
      2>/dev/null | tr '\n' ' ' || true)"
    [[ -n "$props" ]] && log "systemd show ${u}: ${props}"
  done
}

# ── Verification helpers ─────────────────────────────────────────────────

VERIFY_PASS=0
VERIFY_FAIL=0

v_ok() {
  VERIFY_PASS=$((VERIFY_PASS + 1))
  printf 'OK   - %s\n' "$*"
}

v_fail() {
  VERIFY_FAIL=$((VERIFY_FAIL + 1))
  printf 'FAIL - %s\n' "$*" >&2
}

read_cgroup_raw() { # <path>
  local p="$1"
  [[ -r "$p" ]] || return 1
  local val
  IFS= read -r val <"$p" || return 1
  printf '%s' "$val"
}

is_uint() {
  local v="${1:-}"
  [[ "$v" =~ ^[0-9]+$ ]]
}

is_positive_uint() {
  local v="${1:-}"
  [[ "$v" =~ ^[0-9]+$ ]] && (( v > 0 ))
}

verify_unit_directives() { # <file> <label> <directive...>
  local file="$1" label="$2"; shift 2
  if [[ ! -f "$file" ]]; then
    v_fail "missing unit template ${label}: ${file}"
    return 0
  fi
  local missing=() d
  for d in "$@"; do
    if ! grep -Fxq -- "$d" "$file"; then
      missing+=("$d")
    fi
  done
  if (( ${#missing[@]} == 0 )); then
    v_ok "unit template QoS directives present: ${label}"
  else
    v_fail "unit template ${label} missing directives: ${missing[*]}"
  fi
}

# Verify a single active leaf service cgroup if its directory exists.
# Populates LEAF_LAST_MIN and LEAF_LAST_LOW (0 when absent or unreadable) for parent-sum checks.
LEAF_LAST_MIN=0
LEAF_LAST_LOW=0
verify_active_leaf() { # <cg_dir> <label> <min_mem_min> <min_mem_low> <min_cpu>
  local cg_dir="$1" label="$2" want_min="$3" want_low="$4" want_cpu="$5"
  LEAF_LAST_MIN=0
  LEAF_LAST_LOW=0
  [[ -d "$cg_dir" ]] || return 0

  local got_min="" got_low="" got_cpu="" ok=1
  got_min="$(read_cgroup_raw "${cg_dir}/memory.min" || true)"
  got_low="$(read_cgroup_raw "${cg_dir}/memory.low" || true)"
  got_cpu="$(read_cgroup_raw "${cg_dir}/cpu.weight" || true)"

  if is_uint "$got_min"; then LEAF_LAST_MIN="$got_min"; fi
  if is_uint "$got_low"; then LEAF_LAST_LOW="$got_low"; fi

  if (( want_min > 0 )); then
    if ! is_positive_uint "$got_min" || (( got_min < want_min )); then
      ok=0
    fi
  fi
  if (( want_low > 0 )); then
    if ! is_positive_uint "$got_low" || (( got_low < want_low )); then
      ok=0
    fi
  fi
  if (( want_cpu > 0 )); then
    if ! is_positive_uint "$got_cpu" || (( got_cpu < want_cpu )); then
      ok=0
    fi
  fi

  if (( ok == 1 )); then
    v_ok "active leaf ${label} meets thresholds (memory.min=${got_min:-0} memory.low=${got_low:-0} cpu.weight=${got_cpu:-0})"
  else
    v_fail "active leaf ${label} below threshold (got min='${got_min:-<missing>}' low='${got_low:-<missing>}' cpu='${got_cpu:-<missing>}', want min>=${want_min} low>=${want_low} cpu>=${want_cpu})"
  fi
}

run_verify() {
  VERIFY_PASS=0
  VERIFY_FAIL=0

  # 1. Persistent oc-host-cmd.slice
  local slice_src="${DEPLOY_DIR}/oc-host-cmd.slice"
  local slice_dst="${SYSTEMD_DIR}/oc-host-cmd.slice"
  if [[ -f "$slice_dst" ]] && cmp -s -- "$slice_src" "$slice_dst"; then
    v_ok "persistent slice matches repo: ${slice_dst}"
  else
    v_fail "persistent slice missing or drifted: ${slice_dst}"
  fi

  # 2. All 12 persistent drop-ins
  local entry src_name unit_name src_path dst_path
  for entry in "${DROPIN_MAPPINGS[@]}"; do
    src_name="${entry%%|*}"
    unit_name="${entry#*|}"
    src_path="${QOS_SRC_DIR}/${src_name}"
    dst_path="${SYSTEMD_DIR}/${unit_name}.d/${DROPIN_NAME}"
    if [[ -f "$dst_path" ]] && cmp -s -- "$src_path" "$dst_path"; then
      v_ok "persistent drop-in matches repo: ${unit_name}.d/${DROPIN_NAME}"
    else
      v_fail "persistent drop-in missing or drifted: ${dst_path}"
    fi
  done

  # 3. Unit templates (unless --skip-unit-templates)
  if (( SKIP_UNIT_TEMPLATES == 0 )); then
    verify_unit_directives \
      "${SYSTEMD_DIR}/openclaude-v5-selfhost-frontdoor.service" \
      "openclaude-v5-selfhost-frontdoor.service" \
      "CPUWeight=1000" "IOWeight=1000" "MemoryMin=64M" "MemoryLow=128M" "OOMScoreAdjust=-800"
    verify_unit_directives \
      "${SYSTEMD_DIR}/openclaude-v5-selfhost@.service" \
      "openclaude-v5-selfhost@.service" \
      "CPUWeight=1000" "IOWeight=1000" "MemoryMin=512M" "MemoryLow=768M" "OOMScoreAdjust=-800"

    if [[ -f "${SYSTEMD_DIR}/openclaude-v5-selfhost.service" ]]; then
      verify_unit_directives \
        "${SYSTEMD_DIR}/openclaude-v5-selfhost.service" \
        "openclaude-v5-selfhost.service" \
        "CPUWeight=1000" "IOWeight=1000" "MemoryMin=512M" "MemoryLow=768M" "OOMScoreAdjust=-800"
    fi
    if [[ -f "${SYSTEMD_DIR}/cloudflared-v5-selfhost.service" ]]; then
      verify_unit_directives \
        "${SYSTEMD_DIR}/cloudflared-v5-selfhost.service" \
        "cloudflared-v5-selfhost.service" \
        "CPUWeight=1000" "IOWeight=1000" "MemoryMin=64M" "MemoryLow=128M" "OOMScoreAdjust=-800"
    fi
    if [[ -f "${SYSTEMD_DIR}/openclaude-v5-selfhost-egress@.service" ]]; then
      verify_unit_directives \
        "${SYSTEMD_DIR}/openclaude-v5-selfhost-egress@.service" \
        "openclaude-v5-selfhost-egress@.service" \
        "CPUWeight=600" "IOWeight=600" "MemoryLow=256M" "OOMScoreAdjust=-500"
    fi
    if [[ -f "${SYSTEMD_DIR}/openclaude-v5-selfhost-remote-relay@.service" ]]; then
      verify_unit_directives \
        "${SYSTEMD_DIR}/openclaude-v5-selfhost-remote-relay@.service" \
        "openclaude-v5-selfhost-remote-relay@.service" \
        "CPUWeight=500" "IOWeight=500" "MemoryLow=64M" "OOMScoreAdjust=-500"
    fi
  fi

  # 4. Managed runtime QoS drop-in files must be absent (non-QoS runtime files allowed)
  local d f rt_target leftover=0
  for d in "${MANAGED_RUNTIME_DIRS[@]}"; do
    for f in "${MANAGED_RUNTIME_QOS_FILES[@]}"; do
      rt_target="${RUNTIME_CONTROL_DIR}/${d}/${f}"
      if [[ -e "$rt_target" || -L "$rt_target" ]]; then
        v_fail "leftover managed runtime QoS drop-in: ${rt_target}"
        leftover=1
      fi
    done
  done
  if (( leftover == 0 )); then
    v_ok "no managed runtime QoS drop-in files remaining under ${RUNTIME_CONTROL_DIR}"
  fi

  # 5. Legacy tsc queue script check (fail only when service is confirmed inactive/failed)
  if [[ -e "$TSC_QUEUE_SCRIPT" || -L "$TSC_QUEUE_SCRIPT" ]]; then
    local tsc_state
    tsc_state="$(tsc_queue_service_state)"
    if tsc_queue_service_confirmed_stopped "$tsc_state"; then
      v_fail "legacy script still present while v5-selfhost-tsc-queue.service is ${tsc_state}: ${TSC_QUEUE_SCRIPT}"
    else
      warn "legacy ${TSC_QUEUE_SCRIPT} preserved (v5-selfhost-tsc-queue.service state='${tsc_state}')"
      v_ok "legacy tsc queue script preserved safely while service state='${tsc_state}'"
    fi
  else
    v_ok "legacy tsc queue script absent: ${TSC_QUEUE_SCRIPT}"
  fi

  # 6. Kernel cgroup v2 ancestor-chain, byte-threshold, priority, and active-leaf verification
  local sys_cg="${CGROUP_ROOT}/system.slice"
  local master_cg="${CGROUP_ROOT}/system.slice/system-openclaude\x2dv5\x2dselfhost.slice"
  local pg_cg="${CGROUP_ROOT}/system.slice/system-postgresql.slice"
  local egress_cg="${CGROUP_ROOT}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2degress.slice"
  local relay_cg="${CGROUP_ROOT}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2dremote\x2drelay.slice"
  local user_cg="${CGROUP_ROOT}/user.slice"
  local user0_cg="${CGROUP_ROOT}/user.slice/user-0.slice"

  local sys_min="" sys_low="" sys_cpu=""
  local master_min="" master_low="" master_cpu=""
  local pg_min="" pg_low="" pg_cpu=""
  local egress_low="" egress_cpu=""
  local relay_low="" relay_cpu=""
  local user_cpu=""
  local user0_high="" user0_max="" user0_cpu=""

  # 6a. system.slice: memory.min >= 2304 MiB, memory.low >= 4608 MiB, cpu.weight >= 800
  sys_min="$(read_cgroup_raw "${sys_cg}/memory.min" || true)"
  sys_low="$(read_cgroup_raw "${sys_cg}/memory.low" || true)"
  sys_cpu="$(read_cgroup_raw "${sys_cg}/cpu.weight" || true)"

  if is_positive_uint "$sys_min" && (( sys_min >= BYTES_2304M )) \
     && is_positive_uint "$sys_low" && (( sys_low >= BYTES_4608M )) \
     && is_positive_uint "$sys_cpu" && (( sys_cpu >= 800 )); then
    v_ok "cgroup system.slice meets thresholds (memory.min=${sys_min} memory.low=${sys_low} cpu.weight=${sys_cpu})"
  else
    v_fail "cgroup system.slice below thresholds (got min='${sys_min:-<missing>}' low='${sys_low:-<missing>}' cpu='${sys_cpu:-<missing>}', want min>=${BYTES_2304M} low>=${BYTES_4608M} cpu>=800)"
  fi

  # 6b. system-openclaude\x2dv5\x2dselfhost.slice: memory.min >= 1024 MiB, memory.low >= 1536 MiB, cpu.weight >= 1000
  master_min="$(read_cgroup_raw "${master_cg}/memory.min" || true)"
  master_low="$(read_cgroup_raw "${master_cg}/memory.low" || true)"
  master_cpu="$(read_cgroup_raw "${master_cg}/cpu.weight" || true)"

  if is_positive_uint "$master_min" && (( master_min >= BYTES_1024M )) \
     && is_positive_uint "$master_low" && (( master_low >= BYTES_1536M )) \
     && is_positive_uint "$master_cpu" && (( master_cpu >= 1000 )); then
    if is_positive_uint "$sys_min" && (( sys_min >= master_min )) \
       && is_positive_uint "$sys_low" && (( sys_low >= master_low )); then
      v_ok "cgroup system-openclaude\\x2dv5\\x2dselfhost.slice meets thresholds & ancestor chain (memory.min=${master_min} memory.low=${master_low} cpu.weight=${master_cpu})"
    else
      v_fail "cgroup system-openclaude\\x2dv5\\x2dselfhost.slice truncated by system.slice ancestor (memory_recursiveprot)"
    fi
  else
    v_fail "cgroup system-openclaude\\x2dv5\\x2dselfhost.slice below thresholds (got min='${master_min:-<missing>}' low='${master_low:-<missing>}' cpu='${master_cpu:-<missing>}', want min>=${BYTES_1024M} low>=${BYTES_1536M} cpu>=1000)"
  fi

  # 6c. system-postgresql.slice: memory.min >= 1024 MiB, memory.low >= 1536 MiB, cpu.weight >= 800
  pg_min="$(read_cgroup_raw "${pg_cg}/memory.min" || true)"
  pg_low="$(read_cgroup_raw "${pg_cg}/memory.low" || true)"
  pg_cpu="$(read_cgroup_raw "${pg_cg}/cpu.weight" || true)"

  if is_positive_uint "$pg_min" && (( pg_min >= BYTES_1024M )) \
     && is_positive_uint "$pg_low" && (( pg_low >= BYTES_1536M )) \
     && is_positive_uint "$pg_cpu" && (( pg_cpu >= 800 )); then
    if is_positive_uint "$sys_min" && (( sys_min >= pg_min )) \
       && is_positive_uint "$sys_low" && (( sys_low >= pg_low )); then
      v_ok "cgroup system-postgresql.slice meets thresholds & ancestor chain (memory.min=${pg_min} memory.low=${pg_low} cpu.weight=${pg_cpu})"
    else
      v_fail "cgroup system-postgresql.slice truncated by system.slice ancestor (memory_recursiveprot)"
    fi
  else
    v_fail "cgroup system-postgresql.slice below thresholds (got min='${pg_min:-<missing>}' low='${pg_low:-<missing>}' cpu='${pg_cpu:-<missing>}', want min>=${BYTES_1024M} low>=${BYTES_1536M} cpu>=800)"
  fi

  # 6d. user.slice: 0 < cpu.weight <= 50 and system.slice cpu.weight >= 8 * user.slice cpu.weight
  user_cpu="$(read_cgroup_raw "${user_cg}/cpu.weight" || true)"
  if is_positive_uint "$user_cpu" && (( user_cpu <= 50 )); then
    v_ok "cgroup user.slice cpu.weight=${user_cpu} (<= 50)"
  else
    v_fail "cgroup user.slice cpu.weight invalid or > 50 ('${user_cpu:-<missing>}')"
  fi

  if is_positive_uint "$sys_cpu" && is_positive_uint "$user_cpu"; then
    if (( sys_cpu >= 8 * user_cpu )); then
      v_ok "cgroup CPU priority invariant: system.slice(${sys_cpu}) >= 8 * user.slice(${user_cpu})"
    else
      v_fail "cgroup CPU priority violated: system.slice(${sys_cpu}) < 8 * user.slice(${user_cpu})"
    fi
  else
    v_fail "cgroup CPU priority check skipped due to missing cpu.weight"
  fi

  # 6e. user-0.slice: 0 < memory.high <= 7 GiB, 0 < memory.max <= 9 GiB, 0 < cpu.weight <= 20
  user0_high="$(read_cgroup_raw "${user0_cg}/memory.high" || true)"
  user0_max="$(read_cgroup_raw "${user0_cg}/memory.max" || true)"
  user0_cpu="$(read_cgroup_raw "${user0_cg}/cpu.weight" || true)"

  if is_positive_uint "$user0_high" && (( user0_high <= BYTES_7G )) \
     && is_positive_uint "$user0_max" && (( user0_max <= BYTES_9G )) \
     && is_positive_uint "$user0_cpu" && (( user0_cpu <= 20 )); then
    v_ok "cgroup user-0.slice bounded (memory.high=${user0_high} memory.max=${user0_max} cpu.weight=${user0_cpu})"
  else
    v_fail "cgroup user-0.slice unbounded or above caps (got high='${user0_high:-<missing>}' max='${user0_max:-<missing>}' cpu='${user0_cpu:-<missing>}', want 0<high<=${BYTES_7G} 0<max<=${BYTES_9G} 0<cpu<=20)"
  fi

  # 6f. Optional active sub-slices (egress & remote-relay)
  if [[ -d "$egress_cg" ]]; then
    egress_low="$(read_cgroup_raw "${egress_cg}/memory.low" || true)"
    egress_cpu="$(read_cgroup_raw "${egress_cg}/cpu.weight" || true)"
    if is_positive_uint "$egress_low" && (( egress_low >= BYTES_512M )) \
       && is_positive_uint "$egress_cpu" && (( egress_cpu >= 600 )); then
      v_ok "cgroup system-openclaude\\x2dv5\\x2dselfhost\\x2degress.slice meets thresholds (memory.low=${egress_low} cpu.weight=${egress_cpu})"
    else
      v_fail "cgroup system-openclaude\\x2dv5\\x2dselfhost\\x2degress.slice below thresholds (got low='${egress_low:-<missing>}' cpu='${egress_cpu:-<missing>}', want low>=${BYTES_512M} cpu>=600)"
    fi
  fi

  if [[ -d "$relay_cg" ]]; then
    relay_low="$(read_cgroup_raw "${relay_cg}/memory.low" || true)"
    relay_cpu="$(read_cgroup_raw "${relay_cg}/cpu.weight" || true)"
    if is_positive_uint "$relay_low" && (( relay_low >= BYTES_128M )) \
       && is_positive_uint "$relay_cpu" && (( relay_cpu >= 500 )); then
      v_ok "cgroup system-openclaude\\x2dv5\\x2dselfhost\\x2dremote\\x2drelay.slice meets thresholds (memory.low=${relay_low} cpu.weight=${relay_cpu})"
    else
      v_fail "cgroup system-openclaude\\x2dv5\\x2dselfhost\\x2dremote\\x2drelay.slice below thresholds (got low='${relay_low:-<missing>}' cpu='${relay_cpu:-<missing>}', want low>=${BYTES_128M} cpu>=500)"
    fi
  fi

  # 6g. Active leaf service verification + parent >= sum(active children) invariants
  local sum_master_min=0 sum_master_low=0 slot
  for slot in A B; do
    if [[ -d "${master_cg}/openclaude-v5-selfhost@${slot}.service" ]]; then
      verify_active_leaf "${master_cg}/openclaude-v5-selfhost@${slot}.service" \
        "openclaude-v5-selfhost@${slot}.service" "$BYTES_512M" "$BYTES_768M" 1000
      sum_master_min=$((sum_master_min + LEAF_LAST_MIN))
      sum_master_low=$((sum_master_low + LEAF_LAST_LOW))
    fi
  done
  if (( sum_master_min > 0 || sum_master_low > 0 )); then
    if is_uint "$master_min" && is_uint "$master_low" \
       && (( master_min >= sum_master_min && master_low >= sum_master_low )); then
      v_ok "parent master slice covers sum of active master slots (min: ${master_min}>=${sum_master_min}, low: ${master_low}>=${sum_master_low})"
    else
      v_fail "parent master slice budget < sum of active master slots (parent min=${master_min:-0} low=${master_low:-0}, sum min=${sum_master_min} low=${sum_master_low})"
    fi
  fi

  local sum_pg_min=0 sum_pg_low=0
  if [[ -d "${pg_cg}/postgresql@16-main.service" ]]; then
    verify_active_leaf "${pg_cg}/postgresql@16-main.service" \
      "postgresql@16-main.service" "$BYTES_1024M" "$BYTES_1536M" 800
    sum_pg_min=$((sum_pg_min + LEAF_LAST_MIN))
    sum_pg_low=$((sum_pg_low + LEAF_LAST_LOW))
    if is_uint "$pg_min" && is_uint "$pg_low" \
       && (( pg_min >= sum_pg_min && pg_low >= sum_pg_low )); then
      v_ok "parent postgresql slice covers active postgresql@16-main.service (min: ${pg_min}>=${sum_pg_min}, low: ${pg_low}>=${sum_pg_low})"
    else
      v_fail "parent postgresql slice budget < active postgresql@16-main.service (parent min=${pg_min:-0} low=${pg_low:-0}, leaf min=${sum_pg_min} low=${sum_pg_low})"
    fi
  fi

  local sum_egress_low=0
  for slot in A B; do
    if [[ -d "${egress_cg}/openclaude-v5-selfhost-egress@${slot}.service" ]]; then
      verify_active_leaf "${egress_cg}/openclaude-v5-selfhost-egress@${slot}.service" \
        "openclaude-v5-selfhost-egress@${slot}.service" 0 "$BYTES_256M" 600
      sum_egress_low=$((sum_egress_low + LEAF_LAST_LOW))
    fi
  done
  if (( sum_egress_low > 0 )); then
    if is_uint "$egress_low" && (( egress_low >= sum_egress_low )); then
      v_ok "parent egress slice covers sum of active egress slots (low: ${egress_low}>=${sum_egress_low})"
    else
      v_fail "parent egress slice budget < sum of active egress slots (parent low=${egress_low:-0}, sum low=${sum_egress_low})"
    fi
  fi

  local sum_relay_low=0
  for slot in A B; do
    if [[ -d "${relay_cg}/openclaude-v5-selfhost-remote-relay@${slot}.service" ]]; then
      verify_active_leaf "${relay_cg}/openclaude-v5-selfhost-remote-relay@${slot}.service" \
        "openclaude-v5-selfhost-remote-relay@${slot}.service" 0 "$BYTES_64M" 500
      sum_relay_low=$((sum_relay_low + LEAF_LAST_LOW))
    fi
  done
  if (( sum_relay_low > 0 )); then
    if is_uint "$relay_low" && (( relay_low >= sum_relay_low )); then
      v_ok "parent remote-relay slice covers sum of active relay slots (low: ${relay_low}>=${sum_relay_low})"
    else
      v_fail "parent remote-relay slice budget < sum of active relay slots (parent low=${relay_low:-0}, sum low=${sum_relay_low})"
    fi
  fi

  local sum_sys_leaf_min=0 sum_sys_leaf_low=0
  local leaf_spec leaf_unit leaf_wmin leaf_wlow leaf_wcpu
  for leaf_spec in \
    "openclaude-v5-selfhost.service|${BYTES_512M}|${BYTES_768M}|1000" \
    "openclaude-v5-selfhost-frontdoor.service|${BYTES_64M}|${BYTES_128M}|1000" \
    "cloudflared-v5-selfhost.service|${BYTES_64M}|${BYTES_128M}|1000" \
    "redis-server.service|0|${BYTES_128M}|500" \
    "openclaude.service|0|${BYTES_256M}|500" \
    "cloudflared-oc.service|0|${BYTES_64M}|500" \
    "ssh.service|0|${BYTES_64M}|800"; do
    IFS='|' read -r leaf_unit leaf_wmin leaf_wlow leaf_wcpu <<<"$leaf_spec"
    if [[ -d "${sys_cg}/${leaf_unit}" ]]; then
      verify_active_leaf "${sys_cg}/${leaf_unit}" "$leaf_unit" "$leaf_wmin" "$leaf_wlow" "$leaf_wcpu"
      sum_sys_leaf_min=$((sum_sys_leaf_min + LEAF_LAST_MIN))
      sum_sys_leaf_low=$((sum_sys_leaf_low + LEAF_LAST_LOW))
    fi
  done

  # Verify system.slice budget >= sum of all active direct child slices + active direct child services
  local sum_sys_children_min="$sum_sys_leaf_min"
  local sum_sys_children_low="$sum_sys_leaf_low"
  is_uint "$master_min" && sum_sys_children_min=$((sum_sys_children_min + master_min))
  is_uint "$master_low" && sum_sys_children_low=$((sum_sys_children_low + master_low))
  is_uint "$pg_min" && sum_sys_children_min=$((sum_sys_children_min + pg_min))
  is_uint "$pg_low" && sum_sys_children_low=$((sum_sys_children_low + pg_low))
  is_uint "$egress_low" && sum_sys_children_low=$((sum_sys_children_low + egress_low))
  is_uint "$relay_low" && sum_sys_children_low=$((sum_sys_children_low + relay_low))

  if is_uint "$sys_min" && is_uint "$sys_low" \
     && (( sys_min >= sum_sys_children_min && sys_low >= sum_sys_children_low )); then
    v_ok "system.slice budget covers sum of active children (min: ${sys_min}>=${sum_sys_children_min}, low: ${sys_low}>=${sum_sys_children_low})"
  else
    v_fail "system.slice budget < sum of active children (parent min=${sys_min:-0} low=${sys_low:-0}, children min=${sum_sys_children_min} low=${sum_sys_children_low})"
  fi

  log "verify summary: passed=${VERIFY_PASS} failed=${VERIFY_FAIL}"
  (( VERIFY_FAIL == 0 ))
}

main() {
  parse_args "$@"

  if (( MODE_DRY_RUN == 1 || MODE_APPLY == 1 )); then
    install_persistent_qos_files
    sync_unit_templates
    cleanup_runtime_dropins
    cleanup_tsc_queue_script
    reload_systemd
  fi

  if (( MODE_VERIFY == 1 )); then
    run_verify
  fi
}

main "$@"
