#!/usr/bin/env bash
# Offline unit tests for OCV5-931 Layer 2:
#   - scripts/host/oc-host-cmd-gate.sh
#   - scripts/selfhost-setup-host-access.sh (--gate-only + authorized_keys idempotent upgrade)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GATE="${REPO_ROOT}/scripts/host/oc-host-cmd-gate.sh"
SETUP="${REPO_ROOT}/scripts/selfhost-setup-host-access.sh"

TMP_ROOT="$(mktemp -d)"
cleanup_root() {
  rm -rf "$TMP_ROOT"
}
trap cleanup_root EXIT

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  printf '  PASS: %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf '  FAIL: %s\n' "$1" >&2
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label (expected='$expected', actual='$actual')"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$label"
  else
    fail "$label (missing '$needle' in '$haystack')"
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$label"
  else
    fail "$label (unexpected '$needle' found in '$haystack')"
  fi
}

make_host_wrapper_cmd() {
  local inner="$1"
  local session="${2:-sess-test}"
  local detach="${3:-0}"
  local hclass="${4:-}"
  local b64
  b64="$(printf '%s' "$inner" | base64 | tr -d '\n\r ')"
  printf "export OC_CALLER_SESSION='%s' OC_CALLER_AGENT='main' OC_CALLER_TURN='t1' OC_HOST_DETACH='%s' OC_HOST_CLASS='%s'; logger -t oc-host-cmd -- 'test' </dev/null 2>/dev/null || true; export _OC_SSHD_PID=\$PPID _OC_B64_CMD='%s'; exec setsid -w /bin/bash -c '_oc_cmd=\$(printf \"%%s\" \"\$_OC_B64_CMD\" | base64 -d); /bin/bash -c \"\$_oc_cmd\"'" \
    "$session" "$detach" "$hclass" "$b64"
}

MEMINFO_OK="${TMP_ROOT}/meminfo.ok"
cat > "$MEMINFO_OK" <<'EOF'
MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:    8192000 kB
EOF

MEMINFO_LOW="${TMP_ROOT}/meminfo.low"
cat > "$MEMINFO_LOW" <<'EOF'
MemTotal:       16384000 kB
MemFree:          512000 kB
MemAvailable:    1024000 kB
EOF

# ─── 1. Classifier Matrix & Authoritative Classification ──────────────────────
printf '\n=== 1. Classifier Matrix & Authoritative Classification ===\n'

check_class() {
  local expected="$1" cmd="$2" label="${3:-$2}"
  local actual
  actual="$(env -u OC_HOST_CLASS -u OC_HOST_GATE_ACTIVE "$GATE" --classify "$cmd")"
  assert_eq "classify [$label]" "$expected" "$actual"
}

check_class heavy 'cd /wt && tsc -b'
check_class heavy 'npx vitest'
check_class heavy 'npx vitest run src/foo.test.ts'
check_class heavy 'npm run check:governance:fast'
check_class heavy 'npm run build'
check_class heavy 'npm test'
check_class heavy 'playwright test'
check_class heavy 'npx playwright test --grep smoke'
check_class heavy 'cd /wt && git status && npx tsc -b'
check_class heavy './node_modules/.bin/tsc --noEmit'
check_class heavy 'env FOO=1 timeout 30 nice -n 10 npx tsx scripts/check-architecture.ts'
check_class heavy 'bash -c "cd /wt && npx tsc -b"'
check_class heavy 'node --test scripts/__tests__/v5TaskHost.node-test.mjs'
check_class heavy 'docker compose -f compose.yml build'
check_class heavy 'go test ./...'
check_class heavy 'pytest tests/'
check_class heavy 'cargo build --release'
check_class heavy 'bash scripts/check-v5-box-gate.sh'
check_class heavy 'oc-lease.sh register && npx tsc -b'
check_class heavy 'OC_HOST_CLASS=heavy echo hi'
check_class heavy "$(make_host_wrapper_cmd 'cd /wt && tsc -b' 's-heavy')" 'wrapper(tsc -b)'

# Blocker 2A: Authoritative host classification — OC_HOST_CLASS=light MUST NOT downgrade heavy!
check_class heavy 'OC_HOST_CLASS=light npx tsc -b' 'no-downgrade(inline light + tsc)'
check_class heavy 'export OC_HOST_CLASS=light; npx tsc -b' 'no-downgrade(export light + tsc)'
check_class heavy "$(make_host_wrapper_cmd 'npx tsc -b' 's-override' '0' 'light')" 'no-downgrade(wrapper light + tsc)'

# Blocker 2B: Smuggled heavy command alongside decoy _OC_B64_CMD MUST be classified heavy!
check_class heavy "export _OC_B64_CMD='ZWNobyBoaQ=='; npx tsc -b" 'smuggle(decoy b64 + tsc)'
check_class heavy "export _OC_B64_CMD='ZWNobyBoaQ=='; export _OC_B64_CMD='bnB4IHRzYyAtYg=='" 'smuggle(multi _OC_B64_CMD)'

# R2 #2: Command substitutions $(...) and `...` outside single quotes MUST be classified recursively!
check_class heavy 'echo "$(npx tsc -b)"' 'cmd-subst(double-quoted $())'
check_class heavy 'echo `vitest run`' 'cmd-subst(backticks)'
check_class heavy 'echo "`npx playwright test`"' 'cmd-subst(double-quoted backticks)'
check_class heavy 'git commit -m "build $(npm run build)"' 'cmd-subst(in git commit double quotes)'
check_class light "echo '\$(npx tsc -b)'" 'cmd-subst(single-quoted literal $())'
check_class light 'echo '\''`vitest run`'\''' 'cmd-subst(single-quoted literal backticks)'
check_class light 'git commit -m "fix tsc"' 'plain double-quoted text'

check_class light "$(make_host_wrapper_cmd 'git status' 's-light')" 'wrapper(git status)'
check_class light 'git commit -m "fix tsc and vitest"'
check_class light 'gh pr create --title "fix tsc"'
check_class light 'rg "vitest" scripts/'
check_class light 'cat foo/vitest.config.ts'
check_class light 'echo "tsc"'
check_class light 'oc-lease.sh register'
check_class light 'v5-deploy-detached.sh --status'
check_class light 'deploy-v5-selfhost.sh --check'
check_class light 'install-v5-selfhost-qos.sh --dry-run'
check_class light 'scp -t /tmp/a'
check_class light '/usr/lib/openssh/sftp-server'
check_class light 'rsync --server -vlogDtpre.iLsfxCIvu . /tmp/dest'
check_class light 'OC_HOST_CLASS=light echo ok'

# Protocol channel stdout cleanliness test (mock scp on PATH)
SCP_BIN_DIR="${TMP_ROOT}/scp-bin"
mkdir -p "$SCP_BIN_DIR"
cat > "${SCP_BIN_DIR}/scp" <<'EOF'
#!/usr/bin/env bash
printf 'PROTO_PAYLOAD:%s' "$*"
EOF
chmod +x "${SCP_BIN_DIR}/scp"

scp_out="$(env -u OC_HOST_GATE_ACTIVE PATH="${SCP_BIN_DIR}:$PATH" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_LOW" \
  SSH_ORIGINAL_COMMAND="scp -t /tmp/a" \
  "$GATE")"
assert_eq "scp passthrough preserves exact stdout even under low memory" "PROTO_PAYLOAD:-t /tmp/a" "$scp_out"

# Interactive shell passthrough (Case A: empty SSH_ORIGINAL_COMMAND)
MOCK_SHELL="${TMP_ROOT}/mock-shell"
cat > "$MOCK_SHELL" <<'EOF'
#!/usr/bin/env bash
printf 'INTERACTIVE_SHELL:%s' "$*"
EOF
chmod +x "$MOCK_SHELL"

shell_out="$(env -u OC_HOST_GATE_ACTIVE \
  SHELL="$MOCK_SHELL" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_LOW" \
  SSH_ORIGINAL_COMMAND="" \
  "$GATE")"
assert_eq "empty SSH_ORIGINAL_COMMAND execs login shell directly even under low memory" "INTERACTIVE_SHELL:-l" "$shell_out"

# Blocker 1 + R2 #1: Stdin + Stdout + Stderr + Exit Code preservation across BOTH heavy & light paths
SLOTS_STDIN="${TMP_ROOT}/slots-stdin"
IO_HEAVY_OUT="${TMP_ROOT}/io-heavy.out"
IO_HEAVY_ERR="${TMP_ROOT}/io-heavy.err"
rc_io_heavy=0
printf '123456789' | env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_STDIN" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy sh -c 'cat; echo diag-stderr >&2; exit 23'" \
  "$GATE" >"$IO_HEAVY_OUT" 2>"$IO_HEAVY_ERR" || rc_io_heavy=$?

assert_eq "heavy path preserves piped SSH stdin -> stdout (exact 9 bytes)" "123456789" "$(cat "$IO_HEAVY_OUT")"
assert_contains "heavy path preserves stderr (not swallowed by exec 3<&0)" "diag-stderr" "$(cat "$IO_HEAVY_ERR")"
assert_eq "heavy path preserves exact exit code (23)" "23" "$rc_io_heavy"

IO_LIGHT_OUT="${TMP_ROOT}/io-light.out"
IO_LIGHT_ERR="${TMP_ROOT}/io-light.err"
rc_io_light=0
printf '123456789' | env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_STDIN" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="sh -c 'cat; echo diag-stderr >&2; exit 23'" \
  "$GATE" >"$IO_LIGHT_OUT" 2>"$IO_LIGHT_ERR" || rc_io_light=$?

assert_eq "light path preserves piped SSH stdin -> stdout (exact 9 bytes)" "123456789" "$(cat "$IO_LIGHT_OUT")"
assert_contains "light path preserves stderr" "diag-stderr" "$(cat "$IO_LIGHT_ERR")"
assert_eq "light path preserves exact exit code (23)" "23" "$rc_io_light"

# Heavy & light exact non-zero exit code passthrough + wrapper end-to-end execution
SLOTS_RC="${TMP_ROOT}/slots-rc"
rc_heavy_nz=0
env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_RC" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy exit 42" \
  "$GATE" || rc_heavy_nz=$?
assert_eq "heavy path preserves exact non-zero exit code (42)" "42" "$rc_heavy_nz"

rc_light_nz=0
env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_RC" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="exit 17" \
  "$GATE" || rc_light_nz=$?
assert_eq "light path preserves exact non-zero exit code (17)" "17" "$rc_light_nz"

wrapper_e2e_cmd="$(make_host_wrapper_cmd 'printf "wrapped-ok:%s" "$OC_CALLER_SESSION"' 'sess-wrap-e2e' '0' 'heavy')"
wrap_out="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_RC" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="$wrapper_e2e_cmd" \
  "$GATE")"
assert_eq "host wrapper payload executes end-to-end with session preserved" "wrapped-ok:sess-wrap-e2e" "$wrap_out"

# ─── 2. Heavy 2-Slot Concurrency Control + Light Unblocked ────────────────────
printf '\n=== 2. Heavy 2-Slot Concurrency Control ===\n'

SLOTS_2="${TMP_ROOT}/slots-2"
STATE_2="${TMP_ROOT}/state-2"
mkdir -p "$STATE_2"
printf '0\n' > "${STATE_2}/cur"
printf '0\n' > "${STATE_2}/max"

HEAVY_WORKER="${TMP_ROOT}/heavy-worker.sh"
cat > "$HEAVY_WORKER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
(
  flock -x 200
  cur=\$(cat "${STATE_2}/cur")
  max=\$(cat "${STATE_2}/max")
  cur=\$((cur + 1))
  printf '%d\n' "\$cur" > "${STATE_2}/cur"
  if (( cur > max )); then
    printf '%d\n' "\$cur" > "${STATE_2}/max"
  fi
) 200>"${STATE_2}/cnt.lock"
sleep 0.45
(
  flock -x 200
  cur=\$(cat "${STATE_2}/cur")
  cur=\$((cur - 1))
  printf '%d\n' "\$cur" > "${STATE_2}/cur"
) 200>"${STATE_2}/cnt.lock"
EOF
chmod +x "$HEAVY_WORKER"

pids=()
for i in 1 2 3 4; do
  env -u OC_HOST_GATE_ACTIVE \
    OC_HOST_GATE_SLOTS_DIR="$SLOTS_2" \
    OC_HOST_HEAVY_SLOTS=2 \
    OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
    OC_HOST_MIN_AVAIL_MB=2500 \
    OC_HOST_WAIT_TIMEOUT_SEC=15 \
    OC_HOST_POLL_INTERVAL_SEC=0.05 \
    OC_HOST_SYSTEMD_RUN_BIN=none \
    OC_CALLER_SESSION="conc-$i" \
    SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy ${HEAVY_WORKER}" \
    "$GATE" &
  pids+=($!)
done

sleep 0.15

t0_ms="$(date +%s%3N)"
light_out="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_2" \
  OC_HOST_HEAVY_SLOTS=2 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="echo light-fast" \
  "$GATE")"
t1_ms="$(date +%s%3N)"
light_elapsed_ms=$(( t1_ms - t0_ms ))

assert_eq "light command succeeds during heavy saturation" "light-fast" "$light_out"
if (( light_elapsed_ms < 350 )); then
  pass "light command unblocked during heavy saturation (${light_elapsed_ms}ms < 350ms)"
else
  fail "light command was unexpectedly delayed (${light_elapsed_ms}ms)"
fi

all_ok=1
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    all_ok=0
  fi
done
assert_eq "all 4 concurrent heavy jobs succeeded" "1" "$all_ok"

peak="$(cat "${STATE_2}/max")"
if (( peak <= 2 && peak >= 1 )); then
  pass "heavy concurrency bounded <= 2 (peak=${peak})"
else
  fail "heavy concurrency exceeded bound (peak=${peak})"
fi

# ─── 3. Slot Timeout Fail-Fast & Secret Redaction + File Perms (Blocker 5) ───
printf '\n=== 3. Slot Timeout Fail-Fast & Secret Redaction (0700/0600) ===\n'

SLOTS_3="${TMP_ROOT}/slots-3"
FAKE_BIN_3="${TMP_ROOT}/fake-bin-3"
mkdir -p "$FAKE_BIN_3"
# Mock npx so holder actually sleeps while classified as heavy 'npx:tsc'
cat > "${FAKE_BIN_3}/npx" <<'EOF'
#!/usr/bin/env bash
sleep 6
EOF
chmod +x "${FAKE_BIN_3}/npx"

holder_pids=()
for i in 1 2; do
  env -u OC_HOST_GATE_ACTIVE \
    PATH="${FAKE_BIN_3}:$PATH" \
    OC_HOST_GATE_SLOTS_DIR="$SLOTS_3" \
    OC_HOST_HEAVY_SLOTS=2 \
    OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
    OC_HOST_MIN_AVAIL_MB=2500 \
    OC_HOST_WAIT_TIMEOUT_SEC=10 \
    OC_HOST_POLL_INTERVAL_SEC=0.05 \
    OC_HOST_SYSTEMD_RUN_BIN=none \
    OC_CALLER_SESSION="holder-sess-${i}" \
    SSH_ORIGINAL_COMMAND="SECRET_TOKEN=supersecret_12345 npx tsc -b --token=my_secret_xyz" \
    "$GATE" &
  holder_pids+=($!)
done

for _ in $(seq 1 40); do
  [[ -f "${SLOTS_3}/heavy-1.meta" && -f "${SLOTS_3}/heavy-2.meta" ]] && break
  sleep 0.05
done

# Verify 0700 dir and 0600 meta permissions + secret redaction in .meta
slots_dir_mode="$(stat -c '%a' "$SLOTS_3")"
meta1_mode="$(stat -c '%a' "${SLOTS_3}/heavy-1.meta")"
meta1_body="$(cat "${SLOTS_3}/heavy-1.meta")"

assert_eq "SLOTS_DIR has private mode 700" "700" "$slots_dir_mode"
assert_eq "heavy-1.meta has private mode 600" "600" "$meta1_mode"
assert_contains "heavy-1.meta contains sanitized cmd_kind=npx:tsc" "cmd_kind=npx:tsc" "$meta1_body"
assert_contains "heavy-1.meta contains job_id=g-" "job_id=g-" "$meta1_body"
assert_not_contains "heavy-1.meta MUST NOT leak SECRET_TOKEN value" "supersecret_12345" "$meta1_body"
assert_not_contains "heavy-1.meta MUST NOT leak --token flag value" "my_secret_xyz" "$meta1_body"

rc3=0
err3="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_3" \
  OC_HOST_HEAVY_SLOTS=2 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_MIN_AVAIL_MB=2500 \
  OC_HOST_WAIT_TIMEOUT_SEC=1 \
  OC_HOST_POLL_INTERVAL_SEC=0.1 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  OC_CALLER_SESSION="blocked-sess" \
  SSH_ORIGINAL_COMMAND="SECRET_TOKEN=caller_secret_999 npx tsc -b --token=caller_tok_888" \
  "$GATE" 2>&1 >/dev/null)" || rc3=$?

for pid in "${holder_pids[@]}"; do
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
done

assert_eq "3rd heavy task exits with EX_TEMPFAIL (75)" "75" "$rc3"
assert_contains "stderr reports slot_busy" "slot_busy" "$err3"
assert_contains "stderr includes holder pid=" "pid=" "$err3"
assert_contains "stderr includes holder session" "holder-sess-1" "$err3"
assert_contains "stderr includes holder job_id=" "job_id=g-" "$err3"
assert_contains "stderr includes sanitized holder cmd_kind (tsc)" "tsc" "$err3"
assert_not_contains "stderr MUST NOT leak holder secret env value" "supersecret_12345" "$err3"
assert_not_contains "stderr MUST NOT leak holder --token flag value" "my_secret_xyz" "$err3"
assert_not_contains "stderr MUST NOT leak caller secret env value" "caller_secret_999" "$err3"
assert_not_contains "stderr MUST NOT leak caller --token flag value" "caller_tok_888" "$err3"

# ─── 4. Low Memory Watermark Rejection & Guardrail Anti-Bypass ────────────────
printf '\n=== 4. Low Memory Watermark & Guardrail Anti-Bypass ===\n'

SLOTS_4="${TMP_ROOT}/slots-4"

rc4_heavy=0
err4="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_4" \
  OC_HOST_HEAVY_SLOTS=2 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_LOW" \
  OC_HOST_MIN_AVAIL_MB=2500 \
  OC_HOST_WAIT_TIMEOUT_SEC=1 \
  OC_HOST_POLL_INTERVAL_SEC=0.1 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy echo blocked-by-mem" \
  "$GATE" 2>&1 >/dev/null)" || rc4_heavy=$?

assert_eq "heavy rejected under low memory with rc=75" "75" "$rc4_heavy"
assert_contains "low-mem stderr includes low_memory" "low_memory" "$err4"
assert_contains "low-mem stderr includes MemAvailable value (1000)" "1000" "$err4"
assert_contains "low-mem stderr includes threshold (2500)" "2500" "$err4"

rc4_light=0
out4_light="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_4" \
  OC_HOST_HEAVY_SLOTS=2 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_LOW" \
  OC_HOST_MIN_AVAIL_MB=2500 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="echo light-ok-under-low-mem" \
  "$GATE")" || rc4_light=$?

assert_eq "light succeeds under low memory (rc=0)" "0" "$rc4_light"
assert_eq "light output intact under low memory" "light-ok-under-low-mem" "$out4_light"

# Security: container inline env vars MUST NOT bypass host guardrails
rc4_bypass_mem=0
err4_bypass_mem="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_4" \
  OC_HOST_HEAVY_SLOTS=2 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_LOW" \
  OC_HOST_MIN_AVAIL_MB=2500 \
  OC_HOST_WAIT_TIMEOUT_SEC=1 \
  OC_HOST_POLL_INTERVAL_SEC=0.1 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_MIN_AVAIL_MB=0 OC_HOST_HEAVY_SLOTS=16 OC_HOST_CLASS=light npx tsc -b" \
  "$GATE" 2>&1 >/dev/null)" || rc4_bypass_mem=$?

assert_eq "inline MIN_AVAIL_MB=0 + HEAVY_SLOTS=16 + CLASS=light cannot bypass low-mem guardrail (rc=75)" "75" "$rc4_bypass_mem"
assert_contains "bypass attempt still reports low_memory" "low_memory" "$err4_bypass_mem"
assert_contains "bypass attempt still enforces host threshold (2500)" "2500" "$err4_bypass_mem"

SLOTS_4B="${TMP_ROOT}/slots-4b"
env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_4B" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=5 \
  OC_HOST_POLL_INTERVAL_SEC=0.05 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy sleep 5" \
  "$GATE" &
pid_4b_holder=$!
for _ in $(seq 1 40); do
  [[ -f "${SLOTS_4B}/heavy-1.meta" ]] && break
  sleep 0.05
done

rc4_bypass_slot=0
err4_bypass_slot="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_4B" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=1 \
  OC_HOST_POLL_INTERVAL_SEC=0.1 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_HEAVY_SLOTS=16 OC_HOST_GATE_SLOTS_DIR=${TMP_ROOT}/evil-slots npx tsc -b" \
  "$GATE" 2>&1 >/dev/null)" || rc4_bypass_slot=$?

kill -TERM "$pid_4b_holder" 2>/dev/null || true
wait "$pid_4b_holder" 2>/dev/null || true

assert_eq "inline HEAVY_SLOTS=16 / SLOTS_DIR cannot bypass host slot cap (rc=75)" "75" "$rc4_bypass_slot"
assert_contains "slot bypass attempt still reports slot_busy" "slot_busy" "$err4_bypass_slot"

# ─── 5. NODE_OPTIONS Default Injection vs Existing Override ───────────────────
printf '\n=== 5. NODE_OPTIONS Injection ===\n'

SLOTS_5="${TMP_ROOT}/slots-5"

node_opt_default="$(env -u OC_HOST_GATE_ACTIVE -u NODE_OPTIONS \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_5" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_DEFAULT_NODE_MAX_OLD_SPACE_MB=3072 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND='OC_HOST_CLASS=heavy printf "%s" "$NODE_OPTIONS"' \
  "$GATE")"
assert_eq "NODE_OPTIONS injects default --max-old-space-size=3072" "--max-old-space-size=3072" "$node_opt_default"

node_opt_append="$(env -u OC_HOST_GATE_ACTIVE \
  NODE_OPTIONS="--enable-source-maps" \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_5" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_DEFAULT_NODE_MAX_OLD_SPACE_MB=3072 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND='OC_HOST_CLASS=heavy printf "%s" "$NODE_OPTIONS"' \
  "$GATE")"
assert_eq "NODE_OPTIONS appends to existing flags" "--enable-source-maps --max-old-space-size=3072" "$node_opt_append"

node_opt_env_keep="$(env -u OC_HOST_GATE_ACTIVE \
  NODE_OPTIONS="--max-old-space-size=4096" \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_5" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_DEFAULT_NODE_MAX_OLD_SPACE_MB=3072 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND='OC_HOST_CLASS=heavy printf "%s" "$NODE_OPTIONS"' \
  "$GATE")"
assert_eq "NODE_OPTIONS preserves existing env --max-old-space-size=4096" "--max-old-space-size=4096" "$node_opt_env_keep"

node_opt_cmd_keep="$(env -u OC_HOST_GATE_ACTIVE -u NODE_OPTIONS \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_5" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_DEFAULT_NODE_MAX_OLD_SPACE_MB=3072 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND='OC_HOST_CLASS=heavy printf "%s" "${NODE_OPTIONS:-unset}" # --max-old-space-size=4096' \
  "$GATE")"
assert_eq "NODE_OPTIONS not injected when command specifies --max-old-space-size" "unset" "$node_opt_cmd_keep"

# ─── 6. Nested Re-entrancy Guard (OC_HOST_GATE_ACTIVE=1) ──────────────────────
printf '\n=== 6. Nested Re-entrancy Guard ===\n'

SLOTS_6="${TMP_ROOT}/slots-6"

rc6=0
out6="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_6" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=1 \
  OC_HOST_POLL_INTERVAL_SEC=0.1 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy SSH_ORIGINAL_COMMAND='OC_HOST_CLASS=heavy echo nested-ok' \"${GATE}\"" \
  "$GATE")" || rc6=$?

assert_eq "nested heavy invocation exits 0 without deadlock" "0" "$rc6"
assert_eq "nested heavy invocation returns expected output" "nested-ok" "$out6"

# ─── 7. SIGTERM, SIGKILL Orphan Quota & OC_HOST_DETACH=1 Quota (Blocker 3) ───
printf '\n=== 7. SIGTERM / SIGKILL / OC_HOST_DETACH=1 Quota Persistence ===\n'

SLOTS_7="${TMP_ROOT}/slots-7"

# 7a: SIGTERM cleanly reaps child + grandchild via setsid PGID and frees slot
GRANDCHILD_PID_FILE="${TMP_ROOT}/sigterm-grandchild.pid"
env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_7" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=5 \
  OC_HOST_POLL_INTERVAL_SEC=0.05 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy bash -c 'sleep 30 & echo \$! > \"${GRANDCHILD_PID_FILE}\"; wait'" \
  "$GATE" &
pid_term=$!

for _ in $(seq 1 40); do
  [[ -f "${SLOTS_7}/heavy-1.meta" && -s "$GRANDCHILD_PID_FILE" ]] && break
  sleep 0.05
done

gc_pid="$(cat "$GRANDCHILD_PID_FILE")"
kill -TERM "$pid_term" 2>/dev/null || true
wait "$pid_term" 2>/dev/null || true

sleep 0.1
if ! kill -0 "$gc_pid" 2>/dev/null; then
  pass "fallback SIGTERM cleanly reaps grandchild process (pid=${gc_pid})"
else
  kill -KILL "$gc_pid" 2>/dev/null || true
  fail "fallback SIGTERM left orphan grandchild alive (pid=${gc_pid})"
fi

rc7a=0
out7a="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_7" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=1 \
  OC_HOST_POLL_INTERVAL_SEC=0.05 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy echo after-sigterm" \
  "$GATE")" || rc7a=$?

assert_eq "slot immediately available after SIGTERM (rc=0)" "0" "$rc7a"
assert_eq "output after SIGTERM" "after-sigterm" "$out7a"

# 7b: SIGKILL while child is STILL alive -> slot MUST stay accounted (rc=75 slot_busy)
# until surviving child actually exits; then next request immediately succeeds (rc=0)!
SLOTS_7B="${TMP_ROOT}/slots-7b"
ORPHAN_PID_FILE="${TMP_ROOT}/sigkill-orphan.pid"
env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_7B" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=5 \
  OC_HOST_POLL_INTERVAL_SEC=0.05 \
  OC_HOST_WATCHDOG_INTERVAL_SEC=60 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  OC_CALLER_SESSION="orphan-sess" \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy sh -c 'echo \$\$ > \"${ORPHAN_PID_FILE}\"; exec sleep 30'" \
  "$GATE" &
pid_kill=$!

for _ in $(seq 1 40); do
  [[ -f "${SLOTS_7B}/heavy-1.meta" && -s "$ORPHAN_PID_FILE" ]] && grep -q 'child_pid=[0-9]' "${SLOTS_7B}/heavy-1.meta" && break
  sleep 0.05
done

orphan_pid="$(cat "$ORPHAN_PID_FILE")"
kill -KILL "$pid_kill" 2>/dev/null || true
wait "$pid_kill" 2>/dev/null || true

# While orphan child is still alive, a 2nd heavy task MUST be rejected with rc=75 slot_busy
rc7b_blocked=0
err7b_blocked="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_7B" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=1 \
  OC_HOST_POLL_INTERVAL_SEC=0.1 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy echo blocked-by-orphan" \
  "$GATE" 2>&1 >/dev/null)" || rc7b_blocked=$?

assert_eq "surviving child after gate SIGKILL still holds quota (rc=75)" "75" "$rc7b_blocked"
assert_contains "orphan block reports slot_busy" "slot_busy" "$err7b_blocked"
assert_contains "orphan block lists orphaned holder session" "orphan-sess" "$err7b_blocked"
assert_contains "orphan block reports state=orphaned" "state=orphaned" "$err7b_blocked"

# Now terminate the surviving orphan child -> next heavy task MUST succeed immediately!
kill -KILL "$orphan_pid" 2>/dev/null || true
for _ in $(seq 1 20); do
  kill -0 "$orphan_pid" 2>/dev/null || break
  sleep 0.05
done

rc7b_ok=0
out7b_ok="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_7B" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=1 \
  OC_HOST_POLL_INTERVAL_SEC=0.05 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy echo after-orphan-exit" \
  "$GATE")" || rc7b_ok=$?

assert_eq "slot immediately reclaimed once orphaned child exits (rc=0)" "0" "$rc7b_ok"
assert_eq "output after orphan exit" "after-orphan-exit" "$out7b_ok"

# 7c: Watchdog takes over and reaps child when gate is SIGKILLed (fast watchdog interval)
SLOTS_7C="${TMP_ROOT}/slots-7c"
WD_CHILD_PID_FILE="${TMP_ROOT}/wd-sigkill-child.pid"
env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_7C" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=5 \
  OC_HOST_POLL_INTERVAL_SEC=0.05 \
  OC_HOST_WATCHDOG_INTERVAL_SEC=0.1 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy sh -c 'echo \$\$ > \"${WD_CHILD_PID_FILE}\"; exec sleep 30'" \
  "$GATE" &
pid_wd_kill=$!

for _ in $(seq 1 40); do
  [[ -f "${SLOTS_7C}/heavy-1.meta" && -s "$WD_CHILD_PID_FILE" ]] && grep -q 'child_pid=[0-9]' "${SLOTS_7C}/heavy-1.meta" && break
  sleep 0.05
done

wd_child_pid="$(cat "$WD_CHILD_PID_FILE")"
kill -KILL "$pid_wd_kill" 2>/dev/null || true
wait "$pid_wd_kill" 2>/dev/null || true

wd_reaped=0
for _ in $(seq 1 30); do
  if ! kill -0 "$wd_child_pid" 2>/dev/null; then
    wd_reaped=1
    break
  fi
  sleep 0.1
done
if (( ! wd_reaped )); then
  kill -KILL "$wd_child_pid" 2>/dev/null || true
fi
assert_eq "watchdog takes over after gate SIGKILL and reaps orphan child" "1" "$wd_reaped"

# 7d: OC_HOST_DETACH=1 heavy task stays accounted in quota after gate SIGTERM until child exits
SLOTS_7D="${TMP_ROOT}/slots-7d"
DETACH_PID_FILE="${TMP_ROOT}/detach-child.pid"
env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_7D" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=5 \
  OC_HOST_POLL_INTERVAL_SEC=0.05 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  OC_CALLER_SESSION="detach-sess" \
  SSH_ORIGINAL_COMMAND="OC_HOST_DETACH=1 OC_HOST_CLASS=heavy sh -c 'echo \$\$ > \"${DETACH_PID_FILE}\"; exec sleep 30'" \
  "$GATE" &
pid_detach_gate=$!

for _ in $(seq 1 40); do
  [[ -f "${SLOTS_7D}/heavy-1.meta" && -s "$DETACH_PID_FILE" ]] && grep -q 'child_pid=[0-9]' "${SLOTS_7D}/heavy-1.meta" && break
  sleep 0.05
done

detach_child_pid="$(cat "$DETACH_PID_FILE")"
kill -TERM "$pid_detach_gate" 2>/dev/null || true
wait "$pid_detach_gate" 2>/dev/null || true

# Detached child must still be alive AND still blocking slot 1
if kill -0 "$detach_child_pid" 2>/dev/null; then
  pass "OC_HOST_DETACH=1 child survives gate SIGTERM"
else
  fail "OC_HOST_DETACH=1 child was unexpectedly killed by gate SIGTERM"
fi

rc7d_blocked=0
err7d_blocked="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_7D" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=1 \
  OC_HOST_POLL_INTERVAL_SEC=0.1 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy echo blocked-by-detach" \
  "$GATE" 2>&1 >/dev/null)" || rc7d_blocked=$?

assert_eq "OC_HOST_DETACH=1 surviving child still holds heavy quota (rc=75)" "75" "$rc7d_blocked"
assert_contains "detach block reports slot_busy" "slot_busy" "$err7d_blocked"
assert_contains "detach block reports state=detached" "state=detached" "$err7d_blocked"
assert_contains "detach block lists detached session" "detach-sess" "$err7d_blocked"

# Stop detached child -> next heavy task immediately succeeds
kill -KILL "$detach_child_pid" 2>/dev/null || true
for _ in $(seq 1 20); do
  kill -0 "$detach_child_pid" 2>/dev/null || break
  sleep 0.05
done

rc7d_ok=0
out7d_ok="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_7D" \
  OC_HOST_HEAVY_SLOTS=1 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_WAIT_TIMEOUT_SEC=1 \
  OC_HOST_POLL_INTERVAL_SEC=0.05 \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy echo after-detach-exit" \
  "$GATE")" || rc7d_ok=$?

assert_eq "slot reclaimed immediately after detached child exits (rc=0)" "0" "$rc7d_ok"
assert_eq "output after detached child exit" "after-detach-exit" "$out7d_ok"

# ─── 8. Mock systemd-run Argument & OOM Verification ──────────────────────────
printf '\n=== 8. Mock systemd-run Verification ===\n'

SLOTS_8="${TMP_ROOT}/slots-8"
SR_LOG="${TMP_ROOT}/systemd-run.args"
MOCK_SR="${TMP_ROOT}/mock-systemd-run"
cat > "$MOCK_SR" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" > "${SR_LOG}"
while [[ \$# -gt 0 ]]; do
  if [[ "\$1" == "--" ]]; then
    shift
    break
  fi
  shift
done
exec "\$@"
EOF
chmod +x "$MOCK_SR"

OOM_ADJ_MOCK_SR="${TMP_ROOT}/oom_score_adj.sr"
rc8=0
out8="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_8" \
  OC_HOST_HEAVY_SLOTS=2 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_SLICE="oc-host-cmd.slice" \
  OC_HOST_SYSTEMD_RUN_BIN="$MOCK_SR" \
  OC_HOST_OOM_SCORE_ADJ_FILE="$OOM_ADJ_MOCK_SR" \
  OC_CALLER_SESSION="sr-sess" \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy OC_HOST_SYSTEMD_RUN_BIN=none echo via-systemd-run" \
  "$GATE")" || rc8=$?

sr_args="$(cat "$SR_LOG")"
oom_sr_val="$(cat "$OOM_ADJ_MOCK_SR")"
assert_eq "mock systemd-run execution succeeded" "0" "$rc8"
assert_eq "mock systemd-run stdout intact" "via-systemd-run" "$out8"
assert_contains "systemd-run passed --quiet" "--quiet" "$sr_args"
assert_contains "systemd-run passed --scope" "--scope" "$sr_args"
assert_contains "systemd-run passed --expand-environment=no" "--expand-environment=no" "$sr_args"
assert_contains "systemd-run passed --slice=oc-host-cmd.slice" "--slice=oc-host-cmd.slice" "$sr_args"
assert_contains "systemd-run passed --property=OOMPolicy=kill" "--property=OOMPolicy=kill" "$sr_args"
assert_not_contains "systemd-run MUST NOT pass --property=OOMScoreAdjust=" "--property=OOMScoreAdjust=" "$sr_args"
assert_contains "systemd-run passed --unit=oc-host-cmd-heavy-" "--unit=oc-host-cmd-heavy-" "$sr_args"
assert_contains "systemd-run passed --description with caller session" "sr-sess" "$sr_args"
assert_eq "systemd-run branch writes oom_score_adj=500 before exec" "500" "$oom_sr_val"

OOM_ADJ_MOCK_FB="${TMP_ROOT}/oom_score_adj.fb"
rc8_fb=0
out8_fb="$(env -u OC_HOST_GATE_ACTIVE \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_8" \
  OC_HOST_HEAVY_SLOTS=2 \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  OC_HOST_OOM_SCORE_ADJ_FILE="$OOM_ADJ_MOCK_FB" \
  SSH_ORIGINAL_COMMAND="OC_HOST_CLASS=heavy echo via-fallback" \
  "$GATE")" || rc8_fb=$?
oom_fb_val="$(cat "$OOM_ADJ_MOCK_FB")"
assert_eq "fallback branch execution succeeded" "0" "$rc8_fb"
assert_eq "fallback branch stdout intact" "via-fallback" "$out8_fb"
assert_eq "fallback branch writes oom_score_adj=500 before exec" "500" "$oom_fb_val"

# ─── 9. authorized_keys Idempotent Upgrade Test ───────────────────────────────
printf '\n=== 9. selfhost-setup-host-access.sh --gate-only & authorized_keys ===\n'

T9="${TMP_ROOT}/t9"
mkdir -p "${T9}/ssh" "${T9}/bin" "${T9}/local/bin"

CONTAINER_KEY="${T9}/ssh/oc-v5-selfhost-container"
CONTAINER_PUB_LINE="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIContainer+Test/Key+Blob000000000000000000001= oc-v5-selfhost admin container -> host"
printf '%s\n' "$CONTAINER_PUB_LINE" > "${CONTAINER_KEY}.pub"

HUMAN_1="# Human ops keys - do not modify"
HUMAN_2="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHuman+Key/One11111111111111111111111111111111 alice@ops"
HUMAN_3="ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCHuman+Rsa/KeyTwo2222222222222222222222222222222 bob@laptop"
HUMAN_4='no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHumanKeyThree333333333333333333333333333333333 carol@ci'
HUMAN_5='command="/usr/local/bin/other-tool" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHumanKeyFour4444444444444444444444444444444444 dave@bastion'

AUTH_FILE="${T9}/ssh/authorized_keys"
cat > "$AUTH_FILE" <<EOF
${HUMAN_1}
${HUMAN_2}
${HUMAN_3}
${CONTAINER_PUB_LINE}
${HUMAN_4}

${HUMAN_5}
EOF
chmod 600 "$AUTH_FILE"
cp "$AUTH_FILE" "${T9}/auth.orig"

GATE_DST="${T9}/bin/oc-host-cmd-gate"
WRAPPER_DST="${T9}/local/bin/host"

# 9a: Dry-run must not touch files
OC_SETUP_KEY="$CONTAINER_KEY" \
OC_SETUP_AUTH="$AUTH_FILE" \
OC_SETUP_GATE_SRC="$GATE" \
OC_SETUP_GATE_DST="$GATE_DST" \
OC_SETUP_WRAPPER_DST="$WRAPPER_DST" \
  bash "$SETUP" --gate-only --dry-run >/dev/null

if cmp -s "${T9}/auth.orig" "$AUTH_FILE" && [[ ! -e "$GATE_DST" ]]; then
  pass "dry-run leaves authorized_keys and gate dst untouched"
else
  fail "dry-run unexpectedly modified files"
fi

# 9b: First --apply upgrades exact container key line & installs gate + wrapper
OC_SETUP_KEY="$CONTAINER_KEY" \
OC_SETUP_AUTH="$AUTH_FILE" \
OC_SETUP_GATE_SRC="$GATE" \
OC_SETUP_GATE_DST="$GATE_DST" \
OC_SETUP_WRAPPER_DST="$WRAPPER_DST" \
  bash "$SETUP" --gate-only --apply >/dev/null

if [[ -x "$GATE_DST" ]] && cmp -s "$GATE" "$GATE_DST"; then
  pass "gate installed atomically with +x and exact content"
else
  fail "gate installation mismatch"
fi

if [[ -x "$WRAPPER_DST" ]] && grep -q 'OC_HOST_CLASS' "$WRAPPER_DST" && grep -q 'setsid -w' "$WRAPPER_DST"; then
  pass "host wrapper synced with setsid -w and OC_HOST_CLASS passthrough"
else
  fail "host wrapper missing expected content"
fi

auth_mode="$(stat -c '%a' "$AUTH_FILE")"
assert_eq "authorized_keys preserves chmod 600" "600" "$auth_mode"

bak_count="$(find "${T9}/ssh" -maxdepth 1 -name 'authorized_keys.bak.*' | wc -l)"
assert_eq "backup file created on authorized_keys rewrite" "1" "$bak_count"

EXPECTED_AUTH="${T9}/auth.expected"
cat > "$EXPECTED_AUTH" <<EOF
${HUMAN_1}
${HUMAN_2}
${HUMAN_3}
command="/usr/local/bin/oc-host-cmd-gate" ${CONTAINER_PUB_LINE}
${HUMAN_4}

${HUMAN_5}
EOF

if cmp -s "$EXPECTED_AUTH" "$AUTH_FILE"; then
  pass "authorized_keys matches expected byte-for-byte (4 human keys untouched)"
else
  fail "authorized_keys diff from expected:"
  diff -u "$EXPECTED_AUTH" "$AUTH_FILE" >&2 || true
fi

# 9c: Second --apply is strictly idempotent (no duplicate prefix, no extra backup)
cp "$AUTH_FILE" "${T9}/auth.after1"
OC_SETUP_KEY="$CONTAINER_KEY" \
OC_SETUP_AUTH="$AUTH_FILE" \
OC_SETUP_GATE_SRC="$GATE" \
OC_SETUP_GATE_DST="$GATE_DST" \
OC_SETUP_WRAPPER_DST="$WRAPPER_DST" \
  bash "$SETUP" --gate-only --apply >/dev/null

if cmp -s "${T9}/auth.after1" "$AUTH_FILE"; then
  pass "second --apply is strictly idempotent (no duplicate command= prefix)"
else
  fail "second --apply mutated authorized_keys"
fi

bak_count_2="$(find "${T9}/ssh" -maxdepth 1 -name 'authorized_keys.bak.*' | wc -l)"
assert_eq "second --apply does not create extra backup" "1" "$bak_count_2"

# 9d: Non-leading existing command="..." is replaced in-place with zero duplication
AUTH_NONLEAD="${T9}/ssh/authorized_keys_nonlead"
cat > "$AUTH_NONLEAD" <<EOF
${HUMAN_2}
no-pty,command="/old/cmd",no-X11-forwarding ${CONTAINER_PUB_LINE}
${HUMAN_5}
EOF
chmod 600 "$AUTH_NONLEAD"

OC_SETUP_KEY="$CONTAINER_KEY" \
OC_SETUP_AUTH="$AUTH_NONLEAD" \
OC_SETUP_GATE_SRC="$GATE" \
OC_SETUP_GATE_DST="$GATE_DST" \
  bash "$SETUP" --gate-only --apply >/dev/null

EXPECTED_NONLEAD="${T9}/auth.nonlead.expected"
cat > "$EXPECTED_NONLEAD" <<EOF
${HUMAN_2}
no-pty,command="/usr/local/bin/oc-host-cmd-gate",no-X11-forwarding ${CONTAINER_PUB_LINE}
${HUMAN_5}
EOF

if cmp -s "$EXPECTED_NONLEAD" "$AUTH_NONLEAD"; then
  pass "non-leading command=\"/old/cmd\" replaced in-place without duplicate command="
else
  fail "non-leading command= replacement diff:"
  diff -u "$EXPECTED_NONLEAD" "$AUTH_NONLEAD" >&2 || true
fi

# Re-running on already-replaced non-leading command= must be strictly idempotent
cp "$AUTH_NONLEAD" "${T9}/auth.nonlead.after1"
OC_SETUP_KEY="$CONTAINER_KEY" \
OC_SETUP_AUTH="$AUTH_NONLEAD" \
OC_SETUP_GATE_SRC="$GATE" \
OC_SETUP_GATE_DST="$GATE_DST" \
  bash "$SETUP" --gate-only --apply >/dev/null
if cmp -s "${T9}/auth.nonlead.after1" "$AUTH_NONLEAD"; then
  pass "non-leading command= second --apply is strictly idempotent"
else
  fail "non-leading command= second --apply mutated file"
fi

# 9e: Missing container key is appended with command= prefix while keeping existing keys intact
AUTH_FILE_APPEND="${T9}/ssh/authorized_keys_append"
cat > "$AUTH_FILE_APPEND" <<EOF
${HUMAN_2}
${HUMAN_5}
EOF
chmod 600 "$AUTH_FILE_APPEND"

OC_SETUP_KEY="$CONTAINER_KEY" \
OC_SETUP_AUTH="$AUTH_FILE_APPEND" \
OC_SETUP_GATE_SRC="$GATE" \
OC_SETUP_GATE_DST="$GATE_DST" \
  bash "$SETUP" --gate-only --apply >/dev/null

EXPECTED_APPEND="${T9}/auth.append.expected"
cat > "$EXPECTED_APPEND" <<EOF
${HUMAN_2}
${HUMAN_5}
command="/usr/local/bin/oc-host-cmd-gate" ${CONTAINER_PUB_LINE}
EOF

if cmp -s "$EXPECTED_APPEND" "$AUTH_FILE_APPEND"; then
  pass "missing container key appended with command= prefix preserving existing keys"
else
  fail "append mode diff from expected"
  diff -u "$EXPECTED_APPEND" "$AUTH_FILE_APPEND" >&2 || true
fi

# 9f: R2 #5 — Real rendered host wrapper redacts secrets in syslog & routes end-to-end through gate
sh -n "$WRAPPER_DST" && pass "rendered host wrapper passes POSIX sh -n" || fail "rendered host wrapper failed sh -n"

MOCK_SSH_CAPTURE="${T9}/captured-remote-wrap.txt"
MOCK_SSH_BIN="${T9}/mock-ssh"
cat > "$MOCK_SSH_BIN" <<EOF
#!/usr/bin/env bash
# Capture the last argument (REMOTE_WRAP) passed by host wrapper to ssh
printf '%s' "\${!#}" > "${MOCK_SSH_CAPTURE}"
EOF
chmod +x "$MOCK_SSH_BIN"

OC_HOST_SSH_BIN="$MOCK_SSH_BIN" \
OC_SESSION_ID="wrap-r2-sess" \
  "$WRAPPER_DST" 'SECRET_TOKEN=supersecret_999 npx tsc -b --token=secret_abc'

captured_wrap="$(cat "$MOCK_SSH_CAPTURE")"
logger_segment="${captured_wrap%%_OC_B64_CMD=*}"

assert_contains "real host wrapper logs sanitized cmd_head=npx" "cmd_head=npx" "$logger_segment"
assert_contains "real host wrapper logs bytes= count" "bytes=" "$logger_segment"
assert_not_contains "real host wrapper logger MUST NOT leak SECRET_TOKEN value" "supersecret_999" "$logger_segment"
assert_not_contains "real host wrapper logger MUST NOT leak --token flag value" "secret_abc" "$logger_segment"

# Verify gate classifies the real rendered wrapper payload as HEAVY and executes end-to-end
real_wrap_class="$(env -u OC_HOST_CLASS -u OC_HOST_GATE_ACTIVE "$GATE" --classify "$captured_wrap")"
assert_eq "real rendered host wrapper (npx tsc -b) classified as heavy by gate" "heavy" "$real_wrap_class"

FAKE_NPX_T9="${T9}/fake-npx-bin"
mkdir -p "$FAKE_NPX_T9"
cat > "${FAKE_NPX_T9}/npx" <<'EOF'
#!/usr/bin/env bash
printf 'E2E_NPX:%s:%s' "${SECRET_TOKEN:-unset}" "$*"
EOF
chmod +x "${FAKE_NPX_T9}/npx"

SLOTS_T9="${T9}/slots-t9"
e2e_wrap_out="$(env -u OC_HOST_GATE_ACTIVE \
  PATH="${FAKE_NPX_T9}:$PATH" \
  OC_HOST_GATE_SLOTS_DIR="$SLOTS_T9" \
  OC_HOST_MEMINFO_FILE="$MEMINFO_OK" \
  OC_HOST_SYSTEMD_RUN_BIN=none \
  SSH_ORIGINAL_COMMAND="$captured_wrap" \
  "$GATE")"
assert_eq "real rendered host wrapper executes end-to-end through gate with env & args intact" \
  "E2E_NPX:supersecret_999:tsc -b --token=secret_abc" "$e2e_wrap_out"

# ─── Summary ──────────────────────────────────────────────────────────────────
printf '\n=== Summary: %d passed, %d failed ===\n' "$PASS" "$FAIL"
if (( FAIL > 0 )); then
  exit 1
fi
