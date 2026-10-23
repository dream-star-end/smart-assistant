#!/usr/bin/env bash
# Function definitions only; production installation reads the captured candidate.
host_log_policy_files() {
  printf '%s\n' scripts/v5-selfhost-host-log-policy.py deploy/v5-selfhost/host-log-policy.json \
    deploy/v5-selfhost/logrotate.d/openclaude-v5-selfhost \
    deploy/v5-selfhost/logrotate.d/openclaude-v5-selfhost-egress-watch
}

host_log_policy_require_bundle() { # <bundle-root>, also used before a new marker is written
  local root="$1" f
  while IFS= read -r f; do
    [[ -f "$root/$f" && ! -L "$root/$f" ]] || {
      echo "host-log-policy: missing/invalid bundle component $f" >&2
      return 78
    }
  done < <(host_log_policy_files)
  python3 "$root/scripts/v5-selfhost-host-log-policy.py" validate --bundle-root "$root" >/dev/null || {
    echo "host-log-policy: invalid bundle manifest" >&2
    return 78
  }
}

host_log_policy_generation() { # <release>; legacy requires the entire bundle to be absent
  local rel="$1" generation f present=0
  generation="$(jq -er 'if has("hostLogPolicyGeneration") then
    if (.hostLogPolicyGeneration|type)=="number" and .hostLogPolicyGeneration==1
    then "1" else error("unknown host log policy generation") end
    else "legacy" end' "$rel/.complete")" || return 78
  while IFS= read -r f; do
    # This one snippet already exists in pre-policy releases.
    [[ "$f" != deploy/v5-selfhost/logrotate.d/openclaude-v5-selfhost-egress-watch ]] || continue
    if [[ -e "$rel/$f" || -L "$rel/$f" ]]; then present=1; fi
  done < <(host_log_policy_files)
  if [[ "$generation" == legacy ]]; then
    [[ "$present" == 0 ]] || { echo "host-log-policy: unversioned partial bundle" >&2; return 78; }
  else
    host_log_policy_require_bundle "$rel" || return $?
  fi
  printf '%s\n' "$generation"
}

host_log_policy_check_release() { # <live-release>
  local rel="$1" generation
  generation="$(host_log_policy_generation "$rel")" || return $?
  if [[ "$generation" == legacy ]]; then
    echo "host-log-policy: legacy-unavailable" >&2
    return 0
  fi
  python3 "$rel/scripts/v5-selfhost-host-log-policy.py" check --bundle-root "$rel" >&2
}

snapshot_host_log_policy() { # <verified-release> <root-owned-unit-snapshot>
  local rel="$1" snap="$2" generation f directory
  generation="$(host_log_policy_generation "$rel")" || return $?
  [[ "$generation" != legacy ]] || return 0
  while IFS= read -r f; do
    install -D -o 0 -g 0 -m 0644 -- "$rel/$f" "$snap/$f" || return $?
    fsync_path "$snap/$f" || return $?
  done < <(host_log_policy_files)
  for directory in "$snap/scripts" "$snap/deploy/v5-selfhost/logrotate.d" \
      "$snap/deploy/v5-selfhost" "$snap/deploy" "$snap"; do
    fsync_path "$directory" || return $?
  done
}

install_host_log_policy_from_snapshot() { # <verified-release> <unit-snapshot>
  local rel="$1" snap="$2" generation evidence
  generation="$(host_log_policy_generation "$rel")" || return $?
  if [[ "$generation" == legacy ]]; then
    echo "host-log-policy: legacy-unavailable" >&2
    return 0
  fi
  host_log_policy_require_bundle "$snap" || return $?
  evidence="/var/lib/openclaude-v5-selfhost/host-log-policy-evidence/${rel##*/}-$$"
  python3 "$snap/scripts/v5-selfhost-host-log-policy.py" install --bundle-root "$snap" \
    --evidence-dir "$evidence" >&2
}
