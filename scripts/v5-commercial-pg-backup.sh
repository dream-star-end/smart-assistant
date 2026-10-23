#!/usr/bin/env bash
# v5 commercial PostgreSQL backup with an encrypted off-host copy on Cloudflare R2 (OCV5-600).
#
# Until now the commercial database (openclaude_commercial, ~16 GB) had no PostgreSQL backup
# at all: openclaude-v5-backup.service only copies sessions.db, config and env. Daily (timer
# 04:30 Asia/Taipei) this script:
#   1. waits for the file-level backup (openclaude-v5-backup.service) to finish;
#   2. skips (exit 3) when a release or a manual production change may be running: the
#      production mutation lock is open by any process, a recovery/inflight marker exists, or
#      deploy_state is not stable with an empty candidate. It never takes that lock: deploy's
#      reclaim protocol refuses holders without fencing meta;
#   3. writes /run/openclaude/pg-r2-backup.running (pid, start) for the run and checks again.
#      Releases check that file before they start (ocv5-release-verify), because a dump holds
#      AccessShareLock on every table and migrations set no lock_timeout;
#   4. dumps the whole database (pg_dump -Fc -Z zstd:3) to V5CB_DIR, verifies it, keeps 2;
#   5. uploads it to R2 through scripts/v5-selfhost-pg-backup-r2.sh (the shared helper: gpg to a
#      public key, delete the old full copy first, 9.5 GB cap with precheck and streaming
#      abort, warning above 9 GB) and the newest file-level backup as a tarball through the
#      helper's keep-N slot (prefix files/, kept 2). Its core-<UTC>.dump name is only the slot
#      format: the content is the file-level tarball.
#
# Usage: v5-commercial-pg-backup.sh run | status
# Exit codes: 0 ok, 1 failure, 2 usage, 3 skipped (release busy, low disk, R2 cap),
#             4 another run holds the lock, 5 done but the R2 bucket is above its warning line.
set -Eeuo pipefail
umask 077
export LC_ALL=C

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${V5CB_DB:-openclaude_commercial}"
BACKUP_DIR="${V5CB_DIR:-/var/backups/openclaude-v5-pg}"
KEEP="${V5CB_KEEP:-2}"
MIN_FREE_GIB="${V5CB_MIN_FREE_GIB:-10}"
COMPRESS="${V5CB_COMPRESS:-zstd:3}"
LOCK_FILE="${V5CB_LOCK:-/run/openclaude-v5-pg-r2-backup.lock}"
MARKER="${V5CB_MARKER:-/run/openclaude/pg-r2-backup.running}"
MUTATION_LOCK="${V5CB_MUTATION_LOCK:-/run/openclaude-v5/production-mutation.lock}"
RUN_DIR="${V5CB_RUN_DIR:-/run/openclaude-v5}"
FILES_SRC="${V5CB_FILES_SRC:-/var/backups/openclaude-v5}"
FILE_UNIT="${V5CB_FILE_BACKUP_UNIT:-openclaude-v5-backup.service}"
FILE_WAIT_SEC="${V5CB_FILE_BACKUP_WAIT_SEC:-1800}"
STATUS_FILE="${V5CB_STATUS:-/var/lib/openclaude-v5/pg-r2-backup-status.json}"
R2="${V5CB_R2:-$SELF_DIR/v5-selfhost-pg-backup-r2.sh}"
PG_DUMP="${V5CB_PG_DUMP:-pg_dump}"
PG_RESTORE="${V5CB_PG_RESTORE:-pg_restore}"
PSQL="${V5CB_PSQL:-psql}"
PG_AS="${V5CB_PG_AS-postgres}"
FUSER="${V5CB_FUSER:-fuser}"
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

# Non-empty reason when a release or a manual production change may be running.
busy_reason() {
  local st
  if "$FUSER" "$MUTATION_LOCK" >/dev/null 2>&1; then echo "production mutation lock is open"; return; fi
  for st in .manual-recovery-required .mutation-lane-inflight; do
    if [[ -e "$RUN_DIR/$st" ]]; then echo "$RUN_DIR/$st exists"; return; fi
  done
  st=$(as_pg "$PSQL" -d "$DB" -XAtqc \
    "select phase || '|' || coalesce(candidate_release, '') from deploy_state where singleton" 2>/dev/null) \
    || { echo "cannot read deploy_state"; return; }
  [[ "$st" == "stable|" ]] || echo "deploy_state is '$st' (want stable, no candidate)"
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
  local waited=0
  while "$SYSTEMCTL" is-active --quiet "$FILE_UNIT" 2>/dev/null; do
    (( waited < FILE_WAIT_SEC )) || return 1
    (( waited == 0 )) && log "waiting for $FILE_UNIT to finish (up to ${FILE_WAIT_SEC}s)"
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
  # A release that checked before the marker existed may have started meanwhile.
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
trap drop_marker EXIT
rc=0
run || rc=$?
exit "$rc"
