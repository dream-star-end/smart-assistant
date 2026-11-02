import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateOriginBuildEvidence } from '../lib/v5-prebuilt-resume.mjs'

const sourceCommit = 'cdd0aa734be15bffea7f5b3ff53434a7a767ee7b'
const originUnit = 'openclaude-v5-deploy-20261102-121955-cdd0aa73-with-dist.service'
const masterRelease = '/opt/openclaude/openclaude-v5-releases/rel-cdd0aa734-20261102-122348'
const runtimeRelease = '/var/lib/openclaude-v5/runtime-releases/rel-55de34b944a9'
const imageId = `sha256:${'a'.repeat(64)}`
const invocationId = '1f1cd39638884fb3991219b20d2df726'
const canonical = '/opt/openclaude/openclaude-v5-aurora'
const micros = (iso: string) => String(Date.parse(iso) * 1000)
const row = (iso: string, MESSAGE: string) => ({
  __REALTIME_TIMESTAMP: micros(iso), _SYSTEMD_INVOCATION_ID: invocationId, MESSAGE,
})

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

// Only external host/PG/GitHub/queue facts are fixtures. Artifact hashes, provenance,
// original-evidence parsing, source pinning and ordinary deploy branches run real code.
function artifactFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-prebuilt-resume-'))
  const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
  assert.match(source, /^[0-9a-f]{40}$/)
  const master = path.join(dir, 'master', `rel-${source.slice(0, 9)}-20261102-122348`)
  const previous = path.join(dir, 'master', 'rel-18f6c8a3f-20261101-175855')
  const runtimeRoot = path.join(dir, 'runtime')
  const platformRoot = path.join(dir, 'platform')
  const platformSource = 'packages/commercial/agent-sandbox/platform-runtime'
  for (const name of ['deploy/v5', 'scripts', 'node_modules/.bin', 'packages/web-react/dist']) {
    mkdirSync(path.join(master, name), { recursive: true })
  }
  mkdirSync(runtimeRoot); mkdirSync(platformRoot)
  cpSync(path.join(repo, platformSource), path.join(master, platformSource), { recursive: true })
  cpSync(path.join(repo, platformSource), path.join(dir, 'bundle-stage'), { recursive: true })
  cpSync(path.join(repo, 'scripts/v5-runtime-release-lib.sh'), path.join(master, 'scripts/v5-runtime-release-lib.sh'))
  cpSync(path.join(repo, 'deploy/v5/release-metadata.json'), path.join(master, 'deploy/v5/release-metadata.json'))
  writeFileSync(path.join(master, 'package.json'), '{"type":"module"}\n')
  writeFileSync(path.join(master, 'VERSION.json'), JSON.stringify({ commit: source.slice(0, 9) }))
  writeFileSync(path.join(master, 'packages/web-react/dist/index.html'), '<meta name="oc-build" content="abcdef123456">\n')
  cpSync(path.join(repo, 'node_modules/yaml'), path.join(master, 'node_modules/yaml'), { recursive: true })
  writeFileSync(path.join(dir, 'env'), 'DATABASE_URL=fixture-no-network\n')
  mkdirSync(path.join(dir, 'bin'))
  writeFileSync(path.join(dir, 'bin/psql'), `#!/usr/bin/env bash
set -euo pipefail
sql="$(cat)"
grep -Fq 'BEGIN READ ONLY;' <<<"$sql"
grep -Fq 'PREPARE oc_v5_turn_waiver_receipt AS' <<<"$sql"
grep -Fq 'ROLLBACK;' <<<"$sql"
echo FRESH_SQL >>"$FIX/calls"
`)
  chmodSync(path.join(dir, 'bin/psql'), 0o755)
  writeFileSync(path.join(dir, 'queue'), `#!/usr/bin/env bash
set -eu
case "$1" in
  pinned-sha) printf '%s\\n' "\${QUEUE_SHA:-$SOURCE}" ;;
  assert) [[ "$*" == 'assert --id rq-fixture' && "\${FOREIGN_QUEUE:-0}" == 0 ]] ;;
  *) exit 99 ;;
esac
`)
  chmodSync(path.join(dir, 'queue'), 0o755)
  const prelude = `set -euo pipefail
export V5_DEPLOY_SOURCE_ONLY=1
source ${quote(path.join(repo, 'scripts/deploy-v5.sh'))}
export FIX=${quote(dir)} SOURCE=${quote(source)} FIX_IMAGE=${quote(imageId)}
export PATH="$FIX/bin:$PATH"
RELEASES_ROOT=${quote(path.dirname(master))}; OC_HOTCFG_RELEASES_ROOT=${quote(runtimeRoot)}
OC_HOTCFG_PLATFORM_ROOT=${quote(platformRoot)}; export KL_HOST=fixture V5_ENV="$FIX/env"
RELEASE_QUEUE_SCRIPT="$FIX/queue"; OC_V5_RELEASE_QUEUE_ID=rq-fixture
RESUME_BUILT_RELEASE="$FIX/record"; DRY=0; WITH_DIST=1; RESTART_EGRESS=0
ssh() { shift; if [[ $# == 1 ]]; then bash -c "$1"; else "$@"; fi; }
docker() { [[ "$1 $2" == 'image inspect' ]] || return 99; printf '%s\\n' "\${OBSERVED_IMAGE:-$FIX_IMAGE}"; }
npx() { [[ "$1 $2" == '--no-install tsx' ]] || return 99; shift 2; node ${quote(path.join(repo, 'node_modules/tsx/dist/cli.mjs'))} "$@"; }
getent() {
  case "$1" in passwd) printf 'root:x:0:0:fixture:/root:/bin/bash\\n' ;; group) printf 'root:x:0:\\n' ;; *) return 99 ;; esac
}
export -f ssh docker npx getent
systemctl() { cat "$FIX/unit"; }
journalctl() { cat "$FIX/journal"; }
# The fixture supplies checkout and remote-ref facts, never modifies a real branch.
git() {
  case "$*" in
    *' status --porcelain'*) [[ "\${DIRTY_CONTROLLER:-0}" == 0 ]] || echo ' M unrelated.ts' ;;
    *' branch --show-current') echo feat/v5-aurora-rewrite ;;
    *' ls-remote origin refs/heads/feat/v5-aurora-rewrite') printf '%s\\trefs/heads/feat/v5-aurora-rewrite\\n' "$SOURCE" ;;
    *) command git "$@" ;;
  esac
}
assert_ci_green_for_source_commit() { echo "CI $1" >>"$FIX/calls"; [[ "$1" == "$SOURCE" ]]; }
MUTATION_LEASE_ACTIVE=1; MUTATION_LEASE_BYPASSED=0
mutation_lease_live() { echo FENCE >>"$FIX/calls"; [[ "\${FOREIGN_LEASE:-0}" == 0 ]]; }
ds_load() {
  DS_phase="\${OBSERVED_PHASE:-stable}"; DS_candidate_release="\${OBSERVED_CANDIDATE:-}"; DS_candidate_slot=''
  DS_active_release="\${OBSERVED_PREVIOUS:-${previous}}"; DS_active_slot="\${OBSERVED_SLOT:-B}"; DS_lock_version="\${OBSERVED_LOCK:-7}"
  DS_previous_active_release=''; DS_generation="\${OBSERVED_GENERATION:-174}"
}
remote_env_get() {
  case "$1" in
    OC_RUNTIME_IMAGE) echo fixture-runtime ;;
    OC_RUNTIME_IMAGE_ID) echo "$FIX_IMAGE" ;;
    OC_RUNTIME_RELEASE) echo "\${OBSERVED_RUNTIME:-/old-runtime}" ;;
    OC_PLATFORM_BUNDLE) echo "\${OBSERVED_BUNDLE:-/old-bundle}" ;;
    *) return 99 ;;
  esac
}
CAPTURED_RELEASE_PREDECESSOR=${quote(previous)}
# Copying the unchanged controller lib is an external transport effect, not a build.
hotcfg_ship_lib() { echo SHIP_RUNTIME_LIB >>"$FIX/calls"; }
build_release() { echo UNEXPECTED_BUILD_MASTER >>"$FIX/calls"; return 97; }
build_runtime_release() { echo UNEXPECTED_BUILD_RUNTIME >>"$FIX/calls"; return 98; }
build_platform_bundle() { echo UNEXPECTED_BUILD_PLATFORM >>"$FIX/calls"; return 99; }
`
  const run = (command: string, env: Record<string, string> = {}) => spawnSync('bash', ['-c', prelude + '\n' + command], {
    cwd: repo, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ALLOW_ANY_BRANCH: '1', ...env },
  })
  const setup = run(`
bundle="$(oc_hotcfg_finalize_bundle "$FIX/bundle-stage" 1 "$SOURCE")"
mkdir "$FIX/runtime-stage"
printf 'runtime fixture\\n' >"$FIX/runtime-stage/content.txt"
digest="$(oc_hotcfg_build_manifest "$FIX/runtime-stage" 1 "$SOURCE")"
runtime="$OC_HOTCFG_RELEASES_ROOT/rel-$digest"; mv "$FIX/runtime-stage" "$runtime"
input="$(compute_runtime_input_digest "$SOURCE" "$FIX_IMAGE")"
caps="$(git -C "$REPO_ROOT" show "$SOURCE:deploy/v5/release-metadata.json" | jq -c .runtimeCapabilities)"
jq --arg input "$input" --arg image "$FIX_IMAGE" --arg sha "$SOURCE" --argjson caps "$caps" \
  '.inputDigest=$input|.inputDigestProvenance={sourceCommit:$sha,imageId:$image}|.capabilities=$caps|.flavorGuardGeneration=1' \
  "$runtime/MANIFEST.json" >"$runtime/MANIFEST.new"
mv "$runtime/MANIFEST.new" "$runtime/MANIFEST.json"
printf '%s\\n%s\\n' "$runtime" "$bundle" >"$FIX/selection"
release_artifact_digest ${quote(master)} >"$FIX/master-digest"
`)
  assert.equal(setup.status, 0, setup.stdout + setup.stderr)
  const [runtime, bundle] = readFileSync(path.join(dir, 'selection'), 'utf8').trim().split('\n')
  const marker = { schemaVersion: 2, sourceCommit: source, builtAt: '20261102-122348',
    metadataSha256: sha256(readFileSync(path.join(master, 'deploy/v5/release-metadata.json'))),
    artifactSha256: readFileSync(path.join(dir, 'master-digest'), 'utf8').trim() }
  writeFileSync(path.join(master, '.complete'), JSON.stringify(marker)); chmodSync(master, 0o755)
  const origin = originFixture()
  const unit = originUnit.replace('cdd0aa73', source.slice(0, 8))
  origin.unitProperties.Id = unit
  writeFileSync(path.join(dir, 'unit'), Object.entries(origin.unitProperties).map(([k, v]) => `${k}=${v}`).join('\n'))
  const journal = [
    row('2026-11-02T12:20:00Z', `  · 捕获 predecessor(kind=strong path=${previous})`),
    row('2026-11-02T12:20:01Z', '  · active lane: slot=B unit=fixture port=18795 state_lock=7'),
    row('2026-11-02T12:49:41Z', `  ✓ release 就绪(带 .complete):${master}`),
    row('2026-11-02T12:50:00Z', `  ✓ platform bundle rev=${bundle}`),
    row('2026-11-02T12:58:17Z', `  ✓ runtime release=${runtime} image_id=${imageId}`),
    row('2026-11-02T13:08:41Z', '✗ 未证明商业空窗,live 未切换'),
  ]
  writeFileSync(path.join(dir, 'journal'), journal.map(value => JSON.stringify(value)).join('\n'))
  const record = { schemaVersion: 1, sourceCommit: source, originUnit: unit, masterRelease: master,
    runtimeRelease: runtime, imageId, platformBundle: bundle, masterArtifactSha256: marker.artifactSha256,
    runtimeManifestSha256: sha256(readFileSync(path.join(runtime!, 'MANIFEST.json'))),
    bundleManifestSha256: sha256(readFileSync(path.join(platformRoot, 'bundles', bundle!, 'MANIFEST.json'))) }
  writeFileSync(path.join(dir, 'record'), JSON.stringify(record)); chmodSync(path.join(dir, 'record'), 0o600)
  writeFileSync(path.join(dir, 'calls'), '')
  const ready = `assert_development_release_queue; run_ci_green_gate_before_lease "$SOURCE"; prebuilt_resume_prepare`
  const deploymentFacts = `
assert_bluegreen_layout() { :; }
assert_target_runtime_image_ready() { :; }
bg_current_release() { printf '%s\\n' ${quote(previous)}; }
assert_runtime_channel_column() { :; }
prepare_live_baseline_safety() { echo BASELINE >>"$FIX/calls"; }
knowledge_planet_plugin_advisory_gate() { KP_PLUGIN_PROMOTE=0; }
weibo_plugin_advisory_gate() { WB_PLUGIN_PROMOTE=0; }
hotcfg_bundle_axis_on() { return 0; }
hotcfg_release_axis_on() { return 0; }
assert_direct_turn_timeline_pair() { return 0; }
sync_assets_to_pool() { echo ASSETS >>"$FIX/calls"; }
begin_planned_maintenance() { echo MAINTENANCE >>"$FIX/calls"; }
end_planned_maintenance() { echo END_MAINTENANCE >>"$FIX/calls"; }
knowledge_planet_plugin_close_gate() { KNOWLEDGE_PLANET_GATE_VERSION_ID=previous; }
knowledge_planet_plugin_classify_previous_release() { KNOWLEDGE_PLANET_PREVIOUS_RELEASE_AVAILABLE=1; }
weibo_plugin_pre_activation_bracket() { WEIBO_DEPLOY_BRACKET=1; WEIBO_HAD_PREVIOUS_PLUGIN=1; }
knowledge_planet_plugin_open_gate_to_release() { echo "RESTORE_KP $2" >>"$FIX/calls"; }
weibo_plugin_open_gate_to_release() { echo "RESTORE_WB $2" >>"$FIX/calls"; }
rollback() { echo UNEXPECTED_ROLLBACK >>"$FIX/calls"; return 99; }
`
  return { dir, master, previous, runtime: runtime!, record, run, ready, deploymentFacts,
    calls: () => readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean),
    close: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('formal prebuilt resume real shell behavior', () => {
  test('valid exact artifacts pass full verification, fresh SQL and runtime selection without builds', () => {
    const fx = artifactFixture()
    try {
      const result = fx.run(`${fx.ready}
prebuilt_resume_load
prebuilt_resume_select_runtime
[[ "$BUILT_RELEASE" == "$PREBUILT_MASTER" && "$BUILT_RUNTIME_RELEASE" == "$PREBUILT_RUNTIME" && "$BUILT_BUNDLE_REV" == "$PREBUILT_BUNDLE" ]]
echo SELECTED_EXACT`)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.match(result.stdout, /SELECTED_EXACT/)
      assert.ok(fx.calls().includes('FRESH_SQL'))
      assert.ok(fx.calls().includes('SHIP_RUNTIME_LIB'))
      assert.ok(!fx.calls().some(value => value.startsWith('UNEXPECTED_BUILD_')))
    } finally { fx.close() }
  })

  test('tampered master bytes, marker, metadata and runtime manifest or leaves reject before activation', () => {
    const fx = artifactFixture()
    try {
      const cases = [
        [path.join(fx.master, 'package.json'), '{"tampered":true}'],
        [path.join(fx.master, '.complete'), JSON.stringify({ sourceCommit: 'f'.repeat(40) })],
        [path.join(fx.master, 'deploy/v5/release-metadata.json'), '{}'],
        [path.join(fx.runtime, 'MANIFEST.json'), '{}'],
        [path.join(fx.runtime, 'content.txt'), 'tampered runtime'],
      ]
      for (const [file, replacement] of cases) {
        const original = readFileSync(file!)
        writeFileSync(file!, replacement!)
        const result = fx.run(`${fx.ready}; prebuilt_resume_load || exit 41; echo UNEXPECTED_ACTIVATION`)
        writeFileSync(file!, original)
        assert.notEqual(result.status, 0, `${file}: ${result.stdout}${result.stderr}`)
        assert.doesNotMatch(result.stdout, /UNEXPECTED_ACTIVATION/)
      }
    } finally { fx.close() }
  })

  test('record, queue, source, predecessor, tuple authority and foreign lease drift fail closed', () => {
    const fx = artifactFixture()
    try {
      for (const env of [{ FOREIGN_QUEUE: '1' }, { QUEUE_SHA: 'f'.repeat(40) }, { DIRTY_CONTROLLER: '1' },
        { OBSERVED_PREVIOUS: '/alien' }, { OBSERVED_SLOT: 'A' }, { OBSERVED_LOCK: '8' },
        { OBSERVED_PHASE: 'canary' }, { OBSERVED_CANDIDATE: '/candidate' }, { FOREIGN_LEASE: '1' }]) {
        const result = fx.run(`${fx.ready}; prebuilt_resume_load || exit 42; echo UNEXPECTED_ACTIVATION`, env)
        assert.notEqual(result.status, 0, JSON.stringify(env) + result.stdout + result.stderr)
        assert.doesNotMatch(result.stdout, /UNEXPECTED_ACTIVATION/)
      }
      const changed = fx.run(`${fx.ready}; printf '\\n' >>"$RESUME_BUILT_RELEASE"; prebuilt_resume_recheck || exit 43; echo UNEXPECTED_ACTIVATION`)
      assert.notEqual(changed.status, 0, changed.stdout + changed.stderr)
      assert.doesNotMatch(changed.stdout, /UNEXPECTED_ACTIVATION/)
      writeFileSync(path.join(fx.dir, 'record'), JSON.stringify(fx.record))
      for (const drift of ['OBSERVED_RUNTIME=/alien-runtime', 'OBSERVED_BUNDLE=/alien-bundle',
        'OBSERVED_GENERATION=175', 'export FOREIGN_QUEUE=1', 'PREBUILT_RESUME_CONTROLLER_CI_AT=9999999999']) {
        const result = fx.run(`${fx.ready}; ${drift}; prebuilt_resume_recheck || exit 45; echo UNEXPECTED_ACTIVATION`)
        assert.notEqual(result.status, 0, drift + result.stdout + result.stderr)
        assert.doesNotMatch(result.stdout, /UNEXPECTED_ACTIVATION/)
      }
      for (const bypass of ['OC_V5_SKIP_MUTATION_LEASE=1', 'MUTATION_LEASE_ACTIVE=0; MUTATION_LEASE_BYPASSED=1']) {
        const result = fx.run(`${fx.ready}; ${bypass}; prebuilt_resume_recheck; echo UNEXPECTED_ACTIVATION`)
        assert.equal(result.status, 86, bypass + result.stdout + result.stderr)
        assert.doesNotMatch(result.stdout, /UNEXPECTED_ACTIVATION/)
      }
    } finally { fx.close() }
  })

  test('ordinary resume still stops on busy idle before maintenance or activation and never rebuilds', () => {
    const fx = artifactFixture()
    try {
      const result = fx.run(`${fx.ready}\n${fx.deploymentFacts}
commercial_wait_for_cutover_idle() { echo IDLE_BUSY >>"$FIX/calls"; return 44; }
activate_runtime_tuple() { echo UNEXPECTED_ACTIVATION >>"$FIX/calls"; }
deploy`)
      assert.equal(result.status, 44, result.stdout + result.stderr)
      const calls = fx.calls()
      assert.ok(calls.includes('FRESH_SQL') && calls.includes('ASSETS') && calls.includes('IDLE_BUSY'))
      assert.ok(!calls.some(value => /MAINTENANCE|ACTIVATION|ROLLBACK|UNEXPECTED_BUILD_/.test(value)), calls.join('\n'))
    } finally { fx.close() }
  })

  test('resume activation failure retains exact predecessor compensation and fences owner loss', () => {
    const fx = artifactFixture()
    try {
      for (const lost of ['0', '1']) {
        writeFileSync(path.join(fx.dir, 'calls'), '')
        const result = fx.run(`${fx.ready}\n${fx.deploymentFacts}
commercial_wait_for_cutover_idle() { echo IDLE_FREE >>"$FIX/calls"; }
activate_runtime_tuple() { echo ACTIVATION_FAILED >>"$FIX/calls"; FOREIGN_LEASE="$LOSE_AFTER_ACTIVATION"; return 1; }
deploy`, { LOSE_AFTER_ACTIVATION: lost })
        assert.equal(result.status, lost === '1' ? 86 : 1, result.stdout + result.stderr)
        const calls = fx.calls()
        assert.equal(calls.filter(value => value === 'ACTIVATION_FAILED').length, 1)
        assert.ok(calls.indexOf('IDLE_FREE') < calls.indexOf('MAINTENANCE'))
        if (lost === '0') {
          assert.ok(calls.includes(`RESTORE_KP ${fx.previous}`), calls.join('\n'))
          assert.ok(calls.includes(`RESTORE_WB ${fx.previous}`), calls.join('\n'))
          assert.ok(calls.includes('END_MAINTENANCE'))
        } else {
          assert.ok(!calls.some(value => /RESTORE_|END_MAINTENANCE/.test(value)), calls.join('\n'))
        }
        assert.ok(!calls.some(value => /UNEXPECTED_BUILD_|UNEXPECTED_ROLLBACK/.test(value)), calls.join('\n'))
      }
    } finally { fx.close() }
  })
})
test('actual controller gate accepts only protected clean ops descendants and independently checks controller CI', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-resume-controller-'))
  const tree = path.join(dir, 'repo'), origin = path.join(dir, 'origin.git')
  mkdirSync(tree)
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: tree, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout.trim()
  }
  const invoke = (command: string) => spawnSync('bash', ['-c', `set -euo pipefail
export V5_DEPLOY_SOURCE_ONLY=1
source ${quote(path.join(repo, 'scripts/deploy-v5.sh'))}
REPO_ROOT=${quote(tree)}
${command}`], { cwd: repo, encoding: 'utf8', env: { ...process.env, ALLOW_ANY_BRANCH: '1' } })
  try {
    git('init', '-q', '-b', 'feat/v5-aurora-rewrite')
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@invalid')
    writeFileSync(path.join(tree, 'base'), 'base\n'); git('add', '.'); git('commit', '-qm', 'fixture base')
    const base = git('rev-parse', 'HEAD')
    mkdirSync(path.join(tree, 'scripts/lib'), { recursive: true })
    writeFileSync(path.join(tree, 'scripts/lib/v5-prebuilt-resume.sh'), '# fixture ops controller\n')
    git('add', '.'); git('commit', '-qm', 'fixture allowed controller')
    const controller = git('rev-parse', 'HEAD')
    git('init', '--bare', '-q', origin); git('remote', 'add', 'origin', origin)
    git('push', '-q', 'origin', 'feat/v5-aurora-rewrite')
    assert.equal(invoke(`prebuilt_resume_controller_identity ${base}`).status, 0)
    writeFileSync(path.join(tree, 'untracked'), 'dirty')
    assert.notEqual(invoke(`prebuilt_resume_controller_identity ${base}`).status, 0)
    rmSync(path.join(tree, 'untracked'))
    for (const file of ['packages/gateway/business.ts', 'e2e/session-display/incidents.json', 'deploy/v5/release-metadata.json']) {
      mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
      writeFileSync(path.join(tree, file), '{}\n'); git('add', '.'); git('commit', '-qm', 'fixture unrelated delta')
      git('push', '-q', 'origin', 'feat/v5-aurora-rewrite')
      assert.notEqual(invoke(`prebuilt_resume_controller_identity ${base}`).status, 0, file)
      git('reset', '--hard', controller)
      git('--git-dir', origin, 'update-ref', 'refs/heads/feat/v5-aurora-rewrite', controller)
    }
    writeFileSync(path.join(tree, 'scripts/lib/v5-prebuilt-resume.sh'), '# unmerged allowed controller\n')
    git('add', '.'); git('commit', '-qm', 'fixture unmerged controller')
    assert.notEqual(invoke(`prebuilt_resume_controller_identity ${base}`).status, 0)
    git('reset', '--hard', controller)
    const record = { schemaVersion: 1, sourceCommit: base,
      originUnit: originUnit.replace('cdd0aa73', base.slice(0, 8)),
      masterRelease: path.join(dir, 'master', `rel-${base.slice(0, 9)}-20261102-122348`),
      runtimeRelease: path.join(dir, 'runtime', 'rel-aaaaaaaaaaaa'), imageId,
      platformBundle: 'bbbbbbbbbbbb', masterArtifactSha256: 'a'.repeat(64),
      runtimeManifestSha256: 'b'.repeat(64), bundleManifestSha256: 'c'.repeat(64) }
    const recordFile = path.join(dir, 'record'), queue = path.join(dir, 'queue')
    writeFileSync(recordFile, JSON.stringify(record)); chmodSync(recordFile, 0o600)
    writeFileSync(queue, `#!/bin/bash\nprintf '%s\\n' '${base}'\n`); chmodSync(queue, 0o755)
    const refused = invoke(`
RELEASES_ROOT=${quote(path.join(dir, 'master'))}; OC_HOTCFG_RELEASES_ROOT=${quote(path.join(dir, 'runtime'))}
RESUME_BUILT_RELEASE=${quote(recordFile)}; RELEASE_QUEUE_SCRIPT=${quote(queue)}; OC_V5_RELEASE_QUEUE_ID=rq-fixture
CI_GREEN_PASSED_SHA=${base}; CI_GREEN_PASSED_AT=1
assert_ci_green_for_source_commit() { printf 'CONTROLLER_CI %s\\n' "$1"; [[ "$1" != ${controller} ]]; }
systemctl() { echo UNEXPECTED_ORIGIN_READ; return 99; }
rc=0; prebuilt_resume_prepare || rc=$?
[[ "$rc" != 0 && "$CI_GREEN_PASSED_SHA" == ${base} && "$CI_GREEN_PASSED_AT" == 1 && -z "$PREBUILT_RESUME_CONTROLLER_SHA" ]]
echo SOURCE_CI_UNCHANGED`)
    assert.equal(refused.status, 0, refused.stdout + refused.stderr)
    assert.ok(refused.stdout.includes(`CONTROLLER_CI ${controller}`))
    assert.match(refused.stdout, /SOURCE_CI_UNCHANGED/)
    assert.doesNotMatch(refused.stdout, /UNEXPECTED_ORIGIN_READ/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function originFixture() {
  return {
    sourceCommit, originUnit, masterRelease, runtimeRelease, imageId,
    masterMarker: { schemaVersion: 2, sourceCommit, builtAt: '20261102-122348',
      metadataSha256: 'b'.repeat(64), artifactSha256: 'c'.repeat(64) },
    unitProperties: {
      Id: originUnit, InvocationID: invocationId, ActiveState: 'failed', SubState: 'failed',
      Result: 'exit-code', ExecMainStatus: '1',
      ExecMainStartTimestamp: 'Mon 2026-11-02 12:19:55 UTC',
      ExecMainExitTimestamp: 'Mon 2026-11-02 13:08:44 UTC',
      WorkingDirectory: canonical,
      ExecStart: `{ path=/usr/bin/bash ; argv[]=/usr/bin/bash ${canonical}/scripts/deploy-v5.sh --with-dist ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    },
    journal: [
      row('2026-11-02T12:49:41Z', `  ✓ release 就绪(带 .complete):${masterRelease}`),
      row('2026-11-02T12:58:17Z', `  ✓ runtime release=${runtimeRelease} image_id=${imageId}`),
      row('2026-11-02T13:08:41Z', '✗ 未证明商业空窗,live 未切换'),
    ],
  }
}

describe('formal prebuilt resume original-build evidence', () => {
  test('accepts the exact failed ordinary invocation and returns bound provenance', () => {
    const evidence = validateOriginBuildEvidence(originFixture())
    assert.equal(evidence.sourceCommit, sourceCommit)
    assert.equal(evidence.originUnit, originUnit)
    assert.equal(evidence.invocationId, invocationId)
    assert.match(evidence.journalSha256, /^[0-9a-f]{64}$/)
  })

  test('accepts raw systemctl properties and JSON-line journal without manual PASS input', () => {
    const input = originFixture()
    const evidence = validateOriginBuildEvidence({ ...input,
      unitProperties: Object.entries(input.unitProperties).map(([k, v]) => `${k}=${v}`).join('\n'),
      journal: input.journal.map(value => JSON.stringify(value)).join('\n'),
    })
    assert.equal(evidence.sourceCommit, sourceCommit)
    assert.equal(evidence.invocationId, invocationId)
  })

  test('refuses unrelated or wrong-source original units', () => {
    for (const replacement of ['some-other.service', originUnit.replace('cdd0aa73', 'deadbeef'),
      originUnit.replace('with-dist', 'canary')]) {
      assert.throws(() => validateOriginBuildEvidence({ ...originFixture(), originUnit: replacement }))
    }
  })

  test('refuses an active, successful, signalled or otherwise non-idle-timeout origin', () => {
    for (const changed of [{ ActiveState: 'active', SubState: 'running' }, { ExecMainStatus: '0' },
      { Result: 'signal' }, { InvocationID: '' }]) {
      const input = originFixture()
      assert.throws(() => validateOriginBuildEvidence({ ...input,
        unitProperties: { ...input.unitProperties, ...changed } }))
    }
  })

  test('refuses changed canonical cwd, script identity or extra deployment arguments', () => {
    const input = originFixture()
    for (const changed of [{ WorkingDirectory: '/other/tree' },
      { ExecStart: input.unitProperties.ExecStart.replace(canonical, '/other/tree') },
      { ExecStart: input.unitProperties.ExecStart.replace('--with-dist', '--with-dist --allow-unverified-ci') },
      { ExecStart: input.unitProperties.ExecStart.replace('--with-dist', '--canary') }]) {
      assert.throws(() => validateOriginBuildEvidence({ ...input,
        unitProperties: { ...input.unitProperties, ...changed } }))
    }
  })

  test('refuses every missing official readiness or pre-cutover failure record', () => {
    const input = originFixture()
    for (let missing = 0; missing < input.journal.length; missing++) {
      assert.throws(() => validateOriginBuildEvidence({ ...input,
        journal: input.journal.filter((_, index) => index !== missing) }))
    }
    assert.throws(() => validateOriginBuildEvidence({ ...input, journal: 'PASS all gates' }))
  })

  test('refuses ready master, runtime or image identities borrowed from another build', () => {
    const input = originFixture()
    for (const [index, old, replacement] of [
      [0, masterRelease, masterRelease.replace('cdd0aa734', 'deadbeef')],
      [1, runtimeRelease, runtimeRelease.replace('55de34b944a9', '000000000000')],
      [1, imageId, `sha256:${'d'.repeat(64)}`],
    ] as const) {
      const journal = structuredClone(input.journal)
      journal[index]!.MESSAGE = journal[index]!.MESSAGE.replace(old, replacement)
      assert.throws(() => validateOriginBuildEvidence({ ...input, journal }))
    }
  })

  test('refuses journal proof from another invocation or without its identity', () => {
    const input = originFixture()
    for (const identity of ['e'.repeat(32), '']) {
      const journal = structuredClone(input.journal)
      journal[1]!._SYSTEMD_INVOCATION_ID = identity
      assert.throws(() => validateOriginBuildEvidence({ ...input, journal }))
    }
    const nullMessage = structuredClone(input.journal)
    nullMessage[1]!.MESSAGE = null as unknown as string
    assert.throws(() => validateOriginBuildEvidence({ ...input, journal: nullMessage }))
  })

  test('refuses readiness outside the unit lifetime or in the wrong temporal order', () => {
    const input = originFixture()
    for (const [index, timestamp] of [[0, '2026-11-02T12:00:00Z'],
      [1, '2026-11-02T13:10:00Z'], [2, '2026-11-02T12:40:00Z']] as const) {
      const journal = structuredClone(input.journal)
      journal[index]!.__REALTIME_TIMESTAMP = micros(timestamp)
      assert.throws(() => validateOriginBuildEvidence({ ...input, journal }))
    }
  })

  test('refuses a wrong-source marker or an artifact built outside the original invocation', () => {
    const input = originFixture()
    for (const changed of [{ sourceCommit: 'f'.repeat(40) }, { builtAt: '20261101-122348' },
      { builtAt: '20261102-140000' }, { builtAt: 'invalid' }]) {
      assert.throws(() => validateOriginBuildEvidence({ ...input,
        masterMarker: { ...input.masterMarker, ...changed } }))
    }
  })
})

test('ordinary resume CLI keeps all live gates and rejects waiver or alternate lanes before side effects', () => {
  const command = 'if test "$FIXTURE_DETACHED_BRANCH" = 1; then git() { if test "$*" = "rev-parse --abbrev-ref HEAD"; then printf HEAD; else command git "$@"; fi; }; fi; V5_DEPLOY_SOURCE_ONLY=1 source scripts/deploy-v5.sh --with-dist --resume-built-release=/tmp/fixture-resume.json "$@"; printf PARSED'
  const invoke = (env: Record<string, string> = {}, args: string[] = []) => spawnSync('bash', ['-c', command, 'fixture', ...args], {
    cwd: repo, env: { ...process.env, ALLOW_ANY_BRANCH: '1', FIXTURE_DETACHED_BRANCH: '0', V5_SMOKE_E2E: '1', V5_SMOKE_TURN: '1', V5_CANARY_REQUIRE_COST: '1', OC_FINALIZE_SKIP_EGRESS_GATE: '0', OC_V5_SKIP_MUTATION_LEASE: '0', OC_CAPMATRIX_COMPAT: '', ...env }, encoding: 'utf8', timeout: 10_000,
  })
  const valid = invoke()
  assert.equal(valid.status, 0, valid.stdout + valid.stderr)
  const detached = invoke({ FIXTURE_DETACHED_BRANCH: '1' })
  assert.equal(detached.status, 0, detached.stdout + detached.stderr)
  const guarded = invoke({ FIXTURE_DETACHED_BRANCH: '1', ALLOW_ANY_BRANCH: '0' })
  assert.equal(guarded.status, 1, guarded.stdout + guarded.stderr)
  assert.doesNotMatch(guarded.stdout, /PARSED/)
  for (const env of [{ V5_SMOKE_E2E: '0' }, { V5_SMOKE_E2E: '2' }, { V5_SMOKE_TURN: '0' },
    { V5_CANARY_REQUIRE_COST: '0' }, { OC_FINALIZE_SKIP_EGRESS_GATE: '1' }, { OC_V5_SKIP_MUTATION_LEASE: '1' }, { OC_CAPMATRIX_COMPAT: 'fixture' }]) {
    const run = invoke(env)
    assert.equal(run.status, 2, run.stderr)
    assert.doesNotMatch(run.stdout, /PARSED/)
  }
  for (const args of [['--egress'], ['--allow-unverified-ci'], ['--allow-legacy-manifest-missing'], ['--canary'], ['--hot-config'], ['--dry-run']]) {
    const run = invoke({}, args)
    assert.equal(run.status, 2, run.stderr)
    assert.doesNotMatch(run.stdout, /PARSED/)
  }
})
