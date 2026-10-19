#!/usr/bin/env bash
# Explicit commercial normal-deploy policy. Production mutation fencing stays in deploy-v5.sh.
COMMERCIAL_FAILURE_POLICY="${COMMERCIAL_FAILURE_POLICY:-}"
CP_ROOT="${CP_ROOT:-/var/lib/openclaude-v5/release-policy}"
CP_CODE_DIGEST="${CP_CODE_DIGEST:-}"
CP_BUNDLE="${CP_BUNDLE:-}"
CP_CONFIG="${CP_CONFIG:-}"
commercial_policy_enabled() { [[ "$COMMERCIAL_FAILURE_POLICY" == user-impact-only ]]; }

commercial_policy_py() { python3 -B "$CP_BUNDLE/lib/v5-commercial-release-policy.py" "$@"; }
commercial_policy_remote_owner() { commercial_policy_py owner || return 86; }
commercial_policy_saga_adapter() {
  local action="$1"; shift
  commercial_policy_remote_owner || return 86
  case "$action" in
    owner) return 0 ;;
    prepare) commercial_policy_py prepare "$CP_CONFIG" "$@" || return $? ;;
    arm) commercial_policy_py arm || return $? ;;
    failure)
      local authority=unobserved decision
      case "${2:-none}" in applied) authority=applied ;; old) authority=original ;; uncertain) authority=unknown ;; esac
      decision="$(commercial_policy_py failure "$1" "$authority" "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$CP_LIVE" "$CP_UNIT")" || return $?
      case "$decision" in PREPARATION_ABORT|COMPENSATE_USER_IMPAIRMENT) return 0 ;; KEEP_FAILED) return 78 ;; CRASH_STOP) return 86 ;; *) return 79 ;; esac ;;
    *) return 79 ;;
  esac
}

commercial_policy_ship() {
  commercial_policy_enabled || return 0
  [[ "$DRY" == 1 ]] && return 0
  assert_mutation_lease_alive policy-code-ship || return 86
  [[ "$MUTATION_LEASE_BYPASSED" != 1 ]] || return 86
  local dir digest remote
  dir="$SCRIPT_DIR"
  digest="$(cat "$RUNTIME_LIB" "$dir/lib/v5-commercial-release-policy.sh" "$dir/lib/v5-commercial-release-policy.py" "$dir/lib/v5-release-policy.py" "$dir/v5-egress-slots.sh" | sha256sum | awk '{print $1}')" || return 79
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 79
  CP_CODE_DIGEST="$digest"
  CP_BUNDLE="$CP_ROOT/code-$digest"
  [[ "${CP_SHIPPED:-}" == "$digest" ]] && return 0
  remote="set -euo pipefail; umask 077; mkdir -p '$CP_ROOT'; t=\$(mktemp -d '$CP_ROOT/.code.XXXXXX'); trap 'rm -rf -- \"\$t\"' EXIT; tar -xf - -C \"\$t\"; test \"\$(cat \"\$t/v5-runtime-release-lib.sh\" \"\$t/lib/v5-commercial-release-policy.sh\" \"\$t/lib/v5-commercial-release-policy.py\" \"\$t/lib/v5-release-policy.py\" \"\$t/v5-egress-slots.sh\" | sha256sum | cut -d' ' -f1)\" = '$digest'; if test -e '$CP_BUNDLE'; then diff -qr \"\$t\" '$CP_BUNDLE' >/dev/null; else mv -T \"\$t\" '$CP_BUNDLE'; fi"
  tar -cf - -C "$dir" v5-runtime-release-lib.sh lib/v5-commercial-release-policy.sh lib/v5-commercial-release-policy.py lib/v5-release-policy.py v5-egress-slots.sh \
    | ssh "$KL_HOST" "$remote" || return 79
  CP_SHIPPED="$digest"
}

commercial_policy_rmt() { # trusted fixed shell function + argv, no caller-provided commands
  local fn="$1"; shift
  commercial_policy_ship || return $?
  assert_mutation_lease_alive policy-remote-call || return 86
  local q
  printf -v q '%q ' "$@"
  ssh "$KL_HOST" "bash -s -- $q" <<POLICY_REMOTE
set -Eeuo pipefail
export CP_ROOT=$(printf '%q' "$CP_ROOT")
export CP_BUNDLE=$(printf '%q' "$CP_BUNDLE")
export CP_CONFIG=$(printf '%q' "$CP_CONFIG")
export CP_LOCK=$(printf '%q' "$PRODUCTION_MUTATION_LOCK")
export CP_DEPLOY_ID=$(printf '%q' "$MUTATION_DEPLOY_ID")
export CP_ADMISSION=$(printf '%q' "$MUTATION_ADMISSION_NONCE")
export CP_LANE_MARKER=$(printf '%q' "$MUTATION_LANE_INFLIGHT_MARKER")
export CP_LANE_NONCE=$(printf '%q' "$MUTATION_LANE_INFLIGHT_NONCE")
export CP_RECOVERY_MARKER=$(printf '%q' "$DEPLOY_RECOVERY_MARKER")
export CP_LIVE=$(printf '%q' "$ACTIVE_SRC")
export CP_UNIT=$(printf '%q' "$ACTIVE_UNIT")
export OC_HOTCFG_ENV_FILE=$(printf '%q' "$V5_ENV")
export OC_HOTCFG_PLATFORM_ROOT=$(printf '%q' "$OC_HOTCFG_PLATFORM_ROOT")
export OC_HOTCFG_RELEASES_ROOT=$(printf '%q' "$OC_HOTCFG_RELEASES_ROOT")
export OC_HOTCFG_HISTORY=$(printf '%q' "$OC_HOTCFG_HISTORY")
source "\$CP_BUNDLE/v5-runtime-release-lib.sh"
source "\$CP_BUNDLE/lib/v5-commercial-release-policy.sh"
commercial_policy_remote_owner || exit 86
$fn "\$@"
POLICY_REMOTE
}

commercial_policy_configure() {
  commercial_policy_enabled || return 0
  [[ "$DRY" == 1 ]] && return 0
  commercial_policy_ship || return $?
  local serving_unit="" egress_target_slot=""
  if [[ "$RESTART_EGRESS" == 1 ]]; then
    serving_unit="$(egress_slots_remote active)" || return 79
    serving_unit="${serving_unit%% *}"
    case "$serving_unit" in openclaude-v5-egress@A.service) egress_target_slot=B ;; openclaude-v5-egress@B.service) egress_target_slot=A ;; *) return 79 ;; esac
  fi
  CP_CONFIG="$(jq -cn --arg sha "$BUILT_RELEASE_SOURCE_COMMIT" --arg slot "$ACTIVE_SLOT" --argjson port "$ACTIVE_PORT" \
    --argjson withDist "$([[ "$WITH_DIST" == 1 ]] && echo true || echo false)" --argjson restartEgress "$([[ "$RESTART_EGRESS" == 1 ]] && echo true || echo false)" \
    --arg egressBefore "${CAPTURED_EGRESS_PREDECESSOR:-}" --arg egressTargetSlot "$egress_target_slot" --arg queueId "${OC_V5_RELEASE_QUEUE_ID:-}" --arg bundleDigest "$CP_CODE_DIGEST" \
    --argjson lockVersion "$ACTIVE_STATE_LOCK_VERSION" --arg activeRelease "$ACTIVE_STATE_RELEASE" --arg previousRelease "${ACTIVE_STATE_PREVIOUS_RELEASE:-}" \
    '{sha:$sha,slot:$slot,port:$port,withDist:$withDist,restartEgress:$restartEgress,egressBefore:$egressBefore,egressTargetSlot:$egressTargetSlot,queueId:$queueId,bundleDigest:$bundleDigest,
      authority:{lockVersion:$lockVersion,activeSlot:$slot,activeRelease:$activeRelease,previousRelease:$previousRelease}}')" || return 79
}

commercial_policy_failure() { # allow existing compensation only on explicit direct user impairment
  commercial_policy_enabled || return 0
  [[ "$DRY" == 1 ]] && return 0
  local rc=0
  commercial_policy_rmt commercial_policy_saga_adapter failure "$1" "${2:-none}" || rc=$?
  case "$rc" in
    78|79)
      commercial_policy_keep_failed "$rc" || rc=$?
      echo "✗ release gate failed; candidate retained; stage=$1 rc=$rc" >&2 ;;
  esac
  return "$rc"
}

commercial_policy_finish() { # caller passed all original required gates/finalizers
  commercial_policy_enabled || return 0
  [[ "$DRY" == 1 ]] && return 0
  local status
  status="$(commercial_policy_authority_status)" || return $?
  [[ "$status" == applied ]] || return 79
  status="$(commercial_policy_rmt commercial_policy_verified_history)" || return $?
  [[ "$status" == applied ]] || return 79
  hotcfg_rmt oc_hotcfg_history_last_committed "$OC_HOTCFG_HISTORY" >/dev/null || return 79
  if [[ "$RESTART_EGRESS" == 1 ]]; then commercial_policy_resume_egress "$BUILT_RELEASE" || return $?; fi
  commercial_policy_rmt commercial_policy_py resolve target applied "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$ACTIVE_SRC" "$ACTIVE_UNIT" || return $?
}

commercial_policy_authority_status() {
  local sql lock slot previous target older
  lock="$(commercial_policy_rmt commercial_policy_py field options.authority.lockVersion)" || return $?
  slot="$(commercial_policy_rmt commercial_policy_py field options.authority.activeSlot)" || return $?
  previous="$(commercial_policy_rmt commercial_policy_py field options.authority.activeRelease)" || return $?
  older="$(commercial_policy_rmt commercial_policy_py field options.authority.previousRelease)" || return $?
  target="$(commercial_policy_rmt commercial_policy_py field target.masterRelease)" || return $?
  if [[ "${1:-target}" == before ]]; then
    sql="$(ds_stable_release_status_sql "$((lock+1))" "$slot" "$target" "$previous" "$previous")" || return 79
  else sql="$(ds_stable_release_status_sql "$lock" "$slot" "$previous" "$older" "$target")" || return 79; fi
  ds_exec <<<"$sql" | tr -d '[:space:]'
}

commercial_policy_reconcile_metadata() { # physical target proof is caller's prerequisite
  local rel="$1" status tuple hist previous kind
  status="$(commercial_policy_authority_status)" || return $?
  if [[ "$status" == original ]]; then
    ACTIVE_STATE_LOCK_VERSION="$(commercial_policy_rmt commercial_policy_py field options.authority.lockVersion)" || return $?
    ACTIVE_STATE_RELEASE="$(commercial_policy_rmt commercial_policy_py field options.authority.activeRelease)" || return $?
    assert_mutation_lease_alive policy-metadata-reconcile || return 86
    ds_commit_active_release "$rel" || return 79
    status="$(commercial_policy_authority_status)" || return $?
  fi
  [[ "$status" == applied ]] || return 79
  status="$(commercial_policy_rmt commercial_policy_verified_history)" || return $?
  hist="$(commercial_policy_rmt commercial_policy_py field history.path)" || return $?
  if [[ "$status" == missing ]]; then
    tuple="$(commercial_policy_rmt commercial_policy_py field target.tuple)" || return $?
    previous="$(commercial_policy_rmt commercial_policy_py field before.masterRelease)" || return $?
    kind="$(commercial_policy_rmt commercial_policy_py field history.transitionKind)" || return $?
    commercial_policy_rmt oc_hotcfg_history_append "$hist" "$(jq -r '.OC_RUNTIME_IMAGE' <<<"$tuple")" "$(jq -r '.OC_RUNTIME_IMAGE_ID' <<<"$tuple")" \
      "$(jq -r '.OC_RUNTIME_RELEASE' <<<"$tuple")" "$(jq -r '.OC_PLATFORM_BUNDLE' <<<"$tuple")" "$rel" "" "$kind" "$previous" || return $?
  fi
  status="$(commercial_policy_rmt commercial_policy_verified_history)" || return $?
  [[ "$status" == applied ]] || return 79
}
commercial_policy_resume_egress() {
  local rel="$1" before selection
  before="$(commercial_policy_rmt commercial_policy_py field options.egressBefore)" || return $?
  selection="$(egress_slots_remote policy-state "$rel" "$before")" || return $?
  case "$selection" in
    target\ *) : ;;
    before\ *) activate_egress_release "$rel" "$before" || return $? ;;
    unavailable)
      local forward_rc=0
      egress_slots_remote restore "$EGRESS_SLOT_PREDRAIN_SEC" || forward_rc=$?
      if [[ "$forward_rc" != 0 ]]; then
        [[ "$forward_rc" != 86 ]] || return 86
        # A retry must restore task service if this exact operation still has no listener.
        commercial_policy_rmt commercial_policy_reverse_unavailable || return $?
        commercial_policy_reverse_dead_egress "$before" || return $?
        return 78 # old egress is usable; new master and failed context stay in place
      fi ;;
    *) return 79 ;;
  esac
  egress_slots_remote converge "$rel" "$before" || return $?
  wait_for_egress_release_ready "$rel" 0 30 || return 79
}
# Seed already opens the verified listing after account/handoff binding. Restore
# only the current approved gate after failure; keep the release unaccepted.
commercial_policy_promote_plugin() {
  local plugin="$1" rel="$2" failed=0
  assert_mutation_lease_alive "policy-$plugin-close" || return 86
  "${plugin}_plugin_close_gate" "$rel" || failed=1
  if [[ "$failed" == 0 ]]; then
    assert_mutation_lease_alive "policy-$plugin-seed" || return 86
    "${plugin}_plugin_seed" "$rel" || failed=1
  fi
  if [[ "$failed" == 1 ]]; then
    assert_mutation_lease_alive "policy-$plugin-restore-current" || return 86
    "${plugin}_plugin_open_gate_current" "$rel" || return 79
    return 79
  fi
}
commercial_policy_required_gates() {
  local rel="$1" with_dist
  BUILT_RELEASE_SOURCE_COMMIT="$(commercial_policy_rmt commercial_policy_py source-for-release "$rel")" || return $?
  BUILT_RELEASE="$rel"
  with_dist="$(commercial_policy_rmt commercial_policy_py field options.withDist)" || return $?
  smoke "$ACTIVE_PORT" || return 79
  minimum_functional_core deploy "$rel" "$ACTIVE_PORT" || return 79
  if [[ "$with_dist" == true ]]; then
    WITH_DIST=1
    DIST_BUILD_ID="$(ssh "$KL_HOST" "grep -o 'name=\"oc-build\" content=\"[0-9a-f]\{8,32\}\"' '$rel/packages/web-react/dist/index.html' | grep -o '[0-9a-f]\{8,32\}' | head -1")" || return 79
    [[ "$DIST_BUILD_ID" =~ ^[0-9a-f]{8,32}$ ]] || return 79
    dist_handshake_smoke "$ACTIVE_PORT" || return 79
  fi
  verify_public_surface deploy || return 79
  knowledge_planet_plugin_advisory_gate "$rel" || return 79
  weibo_plugin_advisory_gate "$rel" || return 79
  if [[ "$KP_PLUGIN_PROMOTE" == 1 ]]; then commercial_policy_promote_plugin knowledge_planet "$rel" || return $?; fi
  if [[ "$WB_PLUGIN_PROMOTE" == 1 ]]; then commercial_policy_promote_plugin weibo "$rel" || return $?; fi
  end_planned_maintenance || return 79
  smoke_sourcemap_sealed || return 79
}
commercial_policy_recover() {
  [[ "$DRY" == 1 ]] && { echo '  [dry-run] exact policy: recover service, reconcile real metadata, rerun all original gates'; return 0; }
  commercial_policy_ship || return $?
  local rel status queue direction restart_egress rc=0
  rel="$(commercial_policy_rmt commercial_policy_py field target.masterRelease)" || return $?
  queue="$(commercial_policy_rmt commercial_policy_py field options.queueId)" || return $?
  [[ "$queue" == "${OC_V5_RELEASE_QUEUE_ID:-}" ]] || return 79
  direction="$(commercial_policy_rmt commercial_policy_py archive-direction)" || return $?
  if [[ "$direction" == before ]]; then
    commercial_policy_complete_compensation || return $?
    return 0
  fi
  if commercial_policy_rmt commercial_policy_py before-current-plan "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$ACTIVE_SRC" "$ACTIVE_UNIT" >/dev/null; then
    commercial_policy_complete_compensation || return $?
    return 0
  else rc=$?; [[ "$rc" != 86 ]] || return 86; fi
  if commercial_policy_rmt commercial_policy_py verify target "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$ACTIVE_SRC" "$ACTIVE_UNIT" >/dev/null; then :
  else rc=$?; [[ "$rc" != 86 ]] || return 86; commercial_policy_rollback; return $?; fi
  commercial_policy_reconcile_metadata "$rel" || return $?
  BUILT_RELEASE="$rel"
  restart_egress="$(commercial_policy_rmt commercial_policy_py field options.restartEgress)" || return $?
  if [[ "$restart_egress" == true ]]; then RESTART_EGRESS=1; commercial_policy_resume_egress "$rel" || return $?; fi
  if [[ "$direction" == target ]]; then
    commercial_policy_rmt commercial_policy_py clear-accepted-marker "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$ACTIVE_SRC" "$ACTIVE_UNIT" || return $?
    echo "✓ exact commercial acceptance receipt cleanup recovered"
    return 0
  fi
  commercial_policy_required_gates "$rel" || return $?
  commercial_policy_finish || return $?
  clear_deploy_recovery_marker_after_stable_recover || return 79
  echo "✓ commercial policy recovered forward(release=$rel)"
}
# Read-only admission exception: only this operation's exact typed marker. In-flight fencing
# remains unconditional in assert_no_deploy_recovery_marker; authority follows under the lease.
commercial_policy_rollback_preflight() {
  ssh "$KL_HOST" bash -s -- "$CP_ROOT/active.json" "$DEPLOY_RECOVERY_MARKER" <<'POLICY_PREFLIGHT'
set -eu
python3 -B - "$@" <<'CHECK'
import json,sys
from pathlib import Path
c=json.loads(Path(sys.argv[1]).read_text());m=json.loads(Path(sys.argv[2]).read_text())
assert c['edition']=='commercial' and c['policy']=='user-impact-only'
assert m==dict(policy='user-impact-only',operationId=c['operationId'])
CHECK
POLICY_PREFLIGHT
}
commercial_policy_rollback() {
  [[ "$DRY" == 1 ]] && { echo '  [dry-run] confirmed-user-impact N1 rollback under original guards'; return 0; }
  commercial_policy_ship || return $?
  commercial_policy_rmt commercial_policy_py rollback-marker || return $?
  commercial_policy_rmt commercial_policy_py verify-identity target "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$ACTIVE_SRC" || return $?
  local rel hist status row decision expected_egress restart_egress op
  rel="$(commercial_policy_rmt commercial_policy_py field target.masterRelease)" || return $?
  status="$(commercial_policy_authority_status)" || return $?
  [[ "$status" == original || "$status" == applied ]] || return 79
  decision="$(commercial_policy_rmt commercial_policy_py failure operator-rollback "$status" "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$ACTIVE_SRC" "$ACTIVE_UNIT" "${CP_USER_IMPACT_EVIDENCE:-}")" || return $?
  [[ "$decision" == COMPENSATE_USER_IMPAIRMENT ]] || { echo '✗ rollback requires actual candidate-bound user impairment' >&2; return 79; }
  hist="$(commercial_policy_rmt commercial_policy_py field history.path)" || return $?
  status="$(commercial_policy_rmt commercial_policy_verified_history)" || return $?
  if [[ "$status" == missing ]]; then row="$(hotcfg_rmt oc_hotcfg_history_last_committed "$hist")" || return 79
  elif [[ "$status" == applied ]]; then row="$(hotcfg_rmt oc_hotcfg_history_nth_committed "$hist" 2)" || return 79
  else return 79; fi
  commercial_policy_rmt commercial_policy_py rollback-before-check "$row" || return $?
  # Repair records of the observed target only, never claim a successful candidate acceptance.
  commercial_policy_reconcile_metadata "$rel" || return $?
  row="$(hotcfg_rmt oc_hotcfg_history_nth_committed "$hist" 2)" || return 79
  commercial_policy_rmt commercial_policy_py rollback-before-check "$row" || return $?
  op="$(commercial_policy_rmt commercial_policy_py field operationId)" || return $?
  local original_marker="$DEPLOY_RECOVERY_MARKER" rollback_marker="$CP_ROOT/$op.rollback-recovery"
  # The shared saga still has a recovery marker: isolated per operation, never blank/bypassed.
  local COMMERCIAL_FAILURE_POLICY="" DEPLOY_RECOVERY_MARKER="$rollback_marker" ROLLBACK_N=1
  rollback || return $?
  ssh "$KL_HOST" "test ! -e '$rollback_marker'" || return 79
  # Re-enable typed checks in this function's scope; original context/manual evidence survived.
  COMMERCIAL_FAILURE_POLICY=user-impact-only; DEPLOY_RECOVERY_MARKER="$original_marker"
  commercial_policy_complete_compensation || return $?
  echo '✓ actual user impairment recovered by original guarded N1 rollback'
}
commercial_policy_complete_compensation() {
  local before target restart_egress egress_before current status direction authority
  before="$(commercial_policy_rmt commercial_policy_py field before.masterRelease)" || return $?
  target="$(commercial_policy_rmt commercial_policy_py field target.masterRelease)" || return $?
  commercial_policy_rmt commercial_policy_restore_disabled_current || return $?
  commercial_policy_rmt commercial_policy_py verify before "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$ACTIVE_SRC" "$ACTIVE_UNIT" >/dev/null || return $?
  status="$(commercial_policy_authority_status)" || return $?
  if [[ "$status" == original ]]; then
    # The original saga already restored service before state/history were committed.
    status="$(commercial_policy_rmt commercial_policy_verified_history)" || return $?
    [[ "$status" == missing ]] || return 79
    authority=original
  else
    status="$(commercial_policy_authority_status before)" || return $?
    [[ "$status" == applied ]] || return 79
    commercial_policy_rmt commercial_policy_compensated_history || return $?
    authority=reverted
  fi
  restart_egress="$(commercial_policy_rmt commercial_policy_py field options.restartEgress)" || return $?
  if [[ "$restart_egress" == true ]]; then
    egress_before="$(commercial_policy_rmt commercial_policy_py field options.egressBefore)" || return $?
    current="$(egress_running_cwd)" || return 79
    if [[ "$current" == "$target" ]]; then
      # Exactly converge the healthy target before asking the original reverse activation.
      egress_slots_remote stabilize-before-reverse "$target" "$egress_before" || return $?
      commercial_policy_reverse_egress "$egress_before" "$target" || return $?
    elif [[ "$current" != "$egress_before" ]]; then
      commercial_policy_rmt commercial_policy_reverse_unavailable || return $?
      commercial_policy_reverse_dead_egress "$egress_before" || return $?
    else
      commercial_policy_rmt commercial_policy_reverse_pointer "$egress_before" || return $?
    fi
    egress_slots_remote converge "$egress_before" "$target" || return $?
    wait_for_egress_release_ready "$egress_before" 0 30 || return 79
  fi
  direction="$(commercial_policy_rmt commercial_policy_py archive-direction)" || return $?
  if [[ "$direction" == before ]]; then
    commercial_policy_rmt commercial_policy_py clear-accepted-marker "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$ACTIVE_SRC" "$ACTIVE_UNIT" || return $?
    return 0
  fi
  local op
  op="$(commercial_policy_rmt commercial_policy_py field operationId)" || return $?
  ssh "$KL_HOST" "test ! -e '$CP_ROOT/$op.rollback-recovery'" || return 79
  BUILT_RELEASE="$before"
  commercial_policy_required_gates "$before" || return $?
  commercial_policy_rmt commercial_policy_py resolve before "$authority" "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$ACTIVE_SRC" "$ACTIVE_UNIT" || return $?
}
commercial_policy_reverse_egress() {
  local COMMERCIAL_FAILURE_POLICY=""
  activate_egress_release "$1" "$2"
}
commercial_policy_reverse_dead_egress() {
  local rel="$1" COMMERCIAL_FAILURE_POLICY="" CP_EGRESS_RESTORE=1
  require_mutation_lease_for_compensation policy-egress-outage-restore || return 86
  assert_release_marker "$rel" egress || return 79
  commercial_policy_rmt commercial_policy_reverse_pointer "$rel" || return $?
  egress_restart_in_place && wait_for_egress_release_ready "$rel" 0 60 || return 79
}
commercial_policy_restore_disabled_current() {
  commercial_policy_remote_owner || return 86
  local plan target current="$OC_HOTCFG_PLATFORM_ROOT/current"
  plan="$(commercial_policy_py before-current-plan "$OC_HOTCFG_ENV_FILE" "$OC_HOTCFG_PLATFORM_ROOT" "$CP_LIVE" "$CP_UNIT")" || return $?
  [[ "$(jq -r .needed <<<"$plan")" == true ]] || return 0
  target="$(jq -r .target <<<"$plan")" || return 79
  commercial_policy_remote_owner || return 86
  if [[ -n "$target" ]]; then
    rm -f "$current.policy-link" || return 79
    ln -s "$target" "$current.policy-link" || return 79
    mv -T "$current.policy-link" "$current" || return 79
  else rm -f "$current" || return 79; fi
  oc_hotcfg_fsync_path "$OC_HOTCFG_PLATFORM_ROOT" || return 79
}
commercial_policy_reverse_unavailable() {
  commercial_policy_remote_owner || return 86
  local before target pointer slot state pid cwd
  before="$(commercial_policy_py field options.egressBefore)" || return $?
  target="$(commercial_policy_py field target.masterRelease)" || return $?
  pointer="$(readlink -f /opt/openclaude/openclaude-v5-egress)" || return 79
  [[ "$pointer" == "$target" || "$pointer" == "$before" ]] || return 79
  state="$(systemctl is-active openclaude-v5-egress.service 2>/dev/null || true)"
  [[ "$state" == inactive || "$state" == failed ]] || return 79
  for slot in A B; do
    state="$(systemctl is-active "openclaude-v5-egress@$slot.service" 2>/dev/null || true)"
    [[ "$state" == failed || "$state" == inactive || "$state" == deactivating ]] || return 79
    pid="$(systemctl show -p MainPID --value "openclaude-v5-egress@$slot.service")" || return 79
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
      cwd="$(readlink -f "/proc/$pid/cwd")" || return 79
      [[ "$cwd" == "$before" || "$cwd" == "$target" ]] || return 79
    elif [[ "$pid" != 0 ]]; then return 79; fi
  done
  commercial_policy_port_refused || return $?
}

commercial_policy_reverse_pointer() {
  commercial_policy_remote_owner || return 86
  local rel="$1" before target pointer
  before="$(commercial_policy_py field options.egressBefore)" || return $?
  target="$(commercial_policy_py field target.masterRelease)" || return $?
  pointer="$(readlink -f /opt/openclaude/openclaude-v5-egress)" || return 79
  [[ "$rel" == "$before" && ( "$pointer" == "$target" || "$pointer" == "$before" ) ]] || return 79
  commercial_policy_remote_owner || return 86
  rm -f /opt/openclaude/openclaude-v5-egress.policy-link || return 79
  ln -s "$rel" /opt/openclaude/openclaude-v5-egress.policy-link || return 79
  mv -T /opt/openclaude/openclaude-v5-egress.policy-link /opt/openclaude/openclaude-v5-egress || return 79
  oc_hotcfg_fsync_path /opt/openclaude || return 79
  systemctl daemon-reload || return 79
}

commercial_policy_compensated_history() {
  commercial_policy_remote_owner || return 86
  commercial_policy_py compensated-history-status >/dev/null || return $?
  local hist one two
  hist="$(commercial_policy_py field history.path)" || return $?
  one="$(tail -n 2 "$hist" | head -n1)" || return 79
  two="$(tail -n1 "$hist")" || return 79
  one="$(oc_hotcfg__history_verify_line "$one")" || return 79
  two="$(oc_hotcfg__history_verify_line "$two")" || return 79
  jq -e --argjson one "$one" '.schemaVer==3 and ((.preState//false)==false) and .seq==($one.seq+1)' <<<"$two" >/dev/null || return 79
  commercial_policy_remote_owner || return 86
}

commercial_policy_egress() {
  commercial_policy_remote_owner || return 86
  CP_EGRESS_POLICY=1 bash "$CP_BUNDLE/v5-egress-slots.sh" "$@"
}
commercial_policy_egress_failure() { # proven failed target only; a private-health timeout is not proof
  commercial_policy_remote_owner || return 86
  local target_unit="openclaude-v5-egress@$1.service" state pid attempt
  attempt="$(commercial_policy_py egress-slot)" || return $?
  [[ "$1" == "$attempt" ]] || return 79
  state="$(systemctl is-active "$target_unit" 2>/dev/null || true)"
  pid="$(systemctl show "$target_unit" -p MainPID --value 2>/dev/null || true)"
  if [[ "$state" == failed && "$pid" == 0 ]]; then return 0; fi
  return 79
}

commercial_policy_verified_history() {
  commercial_policy_remote_owner || return 86
  local status hist line verified prior expected
  status="$(commercial_policy_py history-status)" || return $?
  if [[ "$status" == applied ]]; then
    hist="$(commercial_policy_py field history.path)" || return $?
    line="$(tail -n 1 -- "$hist")" || return 79
    verified="$(oc_hotcfg__history_verify_line "$line")" || return 79
    prior=""
    while IFS= read -r line; do
      if prior="$(oc_hotcfg__history_verify_line "$line")"; then break; fi
      prior=""
    done < <(head -n -1 -- "$hist" | tac)
    expected=1
    if [[ -n "$prior" ]]; then
      expected="$(jq -er '.seq // 0' <<<"$prior")" || return 79
      expected=$((expected+1))
    fi
    jq -e '.schemaVer==3 and ((.preState // false)==false)' <<<"$verified" >/dev/null || return 79
    [[ "$(jq -r .seq <<<"$verified")" == "$expected" ]] || return 79
  fi
  printf '%s\n' "$status"
}

# Original activation caller, moved without changing bytes to keep the publisher size gate.

activate_runtime_tuple() {
  echo "── 激活 runtime tuple saga ──"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] saga: [pre-state(首启)]→[canary validate-only]→extra_apply(master symlink→$BUILT_RELEASE)→env tuple(四键恒写,禁用轴空值)→[flip current]→restart→smoke→history commit"
    return 0
  fi
  assert_commercial_flavor_on_target "$BUILT_RELEASE" || return 1
  assert_release_marker "$BUILT_RELEASE" || return 1
  assert_release_required_migrations "$BUILT_RELEASE" || return 1
  assert_release_baseline_security "$BUILT_RELEASE" || return 1
  # hotcfg 路径的 master symlink 翻转走 saga 的 extra_apply,**不经 activate_release** →
  # 两个 capability 门必须在这里显式再挂一次(否则开了 hotcfg 就等于绕过了所有制品守卫)。
  # 容器 tuple 面由 lib 的 assert_tuple_viable ③ 在 saga 内覆盖(release MANIFEST / 镜像 label)。
  assert_release_capability_for_sessions_pg "$BUILT_RELEASE"
  assert_lossless_turn_tape_floor "$BUILT_RELEASE"
  assert_model_authority_floor "$BUILT_RELEASE"
  local prev_src old_prev="" image image_id release bundle_val flip_rev restart_cmd smoke_cmd extra_apply extra_revert prev_apply="" prev_revert=""
  prev_src="$(bg_current_release "$ACTIVE_SRC")"
  [[ -n "$prev_src" ]] || { echo "✗ hotcfg 激活前无法解析 slot=$ACTIVE_SLOT 当前 release" >&2; return 1; }
  assert_web_storage_rollback_transition \
    "$prev_src" "${ACTIVE_STATE_PREVIOUS_RELEASE:-}" "$BUILT_RELEASE" \
    "runtime hotcfg master activation" || return 1
  assert_release_marker "$prev_src" || {
    echo "✗ hotcfg 激活前 exact predecessor marker 无效:$prev_src" >&2; return 1;
  }
  assert_direct_turn_timeline_pair "$prev_src" "$BUILT_RELEASE" "runtime hotcfg activation" || return 1
  # M7c:快照翻转**前**的 .prev-release 指针内容,失败恢复时一并还原(否则 saga 失败一次丢 rollback 指针)。
  if [[ "$ACTIVE_SLOT" == A ]]; then
    old_prev="$(ssh "$KL_HOST" "cat '$RELEASES_ROOT/.prev-release' 2>/dev/null || true")"
    prev_apply="printf '%s\\n' '$prev_src' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release';"
    if [[ -n "$old_prev" ]]; then
      prev_revert="printf '%s\\n' '$old_prev' > '$RELEASES_ROOT/.prev-release.tmp' && mv -f '$RELEASES_ROOT/.prev-release.tmp' '$RELEASES_ROOT/.prev-release';"
    else
      prev_revert="rm -f '$RELEASES_ROOT/.prev-release';"
    fi
  fi
  # image / image_id **恒写**:release 轴启用则用刚 inspect 的;否则从 env 取 image 并 inspect 出 id(供 stale/label/canary)。
  if hotcfg_release_axis_on; then
    image="$RUNTIME_IMAGE_REF"; image_id="$RUNTIME_IMAGE_ID"; release="$BUILT_RUNTIME_RELEASE"
  else
    if [[ "$DISABLE_RELEASE_FLAG" == 1 && -n "$EMERG_IMAGE" ]]; then
      # R3-B1:禁用 release 轴时显式切换到内嵌源码镜像(tuple 可行性守卫要求 embed_source≠0;
      # ID 就地核验,tag 漂移在此拦下而非等 saga)。
      image="$EMERG_IMAGE"
      image_id="$(ssh "$KL_HOST" "docker image inspect --format '{{.Id}}' '$image'" 2>/dev/null || true)"
      [[ "$image_id" == "$EMERG_IMAGE_ID" ]] \
        || { echo "✗ --image 的 immutable ID($image_id)与 --image-id($EMERG_IMAGE_ID)不符" >&2; return 1; }
    else
      image="$(ssh "$KL_HOST" "grep '^OC_RUNTIME_IMAGE=' '$V5_ENV' | tail -n1 | cut -d= -f2-")"
      image_id="$(ssh "$KL_HOST" "docker image inspect --format '{{.Id}}' '$image'" 2>/dev/null || true)"
    fi
    # R2-B1:release 轴禁用/未启用 → 传**空串**(恒写 OC_RUNTIME_RELEASE=,值空=禁用,--disable 后即稳态)。
    # 注:saga 内 oc_hotcfg_assert_tuple_viable 会对"镜像 embed_source=0 + 空 release"fail-loud(R3-B1)。
    release=""
  fi
  # This activation introduces a v2 writer together with its capable master.
  # Prove the actual target tuple before any saga side effect, even before the
  # first tape exists; metadata-only declarations are insufficient.
  assert_lossless_runtime_tuple_capability "$image_id" "$release" || return 1
  # bundle 轴:启用则翻新 rev + 写新绝对路径;禁用/未启用 → flip_rev 空(不翻 current)+ 写空值(R2-B1)。
  if hotcfg_bundle_axis_on; then
    flip_rev="$BUILT_BUNDLE_REV"; bundle_val="$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV"
  else
    flip_rev=""; bundle_val=""
  fi
  restart_cmd="systemctl restart '$ACTIVE_UNIT'"
  # 远端核心健康门(fail-closed):ok=true + channel=v5 + sessionsDb=ok(与 smoke() 深度探活同不变量)。
  # 全量 smoke(调度器白名单等第二道防线)在 saga 提交后由 deploy() 另跑本地 smoke() 兜底。
  smoke_cmd="$(hotcfg_core_smoke_cmd)"
  # extra:master 源码 symlink 翻转(先原子落 .prev-release=prev_src,再 ln+mv -T);
  # revert(M7c):**先还原 .prev-release=old_prev**(翻转前快照),再翻回 master symlink=prev_src。
  extra_apply="$prev_apply rm -f '$ACTIVE_SRC.hotlink'; ln -s '$BUILT_RELEASE' '$ACTIVE_SRC.hotlink'; mv -T '$ACTIVE_SRC.hotlink' '$ACTIVE_SRC'"
  extra_revert="$prev_revert rm -f '$ACTIVE_SRC.hotlink'; ln -s '$prev_src' '$ACTIVE_SRC.hotlink'; mv -T '$ACTIVE_SRC.hotlink' '$ACTIVE_SRC'"
  if commercial_policy_enabled; then
    printf -v extra_apply 'commercial_policy_flip_source %q %q %q %q %q' "$ACTIVE_SRC" "$BUILT_RELEASE" "$RELEASES_ROOT/.prev-release" "$prev_src" "$ACTIVE_SLOT"
    printf -v extra_revert 'commercial_policy_flip_source %q %q %q %q %q' "$ACTIVE_SRC" "$prev_src" "$RELEASES_ROOT/.prev-release" "$old_prev" "$ACTIVE_SLOT"
  fi
  build_hotcfg_state_hooks "$BUILT_RELEASE"
  commercial_policy_configure || return $?
  local policy_adapter=""
  commercial_policy_enabled && policy_adapter=commercial_policy_saga_adapter
  # M7a:masterRelease=$BUILT_RELEASE(本次激活的 master 蓝绿 release)进 history,rollback 从同一条取回对齐。
  # R2-B2:prev_master=$prev_src(激活前 live master)供首次启用的 pre-state 记录。
  hotcfg_rmt oc_hotcfg_activate_saga \
    "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$flip_rev" "$OC_HOTCFG_HISTORY" \
    "$image" "$image_id" "$release" "$bundle_val" \
    "$restart_cmd" "$smoke_cmd" "$extra_apply" "$extra_revert" "$BUILT_RELEASE" "$prev_src" \
    "$HOTCFG_STATE_COMMIT_CMD" "$HOTCFG_STATE_REVERT_CMD" "$DEPLOY_RECOVERY_MARKER" "joint" "$policy_adapter" \
    || { local rc=$?; if commercial_policy_enabled; then echo "✗ activation saga failed(rc=$rc); inspect policy context before compensation" >&2; else echo "✗ 激活 saga 失败,已自动回滚旧 tuple(env/current/master 源码/.prev-release/重启旧 master)" >&2; fi; return "$rc"; }
  ACTIVE_STATE_PREVIOUS_RELEASE="$ACTIVE_STATE_RELEASE"
  ACTIVE_STATE_RELEASE="$BUILT_RELEASE"
  ACTIVE_STATE_LOCK_VERSION=$((ACTIVE_STATE_LOCK_VERSION + 1))
  echo "  ✓ runtime tuple 激活并提交 history(release=${release:-<none>} bundle=${flip_rev:-<unchanged>} master=$BUILT_RELEASE)"
  run "sleep 3"
}


commercial_policy_flip_source() {
  commercial_policy_remote_owner || return 86
  local src="$1" target="$2" previous_file="$3" previous_value="$4" slot="$5"
  if [[ "$slot" == A ]]; then
    if [[ -n "$previous_value" ]]; then
      printf '%s\n' "$previous_value" >"$previous_file.tmp" || return 1
      mv -f "$previous_file.tmp" "$previous_file" || return 1
    else rm -f "$previous_file" || return 1; fi
    oc_hotcfg_fsync_path "$(dirname "$previous_file")" || return 1
  fi
  commercial_policy_remote_owner || return 86
  rm -f "$src.hotlink" || return 1
  ln -s "$target" "$src.hotlink" || return 1
  mv -T "$src.hotlink" "$src" || return 1
  oc_hotcfg_fsync_path "$(dirname "$src")" || return 1
}

commercial_policy_keep_failed() { # restore compatible target Plugin access without old source/pin compensation
  local original_rc="$1"
  assert_mutation_lease_alive policy-keep-service || return 86
  commercial_policy_rmt commercial_policy_py verify target "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$ACTIVE_SRC" "$ACTIVE_UNIT" >/dev/null || return $?
  knowledge_planet_plugin_open_gate_to_release "$BUILT_RELEASE" "$BUILT_RELEASE" || return 79
  assert_mutation_lease_alive policy-keep-weibo || return 86
  case "$WEIBO_DEPLOY_BRACKET" in
    1) weibo_plugin_open_gate_to_release "$BUILT_RELEASE" "$BUILT_RELEASE" || return 79 ;;
    0)
      weibo_plugin_advisory_gate "$BUILT_RELEASE" || return 79
      [[ "$WB_PIN_ALIGNED" == 1 ]] || return 79
      ;;
    *) return 79 ;;
  esac
  return "$original_rc"
}

commercial_policy_egress_unavailable() { # actual user impairment, never inferred from a gate timeout
  commercial_policy_remote_owner || return 86
  local expected="$1" target slot state pid
  target="$(commercial_policy_py field target.masterRelease)" || return $?
  [[ "$expected" == "$target" && "$(readlink -f /opt/openclaude/openclaude-v5-egress)" == "$target" ]] || return 1
  slot="$(commercial_policy_py egress-slot)" || return $?
  [[ "$slot" == A || "$slot" == B ]] || return 1
  state="$(systemctl is-active "openclaude-v5-egress@$slot.service" 2>/dev/null || true)"
  pid="$(systemctl show "openclaude-v5-egress@$slot.service" -p MainPID --value 2>/dev/null || true)"
  [[ "$state" == failed && "$pid" == 0 ]] || return 1
  [[ "$(systemctl show "openclaude-v5-egress@$slot.service" -p WorkingDirectory --value)" == /opt/openclaude/openclaude-v5-egress ]] || return 1
  local rc=0
  python3 -B - <<'EGRESS_IMPACT' || rc=$?
import errno,socket,sys
try:
    with socket.create_connection(('172.31.0.1',18892),timeout=3):sys.exit(1)
except OSError as error:sys.exit(0 if error.errno==errno.ECONNREFUSED else 1)
EGRESS_IMPACT
  commercial_policy_remote_owner || return 86
  return "$rc"
}

commercial_policy_port_refused() {
  local rc=0
  python3 -B - <<'EGRESS_REFUSED' || rc=$?
import errno,socket,sys
try:
    with socket.create_connection(('172.31.0.1',18892),timeout=3):sys.exit(79)
except OSError as error:sys.exit(0 if error.errno==errno.ECONNREFUSED else 79)
EGRESS_REFUSED
  commercial_policy_remote_owner || return 86
  return "$rc"
}
commercial_policy_egress_target() {
  commercial_policy_remote_owner || return 86
  local target="$1" cur="$2" before info
  [[ "$target" == A || "$target" == B ]] || return 79
  before="$(commercial_policy_py field options.egressBefore)" || return $?
  if [[ -n "$cur" ]]; then
    [[ "$cur" != "$target" ]] || return 79
    info="$(policy_slot_identity "$cur")" || return 79
    [[ "$(awk '{print $2}' <<<"$info")" == "$before" ]] || return 79
    wait_slot_ready "$cur" && policy_unique_listener "$(awk '{print $1}' <<<"$info")" || return 79
  else commercial_policy_port_refused || return $?; fi
  commercial_policy_remote_owner || return 86
  commercial_policy_py egress-attempt "$target" || return $?
  local actual_attempt
  actual_attempt="$(commercial_policy_py egress-slot)" || return $?
  [[ "$actual_attempt" == "$target" ]] || return 79
}

build_hotcfg_state_hooks() {  # $1=target master release
  local target="$1" apply_sql revert_sql status_sql next_lock
  next_lock=$((ACTIVE_STATE_LOCK_VERSION + 1))
  apply_sql="$(ds_stable_release_commit_sql "$ACTIVE_STATE_LOCK_VERSION" "$ACTIVE_SLOT" "$ACTIVE_STATE_RELEASE" "$target")"
  revert_sql="$(ds_stable_release_revert_sql "$next_lock" "$ACTIVE_SLOT" "$target" "$ACTIVE_STATE_RELEASE" "$ACTIVE_STATE_PREVIOUS_RELEASE")"
  status_sql="$(ds_stable_release_status_sql "$ACTIVE_STATE_LOCK_VERSION" "$ACTIVE_SLOT" \
    "$ACTIVE_STATE_RELEASE" "$ACTIVE_STATE_PREVIOUS_RELEASE" "$target")"
  # commit 三态协议:0=applied(含“UPDATE 已提交但回执丢失后回读确认”)；10=original 确认；
  # 11=unknown。命令包在子 shell，避免 exit/return 穿透调用 saga。
  printf -v HOTCFG_STATE_COMMIT_CMD \
    '( set -a; . %q; if out="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAq -c %q 2>/dev/null)" && [ -n "$out" ]; then exit 0; fi; for i in 1 2 3; do status="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAq -c %q 2>/dev/null || true)"; status="$(printf %%s "$status" | tr -d "[:space:]")"; case "$status" in applied) exit 0 ;; original) exit 10 ;; esac; sleep 1; done; exit 11 )' \
    "$V5_ENV" "$apply_sql" "$status_sql"
  # revert 是幂等 reconcile：无论 apply 明确成功、回执不明或明确未命中，只有回读确认
  # original/reverted 才返回 0；PG 不可读/竞争/alien state 均返回 11，让 saga 保持新运行面。
  printf -v HOTCFG_STATE_REVERT_CMD \
    '( set -a; . %q; for i in 1 2 3; do out="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAq -c %q 2>/dev/null || true)"; [ -n "$out" ] && exit 0; status="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAq -c %q 2>/dev/null || true)"; status="$(printf %%s "$status" | tr -d "[:space:]")"; case "$status" in original|reverted) exit 0 ;; esac; sleep 1; done; exit 11 )' \
    "$V5_ENV" "$revert_sql" "$status_sql"
}
