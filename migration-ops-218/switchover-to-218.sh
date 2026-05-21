#!/usr/bin/env bash
# switchover-to-218.sh — Run ON 218. Promotes 218 from hot standby to v3
# master. Target: ≤ 10 min user-visible disruption.
#
# Pre-conditions:
#   * KL primary (236) still reachable (graceful) OR confirmed down (forced).
#   * verify-standby-218.sh all green.
#
# CF DNS A-flip is performed by boss manually at the end (script prints
# instructions). We do NOT bake the CF token into this script — different
# zone or token rotation should not break the playbook.
set -euo pipefail

PRIMARY_HOST="kl-primary"                    # SSH alias on 218 → 154.193.246.236
PRIMARY_IP="154.193.246.236"
NEW_PRIMARY_IP="154.193.246.218"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/var/log/v3-migration"
DUMP_DIR="/var/backups/v3-migration"

# Force mode: skip "old primary must be reachable" gate. Used when KL is
# truly dead (DC fire, network blackhole). Boss invokes with --force.
FORCE=0
CONFIRMED=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --yes-really-switch) CONFIRMED=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

red()    { printf '\e[31m%s\e[0m\n' "$*"; }
green()  { printf '\e[32m%s\e[0m\n' "$*"; }
yellow() { printf '\e[33m%s\e[0m\n' "$*"; }
bold()   { printf '\e[1m%s\e[0m\n' "$*"; }
abort()  { red "$*"; exit 1; }

bold "========================================"
bold " V3 MASTER SWITCHOVER → 218 @ $(date -u +%FT%TZ)"
bold "  mode: $([ $FORCE = 1 ] && echo 'FORCED (old primary assumed dead)' || echo 'GRACEFUL')"
bold "  $([ $CONFIRMED = 1 ] && echo 'CONFIRMED — will mutate state' || echo 'DRY RUN — read-only')"
bold "========================================"

# ── 0a. read-only pre-flight (NO side effects in dry-run) ─────────────
# verify --force in FORCED mode = skip primary-dependent checks. We do
# NOT touch sentinels or open lock files yet — boss must be free to call
# this in dry-run with sync timers running.
echo "[0/11] pre-flight verify-standby-218..."
VERIFY_ARGS=()
[ $FORCE = 1 ] && VERIFY_ARGS+=(--force)
"$SCRIPT_DIR/verify-standby-218.sh" "${VERIFY_ARGS[@]}" || abort "standby NOT healthy — abort"
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
  || abort "/etc/caddy/Caddyfile invalid"

if [ "$CONFIRMED" != 1 ]; then
  yellow "DRY RUN — preflight only. Add --yes-really-switch to actually promote."
  exit 0
fi

# ── 0b. side effects begin here (only after CONFIRMED) ────────────────
mkdir -p "$LOG_DIR" "$DUMP_DIR" /opt/openclaude/migration-ops
LOG="$LOG_DIR/switchover-to-218-$(date +%Y%m%dT%H%M%S).log"

# Single-instance lock (process-level).
exec 9>/var/lock/v3-switchover-to-218.lock
flock -n 9 || { echo "switchover-to-218 already running"; exit 1; }

exec > >(tee -a "$LOG") 2>&1

# Atomic gate vs sync: take the SAME lock sync uses, then check no
# STANDBY_SYNCING, then claim STANDBY_PROMOTING. Outside the flock close
# the FD so concurrent sync ticks can take it again (they will then see
# STANDBY_PROMOTING and refuse).
SENTINEL=/opt/openclaude/migration-ops/STANDBY_PROMOTING
SYNC_SENTINEL=/opt/openclaude/migration-ops/STANDBY_SYNCING
{
  flock -n -x 8 || { echo "v3-218-sync.lock contended (sync in flight) — retry later" >&2; exit 1; }
  if [ -f "$SYNC_SENTINEL" ]; then
    echo "STANDBY_SYNCING sentinel present — wait for sync to finish or rm it" >&2
    exit 1
  fi
  touch "$SENTINEL"
} 8>/var/lock/v3-218-sync.lock
trap 'rm -f "$SENTINEL"' EXIT

T0=$(date +%s)

# ── 1. Old primary: Caddy maintenance 503 + stop writer + flush ───────
# In FORCED mode we skip touching the old primary entirely (it's assumed
# dead / unreachable). Any session writes still pending against it become
# data loss — boss must understand and accept that tradeoff.
OLD_PRIMARY_DRAINED=0
if [ $FORCE = 1 ]; then
  yellow "[1/11] FORCED mode — skipping old-primary drain (assumed unreachable)"
else
  echo "[1/11] swap kl-primary Caddy → maintenance 503..."
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "$PRIMARY_HOST" true 2>/dev/null; then
    if ssh "$PRIMARY_HOST" '[ -f /etc/caddy/Caddyfile.maintenance ]' 2>/dev/null; then
      ssh "$PRIMARY_HOST" 'cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-switchover && cp /etc/caddy/Caddyfile.maintenance /etc/caddy/Caddyfile && systemctl reload caddy'
    else
      yellow "  (no Caddyfile.maintenance on old primary; just stopping openclaude)"
    fi

    echo "[2/11] stop watchdog + kl-primary openclaude + flush state to disk..."
    # Watchdog auto-restarts openclaude on healthz failure; must stop it first.
    ssh "$PRIMARY_HOST" 'systemctl stop openclaude-healthz-watchdog 2>/dev/null; systemctl disable openclaude-healthz-watchdog 2>/dev/null' || true
    ssh "$PRIMARY_HOST" 'systemctl stop openclaude && systemctl disable openclaude'

    # Verify sessions.db lock released — refuse to continue if a detached
    # child still holds it.
    HOLDERS=$(ssh "$PRIMARY_HOST" 'lsof /root/.openclaude/sessions.db 2>/dev/null | wc -l')
    if [ "${HOLDERS:-0}" -gt 0 ]; then
      ssh "$PRIMARY_HOST" 'lsof /root/.openclaude/sessions.db 2>/dev/null' >&2
      abort "sessions.db still has open handle(s) on primary after stop — abort"
    fi

    # SQLite WAL checkpoint + sync.
    ssh "$PRIMARY_HOST" bash -s <<'REMOTE_EOF' || abort "primary state-flush step failed"
set -e
DB=/root/.openclaude/sessions.db
if [ ! -f "$DB" ]; then
  echo "[warn] $DB not present — skip checkpoint" >&2
  sync
  exit 0
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[warn] sqlite3 binary missing — relying on graceful shutdown + rsync of -wal" >&2
  sync
  exit 0
fi
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/tmp/wal_chk.log 2>&1 || { cat /tmp/wal_chk.log >&2; exit 1; }
sync
REMOTE_EOF
    OLD_PRIMARY_DRAINED=1
  else
    yellow "  kl-primary unreachable — proceeding as if --force (data loss possible)"
    FORCE=1
  fi
fi

# ── 3. Last-mile rsync /root/.openclaude (no active writer) ───────────
# Pull from old primary if it's still alive. In FORCED/unreachable mode we
# rely on whatever the continuous fast-sync delivered (≤1 min stale).
if [ $OLD_PRIMARY_DRAINED = 1 ]; then
  echo "[3/11] last-mile rsync /root/.openclaude (atomic)..."
  if ! rsync -aAX --delete "$PRIMARY_HOST":/root/.openclaude/ /root/.openclaude/; then
    red "######################################################################"
    red "##  last-mile rsync FAILED with primary in maintenance + openclaude"
    red "##  stopped. Service is DOWN. 218 NOT yet promoted. NO data loss yet."
    red "##"
    red "##  Manual recovery options:"
    red "##    A) rollback the cutover:"
    red "##       ssh $PRIMARY_HOST 'cp /etc/caddy/Caddyfile.pre-switchover /etc/caddy/Caddyfile'"
    red "##       ssh $PRIMARY_HOST 'systemctl enable --now openclaude && systemctl reload caddy'"
    red "##       ssh $PRIMARY_HOST 'systemctl enable --now openclaude-healthz-watchdog'"
    red "##    B) diagnose rsync (network? disk? perms?), retry, then re-run from [4/11]."
    red "######################################################################"
    exit 1
  fi
else
  yellow "[3/11] SKIPPED (forced mode) — using last STANDBY_SYNCING snapshot"
fi

# ── 4. No other writers on old primary ────────────────────────────────
if [ $OLD_PRIMARY_DRAINED = 1 ]; then
  echo "[4/11] check no other writer on primary DB..."
  WRITERS=$(ssh "$PRIMARY_HOST" "sudo -u postgres psql -tAc \"SELECT count(*) FROM pg_stat_activity WHERE datname='openclaude_commercial' AND pid <> pg_backend_pid() AND state <> 'idle' AND backend_type='client backend'\"")
  if [ "${WRITERS:-1}" -gt 0 ]; then
    ssh "$PRIMARY_HOST" "sudo -u postgres psql -c \"SELECT pid, usename, application_name, state, substr(query,1,80) FROM pg_stat_activity WHERE datname='openclaude_commercial' AND pid <> pg_backend_pid() AND state <> 'idle'\""
    abort "active writer(s) on primary DB — abort, investigate"
  fi

  # ── 5. primary CHECKPOINT + take final LSN ──────────────────────────
  echo "[5/11] primary CHECKPOINT + final LSN..."
  ssh "$PRIMARY_HOST" 'sudo -u postgres psql -c "CHECKPOINT"'
  PRIM_LSN=$(ssh "$PRIMARY_HOST" 'sudo -u postgres psql -tAc "SELECT pg_current_wal_lsn()"' | tr -d ' ')
  echo "  primary final LSN: $PRIM_LSN"

  # ── 6. wait standby to replay to that LSN ───────────────────────────
  echo "[6/11] wait 218 standby to catch up..."
  CAUGHT_UP=0
  for i in $(seq 1 60); do
    CAUGHT=$(sudo -u postgres psql -tAc "SELECT pg_last_wal_replay_lsn() >= '$PRIM_LSN'::pg_lsn" 2>/dev/null | tr -d ' ')
    if [ "$CAUGHT" = "t" ]; then
      CAUGHT_UP=1
      LCL_LSN=$(sudo -u postgres psql -tAc "SELECT pg_last_wal_replay_lsn()")
      green "  caught up at attempt $i — 218_LSN=$LCL_LSN"
      break
    fi
    sleep 1
  done
  [ "$CAUGHT_UP" = 1 ] || abort "218 standby did not catch up to $PRIM_LSN within 60s"
else
  yellow "[4-6/11] SKIPPED (forced mode) — promoting at current replay LSN"
fi

# ── 7. promote 218 ────────────────────────────────────────────────────
echo "[7/11] pg_promote 218 standby..."
sudo -u postgres psql -c "SELECT pg_promote(true, 60)"
IN_REC=$(sudo -u postgres psql -tAc "SELECT pg_is_in_recovery()" | tr -d ' ')
[ "$IN_REC" = "f" ] || abort "218 promote did not complete (still in recovery)"
green "  218 is now primary (in_recovery=f)"

# Clean up standby config so a future restart doesn't re-attach to old primary.
echo "  clean up postgresql.auto.conf replication settings..."
sudo -u postgres psql -c "ALTER SYSTEM RESET primary_conninfo" || true
sudo -u postgres psql -c "ALTER SYSTEM RESET primary_slot_name" || true
sudo -u postgres psql -c "SELECT pg_reload_conf()"

# ── 8. post-promote dump (emergency rollback insurance) ───────────────
echo "[8/11] take post-promote pg_dump..."
TS=$(date +%Y%m%dT%H%M%S)
sudo -u postgres pg_dump -Fc openclaude_commercial > "$DUMP_DIR/openclaude_commercial_post_promote_218_$TS.dump"
sudo -u postgres psql -tAc "SELECT pg_current_wal_lsn()" > "$DUMP_DIR/openclaude_promote_lsn_218_$TS.txt"
ls -la "$DUMP_DIR/" | tail -5

# ── 9. start openclaude + caddy on 218 ───────────────────────────────
echo "[9/11] enable + start openclaude.service + caddy.service on 218..."
systemctl enable --now openclaude
systemctl enable --now caddy
sleep 3

# ── 10. healthz probe (45 × 2s = 90s) ─────────────────────────────────
echo "[10/11] healthz probe (90s timeout)..."
HEALTHY=0
for i in $(seq 1 45); do
  if curl -sf --max-time 3 http://127.0.0.1:18789/healthz | grep -q '"ok":true'; then
    HEALTHY=1
    green "  healthz OK at attempt $i"
    break
  fi
  sleep 2
done
if [ "$HEALTHY" -eq 0 ]; then
  red "healthz failed after 90s — printing last 100 journal lines..."
  journalctl -u openclaude -n 100 --no-pager
  abort "healthz check did not pass"
fi

# ── 11. stop the inbound SSH tunnel (218 = primary now, no more WAL pull) ──
echo "[11/11] stop pg-tunnel-to-kl-primary..."
systemctl stop pg-tunnel-to-kl-primary 2>/dev/null || true
systemctl disable pg-tunnel-to-kl-primary 2>/dev/null || true

T1=$(date +%s)
ELAPSED=$((T1 - T0))

green "========================================"
green " SWITCHOVER → 218 COMPLETE in ${ELAPSED}s"
green "========================================"
yellow "下一步(boss 操作):"
yellow "  1. CF dashboard: claudeai.chat A → $NEW_PRIMARY_IP"
yellow "  2. 等 CF edge 传播 (~30-60s)"
yellow "  3. 验证 https://claudeai.chat/version.tag"
echo "log: $LOG"
echo "post-promote dump: $DUMP_DIR/openclaude_commercial_post_promote_218_$TS.dump"
