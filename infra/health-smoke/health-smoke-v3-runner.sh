#!/usr/bin/env bash
# M8.2 / P2-19 — health-smoke-v3 wrapper: run smoke + dispatch alert on
# OK→FAIL transition + clear marker on FAIL→OK transition.
#
# Marker semantics (matches infra/pg-backup-pull/pull-v3-backups.sh):
#   - $MARKER absent + smoke fail → INSERT alert + touch marker (only after INSERT OK)
#   - $MARKER present + smoke fail → silent (alert already pending in outbox)
#   - $MARKER present + smoke ok   → rm marker + log RECOVERED
#   - $MARKER absent  + smoke ok   → silent (steady-state happy path)
#
# Critical guard (Codex M8.2 PASS condition): if psql INSERT fails, do NOT
# touch marker. Otherwise a one-time DB hiccup permanently suppresses retries
# for the entire outage, defeating the purpose.
#
# Silence intentionally bypassed (see plan v2 IMPORTANT#1 reply):
#   maintenance suppression is `systemctl stop health-smoke-v3.timer`,
#   NOT admin UI silence (which would be unreachable if service is dead).

set -euo pipefail
umask 077

URL="${URL:-https://claudeai.chat}"
LOG=/var/log/health-smoke-v3.log
MARKER=/var/lib/openclaude/health-smoke-v3.failed
SQL=/usr/local/share/health-smoke/insert-alert.sql
SMOKE=/usr/local/bin/health-smoke-v3.sh

# umask 077 + install once on first run; keep mode 600 idempotently
if [ ! -e "$LOG" ]; then install -m 600 /dev/null "$LOG"; fi
chmod 600 "$LOG" 2>/dev/null || true

ts() { date -u +%FT%TZ; }

log() {
  printf '%s %s\n' "$(ts)" "$*" >> "$LOG"
}

dispatch_alert() {
  # Read DATABASE_URL line only (avoid sourcing whole .env into env).
  local dburl
  dburl=$(grep -E '^DATABASE_URL=' /etc/openclaude/commercial.env 2>/dev/null | head -1 | cut -d= -f2-) || {
    log "WARN: cannot read DATABASE_URL from /etc/openclaude/commercial.env"
    return 1
  }
  # Strip surrounding double quotes if present.
  dburl=${dburl%\"}
  dburl=${dburl#\"}
  if [ -z "$dburl" ]; then
    log "WARN: DATABASE_URL empty after strip"
    return 1
  fi

  # Codex M8.2 IMPORTANT#2: 把 url/checked_at/host 当 scalar 传, 让 SQL 用
  # jsonb_build_object 拼 payload, 避免 bash printf 拼 JSON 时的转义陷阱
  # (URL/hostname 含 " 或 \ 会变非法 JSON).
  local hour body now_ts host
  hour=$(date -u +%Y-%m-%dT%H)
  now_ts=$(ts)
  host=$(hostname -s)
  body="claudeai.chat liveness check failed at ${now_ts}. marker=${MARKER}, log=${LOG}. Recover: \`systemctl restart openclaude\` or investigate."

  if psql "$dburl" \
       -v ON_ERROR_STOP=1 \
       -v "dedupe_key=health.smoke_failed:$hour" \
       -v "body=$body" \
       -v "p_url=$URL" \
       -v "p_checked_at=$now_ts" \
       -v "p_host=$host" \
       -f "$SQL" >> "$LOG" 2>&1; then
    return 0
  else
    log "WARN: psql INSERT failed (see preceding lines); marker NOT touched"
    return 1
  fi
}

# ── main ──
if "$SMOKE" "$URL" >> "$LOG" 2>&1; then
  if [ -f "$MARKER" ]; then
    rm -f "$MARKER"
    log "RECOVERED — marker cleared"
  fi
  exit 0
fi

# smoke failed
if [ -f "$MARKER" ]; then
  log "FAIL — alert already pending since $(stat -c %y "$MARKER" 2>/dev/null || echo 'unknown')"
  exit 1
fi

# OK→FAIL transition: dispatch + touch marker (only if dispatch OK)
if dispatch_alert; then
  install -d -m 700 -o root -g root /var/lib/openclaude
  touch "$MARKER"
  chmod 600 "$MARKER"
  log "FAIL — alert dispatched, marker created"
  exit 1
else
  log "FAIL — alert dispatch FAILED (will retry next tick)"
  exit 1
fi
