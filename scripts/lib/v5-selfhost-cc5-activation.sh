# Fixed selfhost two-key carrier. No arbitrary task/config hooks are accepted.
# The Python helper owns the receipt and fixed production paths; this shell
# composes it with the existing cutover/policy lifecycle only.
cc5_activation_py() {
  python3 "$SCRIPT_DIR/lib/v5-selfhost-cc5-activation.py" "$@"
}

cc5_activation_apply() { # <verified candidate> <verified previous master>
  local rel="$1" previous="$2" action=apply sha
  [[ "${DRY:-0}" != 1 ]] || return 0
  [[ "${CUTOVER_ROLLBACK:-0}" != 1 ]] || action=rollback
  sha="$(jq -er '.sourceCommit | select(test("^[0-9a-f]{40}$"))' "$rel/.complete")" || return 79
  cc5_activation_py "$action" "$rel" "$sha" "${LEASE_TRAIN_ID:-}" \
    "${CUTOVER_BACKUP:-}" "$$" "$previous"
}

cc5_activation_revert() {
  [[ "${DRY:-0}" != 1 ]] || return 0
  cc5_activation_py revert "${CUTOVER_BACKUP:-}" "${LEASE_TRAIN_ID:-}" "$$"
}

cc5_activation_finalize() {
  [[ "${DRY:-0}" != 1 ]] || return 0
  cc5_activation_py finalize "${CUTOVER_BACKUP:-}" "${LEASE_TRAIN_ID:-}" "$$"
}

cc5_activation_restart_guard() {
  local expected=after
  if [[ "${HOTCFG_SAGA_ROLLING_BACK:-0}" == 1 || "${CC5_ACTIVATION_COMPENSATING:-0}" == 1 ]]; then
    expected=before
  fi
  cc5_activation_py check-restart "${CUTOVER_BACKUP:-}" "${LEASE_TRAIN_ID:-}" "$$" "$expected"
}

cc5_activation_restore_guard() {
  cc5_activation_py guard
}

cc5_activation_extra_apply() { # <candidate> <previous>
  if release_policy_enabled; then
    release_policy_flip_live "$1" || return "$?"
  fi
  cc5_activation_apply "$1" "$2"
}

cc5_activation_extra_revert() { # <previous>
  cc5_activation_revert || return "$?"
  if release_policy_enabled; then
    release_policy_restore_live_before "$1" || return "$?"
  fi
}
