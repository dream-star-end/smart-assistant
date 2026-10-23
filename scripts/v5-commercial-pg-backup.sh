#!/usr/bin/env bash
# v5 commercial PostgreSQL backup with an encrypted off-host copy on Cloudflare R2 (OCV5-600).
#
# Scheduled on v5-dev through the existing official production mutation lease.
# This foreground remote worker dumps locally (2 kept), uploads one encrypted full
# and two encrypted file backups to R2. A separate execution guardian checks the
# official lease proof while it runs, and kills this invocation's body on loss.
# It never acquires or renews a production lease. See the controller and install guide.
# Usage: v5-commercial-pg-backup.sh run | status
# Exit: 0 success, 1 failure, 2 usage, 3 skipped, 4 another backup, 5 R2 warning.
set -Eeuo pipefail
umask 077
export LC_ALL=C

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${V5CB_BACKUP_ENV:-/etc/openclaude/pg-r2-backup.env}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${V5CB_BACKUP_ENV:-/etc/openclaude/pg-r2-backup.env}"
  set +a
fi
# shellcheck source=scripts/lib/v5-commercial-backup-supervisor.sh
source "$SELF_DIR/lib/v5-commercial-backup-supervisor.sh"
BUN="${V5CB_BUN:-/root/.bun/bin/bun}"
LEASE_VERIFY="${V5CB_LEASE_VERIFY:-$SELF_DIR/v5-commercial-pg-backup-lease.ts}"
COMMERCIAL_ENV="${V5CB_COMMERCIAL_ENV:-/etc/openclaude/commercial-v5.env}"
DB="${V5CB_DB:-openclaude_commercial}"
BACKUP_DIR="${V5CB_DIR:-/var/backups/openclaude-v5-pg}"
KEEP="${V5CB_KEEP:-2}"
MIN_FREE_GIB="${V5CB_MIN_FREE_GIB:-10}"
COMPRESS="${V5CB_COMPRESS:-zstd:3}"
LOCK_FILE="${V5CB_LOCK:-/run/openclaude-v5-pg-r2-backup.lock}"
MARKER="${V5CB_MARKER:-/run/openclaude/pg-r2-backup.running}"
RUN_DIR="${V5CB_RUN_DIR:-/opt/openclaude/openclaude-v5-releases}"
FILES_SRC="${V5CB_FILES_SRC:-/var/backups/openclaude-v5}"
FILE_UNIT="${V5CB_FILE_BACKUP_UNIT:-openclaude-v5-backup.service}"
FILE_WAIT_SEC="${V5CB_FILE_BACKUP_WAIT_SEC:-1800}"
STATUS_FILE="${V5CB_STATUS:-/var/lib/openclaude-v5/pg-r2-backup-status.json}"
R2="${V5CB_R2:-$SELF_DIR/v5-selfhost-pg-backup-r2.sh}"
PG_DUMP="${V5CB_PG_DUMP:-pg_dump}"
PG_RESTORE="${V5CB_PG_RESTORE:-pg_restore}"
PSQL="${V5CB_PSQL:-psql}"
PG_AS="${V5CB_PG_AS-postgres}"
SYSTEMCTL="${V5CB_SYSTEMCTL:-systemctl}"
POLL="${V5CB_POLL_SEC:-15}"

# The helper's settings for the commercial bucket (env from the unit's EnvironmentFile wins).
export V5SB_DB="$DB" V5SB_PSQL="$PSQL" V5SB_PG_AS="$PG_AS"
export V5SB_R2_REMOTE="${V5SB_R2_REMOTE:-r2:ocv5-commercial-backup}"
export V5SB_R2_STATE="${V5SB_R2_STATE:-/var/lib/openclaude-v5/pg-backup-r2.json}"
export V5SB_FULL_COMPRESS="$COMPRESS"

GIB=1073741824
log() { printf '%s [pg-r2-backup] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die_usage() { printf '%s\n' "$*" >&2; exit 2; }
now_iso() { date -u +%FT%TZ; }

as_pg() {
  if [[ -n "$PG_AS" ]]; then runuser -u "$PG_AS" -- "$@"; else "$@"; fi
}

avail_bytes() { df -PB1 -- "$1" | awk 'NR==2 {print $4}'; }

write_status() { # key=value ... (one run, replaces the file)
  local dir tmp
  dir="$(dirname -- "$STATUS_FILE")"
  install -d -m 755 -- "$dir" || return 1
  tmp="$(mktemp -p "$dir" .pg-r2-backup-status.XXXXXX)" || return 1
  if python3 -c '
import json, sys
out = {"schemaVersion": 1}
for arg in sys.argv[1:]:
    k, _, v = arg.partition("=")
    out[k] = int(v) if v.isdigit() else v
print(json.dumps(out, ensure_ascii=False, sort_keys=True))
' "$@" >"$tmp" && chmod 644 -- "$tmp" && mv -T -- "$tmp" "$STATUS_FILE"; then
    return 0
  fi
  rm -f -- "$tmp"
  return 1
}

# Every qualification is bounded: a stuck database probe cannot stall the execution guardian.
qualify_lease() (
  [[ -f "$COMMERCIAL_ENV" && ! -L "$COMMERCIAL_ENV" ]] || return 1
  [[ "$(stat -c '%u:%a' "$COMMERCIAL_ENV")" == 0:600 ]] || return 1
  set -a
  # shellcheck source=/dev/null
  source "$COMMERCIAL_ENV"
  set +a
  timeout --signal=KILL --kill-after=1 5s "$BUN" "$LEASE_VERIFY" >/dev/null 2>&1
)

# The official lease is ours; a missing/stale proof or recovery state stops the run.
busy_reason() {
  local st
  qualify_lease || { echo "official production mutation lease is not qualified"; return; }
  for st in .manual-recovery-required .mutation-lane-inflight; do
    if [[ -e "$RUN_DIR/$st" ]]; then echo "$RUN_DIR/$st exists"; return; fi
  done
  st=$(as_pg "$PSQL" -d "$DB" -XAtqc \
    "select phase || '|' || coalesce(candidate_slot, '') || '|' || coalesce(candidate_release, '') from deploy_state where singleton" 2>/dev/null) \
    || { echo "cannot read deploy_state"; return; }
  [[ "$st" == "stable||" ]] || echo "deploy_state is '$st' (want stable, no candidate)"
}

MARKER_OWNED=0
write_marker() {
  local dir tmp
  dir="$(dirname -- "$MARKER")"
  install -d -m 755 -- "$dir" || return 1
  [[ ! -L "$MARKER" ]] || return 1
  tmp="$(mktemp -p "$dir" .pg-r2-backup.running.XXXXXX)" || return 1
  printf 'pid=%s started=%s\n' "$$" "$(now_iso)" >"$tmp" && chmod 644 -- "$tmp" \
    && mv -T -- "$tmp" "$MARKER" || { rm -f -- "$tmp"; return 1; }
  MARKER_OWNED=1
}
drop_marker() {
  (( MARKER_OWNED )) || return 0
  if [[ ! -L "$MARKER" ]] && grep -q "^pid=$$ " "$MARKER" 2>/dev/null; then rm -f -- "$MARKER"; fi
}

wait_file_backup() {
  local waited=0 state
  while :; do
    state=$("$SYSTEMCTL" show "$FILE_UNIT" -p ActiveState --value 2>/dev/null) || return 1
    case "$state" in
      inactive|failed) return 0 ;;
      active|activating|deactivating|reloading) ;;
      *) return 1 ;;
    esac
    (( waited < FILE_WAIT_SEC )) || return 1
    if (( waited == 0 )); then log "waiting for $FILE_UNIT ($state, up to ${FILE_WAIT_SEC}s)"; fi
    sleep "$POLL"
    waited=$((waited + POLL))
  done
}

last_full_bytes() {
  local f last=""
  for f in "$BACKUP_DIR"/full-*.dump; do
    [[ "${f##*/}" =~ ^full-[0-9]{8}T[0-9]{6}Z\.dump$ && -f "$f" && ! -L "$f" ]] && last="$f"
  done
  if [[ -n "$last" ]]; then stat -c %s -- "$last"; else echo 0; fi
}

rotate_local() {
  local -a files=()
  local f i
  for f in "$BACKUP_DIR"/full-*.dump; do
    [[ "${f##*/}" =~ ^full-[0-9]{8}T[0-9]{6}Z\.dump$ && -f "$f" && ! -L "$f" ]] && files+=("$f")
  done
  for (( i = 0; i + KEEP < ${#files[@]}; i++ )); do
    rm -f -- "${files[$i]}" "${files[$i]}.sha256" || return 1
    log "local rotated out ${files[$i]##*/}"
  done
}

# Newest finished file-level backup dir v5-YYYYMMDD-HHMMSSZ (no .partial).
newest_files_dir() {
  local d last=""
  for d in "$FILES_SRC"/v5-*; do
    [[ "${d##*/}" =~ ^v5-[0-9]{8}-[0-9]{6}Z$ && -d "$d" && ! -L "$d" ]] && last="$d"
  done
  printf '%s' "$last"
}

# Called as `run || rc=$?`, which turns set -e off inside: every step checks its own result.
fail() { log "FAILED $1"; write_status result=failed "at=$(now_iso)" "reason=$1" || true; return 1; }

run() {
  local reason est free name final partial rc tdata bytes sha r2rc=0 frc=0 fdir fname tarball worst=0
  wait_file_backup || { log "SKIP $FILE_UNIT still active after ${FILE_WAIT_SEC}s"; write_status result=skipped_file_backup_busy "at=$(now_iso)"; return 3; }
  reason=$(busy_reason)
  if [[ -n "$reason" ]]; then log "SKIP release busy: $reason"; write_status result=skipped_release_busy "at=$(now_iso)" "reason=$reason"; return 3; fi
  write_marker || { fail "cannot write $MARKER"; return 1; }
  # Requalify after publishing the informational marker; the controller holds the real lease.
  reason=$(busy_reason)
  if [[ -n "$reason" ]]; then log "SKIP release busy after marker: $reason"; write_status result=skipped_release_busy "at=$(now_iso)" "reason=$reason"; return 3; fi

  [[ ! -L "$BACKUP_DIR" ]] && install -d -m 700 -- "$BACKUP_DIR" && [[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] \
    || { fail "$BACKUP_DIR is not a real directory"; return 1; }
  est=$(last_full_bytes)
  if (( est > 0 )); then est=$(( est * 3 / 2 )); else est=$(( 8 * GIB )); fi
  free=$(avail_bytes "$BACKUP_DIR")
  if [[ ! "$free" =~ ^[0-9]+$ ]] || (( free < est + MIN_FREE_GIB * GIB )); then
    log "SKIP low disk free=$free estimate=$est floor=${MIN_FREE_GIB}GiB"
    write_status result=skipped_low_disk "at=$(now_iso)" "freeBytes=${free:-0}"
    return 3
  fi

  name="full-$(date -u +%Y%m%dT%H%M%SZ).dump"
  final="$BACKUP_DIR/$name"
  partial="$final.partial"
  [[ ! -e "$final" && ! -e "$partial" && ! -L "$partial" ]] || { fail "$final exists"; return 1; }
  log "dump start db=$DB -> $final"
  set +e
  ( set -C; as_pg "$PG_DUMP" -Fc -Z "$COMPRESS" --no-password -d "$DB" >"$partial" )
  rc=$?
  set -e
  if (( rc != 0 )) || [[ ! -s "$partial" ]]; then
    rm -f -- "$partial"
    log "FAILED pg_dump rc=$rc"; write_status result=dump_failed "at=$(now_iso)" "rc=$rc"; return 1
  fi
  tdata=$("$PG_RESTORE" --list -- "$partial" 2>/dev/null | grep -c ' TABLE DATA ' || true)
  if [[ ! "$tdata" =~ ^[0-9]+$ ]] || (( tdata < 1 )); then
    rm -f -- "$partial"
    log "FAILED verify table_data=${tdata:-0}"; write_status result=verify_failed "at=$(now_iso)"; return 1
  fi
  bytes=$(stat -c %s -- "$partial") || bytes=""
  sha=$(sha256sum -- "$partial" | awk '{print $1}') || sha=""
  if [[ ! "$bytes" =~ ^[0-9]+$ || ! "$sha" =~ ^[0-9a-f]{64}$ ]]; then rm -f -- "$partial"; fail "size or sha256 unreadable"; return 1; fi
  mv -T -- "$partial" "$final" || { rm -f -- "$partial"; fail "promote $partial"; return 1; }
  printf '%s  %s\n' "$sha" "$name" >"$final.sha256" || { fail "sidecar $final.sha256"; return 1; }
  rotate_local || { fail "local rotation"; return 1; }
  log "dump OK bytes=$bytes table_data=$tdata"

  # Off-host full copy: precheck (cap), then the helper deletes the old copy and streams the new one.
  "$R2" precheck || r2rc=$?
  if (( r2rc == 0 )); then
    "$R2" full "$name" <"$final" || r2rc=$?
  fi
  log "r2 full rc=$r2rc"

  # Off-host file-level copy (small; upload first, keep 2).
  fdir=$(newest_files_dir)
  if [[ -n "$fdir" ]]; then
    fname="core-$(sed -E 's/^v5-([0-9]{8})-([0-9]{6}Z)$/\1T\2/' <<<"${fdir##*/}").dump"
    tarball="$BACKUP_DIR/$fname"
    if tar -C "$(dirname -- "$fdir")" -cf "$tarball" "${fdir##*/}"; then
      V5SB_R2_PREFIX=files V5SB_R2_CORE_KEEP=2 "$R2" core "$tarball" || frc=$?
    else
      frc=1
    fi
    rm -f -- "$tarball"
  else
    log "no file-level backup under $FILES_SRC"
    frc=1
  fi
  log "r2 files rc=$frc"

  for rc in "$r2rc" "$frc"; do
    case "$rc" in
      0) ;;
      5) (( worst == 1 || worst == 3 )) || worst=5 ;;
      3) (( worst == 1 )) || worst=3 ;;
      *) worst=1 ;;
    esac
  done
  local result=ok
  (( worst == 0 )) || result="rc$worst"
  write_status "result=$result" "at=$(now_iso)" "file=$final" \
    "bytes=$bytes" "sha256=$sha" "r2Full=$r2rc" "r2Files=$frc"
  return "$worst"
}

cmd="${1:-}"
case "$cmd" in
  status) if [[ -f "$STATUS_FILE" ]]; then cat -- "$STATUS_FILE"; else echo '{"schemaVersion":1}'; fi; exit 0 ;;
  __watch) backup_watch "$2" "$3" "$4"; exit $? ;;
  __body)
    [[ "$PPID" == "$3" ]] && backup_live "$3" "$4" && backup_live "$5" "$6" || exit 1
    [[ -e /proc/$$/fd/9 && /proc/$$/fd/9 -ef "$LOCK_FILE" ]] || exit 1
    while [[ ! -e "$2/go" ]]; do backup_live "$3" "$4" && backup_live "$5" "$6" || exit 1; sleep 0.02; done
    trap drop_marker EXIT
    rc=0; run || rc=$?; exit "$rc"
    ;;
  run) ;;
  -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
  *) die_usage "usage: $0 run | status" ;;
esac
for knob in KEEP MIN_FREE_GIB FILE_WAIT_SEC POLL; do
  # decimal without leading zeros: bash arithmetic reads 08 as octal and fails
  [[ "${!knob}" =~ ^(0|[1-9][0-9]*)$ ]] || die_usage "$knob must be a non-negative integer"
done
(( KEEP >= 1 )) || die_usage "V5CB_KEEP must be >= 1"
(( POLL >= 1 )) || die_usage "V5CB_POLL_SEC must be >= 1"
[[ "$BACKUP_DIR" == /?* && "$BACKUP_DIR" != */ ]] || die_usage "V5CB_DIR must be an absolute directory path"
[[ -x "$R2" ]] || die_usage "R2 helper not executable: $R2"

install -d -m 755 -- "$(dirname -- "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || { log "another run holds $LOCK_FILE"; exit 4; }
rc=0
backup_supervise || rc=$?
exit "$rc"
