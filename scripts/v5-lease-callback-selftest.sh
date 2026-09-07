#!/usr/bin/env bash
# Isolated P2 contract test: no real deploy, network, secrets, or ticket writes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/run"
export OC_V5_LEASE_DB="$T/lease.db" OC_V5_LEASE_LOCK="$T/run/db.lock"
export OC_V5_LEASE_CALLBACK_SECRET_FILE="$T/secret.env"
export OC_V5_LEASE_CALLBACK_URL=http://127.0.0.1:18894/internal/v3/lease-callback
export OC_V5_LEASE_TASK_CLI="$T/bin/task" FAKE_LEASE_ROOT="$T"
export PATH="$T/bin:$PATH"
printf 'OC_LEASE_CALLBACK_SECRET=%064d\n' 0 >"$T/secret.env"
cat >"$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -eu
cat >>"$FAKE_LEASE_ROOT/requests"
mode="$(cat "$FAKE_LEASE_ROOT/mode")"
case "$mode" in
 busy) printf '{"kind":"in_flight"}\n200' ;;
 gone) printf '{"kind":"gone"}\n200' ;;
 404) printf '{"error":"not found"}\n404' ;;
 unavailable) printf '{"kind":"no_transport"}\n200' ;;
 fail) echo "connection lost" >&2; exit 7 ;;
 *) printf '{"kind":"%s"}\n200' "$mode" ;;
esac
EOF
cat >"$T/bin/task" <<'EOF'
#!/usr/bin/env bash
set -eu
case "$1 $2" in
 "ticket get") cat "$FAKE_LEASE_ROOT/comments" 2>/dev/null || true ;;
 "ticket comment")
   printf '%s\n' "$5" >>"$FAKE_LEASE_ROOT/comments"
   if [[ -f "$FAKE_LEASE_ROOT/drop" ]]; then rm "$FAKE_LEASE_ROOT/drop"; exit 1; fi ;;
 *) exit 2 ;;
esac
EOF
chmod +x "$T/bin/"*
source "$SCRIPT_DIR/v5-lease-worker.sh"
lease_init_db
pass=0
eq() { [[ "$1" == "$2" ]] || { echo "FAIL $3: $1 != $2" >&2; exit 1; }; pass=$((pass+1)); echo "ok $pass - $3"; }
q() { lease_sql "$1"; }
reset() {
  q "DELETE FROM outbox; DELETE FROM lease;"
  rm -f "$T/comments" "$T/drop"
  lease_sql "INSERT INTO lease(id,resource,mode,status,owner,owner_uid,callback_session_key,ticket_ref,created_at,updated_at)
    VALUES('ls-test','deploy:selfhost','ride','failed','test','3','agent:main:webchat:dm:webtest','OCV5-133','x','x');"
  lease_sql "$(lease_outbox_sql test ls-test failed session agent:main:webchat:dm:webtest '列车失败证据')"
}
due() { q "UPDATE outbox SET next_attempt_at='2000-01-01T00:00:00Z';"; }
reset; echo injected >"$T/mode"; deliver_outbox
eq "$(q 'SELECT status FROM outbox;')" delivered "injected marks session delivered"
eq "$(q 'SELECT target_kind FROM outbox;')" session "delivery target remains session"
reset; echo busy >"$T/mode"; deliver_outbox
eq "$(q 'SELECT status FROM outbox;')" pending "busy remains pending"
eq "$(q 'SELECT attempts FROM outbox;')" 0 "busy does not spend attempts"
eq "$(q "SELECT next_attempt_at > strftime('%Y-%m-%dT%H:%M:%SZ','now') FROM outbox;")" 1 "busy schedules future retry"
reset; echo 404 >"$T/mode"; deliver_outbox
eq "$(q 'SELECT target_kind FROM outbox;')" session "HTTP 404 is endpoint failure not deleted conversation"
eq "$(q 'SELECT attempts FROM outbox;')" 1 "404 spends retry attempt"
reset; echo unavailable >"$T/mode"; deliver_outbox
eq "$(q 'SELECT status FROM outbox;')" pending "no transport retries"
reset; echo fail >"$T/mode"; deliver_outbox
eq "$(q 'SELECT attempts FROM outbox;')" 1 "curl failure retries"
reset; echo gone >"$T/mode"; deliver_outbox
eq "$(q 'SELECT target_kind FROM outbox;')" ticket "semantic gone falls back"
deliver_outbox
eq "$(q 'SELECT status FROM outbox;')" fallback_ticket "comment delivery never claims session delivery"
eq "$(grep -c 'lease-outbox' "$T/comments")" 1 "one fallback comment"
reset; q "UPDATE outbox SET deadline='2000-01-01T00:00:00Z',last_error='http=503';"; deliver_outbox
eq "$(q 'SELECT target_kind FROM outbox;')" ticket "deadline gets ticket warning"
eq "$(q "SELECT deadline > strftime('%Y-%m-%dT%H:%M:%SZ','now') FROM outbox;")" 1 "fallback gets its own delivery window"
touch "$T/drop"; deliver_outbox
eq "$(q 'SELECT status FROM outbox;')" pending "lost comment response retries"
due; deliver_outbox
eq "$(q 'SELECT status FROM outbox;')" fallback_ticket "lost response deduplicated"
eq "$(grep -c 'lease-outbox' "$T/comments")" 1 "lost response adds no duplicate comment"
eq "$(grep -c 'http=503' "$T/comments")" 1 "original failure reason preserved"

# Registration validation: fake git only; never touches a real branch or lease DB.
git init -q --bare "$T/origin.git"
git init -q -b feat/test "$T/repo"
git -C "$T/repo" config user.email test@example.invalid
git -C "$T/repo" config user.name test
echo test >"$T/repo/a"; git -C "$T/repo" add a; git -C "$T/repo" commit -qm test
git -C "$T/repo" remote add origin "$T/origin.git"; git -C "$T/repo" push -q origin feat/test
export OC_V5_LEASE_REPO_ROOT="$T/repo" OC_V5_LEASE_BRANCH=feat/test
export OC_V5_LEASE_LIVE_LINK="$T/absent-live" OC_V5_LEASE_SURVIVOR_STATE="$T/absent-state"
export OC_USER_ID=3
unset OC_SESSION_KEY
export OPENCLAUDE_SESSION_KEY=agent:main:webchat:dm:webtest
sha="$(git -C "$T/repo" rev-parse HEAD)"
q "DELETE FROM outbox; DELETE FROM lease;"
echo gone >"$T/mode"
if bash "$SCRIPT_DIR/oc-lease.sh" register --resource deploy:selfhost --sha "$sha" --ticket OCV5-133 >"$T/register.log" 2>&1; then
  echo "FAIL registration with invalid ownership succeeded"; exit 1
fi
eq "$(q 'SELECT count(*) FROM lease;')" 0 "validate rejects before insert"
echo validated >"$T/mode"
bash "$SCRIPT_DIR/oc-lease.sh" register --resource deploy:selfhost --sha "$sha" --ticket OCV5-133 >"$T/register.log"
eq "$(q 'SELECT callback_session_key FROM lease;')" agent:main:webchat:dm:webtest "CCB existing alias binds origin session"
bash "$SCRIPT_DIR/oc-lease.sh" register --resource deploy:selfhost --sha "$sha" --ticket OCV5-133 >"$T/register.log"
eq "$(q 'SELECT count(*) FROM lease;')" 1 "register idempotent"
echo "PASS: $pass assertions"
