# shellcheck shell=bash
# P3: bounded C/D jobs. Only the parent owns receipts, summary writes and cleanup.
# Do not inherit job identities from the environment or another invocation.
MASTER_BUILD_JOB_PIDS=()
MASTER_BUILD_JOB_IDS=()
MASTER_BUILD_JOB_LOGS=()
MASTER_BUILD_JOB_STARTS=()
MASTER_BUILD_JOB_FAILED=0

# The runtime build is already admitted by P2. C and D share this extra budget:
# up to three jobs below load1=4, two below 8, none at/above 8 (or unreadable).
# Recheck on every launch; never kill work already admitted when load rises.
master_build_job_limit() { # <load sample>, also used verbatim in admission evidence
  local load="$1"
  if [[ -z "$load" ]]; then printf 0; return; fi
  awk -v l="$load" -v max="$MASTER_BOX_GATE_LOAD_MAX" \
    'BEGIN { print l >= max ? 0 : (l >= max / 2 ? 2 : 3) }'
}

# Each job has its own process group. A dead shell can leave a live foreground
# command behind; keep that group owned until all its non-zombie members exit.
# Probe failures stay conservative. Zombies cannot write and cannot be reaped
# by this parent after their original parent has died.
master_build_job_group_running() { # <owned pgid>
  local rows rc=0
  kill -0 -- "-$1" 2>/dev/null || return 1
  rows="$(ps -eo pgid=,stat=)" || return 0
  awk -v pgid="$1" '$1 == pgid && $2 !~ /^[ZX]/ { alive=1 } END { exit !alive }' <<<"$rows" || rc=$?
  [[ "$rc" != 1 ]]
}

master_build_job_collect() { # <array index>, called only after the child has exited
  local i="$1" rc=0 id elapsed drain_start draining=0
  id="${MASTER_BUILD_JOB_IDS[i]}"
  wait "${MASTER_BUILD_JOB_PIDS[i]}" || rc=$?
  tsum_note "job.$id.workerRc" "$rc" 2>/dev/null || :
  drain_start="$SECONDS"
  while master_build_job_group_running "${MASTER_BUILD_JOB_PIDS[i]}"; do
    if [[ "$draining" == 0 ]]; then
      mlog "  [$id] worker rc=$rc; 等待存活命令/进程组探测恢复(pgid=${MASTER_BUILD_JOB_PIDS[i]},TMPDIR 保留)"
      draining=1
    fi
    sleep .1
  done
  tsum_note "job.$id.drainSec" "$((SECONDS - drain_start))" 2>/dev/null || :
  elapsed=$(( $(date +%s) - MASTER_BUILD_JOB_STARTS[i] ))
  mlog "  [$id] rc=$rc elapsed=${elapsed}s log=${MASTER_BUILD_JOB_LOGS[i]}"
  cat -- "${MASTER_BUILD_JOB_LOGS[i]}" >&2 || rc=1
  tsum_note "job.$id.rc" "$rc" 2>/dev/null || :
  tsum_note "job.$id.elapsedSec" "$elapsed" 2>/dev/null || :
  tsum_note "job.$id.log" "${MASTER_BUILD_JOB_LOGS[i]}" 2>/dev/null || :
  if [[ "$rc" != 0 ]]; then
    MASTER_BUILD_JOB_FAILED=1
    tsum_note "gateFailure.$id" "$(master_gate_first_failure "${MASTER_BUILD_JOB_LOGS[i]}" "$rc")" 2>/dev/null || :
  fi
  unset 'MASTER_BUILD_JOB_PIDS[i]' 'MASTER_BUILD_JOB_IDS[i]' 'MASTER_BUILD_JOB_LOGS[i]' 'MASTER_BUILD_JOB_STARTS[i]'
  return 0
}

master_build_jobs_poll() {
  local i
  for i in "${!MASTER_BUILD_JOB_PIDS[@]}"; do
    kill -0 "${MASTER_BUILD_JOB_PIDS[i]}" 2>/dev/null || master_build_job_collect "$i"
  done
  [[ "$MASTER_BUILD_JOB_FAILED" == 0 ]]
}

master_build_job_reject() { # <id> <reason>; setup failures also poison future admission
  MASTER_BUILD_JOB_FAILED=1
  tsum_note "job.$1.admissionFailure" "$2" 2>/dev/null || :
  mlog "✗ [$1] 未启动: $2"
  return 1
}

master_build_job_start() { # <phase id> <function>, function has explicit failure returns
  local id="$1"; shift
  local began="$SECONDS" limit load log job_tmp i monitor=0
  while :; do
    master_build_jobs_poll || return 1
    load="$(master_gate_load1)"
    # A broken budget calculation is never interpreted as free capacity.
    if ! limit="$(master_build_job_limit "$load")" || [[ ! "$limit" =~ ^[023]$ ]]; then limit=0; fi
    if (( ${#MASTER_BUILD_JOB_PIDS[@]} < limit )); then break; fi
    if (( SECONDS - began >= MASTER_GATE_IDLE_TIMEOUT_S )); then
      tsum_note "job.$id.admissionWaitSec" "$((SECONDS - began))" 2>/dev/null || :
      tsum_note "job.$id.load1" "${load:-unreadable}" 2>/dev/null || :
      master_build_job_reject "$id" admission-timeout
      return 1
    fi
    sleep 1
  done
  tsum_note "job.$id.admissionWaitSec" "$((SECONDS - began))" 2>/dev/null || :
  tsum_note "job.$id.load1" "$load" 2>/dev/null || :
  log="$(master_gate_attempt_log "$id" 1)" || { master_build_job_reject "$id" log-setup; return 1; }
  job_tmp="$MASTER_GATE_TMPDIR/$id"
  mkdir -- "$job_tmp" || { master_build_job_reject "$id" tmpdir-setup; return 1; }
  # Sparse arrays: reuse a free slot only after its old child has been waited.
  i=0
  while [[ -n "${MASTER_BUILD_JOB_PIDS[i]:-}" ]]; do i=$((i + 1)); done
  MASTER_BUILD_JOB_IDS[i]="$id"
  MASTER_BUILD_JOB_LOGS[i]="$log"
  MASTER_BUILD_JOB_STARTS[i]="$(date +%s)"
  tsum_note "job.$id.slots" "$limit" 2>/dev/null || :
  mlog "  [$id] 后台启动(最多 $limit 路 C/D),日志 $log"
  # Bash assigns this async subshell pgid=$!. Restore the caller's monitor mode
  # immediately; disable it inside the worker so its commands share that group.
  [[ "$-" == *m* ]] && monitor=1
  set -m
  (
    # Inherited deploy traps must never release a lease or remove staging here.
    trap - EXIT ERR
    set +m
    MASTER_GATE_TMPDIR="$job_tmp"
    export TMPDIR="$job_tmp"
    "$@"
  ) >"$log" 2>&1 &
  MASTER_BUILD_JOB_PIDS[i]=$!
  [[ "$monitor" == 1 ]] || set +m
  tsum_note "job.$id.pgid" "${MASTER_BUILD_JOB_PIDS[i]}" 2>/dev/null || :
  tsum_note "job.$id.tmpdir" "$job_tmp" 2>/dev/null || :
  return 0
}

master_build_jobs_wait() {
  while (( ${#MASTER_BUILD_JOB_PIDS[@]} > 0 )); do
    master_build_jobs_poll || return 1
    (( ${#MASTER_BUILD_JOB_PIDS[@]} == 0 )) || sleep 1
  done
  [[ "$MASTER_BUILD_JOB_FAILED" == 0 ]]
}

# Failure/EXIT: drain only our recorded children before removing staging/TMPDIR
# or releasing the train. No kill-by-pattern, shared lock, or other job is touched.
reap_master_build_jobs() {
  local i
  for i in "${!MASTER_BUILD_JOB_PIDS[@]}"; do
    while kill -0 "${MASTER_BUILD_JOB_PIDS[i]}" 2>/dev/null; do
      # A caught signal may interrupt wait; keep ownership until the child exits.
      wait "${MASTER_BUILD_JOB_PIDS[i]}" 2>/dev/null || :
    done
    master_build_job_collect "$i"
  done
  return 0
}
