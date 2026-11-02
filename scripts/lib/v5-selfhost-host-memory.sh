#!/usr/bin/env bash
# The real deploy process answers every request with its existing owner guard.
# No environment flag, child process or new controller may mint this authority.
host_memory_sampler_finalize() { # <current immutable live release>
  local rel="$1"
  [[ -f "$rel/scripts/v5-selfhost-host-memory.py" ]] || return 0
  [[ -f "$rel/deploy/v5-selfhost/openclaude-v5-selfhost-host-memory.service" ]] || return 79
  # Legacy release finalization does not activate/update this independent unit.
  # OOM readiness requires the policy lane below and a verified sampler receipt.
  if ! release_policy_enabled; then
    cutover_clog "  host-memory: legacy lane leaves collector unchanged; not an OOM acceptance"
    return 0
  fi
  host_memory_sampler_owner_action "$rel" apply
}

host_memory_sampler_restore() { # same-operation recovery only; no arbitrary path
  local rel="$1"
  release_policy_enabled || return 79
  [[ -f "$rel/scripts/v5-selfhost-host-memory.py" ]] || return 79
  [[ -f "$rel/deploy/v5-selfhost/openclaude-v5-selfhost-host-memory.service" ]] || return 79
  host_memory_sampler_owner_action "$rel" restore
}

host_memory_sampler_owner_action() { # <immutable release> <apply|restore>
  local rel="$1" action="$2"
  case "$action" in apply|restore) ;; *) return 79 ;; esac
  release_policy_require_owner || return 86
  local child pid original_read original_write read_fd write_fd line
  local child_rc=0 owner_lost=0 protocol_error=0 received=0 requests=0
  coproc V5_HOST_MEMORY_JOB {
    exec python3 "$rel/scripts/lib/v5-selfhost-host-memory-owner.py" "$rel" "$LEASE_TRAIN_ID" "$action"
  }
  pid="${V5_HOST_MEMORY_JOB_PID:-}"
  original_read="${V5_HOST_MEMORY_JOB[0]:-}"
  original_write="${V5_HOST_MEMORY_JOB[1]:-}"
  [[ -n "$pid" && -n "$original_read" && -n "$original_write" ]] || return 79
  exec {read_fd}<&"$original_read"
  exec {write_fd}>&"$original_write"
  exec {original_read}<&-
  exec {original_write}>&-
  while IFS= read -r line <&"$read_fd"; do
    case "$line" in
      OWNER_CHECK)
        requests=$((requests + 1))
        if (( requests > 512 )); then protocol_error=1; break; fi
        if (( owner_lost == 0 )) && release_policy_require_owner; then
          if ! printf 'OWNER_OK\n' >&"$write_fd"; then protocol_error=1; break; fi
        else
          owner_lost=1
          printf 'OWNER_NO\n' >&"$write_fd" || :
        fi
        ;;
      RESULT\ *)
        received=$((received + 1))
        cutover_clog "  host-memory $action receipt: ${line#RESULT }"
        ;;
      ERROR\ *) cutover_clog "  host-memory installation not accepted: ${line#ERROR }" ;;
      *) protocol_error=1; break ;;
    esac
  done
  exec {read_fd}<&-
  exec {write_fd}>&-
  wait "$pid" || child_rc=$?
  # Ownership loss must never become an ordinary failure/keep_failed write.
  (( owner_lost == 0 )) || return 86
  (( protocol_error == 0 )) || return 79
  [[ "$child_rc" != 86 ]] || return 86
  [[ "$child_rc" == 0 && "$received" == 1 ]] || return 79
  return 0
}
