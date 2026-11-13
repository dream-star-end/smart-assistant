# shellcheck shell=bash
# Globals below are consumed by the sourcing deploy script and its build helpers.
# shellcheck disable=SC2034
# P4: preparation never holds deploy.lock. The independent artifact mutex only
# serializes build/cache writers and excludes selfhost GC; it grants no live writes.
SELFHOST_PREPARED_ROOT="${OC_V5_SELFHOST_PREPARED_ROOT:-/var/lib/openclaude-v5-selfhost/prepared}"
SELFHOST_PREPARE_LOCK="${OC_V5_SELFHOST_PREPARE_LOCK:-/run/openclaude-v5-selfhost/prepare.lock}"
SELFHOST_PREPARE_HELD=0
SELFHOST_SPLIT_PREPARED=0
SELFHOST_PREPARED_OPTIONS=""

selfhost_prepare_lock() {
  [[ "$SELFHOST_PREPARE_HELD" == 1 ]] && return 0
  selfhost_lock_py prepare "$SELFHOST_PREPARE_LOCK" "$SELFHOST_DEPLOY_LOCK_DIR"
  exec 9<>"$SELFHOST_PREPARE_LOCK"
  flock 9 || die "cannot acquire selfhost artifact lock"
  SELFHOST_PREPARE_HELD=1
}

selfhost_prepare_unlock() {
  exec 9>&-
  SELFHOST_PREPARE_HELD=0
}

selfhost_prepared_state() { # <action> <sha> [identity/paths...]
  python3 "$SCRIPT_DIR/lib/v5-selfhost-prepared.py" "$1" "$SELFHOST_PREPARED_ROOT" "${@:2}"
}

selfhost_prepare_assert_tip() { # <sha>; no ref update, live state or canonical checkout mutation
  local sha="$1" tip
  tip="$(git -C "$REPO_ROOT" ls-remote --exit-code origin refs/heads/feat/v5-selfhost)" \
    || die "cannot verify selfhost remote tip; prepared candidate refused"
  [[ "$tip" == "$sha"$'\t'refs/heads/feat/v5-selfhost ]] \
    || die "selfhost tip changed; discard prepared $sha and prepare the new tip"
  git -C "$REPO_ROOT" cat-file -e "$sha^{commit}" \
    || die "prepared source object missing; fetch the selfhost tip first"
  # Ahead-of-HEAD preparation may use this controller only when its build/guard
  # definitions are byte-identical to the target. Gate scripts themselves execute
  # from the pinned archive. Controller changes require refreshing the checkout.
  git -C "$REPO_ROOT" diff --quiet "$sha" -- scripts/deploy-v5-selfhost.sh \
    scripts/v5-selfhost-master-release-lib.sh scripts/v5-runtime-release-lib.sh scripts/lib \
    || die "prepared source changes the build controller; refresh canonical before preparing"
}

selfhost_prepare_identity() { # must run with artifact mutex held
  local sha="$1" key bun_version
  key="$(master_web_dist_key "$sha")" || die "cannot bind prepared web inputs"
  RUNTIME_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$RUNTIME_IMAGE")" \
    || die "cannot bind prepared runtime image"
  bun_version="$("$OC_BUN_BIN" --version)" || die "cannot bind bun version"
  SELFHOST_PREPARED_OPTIONS="$(printf '%s\n' "$key" "${FORCE_NPM_CI:-0}" \
    "${OC_V5_FORCE_WEB_BUILD:-0}" "${OC_V5_ALLOW_WORKTREE_DONOR:-0}" \
    "$bun_version" | sha256sum | cut -d' ' -f1)"
}

selfhost_prepared_receipt() { # <read|write> <sha>
  local action="$1" sha="$2" tree
  tree="$(git -C "$REPO_ROOT" rev-parse "$sha^{tree}")" || return 1
  local -a args=("$tree" "$SELFHOST_PREPARED_OPTIONS" "$RUNTIME_IMAGE" "$RUNTIME_IMAGE_ID"
    "$MASTER_RELEASES_ROOT" "$OC_HOTCFG_RELEASES_ROOT" "$OC_HOTCFG_PLATFORM_ROOT/bundles")
  if [[ "$action" == write ]]; then
    args+=("$BUILT_MASTER_RELEASE" "$BUILT_RUNTIME_RELEASE" "$CUTOVER_TUPLE_BUNDLE")
  fi
  selfhost_prepared_state "$action" "$sha" "${args[@]}"
}

selfhost_prepared_load() { # <sha>; failures must not leave partially assigned artifact paths
  local doc master runtime bundle
  doc="$(selfhost_prepared_receipt read "$1")" || return 1
  master="$(jq -er '.master.path' <<<"$doc")" || return 1
  runtime="$(jq -er '.runtime.path' <<<"$doc")" || return 1
  bundle="$(jq -er '.bundle.path' <<<"$doc")" || return 1
  python3 "$SCRIPT_DIR/lib/v5-selfhost-digest.py" verify "$runtime" >/dev/null || return 1
  python3 "$SCRIPT_DIR/lib/v5-selfhost-digest.py" verify "$bundle" >/dev/null || return 1
  BUILT_MASTER_RELEASE="$master"
  BUILT_RUNTIME_RELEASE="$runtime"
  CUTOVER_TUPLE_BUNDLE="$bundle"
  BUILT_BUNDLE_REV="${bundle##*/}"
}

selfhost_prepare_candidate() { # <sha>; default deploy and standalone prepare share every gate
  local sha="$1"
  [[ "${OC_V5_SELFHOST_DEPLOY_LOCK_HELD:-0}" != 1 && ! -e /proc/$$/fd/8 ]] \
    || die "prepare refuses an inherited deploy lock/fd"
  [[ "${OC_V5_SKIP_TRAILER_GATE:-0}" != 1 ]] || die "prepare requires the trailer gate"
  selfhost_prepare_lock
  selfhost_prepared_state init "$sha" || die "cannot initialize trusted prepared state"
  # Validate after waiting for the artifact lock and before deleting any receipt:
  # a delayed request for an old SHA must not invalidate a newer ready candidate.
  selfhost_prepare_assert_tip "$sha"
  selfhost_prepared_state prune "$sha" || die "cannot invalidate stale prepared receipts"
  selfhost_prepare_identity "$sha"
  if [[ -e "$SELFHOST_PREPARED_ROOT/$sha.json" ]]; then
    if selfhost_prepared_load "$sha"; then
      log "  ✓ reuse sealed prepared candidate source=$sha"
      selfhost_prepare_unlock
      return 0
    fi
    selfhost_prepared_state remove "$sha" || die "cannot invalidate rejected receipt"
    die "prepared candidate damaged or inputs changed; receipt invalidated, run prepare again"
  fi
  # L0 build-space admission runs only when a build is needed. A valid sealed
  # receipt already passed it; flip does not allocate another candidate tree.
  selfhost_release_preflight "$sha" prepared
  MASTER_RUNTIME_BG_AFTER_ADMISSION=1
  build_master_release "$sha"
  [[ -f "$BUILT_MASTER_RELEASE/.complete" ]] || die "prepared master is not sealed"
  tsum_mark P.runtime-wait 2>/dev/null || :
  collect_runtime_release_bg "$sha"
  tsum_mark P.platform-bundle 2>/dev/null || :
  # Use the validator from this exact sealed source, never a moving worktree.
  local SEED_CLI="$BUILT_MASTER_RELEASE/packages/commercial/agent-sandbox/platform-runtime/entrypoint/validatePlatformSeedCli.ts"
  build_platform_bundle "$sha"
  CUTOVER_TUPLE_BUNDLE="$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV"
  selfhost_prepare_assert_tip "$sha"
  selfhost_prepared_receipt write "$sha" || die "cannot seal prepared receipt"
  selfhost_prepare_unlock
}

selfhost_prepared_enter_flip() { # <sha>; no build/resource wait while deploy.lock is held
  local sha="$1" verify_start verify_rc=0
  tsum_mark A.flip-lock-wait 2>/dev/null || :
  acquire_selfhost_deploy_lock
  prewarm_quiesce "$SELFHOST_DEPLOY_LOCK" || die "prewarm did not stop; flip refused"
  selfhost_prepare_assert_tip "$sha"
  [[ "$(source_commit)" == "$sha" ]] \
    || die "canonical HEAD changed; prepared candidate refused at flip"
  # Never hold deploy.lock waiting behind a long preparation: fail and retry later.
  selfhost_lock_py prepare "$SELFHOST_PREPARE_LOCK" "$SELFHOST_DEPLOY_LOCK_DIR"
  exec 9<>"$SELFHOST_PREPARE_LOCK"
  flock -n 9 || die "another prepare owns artifacts; retry flip after it finishes"
  SELFHOST_PREPARE_HELD=1
  selfhost_prepare_identity "$sha"
  verify_start="$EPOCHREALTIME"
  selfhost_prepared_load "$sha" || verify_rc=$?
  tsum_note flip.verifySec "$(awk -v start="$verify_start" -v end="$EPOCHREALTIME" 'BEGIN { printf "%.3f", end-start }')" 2>/dev/null || :
  [[ "$verify_rc" == 0 ]] || die "prepared receipt no longer valid at flip"
  selfhost_prepare_unlock
  SELFHOST_SPLIT_PREPARED=1
  tsum_mark E0.locked-preflight 2>/dev/null || :
}

cmd_prepare() {
  [[ "$DRY" != 1 ]] || { log "[dry-run] prepare pinned artifacts without deploy.lock"; return 0; }
  [[ -n "$LEASE_TARGET_SHA" ]] || die "--prepare requires --target-sha"
  PLATFORM_FROM_HEAD=1
  selfhost_prepare_assert_tip "$LEASE_TARGET_SHA"
  preflight_common
  assert_fix_trailers "$LEASE_TARGET_SHA"
  selfhost_prepare_candidate "$LEASE_TARGET_SHA"
  log "✓ prepared source=$LEASE_TARGET_SHA; live untouched"
}

# Keep the receipt across a pre-mutation/idle failure, so retry can repeat E1–G.
# A successful flip consumes only its own master candidate, never a newer build.
selfhost_prepared_complete() { # <sha> <master-release>
  (
    selfhost_lock_py prepare "$SELFHOST_PREPARE_LOCK" "$SELFHOST_DEPLOY_LOCK_DIR" || exit 1
    exec 9<>"$SELFHOST_PREPARE_LOCK"
    flock -n 9 || exit 0  # next prepare/GC will prune the stale receipt
    selfhost_prepared_state consume "$1" "$2"
  )
}

selfhost_prepared_gc() { # <command...>; subshell owns the GC artifact lock until command returns
  (
    if [[ "$SELFHOST_PREPARE_HELD" != 1 ]]; then
      selfhost_lock_py prepare "$SELFHOST_PREPARE_LOCK" "$SELFHOST_DEPLOY_LOCK_DIR" || exit 1
      exec 9<>"$SELFHOST_PREPARE_LOCK"
      flock -n 9 || { log "  GC deferred: prepare is running"; exit 0; }
    fi
    if [[ -e "$SELFHOST_PREPARED_ROOT" || -L "$SELFHOST_PREPARED_ROOT" ]]; then
      # A read error also defers GC. No prepared evidence may disappear underneath flip.
      local rc=0 tip
      tip="$(git -C "$REPO_ROOT" ls-remote --exit-code origin refs/heads/feat/v5-selfhost)" \
        || { log "  GC deferred: remote tip unverifiable"; exit 0; }
      tip="${tip%%$'\t'*}"
      selfhost_prepared_state prune "$tip" \
        || { log "  GC deferred: prepared state unreadable"; exit 0; }
      selfhost_prepared_state pending "$tip" || rc=$?
      [[ "$rc" == 1 ]] || { log "  GC deferred: prepared artifacts await flip"; exit 0; }
    fi
    "$@"
  )
}
