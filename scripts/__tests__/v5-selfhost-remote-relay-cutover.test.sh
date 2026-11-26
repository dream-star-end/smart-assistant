#!/usr/bin/env bash
# OCV5-855: Comprehensive hermetic red/green tests for independent blue-green remote-relay
# covering B1, B2, B3, B5, B6, B7, B9, B10, SQL tightening, and live v4 cutover gate.
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

# ── 1. Syntax & B3 systemd unit template validation ──────────────────────
for f in \
  scripts/deploy-v5-selfhost.sh \
  scripts/v5-selfhost-dual-slot-lib.sh \
  scripts/v5-selfhost-remote-relay-lib.sh \
  scripts/v5-selfhost-slot-exec.sh \
  scripts/lib/v5-selfhost-cutover-units.sh \
  scripts/lib/v5-selfhost-release-policy.sh; do
  if bash -n "$ROOT/$f"; then pass "bash -n $f"; else fail "bash -n $f"; fi
done

UNIT_FILE="$ROOT/deploy/v5-selfhost/openclaude-v5-selfhost-remote-relay@.service"
[[ -f "$UNIT_FILE" ]] \
  && grep -qx 'WorkingDirectory=/opt/openclaude/openclaude-v5-selfhost-live' "$UNIT_FILE" \
  && grep -qx 'EnvironmentFile=/etc/openclaude/commercial-v5-selfhost.env' "$UNIT_FILE" \
  && grep -qx 'Environment="OC_REMOTE_RELAY_SLOT=%i"' "$UNIT_FILE" \
  && grep -qx 'Environment="OC_REMOTE_RELAY_SLOT_SOCK_PREFIX=/run/openclaude-v5-selfhost/remote-relay"' "$UNIT_FILE" \
  && grep -qx 'Environment="OC_REMOTE_RELAY_SOCKET=/run/openclaude-v5-selfhost/remote-relay-active.sock"' "$UNIT_FILE" \
  && grep -qx 'Environment="OC_REMOTE_RELAY_STATE_FILE=/var/lib/openclaude-v5-selfhost/remote-relay-state.json"' "$UNIT_FILE" \
  && grep -q 'assert-flavor.sh identity --effector /opt/openclaude/openclaude-v5-selfhost-live/scripts/lib' "$UNIT_FILE" \
  && grep -qx 'ExecStart=/usr/bin/node --import tsx packages/commercial/src/remoteRelay/main.ts' "$UNIT_FILE" \
  && grep -qx 'KillMode=mixed' "$UNIT_FILE" \
  && ! grep -qx 'KillMode=control-group' "$UNIT_FILE" \
  && grep -qx 'KillSignal=SIGTERM' "$UNIT_FILE" \
  && grep -qx 'TimeoutStopSec=1860' "$UNIT_FILE" \
  && grep -qx 'SendSIGKILL=yes' "$UNIT_FILE" \
  && grep -qx 'RuntimeDirectory=openclaude-v5-selfhost' "$UNIT_FILE" \
  && grep -qx 'StateDirectory=openclaude-v5-selfhost' "$UNIT_FILE" \
  && grep -qx 'StateDirectoryMode=0700' "$UNIT_FILE" \
  && pass "B3: systemd template uses KillMode=mixed, KillSignal=SIGTERM, StateDirectory & env contract" \
  || fail "B3: systemd template missing required directives"

# ── 2. v5-selfhost-slot-exec.sh exports remote-relay defaults & overrides ──
OUT_A="$(OC_SLOT_EXEC_OVERRIDE=/usr/bin/env bash "$ROOT/scripts/v5-selfhost-slot-exec.sh" A)"
grep -qx 'OC_SLOT=A' <<<"$OUT_A" \
  && grep -qx 'OC_REMOTE_RELAY_SOCKET=/run/openclaude-v5-selfhost/remote-relay-active.sock' <<<"$OUT_A" \
  && grep -qx 'OC_REMOTE_RELAY_MODE=auto' <<<"$OUT_A" \
  && pass "slot-exec exports default OC_REMOTE_RELAY_SOCKET and OC_REMOTE_RELAY_MODE=auto" \
  || fail "slot-exec missing remote-relay default exports"

OUT_OVR="$(OC_REMOTE_RELAY_SOCKET=/tmp/custom.sock OC_REMOTE_RELAY_MODE=external OC_SLOT_EXEC_OVERRIDE=/usr/bin/env bash "$ROOT/scripts/v5-selfhost-slot-exec.sh" B)"
grep -qx 'OC_SLOT=B' <<<"$OUT_OVR" \
  && grep -qx 'OC_REMOTE_RELAY_SOCKET=/tmp/custom.sock' <<<"$OUT_OVR" \
  && grep -qx 'OC_REMOTE_RELAY_MODE=external' <<<"$OUT_OVR" \
  && pass "slot-exec honors explicit OC_REMOTE_RELAY_SOCKET/OC_REMOTE_RELAY_MODE overrides" \
  || fail "slot-exec failed to honor remote-relay overrides"

# ── 3. Source libs + B10 Master unit soft ordering + secret safety ───────
export V5_REMOTE_RELAY_SOCK_PREFIX="$TMP/run/remote-relay"
export V5_REMOTE_RELAY_ACTIVE_SOCK="$TMP/run/remote-relay-active.sock"
export V5_REMOTE_RELAY_STATE_FILE="$TMP/state/remote-relay-state.json"
export V5_REMOTE_RELAY_LOG="$TMP/remote-relay.log"
export V5_SYSTEMD_DIR="$TMP/systemd"
export OC_SELFHOST_DUAL_SLOT_RECOVERY_LOCK="$TMP/recovery-lock.json"
export V5_DUAL_SLOT_RECOVERY_LOCK="$TMP/recovery-lock.json"
mkdir -p "$TMP/run" "$TMP/state" "$TMP/systemd" "$TMP/fakebin"

# shellcheck source=scripts/v5-selfhost-dual-slot-lib.sh
source "$ROOT/scripts/v5-selfhost-dual-slot-lib.sh"

MASTER_TPL="$(render_selfhost_master_slot_unit)"
! grep -q '^After=.*remote-relay' <<<"$MASTER_TPL" \
  && ! grep -q '^Wants=.*remote-relay' <<<"$MASTER_TPL" \
  && ! grep -q '^Requires=.*remote-relay' <<<"$MASTER_TPL" \
  && pass "N1: master@.service has NO After=/Wants=/Requires= dependency on remote-relay@{A,B} (never blocks live cutover)" \
  || fail "N1: master@.service must NOT order After= remote-relay@{A,B}"

# ── 4. B1: Real snapshot_cutover_units_from_release -> install + backup + missing-in-snap guard ──
if bash -c '
  set -Eeuo pipefail
  TMPD="$1"; ROOTD="$2"
  export V5_UNIT="openclaude-v5-selfhost.service"
  export V5_EGRESS_UNIT="openclaude-v5-selfhost-egress.service"
  export V5_EGRESS_SLOT_SOCKET_TPL="openclaude-v5-selfhost-egress@.socket"
  export V5_EGRESS_SLOT_SERVICE_TPL="openclaude-v5-selfhost-egress@.service"
  export V5_REMOTE_RELAY_SLOT_TPL="openclaude-v5-selfhost-remote-relay@.service"
  export V5_CUTOVER_SNAP_DIR="$TMPD/snap-root"
  export V5_SYSTEMD_DIR="$TMPD/sys-b1"
  export BREAKGLASS_ROOT="$TMPD/bg-b1"
  export MASTER_LIVE_LINK="/opt/openclaude/openclaude-v5-selfhost-live"
  mkdir -p "$V5_CUTOVER_SNAP_DIR" "$V5_SYSTEMD_DIR" "$BREAKGLASS_ROOT" "$TMPD/cand/deploy/v5-selfhost"
  cat >"$TMPD/cand/deploy/v5-selfhost/$V5_UNIT" <<EOF
[Service]
WorkingDirectory=/opt/openclaude/openclaude-v5-selfhost-live
ExecStart=/bin/true
EOF
  cat >"$TMPD/cand/deploy/v5-selfhost/$V5_EGRESS_UNIT" <<EOF
[Service]
WorkingDirectory=/opt/openclaude/openclaude-v5-selfhost-live
ExecStart=/bin/true
EOF
  cp "$ROOTD/deploy/v5-selfhost/$V5_REMOTE_RELAY_SLOT_TPL" "$TMPD/cand/deploy/v5-selfhost/"

  source "$ROOTD/scripts/v5-selfhost-remote-relay-lib.sh"
  source "$ROOTD/scripts/lib/v5-selfhost-cutover-units.sh"
  mlog() { :; }
  assert_unit_templates_live_wd() { :; }
  snapshot_host_log_policy() { :; }
  fsync_path() { [[ -e "$1" ]]; }

  snap_dir=""
  snapshot_cutover_units_from_release "$TMPD/cand" snap_dir
  [[ -f "$snap_dir/$V5_REMOTE_RELAY_SLOT_TPL" ]]
  install_remote_relay_slot_unit_from "$snap_dir"
  cmp -s "$ROOTD/deploy/v5-selfhost/$V5_REMOTE_RELAY_SLOT_TPL" "$V5_SYSTEMD_DIR/$V5_REMOTE_RELAY_SLOT_TPL"

  # Also test backup_installed_units_for_cutover includes remote-relay@.service
  cp "$TMPD/cand/deploy/v5-selfhost/$V5_UNIT" "$V5_SYSTEMD_DIR/"
  cp "$TMPD/cand/deploy/v5-selfhost/$V5_EGRESS_UNIT" "$V5_SYSTEMD_DIR/"
  source "$ROOTD/scripts/v5-selfhost-master-release-lib.sh"
  bak_dir=""
  backup_installed_units_for_cutover bak_dir
  [[ -f "$bak_dir/$V5_REMOTE_RELAY_SLOT_TPL" ]]
  cleanup_cutover_unit_snap
' _ "$TMP" "$ROOT"; then
  pass "B1: real snapshot_cutover_units_from_release -> install_remote_relay_slot_unit_from & backup_installed_units_for_cutover include remote-relay template"
else
  fail "B1: snapshot/install/backup of remote-relay template failed"
fi

# B1 negative: candidate release has template, but snapshot lacks it -> STEP 5 MUST call cutover_compensate "missing-remote-relay-unit-in-snap"
if python3 - "$ROOT/scripts/deploy-v5-selfhost.sh" "$TMP" <<'PY'
import re, subprocess, sys
src = open(sys.argv[1]).read()
m = re.search(r'^    if declare -F install_remote_relay_slot_unit_from >/dev/null 2>&1; then\n.*?^    fi$', src, re.M | re.S)
assert m, 'STEP 5 remote-relay install block not found'
block = m.group(0)
assert 'missing-remote-relay-unit-in-snap' in block, 'missing-remote-relay-unit-in-snap guard absent'
tmp = sys.argv[2]
script = f"""
set -Eeuo pipefail
rel="{tmp}/b1-src"
unit_snap="{tmp}/b1-snap-empty"
mkdir -p "$rel/deploy/v5-selfhost" "$unit_snap"
touch "$rel/deploy/v5-selfhost/openclaude-v5-selfhost-remote-relay@.service"
install_remote_relay_slot_unit_from() {{ return 2; }}
cutover_clog() {{ :; }}
cutover_compensate() {{ printf '%s\\n' "$1" >"{tmp}/b1-comp"; return 77; }}
run_step() {{
{block}
}}
rc=0; run_step || rc=$?
[[ "$rc" == "77" && "$(cat "{tmp}/b1-comp")" == "missing-remote-relay-unit-in-snap" ]]
"""
subprocess.run(['bash', '-c', script], check=True)
PY
then
  pass "B1: STEP 5 fails closed with cutover_compensate(missing-remote-relay-unit-in-snap) when source has unit but snap lacks it"
else
  fail "B1: STEP 5 did not fail closed on missing-in-snap remote-relay unit"
fi

# Secret safety via stdin curl -K - (never argv)
python3 - "$TMP/run/remote-relay-A.sock" <<'PY' &
import os, socket, sys, time
p = sys.argv[1]
if os.path.exists(p): os.unlink(p)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(p); s.listen(1)
time.sleep(3)
s.close()
PY
SOCK_PID=$!
for _ in $(seq 1 40); do [[ -S "$TMP/run/remote-relay-A.sock" ]] && break; sleep 0.05; done
cat >"$TMP/fakebin/curl" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
out_file=""
while (( $# > 0 )); do
  case "$1" in
    -o) out_file="$2"; shift 2 ;;
    *)
      if [[ "$1" == *"SUPER_SECRET_RELAY_855"* ]]; then echo "SECRET_LEAKED_IN_ARGV" >&2; exit 99; fi
      shift ;;
  esac
done
stdin_cfg="$(cat)"
grep -q 'header = "x-oc-egress-secret: SUPER_SECRET_RELAY_855"' <<<"$stdin_cfg" || exit 98
[[ -n "$out_file" ]] && printf '{"ok":true,"role":"remote-relay","slot":"A","instanceId":"rr-sec-1","runtimeState":"ready","remoteRuntimeReady":true,"accepting":true}' >"$out_file"
printf '200'
SHIM
chmod +x "$TMP/fakebin/curl"
inst_sec="$(PATH="$TMP/fakebin:$PATH" OC_EGRESS_SECRET="SUPER_SECRET_RELAY_855" OC_SELFHOST_REMOTE_RELAY_HTTP_CMD="" \
  remote_relay_probe_health "$TMP/run/remote-relay-A.sock" A)"
assert_eq "remote_relay_http passes secret ONLY on stdin (-K -) and returns instanceId" "rr-sec-1" "$inst_sec"
kill "$SOCK_PID" 2>/dev/null || true; wait "$SOCK_PID" 2>/dev/null || true
rm -f -- "$TMP/run/remote-relay-A.sock"

# ── 5. remote_relay_slot_flip matrix: B6 (disabled vs error), B9 (dual-active), B10 (state.json) ──
mkdir -p "$TMP/rel-rr/deploy/v5-selfhost" "$TMP/rel-old-no-rr/deploy/v5-selfhost"
cp "$UNIT_FILE" "$TMP/rel-rr/deploy/v5-selfhost/"
export MASTER_LIVE_LINK="$TMP/live"
ln -sfn "$TMP/rel-rr" "$MASTER_LIVE_LINK"
export OC_REMOTE_RELAY_READY_TIMEOUT_SEC=1
export OC_REMOTE_RELAY_READY_POLL_SEC=0.05

RR_STATE_DIR="$TMP/rr-state"
mkdir -p "$RR_STATE_DIR"
printf 'inactive\n' >"$RR_STATE_DIR/A"
printf 'inactive\n' >"$RR_STATE_DIR/B"
printf 'disabled\n' >"$RR_STATE_DIR/en-A"
printf 'disabled\n' >"$RR_STATE_DIR/en-B"
: >"$TMP/rr.trace"

MOCK_SYS_FAIL_STOP_UNIT=""
MOCK_SYS_FAIL_ENABLE_UNIT=""
systemctl() {
  local cmd="$1"; shift
  printf 'SYS:%s %s\n' "$cmd" "$*" >>"$TMP/rr.trace"
  case "$cmd" in
    is-active)
      local u="$1" st
      if [[ "$u" == *"@A.service" ]]; then st="$(cat "$RR_STATE_DIR/A")"
      elif [[ "$u" == *"@B.service" ]]; then st="$(cat "$RR_STATE_DIR/B")"
      else st="inactive"; fi
      printf '%s\n' "$st"; [[ "$st" == "active" ]] && return 0 || return 3 ;;
    is-enabled)
      local u="$1" en
      if [[ "$u" == *"@A.service" ]]; then en="$(cat "$RR_STATE_DIR/en-A")"
      elif [[ "$u" == *"@B.service" ]]; then en="$(cat "$RR_STATE_DIR/en-B")"
      else en="disabled"; fi
      printf '%s\n' "$en"; [[ "$en" == "enabled" ]] && return 0 || return 1 ;;
    start)
      [[ "$1" == *"@A.service" ]] && printf 'active\n' >"$RR_STATE_DIR/A"
      [[ "$1" == *"@B.service" ]] && printf 'active\n' >"$RR_STATE_DIR/B"
      return 0 ;;
    stop)
      local u="${@: -1}"
      if [[ -n "$MOCK_SYS_FAIL_STOP_UNIT" && "$u" == "$MOCK_SYS_FAIL_STOP_UNIT" ]]; then return 1; fi
      [[ "$u" == *"@A.service" ]] && printf 'inactive\n' >"$RR_STATE_DIR/A"
      [[ "$u" == *"@B.service" ]] && printf 'inactive\n' >"$RR_STATE_DIR/B"
      return 0 ;;
    enable)
      local u="${@: -1}"
      if [[ -n "$MOCK_SYS_FAIL_ENABLE_UNIT" && "$u" == "$MOCK_SYS_FAIL_ENABLE_UNIT" ]]; then return 1; fi
      [[ "$u" == *"@A.service" ]] && printf 'enabled\n' >"$RR_STATE_DIR/en-A"
      [[ "$u" == *"@B.service" ]] && printf 'enabled\n' >"$RR_STATE_DIR/en-B"
      return 0 ;;
    disable)
      local u="${@: -1}"
      [[ "$u" == *"@A.service" ]] && printf 'disabled\n' >"$RR_STATE_DIR/en-A"
      [[ "$u" == *"@B.service" ]] && printf 'disabled\n' >"$RR_STATE_DIR/en-B"
      return 0 ;;
  esac
}

MOCK_RR_MODE="ready"   # ready | disabled | error | b-unhealthy | active-fail | b-draining
MOCK_RR_DRAIN_OK=1
MOCK_RR_REOPEN_OK=1
MOCK_RR_DRAINING_POLLS=0
mock_rr_http() {
  local sock="$1" method="$2" path="$3" body="${4:-}" target_slot=""
  printf 'HTTP:%s:%s:%s:%s\n' "$(basename -- "$sock")" "$method" "$path" "$body" >>"$TMP/rr.trace"
  if [[ "$sock" == "$V5_REMOTE_RELAY_ACTIVE_SOCK" ]]; then
    if [[ "$MOCK_RR_MODE" == "active-fail" ]]; then printf '503\n{"ok":false}\n'; return 0; fi
    local resolved; resolved="$(readlink -- "$sock" 2>/dev/null || true)"
    case "$resolved" in
      *remote-relay-A.sock) target_slot="A" ;;
      *remote-relay-B.sock) target_slot="B" ;;
      *) printf '000\n'; return 0 ;;
    esac
  elif [[ "$sock" == *"remote-relay-A.sock" ]]; then target_slot="A"
  elif [[ "$sock" == *"remote-relay-B.sock" ]]; then target_slot="B"; fi

  if [[ "$method" == "POST" && "$path" == "/drain-begin" ]]; then
    printf 'DRAIN_BEGIN:%s:%s\n' "$target_slot" "$body" >>"$TMP/rr.trace"
    printf '200\n{"ok":true,"draining":true,"slot":"%s"}\n' "$target_slot"; return 0
  fi
  if [[ "$method" == "POST" && "$path" == "/reopen" ]]; then
    printf 'REOPEN:%s\n' "$target_slot" >>"$TMP/rr.trace"
    if [[ "$MOCK_RR_REOPEN_OK" == "1" ]]; then printf '200\n{"ok":true,"draining":false,"slot":"%s"}\n' "$target_slot"
    else printf '500\n{"ok":false,"draining":true}\n'; fi
    return 0
  fi
  if [[ "$method" == "POST" && "$path" == "/drain" ]]; then
    printf 'DRAIN_BLOCK:%s:%s\n' "$target_slot" "$body" >>"$TMP/rr.trace"
    if [[ "$MOCK_RR_DRAIN_OK" == "1" ]]; then printf '200\n{"ok":true,"drained":true,"slot":"%s"}\n' "$target_slot"
    else printf '503\n{"ok":false,"error":"DRAIN_TIMEOUT"}\n'; fi
    return 0
  fi
  if [[ "$method" == "GET" && "$path" == "/healthz" ]]; then
    if [[ "$MOCK_RR_MODE" == "disabled" ]]; then
      printf '200\n{"ok":true,"role":"remote-relay","slot":"%s","instanceId":"rr-%s-dis","runtimeState":"disabled","remoteRuntimeReady":false,"accepting":false,"draining":false}\n' "$target_slot" "$target_slot"; return 0
    fi
    if [[ "$MOCK_RR_MODE" == "b-draining" && "$target_slot" == "B" ]]; then
      MOCK_RR_DRAINING_POLLS=$((MOCK_RR_DRAINING_POLLS + 1))
      if (( MOCK_RR_DRAINING_POLLS >= 2 )); then
        printf 'inactive\n' >"$RR_STATE_DIR/B"
      fi
      printf '200\n{"ok":true,"role":"remote-relay","slot":"B","instanceId":"rr-B-old","runtimeState":"ready","remoteRuntimeReady":true,"accepting":false,"draining":true}\n'; return 0
    fi
    if [[ "$MOCK_RR_MODE" == "error" ]] || [[ "$MOCK_RR_MODE" == "b-unhealthy" && "$target_slot" == "B" ]]; then
      printf '503\n{"ok":false,"role":"remote-relay","slot":"%s","instanceId":"rr-%s-err","runtimeState":"error","remoteRuntimeReady":false,"accepting":false,"draining":false}\n' "$target_slot" "$target_slot"; return 0
    fi
    printf '200\n{"ok":true,"role":"remote-relay","slot":"%s","instanceId":"rr-%s-inst","runtimeState":"ready","remoteRuntimeReady":true,"accepting":true,"draining":false}\n' "$target_slot" "$target_slot"; return 0
  fi
  printf '404\n{"ok":false}\n'
}
export OC_SELFHOST_REMOTE_RELAY_HTTP_CMD=mock_rr_http

# B6a: intentionally-disabled (rc=76) cleanly skips flip without blocking & without writing state/symlink
rm -f -- "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$V5_REMOTE_RELAY_STATE_FILE"
MOCK_RR_MODE="disabled"
rc=0; remote_relay_probe_health "$TMP/run/remote-relay-A.sock" A >/dev/null || rc=$?
assert_eq "B6: remote_relay_probe_health returns 76 for intentionally disabled" "76" "$rc"
if remote_relay_slot_flip; then
  [[ ! -e "$V5_REMOTE_RELAY_ACTIVE_SOCK" && ! -e "$V5_REMOTE_RELAY_STATE_FILE" ]] \
    && assert_eq "B6: disabled slot stopped cleanly" "none" "$(remote_relay_describe_topology)"
  pass "B6: intentionally-disabled remote-relay skips cleanly (rc=0) without faking healthy"
else
  fail "B6: intentionally-disabled remote-relay blocked cutover"
fi

# B6b: runtimeState=error (503) strictly blocks flip (rc=1)
MOCK_RR_MODE="error"
rc=0; remote_relay_slot_flip || rc=$?
assert_eq "B6: broken/error (503) remote-relay strictly fails flip (rc=1)" "1" "$rc"
MOCK_RR_MODE="ready"

# Normal none->A and A->B + B10 state.json verification
if remote_relay_slot_flip; then
  assert_eq "flip none->A symlink" "remote-relay-A.sock" "$(readlink "$V5_REMOTE_RELAY_ACTIVE_SOCK")"
  jq -e '.version == 1 and .migrated == true and .activeSlot == "A" and .instanceId == "rr-A-inst" and (.switchedAt | length > 0)' "$V5_REMOTE_RELAY_STATE_FILE" >/dev/null \
    && pass "B10: remote-relay-state.json persisted accurately after none->A" \
    || fail "B10: remote-relay-state.json invalid after none->A"
else
  fail "flip none->A failed"
fi

: >"$TMP/rr.trace"
if remote_relay_slot_flip; then
  assert_eq "flip A->B symlink" "remote-relay-B.sock" "$(readlink "$V5_REMOTE_RELAY_ACTIVE_SOCK")"
  jq -e '.version == 1 and .migrated == true and .activeSlot == "B" and .instanceId == "rr-B-inst"' "$V5_REMOTE_RELAY_STATE_FILE" >/dev/null \
    && pass "B10: remote-relay-state.json updated atomically to slot B" \
    || fail "B10: remote-relay-state.json not updated to slot B"
  line_start_b="$(grep -n '^SYS:start openclaude-v5-selfhost-remote-relay@B.service$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  line_enable_b="$(grep -n '^SYS:enable openclaude-v5-selfhost-remote-relay@B.service$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  line_drain_a="$(grep -n '^DRAIN_BEGIN:A:{"exitWhenDrained":true}$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  line_dis_a="$(grep -n '^SYS:disable openclaude-v5-selfhost-remote-relay@A.service$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  (( line_start_b < line_enable_b && line_enable_b < line_drain_a && line_drain_a < line_dis_a )) \
    && ! grep -q '^SYS:stop --no-block openclaude-v5-selfhost-remote-relay@A.service$' "$TMP/rr.trace" \
    && pass "B3+B10+N1: flip A->B enables @B BEFORE commit, retires @A via online /drain-begin(exitWhenDrained=true) with ZERO systemd stop job" \
    || fail "B3+B10+N1: flip A->B ordering wrong or emitted systemd stop job on @A"
else
  fail "flip A->B failed"
fi

# B10 AUDITOR COUNTEREXAMPLE: systemctl enable @B fails -> MUST abort (rc=1), keep A enabled/active/symlink/state untouched!
printf 'active\n' >"$RR_STATE_DIR/A"; printf 'inactive\n' >"$RR_STATE_DIR/B"
printf 'enabled\n' >"$RR_STATE_DIR/en-A"; printf 'disabled\n' >"$RR_STATE_DIR/en-B"
remote_relay_atomic_switch_symlink A
remote_relay_write_state_atomic A "rr-A-inst"
: >"$TMP/rr.trace"
MOCK_SYS_FAIL_ENABLE_UNIT="openclaude-v5-selfhost-remote-relay@B.service"
rc=0; remote_relay_slot_flip || rc=$?
MOCK_SYS_FAIL_ENABLE_UNIT=""
assert_eq "B10 (auditor counterexample): systemctl enable @B failure MUST fail flip (rc=1)" "1" "$rc"
assert_eq "B10: enable @B failure keeps symlink at A" "remote-relay-A.sock" "$(readlink "$V5_REMOTE_RELAY_ACTIVE_SOCK")"
assert_eq "B10: enable @B failure keeps state.json at A" "A" "$(jq -r '.activeSlot' "$V5_REMOTE_RELAY_STATE_FILE")"
assert_eq "B10: enable @B failure keeps @A enabled" "enabled" "$(cat "$RR_STATE_DIR/en-A")"
! grep -q '^DRAIN_BEGIN:A' "$TMP/rr.trace" \
  && pass "B10: enable @B failure never drained or disabled @A" \
  || fail "B10: enable @B failure touched @A"

# Active symlink probe fail rolls back BOTH symlink AND state.json
printf 'active\n' >"$RR_STATE_DIR/A"; printf 'inactive\n' >"$RR_STATE_DIR/B"
remote_relay_atomic_switch_symlink A
remote_relay_write_state_atomic A "rr-A-inst"
MOCK_RR_MODE="active-fail"
rc=0; remote_relay_slot_flip || rc=$?
MOCK_RR_MODE="ready"
assert_eq "active symlink probe failure returns 1" "1" "$rc"
assert_eq "active symlink probe failure rolls symlink back to A" "remote-relay-A.sock" "$(readlink "$V5_REMOTE_RELAY_ACTIVE_SOCK")"
assert_eq "active symlink probe failure preserves state.json activeSlot=A" "A" "$(jq -r '.activeSlot' "$V5_REMOTE_RELAY_STATE_FILE")"

# B9 Case 1: Both A & B active (unfinished B not draining); active.sock points to A (healthy) and state.json agrees -> MUST retain A, stop B first, then flip A->B!
printf 'active\n' >"$RR_STATE_DIR/A"; printf 'active\n' >"$RR_STATE_DIR/B"
remote_relay_atomic_switch_symlink A
remote_relay_write_state_atomic A "rr-A-inst"
: >"$TMP/rr.trace"
if remote_relay_slot_flip; then
  line_stop_b_first="$(grep -n '^SYS:stop openclaude-v5-selfhost-remote-relay@B\.service$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  line_drain_a_after="$(grep -n '^DRAIN_BEGIN:A:{"exitWhenDrained":true}$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  (( line_stop_b_first > 0 && line_drain_a_after > line_stop_b_first )) \
    && ! grep -q '^SYS:stop.*openclaude-v5-selfhost-remote-relay@A\.service$' "$TMP/rr.trace" \
    && pass "B9: dual-active preserves authoritative symlink slot A, stops unfinished B first, then flips A->B" \
    || fail "B9: dual-active recovery stopped A prematurely"
else
  fail "B9: dual-active valid recovery failed"
fi

# B3+B9 Case 1b: Both A & B active, where B is legitimately online self-draining (draining==true) -> waits for B to self-exit WITHOUT force-stopping B!
printf 'active\n' >"$RR_STATE_DIR/A"; printf 'active\n' >"$RR_STATE_DIR/B"
remote_relay_atomic_switch_symlink A
remote_relay_write_state_atomic A "rr-A-inst"
: >"$TMP/rr.trace"
MOCK_RR_MODE="b-draining"
MOCK_RR_DRAINING_POLLS=0
OC_REMOTE_RELAY_DEACTIVATING_WAIT_SEC=2 OC_REMOTE_RELAY_DEACTIVATING_POLL_SEC=0.05 remote_relay_slot_flip || rc=$?
MOCK_RR_MODE="ready"
! grep -q '^SYS:stop openclaude-v5-selfhost-remote-relay@B\.service$' "$TMP/rr.trace" \
  && pass "B3+B9: dual-active waits for legitimate draining peer B to self-exit without force-stopping it" \
  || fail "B3+B9: force-stopped legitimate draining peer B"

# B9 Case 2: Both A & B active; active.sock points to A while state.json says B (contradiction!) -> keep BOTH running, write recovery lock, return 79!
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"
printf 'active\n' >"$RR_STATE_DIR/A"; printf 'active\n' >"$RR_STATE_DIR/B"
remote_relay_atomic_switch_symlink A
remote_relay_write_state_atomic B "rr-B-inst"
: >"$TMP/rr.trace"
rc=0; remote_relay_slot_flip || rc=$?
assert_eq "B9: contradictory active.sock vs state.json returns 79" "79" "$rc"
[[ -f "$V5_DUAL_SLOT_RECOVERY_LOCK" ]] \
  && ! grep -q '^SYS:stop ' "$TMP/rr.trace" \
  && pass "B9: contradictory dual-active keeps BOTH slots running and persists recovery lock" \
  || fail "B9: contradictory dual-active stopped a slot or missed recovery lock"
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"

# ── 6. B2: First-time migration & reverse rollback orchestration ─────────
export OC_SELFHOST_DUAL_SLOT_ACTIVE=1
egress_slot_flip() { printf 'EGRESS_FLIP\n' >>"$TMP/rr.trace"; return 0; }
selfhost_master_current_slot() { printf 'A'; }
selfhost_master_restart_or_flip() { printf 'MASTER_FLIP\n' >>"$TMP/rr.trace"; return 0; }
remote_v4_cutover_drain() { printf 'OLD_MASTER_DRAIN:%s\n' "${OC_REMOTE_V4_DRAIN_SOCKET:-}" >>"$TMP/rr.trace"; return 0; }
remote_v4_cutover_reopen() { printf 'OLD_MASTER_REOPEN\n' >>"$TMP/rr.trace"; return 0; }
mock_priv_b2() {
  local slot="$1" method="$2" path="$3" body="${4:-}"
  printf 'PRIV:%s:%s:%s\n' "$slot" "$method" "$path" >>"$TMP/rr.trace"
  if [[ "$path" == "/internal/v5/cutover-fence" ]]; then
    local en; en="$(printf '%s' "$body" | jq -r '.enabled')"
    printf '200\n{"ok":true,"slot":"%s","fencing":%s}\n' "$slot" "$en"; return 0
  fi
  printf '200\n{"ok":true,"slot":"%s","fencing":false,"containerLinkEnabled":true,"nonSurvivableInFlight":0,"remoteRelayExternal":false,"remoteRelayHealthy":false,"remoteRelayInstanceId":null}\n' "$slot"
}
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv_b2

# B2a: First migration from in-process Master -> MUST fence + drain old Master BEFORE starting remote-relay@A!
ln -sfn "$TMP/rel-rr" "$MASTER_LIVE_LINK"
printf 'inactive\n' >"$RR_STATE_DIR/A"; printf 'inactive\n' >"$RR_STATE_DIR/B"
rm -f -- "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$V5_REMOTE_RELAY_STATE_FILE"
: >"$TMP/rr.trace"
if selfhost_flip_egress_relay_and_master; then
  l_eg="$(grep -n '^EGRESS_FLIP$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  l_fn="$(grep -n '^PRIV:A:POST:/internal/v5/cutover-fence$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  l_dr="$(grep -n '^OLD_MASTER_DRAIN:' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  l_rr="$(grep -n '^SYS:start openclaude-v5-selfhost-remote-relay@A\.service$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  l_ms="$(grep -n '^MASTER_FLIP$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  (( l_eg < l_fn && l_fn < l_dr && l_dr < l_rr && l_rr < l_ms )) \
    && pass "B2: first migration enforces egress < old-Master fence < old-Master drain < start remote-relay@A < master flip" \
    || fail "B2: first migration ordering violated (eg=$l_eg fn=$l_fn dr=$l_dr rr=$l_rr ms=$l_ms)"
else
  fail "B2: first migration failed"
fi

# B2a-abort: First migration Master failure (e.g. standby boot fail at [1/5] or idle gate fail)
# MUST drain (releaseIdleLanes=true) + stop newly-started relay, remove active.sock/state.json,
# reopen old Master remote-v4-drain, AND unfence old Master!
ln -sfn "$TMP/rel-rr" "$MASTER_LIVE_LINK"
printf 'inactive\n' >"$RR_STATE_DIR/A"; printf 'inactive\n' >"$RR_STATE_DIR/B"
rm -f -- "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$V5_REMOTE_RELAY_STATE_FILE"
: >"$TMP/rr.trace"
selfhost_master_restart_or_flip() { printf 'MASTER_FLIP_FAIL\n' >>"$TMP/rr.trace"; return 1; }
rc=0; selfhost_flip_egress_relay_and_master || rc=$?
selfhost_master_restart_or_flip() { printf 'MASTER_FLIP\n' >>"$TMP/rr.trace"; return 0; }
assert_eq "B2a-abort: first migration Master failure returns 1" "1" "$rc"
l_dr_ab="$(grep -n '^DRAIN_BLOCK:A:{"releaseIdleLanes":true,"keepClosedForRestart":true}$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
l_st_ab="$(grep -n '^SYS:stop openclaude-v5-selfhost-remote-relay@A\.service$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
l_re_ab="$(grep -n '^OLD_MASTER_REOPEN$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
l_uf_ab="$(grep -n '^PRIV:A:POST:/internal/v5/cutover-fence$' "$TMP/rr.trace" | tail -n1 | cut -d: -f1)"
fc_ab="$(grep -c '^PRIV:A:POST:/internal/v5/cutover-fence$' "$TMP/rr.trace" || echo 0)"
(( fc_ab >= 2 && l_dr_ab > 0 && l_dr_ab < l_st_ab && l_st_ab < l_re_ab && l_re_ab < l_uf_ab )) \
  && [[ ! -e "$V5_REMOTE_RELAY_ACTIVE_SOCK" && ! -e "$V5_REMOTE_RELAY_STATE_FILE" ]] \
  && pass "B2a-abort: drains+stops orphan relay BEFORE reopening & unfencing legacy Master" \
  || fail "B2a-abort: cleanup ordering or artifact removal failed (fc=$fc_ab dr=$l_dr_ab st=$l_st_ab re=$l_re_ab uf=$l_uf_ab)"

# B2a-orphan: Even if a stale relay@B was left running while live Master still reports remoteRelayExternal=false,
# MUST still enter Case 2 (fence+drain old Master BEFORE flipping relay)!
ln -sfn "$TMP/rel-rr" "$MASTER_LIVE_LINK"
printf 'inactive\n' >"$RR_STATE_DIR/A"; printf 'active\n' >"$RR_STATE_DIR/B"
remote_relay_atomic_switch_symlink B
remote_relay_write_state_atomic B "rr-B-inst"
: >"$TMP/rr.trace"
if selfhost_flip_egress_relay_and_master; then
  l_fn2="$(grep -n '^PRIV:A:POST:/internal/v5/cutover-fence$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  l_dr2="$(grep -n '^OLD_MASTER_DRAIN:' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  l_rr2="$(grep -n '^SYS:start openclaude-v5-selfhost-remote-relay@A\.service$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  (( l_fn2 > 0 && l_fn2 < l_dr2 && l_dr2 < l_rr2 )) \
    && pass "B2a-orphan: stale active relay with in-process Master still fences+drains old Master first" \
    || fail "B2a-orphan: skipped old Master fence+drain (fn=$l_fn2 dr=$l_dr2 rr=$l_rr2)"
else
  fail "B2a-orphan: failed unexpectedly"
fi

# B2-auditor-2: Readiness timeout/503/invalid JSON -> mode=unknown -> MUST fail closed (rc=1)
# WITHOUT stopping active external relay or removing active.sock / state.json!
ln -sfn "$TMP/rel-rr" "$MASTER_LIVE_LINK"
printf 'active\n' >"$RR_STATE_DIR/A"; printf 'inactive\n' >"$RR_STATE_DIR/B"
remote_relay_atomic_switch_symlink A
remote_relay_write_state_atomic A "rr-A-inst"
: >"$TMP/rr.trace"
mock_priv_unknown() { printf 'PRIV:%s:%s:%s\n' "$1" "$2" "$3" >>"$TMP/rr.trace"; printf '000\n'; }
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv_unknown
rc=0; selfhost_flip_egress_relay_and_master || rc=$?
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv_b2
assert_eq "B2-auditor-2: unknown readiness mode returns 1 fail-closed" "1" "$rc"
! grep -q '^SYS:stop ' "$TMP/rr.trace" \
  && ! grep -q '^PRIV:A:POST:/internal/v5/cutover-fence$' "$TMP/rr.trace" \
  && [[ -L "$V5_REMOTE_RELAY_ACTIVE_SOCK" && -f "$V5_REMOTE_RELAY_STATE_FILE" ]] \
  && pass "B2-auditor-2: unknown readiness preserves active external relay, symlink, and state" \
  || fail "B2-auditor-2: unknown readiness mutated active relay or fenced old Master"

# B2-auditor-3a: First migration preheat failure + /reopen returns error -> MUST return 79,
# persist recovery lock, and NEVER clear cutover-fence!
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"
ln -sfn "$TMP/rel-rr" "$MASTER_LIVE_LINK"
printf 'inactive\n' >"$RR_STATE_DIR/A"; printf 'inactive\n' >"$RR_STATE_DIR/B"
rm -f -- "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$V5_REMOTE_RELAY_STATE_FILE"
: >"$TMP/rr.trace"
selfhost_master_restart_or_flip() { printf 'MASTER_PREHEAT_FAIL\n' >>"$TMP/rr.trace"; return 1; }
remote_v4_cutover_reopen() { printf 'OLD_MASTER_REOPEN_FAIL\n' >>"$TMP/rr.trace"; return 1; }
rc=0; selfhost_flip_egress_relay_and_master || rc=$?
selfhost_master_restart_or_flip() { printf 'MASTER_FLIP\n' >>"$TMP/rr.trace"; return 0; }
remote_v4_cutover_reopen() { printf 'OLD_MASTER_REOPEN\n' >>"$TMP/rr.trace"; return 0; }
assert_eq "B2-auditor-3a: failed /reopen after preheat abort returns 79" "79" "$rc"
fc_reopen_fail="$(grep -c '^PRIV:A:POST:/internal/v5/cutover-fence$' "$TMP/rr.trace" || echo 0)"
[[ "$fc_reopen_fail" == "1" && -f "$V5_DUAL_SLOT_RECOVERY_LOCK" ]] \
  && pass "B2-auditor-3a: failed /reopen keeps old Master fenced and persists recovery lock" \
  || fail "B2-auditor-3a: unfenced old Master despite failed /reopen (fence_calls=$fc_reopen_fail)"
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"

# B2-auditor-3b: Real remote_v4_cutover_reopen in v5-selfhost-master-release-lib.sh MUST propagate
# non-zero exit from drain-remote-v4.sh and preserve REMOTE_V4_CUTOVER_DRAINED=1 on failure.
if bash -c '
  set -Eeuo pipefail
  TMPD="$1"; ROOTD="$2"
  mkdir -p "$TMPD/fake-scripts/agent-remote"
  cat >"$TMPD/fake-scripts/agent-remote/drain-remote-v4.sh" <<EOF
#!/usr/bin/env bash
exit 1
EOF
  chmod +x "$TMPD/fake-scripts/agent-remote/drain-remote-v4.sh"
  python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])" "$TMPD/drain.sock"
  SCRIPT_DIR="$TMPD/fake-scripts"
  DRY=0
  OC_REMOTE_V4_DRAIN_SOCKET="$TMPD/drain.sock"
  cutover_clog() { :; }
  source "$ROOTD/scripts/v5-selfhost-master-release-lib.sh"
  REMOTE_V4_CUTOVER_DRAINED=1
  rc=0; remote_v4_cutover_reopen || rc=$?
  [[ "$rc" -ne 0 && "$REMOTE_V4_CUTOVER_DRAINED" == "1" ]]
' _ "$TMP" "$ROOT"; then
  pass "B2-auditor-3b: real remote_v4_cutover_reopen propagates error and keeps REMOTE_V4_CUTOVER_DRAINED=1"
else
  fail "B2-auditor-3b: real remote_v4_cutover_reopen swallowed failure or cleared drained flag"
fi

# B2-auditor-1a/1b/1c: REAL inner selfhost_master_dual_slot_flip + REAL outer selfhost_flip_egress_relay_and_master!
# Verifies external relay drain+stop ALWAYS precedes old Master reopen+unfence across BOTH [3/5] idle gate
# failure AND [4/5] post-CAS verified rollback, and relay drain failure aborts rc=79 WITHOUT reopening old Master!
if bash -c '
  set -Eeuo pipefail
  TMPD="$1"; ROOTD="$2"
  source "$ROOTD/scripts/v5-selfhost-dual-slot-lib.sh"
  source "$ROOTD/scripts/v5-selfhost-remote-relay-lib.sh"
  export OC_SELFHOST_DUAL_SLOT_ACTIVE=1
  export OC_SELFHOST_STANDBY_TIMEOUT_SEC=1 OC_SELFHOST_STANDBY_POLL_SEC=0
  export OC_SELFHOST_IDLE_WAIT_TIMEOUT_SEC=1 OC_SELFHOST_IDLE_WAIT_POLL_SEC=0
  export MASTER_LIVE_LINK="$TMPD/e2e-live"
  export V5_SLOT_LINK_PREFIX="$TMPD/e2e-slot"
  export V5_REMOTE_RELAY_RUN_DIR="$TMPD/e2e-run"
  export V5_REMOTE_RELAY_ACTIVE_SOCK="$TMPD/e2e-run/remote-relay-active.sock"
  export V5_REMOTE_RELAY_STATE_FILE="$TMPD/e2e-rr-state.json"
  export V5_DUAL_SLOT_RECOVERY_LOCK="$TMPD/e2e-recovery.lock"
  mkdir -p "$TMPD/e2e-rel-old" "$TMPD/e2e-rel-new/deploy/v5-selfhost" "$TMPD/e2e-rel-new/scripts" "$TMPD/e2e-run" "$TMPD/e2e-sys"
  : >"$TMPD/e2e-rel-new/deploy/v5-selfhost/openclaude-v5-selfhost-remote-relay@.service"
  : >"$TMPD/e2e-rel-new/scripts/v5-selfhost-frontdoor.mjs"
  ln -sfn "$TMPD/e2e-rel-old" "$V5_SLOT_LINK_PREFIX-A"
  ln -sfn "$TMPD/e2e-rel-new" "$MASTER_LIVE_LINK"
  TRACE="$TMPD/e2e.trace"
  FAIL_RELAY_DRAIN=0
  FAIL_IDLE_GATE=1
  FAIL_LEADER_B=0

  egress_slot_flip() { echo "EGRESS_FLIP" >>"$TRACE"; return 0; }
  systemctl() {
    local sub="$1" unit="${2:-}"
    echo "SYS:$sub $unit" >>"$TRACE"
    case "$unit" in
      openclaude-v5-selfhost-remote-relay@A.service)
        case "$sub" in
          start) echo active >"$TMPD/e2e-sys/rrA"; : >"$V5_REMOTE_RELAY_RUN_DIR/remote-relay-A.sock" ;;
          stop) echo inactive >"$TMPD/e2e-sys/rrA" ;;
          enable) echo enabled >"$TMPD/e2e-sys/enA" ;;
          disable) echo disabled >"$TMPD/e2e-sys/enA" ;;
          is-enabled) [[ -f "$TMPD/e2e-sys/enA" ]] && cat "$TMPD/e2e-sys/enA" || echo disabled ;;
          is-active) [[ -f "$TMPD/e2e-sys/rrA" ]] && cat "$TMPD/e2e-sys/rrA" || echo inactive; [[ "$(cat "$TMPD/e2e-sys/rrA" 2>/dev/null || echo inactive)" == active ]] ;;
          *) return 0 ;;
        esac ;;
      openclaude-v5-selfhost-remote-relay@B.service)
        case "$sub" in
          is-active) echo inactive; return 3 ;;
          *) return 0 ;;
        esac ;;
      *) return 0 ;;
    esac
  }
  mock_rr_http() {
    local sock="$1" method="$2" path="$3" body="${4:-}"
    if [[ "$path" == "/healthz" ]]; then
      printf "200\n{\"ok\":true,\"role\":\"remote-relay\",\"slot\":\"A\",\"instanceId\":\"rr-e2e-A\",\"runtimeState\":\"ready\",\"remoteRuntimeReady\":true,\"accepting\":true}\n"
      return 0
    fi
    if [[ "$path" == "/drain" ]]; then
      echo "RELAY_DRAIN:$body" >>"$TRACE"
      if (( FAIL_RELAY_DRAIN == 1 )); then
        printf "500\n{\"ok\":false,\"error\":\"ACTIVE_TURN\"}\n"
        return 0
      fi
      printf "200\n{\"ok\":true,\"drained\":true}\n"
      return 0
    fi
    printf "200\n{\"ok\":true}\n"
  }
  export OC_SELFHOST_REMOTE_RELAY_HTTP_CMD=mock_rr_http
  selfhost_frontdoor_current_slot() { cat "$TMPD/e2e-fd"; }
  selfhost_frontdoor_switch_verified() { echo "$1" >"$TMPD/e2e-fd"; echo "FD_SWITCH:$1" >>"$TRACE"; SELFHOST_LAST_FRONTDOOR_SLOT="$1"; return 0; }
  selfhost_deploy_state_read_lock_version() { echo 10; }
  selfhost_deploy_state_cas_switch() { echo "DS_SWITCH:$2" >>"$TRACE"; echo 11; }
  selfhost_deploy_state_cas_revert() { echo "DS_REVERT:$2" >>"$TRACE"; echo 12; }
  selfhost_wait_slot_standby_ready() { echo "STANDBY_OK:$1" >>"$TRACE"; return 0; }
  selfhost_wait_slot_leader_vip() {
    if [[ "$1" == "B" && "$FAIL_LEADER_B" == "1" ]]; then echo "LEADER_FAIL:B" >>"$TRACE"; return 1; fi
    echo "LEADER_OK:$1" >>"$TRACE"; return 0
  }
  selfhost_healthz_18790_ok() { return 0; }
  selfhost_query_tiered_idle_pg() {
    if (( FAIL_IDLE_GATE == 1 )); then echo "IDLE_GATE_FAIL" >>"$TRACE"; return 1; fi
    printf "0|0|0|0|0||0|0|\n"
  }
  remote_v4_cutover_drain() { echo "OLD_MASTER_DRAIN" >>"$TRACE"; return 0; }
  remote_v4_cutover_reopen() { echo "OLD_MASTER_REOPEN" >>"$TRACE"; return 0; }
  mock_e2e_priv() {
    local slot="$1" method="$2" path="$3" body="${4:-}"
    if [[ "$path" == "/internal/v5/cutover-fence" ]]; then
      local en; en="$(printf "%s" "$body" | jq -r ".enabled")"
      echo "FENCE:$slot:$en" >>"$TRACE"
      echo "$en" >"$TMPD/e2e-fence-$slot"
      printf "200\n{\"ok\":true,\"slot\":\"%s\",\"fencing\":%s}\n" "$slot" "$en"; return 0
    fi
    local fn; fn="$(cat "$TMPD/e2e-fence-$slot" 2>/dev/null || echo false)"
    if [[ "$slot" == "A" ]]; then
      printf "200\n{\"ok\":true,\"slot\":\"A\",\"role\":\"leader\",\"vipOwner\":true,\"fencing\":%s,\"containerLinkEnabled\":true,\"nonSurvivableInFlight\":0}\n" "$fn"
    else
      printf "200\n{\"ok\":true,\"slot\":\"B\",\"role\":\"standby\",\"vipOwner\":false,\"fencing\":%s,\"containerLinkEnabled\":true,\"nonSurvivableInFlight\":0,\"remoteRelayExternal\":true,\"remoteRelayHealthy\":true,\"remoteRelayInstanceId\":\"rr-e2e-A\"}\n" "$fn"
    fi
  }
  export OC_SELFHOST_PRIV_CONTROL_CMD=mock_e2e_priv

  # 1a: [3/5] idle gate fails -> relay drained & stopped STRICTLY BEFORE old Master reopen & unfence!
  echo A >"$TMPD/e2e-fd"; echo false >"$TMPD/e2e-fence-A"; echo inactive >"$TMPD/e2e-sys/rrA"
  rm -f -- "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$V5_REMOTE_RELAY_STATE_FILE" "$V5_DUAL_SLOT_RECOVERY_LOCK"
  : >"$TRACE"; FAIL_IDLE_GATE=1; FAIL_RELAY_DRAIN=0; FAIL_LEADER_B=0
  rc=0; selfhost_flip_egress_relay_and_master || rc=$?
  [[ "$rc" == "1" ]]
  l_ig="$(grep -n "^IDLE_GATE_FAIL$" "$TRACE" | head -n1 | cut -d: -f1)"
  l_rd="$(grep -n "^RELAY_DRAIN:{\"releaseIdleLanes\":true,\"keepClosedForRestart\":true}$" "$TRACE" | head -n1 | cut -d: -f1)"
  l_rs="$(grep -n "^SYS:stop openclaude-v5-selfhost-remote-relay@A\.service$" "$TRACE" | head -n1 | cut -d: -f1)"
  l_ro="$(grep -n "^OLD_MASTER_REOPEN$" "$TRACE" | head -n1 | cut -d: -f1)"
  l_uf="$(grep -n "^FENCE:A:false$" "$TRACE" | head -n1 | cut -d: -f1)"
  l_ms="$(grep -n "^SYS:stop openclaude-v5-selfhost@B\.service$" "$TRACE" | head -n1 | cut -d: -f1)"
  (( l_ig > 0 && l_ig < l_rd && l_rd < l_rs && l_rs < l_ro && l_ro < l_uf && l_uf < l_ms ))
  [[ ! -e "$V5_REMOTE_RELAY_ACTIVE_SOCK" && ! -e "$V5_REMOTE_RELAY_STATE_FILE" ]]

  # 1b: [3/5] idle gate fails + relay drain fails -> rc=79, recovery lock, OLD MASTER NEVER REOPENED/UNFENCED!
  echo A >"$TMPD/e2e-fd"; echo false >"$TMPD/e2e-fence-A"; echo inactive >"$TMPD/e2e-sys/rrA"
  rm -f -- "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$V5_REMOTE_RELAY_STATE_FILE" "$V5_DUAL_SLOT_RECOVERY_LOCK"
  : >"$TRACE"; FAIL_IDLE_GATE=1; FAIL_RELAY_DRAIN=1; FAIL_LEADER_B=0
  rc=0; selfhost_flip_egress_relay_and_master || rc=$?
  [[ "$rc" == "79" && -f "$V5_DUAL_SLOT_RECOVERY_LOCK" ]]
  ! grep -q "^OLD_MASTER_REOPEN$" "$TRACE"
  ! grep -q "^FENCE:A:false$" "$TRACE"

  # 1c: [4/5] post-CAS verified rollback -> reverts fd+ds, THEN drains+stops relay BEFORE reopen+unfence!
  echo A >"$TMPD/e2e-fd"; echo false >"$TMPD/e2e-fence-A"; echo inactive >"$TMPD/e2e-sys/rrA"
  rm -f -- "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$V5_REMOTE_RELAY_STATE_FILE" "$V5_DUAL_SLOT_RECOVERY_LOCK"
  : >"$TRACE"; FAIL_IDLE_GATE=0; FAIL_RELAY_DRAIN=0; FAIL_LEADER_B=1
  rc=0; selfhost_flip_egress_relay_and_master || rc=$?
  [[ "$rc" == "1" ]]
  l_rv="$(grep -n "^DS_REVERT:A$" "$TRACE" | head -n1 | cut -d: -f1)"
  l_rd3="$(grep -n "^RELAY_DRAIN:{\"releaseIdleLanes\":true,\"keepClosedForRestart\":true}$" "$TRACE" | head -n1 | cut -d: -f1)"
  l_rs3="$(grep -n "^SYS:stop openclaude-v5-selfhost-remote-relay@A\.service$" "$TRACE" | head -n1 | cut -d: -f1)"
  l_ro3="$(grep -n "^OLD_MASTER_REOPEN$" "$TRACE" | head -n1 | cut -d: -f1)"
  l_uf3="$(grep -n "^FENCE:A:false$" "$TRACE" | head -n1 | cut -d: -f1)"
  (( l_rv > 0 && l_rv < l_rd3 && l_rd3 < l_rs3 && l_rs3 < l_ro3 && l_ro3 < l_uf3 ))
' _ "$TMP" "$ROOT"; then
  pass "B2-auditor-1a/1b/1c: real inner+outer flow enforces relay drain+stop BEFORE old Master reopen+unfence (both [3/5] abort & [4/5] rollback, fail-closed rc=79 on relay drain error)"
else
  fail "B2-auditor-1a/1b/1c: real inner+outer first-migration abort/rollback ordering violated"
fi

# B2-R2-1/2/3: Verify all 3 R2 audit findings closed:
#   R2-1: unknown/empty systemctl is-active or undeletable state.json returns 79 (never false 0)
#   R2-2: candidate ready timeout + stop failure returns 79 and keeps old Master fenced
#   R2-3: drain lost-ACK/timeout sets REMOTE_V4_CUTOVER_DRAINED=1 so reopen on missing/75 socket fails closed
if bash -c '
  set -Eeuo pipefail
  TMPD="$1"; ROOTD="$2"
  source "$ROOTD/scripts/v5-selfhost-dual-slot-lib.sh"
  source "$ROOTD/scripts/v5-selfhost-remote-relay-lib.sh"
  export V5_REMOTE_RELAY_RUN_DIR="$TMPD/r2-run"
  export V5_REMOTE_RELAY_ACTIVE_SOCK="$TMPD/r2-run/remote-relay-active.sock"
  export V5_REMOTE_RELAY_STATE_FILE="$TMPD/r2-ro/state.json"
  export V5_DUAL_SLOT_RECOVERY_LOCK="$TMPD/r2-recovery.lock"
  export OC_REMOTE_RELAY_READY_TIMEOUT_SEC=1 OC_REMOTE_RELAY_READY_POLL_SEC=0.05
  export MASTER_LIVE_LINK="$TMPD/r2-live"
  mkdir -p "$TMPD/r2-run" "$TMPD/r2-ro" "$TMPD/r2-rel/deploy/v5-selfhost"
  : >"$TMPD/r2-rel/deploy/v5-selfhost/openclaude-v5-selfhost-remote-relay@.service"
  ln -sfn "$TMPD/r2-rel" "$MASTER_LIVE_LINK"

  # R2-1a: empty systemctl is-active (D-Bus failure) + stop cannot verify inactive -> rc=79!
  systemctl() {
    case "$1" in
      is-active) return 1 ;; # prints empty stdout
      stop) return 0 ;;
      *) return 0 ;;
    esac
  }
  rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"
  rc=0; remote_relay_stop_all_for_legacy_rollback "test-dbus-fail" || rc=$?
  [[ "$rc" == "79" && -f "$V5_DUAL_SLOT_RECOVERY_LOCK" ]]

  # R2-1b: slots inactive but state path cannot be removed by rm -f (e.g. non-empty dir, even as root) -> rc=79!
  systemctl() {
    case "$1" in
      is-active) echo inactive; return 3 ;;
      is-enabled) echo disabled; return 1 ;;
      *) return 0 ;;
    esac
  }
  mkdir -p "$V5_REMOTE_RELAY_STATE_FILE"
  rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"
  rc=0; remote_relay_stop_all_for_legacy_rollback "test-rm-fail" || rc=$?
  rmdir "$V5_REMOTE_RELAY_STATE_FILE"
  [[ "$rc" == "79" && -f "$V5_DUAL_SLOT_RECOVERY_LOCK" ]]

  # R2-2: first migration candidate relay ready timeout + stop failure -> rc=79 & old Master NOT unfenced!
  rm -f -- "$V5_REMOTE_RELAY_STATE_FILE" "$V5_REMOTE_RELAY_ACTIVE_SOCK" "$V5_DUAL_SLOT_RECOVERY_LOCK"
  export OC_SELFHOST_DUAL_SLOT_ACTIVE=1
  egress_slot_flip() { return 0; }
  selfhost_master_current_slot() { printf "A"; }
  remote_v4_cutover_drain() { return 0; }
  remote_v4_cutover_reopen() { echo "UNEXPECTED_REOPEN" >>"$TMPD/r2.trace"; return 0; }
  mock_r2_priv() {
    if [[ "$3" == "/internal/v5/cutover-fence" ]]; then
      echo "FENCE:$4" >>"$TMPD/r2.trace"
      printf "200\n{\"ok\":true,\"slot\":\"A\",\"fencing\":true}\n"; return 0
    fi
    printf "200\n{\"ok\":true,\"slot\":\"A\",\"remoteRelayExternal\":false}\n"
  }
  export OC_SELFHOST_PRIV_CONTROL_CMD=mock_r2_priv
  mock_r2_http() { printf "503\n{\"ok\":false,\"error\":\"BOOT_FAIL\"}\n"; }
  export OC_SELFHOST_REMOTE_RELAY_HTTP_CMD=mock_r2_http
  R2_STATE="$TMPD/r2-a-st"; echo inactive >"$R2_STATE"
  systemctl() {
    case "$1" in
      is-active) [[ "$2" == *"@A.service" ]] && cat "$R2_STATE" || echo inactive; [[ "$2" == *"@A.service" && "$(cat "$R2_STATE")" == active ]] ;;
      start) echo active >"$R2_STATE"; : >"$V5_REMOTE_RELAY_RUN_DIR/remote-relay-A.sock"; return 0 ;;
      stop) return 1 ;; # simulate stop failure!
      *) return 0 ;;
    esac
  }
  : >"$TMPD/r2.trace"
  rc=0; selfhost_flip_egress_relay_and_master || rc=$?
  [[ "$rc" == "79" && -f "$V5_DUAL_SLOT_RECOVERY_LOCK" ]]
  ! grep -q "UNEXPECTED_REOPEN" "$TMPD/r2.trace"
  ! grep -q "false" "$TMPD/r2.trace"

  # R2-3: real remote_v4_cutover_drain lost-ACK/timeout (rc=1) sets REMOTE_V4_CUTOVER_DRAINED=1,
  # so subsequent remote_v4_cutover_reopen encountering rc=75 / missing socket FAILS (never false 0)!
  mkdir -p "$TMPD/r2-scripts/agent-remote"
  cat >"$TMPD/r2-scripts/agent-remote/drain-remote-v4.sh" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == "--drain" ]]; then exit 1; fi
exit 75
EOF
  chmod +x "$TMPD/r2-scripts/agent-remote/drain-remote-v4.sh"
  python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])" "$TMPD/r2-drain.sock"
  SCRIPT_DIR="$TMPD/r2-scripts"; DRY=0; ALLOW_INFLIGHT=0; OC_REMOTE_V4_DRAIN_SOCKET="$TMPD/r2-drain.sock"
  cutover_clog() { :; }
  source "$ROOTD/scripts/v5-selfhost-master-release-lib.sh"
  REMOTE_V4_CUTOVER_DRAINED=0
  d_rc=0; remote_v4_cutover_drain || d_rc=$?
  [[ "$d_rc" -ne 0 && "$REMOTE_V4_CUTOVER_DRAINED" == "1" ]]
  r_rc=0; remote_v4_cutover_reopen || r_rc=$?
  [[ "$r_rc" -ne 0 && "$REMOTE_V4_CUTOVER_DRAINED" == "1" ]]
' _ "$TMP" "$ROOT"; then
  pass "B2-R2-1/2/3: empty is-active/cleanup fail -> rc=79, candidate stop fail -> rc=79 keeps fence, drain lost-ACK requires verified reopen"
else
  fail "B2-R2-1/2/3: R2 fail-closed regression check failed"
fi

# B2b: Reverse rollback -> MUST drain active external relay (with releaseIdleLanes=true) BEFORE flipping Master, THEN stop relay & remove state/symlink!
ln -sfn "$TMP/rel-old-no-rr" "$MASTER_LIVE_LINK"
printf 'active\n' >"$RR_STATE_DIR/A"; printf 'inactive\n' >"$RR_STATE_DIR/B"
remote_relay_atomic_switch_symlink A
remote_relay_write_state_atomic A "rr-A-inst"
: >"$TMP/rr.trace"
if selfhost_flip_egress_relay_and_master; then
  l_dr="$(grep -n '^DRAIN_BLOCK:A:{"releaseIdleLanes":true,"keepClosedForRestart":true}$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  l_ms="$(grep -n '^MASTER_FLIP$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  l_st="$(grep -n '^SYS:stop openclaude-v5-selfhost-remote-relay@A\.service$' "$TMP/rr.trace" | head -n1 | cut -d: -f1)"
  (( l_dr > 0 && l_dr < l_ms && l_ms < l_st )) \
    && [[ ! -e "$V5_REMOTE_RELAY_ACTIVE_SOCK" && ! -e "$V5_REMOTE_RELAY_STATE_FILE" ]] \
    && pass "B2: reverse rollback drains external relay (releaseIdleLanes=true) BEFORE Master flip and stops/cleans relay AFTER Master flip" \
    || fail "B2: reverse rollback ordering or cleanup violated (dr=$l_dr ms=$l_ms st=$l_st)"
else
  fail "B2: reverse rollback failed"
fi

# B2b-fail: Reverse rollback Master flip failure MUST reopen external relay & verify!
printf 'active\n' >"$RR_STATE_DIR/A"; printf 'inactive\n' >"$RR_STATE_DIR/B"
remote_relay_atomic_switch_symlink A
remote_relay_write_state_atomic A "rr-A-inst"
: >"$TMP/rr.trace"
selfhost_master_restart_or_flip() { printf 'MASTER_FLIP_FAIL\n' >>"$TMP/rr.trace"; return 1; }
rc=0; selfhost_flip_egress_relay_and_master || rc=$?
selfhost_master_restart_or_flip() { printf 'MASTER_FLIP\n' >>"$TMP/rr.trace"; return 0; }
assert_eq "B2: reverse rollback Master failure returns 1" "1" "$rc"
grep -q '^REOPEN:A$' "$TMP/rr.trace" \
  && [[ -L "$V5_REMOTE_RELAY_ACTIVE_SOCK" ]] \
  && pass "B2: reverse rollback Master failure reopens drained external relay and keeps active.sock" \
  || fail "B2: reverse rollback Master failure failed to reopen external relay"

# B2c: Reverse rollback systemctl stop failure MUST return 79 (never swallowed!)
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"
printf 'active\n' >"$RR_STATE_DIR/A"; printf 'inactive\n' >"$RR_STATE_DIR/B"
remote_relay_atomic_switch_symlink A
remote_relay_write_state_atomic A "rr-A-inst"
MOCK_SYS_FAIL_STOP_UNIT="openclaude-v5-selfhost-remote-relay@A.service"
rc=0; selfhost_flip_egress_relay_and_master || rc=$?
MOCK_SYS_FAIL_STOP_UNIT=""
assert_eq "B2: reverse rollback systemctl stop failure returns 79 (never swallowed)" "79" "$rc"
[[ -f "$V5_DUAL_SLOT_RECOVERY_LOCK" ]] \
  && pass "B2: reverse rollback stop failure persisted recovery lock" \
  || fail "B2: reverse rollback stop failure missed recovery lock"
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"

# ── 7. B5: cc5_activation_extra_apply / release_policy_flip_live dual-slot vs legacy ──
if bash -c '
  set -Eeuo pipefail
  TMPD="$1"; ROOTD="$2"
  SCRIPT_DIR="$ROOTD/scripts"
  source "$ROOTD/scripts/lib/v5-selfhost-release-policy.sh"
  source "$ROOTD/scripts/lib/v5-selfhost-cc5-activation.sh"
  RELEASE_POLICY_MODE=user-impact-only
  MASTER_LIVE_LINK="$TMPD/b5-live"
  mkdir -p "$TMPD/b5-rel"
  TRACE="$TMPD/b5.trace"
  release_policy_require_owner() { return 0; }
  release_policy_rejected_phase() { return 0; }
  atomic_flip_live_symlink() { echo "FLIP:$1" >>"$TRACE"; }
  oc_hotcfg_fsync_path() { return 0; }
  release_policy_drain_reader() { return 0; }
  release_policy_assert_no_service_jobs() { return 0; }
  cc5_activation_apply() { echo "CC5_APPLY" >>"$TRACE"; }
  remote_v4_cutover_drain() { echo "LEGACY_DRAIN" >>"$TRACE"; }
  cutover_wait_for_user_idle() { echo "LEGACY_IDLE" >>"$TRACE"; }

  # Case 1: Dual-slot active -> MUST skip legacy blind drain/idle in release_policy_flip_live
  : >"$TRACE"
  selfhost_master_dual_slot_active() { return 0; }
  cc5_activation_extra_apply "$TMPD/b5-rel" "$TMPD/b5-prev"
  grep -q "^FLIP:" "$TRACE"
  grep -q "^CC5_APPLY$" "$TRACE"
  ! grep -q "LEGACY_DRAIN" "$TRACE"
  ! grep -q "LEGACY_IDLE" "$TRACE"

  # Case 2: Legacy single-slot -> MUST still run legacy drain + idle
  : >"$TRACE"
  selfhost_master_dual_slot_active() { return 1; }
  cc5_activation_extra_apply "$TMPD/b5-rel" "$TMPD/b5-prev"
  grep -q "^LEGACY_DRAIN$" "$TRACE"
  grep -q "^LEGACY_IDLE$" "$TRACE"
' _ "$TMP" "$ROOT"; then
  pass "B5: cc5_activation_extra_apply / release_policy_flip_live skips legacy drain in dual-slot mode and preserves it in legacy single-slot mode"
else
  fail "B5: release_policy_flip_live dual-slot / legacy gating failed"
fi

# ── 8. B7 & Master dual-slot flip + tiered cutover gate red/green matrix ──
export PG_DB="openclaude_v5_selfhost"
export DRY=0
export ALLOW_INFLIGHT=0
export OC_SELFHOST_DUAL_SLOT_ACTIVE=1
export OC_SELFHOST_IDLE_WAIT_TIMEOUT_SEC=1
export OC_SELFHOST_IDLE_WAIT_POLL_SEC=0
export OC_SELFHOST_OLD_SLOT_DRAIN_TIMEOUT_SEC=1
export OC_SELFHOST_DRAIN_POLL_SEC=0.05
export V5_SLOT_LINK_PREFIX="$TMP/mslot"
mkdir -p "$TMP/mrel-old/scripts" "$TMP/mrel-new/scripts"
touch "$TMP/mrel-old/scripts/v5-selfhost-frontdoor.mjs" "$TMP/mrel-new/scripts/v5-selfhost-frontdoor.mjs"
ln -sfn "$TMP/mrel-old" "$TMP/mslot-A"

cutover_clog() { printf '%s\n' "$*" >>"$TMP/cutover.log"; }
mock_docker() {
  case "$1" in
    cid_running_*) printf 'true\n' ;;
    cid_stopped_*) printf 'false\n' ;;
    *) return 1 ;;
  esac
}
export OC_SELFHOST_DOCKER_INSPECT_CMD=mock_docker

printf 'A\n' >"$TMP/fd-slot"
mock_fd() {
  local method="$1" path="$2" body="${3:-}" cur next
  cur="$(cat "$TMP/fd-slot")"
  if [[ "$method" == "GET" && "$path" == "/status" ]]; then printf '{"ok":true,"slot":"%s"}\n' "$cur"; return 0; fi
  if [[ "$method" == "POST" && "$path" == "/switch" ]]; then
    next="$(printf '%s' "$body" | jq -r '.slot')"; printf '%s\n' "$next" >"$TMP/fd-slot"
    printf '{"ok":true,"slot":"%s"}\n' "$next"; return 0
  fi
  return 1
}
export OC_SELFHOST_FRONTDOOR_HTTP_CMD=mock_fd

printf 'A|A|A|stable|10|%s|1|\n' "$TMP/mrel-old" >"$TMP/ds-row"
selfhost_deploy_state_read_override() { cat "$TMP/ds-row"; }
selfhost_psql_rw_override() {
  local sql row a dl dc ph lv ar gen op next_lv new_slot new_ph
  sql="$(cat)"; row="$(cat "$TMP/ds-row")"
  IFS='|' read -r a dl dc ph lv ar gen op <<<"$row"
  next_lv=$((lv + 1))
  new_slot="$(printf '%s' "$sql" | sed -nE "s/.*active_slot *= *'([AB])'.*/\1/p" | head -n 1)"
  new_ph="$(printf '%s' "$sql" | sed -nE "s/.*phase *= *'([a-z]+)'.*/\1/p" | head -n 1)"
  printf '%s|%s|%s|%s|%s|%s|%s|\n' "${new_slot:-$a}" "${new_slot:-$a}" "${new_slot:-$a}" "${new_ph:-$ph}" "$next_lv" "$ar" "$((gen + 1))" >"$TMP/ds-row"
  printf '%s\n' "$next_lv"
}
systemctl() { printf 'MSYS:%s\n' "$*" >>"$TMP/mflip.trace"; return 0; }
selfhost_wait_slot_standby_ready() { return 0; }
selfhost_wait_slot_leader_vip() { return 0; }
mock_hz() { return 0; }
export OC_SELFHOST_HEALTHZ_CMD=mock_hz

remote_v4_cutover_drain() { printf 'CALLED_REMOTE_V4_DRAIN:%s\n' "${OC_REMOTE_V4_DRAIN_SOCKET:-}" >>"$TMP/mflip.trace"; return 0; }
remote_v4_cutover_reopen() { printf 'CALLED_REMOTE_V4_REOPEN:%s\n' "${OC_REMOTE_V4_DRAIN_SOCKET:-}" >>"$TMP/mflip.trace"; return 0; }

MOCK_RELAY_HEALTH_JSON='{"ok":true,"role":"remote-relay","slot":"A","instanceId":"rr-live-1","runtimeState":"ready","remoteRuntimeReady":true,"accepting":true}'
mock_rr_direct() { printf '200\n%s\n' "$MOCK_RELAY_HEALTH_JSON"; }
export OC_SELFHOST_REMOTE_RELAY_HTTP_CMD=mock_rr_direct

MOCK_SLOT_A_READINESS='{"ok":true,"slot":"A","role":"leader","vipOwner":true,"fencing":false,"containerLinkEnabled":true,"nonSurvivableInFlight":0,"remoteRelayExternal":true,"remoteRelayHealthy":true,"remoteRelaySlot":"A","remoteRelayInstanceId":"rr-live-1","remoteRelayActiveCount":1}'
MOCK_SLOT_B_READINESS='{"ok":true,"slot":"B","role":"standby","vipOwner":false,"fencing":false,"containerLinkEnabled":true,"nonSurvivableInFlight":0,"remoteRelayExternal":true,"remoteRelayHealthy":true,"remoteRelaySlot":"A","remoteRelayInstanceId":"rr-live-1","remoteRelayActiveCount":1}'
mock_master_priv() {
  local slot="$1" method="$2" path="$3" body="${4:-}"
  if [[ "$path" == "/internal/v5/cutover-fence" ]]; then
    local en; en="$(printf '%s' "$body" | jq -r '.enabled')"
    printf '200\n{"ok":true,"slot":"%s","fencing":%s}\n' "$slot" "$en"; return 0
  fi
  if [[ "$path" == "/internal/v5/cutover-readiness" ]]; then
    if [[ "$slot" == "A" ]]; then printf '200\n%s\n' "$MOCK_SLOT_A_READINESS"
    else printf '200\n%s\n' "$MOCK_SLOT_B_READINESS"; fi
    return 0
  fi
  printf '200\n{"ok":true,"slot":"%s"}\n' "$slot"
}
export OC_SELFHOST_PRIV_CONTROL_CMD=mock_master_priv
selfhost_query_tiered_idle_pg() { printf '%s\n' "$MOCK_PG_ROW"; }

# B7 AUDITOR COUNTEREXAMPLE: A.CL=true, B.CL=false, matching 3-way relay ID, 1 accepted + 1 v4 binding + 1 v4 inflight, container running -> MUST REFUSE!
MOCK_PG_ROW="0|1|1|0|0|cid_running_1|1|1|cid_running_1,cid_running_1"
MOCK_SLOT_B_READINESS='{"ok":true,"slot":"B","role":"standby","vipOwner":false,"fencing":false,"containerLinkEnabled":false,"nonSurvivableInFlight":0,"remoteRelayExternal":true,"remoteRelayHealthy":true,"remoteRelaySlot":"A","remoteRelayInstanceId":"rr-live-1","remoteRelayActiveCount":1}'
rc=0; selfhost_wait_old_slot_drained A B 1 || rc=$?
assert_eq "B7 (auditor counterexample): A.CL=true + B.CL=false + matching relay ID MUST refuse old-slot drain (rc=1)" "1" "$rc"

# B7 missing new_slot with live survivable turns -> MUST fail closed (rc=1)
rc=0; selfhost_wait_old_slot_drained A "" 1 || rc=$?
assert_eq "B7 (missing new_slot): live survivable turns fail closed (rc=1)" "1" "$rc"

# B7 green: A.CL=true + B.CL=true + matching 3-way relay ID -> PASSES (rc=0)!
MOCK_SLOT_B_READINESS='{"ok":true,"slot":"B","role":"standby","vipOwner":false,"fencing":false,"containerLinkEnabled":true,"nonSurvivableInFlight":0,"remoteRelayExternal":true,"remoteRelayHealthy":true,"remoteRelaySlot":"A","remoteRelayInstanceId":"rr-live-1","remoteRelayActiveCount":1}'
rc=0; selfhost_wait_old_slot_drained A B 1 || rc=$?
assert_eq "B7 (green): A.CL=true + B.CL=true + matching 3-way relay ID passes old-slot drain (rc=0)" "0" "$rc"

# GREEN full flip: skips remote_v4_cutover_drain and flips A->B cleanly
printf 'A\n' >"$TMP/fd-slot"
printf 'A|A|A|stable|10|%s|1|\n' "$TMP/mrel-old" >"$TMP/ds-row"
: >"$TMP/mflip.trace"
rm -f -- "$V5_DUAL_SLOT_RECOVERY_LOCK"
if selfhost_master_dual_slot_flip "$TMP/mrel-new"; then
  ! grep -q 'CALLED_REMOTE_V4_DRAIN' "$TMP/mflip.trace" \
    && assert_eq "GREEN: frontdoor flipped A->B with live v4 turn surviving" "B" "$(cat "$TMP/fd-slot")"
  pass "GREEN: independent remote-relay skipped remote_v4_cutover_drain and passed live v4 cutover"
else
  fail "GREEN: live v4 cutover unexpectedly failed"
fi

# RED 1: Legacy old slot A without remoteRelayExternal -> invokes remote_v4_cutover_drain & blocks
MOCK_SLOT_A_READINESS='{"ok":true,"slot":"A","role":"leader","vipOwner":true,"fencing":false,"containerLinkEnabled":true,"nonSurvivableInFlight":0,"remoteRelayExternal":false,"remoteRelayHealthy":false,"remoteRelaySlot":null,"remoteRelayInstanceId":null,"remoteRelayActiveCount":0}'
printf 'A\n' >"$TMP/fd-slot"
printf 'A|A|A|stable|20|%s|2|\n' "$TMP/mrel-old" >"$TMP/ds-row"
: >"$TMP/mflip.trace"
rc=0; selfhost_master_dual_slot_flip "$TMP/mrel-new" || rc=$?
assert_eq "RED 1 (old slot no remoteRelayExternal): flip blocked (rc=1)" "1" "$rc"
grep -q 'CALLED_REMOTE_V4_DRAIN' "$TMP/mflip.trace" \
  && pass "RED 1: legacy old slot strictly invoked remote_v4_cutover_drain" \
  || fail "RED 1: did not invoke remote_v4_cutover_drain"

# RED 2a/2b: instanceId mismatch & direct probe accepting=false
MOCK_SLOT_A_READINESS='{"ok":true,"slot":"A","role":"leader","vipOwner":true,"fencing":false,"containerLinkEnabled":true,"nonSurvivableInFlight":0,"remoteRelayExternal":true,"remoteRelayHealthy":true,"remoteRelaySlot":"A","remoteRelayInstanceId":"rr-live-1","remoteRelayActiveCount":1}'
MOCK_SLOT_B_READINESS='{"ok":true,"slot":"B","role":"standby","vipOwner":false,"fencing":false,"containerLinkEnabled":true,"nonSurvivableInFlight":0,"remoteRelayExternal":true,"remoteRelayHealthy":true,"remoteRelaySlot":"B","remoteRelayInstanceId":"rr-live-OTHER","remoteRelayActiveCount":0}'
rc=0; selfhost_cutover_wait_for_safe_window --slot=A --candidate-slot=B || rc=$?
assert_eq "RED 2a (instanceId mismatch A vs B): tiered gate strictly blocks" "1" "$rc"

MOCK_SLOT_B_READINESS='{"ok":true,"slot":"B","role":"standby","vipOwner":false,"fencing":false,"containerLinkEnabled":true,"nonSurvivableInFlight":0,"remoteRelayExternal":true,"remoteRelayHealthy":true,"remoteRelaySlot":"A","remoteRelayInstanceId":"rr-live-1","remoteRelayActiveCount":1}'
MOCK_RELAY_HEALTH_JSON='{"ok":true,"role":"remote-relay","slot":"A","instanceId":"rr-live-1","runtimeState":"ready","remoteRuntimeReady":true,"accepting":false}'
rc=0; selfhost_cutover_wait_for_safe_window --slot=A --candidate-slot=B || rc=$?
assert_eq "RED 2b (direct relay probe accepting=false): tiered gate strictly blocks" "1" "$rc"
MOCK_RELAY_HEALTH_JSON='{"ok":true,"role":"remote-relay","slot":"A","instanceId":"rr-live-1","runtimeState":"ready","remoteRuntimeReady":true,"accepting":true}'

# RED 3a/3b/3c: legacy binding / finalizing journal / stopped Docker container
MOCK_PG_ROW="0|1|1|1|0|cid_running_1|0|0|"
rc=0; selfhost_cutover_wait_for_safe_window --slot=A --candidate-slot=B || rc=$?
assert_eq "RED 3a (legacy binding): strictly blocks despite healthy relay" "1" "$rc"

MOCK_PG_ROW="0|1|1|0|1|cid_running_1|1|0|cid_running_1"
rc=0; selfhost_cutover_wait_for_safe_window --slot=A --candidate-slot=B || rc=$?
assert_eq "RED 3b (finalizing journal): strictly blocks despite healthy relay" "1" "$rc"

MOCK_PG_ROW="0|1|1|0|0|cid_running_1|1|1|cid_stopped_1,cid_running_1"
rc=0; selfhost_cutover_wait_for_safe_window --slot=A --candidate-slot=B || rc=$?
assert_eq "RED 3c (stopped Docker container): strictly blocks despite healthy relay" "1" "$rc"

# ── 9. Real PG SQL tightening verification (when local test PG 55432 is reachable) ──
if PGHOST=127.0.0.1 PGPORT=55432 PGUSER=test PGPASSWORD=test PGDATABASE=openclaude_test \
   psql -X -qAt -c 'SELECT 1;' >/dev/null 2>&1; then
  RR_DB="oc_test_rr855_${BASHPID}_${RANDOM}"
  PGHOST=127.0.0.1 PGPORT=55432 PGUSER=test PGPASSWORD=test PGDATABASE=openclaude_test \
    psql -X -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$RR_DB\";"
  rr_sql() {
    PGHOST=127.0.0.1 PGPORT=55432 PGUSER=test PGPASSWORD=test psql -X -v ON_ERROR_STOP=1 -q -d "$RR_DB" -c "$1"
  }
  rr_sql "CREATE TABLE compute_hosts (id uuid PRIMARY KEY, name text NOT NULL);"
  rr_sql "CREATE TABLE agent_containers (id bigint PRIMARY KEY, user_id bigint NOT NULL, host_id bigint, host_uuid uuid, bound_ip inet, port integer, runtime_channel text NOT NULL, runtime_kind text NOT NULL, state text NOT NULL, container_internal_id text, docker_id text);"
  rr_sql "CREATE TABLE turn_dispatches (dispatch_id uuid PRIMARY KEY, user_id bigint NOT NULL, status text NOT NULL, terminal_at timestamptz, agent_container_id bigint, runtime_kind text);"
  rr_sql "CREATE TABLE request_finalize_journal (request_id text PRIMARY KEY, state text NOT NULL, ctx jsonb NOT NULL, dispatch_id uuid);"
  rr_sql "CREATE TABLE remote_agent_bindings (operation_id uuid PRIMARY KEY, uid bigint NOT NULL, container_db_id bigint NOT NULL, docker_id text NOT NULL, driver_id text, remote_protocol_version integer NOT NULL DEFAULT 1, generation bigint NOT NULL DEFAULT 1, state text NOT NULL);"
  rr_sql "INSERT INTO compute_hosts VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','self');"
  rr_sql "INSERT INTO agent_containers VALUES (1,3,NULL,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','172.31.116.99',18789,'v5','docker','active','cid_running_1','cid_running_1');"
  rr_sql "INSERT INTO turn_dispatches VALUES ('11111111-1111-1111-1111-111111111111',3,'accepted',NULL,1,'docker');"
  rr_sql "INSERT INTO remote_agent_bindings VALUES ('22222222-2222-2222-2222-222222222222',3,1,'cid_running_1','claude-code',4,1,'running');"
  rr_sql "INSERT INTO request_finalize_journal VALUES ('req-1','inflight','{\"remoteNativeBillingRecovery\":\"remote-native-v4\",\"remoteDriverV4\":{\"v\":4,\"scope\":{\"operationId\":\"22222222-2222-2222-2222-222222222222\",\"generation\":\"1\"}}}','11111111-1111-1111-1111-111111111111');"

  run_pg_gate() {
    bash -c '
      set -euo pipefail
      source "$1"
      PG_DB="$2"; DRY=0; ALLOW_INFLIGHT=0; export OC_SELFHOST_DUAL_SLOT_ACTIVE=1
      export OC_SELFHOST_IDLE_WAIT_TIMEOUT_SEC=1 OC_SELFHOST_IDLE_WAIT_POLL_SEC=0
      psql_as_postgres() { PGHOST=127.0.0.1 PGPORT=55432 PGUSER=test PGPASSWORD=test psql -X -v ON_ERROR_STOP=1 "$@"; }
      mock_docker() { [[ "$1" == cid_running_* ]] && echo true || echo false; }
      export OC_SELFHOST_DOCKER_INSPECT_CMD=mock_docker
      mock_priv() { printf "200\n{\"ok\":true,\"slot\":\"%s\",\"containerLinkEnabled\":true,\"nonSurvivableInFlight\":0,\"remoteRelayExternal\":true,\"remoteRelayHealthy\":true,\"remoteRelayInstanceId\":\"rr-pg-1\"}\n" "$1"; }
      export OC_SELFHOST_PRIV_CONTROL_CMD=mock_priv
      mock_rr() { printf "200\n{\"ok\":true,\"role\":\"remote-relay\",\"slot\":\"A\",\"instanceId\":\"rr-pg-1\",\"runtimeState\":\"ready\",\"remoteRuntimeReady\":true,\"accepting\":true}\n"; }
      export OC_SELFHOST_REMOTE_RELAY_HTTP_CMD=mock_rr
      selfhost_cutover_wait_for_safe_window --slot=A --candidate-slot=B
    ' _ "$ROOT/scripts/v5-selfhost-dual-slot-lib.sh" "$RR_DB" 2>/dev/null
  }

  run_pg_gate && pass "REAL PG: v4 binding (proto=4, docker_id match) + matched operationId inflight journal passes" || fail "REAL PG: valid v4 binding+journal blocked"
  # Mismatched docker_id -> MUST BLOCK
  rr_sql "UPDATE remote_agent_bindings SET docker_id='stale_docker_id' WHERE operation_id='22222222-2222-2222-2222-222222222222';"
  ! run_pg_gate && pass "REAL PG: mismatched binding docker_id strictly blocks" || fail "REAL PG: mismatched docker_id falsely passed"
  rr_sql "UPDATE remote_agent_bindings SET docker_id='cid_running_1', remote_protocol_version=3 WHERE operation_id='22222222-2222-2222-2222-222222222222';"
  ! run_pg_gate && pass "REAL PG: remote_protocol_version!=4 strictly blocks" || fail "REAL PG: proto=3 falsely passed"
  rr_sql "UPDATE remote_agent_bindings SET remote_protocol_version=4 WHERE operation_id='22222222-2222-2222-2222-222222222222';"
  # Missing operationId link in journal ctx -> MUST BLOCK
  rr_sql "UPDATE request_finalize_journal SET ctx='{\"remoteNativeBillingRecovery\":\"remote-native-v4\"}' WHERE request_id='req-1';"
  ! run_pg_gate && pass "REAL PG: inflight journal missing remoteDriverV4.scope.operationId strictly blocks" || fail "REAL PG: unlinked journal falsely passed"
  # Fail-closed fallback without 4-state CHECK constraint: custom non-terminal state MUST BLOCK
  rr_sql "UPDATE request_finalize_journal SET ctx='{\"remoteNativeBillingRecovery\":\"remote-native-v4\",\"remoteDriverV4\":{\"v\":4,\"scope\":{\"operationId\":\"22222222-2222-2222-2222-222222222222\",\"generation\":\"1\"}}}' WHERE request_id='req-1';"
  rr_sql "INSERT INTO request_finalize_journal VALUES ('req-custom','pending','{}',NULL);"
  ! run_pg_gate && pass "REAL PG: without 4-state CHECK, unknown non-terminal state ('pending') fails closed" || fail "REAL PG: unknown non-terminal state falsely passed"
  rr_sql "DELETE FROM request_finalize_journal WHERE request_id='req-custom';"
  # Production-shape performance regression: 10,000 committed/aborted TOASTed rows + 4-state CHECK + idx_rfj_stuck
  # MUST finish well under 1s (previously blew 5s statement_timeout via 138 InitPlans JIT + 3x Seq Scan)
  rr_sql "ALTER TABLE request_finalize_journal ADD CONSTRAINT request_finalize_journal_state_check CHECK (state = ANY (ARRAY['inflight'::text, 'finalizing'::text, 'committed'::text, 'aborted'::text]));"
  rr_sql "CREATE INDEX idx_rfj_stuck ON request_finalize_journal (state) WHERE state = ANY (ARRAY['inflight'::text, 'finalizing'::text]);"
  rr_sql "INSERT INTO request_finalize_journal (request_id, state, ctx, dispatch_id)
    SELECT 'hist-' || g, CASE WHEN g % 10 = 0 THEN 'aborted' ELSE 'committed' END,
           jsonb_build_object('model', 'gpt-6.2-astra', 'pad', repeat('x', 4096)), NULL
      FROM generate_series(1, 10000) g;"
  rr_sql "ANALYZE request_finalize_journal;"
  t0_ms="$(date +%s%3N)"
  if run_pg_gate; then
    t1_ms="$(date +%s%3N)"
    elapsed_ms=$(( t1_ms - t0_ms ))
    (( elapsed_ms < 2000 )) \
      && pass "REAL PG: 10k TOASTed history rows + idx_rfj_stuck passed in ${elapsed_ms}ms (<2000ms)" \
      || fail "REAL PG: 10k history rows took ${elapsed_ms}ms (>=2000ms)"
  else
    fail "REAL PG: 10k history rows gate failed or timed out"
  fi

  PGHOST=127.0.0.1 PGPORT=55432 PGUSER=test PGPASSWORD=test PGDATABASE=openclaude_test \
    psql -X -v ON_ERROR_STOP=1 -q -c "DROP DATABASE \"$RR_DB\";"
fi

# ── 10. deploy-v5-selfhost.sh wiring check ───────────────────────────────
if python3 - "$ROOT/scripts/deploy-v5-selfhost.sh" "$TMP" <<'PY'
import re, subprocess, sys
src = open(sys.argv[1]).read()
m = re.search(r'^egress_slot_flip_then_master_restart\(\) \{.*?^\}', src, re.M | re.S)
assert m, 'egress_slot_flip_then_master_restart not found'
fn = m.group(0)
assert 'selfhost_flip_egress_relay_and_master' in fn
script = f"""
set -Eeuo pipefail
TRACE="{sys.argv[2]}/order.trace"
: >"$TRACE"
cc5_activation_restart_guard() {{ echo guard >>"$TRACE"; }}
selfhost_flip_egress_relay_and_master() {{ echo unified >>"$TRACE"; }}
{fn}
egress_slot_flip_then_master_restart
"""
subprocess.run(['bash', '-c', script], check=True)
assert open(f"{sys.argv[2]}/order.trace").read().splitlines() == ['guard', 'unified']
PY
then
  pass "deploy-v5-selfhost.sh delegates egress_slot_flip_then_master_restart to selfhost_flip_egress_relay_and_master"
else
  fail "deploy-v5-selfhost.sh delegation check failed"
fi

printf '\nSummary: %d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
