#!/usr/bin/env bash
# v5 selfhost PostgreSQL backup (OCV5-443).
#
# Before this script the selfhost database (openclaude_v5_selfhost, ~19 GB on
# 2026-10-16) had no backup at all, while every release train applies
# migrations to it and never rolls the schema back. The host has one disk at
# ~93%, and a full zstd dump is ~7.5 GB (client_session_turn_tape_records is
# ~6.9 GB of it), so a full local copy would push the disk under the 8 GiB
# release gate. Hence two tiers:
#
#   core  Every table's schema, and the data of every table except the large
#         session-content tables in V5SB_LARGE_TABLES. Identity, billing,
#         usage, catalog, settings, audit. Local, daily, keep V5SB_KEEP files.
#   full  The whole database, streamed to an off-host sink executable
#         (V5SB_FULL_SINK) without touching the local disk. Skipped and
#         reported as "unconfigured" when no sink is set.
#
# Disk safety (core): refuse to start unless free space after the estimated
# dump stays >= V5SB_MIN_FREE_GIB; while dumping, a watchdog aborts and
# deletes the partial file if free space drops below V5SB_ABORT_FREE_GIB.
# Never deletes anything except core-*.dump files (and their .sha256) in
# V5SB_DIR, oldest first, beyond V5SB_KEEP, and only after a new dump verified.
#
# Usage:
#   v5-selfhost-pg-backup.sh run [--tier core|full|all]   (timer default: all)
#   v5-selfhost-pg-backup.sh status                       (read-only)
#   v5-selfhost-pg-backup.sh drill [<core dump>]          (restore into a scratch DB, compare, drop)
#
# Exit codes: 0 ok (full may be "unconfigured"), 1 failure, 2 usage,
#             3 skipped or aborted for disk space, 4 another backup holds the lock.
# Non-zero exits trigger openclaude-v5-selfhost-watch-alert@ via OnFailure=.
set -Eeuo pipefail
umask 077

DB="${V5SB_DB:-openclaude_v5_selfhost}"
BACKUP_DIR="${V5SB_DIR:-/var/backups/openclaude-v5-selfhost}"
KEEP="${V5SB_KEEP:-7}"
MIN_FREE_GIB="${V5SB_MIN_FREE_GIB:-10}"
ABORT_FREE_GIB="${V5SB_ABORT_FREE_GIB:-9}"
STATUS_FILE="${V5SB_STATUS:-/var/lib/openclaude-v5-selfhost/pg-backup-status.json}"
LOCK_FILE="${V5SB_LOCK:-/run/openclaude-v5-selfhost-pg-backup.lock}"
DEPLOY_LOCK="${V5SB_DEPLOY_LOCK:-/run/openclaude-v5-selfhost/deploy.lock}"
DEPLOY_WAIT_SEC="${V5SB_DEPLOY_WAIT_SEC:-3600}"
LARGE_TABLES="${V5SB_LARGE_TABLES:-client_session_turn_tape_records client_session_live_frames client_session_turn_tape_model_records}"
COMPRESS="${V5SB_COMPRESS:-zstd:3}"
CORE_EST_DEFAULT_BYTES="${V5SB_CORE_EST_BYTES:-1073741824}"
FULL_SINK="${V5SB_FULL_SINK:-}"
WATCH_INTERVAL="${V5SB_WATCH_INTERVAL:-5}"
PG_DUMP="${V5SB_PG_DUMP:-pg_dump}"
PG_RESTORE="${V5SB_PG_RESTORE:-pg_restore}"
PSQL="${V5SB_PSQL:-psql}"
# Run pg tools as this OS user (peer auth on the local socket). Empty = as is.
PG_AS="${V5SB_PG_AS-postgres}"
DRILL_DB="${V5SB_DRILL_DB:-openclaude_v5_selfhost_restore_drill}"

GIB=1073741824

log() { printf '%s [pg-backup] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die_usage() { printf '%s\n' "$*" >&2; exit 2; }

as_pg() {
  if [[ -n "$PG_AS" ]]; then
    runuser -u "$PG_AS" -- "$@"
  else
    "$@"
  fi
}

avail_bytes() { # <dir>
  df -PB1 -- "$1" | awk 'NR==2 {print $4}'
}

now_iso() { date -u +%FT%TZ; }

# Merge one tier's result into the status file atomically. The previous
# lastOkAt/lastOkFile survive failures, so a stale backup stays visible.
write_status() { # <tier> <json-object-for-tier>
  local tier="$1" obj="$2" dir tmp
  dir="$(dirname -- "$STATUS_FILE")"
  install -d -m 755 -- "$dir"
  tmp="$(mktemp -p "$dir" .pg-backup-status.XXXXXX)"
  python3 - "$STATUS_FILE" "$tier" "$obj" >"$tmp" <<'PY'
import json, sys
path, tier, raw = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as fh:
        state = json.load(fh)
    if not isinstance(state, dict):
        state = {}
except (OSError, ValueError):
    state = {}
state["schemaVersion"] = 1
new = json.loads(raw)
old = state.get(tier) if isinstance(state.get(tier), dict) else {}
for key in ("lastOkAt", "lastOkFile", "lastOkBytes"):
    if key in old and key not in new:
        new[key] = old[key]
if new.get("result") == "ok":
    new["lastOkAt"] = new.get("at")
    if "file" in new:
        new["lastOkFile"] = new["file"]
    if "bytes" in new:
        new["lastOkBytes"] = new["bytes"]
state[tier] = new
json.dump(state, sys.stdout, ensure_ascii=False, sort_keys=True, indent=2)
sys.stdout.write("\n")
PY
  chmod 644 -- "$tmp"
  mv -T -- "$tmp" "$STATUS_FILE"
}

tier_json() { # key=value ... (numbers stay numbers when they look like integers)
  python3 - "$@" <<'PY'
import json, sys
out = {}
for arg in sys.argv[1:]:
    key, _, value = arg.partition("=")
    out[key] = int(value) if value.isdigit() else value
print(json.dumps(out, ensure_ascii=False))
PY
}

last_core_bytes() {
  [[ -f "$STATUS_FILE" ]] || { echo 0; return; }
  python3 - "$STATUS_FILE" <<'PY' 2>/dev/null || echo 0
import json, sys
state = json.load(open(sys.argv[1], encoding="utf-8"))
print(int((state.get("core") or {}).get("lastOkBytes") or 0))
PY
}

wait_deploy_free() {
  local waited=0
  [[ -e "$DEPLOY_LOCK" ]] || return 0
  # Probe with a shared lock and let go at once: deploy takes it exclusively
  # (scripts/deploy-v5-selfhost.sh acquire_selfhost_deploy_lock) and polls, so a
  # momentary probe only delays it by one poll interval at worst.
  while ! flock -n -s "$DEPLOY_LOCK" true 2>/dev/null; do
    if (( waited >= DEPLOY_WAIT_SEC )); then
      return 1
    fi
    if (( waited == 0 )); then log "deploy lock held, waiting up to ${DEPLOY_WAIT_SEC}s"; fi
    sleep 10
    waited=$((waited + 10))
  done
  return 0
}

exclude_args() {
  local t
  for t in $LARGE_TABLES; do
    printf -- '--exclude-table-data=public.%s\n' "$t"
  done
}

# ── core tier ────────────────────────────────────────────────────────────────
run_core() {
  local started est free need floor ts final partial pid rc reason bytes sha tdata
  started=$(date +%s)
  install -d -m 700 -- "$BACKUP_DIR"
  est=$(last_core_bytes)
  if (( est > 0 )); then est=$(( est * 3 / 2 )); else est=$CORE_EST_DEFAULT_BYTES; fi
  free=$(avail_bytes "$BACKUP_DIR")
  need=$(( est + MIN_FREE_GIB * GIB ))
  if (( free < need )); then
    reason="free=${free} < estimate=${est} + floor=${MIN_FREE_GIB}GiB"
    log "core SKIPPED_LOW_DISK $reason"
    write_status core "$(tier_json result=skipped_low_disk "at=$(now_iso)" "reason=$reason" "freeBytes=$free")"
    return 3
  fi

  ts=$(date -u +%Y%m%dT%H%M%SZ)
  final="$BACKUP_DIR/core-$ts.dump"
  partial="$final.partial"
  floor=$(( ABORT_FREE_GIB * GIB ))
  log "core start db=$DB est=${est} free=${free} -> $final"

  local -a args
  mapfile -t args < <(exclude_args)
  # The redirect is done by this (root) shell, so the file is root:root 0600.
  as_pg "$PG_DUMP" -Fc -Z "$COMPRESS" --no-password "${args[@]}" -d "$DB" >"$partial" &
  pid=$!
  reason=""
  while kill -0 "$pid" 2>/dev/null; do
    free=$(avail_bytes "$BACKUP_DIR")
    if (( free < floor )); then
      reason="free=${free} fell below abort floor ${ABORT_FREE_GIB}GiB during dump"
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      break
    fi
    sleep "$WATCH_INTERVAL"
  done
  rc=0
  wait "$pid" || rc=$?
  if [[ -n "$reason" ]]; then
    rm -f -- "$partial"
    log "core ABORTED_LOW_DISK $reason"
    write_status core "$(tier_json result=aborted_low_disk "at=$(now_iso)" "reason=$reason")"
    return 3
  fi
  if (( rc != 0 )) || [[ ! -s "$partial" ]]; then
    rm -f -- "$partial"
    log "core DUMP_FAILED rc=$rc"
    write_status core "$(tier_json result=dump_failed "at=$(now_iso)" "reason=pg_dump rc=$rc")"
    return 1
  fi

  # Verify: the archive TOC must be readable and contain table data.
  tdata=$("$PG_RESTORE" --list -- "$partial" 2>/dev/null | grep -c ' TABLE DATA ' || true)
  if [[ -z "$tdata" || "$tdata" -lt 1 ]]; then
    rm -f -- "$partial"
    log "core VERIFY_FAILED table_data=${tdata:-0}"
    write_status core "$(tier_json result=verify_failed "at=$(now_iso)" "reason=pg_restore --list table_data=${tdata:-0}")"
    return 1
  fi

  bytes=$(stat -c %s -- "$partial")
  sha=$(sha256sum -- "$partial" | awk '{print $1}')
  mv -T -- "$partial" "$final"
  printf '%s  %s\n' "$sha" "$(basename -- "$final")" >"$final.sha256"
  rotate_core
  log "core OK bytes=$bytes table_data=$tdata sha256=$sha seconds=$(( $(date +%s) - started ))"
  write_status core "$(tier_json result=ok "at=$(now_iso)" "file=$final" "bytes=$bytes" "sha256=$sha" \
    "tableData=$tdata" "durationSec=$(( $(date +%s) - started ))" "excludedData=$LARGE_TABLES")"
  return 0
}

rotate_core() {
  local -a files
  local i
  mapfile -t files < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'core-*.dump' -printf '%f\n' | sort)
  if (( ${#files[@]} > KEEP )); then
    for (( i = 0; i < ${#files[@]} - KEEP; i++ )); do
      rm -f -- "$BACKUP_DIR/${files[$i]}" "$BACKUP_DIR/${files[$i]}.sha256"
      log "core rotated out ${files[$i]}"
    done
  fi
  # A crashed earlier run may have left a partial; it is never a valid backup.
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'core-*.dump.partial' -mmin +360 -delete
}

# ── full tier ────────────────────────────────────────────────────────────────
run_full() {
  local started name rc dump_rc sink_rc
  if [[ -z "$FULL_SINK" ]]; then
    log "full UNCONFIGURED (set V5SB_FULL_SINK to an off-host sink executable)"
    write_status full "$(tier_json result=unconfigured "at=$(now_iso)")"
    return 0
  fi
  if [[ ! -x "$FULL_SINK" ]]; then
    log "full FAILED sink not executable: $FULL_SINK"
    write_status full "$(tier_json result=sink_missing "at=$(now_iso)" "reason=sink not executable")"
    return 1
  fi
  started=$(date +%s)
  name="full-$(date -u +%Y%m%dT%H%M%SZ).dump"
  log "full start -> sink $name"
  set +e
  as_pg "$PG_DUMP" -Fc -Z "$COMPRESS" --no-password -d "$DB" | "$FULL_SINK" "$name"
  local -a st=("${PIPESTATUS[@]}")
  set -e
  dump_rc=${st[0]}; sink_rc=${st[1]}
  rc=$(( dump_rc != 0 || sink_rc != 0 ))
  if (( rc != 0 )); then
    log "full FAILED pg_dump=$dump_rc sink=$sink_rc"
    write_status full "$(tier_json result=failed "at=$(now_iso)" "reason=pg_dump=$dump_rc sink=$sink_rc")"
    return 1
  fi
  log "full OK name=$name seconds=$(( $(date +%s) - started ))"
  write_status full "$(tier_json result=ok "at=$(now_iso)" "file=$name" "durationSec=$(( $(date +%s) - started ))")"
  return 0
}

# ── restore drill ────────────────────────────────────────────────────────────
run_drill() {
  local dump="${1:-}" exists t live got bad=0
  if [[ -z "$dump" ]]; then
    dump=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'core-*.dump' -printf '%p\n' | sort | tail -n 1)
  fi
  [[ -n "$dump" && -f "$dump" ]] || { log "drill: no core dump found"; return 1; }
  [[ "$DRILL_DB" != "$DB" ]] || { log "drill: refusing, drill db equals live db"; return 1; }
  exists=$(as_pg "$PSQL" -Atqc "select 1 from pg_database where datname='${DRILL_DB}'" postgres)
  [[ -z "$exists" ]] || { log "drill: $DRILL_DB already exists, refusing to touch it"; return 1; }
  log "drill restore $dump -> $DRILL_DB"
  as_pg "$PSQL" -qc "create database \"${DRILL_DB}\"" postgres
  # The archive is root-owned 0600; feed it on stdin so the postgres user needs no access.
  if ! as_pg "$PG_RESTORE" --no-owner --no-privileges --exit-on-error -d "$DRILL_DB" <"$dump"; then
    as_pg "$PSQL" -qc "drop database if exists \"${DRILL_DB}\"" postgres || true
    log "drill FAILED restore"
    return 1
  fi
  for t in users usage_records credit_ledger model_catalog schema_migrations; do
    live=$(as_pg "$PSQL" -Atqc "select count(*) from public.${t}" "$DB" 2>/dev/null || echo NA)
    got=$(as_pg "$PSQL" -Atqc "select count(*) from public.${t}" "$DRILL_DB" 2>/dev/null || echo NA)
    log "drill rows $t live=$live restored=$got"
    # Live keeps growing after the dump; restored may lag but never exceed it.
    if [[ "$got" == NA || ( "$live" != NA && "$got" -gt "$live" ) ]]; then bad=1; fi
  done
  as_pg "$PSQL" -qc "drop database \"${DRILL_DB}\"" postgres
  if (( bad )); then log "drill FAILED row check"; return 1; fi
  log "drill OK"
  write_status drill "$(tier_json result=ok "at=$(now_iso)" "file=$dump")"
  return 0
}

cmd="${1:-run}"
shift || true
case "$cmd" in
  status)
    if [[ -f "$STATUS_FILE" ]]; then cat -- "$STATUS_FILE"; else echo '{"schemaVersion":1,"core":null,"full":null}'; fi
    exit 0
    ;;
  run|drill) ;;
  -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
  *) die_usage "unknown command: $cmd" ;;
esac

tier=all
if [[ "$cmd" == run ]]; then
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tier) tier="${2:-}"; shift 2 ;;
      *) die_usage "unknown arg: $1" ;;
    esac
  done
  case "$tier" in core|full|all) ;; *) die_usage "bad --tier: $tier" ;; esac
fi

install -d -m 755 -- "$(dirname -- "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another pg-backup run holds $LOCK_FILE"
  exit 4
fi

if [[ "$cmd" == drill ]]; then
  run_drill "${1:-}"
  exit $?
fi

if ! wait_deploy_free; then
  log "deploy lock still held after ${DEPLOY_WAIT_SEC}s; not starting"
  write_status core "$(tier_json result=skipped_deploy_busy "at=$(now_iso)")"
  exit 1
fi

core_rc=0
full_rc=0
if [[ "$tier" == core || "$tier" == all ]]; then
  run_core || core_rc=$?
fi
if [[ "$tier" == full || "$tier" == all ]]; then
  run_full || full_rc=$?
fi
if (( core_rc != 0 )); then exit "$core_rc"; fi
exit "$full_rc"
