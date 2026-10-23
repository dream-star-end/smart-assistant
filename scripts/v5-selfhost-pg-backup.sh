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
# Off-host copies (OCV5-600): V5SB_OFFSITE names an executable with the
# interface of scripts/v5-selfhost-pg-backup-r2.sh. It replaces V5SB_FULL_SINK
# (setting both is a usage error): `precheck` runs before a full dump (exit 3 =
# skip, the copy would not fit), the dump streams into `full <name>`, and every
# verified core dump goes to `core <file>`. A failed core upload keeps the local
# core result ok and is recorded as the coreOffsite tier. The full tier uses
# V5SB_FULL_COMPRESS (default V5SB_COMPRESS), the first knob to turn when the
# off-host bucket runs full.
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
#             3 skipped or aborted for disk space (or, off-host, for the bucket cap),
#             4 another backup holds the lock, 5 off-host bucket above its warning line.
# Non-zero exits trigger openclaude-v5-selfhost-watch-alert@ via OnFailure=.
set -Eeuo pipefail
umask 077
# Deterministic glob/sort order: rotation relies on it.
export LC_ALL=C

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
OFFSITE="${V5SB_OFFSITE:-}"
FULL_COMPRESS="${V5SB_FULL_COMPRESS:-$COMPRESS}"
WATCH_INTERVAL="${V5SB_WATCH_INTERVAL:-2}"
PG_DUMP="${V5SB_PG_DUMP:-pg_dump}"
PG_RESTORE="${V5SB_PG_RESTORE:-pg_restore}"
PSQL="${V5SB_PSQL:-psql}"
STATUS_PY="${V5SB_STATUS_PY:-python3}"
# Run pg tools as this OS user (peer auth on the local socket). Empty = as is.
PG_AS="${V5SB_PG_AS-postgres}"
DRILL_DB="${V5SB_DRILL_DB:-openclaude_v5_selfhost_restore_drill}"
DRILL_FACTOR="${V5SB_DRILL_FACTOR:-30}"
PG_DATA_PATH="${V5SB_PG_DATA_PATH:-/var/lib/postgresql}"

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
  install -d -m 755 -- "$dir" || return 1
  tmp="$(mktemp -p "$dir" .pg-backup-status.XXXXXX)" || return 1
  # Callers run with set -e disabled (`run_core || rc=$?`): check every step, and
  # never let an empty or partial file replace the previous status.
  if ! "$STATUS_PY" - "$STATUS_FILE" "$tier" "$obj" >"$tmp" <<'PY'
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
  then
    unlink -- "$tmp" 2>/dev/null || true
    return 1
  fi
  if [[ ! -s "$tmp" ]] || ! chmod 644 -- "$tmp" || ! mv -T -- "$tmp" "$STATUS_FILE"; then
    unlink -- "$tmp" 2>/dev/null || true
    return 1
  fi
  return 0
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
  # Take a shared lock and hold it (fd 7) until the run exits: deploy takes it
  # exclusively (scripts/deploy-v5-selfhost.sh acquire_selfhost_deploy_lock) and
  # polls for up to 40 min. A dump holds AccessShareLock on every table and the
  # migrations set no lock_timeout, so a train that started mid-dump would queue
  # its DDL behind the dump and every query behind the DDL (OCV5-600); now the
  # train waits for the backup instead.
  exec 7<"$DEPLOY_LOCK" || return 1
  while ! flock -n -s 7 2>/dev/null; do
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
# Every step below checks its own result: run_core is called as `run_core || rc=$?`,
# which turns `set -e` off inside it (OCV5-443 review r1).
core_fail() { # <result> <reason>
  log "core ${1^^} $2"
  write_status core "$(tier_json "result=$1" "at=$(now_iso)" "reason=$2")" || log "status write failed"
}

# The backup dir must be a real directory owned by us, mode 0700, so nothing
# else can plant links or files in it.
ensure_backup_dir() {
  [[ ! -L "$BACKUP_DIR" ]] || return 1
  install -d -m 700 -- "$BACKUP_DIR" || return 1
  [[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || return 1
  [[ "$(stat -c %u -- "$BACKUP_DIR")" == "$(id -u)" ]] || return 1
  chmod 700 -- "$BACKUP_DIR"
}

# Wait for <pid> while sampling free space on <path>. Kills it when free space
# drops below <floor>, and samples once more after it exits (the last writes
# can land between two samples). Sets WD_RC and WD_REASON (empty = no abort).
watchdog_wait() { # <pid> <path> <floor-bytes> <what>
  local pid="$1" path="$2" floor="$3" what="$4" free
  WD_RC=0
  WD_REASON=""
  while kill -0 "$pid" 2>/dev/null; do
    free=$(avail_bytes "$path")
    if [[ ! "$free" =~ ^[0-9]+$ ]] || (( free < floor )); then
      WD_REASON="free=${free:-unknown} below abort floor ${ABORT_FREE_GIB}GiB during $what"
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      break
    fi
    sleep "$WATCH_INTERVAL"
  done
  wait "$pid" || WD_RC=$?
  if [[ -z "$WD_REASON" ]]; then
    free=$(avail_bytes "$path")
    if [[ ! "$free" =~ ^[0-9]+$ ]] || (( free < floor )); then
      WD_REASON="free=${free:-unknown} below abort floor ${ABORT_FREE_GIB}GiB after $what"
    fi
  fi
  return 0
}

# Removes one file this script owns: a plain name inside BACKUP_DIR, never a path.
drop_own() { # <basename>
  local name="$1"
  [[ -n "$name" && "$name" != */* && "$name" == core-* ]] || return 1
  rm -f -- "${BACKUP_DIR:?}/${name}"
}

run_core() {
  local started est free need floor ts name final partial sumfile p rc bytes sha tdata
  started=$(date +%s)
  if ! ensure_backup_dir; then
    core_fail dir_unsafe "$BACKUP_DIR is not a real directory owned by uid $(id -u)"
    return 1
  fi
  est=$(last_core_bytes)
  [[ "$est" =~ ^[0-9]+$ ]] || est=0
  if (( est > 0 )); then est=$(( est * 3 / 2 )); else est=$CORE_EST_DEFAULT_BYTES; fi
  free=$(avail_bytes "$BACKUP_DIR")
  if [[ ! "$free" =~ ^[0-9]+$ ]]; then
    core_fail df_failed "cannot read free space of $BACKUP_DIR"
    return 1
  fi
  need=$(( est + MIN_FREE_GIB * GIB ))
  if (( free < need )); then
    log "core SKIPPED_LOW_DISK free=${free} < estimate=${est} + floor=${MIN_FREE_GIB}GiB"
    write_status core "$(tier_json result=skipped_low_disk "at=$(now_iso)" \
      "reason=free=${free} < estimate=${est} + floor=${MIN_FREE_GIB}GiB" "freeBytes=$free")" || true
    return 3
  fi

  # Names carry a 1 s UTC stamp; a run right after another (same second) waits
  # for a fresh one. Anything still occupying the name (file or link) is refused.
  local try taken
  for (( try = 0; try < 3; try++ )); do
    ts=$(date -u +%Y%m%dT%H%M%SZ)
    name="core-$ts.dump"
    final="$BACKUP_DIR/$name"
    partial="$final.partial"
    sumfile="$final.sha256"
    taken=""
    for p in "$final" "$partial" "$sumfile"; do
      if [[ -e "$p" || -L "$p" ]]; then taken="$p"; fi
    done
    [[ -n "$taken" ]] || break
    sleep 1
  done
  if [[ -n "$taken" ]]; then
    core_fail path_exists "refusing to reuse existing path $taken"
    return 1
  fi
  floor=$(( ABORT_FREE_GIB * GIB ))
  log "core start db=$DB est=${est} free=${free} -> $final"

  local -a args
  mapfile -t args < <(exclude_args)
  # noclobber: the redirect never opens an existing file or follows a link.
  # Done by this (root) shell, so the file is root:root 0600 (umask 077).
  ( set -C; as_pg "$PG_DUMP" -Fc -Z "$COMPRESS" --no-password "${args[@]}" -d "$DB" >"$partial" ) &
  watchdog_wait $! "$BACKUP_DIR" "$floor" dump
  rc=$WD_RC
  if [[ -n "$WD_REASON" ]]; then
    drop_own "$name.partial" || true
    core_fail aborted_low_disk "$WD_REASON"
    return 3
  fi
  if (( rc != 0 )) || [[ ! -f "$partial" || -L "$partial" || ! -s "$partial" ]]; then
    drop_own "$name.partial" || true
    core_fail dump_failed "pg_dump rc=$rc"
    return 1
  fi

  # Verify: the archive TOC must be readable and contain table data.
  tdata=$("$PG_RESTORE" --list -- "$partial" 2>/dev/null | grep -c ' TABLE DATA ' || true)
  if [[ ! "$tdata" =~ ^[0-9]+$ ]] || (( tdata < 1 )); then
    drop_own "$name.partial" || true
    core_fail verify_failed "pg_restore --list table_data=${tdata:-0}"
    return 1
  fi

  bytes=$(stat -c %s -- "$partial" || true)
  sha=$(sha256sum -- "$partial" | awk '{print $1}' || true)
  if [[ ! "$bytes" =~ ^[0-9]+$ || ! "$sha" =~ ^[0-9a-f]{64}$ ]]; then
    drop_own "$name.partial" || true
    core_fail hash_failed "size or sha256 of $partial unreadable"
    return 1
  fi
  if ! mv -T -- "$partial" "$final" || [[ ! -f "$final" || -L "$final" || -e "$partial" ]]; then
    drop_own "$name.partial" || true
    core_fail promote_failed "mv $partial -> $final failed"
    return 1
  fi
  if ! ( set -C; printf '%s  %s\n' "$sha" "$name" >"$sumfile" ); then
    core_fail sidecar_failed "cannot write $sumfile (dump kept at $final)"
    return 1
  fi
  if ! rotate_core; then
    core_fail rotate_failed "rotation failed after writing $final"
    return 1
  fi
  log "core OK bytes=$bytes table_data=$tdata sha256=$sha seconds=$(( $(date +%s) - started ))"
  if ! write_status core "$(tier_json result=ok "at=$(now_iso)" "file=$final" "bytes=$bytes" "sha256=$sha" \
    "tableData=$tdata" "durationSec=$(( $(date +%s) - started ))" "excludedData=$LARGE_TABLES")"; then
    log "core status write failed"
    return 1
  fi
  if [[ -n "$OFFSITE" ]]; then
    offsite_core "$final" || return $?
  fi
  return 0
}

# The local core dump is already verified and recorded; an off-host failure only
# fails the run (so the unit alerts) and is recorded as its own tier.
offsite_core() { # <final>
  local orc=0 result=ok
  "$OFFSITE" core "$1" || orc=$?
  case "$orc" in
    0) ;;
    3) result=skipped_over_cap ;;
    5) result=ok_usage_warn ;;
    *) result=failed ;;
  esac
  log "coreOffsite ${result^^} rc=$orc"
  write_status coreOffsite "$(tier_json "result=$result" "at=$(now_iso)" "file=${1##*/}" "rc=$orc")" || true
  return "$orc"
}

# Only names that this script creates are ever deleted: each glob result is
# matched against a strict regex (no line splitting), links are skipped.
rotate_core() {
  local -a files=()
  local f base i
  for f in "$BACKUP_DIR"/core-*.dump; do
    base=${f##*/}
    [[ "$base" =~ ^core-[0-9]{8}T[0-9]{6}Z\.dump$ && -f "$f" && ! -L "$f" ]] || continue
    files+=("$base")
  done
  # Glob order is sorted under LC_ALL=C and names carry UTC stamps: oldest first.
  for (( i = 0; i + KEEP < ${#files[@]}; i++ )); do
    drop_own "${files[$i]}" || return 1
    drop_own "${files[$i]}.sha256" || return 1
    log "core rotated out ${files[$i]}"
  done
  # A crashed earlier run may have left a partial; it is never a valid backup.
  for f in "$BACKUP_DIR"/core-*.dump.partial; do
    base=${f##*/}
    [[ "$base" =~ ^core-[0-9]{8}T[0-9]{6}Z\.dump\.partial$ && -f "$f" && ! -L "$f" ]] || continue
    if [[ -n "$(find "$f" -maxdepth 0 -mmin +360 2>/dev/null)" ]]; then
      drop_own "$base" || return 1
    fi
  done
  return 0
}

# ── full tier ────────────────────────────────────────────────────────────────
run_full() {
  local started name rc dump_rc sink_rc sink prc=0
  local -a sink_args=()
  sink="${OFFSITE:-$FULL_SINK}"
  if [[ -z "$sink" ]]; then
    log "full UNCONFIGURED (set V5SB_OFFSITE or V5SB_FULL_SINK to an off-host sink executable)"
    write_status full "$(tier_json result=unconfigured "at=$(now_iso)")"
    return 0
  fi
  if [[ ! -x "$sink" ]]; then
    log "full FAILED sink not executable: $sink"
    write_status full "$(tier_json result=sink_missing "at=$(now_iso)" "reason=sink not executable")"
    return 1
  fi
  if [[ -n "$OFFSITE" ]]; then
    "$OFFSITE" precheck || prc=$?
    if (( prc == 3 )); then
      log "full SKIPPED_OVER_CAP (off-host precheck)"
      write_status full "$(tier_json result=skipped_over_cap "at=$(now_iso)" "compress=$FULL_COMPRESS")"
      return 3
    elif (( prc != 0 )); then
      log "full FAILED off-host precheck rc=$prc"
      write_status full "$(tier_json result=failed "at=$(now_iso)" "reason=precheck=$prc")"
      return 1
    fi
    sink_args=(full)
  fi
  started=$(date +%s)
  name="full-$(date -u +%Y%m%dT%H%M%SZ).dump"
  log "full start -> sink $name compress=$FULL_COMPRESS"
  set +e
  as_pg "$PG_DUMP" -Fc -Z "$FULL_COMPRESS" --no-password -d "$DB" | "$sink" "${sink_args[@]}" "$name"
  local -a st=("${PIPESTATUS[@]}")
  set -e
  dump_rc=${st[0]}; sink_rc=${st[1]}
  if [[ -n "$OFFSITE" ]]; then
    # 3: the sink killed its upload at the bucket cap (pg_dump then dies of SIGPIPE).
    if (( sink_rc == 3 )); then
      log "full ABORTED_OVER_CAP pg_dump=$dump_rc"
      write_status full "$(tier_json result=aborted_over_cap "at=$(now_iso)" "compress=$FULL_COMPRESS")"
      return 3
    fi
    # A failed pg_dump still ends the stream normally, so the sink may have stored
    # a truncated copy: have it dropped.
    if (( dump_rc != 0 )); then
      "$OFFSITE" discard-full "$name" || log "full: discard of $name failed"
    elif (( sink_rc == 5 )); then
      log "full OK name=$name, off-host bucket above its warning line"
      write_status full "$(tier_json result=ok "at=$(now_iso)" "file=$name" "usageWarn=1" "durationSec=$(( $(date +%s) - started ))")"
      return 5
    fi
  fi
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
# The scratch DB lives in the same PostgreSQL cluster and on the same disk, so
# it gets the same precheck + watchdog as a dump: restored size is estimated at
# V5SB_DRILL_FACTOR x the compressed dump.
run_drill() {
  local dump="${1:-}" exists t live got bad=0 size free need f
  if [[ -z "$dump" ]]; then
    for f in "$BACKUP_DIR"/core-*.dump; do
      if [[ "${f##*/}" =~ ^core-[0-9]{8}T[0-9]{6}Z\.dump$ && -f "$f" && ! -L "$f" ]]; then dump="$f"; fi
    done
  fi
  [[ -n "$dump" && -f "$dump" && ! -L "$dump" ]] || { log "drill: no core dump found"; return 1; }
  [[ "$DRILL_DB" != "$DB" ]] || { log "drill: refusing, drill db equals live db"; return 1; }
  size=$(stat -c %s -- "$dump")
  free=$(avail_bytes "$PG_DATA_PATH")
  [[ "$free" =~ ^[0-9]+$ ]] || { log "drill: cannot read free space of $PG_DATA_PATH"; return 1; }
  need=$(( size * DRILL_FACTOR + MIN_FREE_GIB * GIB ))
  if (( free < need )); then
    log "drill SKIPPED_LOW_DISK free=$free < ${DRILL_FACTOR}x dump ($size) + ${MIN_FREE_GIB}GiB"
    return 3
  fi
  exists=$(as_pg "$PSQL" -Atqc "select 1 from pg_database where datname='${DRILL_DB}'" postgres)
  [[ -z "$exists" ]] || { log "drill: $DRILL_DB already exists, refusing to touch it"; return 1; }
  log "drill restore $dump -> $DRILL_DB"
  as_pg "$PSQL" -qc "create database \"${DRILL_DB}\"" postgres || { log "drill: create database failed"; return 1; }
  # The archive is root-owned 0600; feed it on stdin so the postgres user needs no access.
  as_pg "$PG_RESTORE" --no-owner --no-privileges --exit-on-error -d "$DRILL_DB" <"$dump" &
  watchdog_wait $! "$PG_DATA_PATH" "$(( ABORT_FREE_GIB * GIB ))" restore
  if [[ -n "$WD_REASON" || "$WD_RC" != 0 ]]; then
    as_pg "$PSQL" -qc "drop database if exists \"${DRILL_DB}\"" postgres || true
    log "drill FAILED restore rc=$WD_RC ${WD_REASON}"
    if [[ -n "$WD_REASON" ]]; then return 3; fi
    return 1
  fi
  for t in users usage_records credit_ledger model_catalog schema_migrations; do
    live=$(as_pg "$PSQL" -Atqc "select count(*) from public.${t}" "$DB" 2>/dev/null || echo NA)
    got=$(as_pg "$PSQL" -Atqc "select count(*) from public.${t}" "$DRILL_DB" 2>/dev/null || echo NA)
    log "drill rows $t live=$live restored=$got"
    # Live keeps growing after the dump; restored may lag but never exceed it.
    if [[ ! "$got" =~ ^[0-9]+$ ]] || [[ "$live" =~ ^[0-9]+$ && "$got" -gt "$live" ]]; then bad=1; fi
  done
  as_pg "$PSQL" -qc "drop database \"${DRILL_DB}\"" postgres || { log "drill: drop database failed"; return 1; }
  if (( bad )); then log "drill FAILED row check"; return 1; fi
  log "drill OK"
  write_status drill "$(tier_json result=ok "at=$(now_iso)" "file=$dump")" || true
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
  -h|--help) sed -n '2,41p' "$0"; exit 0 ;;
  *) die_usage "unknown command: $cmd" ;;
esac

[[ -z "$OFFSITE" || -z "$FULL_SINK" ]] || die_usage "set V5SB_OFFSITE or V5SB_FULL_SINK, not both"
for knob in KEEP MIN_FREE_GIB ABORT_FREE_GIB DEPLOY_WAIT_SEC DRILL_FACTOR CORE_EST_DEFAULT_BYTES; do
  [[ "${!knob}" =~ ^[0-9]+$ ]] || die_usage "$knob must be a non-negative integer"
done
(( KEEP >= 1 )) || die_usage "V5SB_KEEP must be >= 1"
(( ABORT_FREE_GIB <= MIN_FREE_GIB )) || die_usage "V5SB_ABORT_FREE_GIB must be <= V5SB_MIN_FREE_GIB"
# BACKUP_DIR is the only place this script deletes from: absolute, not "/".
[[ "$BACKUP_DIR" == /?* && "$BACKUP_DIR" != *//* && "$BACKUP_DIR" != */ ]] || die_usage "V5SB_DIR must be an absolute directory path"

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
