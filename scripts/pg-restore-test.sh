#!/usr/bin/env bash
# M7/P1-10 — Weekly restore drill on the v3 commercial VM.
#
# Verifies that the latest pg_dump --format=custom file actually restores end-to-end
# into a throwaway database, then drops the throwaway. Catches silent dump corruption
# (pg_restore -l would already catch most, but full restore covers schema/data flow too).
#
# Runs as root via systemd timer. PG operations switch to postgres via runuser.
#
# Idempotent / safe re-run:
#   - Throwaway DB name carries a PID + timestamp suffix; cleanup on every exit path
#   - Trap is registered AFTER initializing TEST_DB="" / TMP="" so cleanup never sees
#     unbound vars under set -u (Codex v1 BLOCKING #2)
#
# Why runuser not sudo (per Codex v1 BLOCKING #3):
#   - sudo in non-interactive systemd context can hit pam_limits / TTY weirdness
#   - runuser is exactly the systemd-friendly switch primitive
#
# Why to_regclass (per Codex v1 NON-BLOCKING):
#   - SELECT ... LIMIT 1 returns 0 rows on an empty table without erroring; we'd silently
#     pass even if migration didn't run. to_regclass returns NULL only if table absent.

set -euo pipefail
umask 077

DUMP_DIR=/var/backups/postgres
DUMP_RE='^openclaude_commercial-[0-9]{8}-[0-9]{6}Z\.dump$'
LOG=/var/log/pg-restore-test.log

# Initialize cleanup variables BEFORE registering trap (set -u safety)
TEST_DB=""
TMP=""

cleanup() {
  local exit_code=$?
  if [ -n "$TEST_DB" ]; then
    runuser -u postgres -- dropdb --if-exists "$TEST_DB" >/dev/null 2>&1 || true
  fi
  if [ -n "$TMP" ]; then
    rm -rf "$TMP" 2>/dev/null || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

if [ ! -e "$LOG" ]; then install -m 600 /dev/null "$LOG"; fi
chmod 600 "$LOG" 2>/dev/null || true

{
  echo
  echo "=== $(date -u +%FT%TZ) pg-restore-test start ==="

  # Pick latest dump by filename UTC sort (stable; mtime can lie after file copies)
  cd "$DUMP_DIR" 2>/dev/null || { echo "FAIL: cannot read $DUMP_DIR"; exit 2; }
  base=$(LC_ALL=C ls -1 2>/dev/null | grep -E "$DUMP_RE" | sort | tail -1 || true)
  if [ -z "$base" ]; then
    echo "FAIL: no dump found in $DUMP_DIR"
    exit 3
  fi
  dump_path="$DUMP_DIR/$base"
  [ -f "$dump_path" ] || { echo "FAIL: $dump_path missing"; exit 4; }

  echo "selected dump: $dump_path ($(stat -c%s "$dump_path") bytes)"

  # Throwaway DB name. PID + timestamp avoids collision with prior runs that
  # crashed before cleanup (would still be dropped here via --if-exists in cleanup).
  TEST_DB="restoretest_$(date -u +%Y%m%d_%H%M%S)_$$"
  TMP="$(mktemp -d /tmp/pg-restore-test.XXXXXX)"
  chown postgres:postgres "$TMP"

  echo "throwaway DB: $TEST_DB"

  # Create empty DB owned by postgres
  runuser -u postgres -- createdb "$TEST_DB"

  # Restore (custom format → use pg_restore, not psql)
  # -j 1 conservative; small DB, no benefit from parallel.
  # --no-owner / --no-acl to avoid role-existence failures in throwaway env.
  if ! runuser -u postgres -- pg_restore --no-owner --no-acl -d "$TEST_DB" "$dump_path" 2> "$TMP/restore.err"; then
    echo "FAIL: pg_restore exited non-zero. stderr:"
    cat "$TMP/restore.err"
    exit 5
  fi

  # Show any non-fatal restore warnings (errors above would already have aborted)
  if [ -s "$TMP/restore.err" ]; then
    echo "--- pg_restore stderr (non-fatal warnings) ---"
    cat "$TMP/restore.err"
    echo "--- end stderr ---"
  fi

  # Assertion: claude_accounts table exists. Use to_regclass (NULL if absent).
  # Quoted single shot; -X to skip any system psqlrc.
  exists=$(runuser -u postgres -- psql -X -At -d "$TEST_DB" \
    -c "SELECT to_regclass('public.claude_accounts') IS NOT NULL")
  if [ "$exists" != "t" ]; then
    echo "FAIL: claude_accounts table not found in restored DB (got '$exists')"
    exit 6
  fi

  # Belt-and-suspenders: count migrations table rows (sanity)
  mig_count=$(runuser -u postgres -- psql -X -At -d "$TEST_DB" \
    -c "SELECT COUNT(*) FROM schema_migrations" 2>/dev/null || echo "?")

  echo "OK: restored from $base, claude_accounts present, schema_migrations rows=$mig_count"
  echo "=== pg-restore-test end ==="
} >> "$LOG" 2>&1
