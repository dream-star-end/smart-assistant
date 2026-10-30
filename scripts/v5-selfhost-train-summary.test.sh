#!/usr/bin/env bash
# OCV5-539: the train summary recorder (scripts/lib/v5-selfhost-train-summary.sh) and its wiring.
# Record only: these tests prove it writes a complete summary.json and never changes the train's
# control flow or exit code. Usage: bash scripts/v5-selfhost-train-summary.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib/v5-selfhost-train-summary.sh"
DEPLOY="$SCRIPT_DIR/deploy-v5-selfhost.sh"
MLIB="$SCRIPT_DIR/v5-selfhost-master-release-lib.sh"
command -v jq >/dev/null || { echo "need jq" >&2; exit 2; }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1" >&2; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null; then ok "$name"; else bad "$name"; fi; }

# Runs a snippet the way the deploy script runs: strict mode plus an ERR trap that would show any
# failing command inside the recorder.
run() { # <dir> <snippet>
  local dir="$1"; shift
  env -i PATH="$PATH" HOME="$T" OC_V5_TRAIN_SUMMARY_DIR="$dir" bash -c "
    set -Eeuo pipefail
    trap 'echo \"ERR at \$LINENO: \$BASH_COMMAND\" >&2; exit 99' ERR
    DRY=0
    source '$LIB'
    $*"
}
S() { echo "$1/tr-20990101T000000Z-abc123.summary.json"; }
TID=tr-20990101T000000Z-abc123

# 1. A full successful train: phases contiguous, durations add up, final summary valid.
d="$T/ok"; mkdir -p "$d"
out="$(run "$d" "
  LEASE_TRAIN_ID=$TID LEASE_TARGET_SHA=0123456789abcdef0123456789abcdef01234567
  MASTER_DEPS_MODE=hardlink MASTER_FRONTEND_MODE=reused
  tsum_init 2>/dev/null || :
  tsum_mark B 2>/dev/null || :; sleep 0.05
  tsum_mark C.box-success-recovery 2>/dev/null || :; sleep 0.05
  tsum_mark D 2>/dev/null || :
  jq -e '.final == false and .result == \"running\" and .phases[-1].id == \"D\" and .phases[-1].endMs == null' '$(S "$d")' >/dev/null
  tsum_mark G 2>/dev/null || :
  tsum_finish 0 2>/dev/null || :
  echo finished" 2>&1)"
check "successful train runs to the end without tripping set -e/ERR" test "$out" = finished
f="$(S "$d")"
check "final summary is valid JSON" jq -e . "$f" >/dev/null
check "final summary: success, exitCode 0, no failedPhase" \
  jq -e '.schema == "oc.v5.selfhost.train-summary/1" and .final == true and .result == "success" and .exitCode == 0 and .failedPhase == null' "$f"
check "phases in order A B C.box-success-recovery D G" \
  jq -e '[.phases[].id] == ["A","B","C.box-success-recovery","D","G"]' "$f"
check "every phase closed and contiguous" \
  jq -e '. as $s | ([range(1; $s.phases|length) as $i | $s.phases[$i].startMs == $s.phases[$i-1].endMs] | all) and ($s.phases | map(.durationMs != null) | all)' "$f"
check "phase durations add up to the train duration" \
  jq -e '(.phases | map(.durationMs) | add) == (.durationMs - .phases[0].startMs)' "$f"
check "C phase measured (>= 40 ms)" jq -e '.phases[2].durationMs >= 40' "$f"
check "cache modes and sourceCommit recorded" \
  jq -e '.cache.nodeModules == "hardlink" and .cache.frontend == "reused" and .sourceCommit == "0123456789abcdef0123456789abcdef01234567"' "$f"
check "load recorded" jq -e '(.load.start | type) == "number" and .load.peakAtMarks >= .load.start and .load.samples == 6' "$f"
check "no temp file left" bash -c "! ls '$d' | grep -q tmp"

# 2. A failed train: failedPhase is the last non-compensation phase; exit code kept.
d="$T/fail"; mkdir -p "$d"
run "$d" "LEASE_TRAIN_ID=$TID; tsum_init || :; tsum_mark B || :; tsum_mark F.C1-C3 || :; tsum_mark X.compensate || :; tsum_finish 7 || :" >/dev/null 2>&1
f="$(S "$d")"
check "failed train: result failed, exitCode 7, failedPhase F.C1-C3" \
  jq -e '.final and .result == "failed" and .exitCode == 7 and .failedPhase == "F.C1-C3"' "$f"

# 3. Through the EXIT trap, as deploy-v5-selfhost.sh does it.
d="$T/exit"; mkdir -p "$d"
run "$d" "LEASE_TRAIN_ID=$TID; trap 'tsum_finish \$? 2>/dev/null || :' EXIT; tsum_init || :; tsum_mark E2 || :; false" >/dev/null 2>&1
rc=$?
check "EXIT trap keeps the script's exit code (99 from the ERR trap here)" test "$rc" = 99
check "EXIT trap writes the final summary with that code" jq -e '.final and .exitCode == 99 and .failedPhase == "E2"' "$(S "$d")"

# 4. Killed with SIGKILL: the last partial summary stays and names the open phase.
d="$T/kill"; mkdir -p "$d"
run "$d" "LEASE_TRAIN_ID=$TID; tsum_init || :; tsum_mark C.callback-ws || :; touch '$d/marked'; sleep 30" >/dev/null 2>&1 &
pid=$!
for _ in $(seq 1 50); do [[ -e "$d/marked" ]] && break; sleep 0.1; done
kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
check "killed train leaves final=false with the open phase" \
  jq -e '.final == false and .result == "running" and .phases[-1].id == "C.callback-ws" and .phases[-1].endMs == null' "$(S "$d")"

# 5. Train id known only later (manual deploy): early phases are kept and written once it is known.
d="$T/late"; mkdir -p "$d"
run "$d" "tsum_init || :; tsum_mark B || :; test ! -e '$(S "$d")'; LEASE_TRAIN_ID=$TID; tsum_mark C.ccb-mcp || :; tsum_finish 0 || :" >/dev/null 2>&1
check "late train id: no file before, all phases after" jq -e '[.phases[].id] == ["A","B","C.ccb-mcp"]' "$(S "$d")"

# 6. Dry-run and not-initialised are no-ops.
d="$T/dry"; mkdir -p "$d"
run "$d" "DRY=1; LEASE_TRAIN_ID=$TID; tsum_init || :; tsum_mark B || :; tsum_finish 0 || :" >/dev/null 2>&1
check "dry-run writes nothing" bash -c "[ -z \"\$(ls -A '$d')\" ]"
run "$d" "LEASE_TRAIN_ID=$TID; tsum_mark B || :; tsum_note k v || :; tsum_finish 0 || :" >/dev/null 2>&1
check "marks before tsum_init write nothing" bash -c "[ -z \"\$(ls -A '$d')\" ]"

# 7. A subshell's marks never reach the file (only the tsum_init shell writes).
d="$T/sub"; mkdir -p "$d"
run "$d" "LEASE_TRAIN_ID=$TID; tsum_init || :; ( tsum_mark ZZ.sub || : ); x=\$(tsum_mark ZZ.cmdsub || :); tsum_mark B || :; tsum_finish 0 || :" >/dev/null 2>&1
check "subshell marks are not written" jq -e '[.phases[].id] == ["A","B"]' "$(S "$d")"

# 8. Missing or read-only directory: nothing written, nothing fails.
out="$(run "$T/does-not-exist" "LEASE_TRAIN_ID=$TID; tsum_init 2>/dev/null || :; tsum_mark B 2>/dev/null || :; tsum_finish 0 2>/dev/null || :; echo survived" 2>&1)"
check "missing summary dir does not fail the train" test "$out" = survived
d="$T/ro"; mkdir -p "$d"; chmod 0555 "$d"
if [[ "$(id -u)" != 0 ]]; then
  out="$(run "$d" "LEASE_TRAIN_ID=$TID; tsum_init 2>/dev/null || :; tsum_mark B 2>/dev/null || :; tsum_finish 0 2>/dev/null || :; echo survived" 2>&1)"
  check "read-only summary dir does not fail the train" test "$out" = survived
fi
chmod 0755 "$d"

# 9. Hostile values are cleaned; the file stays valid JSON.
d="$T/hostile"; mkdir -p "$d"
run "$d" "LEASE_TRAIN_ID=$TID; MASTER_DEPS_MODE='a\"b'; tsum_init || :; tsum_mark 'C.x\"y}' || :; tsum_note 'k\"' 'v\$(x)' || :; tsum_finish 0 || :" >/dev/null 2>&1
check "hostile ids/notes cleaned, JSON valid" \
  jq -e '.phases[1].id == "C.x_y_" and .notes["k_"] == "v__x_" and .cache.nodeModules == "a_b"' "$(S "$d")"
run "$d" "LEASE_TRAIN_ID='tr-bad/../../x'; tsum_init || :; tsum_finish 0 || :" >/dev/null 2>&1
check "an invalid train id writes nothing outside" bash -c "[ ! -e '$T/x.summary.json' ] && [ \$(ls '$d' | wc -l) = 1 ]"

# 10. Cache hits read from the train log next to the summary.
d="$T/cache"; mkdir -p "$d"
printf '%s\n' '  [hotcfg] depsCacheKey 命中上一 release → cp -al 复用 root node_modules' \
  '  [hotcfg] bundle rev=0123456789ab 已存在 → 全量重校验后复用(不信任裸存在)' >"$d/$TID.log"
run "$d" "LEASE_TRAIN_ID=$TID; tsum_init || :; tsum_mark P.runtime-wait || :; tsum_mark P.platform-bundle || :; tsum_mark E1 || :; tsum_finish 0 || :" >/dev/null 2>&1
check "cache: deps hit, ccb miss, release miss, bundle hit" \
  jq -e '.cache.runtimeDeps == "hit" and .cache.runtimeCcbDist == "miss" and .cache.runtimeRelease == "miss" and .cache.platformBundle == "hit"' "$(S "$d")"
d="$T/cache2"; mkdir -p "$d"
run "$d" "LEASE_TRAIN_ID=$TID; tsum_init || :; tsum_finish 1 || :" >/dev/null 2>&1
check "cache: unknown without a train log" jq -e '.cache.runtimeDeps == "unknown" and .cache.platformBundle == "unknown"' "$(S "$d")"

# 11. Call sites never depend on the lib: a function body extracted into a test still runs.
out="$(bash -c 'set -Eeuo pipefail; trap "exit 99" ERR; f() { tsum_mark B 2>/dev/null || :; echo body; }; f' 2>&1)"
check "guarded call site without the lib: runs silently" test "$out" = body

# 12. Wiring in the release scripts.
sites="$(grep -hE '^\s*tsum_(init|mark|finish|note)\b' "$DEPLOY" "$MLIB")"
check "every call site is guarded (2>/dev/null || :)" bash -c "! printf '%s\n' \"\$1\" | grep -vE ' 2>/dev/null \|\| :\$'" _ "$sites"
check "deploy sources the lib" grep -qE '^source "\$SCRIPT_DIR/lib/v5-selfhost-train-summary\.sh"' "$DEPLOY"
# P1 (a3bd7741e): prewarm now exits through private cleanup before train recording.
# Exercise the actual function: ordinary deploy drains C/D before recording the original status,
# including owner loss; prewarm must never call the recorder or production cleanup.
sed -n '/^cleanup_selfhost_deploy() {/,/^}/p' "$DEPLOY" >"$T/cleanup.sh"
for mode in deploy prewarm-artifacts; do
  for code in 0 7 86; do
    trace="$T/cleanup-$mode-$code.log"
    env -i PATH="$PATH" HOME="$T" MODE="$mode" TRACE="$trace" bash -c '
      set -Eeuo pipefail
      source "$1"
      note() { printf "%s\n" "$*" >>"$TRACE"; }
      reap_master_build_jobs() { note drain; }
      tsum_finish() { note "finish:$1"; }
      prewarm_cleanup_invocation() { note "prewarm:$1"; }
      release_policy_enabled() { note policy; return 1; }
      release_policy_abort_unexposed() { note abort; }
      reap_runtime_release_bg() { note reap; }
      master_gate_load_budget_stop() { note load-stop; }
      lease_train_on_exit() { note "lease:$1"; }
      cleanup_master_staging() { note master; }
      cleanup_cutover_unit_snap() { note units; }
      p0web_cleanup_build() { note web; }
      trap cleanup_selfhost_deploy EXIT
      exit "$2"
    ' _ "$T/cleanup.sh" "$code"
    rc=$?
    check "$mode EXIT cleanup preserves status $code" test "$rc" = "$code"
    expected="prewarm:$code"
    if [[ "$mode" == deploy ]]; then
      expected=$'drain\nfinish:'"$code"
      if [[ "$code" != 86 ]]; then
        expected+=$'\npolicy'
        [[ "$code" == 0 ]] || expected+=$'\nabort'
        expected+=$'\nreap\nload-stop\nlease:'"$code"$'\nmaster\nunits\nweb'
      fi
    fi
    check "$mode EXIT cleanup $code has only its ordered effects" test "$(cat "$trace")" = "$expected"
  done
done
check "cmd_deploy starts the recorder" bash -c "sed -n '/^cmd_deploy() {/,/^}/p' '$DEPLOY' | grep -qE '^  tsum_init '"
# P3: twelve C jobs + D share one wall-clock phase; four isolated C gates retain marks.
# Exact execution/parent-only per-job receipts are covered by v5SelfhostParallelGates.node-test.mjs.
body="$(sed -n '/^build_master_release() {/,/^}/p' "$MLIB")"
queued="$(printf '%s\n' "$body" | grep -cE '^    C\.[a-z-]+:master_job_')"
check "all twelve deterministic C jobs are queued" test "$queued" = 12
cmarks="$(printf '%s\n' "$body" | sed -n 's/^  tsum_mark \(C\.[a-z-]*\) .*/\1/p')"
check "one C.parallel mark plus all four isolated C marks" test "$cmarks" = $'C.parallel\nC.box-success-recovery\nC.box-continuation\nC.box-incident-proofs\nC.ccb-mcp'
check "D is queued and its measured duration returns to the parent" \
  python3 - "$MLIB" <<'PY_CHECK'
import sys
s = open(sys.argv[1]).read()
assert '    D:master_job_frontend' in s
assert 'tsum_note frontendElapsedSec "$MASTER_FRONTEND_ELAPSED_S"' in s
PY_CHECK
for p in A B P.mcp-bundle P.seal P.runtime-wait P.platform-bundle E1 E2 E2.apply E3.prep E3.wait-idle E3.units E4 F.prewarm F.C1-C3 F.G1 F.S1 G X.compensate; do
  if [[ "$p" == A ]]; then continue; fi
  check "phase $p is marked" grep -qE "^\s*tsum_mark ${p//./\\.} 2>/dev/null \|\| :\$" "$DEPLOY" "$MLIB"
done
check "user_contract_gate still ends with the S1 run (its exit code is the gate's)" \
  bash -c "sed -n '/^user_contract_gate() {/,/^}/p' '$DEPLOY' | tail -2 | head -1 | grep -q 'v5-stop-before-start-contract.mjs'"

# 13. OCV5-545: the architecture step's counts land in notes; an unreadable report is noted, not fatal.
fn="$(sed -n '/^master_note_architecture() {/,/^}/p' "$MLIB")"
d="$T/arch"; mkdir -p "$d"
printf '%s' '{"mode":"report","files":3,"edges":2,"seconds":36.4,"unmapped":0,"byRule":{"R3-env":5,"R2-upward":2},"identities":4,"grown":[{"key":"k"}],"stale":[],"baselineGrown":[]}' >"$T/arch.json"
run "$d" "mlog() { :; }; $fn
LEASE_TRAIN_ID=$TID; tsum_init || :; tsum_mark C.architecture 2>/dev/null || :; master_note_architecture '$T/arch.json'; tsum_finish 0 || :" >/dev/null 2>&1
check "architecture counts recorded as notes" \
  jq -e '.notes["arch.violations"] == "7" and .notes["arch.identities"] == "4" and .notes["arch.grown"] == "1" and .notes["arch.stale"] == "0" and .notes["arch.unmapped"] == "0" and .notes["arch.seconds"] == "36"' "$(S "$d")"
d="$T/arch2"; mkdir -p "$d"
out="$(run "$d" "mlog() { :; }; $fn
LEASE_TRAIN_ID=$TID; tsum_init || :; master_note_architecture '$T/missing.json'; tsum_finish 0 || :; echo survived" 2>&1)"
check "unreadable architecture report: noted, train goes on" test "$out" = survived
check "unreadable architecture report is noted" jq -e '.notes["arch.report"] == "unreadable"' "$(S "$d")"
body="$(sed -n '/^build_master_release() {/,/^}/p' "$MLIB")"
check "architecture worker returns failure to the parent job barrier" \
  bash -c "printf '%s\\n' \"\$1\" | grep -A3 -F 'npx --no-install tsx scripts/check-architecture.ts' | grep -qF 'return 1'" _ "$body"
check "architecture counts are noted after the step" \
  bash -c "printf '%s\\n' \"\$1\" | grep -qF 'master_note_architecture \"\$MASTER_GATE_TMPDIR/C.architecture/architecture.json\"'" _ "$body"

echo "---"
if (( fails )); then echo "FAIL: $fails" >&2; exit 1; fi
echo "PASS"
