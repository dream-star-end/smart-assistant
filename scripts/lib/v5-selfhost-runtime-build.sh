#!/usr/bin/env bash
# shellcheck disable=SC2034 # Outputs are read by the sourcing deploy/prewarm caller.
# Selfhost runtime builder shared by ordinary trains and speculative prewarming.

runtime_caps_from_metadata() {
  local sha="$1"
  git -C "$REPO_ROOT" show "${sha}:deploy/v5/release-metadata.json" \
    | jq -er '.runtimeCapabilities | join(" ")'
}

build_runtime_release() {
  local sha="$1" caps nonce raw staging prev image_id warm
  log "── build runtime release(git archive + prune + finalize) ──"
  caps="$(runtime_caps_from_metadata "$sha")" \
    || die "读 release-metadata.json runtimeCapabilities 失败"
  image_id="$(docker image inspect --format '{{.Id}}' "$RUNTIME_IMAGE")" \
    || die "inspect runtime 镜像失败"
  RUNTIME_IMAGE_ID="$image_id"
  if [[ "$DRY" == 1 ]]; then
    echo "  [dry-run] git archive $sha → prune --exclude-from=$EXCLUDES → oc_hotcfg_finalize_release"
    BUILT_RUNTIME_RELEASE="$OC_HOTCFG_RELEASES_ROOT/rel-dryrunrelease"
    return 0
  fi
  if [[ "${PREWARM_RUNTIME_BUILD:-0}" != 1 ]]; then
    warm="$(prewarm_runtime_donor "$sha" "$image_id" "$caps" 2>/dev/null || true)"
    if [[ -n "$warm" ]]; then
      BUILT_RUNTIME_RELEASE="$warm"
      log "  ✓ runtime prewarm hit (full digest reverified): $warm"
      return 0
    fi
  fi
  prev="$(oc_hotcfg_env_get "$V5_ENV" OC_RUNTIME_RELEASE || true)"
  nonce="$(openssl rand -hex 8)"
  raw="$OC_HOTCFG_RELEASES_ROOT/.raw-$nonce"
  staging="$OC_HOTCFG_RELEASES_ROOT/.staging-$nonce"
  mkdir -p "$OC_HOTCFG_RELEASES_ROOT"
  rm -rf "$raw" "$staging"
  mkdir -p "$raw" "$staging"
  git -C "$REPO_ROOT" archive --format=tar "$sha" | tar -x -C "$raw" \
    || { rm -rf "$raw" "$staging"; die "git archive 失败"; }
  rsync -a --exclude-from="$raw/packages/commercial/agent-sandbox/runtime-src-excludes.txt" "$raw/" "$staging/" \
    || { rm -rf "$raw" "$staging"; die "rsync prune 失败"; }
  rm -rf "$raw"
  write_flavor_manifest "$staging" selfhost "$sha" \
    || { rm -rf "$staging"; die "写 runtime flavor.manifest.json 失败"; }
  BUILT_RUNTIME_RELEASE="$(oc_hotcfg_finalize_release "$staging" "$image_id" "$sha" "${prev:-}" "$caps")" \
    || { rm -rf "$staging"; die "release finalize 失败(npm ci / ccb bun build / MANIFEST)"; }
  BUILT_RUNTIME_RELEASE="$(printf '%s' "$BUILT_RUNTIME_RELEASE" | tr -d '[:space:]')"
  [[ "$BUILT_RUNTIME_RELEASE" == "$OC_HOTCFG_RELEASES_ROOT"/rel-* ]] \
    || die "release 目录非法: $BUILT_RUNTIME_RELEASE"
  log "  ✓ runtime release=$BUILT_RUNTIME_RELEASE"
}
