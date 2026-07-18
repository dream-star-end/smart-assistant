import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const deploy = path.join(root, 'scripts/deploy-v5.sh')
const manualMutationLease = path.join(root, 'scripts/with-production-mutation-lease.sh')
const baselineGuard = path.join(root, 'scripts/v5-baseline-security.sh')
const releaseGc = path.join(root, 'scripts/v5-release-gc.sh')
const monitor = path.join(root, 'scripts/v5-monitor.sh')
const caddy = path.join(root, 'scripts/install-v5-upstream-errors.sh')
const caddyApply = path.join(root, 'scripts/v5-caddy-apply.sh')
const anthropicProxy = path.join(root, 'packages/commercial/src/http/proxy/index.ts')
const commercialIndex = path.join(root, 'packages/commercial/src/index.ts')
const knowledgePlanetSeed = path.join(
  root,
  'packages/commercial/scripts/seed-knowledge-planet-plugin.ts',
)
const supervisor = path.join(root, 'packages/commercial/src/agent-sandbox/v3supervisor.ts')
const v5Overrides = path.join(root, 'deploy/v5/commercial-v5.env.overrides')
const v5UnitA = path.join(root, 'deploy/v5/openclaude-v5.service')
const v5UnitB = path.join(root, 'deploy/v5/openclaude-v5-b.service')
const v5BaselinePortGuardSocket = path.join(root, 'deploy/v5/openclaude-v5-baseline-port-guard.socket')
const v5BaselinePortGuardService = path.join(root, 'deploy/v5/openclaude-v5-baseline-port-guard.service')
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function run(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const childEnv = { ...process.env, ALLOW_ANY_BRANCH: '1', ...env }
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key]
  }
  return spawnSync('bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: childEnv,
  })
}

async function waitUntilManualLease(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function manualLeaseFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'v5-manual-lease-'))
  dirs.push(dir)
  const bin = path.join(dir, 'bin')
  await mkdir(bin)
  const lock = path.join(dir, 'mutation.lock')
  const commandStarted = path.join(dir, 'command-started')
  const commandRelease = path.join(dir, 'command-release')
  const blockerStarted = path.join(dir, 'blocker-started')
  const blockerRelease = path.join(dir, 'blocker-release')
  const sshPids = path.join(dir, 'ssh-pids')
  const remotePids = path.join(dir, 'remote-pids')
  const wrapper = path.join(dir, 'with-production-mutation-lease.sh')
  const command = path.join(dir, 'wrapped-command.sh')
  const source = await readFile(manualMutationLease, 'utf8')
  const lockNeedle = 'PRODUCTION_MUTATION_LOCK="/run/openclaude-v5/production-mutation.lock"'
  assert.equal(source.split(lockNeedle).length - 1, 1, 'manual wrapper lock path replacement drifted')
  const fixtureSource = source.replace(lockNeedle, `PRODUCTION_MUTATION_LOCK="${lock}"`)
  await writeFile(wrapper, fixtureSource)
  await chmod(wrapper, 0o755)
  await writeFile(
    path.join(bin, 'ssh'),
    [
      '#!/bin/bash',
      'printf "%s\\n" "$$" >>"$FAKE_SSH_PIDS"',
      'shift',
      'bash -c "$1" &',
      'remote_pid=$!',
      'printf "%s\\n" "$remote_pid" >>"$FAKE_REMOTE_PIDS"',
      "trap 'exit 0' HUP INT TERM",
      'wait "$remote_pid"',
    ].join('\n') + '\n',
  )
  await chmod(path.join(bin, 'ssh'), 0o755)
  await writeFile(
    command,
    [
      '#!/bin/bash',
      'set -e',
      ': >"$COMMAND_STARTED"',
      'while [ ! -e "$COMMAND_RELEASE" ]; do sleep 0.05; done',
    ].join('\n') + '\n',
  )
  await chmod(command, 0o755)
  return {
    dir,
    lock,
    commandStarted,
    commandRelease,
    blockerStarted,
    blockerRelease,
    sshPids,
    remotePids,
    wrapper,
    command,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      KL_HOST: 'fake-manual-lease',
      FAKE_SSH_PIDS: sshPids,
      FAKE_REMOTE_PIDS: remotePids,
      COMMAND_STARTED: commandStarted,
      COMMAND_RELEASE: commandRelease,
      BLOCKER_STARTED: blockerStarted,
      BLOCKER_RELEASE: blockerRelease,
    } as NodeJS.ProcessEnv,
  }
}

async function killManualLeaseFixtureProcesses(...pidFiles: string[]): Promise<void> {
  for (const pidFile of pidFiles) {
    const raw = await readFile(pidFile, 'utf8').catch(() => '')
    for (const value of raw.split(/\s+/)) {
      const pid = Number(value)
      if (!Number.isSafeInteger(pid) || pid <= 1) continue
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
}

async function caddyRemoteFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'v5-caddy-port-')); dirs.push(dir)
  const bin = path.join(dir, 'bin'); await mkdir(bin)
  const sshLog = path.join(dir, 'ssh.log')
  const sshStdinLog = path.join(dir, 'ssh.stdin.log')
  const scpLog = path.join(dir, 'scp.log')
  await writeFile(path.join(bin, 'ssh'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >>"$FAKE_SSH_LOG"',
    'if [ "${2:-}" = bash ] && [ "${3:-}" = -s ]; then',
    '  cat >"$FAKE_SSH_STDIN_LOG"',
    '  printf "SET:%s:svc_v5 http_v5 public_route\\n" "${9:-}"',
    '  exit 0',
    'fi',
    'case "$*" in',
    '  *psql*) cat >/dev/null; printf "%s\\n" "$FAKE_DS_ROW" ;;',
    '  *Cookie:*) printf "%s\\n" \'{"ok":true,"slot":"B"}\' ;;',
    '  *curl*) printf "%s\\n" \'{"ok":true,"slot":"A"}\' ;;',
    'esac',
  ].join('\n') + '\n')
  await writeFile(path.join(bin, 'scp'), '#!/bin/sh\nprintf "%s\\n" "$*" >>"$FAKE_SCP_LOG"\n')
  await chmod(path.join(bin, 'ssh'), 0o755)
  await chmod(path.join(bin, 'scp'), 0o755)
  return {
    dir,
    sshLog,
    sshStdinLog,
    scpLog,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      KL_HOST: 'fake-v5',
      FAKE_SSH_LOG: sshLog,
      FAKE_SSH_STDIN_LOG: sshStdinLog,
      FAKE_SCP_LOG: scpLog,
    } satisfies NodeJS.ProcessEnv,
  }
}

describe('v5 release safety lanes', () => {
  test('Knowledge Planet Plugin is noninteractively gated before activation and seeded only after full smoke', async () => {
    const [source, seedSource] = await Promise.all([
      readFile(deploy, 'utf8'),
      readFile(knowledgePlanetSeed, 'utf8'),
    ])
    const start = source.indexOf('\ndeploy() {')
    const end = source.indexOf('\n# ───────────────────────── offline recycle', start)
    assert.ok(start >= 0 && end > start)
    const body = source.slice(start, end)
    const built = body.indexOf('build_release ||')
    // 2026-07-17 架构纠偏:阻断式 smoke_gate → 非阻断 advisory gate(stdout JSON 契约,
    // 基础设施故障 fail-closed;审批状态只决定是否走插件迁移段,不阻断平台部署)。
    const advisoryGate = body.indexOf('knowledge_planet_plugin_advisory_gate "$BUILT_RELEASE"')
    const maintenance = body.indexOf('begin_planned_maintenance deploy')
    const closeGate = body.indexOf('knowledge_planet_plugin_close_gate "$BUILT_RELEASE"')
    const previousPluginPin = body.indexOf(
      'kp_previous_plugin_version_id="$KNOWLEDGE_PLANET_GATE_VERSION_ID"',
    )
    const previousPluginClassifier = body.indexOf(
      'knowledge_planet_plugin_classify_previous_release',
      previousPluginPin,
    )
    const activation = body.indexOf('activate_release "$BUILT_RELEASE"')
    const fullSmoke = body.indexOf('smoke "$ACTIVE_PORT"')
    const turnCanary = body.indexOf('smoke_turn_canary "$BUILT_RELEASE"')
    const zeroTouch = body.indexOf('knowledge-planet=zero-touch')
    const seed = body.indexOf('knowledge_planet_plugin_seed "$BUILT_RELEASE"')
    const maintenanceEnd = body.indexOf('end_planned_maintenance', seed)
    assert.ok(built >= 0 && advisoryGate > built && maintenance > advisoryGate)
    assert.ok(
      closeGate > maintenance &&
        previousPluginPin > closeGate &&
        previousPluginClassifier > previousPluginPin &&
        activation > previousPluginClassifier &&
        fullSmoke > activation,
    )
    // 真 turn canary 强校验紧随 full smoke(2026-07-17 goal 事故门禁补强);
    // 零接触收尾分支必须在 seed 之前(门未关/未审批 → 不 seed 直接完成)。
    assert.ok(turnCanary > fullSmoke && zeroTouch > turnCanary && seed > zeroTouch && maintenanceEnd > seed)
    // advisory gate 必须校验 stdout JSON 契约,不依赖 tsx 退出码(fail-open 历史教训)。
    assert.match(source, /advisory == "knowledge-planet"/)
    assert.match(source, /--advisory-status/)
    const advisoryStatus = seedSource.slice(
      seedSource.indexOf('async function advisoryStatus()'),
      seedSource.indexOf('async function assertSetupFirstSafe'),
    )
    const artifactMatch = advisoryStatus.indexOf('const artifactMatchesCurrentApproved')
    const strictLookup = advisoryStatus.indexOf('findApprovedKnowledgePlanetPluginForDeploy')
    assert.ok(artifactMatch >= 0 && strictLookup > artifactMatch)
    assert.match(
      advisoryStatus,
      /const approvedForDeploy =\s*artifactMatchesCurrentApproved &&\s*\(await findApprovedKnowledgePlanetPluginForDeploy/,
    )
    assert.equal(
      body.match(/"\$egress_prev_release" "\$kp_had_previous_plugin"/g)?.length,
      2,
      'pre-seed validation and mid-seed failures must both carry the pinned first-publication flag',
    )
    assert.match(
      source,
      /seed-knowledge-planet-plugin\.ts --smoke-only[\s\S]*seed-knowledge-planet-plugin\.ts --seed-only/,
    )
    assert.doesNotMatch(seedSource, /smoke skipped/)
    const smokeOnly = seedSource.slice(
      seedSource.indexOf('async function smokeOnly()'),
      seedSource.indexOf('async function seedOnly()'),
    )
    assert.match(smokeOnly, /readHandoffIfPresent\(expected\)/)
    assert.doesNotMatch(smokeOnly, /startLogin|waitForQrLogin/)
    assert.match(seedSource, /readHandoffIfPresent\(expected\)[\s\S]*seedKnowledgePlanetPlugin/)
    assert.match(seedSource, /workerDigest: KNOWLEDGE_PLANET_WORKER_DIGEST/)
    assert.match(seedSource, /runKnowledgePlanetActionSmoke/)
    assert.match(seedSource, /findApprovedKnowledgePlanetPluginForDeploy/)
    assert.match(seedSource, /passedActionIds/)
    assert.match(seedSource, /beforeListingOpen/)
    assert.match(seedSource, /bindManagedBrowserPluginAccount/)
    assert.match(seedSource, /--verify-user=/)
    assert.match(
      source,
      /--verify-knowledge-planet-user=\*\)[\s\S]*MODE="knowledge-planet-verify"/,
    )
    assert.match(
      source,
      /OC_V5_KP_VERIFY_LOCK_FILE:-\/var\/lock\/oc-v5-knowledge-planet-verify\.lock/,
    )
    assert.match(
      source,
      /knowledge-planet-verify\) knowledge_planet_plugin_verify_user/,
    )
    assert.match(seedSource, /--classify-current-for-release=/)
    assert.match(
      source,
      /deploy_dist\(\)[\s\S]*knowledge_planet_plugin_assert_release_compatible[\s\S]*activate_runtime_tuple/,
    )
    assert.match(
      source,
      /canary\(\)[\s\S]*knowledge_planet_plugin_assert_release_compatible[\s\S]*start_candidate_unit_and_wait/,
    )
    assert.match(
      source,
      /finalize\(\)[\s\S]*knowledge_planet_plugin_assert_release_compatible[\s\S]*finalize_run_steps/,
    )
    assert.match(
      source,
      /rollback_runtime_tuple "\$ROLLBACK_N" 1 "\$kp_rollback_helper"[\s\S]*smoke "\$ACTIVE_PORT"[\s\S]*knowledge_planet_plugin_open_gate_to_release/,
    )
    // 2026-07-17 纠偏:rollback 的插件门恢复 best-effort——release 身份失败必须有
    // current-version 兜底,且不再以反向补偿推翻已成功的回滚。
    assert.match(
      source,
      /knowledge_planet_plugin_open_gate_to_release "\$kp_rollback_helper" "\$kp_rollback_target"[\s\S]*knowledge_planet_plugin_open_gate_current "\$kp_rollback_helper"/,
    )
    assert.match(seedSource, /--open-listing-gate-current/)
    assert.match(seedSource, /zero-touch seed: reopening gate to current approved version/)
    assert.match(seedSource, /async function openListingGateToCurrent/)
    // seed 脚本必须硬退出(process.exit),软 exitCode 经 npx tsx 会 fail-open(2026-07-17 实测)。
    assert.match(seedSource, /process\.exit\(1\)/)
    // 未审批候选不再 throw 阻断(旧断言反转)。
    assert.doesNotMatch(
      seedSource,
      /throw new Error\('new Knowledge Planet Plugin versions require an encrypted action handoff'\)/,
    )
  })

  test('Knowledge Planet setup-first deploy is race-guarded, repeat-safe, and skips the v1.1 seed', async () => {
    const [source, seedSource] = await Promise.all([
      readFile(deploy, 'utf8'),
      readFile(knowledgePlanetSeed, 'utf8'),
    ])
    const start = source.indexOf('\ndeploy() {')
    const end = source.indexOf('\n# ───────────────────────── offline recycle', start)
    const body = source.slice(start, end)
    const built = body.indexOf('build_release ||')
    const pre = body.indexOf(
      'knowledge_planet_plugin_assert_setup_first_safe "$BUILT_RELEASE" pre',
    )
    const capturedVersion = body.indexOf(
      'kp_setup_plugin_version_id="$KNOWLEDGE_PLANET_SETUP_VERSION_ID"',
      pre,
    )
    const close = body.indexOf('knowledge_planet_plugin_close_gate "$BUILT_RELEASE"')
    const activation = body.indexOf('activate_release "$BUILT_RELEASE"')
    const post = body.indexOf(
      'knowledge_planet_plugin_assert_setup_first_safe "$BUILT_RELEASE" post',
    )
    const smoke = body.indexOf('smoke "$ACTIVE_PORT"', post)
    const dist = body.indexOf('dist_handshake_smoke "$ACTIVE_PORT"', smoke)
    const reopen = body.indexOf(
      'knowledge_planet_plugin_open_setup_first_gate_to_version',
      dist,
    )
    const setupDone = body.indexOf('knowledge-planet=setup-first', reopen)
    const earlyReturn = body.indexOf('return 0', reopen)
    const seed = body.indexOf('knowledge_planet_plugin_seed "$BUILT_RELEASE"')
    assert.ok(
      built >= 0 &&
        pre > built &&
        capturedVersion > pre &&
        close > capturedVersion &&
        activation > close &&
        post > activation &&
        smoke > post &&
        dist > smoke &&
        reopen > dist &&
        setupDone > reopen &&
        earlyReturn > reopen &&
        seed > earlyReturn,
    )
    assert.match(
      seedSource,
      /async function assertSetupFirstSafe\(phase: ['"]pre['"] \| ['"]post['"]\)/,
    )
    assert.match(seedSource, /version_review_source !== ['"]platform['"]/)
    assert.match(seedSource, /OFFICIAL_MANAGED_BROWSER_TRANSITION_GATE_REASON/)
    assert.match(seedSource, /classifyKnowledgePlanetSetupPin\([\s\S]*compatible-predecessor/)
    assert.match(seedSource, /exactActiveInstalls !== activeInstalls/)
    assert.match(seedSource, /activeAccounts !== 0/)
    assert.match(seedSource, /--open-setup-first-gate-to-version=ID/)
    assert.match(
      seedSource,
      /async function openSetupFirstListingGateToVersion[\s\S]*loadVerifiedRuntimePluginContract[\s\S]*classifyKnowledgePlanetSetupPin[\s\S]*compatible-predecessor[\s\S]*canonicalSha256Hex\(verified\.contract\.account\)[\s\S]*canonicalSha256Hex\(verified\.contract\.runtime\.accountState\)[\s\S]*openOfficialManagedBrowserPluginListingGate/,
    )

    const missingDist = run(deploy, ['--dry-run', '--defer-knowledge-planet-upgrade'])
    assert.equal(missingDist.status, 2, missingDist.stdout + missingDist.stderr)
    assert.match(missingDist.stderr, /仅允许与普通 deploy \+ --with-dist 同用/)

    const accepted = run(deploy, [
      '--dry-run',
      '--with-dist',
      '--defer-knowledge-planet-upgrade',
    ])
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr)
    assert.match(accepted.stdout, /setup-first 前置守卫/)
    assert.match(accepted.stdout, /setup-first drain 后守卫/)
    assert.match(accepted.stdout, /knowledge-planet=setup-first/)
    assert.doesNotMatch(accepted.stdout, /消费加密交接/)
  })

  test('Knowledge Planet setup-first compensation restores source then the exact predecessor without a Plugin transition', () => {
    const harness = [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'calls=()',
      'knowledge_planet_plugin_close_gate() { calls+=("close:$1"); }',
      'knowledge_planet_plugin_transition_to_release() { calls+=("UNEXPECTED-transition:$*"); return 91; }',
      'knowledge_planet_plugin_open_gate_to_release() { calls+=("UNEXPECTED-release-open:$*"); return 92; }',
      'knowledge_planet_plugin_open_setup_first_gate_to_version() { calls+=("open-exact:$1:$2"); }',
      'activate_release() { calls+=("activate:$1"); }',
      'activate_egress_release() { calls+=("UNEXPECTED-egress:$*"); return 93; }',
      'rollback_runtime_tuple() { calls+=("rollback:$1:$2:$3:$4"); }',
      'smoke() { calls+=("smoke:$1"); }',
      'ACTIVE_PORT=18790',
      'knowledge_planet_compensate_setup_first new-release old-release 0 0 "" 1606',
      'printf "classic:%s\n" "${calls[*]}"',
      'calls=()',
      'knowledge_planet_compensate_setup_first new-release old-release 1 0 "" 1606',
      'printf "hotcfg:%s\n" "${calls[*]}"',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1' },
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(
      result.stdout,
      /classic:close:new-release activate:old-release smoke:18790 open-exact:new-release:1606/,
    )
    assert.match(
      result.stdout,
      /hotcfg:rollback:1:1:new-release:0 smoke:18790 open-exact:new-release:1606/,
    )
    assert.doesNotMatch(result.stdout, /UNEXPECTED/)
  })

  test('Knowledge Planet first-publication and hotcfg compensation stay fail-closed', () => {
    const harness = [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'calls=()',
      'knowledge_planet_plugin_close_gate() { calls+=("close:$1"); }',
      'knowledge_planet_plugin_transition_to_release() { calls+=("UNEXPECTED-transition:$*"); return 91; }',
      'knowledge_planet_plugin_open_gate_to_release() { calls+=("open:$1:$2"); }',
      'activate_release() { calls+=("activate:$1"); }',
      'activate_egress_release() { calls+=("UNEXPECTED-egress:$*"); return 92; }',
      'rollback_runtime_tuple() { calls+=("rollback:$1:$2:$3:$4"); }',
      'smoke() { calls+=("smoke:$1"); }',
      'ACTIVE_PORT=18790',
      '# A prior partial first publication left current=candidate, but old source still has no approved exact version.',
      'ssh() { printf \'%s\\n\' \'{"available":false,"versionId":null,"currentVersionId":"77"}\'; }',
      'knowledge_planet_plugin_classify_previous_release new-release old-release 77',
      'test "$KNOWLEDGE_PLANET_PREVIOUS_RELEASE_AVAILABLE" = 0',
      '# Models the first mid-seed failure followed by a second pre-seed smoke failure.',
      'knowledge_planet_compensate_deploy new-release old-release 0 0 "" "$KNOWLEDGE_PLANET_PREVIOUS_RELEASE_AVAILABLE"',
      'knowledge_planet_compensate_deploy new-release old-release 0 0 "" "$KNOWLEDGE_PLANET_PREVIOUS_RELEASE_AVAILABLE"',
      'printf "classic:%s\\n" "${calls[*]}"',
      'calls=()',
      'ssh() { printf \'%s\\n\' \'{"available":true,"versionId":"55","currentVersionId":"77"}\'; }',
      'knowledge_planet_plugin_classify_previous_release new-release old-release 77',
      'test "$KNOWLEDGE_PLANET_PREVIOUS_RELEASE_AVAILABLE" = 1',
      'knowledge_planet_compensate_deploy new-release old-release 1 0 "" "$KNOWLEDGE_PLANET_PREVIOUS_RELEASE_AVAILABLE"',
      'printf "hotcfg-existing:%s\\n" "${calls[*]}"',
      'calls=()',
      'knowledge_planet_compensate_deploy new-release old-release 1 0 "" 0',
      'printf "hotcfg-first:%s\\n" "${calls[*]}"',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1' },
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(
      result.stdout,
      /classic:close:new-release activate:old-release smoke:18790 close:new-release activate:old-release smoke:18790/,
    )
    assert.match(
      result.stdout,
      /hotcfg-existing:rollback:1:1:new-release:1 smoke:18790 open:new-release:old-release/,
    )
    assert.match(
      result.stdout,
      /hotcfg-first:rollback:1:1:new-release:0 smoke:18790(?:\n|$)/,
    )
    assert.doesNotMatch(result.stdout, /UNEXPECTED/)
  })

  test('Knowledge Planet verification is an explicit validated lane while ordinary deploy stays noninteractive', () => {
    const verified = run(deploy, ['--dry-run', '--verify-knowledge-planet-user=1'])
    assert.equal(verified.status, 0, verified.stdout + verified.stderr)
    assert.match(verified.stdout, /Knowledge Planet Plugin preverification\(user=1\)/)
    assert.match(verified.stdout, /one QR → 15 actions → encrypted handoff/)

    for (const userId of ['0', '-1', 'abc', '']) {
      const rejected = run(deploy, [
        '--dry-run',
        `--verify-knowledge-planet-user=${userId}`,
      ])
      assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr)
      assert.match(rejected.stderr, /需正整数用户 ID/)
    }
  })

  test('trusted baseline guard mirrors the runtime manifest and hardens 775/664 releases', async () => {
    const [guardSource, supervisorSource] = await Promise.all([
      readFile(baselineGuard, 'utf8'),
      readFile(supervisor, 'utf8'),
    ])
    const shellSkills = guardSource
      .match(/EXPECTED_SKILLS=\(\n([\s\S]*?)\n\)/)?.[1]
      .split(/\s+/)
      .filter(Boolean) ?? []
    const tsSkills = [...(supervisorSource
      .match(/V3_CCB_BASELINE_SKILL_NAMES = \[([\s\S]*?)\] as const/)?.[1] ?? '')
      .matchAll(/"([a-z0-9-]+)"/g)]
      .map((match) => match[1])
    assert.deepEqual(shellSkills, tsSkills)

    const dir = await mkdtemp(path.join(tmpdir(), 'v5-baseline-guard-')); dirs.push(dir)
    const release = path.join(dir, 'release')
    const baseline = path.join(release, 'packages/commercial/agent-sandbox/ccb-baseline')
    await mkdir(path.dirname(baseline), { recursive: true })
    await cp(path.join(root, 'packages/commercial/agent-sandbox/ccb-baseline'), baseline, { recursive: true })
    const madeWritable = spawnSync('chmod', ['-R', 'g+w', baseline], { encoding: 'utf8' })
    assert.equal(madeWritable.status, 0, madeWritable.stderr)
    await chmod(path.join(baseline, 'skills/system-info'), 0o700)
    await chmod(path.join(baseline, 'skills/system-info/SKILL.md'), 0o600)

    const before = spawnSync('bash', [baselineGuard, 'check-release', release], { encoding: 'utf8' })
    assert.notEqual(before.status, 0)
    assert.match(before.stderr, /group\/other writable/)
    const hardened = spawnSync('bash', [baselineGuard, 'harden-release', release], { encoding: 'utf8' })
    assert.equal(hardened.status, 0, hardened.stderr)
    const after = spawnSync('bash', [baselineGuard, 'check-release', release], { encoding: 'utf8' })
    assert.equal(after.status, 0, after.stderr)
    const dirMode = spawnSync('stat', ['-c', '%a', path.join(baseline, 'skills/system-info')], { encoding: 'utf8' })
    const fileMode = spawnSync('stat', ['-c', '%a', path.join(baseline, 'skills/system-info/SKILL.md')], { encoding: 'utf8' })
    assert.equal(dirMode.stdout.trim(), '755')
    assert.equal(fileMode.stdout.trim(), '644')
  })

  test('trusted baseline guard rejects symlinks, special nodes and manifest drift before hardening', async () => {
    const makeRelease = async (suffix: string) => {
      const dir = await mkdtemp(path.join(tmpdir(), `v5-baseline-${suffix}-`)); dirs.push(dir)
      const release = path.join(dir, 'release')
      const baseline = path.join(release, 'packages/commercial/agent-sandbox/ccb-baseline')
      await mkdir(path.dirname(baseline), { recursive: true })
      await cp(path.join(root, 'packages/commercial/agent-sandbox/ccb-baseline'), baseline, { recursive: true })
      return { release, baseline }
    }

    const linked = await makeRelease('symlink')
    const linkedSkill = path.join(linked.baseline, 'skills/system-info/SKILL.md')
    await rm(linkedSkill)
    await symlink('/etc/passwd', linkedSkill)
    const linkedResult = spawnSync('bash', [baselineGuard, 'harden-release', linked.release], { encoding: 'utf8' })
    assert.notEqual(linkedResult.status, 0)
    assert.match(linkedResult.stderr, /symlink\/special node/)

    const special = await makeRelease('fifo')
    const specialSkill = path.join(special.baseline, 'skills/system-info/SKILL.md')
    await rm(specialSkill)
    const fifo = spawnSync('mkfifo', [specialSkill], { encoding: 'utf8' })
    assert.equal(fifo.status, 0, fifo.stderr)
    const specialResult = spawnSync('bash', [baselineGuard, 'harden-release', special.release], { encoding: 'utf8' })
    assert.notEqual(specialResult.status, 0)
    assert.match(specialResult.stderr, /symlink\/special node/)

    const drift = await makeRelease('drift')
    await mkdir(path.join(drift.baseline, 'skills/undeclared'))
    await writeFile(path.join(drift.baseline, 'skills/undeclared/SKILL.md'), '# unexpected\n')
    const driftResult = spawnSync('bash', [baselineGuard, 'harden-release', drift.release], { encoding: 'utf8' })
    assert.notEqual(driftResult.status, 0)
    assert.match(driftResult.stderr, /skill manifest mismatch/)

    const extraFile = await makeRelease('extra-file')
    await writeFile(path.join(extraFile.baseline, 'skills/undeclared.txt'), 'unexpected\n')
    const extraFileResult = spawnSync('bash', [baselineGuard, 'harden-release', extraFile.release], { encoding: 'utf8' })
    assert.notEqual(extraFileResult.status, 0)
    assert.match(extraFileResult.stderr, /skill manifest mismatch/)

    const unreadable = await makeRelease('unreadable')
    await chmod(path.join(unreadable.baseline, 'skills/system-info/SKILL.md'), 0o600)
    const unreadableResult = spawnSync('bash', [baselineGuard, 'check-release', unreadable.release], { encoding: 'utf8' })
    assert.notEqual(unreadableResult.status, 0)
    assert.match(unreadableResult.stderr, /not world-readable/)

    const untraversable = await makeRelease('untraversable')
    await chmod(path.join(untraversable.baseline, 'skills/system-info'), 0o700)
    const untraversableResult = spawnSync('bash', [baselineGuard, 'check-release', untraversable.release], { encoding: 'utf8' })
    assert.notEqual(untraversableResult.status, 0)
    assert.match(untraversableResult.stderr, /not world-readable\/traversable/)
  })

  test('baseline release/config guards cover build, slots, smoke, canary and rollback activation', async () => {
    const [source, overrides, unitA, unitB, portGuardSocket, portGuardService, indexSource] = await Promise.all([
      readFile(deploy, 'utf8'),
      readFile(v5Overrides, 'utf8'),
      readFile(v5UnitA, 'utf8'),
      readFile(v5UnitB, 'utf8'),
      readFile(v5BaselinePortGuardSocket, 'utf8'),
      readFile(v5BaselinePortGuardService, 'utf8'),
      readFile(commercialIndex, 'utf8'),
    ])
    for (const key of [
      'OC_V3_CCB_BASELINE_DIR',
      'OC_V3_CCB_BASELINE_OPTIONAL',
      'OPENCLAUDE_MASTER_BASELINE_BASE_URL',
    ]) {
      assert.doesNotMatch(overrides, new RegExp(`^${key}=`, 'm'))
      assert.match(source, new RegExp(`REMOVE_KEYS=\\([\\s\\S]*?${key}`))
      assert.match(source, new RegExp(`FORBIDDEN_IN_OVERRIDES=\\([\\s\\S]*?${key}`))
    }
    assert.match(unitA, /OC_V3_CCB_BASELINE_DIR=\/opt\/openclaude\/openclaude-v5\/packages\/commercial\/agent-sandbox\/ccb-baseline/)
    assert.match(unitB, /OC_V3_CCB_BASELINE_DIR=\/opt\/openclaude\/openclaude-v5-b\/packages\/commercial\/agent-sandbox\/ccb-baseline/)
    assert.match(unitA, /^Requires=openclaude-v5-baseline-port-guard\.socket$/m)
    assert.match(unitB, /^Requires=openclaude-v5-baseline-port-guard\.socket$/m)
    assert.doesNotMatch(unitA, /^SocketBindDeny=/m)
    assert.doesNotMatch(unitB, /^SocketBindDeny=/m)
    assert.match(portGuardSocket, /^ListenStream=127\.0\.0\.1:18893$/m)
    assert.match(portGuardSocket, /^Service=openclaude-v5-baseline-port-guard\.service$/m)
    assert.match(portGuardService, /^ExecStart=\/usr\/lib\/systemd\/systemd-socket-proxyd .*baseline-port-disabled\.sock$/m)

    const transition = source.match(/prepare_live_baseline_safety\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.ok(transition.indexOf('install_v5_slot_units') < transition.indexOf('harden_release_baseline'))
    const bootstrap = source.match(/^bootstrap\(\) \{([\s\S]*?)\n\}/m)?.[1] ?? ''
    assert.ok(bootstrap.indexOf('install_v5_slot_units') < bootstrap.indexOf('harden_release_baseline "$REMOTE_SRC"'))
    assert.ok(bootstrap.indexOf('install_v5_slot_units') < bootstrap.indexOf('rsync -az --delete'))
    const migrate = source.match(/migrate_to_bluegreen\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.ok(migrate.indexOf('install_v5_slot_units') < migrate.indexOf('harden_release_baseline "$REMOTE_SRC"'))
    assert.ok(migrate.indexOf('install_v5_slot_units') < migrate.indexOf("systemctl stop '$V5_UNIT'"))
    const unitInstall = source.match(/install_v5_slot_units\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(unitInstall, /if ! systemctl is-active --quiet '\$V5_BASELINE_PORT_GUARD_SOCKET'; then[\s\S]*systemctl start '\$V5_BASELINE_PORT_GUARD_SOCKET'/)
    assert.doesNotMatch(unitInstall, /systemctl restart[^\n]*V5_BASELINE_PORT_GUARD_SOCKET/)
    assert.match(source, /assert_v5_baseline_port_guard/)
    assert.match(source, /probe\.bind\(\("0\.0\.0\.0", port\)\)/)
    assert.match(source, /RELEASE_GC_SCRIPT=.*v5-release-gc\.sh/)
    assert.match(source, /gc_rc" in[\s\S]*75\)[\s\S]*首个 rm 前安全跳过整轮删除/)

    const build = source.match(/build_release\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.ok(build.indexOf('harden_release_baseline "$staging"') > build.indexOf('vite build'))
    assert.ok(build.indexOf('harden_release_baseline "$staging"') < build.indexOf("'$staging/.complete'"))
    assert.match(source, /activate_release\(\)[\s\S]*?assert_release_baseline_security "\$reldir"/)
    assert.match(source, /activate_runtime_tuple\(\)[\s\S]*?assert_release_baseline_security "\$BUILT_RELEASE"/)
    assert.match(source, /rollback_runtime_tuple\(\)[\s\S]*?assert_release_baseline_security "\$master"/)
    assert.match(source, /canary\(\)[\s\S]*?assert_release_baseline_security "\$reldir"/)
    assert.match(source, /smoke\(\)[\s\S]*?assert_live_baseline_security_for_slot "\$baseline_slot"/)
    assert.match(source, /start_candidate_unit_and_wait\(\)[\s\S]*?assert_live_baseline_security_for_slot "\$cand"/)

    assert.match(indexSource, /if \(v3Deps && selfHostUuid && runtimeChannel !== "v5"\)/)
    assert.doesNotMatch(indexSource, /runtimeChannel === "v5" \? 18893/)
  })

  test('shared baseline env migration preserves the original on grep errors', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-baseline-env-')); dirs.push(dir)
    const bin = path.join(dir, 'bin'); await mkdir(bin)
    const envFile = path.join(dir, 'commercial-v5.env')
    const original = [
      'DATABASE_URL=postgres://fixture',
      'OC_V3_CCB_BASELINE_OPTIONAL=1',
      'PLATFORM_HMAC_SECRET=keep-me',
      '',
    ].join('\n')
    await writeFile(envFile, original)
    await writeFile(path.join(bin, 'grep'), [
      '#!/bin/bash',
      'if [[ "$1" == "-Ev" ]]; then',
      '  printf "DATABASE_URL=truncated\\n"',
      '  exit 2',
      'fi',
      'exec /usr/bin/grep "$@"',
    ].join('\n') + '\n')
    await chmod(path.join(bin, 'grep'), 0o755)
    const harness = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      `V5_ENV='${envFile}'`,
      'KL_HOST=fake-v5',
      'ssh() { shift; command "$@"; }',
      'strip_shared_baseline_env_keys',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', PATH: `${bin}:${process.env.PATH}` },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /failed to filter shared V5 env\(rc=2\)/)
    assert.equal(await readFile(envFile, 'utf8'), original)
  })

  test('shared baseline env migration removes forbidden keys with leading whitespace', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-baseline-env-space-')); dirs.push(dir)
    const envFile = path.join(dir, 'commercial-v5.env')
    await writeFile(envFile, [
      'DATABASE_URL=postgres://fixture',
      '  OC_V3_CCB_BASELINE_DIR=/untrusted/shared/path',
      '\tOC_V3_CCB_BASELINE_OPTIONAL=1',
      ' OPENCLAUDE_MASTER_BASELINE_BASE_URL=https://untrusted.invalid',
      'PLATFORM_HMAC_SECRET=keep-me',
      '',
    ].join('\n'))
    const harness = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      `V5_ENV='${envFile}'`,
      'KL_HOST=fake-v5',
      'ssh() { shift; command "$@"; }',
      'strip_shared_baseline_env_keys',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1' },
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(
      await readFile(envFile, 'utf8'),
      'DATABASE_URL=postgres://fixture\nPLATFORM_HMAC_SECRET=keep-me\n',
    )
  })

  test('18893 loopback reservation fails closed on inactive, ss/probe errors, or non-loopback listeners', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-baseline-ss-')); dirs.push(dir)
    const bin = path.join(dir, 'bin'); await mkdir(bin)
    const harness = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'DRY=0',
      'KL_HOST=fake-v5',
      'ssh() { shift; command "$@"; }',
      'assert_v5_baseline_port_guard',
    ].join('\n')
    const invoke = async (ssBody: string, pythonBody = 'exit 0', systemctlBody = 'exit 0') => {
      await writeFile(path.join(bin, 'ss'), `#!/bin/sh\n${ssBody}\n`)
      await writeFile(path.join(bin, 'python3'), `#!/bin/sh\ncat >/dev/null\n${pythonBody}\n`)
      await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh\n${systemctlBody}\n`)
      await chmod(path.join(bin, 'ss'), 0o755)
      await chmod(path.join(bin, 'python3'), 0o755)
      await chmod(path.join(bin, 'systemctl'), 0o755)
      return spawnSync('bash', ['-c', harness], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ALLOW_ANY_BRANCH: '1', PATH: `${bin}:${process.env.PATH}` },
      })
    }
    const inactive = await invoke('exit 0', 'exit 0', 'exit 3')
    assert.notEqual(inactive.status, 0)
    assert.match(inactive.stderr, /port guard is not active/)
    const failed = await invoke('exit 23')
    assert.notEqual(failed.status, 0)
    const listening = await invoke('printf "LISTEN 0 128 0.0.0.0:18893 0.0.0.0:*\\n"')
    assert.notEqual(listening.status, 0)
    assert.match(listening.stderr, /expected exactly one loopback/)
    const exact = 'printf "LISTEN 0 128 127.0.0.1:18893 0.0.0.0:*\\n"'
    const ineffective = await invoke(exact, 'exit 17')
    assert.notEqual(ineffective.status, 0)
    const guarded = await invoke(exact)
    assert.equal(guarded.status, 0, guarded.stderr || guarded.stdout)
  })

  test('release GC protects container baseline references and skips all deletion on inspect failure', async () => {
    const makeFixture = async (suffix: string) => {
      const dir = await mkdtemp(path.join(tmpdir(), `v5-release-gc-${suffix}-`)); dirs.push(dir)
      const releases = path.join(dir, 'releases'); await mkdir(releases)
      const releasePaths: string[] = []
      for (let index = 1; index <= 8; index += 1) {
        const release = path.join(releases, `rel-proof-${String(index).padStart(2, '0')}`)
        const baseline = path.join(release, 'packages/commercial/agent-sandbox/ccb-baseline')
        await mkdir(path.join(baseline, 'skills'), { recursive: true })
        await writeFile(path.join(baseline, 'AGENTS.md'), '# agents\n')
        await writeFile(path.join(baseline, 'CLAUDE.md'), '# claude\n')
        await writeFile(path.join(release, '.complete'), 'ok\n')
        const stamp = new Date(1_700_000_000_000 + index * 1_000)
        await utimes(release, stamp, stamp)
        releasePaths.push(release)
      }
      const srcA = path.join(dir, 'slot-a')
      const srcB = path.join(dir, 'slot-b')
      const egress = path.join(dir, 'egress')
      await symlink(releasePaths[7]!, srcA)
      await symlink(releasePaths[6]!, srcB)
      await symlink(releasePaths[7]!, egress)
      const prev = path.join(releases, '.prev-release')
      await writeFile(prev, `${releasePaths[5]}\n`)

      const inspect = path.join(dir, 'inspect.json')
      await writeFile(inspect, JSON.stringify([{
        Config: { Labels: {
          'com.openclaude.v3.managed': '1',
          'com.openclaude.runtime_channel': 'v5',
        } },
        Mounts: [
          { Type: 'bind', Source: path.join(releasePaths[0]!, 'packages/commercial/agent-sandbox/ccb-baseline/AGENTS.md'), Destination: '/opt/openclaude/AGENTS.md', RW: false },
          { Type: 'bind', Source: path.join(releasePaths[0]!, 'packages/commercial/agent-sandbox/ccb-baseline/CLAUDE.md'), Destination: '/run/oc/claude-config/CLAUDE.md', RW: false },
          { Type: 'bind', Source: path.join(releasePaths[0]!, 'packages/commercial/agent-sandbox/ccb-baseline/skills'), Destination: '/run/oc/claude-config/skills', RW: false },
        ],
      }]))
      const bin = path.join(dir, 'bin'); await mkdir(bin)
      const dockerLog = path.join(dir, 'docker.log')
      await writeFile(path.join(bin, 'systemctl'), [
        '#!/bin/sh',
        'if [ "$1" = show ]; then printf "0\\n"; exit 0; fi',
        'exit 1',
      ].join('\n') + '\n')
      await writeFile(path.join(bin, 'docker'), [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
        'if [ "$1" = ps ]; then printf "aaaaaaaaaaaa\\n"; exit 0; fi',
        'if [ "$1" = inspect ]; then',
        '  [ "${FAKE_INSPECT_FAIL:-0}" = 1 ] && exit 23',
        '  cat "$FAKE_INSPECT"; exit 0',
        'fi',
        'exit 99',
      ].join('\n') + '\n')
      await chmod(path.join(bin, 'systemctl'), 0o755)
      await chmod(path.join(bin, 'docker'), 0o755)
      const args = [
        releases, '2', srcA, srcB, egress, prev,
        'openclaude-v5.service', 'openclaude-v5-b.service', 'openclaude-v5-egress.service',
        '', '', '',
      ]
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_INSPECT: inspect,
        FAKE_DOCKER_LOG: dockerLog,
      }
      return { releases, releasePaths, args, env, dockerLog }
    }

    const protectedFixture = await makeFixture('protected')
    const protectedRun = spawnSync('bash', [releaseGc, ...protectedFixture.args], {
      cwd: root, encoding: 'utf8', env: protectedFixture.env,
    })
    assert.equal(protectedRun.status, 0, protectedRun.stderr || protectedRun.stdout)
    const survivors = (await readdir(protectedFixture.releases)).filter((name) => name.startsWith('rel-')).sort()
    assert.deepEqual(survivors, ['rel-proof-01', 'rel-proof-06', 'rel-proof-07', 'rel-proof-08'])
    const dockerLog = await readFile(protectedFixture.dockerLog, 'utf8')
    assert.match(dockerLog, /label=com\.openclaude\.v3\.managed=1/)
    assert.match(dockerLog, /label=com\.openclaude\.runtime_channel=v5/)

    const failedFixture = await makeFixture('inspect-fail')
    const before = (await readdir(failedFixture.releases)).filter((name) => name.startsWith('rel-')).sort()
    const failedRun = spawnSync('bash', [releaseGc, ...failedFixture.args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...failedFixture.env, FAKE_INSPECT_FAIL: '1' },
    })
    assert.equal(failedRun.status, 75)
    assert.match(failedRun.stderr, /SAFE-SKIP:.*cannot inspect/)
    const after = (await readdir(failedFixture.releases)).filter((name) => name.startsWith('rel-')).sort()
    assert.deepEqual(after, before)
  })

  test('ordinary deploy/dist/rollback dry-runs never require a cutover nonce', () => {
    for (const [mode, args] of [
      ['deploy', ['--dry-run']],
      ['dist', ['--dist', '--dry-run']],
      ['rollback', ['--rollback', '--dry-run']],
    ] as const) {
      const result = run(deploy, args)
      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.doesNotMatch(result.stdout + result.stderr, /缺 --cutover-nonce|manifest missing/)
      assert.match(result.stdout, new RegExp(`begin planned-maintenance schema=2 mode=${mode}`))
      assert.match(result.stdout, /end planned-maintenance schema=2 nonce=.*\(nonce-match\)/)
    }
  })

  test('ordinary deploy maintenance scope includes egress only for --egress', () => {
    const normal = run(deploy, ['--dry-run'])
    const egress = run(deploy, ['--dry-run', '--egress'])
    assert.equal(normal.status, 0, normal.stderr || normal.stdout)
    assert.equal(egress.status, 0, egress.stderr || egress.stdout)
    assert.doesNotMatch(normal.stdout, /checks=.*svc_egress/)
    assert.match(egress.stdout, /checks=svc_v5,http_v5,public_route,turn_failures,svc_egress,http_egress/)
  })

  test('production smoke allowlist covers every explicitly v5-owned leader scheduler', async () => {
    const [deploySource, indexSource] = await Promise.all([
      readFile(deploy, 'utf8'),
      readFile(commercialIndex, 'utf8'),
    ])
    const smokeBody = deploySource.match(/smoke\(\) \{([\s\S]*?)\n\}\n\n# ─+ bootstrap/)?.[1] ?? ''
    const allowed = new Set(
      [...smokeBody.matchAll(/allowed="([^"]*)"/g)]
        .flatMap((match) => match[1].split(/\s+/))
        .filter((name) => name !== '' && name !== '$allowed'),
    )
    const v5Owned = [...indexSource.matchAll(
      /leaderBundle\.add\(\{\s*\n\s*name:\s*["']([^"']+)["'],\s*\n\s*domain:\s*["']v5-owned["']/g,
    )].map((match) => match[1])

    assert.ok(v5Owned.includes('imageUsageSweep'))
    assert.ok(v5Owned.includes('githubWorkspaceSweeper'))
    assert.ok(v5Owned.includes('knowledgePlanetAutomation'))
    assert.deepEqual(v5Owned.filter((name) => !allowed.has(name)), [])
  })

  test('maintenance lifecycle uses one cleanup trap and locked schema+nonce clear', async () => {
    const source = await readFile(deploy, 'utf8')
    assert.equal((source.match(/trap cleanup_deploy_process EXIT/g) ?? []).length, 1)
    assert.doesNotMatch(source, /trap 'rm -f .*DEPLOY_LOCK.*holder.*' EXIT/)
    assert.match(source, /exec 9>"\$lock"; flock -x 9/)
    assert.match(source, /\.schema == 2 and \.nonce == \$nonce/)
    assert.match(source, /PLANNED_MAINTENANCE_ACTIVE=0/)
    const recovery = source.match(/recover_cutover\(\) \{([\s\S]*?)\n\}\n\nset_cutover_maintenance/)?.[1] ?? ''
    assert.match(recovery, /flock -x 8/)
    assert.match(recovery, /\.schema == 1 and \.nonce == \$nonce/)
    assert.equal((recovery.match(/rm -f "\$marker"/g) ?? []).length, 1)
    assert.match(source, /stale\/untrusted schema1 marker preserved; deployment continues fail-open/)
    assert.match(source, /safely cleared expired schema1 marker/)
  })

  test('requiredMigrations gate includes deploy_state and precedes every write dispatch', async () => {
    const metadata = JSON.parse(await readFile(path.join(root, 'deploy/v5/release-metadata.json'), 'utf8')) as {
      requiredMigrations: string[]
    }
    assert.ok(metadata.requiredMigrations.includes('0135_deploy_state'))
    assert.ok(metadata.requiredMigrations.includes('0153_marketplace_plugin_kernel'))
    assert.ok(metadata.requiredMigrations.includes('0168_knowledge_planet_automation'))
    const source = await readFile(deploy, 'utf8')
    const gateAt = source.indexOf('assert_repo_required_migrations || exit 1')
    const dispatchAt = source.indexOf('case "$MODE" in', gateAt)
    assert.ok(gateAt > 0 && dispatchAt > gateAt, '统一迁移门必须在模式 dispatch 前')
    assert.match(source, /activate_release\(\)[\s\S]*assert_release_required_migrations "\$reldir"/)
    assert.match(source, /rollback_runtime_tuple\(\)[\s\S]*assert_release_required_migrations "\$master"/)

    const dry = run(deploy, ['--dry-run'])
    assert.equal(dry.status, 0, dry.stderr || dry.stdout)
    const combined = dry.stdout + dry.stderr
    assert.ok(combined.indexOf('校验 requiredMigrations 已全部记录') < combined.indexOf('建 release'))
  })

  test('requiredMigrations remote failure stays fail-closed in production OR-list context', () => {
    const harness = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'ssh() { return 23; }',
      'assert_repo_required_migrations || exit 1',
      'printf "%s\\n" SIDE_EFFECT',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1' },
    })
    const combined = result.stdout + result.stderr
    assert.notEqual(result.status, 0)
    assert.match(combined, /requiredMigrations 远端校验失败/)
    assert.doesNotMatch(combined, /requiredMigrations 已应用/)
    assert.doesNotMatch(combined, /SIDE_EFFECT/)
  })

  test('0151 application-role privilege gate covers every runtime object before dispatch and smoke', async () => {
    const source = await readFile(deploy, 'utf8')
    const body = source.match(/assert_0151_runtime_privileges\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    for (const object of [
      'product_friction_events',
      'image_generation_attempts',
      'image_generation_attempts_id_seq',
      'canonicalize_legacy_codex_terminal_snapshot()',
      'oc_0151_canonicalize_billing_array(jsonb)',
      'canonicalize_legacy_lossless_tape_header()',
      'canonicalize_legacy_lossless_agent_group()',
      'reject_finalized_lossless_tape_part()',
      'capture_legacy_image_attempt_on_terminal()',
      'clear_github_workspace_on_session_delete()',
    ]) {
      assert.match(body, new RegExp(object.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    assert.equal((body.match(/has_table_privilege\(/g) ?? []).length, 8)
    assert.equal((body.match(/has_sequence_privilege\(/g) ?? []).length, 2)
    assert.doesNotMatch(body, /'SELECT,INSERT|SELECT,USAGE'/)
    assert.equal((body.match(/pg_get_userbyid\(/g) ?? []).length, 10)
    assert.match(body, /='openclaude'/)
    const sourceOnlyAt = source.indexOf('V5_DEPLOY_SOURCE_ONLY')
    const gateAt = source.indexOf('assert_0151_runtime_privileges || exit 1', sourceOnlyAt)
    const dispatchAt = source.indexOf('case "$MODE" in', gateAt)
    assert.ok(gateAt > sourceOnlyAt && dispatchAt > gateAt)
    assert.match(source, /bootstrap\(\) \{[\s\S]*assert_repo_required_migrations\n\s*assert_0151_runtime_privileges/)

    const smokeDryRun = run(deploy, ['--smoke', '--dry-run'])
    assert.equal(smokeDryRun.status, 0, smokeDryRun.stderr || smokeDryRun.stdout)
    assert.match(smokeDryRun.stdout, /校验 0151 runtime 对象 owner 与应用角色逐项权限/)
    assert.match(smokeDryRun.stdout, /\[dry-run\] \/healthz 深度健康/)
  })

  test('0151 privilege transport/query failure is fail-closed', () => {
    const harness = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'ssh() { cat >/dev/null; return 23; }',
      'assert_0151_runtime_privileges || exit 1',
      'printf "%s\\n" SIDE_EFFECT',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1' },
    })
    const combined = result.stdout + result.stderr
    assert.notEqual(result.status, 0)
    assert.match(combined, /0151 runtime ownership\/privileges 校验失败/)
    assert.doesNotMatch(combined, /SIDE_EFFECT/)
  })

  test('0151 privilege gate rejects a false capability result and accepts only complete true', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-0151-privileges-')); dirs.push(dir)
    const bin = path.join(dir, 'bin'); await mkdir(bin)
    const envFile = path.join(dir, 'commercial-v5.env')
    await writeFile(envFile, 'DATABASE_URL=postgres://unused/runtime\n')
    await writeFile(path.join(bin, 'psql'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_PSQL_READY"\n')
    await chmod(path.join(bin, 'psql'), 0o755)
    const harness = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      `V5_ENV='${envFile}'`,
      'KL_HOST=fake-v5',
      'ssh() { shift; command "$@"; }',
      'assert_0151_runtime_privileges || exit 1',
      'printf "%s\\n" SIDE_EFFECT',
    ].join('\n')
    const runReady = (ready: 'true' | 'false') => spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_ANY_BRANCH: '1',
        FAKE_PSQL_READY: ready,
        PATH: `${bin}:${process.env.PATH}`,
      },
    })
    const incomplete = runReady('false')
    assert.notEqual(incomplete.status, 0)
    assert.doesNotMatch(incomplete.stdout + incomplete.stderr, /SIDE_EFFECT/)
    const complete = runReady('true')
    assert.equal(complete.status, 0, complete.stderr || complete.stdout)
    assert.match(complete.stdout, /SIDE_EFFECT/)
  })

  test('finalize/abort verify the target before irreversible state changes', async () => {
    const source = await readFile(deploy, 'utf8')
    const finalizeBody = source.match(/finalize_run_steps\(\) \{([\s\S]*?)\n\}\n\n# ═+ lane: --abort/)?.[1] ?? ''
    const expectedAt = finalizeBody.indexOf('candidate release oc-build 权威')
    const smokeAt = finalizeBody.indexOf('提交 stable 前完整 smoke')
    const stopAt = finalizeBody.indexOf('systemctl stop $(slot_unit "$old")')
    const commitAt = finalizeBody.indexOf("active_slot='$cand', previous_active_release=active_release")
    assert.ok(expectedAt >= 0 && smokeAt > expectedAt, 'finalize 必须从 candidate release 建立 build 权威')
    assert.ok(stopAt > smokeAt && commitAt > smokeAt, '完整 smoke/版本握手必须早于 stop old 与 stable commit')
    assert.doesNotMatch(finalizeBody, /dist_handshake_smoke[^\n]*\|\| true/)
    assert.doesNotMatch(
      finalizeBody,
      /phase='aborting'[^\n]*desired_leader_slot/,
      'finalize 补偿必须先仅切 aborting，让 abort_continue 先回 Caddy 再收 desired',
    )

    const abortBody = source.match(/abort_continue\(\) \{([\s\S]*?)\n\}\n\n# ═+ --recover/)?.[1] ?? ''
    const abortSmokeAt = abortBody.indexOf('旧 slot($old)完整 smoke')
    const abortStopAt = abortBody.indexOf('systemctl stop $(slot_unit "$cand")')
    const abortCommitAt = abortBody.indexOf("phase='stable', candidate_slot=NULL")
    assert.ok(abortSmokeAt >= 0 && abortStopAt > abortSmokeAt && abortCommitAt > abortSmokeAt)
    assert.doesNotMatch(abortBody, /smoke[^\n]*\|\| echo/)

    const smokeBody = source.match(/smoke\(\) \{([\s\S]*?)\n\}\n\n# ─+ bootstrap/)?.[1] ?? ''
    assert.match(smokeBody, /\[\[ "\$leadership" == leader \]\]/)
  })

  test('dangerous offline mode fails closed without one-shot nonce', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-deploy-safety-')); dirs.push(dir)
    await writeFile(path.join(dir, 'ssh'), '#!/bin/sh\necho active\n')
    await chmod(path.join(dir, 'ssh'), 0o755)
    const result = run(deploy, ['--offline-recycle', '--dry-run'], {
      PATH: `${dir}:${process.env.PATH}`,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /缺 --cutover-nonce/)
    assert.doesNotMatch(result.stdout + result.stderr, /Docker v5 label 清理/)
  })

  test('target migration readiness is scoped to offline activation only', async () => {
    const source = await readFile(deploy, 'utf8')
    assert.match(source, /activate_staged_inner\(\)[\s\S]*assert_gpt56_migration_ready/)
    assert.match(source, /activate_staged_inner\(\)[\s\S]*install_cutover_target_image_env/)
    const deployBody = source.match(/deploy\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const distBody = source.match(/deploy_dist\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const rollbackBody = source.match(/rollback\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    for (const body of [deployBody, distBody, rollbackBody]) {
      assert.doesNotMatch(body, /assert_gpt56_migration_ready|cutover_transition/)
    }
  })

  // ── 模型权威:四面 capability 守卫(方案 §7 步 4/5,R3-B4 + R4-M2)──────────────
  //
  // 用 ssh stub 模拟 kl-mirror:preflight 的四面探测(DB/master/egress/容器 runtime)全部
  // 经 `ssh $KL_HOST <cmd>` 出口,故一个 stub 即可把"四面缺任一 → 拒绝开 flag"的矩阵实跑出来。
  // 锁走 OC_V5_DEPLOY_LOCK_FILE(hermetic,不抢真实部署锁)。
  async function maFixture(over: Record<string, string> = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-')); dirs.push(dir)
    const ssh = path.join(dir, 'ssh')
    // stub 收到的是 `ssh <host> <cmd...>`;按命令特征回放各面的探测结果。
    await writeFile(
      ssh,
      [
        '#!/bin/bash',
        'cmd="$*"',
        'stdin="$(cat)"',
        'if [[ "$stdin" == *"FROM deploy_state"* ]]; then',
        '  printf "%s\\n" "${MA_DS_ROW:-1|stable|A||/rel/a||A|A|0|salt|0||1|}"',
        '  exit 0',
        'fi',
        'case "$cmd" in',
        '  *schema_migrations*) printf "%s\\n" "${MA_DB_READY:-true}" ;;',
        "  *\"name='DATABASE_URL'\"*) printf \"%s\\\\n\" \"openclaude_app|${MA_APP_ROLE_READY:-true}\" ;;",
        "  *\"name='MODEL_CATALOG_ADMIN_DATABASE_URL'\"*) printf \"%s\\\\n\" \"openclaude_model_admin|${MA_ADMIN_ROLE_READY:-true}\" ;;",
        "  *\"name='MODEL_AUTHORITY_DEPLOY_DATABASE_URL'\"*) printf \"%s\\\\n\" \"openclaude_model_deploy|${MA_DEPLOY_ROLE_READY:-true}\" ;;",
        '  *"/healthz"*) printf "%s\\n" "{\\"ok\\":true,\\"runtime\\":{\\"capabilities\\":[${MA_MASTER_CAPS-\\"model_authority_v1\\"}]}}" ;;',
        '  *egress-health*) printf "%s\\n" "{\\"ok\\":true,\\"role\\":\\"egress\\",\\"capabilities\\":[${MA_EGRESS_CAPS-\\"model_authority_v1-egress\\"}]}" ;;',
        '  *OC_RUNTIME_RELEASE*) printf "%s\\n" "${MA_RT_RELEASE-/var/lib/openclaude-v5/runtime-releases/rel-abc}" ;;',
        '  *OC_RUNTIME_IMAGE_ID*) printf "%s\\n" "sha256:emb" ;;',
        '  *OC_MODEL_AUTHORITY_CUTOVER*) printf "%s\\n" "${MA_CUTOVER:-}" ;;',
        '  *OC_MODEL_AUTHORITY=*) printf "%s\\n" "${MA_FLAG:-}" ;;',
        '  *MANIFEST.json*) printf "%s\\n" "${MA_RT_CAPS-model_authority_v1}" ;;',
        '  *oc.runtime.features*) printf "%s\\n" "${MA_IMG_FEATURES-v3-sink model_authority_v1}" ;;',
        '  *) printf "\\n" ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    )
    await chmod(ssh, 0o755)
    return run(deploy, ['--model-authority-preflight'], {
      PATH: `${dir}:${process.env.PATH}`,
      OC_V5_DEPLOY_LOCK_FILE: path.join(dir, 'lock'),
      ...over,
    })
  }

  test('model-authority preflight passes only when all four faces declare capability', async () => {
    const green = await maFixture()
    assert.equal(green.status, 0, green.stdout + green.stderr)
    for (const line of ['✓ ① DB', '✓ ② master', '✓ ③ egress', '✓ ④ runtime']) {
      assert.ok(green.stdout.includes(line), `missing "${line}" in:\n${green.stdout}`)
    }

    // ① DB:catalog + guards 任一迁移/关键对象未就绪
    const noDb = await maFixture({ MA_DB_READY: 'false' })
    assert.notEqual(noDb.status, 0)
    assert.match(noDb.stdout + noDb.stderr, /① DB:.*0143_model_catalog.*0144_model_authority_guards/)

    // ① DB 还必须证明 app/admin/deploy 三个独立角色的最小权限边界。
    const badAppRole = await maFixture({ MA_APP_ROLE_READY: 'false' })
    assert.notEqual(badAppRole.status, 0)
    assert.match(badAppRole.stdout + badAppRole.stderr, /① DB:/)

    // ② master:旧版本不广播 capability
    const oldMaster = await maFixture({ MA_MASTER_CAPS: '' })
    assert.notEqual(oldMaster.status, 0)
    assert.match(oldMaster.stdout + oldMaster.stderr, /② master:\/healthz 未广播/)

    // ③ egress:旧进程无 epoch fence(deploy 默认不重启 egress —— 最易错配的一面,R4-m6)
    const oldEgress = await maFixture({ MA_EGRESS_CAPS: '' })
    assert.notEqual(oldEgress.status, 0)
    assert.match(oldEgress.stdout + oldEgress.stderr, /③ egress:未广播/)
    assert.match(oldEgress.stdout + oldEgress.stderr, /--egress/)

    // ④ 容器 runtime release 未声明
    const oldRelease = await maFixture({ MA_RT_CAPS: '' })
    assert.notEqual(oldRelease.status, 0)
    assert.match(oldRelease.stdout + oldRelease.stderr, /④ runtime release:.*未声明/)

    // ④ release 轴关闭时回落镜像 label:旧镜像(无 model_authority_v1 token)同样拒
    const oldImage = await maFixture({ MA_RT_RELEASE: '', MA_IMG_FEATURES: 'v3-sink' })
    assert.notEqual(oldImage.status, 0)
    assert.match(oldImage.stdout + oldImage.stderr, /④ runtime 镜像/)
  })

  test('step-5 compat floor is irreversible and guards every activation path', async () => {
    const source = await readFile(deploy, 'utf8')
    // 地板挂在**全部**激活/回滚路径:传统激活、hotcfg tuple、tuple 回滚、P3 candidate。
    for (const fn of ['activate_release', 'activate_runtime_tuple', 'rollback_runtime_tuple', 'canary']) {
      const body = source.match(new RegExp(`(?:^|\\n)${fn}\\(\\) \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
      assert.match(body, /assert_model_authority_floor/, `${fn} 未挂兼容地板`)
      assert.match(body, /assert_lossless_turn_tape_floor/, `${fn} 未挂 lossless tape 兼容地板`)
    }
    // marker 探测 fail-closed:psql 失败 → 按已置位处理(不确定即拒)
    const cutoverFn = source.match(/model_authority_cutover_done\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(cutoverFn, /fail-closed/)
    // 关 flag 在 cutover 后必须被拒(不可逆地板)
    const disableFn = source.match(/disable_model_authority\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(disableFn, /model_authority_cutover_done/)
    assert.match(disableFn, /兼容地板不可逆/)
  })

  test('lossless tape floor permits pre-cutover targets but rejects old readers/writers after first finalize', () => {
    function runFloor(dbResult: 'true' | 'false' | 'error', master = '1', runtime = '1') {
      const harness = [
        'set -u',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'DRY=0',
        'ssh() {',
        '  case "$*" in',
        '    *"record_storage_format"*) printf "%s\\n" false ;;',
        '    *"SELECT EXISTS (SELECT 1 FROM client_session_turn_tapes"*)',
        dbResult === 'error' ? '      return 23 ;;' : `      printf '%s\\n' '${dbResult}' ;;`,
        '    *".runtimeCapabilities"*) [[ "$FLOOR_RUNTIME" == 1 ]] && printf "capable\\n" || printf "incapable\\n" ;;',
        '    *".capabilities"*) [[ "$FLOOR_MASTER" == 1 ]] && printf "capable\\n" || printf "incapable\\n" ;;',
        '    *) return 97 ;;',
        '  esac',
        '}',
        'assert_lossless_turn_tape_floor /release/target',
      ].join('\n')
      return spawnSync('bash', ['-c', harness], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ALLOW_ANY_BRANCH: '1',
          FLOOR_MASTER: master,
          FLOOR_RUNTIME: runtime,
        },
      })
    }

    const beforeFirstTape = runFloor('false', '', '')
    assert.equal(beforeFirstTape.status, 0, beforeFirstTape.stderr || beforeFirstTape.stdout)
    const capable = runFloor('true')
    assert.equal(capable.status, 0, capable.stderr || capable.stdout)
    for (const rejected of [
      runFloor('true', '', '1'),
      runFloor('true', '1', ''),
      runFloor('error', '', ''),
    ]) {
      assert.notEqual(rejected.status, 0)
      assert.match(
        rejected.stdout + rejected.stderr,
        /目标 release (?:未同时声明 reader\/writer capability|的 lossless reader\/writer capability 状态不可核验)/,
      )
    }
  })

  test('lossless compensation arms on capability probe failure and never flips the old stack', async () => {
    const harness = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'DRY=0',
      'KL_HOST=fake',
      'ACTIVE_SRC=/fixture/active',
      'ACTIVE_SLOT=A',
      'ACTIVE_UNIT=fixture.service',
      'ACTIVE_PORT=19999',
      'RELEASES_ROOT=/fixture/releases',
      'mark_deploy_recovery_required() { printf "RECOVERY:%s\\n" "$1"; }',
      'ssh() {',
      '  case "$*" in',
      '    *"record_storage_format"*) printf "%s\\n" false; return 0 ;;',
      '    *candidate*) return 23 ;;',
      '    *old*) printf "%s\\n" incapable; return 0 ;;',
      '    *) printf "MUTATION:%s\\n" "$*" >>"$MUTATION_LOG"; return 0 ;;',
      '  esac',
      '}',
      'restore_release_activation /release/old "" smoke-failed /release/candidate',
    ].join('\n')
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-lossless-probe-')); dirs.push(dir)
    const mutationLog = path.join(dir, 'mutations.log')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', MUTATION_LOG: mutationLog },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /RECOVERY:lossless writer 已可能对外服务/)
    assert.equal(spawnSync('bash', ['-c', `test ! -s '${mutationLog}'`]).status, 0,
      `old-stack mutation unexpectedly ran:\n${result.stdout}\n${result.stderr}`)
  })

  test('ordinary commit ACK loss checks compatibility before deploy_state compensation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-lossless-ack-loss-')); dirs.push(dir)
    const mutationLog = path.join(dir, 'mutations.log')
    const stateRevertMarker = path.join(dir, 'state-reverted')
    const activeTarget = path.join(dir, 'active-target')
    const recoveryLog = path.join(dir, 'recovery.log')
    const harness = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      "source '" + deploy + "'",
      'DRY=0',
      'KL_HOST=fake',
      'ACTIVE_SRC=/fixture/active',
      'ACTIVE_SLOT=B',
      'ACTIVE_UNIT=fixture.service',
      'ACTIVE_PORT=19999',
      'RELEASES_ROOT=/fixture/releases',
      'ACTIVE_STATE_LOCK_VERSION=7',
      'ACTIVE_STATE_RELEASE=/release/old',
      'ACTIVE_STATE_PREVIOUS_RELEASE=/release/older',
      'assert_release_required_migrations() { :; }',
      'assert_release_capability_for_sessions_pg() { :; }',
      'assert_lossless_turn_tape_floor() { :; }',
      'assert_model_authority_floor() { :; }',
      'bg_current_release() { printf "%s\\n" /release/old; }',
      'sync_assets_to_pool() { :; }',
      'run() { :; }',
      'smoke() { :; }',
      'mark_deploy_recovery_required() { printf "%s\\n" "$1" >>"$RECOVERY_LOG"; }',
      'probe_release_lossless_master_capability() {',
      '  case "$1" in',
      '    /release/candidate) return 0 ;;',
      '    /release/old) return 1 ;;',
      '    *) return 2 ;;',
      '  esac',
      '}',
      'ssh() {',
      '  case "$*" in',
      '    *"record_storage_format"*) printf "%s\\n" false; return 0 ;;',
      '    *"test -f"*"/release/candidate/.complete"*) return 0 ;;',
      '    *"ln -s"*"/release/candidate"*)',
      '      printf "%s\\n" candidate >"$ACTIVE_TARGET"',
      '      printf "%s\\n" CANDIDATE_FLIP >>"$MUTATION_LOG"',
      '      return 0 ;;',
      '    *"ln -s"*"/release/old"*)',
      '      printf "%s\\n" old >"$ACTIVE_TARGET"',
      '      printf "%s\\n" OLD_STACK_FLIP >>"$MUTATION_LOG"',
      '      return 0 ;;',
      '    *"systemctl restart"*) printf "%s\\n" RESTART >>"$MUTATION_LOG"; return 0 ;;',
      '    *) return 0 ;;',
      '  esac',
      '}',
      'ds_commit_active_release() { printf "%s\\n" COMMIT_ACK_LOST; return 1; }',
      'ds_stable_release_status_sql() { printf "%s\\n" STATUS; }',
      'ds_exec() {',
      '  if [[ -f "$STATE_REVERT_MARKER" ]]; then printf "%s\\n" reverted; else printf "%s\\n" applied; fi',
      '}',
      'ds_stable_release_revert() {',
      '  printf "%s\\n" STATE_REVERTED >>"$MUTATION_LOG"',
      '  : >"$STATE_REVERT_MARKER"',
      '}',
      'activate_release /release/candidate || true',
      'printf "ACTIVE:%s\\n" "$(cat "$ACTIVE_TARGET")"',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_ANY_BRANCH: '1',
        MUTATION_LOG: mutationLog,
        STATE_REVERT_MARKER: stateRevertMarker,
        ACTIVE_TARGET: activeTarget,
        RECOVERY_LOG: recoveryLog,
      },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /COMMIT_ACK_LOST/)
    assert.match(result.stdout, /ACTIVE:candidate/)
    assert.match(await readFile(recoveryLog, 'utf8'), /禁止自动回切旧 master/)
    assert.doesNotMatch(await readFile(mutationLog, 'utf8'), /STATE_REVERTED|OLD_STACK_FLIP/)
    assert.equal(await readFile(activeTarget, 'utf8'), 'candidate\n')
    assert.equal(await readFile(stateRevertMarker, 'utf8').catch(() => ''), '')
  })

  test('lossless artifact probe treats a scalar capability field as unknown', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-lossless-metadata-')); dirs.push(dir)
    const metadataDir = path.join(dir, 'deploy/v5')
    await mkdir(metadataDir, { recursive: true })
    const metadata = path.join(metadataDir, 'release-metadata.json')
    const harness = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      "source '" + deploy + "'",
      'KL_HOST=fake',
      'ssh() { shift; bash -c "$1"; }',
      'rc=0; probe_release_lossless_master_capability "$RELEASE" || rc=$?',
      'printf "RC:%s\\n" "$rc"',
    ].join('\n')
    const invoke = () => spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', RELEASE: dir },
    })

    await writeFile(metadata, JSON.stringify({ capabilities: ['lossless-turn-tape-v2'] }))
    assert.match(invoke().stdout, /RC:0/)
    await writeFile(metadata, JSON.stringify({ capabilities: [] }))
    assert.match(invoke().stdout, /RC:1/)
    await writeFile(metadata, JSON.stringify({ capabilities: 'lossless-turn-tape-v2' }))
    assert.match(invoke().stdout, /RC:2/)
  })

  test('runtime-event batch format has a distinct master capability and durable rollback floor', async () => {
    const invoke = (floor: 'true' | 'false' | 'error', capability: 'capable' | 'incapable') => {
      const harness = [
        'set -u',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'DRY=0',
        'ssh() {',
        '  case "$*" in',
        '    *"record_storage_format"*)',
        floor === 'error' ? '      return 23 ;;' : `      printf '%s\\n' '${floor}' ;;`,
        `    *"lossless-turn-runtime-batch-v1"*) printf '%s\\n' '${capability}' ;;`,
        '    *) return 97 ;;',
        '  esac',
        '}',
        'assert_lossless_runtime_batch_floor /release/target',
      ].join('\n')
      return spawnSync('bash', ['-c', harness], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ALLOW_ANY_BRANCH: '1' },
      })
    }

    assert.equal(invoke('false', 'incapable').status, 0, 'default-off rollout must retain old-reader rollback')
    assert.equal(invoke('true', 'capable').status, 0)
    assert.notEqual(invoke('true', 'incapable').status, 0)
    assert.notEqual(invoke('error', 'incapable').status, 0, 'unknown DB state must fail closed')

    const source = await readFile(deploy, 'utf8')
    const start = source.indexOf('enable_runtime_tape_batching()')
    const end = source.indexOf('\n# 自动回切', start)
    const enableBody = source.slice(start, end)
    const activeProof = enableBody.indexOf('assert_lossless_runtime_batch_capability "$active"')
    const rollbackProof = enableBody.indexOf('assert_lossless_runtime_batch_capability "$previous"')
    const flagWrite = enableBody.indexOf('remote_env_set "$LOSSLESS_RUNTIME_BATCH_ENV" 1')
    assert.ok(activeProof >= 0 && rollbackProof > activeProof && flagWrite > rollbackProof,
      'explicit opt-in must prove live and rollback readers before arming the writer')
  })

  test('runtime-event batch floor treats every unprovable database state as unknown', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-runtime-batch-floor-')); dirs.push(dir)
    const bin = path.join(dir, 'bin'); await mkdir(bin)
    const envOff = path.join(dir, 'off.env')
    const envSourceFailure = path.join(dir, 'source-failure.env')
    const envMissingDatabase = path.join(dir, 'missing-database.env')
    const envDatabase = path.join(dir, 'database.env')
    const missingEnv = path.join(dir, 'missing.env')
    await writeFile(envOff, 'unset LOSSLESS_TURN_TAPE_RUNTIME_BATCHING\nexport DATABASE_URL=fake\n')
    await writeFile(envSourceFailure, 'return 1\n')
    await writeFile(envMissingDatabase, 'unset LOSSLESS_TURN_TAPE_RUNTIME_BATCHING DATABASE_URL\n')
    await writeFile(envDatabase, 'unset LOSSLESS_TURN_TAPE_RUNTIME_BATCHING\nexport DATABASE_URL=fake\n')
    await writeFile(path.join(bin, 'psql'), [
      '#!/bin/sh',
      'case "$FAKE_PSQL_MODE" in',
      '  false) printf "%s\\n" false ;;',
      '  missing-column) exit 3 ;;',
      '  failure) exit 9 ;;',
      '  *) exit 10 ;;',
      'esac',
    ].join('\n') + '\n')
    await chmod(path.join(bin, 'psql'), 0o755)

    const invokeDeployProbe = (envFile: string, psqlMode: string) => {
      const harness = [
        'set -u',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'KL_HOST=fake',
        `V5_ENV='${envFile}'`,
        'unset DATABASE_URL LOSSLESS_TURN_TAPE_RUNTIME_BATCHING',
        'ssh() { shift; bash -c "$1"; }',
        'rc=0; probe_lossless_runtime_batch_floor || rc=$?',
        'printf "RC:%s\\n" "$rc"',
      ].join('\n')
      return spawnSync('bash', ['-c', harness], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ALLOW_ANY_BRANCH: '1',
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_PSQL_MODE: psqlMode,
        },
      })
    }

    const runtimeLib = path.join(root, 'scripts/v5-runtime-release-lib.sh')
    const invokeHotcfgProbe = (envFile: string, psqlMode: string) => {
      const harness = [
        'set -u',
        `source '${runtimeLib}'`,
        'unset DATABASE_URL LOSSLESS_TURN_TAPE_RUNTIME_BATCHING',
        `rc=0; oc_hotcfg_probe_runtime_batch_floor '${envFile}' || rc=$?`,
        'printf "RC:%s\\n" "$rc"',
      ].join('\n')
      return spawnSync('bash', ['-c', harness], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_PSQL_MODE: psqlMode,
        },
      })
    }

    const scenarios = [
      ['env file missing', missingEnv, 'false'],
      ['env source failed', envSourceFailure, 'false'],
      ['DATABASE_URL missing', envMissingDatabase, 'false'],
      ['migration/column missing', envDatabase, 'missing-column'],
      ['psql failed', envDatabase, 'failure'],
    ] as const
    for (const [label, envFile, psqlMode] of scenarios) {
      assert.match(invokeDeployProbe(envFile, psqlMode).stdout, /RC:2/, `deploy probe: ${label}`)
      assert.match(invokeHotcfgProbe(envFile, psqlMode).stdout, /RC:2/, `hotcfg probe: ${label}`)
    }
    assert.match(invokeDeployProbe(envOff, 'false').stdout, /RC:1/,
      'only a successful false query proves the floor inactive')
    assert.match(invokeHotcfgProbe(envOff, 'false').stdout, /RC:1/,
      'only a successful false query proves the hotcfg floor inactive')
  })

  test('explicit rollback uses the live capability, not a racy no-tape DB observation', () => {
    const invoke = (live: 'capable' | 'incapable' | 'probe-error', target: 'capable' | 'incapable') => {
      const harness = [
        'set -u',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'DRY=0',
        'KL_HOST=fake',
        'ssh() {',
        '  case "$*" in',
        '    *"record_storage_format"*) printf "%s\\n" false ;;',
        '    *"/release/live"*)',
        live === 'probe-error' ? '      return 23 ;;' : `      printf '%s\\n' '${live}';;`,
        '    *"/release/target"*) printf "%s\\n" "$TARGET_CAP" ;;',
        '    *"SELECT EXISTS"*) printf "RACY_DB_QUERY\\n" >&2; return 99 ;;',
        '    *) return 98 ;;',
        '  esac',
        '}',
        'assert_lossless_runtime_tuple_capability() { printf "RUNTIME_PROVED\\n"; }',
        'assert_lossless_explicit_rollback_target /release/live /release/target sha256:rt /runtime/release',
      ].join('\n')
      return spawnSync('bash', ['-c', harness], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ALLOW_ANY_BRANCH: '1', TARGET_CAP: target },
      })
    }

    const capableToOld = invoke('capable', 'incapable')
    assert.notEqual(capableToOld.status, 0)
    assert.doesNotMatch(capableToOld.stdout + capableToOld.stderr, /RACY_DB_QUERY/)
    const unknownToOld = invoke('probe-error', 'incapable')
    assert.notEqual(unknownToOld.status, 0)
    assert.match(unknownToOld.stdout + unknownToOld.stderr, /按可能正在写 v2 tape fail-closed/)
    const capableToCapable = invoke('capable', 'capable')
    assert.equal(capableToCapable.status, 0, capableToCapable.stderr || capableToCapable.stdout)
    assert.match(capableToCapable.stdout, /RUNTIME_PROVED/)
    const legacyToLegacy = invoke('incapable', 'incapable')
    assert.equal(legacyToLegacy.status, 0, legacyToLegacy.stderr || legacyToLegacy.stdout)
    assert.doesNotMatch(legacyToLegacy.stdout, /RUNTIME_PROVED/)
  })

  test('lossless floor covers canary first-write race, abort, and actual runtime tuples', async () => {
    const source = await readFile(deploy, 'utf8')
    const runtimeLib = await readFile(path.join(root, 'scripts/v5-runtime-release-lib.sh'), 'utf8')
    const canaryMatrix = source.slice(
      source.indexOf('capability_matrix_preflight()'),
      source.indexOf('\n# 同步某 release 的 dist/assets', source.indexOf('capability_matrix_preflight()')),
    )
    assert.match(canaryMatrix, /assert_lossless_canary_pair "\$active_rel" "\$candidate_rel"/)
    const abortBody = source.slice(
      source.indexOf('abort_continue()'),
      source.indexOf('\n# ═════════ --recover', source.indexOf('abort_continue()')),
    )
    assert.ok(
      abortBody.indexOf('assert_lossless_turn_tape_floor "$old_src"')
        < abortBody.indexOf('caddy_render_reload'),
      'abort must recheck the old reader before routing traffic back',
    )
    const rollbackBody = source.slice(
      source.indexOf('rollback_runtime_tuple()'),
      source.indexOf('\n# ═══════════════════════ P3', source.indexOf('rollback_runtime_tuple()')),
    )
    assert.match(rollbackBody, /assert_lossless_runtime_tuple_floor "\$image_id" "\$release"/)
    assert.match(runtimeLib, /oc_hotcfg_assert_tuple_viable\(\)[\s\S]*oc_hotcfg_assert_tuple_lossless_floor "\$image_id" "\$release"/)
    assert.match(runtimeLib, /oc_hotcfg_assert_master_runtime_batch_pair "\$env_file" "\$master_release" "\$prev_master_release"/)

    const compensationGuardStart = source.indexOf('assert_release_activation_compensation_compatible()')
    const compensationGuardBody = source.slice(
      compensationGuardStart,
      source.indexOf('\n# 仅供紧邻', compensationGuardStart),
    )
    assert.match(compensationGuardBody, /lossless_release_may_have_served "\$candidate_release"/)
    assert.match(compensationGuardBody, /assert_lossless_master_release_capability "\$old_release"/)
    assert.match(compensationGuardBody, /assert_lossless_runtime_tuple_capability "\$image_id" "\$runtime_release"/)

    const restoreStart = source.indexOf('restore_release_activation()')
    const restoreBody = source.slice(
      restoreStart,
      source.indexOf('\n# 状态提交回执', restoreStart),
    )
    const ordinaryGuardAt = restoreBody.indexOf(
      'assert_release_activation_compensation_compatible "$old_release" "$candidate_release"',
    )
    const ordinaryFlipAt = restoreBody.indexOf(
      'restore_release_runtime_after_compatibility_guard "$old_release"',
    )
    assert.ok(ordinaryGuardAt >= 0 && ordinaryGuardAt < ordinaryFlipAt,
      'ordinary compensation must prove the old stack before flipping its symlink')
    assert.match(source, /restore_release_activation "\$prev" "\$old_prev_file" "restart new failed" "\$reldir"/)

    const activateStart = source.indexOf('activate_release() {')
    const activateBody = source.slice(
      activateStart,
      source.indexOf('\n# 传统 deploy/rollback', activateStart),
    )
    const ackLossGuardAt = activateBody.indexOf(
      'assert_release_activation_compensation_compatible "$prev" "$reldir"',
    )
    const stateCompensationAt = activateBody.indexOf('restore_release_state_if_committed "$reldir"')
    assert.ok(ackLossGuardAt >= 0 && ackLossGuardAt < stateCompensationAt,
      'ordinary ACK-loss compensation must prove the old stack before reverting deploy_state')

    const sagaRollbackStart = runtimeLib.indexOf('_hotcfg_saga_rollback()')
    const sagaRollbackBody = runtimeLib.slice(
      sagaRollbackStart,
      runtimeLib.indexOf('\n  # 2) extra:', sagaRollbackStart),
    )
    const sagaGuardAt = sagaRollbackBody.indexOf('lossless_writer_may_have_served')
    const stateRevertAt = sagaRollbackBody.indexOf('if [ "$commit_state" = applied ]')
    assert.ok(sagaGuardAt >= 0 && sagaGuardAt < stateRevertAt,
      'hotcfg compensation must block an incapable old stack before state/runtime rollback')
    assert.match(sagaRollbackBody, /oc_hotcfg_assert_master_lossless_capability "\$prev_master_release"/)
    assert.match(sagaRollbackBody, /oc_hotcfg_assert_tuple_lossless_capability "\$old_image_id" "\$old_release"/)
    assert.doesNotMatch(sagaRollbackBody, /assert_tuple_lossless_floor/,
      'post-exposure rollback must be unconditional, not a racy DB floor probe')

    const ordinaryRollback = source.slice(
      source.indexOf('rollback()'),
      source.indexOf('\n# tuple 感知回滚', source.indexOf('rollback()')),
    )
    const ordinaryExplicitAt = ordinaryRollback.indexOf('assert_lossless_explicit_rollback_target')
    const ordinaryMaintenanceAt = ordinaryRollback.indexOf('begin_planned_maintenance rollback 0', ordinaryExplicitAt)
    assert.ok(ordinaryExplicitAt >= 0 && ordinaryMaintenanceAt > ordinaryExplicitAt,
      'ordinary explicit rollback must prove the target before maintenance/symlink mutation')
    assert.match(rollbackBody,
      /assert_lossless_explicit_rollback_target[\s\\]*\n?[\s\\]*"\$prev_src" "\$master" "\$image_id" "\$release"/)

    const dir = await mkdtemp(path.join(tmpdir(), 'v5-lossless-tuple-')); dirs.push(dir)
    const capable = path.join(dir, 'capable'); const old = path.join(dir, 'old')
    await mkdir(capable); await mkdir(old)
    await writeFile(path.join(capable, 'MANIFEST.json'), JSON.stringify({ capabilities: ['lossless-turn-tape-v2'] }))
    await writeFile(path.join(old, 'MANIFEST.json'), JSON.stringify({ capabilities: [] }))
    const invoke = (release: string) => spawnSync('bash', ['-c', [
      `source '${path.join(root, 'scripts/v5-runtime-release-lib.sh')}'`,
      `oc_hotcfg_assert_tuple_lossless_capability ignored '${release}'`,
    ].join('\n')], { cwd: root, encoding: 'utf8' })
    assert.equal(invoke(capable).status, 0)
    const rejected = invoke(old)
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /未声明 'lossless-turn-tape-v2'/)
  })

  test('model-authority operations pin the stable P3 active lane', async () => {
    const source = await readFile(deploy, 'utf8')
    const egressUnit = await readFile(path.join(root, 'deploy/v5/openclaude-v5-egress.service'), 'utf8')
    const preflight = source.match(/model_authority_preflight\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(preflight, /assert_no_rollout_in_progress/)
    assert.match(preflight, /ACTIVE_PORT/)
    assert.doesNotMatch(preflight, /\$\{?V5_PORT\}?/)

    const enable = source.match(/enable_model_authority\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const enableSeed = source.match(/enable_seed_authority_by_rev\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const disable = source.match(/disable_model_authority\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(enable, /systemctl restart '\$ACTIVE_UNIT'/)
    assert.match(enable, /smoke "\$ACTIVE_PORT"/)
    assert.match(enableSeed, /assert_no_rollout_in_progress/)
    assert.match(enableSeed, /systemctl restart '\$ACTIVE_UNIT'/)
    assert.doesNotMatch(enableSeed, /systemctl restart '\$V5_UNIT'/)
    assert.match(enableSeed, /cd '\$ACTIVE_SRC'/)
    assert.doesNotMatch(enableSeed, /cd '\$REMOTE_SRC'/)
    assert.match(enableSeed, /smoke "\$ACTIVE_PORT"/)
    assert.match(disable, /rollback_model_authority_before_cutover/)

    const activeB = await maFixture({
      MA_DS_ROW: '2|stable|B||/rel/b||B|B|0|salt|0||2|/rel/a',
    })
    assert.equal(activeB.status, 0, activeB.stdout + activeB.stderr)
    assert.match(activeB.stdout, /active lane:slot=B.*port=18795/)

    const rollout = await maFixture({
      MA_DS_ROW: '3|canary|A|B|/rel/a|/rel/b|A|A|10|salt|10|op|3|',
    })
    assert.notEqual(rollout.status, 0)
    assert.match(rollout.stdout + rollout.stderr, /cohort rollout\/候选状态未收敛/)

    // egress 是全局单实例：不得再永久从 slot A 工作目录启动。普通 --egress 必须把
    // 独立指针钉到本次 BUILT_RELEASE，并具备 cwd/capability 活体验证与旧 release 回切。
    assert.match(egressUnit, /^WorkingDirectory=\/opt\/openclaude\/openclaude-v5-egress$/m)
    assert.doesNotMatch(egressUnit, /^WorkingDirectory=\/opt\/openclaude\/openclaude-v5$/m)
    const egressStart = source.indexOf('egress_release_ready_once()')
    const deployStart = source.indexOf('\ndeploy()', egressStart)
    const egressActivate = source.slice(egressStart, deployStart)
    const deployEnd = source.indexOf('\n# ───────────────────────── offline recycle', deployStart)
    const deployBody = source.slice(deployStart, deployEnd)
    assert.ok(egressStart >= 0 && deployStart > egressStart)
    assert.match(egressActivate, /mv -T '\$tmplink' '\$V5_EGRESS_SRC'/)
    assert.match(egressActivate, /readlink -f .*\/proc\/.*pid.*\/cwd/)
    assert.match(egressActivate, /MODEL_AUTHORITY_EGRESS_CAP/)
    assert.match(egressActivate, /ln -s '\$prev' '\$tmplink'/)
    assert.match(egressActivate, /wait_for_egress_release_ready "\$reldir" "\$require_cap" 30/)
    assert.match(egressActivate, /wait_for_egress_release_ready "\$prev" 0 30/)
    assert.doesNotMatch(egressActivate, /run "sleep 3"/)
    assert.match(deployBody, /egress_prev_release=.*systemctl show -p MainPID/)
    assert.match(deployBody, /activate_egress_release "\$BUILT_RELEASE" "\$egress_prev_release"/)
    assert.doesNotMatch(deployBody, /systemctl restart openclaude-v5-egress/)
  })

  test('egress release readiness tolerates delayed startup and has a hard deadline', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-egress-ready-')); dirs.push(dir)
    const bin = path.join(dir, 'bin'); await mkdir(bin)
    const counter = path.join(dir, 'counter'); await writeFile(counter, '0')
    await writeFile(path.join(bin, 'ssh'), [
      '#!/bin/sh',
      'if [ "${SLOW_PROBE:-0}" = 1 ]; then sleep 3; exit 1; fi',
      'n=$(cat "$COUNTER"); n=$((n+1)); printf "%s" "$n" >"$COUNTER"',
      'state=active; pid=4321; cwd="$EXPECTED_RELEASE"',
      'health=\'{"ok":true,"role":"egress","capabilities":["model_authority_v1-egress"]}\'',
      'case "$n" in',
      '  1) state=activating; pid=0; cwd=""; health="" ;;',
      '  2) cwd=/release/wrong ;;',
      '  3) health=\'{"ok":true,"role":"egress","capabilities":[]}\' ;;',
      'esac',
      'printf "%s\\n%s\\n%s\\n" "$state" "$pid" "$cwd"',
      'printf "%s" "$health" | base64 -w0',
      'printf "\\n"',
    ].join('\n') + '\n')
    await chmod(path.join(bin, 'ssh'), 0o755)

    const delayed = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'sleep() { :; }',
      'wait_for_egress_release_ready "$EXPECTED_RELEASE" 1 5',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_ANY_BRANCH: '1',
        PATH: `${bin}:${process.env.PATH}`,
        COUNTER: counter,
        EXPECTED_RELEASE: '/release/new',
      },
    })
    assert.equal(delayed.status, 0, delayed.stderr || delayed.stdout)
    assert.equal(await readFile(counter, 'utf8'), '4')
    assert.match(delayed.stdout, /egress ready\(state=active pid=4321 cwd=\/release\/new\)/)

    const started = Date.now()
    const timedOut = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'wait_for_egress_release_ready /release/new 1 1',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_ANY_BRANCH: '1',
        PATH: `${bin}:${process.env.PATH}`,
        COUNTER: counter,
        EXPECTED_RELEASE: '/release/new',
        SLOW_PROBE: '1',
      },
    })
    const elapsed = Date.now() - started
    assert.notEqual(timedOut.status, 0)
    assert.ok(elapsed < 2500, `one-second egress deadline took ${elapsed}ms`)
    assert.match(timedOut.stderr, /last state=<empty> pid=<empty> cwd=<empty>/)
    assert.match(timedOut.stderr, /last egress health: <empty>/)
  })

  test('runtime release finalization propagates the full pinned capability list and rejects invalid metadata', async () => {
    async function runBuild(runtimeCapabilities: unknown) {
      const dir = await mkdtemp(path.join(tmpdir(), 'v5-runtime-caps-')); dirs.push(dir)
      const capture = path.join(dir, 'finalize.args')
      await writeFile(capture, '')
      const harness = [
        'set -euo pipefail',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'DRY=0',
        'git() {',
        '  case "$*" in',
        '    *"rev-parse HEAD"*) printf "%s\\n" pinned-commit ;;',
        '    *"show pinned-commit:deploy/v5/release-metadata.json"*) printf "%s\\n" "$PINNED_METADATA" ;;',
        '    *"archive --format=tar pinned-commit"*) : ;;',
        '    *) return 97 ;;',
        '  esac',
        '}',
        'hotcfg_ship_lib() { :; }',
        'ssh() {',
        '  case "$*" in',
        '    *"grep \'^OC_RUNTIME_IMAGE=\'"*) printf "%s\\n" runtime:test ;;',
        '    *"docker image inspect"*) printf "%s\\n" sha256:test ;;',
        '    *"grep \'^OC_RUNTIME_RELEASE=\'"*) printf "%s\\n" /runtime/prev ;;',
        '    *) cat >/dev/null || true ;;',
        '  esac',
        '}',
        'hotcfg_rmt() { printf "%s\\n" "$@" >"$CAPTURE"; printf "%s\\n" "$OC_HOTCFG_RELEASES_ROOT/rel-test"; }',
        'build_runtime_release',
      ].join('\n')
      const result = spawnSync('bash', ['-c', harness], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ALLOW_ANY_BRANCH: '1',
          CAPTURE: capture,
          PINNED_METADATA: JSON.stringify({ runtimeCapabilities }),
        },
      })
      return {
        result,
        args: (await readFile(capture, 'utf8')).trim().split('\n').filter(Boolean),
      }
    }

    const valid = await runBuild(['model_authority_v1', 'future.runtime-cap'])
    assert.equal(valid.result.status, 0, valid.result.stderr || valid.result.stdout)
    assert.equal(valid.args[0], 'oc_hotcfg_finalize_release')
    assert.equal(valid.args[5], 'model_authority_v1 future.runtime-cap')

    for (const invalid of [
      'model_authority_v1',
      ['model_authority_v1', 'model_authority_v1'],
      ['future.runtime-cap'],
      ['model_authority_v1', 'bad token'],
    ]) {
      const rejected = await runBuild(invalid)
      assert.notEqual(rejected.result.status, 0, rejected.result.stdout + rejected.result.stderr)
      assert.deepEqual(rejected.args, [], 'invalid metadata must fail before finalize')
      assert.match(rejected.result.stderr, /runtimeCapabilities 非法或缺/)
    }
  })

  test('release metadata declares authority plus lossless persistence capabilities', async () => {
    const meta = JSON.parse(await readFile(path.join(root, 'deploy/v5/release-metadata.json'), 'utf8'))
    const source = await readFile(deploy, 'utf8')
    const buildRuntimeStart = source.indexOf('build_runtime_release()')
    const buildRuntimeEnd = source.indexOf('\n# ── 3. activate_runtime_tuple', buildRuntimeStart)
    assert.ok(meta.requiredMigrations.includes('0143_model_catalog'))
    assert.ok(meta.requiredMigrations.includes('0144_model_authority_guards'))
    assert.ok(meta.capabilities.includes('model_authority_v1'))
    assert.ok(meta.capabilities.includes('model_authority_v1-egress'))
    assert.ok(meta.capabilities.includes('lossless-turn-tape-v2'))
    assert.ok(meta.capabilities.includes('lossless-turn-runtime-batch-v1'))
    assert.ok(meta.requiredMigrations.includes('0157_lossless_runtime_batches'))
    assert.ok(meta.requiredMigrations.includes('0164_admin_audit_model_admin_grant'))
    assert.ok(meta.requiredMigrations.includes('0166_prompt_queue'))
    assert.ok(meta.requiredMigrations.includes('0167_turn_waiver_receipts'))
    // 容器面单独一列:release MANIFEST 只声明容器实现的能力(digest 相同 ⇒ 声明相同)
    assert.deepEqual(meta.runtimeCapabilities, [
      'model_authority_v1',
      'lossless-turn-tape-v2',
      'durable-turn-dispatch-v1',
    ])
    assert.ok(meta.capabilities.includes('durable-turn-dispatch-v1'))
    assert.ok(meta.requiredMigrations.includes('0170_durable_turn_dispatch'))
    // scheduler 泄漏门白名单必须登记本批新 reconciler(漏登=部署 smoke 判泄漏→假回滚,20260718 实撞)
    assert.match(source, /allowed="\$allowed[^"]*\bturnDispatchReconciler\b[^"]*"/)
    assert.ok(buildRuntimeStart >= 0 && buildRuntimeEnd > buildRuntimeStart)
    assert.match(
      source.slice(buildRuntimeStart, buildRuntimeEnd),
      /oc_hotcfg_finalize_release "\$staging" "\$RUNTIME_IMAGE_ID" "\$full_sha" "\$\{prev:-\}" "\$runtime_caps"/,
    )
    // 既有 capability 不得被本批次挤掉(sessions 割接地板仍在)
    assert.ok(meta.capabilities.includes('sessions-store-pg-v1'))
  })

  test('model-authority readiness tolerates startup delay, rejects PID churn, and has a hard deadline', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-ready-')); dirs.push(dir)
    const bin = path.join(dir, 'bin'); await mkdir(bin)
    const counter = path.join(dir, 'counter'); await writeFile(counter, '0')
    await writeFile(path.join(bin, 'ssh'), [
      '#!/bin/sh',
      'if [ "${SLOW_PROBE:-0}" = 1 ]; then sleep 3; exit 1; fi',
      'n=$(cat "$COUNTER"); n=$((n+1)); printf "%s" "$n" >"$COUNTER"',
      'master_health=$(printf %s \'{"ok":true,"runtime":{"leadership":{"state":"leader"}},"sessionsDb":"ok"}\' | base64 -w0)',
      'egress_health=$(printf %s \'{"ok":true,"role":"egress","modelAuthority":{"enforced":true}}\' | base64 -w0)',
      'case "$PROBE_MODE" in',
      '  master-delayed)',
      '    if [ "$n" -eq 1 ]; then printf "activating\\n0\\n\\n\\n\\n\\nactivating\\n0\\n"',
      '    elif [ "$n" -eq 2 ]; then printf "active\\n4321\\n1\\n1\\n0\\n%s\\nactive\\n4322\\n" "$master_health"',
      '    else printf "active\\n4321\\n1\\n1\\n0\\n%s\\nactive\\n4321\\n" "$master_health"; fi ;;',
      '  master-churn) printf "active\\n4321\\n1\\n1\\n0\\n%s\\nactive\\n4322\\n" "$master_health" ;;',
      '  master-invalid) printf "inactive\\n0\\n1\\n1\\n0\\n%s\\ninactive\\n0\\n" "$master_health" ;;',
      '  egress-delayed)',
      '    if [ "$n" -eq 1 ]; then printf "activating\\n0\\n\\nactivating\\n0\\n"',
      '    elif [ "$n" -eq 2 ]; then printf "active\\n5321\\n%s\\nactive\\n5322\\n" "$egress_health"',
      '    else printf "active\\n5321\\n%s\\nactive\\n5321\\n" "$egress_health"; fi ;;',
      '  egress-churn) printf "active\\n5321\\n%s\\nactive\\n5322\\n" "$egress_health" ;;',
      '  egress-invalid) printf "inactive\\n0\\n%s\\ninactive\\n0\\n" "$egress_health" ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join('\n') + '\n')
    await chmod(path.join(bin, 'ssh'), 0o755)

    async function runProbe(body: string, mode: string, slow = false) {
      await writeFile(counter, '0')
      return spawnSync('bash', ['-c', [
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        body,
      ].join('\n')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ALLOW_ANY_BRANCH: '1',
          PATH: `${bin}:${process.env.PATH}`,
          KL_HOST: 'fake-v5',
          COUNTER: counter,
          PROBE_MODE: mode,
          SLOW_PROBE: slow ? '1' : '0',
        },
      })
    }

    const masterDelayed = await runProbe(
      'sleep() { :; }; wait_for_model_authority_master_ready openclaude-v5.service 1 1 - 5',
      'master-delayed',
    )
    assert.equal(masterDelayed.status, 0, masterDelayed.stderr || masterDelayed.stdout)
    assert.equal(await readFile(counter, 'utf8'), '3')
    assert.match(masterDelayed.stdout, /master ready\(pid=4321 authority=1 provision=1 seed=-\)/)

    for (const mode of ['master-churn', 'master-invalid']) {
      const rejected = await runProbe(
        'model_authority_master_ready_once openclaude-v5.service 1 1 - 2',
        mode,
      )
      assert.notEqual(rejected.status, 0, `${mode} must be rejected`)
    }

    const egressDelayed = await runProbe(
      'sleep() { :; }; wait_for_model_authority_egress_ready true 5',
      'egress-delayed',
    )
    assert.equal(egressDelayed.status, 0, egressDelayed.stderr || egressDelayed.stdout)
    assert.equal(await readFile(counter, 'utf8'), '3')
    assert.match(egressDelayed.stdout, /egress authority ready\(pid=5321 enforced=true\)/)

    for (const mode of ['egress-churn', 'egress-invalid']) {
      const rejected = await runProbe('model_authority_egress_ready_once true 2', mode)
      assert.notEqual(rejected.status, 0, `${mode} must be rejected`)
    }

    for (const [body, mode] of [
      ['wait_for_model_authority_master_ready openclaude-v5.service 1 1 - 1', 'master-delayed'],
      ['wait_for_model_authority_egress_ready true 1', 'egress-delayed'],
    ] as const) {
      const started = Date.now()
      const timedOut = await runProbe(body, mode, true)
      const elapsed = Date.now() - started
      assert.notEqual(timedOut.status, 0)
      assert.ok(elapsed < 2500, `one-second ${mode} deadline took ${elapsed}ms`)
    }
  })

  test('authority enable is fail-closed: egress enforces before master starts signing', async () => {
    const source = await readFile(deploy, 'utf8')
    const body = source.match(/enable_model_authority\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const egressRestart = body.indexOf("systemctl restart '$V5_EGRESS_UNIT'")
    const enforceProbe = body.indexOf('wait_for_model_authority_egress_ready true')
    const masterRestart = body.indexOf("systemctl restart '$ACTIVE_UNIT'")
    assert.ok(egressRestart >= 0, 'enable must restart egress')
    assert.ok(enforceProbe > egressRestart, 'enable must probe egress enforced=true after restart')
    assert.ok(masterRestart > enforceProbe, 'master may sign only after egress is enforcing')
  })

  test('authority enable readiness failures take the correct verified rollback path', async () => {
    async function enableHarness(failAt: 'egress-true' | 'master-ready') {
      const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-enable-')); dirs.push(dir)
      const log = path.join(dir, 'order.log')
      const body = [
        'set -u',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'ACTIVE_UNIT=openclaude-v5.service; ACTIVE_PORT=18790',
        'record() { printf "%s\\n" "$1" >>"$ORDER_LOG"; }',
        'model_authority_preflight() { record preflight; return 0; }',
        'install_model_authority_canary() { record canary; return 0; }',
        'remote_env_set() { record "env:$1=$2"; return 0; }',
        'ssh() { record "ssh:$*"; return 0; }',
        'wait_for_model_authority_egress_ready() { record "egress-ready:$1"; [[ ! ( "$FAIL_AT" == egress-true && "$1" == true ) ]]; }',
        'wait_for_model_authority_master_ready() { record "master-ready:$2/$3/$4"; [[ "$FAIL_AT" != master-ready ]]; }',
        'rollback_model_authority_before_cutover() { record "full-rollback:$1"; return 0; }',
        'model_authority_rollback_diagnostics() { record "diagnostic:$1"; }',
        'smoke() { record smoke; return 0; }',
        'start_model_authority_observation() { record observation; return 0; }',
        'enable_model_authority',
      ].join('\n')
      const result = spawnSync('bash', ['-c', body], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ALLOW_ANY_BRANCH: '1', KL_HOST: 'fake-v5', ORDER_LOG: log, FAIL_AT: failAt },
      })
      return { result, order: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean) }
    }

    const egressFailure = await enableHarness('egress-true')
    assert.notEqual(egressFailure.result.status, 0)
    assert.match(
      egressFailure.order.join('\n'),
      /openclaude-v5-egress[\s\S]*egress-ready:true[\s\S]*env:OC_MODEL_AUTHORITY=0[\s\S]*openclaude-v5-egress[\s\S]*egress-ready:false/,
    )
    assert.equal(egressFailure.order.some((line) => line.includes("restart 'openclaude-v5.service'")), false)

    const masterFailure = await enableHarness('master-ready')
    assert.notEqual(masterFailure.result.status, 0)
    assert.match(
      masterFailure.order.join('\n'),
      /egress-ready:true[\s\S]*restart 'openclaude-v5.service'[\s\S]*master-ready:1\/1\/-[\s\S]*full-rollback:post-enable master readiness failed/,
    )
    assert.doesNotMatch(masterFailure.order.join('\n'), /smoke|observation/)
  })

  test('model-authority evidence persistence survives real psql command tags and stays fail-closed without a canary', (t) => {
    const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
    const schema = `oc_ma_observation_${process.pid}_${Date.now()}`
    const bundleRev = 'abcdef123456'
    const bundlePath = `/var/lib/openclaude-v5/platform/bundles/${bundleRev}`
    const psql = (sql: string, searchPath = false) => spawnSync(
      'psql',
      [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...(searchPath ? { PGOPTIONS: `-c search_path=${schema}` } : {}),
        },
      },
    )

    const setup = psql(`
      CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.model_security_epoch (id BOOLEAN PRIMARY KEY, epoch BIGINT NOT NULL);
      CREATE TABLE ${schema}.model_visibility_grants (user_id BIGINT NOT NULL, model_id TEXT NOT NULL);
      CREATE TABLE ${schema}.usage_records (
        model TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        execution_revision TEXT,
        security_epoch BIGINT,
        authority_kind TEXT
      );
      CREATE TABLE ${schema}.request_finalize_journal (
        request_id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        state TEXT NOT NULL,
        ctx JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE ${schema}.model_catalog (entry_id BIGINT PRIMARY KEY, model_id TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE ${schema}.model_aliases (alias TEXT NOT NULL, entry_id BIGINT NOT NULL);
      CREATE TABLE ${schema}.model_runtime_requirements (model_id TEXT NOT NULL);
      CREATE TABLE ${schema}.model_pricing (model_id TEXT NOT NULL, enabled BOOLEAN NOT NULL);
      CREATE TABLE ${schema}.model_authority_deploy_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO ${schema}.model_security_epoch(id,epoch) VALUES (TRUE,3);
      INSERT INTO ${schema}.model_visibility_grants(user_id,model_id)
      VALUES (42,'oc-catalog-canary-glm52');
      INSERT INTO ${schema}.usage_records(authority_kind) VALUES ('bridge_signed'),('legacy');
    `)
    assert.equal(setup.status, 0, setup.stderr || setup.stdout)

    t.after(() => {
      const cleanup = psql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout)
    })

    const shellPrelude = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'model_authority_release_sha() { printf %s test-release-sha; }',
      `model_authority_runtime_tuple() { printf "%s\\n" '{"image":"test-image","image_id":"sha256:test","release":"/test/release","bundle":"${bundlePath}"}'; }`,
      'remote_model_authority_psql() {',
      '  PGOPTIONS="-c search_path=$TEST_SCHEMA" psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tAc "$1" 2>/dev/null | tr -d \'[:space:]\'',
      '}',
    ]
    const runShell = (body: string[]) => spawnSync('bash', ['-c', [...shellPrelude, ...body].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', TEST_DATABASE_URL: databaseUrl, TEST_SCHEMA: schema },
    })
    const runObservation = () => runShell(['start_model_authority_observation'])

    const success = runObservation()
    assert.equal(success.status, 0, success.stderr || success.stdout)
    assert.match(success.stdout, /observation 已开始/)

    const persisted = psql(
      "SELECT value::text FROM model_authority_deploy_state WHERE key='observation'",
      true,
    )
    assert.equal(persisted.status, 0, persisted.stderr || persisted.stdout)
    const observation = JSON.parse(persisted.stdout.trim()) as Record<string, unknown>
    assert.equal(observation.release_sha, 'test-release-sha')
    assert.equal(observation.security_epoch, '3')
    assert.equal(observation.canary_uid, '42')
    assert.equal(observation.request_baseline, '1')
    assert.deepEqual(observation.runtime_tuple, {
      image: 'test-image',
      image_id: 'sha256:test',
      release: '/test/release',
      bundle: bundlePath,
    })

    const addCanaryUsage = psql(`
      INSERT INTO usage_records(model,execution_revision,security_epoch,authority_kind)
      VALUES ('oc-catalog-canary-glm52','revision-canary',3,'bridge_signed')
    `, true)
    assert.equal(addCanaryUsage.status, 0, addCanaryUsage.stderr || addCanaryUsage.stdout)
    const status = runShell(['model_authority_observation_status'])
    assert.equal(status.status, 0, status.stderr || status.stdout)
    const statusJson = JSON.parse(status.stdout) as Record<string, unknown>
    assert.equal(statusJson.signed_requests, 1)
    assert.equal(statusJson.canary_requests, 1)

    const legacyUpdate = psql(`
      UPDATE model_authority_deploy_state SET value=value
      WHERE key='observation'
      RETURNING 'ok'
    `, true)
    assert.equal(legacyUpdate.status, 0, legacyUpdate.stderr || legacyUpdate.stdout)
    assert.equal(legacyUpdate.stdout.replace(/\s/g, ''), 'okUPDATE1')

    const seed = runShell([
      'OC_HOTCFG_PLATFORM_ROOT=/var/lib/openclaude-v5/platform',
      'ACTIVE_UNIT=openclaude-v5.service; ACTIVE_PORT=18790; ACTIVE_SRC=/test/release',
      'assert_no_rollout_in_progress() { return 0; }',
      `remote_env_get() { case "$1" in OC_PLATFORM_BUNDLE) printf "%s\\n" '${bundlePath}' ;; OC_SEED_AUTHORITY_BY_REV) printf 0 ;; *) printf "" ;; esac; }`,
      'remote_env_set() { return 0; }',
      'ssh() { return 0; }',
      `model_authority_fleet_census() { printf "%s\\n" '[{"id":"test-container","name":"oc-v5-test","status":"running","bundle_rev":"${bundleRev}"}]'; }`,
      'wait_for_model_authority_master_ready() { return 0; }',
      'smoke() { return 0; }',
      'enable_seed_authority_by_rev',
    ])
    assert.equal(seed.status, 0, seed.stderr || seed.stdout)
    assert.match(seed.stdout, /seed authority by rev 已开启并留证/)
    const persistedSeed = psql(
      "SELECT (value->'seed_census')::text FROM model_authority_deploy_state WHERE key='observation'",
      true,
    )
    assert.equal(persistedSeed.status, 0, persistedSeed.stderr || persistedSeed.stdout)
    const seedEvidence = JSON.parse(persistedSeed.stdout.trim()) as Record<string, unknown>
    assert.equal(seedEvidence.bundle_rev, bundleRev)
    assert.equal(seedEvidence.container_count, '1')
    assert.deepEqual(seedEvidence.fleet, [
      { id: 'test-container', name: 'oc-v5-test', status: 'running', bundle_rev: bundleRev },
    ])

    const currentTuple = JSON.stringify({
      image: 'test-image',
      image_id: 'sha256:test',
      release: '/test/release',
      bundle: bundlePath,
    })
    const emergencyTuple = JSON.stringify({
      image: 'test-emergency-image',
      image_id: 'sha256:emergency',
      release: '',
      bundle: bundlePath,
    })
    const emergency = runShell([
      'assert_no_rollout_in_progress() { return 0; }',
      `hotcfg_rmt() { case "$3" in 1|3) printf "%s\\n" '${currentTuple}' ;; 2) printf "%s\\n" '${emergencyTuple}' ;; *) return 1 ;; esac; }`,
      `ssh() { case "$*" in *OC_RUNTIME_EMERGENCY_TUPLE*) printf "%s\\n" '${emergencyTuple}' ;; *) return 0 ;; esac; }`,
      'record_model_authority_emergency_drill',
    ])
    assert.equal(emergency.status, 0, emergency.stderr || emergency.stdout)
    assert.match(emergency.stdout, /激活与原 tuple 恢复已由三条 committed history/)
    const persistedEmergency = psql(
      "SELECT (value->'emergency_drill')::text FROM model_authority_deploy_state WHERE key='observation'",
      true,
    )
    assert.equal(persistedEmergency.status, 0, persistedEmergency.stderr || persistedEmergency.stdout)
    const emergencyEvidence = JSON.parse(persistedEmergency.stdout.trim()) as Record<string, unknown>
    assert.equal(emergencyEvidence.activated_and_restored, true)
    assert.deepEqual(emergencyEvidence.emergency_tuple, JSON.parse(emergencyTuple))

    const prepareCutover = psql(`
      INSERT INTO usage_records(model,execution_revision,security_epoch,authority_kind)
      SELECT 'glm-5.2','revision-' || n,3,'bridge_signed' FROM generate_series(1,9) AS n;
      INSERT INTO model_catalog(entry_id,model_id,state)
      VALUES (1,'oc-catalog-canary-glm52','active');
      INSERT INTO model_aliases(alias,entry_id) VALUES ('oc-catalog-canary',1);
      UPDATE model_authority_deploy_state SET value=value || jsonb_build_object(
        'started_at',(NOW()-interval '901 seconds')::text
      ) WHERE key='observation';

      -- 这些行逐项模拟旧证据/畸形字段/错误绑定/reconciler 晚改 updated_at。
      -- 它们都不得满足“同一 canary lease 的早期请求 + 5min 后另一请求”。
      WITH t AS (
        SELECT floor(extract(epoch FROM NOW())*1000)::bigint-360000 AS issued,
               floor(extract(epoch FROM NOW())*1000)::bigint-1260000 AS pre_observation_issued
      )
      INSERT INTO request_finalize_journal(request_id,user_id,state,ctx,created_at,updated_at)
      SELECT * FROM (
        SELECT 'legacy-no-lease',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','legacy','securityEpoch','3'),
          NOW()-interval '6 minutes',NOW()
        FROM t
        UNION ALL SELECT 'malformed-early',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','bad-time','securityEpoch','3','authorityTurnId',repeat('a',32),'turnLeaseIssuedAtMs','not-a-number','turnLeaseVerifiedAtMs',issued+1000),
          NOW()-interval '6 minutes',NOW() FROM t
        UNION ALL SELECT 'malformed-late',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','bad-time','securityEpoch','3','authorityTurnId',repeat('a',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+301000),
          NOW()-interval '30 seconds',NOW() FROM t
        UNION ALL SELECT 'wrong-epoch-early',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','wrong-epoch','securityEpoch','4','authorityTurnId',repeat('b',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+1000),
          NOW()-interval '6 minutes',NOW() FROM t
        UNION ALL SELECT 'wrong-epoch-late',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','wrong-epoch','securityEpoch','4','authorityTurnId',repeat('b',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+301000),
          NOW()-interval '30 seconds',NOW() FROM t
        UNION ALL SELECT 'empty-revision-early',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','','securityEpoch','3','authorityTurnId',repeat('c',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+1000),
          NOW()-interval '6 minutes',NOW() FROM t
        UNION ALL SELECT 'empty-revision-late',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','','securityEpoch','3','authorityTurnId',repeat('c',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+301000),
          NOW()-interval '30 seconds',NOW() FROM t
        UNION ALL SELECT 'wrong-user-early',43,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','wrong-user','securityEpoch','3','authorityTurnId',repeat('d',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+1000),
          NOW()-interval '6 minutes',NOW() FROM t
        UNION ALL SELECT 'wrong-user-late',43,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','wrong-user','securityEpoch','3','authorityTurnId',repeat('d',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+301000),
          NOW()-interval '30 seconds',NOW() FROM t
        UNION ALL SELECT 'wrong-model-early',42,'committed',
          jsonb_build_object('model','glm-5.2','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','wrong-model','securityEpoch','3','authorityTurnId',repeat('e',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+1000),
          NOW()-interval '6 minutes',NOW() FROM t
        UNION ALL SELECT 'wrong-model-late',42,'committed',
          jsonb_build_object('model','glm-5.2','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','wrong-model','securityEpoch','3','authorityTurnId',repeat('e',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+301000),
          NOW()-interval '30 seconds',NOW() FROM t
        UNION ALL SELECT 'single-request-only',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','single','securityEpoch','3','authorityTurnId',repeat('f',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+301000),
          NOW()-interval '30 seconds',NOW() FROM t
        UNION ALL SELECT 'reconciler-early',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','reconciled','securityEpoch','3','authorityTurnId',repeat('1',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+1000),
          NOW()-interval '6 minutes',NOW() FROM t
        UNION ALL SELECT 'reconciler-late-update',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','reconciled','securityEpoch','3','authorityTurnId',repeat('1',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+2000),
          NOW()-interval '6 minutes',NOW() FROM t
        UNION ALL SELECT 'pre-observation-verified-early',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','pre-observation','securityEpoch','3','authorityTurnId',repeat('3',32),'turnLeaseIssuedAtMs',pre_observation_issued,'turnLeaseVerifiedAtMs',pre_observation_issued+1000),
          NOW()-interval '10 minutes',NOW() FROM t
        UNION ALL SELECT 'pre-observation-verified-late',42,'committed',
          jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','pre-observation','securityEpoch','3','authorityTurnId',repeat('3',32),'turnLeaseIssuedAtMs',pre_observation_issued,'turnLeaseVerifiedAtMs',pre_observation_issued+301000),
          NOW()-interval '10 minutes',NOW() FROM t
      ) AS rows(request_id,user_id,state,ctx,created_at,updated_at);
    `, true)
    assert.equal(prepareCutover.status, 0, prepareCutover.stderr || prepareCutover.stdout)

    const beforeLongEvidence = runShell(['model_authority_observation_status'])
    assert.equal(beforeLongEvidence.status, 0, beforeLongEvidence.stderr || beforeLongEvidence.stdout)
    assert.equal(JSON.parse(beforeLongEvidence.stdout).long_ccb_turns, 0)

    const cutoverBody = [
      'remote_env_get() { case "$1" in "$MODEL_AUTHORITY_FLAG_KEY"|OC_SEED_AUTHORITY_BY_REV) printf 1 ;; *) printf "" ;; esac; }',
      'model_authority_preflight() { return 0; }',
      `model_authority_fleet_census() { printf "%s\\n" '[{"id":"test-container","bundle_rev":"${bundleRev}"}]'; }`,
      'remote_model_authority_psql_script() {',
      '  PGOPTIONS="-c search_path=$TEST_SCHEMA" psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -q',
      '}',
      'remote_env_set() { return 0; }',
      'model_authority_cutover_done() { return 0; }',
      'model_authority_cutover',
    ]
    const missingLong = runShell(cutoverBody)
    assert.notEqual(missingLong.status, 0)
    assert.match(missingLong.stderr, /no committed multi-request CCB turn/)

    const addValidLongTurn = psql(`
      WITH t AS (SELECT floor(extract(epoch FROM NOW())*1000)::bigint-360000 AS issued)
      INSERT INTO request_finalize_journal(request_id,user_id,state,ctx,created_at,updated_at)
      SELECT 'valid-early',42,'committed',
        jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','valid-long','securityEpoch','3','authorityTurnId',repeat('2',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+1000),
        NOW()-interval '6 minutes',NOW() FROM t
      UNION ALL SELECT 'valid-late',42,'committed',
        jsonb_build_object('model','oc-catalog-canary-glm52','source','ccb_proxy','authorityKind','bridge_signed','executionRevision','valid-long','securityEpoch','3','authorityTurnId',repeat('2',32),'turnLeaseIssuedAtMs',issued,'turnLeaseVerifiedAtMs',issued+301000),
        NOW()-interval '30 seconds',NOW() FROM t
    `, true)
    assert.equal(addValidLongTurn.status, 0, addValidLongTurn.stderr || addValidLongTurn.stdout)
    const afterLongEvidence = runShell(['model_authority_observation_status'])
    assert.equal(afterLongEvidence.status, 0, afterLongEvidence.stderr || afterLongEvidence.stdout)
    assert.equal(JSON.parse(afterLongEvidence.stdout).long_ccb_turns, 1)

    const cutover = runShell(cutoverBody)
    assert.equal(cutover.status, 0, cutover.stderr || cutover.stdout)
    const cutoverMarker = psql(
      "SELECT value->>'release_sha' FROM model_authority_deploy_state WHERE key='cutover'",
      true,
    )
    assert.equal(cutoverMarker.status, 0, cutoverMarker.stderr || cutoverMarker.stdout)
    assert.equal(cutoverMarker.stdout.trim(), 'test-release-sha')

    const legacy = psql(`
      INSERT INTO model_authority_deploy_state(key,value)
      VALUES ('cutover','{}')
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value
      RETURNING 'ok'
    `, true)
    assert.equal(legacy.status, 0, legacy.stderr || legacy.stdout)
    assert.equal(legacy.stdout.replace(/\s/g, ''), 'okINSERT01')

    const removeGrant = psql('DELETE FROM model_visibility_grants', true)
    assert.equal(removeGrant.status, 0, removeGrant.stderr || removeGrant.stdout)
    const missingCanary = runObservation()
    assert.notEqual(missingCanary.status, 0)
    assert.match(missingCanary.stderr, /observation 未写入/)
    assert.doesNotMatch(missingCanary.stdout, /observation 已开始/)
  })

  async function modelAuthorityRollbackHarness(fail = '') {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-rollback-')); dirs.push(dir)
    const log = path.join(dir, 'order.log')
    const body = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'ACTIVE_SLOT=A; ACTIVE_UNIT=openclaude-v5.service; ACTIVE_PORT=18790; ACTIVE_SRC=/rel/a',
      'authority_flag=1',
      'record() { printf "%s\\n" "$1" >>"$ORDER_LOG"; }',
      'assert_no_rollout_in_progress() { record stable; return 0; }',
      'remote_env_get() { [[ "$1" == "$MODEL_AUTHORITY_FLAG_KEY" ]] && printf "%s\\n" "$authority_flag"; }',
      'remote_env_set() { record "env:$1=$2"; [[ "$FAIL_AT" != "env:$1=$2" ]] || return 1; [[ "$1" == "$MODEL_AUTHORITY_FLAG_KEY" ]] && authority_flag="$2"; return 0; }',
      'ssh() {',
      '  record "ssh:$*"',
      '  if [[ "$*" == *"restart \'$ACTIVE_UNIT\'"* && "$FAIL_AT" == master_first && "$(grep -c "restart \'$ACTIVE_UNIT\'" "$ORDER_LOG")" == 1 ]]; then return 1; fi',
      '  return 0',
      '}',
      'wait_for_model_authority_master_ready() { record "master-ready:$2/$3/$4"; [[ "$FAIL_AT" != "master-ready:$2/$3/$4" ]]; }',
      'run_model_authority_container_rollback() { record census; [[ "$FAIL_AT" != census ]]; }',
      'wait_for_model_authority_egress_ready() { record "egress-ready:$1"; [[ "$FAIL_AT" != "egress-ready:$1" ]]; }',
      'smoke() { record smoke; [[ "$FAIL_AT" != smoke ]]; }',
      'model_authority_rollback_diagnostics() { record "diagnostic:$1"; }',
      'rollback_model_authority_before_cutover test',
    ].join('\n')
    const result = spawnSync('bash', ['-c', body], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', KL_HOST: 'fake-v5', ORDER_LOG: log, FAIL_AT: fail },
    })
    return { result, order: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean) }
  }

  test('authority rollback behavior is provision-stop → census → master-first → egress, with full smoke', async () => {
    const { result, order } = await modelAuthorityRollbackHarness()
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const expected = [
      'stable',
      'env:OC_MODEL_AUTHORITY_PROVISION_REQUIRED=0',
      "ssh:fake-v5 systemctl restart 'openclaude-v5.service'",
      'master-ready:1/0/-',
      'census',
      'env:OC_MODEL_AUTHORITY=0',
      "ssh:fake-v5 systemctl restart 'openclaude-v5.service'",
      'master-ready:0/0/-',
      "ssh:fake-v5 systemctl restart 'openclaude-v5-egress.service'",
      'egress-ready:false',
      'smoke',
    ]
    assert.deepEqual(order, expected)
  })

  test('authority rollback short-circuits safely on env/master/census/smoke failures', async () => {
    const envFail = await modelAuthorityRollbackHarness('env:OC_MODEL_AUTHORITY=0')
    assert.notEqual(envFail.result.status, 0)
    const flagWrite = envFail.order.indexOf('env:OC_MODEL_AUTHORITY=0')
    assert.ok(flagWrite >= 0)
    assert.equal(envFail.order.slice(flagWrite + 1).some((v) => v.includes('restart')), false)

    const masterFail = await modelAuthorityRollbackHarness('master_first')
    assert.notEqual(masterFail.result.status, 0)
    assert.doesNotMatch(masterFail.order.join('\n'), /census|OC_MODEL_AUTHORITY=0|egress:false/)

    const masterReadinessFail = await modelAuthorityRollbackHarness('master-ready:1/0/-')
    assert.notEqual(masterReadinessFail.result.status, 0)
    assert.doesNotMatch(masterReadinessFail.order.join('\n'), /census|OC_MODEL_AUTHORITY=0|egress-ready:false/)

    const censusFail = await modelAuthorityRollbackHarness('census')
    assert.notEqual(censusFail.result.status, 0)
    assert.doesNotMatch(censusFail.order.join('\n'), /env:OC_MODEL_AUTHORITY=0|egress:false/)

    const smokeFail = await modelAuthorityRollbackHarness('smoke')
    assert.notEqual(smokeFail.result.status, 0)
    assert.match(smokeFail.order.join('\n'), /egress-ready:false[\s\S]*smoke[\s\S]*diagnostic:/)
  })

  test('authority rollback is resumable after flag0 when egress recovery previously failed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-resume-')); dirs.push(dir)
    const log = path.join(dir, 'order.log')
    const body = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'ACTIVE_SLOT=A; ACTIVE_UNIT=openclaude-v5.service; ACTIVE_PORT=18790; ACTIVE_SRC=/rel/a',
      'authority_flag=1; egress_fail=1',
      'record() { printf "%s\\n" "$1" >>"$ORDER_LOG"; }',
      'assert_no_rollout_in_progress() { return 0; }',
      'remote_env_get() { printf "%s\\n" "$authority_flag"; }',
      'remote_env_set() { record "env:$1=$2"; [[ "$1" == "$MODEL_AUTHORITY_FLAG_KEY" ]] && authority_flag="$2"; return 0; }',
      'ssh() { record "ssh:$*"; if [[ "$*" == *"restart \'$V5_EGRESS_UNIT\'"* && "$egress_fail" == 1 ]]; then return 1; fi; return 0; }',
      'wait_for_model_authority_master_ready() { record "master-ready:$2/$3/$4"; [[ "$authority_flag" == "$2" ]]; }',
      'run_model_authority_container_rollback() { record census; return 0; }',
      'wait_for_model_authority_egress_ready() { record "egress-ready:$1"; return 0; }',
      'smoke() { record smoke; return 0; }',
      'model_authority_rollback_diagnostics() { record "diagnostic:$1"; }',
      'rollback_model_authority_before_cutover first || true',
      'record retry',
      'egress_fail=0',
      'rollback_model_authority_before_cutover retry',
    ].join('\n')
    const result = spawnSync('bash', ['-c', body], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', KL_HOST: 'fake-v5', ORDER_LOG: log },
    })
    const order = (await readFile(log, 'utf8')).trim().split('\n')
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const retryAt = order.indexOf('retry')
    const retried = order.slice(retryAt + 1).join('\n')
    assert.match(retried, /master-ready:0\/0\/-[\s\S]*census[\s\S]*openclaude-v5-egress[\s\S]*egress-ready:false[\s\S]*smoke/)
    assert.doesNotMatch(retried, /master-ready:1\/0\/-/)
  })

  test('seed authority failures compensate commit-unknown writes and verify live seed=0', async () => {
    async function seedHarness(failAt: 'write-unknown' | 'seed-ready' | 'comp-ready' | 'evidence-read') {
      const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-seed-')); dirs.push(dir)
      const log = path.join(dir, 'order.log')
      const body = [
        'set -u',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'ACTIVE_UNIT=openclaude-v5.service; ACTIVE_PORT=18790; ACTIVE_SRC=/rel/a',
        'OC_HOTCFG_PLATFORM_ROOT=/platform; seed_state=0',
        'record() { printf "%s\\n" "$1" >>"$ORDER_LOG"; }',
        'assert_no_rollout_in_progress() { record stable; return 0; }',
        'remote_env_get() { case "$1" in OC_PLATFORM_BUNDLE) printf "%s\\n" /platform/bundles/aaaaaaaaaaaa ;; OC_SEED_AUTHORITY_BY_REV) printf "%s\\n" "$seed_state" ;; esac; }',
        'remote_env_set() { record "env:$1=$2"; if [[ "$1" == OC_SEED_AUTHORITY_BY_REV ]]; then seed_state="$2"; [[ ! ( "$FAIL_AT" == write-unknown && "$2" == 1 ) ]]; else return 0; fi; }',
        'ssh() { record "ssh:$*"; return 0; }',
        'model_authority_fleet_census() { printf "%s\\n" \'[{"id":"cid","name":"oc-v5-u1","status":"running","bundle_rev":"aaaaaaaaaaaa"}]\'; }',
        'wait_for_model_authority_master_ready() { record "master-ready:$2/$3/$4"; if [[ "$4" == 1 && ( "$FAIL_AT" == seed-ready || "$FAIL_AT" == comp-ready ) ]]; then return 1; fi; [[ ! ( "$4" == 0 && "$FAIL_AT" == comp-ready ) ]]; }',
        'smoke() { record smoke; return 0; }',
        'model_authority_release_sha() { record release-read; [[ "$FAIL_AT" != evidence-read ]] || return 1; printf %s release-sha; }',
        'model_authority_runtime_tuple() { record tuple-read; printf "%s\\n" \'{"image":"i","image_id":"id","release":"r","bundle":"b"}\'; }',
        'remote_model_authority_psql() { record psql; return 1; }',
        'enable_seed_authority_by_rev',
      ].join('\n')
      const result = spawnSync('bash', ['-c', body], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ALLOW_ANY_BRANCH: '1', KL_HOST: 'fake-v5', ORDER_LOG: log, FAIL_AT: failAt },
      })
      return {
        result,
        order: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean),
        output: result.stdout + result.stderr,
      }
    }

    const commitUnknown = await seedHarness('write-unknown')
    assert.notEqual(commitUnknown.result.status, 0)
    assert.match(
      commitUnknown.order.join('\n'),
      /env:OC_SEED_AUTHORITY_BY_REV=1[\s\S]*env:OC_SEED_AUTHORITY_BY_REV=0[\s\S]*restart 'openclaude-v5.service'[\s\S]*master-ready:1\/1\/0/,
    )
    assert.doesNotMatch(commitUnknown.order.join('\n'), /psql/)
    assert.match(commitUnknown.output, /seed authority 已验证回滚/)
    assert.doesNotMatch(commitUnknown.output, /seed authority by rev 已开启并留证/)

    const readinessFailure = await seedHarness('seed-ready')
    assert.notEqual(readinessFailure.result.status, 0)
    assert.match(
      readinessFailure.order.join('\n'),
      /master-ready:1\/1\/1[\s\S]*env:OC_SEED_AUTHORITY_BY_REV=0[\s\S]*restart 'openclaude-v5.service'[\s\S]*master-ready:1\/1\/0/,
    )
    assert.match(readinessFailure.output, /seed authority 已验证回滚/)

    const evidenceReadFailure = await seedHarness('evidence-read')
    assert.notEqual(evidenceReadFailure.result.status, 0)
    assert.match(
      evidenceReadFailure.order.join('\n'),
      /master-ready:1\/1\/1[\s\S]*smoke[\s\S]*release-read[\s\S]*env:OC_SEED_AUTHORITY_BY_REV=0[\s\S]*restart 'openclaude-v5.service'[\s\S]*master-ready:1\/1\/0/,
    )
    assert.match(evidenceReadFailure.output, /seed authority 已验证回滚/)
    assert.doesNotMatch(evidenceReadFailure.output, /seed authority by rev 已开启并留证/)

    const compensationFailure = await seedHarness('comp-ready')
    assert.notEqual(compensationFailure.result.status, 0)
    assert.match(compensationFailure.order.join('\n'), /master-ready:1\/1\/1[\s\S]*master-ready:1\/1\/0/)
    assert.doesNotMatch(compensationFailure.output, /seed authority 已验证回滚/)
    assert.doesNotMatch(compensationFailure.output, /seed authority by rev 已开启并留证/)
  })

  test('authority cutover is evidence-bound and linearized on observation + epoch locks', async () => {
    const source = await readFile(deploy, 'utf8')
    const proxySource = await readFile(anthropicProxy, 'utf8')
    const enableStart = source.indexOf('enable_model_authority()')
    const enableEnd = source.indexOf('disable_model_authority()', enableStart)
    const enableBody = source.slice(enableStart, enableEnd)
    assert.ok(enableBody.indexOf('install_model_authority_canary') < enableBody.indexOf('remote_env_set "$MODEL_AUTHORITY_FLAG_KEY" 1'))
    assert.ok(enableBody.indexOf('start_model_authority_observation') > enableBody.indexOf('smoke'))

    const cutoverStart = source.indexOf('model_authority_cutover()')
    const cutoverEnd = source.indexOf('activate_release()', cutoverStart)
    const cutoverBody = source.slice(cutoverStart, cutoverEnd)
    assert.match(cutoverBody, /MODEL_AUTHORITY_OBSERVATION_KEY[\s\S]*FOR UPDATE/)
    assert.match(cutoverBody, /model_security_epoch WHERE id FOR UPDATE/)
    assert.match(cutoverBody, /observation window shorter than.*MODEL_AUTHORITY_MIN_OBSERVE_SECONDS/)
    assert.match(cutoverBody, /signed request evidence.*MODEL_AUTHORITY_MIN_REQUESTS/)
    assert.match(cutoverBody, /catalog canary has no signed usage/)
    assert.match(cutoverBody, /turnLeaseIssuedAtMs/)
    assert.match(cutoverBody, /turnLeaseVerifiedAtMs/)
    assert.match(cutoverBody, /late\.request_id<>early\.request_id/)
    assert.match(cutoverBody, /user_id::text=v_obs->>'canary_uid'/)
    assert.match(cutoverBody, /ctx->>'model'=v_obs->>'canary_model'/)
    assert.match(cutoverBody, /emergency activate\/restore drill evidence missing/)
    assert.match(cutoverBody, /INSERT INTO model_authority_deploy_state\(key,value,description\)/)
    assert.match(proxySource, /authorityTurnId: gate\.authorityTurnId/)
    assert.match(proxySource, /turnLeaseIssuedAtMs: gate\.turnLeaseIssuedAtMs/)
    assert.match(proxySource, /turnLeaseVerifiedAtMs: gate\.turnLeaseVerifiedAtMs/)

    const censusStart = source.indexOf('enable_seed_authority_by_rev()')
    const censusEnd = source.indexOf('record_model_authority_emergency_drill()', censusStart)
    const censusBody = source.slice(censusStart, censusEnd)
    assert.match(censusBody, /docker ps -aq/)
    assert.match(censusBody, /fleet 含旧\/缺 bundle_rev 容器\(含 stopped\)/)
  })

  test('Caddy fallback is transport-error-only and installer dry-run is inert', async () => {
    const source = await readFile(caddy, 'utf8')
    assert.match(source, /handle_errors/)
    assert.match(source, /\{err\.status_code\} in \[502, 503, 504\]/)
    assert.match(source, /application error.*418/)
    assert.match(source, /websocket failure must be non-200/)
    assert.doesNotMatch(source, /@v5_upstream_unavailable status/)
    const result = run(caddy, ['--dry-run'])
    assert.equal(result.status, 0, result.stderr)
  })

  test('P3 Caddy port keeps the production render golden and validates boundaries', () => {
    const production = run(caddyApply, ['--render', '--dry-run'], { CADDY_HTTP_PORT: undefined })
    assert.equal(production.status, 0, production.stderr)
    assert.equal(
      createHash('sha256').update(production.stdout).digest('hex'),
      '60c9853f4b3bca511bf9f2cd6fad50dade596b99fb2f487f7dd0227919cc9d7b',
    )
    assert.doesNotMatch(production.stdout, /\tbind /)

    const staging = run(caddyApply, ['--render', '--dry-run'], { CADDY_HTTP_PORT: '18081' })
    assert.equal(staging.status, 0, staging.stderr)
    assert.match(staging.stdout, /http:\/\/claudeai\.chat:18081 \{\n\tbind 127\.0\.0\.1\n/)

    for (const port of ['1', '65535']) {
      const valid = run(caddyApply, ['--render', '--dry-run'], { CADDY_HTTP_PORT: port })
      assert.equal(valid.status, 0, `port=${port}: ${valid.stderr}`)
    }
    for (const port of ['0', '65536', '08', 'not-a-port']) {
      const invalid = run(caddyApply, ['--render', '--dry-run'], { CADDY_HTTP_PORT: port })
      assert.notEqual(invalid.status, 0, `port=${port} should fail`)
      assert.match(invalid.stderr, /CADDY_HTTP_PORT 必须是 1\.\.65535/)
    }
  })

  test('P3 Caddy verify and reload probes honor the configured port', async () => {
    const fixture = await caddyRemoteFixture()
    const canaryRow = '42|canary|A|B|/rel/a|/rel/b|A|A|0|salt|10||7|'

    const defaultVerify = run(caddyApply, ['--verify'], {
      ...fixture.env,
      CADDY_HTTP_PORT: undefined,
      FAKE_DS_ROW: canaryRow,
    })
    assert.equal(defaultVerify.status, 0, defaultVerify.stderr || defaultVerify.stdout)
    let log = await readFile(fixture.sshLog, 'utf8')
    assert.match(log, /http:\/\/127\.0\.0\.1:80\/healthz/)
    assert.doesNotMatch(log, /:18081\/healthz/)

    await writeFile(fixture.sshLog, '')
    const stagingVerify = run(caddyApply, ['--verify'], {
      ...fixture.env,
      CADDY_HTTP_PORT: '18081',
      FAKE_DS_ROW: canaryRow,
    })
    assert.equal(stagingVerify.status, 0, stagingVerify.stderr || stagingVerify.stdout)
    log = await readFile(fixture.sshLog, 'utf8')
    assert.equal((log.match(/http:\/\/127\.0\.0\.1:18081\/healthz/g) ?? []).length, 2)

    await writeFile(fixture.sshLog, '')
    const apply = run(caddyApply, ['--apply'], {
      ...fixture.env,
      CADDY_HTTP_PORT: '18081',
      FAKE_DS_ROW: '42|stable|A||/rel/a||A|A|0|salt|0||7|',
    })
    assert.equal(apply.status, 0, apply.stderr || apply.stdout)
    log = await readFile(fixture.sshLog, 'utf8')
    assert.match(log, /for i in .*http:\/\/127\.0\.0\.1:18081\/healthz/)
  })

  test('planned-maintenance public probe receives the same staging Caddy port', async () => {
    const fixture = await caddyRemoteFixture()
    const harness = [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'begin_planned_maintenance deploy 0',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
        ALLOW_ANY_BRANCH: '1',
        CADDY_HTTP_PORT: '18081',
      },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const args = await readFile(fixture.sshLog, 'utf8')
    const remoteBody = await readFile(fixture.sshStdinLog, 'utf8')
    assert.match(args, /\/var\/lib\/openclaude-v5\/cutovers 18081\n$/)
    assert.match(remoteBody, /http:\/\/127\.0\.0\.1:\$\{caddy_http_port\}\/healthz/)
  })

  test('candidate readiness predicate is fail-closed for every required field', () => {
    const check = (payload: string) => spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'candidate_health_ready "$PAYLOAD"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', PAYLOAD: payload },
    })
    const valid = '{"ok":true,"channel":"v5","leadership":{"state":"standby"},"vip":"released"}'
    assert.equal(check(valid).status, 0)
    for (const invalid of [
      '{"ok":false,"channel":"v5","leadership":{"state":"standby"},"vip":"released"}',
      '{"channel":"v5","leadership":{"state":"standby"},"vip":"released"}',
      '{"ok":true,"channel":"v3","leadership":{"state":"standby"},"vip":"released"}',
      '{"ok":true,"leadership":{"state":"standby"},"vip":"released"}',
      '{"ok":true,"channel":"v5","leadership":{"state":"leader"},"vip":"released"}',
      '{"ok":true,"channel":"v5","leadership":{},"vip":"released"}',
      '{"ok":true,"channel":"v5","leadership":{"state":"standby"},"vip":"owner"}',
      '{"ok":true,"channel":"v5","leadership":{"state":"standby"}}',
      '{not-json',
      '',
    ]) {
      assert.notEqual(check(invalid).status, 0, `payload must fail closed: ${invalid}`)
    }
  })

  test('candidate readiness polling supports delayed success and a hard wall-clock deadline', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-candidate-ready-')); dirs.push(dir)
    const counter = path.join(dir, 'counter'); await writeFile(counter, '0')
    const delayed = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'slot_priv_healthz() {',
      '  n=$(cat "$COUNTER"); n=$((n+1)); printf "%s" "$n" >"$COUNTER"',
      '  if [ "$n" -lt 3 ]; then echo \'{"ok":true,"channel":"v5","leadership":{"state":"acquiring"},"vip":"released"}\';',
      '  else echo \'{"ok":true,"channel":"v5","leadership":{"state":"standby"},"vip":"released"}\'; fi',
      '}',
      'sleep() { :; }',
      'wait_for_candidate_ready B 5',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', COUNTER: counter },
    })
    assert.equal(delayed.status, 0, delayed.stderr || delayed.stdout)
    assert.equal(await readFile(counter, 'utf8'), '3')
    assert.match(delayed.stdout, /candidate=B 已 standby\+VIP released/)

    const bin = path.join(dir, 'bin'); await mkdir(bin)
    await writeFile(path.join(bin, 'ssh'), '#!/bin/sh\nsleep 3\n')
    await chmod(path.join(bin, 'ssh'), 0o755)
    const started = Date.now()
    const transportTimedOut = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'wait_for_candidate_ready B 1',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', PATH: `${bin}:${process.env.PATH}` },
    })
    const elapsed = Date.now() - started
    assert.notEqual(transportTimedOut.status, 0)
    assert.ok(elapsed < 2500, `one-second deadline took ${elapsed}ms`)
    assert.match(transportTimedOut.stderr, /last private healthz: <empty>/)

    const diagnostic = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'slot_priv_healthz() { sleep 1; echo \'{"ok":false,"probe":"last-seen"}\'; }',
      'wait_for_candidate_ready B 1',
    ].join('\n')], { cwd: root, encoding: 'utf8', env: { ...process.env, ALLOW_ANY_BRANCH: '1' } })
    assert.notEqual(diagnostic.status, 0)
    assert.match(diagnostic.stderr, /last private healthz: .*last-seen/)
  })

  test('candidate readiness dry-run is immediate and canary failure retains pre-READY recovery', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-candidate-dry-')); dirs.push(dir)
    const touched = path.join(dir, 'touched')
    const started = Date.now()
    const dry = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'DRY=1',
      'slot_priv_healthz() { touch "$TOUCHED"; return 1; }',
      'wait_for_candidate_ready B 90',
      'test ! -e "$TOUCHED"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', TOUCHED: touched },
    })
    assert.equal(dry.status, 0, dry.stderr || dry.stdout)
    assert.ok(Date.now() - started < 1000)

    const recovery = path.join(dir, 'recovered')
    const failedStart = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'sshk() { :; }',
      'wait_for_candidate_ready() { return 1; }',
      'recover_canary_prep() { printf "%s" "$1" >"$RECOVERY"; }',
      'set +e; start_candidate_unit_and_wait B; rc=$?; set -e',
      'test "$rc" -ne 0',
      'test "$(cat "$RECOVERY")" = B',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', RECOVERY: recovery },
    })
    assert.equal(failedStart.status, 0, failedStart.stderr || failedStart.stdout)

    const startFailure = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'sshk() { return 42; }',
      'wait_for_candidate_ready() { touch "$WAITED"; return 0; }',
      'recover_canary_prep() { touch "$RECOVERED"; }',
      'set +e; start_candidate_unit_and_wait B; rc=$?; set -e',
      'test "$rc" -ne 0',
      'test ! -e "$WAITED"',
      'test ! -e "$RECOVERED"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_ANY_BRANCH: '1',
        WAITED: path.join(dir, 'waited'),
        RECOVERED: path.join(dir, 'recovered-after-start-failure'),
      },
    })
    assert.equal(startFailure.status, 0, startFailure.stderr || startFailure.stdout)

    const stopFailure = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'calls=0',
      'sshk() { calls=$((calls+1)); [ "$calls" -ne 2 ]; }',
      'wait_for_candidate_ready() { return 1; }',
      'ds_cas_or_die() { touch "$CASSED"; }',
      'set +e; start_candidate_unit_and_wait B; rc=$?; set -e',
      'test "$rc" -ne 0',
      'test "$calls" -eq 2',
      'test ! -e "$CASSED"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', CASSED: path.join(dir, 'cassed-after-stop-failure') },
    })
    assert.equal(stopFailure.status, 0, stopFailure.stderr || stopFailure.stdout)

    const dispatcherStopFailure = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'ds_snapshot() { DS_phase=canary; DS_transition_step=2; DS_candidate_slot=B; DS_active_slot=A; DS_operation_id=op; DS_lock_version=7; }',
      'recover_canary_prep() { return 42; }',
      'ds_cas_or_die() { touch "$CASSED"; }',
      'set +e; recover; rc=$?; set -e',
      'test "$rc" -ne 0',
      'test ! -e "$CASSED"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', CASSED: path.join(dir, 'dispatcher-cassed-after-stop-failure') },
    })
    assert.equal(dispatcherStopFailure.status, 0, dispatcherStopFailure.stderr || dispatcherStopFailure.stdout)

    const missingUnit = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'sshk() { eval "$*"; }',
      'systemctl() { touch "$SYSTEMCTL_CALLED"; return 42; }',
      'export -f systemctl',
      'ds_cas_or_die() { touch "$CASSED"; }',
      'recover_canary_prep B',
      'test ! -e "$SYSTEMCTL_CALLED"',
      'test -e "$CASSED"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_ANY_BRANCH: '1',
        SYSTEMCTL_CALLED: path.join(dir, 'systemctl-called-for-missing-unit'),
        CASSED: path.join(dir, 'cassed-for-missing-unit'),
      },
    })
    assert.equal(missingUnit.status, 0, missingUnit.stderr || missingUnit.stdout)

    const source = await readFile(deploy, 'utf8')
    const startBody = source.match(/start_candidate_unit_and_wait\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(startBody, /wait_for_candidate_ready "\$cand" 90/)
    assert.doesNotMatch(startBody, /run "sleep 4"/)
  })
})

interface MonitorFixtureOptions {
  markerMode?: number
  checkV3?: boolean
  marker?: Record<string, unknown>
  state?: Record<string, unknown>
  egressBad?: boolean
  conditions?: boolean
  schema1Manifest?: boolean
  deployState?: { phase: string; step: number; active: string; candidate?: string } | 'error'
  healthyHttpPorts?: number[]
}

function schema1Marker(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    host: spawnSync('hostname', ['-f'], { encoding: 'utf8' }).stdout.trim(),
    nonce: 'a'.repeat(32),
    deadline: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }
}

function schema2Marker(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    schema: 2,
    host: spawnSync('hostname', ['-f'], { encoding: 'utf8' }).stdout.trim(),
    nonce: 'b'.repeat(32),
    kind: 'deploy',
    mode: 'deploy',
    target_commit: 'd'.repeat(40),
    started_at: now,
    deadline: now + 180,
    checks: ['svc_v5', 'http_v5', 'public_route'],
    ...overrides,
  }
}

async function monitorFixture(options: MonitorFixtureOptions = {}) {
  const {
    markerMode = 0o600,
    checkV3 = false,
    marker = schema1Marker(),
    state = { checks: {} },
    egressBad = false,
    conditions = false,
    schema1Manifest = true,
    deployState = { phase: 'stable', step: 0, active: 'A' },
    healthyHttpPorts = [],
  } = options
  const dir = await mkdtemp(path.join(tmpdir(), 'v5-monitor-safety-')); dirs.push(dir)
  const bin = path.join(dir, 'bin'); await writeFile(path.join(dir, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 900 kB\n')
  await writeFile(path.join(dir, 'env'), 'OC_RUNTIME_IMAGE=test/runtime:v5\nDATABASE_URL=postgres://unused\n')
  await writeFile(path.join(dir, 'state'), JSON.stringify(state))
  await writeFile(path.join(dir, 'marker'), JSON.stringify(marker))
  await chmod(path.join(dir, 'marker'), markerMode)
  const cutoverRoot = path.join(dir, 'cutovers')
  if (marker.schema === 1 && schema1Manifest && typeof marker.nonce === 'string') {
    const bundle = path.join(cutoverRoot, marker.nonce)
    spawnSync('mkdir', ['-p', bundle])
    await chmod(cutoverRoot, 0o700)
    await chmod(bundle, 0o700)
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({
      schema: 1,
      host: marker.host,
      nonce: marker.nonce,
    }))
    await chmod(path.join(bundle, 'manifest.json'), 0o600)
  }
  await writeFile(path.join(dir, 'setup'), '')
  spawnSync('mkdir', ['-p', bin])
  const scripts: Record<string, string> = {
    systemctl: `#!/bin/sh\ncase "$2" in openclaude-v5${egressBad ? '|openclaude-v5-egress' : ''}) echo inactive; exit 3;; *) echo active;; esac\n`,
    curl: `#!/bin/sh
case "$*" in
  ${egressBad ? '' : '*18892*) echo \'{"ok":true,"role":"egress"}\';;'}
  ${healthyHttpPorts.map((port) => `*${port}*) echo '{"ok":true,"channel":"v5"}';;`).join('\n  ')}
  *) echo refused >&2; exit 7;;
esac
`,
    psql: deployState === 'error'
      ? '#!/bin/sh\necho database-down >&2; exit 2\n'
      : `#!/bin/sh
case "$*" in
  *"FROM deploy_state"*) printf '%s\\n' '${deployState.phase}|${deployState.step}|${deployState.active}|${deployState.candidate ?? ''}' ;;
  *) exit 0 ;;
esac
`,
    df: '#!/bin/sh\necho "Use%"; echo "10%"\n',
    docker: '#!/bin/sh\ncase "$1" in images) echo test/runtime:v5;; ps) :;; esac\n',
  }
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(path.join(bin, name), body); await chmod(path.join(bin, name), 0o755)
  }
  const result = run(monitor, ['--dry-run'], {
    PATH: `${bin}:${process.env.PATH}`,
    V5MON_ENV_FILE: path.join(dir, 'env'),
    V5MON_STATE_FILE: path.join(dir, 'state'),
    V5MON_LOG_FILE: path.join(dir, 'log'),
    V5MON_MEMINFO: path.join(dir, 'meminfo'),
    V5MON_MAINTENANCE_FILE: path.join(dir, 'marker'),
    V5MON_MAINTENANCE_LOCK: path.join(dir, 'maintenance.lock'),
    V5MON_CUTOVER_ROOT: cutoverRoot,
    V5MON_CHECK_V3: checkV3 ? '1' : '0',
    V5MON_CONDITIONS: conditions ? '1' : '0',
  })
  return result
}

describe('v5 monitor planned-maintenance scope', () => {
  test('monitor validates and consumes one marker snapshot under the shared lock', async () => {
    const source = await readFile(monitor, 'utf8')
    assert.match(source, /flock -n -s 7/)
    assert.match(source, /MARKER_JSON="\$\(cat "\$MAINTENANCE_FILE"/)
    assert.match(source, /<<<"\$MARKER_JSON"/)
    const markerSection = source.match(/MARKER_PRESENT=0([\s\S]*?)maintenance_suppresses\(\)/)?.[1] ?? ''
    assert.equal((markerSection.match(/cat "\$MAINTENANCE_FILE"/g) ?? []).length, 1)
  })

  test('valid marker suppresses only expected v5/public failures and v3 is off by default', async () => {
    const result = await monitorFixture()
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /PLANNED svc_v5/)
    assert.match(result.stdout, /PLANNED http_v5/)
    assert.match(result.stdout, /PLANNED public_route/)
    assert.doesNotMatch(result.stdout, /EVENT ❌ \*\*(svc_v5|http_v5|public_route)\*\*/)
    assert.doesNotMatch(result.stdout, /http_v3/)
  })

  test('invalid marker fails open and explicit v3 check is still available', async () => {
    const result = await monitorFixture({ checkV3: true, marker: schema1Marker({ schema: 3 }) })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /fail-open to normal alerts/)
    assert.match(result.stdout, /EVENT ❌ \*\*svc_v5\*\*/)
    assert.match(result.stdout, /EVENT ❌ \*\*http_v5\*\*/)
    assert.match(result.stdout, /EVENT ❌ \*\*public_route\*\*/)
    assert.match(result.stdout, /http_v3/)
  })

  test('schema1 without its trusted cutover manifest fails open', async () => {
    const result = await monitorFixture({ schema1Manifest: false })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /invalid\/expired maintenance marker; fail-open/)
    assert.match(result.stdout, /EVENT ❌ \*\*svc_v5\*\*/)
    assert.doesNotMatch(result.stdout, /PLANNED svc_v5/)
  })

  test('schema2 suppresses exactly its validated checks, including egress when requested', async () => {
    const masterOnly = await monitorFixture({ marker: schema2Marker() })
    assert.equal(masterOnly.status, 0, masterOnly.stderr)
    assert.match(masterOnly.stdout, /PLANNED svc_v5/)
    assert.match(masterOnly.stdout, /PLANNED http_v5/)
    assert.match(masterOnly.stdout, /PLANNED public_route/)

    const withEgress = await monitorFixture({
      egressBad: true,
      marker: schema2Marker({
        checks: ['svc_v5', 'http_v5', 'public_route', 'svc_egress', 'http_egress'],
      }),
    })
    assert.equal(withEgress.status, 0, withEgress.stderr)
    assert.match(withEgress.stdout, /PLANNED svc_egress/)
    assert.match(withEgress.stdout, /PLANNED http_egress/)
    assert.doesNotMatch(withEgress.stdout, /EVENT ❌ \*\*(svc_egress|http_egress)\*\*/)
  })

  test('schema2 invalid TTL, duplicate scope, or invalid mode fails open', async () => {
    const now = Math.floor(Date.now() / 1000)
    for (const marker of [
      schema2Marker({ started_at: now, deadline: now + 181 }),
      schema2Marker({ checks: ['svc_v5', 'svc_v5'] }),
      schema2Marker({ mode: 'offline-recycle' }),
    ]) {
      const result = await monitorFixture({ marker })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /invalid\/expired maintenance marker; fail-open/)
      assert.match(result.stdout, /EVENT ❌ \*\*svc_v5\*\*/)
    }
  })

  test('pre-existing bad state is never hidden by a valid deployment marker', async () => {
    const now = Math.floor(Date.now() / 1000)
    const result = await monitorFixture({
      marker: schema2Marker(),
      state: { checks: { svc_v5: { status: 'bad', since: now - 600, last_alert: 0 } } },
      conditions: true,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /PLANNED svc_v5/)
    assert.match(result.stdout, /EVENT ⏰ \*\*svc_v5\*\* 仍异常/)
    assert.match(result.stdout, /write_alert_condition\('ops\.monitor:svc_v5','probe',true/)
    const source = await readFile(monitor, 'utf8')
    assert.match(source, /maintenance_nonce:\$nonce/)
  })

  test('planned state becomes an immediate real alert after marker expiry', async () => {
    const now = Math.floor(Date.now() / 1000)
    const result = await monitorFixture({
      marker: schema2Marker({ started_at: now - 200, deadline: now - 20 }),
      state: {
        checks: {
          svc_v5: {
            status: 'planned',
            since: 0,
            last_alert: 0,
            maintenance_nonce: 'b'.repeat(32),
          },
        },
      },
      conditions: true,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /invalid\/expired maintenance marker; fail-open/)
    assert.match(result.stdout, /EVENT ❌ \*\*svc_v5\*\*/)
    assert.match(result.stdout, /write_alert_condition\('ops\.monitor:svc_v5','probe',true/)
  })
})

describe('v5 monitor deploy_state serving lanes', () => {
  test('stable follows active B instead of assuming A', async () => {
    const result = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'stable', step: 0, active: 'B' },
      healthyHttpPorts: [18795],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /svc_v5\s+ok\s+serving slot=B/)
    assert.match(result.stdout, /http_v5\s+ok\s+serving slot=B healthz 正常/)
    assert.match(result.stdout, /svc_candidate_v5\s+ok\s+candidate not-serving/)
  })

  test('canary READY monitors active and candidate independently', async () => {
    const result = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'canary', step: 10, active: 'A', candidate: 'B' },
      healthyHttpPorts: [18790],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /EVENT ❌ \*\*svc_v5\*\*/)
    assert.match(result.stdout, /EVENT ❌ \*\*http_candidate_v5\*\*/)
    assert.match(result.stdout, /serving candidate=B phase=canary step=10/)
  })

  test('canary preparation step below READY does not monitor candidate', async () => {
    const result = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'canary', step: 5, active: 'A', candidate: 'B' },
      healthyHttpPorts: [18790],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /svc_candidate_v5\s+ok\s+candidate not-serving\(phase=canary step=5/)
    assert.doesNotMatch(result.stdout, /serving candidate=B phase=canary step=5/)
  })

  test('finalizing step6 treats candidate as the generic sole serving lane', async () => {
    const result = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'finalizing', step: 6, active: 'A', candidate: 'B' },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /EVENT ❌ \*\*http_v5\*\* serving slot=B/)
    assert.match(result.stdout, /http_candidate_v5\s+ok\s+candidate not-serving/)
  })

  test('aborting monitors both until Caddy restore is recorded, then old active only', async () => {
    const before = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'aborting', step: 0, active: 'A', candidate: 'B' },
      healthyHttpPorts: [18790],
    })
    assert.match(before.stdout, /EVENT ❌ \*\*http_candidate_v5\*\*/)

    const after = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'aborting', step: 2, active: 'A', candidate: 'B' },
      healthyHttpPorts: [18790],
    })
    assert.doesNotMatch(after.stdout, /EVENT ❌ \*\*http_candidate_v5\*\*/)
    assert.match(after.stdout, /http_candidate_v5\s+ok\s+candidate not-serving/)
  })

  test('PG failure is fail-open alert and never guesses slot A', async () => {
    const result = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: 'error',
      conditions: true,
      state: {
        checks: {
          svc_v5: { status: 'ok', since: 0, last_alert: 0 },
          http_v5: { status: 'ok', since: 0, last_alert: 0 },
        },
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /EVENT ❌ \*\*deploy_state\*\* deploy_state 不可裁决:psql 失败/)
    assert.match(result.stdout, /svc_candidate_v5\s+ok\s+candidate not-serving\(state unavailable\)/)
    assert.doesNotMatch(result.stdout, /openclaude-v5 状态=/)
    assert.match(result.stdout, /write_alert_condition\('ops\.monitor:deploy_state','probe',true/)
    assert.doesNotMatch(result.stdout, /write_alert_condition\('ops\.monitor:(svc_v5|http_v5)'/)
  })
})

describe('v5 selfheal batch1b lock/lease hardening (F6/F7)', () => {
  test('remote mutation holder watches the kernel parent instead of orphaning sleep', async () => {
    const source = await readFile(deploy, 'utf8')
    const start = source.indexOf('remote_script="mkdir -p -m 700')
    const end = source.indexOf('\n  if [[ -n "${OC_V5_DEPLOY_LOCK_FD:-}"', start)
    assert.ok(start >= 0 && end > start, '未找到 production-mutation remote holder')
    const holder = source.slice(start, end)
    const parentCapture = holder.indexOf('lease_parent=\\"\\$PPID\\"')
    // C1:trap 现在同时清 fencing meta 再退出。
    const signalTrap = holder.indexOf("trap 'drop_meta; exit 0' HUP INT TERM")
    const firstKernelParent = holder.indexOf('/proc/\\$\\$/status')
    const leased = holder.indexOf('echo LEASED')
    const loop = holder.indexOf('while :; do', leased)
    assert.ok(parentCapture >= 0, 'remote holder 未快照 sshd session parent')
    assert.ok(signalTrap > parentCapture && signalTrap < leased, '退出 trap 必须在 LEASED 握手前安装')
    assert.ok(
      firstKernelParent > signalTrap && firstKernelParent < leased,
      'LEASED 前缺 /proc 实时 PPid 身份校验',
    )
    assert.ok(loop > leased, 'remote holder 缺握手后的 parent-watch 循环')
    assert.ok(
      holder.indexOf('/proc/\\$\\$/status', loop) > loop &&
        holder.indexOf('kill -0 \\"\\$lease_parent\\"', loop) > loop,
      'parent-watch 必须同时复核内核实时 PPid 与 parent 活性',
    )
    assert.doesNotMatch(holder, /exec sleep infinity/, '禁止 PID 1 收养的无限 sleep 继续持锁')
    // C1 硬 TTL + fencing 证据:meta 在 LEASED 前落盘,TTL 在 watch 循环里到点自 exit,
    // 每条退出路径都清自己的 meta。这几条一起消除"SIGKILL 部署→残活 ssh 焊死远端 lease 永不过期"。
    assert.ok(holder.indexOf('write_meta\necho LEASED') >= 0, 'fencing meta 必须在 LEASED 握手前写(write_meta 调用)')
    assert.ok(holder.indexOf('lease_ttl=') > parentCapture && holder.indexOf('lease_ttl=') < leased, 'remote holder 缺硬 TTL 变量 lease_ttl')
    assert.ok(
      holder.indexOf('-ge \\"\\$lease_ttl\\"', loop) > loop,
      'parent-watch 循环缺到点自释放的硬 TTL 检查',
    )
    assert.ok(holder.indexOf('drop_meta', loop) > loop, 'holder 退出路径必须清 fencing meta')
  })

  test('manual mutation wrapper holder watches its live sshd parent and isolates stdin', async () => {
    const source = await readFile(manualMutationLease, 'utf8')
    const start = source.indexOf('REMOTE_HOLDER="')
    const end = source.indexOf('\nssh "$KL_HOST" "$REMOTE_HOLDER"', start)
    assert.ok(start >= 0 && end > start, '未找到 manual production-mutation remote holder')
    const holder = source.slice(start, end)
    const signalTrap = holder.indexOf("trap 'exit 0' HUP INT TERM")
    const parentCapture = holder.indexOf('lease_parent=\\"\\$PPID\\"')
    const flock = holder.indexOf('flock -w 60 9')
    const firstKernelParent = holder.indexOf('/proc/\\$\\$/status')
    const leased = holder.indexOf('echo LEASED')
    const loop = holder.indexOf('while :; do', leased)
    assert.ok(signalTrap >= 0 && signalTrap < parentCapture, 'manual holder 须在等待 flock 前安装退出 trap')
    assert.ok(parentCapture > signalTrap && parentCapture < flock, '必须在可能阻塞的 flock 前快照 sshd parent')
    assert.ok(firstKernelParent > flock && firstKernelParent < leased, '取锁后、LEASED 前须读取内核实时 PPid')
    assert.ok(holder.indexOf('[ \\"\\$current_parent\\" = \\"\\$lease_parent\\" ]', firstKernelParent) < leased,
      'LEASED 前未校验取锁后的 PPid 仍是原 sshd parent')
    assert.ok(holder.indexOf('kill -0 \\"\\$lease_parent\\"', firstKernelParent) < leased, 'LEASED 前未校验 parent 活性')
    assert.ok(loop > leased, 'manual holder 缺 parent-watch 循环')
    assert.ok(holder.indexOf('/proc/\\$\\$/status', loop) > loop, '循环未重读实时 PPid')
    assert.ok(holder.indexOf('kill -0 \\"\\$lease_parent\\"', loop) > loop, '循环未复核 parent 活性')
    assert.doesNotMatch(holder, /exec sleep infinity/, 'manual holder 禁止 orphanable infinite sleep')
    assert.match(source, /ssh "\$KL_HOST" "\$REMOTE_HOLDER" <\/dev\/null/, '后台 ssh 必须隔离 stdin')
  })

  test('manual mutation wrapper normal cleanup releases a reparented remote holder', async () => {
    const fx = await manualLeaseFixture()
    const child = spawn('bash', [fx.wrapper, fx.command], { env: fx.env, stdio: 'ignore' })
    try {
      assert.equal(
        await waitUntilManualLease(() => readFile(fx.commandStarted).then(() => true).catch(() => false), 5_000),
        true,
        'wrapped command never started after LEASED',
      )
      assert.notEqual(spawnSync('flock', ['-n', fx.lock, 'true']).status, 0, 'manual holder never held flock')
      await writeFile(fx.commandRelease, '')
      assert.equal(await waitForChildExit(child, 5_000), true, 'manual wrapper did not exit after command')
      assert.equal(
        await waitUntilManualLease(() => spawnSync('flock', ['-n', fx.lock, 'true']).status === 0, 3_000),
        true,
        'normal cleanup left an orphaned manual holder',
      )
    } finally {
      child.kill('SIGKILL')
      await killManualLeaseFixtureProcesses(fx.sshPids, fx.remotePids)
    }
  })

  test('manual mutation wrapper disconnect while waiting for flock cannot leak after acquisition', async () => {
    const fx = await manualLeaseFixture()
    const blocker = spawn(
      'flock',
      [fx.lock, 'bash', '-c', ': >"$BLOCKER_STARTED"; while [ ! -e "$BLOCKER_RELEASE" ]; do sleep 0.05; done'],
      { env: fx.env, stdio: 'ignore' },
    )
    let child: ReturnType<typeof spawn> | undefined
    try {
      assert.equal(
        await waitUntilManualLease(() => readFile(fx.blockerStarted).then(() => true).catch(() => false), 5_000),
        true,
        'test blocker never acquired the mutation flock',
      )
      child = spawn('bash', [fx.wrapper, fx.command], { env: fx.env, stdio: 'ignore' })
      assert.equal(
        await waitUntilManualLease(() => readFile(fx.remotePids, 'utf8').then((raw) => raw.trim().length > 0).catch(() => false), 5_000),
        true,
        'remote holder never started waiting for flock',
      )
      child.kill('SIGTERM')
      assert.equal(await waitForChildExit(child, 5_000), true, 'interrupted manual wrapper did not exit')
      const remotePid = Number((await readFile(fx.remotePids, 'utf8')).trim().split(/\s+/).at(-1))
      const sshPid = Number((await readFile(fx.sshPids, 'utf8')).trim().split(/\s+/).at(-1))
      assert.equal(
        await waitUntilManualLease(async () => {
          const status = await readFile(`/proc/${remotePid}/status`, 'utf8').catch(() => '')
          const parent = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1])
          return parent > 0 && parent !== sshPid
        }, 3_000),
        true,
        'fake remote holder was not reparented after ssh disconnect',
      )
      await writeFile(fx.blockerRelease, '')
      assert.equal(await waitForChildExit(blocker, 5_000), true, 'test blocker did not release flock')
      assert.equal(
        await waitUntilManualLease(() => spawnSync('flock', ['-n', fx.lock, 'true']).status === 0, 3_000),
        true,
        'reparented pre-LEASED holder leaked flock after the blocker released it',
      )
    } finally {
      await writeFile(fx.blockerRelease, '').catch(() => undefined)
      blocker.kill('SIGKILL')
      child?.kill('SIGKILL')
      await killManualLeaseFixtureProcesses(fx.sshPids, fx.remotePids)
    }
  })

  test('reclaim-mutation-lease is read-only rescue: skips every write-fence and the global lease', async () => {
    const source = await readFile(deploy, 'utf8')
    // 子命令入口 + dispatch 存在
    assert.match(source, /--reclaim-mutation-lease\) MODE="reclaim-mutation-lease"/)
    assert.match(source, /reclaim-mutation-lease\) reclaim_production_mutation_lease/)
    // 陈旧裁决:kill -0 校验 holder + 超 TTL,二者任一为陈旧才清,否则 REFUSE
    const fn = source.slice(
      source.indexOf('reclaim_production_mutation_lease() {'),
      source.indexOf('\nrelease_production_mutation_lease() {'),
    )
    assert.ok(fn.length > 0, '未找到 reclaim_production_mutation_lease')
    assert.match(fn, /kill -0 "\$rpid"/)
    assert.match(fn, /REFUSE:holder-live/)
    assert.match(fn, /CLEAN:/)
    assert.match(fn, /OC_V5_RECLAIM_FORCE/)
    // reclaim 必须不抢本地 deploy lock、不取全局 lease,也不被 recovery marker 挡住(否则被同一残留焊死)。
    assert.match(
      source,
      /MODE" != "reclaim-mutation-lease" \]\]; then\n {2}# reclaim 是"陈旧锁被同一残留焊死"/,
      'reclaim 必须跳过本地 deploy lock 获取',
    )
    assert.match(source, /reclaim-mutation-lease\) ;;\n {2}# knowledge-planet-verify/, 'reclaim 必须跳过全局 mutation lease 获取')
    assert.match(source, /"\$MODE" != "reclaim-mutation-lease" \]\]; then\n {2}assert_no_deploy_recovery_marker/, 'reclaim 必须能在 recovery marker 存在时照跑')
  })

  test('mutation holder releases its flock after its session parent is SIGKILLed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-mutation-holder-'))
    dirs.push(dir)
    const lock = path.join(dir, 'mutation.lock')
    const ready = path.join(dir, 'ready')
    const holderScript = path.join(dir, 'holder.sh')
    const parentScript = path.join(dir, 'parent.sh')
    await writeFile(
      holderScript,
      `#!/bin/bash
set -e
lock="$1"; ready="$2"
exec 9>"$lock"
flock -w 2 9 || exit 75
lease_parent="$PPID"
trap 'exit 0' HUP INT TERM
current_parent="$(awk '/^PPid:/{print $2; exit}' "/proc/$$/status" 2>/dev/null)" || exit 76
case "$current_parent" in ''|*[!0-9]*) exit 76 ;; esac
[ "$current_parent" = "$lease_parent" ] || exit 76
printf '%s\n' "$$" >"$ready"
while :; do
  current_parent="$(awk '/^PPid:/{print $2; exit}' "/proc/$$/status" 2>/dev/null)" || exit 0
  case "$current_parent" in ''|*[!0-9]*) exit 0 ;; esac
  [ "$current_parent" = "$lease_parent" ] || exit 0
  kill -0 "$lease_parent" 2>/dev/null || exit 0
  sleep 1
done
`,
    )
    await writeFile(
      parentScript,
      `#!/bin/bash
set -e
bash "$1" "$2" "$3" &
wait $!
`,
    )
    await chmod(holderScript, 0o755)
    await chmod(parentScript, 0o755)

    const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (await predicate()) return true
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return false
    }
    let parent: ReturnType<typeof spawn> | undefined
    let holderPid = 0
    let holderExited = false
    try {
      parent = spawn('bash', [parentScript, holderScript, lock, ready], {
        stdio: 'ignore',
      })
      assert.equal(
        await waitUntil(async () => {
          const raw = await readFile(ready, 'utf8').catch(() => '')
          holderPid = Number(raw.trim())
          return Number.isSafeInteger(holderPid) && holderPid > 0
        }, 2_000),
        true,
        'holder 未进入已持锁 parent-watch 状态',
      )
      assert.notEqual(spawnSync('flock', ['-n', lock, 'true']).status, 0, 'holder 未持有 flock')
      assert.equal(parent.kill('SIGKILL'), true, '未能 SIGKILL session parent')
      assert.equal(
        await waitUntil(() => spawnSync('flock', ['-n', lock, 'true']).status === 0, 5_000),
        true,
        'session parent 死亡后 holder 未在时限内释放 flock',
      )
      holderExited = await waitUntil(
        () => spawnSync('kill', ['-0', String(holderPid)]).status !== 0,
        5_000,
      )
      assert.equal(holderExited, true, 'orphan holder 未自行退出')
    } finally {
      parent?.kill('SIGKILL')
      if (holderPid > 0 && !holderExited) spawnSync('kill', ['-KILL', String(holderPid)])
    }
  })

  test('F6: inherited deploy-lock fd uses probe-then-relock (rejects unlocked liar)', async () => {
    const source = await readFile(deploy, 'utf8')
    // 继承锁 FD 分支:从 `if [[ -n "${OC_V5_DEPLOY_LOCK_FD:-}" ]]; then` 到 else 分支起点 `exec 8>"$DEPLOY_LOCK"`。
    const start = source.indexOf('if [[ -n "${OC_V5_DEPLOY_LOCK_FD:-}" ]]; then')
    const end = source.indexOf('exec 8>"$DEPLOY_LOCK"', start)
    assert.ok(start >= 0 && end > start, '未找到继承锁 FD 分支')
    const branch = source.slice(start, end)
    // ① 另开独立 OFD 的 probe fd(区分"真持锁 vs 谎称持锁"的核心)
    const probeOpen = branch.indexOf('exec {probe_fd}>"$DEPLOY_LOCK"')
    // ② probe flock -n 复核:竟成功=锁本空闲=谎称已持锁 → flock -u 释放 + exit 3
    const probeTry = branch.indexOf('if flock -n "$probe_fd"; then')
    const probeUnlock = branch.indexOf('flock -u "$probe_fd"')
    const probeExit = branch.indexOf('exit 3', probeTry)
    // ③ probe fd 关闭
    const probeClose = branch.indexOf('exec {probe_fd}>&-')
    // ④ 与父同 OFD 重入取锁(幂等)必须成功
    const relock = branch.indexOf('if ! flock -n "$lock_fd"; then')
    assert.ok(probeOpen >= 0, 'probe fd 未以独立 OFD 打开(exec {probe_fd}>)')
    assert.ok(probeTry > probeOpen, 'probe flock -n 复核缺失或顺序错(应在 probe fd 打开后)')
    assert.ok(
      probeUnlock > probeTry && probeExit > probeUnlock,
      'probe 抢到锁(谎称已持锁)未走 flock -u 释放 + exit 3',
    )
    assert.ok(probeClose > probeOpen, 'probe fd 未关闭(exec {probe_fd}>&-)')
    assert.ok(relock > probeTry, '末尾对 lock_fd 的重入 flock -n 缺失或顺序错(应在 probe 复核之后)')
    // ── R2-5:relock 之前的 per-fd FLOCK 归属证明(消 probe→relock 残留 TOCTOU)──
    // 说明:原议"/proc/locks 取持有 pid + PPid 祖先链"对 flock(1) 不可行(/proc/locks 记录临时 flock 命令
    // 进程的 pid,检时已 reap,fd-继承协议下既非 $$ 亦非祖先);改用 /proc/self/fdinfo/<fd> 的 per-fd
    // `lock:` 行直证继承 fd 确已持锁——零 TOCTOU、无需祖先链。断言其存在且在 relock **之前**。
    const fdinfoProof = branch.indexOf('/proc/self/fdinfo/$lock_fd')
    const fdinfoGrep = branch.indexOf('FLOCK[[:space:]]+ADVISORY[[:space:]]+WRITE')
    assert.ok(fdinfoProof >= 0, 'R2-5:缺 /proc/self/fdinfo/<fd> per-fd 归属证明')
    assert.ok(fdinfoGrep >= 0, 'R2-5:缺 FLOCK ADVISORY WRITE per-fd 校验(继承 fd 确已持锁)')
    assert.ok(
      fdinfoProof > probeTry && fdinfoProof < relock,
      'R2-5:fdinfo 归属证明须在 probe 复核之后、relock **之前**(relock 若 fresh-acquire 会掩盖谎称)',
    )
    // 归属证明失败必须 fail-closed(exit 3),而非放行继承。
    const fdinfoExit = branch.indexOf('exit 3', fdinfoProof)
    assert.ok(fdinfoExit >= 0 && fdinfoExit < relock, 'R2-5:fdinfo 归属证明失败未 fail-closed exit 3')
  })

  test('F7: mutation-lease deactivation covered on compensation + emergency/staged flips', async () => {
    const source = await readFile(deploy, 'utf8')
    // helper 已定义
    assert.match(source, /reacquire_mutation_lease_best_effort\(\) \{/)
    // ── R2-6:补偿路径改为**阻塞等待**重取(远端 flock -w 180),等待失败才降级续作补偿 ──
    {
      const rqStart = source.indexOf('reacquire_mutation_lease_best_effort() {')
      const rqEnd = source.indexOf('# ───────────────────────── dangerous offline cutover', rqStart)
      assert.ok(rqStart >= 0 && rqEnd > rqStart, '未找到 reacquire 函数体')
      const rq = source.slice(rqStart, rqEnd)
      assert.match(rq, /acquire_production_mutation_lease 180/, 'R2-6:reacquire 未走 180s 阻塞等待重取')
      assert.match(rq, /CRITICAL/, 'R2-6:reacquire 降级路径缺 CRITICAL stderr')
      assert.ok(
        rq.includes('补偿优先于互斥,残余窗口=host-action 90s 内的并发,已知且接受'),
        'R2-6:reacquire 降级路径缺"已知且接受残余窗口"注记(须同时在函数注释)',
      )
    }
    // acquire 支持可配置等待秒数(默认 60,reacquire 传 180),远端 flock 用参数化等待。
    assert.ok(source.includes('local lease_wait="${1:-60}"'), 'R2-6:acquire 未参数化等待秒数(默认 60)')
    assert.match(source, /flock -w \$\{lease_wait\} 9 \|\| exit 75/, 'R2-6:remote lease flock 未用参数化等待秒数')
    // deploy 两条补偿路径(validation + plugin seed)各挂一次
    assert.equal(
      source.match(/reacquire_mutation_lease_best_effort "deploy-validation-compensation"/g)?.length,
      2,
      'deploy 补偿(validation + plugin seed)未各挂一次 reacquire',
    )
    // deploy 补偿内 reacquire 先于 knowledge_planet_compensate_deploy
    const deployStart = source.indexOf('\ndeploy() {')
    const deployEnd = source.indexOf('\n# ───────────────────────── offline recycle', deployStart)
    const deployBody = source.slice(deployStart, deployEnd)
    assert.ok(
      deployBody.indexOf('reacquire_mutation_lease_best_effort "deploy-validation-compensation"') <
        deployBody.indexOf('knowledge_planet_compensate_deploy'),
      'deploy 补偿 reacquire 未先于 compensate',
    )
    // rollback 补偿覆盖(2026-07-17 KP 门摘除后):真正做反向补偿的只剩 hotcfg smoke-failure
    // reverse compensation + 非 hotcfg activate-failure 两条;其余插件侧失败已降级为
    // warn+open_gate_current 兜底继续(不做补偿,lease 仍在持有中),不需要 reacquire。
    assert.equal(
      source.match(/reacquire_mutation_lease_best_effort "rollback-compensation"/g)?.length,
      2,
      'rollback 反向补偿路径(hotcfg smoke-failure + 非 hotcfg activate-failure)未挂 reacquire',
    )
    // hotcfg smoke-failure 反向补偿紧邻先于 rollback_runtime_tuple 1 1。
    assert.match(
      source,
      /reacquire_mutation_lease_best_effort "rollback-compensation"\n\s*if rollback_runtime_tuple 1 1 "\$kp_rollback_helper"/,
    )
    // 非 hotcfg 三条:reacquire 紧邻先于 Knowledge Planet 补偿(open_gate / transition)。
    assert.match(
      source,
      /reacquire_mutation_lease_best_effort "rollback-compensation"\n(\s*if \[\[ "\$kp_rb_bracket" == 1 \]\]; then\n)?\s*knowledge_planet_plugin_(open_gate_to_release|transition_to_release) "\$live_master"/,
    )
    // 全部 2 次 reacquire(2026-07-17 KP 门摘除后仅剩真反向补偿两条)都落在
    // rollback() 函数体内(不外溢别的 lane)。
    {
      const rbStart = source.indexOf('\nrollback() {')
      const rbEnd = source.indexOf('\nrollback_runtime_tuple() {', rbStart)
      const rbBody = source.slice(rbStart, rbEnd)
      assert.equal(
        rbBody.match(/reacquire_mutation_lease_best_effort "rollback-compensation"/g)?.length,
        2,
        'rollback-compensation reacquire 未全部落在 rollback() 内',
      )
    }
    // 2026-07-17 lease 孤儿修复:ACTIVE 在 spawn 后立即置位(轮询窗被 trap 打断
    // 也能回收本地 ssh;远端 holder 由 base 侧自释放设计负责,见 PPid 自检循环)。
    assert.match(
      source,
      /MUTATION_LEASE_PID=\$!\n[\s\S]{0,400}?MUTATION_LEASE_ACTIVE=1/,
    )
    // abort_continue 恢复动作(caddy_render_reload)前调用
    const abortStart = source.indexOf('\nabort_continue() {')
    const abortEnd = source.indexOf('\n# ═════════ --recover', abortStart)
    const abortBody = source.slice(abortStart, abortEnd)
    const abortReacquire = abortBody.indexOf('reacquire_mutation_lease_best_effort "abort-continue"')
    assert.ok(
      abortReacquire >= 0 && abortReacquire < abortBody.indexOf('caddy_render_reload'),
      'abort_continue 恢复动作前未挂 reacquire',
    )
    // emergency tuple 翻转点:activate saga 前断言 lease
    const emStart = source.indexOf('\nactivate_emergency_tuple() {')
    const emEnd = source.indexOf('\nmigrate_to_bluegreen() {', emStart)
    const emBody = source.slice(emStart, emEnd)
    const emAssert = emBody.indexOf('assert_mutation_lease_alive "emergency-tuple-flip"')
    assert.ok(
      emAssert >= 0 && emAssert < emBody.indexOf('oc_hotcfg_activate_saga'),
      'emergency tuple 翻转点未在 activate saga 前断言 lease',
    )
    // activate-staged 翻转点:systemctl start 前断言 lease
    const asStart = source.indexOf('\nactivate_staged_inner() {')
    const asEnd = source.indexOf('\nactivate_staged() {', asStart)
    const asBody = source.slice(asStart, asEnd)
    const asAssert = asBody.indexOf('assert_mutation_lease_alive "activate-staged-flip"')
    assert.ok(
      asAssert >= 0 && asAssert < asBody.indexOf('systemctl start $V5_UNIT'),
      'activate-staged 翻转点未在 systemctl start 前断言 lease',
    )
  })

  // 2026-07-18 附件事故门禁补强 + 同日门禁审计升级(二期):E2E 用户旅程门(真浏览器)
  // 已进 validation 补偿链。契约:
  //  ① 函数本体:V5_SMOKE_E2E=0 豁免必须写留痕(record_smoke_waiver,monitor 告警到补跑)、
  //     playwright-core 依赖活体探测(缺失 fail-loud 禁静默跳过)、dry-run 分支、失败自动
  //     重试恰好一次且重试通过必须 record_e2e_flake 记账(fail-open 可见化)、双跑失败必须
  //     返回非零。
  //  ② 接线:一期"成功出口 end_planned_maintenance 之后 || exit 1"的 post-live 形态必须
  //     绝迹(已 live 才验、只喊不撤);deploy()/deploy_dist() 以 validation_failure 赋值
  //     形态挂进各自补偿链;finalize 提交 stable 前、canary READY 内部验证后必须有真 turn
  //     功能门(finalize 还要 E2E),全部先于不可逆动作(停旧 unit / 放量)。
  //  ③ dist 对称补偿:compensate_dist_activation 存在(hotcfg 轴复用 rollback_runtime_tuple,
  //     非 hotcfg 轴 symlink 回切,禁第二套恢复机制),且 deploy_dist 校验失败路径调用它。
  test('E2E journey gate wired into validation compensation chains', async () => {
    const source = await readFile(deploy, 'utf8')
    // ① 函数本体契约。
    const fnStart = source.indexOf('\nsmoke_e2e_journey() {')
    assert.ok(fnStart >= 0, 'smoke_e2e_journey 函数缺失')
    const fnEnd = source.indexOf('\n}', fnStart)
    const fn = source.slice(fnStart, fnEnd)
    assert.match(fn, /V5_SMOKE_E2E:-1/, '缺 V5_SMOKE_E2E 豁免开关')
    assert.match(fn, /record_smoke_waiver e2e/, '豁免必须写留痕(monitor 持续告警直到补跑)')
    assert.match(fn, /node_modules\/playwright-core/, '缺依赖活体探测(缺失必须 fail-loud 而非静默跳过)')
    assert.match(fn, /return 1/, '依赖缺失/旅程双跑失败必须返回非零')
    assert.match(fn, /\[dry-run\]/, '缺 dry-run 分支')
    const journeyCalls = fn.match(/v5-e2e-journey-canary\.mjs/g) ?? []
    assert.equal(journeyCalls.length, 2, '旅程脚本必须恰好双跑(首跑+重试一次);确定性回归两跑必双红,多于两跑=掩蔽')
    assert.match(fn, /record_e2e_flake/, '重试通过必须 flake 记账,禁静默续命')
    // ② 一期 post-live 形态绝迹。
    assert.equal(
      source.match(/smoke_e2e_journey \|\| exit 1/g),
      null,
      '发现 post-live "|| exit 1" 形态:E2E 门必须在补偿链内,不允许已 live 才验',
    )
    // deploy():E2E 校验位于 turn canary 之后、validation 补偿分支之前。
    const deployStart = source.indexOf('\ndeploy() {')
    assert.ok(deployStart >= 0, 'deploy() 函数缺失')
    const deployBody = source.slice(deployStart, source.indexOf('\noffline_recycle_inner() {', deployStart))
    const dTurn = deployBody.indexOf('smoke_turn_canary "$BUILT_RELEASE"')
    const dE2e = deployBody.indexOf('! smoke_e2e_journey')
    const dComp = deployBody.indexOf('if [[ -n "$validation_failure" ]]')
    assert.ok(
      dTurn >= 0 && dE2e > dTurn && dComp > dE2e,
      'deploy() E2E 门必须在 turn canary 之后、validation 补偿分支之前',
    )
    assert.ok(
      deployBody.includes('validation_failure="E2E journey gate failed'),
      'deploy() E2E 失败必须走 validation_failure(对称补偿)',
    )
    // deploy_dist():校验链 + 对称补偿。
    const distStart = source.indexOf('\ndeploy_dist() {')
    assert.ok(distStart >= 0, 'deploy_dist() 函数缺失')
    const distBody = source.slice(distStart, source.indexOf('\n}', distStart))
    assert.ok(
      distBody.includes('validation_failure="E2E journey gate failed'),
      'deploy_dist() E2E 失败必须走 validation_failure(对称补偿)',
    )
    assert.ok(
      distBody.includes('compensate_dist_activation "$BUILT_RELEASE" "$dist_previous_release" "$hc_any"'),
      'deploy_dist() 校验失败必须走 compensate_dist_activation 对称补偿(禁 set -e 裸退出留坏 dist)',
    )
    const cdaStart = source.indexOf('\ncompensate_dist_activation() {')
    assert.ok(cdaStart >= 0, 'compensate_dist_activation 缺失')
    const cda = source.slice(cdaStart, source.indexOf('\n}', cdaStart))
    assert.match(cda, /rollback_runtime_tuple/, 'dist 补偿 hotcfg 轴必须复用 rollback_runtime_tuple(禁第二套恢复机制)')
    assert.ok(cda.includes('activate_release "$previous"'), 'dist 补偿非 hotcfg 轴必须 symlink 回切旧 release')
    // finalize:提交 stable 前功能门(真 turn + E2E)都在停旧 unit 之前。
    const finStart = source.indexOf('\nfinalize() {')
    assert.ok(finStart >= 0, 'finalize() 函数缺失')
    const finBody = source.slice(finStart, source.indexOf('lane: --abort', finStart))
    const fTurn = finBody.indexOf('smoke_turn_canary "$precommit_release"')
    const fE2e = finBody.indexOf('smoke_e2e_journey "$(slot_port "$cand")"')
    const fStop = finBody.indexOf('systemctl stop $(slot_unit "$old")')
    assert.ok(
      fTurn >= 0 && fE2e > fTurn && fStop > fE2e,
      'finalize 提交前必须依次过真 turn/E2E 功能门,且都在停旧 unit 之前',
    )
    // canary lane:READY+内部验证之后必须有 candidate 真 turn 门(不验真 turn 不准放量)。
    assert.ok(
      source.includes('smoke_turn_canary "$reldir" "$(slot_port "$cand")"'),
      'canary lane READY 后缺 candidate 真 turn 门',
    )
    // ③ 豁免留痕机制:record/clear 存在,turn canary 成功必须清除留痕。
    assert.ok(
      source.includes('\nrecord_smoke_waiver() {') && source.includes('\nclear_smoke_waiver() {'),
      '豁免留痕 record_smoke_waiver/clear_smoke_waiver 函数缺失',
    )
    const tcStart = source.indexOf('\nsmoke_turn_canary() {')
    const tc = source.slice(tcStart, source.indexOf('\n}', tcStart))
    assert.match(tc, /clear_smoke_waiver turn/, 'turn canary 成功必须清除豁免留痕(债务偿还语义)')
  })
})
