#!/usr/bin/env bash
# v5-host-maint-lib.sh — bounded host-maintenance lease for V5 deploys (OCV5-117).
#
# Why: apt-daily-upgrade → needrestart restarted openclaude-v5-deploy-* and
# openclaude-selfheal-tunnel, dropping the production-mutation lease (2026-09-05 #4).
#
# Contract:
#   1. precheck: pgrep -x apt|apt-get|dpkg|unattended-upgr|needrestart → fail-closed
#   2. begin: if leftover maint-suspended.json has a different deployId, restore it
#      first; if apt-daily.timer / apt-daily-upgrade.timer are active, stop them
#      and record {deployId,suspendedAt,timers} atomically
#   3. restore: start the recorded timers and delete the json (idempotent)
#   4. restore-stale: if json exists, suspendedAt is older than 6h, and no
#      in-flight openclaude-v5-deploy-* (MainPID != 0), restore + logger
#
# Source from deploy-v5.sh, or run:
#   v5-host-maint-lib.sh precheck|suspend <deployId>|restore [deployId]|restore-stale
#
# Override (tests / hermetic):
#   OC_V5_MAINT_STATE_FILE   default /opt/openclaude/tmp/maint-suspended.json
#   OC_V5_MAINT_STALE_SECS   default 21600 (6h)
#   OC_V5_MAINT_NOW_EPOCH    pin "now" for stale comparison
#   OC_V5_MAINT_DEPLOY_GLOB  default openclaude-v5-deploy-*.service
set -euo pipefail

HOST_MAINT_TIMERS=(apt-daily.timer apt-daily-upgrade.timer)
HOST_MAINT_PGREP_PATTERN='apt|apt-get|dpkg|unattended-upgr|needrestart'

host_maint_state_file() {
  printf '%s\n' "${OC_V5_MAINT_STATE_FILE:-/opt/openclaude/tmp/maint-suspended.json}"
}

host_maint_now_epoch() {
  if [[ -n "${OC_V5_MAINT_NOW_EPOCH:-}" ]]; then
    printf '%s\n' "$OC_V5_MAINT_NOW_EPOCH"
    return 0
  fi
  date +%s
}

host_maint_now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

host_maint_stale_secs() {
  local n="${OC_V5_MAINT_STALE_SECS:-21600}"
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || n=21600
  printf '%s\n' "$n"
}

host_maint_deploy_glob() {
  printf '%s\n' "${OC_V5_MAINT_DEPLOY_GLOB:-openclaude-v5-deploy-*.service}"
}

# Parse ISO-8601 UTC (…Z or +00:00) to epoch. Empty/unparseable → empty stdout.
host_maint_iso_to_epoch() {
  local iso="${1:-}" epoch
  [[ -n "$iso" ]] || return 0
  epoch="$(date -u -d "$iso" +%s 2>/dev/null || true)"
  [[ "$epoch" =~ ^[0-9]+$ ]] || return 0
  printf '%s\n' "$epoch"
}

host_maint_read_json_field() {
  local file="$1" field="$2"
  python3 - "$file" "$field" <<'PY'
import json, sys
path, field = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)
val = data.get(field, "")
if isinstance(val, list):
    print(",".join(str(x) for x in val))
elif val is None:
    pass
else:
    print(val)
PY
}

host_maint_write_json() {
  local file="$1" deploy_id="$2" suspended_at="$3"
  shift 3
  local dir tmp
  dir="$(dirname -- "$file")"
  mkdir -p -m 700 "$dir"
  tmp="${file}.tmp.$$"
  HOST_MAINT_JSON_DEPLOY_ID="$deploy_id" \
  HOST_MAINT_JSON_SUSPENDED_AT="$suspended_at" \
  HOST_MAINT_JSON_TIMERS="$(IFS=','; echo "$*")" \
  python3 - "$tmp" <<'PY'
import json, os, sys
path = sys.argv[1]
timers = [t for t in os.environ.get("HOST_MAINT_JSON_TIMERS", "").split(",") if t]
doc = {
    "deployId": os.environ["HOST_MAINT_JSON_DEPLOY_ID"],
    "suspendedAt": os.environ["HOST_MAINT_JSON_SUSPENDED_AT"],
    "timers": timers,
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, separators=(",", ":"))
    fh.write("\n")
PY
  mv -f "$tmp" "$file"
}

# True if a detached/foreground deploy still has a live main process.
# RemainAfterExit leftover units (MainPID=0, SubState=exited) are NOT in-flight:
# they must not block the 6h restore fallback.
host_maint_deploy_in_flight() {
  local glob unit pid
  glob="$(host_maint_deploy_glob)"
  local -a units=()
  mapfile -t units < <(systemctl list-units --type=service --all --no-legend --plain "$glob" 2>/dev/null | awk '{print $1}' || true)
  for unit in "${units[@]+"${units[@]}"}"; do
    [[ "$unit" == openclaude-v5-deploy-*.service ]] || continue
    pid="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
      return 0
    fi
  done
  return 1
}

host_maint_timer_active() {
  local unit="$1"
  systemctl is-active --quiet "$unit"
}

# Ubuntu keeps `/usr/share/unattended-upgrades/unattended-upgrade-shutdown
# --wait-for-signal` as a pid-1 child for the whole boot (comm still truncates
# to unattended-upgr). That is not an in-progress upgrade; ignore it.
host_maint_is_shutdown_waiter() {
  local args="$1"
  [[ "$args" == *unattended-upgrade-shutdown* && "$args" == *--wait-for-signal* ]]
}

host_maint_precheck() {
  local hits pid args
  local -a bad=()
  hits="$(pgrep -x "$HOST_MAINT_PGREP_PATTERN" 2>/dev/null || true)"
  if [[ -z "$hits" ]]; then
    echo "  ✓ host-maint precheck: no apt/dpkg/needrestart process"
    return 0
  fi
  while read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    args="$(ps -o args= -p "$pid" 2>/dev/null || true)"
    if host_maint_is_shutdown_waiter "$args"; then
      echo "  · host-maint precheck: ignore unattended-upgrade-shutdown --wait-for-signal pid=$pid"
      continue
    fi
    bad+=("$pid ${args:-<no-cmdline>}")
  done <<<"$hits"
  if [[ ${#bad[@]} -eq 0 ]]; then
    echo "  ✓ host-maint precheck: only the unattended-upgrade-shutdown waiter is present"
    return 0
  fi
  echo "✗ 拒绝启动:宿主维护进程仍在运行 (pgrep -x ${HOST_MAINT_PGREP_PATTERN})。" >&2
  echo "  命中:" >&2
  printf '  %s\n' "${bad[@]}" >&2
  echo "  等 apt/dpkg/unattended-upgrades/needrestart 退出后再发；不要 --allow-unverified-ci，不要 KillMode=none。" >&2
  return 1
}

# Restore timers listed in the state file. If $1 (deployId) is non-empty and
# does not match the file, leave the file alone (another deploy owns it).
# Empty $1 = force (ExecStopPost / restore-stale / leftover takeover).
host_maint_restore() {
  local want_id="${1:-}"
  local file owner timers_csv timer
  file="$(host_maint_state_file)"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  owner="$(host_maint_read_json_field "$file" deployId || true)"
  if [[ -n "$want_id" && -n "$owner" && "$want_id" != "$owner" ]]; then
    echo "  · host-maint restore skipped: file deployId=$owner != $want_id"
    return 0
  fi
  timers_csv="$(host_maint_read_json_field "$file" timers || true)"
  IFS=',' read -r -a timers <<<"$timers_csv"
  for timer in "${timers[@]+"${timers[@]}"}"; do
    [[ -n "$timer" ]] || continue
    case "$timer" in
      apt-daily.timer|apt-daily-upgrade.timer) ;;
      *)
        echo "⚠ host-maint restore: ignore non-allowlisted timer $timer" >&2
        continue
        ;;
    esac
    if systemctl start "$timer"; then
      echo "  ✓ host-maint restored $timer"
    else
      echo "⚠ host-maint failed to start $timer (will keep state file for retry)" >&2
      return 1
    fi
  done
  rm -f -- "$file"
  echo "  ✓ host-maint lease released (${file})"
  return 0
}

host_maint_restore_owned() {
  local id="${1:-}"
  [[ -n "$id" ]] || return 0
  host_maint_restore "$id" || true
}

# Stop active apt-daily timers and record original membership. No-op if none active
# (does not write json). Idempotent for the same deployId.
host_maint_suspend() {
  local deploy_id="${1:-}"
  local file timer
  local -a stopped=()
  [[ -n "$deploy_id" ]] || { echo "✗ host_maint_suspend requires deployId" >&2; return 2; }
  file="$(host_maint_state_file)"
  if [[ -f "$file" ]]; then
    local owner
    owner="$(host_maint_read_json_field "$file" deployId || true)"
    if [[ "$owner" == "$deploy_id" ]]; then
      echo "  · host-maint already held by deployId=$deploy_id"
      return 0
    fi
  fi
  for timer in "${HOST_MAINT_TIMERS[@]}"; do
    if host_maint_timer_active "$timer"; then
      stopped+=("$timer")
    fi
  done
  if [[ ${#stopped[@]} -eq 0 ]]; then
    echo "  · host-maint: apt-daily timers inactive, nothing to suspend"
    return 0
  fi
  for timer in "${stopped[@]}"; do
    systemctl stop "$timer" || { echo "✗ 无法 stop $timer" >&2; return 1; }
    echo "  ✓ host-maint stopped $timer"
  done
  host_maint_write_json "$file" "$deploy_id" "$(host_maint_now_iso)" "${stopped[@]}"
  echo "  ✓ host-maint lease written $file deployId=$deploy_id timers=${stopped[*]}"
}

# Take over leftover json (different deployId → force restore) then suspend.
host_maint_begin() {
  local deploy_id="${1:-}"
  local file owner
  [[ -n "$deploy_id" ]] || { echo "✗ host_maint_begin requires deployId" >&2; return 2; }
  file="$(host_maint_state_file)"
  if [[ -f "$file" ]]; then
    owner="$(host_maint_read_json_field "$file" deployId || true)"
    if [[ -n "$owner" && "$owner" != "$deploy_id" ]]; then
      echo "⚠ 上一轮维护租约未恢复 (deployId=$owner, file=$file); 先恢复再接管" >&2
      host_maint_restore || return 1
    fi
  fi
  host_maint_suspend "$deploy_id"
}

host_maint_restore_stale() {
  local file owner suspended_at epoch now stale age
  file="$(host_maint_state_file)"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  owner="$(host_maint_read_json_field "$file" deployId || true)"
  suspended_at="$(host_maint_read_json_field "$file" suspendedAt || true)"
  epoch="$(host_maint_iso_to_epoch "$suspended_at")"
  if [[ -z "$epoch" ]]; then
    echo "⚠ openclaude-maint: maint-suspended.json unreadable/unparseable (deployId=${owner:-?} suspendedAt=${suspended_at:-?}); leaving in place" >&2
    logger -t openclaude-maint "stale-check skipped: unparseable $file deployId=${owner:-?}" || true
    return 0
  fi
  now="$(host_maint_now_epoch)"
  stale="$(host_maint_stale_secs)"
  age=$(( now - epoch ))
  if (( age < stale )); then
    echo "  · host-maint lease still fresh (${age}s < ${stale}s); leaving $file"
    return 0
  fi
  if host_maint_deploy_in_flight; then
    echo "⚠ openclaude-maint: $file is ${age}s old but an openclaude-v5-deploy-* MainPID is live; not restoring" >&2
    logger -t openclaude-maint "stale lease not restored: deploy in-flight deployId=${owner:-?} age=${age}s" || true
    return 0
  fi
  echo "⚠ openclaude-maint: restoring stale maint lease deployId=${owner:-?} suspendedAt=$suspended_at age=${age}s" >&2
  logger -t openclaude-maint "stale maint lease restored deployId=${owner:-?} suspendedAt=$suspended_at age=${age}s" || true
  host_maint_restore
}

host_maint_cli() {
  case "${1:-}" in
    precheck)
      host_maint_precheck
      ;;
    begin|suspend)
      [[ -n "${2:-}" ]] || { echo "usage: $0 suspend <deployId>" >&2; return 2; }
      host_maint_begin "$2"
      ;;
    restore)
      host_maint_restore "${2:-}"
      ;;
    restore-stale)
      host_maint_restore_stale
      ;;
    *)
      echo "usage: $0 precheck|suspend <deployId>|restore [deployId]|restore-stale" >&2
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  host_maint_cli "$@"
fi
