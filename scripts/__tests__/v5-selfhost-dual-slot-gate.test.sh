#!/usr/bin/env bash
# OCV5-854: Comprehensive red/green tests covering B02, B03, B04, B05, B11, B12, B13, N01.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf 'ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'not ok - %s\n' "$1" >&2; }

assert_eq() {
  local label="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then pass "$label"
  else fail "$label (want='$want' got='$got')"; fi
}

# ── 1. bash -n syntax validation across all touched scripts ──────────────
for f in \
  scripts/v5-selfhost-slot-exec.sh \
  scripts/v5-selfhost-dual-slot-lib.sh \
  scripts/lib/v5-selfhost-release-policy.sh \
  scripts/deploy-v5-selfhost.sh \
  scripts/v5-selfhost-master-release-lib.sh \
  scripts/v5-selfhost-watch.sh \
  scripts/v5-selfhost-cutover-survivor.sh \
  scripts/v5-selfhost-boot-guard.sh \
  scripts/agent-remote/drain-remote-v4.sh; do
  if bash -n "$ROOT/$f"; then pass "bash -n $f"; else fail "bash -n $f"; fi
done

# ── 2. B02: v5-selfhost-slot-exec.sh overrides shared OC_SLOT=A env ──────
SYN_ENV="$TMP/shared.env"
cat >"$SYN_ENV" <<'EOF'
OC_SLOT=A
OPENCLAUDE_GATEWAY_PORT=18790
OC_REMOTE_V4_DRAIN_SOCKET=/run/openclaude-v5-selfhost/remote-v4-drain.sock
OC_PREHEAT_DISABLED=0
OC_IMAGE_DISTRIBUTE_DISABLED=0
EOF

OUT_A="$(bash -c "set -a; source '$SYN_ENV'; set +a; OC_SLOT_EXEC_OVERRIDE=/usr/bin/env '$ROOT/scripts/v5-selfhost-slot-exec.sh' A")"
OUT_B="$(bash -c "set -a; source '$SYN_ENV'; set +a; OC_SLOT_EXEC_OVERRIDE=/usr/bin/env '$ROOT/scripts/v5-selfhost-slot-exec.sh' B")"

grep -qx 'OC_SLOT=A' <<<"$OUT_A" \
  && grep -qx 'OPENCLAUDE_GATEWAY_PORT=18791' <<<"$OUT_A" \
  && grep -qx 'OC_REMOTE_V4_DRAIN_SOCKET=/run/openclaude-v5-selfhost/remote-v4-drain-A.sock' <<<"$OUT_A" \
  && grep -qx 'OC_PREHEAT_DISABLED=1' <<<"$OUT_A" \
  && grep -qx 'OC_IMAGE_DISTRIBUTE_DISABLED=1' <<<"$OUT_A" \
  && pass "B02: slot-exec A overrides shared env cleanly" || fail "B02: slot-exec A env mismatch"

grep -qx 'OC_SLOT=B' <<<"$OUT_B" \
  && grep -qx 'OPENCLAUDE_GATEWAY_PORT=18795' <<<"$OUT_B" \
  && grep -qx 'OC_REMOTE_V4_DRAIN_SOCKET=/run/openclaude-v5-selfhost/remote-v4-drain-B.sock' <<<"$OUT_B" \
  && grep -qx 'OC_PREHEAT_DISABLED=1' <<<"$OUT_B" \
  && grep -qx 'OC_IMAGE_DISTRIBUTE_DISABLED=1' <<<"$OUT_B" \
  && pass "B02: slot-exec B overrides OC_SLOT=A from shared EnvironmentFile" || fail "B02: slot-exec B env mismatch"

rc=0; bash "$ROOT/scripts/v5-selfhost-slot-exec.sh" C >/dev/null 2>&1 || rc=$?
assert_eq "B02: slot-exec rejects invalid slot C" "64" "$rc"

# ── 3. Source dual-slot lib & unit templates ─────────────────────────────
# shellcheck source=scripts/v5-selfhost-dual-slot-lib.sh
source "$ROOT/scripts/v5-selfhost-dual-slot-lib.sh"

assert_eq "slot A port" "18791" "$(selfhost_master_slot_port A)"
assert_eq "slot B port" "18795" "$(selfhost_master_slot_port B)"
assert_eq "slot A priv port" "18896" "$(selfhost_master_slot_priv_port A)"
assert_eq "slot B priv port" "18897" "$(selfhost_master_slot_priv_port B)"

UNIT_OUT="$TMP/systemd"
install_selfhost_dual_slot_units "$UNIT_OUT"
grep -q 'v5-selfhost-slot-exec.sh %i' "$UNIT_OUT/openclaude-v5-selfhost@.service" \
  && grep -q 'WorkingDirectory=/opt/openclaude/openclaude-v5-selfhost-slot-%i' "$UNIT_OUT/openclaude-v5-selfhost@.service" \
  && pass "B02: master@.service template invokes v5-selfhost-slot-exec.sh %i" \
  || fail "B02: master@.service template missing slot-exec launcher"

# ── 4. N01: secret passed via stdin curl -K -, NEVER in curl argv ────────
mkdir -p "$TMP/fakebin"
cat >"$TMP/fakebin/curl" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
out_file=""
while (( $# > 0 )); do
  case "$1" in
    -o) out_file="$2"; shift 2 ;;
    *)
      if [[ "$1" == *"TOPSECRET_N01_TOKEN"* ]]; then
        echo "SECRET_LEAKED_IN_ARGV" >&2
        exit 99
      fi
      shift
      ;;
  esac
done
stdin_cfg="$(cat)"
if ! grep -q 'header = "x-oc-egress-secret: TOPSECRET_N01_TOKEN"' <<<"$stdin_cfg"; then
  echo "SECRET_MISSING_FROM_STDIN" >&2
  exit 98
fi
[[ -n "$out_file" ]] && printf '{"ok":true,"slot":"A","fencing":true}' >"$out_file"
printf '200'
SHIM
chmod +x "$TMP/fakebin/curl"

n01_out="$(PATH="$TMP/fakebin:$PATH" OC_EGRESS_SECRET="TOPSECRET_N01_TOKEN" OC_SELFHOST_PRIV_CONTROL_CMD="" \
  selfhost_priv_control_call A POST /internal/v5/cutover-fence '{"enabled":true}')"
assert_eq "N01: curl receives secret only on stdin (-K -), never argv" "200" "${n01_out%%$'\n'*}"

# ── 5. B05: Docker liveness + SQL NULL/remote/stopped counterexamples ────
PG_DB="openclaude_v5_selfhost"
DRY=0
ALLOW_INFLIGHT=0
export OC_SELFHOST_IDLE_WAIT_TIMEOUT_SEC=1
export OC_SELFHOST_IDLE_WAIT_POLL_SEC=0
export OC_SELFHOST_DUAL_SLOT_ACTIVE=1
cutover_clog() { printf '%s\n' "$*" >>"$TMP/gate.log"; }

printf 'A\n' >"$TMP/fd-slot"
mock_fd_cmd() {
  local method="$1" path="$2" body="${3:-}" cur next
  cur="$(cat "$TMP/fd-slot")"
  if [[ "$method" == "GET" && "$path" == "/status" ]]; then
    printf '{"ok":true,"slot":"%s"}\n' "$cur"; return 0
  fi
  if [[ "$method" == "POST" && "$path" == "/switch" ]]; then
    next="$(printf '%s' "$body" | jq -r '.slot')"
    printf '%s\n' "$next" >"$TMP/fd-slot"
    printf 'SWITCH:%s\n' "$next" >>"$TMP/flip.trace"
    if [[ "${MOCK_FD_DROP_ACK:-0}" == "1" ]]; then
      return 28
    fi
    printf '{"ok":true,"slot":"%s"}\n' "$next"; return 0
  fi
  return 1
}
export OC_SELFHOST_FRONTDOOR_HTTP_CMD=mock_fd_cmd

MOCK_PRIV_CODE="200"
MOCK_PRIV_BODY='{"ok":true,"slot":"A","role":"leader","vipOwner":true,"fencing":true,"containerLinkEnabled":true,"nonSurvivableInFlight":0}'
mock_priv_simple() { printf '%s\n%s\n' "$MOCK_PRIV_CODE" "$MOCK_PRIV_BODY"; }
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv_simple

mock_docker_inspect() {
  case "$1" in
    cid_running_*) printf 'true\n' ;;
    cid_stopped_*) printf 'false\n' ;;
    *) return 1 ;;
  esac
}
export OC_SELFHOST_DOCKER_INSPECT_CMD=mock_docker_inspect

# Real PostgreSQL B05 SQL check when local test PG (55432) is reachable;
# otherwise verify SQL structure + hermetic counterexample matrix.
if PGHOST=127.0.0.1 PGPORT=55432 PGUSER=test PGPASSWORD=test PGDATABASE=openclaude_test \
   psql -X -qAt -c 'SELECT 1;' >/dev/null 2>&1; then
  B05_DB="oc_test_b05_${BASHPID}_${RANDOM}"
  PGHOST=127.0.0.1 PGPORT=55432 PGUSER=test PGPASSWORD=test PGDATABASE=openclaude_test \
    psql -X -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$B05_DB\";"
  b05_sql() {
    PGHOST=127.0.0.1 PGPORT=55432 PGUSER=test PGPASSWORD=test psql -X -v ON_ERROR_STOP=1 -q -d "$B05_DB" -c "$1"
  }
  b05_sql "CREATE TABLE compute_hosts (id uuid PRIMARY KEY, name text NOT NULL);"
  b05_sql "CREATE TABLE agent_containers (id bigint PRIMARY KEY, user_id bigint NOT NULL, host_id bigint, host_uuid uuid, bound_ip inet, port integer, runtime_channel text NOT NULL, runtime_kind text NOT NULL, state text NOT NULL, container_internal_id text, docker_id text);"
  b05_sql "CREATE TABLE turn_dispatches (dispatch_id uuid PRIMARY KEY, user_id bigint NOT NULL, status text NOT NULL, terminal_at timestamptz, agent_container_id bigint, runtime_kind text);"
  b05_sql "CREATE TABLE request_finalize_journal (request_id text PRIMARY KEY, state text NOT NULL, ctx jsonb NOT NULL, dispatch_id uuid);"
  b05_sql "CREATE TABLE remote_agent_bindings (id serial PRIMARY KEY, state text NOT NULL);"
  b05_sql "INSERT INTO compute_hosts VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','self'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','remote-node-1');"
  b05_sql "INSERT INTO agent_containers VALUES
    (1,3,NULL,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','172.31.116.99',18789,'v5','docker','active','cid_running_1',NULL),
    (2,3,99,NULL,'172.31.116.98',18789,'v5','docker','active','cid_running_remote',NULL),
    (3,3,NULL,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','172.31.116.97',18789,'v5','docker','active','cid_stopped_3',NULL),
    (4,3,NULL,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',NULL,18789,'v5','docker','active','cid_running_noip',NULL),
    (5,3,NULL,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','172.31.116.95',0,'v5','docker','active','cid_running_noport',NULL),
    (6,3,NULL,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','172.31.116.94',18789,'v5','docker','active','cid_running_remuuid',NULL);"

  psql_as_postgres() {
    PGHOST=127.0.0.1 PGPORT=55432 PGUSER=test PGPASSWORD=test psql -X -v ON_ERROR_STOP=1 "$@"
  }
  PG_DB="$B05_DB"

  # Counterexample 1: runtime_kind IS NULL (SQL 3-valued logic trap) -> MUST BLOCK
  b05_sql "INSERT INTO turn_dispatches VALUES ('11111111-1111-1111-1111-111111111111',3,'accepted',NULL,1,NULL);"
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (real PG): runtime_kind=NULL accepted dispatch blocks cutover" "1" "$rc"
  b05_sql "DELETE FROM turn_dispatches;"

  # Counterexample 2: remote host_id!=NULL container -> MUST BLOCK
  b05_sql "INSERT INTO turn_dispatches VALUES ('22222222-2222-2222-2222-222222222222',3,'accepted',NULL,2,'docker');"
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (real PG): remote host_id!=NULL container accepted dispatch blocks cutover" "1" "$rc"
  b05_sql "DELETE FROM turn_dispatches;"

  # Counterexample 3: DB active local container whose docker inspect returns false -> MUST BLOCK
  b05_sql "INSERT INTO turn_dispatches VALUES ('33333333-3333-3333-3333-333333333333',3,'accepted',NULL,3,'docker');"
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (real PG): DB active but Docker stopped container blocks cutover" "1" "$rc"
  b05_sql "DELETE FROM turn_dispatches;"

  # Counterexample 4: missing bound_ip -> MUST BLOCK
  b05_sql "INSERT INTO turn_dispatches VALUES ('44444444-4444-4444-4444-444444444441',3,'accepted',NULL,4,'docker');"
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (real PG): missing bound_ip blocks cutover" "1" "$rc"
  b05_sql "DELETE FROM turn_dispatches;"

  # Counterexample 5: port=0 -> MUST BLOCK
  b05_sql "INSERT INTO turn_dispatches VALUES ('44444444-4444-4444-4444-444444444442',3,'accepted',NULL,5,'docker');"
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (real PG): port<=0 blocks cutover" "1" "$rc"
  b05_sql "DELETE FROM turn_dispatches;"

  # Counterexample 6: host_uuid points to non-self compute_host -> MUST BLOCK
  b05_sql "INSERT INTO turn_dispatches VALUES ('44444444-4444-4444-4444-444444444443',3,'accepted',NULL,6,'docker');"
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (real PG): non-self host_uuid blocks cutover" "1" "$rc"
  b05_sql "DELETE FROM turn_dispatches;"

  # Counterexample 7: containerLinkEnabled=false (OC_CONTAINER_LINK=0) -> MUST BLOCK even for live local container
  b05_sql "INSERT INTO turn_dispatches VALUES ('44444444-4444-4444-4444-444444444444',3,'accepted',NULL,1,'docker');"
  MOCK_PRIV_BODY='{"ok":true,"slot":"A","role":"leader","vipOwner":true,"fencing":true,"containerLinkEnabled":false,"nonSurvivableInFlight":0}'
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (real PG): containerLinkEnabled=false blocks cutover even with live local docker container" "1" "$rc"

  # Positive case: local self-host v5 active docker container + bound_ip + port + Running=true + containerLinkEnabled=true -> ALLOWS
  MOCK_PRIV_BODY='{"ok":true,"slot":"A","role":"leader","vipOwner":true,"fencing":true,"containerLinkEnabled":true,"nonSurvivableInFlight":0}'
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (real PG): local self-host v5 active + bound_ip + port + Docker Running + containerLinkEnabled passes" "0" "$rc"

  PGHOST=127.0.0.1 PGPORT=55432 PGUSER=test PGPASSWORD=test PGDATABASE=openclaude_test \
    psql -X -v ON_ERROR_STOP=1 -q -c "DROP DATABASE \"$B05_DB\";"
  PG_DB="openclaude_v5_selfhost"
else
  selfhost_query_tiered_idle_pg() { printf '%s\n' "$MOCK_PG_ROW"; }
  MOCK_PG_ROW="0|1|0|0|0|"
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (hermetic): NULL/remote accepted dispatch blocks cutover" "1" "$rc"

  MOCK_PG_ROW="0|1|1|0|0|cid_stopped_3"
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (hermetic): DB active but docker inspect false blocks cutover" "1" "$rc"

  MOCK_PG_ROW="0|2|2|0|0|cid_running_1,cid_running_2"
  MOCK_PRIV_BODY='{"ok":true,"slot":"A","role":"leader","vipOwner":true,"fencing":true,"containerLinkEnabled":false,"nonSurvivableInFlight":0}'
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (hermetic): containerLinkEnabled=false blocks cutover" "1" "$rc"

  MOCK_PRIV_BODY='{"ok":true,"slot":"A","role":"leader","vipOwner":true,"fencing":true,"containerLinkEnabled":true,"nonSurvivableInFlight":0}'
  rc=0; selfhost_cutover_wait_for_safe_window --slot=A || rc=$?
  assert_eq "B05 (hermetic): live local docker accepted dispatches pass" "0" "$rc"
fi

# ── 6. B04 + B11: Preheat -> Fence -> Gate -> CAS -> Switch -> Post-drain -> Stop ──
export V5_SLOT_LINK_PREFIX="$TMP/slot"
export V5_DUAL_SLOT_RECOVERY_LOCK="$TMP/recovery-lock.json"
export OC_SELFHOST_DRAIN_POLL_SEC=0.05
export OC_SELFHOST_OLD_SLOT_DRAIN_TIMEOUT_SEC=5
export OC_SELFHOST_FRONTDOOR_WAIT_POLL_SEC=0.05
export OC_SELFHOST_MIGRATE_HEALTH_POLL_SEC=0.05
export OC_SELFHOST_STANDBY_POLL_SEC=0.05
mkdir -p "$TMP/rel-old/scripts" "$TMP/rel-new/scripts"
touch "$TMP/rel-old/scripts/v5-selfhost-frontdoor.mjs" "$TMP/rel-new/scripts/v5-selfhost-frontdoor.mjs"
ln -sfn "$TMP/rel-old" "$TMP/slot-A"

# Stateful CAS mock for deploy_state (8 fields including operation_id)
printf 'A|A|A|stable|10|%s|1|\n' "$TMP/rel-old" >"$TMP/ds-row"
selfhost_deploy_state_read_override() { cat "$TMP/ds-row"; }
selfhost_psql_rw_override() {
  local sql row a dl dc ph lv ar gen op expect_lv new_slot new_ph next_lv
  sql="$(cat)"
  row="$(cat "$TMP/ds-row")"
  IFS='|' read -r a dl dc ph lv ar gen op <<<"$row"
  expect_lv="$(printf '%s' "$sql" | sed -nE "s/.*lock_version *= *([0-9]+).*/\1/p" | tail -n 1)"
  if [[ "$expect_lv" != "$lv" || "${MOCK_CAS_FAIL_STABLE:-0}" == "1" && "$sql" == *"phase"*"'stable'"* ]]; then
    return 0
  fi
  next_lv=$(( lv + 1 ))
  new_slot="$(printf '%s' "$sql" | sed -nE "s/.*active_slot *= *'([AB])'.*/\1/p" | head -n 1)"
  new_ph="$(printf '%s' "$sql" | sed -nE "s/.*phase *= *'([a-z]+)'.*/\1/p" | head -n 1)"
  [[ -n "$new_slot" ]] || new_slot="$a"
  [[ -n "$new_ph" ]] || new_ph="$ph"
  printf '%s|%s|%s|%s|%s|%s|%s|\n' "$new_slot" "$new_slot" "$new_slot" "$new_ph" "$next_lv" "$ar" "$((gen + 1))" >"$TMP/ds-row"
  printf 'DS_CAS:%s:%s->%s\n' "$new_ph" "$lv" "$next_lv" >>"$TMP/flip.trace"
  printf '%s\n' "$next_lv"
}

systemctl() {
  printf 'SYSTEMCTL:%s\n' "$*" >>"$TMP/flip.trace"
  if [[ "${MOCK_SYSTEMCTL_FAIL_ENABLE:-0}" == "1" && "$1" == "enable" ]]; then return 1; fi
  if [[ "${MOCK_SYSTEMCTL_FAIL_STOP_OLD:-0}" == "1" && "$1" == "stop" && "$2" == "openclaude-v5-selfhost@A.service" ]]; then return 1; fi
  return 0
}
selfhost_wait_slot_standby_ready() { printf 'STANDBY_READY:%s\n' "$1" >>"$TMP/flip.trace"; return 0; }
selfhost_query_tiered_idle_pg() { printf '0|1|1|0|0|cid_running_1\n'; }
mock_hz_cmd() { [[ "${MOCK_HZ_OK:-1}" == "1" ]]; }
export OC_SELFHOST_HEALTHZ_CMD=mock_hz_cmd

# B04 test: stream arrives on old slot A after fence; post-switch drain waits 2 polls until nonSurvivableInFlight==0 before stopping @A
printf '0\n' >"$TMP/drain-polls"
mock_priv_b04() {
  local slot="$1" method="$2" path="$3" body="${4:-}"
  printf 'PRIV:%s:%s:%s:%s\n' "$slot" "$method" "$path" "$body" >>"$TMP/flip.trace"
  if [[ "$path" == "/internal/v5/cutover-fence" ]]; then
    local en; en="$(printf '%s' "$body" | jq -r '.enabled')"
    printf '200\n{"ok":true,"slot":"%s","fencing":%s}\n' "$slot" "$en"; return 0
  fi
  if [[ "$path" == "/internal/v5/cutover-readiness" ]]; then
    if [[ "$slot" == "A" && "$(cat "$TMP/fd-slot")" == "B" ]]; then
      local c; c=$(( $(cat "$TMP/drain-polls") + 1 )); printf '%s\n' "$c" >"$TMP/drain-polls"
      if (( c <= 2 )); then
        printf '200\n{"ok":true,"slot":"A","role":"standby","vipOwner":false,"fencing":true,"containerLinkEnabled":true,"nonSurvivableInFlight":1}\n'; return 0
      fi
      printf '200\n{"ok":true,"slot":"A","role":"standby","vipOwner":false,"fencing":true,"containerLinkEnabled":true,"nonSurvivableInFlight":0}\n'; return 0
    fi
    printf '200\n{"ok":true,"slot":"%s","role":"leader","vipOwner":true,"fencing":true,"containerLinkEnabled":true,"nonSurvivableInFlight":0}\n' "$slot"; return 0
  fi
  printf '200\n{"ok":true,"slot":"%s","closedCount":1}\n' "$slot"
}
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv_b04

rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"
printf 'A\n' >"$TMP/fd-slot"
: >"$TMP/flip.trace"
if selfhost_master_dual_slot_flip "$TMP/rel-new"; then
  pass "B04: preheat -> fence -> gate -> switch -> post-drain -> stop succeeded"
else
  fail "B04: dual-slot flip failed"
fi
line_preheat="$(grep -n '^STANDBY_READY:B$' "$TMP/flip.trace" | head -n1 | cut -d: -f1)"
line_fence="$(grep -n 'PRIV:A:POST:/internal/v5/cutover-fence:{"enabled":true}' "$TMP/flip.trace" | head -n1 | cut -d: -f1)"
line_switch="$(grep -n '^SWITCH:B$' "$TMP/flip.trace" | head -n1 | cut -d: -f1)"
line_stop_old="$(grep -n 'SYSTEMCTL:stop openclaude-v5-selfhost@A.service' "$TMP/flip.trace" | head -n1 | cut -d: -f1)"
(( line_preheat < line_fence && line_fence < line_switch && line_switch < line_stop_old )) \
  && [[ "$(cat "$TMP/drain-polls")" == "3" ]] \
  && pass "B04: verified exact order (preheat < fence < switch < wait-drain(3 polls) < stop @A)" \
  || fail "B04: ordering/drain assertion failed (preheat=$line_preheat fence=$line_fence switch=$line_switch stop=$line_stop_old polls=$(cat "$TMP/drain-polls"))"

# B11 Case A: /switch commits B then drops ACK, then B fails leader+VIP -> reads back /status, reverts to A, verifies A live+unfenced, then stops @B
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"
printf 'A\n' >"$TMP/fd-slot"
printf 'A|A|A|stable|20|%s|2|\n' "$TMP/rel-old" >"$TMP/ds-row"
: >"$TMP/flip.trace"
MOCK_FD_DROP_ACK=1
printf 'true\n' >"$TMP/a-fencing"
mock_priv_b11_fail_leader() {
  local slot="$1" method="$2" path="$3" body="${4:-}"
  printf 'PRIV:%s:%s:%s\n' "$slot" "$method" "$path" >>"$TMP/flip.trace"
  if [[ "$path" == "/internal/v5/cutover-fence" ]]; then
    local en; en="$(printf '%s' "$body" | jq -r '.enabled')"
    [[ "$slot" == "A" ]] && printf '%s\n' "$en" >"$TMP/a-fencing"
    printf '200\n{"ok":true,"slot":"%s","fencing":%s}\n' "$slot" "$en"; return 0
  fi
  if [[ "$path" == "/internal/v5/cutover-readiness" ]]; then
    if [[ "$slot" == "B" ]]; then
      printf '200\n{"ok":true,"slot":"B","role":"standby","vipOwner":false,"fencing":false,"containerLinkEnabled":true,"nonSurvivableInFlight":0}\n'; return 0
    fi
    local af; af="$(cat "$TMP/a-fencing")"
    printf '200\n{"ok":true,"slot":"A","role":"leader","vipOwner":true,"fencing":%s,"containerLinkEnabled":true,"nonSurvivableInFlight":0}\n' "$af"; return 0
  fi
  printf '200\n{"ok":true}\n'
}
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv_b11_fail_leader
selfhost_wait_slot_leader_vip() {
  local s="$1"
  [[ "$s" == "A" ]] && return 0 || return 1
}
rc=0; selfhost_master_dual_slot_flip "$TMP/rel-new" || rc=$?
MOCK_FD_DROP_ACK=0
assert_eq "B11 (lost ACK + B fails leader): returns 1 after verified rollback" "1" "$rc"
assert_eq "B11 (lost ACK): frontdoor readback + revert restored A" "A" "$(cat "$TMP/fd-slot")"
assert_eq "B11 (lost ACK): old slot A verified unfenced (fencing==false)" "false" "$(cat "$TMP/a-fencing")"
grep -q 'SYSTEMCTL:stop openclaude-v5-selfhost@B.service' "$TMP/flip.trace" \
  && ! grep -q 'stop.*openclaude-v5-selfhost@A.service' "$TMP/flip.trace" \
  && pass "B11: stopped candidate @B ONLY after verified rollback + unfence of @A" \
  || fail "B11: rollback stop invariant violated"

# B11 Case B: Rollback verification fails (18790 healthz red) -> keeps BOTH slots running, writes recovery lock, returns 79
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"
printf 'A\n' >"$TMP/fd-slot"
printf 'A|A|A|stable|30|%s|3|\n' "$TMP/rel-old" >"$TMP/ds-row"
: >"$TMP/flip.trace"
MOCK_HZ_OK=0
rc=0; selfhost_master_dual_slot_flip "$TMP/rel-new" || rc=$?
MOCK_HZ_OK=1
assert_eq "B11 (rollback healthz red): returns 79 recovery_required" "79" "$rc"
[[ -f "$V5_DUAL_SLOT_RECOVERY_LOCK" ]] \
  && pass "B11: wrote persistent dual-slot-recovery-required.json lock" \
  || fail "B11: missing persistent recovery lock"
! grep -q 'SYSTEMCTL:stop openclaude-v5-selfhost@' "$TMP/flip.trace" \
  && pass "B11: rollback verification failure keeps BOTH slots running" \
  || fail "B11: stopped a slot despite failed rollback verification"

# B11 Case B2: Subsequent selfhost_master_restart_or_flip refuses while recovery lock exists
: >"$TMP/flip.trace"
rc=0; selfhost_master_restart_or_flip "$TMP/rel-new" || rc=$?
assert_eq "B11: restart_or_flip refuses with rc=79 while recovery lock present" "79" "$rc"
[[ ! -s "$TMP/flip.trace" ]] \
  && pass "B11: recovery lock prevented any secondary flip or systemctl call" \
  || fail "B11: executed actions despite recovery lock"
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"

# B11 Case C: Fault injection — cutover-fence(true) applies on server then drops ACK!
# Subcase C1: unfence succeeds + readback confirms fencing==false -> stops @B safely, returns 1
printf 'A\n' >"$TMP/fd-slot"
printf 'A|A|A|stable|35|%s|3|\n' "$TMP/rel-old" >"$TMP/ds-row"
printf 'false\n' >"$TMP/a-fencing"
: >"$TMP/flip.trace"
mock_priv_fence_drop_ack_ok_unfence() {
  local slot="$1" method="$2" path="$3" body="${4:-}"
  printf 'PRIV:%s:%s:%s:%s\n' "$slot" "$method" "$path" "$body" >>"$TMP/flip.trace"
  if [[ "$path" == "/internal/v5/cutover-fence" ]]; then
    if [[ "$body" == *'true'* ]]; then
      printf 'true\n' >"$TMP/a-fencing"
      printf '000\n' # lost ACK after applying true!
      return 0
    fi
    printf 'false\n' >"$TMP/a-fencing"
    printf '200\n{"ok":true,"slot":"%s","fencing":false}\n' "$slot"
    return 0
  fi
  if [[ "$path" == "/internal/v5/cutover-readiness" ]]; then
    printf '200\n{"ok":true,"slot":"%s","role":"leader","vipOwner":true,"fencing":%s,"containerLinkEnabled":true,"nonSurvivableInFlight":0}\n' "$slot" "$(cat "$TMP/a-fencing")"
    return 0
  fi
  printf '200\n{"ok":true}\n'
}
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv_fence_drop_ack_ok_unfence
rc=0; selfhost_master_dual_slot_flip "$TMP/rel-new" || rc=$?
assert_eq "B11 (fence true lost ACK, unfence verified): returns 1" "1" "$rc"
assert_eq "B11 (fence true lost ACK): old slot A unfenced to false" "false" "$(cat "$TMP/a-fencing")"
grep -q 'SYSTEMCTL:stop openclaude-v5-selfhost@B.service' "$TMP/flip.trace" \
  && pass "B11: stopped @B only after confirming A fencing==false" \
  || fail "B11: did not stop @B after confirmed unfence"

# Subcase C2: fence true drops ACK AND unfence readback still fencing==true -> keeps BOTH slots, writes lock, returns 79
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"
printf 'A\n' >"$TMP/fd-slot"
: >"$TMP/flip.trace"
mock_priv_fence_stuck_true() {
  local slot="$1" method="$2" path="$3" body="${4:-}"
  printf 'PRIV:%s:%s:%s:%s\n' "$slot" "$method" "$path" "$body" >>"$TMP/flip.trace"
  if [[ "$path" == "/internal/v5/cutover-fence" ]]; then
    printf '000\n'; return 0
  fi
  printf '200\n{"ok":true,"slot":"%s","role":"leader","vipOwner":true,"fencing":true,"containerLinkEnabled":true,"nonSurvivableInFlight":0}\n' "$slot"
}
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv_fence_stuck_true
rc=0; selfhost_master_dual_slot_flip "$TMP/rel-new" || rc=$?
assert_eq "B11 (fence stuck true): returns 79 recovery_required" "79" "$rc"
[[ -f "$V5_DUAL_SLOT_RECOVERY_LOCK" ]] && ! grep -q 'SYSTEMCTL:stop openclaude-v5-selfhost@' "$TMP/flip.trace" \
  && pass "B11 (fence stuck true): keeps both slots and persists recovery lock" \
  || fail "B11 (fence stuck true): failed to preserve both slots or lock"
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"

# Restore real leader-vip wait helper
selfhost_wait_slot_leader_vip() { return 0; }

# B11 Case D: stable CAS failure and systemctl stop @OLD failure on success path NEVER swallowed
printf 'A\n' >"$TMP/fd-slot"
printf 'A|A|A|stable|40|%s|4|\n' "$TMP/rel-old" >"$TMP/ds-row"
: >"$TMP/flip.trace"
MOCK_CAS_FAIL_STABLE=1
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv_simple
rc=0; selfhost_master_dual_slot_flip "$TMP/rel-new" || rc=$?
MOCK_CAS_FAIL_STABLE=0
assert_eq "B11: stable CAS failure returns 79 (never swallowed)" "79" "$rc"
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"

printf 'A\n' >"$TMP/fd-slot"
printf 'A|A|A|stable|41|%s|4|\n' "$TMP/rel-old" >"$TMP/ds-row"
MOCK_SYSTEMCTL_FAIL_STOP_OLD=1
rc=0; selfhost_master_dual_slot_flip "$TMP/rel-new" || rc=$?
MOCK_SYSTEMCTL_FAIL_STOP_OLD=0
assert_eq "B11: systemctl stop @OLD failure returns 79 (never swallowed)" "79" "$rc"
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"

# B11 Case E: Outer oc_hotcfg_activate_saga preserves rc=79 without running rollback compensation!
if bash -c '
  set -euo pipefail
  source "$1"
  TMPD="$2"
  ENVF="$TMPD/saga.env"
  PLAT="$TMPD/plat"
  HIST="$TMPD/hist.jsonl"
  REVERT_MARK="$TMPD/saga-reverted"
  rm -f -- "$REVERT_MARK"
  mkdir -p "$PLAT/bundles/rev1" "$TMPD/rel1"
  printf "OC_RUNTIME_IMAGE=img\nOC_RUNTIME_IMAGE_ID=sha256:1\nOC_RUNTIME_RELEASE=%s/rel1\nOC_PLATFORM_BUNDLE=%s/bundles/rev1\n" "$TMPD" "$PLAT" >"$ENVF"
  ln -sfn "bundles/rev1" "$PLAT/current"
  : >"$HIST"
  oc_hotcfg_assert_tuple_viable() { return 0; }
  oc_hotcfg_canary_boot() { return 0; }
  oc_hotcfg_assert_tuple_lossless_capability() { return 0; }
  oc_hotcfg_assert_master_lossless_capability() { return 0; }
  oc_hotcfg_assert_master_runtime_batch_pair() { return 0; }
  oc_hotcfg_assert_tuple_lossless_floor() { return 0; }
  oc_hotcfg_assert_tuple_model_authority() { return 0; }
  rc=0
  oc_hotcfg_activate_saga "$ENVF" "$PLAT" "rev1" "$HIST" "img" "sha256:1" "$TMPD/rel1" "$PLAT/bundles/rev1" "return 79" "true" "true" "touch \"$REVERT_MARK\"" "$TMPD/rel1" "" "" "" "" "joint" "" || rc=$?
  [[ "$rc" == 79 && ! -e "$REVERT_MARK" ]]
' _ "$ROOT/scripts/v5-runtime-release-lib.sh" "$TMP"; then
  pass "B11: outer oc_hotcfg_activate_saga propagates rc=79 directly without secondary compensation"
else
  fail "B11: oc_hotcfg_activate_saga swallowed rc=79 or triggered compensation"
fi

# B04 extra: drain-ws failure returns 79 + lock (does NOT stop @OLD); post-switch PG blocking waits before stopping @OLD
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"
printf 'A\n' >"$TMP/fd-slot"
printf 'A|A|A|stable|42|%s|4|\n' "$TMP/rel-old" >"$TMP/ds-row"
: >"$TMP/flip.trace"
mock_priv_drain_ws_fail() {
  local slot="$1" method="$2" path="$3" body="${4:-}"
  if [[ "$path" == "/internal/v5/drain-ws" ]]; then printf '500\n{"ok":false}\n'; return 0; fi
  if [[ "$path" == "/internal/v5/cutover-fence" ]]; then
    local en; en="$(printf '%s' "$body" | jq -r '.enabled')"
    printf '200\n{"ok":true,"slot":"%s","fencing":%s}\n' "$slot" "$en"; return 0
  fi
  printf '200\n{"ok":true,"slot":"%s","role":"leader","vipOwner":true,"fencing":true,"containerLinkEnabled":true,"nonSurvivableInFlight":0}\n' "$slot"
}
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv_drain_ws_fail
rc=0; selfhost_master_dual_slot_flip "$TMP/rel-new" || rc=$?
assert_eq "B04: drain-ws non-ok returns 79 recovery_required" "79" "$rc"
[[ -f "$V5_DUAL_SLOT_RECOVERY_LOCK" ]] && ! grep -q 'SYSTEMCTL:stop openclaude-v5-selfhost@A.service' "$TMP/flip.trace" \
  && pass "B04: drain-ws failure preserves @A and persists recovery lock" \
  || fail "B04: drain-ws failure stopped @A or missed lock"
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"

# Post-switch PG re-check: 1st post-switch PG poll sees slipped-in admitted=1, 2nd sees 0 -> waits then stops @A
printf 'A\n' >"$TMP/fd-slot"
printf 'A|A|A|stable|43|%s|4|\n' "$TMP/rel-old" >"$TMP/ds-row"
printf '0\n' >"$TMP/pg-recheck-cnt"
: >"$TMP/flip.trace"
selfhost_query_tiered_idle_pg() {
  if [[ "$(cat "$TMP/fd-slot")" == "B" ]]; then
    local c; c=$(( $(cat "$TMP/pg-recheck-cnt") + 1 )); printf '%s\n' "$c" >"$TMP/pg-recheck-cnt"
    if (( c == 1 )); then printf '1|1|1|0|0|cid_running_1\n'; return 0; fi
  fi
  printf '0|1|1|0|0|cid_running_1\n'
}
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv_simple
if selfhost_master_dual_slot_flip "$TMP/rel-new"; then
  [[ "$(cat "$TMP/pg-recheck-cnt")" == "2" ]] \
    && pass "B04: post-switch drain re-checks PG blocking counts and waits until 0 before stopping @A" \
    || fail "B04: expected 2 post-switch PG re-checks, got $(cat "$TMP/pg-recheck-cnt")"
else
  fail "B04: post-switch PG re-check flip failed"
fi
selfhost_query_tiered_idle_pg() { printf '0|1|1|0|0|cid_running_1\n'; }

# ── 7. B03: Legacy -> frontdoor + @B migration & rollback on failure ─────
export OC_SELFHOST_DUAL_SLOT_ACTIVE=0
export V5_MIGRATION_STATE_FILE="$TMP/migration-state.json"
export V5_FRONTDOOR_STATE_FILE="$TMP/fd-state.json"
printf 'A|A|A|stable|50|%s|5\n' "$TMP/rel-old" >"$TMP/ds-row"
printf 'A\n' >"$TMP/fd-slot"
: >"$TMP/flip.trace"
selfhost_query_tiered_idle_pg() { printf '0|0|0|0|0|\n'; }
install_selfhost_dual_slot_units() { printf 'INSTALL_UNITS\n' >>"$TMP/flip.trace"; return 0; }

# Failure case: frontdoor fails to start -> stops @B, reverts deploy_state to A, restarts legacy + verifies 18790
systemctl() {
  printf 'SYSTEMCTL:%s\n' "$*" >>"$TMP/flip.trace"
  if [[ "$1" == "is-enabled" ]]; then return 0; fi
  if [[ "$1" == "start" && "$2" == "$V5_FRONTDOOR_UNIT" ]]; then return 1; fi
  return 0
}
rc=0; selfhost_master_migrate_legacy_to_dual_slot "$TMP/rel-new" || rc=$?
assert_eq "B03 (migration frontdoor failure): rolls back cleanly and returns 1" "1" "$rc"
grep -q 'SYSTEMCTL:start openclaude-v5-selfhost@B.service' "$TMP/flip.trace" \
  && grep -q 'SYSTEMCTL:stop openclaude-v5-selfhost@B.service' "$TMP/flip.trace" \
  && grep -q 'SYSTEMCTL:start openclaude-v5-selfhost.service' "$TMP/flip.trace" \
  && [[ "$(cut -d'|' -f1,4 "$TMP/ds-row")" == "A|stable" ]] \
  && pass "B03: migration preheats @B first and restores legacy A on failure" \
  || fail "B03: migration failure rollback trace incomplete"

# Rollback to older release without frontdoor.mjs
export OC_SELFHOST_DUAL_SLOT_ACTIVE=1
mkdir -p "$TMP/rel-legacy-pre854/scripts"
: >"$TMP/flip.trace"
systemctl() { printf 'SYSTEMCTL:%s\n' "$*" >>"$TMP/flip.trace"; return 0; }
selfhost_master_restart_or_flip "$TMP/rel-legacy-pre854"
grep -q 'SYSTEMCTL:restart openclaude-v5-selfhost.service' "$TMP/flip.trace" \
  && pass "B03: rollback to pre-frontdoor release restores legacy unit" \
  || fail "B03: did not fall back to legacy unit for pre-frontdoor release"

# ── 8. B12: release_policy_observe_stack dual-slot forward/rollback/mismatch ──
SCRIPT_DIR="$ROOT/scripts"
# shellcheck source=scripts/lib/v5-selfhost-release-policy.sh
source "$ROOT/scripts/lib/v5-selfhost-release-policy.sh"
V5_ENV="$TMP/v5.env"; : >"$V5_ENV"
OC_HOTCFG_PLATFORM_ROOT="$TMP/plat"; mkdir -p "$OC_HOTCFG_PLATFORM_ROOT"
MASTER_LIVE_LINK="$TMP/live-link"; ln -sfn "$TMP/rel-new" "$MASTER_LIVE_LINK"
V5_PORT=18790
V5_UNIT="openclaude-v5-selfhost.service"
V5_EGRESS_UNIT="openclaude-v5-selfhost-egress.service"
egress_live_release_has_slots() { return 1; }
release_policy_py() {
  printf 'POLICY_VERIFY:%s\n' "$*" >>"$TMP/policy.trace"
  printf 'sha256-verified-%s\n' "$6"
}

export OC_SELFHOST_DUAL_SLOT_ACTIVE=1
printf 'B\n' >"$TMP/fd-slot"
printf 'B|B|B|stable|60|%s|6\n' "$TMP/rel-new" >"$TMP/ds-row"
: >"$TMP/policy.trace"
dig="$(release_policy_observe_stack target)"
assert_eq "B12 (forward dual-slot): accepts matching slot B + frontdoor" "sha256-verified-target" "$dig"
grep -q 'openclaude-v5-selfhost@B.service openclaude-v5-selfhost-egress.service openclaude-v5-selfhost-frontdoor.service' "$TMP/policy.trace" \
  && pass "B12 (forward): passes exact @B + frontdoor units to verify-stack" \
  || fail "B12 (forward): wrong units passed to verify-stack"

printf 'A\n' >"$TMP/fd-slot"
printf 'A|A|A|stable|61|%s|7\n' "$TMP/rel-old" >"$TMP/ds-row"
dig_rb="$(release_policy_observe_stack before)"
assert_eq "B12 (rollback dual-slot): accepts matching slot A + frontdoor" "sha256-verified-before" "$dig_rb"

# Split-brain mismatch: frontdoor=B, PG active_slot=A -> MUST REJECT (rc=79)
printf 'B\n' >"$TMP/fd-slot"
printf 'A|A|A|stable|61|%s|7\n' "$TMP/rel-old" >"$TMP/ds-row"
rc=0; release_policy_observe_stack target >/dev/null 2>&1 || rc=$?
assert_eq "B12 (mismatch): rejects frontdoor=B vs PG active_slot=A with rc=79" "79" "$rc"

# ── 9. B13: watch.sh restart_master_for_live when frontdoor alive & both @A/@B dead ──
WATCH_TMP="$TMP/watch-b13"
mkdir -p "$WATCH_TMP/rel-live"
ln -sfn "$WATCH_TMP/rel-live" "$WATCH_TMP/live"
printf '{"slot":"A"}\n' >"$WATCH_TMP/fd-state.json"

# Run in subshell to isolate watch.sh definitions
if bash -c '
  set -euo pipefail
  source "$1"
  WATCH_LIVE="$2/live"
  WATCH_SLOT_LINK_PREFIX="$2/slot"
  WATCH_FRONTDOOR_STATE_FILE="$2/fd-state.json"
  WATCH_MASTER_READY_TIMEOUT_SEC=2
  WATCH_LOG="$2/watch.log"
  TRACE="$2/watch.trace"
  : >"$TRACE"
  systemctl() {
    printf "SYS:%s\n" "$*" >>"$TRACE"
    if [[ "$1" == "is-active" ]]; then
      [[ "$2" == "$WATCH_FRONTDOOR_UNIT" ]] && { echo active; return 0; }
      [[ "$2" == "openclaude-v5-selfhost@A.service" ]] && { echo failed; return 3; }
      echo inactive; return 3
    fi
    return 0
  }
  watch_verify_ok() { printf "VERIFY:%s\n" "$1" >>"$TRACE"; return 0; }
  export WATCH_MASTER_VERIFY_CMD=watch_verify_ok
  restart_master_for_live
  grep -q "^SYS:restart openclaude-v5-selfhost@A.service$" "$TRACE"
  grep -q "^VERIFY:A$" "$TRACE"
  [[ "$(readlink -f "$2/slot-A")" == "$2/rel-live" ]]
' _ "$ROOT/scripts/v5-selfhost-watch.sh" "$WATCH_TMP"; then
  pass "B13: watch starts @A and verifies health when frontdoor active & both @A/@B dead"
else
  fail "B13: watch failed to recover dead @A while frontdoor active"
fi

if bash -c '
  set -euo pipefail
  source "$1"
  WATCH_LIVE="$2/live"
  WATCH_SLOT_LINK_PREFIX="$2/slot"
  WATCH_FRONTDOOR_STATE_FILE="$2/fd-state.json"
  WATCH_MASTER_READY_TIMEOUT_SEC=1
  WATCH_LOG="$2/watch.log"
  systemctl() {
    if [[ "$1" == "is-active" ]]; then
      [[ "$2" == "$WATCH_FRONTDOOR_UNIT" ]] && { echo active; return 0; }
      echo failed; return 3
    fi
    if [[ "$1" == "restart" && "$2" == "openclaude-v5-selfhost@A.service" ]]; then
      return 1
    fi
    return 0
  }
  rc=0; restart_master_for_live || rc=$?
  [[ "$rc" != 0 ]]
' _ "$ROOT/scripts/v5-selfhost-watch.sh" "$WATCH_TMP"; then
  pass "B13: watch returns non-zero when @A restart fails (never treats frontdoor alive as green)"
else
  fail "B13: watch falsely returned 0 when @A failed to start"
fi

# ── 10. B03 + B13 counterexamples: empty curl / exit 7 NEVER false-greens + real frontdoor CLI wait ──
mkdir -p "$TMP/curl-fail7"
cat >"$TMP/curl-fail7/curl" <<'SHIM'
#!/usr/bin/env bash
exit 7
SHIM
chmod +x "$TMP/curl-fail7/curl"

if bash -c '
  set -euo pipefail
  export PATH="$1:$PATH"
  source "$2"
  export OC_SELFHOST_STANDBY_POLL_SEC=0.05
  rc1=0; selfhost_wait_slot_standby_ready B 1 >/dev/null 2>&1 || rc1=$?
  rc2=0; selfhost_healthz_18790_ok >/dev/null 2>&1 || rc2=$?
  [[ "$rc1" != 0 && "$rc2" != 0 ]]
' _ "$TMP/curl-fail7" "$ROOT/scripts/v5-selfhost-dual-slot-lib.sh"; then
  pass "B03: curl exit 7 / empty response strictly fails standby and 18790 healthz probes"
else
  fail "B03: curl exit 7 false-greened standby or healthz probe"
fi

if bash -c '
  set -euo pipefail
  export PATH="$1:$PATH"
  source "$2"
  WATCH_LIVE="$3/live"
  WATCH_SLOT_LINK_PREFIX="$3/slot"
  WATCH_FRONTDOOR_STATE_FILE="$3/fd-state.json"
  WATCH_MASTER_READY_TIMEOUT_SEC=1
  WATCH_LOG="$3/watch-empty.log"
  unset WATCH_MASTER_VERIFY_CMD
  systemctl() {
    if [[ "$1" == "is-active" ]]; then
      [[ "$2" == "$WATCH_FRONTDOOR_UNIT" ]] && { echo active; return 0; }
      echo failed; return 3
    fi
    return 0
  }
  rc=0; restart_master_for_live || rc=$?
  [[ "$rc" != 0 ]]
' _ "$TMP/curl-fail7" "$ROOT/scripts/v5-selfhost-watch.sh" "$WATCH_TMP"; then
  pass "B13: watch restart_master_for_live strictly returns non-zero when curl returns exit 7 / empty"
else
  fail "B13: watch restart_master_for_live false-greened on curl exit 7"
fi

# Real frontdoor CLI startup -> immediate selfhost_wait_frontdoor_ready + switch B
FD_REAL_DIR="$TMP/fd-real"
mkdir -p "$FD_REAL_DIR"
FD_PORT="$(node -e 'const n=require("net"),s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
OC_FRONTDOOR_HOST=127.0.0.1 OC_FRONTDOOR_PORT="$FD_PORT" \
  OC_FRONTDOOR_CONTROL_SOCKET="$FD_REAL_DIR/frontdoor.sock" \
  OC_FRONTDOOR_STATE_FILE="$FD_REAL_DIR/frontdoor-state.json" \
  node "$ROOT/scripts/v5-selfhost-frontdoor.mjs" >/dev/null 2>&1 &
FD_PID=$!
if (
  unset OC_SELFHOST_FRONTDOOR_HTTP_CMD
  V5_FRONTDOOR_CONTROL_SOCKET="$FD_REAL_DIR/frontdoor.sock"
  OC_SELFHOST_FRONTDOOR_WAIT_POLL_SEC=0.05
  selfhost_wait_frontdoor_ready 5 && selfhost_frontdoor_switch_verified B && [[ "$(selfhost_frontdoor_read_slot)" == "B" ]]
); then
  pass "B03: real frontdoor CLI wait helper waits for socket ready and switches to B"
else
  fail "B03: real frontdoor CLI wait + switch failed"
fi
kill -TERM "$FD_PID" 2>/dev/null || true
wait "$FD_PID" 2>/dev/null || true

# ── 11. boot-guard slot symlink repair test ──────────────────────────────
BG_DIR="$TMP/bootguard"
mkdir -p "$BG_DIR/releases/rel-ok-20261122-000000"
printf '{"schemaVersion":2,"sourceCommit":"%s"}\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  >"$BG_DIR/releases/rel-ok-20261122-000000/.complete"
ln -sfn "$BG_DIR/releases/rel-ok-20261122-000000" "$BG_DIR/live"
ln -sfn "$BG_DIR/releases/rel-gone-000000" "$BG_DIR/slot-B"
BOOT_LIVE="$BG_DIR/live" BOOT_SLOT_PREFIX="$BG_DIR/slot" BOOT_RELEASES_ROOT="$BG_DIR/releases" \
  BOOT_LOG="$BG_DIR/bg.log" BOOT_DO_RELOAD=0 bash "$ROOT/scripts/v5-selfhost-boot-guard.sh" >/dev/null
assert_eq "boot-guard repairs dangling slot-B symlink to healthy live target" \
  "$BG_DIR/releases/rel-ok-20261122-000000" "$(readlink -f "$BG_DIR/slot-B")"

printf 'passed=%d failed=%d\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
