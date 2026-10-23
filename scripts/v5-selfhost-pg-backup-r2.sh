#!/usr/bin/env bash
# v5 selfhost PostgreSQL backup: encrypted off-host copies on Cloudflare R2 (OCV5-600).
#
# v5-selfhost-pg-backup.sh calls this when V5SB_OFFSITE points here:
#   precheck       before a full dump. Exit 0 go, 3 skip (the new copy would not fit the cap).
#   full <name>    full dump on stdin -> <remote>/<prefix>/full/<name>.gpg
#   core <file>    a verified local core dump -> <remote>/<prefix>/core/<basename>.gpg
#   discard-full <name>  drop that full copy (pg_dump failed after the upload ended)
#   usage          print the bucket inventory as JSON (read-only)
#
# The bucket sits alone in an R2 account whose free tier is 10 GB, so no write may
# take the bucket total above V5SB_R2_CAP_BYTES (default 9.5e9):
#   full  The old full copies are deleted first, then the new one is uploaded (the
#         user accepted a short window without an off-host full; core copies stay).
#         precheck estimates the new copy from the last upload scaled by database
#         growth and skips when it would not fit. While uploading, a byte counter
#         kills rclone before the object completes once it would pass the cap, and
#         --max-transfer with a hard cutoff backs the counter up.
#   Unfinished multipart uploads take space but are not listed as objects, so
#   every command first aborts them (`rclone backend cleanup`, only this host
#   writes the bucket and the backup lock serialises runs), then lists them again
#   and fails closed unless none is left (cleanup's exit code alone is not proof);
#   a killed or failed upload is cleaned up again at once.
#   core  Upload, then keep the newest V5SB_R2_CORE_KEEP copies.
# After every write a bucket total above V5SB_R2_WARN_BYTES (9e9) exits 5, so the
# unit fails and alerts. First answer: raise V5SB_FULL_COMPRESS; if that is not
# enough, escalate (moving the full copy elsewhere needs the user).
#
# Data is encrypted to a public key (gpg, V5SB_R2_GPG_RECIPIENT). The private key is
# not on this host. Credentials live only in the rclone config (root 0600).
#
# Exit codes: 0 ok, 1 failure, 2 usage/config, 3 skipped or aborted for the cap,
#             5 written but the bucket total is above the warning line.
set -Eeuo pipefail
umask 077
export LC_ALL=C
WORK_DIR=""
trap '[[ -z "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"' EXIT

DB="${V5SB_DB:-openclaude_v5_selfhost}"
PSQL="${V5SB_PSQL:-psql}"
PG_AS="${V5SB_PG_AS-postgres}"
RCLONE="${V5SB_RCLONE:-rclone}"
RCLONE_CONF="${V5SB_R2_RCLONE_CONF:-/etc/openclaude/r2-rclone.conf}"
REMOTE="${V5SB_R2_REMOTE:-r2:ocv5-personal-backup}"
PREFIX="${V5SB_R2_PREFIX:-pg}"
GPG="${V5SB_GPG:-gpg}"
GPG_HOME="${V5SB_R2_GPG_HOME:-/etc/openclaude/backup-gpg}"
RECIPIENT="${V5SB_R2_GPG_RECIPIENT:-}"
CAP_BYTES="${V5SB_R2_CAP_BYTES:-9500000000}"
WARN_BYTES="${V5SB_R2_WARN_BYTES:-9000000000}"
CORE_KEEP="${V5SB_R2_CORE_KEEP:-7}"
FULL_EST_BYTES="${V5SB_R2_FULL_EST_BYTES:-0}"
FULL_COMPRESS="${V5SB_FULL_COMPRESS:-${V5SB_COMPRESS:-zstd:3}}"
STATE_FILE="${V5SB_R2_STATE:-/var/lib/openclaude-v5-selfhost/pg-backup-r2.json}"
CHUNK="${V5SB_R2_CHUNK:-64M}"

FULL_RE='^full-[0-9]{8}T[0-9]{6}Z\.dump$'
CORE_RE='^core-[0-9]{8}T[0-9]{6}Z\.dump$'

log() { printf '%s [pg-backup-r2] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die_usage() { log "$*"; exit 2; }

as_pg() {
  if [[ -n "$PG_AS" ]]; then
    runuser -u "$PG_AS" -- "$@"
  else
    "$@"
  fi
}

rc() { "$RCLONE" --config "$RCLONE_CONF" "$@"; }

# Abort every unfinished multipart upload in the bucket (their parts count
# against the account but not in lsjson). max-age=1s: anything already pending
# when a command starts is left over from an earlier killed or failed upload.
abort_multipart() {
  local listing left
  rc backend cleanup "$REMOTE" -o max-age=1s || return 1
  # rclone 1.70.x returns 0 even when an abort fails (Codex r2): count what is left.
  listing=$(rc backend list-multipart-uploads "$REMOTE") || return 1
  left=$(python3 -c "$PY_MULTIPART_LEFT" <<<"$listing") || return 1
  if [[ "$left" != 0 ]]; then
    log "unfinished multipart uploads still present after cleanup: $left"
    return 1
  fi
}
PY_MULTIPART_LEFT='
import json, sys
v = json.load(sys.stdin)
if not isinstance(v, dict):
    sys.exit(1)
print(sum(len(x or []) for x in v.values()))
'


encrypt() {
  GNUPGHOME="$GPG_HOME" "$GPG" --batch --quiet --no-tty --trust-model always \
    --compress-algo none --encrypt --recipient "$RECIPIENT"
}

db_bytes() {
  as_pg "$PSQL" -Atqc "select pg_database_size('${DB}')" postgres
}

# Bucket inventory as one JSON line: total bytes, full bytes, and the object names
# under <prefix>/full/ and <prefix>/core/ (sorted, so oldest first).
inventory() {
  local listing
  listing=$(rc lsjson -R --files-only "$REMOTE") || return 1
  python3 -c "$PY_INVENTORY" "$PREFIX" <<<"$listing"
}
PY_INVENTORY='
import json, sys
prefix = sys.argv[1]
items = json.load(sys.stdin) or []
out = {"total": 0, "fullBytes": 0, "full": [], "core": []}
for it in items:
    size = int(it.get("Size") or 0)
    p = it.get("Path") or ""
    out["total"] += max(size, 0)
    if p.startswith(prefix + "/full/"):
        out["fullBytes"] += max(size, 0)
        out["full"].append(p[len(prefix) + 6:])
    elif p.startswith(prefix + "/core/"):
        out["core"].append(p[len(prefix) + 6:])
out["full"].sort()
out["core"].sort()
print(json.dumps(out))
'

jget() { # <json> <key> : number or newline-separated list
  python3 -c "$PY_JGET" "$2" <<<"$1"
}
PY_JGET='
import json, sys
v = json.load(sys.stdin).get(sys.argv[1])
if isinstance(v, list):
    for x in v:
        print(x)
elif v is not None:
    print(v)
'

read_state() { # -> "bytes dbBytes compress" or empty
  [[ -f "$STATE_FILE" ]] || return 0
  python3 - "$STATE_FILE" <<'PY' 2>/dev/null || true
import json, sys
s = json.load(open(sys.argv[1], encoding="utf-8"))
b, d, c = s.get("lastFullBytes"), s.get("lastFullDbBytes"), s.get("lastFullCompress")
if isinstance(b, int) and isinstance(d, int) and d > 0 and c:
    print(b, d, c)
PY
}

write_state() { # <bytes> <dbBytes>
  local dir tmp
  dir="$(dirname -- "$STATE_FILE")"
  install -d -m 755 -- "$dir" || return 1
  tmp="$(mktemp -p "$dir" .pg-backup-r2.XXXXXX)" || return 1
  if ! python3 - "$1" "$2" "$FULL_COMPRESS" "$(date -u +%FT%TZ)" >"$tmp" <<'PY'
import json, sys
b, d, c, at = sys.argv[1:]
print(json.dumps({"schemaVersion": 1, "lastFullBytes": int(b), "lastFullDbBytes": int(d),
                  "lastFullCompress": c, "lastFullAt": at}, sort_keys=True))
PY
  then
    unlink -- "$tmp" 2>/dev/null || true
    return 1
  fi
  chmod 644 -- "$tmp" && mv -T -- "$tmp" "$STATE_FILE"
}

# Estimate of the next full copy, 0 when unknown. The last upload is scaled by
# database growth plus 5 %. A different compression level makes the old size
# meaningless, so it counts as unknown and the upload counter is the only guard.
estimate_full() { # <current db bytes>
  local st b d c
  st=$(read_state)
  if [[ -z "$st" ]]; then echo "$FULL_EST_BYTES"; return; fi
  read -r b d c <<<"$st"
  if [[ "$c" != "$FULL_COMPRESS" ]]; then echo 0; return; fi
  # bytes x database bytes overflows 64-bit shell arithmetic at GB scale (Codex r1 P1).
  python3 -c 'import sys; b, d, cur = map(int, sys.argv[1:]); print(b * cur * 105 // (d * 100))' "$b" "$d" "$1"
}

warn_check() { # after a write: exit 5 when the bucket total passed the warning line
  local inv total
  inv=$(inventory) || { log "cannot list bucket after write"; return 1; }
  total=$(jget "$inv" total)
  if (( total > WARN_BYTES )); then
    log "WARN bucket total=$total > warn=$WARN_BYTES (cap $CAP_BYTES): raise V5SB_FULL_COMPRESS, then escalate"
    return 5
  fi
  log "bucket total=$total (warn $WARN_BYTES, cap $CAP_BYTES)"
  return 0
}

cmd_precheck() {
  local inv others limit cur est
  abort_multipart || { log "precheck: cannot abort unfinished uploads"; return 1; }
  inv=$(inventory) || { log "precheck: cannot list bucket"; return 1; }
  # The old full copies are deleted before the upload, so they do not count.
  others=$(( $(jget "$inv" total) - $(jget "$inv" fullBytes) ))
  limit=$(( CAP_BYTES - others ))
  cur=$(db_bytes) || { log "precheck: cannot read database size"; return 1; }
  [[ "$cur" =~ ^[0-9]+$ ]] || { log "precheck: bad database size: $cur"; return 1; }
  est=$(estimate_full "$cur") || { log "precheck: estimate failed"; return 1; }
  [[ "$est" =~ ^[0-9]+$ ]] || { log "precheck: bad estimate: $est"; return 1; }
  if (( est > limit )); then
    log "precheck SKIP estimate=$est > room=$limit (cap $CAP_BYTES, other objects $others): raise V5SB_FULL_COMPRESS (now $FULL_COMPRESS)"
    return 3
  fi
  log "precheck OK estimate=$est room=$limit db=$cur compress=$FULL_COMPRESS"
  return 0
}

cmd_full() {
  local name="$1" inv f others limit cur dest work rpid crc rrc got
  [[ "$name" =~ $FULL_RE ]] || die_usage "full: bad name: $name"
  cur=$(db_bytes) || { log "full: cannot read database size"; return 1; }
  [[ "$cur" =~ ^[0-9]+$ ]] || { log "full: bad database size: $cur"; return 1; }
  abort_multipart || { log "full: cannot abort unfinished uploads"; return 1; }
  inv=$(inventory) || { log "full: cannot list bucket"; return 1; }
  # Delete old first: two full copies never fit next to each other.
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    rc deletefile "$REMOTE/$PREFIX/full/$f" || { log "full: cannot delete old $f"; return 1; }
    log "full deleted old $f"
  done < <(jget "$inv" full)
  inv=$(inventory) || { log "full: cannot list bucket"; return 1; }
  others=$(jget "$inv" total)
  limit=$(( CAP_BYTES - others ))
  if (( limit <= 0 )); then
    log "full ABORT no room: other objects $others >= cap $CAP_BYTES"
    return 3
  fi
  dest="$REMOTE/$PREFIX/full/$name.gpg"
  work=$(mktemp -d) || return 1
  WORK_DIR=$work
  mkfifo -- "$work/pipe"
  log "full upload -> $dest (room $limit)"
  "$RCLONE" --config "$RCLONE_CONF" rcat --s3-chunk-size "$CHUNK" \
    --max-transfer "${limit}B" --cutoff-mode hard "$dest" <"$work/pipe" &
  rpid=$!
  set +e
  encrypt | python3 -c '
import os, signal, sys
limit, pid, countfile = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
total, rc = 0, 0
inp, out = sys.stdin.buffer, sys.stdout.buffer
while True:
    chunk = inp.read(1 << 20)
    if not chunk:
        break
    if total + len(chunk) > limit:
        # Kill the uploader before its input ends, so it never completes the object.
        os.kill(pid, signal.SIGKILL)
        total += len(chunk)
        rc = 3
        break
    out.write(chunk)
    total += len(chunk)
open(countfile, "w").write(str(total))
sys.exit(rc)
' "$limit" "$rpid" "$work/count" >"$work/pipe"
  local -a st=("${PIPESTATUS[@]}")
  wait "$rpid"
  rrc=$?
  set -e
  crc=${st[1]}
  if (( crc != 0 || rrc != 0 || st[0] != 0 )); then
    # the killed or failed upload leaves parts behind
    abort_multipart || log "full: cleanup of unfinished uploads failed"
  fi
  if (( crc == 3 )); then
    rc deletefile "$dest" 2>/dev/null || true
    log "full ABORT over cap: stream passed room=$limit; raise V5SB_FULL_COMPRESS (now $FULL_COMPRESS)"
    return 3
  fi
  if (( st[0] != 0 || crc != 0 || rrc != 0 )); then
    rc deletefile "$dest" 2>/dev/null || true
    log "full FAILED gpg=${st[0]} counter=$crc rclone=$rrc"
    return 1
  fi
  got=$(rc lsjson "$dest" | python3 -c 'import json,sys; v=json.load(sys.stdin); print(v[0]["Size"] if v else -1)') || got=-1
  if [[ "$got" != "$(cat -- "$work/count")" ]]; then
    rc deletefile "$dest" 2>/dev/null || true
    log "full FAILED size check remote=$got sent=$(cat -- "$work/count")"
    return 1
  fi
  write_state "$got" "$cur" || log "full: state write failed (estimate falls back next time)"
  log "full OK $dest bytes=$got"
  warn_check
}

cmd_discard_full() {
  local name="$1"
  [[ "$name" =~ $FULL_RE ]] || die_usage "discard-full: bad name: $name"
  rc deletefile "$REMOTE/$PREFIX/full/$name.gpg" 2>/dev/null || true
  # The truncated size must not feed the next estimate.
  rm -f -- "$STATE_FILE"
  log "full discarded $name"
}

cmd_core() {
  local file="$1" base inv total size dest got i
  local -a names=()
  base=${file##*/}
  [[ "$base" =~ $CORE_RE && -f "$file" && ! -L "$file" ]] || die_usage "core: bad file: $file"
  size=$(stat -c %s -- "$file")
  abort_multipart || { log "core: cannot abort unfinished uploads"; return 1; }
  inv=$(inventory) || { log "core: cannot list bucket"; return 1; }
  total=$(jget "$inv" total)
  # gpg adds a few hundred bytes; 1 % covers it.
  if (( total + size + size / 100 + 4096 > CAP_BYTES )); then
    log "core SKIP bucket total=$total + $size would pass cap $CAP_BYTES"
    return 3
  fi
  dest="$REMOTE/$PREFIX/core/$base.gpg"
  set +e
  encrypt <"$file" | rc rcat "$dest"
  local -a st=("${PIPESTATUS[@]}")
  set -e
  if (( st[0] != 0 || st[1] != 0 )); then
    rc deletefile "$dest" 2>/dev/null || true
    abort_multipart || log "core: cleanup of unfinished uploads failed"
    log "core FAILED gpg=${st[0]} rclone=${st[1]}"
    return 1
  fi
  got=$(rc lsjson "$dest" | python3 -c 'import json,sys; v=json.load(sys.stdin); print(v[0]["Size"] if v else -1)') || got=-1
  if [[ ! "$got" =~ ^[0-9]+$ ]] || (( got < size )); then
    log "core FAILED size check remote=$got local=$size"
    return 1
  fi
  log "core OK $dest bytes=$got"
  inv=$(inventory) || { log "core: cannot list bucket"; return 1; }
  while IFS= read -r i; do
    [[ "$i" =~ ^core-[0-9]{8}T[0-9]{6}Z\.dump\.gpg$ ]] && names+=("$i")
  done < <(jget "$inv" core)
  for (( i = 0; i + CORE_KEEP < ${#names[@]}; i++ )); do
    rc deletefile "$REMOTE/$PREFIX/core/${names[$i]}" || { log "core: rotate failed at ${names[$i]}"; return 1; }
    log "core rotated out ${names[$i]}"
  done
  warn_check
}

cmd="${1:-}"
shift || true
for knob in CAP_BYTES WARN_BYTES CORE_KEEP FULL_EST_BYTES; do
  # decimal without leading zeros: bash arithmetic reads 09 as octal and fails
  [[ "${!knob}" =~ ^(0|[1-9][0-9]*)$ ]] || die_usage "$knob must be a non-negative integer"
done
(( CORE_KEEP >= 1 )) || die_usage "V5SB_R2_CORE_KEEP must be >= 1"
(( WARN_BYTES <= CAP_BYTES )) || die_usage "V5SB_R2_WARN_BYTES must be <= V5SB_R2_CAP_BYTES"
[[ "$PREFIX" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die_usage "bad V5SB_R2_PREFIX: $PREFIX"
case "$cmd" in
  usage) inventory; exit $? ;;
  precheck|full|core|discard-full) ;;
  -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
  *) die_usage "usage: $0 precheck | full <name> | core <file> | discard-full <name> | usage" ;;
esac
[[ -n "$RECIPIENT" ]] || die_usage "V5SB_R2_GPG_RECIPIENT is not set"
[[ -f "$RCLONE_CONF" ]] || die_usage "rclone config missing: $RCLONE_CONF"

case "$cmd" in
  precheck) cmd_precheck ;;
  full) [[ $# -eq 1 ]] || die_usage "full <name>"; cmd_full "$1" ;;
  core) [[ $# -eq 1 ]] || die_usage "core <file>"; cmd_core "$1" ;;
  discard-full) [[ $# -eq 1 ]] || die_usage "discard-full <name>"; cmd_discard_full "$1" ;;
esac
