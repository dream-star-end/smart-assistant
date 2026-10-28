#!/usr/bin/env bash
# P6: keep a fully gated candidate only when user idleness prevents exposure.
# No receipt inside rel-* (that would invalidate the immutable master digest).

selfhost_idle_retry_data() {
  python3 "$SCRIPT_DIR/lib/v5-selfhost-idle-retry.py" "$1" \
    "$MASTER_RELEASES_ROOT" "$OC_HOTCFG_RELEASES_ROOT" "$OC_HOTCFG_PLATFORM_ROOT/bundles" "${@:2}"
}

selfhost_idle_retry_load() { # <exact invocation SHA>; ordinary build on any miss
  [[ "$DRY" != 1 && "$PLATFORM_FROM_HEAD" == 1 ]] || return 1
  release_policy_enabled && return 1
  release_policy_lock_is_owned || return 1
  local row master runtime bundle image iid current
  row="$(selfhost_idle_retry_data load "$1" 2>/dev/null)" || return 1
  IFS=$'\t' read -r master runtime bundle image iid <<<"$row"
  [[ "$image" == "$RUNTIME_IMAGE" ]] || return 1
  current="$(docker image inspect --format '{{.Id}}' "$RUNTIME_IMAGE")" || return 1
  [[ "$current" == "$iid" ]] || return 1
  web_dist_donor_sealed "$master" || return 1
  oc_hotcfg_verify_manifest_full "$runtime" || return 1
  oc_hotcfg_verify_manifest_full "$bundle" || return 1
  BUILT_MASTER_RELEASE="$master"
  BUILT_RUNTIME_RELEASE="$runtime"
  BUILT_BUNDLE_REV="${bundle##*/}"
  RUNTIME_IMAGE_ID="$iid"
  tsum_note idleRetry.reused "$master" 2>/dev/null || :
  log "  ✓ 复用用户空闲超时的已封候选 $master;仍执行 E1–G 全部门禁"
}

selfhost_idle_retry_save() { # called only after the E3 busy timeout, before any exposure
  [[ "$DRY" != 1 && "$PLATFORM_FROM_HEAD" == 1 && "${CUTOVER_MUTATED:-0}" == 0 \
     && "${CUTOVER_JOINT:-0}" == 1 && "${DEPLOY_BUILT_RELEASE:-}" == "$1" ]] || return 1
  release_policy_enabled && return 1
  release_policy_lock_is_owned || return 1
  selfhost_idle_retry_data save "$DEPLOY_BUILT_SOURCE_COMMIT" "$1" \
    "$BUILT_RUNTIME_RELEASE" "$CUTOVER_TUPLE_BUNDLE" "$RUNTIME_IMAGE" "$RUNTIME_IMAGE_ID"
}

selfhost_wait_idle_or_defer() { # <seconds> [sealed candidate]; never defers query/permission errors
  local rc=0
  cutover_wait_for_user_idle "$1" || rc=$?
  [[ "$rc" != 0 ]] || return 0
  if [[ "$rc" == 75 ]] && ! release_policy_enabled; then
    if [[ -n "${2:-}" ]]; then
      selfhost_idle_retry_save "$2" || { log '✗ 无法保留空闲重试候选;不自动重试'; return 1; }
    fi
    lease_train_finish failed user-idle-deferred
  fi
  return "$rc"
}

selfhost_master_gc() {
  # Called only under the selfhost deployment lock; GC's own census remains fail-closed.
  [[ "${DRY:-0}" != 1 ]] || return 1
  release_policy_lock_is_owned || return 1
  local candidate=""
  if [[ -e "$MASTER_RELEASES_ROOT/.idle-retry.json" || -L "$MASTER_RELEASES_ROOT/.idle-retry.json" ]]; then
    candidate="$(selfhost_idle_retry_data protect)" || return 75
  fi
  bash "$SCRIPT_DIR/v5-release-gc.sh" \
    "$MASTER_RELEASES_ROOT" 3 \
    "$MASTER_LIVE_LINK" "$MASTER_LIVE_LINK" "$MASTER_LIVE_LINK" \
    "$MASTER_RELEASES_ROOT/.prev-release" \
    "$V5_UNIT" "$(egress_slot_unit A service)" "$(egress_slot_unit B service)" \
    '' "$candidate" ''
}

selfhost_preflight_disk_recover() {
  # rpf_check_* stays read-only. Only the locked deploy caller may repair disk pressure.
  [[ "${MODE:-}" == deploy && "${DRY:-0}" != 1 ]] || return 1
  local i
  for i in "${!RPF_STATUS[@]}"; do
    if [[ "${RPF_CHECK[$i]}" == disk && "${RPF_STATUS[$i]}" == fail ]]; then
      mlog '  disk preflight 失败;持 selfhost 锁运行一次引用感知 master GC 后重查 L0'
      selfhost_master_gc || return 1
      return 0
    fi
  done
  return 1
}
