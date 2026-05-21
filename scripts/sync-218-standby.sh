#!/usr/bin/env bash
# sync-218-standby.sh — Push runtime state from KL primary to the 218 hot
# standby (154.193.246.218) so it stays in lock-step with the prod master
# between PG-streaming-replication and an eventual switchover.
#
# Runs ON KL primary (154.193.246.236). Triggered by systemd timer or
# manually. Best-effort: failures log WARN, the standby will retry on the
# next tick.
#
# Direction: KL primary (236) ──push──> 218 standby
#
# What this script syncs (PG WAL is separate, handled by streaming replication
# + slot kl_standby_218):
#   * /root/.openclaude/sessions.db        SQLite — snapshot via sqlite3 .backup
#   * /root/.openclaude/{*.json,*.yaml}    small mutable config
#   * /root/.openclaude/uploads/           user-uploaded files
#   * /root/.openclaude/generated/         agent-generated media
#   * /root/.openclaude/agents/            agent skills
#   * /root/.openclaude/cron/              cron job state
#   * /var/lib/docker/volumes/oc-v3-*/     user container volumes (incremental)
#
# Concurrency model (mirrors sync-kl-standby.sh pattern):
#   * Local flock on KL primary — /tmp/openclaude-218-sync.lock — serializes
#     concurrent ticks.
#   * Remote flock on 218       — /var/lock/v3-218-sync.lock — atomic
#     "check sentinels + set STANDBY_SYNCING".
#   * Two sentinels on 218      — /opt/openclaude/migration-ops/STANDBY_SYNCING
#     and STANDBY_PROMOTING. switchover-to-218.sh takes the same lock
#     and refuses if STANDBY_SYNCING exists.
#
# Gates evaluated atomically inside the remote flock:
#   1. 218 openclaude   — must equal `inactive`. Any other state means 218
#                          is not a clean standby; we refuse to write.
#   2. STANDBY_PROMOTING absent — failover not in flight.
#   3. STANDBY_SYNCING absent   — no other sync running / stale.
#   4. pg_is_in_recovery()=t    — 218 is still a postgres standby.
#
# Exit codes:
#   0 — fully succeeded OR gracefully skipped (218 unreachable / not clean
#       standby / failover in flight / SKIP_218_SYNC=1).
#   1 — hard failure: SQLite snapshot failed, rsync failed, or final sanity
#       failed. The standby retains its previous data.
#
# Env knobs:
#   SKIP_218_SYNC=1   — bypass entirely.
#   STANDBY_SSH_ALIAS — override SSH host alias (default kl-standby-218).
#   SYNC_MODE         — "fast" (default, sessions+config only) or
#                       "full" (also incl. docker volumes + uploads + generated).
#                       Timer config:  fast every 1min, full every 5min.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STANDBY_SSH_ALIAS="${STANDBY_SSH_ALIAS:-kl-standby-218}"
SYNC_MODE="${SYNC_MODE:-fast}"

if [[ "${SKIP_218_SYNC:-0}" == "1" ]]; then
  echo "[sync-218] SKIP_218_SYNC=1 — exit"
  exit 0
fi

case "$SYNC_MODE" in
  fast|full) ;;
  *) echo "[sync-218] FATAL: SYNC_MODE must be fast|full, got '$SYNC_MODE'" >&2; exit 1 ;;
esac

# Single-instance lock on KL primary.
exec 9>/tmp/openclaude-218-sync.lock
if ! flock -n 9; then
  echo "[sync-218] another sync already running — skip"
  exit 0
fi

echo "[sync-218] mode=$SYNC_MODE target=$STANDBY_SSH_ALIAS @ $(date -u +%FT%TZ)"

# ── 1. Reachability ───────────────────────────────────────────────────
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$STANDBY_SSH_ALIAS" true 2>/dev/null; then
  echo "[sync-218] WARN: $STANDBY_SSH_ALIAS unreachable via SSH — graceful skip" >&2
  exit 0
fi

# ── 2. Atomic gate + claim STANDBY_SYNCING ────────────────────────────
# Inner script exit codes:
#   0   claim acquired
#   11  openclaude not inactive
#   12  STANDBY_PROMOTING present
#   13  pg not in recovery
#   14  STANDBY_SYNCING already present
#   99  flock contended
set +e
ssh "$STANDBY_SSH_ALIAS" 'flock -n -E 99 -x /var/lock/v3-218-sync.lock -c '"'"'
  mkdir -p /opt/openclaude/migration-ops
  state=$(systemctl is-active openclaude 2>/dev/null || true)
  if [ "$state" != "inactive" ]; then
    echo "openclaude=$state" >&2
    exit 11
  fi
  if [ -f /opt/openclaude/migration-ops/STANDBY_PROMOTING ]; then
    exit 12
  fi
  if [ -f /opt/openclaude/migration-ops/STANDBY_SYNCING ]; then
    exit 14
  fi
  rec=$(sudo -u postgres psql -tAc "SELECT pg_is_in_recovery();" 2>/dev/null | tr -d "[:space:]")
  if [ "$rec" != "t" ]; then
    echo "pg_in_recovery=$rec" >&2
    exit 13
  fi
  touch /opt/openclaude/migration-ops/STANDBY_SYNCING
'"'"
CLAIM_EXIT=$?
set -e
case "$CLAIM_EXIT" in
  0)  echo "[sync-218] gates OK — STANDBY_SYNCING claimed" ;;
  11) echo "[sync-218] WARN: openclaude not inactive on standby — graceful skip" >&2; exit 0 ;;
  12) echo "[sync-218] WARN: STANDBY_PROMOTING present — failover in flight, skip" >&2; exit 0 ;;
  13) echo "[sync-218] WARN: standby pg not in recovery — not a standby, skip" >&2; exit 0 ;;
  14) echo "[sync-218] WARN: STANDBY_SYNCING already present — concurrent or stale" >&2
      echo "        clear with: ssh $STANDBY_SSH_ALIAS 'rm /opt/openclaude/migration-ops/STANDBY_SYNCING'" >&2
      exit 0 ;;
  99) echo "[sync-218] WARN: /var/lock/v3-218-sync.lock contended — skip" >&2; exit 0 ;;
  *)  echo "[sync-218] FATAL: unexpected claim exit $CLAIM_EXIT" >&2; exit 1 ;;
esac

SNAPSHOT_TMP=""
cleanup() {
  if [[ -n "$SNAPSHOT_TMP" && -f "$SNAPSHOT_TMP" ]]; then
    rm -f "$SNAPSHOT_TMP" "${SNAPSHOT_TMP}-wal" "${SNAPSHOT_TMP}-shm"
  fi
  # Best-effort sentinel release; warn rather than abort (EXIT trap).
  if ! ssh "$STANDBY_SSH_ALIAS" "rm -f /opt/openclaude/migration-ops/STANDBY_SYNCING" 2>/dev/null; then
    echo "[sync-218] WARN: failed to remove STANDBY_SYNCING on standby" >&2
    echo "        ssh $STANDBY_SSH_ALIAS 'rm /opt/openclaude/migration-ops/STANDBY_SYNCING'" >&2
  fi
}
trap cleanup EXIT

# ── 3. sessions.db snapshot via sqlite3 .backup ──────────────────────
# .backup yields a consistent point-in-time copy without blocking writers
# (uses SQLite's online backup API). The resulting file has no -wal/-shm,
# so the standby gets a clean self-contained DB.
DB=/root/.openclaude/sessions.db
if [ -f "$DB" ]; then
  SNAPSHOT_TMP=$(mktemp -t sessions.XXXXXX.db)
  echo "[sync-218] sqlite3 .backup → $SNAPSHOT_TMP"
  if ! sqlite3 "$DB" ".backup '$SNAPSHOT_TMP'"; then
    echo "[sync-218] FATAL: sqlite3 .backup failed" >&2
    exit 1
  fi
  # Push as a single atomic file: scp to .tmp then mv.
  if ! scp -q "$SNAPSHOT_TMP" "$STANDBY_SSH_ALIAS:/root/.openclaude/sessions.db.snapshot.tmp"; then
    echo "[sync-218] FATAL: scp sessions snapshot failed" >&2
    exit 1
  fi
  if ! ssh "$STANDBY_SSH_ALIAS" '
    mv /root/.openclaude/sessions.db.snapshot.tmp /root/.openclaude/sessions.db
    # Remove any leftover WAL/SHM from a previous live copy so the standby
    # never opens a half-broken DB if promoted.
    rm -f /root/.openclaude/sessions.db-wal /root/.openclaude/sessions.db-shm
  '; then
    echo "[sync-218] FATAL: remote sessions.db install failed" >&2
    exit 1
  fi
else
  echo "[sync-218] WARN: $DB missing on primary — skip sessions snapshot" >&2
fi

# ── 4. Small mutable config ──────────────────────────────────────────
# Excludes sessions.db (handled above) and large dirs (handled in full mode).
echo "[sync-218] rsync /root/.openclaude/ small config"
if ! rsync -az --delete-after \
      --exclude='sessions.db*' \
      --exclude='/uploads/' \
      --exclude='/generated/' \
      --exclude='/cron/' \
      --exclude='/agents/' \
      /root/.openclaude/ "$STANDBY_SSH_ALIAS:/root/.openclaude/"; then
  echo "[sync-218] FATAL: small config rsync failed" >&2
  exit 1
fi

# ── 5. Full-mode extras: heavy paths ─────────────────────────────────
if [[ "$SYNC_MODE" == "full" ]]; then
  for path in uploads generated cron agents; do
    src="/root/.openclaude/$path/"
    [ -d "$src" ] || continue
    echo "[sync-218] rsync .openclaude/$path"
    if ! rsync -az --delete-after "$src" "$STANDBY_SSH_ALIAS:/root/.openclaude/$path/"; then
      echo "[sync-218] WARN: rsync .openclaude/$path failed — continue" >&2
    fi
  done

  # Docker volumes: only oc-v3-* (user containers). _data only, --delete-after
  # mirrors KL exactly. Volume metadata (driver/labels) is recreated on 218
  # via `docker volume create --label ...` if missing.
  echo "[sync-218] rsync docker volumes (oc-v3-*)"
  mapfile -t VOLS < <(docker volume ls --format '{{.Name}}' | awk '/^oc-v3-/{print}')
  TOTAL=${#VOLS[@]}
  IDX=0
  FAIL=0
  for vol in "${VOLS[@]}"; do
    IDX=$((IDX+1))
    src="/var/lib/docker/volumes/$vol/_data/"
    [ -d "$src" ] || continue
    # Ensure remote-side has a labeled volume entry.
    ssh "$STANDBY_SSH_ALIAS" "docker volume inspect '$vol' >/dev/null 2>&1 || \
      docker volume create --label com.openclaude.v3.managed=1 \
        --label com.openclaude.v3.synced-from=kl-primary '$vol' >/dev/null" \
      || { echo "[sync-218] WARN: remote volume create failed for $vol" >&2; FAIL=$((FAIL+1)); continue; }
    if ! rsync -aHAX --numeric-ids --delete "$src" \
           "$STANDBY_SSH_ALIAS:/var/lib/docker/volumes/$vol/_data/" 2>/dev/null; then
      echo "[sync-218] WARN: rsync vol $vol failed ($IDX/$TOTAL)" >&2
      FAIL=$((FAIL+1))
    fi
  done
  echo "[sync-218] volumes: $((TOTAL - FAIL))/$TOTAL ok ($FAIL failed)"
fi

# ── 6. Final ping (replication still streaming, openclaude still inactive) ──
REMOTE_STATE=$(ssh "$STANDBY_SSH_ALIAS" '
  oc=$(systemctl is-active openclaude 2>/dev/null || true)
  rec=$(sudo -u postgres psql -tAc "SELECT pg_is_in_recovery();" 2>/dev/null | tr -d "[:space:]")
  echo "oc=$oc;rec=$rec"
')
if ! [[ "$REMOTE_STATE" == "oc=inactive;rec=t" ]]; then
  echo "[sync-218] FATAL: post-sync sanity failed: $REMOTE_STATE" >&2
  exit 1
fi

echo "[sync-218] ✓ done (mode=$SYNC_MODE)"
exit 0
