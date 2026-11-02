# shellcheck shell=bash
# Ordinary-only artifact reuse. The ordinary activation/compensation path owns all writes.
PREBUILT_RESUME_CONTROLLER_SHA=""
PREBUILT_RESUME_CONTROLLER_CI_AT=""
PREBUILT_RESUME_RECORD_SHA=""
PREBUILT_RESUME_EVIDENCE=""
PREBUILT_RESUME_INITIAL_TUPLE=""
PREBUILT_RESUME_GENERATION=""

prebuilt_resume_read_record() { # <record> -- references/digests, never caller-supplied PASS
  local file="$1" uid mode
  [[ -f "$file" && ! -L "$file" ]] || { echo '✗ resume record missing/symlink' >&2; return 1; }
  read -r uid mode < <(stat -Lc '%u %a' "$file")
  [[ "$uid" == 0 && $((8#$mode & 8#22)) -eq 0 ]] || { echo '✗ untrusted resume record ownership/mode' >&2; return 1; }
  jq -e '
    .schemaVersion == 1 and
    ((keys - ["schemaVersion","sourceCommit","originUnit","masterRelease","runtimeRelease","imageId","platformBundle","masterArtifactSha256","runtimeManifestSha256","bundleManifestSha256"])|length)==0 and
    (.sourceCommit|type=="string" and test("^[0-9a-f]{40}$")) and
    (.originUnit|type=="string" and test("^openclaude-v5-deploy-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}-with-dist\\.service$")) and
    (.masterRelease|type=="string" and test("^/[a-zA-Z0-9/_-]+/rel-[0-9a-f]{7,40}-[0-9]{8}-[0-9]{6}$")) and
    (.runtimeRelease|type=="string" and test("^/[a-zA-Z0-9/_-]+/rel-[0-9a-f]{12}$")) and
    (.imageId|type=="string" and test("^sha256:[0-9a-f]{64}$")) and
    (.platformBundle|type=="string" and test("^[0-9a-f]{12}$")) and
    ([.masterArtifactSha256,.runtimeManifestSha256,.bundleManifestSha256]|all(type=="string" and test("^[0-9a-f]{64}$")))
  ' "$file" >/dev/null || { echo '✗ invalid resume record (no PASS/waiver fields permitted)' >&2; return 1; }
  PREBUILT_SOURCE="$(jq -r .sourceCommit "$file")"
  PREBUILT_ORIGIN_UNIT="$(jq -r .originUnit "$file")"
  PREBUILT_MASTER="$(jq -r .masterRelease "$file")"
  PREBUILT_RUNTIME="$(jq -r .runtimeRelease "$file")"
  PREBUILT_IMAGE_ID="$(jq -r .imageId "$file")"
  PREBUILT_BUNDLE="$(jq -r .platformBundle "$file")"
  [[ "$(dirname "$PREBUILT_MASTER")" == "$RELEASES_ROOT" && "$(dirname "$PREBUILT_RUNTIME")" == "$OC_HOTCFG_RELEASES_ROOT" ]] || {
    echo '✗ resume artifact outside configured release roots' >&2; return 1;
  }
  PREBUILT_MASTER_SHA="$(jq -r .masterArtifactSha256 "$file")"
  PREBUILT_RUNTIME_MANIFEST_SHA="$(jq -r .runtimeManifestSha256 "$file")"
  PREBUILT_BUNDLE_MANIFEST_SHA="$(jq -r .bundleManifestSha256 "$file")"
  PREBUILT_RESUME_RECORD_SHA="$(sha256sum "$file" | cut -d' ' -f1)"
}

prebuilt_resume_controller_identity() { # original artifact source stays pinned; controller alone advances
  local source="$1" head path remote paths
  head="$(git -C "$REPO_ROOT" rev-parse HEAD)" || return 1
  [[ "$(git -C "$REPO_ROOT" branch --show-current)" == feat/v5-aurora-rewrite && -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ]] || return 1
  git -C "$REPO_ROOT" merge-base --is-ancestor "$source" "$head" || return 1
  paths="$(git -C "$REPO_ROOT" diff --name-only "$source" "$head")" || return 1
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    case "$path" in
      scripts/deploy-v5.sh|scripts/v5-deploy-preflight.sh|scripts/lib/v5-prebuilt-resume.sh|scripts/lib/v5-prebuilt-resume.mjs|scripts/__tests__/v5PrebuiltResume.test.ts|scripts/__tests__/v5ReleaseSafety.test.ts|docs/V5_DEV_PLAYBOOK.md) ;;
      *) echo "✗ resume controller includes unrelated change:$path" >&2; return 1 ;;
    esac
  done <<<"$paths"
  remote="$(git -C "$REPO_ROOT" ls-remote origin refs/heads/feat/v5-aurora-rewrite)" || return 1
  [[ "$remote" == "$head"$'\trefs/heads/feat/v5-aurora-rewrite' ]] || { echo '✗ resume controller is not protected canonical HEAD' >&2; return 1; }
  [[ -z "$PREBUILT_RESUME_CONTROLLER_SHA" || "$PREBUILT_RESUME_CONTROLLER_SHA" == "$head" ]] || return 1
  printf '%s\n' "$head"
}

prebuilt_resume_current_tuple() {
  local key value
  for key in OC_RUNTIME_IMAGE OC_RUNTIME_IMAGE_ID OC_RUNTIME_RELEASE OC_PLATFORM_BUNDLE; do
    value="$(remote_env_get "$key")" || return 1
    printf '%s=%s\n' "$key" "$value"
  done
}

prebuilt_resume_origin_evidence() {
  local temp result rc=0
  temp="$(mktemp -d)" || return 1
  systemctl show "$PREBUILT_ORIGIN_UNIT" --property=Id,InvocationID,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,WorkingDirectory,ExecStart >"$temp/unit" || rc=1
  # Without --all journald renders large proof messages as null in JSON.
  journalctl -u "$PREBUILT_ORIGIN_UNIT" --all --no-pager -o json >"$temp/journal" || rc=1
  ssh "$KL_HOST" "cat '$PREBUILT_MASTER/.complete'" >"$temp/marker" || rc=1
  if [[ "$rc" == 0 ]]; then
    result="$(node "$SCRIPT_DIR/lib/v5-prebuilt-resume.mjs" "$RESUME_BUILT_RELEASE" "$temp/unit" "$temp/journal" "$temp/marker" "$RELEASES_ROOT" "$OC_HOTCFG_RELEASES_ROOT")" || rc=1
  fi
  rm -rf -- "$temp"
  [[ "$rc" == 0 ]] || return 1
  jq -e --arg sha "$PREBUILT_MASTER_SHA" '.masterArtifactSha256==$sha and (.originPredecessor|type=="string") and (.originSlot=="A" or .originSlot=="B") and (.originStateLock|type=="string")' <<<"$result" >/dev/null || return 1
  [[ -z "$PREBUILT_RESUME_EVIDENCE" || "$PREBUILT_RESUME_EVIDENCE" == "$result" ]] || { echo '✗ original build evidence changed' >&2; return 1; }
  PREBUILT_RESUME_EVIDENCE="$result"
}

prebuilt_resume_prepare() { # readonly, before production lease; CI outcomes are independent
  local controller
  prebuilt_resume_read_record "$RESUME_BUILT_RELEASE" || return 1
  [[ "$(resolve_release_source_commit)" == "$PREBUILT_SOURCE" ]] || { echo '✗ resume source differs from queue pin' >&2; return 1; }
  controller="$(prebuilt_resume_controller_identity "$PREBUILT_SOURCE")" || return 1
  assert_ci_green_for_source_commit "$controller" || return 1
  PREBUILT_RESUME_CONTROLLER_SHA="$controller"
  PREBUILT_RESUME_CONTROLLER_CI_AT="$(date +%s)"
  prebuilt_resume_origin_evidence || return 1
  PREBUILT_RESUME_INITIAL_TUPLE="$(prebuilt_resume_current_tuple)" || return 1
  ds_load || return 1
  PREBUILT_RESUME_GENERATION="$DS_generation"
  echo "  ✓ resume controller CI=$controller; artifact source=$PREBUILT_SOURCE; origin=$PREBUILT_ORIGIN_UNIT"
}

prebuilt_resume_verify_artifacts() { # full hashes; uses immutable source's existing runtime verifier
  local probe kind source short built artifact input caps
  probe="$(release_marker_probe "$PREBUILT_MASTER")" || return 1
  IFS=$'\t' read -r kind source short built artifact <<<"$probe"
  [[ "$kind" == strong && "$source" == "$PREBUILT_SOURCE" && "$artifact" == "$PREBUILT_MASTER_SHA" ]] || return 1
  assert_release_metadata_matches_commit "$PREBUILT_MASTER" "$PREBUILT_SOURCE" || return 1
  input="$(compute_runtime_input_digest "$PREBUILT_SOURCE" "$PREBUILT_IMAGE_ID")" || return 1
  caps="$(git -C "$REPO_ROOT" show "$PREBUILT_SOURCE:deploy/v5/release-metadata.json" | jq -ce '.runtimeCapabilities|sort')" || return 1
  ssh "$KL_HOST" bash -s -- "$PREBUILT_MASTER" "$PREBUILT_RUNTIME" "$OC_HOTCFG_RELEASES_ROOT" "$OC_HOTCFG_PLATFORM_ROOT" "$PREBUILT_BUNDLE" "$PREBUILT_SOURCE" "$PREBUILT_IMAGE_ID" "$input" "$caps" "$PREBUILT_RUNTIME_MANIFEST_SHA" "$PREBUILT_BUNDLE_MANIFEST_SHA" <<'REMOTE'
set -Eeuo pipefail
master="$1"; runtime="$2"; runtime_root="$3"; platform_root="$4"; bundle="$platform_root/bundles/$5"
source_commit="$6"; image="$7"; input="$8"; caps="$9"; runtime_mf="${10}"; bundle_mf="${11}"
for root in "$master" "$runtime" "$bundle"; do
  [[ "$(readlink -f "$root")" == "$root" && -d "$root" && ! -L "$root" ]] || exit 1
  if [[ "$root" == "$master" ]]; then
    # Existing strong master releases can contain root:root 0664/0775 leaves.
    # Preserve their sealed modes; permit root-group writes only when all its
    # effective members have uid 0, never a foreign owner/group or world writer.
    getent passwd | awk -F: '$4==0 && $3!=0 {bad=1} END {exit bad}'
    members="$(getent group 0 | cut -d: -f4)"
    for member in ${members//,/ }; do [[ "$(id -u "$member")" == 0 ]] || exit 1; done
    [[ -z "$(find "$root" \( -type f -o -type d \) \( ! -uid 0 -o -perm -002 -o \( -perm -020 ! -gid 0 \) \) -print -quit)" ]] || exit 1
  else
    [[ -z "$(find "$root" \( -type f -o -type d \) -perm /022 -print -quit)" ]] || exit 1
    [[ -f "$root/MANIFEST.json" && ! -L "$root/MANIFEST.json" && -z "$(find "$root" \( -type f -o -type d \) ! -uid 0 -print -quit)" ]] || exit 1
  fi
  while IFS= read -r -d '' link; do
    resolved="$(readlink -f "$link")" || exit 1
    [[ "$resolved" == "$root/"* ]] || exit 1
  done < <(find "$root" -type l -print0)
done
[[ "$(dirname "$runtime")" == "$runtime_root" && "$(sha256sum "$runtime/MANIFEST.json" | cut -d' ' -f1)" == "$runtime_mf" && "$(sha256sum "$bundle/MANIFEST.json" | cut -d' ' -f1)" == "$bundle_mf" ]] || exit 1
source "$master/scripts/v5-runtime-release-lib.sh"
oc_hotcfg_verify_manifest_full "$runtime"
oc_hotcfg_verify_manifest_full "$bundle"
oc_hotcfg_selfcheck_bundle "$bundle"
oc_hotcfg_assert_required_leaves "$bundle"
[[ "$(jq -r .digest "$runtime/MANIFEST.json")" == "${runtime##*/rel-}" && "$(jq -r .digest "$bundle/MANIFEST.json")" == "${bundle##*/}" ]] || exit 1
jq -e --arg s "$source_commit" --arg img "$image" --arg inp "$input" --argjson caps "$caps" '
  .sourceCommit==$s and .inputDigest==$inp and .inputDigestProvenance.sourceCommit==$s and .inputDigestProvenance.imageId==$img and (.capabilities|sort)==$caps and .flavorGuardGeneration==1
' "$runtime/MANIFEST.json" >/dev/null
docker image inspect --format '{{.Id}}' "$image" | grep -Fx "$image" >/dev/null
cd "$master"
npx --no-install tsx "$master/packages/commercial/agent-sandbox/platform-runtime/entrypoint/validatePlatformSeedCli.ts" "$bundle"
REMOTE
}

prebuilt_resume_recheck() { # cheap authority/fencing check, also immediately after the live idle gate
  local controller now
  [[ "${OC_V5_SKIP_MUTATION_LEASE:-0}" == 0 && "${MUTATION_LEASE_ACTIVE:-0}" == 1 && "${MUTATION_LEASE_BYPASSED:-0}" == 0 ]] || {
    echo '✗ prebuilt resume requires an active, non-bypassed production mutation lease' >&2; return 86;
  }
  assert_development_release_queue || return 3
  [[ -n "$PREBUILT_RESUME_CONTROLLER_SHA" && "$PREBUILT_RESUME_CONTROLLER_CI_AT" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$(sha256sum "$RESUME_BUILT_RELEASE" | cut -d' ' -f1)" == "$PREBUILT_RESUME_RECORD_SHA" ]] || return 1
  now="$(date +%s)"
  [[ "$now" -ge "$PREBUILT_RESUME_CONTROLLER_CI_AT" ]] || return 1
  assert_ci_green_process_local "$PREBUILT_SOURCE" resume-built-release || return 1
  controller="$(git -C "$REPO_ROOT" rev-parse HEAD)" || return 1
  [[ "$controller" == "$PREBUILT_RESUME_CONTROLLER_SHA" ]] || return 1
  assert_mutation_lease_alive resume-built-release || return 86
  [[ -n "$PREBUILT_RESUME_INITIAL_TUPLE" && "$(prebuilt_resume_current_tuple)" == "$PREBUILT_RESUME_INITIAL_TUPLE" ]] || { echo '✗ resume active tuple drift' >&2; return 1; }
  ds_load || return 1
  [[ "$DS_generation" == "$PREBUILT_RESUME_GENERATION" && "$DS_phase" == stable && -z "$DS_candidate_release" && -z "$DS_candidate_slot" \
    && "$DS_active_release" == "$(jq -r .originPredecessor <<<"$PREBUILT_RESUME_EVIDENCE")" \
    && "$DS_active_slot" == "$(jq -r .originSlot <<<"$PREBUILT_RESUME_EVIDENCE")" \
    && "$DS_lock_version" == "$(jq -r .originStateLock <<<"$PREBUILT_RESUME_EVIDENCE")" \
    && "$CAPTURED_RELEASE_PREDECESSOR" == "$DS_active_release" ]] || { echo '✗ resume predecessor/authority drift' >&2; return 1; }
}

prebuilt_resume_load() { # replaces only build_release, all later ordinary gates remain
  prebuilt_resume_recheck || return $?
  prebuilt_resume_origin_evidence || return 1
  # Existing live SQL parameter-inference gate must still run on today's schema.
  [[ "$(git -C "$REPO_ROOT" show "$PREBUILT_SOURCE:scripts/v5-turn-waiver-sql-gate.sh" | sha256sum | cut -d' ' -f1)" == "$(sha256sum "$TURN_WAIVER_SQL_GATE" | cut -d' ' -f1)" ]] || return 1
  OC_V5_TURN_WAIVER_SOURCE_COMMIT="$PREBUILT_SOURCE" "$TURN_WAIVER_SQL_GATE" || return 1
  prebuilt_resume_verify_artifacts || return 1
  BUILT_RELEASE="$PREBUILT_MASTER"
  BUILT_RELEASE_SOURCE_COMMIT="$PREBUILT_SOURCE"
  DIST_BUILD_ID="$(ssh "$KL_HOST" "grep -o 'name=\"oc-build\" content=\"[0-9a-f]\\{8,32\\}\"' '$PREBUILT_MASTER/packages/web-react/dist/index.html' | grep -o '[0-9a-f]\\{8,32\\}' | head -1")" || return 1
  [[ "$DIST_BUILD_ID" =~ ^[0-9a-f]{8,32}$ ]] || return 1
  prebuilt_resume_recheck || return $?
  echo "  ✓ reused exact built release=$BUILT_RELEASE source=$BUILT_RELEASE_SOURCE_COMMIT (no build)"
}

prebuilt_resume_select_runtime() {
  prebuilt_resume_recheck || return $?
  # The skipped builders normally ship this unchanged controller library.
  # Keep that ordinary setup under the same proven lease; artifacts stay untouched.
  hotcfg_ship_lib || return 1
  BUILT_RUNTIME_RELEASE="$PREBUILT_RUNTIME"
  RUNTIME_IMAGE_REF="$(remote_env_get OC_RUNTIME_IMAGE)" || return 1
  RUNTIME_IMAGE_ID="$(ssh "$KL_HOST" "docker image inspect --format '{{.Id}}' '$RUNTIME_IMAGE_REF'")" || return 1
  [[ "$RUNTIME_IMAGE_ID" == "$PREBUILT_IMAGE_ID" && "$(remote_env_get OC_RUNTIME_IMAGE_ID)" == "$PREBUILT_IMAGE_ID" ]] || return 1
  BUILT_BUNDLE_REV="$PREBUILT_BUNDLE"
  prebuilt_resume_recheck || return $?
}
