# Ordinary commercial deployment must recheck user work after all builds, before activation.
commercial_wait_for_cutover_idle() { # expected master predecessor
  if [[ "$DRY" == 1 ]]; then
    echo '  [dry-run] commercial cutover: two read-only idle snapshots 15s apart, fail closed after 600s'
    return 0
  fi
  local predecessor="$1" egress
  assert_mutation_lease_alive 'commercial-idle-before' || return 86
  egress="$(egress_running_cwd)" || return 1
  [[ -n "$egress" ]] || return 1
  echo '── commercial cutover: waiting for two actual idle snapshots (no hard cut) ──'
  ssh "$KL_HOST" bash -s -- "$BUILT_RELEASE" "$V5_ENV" "$predecessor" "$egress" <<'REMOTE'
set -Eeuo pipefail
cd "$1"
set -a
. "$2"
set +a
timeout 660 node --import tsx scripts/lib/commercialCutoverIdle.ts "$3" "$4"
REMOTE
  local rc=$?
  (( rc == 0 )) || return "$rc"
  assert_mutation_lease_alive 'commercial-idle-after'
}
