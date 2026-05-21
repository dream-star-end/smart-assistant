#!/usr/bin/env bash
# verify-standby-218.sh — 218 hot standby health check (non-destructive,
# safe to run any time). Lives on 218. Exit code 0 = all OK / 1 = at least
# one failure.
#
# Direction: KL primary (236) ──streams──> 218 standby (this host)
set -uo pipefail

PRIMARY_HOST="kl-primary"           # SSH alias on 218 → 154.193.246.236
PRIMARY_IP="154.193.246.236"
LAG_THRESHOLD_SEC=10                # streaming replay lag soft limit

# --force: KL primary assumed dead/unreachable. Skip the four checks that
#          interrogate the old primary (replay_lag, users parity, sessions.db
#          freshness vs primary, volume count parity). Used by switchover
#          --force pre-flight.
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "verify-standby-218: unknown arg '$arg'" >&2; exit 2 ;;
  esac
done

red()    { printf '\e[31m%s\e[0m\n' "$*"; }
green()  { printf '\e[32m%s\e[0m\n' "$*"; }
yellow() { printf '\e[33m%s\e[0m\n' "$*"; }

FAIL=0
check() {
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    green "✓ $name"
    [ -n "$out" ] && echo "  $out" | head -5 | sed 's/^/  /'
  else
    red "✗ $name"
    echo "  $out" | head -5 | sed 's/^/  /'
    FAIL=$((FAIL+1))
  fi
}

echo "=== 218 standby verify @ $(date -u +%FT%TZ) ==="

# Checks 1-2 check the WAL pull tunnel; skip in --force mode (tunnel is
# expected to be dead if KL is dead).
if [ $FORCE = 0 ]; then
  # 1. ssh tunnel 218:5433 → KL:5432 listening
  check "ssh tunnel 218:5433 → kl-primary:5432 listening" \
    bash -c 'ss -tln "( sport = :5433 )" | grep -q LISTEN'

  # 2. tunnel systemd unit active
  check "pg-tunnel-to-kl-primary.service active" \
    bash -c '[ "$(systemctl is-active pg-tunnel-to-kl-primary)" = active ]'
fi

# 3. 218 postgres still in recovery (= still a standby)
check "218 postgres in recovery (standby mode)" \
  bash -c 'sudo -u postgres psql -tAc "SELECT pg_is_in_recovery()" | grep -q "^t$"'

# Checks 4-6 + 11 interrogate KL primary; skip in --force mode.
if [ $FORCE = 1 ]; then
  yellow "⊙ skipping primary-dependent checks (#4 replay_lag, #5 users parity, #6 sessions.db drift, #11 volume parity) — --force"
else
  # 4. lag from primary side (authoritative)
  LAG_OUT=$(ssh "$PRIMARY_HOST" "sudo -u postgres psql -tAc \"SELECT EXTRACT(EPOCH FROM coalesce(replay_lag, '0'::interval)) || '|' || state || '|' || coalesce(client_addr::text,'') FROM pg_stat_replication WHERE application_name='16/main' LIMIT 1\"" 2>/dev/null || echo "")
  if [ -z "$LAG_OUT" ]; then
    red "✗ primary 没有看到 218 replica connected"
    FAIL=$((FAIL+1))
  else
    LAG_SEC=$(echo "$LAG_OUT" | cut -d'|' -f1 | awk '{printf "%.3f", $0}')
    STATE=$(echo "$LAG_OUT" | cut -d'|' -f2)
    CLIENT=$(echo "$LAG_OUT" | cut -d'|' -f3)
    if [ "$STATE" = "streaming" ]; then
      LAG_INT=${LAG_SEC%.*}
      if [ "${LAG_INT:-0}" -lt "$LAG_THRESHOLD_SEC" ]; then
        green "✓ primary→218 streaming, lag=${LAG_SEC}s, client=$CLIENT"
      else
        yellow "⚠ lag=${LAG_SEC}s exceeds ${LAG_THRESHOLD_SEC}s threshold"
        FAIL=$((FAIL+1))
      fi
    else
      red "✗ replication state=$STATE (expected streaming)"
      FAIL=$((FAIL+1))
    fi
  fi

  # 5. row-count consistency probe (cheap table)
  PRIM_USERS=$(ssh "$PRIMARY_HOST" "sudo -u postgres psql -tAc 'SELECT count(*) FROM users' -d openclaude_commercial" 2>/dev/null)
  ST_USERS=$(sudo -u postgres psql -tAc 'SELECT count(*) FROM users' -d openclaude_commercial 2>/dev/null)
  if [ -n "$PRIM_USERS" ] && [ "$PRIM_USERS" = "$ST_USERS" ]; then
    green "✓ users count match: primary=$PRIM_USERS / standby=$ST_USERS"
  else
    red "✗ users count drift: primary=$PRIM_USERS / standby=$ST_USERS"
    FAIL=$((FAIL+1))
  fi

  # 6. sessions.db freshness (must be < 5 min old vs primary, since fast-sync
  #    runs every 1 min). Allow 5 min for slack.
  PRIM_TS=$(ssh "$PRIMARY_HOST" 'stat -c %Y /root/.openclaude/sessions.db' 2>/dev/null || echo 0)
  ST_TS=$(stat -c %Y /root/.openclaude/sessions.db 2>/dev/null || echo 0)
  DRIFT=$(( PRIM_TS - ST_TS ))
  if [ "$DRIFT" -lt 0 ]; then DRIFT=$(( -DRIFT )); fi
  if [ "$ST_TS" = 0 ]; then
    red "✗ /root/.openclaude/sessions.db missing on 218"
    FAIL=$((FAIL+1))
  elif [ "$DRIFT" -gt 300 ]; then
    yellow "⚠ sessions.db drift ${DRIFT}s > 300s — sync hook may be stuck"
    FAIL=$((FAIL+1))
  else
    green "✓ sessions.db drift=${DRIFT}s (≤300s)"
  fi
fi

# 7. docker network + bridge ACCEPT rule
check "docker network openclaude-v3-net exists" \
  bash -c 'docker network inspect openclaude-v3-net >/dev/null 2>&1'

BRIDGE_IF=$(docker network inspect openclaude-v3-net --format 'br-{{.Id}}' 2>/dev/null | cut -c1-15)
if [ -n "$BRIDGE_IF" ] && iptables -S ufw-before-input 2>/dev/null | grep -q "^-A ufw-before-input -i $BRIDGE_IF -j ACCEPT"; then
  green "✓ ufw before.rules has bridge ACCEPT for $BRIDGE_IF"
else
  red "✗ ufw bridge ACCEPT missing for $BRIDGE_IF — container→relay will be DROPped after promote"
  FAIL=$((FAIL+1))
fi

# 8. runtime image present (look up tag from commercial.env or fall back)
ENV_FILE=/etc/openclaude/commercial.env
if [ -f "$ENV_FILE" ]; then
  RUNTIME_TAG=$(grep '^OC_RUNTIME_IMAGE' "$ENV_FILE" | cut -d= -f2 | tr -d '"')
  check "runtime image $RUNTIME_TAG present" \
    bash -c "docker image inspect '$RUNTIME_TAG' >/dev/null 2>&1"
else
  yellow "⚠ $ENV_FILE missing — cannot check runtime image"
  FAIL=$((FAIL+1))
fi

# 9. code + env present
check "/opt/openclaude/openclaude/packages exists" \
  bash -c 'test -d /opt/openclaude/openclaude/packages'

# 10. openclaude + caddy MUST be inactive while standby
OC_STATE=$(systemctl is-active openclaude 2>/dev/null)
CADDY_STATE=$(systemctl is-active caddy 2>/dev/null)
if [ "$OC_STATE" = "inactive" ] || [ "$OC_STATE" = "failed" ]; then
  green "✓ openclaude.service inactive (correct for standby)"
else
  red "✗ openclaude.service is $OC_STATE — standby 期间必须 inactive"
  FAIL=$((FAIL+1))
fi
if [ "$CADDY_STATE" = "inactive" ] || [ "$CADDY_STATE" = "failed" ]; then
  green "✓ caddy.service inactive (correct for standby)"
else
  yellow "⚠ caddy.service is $CADDY_STATE — standby 期间应 inactive"
fi

# 11. volume count parity (heuristic; allow ±5 since incremental sync may lag).
#     Skipped in --force mode since it queries the (assumed-dead) primary.
if [ $FORCE = 0 ]; then
  PRIM_VOLS=$(ssh "$PRIMARY_HOST" 'docker volume ls --format "{{.Name}}" 2>/dev/null | grep -c "^oc-v3-"' || echo 0)
  ST_VOLS=$(docker volume ls --format "{{.Name}}" 2>/dev/null | grep -c "^oc-v3-" || echo 0)
  DELTA=$(( PRIM_VOLS - ST_VOLS ))
  if [ "$DELTA" -lt 0 ]; then DELTA=$(( -DELTA )); fi
  if [ "$DELTA" -le 5 ]; then
    green "✓ oc-v3-* volume count: primary=$PRIM_VOLS, standby=$ST_VOLS (Δ=$DELTA)"
  else
    yellow "⚠ volume count drift: primary=$PRIM_VOLS / standby=$ST_VOLS (Δ=$DELTA)"
    FAIL=$((FAIL+1))
  fi
fi

# 12. STANDBY_PROMOTING must NOT be present unless a failover is intentionally
#     in progress. If it lingers, sync is blocked and that's a bug to surface.
if [ -f /opt/openclaude/migration-ops/STANDBY_PROMOTING ]; then
  yellow "⚠ STANDBY_PROMOTING sentinel present — failover in flight or stale"
  FAIL=$((FAIL+1))
else
  green "✓ no STANDBY_PROMOTING sentinel"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  green "===== 218 STANDBY HEALTHY ($FAIL failures) ====="
  exit 0
else
  red "===== 218 STANDBY UNHEALTHY ($FAIL failures) ====="
  exit 1
fi
