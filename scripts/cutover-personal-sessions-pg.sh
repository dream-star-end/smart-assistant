#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SERVICE=${OPENCLAUDE_PROD_SERVICE:-openclaude.service}
CONFIG=${OPENCLAUDE_CONFIG:-/root/.openclaude/openclaude.json}
SECRETS_ENV=${OPENCLAUDE_SECRETS_ENV:-/etc/openclaude/secrets.env}
MIGRATE=(npx tsx "$ROOT/scripts/migrate-personal-sessions-pg.ts" --service "$SERVICE")
MODE=${1:---cutover}

if [[ -z "${OPENCLAUDE_SESSIONS_DATABASE_URL:-}" ]]; then
  echo "OPENCLAUDE_SESSIONS_DATABASE_URL is required" >&2
  exit 2
fi

set_driver() {
  local driver=$1
  local path=$2
  DRIVER="$driver" CONFIG_PATH="$path" node <<'NODE'
const fs = require('node:fs')
const path = process.env.CONFIG_PATH
const config = JSON.parse(fs.readFileSync(path, 'utf8'))
config.storage ||= {}
config.storage.sessions ||= {}
config.storage.sessions.driver = process.env.DRIVER
const tmp = `${path}.tmp-${process.pid}`
fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
fs.renameSync(tmp, path)
NODE
}

persist_service_database_url() {
  if [[ ! -f "$SECRETS_ENV" ]] || ! systemctl cat "$SERVICE" | grep -Fq "$SECRETS_ENV"; then
    echo "$SERVICE must load the existing secrets file $SECRETS_ENV" >&2
    exit 1
  fi
  SECRETS_PATH="$SECRETS_ENV" node <<'NODE'
const fs = require('node:fs')
const path = process.env.SECRETS_PATH
const value = process.env.OPENCLAUDE_SESSIONS_DATABASE_URL
const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/)
const kept = lines.filter((line) => !/^\s*OPENCLAUDE_SESSIONS_DATABASE_URL\s*=/.test(line))
while (kept.length && kept[kept.length - 1] === '') kept.pop()
kept.push(`OPENCLAUDE_SESSIONS_DATABASE_URL=${JSON.stringify(value)}`, '')
const tmp = `${path}.tmp-${process.pid}`
fs.writeFileSync(tmp, kept.join('\n'), { mode: 0o600 })
fs.renameSync(tmp, path)
NODE
}

stop_with_barrier() {
  systemctl stop "$SERVICE"
  if systemctl is-active --quiet "$SERVICE"; then
    echo "$SERVICE is still active after stop" >&2
    exit 1
  fi
  local result status
  result=$(systemctl show "$SERVICE" -p Result --value)
  status=$(systemctl show "$SERVICE" -p ExecMainStatus --value)
  if [[ "$result" != "success" || "$status" != "0" ]]; then
    echo "graceful session write barrier failed: Result=$result ExecMainStatus=$status" >&2
    exit 1
  fi
}

wait_health() {
  for _ in $(seq 1 60); do
    if systemctl is-active --quiet "$SERVICE" && curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:18789/healthz >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

case "$MODE" in
  --prepare-only)
    cd "$ROOT"
    "${MIGRATE[@]}" --prepare
    ;;
  --cutover)
    cd "$ROOT"
    "${MIGRATE[@]}" --prepare
    backup="${CONFIG}.pre-pg-cutover-$(date -u +%Y%m%dT%H%M%SZ)"
    secrets_backup="${SECRETS_ENV}.pre-pg-cutover-$(date -u +%Y%m%dT%H%M%SZ)"
    cp --preserve=mode,ownership,timestamps "$CONFIG" "$backup"
    cp --preserve=mode,ownership,timestamps "$SECRETS_ENV" "$secrets_backup"
    stop_with_barrier
    "${MIGRATE[@]}" --finalize
    persist_service_database_url
    set_driver postgres "$CONFIG"
    systemctl start "$SERVICE"
    if ! wait_health; then
      systemctl stop "$SERVICE" || true
      mutations=$("${MIGRATE[@]}" --authority-state | node -e \
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).mutationCount))")
      if [[ "$mutations" == "0" ]]; then
        cp --preserve=mode,ownership,timestamps "$backup" "$CONFIG"
        cp --preserve=mode,ownership,timestamps "$secrets_backup" "$SECRETS_ENV"
        systemctl start "$SERVICE"
        wait_health || true
        echo "PG startup failed before any PG mutation; restored SQLite config from $backup" >&2
      else
        echo "PG startup failed after $mutations committed mutation(s); direct SQLite rollback is forbidden." >&2
        echo "Keep a PG-compatible release and investigate, or run --rollback-to-sqlite while stopped." >&2
      fi
      exit 1
    fi
    echo "PostgreSQL session authority is healthy; backups: $backup $secrets_backup"
    ;;
  --rollback-to-sqlite)
    cd "$ROOT"
    backup="${CONFIG}.pre-sqlite-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
    cp --preserve=mode,ownership,timestamps "$CONFIG" "$backup"
    stop_with_barrier
    "${MIGRATE[@]}" --rollback-to-sqlite
    set_driver sqlite "$CONFIG"
    systemctl start "$SERVICE"
    wait_health
    echo "SQLite session authority restored after reverse migration; config backup: $backup"
    ;;
  *)
    echo "usage: $0 --prepare-only|--cutover|--rollback-to-sqlite" >&2
    exit 2
    ;;
esac
