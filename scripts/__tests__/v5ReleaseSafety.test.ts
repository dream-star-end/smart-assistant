import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const deploy = path.join(root, 'scripts/deploy-v5.sh')
const monitor = path.join(root, 'scripts/v5-monitor.sh')
const caddy = path.join(root, 'scripts/install-v5-upstream-errors.sh')
const caddyApply = path.join(root, 'scripts/v5-caddy-apply.sh')
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
    assert.match(egress.stdout, /checks=svc_v5,http_v5,public_route,svc_egress,http_egress/)
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
