#!/usr/bin/env bash
# OCV5-931 Layer 1: Offline hermetic unit tests for install-v5-selfhost-qos.sh
# and cgroup v2 ancestor-chain QoS configuration.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="${ROOT}/scripts/host/install-v5-selfhost-qos.sh"
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

# ── 1. bash -n syntax check ──────────────────────────────────────────────
for f in \
  scripts/host/install-v5-selfhost-qos.sh \
  scripts/v5-selfhost-dual-slot-lib.sh; do
  if bash -n "${ROOT}/${f}"; then pass "bash -n ${f}"; else fail "bash -n ${f}"; fi
done

# ── Helper to seed a realistic fake systemd / runtime / cgroup sandbox ───
write_leaf_cg() { # <dir> <mem_min> <mem_low> <cpu_weight>
  local dir="$1" mmin="$2" mlow="$3" cpu="$4"
  mkdir -p "$dir"
  printf '%s\n' "$mmin" >"${dir}/memory.min"
  printf '%s\n' "$mlow" >"${dir}/memory.low"
  printf '%s\n' "$cpu"  >"${dir}/cpu.weight"
}

seed_cgroup_valid() {
  local cg="$1"
  rm -rf -- "$cg"
  mkdir -p \
    "${cg}/system.slice" \
    "${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost.slice" \
    "${cg}/system.slice/system-postgresql.slice" \
    "${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2degress.slice" \
    "${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2dremote\x2drelay.slice" \
    "${cg}/user.slice" \
    "${cg}/user.slice/user-0.slice"

  # system.slice: 2304 MiB min, 4608 MiB low, cpu 800
  printf '2415919104\n' >"${cg}/system.slice/memory.min"
  printf '4831838208\n' >"${cg}/system.slice/memory.low"
  printf '800\n'        >"${cg}/system.slice/cpu.weight"

  # system-openclaude\x2dv5\x2dselfhost.slice: 1024 MiB min, 1536 MiB low, cpu 1000
  printf '1073741824\n' >"${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost.slice/memory.min"
  printf '1610612736\n' >"${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost.slice/memory.low"
  printf '1000\n'       >"${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost.slice/cpu.weight"

  # Active Master dual-slot leaves (@A and @B simultaneously during cutover: 2x512M=1024M, 2x768M=1536M)
  write_leaf_cg "${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost.slice/openclaude-v5-selfhost@A.service" 536870912 805306368 1000
  write_leaf_cg "${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost.slice/openclaude-v5-selfhost@B.service" 536870912 805306368 1000

  # system-postgresql.slice: 1024 MiB min, 1536 MiB low, cpu 800 + active leaf
  printf '1073741824\n' >"${cg}/system.slice/system-postgresql.slice/memory.min"
  printf '1610612736\n' >"${cg}/system.slice/system-postgresql.slice/memory.low"
  printf '800\n'        >"${cg}/system.slice/system-postgresql.slice/cpu.weight"
  write_leaf_cg "${cg}/system.slice/system-postgresql.slice/postgresql@16-main.service" 1073741824 1610612736 800

  # system-openclaude\x2dv5\x2dselfhost\x2degress.slice: 512 MiB low, cpu 600 + dual-slot leaves (2x256M)
  printf '536870912\n'  >"${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2degress.slice/memory.low"
  printf '600\n'        >"${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2degress.slice/cpu.weight"
  write_leaf_cg "${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2degress.slice/openclaude-v5-selfhost-egress@A.service" 0 268435456 600
  write_leaf_cg "${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2degress.slice/openclaude-v5-selfhost-egress@B.service" 0 268435456 600

  # system-openclaude\x2dv5\x2dselfhost\x2dremote\x2drelay.slice: 128 MiB low, cpu 500 + dual-slot leaves (2x64M)
  printf '134217728\n'  >"${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2dremote\x2drelay.slice/memory.low"
  printf '500\n'        >"${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2dremote\x2drelay.slice/cpu.weight"
  write_leaf_cg "${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2dremote\x2drelay.slice/openclaude-v5-selfhost-remote-relay@A.service" 0 67108864 500
  write_leaf_cg "${cg}/system.slice/system-openclaude\x2dv5\x2dselfhost\x2dremote\x2drelay.slice/openclaude-v5-selfhost-remote-relay@B.service" 0 67108864 500

  # Direct system.slice control-plane leaves
  write_leaf_cg "${cg}/system.slice/openclaude-v5-selfhost-frontdoor.service" 67108864 134217728 1000
  write_leaf_cg "${cg}/system.slice/cloudflared-v5-selfhost.service" 67108864 134217728 1000
  write_leaf_cg "${cg}/system.slice/redis-server.service" 0 134217728 500
  write_leaf_cg "${cg}/system.slice/openclaude.service" 0 268435456 500
  write_leaf_cg "${cg}/system.slice/cloudflared-oc.service" 0 67108864 500
  write_leaf_cg "${cg}/system.slice/ssh.service" 0 67108864 800

  # user.slice (cpu <= 50) & user-0.slice (high <= 7G, max <= 9G, cpu <= 20)
  printf '50\n'         >"${cg}/user.slice/cpu.weight"
  printf '7516192768\n' >"${cg}/user.slice/user-0.slice/memory.high"
  printf '9663676416\n' >"${cg}/user.slice/user-0.slice/memory.max"
  printf '20\n'         >"${cg}/user.slice/user-0.slice/cpu.weight"
}

seed_sandbox() {
  local box="$1"
  mkdir -p "${box}/systemd/openclaude.service.d" "${box}/runtime" "${box}/run"

  # Existing selfheal.conf that MUST be preserved untouched
  cat >"${box}/systemd/openclaude.service.d/selfheal.conf" <<'EOF'
[Service]
Restart=always
RestartSec=3
EOF

  # Pre-installed newer release .service units (MUST remain 100% byte-for-byte untouched by QoS installer!)
  printf '[Unit]\nDescription=newer frontdoor\n[Service]\nEnvironment="OC_FRONTDOOR_PORT=28790"\nExecStart=/opt/openclaude/rel-newer/frontdoor\n' \
    >"${box}/systemd/openclaude-v5-selfhost-frontdoor.service"
  printf '[Unit]\nDescription=newer master slot\n[Service]\nExecStart=/opt/openclaude/rel-newer/slot-exec.sh %%i\n' \
    >"${box}/systemd/openclaude-v5-selfhost@.service"
  printf '[Unit]\nDescription=newer cloudflared\n[Service]\nExecStart=/opt/openclaude/rel-newer/cloudflared\n' \
    >"${box}/systemd/cloudflared-v5-selfhost.service"
  printf '[Unit]\nDescription=newer egress\n[Service]\nExecStart=/opt/openclaude/rel-newer/egress\n' \
    >"${box}/systemd/openclaude-v5-selfhost-egress@.service"

  # Managed runtime drop-in directories (all 11) + 1 UNMANAGED runtime dir
  local d
  for d in \
    cloudflared-oc.service.d \
    cloudflared-v5-selfhost.service.d \
    openclaude-v5-selfhost-egress@A.service.d \
    openclaude-v5-selfhost-egress@B.service.d \
    openclaude-v5-selfhost-frontdoor.service.d \
    openclaude-v5-selfhost@A.service.d \
    openclaude-v5-selfhost@B.service.d \
    openclaude.service.d \
    postgresql@16-main.service.d \
    redis-server.service.d \
    user-0.slice.d \
    unrelated-custom.service.d; do
    mkdir -p "${box}/runtime/${d}"
    printf '[Service]\nCPUWeight=100\n' >"${box}/runtime/${d}/50-CPUWeight.conf"
    printf '[Service]\nMemoryLow=64M\n' >"${box}/runtime/${d}/50-MemoryLow.conf"
  done

  # Unreplaced QoS runtime cap on postgresql@16-main (postgresql@16-main.service.conf has NO MemoryMax= -> MUST be preserved!)
  printf '[Service]\nMemoryMax=4G\n' >"${box}/runtime/postgresql@16-main.service.d/50-MemoryMax.conf"
  # Non-QoS runtime property file inside a MANAGED runtime directory (MUST be preserved!)
  printf '[Service]\nTasksMax=4096\n' >"${box}/runtime/openclaude.service.d/50-TasksMax.conf"

  # Legacy tsc queue script
  printf '#!/usr/bin/env python3\n' >"${box}/run/v5-tsc-queue.py"

  seed_cgroup_valid "${box}/cgroup"
}

# Fake systemctl binary for offline testing (tracks all invocations)
mkdir -p "${TMP}/fakebin"
cat >"${TMP}/fakebin/systemctl" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
[[ -n "${FAKE_SYSTEMCTL_LOG:-}" ]] && printf '%s\n' "$*" >>"$FAKE_SYSTEMCTL_LOG"
case "${1:-}" in
  is-active)
    if [[ "${2:-}" == "v5-selfhost-tsc-queue.service" ]]; then
      if [[ "${FAKE_TSC_QUEUE_STATE:-inactive}" == "__EMPTY__" ]]; then
        exit 1
      fi
      printf '%s\n' "${FAKE_TSC_QUEUE_STATE:-inactive}"
      [[ "${FAKE_TSC_QUEUE_STATE:-inactive}" == "active" ]] && exit 0 || exit 3
    fi
    printf 'inactive\n'
    exit 3
    ;;
  daemon-reload)
    exit 0
    ;;
  show)
    printf 'CPUWeight=800\n'
    exit 0
    ;;
  revert|restart|reload|stop|start|enable|disable)
    printf 'FORBIDDEN_SYSTEMCTL_OP: %s\n' "$*" >&2
    exit 99
    ;;
esac
exit 0
SHIM
chmod +x "${TMP}/fakebin/systemctl"

# ── 2. Default (--dry-run) performs ZERO writes and ZERO deletions ───────
BOX1="${TMP}/box1"
seed_sandbox "$BOX1"
DRY_LOG="${TMP}/dry-systemctl.log"
: >"$DRY_LOG"

dry_out="$(PATH="${TMP}/fakebin:${PATH}" FAKE_SYSTEMCTL_LOG="$DRY_LOG" \
  bash "$INSTALLER" \
    --systemd-dir "${BOX1}/systemd" \
    --runtime-control-dir "${BOX1}/runtime" \
    --cgroup-root "${BOX1}/cgroup" \
    --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py")"

[[ ! -e "${BOX1}/systemd/oc-host-cmd.slice" ]] \
  && [[ ! -e "${BOX1}/systemd/system.slice.d/10-v5-selfhost-qos.conf" ]] \
  && [[ ! -e "${BOX1}/systemd/openclaude-v5-selfhost@.service.d/10-v5-selfhost-qos.conf" ]] \
  && [[ -f "${BOX1}/runtime/openclaude-v5-selfhost@A.service.d/50-CPUWeight.conf" ]] \
  && [[ -f "${BOX1}/run/v5-tsc-queue.py" ]] \
  && [[ "$dry_out" == *"[dry-run]"* ]] \
  && ! grep -q '^daemon-reload' "$DRY_LOG" \
  && pass "dry-run (default) performs zero filesystem writes, zero deletions, and no daemon-reload" \
  || fail "dry-run modified filesystem or ran daemon-reload"

# Snapshot newer release .service files before --apply to prove single-writer invariance
UNITS_BEFORE="${TMP}/units-before.sha256"
sha256sum \
  "${BOX1}/systemd/openclaude-v5-selfhost-frontdoor.service" \
  "${BOX1}/systemd/openclaude-v5-selfhost@.service" \
  "${BOX1}/systemd/cloudflared-v5-selfhost.service" \
  "${BOX1}/systemd/openclaude-v5-selfhost-egress@.service" >"$UNITS_BEFORE"

# ── 3. --apply installs all drop-ins atomically without modifying .service units ──
APPLY_LOG="${TMP}/apply-systemctl.log"
: >"$APPLY_LOG"

PATH="${TMP}/fakebin:${PATH}" FAKE_SYSTEMCTL_LOG="$APPLY_LOG" FAKE_TSC_QUEUE_STATE="inactive" \
  bash "$INSTALLER" --apply \
    --systemd-dir "${BOX1}/systemd" \
    --runtime-control-dir "${BOX1}/runtime" \
    --cgroup-root "${BOX1}/cgroup" \
    --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null

# Verify oc-host-cmd.slice + all 18 drop-ins installed with exact escaped names
all_dropins_ok=1
[[ -f "${BOX1}/systemd/oc-host-cmd.slice" ]] || all_dropins_ok=0
for u in \
  'system.slice' \
  'system-openclaude\x2dv5\x2dselfhost.slice' \
  'system-openclaude\x2dv5\x2dselfhost\x2degress.slice' \
  'system-openclaude\x2dv5\x2dselfhost\x2dremote\x2drelay.slice' \
  'system-postgresql.slice' \
  'user.slice' \
  'user-0.slice' \
  'postgresql@16-main.service' \
  'redis-server.service' \
  'openclaude.service' \
  'cloudflared-oc.service' \
  'ssh.service' \
  'openclaude-v5-selfhost-frontdoor.service' \
  'openclaude-v5-selfhost@.service' \
  'openclaude-v5-selfhost.service' \
  'cloudflared-v5-selfhost.service' \
  'openclaude-v5-selfhost-egress@.service' \
  'openclaude-v5-selfhost-remote-relay@.service'; do
  [[ -f "${BOX1}/systemd/${u}.d/10-v5-selfhost-qos.conf" ]] || {
    printf 'missing drop-in for %s\n' "$u" >&2
    all_dropins_ok=0
  }
done
assert_eq "apply installs oc-host-cmd.slice and all 18 escaped drop-ins" "1" "$all_dropins_ok"

# Verify selfheal.conf preserved byte-for-byte
grep -Fxq 'Restart=always' "${BOX1}/systemd/openclaude.service.d/selfheal.conf" \
  && grep -Fxq 'RestartSec=3' "${BOX1}/systemd/openclaude.service.d/selfheal.conf" \
  && [[ -f "${BOX1}/systemd/openclaude.service.d/10-v5-selfhost-qos.conf" ]] \
  && pass "apply preserves existing openclaude.service.d/selfheal.conf alongside 10-v5-selfhost-qos.conf" \
  || fail "apply altered or removed selfheal.conf"

# Single-writer regression: pre-existing newer release .service files MUST be byte-for-byte unchanged,
# and no new .service files (e.g. remote-relay@.service) created by QoS installer!
if sha256sum -c --status "$UNITS_BEFORE" && [[ ! -e "${BOX1}/systemd/openclaude-v5-selfhost-remote-relay@.service" ]]; then
  pass "single-writer: QoS --apply leaves newer release .service unit files byte-for-byte untouched"
else
  fail "single-writer VIOLATED: QoS --apply altered or created full .service unit file"
fi

# Verify dual-slot service drop-ins carry exact dual-slot-safe QoS (512M/768M master, 256M egress, 64M relay)
grep -Fxq 'MemoryMin=64M' "${BOX1}/systemd/openclaude-v5-selfhost-frontdoor.service.d/10-v5-selfhost-qos.conf" \
  && grep -Fxq 'MemoryLow=128M' "${BOX1}/systemd/openclaude-v5-selfhost-frontdoor.service.d/10-v5-selfhost-qos.conf" \
  && grep -Fxq 'MemoryMin=512M' "${BOX1}/systemd/openclaude-v5-selfhost@.service.d/10-v5-selfhost-qos.conf" \
  && grep -Fxq 'MemoryLow=768M' "${BOX1}/systemd/openclaude-v5-selfhost@.service.d/10-v5-selfhost-qos.conf" \
  && grep -Fxq 'MemoryLow=256M' "${BOX1}/systemd/openclaude-v5-selfhost-egress@.service.d/10-v5-selfhost-qos.conf" \
  && grep -Fxq 'MemoryLow=64M' "${BOX1}/systemd/openclaude-v5-selfhost-remote-relay@.service.d/10-v5-selfhost-qos.conf" \
  && pass "service drop-ins carry aligned dual-slot-safe QoS directives" \
  || fail "service drop-ins missing expected QoS directives"

# Verified-replacement runtime cleanup:
# - Replaced props removed and empty dirs rmdir'd
# - user-0.slice.d/50-MemoryLow.conf NOT in user-0.slice.conf -> preserved! (only CPUWeight replaced)
# - postgresql@16-main.service.d/50-MemoryMax.conf NOT in postgresql@16-main.service.conf -> preserved!
# - openclaude.service.d/50-TasksMax.conf (non-QoS) -> preserved!
# - unrelated-custom.service.d -> preserved!
rt_ok=1
for d in \
  cloudflared-oc.service.d \
  cloudflared-v5-selfhost.service.d \
  openclaude-v5-selfhost-egress@A.service.d \
  openclaude-v5-selfhost-egress@B.service.d \
  openclaude-v5-selfhost-frontdoor.service.d \
  openclaude-v5-selfhost@A.service.d \
  openclaude-v5-selfhost@B.service.d \
  redis-server.service.d; do
  [[ ! -e "${BOX1}/runtime/${d}" ]] || rt_ok=0
done
[[ ! -e "${BOX1}/runtime/postgresql@16-main.service.d/50-CPUWeight.conf" ]] || rt_ok=0
[[ ! -e "${BOX1}/runtime/postgresql@16-main.service.d/50-MemoryLow.conf" ]] || rt_ok=0
[[ -f "${BOX1}/runtime/postgresql@16-main.service.d/50-MemoryMax.conf" ]] || rt_ok=0
grep -Fxq 'MemoryMax=4G' "${BOX1}/runtime/postgresql@16-main.service.d/50-MemoryMax.conf" || rt_ok=0
[[ ! -e "${BOX1}/runtime/user-0.slice.d/50-CPUWeight.conf" ]] || rt_ok=0
[[ -f "${BOX1}/runtime/user-0.slice.d/50-MemoryLow.conf" ]] || rt_ok=0
[[ ! -e "${BOX1}/runtime/openclaude.service.d/50-CPUWeight.conf" ]] || rt_ok=0
[[ ! -e "${BOX1}/runtime/openclaude.service.d/50-MemoryLow.conf" ]] || rt_ok=0
[[ -f "${BOX1}/runtime/openclaude.service.d/50-TasksMax.conf" ]] || rt_ok=0
grep -Fxq 'TasksMax=4096' "${BOX1}/runtime/openclaude.service.d/50-TasksMax.conf" || rt_ok=0
[[ -f "${BOX1}/runtime/unrelated-custom.service.d/50-CPUWeight.conf" ]] || rt_ok=0
assert_eq "verified-replacement cleanup preserves unreplaced postgresql MemoryMax, user-0 MemoryLow, TasksMax & unrelated dirs" "1" "$rt_ok"

# Verify legacy /run/v5-tsc-queue.py removed when service confirmed inactive
[[ ! -e "${BOX1}/run/v5-tsc-queue.py" ]] \
  && pass "apply removes legacy v5-tsc-queue.py when v5-selfhost-tsc-queue.service is confirmed inactive" \
  || fail "apply failed to remove inactive v5-tsc-queue.py"

# Verify daemon-reload ran and NO forbidden systemctl commands ran
grep -Fxq 'daemon-reload' "$APPLY_LOG" \
  && ! grep -Eq '^(revert|restart|reload|stop|start|enable|disable) ' "$APPLY_LOG" \
  && pass "apply runs daemon-reload without revert/restart/stop/enable" \
  || fail "apply ran unexpected systemctl commands"

# ── 4. Idempotent second --apply reports unchanged and keeps files identical ──
second_out="$(PATH="${TMP}/fakebin:${PATH}" FAKE_SYSTEMCTL_LOG="$APPLY_LOG" \
  bash "$INSTALLER" --apply --skip-reload \
    --systemd-dir "${BOX1}/systemd" \
    --runtime-control-dir "${BOX1}/runtime" \
    --cgroup-root "${BOX1}/cgroup" \
    --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py")"

! grep -q '^installed:' <<<"$second_out" \
  && grep -q '^unchanged: ' <<<"$second_out" \
  && pass "second --apply is strictly idempotent (zero rewrites, all unchanged)" \
  || fail "second --apply was not idempotent"

# ── 5. v5-selfhost-tsc-queue.service fail-safe guard (active, unknown, unavailable -> keep + warn; failed -> remove) ──
printf '#!/usr/bin/env python3\n' >"${BOX1}/run/v5-tsc-queue.py"
active_err="$(PATH="${TMP}/fakebin:${PATH}" FAKE_TSC_QUEUE_STATE="active" \
  bash "$INSTALLER" --apply --skip-reload \
    --systemd-dir "${BOX1}/systemd" \
    --runtime-control-dir "${BOX1}/runtime" \
    --cgroup-root "${BOX1}/cgroup" \
    --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" 2>&1 >/dev/null)"
[[ -f "${BOX1}/run/v5-tsc-queue.py" && "$active_err" == *"WARN:"* ]] \
  && pass "active v5-selfhost-tsc-queue.service emits warning and preserves script (no force-kill)" \
  || fail "active tsc-queue guard failed"

unknown_err="$(PATH="${TMP}/fakebin:${PATH}" FAKE_TSC_QUEUE_STATE="__EMPTY__" \
  bash "$INSTALLER" --apply --skip-reload \
    --systemd-dir "${BOX1}/systemd" \
    --runtime-control-dir "${BOX1}/runtime" \
    --cgroup-root "${BOX1}/cgroup" \
    --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" 2>&1 >/dev/null)"
[[ -f "${BOX1}/run/v5-tsc-queue.py" && "$unknown_err" == *"WARN:"* && "$unknown_err" == *"unknown"* ]] \
  && pass "unknown v5-selfhost-tsc-queue.service state emits warning and preserves script" \
  || fail "unknown tsc-queue state guard failed"

# Also test when systemctl binary is completely unavailable on PATH
NO_SYSCTL_BIN="${TMP}/nosysctl-bin"
mkdir -p "$NO_SYSCTL_BIN"
for cmd in bash cat cmp cp dirname basename grep mkdir mktemp mv rm rmdir stat chmod tr; do
  cpath="$(command -v "$cmd" || true)"
  [[ -n "$cpath" ]] && ln -sf "$cpath" "${NO_SYSCTL_BIN}/${cmd}"
done
unavail_err="$(PATH="$NO_SYSCTL_BIN" \
  bash "$INSTALLER" --apply --skip-reload \
    --systemd-dir "${BOX1}/systemd" \
    --runtime-control-dir "${BOX1}/runtime" \
    --cgroup-root "${BOX1}/cgroup" \
    --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" 2>&1 >/dev/null)"
[[ -f "${BOX1}/run/v5-tsc-queue.py" && "$unavail_err" == *"WARN:"* && "$unavail_err" == *"unavailable"* ]] \
  && pass "unavailable systemctl emits warning and preserves legacy tsc queue script" \
  || fail "unavailable systemctl guard failed"

# Confirmed 'failed' terminal state removes the script
PATH="${TMP}/fakebin:${PATH}" FAKE_TSC_QUEUE_STATE="failed" \
  bash "$INSTALLER" --apply --skip-reload \
    --systemd-dir "${BOX1}/systemd" \
    --runtime-control-dir "${BOX1}/runtime" \
    --cgroup-root "${BOX1}/cgroup" \
    --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null
[[ ! -e "${BOX1}/run/v5-tsc-queue.py" ]] \
  && pass "confirmed failed v5-selfhost-tsc-queue.service removes legacy script" \
  || fail "failed tsc-queue state did not remove legacy script"

# ── 6. --verify green path (including preserved non-QoS 50-TasksMax.conf & full active dual-slot leaves) ──
if PATH="${TMP}/fakebin:${PATH}" bash "$INSTALLER" --verify \
    --systemd-dir "${BOX1}/systemd" \
    --runtime-control-dir "${BOX1}/runtime" \
    --cgroup-root "${BOX1}/cgroup" \
    --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null; then
  pass "verify passes (green) with non-QoS runtime file intact + full dual-slot active leaf cgroups"
else
  fail "verify unexpectedly failed on valid sandbox"
fi

# ── 7. --verify RED counterexamples (anti-4KiB false-green, leaf under-budget, parent<sum, CPU ratio, runtime QoS leftover) ──

# Counterexample A: system.slice memory.low=4096 (4 KiB > 0 but far below 4608 MiB) -> MUST FAIL
printf '4096\n' >"${BOX1}/cgroup/system.slice/memory.low"
rc=0
PATH="${TMP}/fakebin:${PATH}" bash "$INSTALLER" --verify \
  --systemd-dir "${BOX1}/systemd" \
  --runtime-control-dir "${BOX1}/runtime" \
  --cgroup-root "${BOX1}/cgroup" \
  --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null 2>&1 || rc=$?
assert_eq "verify (red): system.slice memory.low=4096 (4KiB false-green trap) fails" "1" "$rc"
seed_cgroup_valid "${BOX1}/cgroup"

# Counterexample B: master slice memory.min=4096 (4 KiB) -> MUST FAIL
printf '4096\n' >"${BOX1}/cgroup/system.slice/system-openclaude\x2dv5\x2dselfhost.slice/memory.min"
rc=0
PATH="${TMP}/fakebin:${PATH}" bash "$INSTALLER" --verify \
  --systemd-dir "${BOX1}/systemd" \
  --runtime-control-dir "${BOX1}/runtime" \
  --cgroup-root "${BOX1}/cgroup" \
  --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null 2>&1 || rc=$?
assert_eq "verify (red): master template slice memory.min=4096 fails" "1" "$rc"
seed_cgroup_valid "${BOX1}/cgroup"

# Counterexample C: PG slice memory.low=4096 (4 KiB) -> MUST FAIL
printf '4096\n' >"${BOX1}/cgroup/system.slice/system-postgresql.slice/memory.low"
rc=0
PATH="${TMP}/fakebin:${PATH}" bash "$INSTALLER" --verify \
  --systemd-dir "${BOX1}/systemd" \
  --runtime-control-dir "${BOX1}/runtime" \
  --cgroup-root "${BOX1}/cgroup" \
  --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null 2>&1 || rc=$?
assert_eq "verify (red): postgresql slice memory.low=4096 fails" "1" "$rc"
seed_cgroup_valid "${BOX1}/cgroup"

# Counterexample D: active leaf openclaude-v5-selfhost@A.service memory.low below 768 MiB -> MUST FAIL
printf '536870912\n' >"${BOX1}/cgroup/system.slice/system-openclaude\x2dv5\x2dselfhost.slice/openclaude-v5-selfhost@A.service/memory.low"
rc=0
PATH="${TMP}/fakebin:${PATH}" bash "$INSTALLER" --verify \
  --systemd-dir "${BOX1}/systemd" \
  --runtime-control-dir "${BOX1}/runtime" \
  --cgroup-root "${BOX1}/cgroup" \
  --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null 2>&1 || rc=$?
assert_eq "verify (red): active leaf openclaude-v5-selfhost@A.service memory.low < 768 MiB fails" "1" "$rc"
seed_cgroup_valid "${BOX1}/cgroup"

# Counterexample E: dual-slot @A+@B sum exceeds parent master slice (e.g. each @A/@B asks 1024 MiB low = 2048 MiB > 1536 MiB parent) -> MUST FAIL
printf '1073741824\n' >"${BOX1}/cgroup/system.slice/system-openclaude\x2dv5\x2dselfhost.slice/openclaude-v5-selfhost@A.service/memory.low"
printf '1073741824\n' >"${BOX1}/cgroup/system.slice/system-openclaude\x2dv5\x2dselfhost.slice/openclaude-v5-selfhost@B.service/memory.low"
rc=0
PATH="${TMP}/fakebin:${PATH}" bash "$INSTALLER" --verify \
  --systemd-dir "${BOX1}/systemd" \
  --runtime-control-dir "${BOX1}/runtime" \
  --cgroup-root "${BOX1}/cgroup" \
  --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null 2>&1 || rc=$?
assert_eq "verify (red): dual-slot @A+@B memory.low sum exceeding parent master slice fails" "1" "$rc"
seed_cgroup_valid "${BOX1}/cgroup"

# Counterexample F: CPU priority ratio violated (system.slice 800, user.slice 150 -> >50 and <8x) -> MUST FAIL
printf '150\n' >"${BOX1}/cgroup/user.slice/cpu.weight"
rc=0
PATH="${TMP}/fakebin:${PATH}" bash "$INSTALLER" --verify \
  --systemd-dir "${BOX1}/systemd" \
  --runtime-control-dir "${BOX1}/runtime" \
  --cgroup-root "${BOX1}/cgroup" \
  --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null 2>&1 || rc=$?
assert_eq "verify (red): user.slice cpu.weight=150 (>50 / <8x ratio) fails" "1" "$rc"
seed_cgroup_valid "${BOX1}/cgroup"

# Counterexample G: user-0.slice memory.max=max (unbounded root session) -> MUST FAIL
printf 'max\n' >"${BOX1}/cgroup/user.slice/user-0.slice/memory.max"
rc=0
PATH="${TMP}/fakebin:${PATH}" bash "$INSTALLER" --verify \
  --systemd-dir "${BOX1}/systemd" \
  --runtime-control-dir "${BOX1}/runtime" \
  --cgroup-root "${BOX1}/cgroup" \
  --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null 2>&1 || rc=$?
assert_eq "verify (red): user-0.slice memory.max=max fails" "1" "$rc"
seed_cgroup_valid "${BOX1}/cgroup"

# Counterexample H: leftover managed runtime QoS drop-in file -> MUST FAIL
mkdir -p "${BOX1}/runtime/openclaude-v5-selfhost@A.service.d"
printf '[Service]\nMemoryLow=128M\n' >"${BOX1}/runtime/openclaude-v5-selfhost@A.service.d/50-MemoryLow.conf"
rc=0
PATH="${TMP}/fakebin:${PATH}" bash "$INSTALLER" --verify \
  --systemd-dir "${BOX1}/systemd" \
  --runtime-control-dir "${BOX1}/runtime" \
  --cgroup-root "${BOX1}/cgroup" \
  --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null 2>&1 || rc=$?
assert_eq "verify (red): leftover managed runtime QoS file fails" "1" "$rc"
rm -rf -- "${BOX1}/runtime/openclaude-v5-selfhost@A.service.d"

# Counterexample I: legacy single-slot openclaude-v5-selfhost.service coexisting with dual-slot slices
# pushes system.slice direct children sum to 5248 MiB > 4608 MiB (and 2688 MiB > 2304 MiB) -> MUST FAIL
write_leaf_cg "${BOX1}/cgroup/system.slice/openclaude-v5-selfhost.service" 536870912 805306368 1000
rc=0
PATH="${TMP}/fakebin:${PATH}" bash "$INSTALLER" --verify \
  --systemd-dir "${BOX1}/systemd" \
  --runtime-control-dir "${BOX1}/runtime" \
  --cgroup-root "${BOX1}/cgroup" \
  --tsc-queue-script "${BOX1}/run/v5-tsc-queue.py" >/dev/null 2>&1 || rc=$?
assert_eq "verify (red): active single-slot openclaude-v5-selfhost.service coexisting with dual-slot slices exceeds system.slice budget" "1" "$rc"
seed_cgroup_valid "${BOX1}/cgroup"

# ── 8. Repo static unit templates and slice configs carry valid OCV5-931 QoS parameters ──
grep -Fxq 'CPUWeight=1000' "${ROOT}/deploy/v5-selfhost/openclaude-v5-selfhost.service" \
  && grep -Fxq 'IOWeight=1000' "${ROOT}/deploy/v5-selfhost/openclaude-v5-selfhost.service" \
  && grep -Fxq 'MemoryMin=512M' "${ROOT}/deploy/v5-selfhost/openclaude-v5-selfhost.service" \
  && grep -Fxq 'MemoryLow=768M' "${ROOT}/deploy/v5-selfhost/openclaude-v5-selfhost.service" \
  && grep -Fxq 'OOMScoreAdjust=-800' "${ROOT}/deploy/v5-selfhost/openclaude-v5-selfhost.service" \
  && grep -Fxq 'CPUWeight=600' "${ROOT}/deploy/v5-selfhost/openclaude-v5-selfhost-egress@.service" \
  && grep -Fxq 'MemoryLow=256M' "${ROOT}/deploy/v5-selfhost/openclaude-v5-selfhost-egress@.service" \
  && grep -Fxq 'CPUWeight=500' "${ROOT}/deploy/v5-selfhost/openclaude-v5-selfhost-remote-relay@.service" \
  && grep -Fxq 'IOWeight=500' "${ROOT}/deploy/v5-selfhost/openclaude-v5-selfhost-remote-relay@.service" \
  && grep -Fxq 'MemoryLow=64M' "${ROOT}/deploy/v5-selfhost/openclaude-v5-selfhost-remote-relay@.service" \
  && grep -Fxq 'OOMScoreAdjust=-500' "${ROOT}/deploy/v5-selfhost/openclaude-v5-selfhost-remote-relay@.service" \
  && grep -Fxq 'MemoryMin=2304M' "${ROOT}/deploy/v5-selfhost/qos/system.slice.conf" \
  && grep -Fxq 'MemoryMin=1024M' "${ROOT}/deploy/v5-selfhost/qos/system-openclaude-v5-selfhost.slice.conf" \
  && grep -Fxq 'MemoryLow=1536M' "${ROOT}/deploy/v5-selfhost/qos/system-openclaude-v5-selfhost.slice.conf" \
  && grep -Fxq 'CPUQuota=1200%' "${ROOT}/deploy/v5-selfhost/oc-host-cmd.slice" \
  && grep -Fxq 'MemoryMax=8G' "${ROOT}/deploy/v5-selfhost/oc-host-cmd.slice" \
  && ! grep -Eq '^(OOMPolicy|OOMScoreAdjust)=' "${ROOT}/deploy/v5-selfhost/oc-host-cmd.slice" "${ROOT}/deploy/v5-selfhost/qos/"*.slice.conf \
  && pass "repo static unit templates, slice drop-ins, and oc-host-cmd.slice carry valid aligned QoS settings" \
  || fail "repo static unit templates, slice drop-ins, or oc-host-cmd.slice missing/invalid QoS settings"

printf 'passed=%d failed=%d\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
