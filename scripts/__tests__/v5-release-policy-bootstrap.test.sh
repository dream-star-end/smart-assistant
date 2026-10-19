#!/usr/bin/env bash
# Source-bound bootstrap reader and post-lock barrier fixture.
# Future author runs under normal train/test mutex; no production roots.
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY_SCRIPT="${POLICY_SCRIPT:-$SCRIPT_DIR/lib/v5-selfhost-release-policy.sh}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-$SCRIPT_DIR/deploy-v5-selfhost.sh}"
WORK="$(mktemp -d /tmp/ocv5-521-bootstrap.XXXXXX)"
if [[ -n "${OC_V5_BOOTSTRAP_EVIDENCE_DIR:-}" ]];then
  [[ ! -e "$OC_V5_BOOTSTRAP_EVIDENCE_DIR" && ! -L "$OC_V5_BOOTSTRAP_EVIDENCE_DIR" ]] || exit 90
  mkdir -m0700 "$OC_V5_BOOTSTRAP_EVIDENCE_DIR"
fi
bootstrap_cleanup() {
  local status=$?
  if [[ -n "${OC_V5_BOOTSTRAP_EVIDENCE_DIR:-}" ]];then
    cp -a "$WORK"/. "$OC_V5_BOOTSTRAP_EVIDENCE_DIR"/ || status=90
  fi
  command rm -rf -- "$WORK"
  return "$status"
}
trap bootstrap_cleanup EXIT
unset DATABASE_URL
export PYTHONDONTWRITEBYTECODE=1 TMPDIR="$WORK"
export OC_V5_RELEASE_POLICY_CONTEXT="$WORK/unresolved.json"
# This is a function library, directly sourced, not a deploy entrypoint.
source "$POLICY_SCRIPT"
# Its survivor_state_phase dependency now lives in the real policy library.
# Extract that parser-accepted definition; never source the deploy CLI top-level.
python3 - "$DEPLOY_SCRIPT" "$POLICY_SCRIPT" "$WORK" <<'EXTRACT'
from pathlib import Path
import sys,re,subprocess,json,hashlib
source,policy,out=map(Path,sys.argv[1:]);lines=policy.read_text().splitlines(keepends=True)
name='survivor_state_phase'
starts=[i for i,line in enumerate(lines) if re.match(r'^'+name+r'\s*\(\s*\)\s*\{',line)]
assert len(starts)==1,'actual survivor definition absent/ambiguous'
start=starts[0];body=None
for end in range(start+1,len(lines)+1):
    if end!=start+1 and not re.match(r'^}\s*(?:#.*)?\n?$',lines[end-1]):continue
    candidate=''.join(lines[start:end])
    checked=subprocess.run(['bash','--noprofile','--norc','-n','-c',candidate],
      env={'PATH':'/usr/bin:/bin','LC_ALL':'C','BASH_ENV':'/dev/null'},capture_output=True,text=True)
    if checked.returncode==0:body=candidate;break
assert body is not None,'cannot extract actual complete survivor definition'
(out/'survivor_state_phase.sh').write_text(body)
(out/'sources.json').write_text(json.dumps({'policy':{'path':str(policy),'sha256':hashlib.sha256(policy.read_bytes()).hexdigest()},
 'deploy':{'path':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest()},
 'survivor':{'path':str(policy),'start':start+1,'end':end,'sha256':hashlib.sha256(body.encode()).hexdigest()},
 'unchangedFunctions':['release_policy_unit_stamp','release_policy_drain_reader','release_policy_rejected_phase']},indent=2)+'\n')
EXTRACT
source "$WORK/survivor_state_phase.sh"

# Only external ownership and systemctl observations, plus virtual sleep.
# The actual unit-stamp parser, reader loop and phase allowlist stay intact.
cutover_clog() { printf '%s\n' "$*" >>"$CASE_DIR/messages.log"; }
release_policy_require_owner() {
  OWNER_CALLS=$((OWNER_CALLS+1))
  printf '%s\n' "$OWNER_CALLS" >>"$CASE_DIR/owners.log"
  if [[ "$CASE_NAME" == fence && "$OWNER_CALLS" -ge 2 ]];then return 86;fi
  return 0
}
systemctl() {
  # There is no fallback to the host command, including unexpected subcommands.
  [[ "$#" == 15 && "$1" == show && "$2" == "$FIXTURE_UNIT" &&
     "$3" == -p && "$4" == LoadState && "$5" == -p && "$6" == ActiveState &&
     "$7" == -p && "$8" == SubState && "$9" == -p && "${10}" == MainPID &&
     "${11}" == -p && "${12}" == InvocationID && "${13}" == -p &&
     "${14}" == Job && "${15}" == --no-pager ]] || {
    printf '%s\n' 'UNEXPECTED_SYSTEMCTL' >>"$CASE_DIR/unexpected.log";return 92;
  }
  # unit_stamp uses command substitution: persist the cursor to a fixture file
  # so a subshell cannot accidentally replay frame1 forever.
  local n
  n="$(cat "$CASE_DIR/cursor")";n=$((n+1))
  printf '%s\n' "$n" >"$CASE_DIR/cursor"
  [[ -f "$CASE_DIR/stamp-$n" ]] || {
    printf '%s\n' "UNEXPECTED_EXCESS_OBSERVATION:$n" >>"$CASE_DIR/unexpected.log";return 92;
  }
  cat "$CASE_DIR/stamp-$n"
}
sleep() {
  [[ "$#" == 1 && "$1" == 1 ]] || {
    printf '%s\n' 'UNEXPECTED_SLEEP' >>"$CASE_DIR/unexpected.log";return 92;
  }
  printf '1\n' >>"$CASE_DIR/sleeps.log"
  SECONDS=$((SECONDS+1))
}
ID_OLD=11111111111111111111111111111111
ID_NEW=22222222222222222222222222222222
FIXTURE_UNIT=fixture-ocv5-521-reader.service
new_case() {
  CASE_NAME="$1";CASE_DIR="$WORK/$CASE_NAME";mkdir -m0700 "$CASE_DIR"
  OWNER_CALLS=0;printf '0\n' >"$CASE_DIR/cursor"
  : >"$CASE_DIR/sleeps.log";: >"$CASE_DIR/owners.log"
  SURVIVOR_STATE="$CASE_DIR/survivor.state"
}
frame() { # index LoadState ActiveState SubState MainPID InvocationID Job
  printf 'LoadState=%s\nActiveState=%s\nSubState=%s\nMainPID=%s\nInvocationID=%s\nJob=%s\n' \
    "$2" "$3" "$4" "$5" "$6" "$7" >"$CASE_DIR/stamp-$1"
}
expect_drain() { # expectedRC seconds optional expectedReads expectedSleeps
  local rc=0
  release_policy_drain_reader "$FIXTURE_UNIT" "$2" "$3" >"$CASE_DIR/drain.log" 2>&1 || rc=$?
  [[ "$rc" == "$1" ]] || { cat "$CASE_DIR/drain.log";printf 'FAIL %s rc=%s wanted=%s\n' "$CASE_NAME" "$rc" "$1";exit 1; }
  [[ "$(cat "$CASE_DIR/cursor")" == "$4" && "$(wc -l <"$CASE_DIR/sleeps.log" | tr -d ' ')" == "$5" ]]
  [[ ! -e "$CASE_DIR/unexpected.log" ]]
  ! grep -Eq 'command not found|unbound variable' "$CASE_DIR/drain.log"
  printf 'PASS actual-bootstrap-drain %s rc=%s reads=%s sleeps=%s\n' "$CASE_NAME" "$rc" "$4" "$5"
}

new_case inactive0
frame 1 loaded inactive dead 0 '' 0
expect_drain 0 0 0 1 0

new_case fixed-old-to-new
frame 1 loaded active running 101 "$ID_OLD" 0
frame 2 loaded active running 202 "$ID_NEW" 0
expect_drain 0 10 0 2 0

new_case same-id-until-end
frame 1 loaded active running 101 "$ID_OLD" 0
frame 2 loaded active running 101 "$ID_OLD" 0
frame 3 loaded active running 101 "$ID_OLD" 0
frame 4 loaded inactive dead 0 "$ID_OLD" 0
expect_drain 0 10 0 4 2

new_case blank-id-job-handoff
frame 1 loaded activating start 0 '' '7 /org/freedesktop/systemd1/job/7'
# A new ID while the captured Job7 still exists must not count as drained.
frame 2 loaded active running 202 "$ID_NEW" '7 /org/freedesktop/systemd1/job/7'
frame 3 loaded active running 202 "$ID_NEW" 0
expect_drain 0 10 0 3 1

new_case pending-zero-budget
frame 1 loaded activating start 0 '' '7 /org/freedesktop/systemd1/job/7'
expect_drain 79 0 0 1 0

new_case unknown-stamp
frame 1 loaded active running not-a-pid "$ID_OLD" 0
expect_drain 79 10 0 1 0

new_case fence
frame 1 loaded active running 101 "$ID_OLD" 0
# Owner is lost before the second observation; no second systemctl frame exists.
expect_drain 86 10 0 1 0
[[ "$OWNER_CALLS" == 2 ]]

new_case optional-not-found
frame 1 not-found inactive dead 0 '' 0
expect_drain 0 0 1 1 0
new_case mandatory-not-found
frame 1 not-found inactive dead 0 '' 0
expect_drain 79 0 0 1 0

# Rejection must come from the actual phase-file reader + actual allowlist.
# No replacement survivor_state_phase, JSON parser or phase predicate.
new_case phase-absent;rc=0
release_policy_rejected_phase || rc=$?
[[ "$rc" == 79 ]]
printf 'PASS actual-rejected-phase absent79\n'
new_case phase-empty;: >"$SURVIVOR_STATE";rc=0
release_policy_rejected_phase || rc=$?
[[ "$rc" == 79 ]]
printf 'PASS actual-rejected-phase empty79\n'
for phase in armed committed mutated smoked unexpected-phase;do
  new_case "phase-$phase";printf 'phase=%s\n' "$phase" >"$SURVIVOR_STATE";rc=0
  release_policy_rejected_phase || rc=$?
  [[ "$rc" == 79 ]]
  printf 'PASS actual-rejected-phase %s79\n' "$phase"
done
for phase in units-installed reloaded grace migrated symlink-flipped restarted kept-failed;do
  new_case "phase-$phase";printf 'phase=%s\n' "$phase" >"$SURVIVOR_STATE";rc=0
  release_policy_rejected_phase || rc=$?
  [[ "$rc" == 0 ]]
  printf 'PASS actual-rejected-phase %s0\n' "$phase"
done
# A regular file behind a symlink is still disallowed by the actual predicate.
new_case phase-symlink;printf 'phase=units-installed\n' >"$CASE_DIR/real-state"
ln -s "$CASE_DIR/real-state" "$SURVIVOR_STATE";rc=0
release_policy_rejected_phase || rc=$?
[[ "$rc" == 79 ]]
printf 'PASS actual-rejected-phase symlink79\n'
# /proc manual-watch FD/inode enumeration and real systemd timing are explicitly
# not covered. Never fake those probes or claim this fixture proves installation.

python3 - "$DEPLOY_SCRIPT" "$WORK/acquire.sh" <<'LOCK_EXTRACT'
import pathlib,re,subprocess,sys
lines=pathlib.Path(sys.argv[1]).read_text().splitlines(keepends=True)
starts=[i for i,line in enumerate(lines) if line.startswith('acquire_selfhost_deploy_lock() {')]
assert len(starts)==1
start=starts[0]
for end in range(start+1,len(lines)+1):
    if lines[end-1].strip()!='}':continue
    body=''.join(lines[start:end])
    if subprocess.run(['bash','-n'],input=body,text=True,capture_output=True).returncode==0:
        pathlib.Path(sys.argv[2]).write_text(body);break
else:raise AssertionError('actual lock function not found')
LOCK_EXTRACT
source "$WORK/acquire.sh"
# Only prepare/holder/flock are observation boundaries; real presence/barrier
# logic and the actual lock-entry order are retained. A hold appears DURING
# flock acquisition, after the command's initial preflight saw absence.
for path in fresh inherited; do
  new_case "post-lock-$path"
  rm -f "$RELEASE_POLICY_CONTEXT"
  trace_file="$CASE_DIR/mutations"
  : >"$trace_file"
  rc=0
  (
    RELEASE_POLICY_RESUME=0
    SELFHOST_DEPLOY_LOCK_DIR="$CASE_DIR"
    SELFHOST_DEPLOY_LOCK="$CASE_DIR/deploy.lock"
    SELFHOST_DEPLOY_LOCK_WAIT=0;SELFHOST_DEPLOY_LOCK_POLL=1
    SELFHOST_DEPLOY_LOCK_HOLDER_OWNED=0
    log() { :; }
    selfhost_lock_py() {
      case "$1" in
        prepare) : >"$2" ;;
        write-holder) printf 'FORBIDDEN_HOLDER_WRITE\n' >>"$trace_file";return 93 ;;
        *) return 94 ;;
      esac
    }
    flock() { : >"$RELEASE_POLICY_CONTEXT";return 0; }
    if [[ "$path" == inherited ]]; then
      export OC_V5_SELFHOST_DEPLOY_LOCK_HELD=1
      : >"$RELEASE_POLICY_CONTEXT"
    else unset OC_V5_SELFHOST_DEPLOY_LOCK_HELD;fi
    acquire_selfhost_deploy_lock
    printf 'FORBIDDEN_MUTATION_AFTER_HOLD\n' >>"$trace_file"
    exit 95
  ) >"$CASE_DIR/lock.log" 2>&1 || rc=$?
  [[ "$rc" == 79 && ! -s "$trace_file" && -f "$RELEASE_POLICY_CONTEXT" ]]
  printf 'PASS actual-post-lock-barrier %s79 no-holder-or-following-write\n' "$path"
  rm -f "$RELEASE_POLICY_CONTEXT"
done
