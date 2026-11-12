#!/usr/bin/env bash
# OCV5-749: exercise the real cutover function and real SQL before/after 0339.
# Run through scripts/test-mutex.sh commercial. Only the local test cluster is used.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=test PGPASSWORD=test PGDATABASE=openclaude_test
unset PGSERVICE PGSERVICEFILE PGOPTIONS
DB="oc_test_remote_v4_drain_${BASHPID}_${RANDOM}"
TMP="$(mktemp -d)"
CREATED=0
cleanup() {
  if [[ "$CREATED" == 1 ]]; then
    psql -X -v ON_ERROR_STOP=1 -q -c "DROP DATABASE \"$DB\";"
  fi
  rm -rf -- "$TMP"
}
trap cleanup EXIT
psql -X -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$DB\";"
CREATED=1
source "$ROOT/scripts/v5-selfhost-master-release-lib.sh"
SCRIPT_DIR="$ROOT/scripts"
PG_DB="$DB"
ALLOW_INFLIGHT=0
DRY=0
OC_REMOTE_V4_DRAIN_SOCKET="$TMP/absent.sock"
psql_as_postgres() {
  PGOPTIONS='-c default_transaction_read_only=on' psql -X -v ON_ERROR_STOP=1 "$@"
}
cutover_clog() { printf '%s\n' "$*"; }
sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$DB" -c "$1"; }
PASS=0
FAIL=0
expect() {
  local label="$1" expected="$2" rc=0
  remote_v4_cutover_drain >"$TMP/result" 2>&1 || rc=$?
  cat "$TMP/result"
  if [[ "$rc" == "$expected" ]]; then
    PASS=$((PASS + 1)); printf 'ok - %s\n' "$label"
  else
    FAIL=$((FAIL + 1)); printf 'not ok - %s (want=%s got=%s)\n' "$label" "$expected" "$rc"
  fi
}
expect 'pre-pool schema: no table' 0
sql 'CREATE TABLE remote_agent_bindings (state text NOT NULL);'
expect '0338 schema: table exists, new column absent' 0
sql 'ALTER TABLE remote_agent_bindings ADD COLUMN remote_protocol_version integer NOT NULL DEFAULT 1;'
expect '0339 schema: no bindings' 0
sql "INSERT INTO remote_agent_bindings VALUES ('released',4),('active',1),('active',3);"
expect 'released v4 and active legacy bindings do not block' 0
sql "INSERT INTO remote_agent_bindings VALUES ('active',4);"
expect 'active v4 binding blocks without drain socket' 1
sql "DELETE FROM remote_agent_bindings WHERE state='active' AND remote_protocol_version=4;"
sql 'ALTER TABLE remote_agent_bindings RENAME COLUMN state TO unavailable_state;'
expect 'count query failure is fail-closed' 1
PG_DB="${DB}_missing"
expect 'column query connection failure is fail-closed' 1
PG_DB="$DB"
printf 'passed=%s failed=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
