import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const deploy = readFileSync(`${root}/scripts/deploy-v5-selfhost.sh`, 'utf8')
const cmdDeploy = deploy.match(/^cmd_deploy\(\) \{[\s\S]*?\n\}/m)[0]
function run(t, body) {
  const dir = mkdtempSync(`${tmpdir()}/p6-retry-`)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return spawnSync('bash', ['-eu', '-o', 'pipefail', '-c', `
SCRIPT_DIR="$TEST_REPO/scripts"
source "$SCRIPT_DIR/v5-runtime-release-lib.sh"
source "$SCRIPT_DIR/v5-selfhost-master-release-lib.sh"
source "$SCRIPT_DIR/lib/v5-selfhost-release-policy.sh"
source "$SCRIPT_DIR/lib/v5-selfhost-idle-retry.sh"
mlog() { :; }; log() { :; }; tsum_note() { :; }; die() { echo "$*" >&2; exit 2; }
MASTER_RELEASES_ROOT="$TEST_TMP/master"
OC_HOTCFG_RELEASES_ROOT="$TEST_TMP/runtime"
OC_HOTCFG_PLATFORM_ROOT="$TEST_TMP/platform"
MASTER_LIVE_LINK="$TEST_TMP/live"
SELFHOST_DEPLOY_LOCK="$TEST_TMP/deploy.lock"
exec 8>"$SELFHOST_DEPLOY_LOCK"; flock 8
DRY=0; PLATFORM_FROM_HEAD=1; MODE=deploy
SHA=$(printf a%.0s {1..40}); OTHER=$(printf b%.0s {1..40})
RUNTIME_IMAGE=fixture/image:tag; RUNTIME_IMAGE_ID=sha256:$(printf c%.0s {1..64})
mkdir -p "$MASTER_RELEASES_ROOT/rel-test" "$OC_HOTCFG_RELEASES_ROOT/staging" "$OC_HOTCFG_PLATFORM_ROOT/bundles/staging"
BUILT_MASTER_RELEASE="$MASTER_RELEASES_ROOT/rel-test"
printf master > "$BUILT_MASTER_RELEASE/payload"
digest=$(release_artifact_digest "$BUILT_MASTER_RELEASE")
jq -n --arg sha "$SHA" --arg d "$digest" '{schemaVersion:2, sourceCommit:$sha, artifactSha256:$d}' > "$BUILT_MASTER_RELEASE/.complete"
printf runtime > "$OC_HOTCFG_RELEASES_ROOT/staging/payload"
digest=$(oc_hotcfg_build_manifest "$OC_HOTCFG_RELEASES_ROOT/staging" 1 "$SHA")
BUILT_RUNTIME_RELEASE="$OC_HOTCFG_RELEASES_ROOT/rel-$digest"
mv "$OC_HOTCFG_RELEASES_ROOT/staging" "$BUILT_RUNTIME_RELEASE"
printf bundle > "$OC_HOTCFG_PLATFORM_ROOT/bundles/staging/payload"
BUILT_BUNDLE_REV=$(oc_hotcfg_build_manifest "$OC_HOTCFG_PLATFORM_ROOT/bundles/staging" 1 "$OTHER")
CUTOVER_TUPLE_BUNDLE="$OC_HOTCFG_PLATFORM_ROOT/bundles/$BUILT_BUNDLE_REV"
mv "$OC_HOTCFG_PLATFORM_ROOT/bundles/staging" "$CUTOVER_TUPLE_BUNDLE"
DEPLOY_BUILT_RELEASE="$BUILT_MASTER_RELEASE"; DEPLOY_BUILT_SOURCE_COMMIT="$SHA"
CUTOVER_MUTATED=0; CUTOVER_JOINT=1
docker() { printf '%s\\n' "$RUNTIME_IMAGE_ID"; }
${body}
`], { encoding: 'utf8', timeout: 20_000, env: {
    PATH: process.env.PATH, TEST_REPO: root, TEST_TMP: dir, TMPDIR: dir,
  } })
}
function ok(r) { assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`) }

test('exact idle candidate preserves all artifacts; only typed busy creates retry evidence', (t) => {
  ok(run(t, `
cutover_wait_for_user_idle() { return 75; }
lease_train_finish() { echo "$*" > "$TEST_TMP/outcome"; }
rc=0; selfhost_wait_idle_or_defer 600 "$BUILT_MASTER_RELEASE" || rc=$?
[[ "$rc" == 75 && "$(cat "$TEST_TMP/outcome")" == 'failed user-idle-deferred' ]]
selfhost_idle_retry_load "$SHA"
[[ "$BUILT_MASTER_RELEASE" == "$DEPLOY_BUILT_RELEASE" ]]
[[ "$(selfhost_idle_retry_data protect)" == "$BUILT_MASTER_RELEASE" ]]
selfhost_idle_retry_data clear
rm "$TEST_TMP/outcome"
cutover_wait_for_user_idle() { return 1; }
rc=0; selfhost_wait_idle_or_defer 600 "$BUILT_MASTER_RELEASE" || rc=$?
[[ "$rc" == 1 && ! -e "$TEST_TMP/outcome" && ! -e "$MASTER_RELEASES_ROOT/.idle-retry.json" ]]
`))
})

test('receipt cannot authorize a different SHA, policy operation, dirty platform or image ID', (t) => {
  ok(run(t, `
selfhost_idle_retry_save "$BUILT_MASTER_RELEASE"
! selfhost_idle_retry_load "$OTHER"
RELEASE_POLICY_MODE=user-impact-only; ! selfhost_idle_retry_load "$SHA"
RELEASE_POLICY_MODE=''; PLATFORM_FROM_HEAD=0; ! selfhost_idle_retry_load "$SHA"
PLATFORM_FROM_HEAD=1
docker() { echo sha256:$(printf d%.0s {1..64}); }
! selfhost_idle_retry_load "$SHA"
`))
})

for (const artifact of ['BUILT_MASTER_RELEASE', 'BUILT_RUNTIME_RELEASE', 'CUTOVER_TUPLE_BUNDLE']) {
  test(`changed ${artifact} bytes fail full artifact verification`, (t) => {
    ok(run(t, `selfhost_idle_retry_save "$BUILT_MASTER_RELEASE"
printf tampered > "\$${artifact}/payload"
! selfhost_idle_retry_load "$SHA"`))
  })
}

test('untrusted, symlinked, missing, poisoned and marker-mutated receipts fail closed', (t) => {
  ok(run(t, `
! selfhost_idle_retry_load "$SHA"
selfhost_idle_retry_save "$BUILT_MASTER_RELEASE"
chmod 666 "$MASTER_RELEASES_ROOT/.idle-retry.json"
! selfhost_idle_retry_load "$SHA"
chmod 600 "$MASTER_RELEASES_ROOT/.idle-retry.json"
touch "$BUILT_MASTER_RELEASE/.poisoned"
! selfhost_idle_retry_load "$SHA"; ! selfhost_idle_retry_data protect
rm "$BUILT_MASTER_RELEASE/.poisoned"
echo ' ' >> "$BUILT_MASTER_RELEASE/.complete"
! selfhost_idle_retry_load "$SHA"
selfhost_idle_retry_save "$BUILT_MASTER_RELEASE"
mv "$MASTER_RELEASES_ROOT/.idle-retry.json" "$TEST_TMP/saved"
ln -s "$TEST_TMP/saved" "$MASTER_RELEASES_ROOT/.idle-retry.json"
! selfhost_idle_retry_load "$SHA"; ! selfhost_idle_retry_data protect
`))
})

test('no lock owner or exposed candidate cannot save a reusable receipt', (t) => {
  ok(run(t, `
CUTOVER_MUTATED=1; ! selfhost_idle_retry_save "$BUILT_MASTER_RELEASE"
CUTOVER_MUTATED=0
flock -u 8
! selfhost_idle_retry_save "$BUILT_MASTER_RELEASE"
! selfhost_idle_retry_load "$SHA"
! selfhost_master_gc
`))
})

test('disk recovery reruns all L0 checks once; dry-run and persistent low space remain closed', (t) => {
  ok(run(t, `
REPO_ROOT="$TEST_TMP"; LEASE_TARGET_SHA="$SHA"
rpf_check_source_pin() { echo checked >> "$TEST_TMP/checks"; }
rpf_check_workspace_links() { :; }; rpf_check_migrations() { :; }; rpf_check_proof_db() { :; }
rpf_check_disk() { if [[ -e "$TEST_TMP/freed" ]]; then rpf_add ok disk enough; else rpf_add fail disk low; fi; }
selfhost_master_gc() { echo gc >> "$TEST_TMP/gc"; touch "$TEST_TMP/freed"; }
selfhost_release_preflight "$SHA"
[[ "$(wc -l < "$TEST_TMP/checks")" == 2 && "$(wc -l < "$TEST_TMP/gc")" == 1 ]]
rm "$TEST_TMP/freed" "$TEST_TMP/gc"
DRY=1; selfhost_release_preflight "$SHA"; [[ ! -e "$TEST_TMP/gc" ]]
DRY=0; selfhost_master_gc() { echo gc >> "$TEST_TMP/gc"; }
! ( selfhost_release_preflight "$SHA" )
[[ "$(wc -l < "$TEST_TMP/gc")" == 1 ]]
`))
})

test('actual deploy reuses the receipt and enters joint cutover without invoking any builder', (t) => {
  ok(run(t, `
${cmdDeploy}
selfhost_idle_retry_save "$BUILT_MASTER_RELEASE"
REPO_ROOT="$TEST_TMP"; V5_ENV="$TEST_TMP/env"; touch "$V5_ENV"
ln -s "$BUILT_MASTER_RELEASE" "$MASTER_LIVE_LINK"
RELEASE_POLICY_RESUME=0; LEASE_TRAIN_ACTIVE=1; LEASE_TARGET_SHA="$SHA"
ALLOW_DIRTY=0
git() { :; }; source_commit() { echo "$SHA"; }; tsum_init() { :; }
preflight_common() { :; }; explain_dirty_semantics() { :; }
release_policy_bind_official_train_request() { :; }; cutover_adopt_inflight_request() { :; }
ensure_selfhost_env_keys() { :; }; seed_web_assets_pool_from_live() { :; }
ensure_node_modules() { :; }; install_aux_units() { :; }; refresh_ccb_proxy_path() { :; }
ensure_model_authority() { :; }; assert_env_key_drift() { :; }
cutover_wait_for_user_idle() { [[ "$1" == 0 ]]; }
selfhost_release_preflight() { [[ "$1" == "$SHA" ]]; }
assert_fix_trailers() { :; }; assert_p0_web_overlay_contained() { :; }
build_master_release() { echo UNEXPECTED_BUILD >&2; exit 9; }
collect_runtime_release_bg() { echo UNEXPECTED_RUNTIME >&2; exit 9; }
build_platform_bundle() { echo UNEXPECTED_PLATFORM >&2; exit 9; }
cmd_cutover() {
  [[ "$CUTOVER_JOINT" == 1 && "$DEPLOY_BUILT_SOURCE_COMMIT" == "$SHA" ]]
  [[ "$DEPLOY_BUILT_RELEASE" == "$MASTER_RELEASES_ROOT/rel-test" ]]
  [[ ! -e "$MASTER_RELEASES_ROOT/.idle-retry.json" ]]
  echo cutover > "$TEST_TMP/cutover"
}
lease_train_finish() { [[ "$1" == committed ]]; }
cmd_deploy
[[ -f "$TEST_TMP/cutover" ]]
`))
})

test('GC delegates to the existing census with the idle candidate protected; invalid receipt prevents invocation', (t) => {
  ok(run(t, `
V5_UNIT=fixture.service
egress_slot_unit() { echo "fixture-$1.service"; }
bash() { printf '%s\\n' "$@" > "$TEST_TMP/gc-argv"; }
selfhost_idle_retry_save "$BUILT_MASTER_RELEASE"
selfhost_master_gc
[[ "$(sed -n '12p' "$TEST_TMP/gc-argv")" == "$BUILT_MASTER_RELEASE" ]]
[[ "$(head -1 "$TEST_TMP/gc-argv")" == "$SCRIPT_DIR/v5-release-gc.sh" ]]
rm "$TEST_TMP/gc-argv"
echo broken > "$MASTER_RELEASES_ROOT/.idle-retry.json"
! selfhost_master_gc
[[ ! -e "$TEST_TMP/gc-argv" ]]
`))
})
