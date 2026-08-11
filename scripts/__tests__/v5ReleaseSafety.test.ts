import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const deploy = path.join(root, 'scripts/deploy-v5.sh')
const branchPolicy = path.join(root, 'scripts/v5-branch-policy.sh')
const deploySurfaceCheck = path.join(root, 'scripts/v5-deploy-surface-check.mjs')
const e2eJourney = path.join(root, 'scripts/v5-e2e-journey-canary.mjs')
const turnCanary = path.join(root, 'scripts/v5-smoke-turn-canary.mjs')
const sessionDisplayRunner = path.join(root, 'e2e/session-display/run.sh')
const sessionDisplayFixtures = path.join(root, 'e2e/session-display/fixtures.ts')
const sessionDisplayApi = path.join(root, 'e2e/session-display/lib/api.ts')
const sessionDisplayUi = path.join(root, 'e2e/session-display/lib/ui.ts')
const sessionDisplayLargeTest = path.join(root, 'e2e/session-display/tests/02-large-session-open.spec.ts')
const sessionDisplayStatusTest = path.join(root, 'e2e/session-display/tests/05-turn-status.spec.ts')
const incidentManifest = path.join(root, 'e2e/session-display/incidents.json')
const baselineEval = path.join(root, 'scripts/run-baseline-skill-evals.sh')
const baselineWeekly = path.join(root, 'scripts/v5-baseline-evals-weekly.sh')
const marketEval = path.join(root, 'scripts/v5-market-skill-eval.sh')
const baselineService = path.join(root, 'deploy/v5/openclaude-v5-baseline-evals.service')
const manualMutationLease = path.join(root, 'scripts/with-production-mutation-lease.sh')
const baselineGuard = path.join(root, 'scripts/v5-baseline-security.sh')
const releaseGc = path.join(root, 'scripts/v5-release-gc.sh')
const releaseQueue = path.join(root, 'scripts/v5-release-queue.sh')
const monitor = path.join(root, 'scripts/v5-monitor.sh')
const dailyCheck = path.join(root, 'scripts/v5-daily-check.sh')
const monitorHostInstaller = path.join(root, 'scripts/v5-monitor-host-install-remote.sh')
const monitorService = path.join(root, 'deploy/v5/openclaude-v5-monitor.service')
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
const require_ = createRequire(path.join(root, 'package.json'))
const { WebSocketServer } = require_('ws')

describe('V5 branch deployment policy', () => {
  const assertBranch = (branch: string, allowAny = '0') =>
    spawnSync(
      'bash',
      ['-c', `source "$1"; assert_v5_deploy_branch_allowed "$2" "$3"`, 'branch-policy', branchPolicy, branch, allowAny],
      { cwd: root, encoding: 'utf8' },
    )

  test('Windows app branches fail closed even when ALLOW_ANY_BRANCH would bypass the generic guard', () => {
    for (const branch of [
      'feat/v5-windows-app',
      'feat/v5-windows-native-shell',
      'fix/v5-windows-downloads',
      'chore/v5-windows-upstream-sync',
    ]) {
      const result = assertBranch(branch, '1')
      assert.notEqual(result.status, 0, branch)
      assert.match(result.stderr, /Windows installer release lane/)
    }
  })

  test('server V5 and explicitly allowed test branches preserve the existing contract', () => {
    assert.equal(assertBranch('feat/v5-aurora-rewrite').status, 0)
    assert.notEqual(assertBranch('v3').status, 0)
    assert.equal(assertBranch('test-fixture', '1').status, 0)
  })
})

async function runTurnCanaryFixture(
  mode: 'foreign-then-success' | 'foreign-only' | 'own-error',
): Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'v5-turn-canary-'))
  dirs.push(dir)
  const passwordFile = path.join(dir, 'password')
  await writeFile(passwordFile, 'fixture-password\n')

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/auth/login') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ access_token: 'fixture-token' }))
      return
    }
    if (req.method === 'PUT' && req.url?.startsWith('/api/sessions/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ server, path: '/ws/user-chat-bridge' })
  let inboundAt = 0
  wss.on('connection', (ws: {
    once: (event: 'message', listener: (raw: { toString(): string }) => void) => void
    send: (data: string) => void
  }) => {
    ws.once('message', (raw) => {
      inboundAt = Date.now()
      const inbound = JSON.parse(raw.toString())
      const foreignErrors = [
        JSON.stringify({
          type: 'error',
          code: 'UNAUTHORIZED_MODEL',
          message: 'foreign recovery peer',
          peer: { id: 'web-foreign-recovery', kind: 'dm' },
          clientMessageId: inbound.clientMessageId,
        }),
        JSON.stringify({
          type: 'error',
          code: 'UNAUTHORIZED_MODEL',
          message: 'foreign recovery turn',
          peer: inbound.peer,
          clientMessageId: 'm-recover-foreign',
        }),
      ]
      const sendForeignErrors = () => foreignErrors.forEach((frame) => ws.send(frame))
      if (mode === 'foreign-only') {
        const timer = setInterval(sendForeignErrors, 15)
        setTimeout(() => clearInterval(timer), 1_200)
        return
      }
      sendForeignErrors()
      if (mode === 'own-error') {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'UPSTREAM_FAILED',
          message: 'own turn failed',
          peer: inbound.peer,
          clientMessageId: inbound.clientMessageId,
        }))
        return
      }
      ws.send(JSON.stringify({
        type: 'outbound.message',
        sessionKey: `agent:main:webchat:dm:${inbound.peer.id}`,
        channel: 'webchat',
        peer: inbound.peer,
        clientMessageId: inbound.clientMessageId,
        blocks: [{ kind: 'text', text: '2' }],
        isFinal: false,
      }))
      ws.send(JSON.stringify({
        type: 'outbound.message',
        sessionKey: `agent:main:webchat:dm:${inbound.peer.id}`,
        channel: 'webchat',
        peer: inbound.peer,
        clientMessageId: inbound.clientMessageId,
        blocks: [],
        isFinal: true,
      }))
      ws.send(JSON.stringify({ type: 'outbound.cost_charged' }))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const startedAt = Date.now()
  const child = spawn(process.execPath, [turnCanary], {
    cwd: root,
    env: {
      ...process.env,
      V5_BASE: `http://127.0.0.1:${address.port}`,
      V5_CANARY_PASSWORD_FILE: passwordFile,
      V5_TURN_ATTEMPTS: '1',
      V5_TURN_SILENCE_MS: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3_000)
    child.once('error', reject)
    child.once('exit', (exitCode) => {
      clearTimeout(timeout)
      resolve(exitCode)
    })
  })
  const elapsedMs = Date.now() - (inboundAt || startedAt)
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return { code, stdout, stderr, elapsedMs }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('V5 P3 preserved runtime tuple surface gate', () => {
  async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-p3-surface-'))
    dirs.push(dir)
    const repo = path.join(dir, 'repo')
    await mkdir(path.join(repo, 'deploy/v5'), { recursive: true })
    await cp(
      path.join(root, 'deploy/v5/selfheal-deploy-surfaces.json'),
      path.join(repo, 'deploy/v5/selfheal-deploy-surfaces.json'),
    )
    const write = async (relative: string, contents = 'fixture\n') => {
      const target = path.join(repo, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, contents)
    }
    await write('packages/gateway/src/old.ts')
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr || result.stdout)
      return result.stdout.trim()
    }
    git('init', '--initial-branch=main')
    git('config', 'user.name', 'Surface Test')
    git('config', 'user.email', 'surface@example.test')
    git('add', '.')
    git('commit', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    const commit = (message = 'candidate') => {
      git('add', '-A')
      git('commit', '-m', message)
      return git('rev-parse', 'HEAD')
    }
    const invoke = (from: string, target: string) => spawnSync(
      process.execPath,
      [deploySurfaceCheck, '--repo', repo, '--base', from, '--target', target],
      { encoding: 'utf8' },
    )
    return { repo, base, write, git, commit, invoke }
  }

  test('classifies gateway and CLI as runtime-source and platform files as platform-runtime', async () => {
    for (const [file, surface] of [
      ['packages/gateway/src/new.ts', 'runtime-source'],
      ['packages/cli/src/new.ts', 'runtime-source'],
      ['packages/commercial/agent-sandbox/platform-runtime/entrypoint/new.ts', 'platform-runtime'],
    ] as const) {
      const f = await fixture()
      await f.write(file)
      const target = f.commit()
      const result = f.invoke(f.base, target)
      assert.equal(result.status, 0, result.stderr || result.stdout)
      const plan = JSON.parse(result.stdout)
      assert.ok(plan.surfaces.includes(surface), `${file} missed ${surface}`)
      assert.deepEqual(plan.manual, [])
    }
  })

  test('master/web-only changes pass while rename old paths, manual paths, and unmatched paths fail closed', async () => {
    const clean = await fixture()
    await clean.write('packages/web-react/src/new.ts')
    await clean.write('docs/new.md')
    const cleanTarget = clean.commit()
    const cleanResult = clean.invoke(clean.base, cleanTarget)
    assert.equal(cleanResult.status, 0, cleanResult.stderr || cleanResult.stdout)
    const cleanPlan = JSON.parse(cleanResult.stdout)
    assert.deepEqual(cleanPlan.manual, [])
    assert.deepEqual(cleanPlan.surfaces, ['master', 'web'])

    const renamed = await fixture()
    await renamed.write('docs/moved.ts')
    await rm(path.join(renamed.repo, 'packages/gateway/src/old.ts'))
    const renameTarget = renamed.commit()
    const renameResult = renamed.invoke(renamed.base, renameTarget)
    assert.equal(renameResult.status, 0, renameResult.stderr || renameResult.stdout)
    const renamePlan = JSON.parse(renameResult.stdout)
    assert.ok(renamePlan.matches['runtime-source'].includes('packages/gateway/src/old.ts'))

    const rejected = await fixture()
    await rejected.write('scripts/new.sh')
    await rejected.write('e2e/session-display/incidents.json')
    const rejectedTarget = rejected.commit()
    const rejectedResult = rejected.invoke(rejected.base, rejectedTarget)
    assert.equal(rejectedResult.status, 0, rejectedResult.stderr || rejectedResult.stdout)
    const rejectedPlan = JSON.parse(rejectedResult.stdout)
    assert.ok(rejectedPlan.manual.some((entry: { reason: string }) => entry.reason.startsWith('manual_glob:')))
    assert.ok(rejectedPlan.manual.some((entry: { path: string, reason: string }) =>
      entry.path === 'e2e/session-display/incidents.json' && entry.reason === 'unmatched_path'))
  })

  test('symlink/type changes, invalid manifests, invalid commits, and non-ancestor ranges fail closed', async () => {
    const changedType = await fixture()
    await rm(path.join(changedType.repo, 'packages/gateway/src/old.ts'))
    await symlink('/tmp/not-runtime-source', path.join(changedType.repo, 'packages/gateway/src/old.ts'))
    const typeTarget = changedType.commit()
    const typeResult = changedType.invoke(changedType.base, typeTarget)
    assert.equal(typeResult.status, 0, typeResult.stderr || typeResult.stdout)
    assert.ok(JSON.parse(typeResult.stdout).manual.some(
      (entry: { reason: string }) => entry.reason.startsWith('unsupported_'),
    ))

    const invalidManifest = await fixture()
    await invalidManifest.write('packages/web-react/src/new.ts')
    const invalidTarget = invalidManifest.commit()
    const manifestPath = path.join(invalidManifest.repo, 'deploy/v5/selfheal-deploy-surfaces.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.version = 2
    await writeFile(manifestPath, JSON.stringify(manifest))
    const invalidResult = invalidManifest.invoke(invalidManifest.base, invalidTarget)
    assert.equal(invalidResult.status, 2)
    assert.match(invalidResult.stderr, /manifest schema\/version\/shape is invalid/)

    const ancestry = await fixture()
    await ancestry.write('docs/new.md')
    const descendant = ancestry.commit()
    const backwards = ancestry.invoke(descendant, ancestry.base)
    assert.equal(backwards.status, 2)
    assert.match(backwards.stderr, /merge-base --is-ancestor/)
    const missing = ancestry.invoke('f'.repeat(40), descendant)
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /cat-file -e/)
  })

  test('deploy integration rejects tuple drift before authorization/debt or any other canary mutation', async () => {
    const source = await readFile(deploy, 'utf8')
    const canaryStart = source.indexOf('\ncanary() {')
    const canary = source.slice(canaryStart, source.indexOf('\n# 内部账号 allowlist', canaryStart))
    const guard = canary.indexOf('assert_p3_preserved_tuple_matches_candidate')
    assert.ok(guard >= 0)
    for (const later of [
      'consume_emergency_authorization',
      'prepare_live_baseline_safety',
      'ds_snapshot',
      'ds_cas_or_die',
      'build_release',
    ]) {
      assert.ok(guard < canary.indexOf(later), `P3 surface guard must precede ${later}`)
    }
    const manifest = JSON.parse(await readFile(path.join(root, 'deploy/v5/selfheal-deploy-surfaces.json'), 'utf8'))
    assert.ok(manifest.rules.some(
      (rule: { glob: string, surface: string }) => rule.glob === 'packages/cli/**' && rule.surface === 'runtime-source',
    ))

    const invokeGuard = (repo: string, base: string, target: string) => spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      `REPO_ROOT='${repo}'`,
      'DRY=0',
      'remote_env_get() {',
      '  case "$1" in',
      '    OC_RUNTIME_RELEASE) printf "%s\\n" /runtime/current ;;',
      '    OC_PLATFORM_BUNDLE) printf "%s\\n" /bundle/current ;;',
      '    *) return 97 ;;',
      '  esac',
      '}',
      'ssh() { cat >/dev/null || true; printf "%s\\n" "$BASE"; }',
      `assert_p3_preserved_tuple_matches_candidate '${target}'`,
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', BASE: base },
    })

    const runtime = await fixture()
    await runtime.write('packages/gateway/src/new.ts')
    const runtimeTarget = runtime.commit()
    const runtimeResult = invokeGuard(runtime.repo, runtime.base, runtimeTarget)
    assert.notEqual(runtimeResult.status, 0)
    assert.match(runtimeResult.stderr, /candidate 含未生效的 runtime-source/)

    const platform = await fixture()
    await platform.write('packages/commercial/agent-sandbox/platform-runtime/entrypoint/new.ts')
    const platformTarget = platform.commit()
    const platformResult = invokeGuard(platform.repo, platform.base, platformTarget)
    assert.notEqual(platformResult.status, 0)
    assert.match(platformResult.stderr, /candidate 含未生效的 platform-runtime/)

    const clean = await fixture()
    await clean.write('packages/web-react/src/new.ts')
    await clean.write('docs/new.md')
    const cleanTarget = clean.commit()
    const cleanResult = invokeGuard(clean.repo, clean.base, cleanTarget)
    assert.equal(cleanResult.status, 0, cleanResult.stderr || cleanResult.stdout)
  })

  test('empty tuple axes trust only an immutable image identity and require embedded runtime source', () => {
    const imageId = `sha256:${'a'.repeat(64)}`
    const sourceCommit = 'b'.repeat(40)
    const harness = [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'DRY=0',
      'remote_env_get() {',
      '  case "$1" in',
      '    OC_RUNTIME_RELEASE|OC_PLATFORM_BUNDLE) printf "\\n" ;;',
      '    OC_RUNTIME_IMAGE) printf "%s\\n" runtime:test ;;',
      `    OC_RUNTIME_IMAGE_ID) printf '%s\\n' '${imageId}' ;;`,
      '    *) return 97 ;;',
      '  esac',
      '}',
      `ssh() { printf '%s|%s|%s\\n' "\${ACTUAL_ID:-${imageId}}" '${sourceCommit}' "\${EMBED_SOURCE:-1}"; }`,
      'p3_tuple_axis_source_commit "$SURFACE"',
    ].join('\n')
    const invoke = (surface: string, env: NodeJS.ProcessEnv = {}) => spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', SURFACE: surface, ...env },
    })
    const runtime = invoke('runtime-source')
    assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout)
    assert.equal(runtime.stdout.trim(), sourceCommit)

    const slim = invoke('runtime-source', { EMBED_SOURCE: '0' })
    assert.notEqual(slim.status, 0)
    assert.match(slim.stderr, /没有 embedded-source image 证明/)

    const drifted = invoke('runtime-source', { ACTUAL_ID: `sha256:${'c'.repeat(64)}` })
    assert.notEqual(drifted.status, 0)
    assert.match(drifted.stderr, /image ID\/sourceCommit 不可信/)

    const bakedPlatform = invoke('platform-runtime', { EMBED_SOURCE: '0' })
    assert.equal(bakedPlatform.status, 0, bakedPlatform.stderr || bakedPlatform.stdout)
    assert.equal(bakedPlatform.stdout.trim(), sourceCommit)
  })
})

describe('V5 durable development release queue', () => {
  async function queueFixture() {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-release-queue-'))
    dirs.push(dir)
    const repo = path.join(dir, 'repo')
    await mkdir(repo)
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr || result.stdout)
      return result.stdout.trim()
    }
    git('init', '--initial-branch=canon')
    git('config', 'user.name', 'Queue Test')
    git('config', 'user.email', 'queue@example.test')
    await writeFile(path.join(repo, 'value.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    await writeFile(path.join(repo, 'value.txt'), 'candidate\n')
    git('commit', '-am', 'candidate')
    const candidate = git('rev-parse', 'HEAD')
    const env = {
      OC_V5_RELEASE_QUEUE_DB: path.join(dir, 'queue.db'),
      OC_V5_RELEASE_QUEUE_LOCK: path.join(dir, 'queue.lock'),
      OC_V5_DEPLOY_LOCK_FILE: path.join(dir, 'deploy.lock'),
      OC_V5_RELEASE_QUEUE_REPO_ROOT: repo,
    }
    const invoke = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
      run(releaseQueue, args, { ...env, ...extraEnv })
    return { dir, repo, base, candidate, env, invoke, git }
  }

  function outputId(result: ReturnType<typeof run>): string {
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const id = result.stdout.trim()
    assert.match(id, /^rq-\d{8}T\d{6}Z-[0-9a-f]{12}$/)
    return id
  }

  test('SQLite queue is durable, idempotent FIFO with one active job and exact canonical pin', async () => {
    const fixture = await queueFixture()
    const empty = fixture.invoke(['status', '--json'])
    assert.equal(empty.status, 0, empty.stderr || empty.stdout)
    assert.deepEqual(JSON.parse(empty.stdout), [])
    const first = outputId(
      fixture.invoke([
        'submit',
        '--task',
        'first',
        '--branch',
        'feat/first',
        '--sha',
        fixture.base,
        '--actor',
        'test',
      ]),
    )
    const duplicate = outputId(
      fixture.invoke([
        'submit',
        '--task',
        'first',
        '--branch',
        'feat/first',
        '--sha',
        fixture.base,
        '--actor',
        'test',
      ]),
    )
    assert.equal(duplicate, first)
    const second = outputId(
      fixture.invoke([
        'submit',
        '--task',
        'second',
        '--branch',
        'feat/second',
        '--sha',
        fixture.base,
        '--actor',
        'test',
      ]),
    )
    const cancelled = outputId(
      fixture.invoke([
        'submit',
        '--task',
        'cancelled',
        '--branch',
        'feat/cancelled',
        '--sha',
        fixture.base,
        '--actor',
        'test',
      ]),
    )
    assert.equal(
      fixture.invoke(['cancel', '--id', cancelled, '--reason', 'superseded', '--actor', 'test'])
        .status,
      0,
    )

    assert.equal(fixture.invoke(['acquire', '--id', first, '--owner', 'test']).status, 0)
    assert.equal(
      fixture.invoke(['acquire', '--id', second, '--owner', 'test']).status,
      75,
      'a later task must not take over an active job',
    )
    assert.equal(
      fixture.invoke(['pin', '--id', first, '--sha', fixture.base, '--actor', 'test']).status,
      2,
      'pin must reject a canonical SHA that is not current HEAD',
    )
    const pin = fixture.invoke([
      'pin',
      '--id',
      first,
      '--sha',
      fixture.candidate,
      '--actor',
      'test',
    ])
    assert.equal(pin.status, 0, pin.stderr || pin.stdout)
    assert.equal(
      fixture.invoke(['assert', '--id', first]).status,
      0,
      'a fresh process must observe the durable active+pin state',
    )

    // 2026-07-26 角色分离:base 在你 active 期间前进是**常态**(所有会话共享这棵开发树),
    // 不该作废你的 job —— 旧语义要求 HEAD 逐字节等于 pinned,于是别人合一个 PR 就把你
    // 顶掉,而你占着唯一 active 槽让别人 acquire 恒返回 75(双向死锁,已真实发生)。
    // 新语义:pinned 仍是 HEAD 的祖先 → 放行,发布内容按 pinned 取源(deploy 侧
    // resolve_release_source_commit,由本文件的 "pinned SHA …" 契约测试锁死配对)。
    await writeFile(path.join(fixture.repo, 'value.txt'), 'drift\n')
    fixture.git('commit', '-am', 'drift')
    const advanced = fixture.invoke(['assert', '--id', first])
    assert.equal(
      advanced.status,
      0,
      `base 前进(pinned 仍是祖先)不得作废 active job:${advanced.stderr || advanced.stdout}`,
    )
    assert.match(
      advanced.stdout,
      /canonical 已前进/,
      '放行时必须显式说明"发布内容按 pinned 取源",否则操作者会以为发的是 HEAD',
    )

    // 但 fail-closed 的核心不能丢:pinned **不在** HEAD 历史里 = pin 错了 / commit 被
    // 改写,那才是真正必须拒绝的场景(否则就会按一个不属于 canonical 的 commit 发布)。
    const baseBranch = fixture.git('rev-parse', '--abbrev-ref', 'HEAD').trim()
    const orphanBranch = 'orphan-history'
    fixture.git('checkout', '-q', '--orphan', orphanBranch)
    fixture.git('commit', '-q', '--allow-empty', '-m', 'unrelated history')
    const orphaned = fixture.invoke(['assert', '--id', first])
    assert.equal(
      orphaned.status,
      2,
      'pinned 不在当前历史里时必须 fail closed(否则会发布一个不属于 canonical 的 commit)',
    )
    assert.match(orphaned.stderr, /不在 canonical 历史里/)
    // 回到原分支:orphan 分支没有前序引用,`checkout -` 在这里不可用,必须用显式名字。
    fixture.git('checkout', '-q', baseBranch)
    fixture.git('branch', '-D', orphanBranch)
    fixture.git('reset', '--hard', fixture.candidate)
    assert.equal(
      fixture.invoke([
        'finish',
        '--id',
        first,
        '--result',
        'deployed',
        '--reason',
        'validated',
        '--actor',
        'test',
      ]).status,
      0,
    )
    assert.equal(
      fixture.invoke(['wait', '--id', second, '--owner', 'test', '--timeout', '2']).status,
      0,
    )

    const status = fixture.invoke(['status', '--json'])
    assert.equal(status.status, 0, status.stderr || status.stdout)
    const jobs = JSON.parse(status.stdout) as Array<{ id: string; status: string }>
    assert.equal(jobs.find((job) => job.id === first)?.status, 'completed')
    assert.equal(jobs.find((job) => job.id === second)?.status, 'active')
    assert.equal(jobs.find((job) => job.id === cancelled)?.status, 'cancelled')
  })

  test('heartbeat refreshes only the exact active owner and records a durable event', async () => {
    const fixture = await queueFixture()
    const active = outputId(
      fixture.invoke([
        'submit',
        '--task',
        'long-eval',
        '--branch',
        'chore/long-eval',
        '--sha',
        fixture.candidate,
        '--actor',
        'test',
      ]),
    )
    const queued = outputId(
      fixture.invoke([
        'submit',
        '--task',
        'waiting',
        '--branch',
        'chore/waiting',
        '--sha',
        fixture.base,
        '--actor',
        'test',
      ]),
    )
    assert.equal(fixture.invoke(['acquire', '--id', active, '--owner', 'eval-owner']).status, 0)
    const before = JSON.parse(fixture.invoke(['status', '--json']).stdout) as Array<{
      id: string
      updated_at: string
    }>
    const beforeUpdatedAt = before.find((job) => job.id === active)?.updated_at
    assert.ok(beforeUpdatedAt)

    await new Promise((resolve) => setTimeout(resolve, 1_100))
    const heartbeat = fixture.invoke(['heartbeat', '--id', active, '--owner', 'eval-owner'])
    assert.equal(heartbeat.status, 0, heartbeat.stderr || heartbeat.stdout)
    assert.equal(heartbeat.stdout.trim(), active)
    const after = JSON.parse(fixture.invoke(['status', '--json']).stdout) as Array<{
      id: string
      updated_at: string
    }>
    const afterUpdatedAt = after.find((job) => job.id === active)?.updated_at
    assert.ok(afterUpdatedAt && afterUpdatedAt > beforeUpdatedAt)
    const heartbeatEvents = spawnSync(
      'sqlite3',
      [
        fixture.env.OC_V5_RELEASE_QUEUE_DB,
        `SELECT count(*) FROM release_queue_events WHERE job_id='${active}' AND event='heartbeat' AND actor='eval-owner';`,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(heartbeatEvents.status, 0, heartbeatEvents.stderr || heartbeatEvents.stdout)
    assert.equal(heartbeatEvents.stdout.trim(), '1')

    assert.notEqual(
      fixture.invoke(['heartbeat', '--id', active, '--owner', 'another-owner']).status,
      0,
      'another owner must not keep an active job alive',
    )
    assert.notEqual(
      fixture.invoke(['heartbeat', '--id', queued, '--owner', 'eval-owner']).status,
      0,
      'a queued job must not accept heartbeats',
    )
    const unchangedEvents = spawnSync(
      'sqlite3',
      [
        fixture.env.OC_V5_RELEASE_QUEUE_DB,
        `SELECT count(*) FROM release_queue_events WHERE event='heartbeat';`,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(unchangedEvents.status, 0, unchangedEvents.stderr || unchangedEvents.stdout)
    assert.equal(unchangedEvents.stdout.trim(), '1')
  })

  test('abandon-active holds local deploy lock and official lease through the audited transition', async () => {
    const fixture = await queueFixture()
    const id = outputId(
      fixture.invoke([
        'submit',
        '--task',
        'lost-owner',
        '--branch',
        'feat/lost-owner',
        '--sha',
        fixture.candidate,
        '--actor',
        'test',
      ]),
    )
    assert.equal(fixture.invoke(['acquire', '--id', id, '--owner', 'lost']).status, 0)

    const held = path.join(fixture.dir, 'remote-lease-held')
    const hookProof = path.join(fixture.dir, 'hook-saw-lease')
    const wrapper = path.join(fixture.dir, 'lease-wrapper.sh')
    const bin = path.join(fixture.dir, 'bin')
    await mkdir(bin)
    await writeFile(
      wrapper,
      [
        '#!/usr/bin/env bash',
        'set -e',
        `: >${JSON.stringify(held)}`,
        `OC_V5_MANUAL_LEASE_NONCE=${'a'.repeat(32)} \\`,
        'OC_V5_MANUAL_LEASE_PROOF=/run/openclaude-v5/production-mutation.lock.manual-holder \\',
        '"$@"',
        'rc=$?',
        `status="$(sqlite3 -noheader "$OC_V5_RELEASE_QUEUE_DB" "SELECT status FROM release_queue_jobs WHERE id='$ABANDON_ID';")"`,
        `if [ "$status" = abandoned ] && [ -e ${JSON.stringify(held)} ]; then : >${JSON.stringify(
          hookProof,
        )}; fi`,
        `rm -f ${JSON.stringify(held)}`,
        'exit "$rc"',
        '',
      ].join('\n'),
    )
    await writeFile(
      path.join(bin, 'ssh'),
      `#!/usr/bin/env bash\ncat >/dev/null\ntest -e ${JSON.stringify(held)}\n`,
    )
    await Promise.all([chmod(wrapper, 0o755), chmod(path.join(bin, 'ssh'), 0o755)])
    const abandoned = fixture.invoke(
      [
        'abandon-active',
        '--id',
        id,
        '--result',
        'not-deployed',
        '--reason',
        'owner-lost-before-merge',
        '--operator',
        'operator',
      ],
      {
        OC_V5_RELEASE_QUEUE_LEASE_WRAPPER: wrapper,
        ABANDON_ID: id,
        KL_HOST: 'fake',
        PATH: `${bin}:${process.env.PATH}`,
      },
    )
    assert.equal(abandoned.status, 0, abandoned.stderr || abandoned.stdout)
    assert.equal((await readFile(hookProof, 'utf8')).length, 0)
    const jobs = JSON.parse(fixture.invoke(['status', '--json']).stdout) as Array<{
      id: string
      status: string
    }>
    assert.equal(jobs.find((job) => job.id === id)?.status, 'abandoned')
  })

  test('abandon-active never releases an active job when stable-state proof fails', async () => {
    const fixture = await queueFixture()
    const id = outputId(
      fixture.invoke([
        'submit',
        '--task',
        'unsafe',
        '--branch',
        'feat/unsafe',
        '--sha',
        fixture.candidate,
        '--actor',
        'test',
      ]),
    )
    assert.equal(fixture.invoke(['acquire', '--id', id, '--owner', 'lost']).status, 0)
    const wrapper = path.join(fixture.dir, 'lease-wrapper.sh')
    const bin = path.join(fixture.dir, 'bin')
    await mkdir(bin)
    await writeFile(
      wrapper,
      `#!/usr/bin/env bash\nOC_V5_MANUAL_LEASE_NONCE=${'b'.repeat(
        32,
      )} OC_V5_MANUAL_LEASE_PROOF=/run/openclaude-v5/production-mutation.lock.manual-holder exec "$@"\n`,
    )
    await writeFile(path.join(bin, 'ssh'), '#!/usr/bin/env bash\ncat >/dev/null\nexit 1\n')
    await Promise.all([chmod(wrapper, 0o755), chmod(path.join(bin, 'ssh'), 0o755)])
    const result = fixture.invoke(
      [
        'abandon-active',
        '--id',
        id,
        '--result',
        'not-deployed',
        '--reason',
        'unproven',
        '--operator',
        'operator',
      ],
      {
        OC_V5_RELEASE_QUEUE_LEASE_WRAPPER: wrapper,
        KL_HOST: 'fake',
        PATH: `${bin}:${process.env.PATH}`,
      },
    )
    assert.notEqual(result.status, 0)
    const jobs = JSON.parse(fixture.invoke(['status', '--json']).stdout) as Array<{
      id: string
      status: string
    }>
    assert.equal(jobs.find((job) => job.id === id)?.status, 'active')

    const skip = fixture.invoke(
      [
        'abandon-active',
        '--id',
        id,
        '--result',
        'not-deployed',
        '--reason',
        'skip-forbidden',
        '--operator',
        'operator',
      ],
      { OC_V5_RELEASE_QUEUE_LEASE_WRAPPER: wrapper, OC_V5_SKIP_MUTATION_LEASE: '1' },
    )
    assert.equal(skip.status, 2)
    const afterSkip = JSON.parse(fixture.invoke(['status', '--json']).stdout) as Array<{
      id: string
      status: string
    }>
    assert.equal(afterSkip.find((job) => job.id === id)?.status, 'active')

    const arbitraryLock = path.join(fixture.dir, 'arbitrary.lock')
    const forged = spawnSync(
      'bash',
      [
        '-c',
        [
          'exec 55>"$1"',
          'flock 55',
          'OC_V5_RELEASE_QUEUE_INTERNAL=1',
          'OC_V5_RELEASE_QUEUE_DEPLOY_LOCK_FD=55',
          'OC_V5_MANUAL_LEASE_NONCE=cccccccccccccccccccccccccccccccc',
          'OC_V5_MANUAL_LEASE_PROOF=/run/openclaude-v5/production-mutation.lock.manual-holder',
          '"$2" __abandon-internal "$3" not-deployed forged operator',
        ].join('; '),
        'forged',
        arbitraryLock,
        releaseQueue,
        id,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...fixture.env,
        },
      },
    )
    assert.notEqual(forged.status, 0, 'an arbitrary flock fd must not authorize internal abandon')
    const afterForged = JSON.parse(fixture.invoke(['status', '--json']).stdout) as Array<{
      id: string
      status: string
    }>
    assert.equal(afterForged.find((job) => job.id === id)?.status, 'active')
  })

  test('deploy mode classification is default-closed and queue gate precedes every production side effect', async () => {
    const source = await readFile(deploy, 'utf8')
    const exempt = [
      'smoke',
      'baseline-census',
      'model-authority-preflight',
      'model-authority-observation-status',
      'abort',
      'rollback',
      'recover',
      'reclaim-mutation-lease',
      'hide-luna',
      'authorize-emergency',
      'close-emergency-debt',
    ]
    const required = [
      'bootstrap',
      'migrate-bluegreen',
      'knowledge-planet-verify',
      'baseline-remount',
      'install-monitor',
      'deploy',
      'dist',
      'enable-model-authority',
      'disable-model-authority',
      'enable-seed-authority-by-rev',
      'record-model-authority-emergency-drill',
      'model-authority-cutover',
      'enable-runtime-tape-batching',
      'emergency-tuple',
      'activate-emergency-tuple',
      'prepare-offline-cutover',
      'offline-recycle',
      'stage',
      'activate-staged',
      'canary',
      'promote',
      'finalize',
      'publish-luna',
      'future-write-mode',
    ]
    const classify = (mode: string) =>
      spawnSync(
        'bash',
        [
          '-c',
          'set +e; deploy_path="$1"; selected_mode="$2"; set --; V5_DEPLOY_SOURCE_ONLY=1 source "$deploy_path"; release_queue_required_for_mode "$selected_mode"; exit $?',
          'classify',
          deploy,
          mode,
        ],
        { cwd: root, encoding: 'utf8', env: { ...process.env, ALLOW_ANY_BRANCH: '1' } },
      )
    for (const mode of exempt) {
      assert.equal(classify(mode).status, 1, `${mode} should be queue-exempt`)
    }
    for (const mode of required) {
      assert.equal(classify(mode).status, 0, `${mode} should require the queue`)
    }

    const gate = source.indexOf('assert_development_release_queue || exit 3')
    const lock = source.indexOf('DEPLOY_HOLDER_OWNED=1', source.indexOf('OC_V5_DEPLOY_LOCK_FD'))
    const migrationGate = source.indexOf('assert_repo_required_migrations || exit 1')
    const productionLease = source.indexOf('acquire_production_mutation_lease || exit 3')
    assert.ok(lock >= 0 && gate > lock, 'release queue gate must run after the real local deploy lock')
    assert.ok(gate < migrationGate, 'release queue gate must run before migration probes')
    assert.ok(gate < productionLease, 'release queue gate must run before the remote mutation lease')
  })

  test('pinned SHA — not the shared worktree HEAD — decides what gets released', async () => {
    // 角色分离(2026-07-26)的成对契约。canonical 这棵树同时是"所有会话共享、随 base
    // 前进的开发 checkout"和"必须钉死的发布源";把后者从工作树活状态里摘出来之后,
    // 下面两半**必须同时存在**:
    //   · queue.assert 放宽为"pinned 是 HEAD 的祖先"(否则别人合一个 PR 就作废你的 job,
    //     而你占着唯一 active 槽 → 双向死锁);
    //   · deploy 按 pinned 显式取源(否则放宽 assert 就等于允许发出未 pin 的代码)。
    // 只留一半是净损失,所以这条测试把两半锁在一起。
    const queueSrc = await readFile(releaseQueue, 'utf8')
    const deploySrc = await readFile(deploy, "utf8")

    assert.match(
      queueSrc,
      /merge-base --is-ancestor "\$pinned" "\$current"/,
      'queue.assert 必须用祖先关系判定 pinned,而不是与共享工作树 HEAD 逐字节相等',
    )
    assert.match(queueSrc, /^\s*pinned-sha\)/m, 'queue 必须提供只读的 pinned-sha 出口供 deploy 取值')

    assert.match(
      deploySrc,
      /resolve_release_source_commit\(\)\s*\{/,
      'deploy 必须有「发布源 commit」的单一权威函数',
    )
    assert.match(
      deploySrc,
      /full_sha="\$\(resolve_release_source_commit\)"/,
      'build_release 必须经该函数取源,不得直接 rev-parse HEAD',
    )
    // build_release / build_platform_bundle 是 tuple 的两半,必须同源 —— 否则
    // release 按 pinned、bundle 按 HEAD,tuple 作为原子回滚单元就不再自洽。
    assert.match(
      deploySrc,
      /full_sha="\$\{BUILT_RELEASE_SOURCE_COMMIT:-\$\(resolve_release_source_commit\)\}"/,
      'build_platform_bundle 必须与 build_release 同源',
    )
    const buildRelease = deploySrc.indexOf('build_release() {')
    const strayHeadRead = deploySrc.indexOf('full_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"', buildRelease)
    assert.equal(
      strayHeadRead,
      -1,
      'build_release 之后不得再出现直接读 HEAD 的 full_sha 赋值(会绕过 pinned 取源)',
    )
  })

  test('selfheal inherited-lock bypass requires exact durable rrid, approved HEAD and cgroup scope', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-selfheal-queue-identity-'))
    dirs.push(dir)
    const db = path.join(dir, 'selfheal.db')
    const cgroup = path.join(dir, 'cgroup')
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    const create = spawnSync(
      'sqlite3',
      [
        db,
        `CREATE TABLE selfheal_release_jobs(
          release_request_id TEXT PRIMARY KEY,status TEXT,approved_sha TEXT,scope_unit TEXT);
         INSERT INTO selfheal_release_jobs VALUES('rrid-ok','deploying','${head}','scope-ok');`,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(create.status, 0, create.stderr)
    await writeFile(cgroup, '0::/system.slice/scope-ok.scope\n')
    const check = (rrid: string, dbPath = db, cgroupPath = cgroup) =>
      spawnSync(
        'bash',
        [
          '-c',
          [
            'set +e',
            'deploy_path="$1"',
            'rrid="$2"',
            'db_path="$3"',
            'cgroup_path="$4"',
            'set --',
            'V5_DEPLOY_SOURCE_ONLY=1 source "$deploy_path"',
            'OC_V5_SELFHEAL_RELEASE_REQUEST_ID="$rrid"',
            'OC_V5_SELFHEAL_DB="$db_path"',
            'OC_V5_SELFHEAL_CGROUP_FILE="$cgroup_path"',
            'assert_selfheal_release_identity',
          ].join('; '),
          'identity',
          deploy,
          rrid,
          dbPath,
          cgroupPath,
        ],
        { cwd: root, encoding: 'utf8', env: { ...process.env, ALLOW_ANY_BRANCH: '1' } },
      )
    assert.equal(check('').status, 1, 'missing rrid must fail')
    assert.equal(check('rrid-ok', path.join(dir, 'missing.db')).status, 1, 'missing ledger must fail')
    await writeFile(cgroup, '0::/system.slice/wrong.scope\n')
    assert.equal(check('rrid-ok').status, 1, 'wrong cgroup scope must fail')
    await writeFile(cgroup, '0::/system.slice/scope-ok.scope\n')
    const valid = check('rrid-ok')
    assert.equal(valid.status, 0, valid.stderr || valid.stdout)
    assert.match(valid.stdout, /ledger\+canonical SHA\+cgroup scope/)
  })
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
  const commandPids = path.join(dir, 'command-pids')
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
      'while [[ "${1:-}" == "-o" ]]; do',
      '  [[ $# -ge 2 ]] || exit 2',
      '  shift 2',
      'done',
      '[[ $# -ge 2 ]] || exit 2',
      'shift',
      'remote_out=""',
      'if [[ "${FAKE_SSH_BUFFER_OUTPUT_UNTIL_REMOTE_EXIT:-0}" == 1 ]]; then',
      '  remote_out="$(mktemp)"',
      '  bash -c "$1" >"$remote_out" &',
      'else',
      '  bash -c "$1" &',
      'fi',
      'remote_pid=$!',
      'printf "%s\\n" "$remote_pid" >>"$FAKE_REMOTE_PIDS"',
      "trap 'exit 0' HUP INT TERM",
      'wait "$remote_pid"',
      'rc=$?',
      'if [[ -n "$remote_out" ]]; then cat "$remote_out"; rm -f -- "$remote_out"; fi',
      'delay="${FAKE_SSH_EXIT_DELAY_SECONDS:-0}"',
      '[[ "$delay" == 0 ]] || sleep "$delay"',
      'exit "$rc"',
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
    commandPids,
    wrapper,
    command,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      KL_HOST: 'fake-manual-lease',
      FAKE_SSH_PIDS: sshPids,
      FAKE_REMOTE_PIDS: remotePids,
      COMMAND_PIDS: commandPids,
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

async function allRecordedProcessesExited(pidFile: string): Promise<boolean> {
  const raw = await readFile(pidFile, 'utf8').catch(() => '')
  const pids = raw.split(/\s+/).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 1)
  if (pids.length === 0) return false
  return pids.every((pid) => {
    try { process.kill(pid, 0); return false } catch { return true }
  })
}

function childProcessGroupLeader(parentPid: number): number | undefined {
  const out = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid='], { encoding: 'utf8' }).stdout
  for (const line of out.split('\n')) {
    const [pidRaw, ppidRaw, pgidRaw] = line.trim().split(/\s+/)
    const pid = Number(pidRaw)
    if (Number(ppidRaw) === parentPid && Number(pgidRaw) === pid && pid > 1) return pid
  }
  return undefined
}

async function writeStubbornManualCommand(fx: Awaited<ReturnType<typeof manualLeaseFixture>>): Promise<string> {
  const command = path.join(fx.dir, 'stubborn-command.sh')
  await writeFile(command, [
    '#!/bin/bash',
    "trap '' TERM",
    'printf "%s\\n" "$BASHPID" >>"$COMMAND_PIDS"',
    '(',
    "  trap '' TERM",
    '  printf "%s\\n" "$BASHPID" >>"$COMMAND_PIDS"',
    '  while :; do sleep 0.1; done',
    ') &',
    ': >"$COMMAND_STARTED"',
    'while :; do sleep 0.1; done',
  ].join('\n') + '\n')
  await chmod(command, 0o755)
  return command
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
    const turnCanary = body.indexOf('minimum_functional_core deploy "$BUILT_RELEASE" "$ACTIVE_PORT"')
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
    // 最小功能核(双引擎真 turn + J1-J5 旅程)紧随 full smoke(2026-07-17 goal 事故 +
    // 2026-07-26 出口矩阵整改);零接触收尾分支必须在 seed 之前(门未关/未审批 → 不 seed 直接完成)。
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
      'MUTATION_LEASE_BYPASSED=1',
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
      'MUTATION_LEASE_BYPASSED=1',
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
    assert.ok(migrate.indexOf('install_v5_slot_units') < migrate.indexOf('systemctl stop "$unit"'))
    const unitInstall = source.match(/install_v5_slot_units\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(unitInstall, /if ! systemctl is-active --quiet '\$V5_BASELINE_PORT_GUARD_SOCKET'; then[\s\S]*systemctl start '\$V5_BASELINE_PORT_GUARD_SOCKET'/)
    assert.doesNotMatch(unitInstall, /systemctl restart[^\n]*V5_BASELINE_PORT_GUARD_SOCKET/)
    assert.match(source, /assert_v5_baseline_port_guard/)
    assert.match(source, /probe\.bind\(\("0\.0\.0\.0", port\)\)/)
    assert.match(source, /RELEASE_GC_SCRIPT=.*v5-release-gc\.sh/)
    assert.match(source, /gc_rc" in[\s\S]*75\)[\s\S]*首个 rm 前安全跳过整轮删除/)

    const build = source.match(/build_release\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.ok(
      build.indexOf('harden_release_baseline "$staging"') >
        build.indexOf('npm run build --workspace packages/web-react'),
    )
    assert.ok(build.indexOf('harden_release_baseline "$staging"') < build.indexOf('publish_strong_release'))
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

  test('requiredMigrations gate covers forward writes while recovery stays target-scoped', async () => {
    const metadata = JSON.parse(await readFile(path.join(root, 'deploy/v5/release-metadata.json'), 'utf8')) as {
      minimumRequiredMigration: string
      requiredMigrations: string[]
    }
    assert.ok(metadata.requiredMigrations.includes('0135_deploy_state'))
    assert.ok(metadata.requiredMigrations.includes('0153_marketplace_plugin_kernel'))
    assert.ok(metadata.requiredMigrations.includes('0168_knowledge_planet_automation'))
    const migrationDir = path.join(root, 'packages/commercial/src/db/migrations')
    const expected = (await readdir(migrationDir))
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -4))
      .filter((version) => version >= metadata.minimumRequiredMigration)
      .sort()
    assert.deepEqual(metadata.requiredMigrations, expected)
    const source = await readFile(deploy, 'utf8')
    const gateAt = source.indexOf('assert_repo_required_migrations || exit 1')
    const dispatchAt = source.indexOf('case "$MODE" in', gateAt)
    assert.ok(gateAt > 0 && dispatchAt > gateAt, '统一迁移门必须在模式 dispatch 前')
    assert.match(source, /activate_release\(\)[\s\S]*assert_release_required_migrations "\$reldir"/)
    assert.match(source, /rollback_runtime_tuple\(\)[\s\S]*assert_release_required_migrations "\$master"/)
    assert.match(source, /abort_continue\(\)[\s\S]*assert_release_required_migrations "\$old_release"/)

    const dry = run(deploy, ['--dry-run'])
    assert.equal(dry.status, 0, dry.stderr || dry.stdout)
    const combined = dry.stdout + dry.stderr
    assert.ok(combined.indexOf('校验 requiredMigrations 已全部记录') < combined.indexOf('建 release'))
    for (const mode of ['--abort', '--rollback', '--recover', '--hide-luna']) {
      const recovery = run(deploy, ['--dry-run', mode])
      assert.equal(recovery.status, 0, `${mode}: ${recovery.stderr || recovery.stdout}`)
      assert.doesNotMatch(
        recovery.stdout + recovery.stderr,
        /校验 requiredMigrations 已全部记录/,
        `${mode} must not depend on forward migrations declared only by current HEAD`,
      )
    }
  })

  test('post-finalize egress handoff refreshes the committed active lane before smoke or rollback', () => {
    const harness = [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'DRY=0',
      'SCENARIO=success',
      'calls=()',
      'ds_load() {',
      '  DS_generation=42; DS_phase=stable; DS_active_slot=B; DS_candidate_slot=""',
      '  DS_active_release=/rel/newB; DS_candidate_release=""; DS_desired_leader_slot=B',
      '  DS_desired_control_slot=B; DS_cohort_percent=0; DS_cohort_salt=s',
      '  DS_transition_step=0; DS_operation_id=""; DS_lock_version=51',
      '  DS_previous_active_release=/rel/oldA',
      '}',
      'ds_snapshot() { ds_load; }',
      'ds_exec() {',
      '  local sql; sql="$(cat)"',
      '  if [[ "$sql" == *"SELECT release_id ||"* ]]; then printf "%s\\n" "/rel/newB|/rel/egress-old"',
      '  elif [[ "$sql" == *"status=\'active\'"* && "$sql" == *"SELECT count(*)"* ]]; then printf "1\\n"',
      '  fi',
      '}',
      'current_egress_release() { printf "%s\\n" /rel/egress-old; }',
      'activate_egress_release() { calls+=("activate:$1:$2"); }',
      'assert_release_required_migrations() {',
      '  calls+=("migration:$1")',
      '  [[ "$1" == /rel/newB && "$SCENARIO" != migration-fail ]]',
      '}',
      'smoke() {',
      '  calls+=("smoke:$1:$ACTIVE_SLOT:$ACTIVE_STATE_RELEASE")',
      '  [[ "$SCENARIO" != smoke-fail ]]',
      '}',
      'rollback() { calls+=("rollback:$ACTIVE_SLOT:$ACTIVE_STATE_RELEASE:$ACTIVE_STATE_PREVIOUS_RELEASE"); }',
      'run_case() {',
      '  SCENARIO="$1"; calls=()',
      '  ACTIVE_STATE_LOADED=1; ACTIVE_SLOT=A; ACTIVE_SRC=/slot/a; ACTIVE_UNIT=unit-a; ACTIVE_PORT=18790',
      '  ACTIVE_STATE_PHASE=finalizing; ACTIVE_STATE_RELEASE=/rel/oldA; ACTIVE_STATE_PREVIOUS_RELEASE=/rel/older',
      '  if finalize_ready_egress_transition; then rc=0; else rc=$?; fi',
      '  printf "%s|rc=%s|%s\\n" "$SCENARIO" "$rc" "${calls[*]}"',
      '}',
      'run_case success',
      'run_case smoke-fail',
      'run_case migration-fail',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1' },
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(
      result.stdout,
      /success\|rc=0\|migration:\/rel\/newB activate:\/rel\/newB:\/rel\/egress-old smoke:18795:B:\/rel\/newB/,
    )
    assert.match(
      result.stdout,
      /smoke-fail\|rc=1\|migration:\/rel\/newB activate:\/rel\/newB:\/rel\/egress-old smoke:18795:B:\/rel\/newB rollback:B:\/rel\/newB:\/rel\/oldA activate:\/rel\/egress-old:\/rel\/newB/,
    )
    assert.match(
      result.stdout,
      /migration-fail\|rc=1\|migration:\/rel\/newB rollback:B:\/rel\/newB:\/rel\/oldA/,
    )
  })

  test('requiredMigrations manifest is exact for the target release archive, including rollback fixtures', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-migration-manifest-')); dirs.push(dir)
    const release = path.join(dir, 'old-release')
    const migrations = path.join(release, 'packages/commercial/src/db/migrations')
    const metadataDir = path.join(release, 'deploy/v5')
    await mkdir(migrations, { recursive: true })
    await mkdir(metadataDir, { recursive: true })
    await writeFile(path.join(migrations, '0123_first.sql'), '-- old release\n')
    await writeFile(path.join(migrations, '0124_second.sql'), '-- old release\n')
    const metadata = path.join(metadataDir, 'release-metadata.json')
    await writeFile(metadata, JSON.stringify({
      minimumRequiredMigration: '0123_first',
      requiredMigrations: ['0123_first', '0124_second'],
    }))
    const invoke = (file: string) => spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      `required_migrations_csv '${file}' local`,
    ].join('\n')], { cwd: root, encoding: 'utf8', env: { ...process.env, ALLOW_ANY_BRANCH: '1' } })
    const valid = invoke(metadata)
    assert.equal(valid.status, 0, valid.stderr)
    assert.equal(valid.stdout, '0123_first,0124_second')
    // A migration introduced only in today's checkout is correctly irrelevant
    // to this old immutable archive; omitting a file that IS in the archive is not.
    await writeFile(metadata, JSON.stringify({
      minimumRequiredMigration: '0123_first', requiredMigrations: ['0123_first'],
    }))
    const omitted = invoke(metadata)
    assert.notEqual(omitted.status, 0)
    assert.match(omitted.stderr, /requiredMigrations mismatch/)
  })

  test('remote legacy migration manifests are scoped to the exact captured predecessor', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-legacy-migration-manifest-')); dirs.push(dir)
    const releasesRoot = path.join(dir, 'releases')
    const release = path.join(releasesRoot, 'rel-ccd3e7e0-legacy')
    const migrations = path.join(release, 'packages/commercial/src/db/migrations')
    const metadataDir = path.join(release, 'deploy/v5')
    await mkdir(migrations, { recursive: true })
    await mkdir(metadataDir, { recursive: true })
    await writeFile(path.join(release, '.complete'), '{"sha":"ccd3e7e0"}\n')

    // Exact release-metadata.json shape shipped by ccd3e7e0: it predates
    // minimumRequiredMigration and its curated list is intentionally not sorted.
    const legacyMetadata = {
      databaseCompatibility: 'backward-compatible',
      requiredMigrations: [
        '0123_gpt56_models',
        '0124_gpt56_xhigh_defaults',
        '0134_sessions_master_pg',
        '0133_selfheal_incidents',
        '0134_selfheal_condition_concurrency',
        '0135_selfheal_hardening',
        '0135_deploy_state',
        '0137_selfheal_user_notice_approval',
        '0143_model_catalog',
        '0144_model_authority_guards',
        '0145_retire_legacy_incident_notices',
        '0146_connector_ai_declarative_verification',
        '0147_lossless_turn_tapes',
        '0148_inbox_rich_assets',
        '0149_audit_hardening',
        '0150_agent_tool_rollups',
        '0151_product_friction_events',
        '0152_marketplace_capability_bindings',
        '0153_marketplace_plugin_kernel',
        '0154_model_admin_audit_returning_grant',
        '0155_selfheal_drill_policy',
        '0156_selfheal_execution_routing',
        '0157_lossless_runtime_batches',
        '0158_skill_retrieval_shadow',
        '0159_goal_state',
        '0163_plugin_write_control',
        '0164_admin_audit_model_admin_grant',
        '0166_prompt_queue',
        '0167_turn_waiver_receipts',
        '0168_knowledge_planet_automation',
        '0169_plugin_write_preapproval',
        '0170_durable_turn_dispatch',
      ],
      capabilities: [
        'sessions-store-pg-v1',
        'dual-master-v1',
        'model_authority_v1',
        'model_authority_v1-egress',
        'lossless-turn-tape-v2',
        'lossless-turn-runtime-batch-v1',
        'durable-turn-dispatch-v1',
      ],
      runtimeCapabilities: [
        'model_authority_v1',
        'lossless-turn-tape-v2',
        'durable-turn-dispatch-v1',
      ],
      bridgeFrameSchema: '1',
      runtimeApi: '1',
    }
    for (const migration of legacyMetadata.requiredMigrations) {
      await writeFile(path.join(migrations, `${migration}.sql`), '-- legacy release\n')
    }
    const metadata = path.join(metadataDir, 'release-metadata.json')
    const invoke = (location: 'local' | 'remote', trustPredecessor = true) => spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      `RELEASES_ROOT='${releasesRoot}'`,
      `TRUSTED_LEGACY_PREDECESSOR=${trustPredecessor ? `'${release}'` : "''"}`,
      "ssh() { local _host=\"$1\"; shift; \"$@\"; }",
      `required_migrations_csv '${metadata}' ${location}`,
    ].join('\n')], { cwd: root, encoding: 'utf8', env: { ...process.env, ALLOW_ANY_BRANCH: '1' } })

    await writeFile(metadata, JSON.stringify(legacyMetadata))
    const untrustedLegacy = invoke('remote', false)
    assert.notEqual(untrustedLegacy.status, 0)
    assert.match(untrustedLegacy.stderr, /exact captured predecessor/)

    const legacyRemote = invoke('remote')
    assert.equal(legacyRemote.status, 0, legacyRemote.stderr)
    assert.equal(legacyRemote.stdout, legacyMetadata.requiredMigrations.join(','))

    const legacyLocal = invoke('local')
    assert.notEqual(legacyLocal.status, 0)
    assert.match(legacyLocal.stderr, /invalid minimumRequiredMigration/)

    await writeFile(metadata, JSON.stringify({
      ...legacyMetadata,
      capabilities: [...legacyMetadata.capabilities, 'history-projection-revision-v1'],
    }))
    const capableWithoutFloor = invoke('remote')
    assert.notEqual(capableWithoutFloor.status, 0)
    assert.match(capableWithoutFloor.stderr, /legacy migration manifest cannot declare a post-floor history capability/)

    await writeFile(metadata, JSON.stringify({
      ...legacyMetadata,
      requiredMigrations: [...legacyMetadata.requiredMigrations, legacyMetadata.requiredMigrations[0]],
    }))
    const duplicate = invoke('remote')
    assert.notEqual(duplicate.status, 0)
    assert.match(duplicate.stderr, /invalid legacy requiredMigrations/)
  })

  test('strong release markers detect tampering and legacy trust is exact-invocation predecessor only', async () => {
    const deploySource = await readFile(deploy, 'utf8')
    assert.match(deploySource, /write_strong_release_marker_local\(\)[\s\S]*schemaVersion:\$schemaVersion[\s\S]*sourceCommit:\$sourceCommit[\s\S]*metadataSha256:\$metadataSha256[\s\S]*artifactSha256:\$artifactSha256/)
    assert.match(deploySource, /activate_release\(\)[\s\S]*assert_release_marker "\$reldir"[\s\S]*assert_release_required_migrations "\$reldir"/)
    assert.match(deploySource, /rollback_runtime_tuple\(\)[\s\S]*assert_release_marker "\$master"[\s\S]*assert_release_required_migrations "\$master"/)
    const captureAt = deploySource.lastIndexOf('capture_trusted_release_predecessor || exit 1')
    assert.ok(captureAt > deploySource.lastIndexOf('acquire_production_mutation_lease || exit 3'))
    assert.ok(captureAt < deploySource.lastIndexOf('run_mutation_lane_supervised run_selected_mode'))
    const egressCaptureAt = deploySource.lastIndexOf('capture_trusted_egress_predecessor || exit 1')
    assert.ok(egressCaptureAt > deploySource.lastIndexOf('acquire_production_mutation_lease || exit 3'))
    assert.ok(egressCaptureAt < deploySource.lastIndexOf('run_mutation_lane_supervised run_selected_mode'))

    const dir = await mkdtemp(path.join(tmpdir(), 'v5-release-marker-')); dirs.push(dir)
    const releasesRoot = path.join(dir, 'releases')
    await mkdir(releasesRoot)
    const full = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    const short = full.slice(0, 8)
    const metadataRaw = spawnSync(
      'git', ['show', `${full}:deploy/v5/release-metadata.json`],
      { cwd: root, encoding: 'utf8' },
    ).stdout
    assert.match(full, /^[0-9a-f]{40}$/)
    assert.ok(metadataRaw.length > 0)

    const makeRelease = async (builtAt: string) => {
      const release = path.join(releasesRoot, `rel-${short}-${builtAt}`)
      await mkdir(path.join(release, 'deploy/v5'), { recursive: true })
      await mkdir(path.join(release, 'node_modules'), { recursive: true })
      await mkdir(path.join(release, 'packages/web-react/dist'), { recursive: true })
      await writeFile(path.join(release, 'deploy/v5/release-metadata.json'), metadataRaw)
      await writeFile(path.join(release, 'VERSION.json'), JSON.stringify({ commit: short }))
      await writeFile(path.join(release, 'package.json'), '{}\n')
      await writeFile(path.join(release, 'node_modules/dependency.js'), 'module.exports = 1\n')
      await writeFile(path.join(release, 'packages/web-react/dist/index.html'), '<html>fixture</html>\n')
      return release
    }
    const invoke = (command: string) => spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      `RELEASES_ROOT='${releasesRoot}'`,
      'KL_HOST=fake',
      'ssh() { local _host="$1"; shift; if [[ $# == 1 ]]; then bash -c "$1"; else "$@"; fi; }',
      command,
    ].join('\n')], { cwd: root, encoding: 'utf8', env: { ...process.env, ALLOW_ANY_BRANCH: '1' } })

    const strong = await makeRelease('20260719-010203')
    const artifact = invoke(`release_artifact_digest '${strong}'`)
    assert.equal(artifact.status, 0, artifact.stderr)
    const marker = {
      schemaVersion: 2,
      sourceCommit: full,
      builtAt: '20260719-010203',
      metadataSha256: createHash('sha256').update(metadataRaw).digest('hex'),
      artifactSha256: artifact.stdout.trim(),
    }
    await writeFile(path.join(strong, '.complete'), JSON.stringify(marker))
    const validStrong = invoke(`assert_release_marker '${strong}'`)
    assert.equal(validStrong.status, 0, validStrong.stderr)

    const hardenedStrong = await makeRelease('20260719-010206')
    await chmod(hardenedStrong, 0o775)
    const publishHardened = invoke([
      `write_strong_release_marker_local '${hardenedStrong}' '${full}' '${short}' '20260719-010206' 2`,
      `[[ "$(stat -c '%u:%g:%a' -- '${hardenedStrong}')" == '0:0:755' ]]`,
      `[[ "$(stat -c '%u:%g:%a' -- '${hardenedStrong}/.complete')" == '0:0:644' ]]`,
      `assert_release_marker '${hardenedStrong}'`,
    ].join('\n'))
    assert.equal(publishHardened.status, 0, publishHardened.stderr)

    await chmod(path.join(strong, '.complete'), 0o666)
    const writableMarker = invoke(`assert_release_marker '${strong}'`)
    assert.notEqual(writableMarker.status, 0)
    assert.match(writableMarker.stderr, /marker ownership\/mode 不可信/)
    await chmod(path.join(strong, '.complete'), 0o644)

    await chmod(strong, 0o775)
    const writableRoot = invoke(`assert_release_marker '${strong}'`)
    assert.notEqual(writableRoot.status, 0)
    assert.match(writableRoot.stderr, /root ownership\/mode 不可信/)
    await chmod(strong, 0o755)

    await writeFile(path.join(strong, 'node_modules/dependency.js'), 'module.exports = 2\n')
    const artifactTamper = invoke(`assert_release_marker '${strong}'`)
    assert.notEqual(artifactTamper.status, 0)
    assert.match(artifactTamper.stderr, /artifact digest mismatch/)
    await writeFile(path.join(strong, 'node_modules/dependency.js'), 'module.exports = 1\n')

    await writeFile(path.join(strong, '.complete'), JSON.stringify({
      ...marker,
      artifactSha256: 'f'.repeat(64),
    }))
    const markerMismatch = invoke(`assert_release_marker '${strong}'`)
    assert.notEqual(markerMismatch.status, 0)
    assert.match(markerMismatch.stderr, /artifact digest mismatch/)
    await writeFile(path.join(strong, '.complete'), JSON.stringify(marker))

    await writeFile(path.join(strong, 'deploy/v5/release-metadata.json'), `${metadataRaw}\n`)
    const metadataTamper = invoke(`assert_release_marker '${strong}'`)
    assert.notEqual(metadataTamper.status, 0)
    assert.match(metadataTamper.stderr, /metadata digest mismatch/)
    await writeFile(path.join(strong, 'deploy/v5/release-metadata.json'), metadataRaw)

    const legacy = await makeRelease('20260719-010204')
    await writeFile(path.join(legacy, '.complete'), JSON.stringify({ sha: short, builtAt: '20260719-010204' }))
    const unknownLegacy = invoke(`assert_release_marker '${legacy}'`)
    assert.notEqual(unknownLegacy.status, 0)
    assert.match(unknownLegacy.stderr, /非本 invocation 精确捕获.*predecessor/)
    const knownLegacy = invoke([
      `capture_trusted_release_predecessor '${legacy}'`,
      `assert_release_marker '${legacy}'`,
    ].join('\n'))
    assert.equal(knownLegacy.status, 0, knownLegacy.stderr)

    const changedLegacy = invoke([
      `capture_trusted_release_predecessor '${legacy}'`,
      `printf '%s\\n' 'module.exports = 9' > '${legacy}/node_modules/dependency.js'`,
      `assert_release_marker '${legacy}'`,
    ].join('\n'))
    assert.notEqual(changedLegacy.status, 0)
    assert.match(changedLegacy.stderr, /制品未变/)
    await writeFile(path.join(legacy, 'node_modules/dependency.js'), 'module.exports = 1\n')

    const otherLegacy = await makeRelease('20260719-010205')
    await writeFile(path.join(otherLegacy, '.complete'), JSON.stringify({ sha: short, builtAt: '20260719-010205' }))
    const wrongLegacy = invoke([
      `capture_trusted_release_predecessor '${legacy}'`,
      `assert_release_marker '${otherLegacy}'`,
    ].join('\n'))
    assert.notEqual(wrongLegacy.status, 0)
    assert.match(wrongLegacy.stderr, /非本 invocation 精确捕获.*predecessor/)

    const splitMasterAndEgress = invoke([
      `capture_trusted_release_predecessor '${legacy}'`,
      `capture_trusted_egress_predecessor '${otherLegacy}'`,
      `assert_release_marker '${legacy}'`,
      `assert_release_marker '${otherLegacy}' egress`,
    ].join('\n'))
    assert.equal(splitMasterAndEgress.status, 0, splitMasterAndEgress.stderr)
    const egressPinIsNotMasterTrust = invoke([
      `capture_trusted_release_predecessor '${legacy}'`,
      `capture_trusted_egress_predecessor '${otherLegacy}'`,
      `assert_release_marker '${otherLegacy}'`,
    ].join('\n'))
    assert.notEqual(egressPinIsNotMasterTrust.status, 0)
    assert.match(egressPinIsNotMasterTrust.stderr, /master predecessor/)
  })

  test('release artifact digest rejects a path added after its initial tree snapshot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-release-digest-race-')); dirs.push(dir)
    const release = path.join(dir, 'release')
    await mkdir(release)
    const large = path.join(release, 'a-large.bin')
    const added = path.join(release, 'z-added-after-snapshot')
    const truncate = spawnSync('truncate', ['-s', '64M', large], { encoding: 'utf8' })
    assert.equal(truncate.status, 0, truncate.stderr)
    const harness = [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'python3() {',
      '  command /usr/bin/python3 "$@" <&0 & local child=$!',
      '  (',
      '    while kill -0 "$child" 2>/dev/null; do',
      `      for fd in /proc/$child/fd/*; do [[ "$(readlink -f "$fd" 2>/dev/null || true)" == '${large}' ]] && { printf x > '${added}'; exit 0; }; done`,
      '    done',
      '  ) & local mutator=$!',
      '  local rc=0; wait "$child" || rc=$?; wait "$mutator" || true; return "$rc"',
      '}',
      `release_artifact_digest '${release}'`,
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ALLOW_ANY_BRANCH: '1' },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /release tree changed during digest/)
  })

  test('root typecheck and every dist build use the official web workspace gate', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    assert.match(pkg.scripts.typecheck, /typecheck --workspace packages\/web-react/)
    const source = await readFile(deploy, 'utf8')
    assert.doesNotMatch(source, /cd '\$staging\/packages\/web-react' && npx vite build/)
    assert.doesNotMatch(source, /cd '\$REPO_ROOT\/packages\/web-react' && npx vite build/)
    assert.match(source, /cd '\$staging' && npm run build --workspace packages\/web-react/)
    assert.match(source, /cd '\$REPO_ROOT' && npm run build --workspace packages\/web-react/)
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
      'MUTATION_LEASE_BYPASSED=1',
      'DRY=0',
      'KL_HOST=fake',
      'ACTIVE_SRC=/fixture/active',
      'ACTIVE_SLOT=A',
      'ACTIVE_UNIT=fixture.service',
      'ACTIVE_PORT=19999',
      'RELEASES_ROOT=/fixture/releases',
      'mark_deploy_recovery_required() { printf "RECOVERY:%s\\n" "$1"; }',
      'assert_web_storage_rollback_transition() { :; }',
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
      'MUTATION_LEASE_BYPASSED=1',
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
      'assert_release_marker() { :; }',
      'assert_release_required_migrations() { :; }',
      'assert_release_capability_for_sessions_pg() { :; }',
      'assert_lossless_turn_tape_floor() { :; }',
      'assert_model_authority_floor() { :; }',
      'assert_web_storage_rollback_transition() { :; }',
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
      'probe_release_direct_turn_timeline() {',
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

  test('browser storage bridge keeps first rollback open, then rejects legacy after two capable generations', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-web-storage-floor-')); dirs.push(dir)
    const legacy = path.join(dir, 'legacy')
    const capableA = path.join(dir, 'capable-a')
    const capableB = path.join(dir, 'capable-b')
    const malformed = path.join(dir, 'malformed')
    for (const release of [legacy, capableA, capableB, malformed]) {
      await mkdir(path.join(release, 'deploy/v5'), { recursive: true })
    }
    await writeFile(path.join(legacy, 'deploy/v5/release-metadata.json'),
      JSON.stringify({ capabilities: [] }))
    for (const release of [capableA, capableB]) {
      await writeFile(path.join(release, 'deploy/v5/release-metadata.json'),
        JSON.stringify({ capabilities: ['web-storage-rollback-safe-v1'] }))
    }
    await writeFile(path.join(malformed, 'deploy/v5/release-metadata.json'),
      JSON.stringify({ capabilities: 'web-storage-rollback-safe-v1' }))

    const invoke = (current: string, previous: string, target: string) => {
      const harness = [
        'set -u',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'DRY=0; KL_HOST=fake',
        'ssh() { shift; bash -c "$1"; }',
        'assert_web_storage_rollback_transition "$CURRENT" "$PREVIOUS" "$TARGET" test',
      ].join('\n')
      return spawnSync('bash', ['-c', harness], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ALLOW_ANY_BRANCH: '1', CURRENT: current, PREVIOUS: previous, TARGET: target },
      })
    }

    assert.equal(invoke(legacy, legacy, capableA).status, 0)
    assert.equal(invoke(capableA, legacy, legacy).status, 0,
      'first bridge generation must retain the official legacy rollback path')
    const blocked = invoke(capableA, capableB, legacy)
    assert.notEqual(blocked.status, 0)
    assert.match(blocked.stderr, /拒绝 browser storage 代际降级/)
    assert.equal(invoke(capableA, capableB, capableB).status, 0)
    assert.notEqual(invoke(capableA, capableB, malformed).status, 0)
  })

  test('browser storage floor runs before live traffic, maintenance, and symlink mutations', async () => {
    const source = await readFile(deploy, 'utf8')
    const activate = source.slice(
      source.indexOf('activate_release() {'),
      source.indexOf('\n# 传统 deploy/rollback', source.indexOf('activate_release() {')),
    )
    assert.ok(
      activate.indexOf('assert_web_storage_rollback_transition')
        < activate.indexOf('sync_assets_to_pool "$reldir"'),
    )

    const rollback = source.slice(
      source.indexOf('rollback() {'),
      source.indexOf('\n# tuple 感知回滚', source.indexOf('rollback() {')),
    )
    const tuplePreflight = rollback.indexOf('"tuple rollback preflight"')
    assert.ok(tuplePreflight >= 0 && tuplePreflight < rollback.indexOf('begin_planned_maintenance rollback 0'))
    const explicitPreflight = rollback.indexOf('"explicit rollback"')
    assert.ok(explicitPreflight >= 0 &&
      explicitPreflight < rollback.indexOf('begin_planned_maintenance rollback 0', explicitPreflight))

    const canary = source.slice(
      source.indexOf('canary() {'),
      source.indexOf('\n# ═════════', source.indexOf('canary() {') + 1),
    )
    assert.ok(
      canary.indexOf('"canary pre-start"') < canary.indexOf('sync_assets_to_pool "$reldir"'),
    )

    const abort = source.slice(
      source.indexOf('abort_continue() {'),
      source.indexOf('\n# ═════════ --recover', source.indexOf('abort_continue() {')),
    )
    assert.ok(abort.indexOf('"canary abort"') < abort.indexOf('caddy_render_reload'))
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
    const runtimeLibSource = await readFile(path.join(root, 'scripts/v5-runtime-release-lib.sh'), 'utf8')
    assert.match(source, /WHERE record_storage_format >= 3/,
      'an unfinalized format-3 pin must arm the deploy rollback floor')
    assert.doesNotMatch(source, /WHERE finalized_at IS NOT NULL AND record_storage_format >= 3/)
    assert.match(runtimeLibSource, /WHERE record_storage_format >= 3/,
      'hotcfg rollback must honor an unfinalized format-3 pin')
    assert.doesNotMatch(runtimeLibSource, /WHERE finalized_at IS NOT NULL AND record_storage_format >= 3/)
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

  test('ccb dist build fail-closes on await-using leakage (2026-05-22 crash-loop 机制化)', async () => {
    const runtimeLib = await readFile(path.join(root, 'scripts/v5-runtime-release-lib.sh'), 'utf8')
    const start = runtimeLib.indexOf('oc_hotcfg_build_ccb_dist()')
    const body = runtimeLib.slice(start, runtimeLib.indexOf('oc_hotcfg_finalize_release()', start))
    assert.ok(start >= 0 && body.length > 0, 'oc_hotcfg_build_ccb_dist 函数体未找到')

    // build.ts pin 了 target='node' 让 Bun 把 `await using` 降级成 ES2022 try/finally。
    // 该 pin 一旦被上游合并覆盖回 'bun'(或 bun 默认 target 漂移),dist 会残留
    // `await using` 字面量 → 容器 Node 22 的 V8 直接 SyntaxError,CCB 子进程在读第一行
    // stdin 前就 exit 1 = **全量用户 crash-loop**(v1.0.194 实发)。当年只 pin 了源码侧,
    // 构建期无门禁,同类回归会再次直达生产 —— 这个门就是补上的那一层。
    // 断言**整条命令形态**而不是分别断言两个片段:`--include='*.js'` 和 `await using` 都
    // 会在本函数的解释性注释里出现,分开断言会被注释满足 → 命令被改坏也照样绿
    // (2026-07-26 写这个测试时用红绿对照实测踩到)。
    // 同时这条断言覆盖三件事:门存在、只扫 .js(source map 内嵌原始源码文本,扫进去会
    // 100% 误报钉死部署门)、正则本体未被削弱。
    assert.match(
      body,
      /grep -rlE --include='\*\.js' '\(\^\|\[\^A-Za-z0-9_\$\]\)await\[\[:space:\]\]\+using\[\[:space:\]\]'/,
      "await-using 门的 grep 必须是 --include='*.js' + 完整边界正则(同一条命令内)",
    )

    // fail-closed:命中必须 die,不能只打日志放行。
    assert.ok(
      body.indexOf('await[[:space:]]+using') < body.indexOf('oc_hotcfg__die "ccb dist 残留'),
      'await-using 门必须 fail-closed(die),不能降级成告警',
    )

    // 门必须排在 dist 拷回 staging 之前,否则坏产物已经进 release 了。
    assert.ok(
      body.indexOf('oc_hotcfg__die "ccb dist 残留') < body.indexOf('cp -a "$ccb_build/dist"'),
      'await-using 门必须在 dist 拷回 staging 之前执行',
    )
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
    assert.match(deployBody, /egress_prev_release="\$CAPTURED_EGRESS_PREDECESSOR"/)
    assert.match(deployBody, /current_egress_cwd=.*systemctl show -p MainPID/)
    assert.match(deployBody, /current_egress_cwd" == "\$egress_prev_release/)
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

  test('online slim runtime image switch is paired, provenance-bound, and feeds the target immutable ID into release finalization', async () => {
    const image = 'openclaude/openclaude-runtime:v5-ccb-fcd3d67de4d0-slim'
    const imageId = `sha256:${'8'.repeat(64)}`
    const sourceCommit = 'fcd3d67de4d0678381aa50213be260fcf90010d5'
    for (const args of [
      [`--runtime-image=${image}`],
      [`--runtime-image-id=${imageId}`],
      [`--runtime-image=bad image`, `--runtime-image-id=${imageId}`],
      [`--runtime-image=${image}`, '--runtime-image-id=sha256:bad'],
      ['--smoke', `--runtime-image=${image}`, `--runtime-image-id=${imageId}`],
    ]) {
      const rejected = run(deploy, args)
      assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr)
    }

    const dir = await mkdtemp(path.join(tmpdir(), 'v5-runtime-image-switch-')); dirs.push(dir)
    await mkdir(path.join(dir, 'deploy/v5'), { recursive: true })
    await writeFile(
      path.join(dir, 'deploy/v5/commercial-v5.env.overrides'),
      `OC_RUNTIME_IMAGE=${image}\n`,
    )
    const capture = path.join(dir, 'finalize.args')
    const harness = [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      `REPO_ROOT='${dir}'`,
      `TARGET_RUNTIME_IMAGE='${image}'`,
      `TARGET_RUNTIME_IMAGE_ID='${imageId}'`,
      'DRY=0',
      'git() {',
      '  case "$*" in',
      `    *"cat-file -e ${sourceCommit}^"*) return 0 ;;`,
      `    *"merge-base --is-ancestor ${sourceCommit} HEAD"*) return "\${ANCESTOR_RC:-0}" ;;`,
      '    *"rev-parse HEAD"*) printf "%s\\n" pinned-commit ;;',
      '    *"show pinned-commit:deploy/v5/release-metadata.json"*) printf "%s\\n" "$PINNED_METADATA" ;;',
      '    *"archive --format=tar pinned-commit"*) : ;;',
      '    *) return 97 ;;',
      '  esac',
      '}',
      'hotcfg_release_axis_on() { return 0; }',
      'hotcfg_ship_lib() { :; }',
      'ssh() {',
      '  if [[ "$*" == *"docker image inspect"* && "$*" == *"source_commit"* ]]; then',
      `    printf '%s|%s|%s\\n' "\${ACTUAL_ID:-${imageId}}" "\${SOURCE_COMMIT:-${sourceCommit}}" "\${EMBED_SOURCE:-0}"`,
      '  elif [[ "$*" == *"docker image inspect"* ]]; then',
      `    printf '%s\\n' "\${ACTUAL_ID:-${imageId}}"`,
      '  elif [[ "$*" == *"OC_RUNTIME_RELEASE"* ]]; then',
      '    printf "%s\\n" /runtime/prev',
      '  else',
      '    cat >/dev/null || true',
      '  fi',
      '}',
      'assert_target_runtime_image_ready',
      'hotcfg_rmt() { printf "%s\\n" "$@" >"$CAPTURE"; printf "%s\\n" "$OC_HOTCFG_RELEASES_ROOT/rel-test"; }',
      'build_runtime_release',
    ].join('\n')
    const invoke = (env: NodeJS.ProcessEnv = {}) => spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_ANY_BRANCH: '1',
        CAPTURE: capture,
        PINNED_METADATA: JSON.stringify({
          runtimeCapabilities: ['model_authority_v1', 'future.runtime-cap'],
        }),
        ...env,
      },
    })

    const valid = invoke()
    assert.equal(valid.status, 0, valid.stderr || valid.stdout)
    const args = (await readFile(capture, 'utf8')).trim().split('\n')
    assert.equal(args[0], 'oc_hotcfg_finalize_release')
    assert.equal(args[2], imageId)

    for (const [env, pattern] of [
      [{ ACTUAL_ID: `sha256:${'9'.repeat(64)}` }, /immutable ID 漂移/],
      [{ EMBED_SOURCE: '1' }, /只接受 slim image/],
      [{ SOURCE_COMMIT: 'a'.repeat(40), ANCESTOR_RC: '1' }, /不是 canonical HEAD 的可验证 ancestor/],
    ] as const) {
      await writeFile(capture, '')
      const rejected = invoke(env)
      assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr)
      assert.match(rejected.stderr, pattern)
      assert.equal(await readFile(capture, 'utf8'), '', 'preflight failure must precede release finalization')
    }

    const source = await readFile(deploy, 'utf8')
    const preflight = source.slice(
      source.indexOf('assert_target_runtime_image_ready()'),
      source.indexOf('\n# ── 1. build_platform_bundle', source.indexOf('assert_target_runtime_image_ready()')),
    )
    const deployBody = source.slice(source.indexOf('deploy() {'), source.indexOf('\n# ───────────────────────── offline recycle'))
    assert.doesNotMatch(preflight, /sed -i|OC_RUNTIME_IMAGE=.*>>|oc_hotcfg_env_write_tuple/)
    assert.ok(
      deployBody.indexOf('assert_target_runtime_image_ready') < deployBody.indexOf('prepare_live_baseline_safety'),
      'target image provenance must be checked before live baseline/plugin mutations',
    )
    assert.match(
      source,
      /if \[\[ -n "\$TARGET_RUNTIME_IMAGE" \]\]; then[\s\S]*RUNTIME_IMAGE_REF="\$TARGET_RUNTIME_IMAGE"[\s\S]*RUNTIME_IMAGE_ID=.*docker image inspect/,
    )
    assert.match(
      source,
      /hotcfg_rmt oc_hotcfg_activate_saga[\s\S]*"\$image" "\$image_id" "\$release" "\$bundle_val"/,
    )
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
    assert.ok(meta.capabilities.includes('history-projection-revision-v1'))
    assert.ok(meta.capabilities.includes('direct-turn-timeline-v1'))
    assert.ok(meta.capabilities.includes('web-storage-rollback-safe-v1'))
    assert.ok(meta.requiredMigrations.includes('0157_lossless_runtime_batches'))
    assert.ok(meta.requiredMigrations.includes('0164_admin_audit_model_admin_grant'))
    assert.ok(meta.requiredMigrations.includes('0166_prompt_queue'))
    assert.ok(meta.requiredMigrations.includes('0167_turn_waiver_receipts'))
    assert.ok(meta.requiredMigrations.includes('0174_selfheal_release_safety_fences'))
    assert.ok(meta.requiredMigrations.includes('0175_client_session_history_revision'))
    assert.ok(meta.requiredMigrations.includes('0176_direct_turn_timeline'))
    assert.ok(meta.requiredMigrations.includes('0177_unified_client_timeline'))
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

  test('direct turn timeline capability blocks mixed readers/writers and unsafe downgrade', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-direct-timeline-')); dirs.push(dir)
    const legacy = path.join(dir, 'legacy')
    const capable = path.join(dir, 'capable')
    for (const [release, capabilities] of [
      [legacy, ['dual-master-v1']],
      [capable, ['dual-master-v1', 'direct-turn-timeline-v1']],
    ] as const) {
      await mkdir(path.join(release, 'deploy/v5'), { recursive: true })
      await writeFile(path.join(release, 'deploy/v5/release-metadata.json'), JSON.stringify({ capabilities }))
    }

    const invoke = (command: string) => spawnSync('bash', ['-c', [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'DRY=0; KL_HOST=fake; ACTIVE_UNIT=fake.service; ACTIVE_PORT=18890; V5_ENV=/fake/env',
      'ssh() {',
      '  local host="$1"; shift; local command="$*"',
      '  case "$command" in',
      '    *"metadata="*) bash -c "$command" ;;',
      '    *) printf "UNEXPECTED:%s\\n" "$command" >&2; return 90 ;;',
      '  esac',
      '}',
      'smoke() { printf "SMOKE\\n"; }',
      'mark_deploy_recovery_required() { printf "RECOVERY:%s\\n" "$*"; }',
      command,
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1' },
    })

    const mixed = invoke(`assert_direct_turn_timeline_pair '${legacy}' '${capable}' canary`)
    assert.notEqual(mixed.status, 0)
    assert.match(mixed.stderr, /代际不一致/)
    const same = invoke(`assert_direct_turn_timeline_pair '${capable}' '${capable}' canary`)
    assert.equal(same.status, 0, same.stderr)

    const firstAdoption = invoke(`prepare_direct_turn_timeline_activation '${capable}' '${legacy}'`)
    assert.equal(firstAdoption.status, 0, firstAdoption.stderr)
    const zeroRevisionDowngrade = invoke(`prepare_direct_turn_timeline_activation '${legacy}' '${capable}'`)
    assert.notEqual(zeroRevisionDowngrade.status, 0)
    assert.match(zeroRevisionDowngrade.stderr, /不可逆 direct turn timeline 降级/)
    assert.doesNotMatch(zeroRevisionDowngrade.stdout + zeroRevisionDowngrade.stderr, /STOP|RESTART/)

    const source = await readFile(deploy, 'utf8')
    const prepareBody = source.slice(
      source.indexOf('prepare_direct_turn_timeline_activation()'),
      source.indexOf('\n# Tri-state artifact probe', source.indexOf('prepare_direct_turn_timeline_activation()')),
    )
    assert.doesNotMatch(prepareBody, /systemctl stop|turn_dispatches/)
    assert.match(prepareBody, /即使当前没有失败行也存在首写竞态/)
    const activationBody = source.slice(
      source.indexOf('activate_release() {'),
      source.indexOf('\n# 传统 deploy/rollback', source.indexOf('activate_release() {')),
    )
    assert.ok(
      activationBody.indexOf('prepare_direct_turn_timeline_activation "$reldir" "$prev"')
        < activationBody.indexOf("mv -T '$tmplink' '$ACTIVE_SRC'"),
      'ordinary downgrade must hit the irreversible floor before the source flip',
    )
    const canaryLane = source.slice(
      source.indexOf('canary() {'),
      source.indexOf('\n# 内部账号 allowlist', source.indexOf('canary() {')),
    )
    assert.ok(
      canaryLane.indexOf('assert_direct_turn_timeline_pair "$DS_active_release" "$reldir" "canary pre-start"')
        < canaryLane.indexOf('start_candidate_unit_and_wait "$cand"'),
      'mixed timeline generations must be rejected before candidate start',
    )
    const recoveryBody = source.slice(
      source.indexOf('recover_cutover()'),
      source.indexOf('\nset_cutover_maintenance() {', source.indexOf('recover_cutover()')),
    )
    const transitionBody = source.slice(
      source.indexOf('cutover_transition()'),
      source.indexOf('\nbegin_cutover_step() {', source.indexOf('cutover_transition()')),
    )
    assert.ok(recoveryBody.indexOf('systemctl stop "$unit"') < recoveryBody.indexOf('current_direct_capability='))
    assert.ok(recoveryBody.indexOf('rollback_partial 1') < recoveryBody.indexOf('cp -al "$remote_src/." "$restore_dir/"'))

    const remoteScript = recoveryBody.match(/<<'REMOTE'\n([\s\S]*?)\nREMOTE/)?.[1]
    assert.ok(remoteScript, 'recover_cutover remote body not found')
    const fixture = await mkdtemp(path.join(tmpdir(), 'v5-direct-recovery-')); dirs.push(fixture)
    const cutoverRoot = path.join(fixture, 'cutovers')
    const nonce = 'a'.repeat(32)
    const bundle = path.join(cutoverRoot, nonce)
    const remoteSrc = path.join(fixture, 'current-source')
    const bin = path.join(fixture, 'bin')
    const marker = path.join(fixture, 'maintenance.json')
    const systemctlLog = path.join(fixture, 'systemctl.log')
    const envFile = path.join(fixture, 'current.env')
    const targetCommit = 'b'.repeat(40)
    const appliedSet = 'fixture_migration'
    const appliedHash = createHash('sha256').update(appliedSet).digest('hex')
    await mkdir(path.join(bundle, 'source/deploy/v5'), { recursive: true, mode: 0o700 })
    await chmod(bundle, 0o700)
    await mkdir(path.join(remoteSrc, 'deploy/v5'), { recursive: true })
    await mkdir(bin)
    const host = spawnSync('hostname', ['-f'], { encoding: 'utf8' }).stdout.trim()
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({
      host,
      nonce,
      old_image: 'fixture:image',
      old_image_id: 'sha256:fixture',
      target_commit: targetCommit,
      database_compatibility: 'backward-compatible',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      target_image: 'fixture:image',
      target_image_id: 'sha256:fixture',
      applied_migrations_hash: appliedHash,
    }), { mode: 0o600 })
    await writeFile(path.join(bundle, 'commercial-v5.env'), 'DATABASE_URL=postgres://unused\n', { mode: 0o600 })
    await writeFile(path.join(bundle, 'state.json'), JSON.stringify({
      state: 'activating', candidate_start_attempted: true,
    }), { mode: 0o600 })
    await writeFile(path.join(bundle, 'source/deploy/v5/release-metadata.json'), JSON.stringify({
      capabilities: ['durable-turn-dispatch-v1'],
    }))
    await writeFile(path.join(remoteSrc, 'deploy/v5/release-metadata.json'), JSON.stringify({
      capabilities: ['durable-turn-dispatch-v1', 'history-projection-revision-v1', 'direct-turn-timeline-v1'],
    }))
    await writeFile(envFile, 'DATABASE_URL=postgres://unused\nCURRENT=1\n', { mode: 0o600 })
    await writeFile(marker, JSON.stringify({ schema: 1, nonce }))
    await writeFile(path.join(bin, 'docker'), [
      '#!/bin/sh',
      'printf "%s\\n" sha256:fixture',
    ].join('\n') + '\n')
    await writeFile(path.join(bin, 'systemctl'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >>"$SYSTEMCTL_LOG"',
    ].join('\n') + '\n')
    await writeFile(path.join(bin, 'curl'), [
      '#!/bin/sh',
      'printf "%s\\n" \'{"ok":true,"channel":"v5"}\'',
    ].join('\n') + '\n')
    await writeFile(path.join(bin, 'psql'), [
      '#!/bin/sh',
      'printf "%s\\n" "$APPLIED_SET"',
    ].join('\n') + '\n')
    await chmod(path.join(bin, 'docker'), 0o755)
    await chmod(path.join(bin, 'systemctl'), 0o755)
    await chmod(path.join(bin, 'curl'), 0o755)
    await chmod(path.join(bin, 'psql'), 0o755)
    const transitionScript = transitionBody.match(/<<'REMOTE'\n([\s\S]*?)\nREMOTE/)?.[1]
    assert.ok(transitionScript, 'cutover_transition remote body not found')
    const transitioned = spawnSync('bash', ['-c', transitionScript!, '--',
      cutoverRoot,
      path.join(fixture, 'cutover.lock'),
      nonce,
      targetCommit,
      'activating',
      'activated',
      envFile,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APPLIED_SET: appliedSet },
    })
    assert.equal(transitioned.status, 0, transitioned.stderr || transitioned.stdout)
    const activatedState = JSON.parse(await readFile(path.join(bundle, 'state.json'), 'utf8'))
    assert.equal(activatedState.state, 'activated')
    assert.equal(activatedState.candidate_start_attempted, true)
    const recovered = spawnSync('bash', ['-c', remoteScript!, '--',
      cutoverRoot,
      path.join(fixture, 'cutover.lock'),
      nonce,
      remoteSrc,
      envFile,
      `openclaude-v5-direct-test-${process.pid}.service`,
      '18890',
      marker,
      path.join(fixture, 'maintenance.lock'),
      'direct-turn-timeline-v1',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYSTEMCTL_LOG: systemctlLog },
    })
    assert.notEqual(recovered.status, 0)
    assert.match(recovered.stderr, /refusing irreversible direct turn timeline downgrade/)
    assert.match(await readFile(systemctlLog, 'utf8'), /stop .*\ndaemon-reload\nstart /)
    await assert.rejects(readFile(marker, 'utf8'))
    const currentMeta = JSON.parse(await readFile(path.join(remoteSrc, 'deploy/v5/release-metadata.json'), 'utf8'))
    assert.ok(currentMeta.capabilities.includes('direct-turn-timeline-v1'))

    // A stage/pre-start failure may leave capable metadata in a partial source,
    // but it never served. The durable marker is the authority: restore the
    // trusted legacy bundle instead of starting the half-staged tree.
    await writeFile(path.join(bundle, 'state.json'), JSON.stringify({
      state: 'staging', candidate_start_attempted: false,
    }), { mode: 0o600 })
    await writeFile(marker, JSON.stringify({ schema: 1, nonce }))
    await writeFile(systemctlLog, '')
    const preStartRecovery = spawnSync('bash', ['-c', remoteScript!, '--',
      cutoverRoot,
      path.join(fixture, 'cutover.lock'),
      nonce,
      remoteSrc,
      envFile,
      `openclaude-v5-direct-test-${process.pid}.service`,
      '18890',
      marker,
      path.join(fixture, 'maintenance.lock'),
      'direct-turn-timeline-v1',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYSTEMCTL_LOG: systemctlLog },
    })
    assert.equal(preStartRecovery.status, 0, preStartRecovery.stderr || preStartRecovery.stdout)
    assert.match(await readFile(systemctlLog, 'utf8'), /stop .*\ndaemon-reload\nstart /)
    await assert.rejects(readFile(marker, 'utf8'))
    const restoredMeta = JSON.parse(await readFile(path.join(remoteSrc, 'deploy/v5/release-metadata.json'), 'utf8'))
    assert.ok(!restoredMeta.capabilities.includes('direct-turn-timeline-v1'))

    const stagedBody = source.slice(
      source.indexOf('activate_staged_inner()'),
      source.indexOf('\nactivate_staged() {', source.indexOf('activate_staged_inner()')),
    )
    assert.ok(
      stagedBody.indexOf('mark_cutover_candidate_start_attempted')
        < stagedBody.indexOf('systemctl start $V5_UNIT'),
      'candidate start evidence must commit before the first start attempt',
    )
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
        'MUTATION_LEASE_BYPASSED=1',
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
      'MUTATION_LEASE_BYPASSED=1',
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
      'MUTATION_LEASE_BYPASSED=1',
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
        'MUTATION_LEASE_BYPASSED=1',
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
      // 2026-07-26 安全整改:/assets 处理块内嵌 route + `@sourcemap path *.map` +
      // `respond @sourcemap 404`,golden 随之更新。改 golden 时必须同时看下面那条
      // sourcemap 结构断言 —— 只更 hash 不看内容等于把门关了。
      // (首版曾用"独立 handle 排在 /assets 之前"的写法,文本断言绿但线上照样 200 —— 
      //  adapter 按路径特异性重排,详见模板与下面那条测试的注释。)
      'fd659d46d64c42d341a494275127e1420d16883be47ad2ff43bdfe7efac85929',
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
    // 末位 0/1 = OC_DEPLOY_ONTO_UNHEALTHY 确认位(2026-07-26 审计 11 新增);默认 0 = fail-closed。
    assert.match(args, /\/var\/lib\/openclaude-v5\/cutovers 18081 0\n$/)
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
      'MUTATION_LEASE_BYPASSED=1',
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
      'MUTATION_LEASE_BYPASSED=1',
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
      'MUTATION_LEASE_BYPASSED=1',
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
  args?: string[]
  allHealthy?: boolean
  markerMode?: number
  marker?: Record<string, unknown>
  state?: Record<string, unknown>
  egressBad?: boolean
  conditions?: boolean
  schema1Manifest?: boolean
  deployState?: { phase: string; step: number; active: string; candidate?: string } | 'error'
  healthyHttpPorts?: number[]
  dockerRows?: string[]
  dockerPsFails?: boolean
  turnWindowStats?: string
  failedUnits?: string[]
}

describe('v5 daily report fanout accounting', () => {
  test('anomaly fanout cannot hide a zero-target daily heartbeat', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-daily-fanout-'))
    dirs.push(dir)
    const bin = path.join(dir, 'bin')
    const log = path.join(dir, 'daily.log')
    const calls = path.join(dir, 'psql-calls')
    const envFile = path.join(dir, 'commercial-v5.env')
    await mkdir(bin)
    await writeFile(envFile, 'DATABASE_URL=postgres://fixture\n')
    await writeFile(path.join(bin, 'psql'), `#!/bin/sh
printf '%s\\n' "$*" >>"$PSQL_CALLS"
case "$*" in
  *"event_type=ops.daily_report"*) cat >/dev/null; echo "fanout targets=0 inserted=0 suppressed=0" ;;
  *"event_type=ops.daily_anomaly"*) cat >/dev/null; echo "fanout targets=1 inserted=1 suppressed=0" ;;
  *) cat >/dev/null ;;
esac
`)
    await writeFile(path.join(bin, 'sqlite3'), '#!/bin/sh\necho "0|0"\n')
    await chmod(path.join(bin, 'psql'), 0o755)
    await chmod(path.join(bin, 'sqlite3'), 0o755)

    const result = run(dailyCheck, [], {
      PATH: `${bin}:${process.env.PATH}`,
      PSQL_CALLS: calls,
      V5DAY_ENV_FILE: envFile,
      V5DAY_LOG_FILE: log,
      V5DAY_SESSIONS_DB: path.join(dir, 'sessions.db'),
      V5DAY_V5_LOG: path.join(dir, 'v5.log'),
      V5DAY_V5_LOG_YDAY: path.join(dir, 'v5.log.1'),
      V5DAY_FANOUT_SQL: path.join(root, 'scripts/v5-alert-fanout.sql'),
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const [logText, psqlCalls] = await Promise.all([
      readFile(log, 'utf8'),
      readFile(calls, 'utf8'),
    ])
    assert.match(logText, /FANOUT-ZERO ops\.daily_report sev=info/)
    assert.match(logText, /FANOUT-OK ops\.daily_anomaly sev=warning targets=1 inserted=1/)
    assert.match(logText, /HEARTBEAT-NOT-PUSHED ops\.daily_report 匹配 0 个通道/)
    assert.match(psqlCalls, /心跳未推送:本条日报\(info\)匹配到 \*\*0\*\* 个可投递通道/)
  })
})

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
    args = ['--dry-run'],
    allHealthy = false,
    markerMode = 0o600,
    marker = schema1Marker(),
    state = { checks: {} },
    egressBad = false,
    conditions = false,
    schema1Manifest = true,
    deployState = { phase: 'stable', step: 0, active: 'A' },
    healthyHttpPorts = allHealthy ? [18790] : [],
    dockerRows = [],
    dockerPsFails = false,
    turnWindowStats: explicitTurnWindowStats,
    failedUnits = [],
  } = options
  const turnWindowStats = explicitTurnWindowStats ?? (allHealthy ? '0|0|0|0' : undefined)
  const dir = await mkdtemp(path.join(tmpdir(), 'v5-monitor-safety-')); dirs.push(dir)
  // 夹具内的"健康备份"目录:一个 mtime=当下的子目录即满足 backup_fresh 的新鲜度判据。
  const backupDir = path.join(dir, 'backups')
  spawnSync('mkdir', ['-p', path.join(backupDir, 'v5-fixture-fresh')])
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
  const psqlCalls = path.join(dir, 'psql-calls')
  const scripts: Record<string, string> = {
    systemctl: `#!/bin/sh
case "$1" in
  list-units)
    case "$*" in
      *--state=failed*) ${failedUnits.map((unit) => `printf '%s\\n' '${unit} loaded failed failed fixture'`).join('; ') || ':'} ;;
    esac
    exit 0
    ;;
  is-active)
    case "$2" in
      ${allHealthy ? '__never__' : `openclaude-v5${egressBad ? '|openclaude-v5-egress' : ''}`}) echo inactive; exit 3 ;;
      *) echo active; exit 0 ;;
    esac
    ;;
  *) echo active ;;
esac
`,
    curl: `#!/bin/sh
case "$*" in
  ${egressBad ? '' : '*18892*) echo \'{"ok":true,"role":"egress"}\';;'}
  ${healthyHttpPorts.map((port) => `*${port}*) echo '{"ok":true,"channel":"v5"}';;`).join('\n  ')}
  ${allHealthy ? '*127.0.0.1/healthz*) echo \'{"ok":true,"channel":"v5"}\';;' : ''}
  *api.github.com*) echo '{"workflow_runs":[{"status":"completed","conclusion":"success","head_sha":"0000000000000000000000000000000000000000"}]}';;
  *) echo refused >&2; exit 7;;
esac
`,
    psql: deployState === 'error'
      ? '#!/bin/sh\necho database-down >&2; exit 2\n'
      : `#!/bin/sh
printf '%s\\n' "$*" >> '${psqlCalls}'
case "$*" in
  *"FROM deploy_state"*) printf '%s\\n' '${deployState.phase}|${deployState.step}|${deployState.active}|${deployState.candidate ?? ''}' ;;
  ${turnWindowStats !== undefined ? `*request_finalize_journal*) printf '%s\\n' '${turnWindowStats}' ;;` : ''}
  ${allHealthy ? '*product_friction_events*) printf \'0|0\\n\' ;;' : ''}
  ${allHealthy ? '*marketplace_skill_listings*) printf \'t\\n\' ;;' : ''}
  *) exit 0 ;;
esac
`,
    df: '#!/bin/sh\necho "Use%"; echo "10%"\n',
    docker: `#!/bin/sh
case "$1" in
  images) echo test/runtime:v5 ;;
  ps) ${dockerPsFails
    ? 'echo docker-unavailable >&2; exit 1'
    : dockerRows.map((row) => `printf '%s\\n' '${row}'`).join('; ') || ':'} ;;
esac
`,
  }
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(path.join(bin, name), body); await chmod(path.join(bin, name), 0o755)
  }
  const statePath = path.join(dir, 'state')
  const logPath = path.join(dir, 'log')
  // 两条 master 日志 lane 的夹具文件(见下方 V5MON_MASTER_LOG_A/B 注释)。
  const masterLogA = path.join(dir, 'master-a.log')
  const masterLogB = path.join(dir, 'master-b.log')
  await writeFile(masterLogA, '')
  await writeFile(masterLogB, '')
  const result = run(monitor, args, {
    PATH: `${bin}:${process.env.PATH}`,
    V5MON_ENV_FILE: path.join(dir, 'env'),
    V5MON_STATE_FILE: statePath,
    V5MON_LOG_FILE: logPath,
    V5MON_MEMINFO: path.join(dir, 'meminfo'),
    // 2026-07-26 新增 check_backup_fresh(critical):把备份目录指向夹具内的新鲜副本。
    // 不指的话,夹具里 /var/backups/openclaude-v5 不存在 → backup_fresh 恒 bad,会挡住
    // "obsolete pool 一次性迁移"那条"本轮必须全绿"的前置(该前置是刻意的 fail-closed,
    // 不能为了让测试过就把它放宽 —— 那等于把迁移模式变成通用告警静默开关)。
    V5MON_BACKUP_DIR: backupDir,
    // 2026-07-26 同理:mail / client_4xx_storm 不再猜 A 槽日志,而是按 deploy_state 的
    // serving slot 派生 lane,并在"serving slot 自己的日志不可读"时判 bad(那正是本次
    // 修复的反向守卫 —— 蓝绿切到 B 之后这两项曾经读闲置槽的静默旧日志、恒判 ok)。
    // 夹具里 /var/log/openclaude-v5*.log 不存在,两条 lane 全不可读 → mail 恒 bad,
    // 会挡住"obsolete pool 一次性迁移"那条要求本轮全绿的前置。所以这里给两条 lane 各
    // 指一个夹具内的空日志文件:空文件是**可读**的,判据照常跑(窗口内无失败行 → ok),
    // 守卫本身一字未放宽 —— 与上面 backup_fresh 同一处理方式。
    V5MON_MASTER_LOG_A: masterLogA,
    V5MON_MASTER_LOG_B: masterLogB,
    V5MON_MAINTENANCE_FILE: path.join(dir, 'marker'),
    V5MON_MAINTENANCE_LOCK: path.join(dir, 'maintenance.lock'),
    V5MON_CUTOVER_ROOT: cutoverRoot,
    V5MON_CONDITIONS: conditions ? '1' : '0',
  })
  return Object.assign(result, { statePath, logPath, psqlCalls })
}

describe('v5 monitor obsolete pool state migration', () => {
  const healthyRow = 'openclaude/openclaude-runtime:v5-ccb-test|1|v5|1'

  test('migrates only the obsolete pool bad state without notification writes', async () => {
    const result = await monitorFixture({
      args: ['--migrate-obsolete-pool-state'],
      allHealthy: true,
      dockerRows: [healthyRow],
      state: {
        checks: {
          pool: { status: 'bad', since: 123, last_alert: 456 },
          mem: { status: 'ok', since: 0, last_alert: 0 },
        },
        preserved: { revision: 7 },
      },
    })
    assert.equal(result.status, 0, result.stderr)
    const migrated = JSON.parse(await readFile(result.statePath, 'utf8'))
    assert.deepEqual(migrated.checks.pool, { status: 'ok', since: 0, last_alert: 0 })
    assert.deepEqual(migrated.checks.mem, { status: 'ok', since: 0, last_alert: 0 })
    assert.deepEqual(migrated.preserved, { revision: 7 })
    const calls = await readFile(result.psqlCalls, 'utf8')
    assert.doesNotMatch(calls, /INSERT INTO|write_alert_condition|v5-alert-fanout\.sql/)
    assert.match(await readFile(result.logPath, 'utf8'), /MIGRATION obsolete pool count-threshold state bad→ok/)
  })

  test('rejects another historical bad key and leaves state byte-identical', async () => {
    const original = JSON.stringify({ checks: { pool: { status: 'bad' }, image: { status: 'bad' } } })
    const result = await monitorFixture({
      args: ['--migrate-obsolete-pool-state'],
      allHealthy: true,
      dockerRows: [healthyRow],
      state: JSON.parse(original),
    })
    assert.equal(result.status, 3, result.stderr)
    assert.equal(await readFile(result.statePath, 'utf8'), original)
    await assert.rejects(readFile(result.logPath, 'utf8'), /ENOENT/)
  })

  test('rejects a current bad check and leaves state byte-identical', async () => {
    const original = JSON.stringify({ checks: { pool: { status: 'bad', since: 1, last_alert: 2 } } })
    const result = await monitorFixture({
      args: ['--migrate-obsolete-pool-state'],
      allHealthy: true,
      dockerRows: ['openclaude/openclaude-runtime:v5-ccb-test||v5|1'],
      state: JSON.parse(original),
    })
    assert.equal(result.status, 3, result.stderr)
    assert.equal(await readFile(result.statePath, 'utf8'), original)
    await assert.rejects(readFile(result.logPath, 'utf8'), /ENOENT/)
  })
})

interface MonitorHostInstallOptions {
  failMonitorStart?: boolean
  failTimerStop?: boolean
  failDailyTimerStop?: boolean
  failDailyTimerStart?: boolean
  busyMonitor?: boolean
  busyDaily?: boolean
  invalidCurrent?: boolean
  invalidState?: boolean
  failUnitBackup?: boolean
  failDailyUnitBackup?: boolean
  warningBad?: boolean
  criticalBad?: boolean
  malformedDryRunSeverity?: boolean
  initialState?: Record<string, unknown>
}

async function monitorHostInstallFixture(options: MonitorHostInstallOptions = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'v5-monitor-host-install-')); dirs.push(dir)
  const stage = path.join(dir, 'stage')
  const hostRoot = path.join(dir, 'host-monitor')
  const systemdDir = path.join(dir, 'systemd')
  const backupRoot = path.join(dir, 'backups')
  const bin = path.join(dir, 'bin')
  const stateFile = path.join(dir, 'monitor-state.json')
  const envFile = path.join(dir, 'commercial-v5.env')
  const monitorLog = path.join(dir, 'monitor.log')
  const actions = path.join(dir, 'systemctl-actions')
  const timerStopped = path.join(dir, 'timer-stopped')
  const dailyTimerStopped = path.join(dir, 'daily-timer-stopped')
  const alertActive = path.join(dir, 'alert-active')
  // 夹具内的"健康备份"目录(见下方 V5MON_BACKUP_DIR)。
  const installBackupDir = path.join(dir, 'host-backups')
  spawnSync('mkdir', ['-p', path.join(installBackupDir, 'v5-fixture-fresh')])
  // 两条 master 日志 lane 的夹具文件(见下方 V5MON_MASTER_LOG_A/B 注释)。
  const installMasterLogA = path.join(dir, 'install-master-a.log')
  const installMasterLogB = path.join(dir, 'install-master-b.log')
  await writeFile(installMasterLogA, '')
  await writeFile(installMasterLogB, '')
  await Promise.all([mkdir(stage), mkdir(systemdDir), mkdir(backupRoot), mkdir(bin)])
  for (const source of [
    'scripts/v5-monitor.sh',
    'scripts/v5-daily-check.sh',
    'scripts/v5-alert-fail.sh',
    'scripts/v5-alert-fanout.sql',
    'scripts/v5-monitor-host-install-remote.sh',
    'deploy/v5/openclaude-v5-monitor.service',
    'deploy/v5/openclaude-v5-monitor.timer',
    'deploy/v5/openclaude-v5-daily.service',
    'deploy/v5/openclaude-v5-daily.timer',
    'deploy/v5/openclaude-v5-alert-fail@.service',
  ]) {
    await cp(path.join(root, source), path.join(stage, path.basename(source)))
  }
  if (options.malformedDryRunSeverity) {
    await cp(path.join(stage, 'v5-monitor.sh'), path.join(stage, 'v5-monitor.real.sh'))
    await writeFile(path.join(stage, 'v5-monitor.sh'), `#!/bin/bash
bash "$(dirname "$0")/v5-monitor.real.sh" "$@" | sed -E 's/ \\[severity=(warning|critical)\\]$//'
`)
    await chmod(path.join(stage, 'v5-monitor.sh'), 0o755)
  }
  const checksum = spawnSync('bash', ['-c', [
    'sha256sum v5-monitor.sh v5-daily-check.sh v5-alert-fail.sh v5-alert-fanout.sql v5-monitor-host-install-remote.sh',
    'openclaude-v5-monitor.service openclaude-v5-monitor.timer',
    'openclaude-v5-daily.service openclaude-v5-daily.timer',
    'openclaude-v5-alert-fail@.service',
  ].join(' ')], { cwd: stage, encoding: 'utf8' })
  assert.equal(checksum.status, 0, checksum.stderr)
  await writeFile(path.join(stage, 'SHA256SUMS'), checksum.stdout)
  const bundleSha = createHash('sha256').update(checksum.stdout).digest('hex')
  await writeFile(envFile, 'OC_RUNTIME_IMAGE=test/runtime:v5\nDATABASE_URL=postgres://unused\n')
  const originalState = JSON.stringify(options.initialState ?? {
    checks: {
      pool: { status: 'bad', since: 123, last_alert: 456 },
      mem: { status: 'ok', since: 0, last_alert: 0 },
    },
  })
  await writeFile(stateFile, originalState)
  if (options.invalidState) {
    await rm(stateFile)
    await symlink(path.join(dir, 'state-target'), stateFile)
  }
  await mkdir(path.join(hostRoot, 'releases', 'monitor-old'), { recursive: true })
  if (options.invalidCurrent) await writeFile(path.join(hostRoot, 'current'), 'not-a-symlink')
  else await symlink('releases/monitor-old', path.join(hostRoot, 'current'))
  for (const unit of [
    'openclaude-v5-monitor.service',
    'openclaude-v5-monitor.timer',
    'openclaude-v5-daily.service',
    'openclaude-v5-daily.timer',
    'openclaude-v5-alert-fail@.service',
  ]) await writeFile(path.join(systemdDir, unit), `old:${unit}\n`)

  const commands: Record<string, string> = {
    'systemd-analyze': '#!/bin/sh\nexit 0\n',
    systemctl: `#!/bin/sh
printf '%s\\n' "$*" >> '${actions}'
cmd="$1"; shift
if [ "\${1:-}" = --quiet ]; then shift; fi
unit="\${1:-}"
case "$cmd:$unit" in
  is-active:openclaude-v5-monitor.timer) [ -f '${timerStopped}' ] && exit 3; echo active; exit 0 ;;
  is-active:openclaude-v5-daily.timer) [ -f '${dailyTimerStopped}' ] && exit 3; echo active; exit 0 ;;
  is-active:openclaude-v5-monitor.service) [ "\${BUSY_MONITOR:-0}" = 1 ] && { echo active; exit 0; }; exit 3 ;;
  is-active:openclaude-v5-daily.service) [ "\${BUSY_DAILY:-0}" = 1 ] && { echo active; exit 0; }; exit 3 ;;
  is-active:*) echo active; exit 0 ;;
  stop:openclaude-v5-monitor.timer) [ "\${FAIL_TIMER_STOP:-0}" = 1 ] && exit 1; touch '${timerStopped}'; exit 0 ;;
  stop:openclaude-v5-daily.timer) [ "\${FAIL_DAILY_TIMER_STOP:-0}" = 1 ] && exit 1; touch '${dailyTimerStopped}'; exit 0 ;;
  start:openclaude-v5-monitor.timer) rm -f '${timerStopped}'; exit 0 ;;
  start:openclaude-v5-daily.timer) [ "\${FAIL_DAILY_TIMER_START:-0}" = 1 ] && exit 1; rm -f '${dailyTimerStopped}'; exit 0 ;;
  start:openclaude-v5-monitor.service)
    [ "\${FAIL_MONITOR_START:-0}" = 1 ] && { touch '${alertActive}'; exit 1; }
    if [ "\${WARNING_BAD:-0}" = 1 ]; then
      jq '
        if .checks.failed_units.status == "bad" then
          .checks.failed_units.severity = "warning"
        else
          .checks.failed_units = {status:"bad", since:123, last_alert:456, severity:"warning"}
        end
      ' '${stateFile}' > '${stateFile}.new'
      mv '${stateFile}.new' '${stateFile}'
    fi
    exit 0
    ;;
  stop:openclaude-v5-alert-fail@openclaude-v5-monitor.service.service) rm -f '${alertActive}'; exit 0 ;;
  list-jobs:*) [ -f '${alertActive}' ] && printf '1 openclaude-v5-alert-fail@openclaude-v5-monitor.service.service start running\\n'; exit 0 ;;
  list-units:--state=failed*) [ "\${WARNING_BAD:-0}" = 1 ] && printf 'fixture-warning.service loaded failed failed test\\n'; exit 0 ;;
  list-units:*) [ -f '${alertActive}' ] && printf 'openclaude-v5-alert-fail@openclaude-v5-monitor.service.service loaded active running test\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`,
    curl: `#!/bin/sh
case "$*" in
  *18892*) echo '{"ok":true,"role":"egress"}' ;;
  *api.github.com*) echo '{"workflow_runs":[{"status":"completed","conclusion":"success","head_sha":"0000000000000000000000000000000000000000"}]}' ;;
  *) echo '{"ok":true,"channel":"v5"}' ;;
esac
`,
    psql: `#!/bin/sh
case "$*" in
  *"FROM deploy_state"*) printf 'stable|0|A|\\n' ;;
  *request_finalize_journal*) [ "\${CRITICAL_BAD:-0}" = 1 ] && { echo authority-down >&2; exit 2; }; printf '0|0|0|0\\n' ;;
  *product_friction_events*) printf '0|0\\n' ;;
  *marketplace_skill_listings*) printf 't\\n' ;;
  *) printf '7|11\\n' ;;
esac
`,
    df: '#!/bin/sh\necho "Use%"; echo "10%"\n',
    docker: `#!/bin/sh
case "$1" in images) echo test/runtime:v5 ;; ps) echo 'openclaude/openclaude-runtime:v5-ccb-test|1|v5|1' ;; esac
`,
  }
  for (const [name, source] of Object.entries(commands)) {
    await writeFile(path.join(bin, name), source)
    await chmod(path.join(bin, name), 0o755)
  }
  if (options.failUnitBackup || options.failDailyUnitBackup) {
    const failedUnit = options.failDailyUnitBackup
      ? 'openclaude-v5-daily.service'
      : 'openclaude-v5-monitor.service'
    await writeFile(path.join(bin, 'cp'), `#!/bin/sh
case "$*" in
  *${systemdDir}/${failedUnit}*${backupRoot}/.monitor-backup.*) exit 1 ;;
  *) exec /bin/cp "$@" ;;
esac
`)
    await chmod(path.join(bin, 'cp'), 0o755)
  }
  const result = run(monitorHostInstaller, [stage, hostRoot, bundleSha, stateFile], {
    PATH: `${bin}:${process.env.PATH}`,
    FAIL_MONITOR_START: options.failMonitorStart ? '1' : '0',
    FAIL_TIMER_STOP: options.failTimerStop ? '1' : '0',
    FAIL_DAILY_TIMER_STOP: options.failDailyTimerStop ? '1' : '0',
    FAIL_DAILY_TIMER_START: options.failDailyTimerStart ? '1' : '0',
    BUSY_MONITOR: options.busyMonitor ? '1' : '0',
    BUSY_DAILY: options.busyDaily ? '1' : '0',
    WARNING_BAD: options.warningBad ? '1' : '0',
    CRITICAL_BAD: options.criticalBad ? '1' : '0',
    OC_V5_SYSTEMD_DIR: systemdDir,
    OC_V5_MONITOR_ENV: envFile,
    OC_V5_MONITOR_LOG: monitorLog,
    OC_V5_MONITOR_BACKUP_ROOT: backupRoot,
    OC_V5_MONITOR_DRAIN_ATTEMPTS: '3',
    OC_V5_MONITOR_DRAIN_SLEEP_SECONDS: '0',
    V5MON_MEMINFO: '/proc/meminfo',
    // check_backup_fresh(2026-07-26 新增,critical)读绝对路径 /var/backups/openclaude-v5。
    // 夹具指向自己的新鲜备份目录:安装门是"任何 bad 就拒装",不指的话开发机上备份陈旧
    // 就恒红,且这条恒红与被测行为无关。安装器已支持透传该覆盖(去掉了硬编码生产假设)。
    V5MON_BACKUP_DIR: installBackupDir,
    // 2026-07-26:此前这里指向一个**不存在**的 missing-app.log,依赖的是 mail 探针
    // "日志不可读 → record ok(跳过)"的旧 fail-open 行为。那条 fail-open 已被修掉
    // (不可读现在判 bad:"没问题"与"没看过"必须是两个结论),于是安装门的
    // "任何 bad 就拒装"会拒掉这次安装 —— 夹具依赖了一个刚被消灭的洞。
    // 改为提供**可读的空日志**:判据照常执行(窗口内无失败行 → ok),守卫一字未放宽。
    V5MON_MASTER_LOG_A: installMasterLogA,
    V5MON_MASTER_LOG_B: installMasterLogB,
    V5MON_MAINTENANCE_FILE: path.join(dir, 'missing-maintenance.json'),
    V5MON_MAINTENANCE_LOCK: path.join(dir, 'maintenance.lock'),
    V5MON_CUTOVER_ROOT: path.join(dir, 'cutovers'),
  })
  return {
    result,
    dir,
    hostRoot,
    systemdDir,
    stateFile,
    monitorLog,
    actions,
    timerStopped,
    dailyTimerStopped,
    alertActive,
    bundleSha,
    originalState,
  }
}

describe('v5 host monitor independent atomic installer', () => {
  test('systemd monitor holds the production mutation shared lock and cleanly skips on conflict', async () => {
    const unit = await readFile(monitorService, 'utf8')
    const execLine = unit.split('\n').find((line) => line.startsWith('ExecStart='))
    assert.equal(
      execLine,
      'ExecStart=/usr/bin/flock --shared --nonblock --conflict-exit-code 0 /run/openclaude-v5/production-mutation.lock /usr/bin/bash /opt/openclaude/v5-monitor/current/v5-monitor.sh',
    )

    const dir = await mkdtemp(path.join(tmpdir(), 'v5-monitor-mutation-lock-')); dirs.push(dir)
    const lock = path.join(dir, 'production-mutation.lock')
    const holderReady = path.join(dir, 'holder-ready')
    const holderRelease = path.join(dir, 'holder-release')
    const payloadRan = path.join(dir, 'payload-ran')
    const payload = path.join(dir, 'monitor-payload.sh')
    await writeFile(payload, `#!/bin/bash\ntouch '${payloadRan}'\n`)

    const holder = spawn('/usr/bin/flock', [
      '--exclusive', lock, '/usr/bin/bash', '-c',
      `touch '${holderReady}'; while [[ ! -e '${holderRelease}' ]]; do sleep 0.02; done`,
    ])
    try {
      assert.equal(
        await waitUntilManualLease(
          () => readFile(holderReady).then(() => true).catch(() => false),
          5_000,
        ),
        true,
        'exclusive mutation lock holder did not start',
      )
      const skipped = spawnSync('/usr/bin/flock', [
        '--shared', '--nonblock', '--conflict-exit-code', '0', lock,
        '/usr/bin/bash', payload,
      ])
      assert.equal(skipped.status, 0, skipped.stderr?.toString())
      await assert.rejects(readFile(payloadRan), /ENOENT/, 'conflicting monitor payload must not run')
    } finally {
      await writeFile(holderRelease, '')
      assert.equal(await waitForChildExit(holder, 5_000), true, 'exclusive lock holder did not exit')
    }

    const ran = spawnSync('/usr/bin/flock', [
      '--shared', '--nonblock', '--conflict-exit-code', '0', lock,
      '/usr/bin/bash', payload,
    ])
    assert.equal(ran.status, 0, ran.stderr?.toString())
    assert.equal(await readFile(payloadRan, 'utf8'), '')
  })

  test('official mode is wired through the shared mutation locks without selecting an A/B slot', async () => {
    const source = await readFile(deploy, 'utf8')
    assert.match(source, /--install-monitor\) MODE="install-monitor"/)
    assert.match(source, /install-monitor\) install_v5_host_monitor/)
    const start = source.indexOf('install_v5_host_monitor()')
    const end = source.indexOf('\nstrip_shared_baseline_env_keys()', start)
    assert.ok(start >= 0 && end > start)
    const body = source.slice(start, end)
    assert.match(body, /v5-monitor-host-install-remote\.sh/)
    assert.match(body, /v5-daily-check\.sh/)
    assert.doesNotMatch(body, /slot_(src|unit|port)|active_slot/)
    assert.match(source, /\*\) acquire_production_mutation_lease \|\| exit 3/)
    assert.match(source, /\*\)\n\s*run_mutation_lane_supervised run_selected_mode "\$MODE"/)
  })

  test('installs a versioned bundle, migrates pool exactly, and restores the active timer', async () => {
    const fixture = await monitorHostInstallFixture()
    assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout)
    assert.equal(await readlink(path.join(fixture.hostRoot, 'current')), `releases/monitor-${fixture.bundleSha}`)
    assert.equal(JSON.parse(await readFile(fixture.stateFile, 'utf8')).checks.pool.status, 'ok')
    assert.match(await readFile(path.join(fixture.systemdDir, 'openclaude-v5-monitor.service'), 'utf8'), /\/opt\/openclaude\/v5-monitor\/current/)
    assert.equal(
      await readFile(path.join(fixture.systemdDir, 'openclaude-v5-daily.service'), 'utf8'),
      await readFile(path.join(root, 'deploy/v5/openclaude-v5-daily.service'), 'utf8'),
    )
    await readFile(path.join(fixture.hostRoot, 'current', 'v5-daily-check.sh'), 'utf8')
    const actions = await readFile(fixture.actions, 'utf8')
    assert.ok(actions.indexOf('stop openclaude-v5-monitor.timer') < actions.indexOf('start openclaude-v5-monitor.service'))
    assert.ok(actions.indexOf('stop openclaude-v5-daily.timer') < actions.indexOf('start openclaude-v5-monitor.service'))
    assert.ok(actions.indexOf('start openclaude-v5-monitor.service') < actions.lastIndexOf('start openclaude-v5-monitor.timer'))
    assert.ok(actions.indexOf('start openclaude-v5-monitor.service') < actions.lastIndexOf('start openclaude-v5-daily.timer'))
    assert.doesNotMatch(actions, /(?:start|stop) openclaude-v5-daily\.service/)
    assert.match(await readFile(fixture.monitorLog, 'utf8'), /INSTALL-OK host monitor/)
  })

  test('installs with a current warning and records its explicit severity', async () => {
    const fixture = await monitorHostInstallFixture({
      warningBad: true,
      initialState: { checks: {} },
    })
    assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout)
    assert.equal(await readlink(path.join(fixture.hostRoot, 'current')), `releases/monitor-${fixture.bundleSha}`)
    const state = JSON.parse(await readFile(fixture.stateFile, 'utf8'))
    assert.deepEqual(state.checks.failed_units, {
      status: 'bad',
      since: 123,
      last_alert: 456,
      severity: 'warning',
    })
  })

  test('allows a later bundle upgrade while a classified warning remains bad', async () => {
    const fixture = await monitorHostInstallFixture({
      warningBad: true,
      initialState: {
        checks: {
          failed_units: { status: 'bad', since: 17, last_alert: 29, severity: 'warning' },
        },
      },
    })
    assert.equal(fixture.result.status, 0, fixture.result.stderr || fixture.result.stdout)
    assert.equal(await readlink(path.join(fixture.hostRoot, 'current')), `releases/monitor-${fixture.bundleSha}`)
    assert.deepEqual(JSON.parse(await readFile(fixture.stateFile, 'utf8')).checks.failed_units, {
      status: 'bad',
      since: 17,
      last_alert: 29,
      severity: 'warning',
    })
  })

  test('rejects a current critical check and restores the old monitor surface', async () => {
    const fixture = await monitorHostInstallFixture({
      criticalBad: true,
      initialState: { checks: {} },
    })
    assert.notEqual(fixture.result.status, 0)
    assert.match(fixture.result.stderr, /critical bad check/)
    assert.equal(await readlink(path.join(fixture.hostRoot, 'current')), 'releases/monitor-old')
    assert.equal(await readFile(fixture.stateFile, 'utf8'), fixture.originalState)
    assert.equal(
      await readFile(path.join(fixture.systemdDir, 'openclaude-v5-monitor.service'), 'utf8'),
      'old:openclaude-v5-monitor.service\n',
    )
    assert.match(await readFile(fixture.actions, 'utf8'), /start openclaude-v5-monitor.timer/)
  })

  test('rejects malformed severity in a current bad dry-run result', async () => {
    const fixture = await monitorHostInstallFixture({
      warningBad: true,
      malformedDryRunSeverity: true,
      initialState: { checks: {} },
    })
    assert.notEqual(fixture.result.status, 0)
    assert.match(fixture.result.stderr, /缺少合法 severity/)
    assert.equal(await readlink(path.join(fixture.hostRoot, 'current')), 'releases/monitor-old')
    assert.equal(await readFile(fixture.stateFile, 'utf8'), fixture.originalState)
  })

  for (const [name, severity] of [
    ['missing', undefined],
    ['invalid', 'urgent'],
  ] as const) {
    test(`rejects a historical bad state with ${name} severity`, async () => {
      const failed: Record<string, unknown> = { status: 'bad', since: 1, last_alert: 2 }
      if (severity !== undefined) failed.severity = severity
      const fixture = await monitorHostInstallFixture({
        warningBad: true,
        initialState: { checks: { failed_units: failed } },
      })
      assert.notEqual(fixture.result.status, 0)
      assert.match(fixture.result.stderr, /历史 critical\/未分级异常/)
      assert.equal(await readlink(path.join(fixture.hostRoot, 'current')), 'releases/monitor-old')
      assert.equal(await readFile(fixture.stateFile, 'utf8'), fixture.originalState)
    })
  }

  test('restores units, pointer, state, and timer when activation fails', async () => {
    const fixture = await monitorHostInstallFixture({ failMonitorStart: true })
    assert.notEqual(fixture.result.status, 0)
    assert.equal(await readlink(path.join(fixture.hostRoot, 'current')), 'releases/monitor-old')
    assert.equal(await readFile(fixture.stateFile, 'utf8'), fixture.originalState)
    assert.equal(
      await readFile(path.join(fixture.systemdDir, 'openclaude-v5-monitor.service'), 'utf8'),
      'old:openclaude-v5-monitor.service\n',
    )
    assert.equal(
      await readFile(path.join(fixture.systemdDir, 'openclaude-v5-daily.service'), 'utf8'),
      'old:openclaude-v5-daily.service\n',
    )
    assert.match(await readFile(fixture.actions, 'utf8'), /start openclaude-v5-monitor.timer/)
    assert.match(await readFile(fixture.actions, 'utf8'), /start openclaude-v5-daily.timer/)
    assert.doesNotMatch(await readFile(fixture.actions, 'utf8'), /stop openclaude-v5-daily\.service/)
    assert.doesNotMatch(await readFile(fixture.actions, 'utf8'), /start openclaude-v5-monitor.timer[\s\S]*stop openclaude-v5-alert-fail@/)
    await assert.rejects(readFile(fixture.alertActive, 'utf8'), /ENOENT/)
    assert.match(await readFile(fixture.monitorLog, 'utf8'), /INSTALL-ROLLBACK host monitor/)
  })

  for (const [name, options] of [
    ['timer stop failure', { failTimerStop: true }],
    ['daily timer stop failure', { failDailyTimerStop: true }],
    ['drain timeout', { busyMonitor: true }],
    ['daily drain timeout', { busyDaily: true }],
    ['invalid current', { invalidCurrent: true }],
    ['invalid state', { invalidState: true }],
    ['unit backup failure', { failUnitBackup: true }],
    ['daily unit backup failure', { failDailyUnitBackup: true }],
  ] as const) {
    test(`${name} restores both originally active timers without killing daily`, async () => {
      const fixture = await monitorHostInstallFixture(options)
      assert.notEqual(fixture.result.status, 0)
      const actions = await readFile(fixture.actions, 'utf8')
      assert.match(actions, /start openclaude-v5-monitor.timer/)
      assert.match(actions, /start openclaude-v5-daily.timer/)
      assert.match(actions.trim().split('\n').at(-1) ?? '', /is-active --quiet openclaude-v5-daily.timer/)
      assert.doesNotMatch(actions, /stop openclaude-v5-daily\.service/)
    })
  }

  test('partial timer restore returns recovery-required after restoring files and pointer', async () => {
    const fixture = await monitorHostInstallFixture({ failDailyTimerStart: true })
    assert.equal(fixture.result.status, 86, fixture.result.stderr || fixture.result.stdout)
    assert.equal(await readlink(path.join(fixture.hostRoot, 'current')), 'releases/monitor-old')
    assert.equal(
      await readFile(path.join(fixture.systemdDir, 'openclaude-v5-daily.service'), 'utf8'),
      'old:openclaude-v5-daily.service\n',
    )
    await assert.rejects(readFile(fixture.timerStopped, 'utf8'), /ENOENT/)
    assert.equal(await readFile(fixture.dailyTimerStopped, 'utf8'), '')
    const actions = await readFile(fixture.actions, 'utf8')
    assert.match(actions, /start openclaude-v5-monitor.timer/)
    assert.match(actions, /start openclaude-v5-daily.timer/)
    assert.doesNotMatch(actions, /stop openclaude-v5-daily\.service/)
  })
})

describe('v5 monitor host structural probes (2026-07-26 audit)', () => {
  // 三个探针根治的是"静默失败"这一整类。背景:异地容灾 v5-dr-sync/v5-dr-volumes 连败
  // 43 小时无人知晓,根因是这两个单元的 OnFailure= 是空的。逐个单元补 OnFailure 只能救
  // 已知的那几个,新单元照样漏 —— 所以改成"本机存在任何 failed 单元"就报。
  // 契约:函数存在 + 进调用列表 + 进 check_severity 分级。三者缺一,探针就是死代码
  // (漏分级会落到默认 warning,backup_fresh 必须是 critical)。
  test('failed_units / backup_fresh / mem_oversubscribe are defined, invoked and graded', async () => {
    const source = await readFile(monitor, 'utf8')
    for (const name of ['failed_units', 'backup_fresh', 'mem_oversubscribe']) {
      assert.ok(source.includes(`check_${name}() {`), `check_${name} 函数缺失`)
      assert.match(
        source,
        new RegExp(`^check_${name}$`, 'm'),
        `check_${name} 未进末尾的检查项调用列表(定义了不调 = 死代码)`,
      )
    }
    const sevStart = source.indexOf('check_severity() {')
    assert.ok(sevStart >= 0, 'check_severity 缺失')
    const sevEnd = source.indexOf('\n}', sevStart)
    const sev = source.slice(sevStart, sevEnd)
    const criticalLine = sev.split('\n').find((l) => l.includes('echo critical')) ?? ''
    const warningLine = sev.split('\n').find((l) => l.includes('echo warning') && l.includes('|')) ?? ''
    // backup_fresh = critical:异地容灾退役后本地备份是唯一数据保护,停摆 = 零保护
    assert.match(criticalLine, /backup_fresh/, 'backup_fresh 必须是 critical')
    assert.match(warningLine, /failed_units/, 'failed_units 必须显式分级(否则只靠默认分支)')
    assert.match(warningLine, /mem_oversubscribe/, 'mem_oversubscribe 必须显式分级')
  })

  test('dry-run and durable state expose severity from the same authority', async () => {
    const healthyRow = 'openclaude/openclaude-runtime:v5-ccb-test|1|v5|1'
    const dry = await monitorFixture({
      allHealthy: true,
      dockerRows: [healthyRow],
      failedUnits: ['fixture-warning.service'],
    })
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /failed_units\s+bad\s+.*\[severity=warning\]$/m)
    assert.match(dry.stdout, /backup_fresh\s+ok\s+.*\[severity=critical\]$/m)

    const live = await monitorFixture({
      args: [],
      allHealthy: true,
      dockerRows: [healthyRow],
      failedUnits: ['fixture-warning.service'],
      state: {
        checks: {
          failed_units: {
            status: 'bad',
            since: 123,
            last_alert: 9_999_999_999,
            severity: 'warning',
          },
        },
      },
    })
    assert.equal(live.status, 0, live.stderr)
    const state = JSON.parse(await readFile(live.statePath, 'utf8'))
    assert.deepEqual(state.checks.failed_units, {
      status: 'bad',
      since: 123,
      last_alert: 9_999_999_999,
      severity: 'warning',
    })
    assert.equal(state.checks.backup_fresh.severity, 'critical')
    assert.doesNotMatch(await readFile(live.psqlCalls, 'utf8'), /INSERT INTO inbox_messages/)
  })

  test('turn health uses terminal journal authority and one shared classified window', async () => {
    const source = await readFile(monitor, 'utf8')
    const loadStart = source.indexOf('load_turn_window_stats() {')
    assert.ok(loadStart >= 0, 'turn window loader 缺失')
    const loader = source.slice(loadStart, source.indexOf('\n}', loadStart))
    assert.match(loader, /FROM request_finalize_journal rfj/)
    assert.match(loader, /LEFT JOIN usage_records ur ON ur\.id=rfj\.usage_id/)
    assert.match(loader, /rfj\.state IN \('committed','aborted'\)/)
    assert.match(loader, /failure_code IN \('CLIENT_ABORT','USER_CANCELLED'\)/)
    assert.match(loader, /codex_terminal_code'='USER_CANCELLED'/)
    assert.match(loader, /ur\.status='success'/)
    assert.match(loader, /COALESCE\(ur\.output_tokens,0\)>0/)
    assert.match(loader, /terminal_outcome='failure'/)
    assert.match(loader, /terminal_outcome='cancelled'/)
    assert.match(loader, /FROM product_friction_events/)

    const turnStart = source.indexOf('check_turn_failures() {')
    const turn = source.slice(turnStart, source.indexOf('\n}', turnStart))
    assert.match(turn, /load_turn_window_stats/)
    assert.match(turn, /TURN_ERR_RATE_MIN_TOTAL/)
    assert.doesNotMatch(turn, /psql /, '主检查不得另起第二条漂移查询')

    const frictionStart = source.indexOf('check_friction_pipeline() {')
    const friction = source.slice(frictionStart, source.indexOf('\n}', frictionStart))
    assert.match(friction, /load_turn_window_stats/)
    assert.doesNotMatch(friction, /psql /, '元监控必须复用同一 classified 查询')
    assert.match(source, /^check_friction_pipeline$/m)
  })

  // docker inspect 必须一次传全部容器 ID:每 2 分钟一轮的探针不能在循环里逐个调。
  test('mem_oversubscribe inspects all containers in one docker call', async () => {
    const source = await readFile(monitor, 'utf8')
    const start = source.indexOf('check_mem_oversubscribe() {')
    const fn = source.slice(start, source.indexOf('\n}', start))
    assert.match(fn, /docker inspect --format '\{\{\.HostConfig\.Memory\}\}' \$ids/)
    assert.doesNotMatch(fn, /for .* in \$ids/, '禁止在循环里逐个 docker inspect')
    // docker 调用失败必须 fail-loud,不能静默当作"没有超售"
    assert.match(fn, /docker ps 失败/)
    assert.match(fn, /docker inspect 取 HostConfig\.Memory 失败/)
  })
})

describe('v5 monitor terminal turn classification', () => {
  const healthyRow = 'openclaude/openclaude-runtime:v5-ccb-test|1|v5|1'

  test('alerts at the non-cancelled error-rate threshold and keeps a healthy telemetry pipe', async () => {
    const result = await monitorFixture({
      allHealthy: true,
      dockerRows: [healthyRow],
      turnWindowStats: '10|2|3|2',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /turn_failures\s+bad\s+turn 错误率 20%\(2\/10,用户取消 3/)
    assert.match(result.stdout, /friction_pipeline\s+ok\s+遥测管道:服务端失败 2 \/ friction failed turn_error 2/)
    const calls = await readFile(result.psqlCalls, 'utf8')
    assert.equal((calls.match(/request_finalize_journal/g) ?? []).length, 1)
  })

  test('keeps a small sample out of the critical rate but flags a missing friction signal', async () => {
    const result = await monitorFixture({
      allHealthy: true,
      dockerRows: [healthyRow],
      turnWindowStats: '9|1|2|0',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /turn_failures\s+ok\s+turn 失败率:非取消终态 9 轮\(<10,样本不足不判\),用户取消 2/)
    assert.match(result.stdout, /friction_pipeline\s+bad\s+遥测管道疑似断裂:窗内服务端失败 1 次/)
  })

  test('does not classify user cancellations as failures or telemetry gaps', async () => {
    const result = await monitorFixture({
      allHealthy: true,
      dockerRows: [healthyRow],
      turnWindowStats: '0|0|4|0',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /turn_failures\s+ok\s+turn 失败率:非取消终态 0 轮\(<10,样本不足不判\),用户取消 4/)
    assert.match(result.stdout, /friction_pipeline\s+ok\s+遥测管道:服务端失败 0 \/ friction failed turn_error 0/)
  })

  test('caches a failed authority query without treating the second consumer as healthy', async () => {
    const result = await monitorFixture({
      allHealthy: true,
      dockerRows: [healthyRow],
      turnWindowStats: 'invalid',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /turn_failures\s+bad\s+turn 失败率:查询返回非法行/)
    assert.match(result.stdout, /friction_pipeline\s+bad\s+遥测管道:查询返回非法行/)
    const calls = await readFile(result.psqlCalls, 'utf8')
    assert.equal((calls.match(/request_finalize_journal/g) ?? []).length, 1)
  })
})

describe('v5 monitor container identity capacity semantics', () => {
  const validRow = (uid: number) => `openclaude/openclaude-runtime:v5-ccb-test|1|v5|${uid}`

  test('21 correctly managed containers are healthy; capacity has no arbitrary count ceiling', async () => {
    const result = await monitorFixture({
      dockerRows: Array.from({ length: 21 }, (_, index) => validRow(index + 1)),
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /pool\s+ok\s+v5-ccb managed 容器 21 个/)
    assert.doesNotMatch(result.stdout, /EVENT ❌ \*\*pool\*\*/)
  })

  test('a v5-ccb container with missing identity labels is unhealthy', async () => {
    const result = await monitorFixture({
      dockerRows: [validRow(1), 'openclaude/openclaude-runtime:v5-ccb-test||v5|247'],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /EVENT ❌ \*\*pool\*\* 1\/2 个 v5-ccb 容器身份标签异常/)
  })

  test('docker ps failure remains a pool failure', async () => {
    const result = await monitorFixture({ dockerPsFails: true })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /EVENT ❌ \*\*pool\*\* docker ps 失败/)
  })
})

describe('v5 monitor planned-maintenance scope', () => {
  test('monitor validates and consumes one marker snapshot under the shared lock', async () => {
    const source = await readFile(monitor, 'utf8')
    assert.match(source, /flock -n -s 7/)
    assert.match(source, /MARKER_JSON="\$\(cat "\$MAINTENANCE_FILE"/)
    assert.match(source, /<<<"\$MARKER_JSON"/)
    const markerSection = source.match(/MARKER_PRESENT=0([\s\S]*?)maintenance_suppresses\(\)/)?.[1] ?? ''
    assert.equal((markerSection.match(/cat "\$MAINTENANCE_FILE"/g) ?? []).length, 1)
  })

  test('valid marker suppresses only expected v5/public failures', async () => {
    const result = await monitorFixture()
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /PLANNED svc_v5/)
    assert.match(result.stdout, /PLANNED http_v5/)
    assert.match(result.stdout, /PLANNED public_route/)
    assert.doesNotMatch(result.stdout, /EVENT ❌ \*\*(svc_v5|http_v5|public_route)\*\*/)
    // v3 于 2026-07-08 彻底下线,http_v3 探测项与 V5MON_CHECK_V3 开关已从 monitor 摘除;
    // 契约由 packages/commercial/src/__tests__/opsMonitorConditionContract.test.ts 兜底。
    assert.doesNotMatch(result.stdout, /http_v3/)
  })

  test('invalid marker fails open', async () => {
    const result = await monitorFixture({ marker: schema1Marker({ schema: 3 }) })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /fail-open to normal alerts/)
    assert.match(result.stdout, /EVENT ❌ \*\*svc_v5\*\*/)
    assert.match(result.stdout, /EVENT ❌ \*\*http_v5\*\*/)
    assert.match(result.stdout, /EVENT ❌ \*\*public_route\*\*/)
    assert.doesNotMatch(result.stdout, /http_v3/)
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
    const start = source.indexOf('remote_holder="')
    const end = source.indexOf('\n\n  # Keepalive bounds', start)
    assert.ok(start >= 0 && end > start, '未找到 manual production-mutation remote holder')
    const holder = source.slice(start, end)
    const signalTrap = holder.indexOf("trap 'cleanup_proof; exit 0' HUP INT TERM")
    const parentCapture = holder.indexOf('lease_parent=\\"\\$PPID\\"')
    const flock = holder.indexOf('flock -w 60 9')
    const firstKernelParent = holder.indexOf('/proc/\\$\\$/status')
    const leased = holder.indexOf('echo \\"LEASED \\$nonce\\"')
    const loop = holder.indexOf('while :; do', leased)
    assert.ok(signalTrap >= 0 && signalTrap < parentCapture, 'manual holder 须在等待 flock 前安装退出 trap')
    assert.ok(parentCapture > signalTrap && parentCapture < flock, '必须在可能阻塞的 flock 前快照 sshd parent')
    assert.ok(firstKernelParent > flock && firstKernelParent < leased, '取锁后、LEASED 前须读取内核实时 PPid')
    assert.ok(holder.indexOf('[ \\"\\$current_parent\\" = \\"\\$lease_parent\\" ]', firstKernelParent) < leased,
      'LEASED 前未校验取锁后的 PPid 仍是原 sshd parent')
    assert.ok(holder.indexOf('kill -0 \\"\\$lease_parent\\"', firstKernelParent) < leased, 'LEASED 前未校验 parent 活性')
    assert.ok(holder.indexOf('mv -f \\"\\$proof_tmp\\" \\"\\$proof\\"') < leased,
      'LEASED 前须原子发布 exact nonce proof')
    assert.ok(loop > leased, 'manual holder 缺 parent-watch 循环')
    assert.ok(holder.indexOf('/proc/\\$\\$/status', loop) > loop, '循环未重读实时 PPid')
    assert.ok(holder.indexOf('kill -0 \\"\\$lease_parent\\"', loop) > loop, '循环未复核 parent 活性')
    assert.ok(
      holder.indexOf('lease_ttl=') > firstKernelParent && holder.indexOf('lease_ttl=') < leased,
      'manual holder 须在 LEASED 前固定可配置 hard TTL',
    )
    assert.ok(holder.indexOf('now - lease_start', loop) > loop, 'manual holder 循环未执行 hard TTL 到点释放')
    assert.doesNotMatch(holder, /exec sleep infinity/, 'manual holder 禁止 orphanable infinite sleep')
    assert.match(source, /ServerAliveInterval=2/, '后台 ssh 必须设置 transport keepalive')
    assert.match(source, /ServerAliveCountMax=2/, '后台 ssh 必须限制连续 keepalive 丢失次数')
    assert.match(source, /"\$KL_HOST" "\$remote_holder" <\/dev\/null/, '后台 ssh 必须隔离 stdin')
    const sshSpawn = source.indexOf('ssh -o ServerAliveInterval=2')
    const localTtlSpawn = source.indexOf('sleep "$local_ttl" &')
    assert.ok(localTtlSpawn >= 0 && localTtlSpawn < sshSpawn, '本地 TTL 必须早于 ssh/远端 TTL 启动')
    const waitRace = source.indexOf('if wait -n -p completed')
    assert.ok(waitRace >= 0, 'manual supervisor 缺命令/lease/watchdog 首退竞速')
    assert.ok(source.indexOf('"$SUP_LOCAL_TTL_PID"', waitRace) > waitRace, '本地安全 TTL 未加入首退竞速')
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
      assert.match(
        await readFile(`${fx.lock}.manual-holder`, 'utf8'),
        /^[0-9a-f]{32}\n$/,
        'manual holder must publish an exact nonce proof only after acquiring flock',
      )
      await writeFile(fx.commandRelease, '')
      assert.equal(await waitForChildExit(child, 5_000), true, 'manual wrapper did not exit after command')
      assert.equal(
        await waitUntilManualLease(() => spawnSync('flock', ['-n', fx.lock, 'true']).status === 0, 3_000),
        true,
        'normal cleanup left an orphaned manual holder',
      )
      await assert.rejects(readFile(`${fx.lock}.manual-holder`, 'utf8'), { code: 'ENOENT' })
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

  test('manual mutation wrapper SIGKILL watchdog terminates ssh and the whole command group', async () => {
    const fx = await manualLeaseFixture()
    const command = await writeStubbornManualCommand(fx)
    const child = spawn('bash', [fx.wrapper, command], { env: fx.env, stdio: 'ignore' })
    try {
      assert.equal(
        await waitUntilManualLease(() => readFile(fx.commandStarted).then(() => true).catch(() => false), 5_000),
        true,
        'stubborn command never started',
      )
      assert.notEqual(spawnSync('flock', ['-n', fx.lock, 'true']).status, 0, 'manual lease was not held')
      assert.equal(child.kill('SIGKILL'), true, 'failed to SIGKILL outer wrapper')
      assert.equal(await waitForChildExit(child, 3_000), true, 'outer wrapper did not die')
      assert.equal(
        await waitUntilManualLease(() => spawnSync('flock', ['-n', fx.lock, 'true']).status === 0, 6_000),
        true,
        'independent supervisor did not release the mutation lease after wrapper SIGKILL',
      )
      assert.equal(
        await waitUntilManualLease(() => allRecordedProcessesExited(fx.commandPids), 6_000),
        true,
        'wrapper SIGKILL left the command or its TERM-ignoring grandchild alive',
      )
    } finally {
      child.kill('SIGKILL')
      await killManualLeaseFixtureProcesses(fx.commandPids, fx.sshPids, fx.remotePids)
    }
  })

  test('manual mutation wrapper supervisor-group SIGSTOP is fenced by an independent watchdog', async () => {
    const fx = await manualLeaseFixture()
    const heartbeat = path.join(fx.dir, 'supervisor-stop-heartbeat')
    const command = path.join(fx.dir, 'supervisor-stop-command.sh')
    await writeFile(command, [
      '#!/bin/bash',
      "trap '' TERM",
      'printf "%s\\n" "$BASHPID" >>"$COMMAND_PIDS"',
      ': >"$COMMAND_STARTED"',
      'while :; do printf "%s\\n" "$RANDOM" >"$HEARTBEAT"; sleep 0.05; done',
    ].join('\n') + '\n')
    await chmod(command, 0o755)
    const child = spawn('bash', [fx.wrapper, command], {
      env: { ...fx.env, HEARTBEAT: heartbeat, OC_V5_MUTATION_LEASE_TTL_SECONDS: '30' },
      stdio: 'ignore',
    })
    let supervisorPid: number | undefined
    try {
      assert.equal(
        await waitUntilManualLease(() => readFile(fx.commandStarted).then(() => true).catch(() => false), 5_000),
        true,
        'heartbeat command never started',
      )
      assert.equal(
        await waitUntilManualLease(() => {
          supervisorPid = childProcessGroupLeader(child.pid!)
          return supervisorPid !== undefined
        }, 3_000),
        true,
        'manual internal supervisor PGID not found',
      )
      const stoppedAt = Date.now()
      process.kill(-supervisorPid!, 'SIGSTOP')
      assert.equal(
        await waitUntilManualLease(() => allRecordedProcessesExited(fx.commandPids), 3_000),
        true,
        'independent watchdog left command mutating after supervisor-group STOP',
      )
      assert.ok(Date.now() - stoppedAt < 3_000, 'command survived until the 30s TTL instead of immediate STOP fencing')
      const frozen = await readFile(heartbeat, 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.equal(await readFile(heartbeat, 'utf8'), frozen, 'heartbeat advanced after supervisor-group STOP fencing')
      assert.equal(await waitForChildExit(child, 5_000), true, 'outer wrapper required SIGCONT to finish')
      assert.notEqual(child.exitCode, 0, 'supervisor STOP must fail closed')
      assert.equal(
        await waitUntilManualLease(() => spawnSync('flock', ['-n', fx.lock, 'true']).status === 0, 5_000),
        true,
        'supervisor STOP left the production-mutation flock held',
      )
    } finally {
      if (supervisorPid) {
        try { process.kill(-supervisorPid, 'SIGCONT') } catch { /* already gone */ }
        try { process.kill(-supervisorPid, 'SIGKILL') } catch { /* already gone */ }
      }
      child.kill('SIGKILL')
      await killManualLeaseFixtureProcesses(fx.commandPids, fx.sshPids, fx.remotePids)
    }
  })

  test('manual mutation wrapper fences a running command when the lease ssh disappears', async () => {
    const fx = await manualLeaseFixture()
    const command = await writeStubbornManualCommand(fx)
    const child = spawn('bash', [fx.wrapper, command], { env: fx.env, stdio: 'ignore' })
    try {
      assert.equal(
        await waitUntilManualLease(() => readFile(fx.commandStarted).then(() => true).catch(() => false), 5_000),
        true,
        'stubborn command never started',
      )
      const sshPid = Number((await readFile(fx.sshPids, 'utf8')).trim().split(/\s+/).at(-1))
      assert.equal(Number.isSafeInteger(sshPid) && sshPid > 1, true, 'missing fake ssh pid')
      process.kill(sshPid, 'SIGKILL')
      assert.equal(await waitForChildExit(child, 8_000), true, 'wrapper did not fail after lease ssh loss')
      assert.equal(child.exitCode, 86, `lease loss must use the dedicated exit code; signal=${child.signalCode}`)
      assert.equal(
        await waitUntilManualLease(() => allRecordedProcessesExited(fx.commandPids), 6_000),
        true,
        'lease loss left the command or its TERM-ignoring grandchild alive',
      )
      assert.equal(
        await waitUntilManualLease(() => spawnSync('flock', ['-n', fx.lock, 'true']).status === 0, 6_000),
        true,
        'lease ssh loss left the remote flock held',
      )
    } finally {
      child.kill('SIGKILL')
      await killManualLeaseFixtureProcesses(fx.commandPids, fx.sshPids, fx.remotePids)
    }
  })

  test('manual mutation wrapper hard TTL fences long commands and preserves normal command status', async () => {
    const ttlFx = await manualLeaseFixture()
    const stubborn = await writeStubbornManualCommand(ttlFx)
    const ttlChild = spawn('bash', [ttlFx.wrapper, stubborn], {
      env: { ...ttlFx.env, OC_V5_MUTATION_LEASE_TTL_SECONDS: '2' },
      stdio: 'ignore',
    })
    try {
      assert.equal(
        await waitUntilManualLease(() => readFile(ttlFx.commandStarted).then(() => true).catch(() => false), 5_000),
        true,
        'TTL command never started',
      )
      assert.equal(await waitForChildExit(ttlChild, 8_000), true, 'hard TTL did not stop the wrapper')
      assert.equal(ttlChild.exitCode, 86, `hard TTL must surface as lease loss; signal=${ttlChild.signalCode}`)
      assert.equal(
        await waitUntilManualLease(() => allRecordedProcessesExited(ttlFx.commandPids), 6_000),
        true,
        'hard TTL left command-group processes alive',
      )
    } finally {
      ttlChild.kill('SIGKILL')
      await killManualLeaseFixtureProcesses(ttlFx.commandPids, ttlFx.sshPids, ttlFx.remotePids)
    }

    const rcFx = await manualLeaseFixture()
    const rcCommand = path.join(rcFx.dir, 'exit-23.sh')
    await writeFile(rcCommand, '#!/bin/bash\nexit 23\n')
    await chmod(rcCommand, 0o755)
    const result = spawnSync('bash', [rcFx.wrapper, rcCommand], {
      env: rcFx.env,
      stdio: 'ignore',
      timeout: 10_000,
    })
    try {
      assert.equal(result.status, 23, `normal command status was not preserved; signal=${result.signal}`)
      assert.equal(
        await waitUntilManualLease(() => spawnSync('flock', ['-n', rcFx.lock, 'true']).status === 0, 4_000),
        true,
        'normal nonzero command exit left the lease held',
      )
    } finally {
      await killManualLeaseFixtureProcesses(rcFx.sshPids, rcFx.remotePids)
    }
  })

  test('manual mutation wrapper local TTL fences before a live ssh observes remote TTL close', async () => {
    const fx = await manualLeaseFixture()
    const stubborn = await writeStubbornManualCommand(fx)
    const child = spawn('bash', [fx.wrapper, stubborn], {
      env: {
        ...fx.env,
        OC_V5_MUTATION_LEASE_TTL_SECONDS: '3',
        FAKE_SSH_EXIT_DELAY_SECONDS: '5',
      },
      stdio: 'ignore',
    })
    try {
      assert.equal(
        await waitUntilManualLease(() => readFile(fx.commandStarted).then(() => true).catch(() => false), 5_000),
        true,
        'delayed-close command never started',
      )
      assert.equal(
        await waitUntilManualLease(async () => {
          if (spawnSync('flock', ['-n', fx.lock, 'true']).status !== 0) return false
          assert.equal(
            await allRecordedProcessesExited(fx.commandPids),
            true,
            'remote flock became acquirable while the old command group was still alive',
          )
          return true
        }, 6_000),
        true,
        'remote hard TTL did not release the lease after local fencing',
      )
      assert.equal(await waitForChildExit(child, 4_000), true, 'wrapper did not finish local-TTL cleanup')
      assert.equal(child.exitCode, 86, `local TTL must surface as lease loss; signal=${child.signalCode}`)
    } finally {
      child.kill('SIGKILL')
      await killManualLeaseFixtureProcesses(fx.commandPids, fx.sshPids, fx.remotePids)
    }
  })

  test('manual mutation wrapper rejects a stale LEASED receipt delivered after remote TTL', async () => {
    const fx = await manualLeaseFixture()
    const stubborn = await writeStubbornManualCommand(fx)
    const child = spawn('bash', [fx.wrapper, stubborn], {
      env: {
        ...fx.env,
        OC_V5_MUTATION_LEASE_TTL_SECONDS: '3',
        FAKE_SSH_BUFFER_OUTPUT_UNTIL_REMOTE_EXIT: '1',
        FAKE_SSH_EXIT_DELAY_SECONDS: '5',
      },
      stdio: 'ignore',
    })
    try {
      assert.equal(await waitForChildExit(child, 6_000), true, 'stale-LEASED wrapper did not fail closed')
      assert.equal(child.exitCode, 86, `stale LEASED must surface as lease loss; signal=${child.signalCode}`)
      assert.equal(
        await readFile(fx.commandStarted).then(() => true).catch(() => false),
        false,
        'wrapped command started from a stale LEASED receipt after remote flock release',
      )
      assert.equal(
        await readFile(fx.commandPids, 'utf8').then((raw) => raw.trim().length > 0).catch(() => false),
        false,
        'stale LEASED spawned the wrapped command process group',
      )
    } finally {
      child.kill('SIGKILL')
      await killManualLeaseFixtureProcesses(fx.commandPids, fx.sshPids, fx.remotePids)
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
    assert.match(
      source,
      /"\$MODE" != "reclaim-mutation-lease" && "\$MODE" != "hide-luna" \]\]; then\n {2}assert_no_deploy_recovery_marker/,
      'reclaim 必须能在 recovery marker 存在时照跑',
    )
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
    // helper 已定义；失锁后禁止自动重取并猜测 saga 阶段，更不能无 lease 补偿。
    assert.match(source, /require_mutation_lease_for_compensation\(\) \{/)
    {
      const rqStart = source.indexOf('require_mutation_lease_for_compensation() {')
      const rqEnd = source.indexOf('# ───────────────────────── dangerous offline cutover', rqStart)
      assert.ok(rqStart >= 0 && rqEnd > rqStart, '未找到 compensation lease fence 函数体')
      const rq = source.slice(rqStart, rqEnd)
      assert.doesNotMatch(rq, /acquire_production_mutation_lease/, '失锁补偿禁止在 generic child 内自动重取 lease')
      assert.match(rq, /return 86/, '失锁补偿必须返回专用 crash-stop rc=86')
      assert.match(rq, /禁止无 lease 补偿\/回滚/, '失锁补偿必须 fail-closed 并保留恢复现场')
    }
    // deploy 两条补偿路径(validation + plugin seed)各挂一次 fail-closed fence。
    assert.equal(
      source.match(/require_mutation_lease_for_compensation "deploy-validation-compensation"/g)?.length,
      2,
      'deploy 补偿(validation + plugin seed)未各挂一次 lease fence',
    )
    // deploy 补偿内 fence 先于 knowledge_planet_compensate_deploy
    const deployStart = source.indexOf('\ndeploy() {')
    const deployEnd = source.indexOf('\n# ───────────────────────── offline recycle', deployStart)
    const deployBody = source.slice(deployStart, deployEnd)
    assert.ok(
      deployBody.indexOf('require_mutation_lease_for_compensation "deploy-validation-compensation"') <
        deployBody.indexOf('knowledge_planet_compensate_deploy'),
      'deploy 补偿 lease fence 未先于 compensate',
    )
    // rollback 补偿覆盖(2026-07-17 KP 门摘除后):真正做反向补偿的只剩 hotcfg smoke-failure
    // reverse compensation + 非 hotcfg activate-failure 两条;其余插件侧失败已降级为
    // warn+open_gate_current 兜底继续(不做补偿,lease 仍在持有中),不需要 reacquire。
    assert.equal(
      source.match(/require_mutation_lease_for_compensation "rollback-compensation"/g)?.length,
      2,
      'rollback 反向补偿路径未挂 lease fence',
    )
    // hotcfg smoke-failure 反向补偿紧邻先于 rollback_runtime_tuple 1 1。
    assert.match(
      source,
      /require_mutation_lease_for_compensation "rollback-compensation" \|\| exit 86\n\s*if rollback_runtime_tuple 1 1 "\$kp_rollback_helper"/,
    )
    // 非 hotcfg 三条:reacquire 紧邻先于 Knowledge Planet 补偿(open_gate / transition)。
    assert.match(
      source,
      /require_mutation_lease_for_compensation "rollback-compensation" \|\| exit 86\n(\s*if \[\[ "\$kp_rb_bracket" == 1 \]\]; then\n)?\s*knowledge_planet_plugin_(open_gate_to_release|transition_to_release) "\$live_master"/,
    )
    // 全部 2 次 reacquire(2026-07-17 KP 门摘除后仅剩真反向补偿两条)都落在
    // rollback() 函数体内(不外溢别的 lane)。
    {
      const rbStart = source.indexOf('\nrollback() {')
      const rbEnd = source.indexOf('\nrollback_runtime_tuple() {', rbStart)
      const rbBody = source.slice(rbStart, rbEnd)
      assert.equal(
        rbBody.match(/require_mutation_lease_for_compensation "rollback-compensation"/g)?.length,
        2,
        'rollback-compensation lease fence 未全部落在 rollback() 内',
      )
    }
    // ACTIVE 在本地 TTL spawn 后、ssh/LEASED 前置位；acquisition 中断可回收二者。
    const ttlSpawn = source.indexOf('MUTATION_LEASE_TTL_PID=$!')
    const leaseActive = source.indexOf('MUTATION_LEASE_ACTIVE=1', ttlSpawn)
    const sshSpawn = source.indexOf('exec setsid ssh -o ServerAliveInterval=2', ttlSpawn)
    assert.ok(ttlSpawn >= 0 && leaseActive > ttlSpawn && sshSpawn > leaseActive, 'lease acquisition ACTIVE/TTL/ssh 顺序错误')
    const kpVerifyStart = source.indexOf('\nknowledge_planet_plugin_verify_user() {')
    const kpVerifyEnd = source.indexOf('\nknowledge_planet_plugin_smoke_gate() {', kpVerifyStart)
    const kpVerify = source.slice(kpVerifyStart, kpVerifyEnd)
    const kpAcquire = kpVerify.indexOf('acquire_production_mutation_lease')
    const kpSupervisedBuild = kpVerify.indexOf('run_mutation_lane_supervised knowledge_planet_build_release_mutation')
    const kpRelease = kpVerify.indexOf('release_production_mutation_lease', kpSupervisedBuild)
    const kpScan = kpVerify.indexOf('seed-knowledge-planet-plugin.ts', kpRelease)
    assert.ok(
      kpAcquire >= 0 && kpSupervisedBuild > kpAcquire && kpRelease > kpSupervisedBuild && kpScan > kpRelease,
      'Knowledge Planet 仅 build_release 窄窗须走持续 lease supervisor，扫码窗须在 release 后',
    )
    const dispatch = source.slice(source.lastIndexOf('case "$MODE" in'))
    assert.match(
      dispatch,
      /smoke\|baseline-census\|model-authority-preflight\|model-authority-observation-status\|reclaim-mutation-lease\|knowledge-planet-verify\)\n\s*run_selected_mode "\$MODE"/,
      '只读/特殊 lane 应直接 dispatch',
    )
    assert.match(
      dispatch,
      /\*\)\n\s*run_mutation_lane_supervised run_selected_mode "\$MODE"/,
      '所有其余 mutation lane 必须统一经过持续 lease supervisor',
    )
    // abort_continue 恢复动作(caddy_render_reload)前调用 fail-closed fence
    const abortStart = source.indexOf('\nabort_continue() {')
    const abortEnd = source.indexOf('\n# ═════════ --recover', abortStart)
    const abortBody = source.slice(abortStart, abortEnd)
    const abortReacquire = abortBody.indexOf('require_mutation_lease_for_compensation "abort-continue"')
    assert.ok(
      abortReacquire >= 0 && abortReacquire < abortBody.indexOf('caddy_render_reload'),
      'abort_continue 恢复动作前未挂 lease fence',
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

  // 2026-07-18 附件事故门禁补强 + 2026-07-26 出口矩阵整改:E2E 用户旅程门(真浏览器)。
  // 【升级前】四个调用点全在 end_planned_maintenance **之后**,失败只 `|| exit 1` —— 新版本
  // 已经 live 且不回滚,坏版本照样在线服务真实用户。第一期显式裁定「连续两周零假阳性后升级」,
  // 到 2026-07-26 已到期。
  // 【升级后契约】journey 不再单独接在成功出口,而是并入 minimum_functional_core,由各 lane
  // 的 validation/abort 补偿链驱动:deploy/dist 走对称补偿回旧 release,canary/finalize 走
  // 官方 abort。函数本体仍必须:依赖缺失 fail-loud(playwright-core 探测,禁静默跳过)+
  // V5_SMOKE_E2E=0 豁免必须落 durable debt + dry-run 分支 + 目标端口参数化。
  // 审计 10/11:逃生 / 单轴翻转 lane 的活体证据,与「不在损坏态上叠加新 release」。
  test('escape and single-axis lanes carry advisory turn evidence and refuse stacking on a broken service', async () => {
    const source = await readFile(deploy, 'utf8')
    // ① 三条 lane 各挂一次非阻断真 turn(逃生通道不加阻断门,但「成功」必须有活体证据)。
    for (const [lane, anchor] of [
      ['emergency-tuple 激活', '✓ emergency tuple 已激活'],
      ['model-authority enable', '✓ $MODEL_AUTHORITY_FLAG_KEY=1 已生效'],
      ['runtime-tape-batching enable', '✓ runtime-event batching 已安全开启'],
    ] as const) {
      const advisoryAt = source.indexOf(`smoke_turn_canary_advisory "`)
      assert.ok(advisoryAt >= 0)
      const successAt = source.indexOf(anchor)
      assert.ok(successAt >= 0, `找不到成功出口锚点:${anchor}`)
      const gateAt = source.lastIndexOf(`" "${lane}"`, successAt)
      assert.ok(
        gateAt >= 0 && successAt - gateAt < 600,
        `lane「${lane}」的成功出口前缺非阻断真 turn(健康端点绿 ≠ agent turn 能出正文)`,
      )
    }
    // advisory 必须真的非阻断(逃生通道加阻断门 = 把救援自我否决)。
    const advisoryFn = source.slice(
      source.indexOf('\nsmoke_turn_canary_advisory() {'),
      source.indexOf('\n# 2026-07-17 架构纠偏'),
    )
    assert.match(advisoryFn, /\n  return 0\n\}/, 'advisory 真 turn 必须恒返回 0(非阻断)')
    assert.equal(
      (advisoryFn.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').match(/return [1-9]/g) ?? []).length,
      0,
      'advisory 真 turn 不得有任何非零返回路径 —— 给逃生通道加阻断门 = 把救援自我否决',
    )

    // ② tape batching 补偿路径不得再用 `|| true` 吞掉恢复结果:操作者必须能区分
    //    「已安全回到 flag=0 且健康」与「回退了但服务已挂」。
    const batching = source.slice(
      source.indexOf('\nenable_runtime_tape_batching() {'),
      source.indexOf('\n# 自动回切的 lossless 能力门'),
    )
    const compensation = batching.slice(batching.indexOf('require_mutation_lease_for_compensation "runtime-batching-compensation"'))
    const compensationCode = compensation
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    assert.equal(
      (compensationCode.match(/\|\| true/g) ?? []).length,
      0,
      'batching 补偿三步不得用 || true 吞掉恢复结果',
    )
    assert.match(compensation, /batch_recover_failed/, '补偿必须逐步取退出码并汇总判词')
    assert.match(compensation, /mark_deploy_recovery_required/, '恢复未确认必须落 durable marker 阻断下次发布')
    assert.match(compensation, /✓ 已确认回到 flag=0 且服务健康/, '恢复确认必须有明确判词')

    // ③ begin_planned_maintenance 不得在 svc_v5/http_v5 全挂时继续叠加新 release;
    //    但 rollback lane 与显式确认永远放行(新门绝不许挡住恢复路径)。
    const bpm = source.slice(
      source.indexOf('\nbegin_planned_maintenance() {'),
      source.indexOf('\nend_planned_maintenance() {'),
    )
    assert.match(bpm, /is_healthy svc_v5 \|\| missing_core\+=\(svc_v5\)/)
    assert.match(bpm, /is_healthy http_v5 \|\| missing_core\+=\(http_v5\)/)
    assert.match(
      bpm,
      /\[\[ "\$mode" != rollback && "\$onto_unhealthy" != 1 \]\]/,
      'rollback lane 与显式确认必须永远放行(在坏服务上回退正是救援本身)',
    )
    assert.match(bpm, /exit 21/, 'fail-closed 必须用独立 rc 让本地侧给出可操作指引')
    assert.match(bpm, /bpm_rc" == 21/, '本地侧必须翻译 rc=21')
    assert.match(bpm, /OC_DEPLOY_ONTO_UNHEALTHY/, '必须提供明示确认逃生口')
    assert.match(bpm, /onto_unhealthy:\$onto_unhealthy/, '强行叠加必须写进 maintenance marker 留痕')
  })

  // 门禁豁免 = durable debt(2026-07-26 出口矩阵整改的架构主线;审计 7)。
  // 此前五个豁免 env 都是「一条 env + 一句 echo」把门整个关掉:不落持久证据、monitor 看不见、
  // 下一次发布照跑不误 —— 豁免强度比门本身还高。本断言把它掰正后的形态钉死,防止回退。
  test('gate waivers are durable debts that block the next ordinary release', async () => {
    const source = await readFile(deploy, 'utf8')
    // ① 五个豁免 env 全部登记进注册表,且各有还债 lane。
    assert.match(
      source,
      /GATE_WAIVER_KEYS="smoke-turn e2e-journey finalize-egress-gate capmatrix-compat canary-turn-cost ci-verification"/,
      '所有豁免 key 必须全在单一注册表里(新增豁免 env/旗标必须同步登记)',
    )
    for (const [key, env] of [
      ['smoke-turn', 'V5_SMOKE_TURN'],
      ['e2e-journey', 'V5_SMOKE_E2E'],
      ['canary-turn-cost', 'V5_CANARY_REQUIRE_COST'],
      ['finalize-egress-gate', 'OC_FINALIZE_SKIP_EGRESS_GATE'],
      ['capmatrix-compat', 'OC_CAPMATRIX_COMPAT'],
    ] as const) {
      const envFn = source.slice(
        source.indexOf('\ngate_waiver_env_active() {'),
        source.indexOf('\nrecord_gate_waiver() {'),
      )
      assert.ok(
        new RegExp(`^\\s*${key}\\)[^\\n]*\\b${env}\\b`, 'm').test(envFn),
        `豁免 key=${key} 未绑定到 env ${env}(gate_waiver_env_active 缺分支)`,
      )
      assert.ok(
        new RegExp(`^\\s*${key}\\)\\s+echo "`, 'm').test(source),
        `豁免 key=${key} 未登记还债 lane(gate_waiver_repay_modes 缺分支)`,
      )
    }
    // ② 记账失败 = fail-closed(绝不出现「豁免生效但没人记账」)。
    const record = source.slice(
      source.indexOf('\nrecord_gate_waiver() {'),
      source.indexOf('\nclear_gate_waiver() {'),
    )
    assert.match(record, /base64 -w0 <"\$marker"\)" == "\$encoded"/, 'marker 必须写后回读校验')
    assert.match(record, /门禁豁免债务写入\/回读失败[\s\S]*return 1/, '写入失败必须返回非零让门保持强制')
    const declared = source.slice(
      source.indexOf('\nrecord_declared_gate_waivers() {'),
      source.indexOf('\n# ── 传统 deploy/dist/rollback 的严格状态快照'),
    )
    assert.match(declared, /for key in \$GATE_WAIVER_KEYS/, '入口记账必须遍历整个注册表')
    assert.match(declared, /return 1/, '入口记账失败必须拒绝发布')
    assert.match(
      declared,
      /忽略与本 lane 无关的豁免声明/,
      '本 lane 不跑的门,豁免它是空操作 —— 不该欠债(否则笔误会凭空阻断下次发布)',
    )
    // ③ 闸的挂载点与放行集合:恢复/回退 lane 永不被阻断(回退优先于任何新门)。
    const gateBlock = source.slice(
      source.indexOf('# 门禁豁免债务闸(2026-07-26)'),
      source.indexOf('# Legacy marker 兼容权只在会 build/flip/放量 master release'),
    )
    assert.ok(gateBlock.length > 0, '门禁豁免债务闸未挂载')
    // 逃生 lane 无法用 --emergency-containment 旁路(EMERGENCY_INCIDENT 只接受
    // --authorize-emergency / --canary / --finalize),所以必须逐条显式放行。
    for (const recoveryLane of [
      'abort',
      'rollback',
      'recover',
      'hide-luna',
      'emergency-tuple',
      'activate-emergency-tuple',
      'disable-model-authority',
      'install-monitor',
    ]) {
      assert.ok(
        new RegExp(`(^\\s*|\\|)${recoveryLane}(\\||\\))`, 'm').test(gateBlock),
        `恢复/逃生 lane ${recoveryLane} 必须在放行集合里 —— 新门绝不许挡住回退路径`,
      )
    }
    // 反向锁:emergency 参数的适用范围一旦扩大(让逃生 lane 能带 --emergency-containment),
    // 上面的显式放行才可以收缩;在那之前这条断言保证两处语义不会各自漂移。
    assert.match(
      source,
      /\[\[ "\$MODE" == canary \|\| "\$MODE" == finalize \|\| "\$MODE" == authorize-emergency \]\]/,
      'emergency 参数适用范围变了 → 债务闸放行集合必须同步复审',
    )
    assert.ok(
      gateBlock.indexOf('assert_no_open_gate_waivers') <
        gateBlock.indexOf('record_declared_gate_waivers'),
      '必须先查旧债再记新债(反了会把本次刚写的 marker 当旧债自我阻塞)',
    )
    // ④ 每个 key 都有真跑通过后的自动销账点,且销账不得在带着同一豁免 env 时发生。
    assert.match(source, /clear_gate_waiver smoke-turn/)
    assert.match(source, /clear_gate_waiver e2e-journey/)
    assert.match(
      source,
      /\[\[ "\$\{OC_FINALIZE_SKIP_EGRESS_GATE:-0\}" == 1 \]\] \|\| clear_gate_waiver finalize-egress-gate/,
      '带着 OC_FINALIZE_SKIP_EGRESS_GATE 跑出来的「通过」不是证据,不得销账',
    )
    assert.match(
      source,
      /\[\[ -n "\$\{OC_CAPMATRIX_COMPAT:-\}" \]\] \|\| clear_gate_waiver capmatrix-compat/,
      '带着 OC_CAPMATRIX_COMPAT 跑出来的「兼容」不是证据,不得销账',
    )
    // ⑤ monitor 必须看得见(否则债务只在部署输出里闪一下就没人知道)。
    const monitor = await readFile(path.join(root, 'scripts/v5-monitor.sh'), 'utf8')
    assert.match(monitor, /check_gate_waivers\(\)/, 'monitor 缺门禁豁免债务探针')
    assert.match(monitor, /^check_gate_waivers$/m, 'monitor 探针未接进主流程')
    // 断言"它被分到 warning 档",而不是锁死它在 case 模式里的排列位置 ——
    // 原写法要求 `gate_waivers)` 紧跟 echo warning,于是往同一档追加任何新检查项
    // (2026-07-26 加 ci_base_red)都会把这条打红,属于"重构必红"的脆弱断言。
    const warningLine = monitor.split('\n').find((line) => /\)\s*echo warning/.test(line)) ?? ''
    assert.ok(
      warningLine.includes('gate_waivers'),
      `monitor 未把 gate_waivers 分到 warning 档(warning 行:${warningLine.trim()})`,
    )
    assert.match(monitor, /GATE_WAIVER_DIR=.*\.gate-waivers/, 'monitor 与 deploy 的 marker 目录必须同路径')
  })

  // 公网面 + 资产面(审计 8)。此前 deploy/--dist 的成功出口没有任何一层经 Caddy 公网入口验证
  // (smoke 全程 ssh 打 127.0.0.1:port,journey 走 ssh 隧道直连 master 端口),而 dist 握手只
  // 抓 index.html 的 oc-build meta —— 哈希 chunk 404 / admin.html 白屏都能带门全绿上线。
  test('public entry and asset reachability are verified before a lane is declared successful', async () => {
    const source = await readFile(deploy, 'utf8')
    // ① 公网面:带 Host 头经 Caddy 打,断言 ok:true ∧ slot=期望(verify_routing 现成)。
    const pub = source.slice(
      source.indexOf('\nverify_public_surface() {'),
      source.indexOf('\n# 资产可达性'),
    )
    assert.match(pub, /v5-caddy-apply\.sh" --verify/, '公网面必须走 verify_routing')
    assert.match(pub, /CADDY_HTTP_PORT="\$CADDY_HTTP_PORT"/, '必须打 Caddy 入口端口而非 master 端口')
    assert.match(pub, /return 1/, '公网面失败必须非零')
    // ② 资产面:index.html 与 admin.html 各自首个 /assets/*.js 必须 200 且是 JS
    //    (SPA fallback 会把 404 兜成 index.html,只看状态码不够)。
    const asset = source.slice(
      source.indexOf('\nverify_asset_surface() {'),
      source.indexOf('\n# C5:rollback 收尾后的 real-turn canary'),
    )
    assert.match(asset, /for page in \/ \/admin\.html/, 'admin.html 是第二入口,必须单独校验')
    assert.match(asset, /\/assets\/\[A-Za-z0-9\._-\]\*\\\.js/, '必须解析 index/admin 引用的哈希 chunk')
    assert.match(asset, /'%\{http_code\}'/, '必须断言 chunk HTTP 状态码')
    assert.match(asset, /javascript\|ecmascript/, '必须断言 Content-Type 是 JS(防 SPA fallback 假绿)')
    // ③ 资产面并入 dist 握手 → deploy/--dist/finalize 三个握手点一次到位。
    const handshake = source.slice(
      source.indexOf('\ndist_handshake_smoke() {'),
      source.indexOf('\n# ───────────────────────── smoke:健康 + 隔离断言'),
    )
    assert.match(handshake, /verify_asset_surface "\$sport" \|\| return 1/, 'dist 握手必须连带资产可达性')
    // ④ deploy 与 --dist 的 validation 链都必须过公网面,且失败进补偿链(不是裸退出)。
    for (const [lane, marker] of [
      ['deploy', 'validation_failure="public/asset surface verification failed'],
      ['dist', 'dist_validation_failure="public/asset surface verification failed'],
    ] as const) {
      assert.ok(source.includes(`verify_public_surface ${lane}`), `${lane} 未挂公网面验证`)
      assert.ok(source.includes(marker), `${lane} 的公网面失败必须写 validation_failure 进补偿链`)
    }
  })

  // 部署与 CI 绿的机械绑定(审计 9)。分支保护只管「合进 canonical」,不管「部署哪个 commit」;
  // 仓内已有走 hotfix 分支绕过 CI 直接部署的先例。本断言锁死第二道门的存在与挂载点。
  test('the commit being built into a release must have green required CI checks', async () => {
    const source = await readFile(deploy, 'utf8')
    const fn = source.slice(
      source.indexOf('\nassert_ci_green_for_source_commit() {'),
      source.indexOf('\nbuild_release() {'),
    )
    assert.ok(fn.length > 0, 'CI 绿门函数缺失')
    // 判定源必须是分支保护的 required contexts(不是「所有 check 全绿」:一个 flaky 可选 job
    // 就能卡死正常发布),并逐个比对 commit 的 check-run 结论。
    assert.match(fn, /protection\/required_status_checks/, '必须以分支保护的必需集为判定口径')
    assert.match(fn, /commits\/\$sha\/check-runs/, '必须查的是被构建的那个 commit 的 check-run')
    assert.match(fn, /\^\(success\|skipped\|neutral\)\$/, 'conclusion 白名单必须显式')
    assert.match(fn, /unverifiable=/, '证据取不到必须与「取到且是红的」一样进阻断分支')
    // 逃生口必须显式且记账。
    assert.match(fn, /ALLOW_UNVERIFIED_CI" != 1/, '缺显式逃生旗标判定')
    assert.match(fn, /record_gate_waiver ci-verification[\s\S]*\|\| return 1/, '逃生必须登记 durable debt 且记账失败即拒绝')
    assert.match(fn, /clear_gate_waiver ci-verification/, '全绿必须自动销账')
    assert.match(
      fn,
      /if \[\[ -n "\$EMERGENCY_INCIDENT" \]\]; then[\s\S]{0,300}?return 0/,
      'dx-declared emergency containment lane 必须放行 —— 止血场景天然「CI 还没跑完就要上」,再加一道门会把止血拦死',
    )
    assert.match(source, /--allow-unverified-ci\) ALLOW_UNVERIFIED_CI=1/, '缺 CLI 旗标')
    assert.match(source, /ALLOW_UNVERIFIED_CI=0/, 'ALLOW_UNVERIFIED_CI 必须默认关(fail-closed)')
    // 挂载点 = build_release 里 source commit 钉死之后、任何远端写之前。
    const build = source.slice(
      source.indexOf('\nbuild_release() {'),
      source.indexOf('mkdir -p \'$staging\''),
    )
    const pin = build.indexOf('BUILT_RELEASE_SOURCE_COMMIT="$full_sha"')
    const gate = build.indexOf('assert_ci_green_for_source_commit "$full_sha" || return 1')
    assert.ok(pin >= 0 && gate > pin, 'CI 绿门必须挂在 build_release 里 source commit 钉死之后')
    // ci-verification 有意不参与连环跳禁令(gh 故障会互锁),这条要留在代码里防被"顺手统一"。
    const envFn = source.slice(
      source.indexOf('\ngate_waiver_env_active() {'),
      source.indexOf('\nrecord_gate_waiver() {'),
    )
    assert.match(envFn, /ci-verification\)\s+return 1 ;;/,
      'ci-verification 不得参与连环跳禁令,否则一次 gh 故障就锁死所有发布(含热修)')
  })

  test('E2E journey gate is part of the shared minimum functional core and fails loud', async () => {
    const source = await readFile(deploy, 'utf8')
    const journeySource = await readFile(e2eJourney, 'utf8')
    // 函数本体契约。
    const fnStart = source.indexOf('\nsmoke_e2e_journey() { # [port]')
    assert.ok(fnStart >= 0, 'smoke_e2e_journey 函数缺失或未参数化目标端口')
    const fnEnd = source.indexOf('\n}', fnStart)
    const fn = source.slice(fnStart, fnEnd)
    assert.match(fn, /V5_SMOKE_E2E:-1/, '缺 V5_SMOKE_E2E 豁免开关')
    assert.match(
      fn,
      /record_gate_waiver e2e-journey [^\n]*\|\| return 1/,
      'V5_SMOKE_E2E=0 豁免必须登记 durable debt,且登记失败即门保持强制',
    )
    assert.match(fn, /node_modules\/playwright-core/, '缺依赖活体探测(缺失必须 fail-loud 而非静默跳过)')
    assert.match(fn, /return 1/, '依赖缺失/旅程失败必须返回非零')
    assert.match(fn, /\[dry-run\]/, '缺 dry-run 分支')
    assert.match(fn, /v5-e2e-journey-canary\.mjs/, '未调用旅程脚本')
    assert.match(fn, /V5_E2E_REMOTE_PORT="\$port"/, '旅程必须打调用方指定的端口(candidate lane 切流前跑)')
    const preJ5Timeout = /const PRE_J5_TIMEOUT = ([\d_]+);/.exec(journeySource)
    const j5Timeout = /const TURN_WAIT_TIMEOUT = ([\d_]+);/.exec(journeySource)
    const outerTimeout = /timeout (\d+) node "\$SCRIPT_DIR\/v5-e2e-journey-canary\.mjs"/.exec(fn)
    assert.ok(preJ5Timeout, 'J1-J4 必须保留有限总防挂预算')
    assert.ok(j5Timeout, 'J5 必须保留有限等待上限')
    assert.ok(outerTimeout, 'journey 必须保留外层有限总超时')
    const preJ5TimeoutMs = Number(preJ5Timeout[1].replaceAll('_', ''))
    const j5TimeoutMs = Number(j5Timeout[1].replaceAll('_', ''))
    const outerTimeoutMs = Number(outerTimeout[1]) * 1_000
    assert.match(
      journeySource,
      /setTimeout\(\(\) => fatal\(1, "[^"]+"\), PRE_J5_TIMEOUT\)/,
      'J1-J4 总防挂预算必须实际启动计时',
    )
    assert.match(
      journeySource,
      /clearTimeout\(preJ5Timer\);\s+await step\("J5 /,
      '只有进入 J5 时才可结束 J1-J4 总防挂计时',
    )
    assert.match(
      journeySource,
      /const deadline = Date\.now\(\) \+ TURN_WAIT_TIMEOUT;/,
      'J5 deadline 必须实际使用 TURN_WAIT_TIMEOUT',
    )
    const modelPin = journeySource.indexOf('const JOURNEY_MODEL_ID = "deepseek-v4-flash";')
    const modelTrigger = journeySource.indexOf('page.getByRole("button", { name: "选择对话模型" })')
    const modelItem = journeySource.indexOf('page.locator(`[data-model-id="${JOURNEY_MODEL_ID}"]`)')
    const modelApplied = journeySource.indexOf('modelTrigger.textContent()')
    const j2 = journeySource.indexOf('await step("J2 ')
    const j4 = journeySource.indexOf('await step("J4 ')
    assert.ok(modelPin >= 0, 'journey 必须固定使用刚由最小功能核真 turn 验证过的 DeepSeek V4 Flash')
    assert.ok(
      modelTrigger > modelPin && modelItem > modelTrigger && modelApplied > modelItem,
      'journey 必须经真实模型选择器选中固定模型并等待触发器回显',
    )
    assert.ok(
      modelApplied < j2 && modelApplied < j4,
      '固定模型必须在附件上传与首次 UI 发送之前生效，禁止账号历史粘滞模型决定 J5',
    )
    assert.ok(j5TimeoutMs >= 180_000, '生产正常慢轮已超过 120s，J5 等待窗不得退回旧阈值')
    assert.ok(
      outerTimeoutMs >= preJ5TimeoutMs + j5TimeoutMs + 30_000,
      '外层总超时必须覆盖 J1-J4 总预算、完整 J5 等待窗和清理余量',
    )
    // 旧的「成功出口裸接 || exit 1」形态必须彻底消失 —— 它正是本次整改要消灭的无效门。
    assert.equal(
      (source.match(/smoke_e2e_journey \|\| exit 1/g) ?? []).length,
      0,
      '不得再在成功出口(切流之后)裸接 journey:失败必须进补偿/abort 链',
    )
    // 唯一合法调用点 = 最小功能核内部。
    const coreStart = source.indexOf('\nminimum_functional_core() {')
    assert.ok(coreStart >= 0, 'minimum_functional_core 缺失')
    const coreEnd = source.indexOf('\n}', coreStart)
    const core = source.slice(coreStart, coreEnd)
    assert.match(
      core,
      /smoke_turn_matrix "\$release" "\$port" "\$lane" \|\|/,
      '最小功能核缺带 lane 身份的双引擎真 turn',
    )
    assert.match(core, /smoke_e2e_journey "\$port" \|\|/, '最小功能核缺 J1-J5 旅程')
    const journeyCalls = source.match(/^\s*smoke_e2e_journey\b/gm) ?? []
    assert.equal(
      journeyCalls.length,
      2,
      `journey 只允许「函数定义 + 最小功能核内一处调用」,实际 ${journeyCalls.length} 处`,
    )
  })

  // 出口矩阵(审计 1/2/3/4/5/6):每条会改变用户流量走向的 lane 都必须过同一个最小功能核,
  // 且必须挂在**切流之前**或**能回退的补偿链里**。本断言锁死挂载点,防止再退回残缺矩阵。
  test('minimum functional core is wired into every traffic-shifting lane', async () => {
    const source = await readFile(deploy, 'utf8')
    const slice = (fnHeader: string, nextHeader: string) => {
      const a = source.indexOf(fnHeader)
      assert.ok(a >= 0, `找不到 ${fnHeader}`)
      const b = source.indexOf(nextHeader, a)
      assert.ok(b > a, `找不到 ${fnHeader} 的结束锚点 ${nextHeader}`)
      return source.slice(a, b)
    }

    // ① deploy:进 validation_failure 对称补偿链(失败 → 回旧 source/账号版本)。
    const deployBody = slice('\ndeploy() {', '\n# ───────────────────────── offline recycle')
    const deployCore = deployBody.indexOf('minimum_functional_core deploy "$BUILT_RELEASE" "$ACTIVE_PORT"')
    const deployCompensate = deployBody.indexOf('knowledge_planet_compensate_deploy')
    assert.ok(deployCore >= 0, 'deploy 未挂最小功能核')
    assert.match(
      deployBody.slice(deployCore - 220, deployCore + 220),
      /validation_failure="minimum functional core failed/,
      'deploy 的最小功能核失败必须写 validation_failure(进补偿链),不得裸 exit',
    )
    assert.ok(deployCompensate > deployCore, 'deploy 的补偿链必须在最小功能核之后')

    // ② --dist:补齐真 turn 硬门 + 对称补偿(此前是零补偿的 set -e 裸退出)。
    const distBody = slice('\ndeploy_dist() {', '\ncompensate_dist_activation() {')
    assert.match(distBody, /minimum_functional_core dist "\$BUILT_RELEASE" "\$ACTIVE_PORT"/)
    assert.match(distBody, /dist_validation_failure="minimum functional core failed/)
    const distPrevCapture = distBody.indexOf('dist_previous_release="$(bg_current_release "$ACTIVE_SRC")"')
    const distFlip = distBody.indexOf('activate_release "$BUILT_RELEASE"')
    assert.ok(distPrevCapture >= 0 && distFlip > distPrevCapture, '--dist 回退点必须在翻转前钉死')
    assert.match(
      distBody,
      /compensate_dist_activation "\$BUILT_RELEASE" "\$dist_previous_release" "\$hc_any"/,
      '--dist 校验失败必须走对称补偿',
    )
    // 补偿必须复用既有机制,不得另造一套。
    const distCompensate = slice('\ncompensate_dist_activation() {', '\n# ───────────────────────── rollback')
    assert.match(distCompensate, /require_mutation_lease_for_compensation "dist-activation-compensation"/)
    assert.match(distCompensate, /rollback_runtime_tuple 1 1 "\$candidate" 0/)
    assert.match(distCompensate, /activate_release "\$previous"/)

    // ③ canary READY:percent=0 不碰真实流量,成本极低,却是放量前唯一的功能证据。
    const canaryBody = slice('\ncanary() {', '\n_internal_allowlist_sql() {')
    const canaryCore = canaryBody.indexOf('minimum_functional_core "canary-ready"')
    assert.ok(canaryCore >= 0, 'canary READY 后未跑最小功能核')
    assert.ok(
      canaryBody.indexOf('✓ --canary 完成') > canaryCore,
      'canary 的最小功能核必须在完成 echo 之前',
    )

    // ④ promote:真实用户暴露从 promote 才开始;CAS 抬 percent 之前必须先探 candidate。
    // 探针不能用 vip_control_gate —— 它断言 state=leader ∧ vip=owner,那是 finalize step4
    // 交接后的不变量;canary 期 candidate 恒为 standby,挂它会让每次正常放量都失败。用本
    // lane 自己的就绪不变量 wait_for_candidate_ready + 一条三信号真 turn。
    const promoteBody = slice('\npromote() {', '\negress_baseline_journal_fragment() {')
    const promoteGate = promoteBody.indexOf('wait_for_candidate_ready "$DS_candidate_slot"')
    const promoteTurn = promoteBody.indexOf('smoke_turn_matrix "$promote_candidate"')
    const promoteCas = promoteBody.indexOf('ds_cas_or_die "cohort_percent=$PROMOTE_PCT')
    assert.ok(promoteGate >= 0 && promoteTurn >= 0 && promoteCas >= 0, 'promote 缺 candidate 探针')
    assert.ok(
      promoteGate < promoteCas && promoteTurn < promoteCas,
      'promote 的 candidate 探针必须在抬 cohort_percent 之前(放量后再探等于没探)',
    )
    assert.ok(
      !/vip_control_gate "\$DS_candidate_slot"/.test(promoteBody),
      'promote 不得用 vip_control_gate 做探针(canary 期 candidate 是 standby,必然失败=挡住正常放量)',
    )
    assert.match(
      promoteBody,
      /smoke_turn_matrix "\$promote_candidate" "\$\(slot_port "\$DS_candidate_slot"\)" "promote-candidate"/,
      'promote 的 candidate 真 turn 必须显式携带 candidate lane 身份',
    )

    // ⑤ finalize:不可逆点之前补功能门,失败转 aborting 保留恢复路径。
    const finalizeBody = slice('\nfinalize_run_steps() {', '\n# ═════════ lane: --abort ═════════')
    const finalizeCore = finalizeBody.indexOf('minimum_functional_core finalize-precommit')
    const finalizeStop = finalizeBody.indexOf('sshk "systemctl stop $(slot_unit "$old")"')
    const finalizeCommit = finalizeBody.indexOf("active_slot='$cand', previous_active_release=active_release")
    assert.ok(finalizeCore >= 0, 'finalize 提交前未跑最小功能核')
    assert.ok(finalizeCore < finalizeStop && finalizeCore < finalizeCommit,
      'finalize 的功能门必须在 stop 旧 unit / commit stable 之前')
    assert.match(
      finalizeBody.slice(finalizeCore, finalizeCore + 900),
      /ds_cas_or_die "phase='aborting', transition_step=0" 0 "finalize precommit/,
      'finalize 功能门失败必须转 aborting 保留恢复路径',
    )
  })

  // 2026-07-26 安全整改:sourcemap 封堵四层防护的契约锁。
  // 事故实测:https://claudeai.chat/assets/main-*.js.map 公网 200、901KB、含 72 个源文件
  // 完整 sourcesContent(等于全量源码泄漏)。四层里任意一层被后人改回去都不会报错,
  // 只会静默重新泄漏 —— 所以四层各自上断言。
  test('sourcemap sealing is enforced at all four layers', async () => {
    // 第一层:vite 不写 sourceMappingURL 指针
    const vite = await readFile(path.join(root, 'packages/web-react/vite.config.ts'), 'utf8')
    assert.match(
      vite,
      /sourcemap:\s*["']hidden["']/,
      'vite build.sourcemap 必须是 hidden(true 会写出 sourceMappingURL 指针)',
    )

    const source = await readFile(deploy, 'utf8')

    // 第二层:资产池同步排除 *.map(不进 Caddy 直服目录)
    const syncStart = source.indexOf('sync_assets_to_pool() {')
    assert.ok(syncStart >= 0, 'sync_assets_to_pool 函数缺失')
    const syncEnd = source.indexOf('\n}', syncStart)
    const syncFn = source.slice(syncStart, syncEnd)
    assert.match(
      syncFn,
      /rsync -a --exclude='\*\.map'/,
      '资产池同步必须排除 *.map,否则 sourcemap 直接进公网直服目录',
    )

    // 第四层:部署活体门(第三层是 Caddy,由 caddy golden + 顺序断言覆盖)
    const fnStart = source.indexOf('\nsmoke_sourcemap_sealed() {')
    assert.ok(fnStart >= 0, 'smoke_sourcemap_sealed 函数缺失')
    const fnEnd = source.indexOf('\n}', fnStart)
    const fn = source.slice(fnStart, fnEnd)
    assert.match(fn, /\[dry-run\]/, '缺 dry-run 分支')
    assert.match(fn, /CADDY_HTTP_PORT/, '必须走可配端口,不许硬编码 :80')
    assert.match(fn, /Host: claudeai\.chat/, '必须带 Host 头经 Caddy 探测(拦截规则在 Caddy 层)')
    assert.match(fn, /if ! ssh /, '远端 heredoc 的退出码必须接(不接 = fail-open)')
    // 配置层断言:没有它,池子被清空后 curl 探测退化成"文件本来就不存在 → 404" = 空断言。
    // 断言的**形态**必须跟着模板走:守卫嵌在 /assets 块内、被 route 包住、respond 早于
    // file_server。绝不能再断言"文本行号更小"—— adapter 会按路径特异性重排 handle,
    // 那个前提是错的(2026-07-26 实测:文本断言全绿而线上仍 200)。
    assert.match(fn, /handle \\\/assets/, '必须定位 live Caddyfile 的 /assets 块')
    assert.match(fn, /@sourcemap path \*\.map/, '必须断言 /assets 块内有 @sourcemap 匹配器')
    assert.match(fn, /respond @sourcemap 404/, '必须断言 /assets 块内有 respond 404')
    assert.match(fn, /r_line.*-ge.*f_line|-ge "\$f_line"/, '必须断言 respond 早于 file_server')
    assert.match(fn, /= "000"/, 'curl 连不上必须与"拿到 200"分开判,探测本身坏了也要 fail-loud')
    assert.match(fn, /return 1/, '门失败必须返回非零')

    // 接线契约:四个成功出口各一处,且都在 end_planned_maintenance 之后
    const calls = source.match(/smoke_sourcemap_sealed \|\| exit 1/g) ?? []
    assert.equal(calls.length, 4, `期望 4 个成功出口接线,实际 ${calls.length}`)
    for (const exitMarker of [
      'knowledge-planet=setup-first)。"',
      'knowledge-planet=zero-touch)。"',
      '"✓ deploy 完成(release=$BUILT_RELEASE,slot=$ACTIVE_SLOT)。"',
      '"✓ dist deploy 完成(release=$BUILT_RELEASE,slot=$ACTIVE_SLOT)。"',
    ]) {
      const exitAt = source.indexOf(exitMarker)
      assert.ok(exitAt >= 0, `成功出口标记缺失: ${exitMarker}`)
      const windowStart = source.lastIndexOf('end_planned_maintenance', exitAt)
      const gateAt = source.lastIndexOf('smoke_sourcemap_sealed || exit 1', exitAt)
      assert.ok(
        gateAt > windowStart && gateAt < exitAt,
        `出口「${exitMarker}」的 sourcemap 门未落在 end_planned_maintenance 与完成 echo 之间`,
      )
    }
  })

  // 第三层:Caddy 渲染里 *.map 拦截必须存在,且**排在 /assets 直服之前**。
  // handle 块按书写顺序互斥求值,排后面等于永不命中 —— 只断言"存在"会漏掉这类静默失效。
  test('Caddy render blocks *.map before serving the assets pool', () => {
    for (const [label, env] of [
      ['production', { CADDY_HTTP_PORT: undefined }],
      ['staging', { CADDY_HTTP_PORT: '18081' }],
    ] as const) {
      const rendered = run(caddyApply, ['--render', '--dry-run'], env)
      assert.equal(rendered.status, 0, `${label}: ${rendered.stderr}`)
      // 非引号 heredoc 里混进反引号/命令替换会被真的执行 —— 首版就踩过,这里钉死
      assert.doesNotMatch(
        rendered.stderr,
        /command not found/,
        `${label}: Caddy 模板 heredoc 里有被 shell 执行掉的命令替换`,
      )
      // 守卫必须**嵌在** /assets 处理块内、并被 route 包住。
      // 【为什么不断言文本顺序】首版把 @sourcemap 写成独立 handle 排在 /assets 之前,
      // 文本断言与 self-check 都绿,**线上照样 200** —— Caddyfile adapter 会按路径特异性
      // 给同组 handle 重排,编译后 /assets/* 反而排前面,*.map 永不命中。
      // route 的语义是"保持写法顺序不重排",是唯一不依赖 adapter 内部排序的写法。
      const assetsAt = rendered.stdout.indexOf('handle /assets/*')
      assert.ok(assetsAt >= 0, `${label}: 渲染结果缺 handle /assets/*`)
      const blockEnd = rendered.stdout.indexOf('\n\t}', assetsAt)
      assert.ok(blockEnd > assetsAt, `${label}: /assets 块未闭合`)
      const block = rendered.stdout.slice(assetsAt, blockEnd)
      assert.match(block, /route \{/, `${label}: /assets 块内缺 route(不用 route 会被 adapter 重排)`)
      assert.match(block, /@sourcemap path \*\.map/, `${label}: /assets 块内缺 @sourcemap 匹配器`)
      assert.match(block, /respond @sourcemap 404/, `${label}: /assets 块内缺 respond @sourcemap 404`)
      assert.ok(
        block.indexOf('respond @sourcemap 404') < block.indexOf('file_server'),
        `${label}: respond @sourcemap 404 必须在 route 内位于 file_server 之前`,
      )
    }
  })

  test('E2E journey completion requires a new finalized non-error assistant row', async () => {
    const source = await readFile(e2eJourney, 'utf8')
    assert.match(source, /assistantRowsBefore = await page\.getByTestId\("assistant-row"\)\.count\(\)/)
    assert.match(source, /await assistantRows\.count\(\)\) > assistantRowsBefore/)
    assert.match(source, /newestAssistant\.locator\("\.caret-blink"\)/)
    assert.match(source, /getByRole\("button", \{ name: "发送", exact: true \}\)/)
    assert.match(source, /newestAssistant\.locator\('\[role="alert"\]'\)/)
    assert.match(source, /writeFileSync\(probePath, `\$\{probeToken\}\\n`\)/)
    assert.match(source, /finalBody\.includes\(probeToken\)/)
    assert.match(source, /getByRole\("button", \{ name: "开始目标" \}\)\.click\(\)/)
    assert.match(source, /getByRole\("button", \{ name: \/清除\/ \}\)\.click\(\)/)
    assert.doesNotMatch(source, /name: "重新生成"/, '不得把可选的重新生成按钮当作回复完成信号')
  })

  test('E2E journey gives only the post-restart first paint a longer boot budget', async () => {
    const source = await readFile(e2eJourney, 'utf8')
    // 本门挂在切流之后立即跑,master 此刻正冷启动(加载 pricing/catalog/host identity),
    // App boot 的首发 /api/auth/refresh 因此变慢;营销首页又是 lazy 组件,boot 未落定就
    // 没有可点的「登录」。2026-07-26 实测该步耗时 20107ms —— 只超固定 20s 阈值 107ms,
    // 却触发整批 dist 回滚,而纯 dist 对照证明新包首屏反而更快(中位 1750ms vs 1887ms)。
    // 契约:**只有 J1 的首屏落地**享受 BOOT_TIMEOUT,其余步骤一律守 STEP_TIMEOUT ——
    // 放宽范围一旦扩大,真实交互回归就会被一起放过。
    assert.match(source, /const STEP_TIMEOUT = 20_000;/)
    assert.match(source, /const BOOT_TIMEOUT = 60_000;/)
    assert.match(
      source,
      /getByText\("登录", \{ exact: true \}\)\.first\(\)\.click\(\{ timeout: BOOT_TIMEOUT \}\)/,
      'J1 首屏点击必须用 BOOT_TIMEOUT(冷启动窗口)',
    )
    // 只数**真实传参**处(注释里解释性地提到常量名不算),否则这条断言会因为写注释而红。
    const bootUses = source.match(/timeout: BOOT_TIMEOUT/g) ?? []
    // J1 首屏只有两处:goto 落地 + 点「登录」。多于此说明放宽蔓延到了别的步骤。
    assert.ok(
      bootUses.length === 2,
      `BOOT_TIMEOUT 只应用于 J1 首屏落地(goto + 首个 click),当前传参 ${bootUses.length} 处`,
    )
    assert.match(source, /getByPlaceholder\("邮箱"\)\.waitFor\(\{ state: "visible", timeout: STEP_TIMEOUT \}\)/)
  })

  test('release verification accepts public Luna and keeps hidden Luna grant-gated', (t) => {
    const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
    const schema = `oc_release_verification_${process.pid}_${Date.now()}`
    const psql = (sql: string, searchPath = false) => spawnSync(
      'psql',
      [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...(searchPath ? { PGOPTIONS: `-c search_path=${schema},public` } : {}),
        },
      },
    )

    const setup = psql(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.users (
        id BIGINT PRIMARY KEY,
        email TEXT NOT NULL,
        credits BIGINT NOT NULL
      );
      CREATE TABLE ${schema}.model_catalog (
        model_id TEXT NOT NULL,
        state TEXT NOT NULL,
        engine TEXT NOT NULL,
        provider_id TEXT NOT NULL
      );
      CREATE TABLE ${schema}.model_pricing (
        model_id TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL,
        visibility TEXT NOT NULL
      );
      CREATE TABLE ${schema}.model_visibility_grants (
        user_id BIGINT NOT NULL,
        model_id TEXT NOT NULL
      );
      CREATE TABLE ${schema}.verification_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash TEXT NOT NULL,
        user_id BIGINT NOT NULL,
        session_prefix TEXT NOT NULL,
        allowed_models TEXT[] NOT NULL,
        expected_release TEXT NOT NULL,
        expected_generation BIGINT NOT NULL,
        approval_ref TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO ${schema}.users(id,email,credits)
      VALUES (626,'v5-evals@claudeai.chat',100);
      INSERT INTO ${schema}.model_catalog(model_id,state,engine,provider_id)
      VALUES ('gpt-5.6-luna','active','codex','codex');
      INSERT INTO ${schema}.model_pricing(model_id,enabled,visibility)
      VALUES ('gpt-5.6-luna',TRUE,'public'),('deepseek-v4-flash',TRUE,'public');
    `)
    assert.equal(setup.status, 0, setup.stderr || setup.stdout)

    t.after(() => {
      const cleanup = psql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout)
    })

    const runGate = () => spawnSync(
      'bash',
      ['-c', [
        'set -euo pipefail',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'create_release_verification_run /rel/test 42',
      ].join('\n')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ALLOW_ANY_BRANCH: '1',
          DS_MODE: 'local',
          DS_DATABASE_URL: databaseUrl,
          PGOPTIONS: `-c search_path=${schema},public`,
        },
      },
    )

    const publicLuna = runGate()
    assert.equal(publicLuna.status, 0, publicLuna.stderr || publicLuna.stdout)
    assert.match(publicLuna.stdout, /verification run=/)

    const hideAndGrant = psql(`
      UPDATE model_pricing SET visibility='hidden' WHERE model_id='gpt-5.6-luna';
      INSERT INTO model_visibility_grants(user_id,model_id) VALUES (626,'gpt-5.6-luna');
    `, true)
    assert.equal(hideAndGrant.status, 0, hideAndGrant.stderr || hideAndGrant.stdout)
    const hiddenGrantedLuna = runGate()
    assert.equal(hiddenGrantedLuna.status, 0, hiddenGrantedLuna.stderr || hiddenGrantedLuna.stdout)

    const removeGrant = psql(
      "DELETE FROM model_visibility_grants WHERE user_id=626 AND model_id='gpt-5.6-luna'",
      true,
    )
    assert.equal(removeGrant.status, 0, removeGrant.stderr || removeGrant.stdout)
    const hiddenWithoutGrant = runGate()
    assert.notEqual(hiddenWithoutGrant.status, 0)
    assert.match(hiddenWithoutGrant.stderr, /two accessible models/)
  })

  test('candidate release gate is fixed-model, zero-skip, evidenced, and aborts before diagnosis', async () => {
    const [source, runner, manifestRaw, fixtures, api, ui, largeTest, statusTest] = await Promise.all([
      readFile(deploy, 'utf8'),
      readFile(sessionDisplayRunner, 'utf8'),
      readFile(incidentManifest, 'utf8'),
      readFile(sessionDisplayFixtures, 'utf8'),
      readFile(sessionDisplayApi, 'utf8'),
      readFile(sessionDisplayUi, 'utf8'),
      readFile(sessionDisplayLargeTest, 'utf8'),
      readFile(sessionDisplayStatusTest, 'utf8'),
    ])
    const manifest = JSON.parse(manifestRaw)
    assert.deepEqual(manifest.fixedLiveMatrix, [
      { engine: 'codex', model: 'gpt-5.6-luna' },
      { engine: 'ccb', model: 'deepseek-v4-flash' },
    ])
    assert.match(runner, /MATRIX=\(gpt-5\.6-luna deepseek-v4-flash\)/)
    assert.match(runner, /OC_E2E_EMAIL="v5-evals@claudeai\.chat"/)
    assert.match(runner, /OC_E2E_REQUIRE_DIRECT_TIMELINE=1/)
    assert.match(runner, /export CI=1/)
    assert.match(runner, /export NO_PROXY="127\.0\.0\.1,localhost\$\{NO_PROXY:\+,\$NO_PROXY\}"/)
    assert.match(runner, /export no_proxy="127\.0\.0\.1,localhost\$\{no_proxy:\+,\$no_proxy\}"/)
    assert.ok(runner.includes('const u=new URL(process.env.DB_URL); console.log(`${u.hostname} ${u.port||5432}`)'))
    assert.ok(!runner.includes('process.stdout.write(`${u.hostname} ${u.port||5432}`)'))
    assert.match(runner, /if\(fail\|\|skip\|\|flaky\)/)
    assert.match(runner, /\[ -z "\$\{OC_E2E_MODEL:-\}" \] \|\| die "OC_E2E_MODEL 已废止；模型矩阵不可覆盖"/)
    assert.doesNotMatch(runner, /OC_E2E_MODEL:-[a-z0-9]/)
    assert.match(fixtures, /api: \[async \(\{\}, use\) => \{[\s\S]*scope: 'worker'/)
    assert.match(fixtures, /sharedContext: \[async \(\{ browser \}, use\) => \{[\s\S]*scope: 'worker'/)
    assert.match(fixtures, /page: async \(\{ sharedContext \}, use\) => \{[\s\S]*sharedContext\.newPage\(\)/)
    assert.match(fixtures, /finally \{[\s\S]*sharedContext\.setOffline\(false\)[\s\S]*page\.close\(\)/)
    assert.doesNotMatch(fixtures, /token: \[[\s\S]*scope: 'worker'/, 'token 必须逐测试取当前安全 TTL')
    assert.match(api, /minimumRemainingMs = cfg\.turnTimeoutMs \* 2 \+ 90_000/)
    assert.match(api, /this\.cachedLogin\.accessExp \* 1000 - Date\.now\(\) > minimumRemainingMs/)
    assert.match(ui, /name: \/\^\(\?:重试\|重新尝试\|重试发送\)\$\//)
    assert.match(ui, /name: '重试', exact: true/)
    assert.match(ui, /cookie\.name === 'oc_rt'/)
    assert.match(ui, /expect\.poll\([\s\S]*timeout: 70_000[\s\S]*\.not\.toBe\('pending'\)/)
    assert.match(statusTest, /SEL\.retryExactBtn\(page\)[\s\S]*\.toHaveCount\(1\)/)
    assert.match(largeTest, /page\.waitForResponse\(/)
    assert.match(largeTest, /request\.headers\(\)\.range === 'bytes=0-0'/)
    assert.match(largeTest, /expect\(probe\.status\(\)[\s\S]*\.toBe\(206\)/)
    // 2026-07-26:原断言锁的是 `SEL.turnProcessCard(page) … .toHaveCount(0)`,而
    // `turn-process-card` 这个 testid 全仓只存在于 e2e 自己的 lib/ui.ts,被测应用里
    // 根本没有 —— 那条断言恒真。这里把锁从"缺席断言必须在"换成"正向对照必须在":
    // 大会话打开后必须真的看见非空的 assistant 正文,选择器漂移会立刻失败而不是静默恒绿。
    // 幽灵选择器本身由 scripts/check-v5-e2e-selectors.ts 整类拦截。
    // 只禁真实调用,不禁注释里提名字(spec 里留了一段说明为什么换掉它)。
    assert.doesNotMatch(largeTest, /SEL\.turnProcessCard\(/)
    assert.match(
      largeTest,
      /SEL\.assistantRows\(page\)[\s\S]*\.prose[\s\S]*toBeVisible\(/,
    )
    assert.match(largeTest, /E2E_TOOL_FINAL_MARKER/)
    const loopbackBypass = runner.indexOf('export NO_PROXY=')
    const lowercaseLoopbackBypass = runner.indexOf('export no_proxy=')
    const readinessProbe = runner.indexOf('for i in $(seq 1 40);')
    const playwrightStart = runner.indexOf('./node_modules/.bin/playwright test')
    assert.ok(
      loopbackBypass >= 0 && lowercaseLoopbackBypass >= 0 &&
        readinessProbe > loopbackBypass && readinessProbe > lowercaseLoopbackBypass &&
        playwrightStart > loopbackBypass && playwrightStart > lowercaseLoopbackBypass,
      'loopback proxy bypass must be active before candidate readiness and Playwright matrix traffic',
    )

    const canaryStart = source.indexOf('\ncanary() {')
    const canaryEnd = source.indexOf('\n# 内部账号 allowlist', canaryStart)
    const canary = source.slice(canaryStart, canaryEnd)
    const routingVerify = canary.indexOf('v5-caddy-apply.sh" --verify')
    const egressPreflight = canary.indexOf('begin_candidate_egress_transition', routingVerify)
    const fixedGate = canary.indexOf('run_candidate_release_verification', routingVerify)
    const failure = canary.indexOf('candidate regression gate failed', fixedGate)
    const abort = canary.indexOf('\n    abort', failure)
    const closeFailed = canary.indexOf('close_release_verification_run failed', abort)
    const recoveryVerify = canary.indexOf('verify_stable_predecessor_after_gate_failure', closeFailed)
    assert.ok(
      routingVerify >= 0 && egressPreflight > routingVerify && fixedGate > egressPreflight && failure > fixedGate && abort > failure &&
        closeFailed > abort && recoveryVerify > closeFailed,
      'candidate gate failure must issue official abort first, then close evidence and verify predecessor',
    )
    assert.match(source, /release_verification_evidence/)
    assert.match(source, /npm run check:v5:incidents/)
    assert.match(source, /expected_generation/)
    assert.match(source, /gate failure abort 后 runtime tuple 未恢复 exact predecessor/)
    assert.match(source, /gate failure abort 后 egress 未恢复 exact predecessor/)
    assert.match(source, /release_egress_transitions/)

    const finalizeStart = source.indexOf('\nfinalize() {')
    const finalizeEnd = source.indexOf('\n# finalize step1', finalizeStart)
    const finalize = source.slice(finalizeStart, finalizeEnd)
    assert.match(finalize, /assert_release_verification_evidence/)
    assert.ok(
      finalize.indexOf('assert_release_verification_evidence') <
        finalize.indexOf('reconcile_testing_egress_transition "$DS_generation"'),
      'missing release evidence must trigger official abort before any egress recovery action',
    )
    assert.match(finalize, /缺 exact release\/generation fixed-matrix evidence；第一动作=官方 abort/)
    assert.ok(
      finalize.indexOf('assert_release_verification_evidence') < finalize.indexOf('knowledge_planet_plugin_assert_release_compatible'),
      'finalize evidence gate must run before other candidate investigation/gates',
    )
    assert.ok(
      finalize.indexOf('reconcile_testing_egress_transition "$DS_generation"') <
        finalize.indexOf('knowledge_planet_plugin_assert_release_compatible'),
      'finalize must restore a crash-left testing egress transition before candidate handoff gates',
    )
    assert.ok(
      finalize.indexOf('finalize_run_steps') < finalize.indexOf('finalize_ready_egress_transition'),
      'egress must activate only after the master candidate has committed stable',
    )

    const handoffStart = source.indexOf('\nfinalize_ready_egress_transition()')
    const handoffEnd = source.indexOf('\nassert_v3_inactive()', handoffStart)
    const handoff = source.slice(handoffStart, handoffEnd)
    const refresh = handoff.indexOf('ACTIVE_STATE_LOADED=0')
    const resolve = handoff.indexOf('resolve_active_lane', refresh)
    const migration = handoff.indexOf('assert_release_required_migrations "$DS_active_release"', resolve)
    const transitionQuery = handoff.indexOf('release_egress_transitions', migration)
    assert.ok(
      refresh >= 0 && resolve > refresh && migration > resolve && transitionQuery > migration,
      'post-step7 active cache refresh and target migration gate must precede every egress effect',
    )
    const casFailureStart = handoff.indexOf('egress activation evidence CAS failed')
    const casFailure = handoff.slice(
      casFailureStart,
      handoff.indexOf('smoke "$ACTIVE_PORT"', casFailureStart),
    )
    assert.ok(
      casFailure.indexOf('rollback || return 1') <
        casFailure.indexOf('activate_egress_release "$predecessor" "$release"'),
      'post-stable egress evidence anomaly must issue official master rollback before egress diagnosis/repair',
    )
    const smokeFailure = handoff.slice(handoff.indexOf('egress handoff 后 smoke failed'))
    assert.ok(
      smokeFailure.indexOf('rollback || return 1') <
        smokeFailure.indexOf('activate_egress_release "$predecessor" "$release"'),
      'post-stable egress smoke anomaly must issue official master rollback before egress repair',
    )
    assert.match(handoff, /transition_generation="\$DS_generation"/)
    const reconcileStart = source.indexOf('\nreconcile_testing_egress_transition()')
    const reconcileEnd = source.indexOf('\nrollback_egress_transition_for_generation()', reconcileStart)
    const reconcile = source.slice(reconcileStart, reconcileEnd)
    assert.match(reconcile, /status='testing'/)
    assert.match(reconcile, /activate_egress_release "\$predecessor" "\$release"/)
    assert.match(reconcile, /status='ready',ready_at=NOW\(\)/)
    const recoverStart = source.indexOf('\nrecover() {')
    const recoverEnd = source.indexOf('\n# ═', recoverStart + 1)
    const recover = source.slice(recoverStart, recoverEnd)
    assert.match(recover, /canary≥READY:[\s\S]*reconcile_testing_egress_transition "\$DS_generation"/)
    assert.match(recover, /testing egress recovery failed；第一动作=官方 abort[\s\S]*\n          abort/)

    const sourced = spawnSync('bash', ['-c',
      'V5_DEPLOY_SOURCE_ONLY=1 source "$1" --dry-run; declare -F close_emergency_debt record_emergency_authorization consume_emergency_authorization set_luna_visibility run_candidate_release_verification reconcile_testing_egress_transition >/dev/null',
      'bash', deploy,
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, ALLOW_ANY_BRANCH: '1' } })
    assert.equal(sourced.status, 0, sourced.stderr || sourced.stdout)
  })

  test('dx-declared emergency containment skips only the full gate and leaves durable blocking debt', async () => {
    const source = await readFile(deploy, 'utf8')
    assert.match(source, /--emergency-containment=\*/)
    assert.match(source, /--authorize-emergency=\*/)
    assert.match(source, /--emergency-approval=\*/)
    assert.match(source, /--emergency-commit=\*/)
    assert.match(source, /--emergency-approval-evidence=\*/)
    assert.match(source, /APPROVE_P0_CONTAINMENT/)
    assert.match(source, /ongoingRealUserFinancialOrSecurityHarm/)
    assert.match(source, /smallestContainmentFirst/)
    assert.match(source, /assert_emergency_source_provenance/)
    assert.match(source, /git ls-remote --heads origin/)
    assert.match(source, /MUTATION_DEPLOY_ID="\$deploy_id"/)
    assert.match(source, /INSERT INTO emergency_containment_authorizations/)
    assert.match(source, /status='consumed',consumed_at=NOW\(\)/)
    assert.match(source, /INSERT INTO emergency_containment_debts/)
    assert.match(source, /open emergency containment debt=.*所有非恢复生产变更被阻断/)
    assert.match(source, /abort\|rollback\|recover\|hide-luna\) return 0/)
    assert.match(source, /--close-emergency-debt=\*/)
    assert.match(source, /codexReview!=='PASS'/)
    assert.match(source, /regressionTests!=='PASS'/)
    assert.match(source, /j\.ci!=='PASS'/)
    assert.match(source, /j\.commit!==process\.argv\[3\]/)

    const canaryStart = source.indexOf('\ncanary() {')
    const canaryEnd = source.indexOf('\n# 内部账号 allowlist', canaryStart)
    const canary = source.slice(canaryStart, canaryEnd)
    assert.match(canary, /consume_emergency_authorization/)
    assert.doesNotMatch(canary, /record_emergency_authorization/)
    const emergencyBranch = canary.indexOf('dx-declared emergency containment')
    const fullGate = canary.indexOf('run_candidate_release_verification')
    assert.ok(emergencyBranch >= 0 && fullGate > emergencyBranch)
    assert.match(canary, /if \[\[ -n "\$EMERGENCY_INCIDENT" \]\]; then[\s\S]*elif ! run_candidate_release_verification/)
    const finalizeStart = source.indexOf('\nfinalize() {')
    const finalizeEnd = source.indexOf('\n# finalize step1', finalizeStart)
    const finalize = source.slice(finalizeStart, finalizeEnd)
    assert.ok(
      finalize.indexOf('assert_emergency_source_provenance') <
        finalize.indexOf('assert_emergency_finalize_authorized'),
      'every emergency finalize/resume must re-pin clean canonical exact HEAD and remote provenance',
    )
    assert.match(source, /publish-luna\) set_luna_visibility public/)
    assert.match(source, /Luna public 只允许 stable active exact release\/generation/)
  })

  test('real-turn canary requires exact answer and keeps reconnect signals attempt-local', async () => {
    const source = await readFile(turnCanary, 'utf8')
    assert.match(
      source,
      /const DEFAULT_SILENCE_MS = MODEL === 'deepseek-v4-flash' \? 270_000 : 90_000/,
    )
    assert.match(
      source,
      /process\.env\.V5_TURN_SILENCE_MS \?\? DEFAULT_SILENCE_MS/,
    )
    const attemptAt = source.indexOf('const attempt = () => new Promise')
    assert.ok(attemptAt >= 0)
    const beforeAttempt = source.slice(0, attemptAt)
    assert.doesNotMatch(beforeAttempt, /let saw(Text|Final|Cost|Error)/)
    assert.match(source.slice(attemptAt), /let answerText = ''/)
    assert.match(source.slice(attemptAt), /answerText \+= b\.text/)
    assert.match(source.slice(attemptAt), /finalText = answerText\.trim\(\)/)
    assert.match(source.slice(attemptAt), /let finalText = ''/)
    assert.match(source.slice(attemptAt), /resolve\(\{ reason, sawText, sawFinal, sawCost, sawError, finalText \}\)/)
    assert.match(source, /result\.finalText === '2'/)
  })

  test('real-turn canary ignores foreign recovery frames but still fails its own exact error', async () => {
    const success = await runTurnCanaryFixture('foreign-then-success')
    assert.equal(success.code, 0, success.stderr || success.stdout)
    assert.match(success.stdout, /TURN_OK model=gpt-5\.6-sol exact_text=2 final=true cost_charged=true/)

    const ownError = await runTurnCanaryFixture('own-error')
    assert.equal(ownError.code, 1, ownError.stdout)
    assert.match(ownError.stderr, /TURN_FAILED.*own turn failed/)

    const foreignOnly = await runTurnCanaryFixture('foreign-only')
    assert.equal(foreignOnly.code, 1, foreignOnly.stdout)
    assert.match(foreignOnly.stderr, /TURN_INCOMPLETE.*resolve=silence/)
    assert.ok(
      foreignOnly.elapsedMs < 900,
      `foreign frames incorrectly refreshed the 60ms silence timer (${foreignOnly.elapsedMs}ms)`,
    )
  })

  test('candidate CCB cost fallback is exact ledger evidence and never weakens stable lanes', async () => {
    const turnSource = await readFile(turnCanary, 'utf8')
    assert.match(
      turnSource,
      /V5_CANARY_ALLOW_LEDGER_COST_EVIDENCE/,
      'turn smoke 缺显式 candidate ledger 模式',
    )
    assert.match(
      turnSource,
      /result\.reason === 'ledger-cost-evidence-required'[\s\S]*result\.finalText === '2'[\s\S]*result\.sawFinal[\s\S]*!result\.sawCost/,
      'rc=3 只能在 exactText+final 已齐且仅缺 live cost 时产生',
    )
    assert.match(
      turnSource,
      /TURN_LEDGER_PROOF_REQUIRED session=\$\{peerId\} model=\$\{MODEL\}/,
      'candidate ledger proof 必须绑定本次脚本生成的唯一 session 与精确 model',
    )
    assert.match(turnSource, /process\.exit\(3\)/, 'candidate ledger proof 必须使用独立退出码 3')

    const source = await readFile(deploy, 'utf8')
    const verifyStart = source.indexOf('\nverify_candidate_ccb_ledger_cost() {')
    const verifyEnd = source.indexOf('\nsmoke_turn_canary() {', verifyStart)
    assert.ok(verifyStart >= 0 && verifyEnd > verifyStart, '缺 candidate CCB 精确 ledger verifier')
    const verify = source.slice(verifyStart, verifyEnd)
    for (const invariant of [
      "u.email = 'v5-canary@claudeai.chat'",
      "t.user_id = 'c:' || u.id::text",
      'tc.user_id = t.user_id',
      'tc.session_id = t.session_id',
      'tc.tape_id = t.tape_id',
      'tc.billing_anchor_id = t.billing_anchor_id',
      'ur.user_id = u.id',
      'ur.request_id = tc.request_id',
      'ur.turn_key = t.turn_key',
      "t.session_id = '$session_id'",
      "t.status = 'completed'",
      "ur.model = '$model'",
      "ur.status = 'success'",
      'ur.cost_credits > 0',
      'tc.cost_credits = ur.cost_credits',
      'cl.id = ur.ledger_id',
      'cl.user_id = ur.user_id',
      "cl.ref_type = 'usage_record'",
      'cl.ref_id = ur.id::text',
      'cl.delta = -ur.cost_credits',
    ]) {
      assert.ok(verify.includes(invariant), `candidate ledger verifier 缺精确约束:${invariant}`)
    }
    assert.doesNotMatch(
      verify,
      /ur\.session_id\s*=\s*'\$session_id'/,
      'usage_records.session_id 是 engine session，不得拿它匹配 smoke client session',
    )
    assert.match(verify, /for i in \$\(seq 1 10\)/, 'ledger proof 必须短且有限轮询')
    assert.match(verify, /return 1/, 'SQL 错误/零行/关系不一致必须 fail-closed')

    const matrixStart = source.indexOf('\nsmoke_turn_matrix() {')
    const matrixEnd = source.indexOf('\n}', matrixStart)
    const matrix = source.slice(matrixStart, matrixEnd)
    assert.match(
      matrix,
      /\(\s*"\$lane" == canary-ready \|\| "\$lane" == promote-candidate\s*\) && "\$model" == deepseek-v4-flash/,
      'ledger fallback 必须同时受 candidate lane 与精确 DeepSeek 模型约束',
    )
    assert.match(matrix, /cost_evidence_mode=live/, '每个模型默认必须回到 live cost frame')
    assert.equal(
      (source.match(/V5_CANARY_ALLOW_LEDGER_COST_EVIDENCE=1/g) ?? []).length,
      1,
      'candidate ledger env 只能在受限 smoke 分支出现一次',
    )
  })

  test('baseline eval tolerates transient poll failure and records terminal result', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-v5-eval-test-'))
    dirs.push(dir)
    const bin = path.join(dir, 'bin')
    const poll = path.join(dir, 'poll-count')
    const loginCount = path.join(dir, 'login-count')
    const refreshCount = path.join(dir, 'refresh-count')
    const results = path.join(dir, 'results.jsonl')
    await mkdir(bin)
    await writeFile(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n')
    await chmod(path.join(bin, 'sleep'), 0o755)
    await writeFile(path.join(bin, 'curl'), `#!/usr/bin/env bash
set -u
poll=${JSON.stringify(poll)}
login_count=${JSON.stringify(loginCount)}
refresh_count=${JSON.stringify(refreshCount)}
args="$*"
case "$args" in
  *'/api/auth/login'*)
    n=0; [ -f "$login_count" ] && n=$(cat "$login_count"); n=$((n+1)); printf '%s' "$n" > "$login_count"
    printf '%s\\n' '{"access_token":"tok"}'
    ;;
  *'/api/auth/refresh'*)
    n=0; [ -f "$refresh_count" ] && n=$(cat "$refresh_count"); n=$((n+1)); printf '%s' "$n" > "$refresh_count"
    printf '%s\\n' '{"access_token":"tok-refreshed"}'
    ;;
  *'/api/auth/logout'*) printf '%s\\n' '{"revoked":true}' ;;
  *'/api/skills/app-connectors/evals'*)
    [ "\${FAKE_MODE:-}" = fetch-fail ] && exit 22
    printf '%s\\n' '{"evals":{"cases":[{"id":"c1"}]}}'
    ;;
  *'/api/skills/app-connectors/eval-run'*) printf '%s\\n' '{"runId":"run-1"}' ;;
  *'/api/skill-eval/run-1'*)
    n=0; [ -f "$poll" ] && n=$(cat "$poll"); n=$((n+1)); printf '%s' "$n" > "$poll"
    [ "$n" -eq 1 ] && exit 22
    case "$args" in *'Authorization: Bearer tok-refreshed'*) ;; *) exit 22 ;; esac
    if [ "\${FAKE_MODE:-}" = incomplete ]; then
      printf '%s\\n' '{"run":{"runId":"run-1","status":"done","benchmark":{"passRate":{"without":0.5},"verdict":"评测未完成"}}}'
    else
      printf '%s\\n' '{"run":{"runId":"run-1","status":"done","benchmark":{"passRate":{"without":0.5,"with":1},"verdict":"技能有效"}}}'
    fi
    ;;
  *) exit 22 ;;
esac
`)
    await chmod(path.join(bin, 'curl'), 0o755)

    const ok = spawnSync('bash', [baselineEval, 'app-connectors'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PASSWORD: 'fixture',
        OC_EVAL_RESULTS_FILE: results,
      },
    })
    assert.equal(ok.status, 0, ok.stderr || ok.stdout)
    assert.match(ok.stdout, /POLL FAILED/)
    assert.match(ok.stdout, /AUTH REFRESHED/)
    assert.equal((await readFile(loginCount, 'utf8')).trim(), '1')
    assert.equal((await readFile(refreshCount, 'utf8')).trim(), '1')
    const row = JSON.parse((await readFile(results, 'utf8')).trim())
    assert.equal(row.skill, 'app-connectors')
    assert.equal(row.status, 'done')

    await writeFile(results, '')
    const incomplete = spawnSync('bash', [baselineEval, 'app-connectors'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PASSWORD: 'fixture',
        OC_EVAL_RESULTS_FILE: results,
        FAKE_MODE: 'incomplete',
      },
    })
    assert.equal(incomplete.status, 1, incomplete.stderr || incomplete.stdout)
    assert.match(incomplete.stdout, /INCOMPLETE BENCHMARK/)
    const incompleteRow = JSON.parse((await readFile(results, 'utf8')).trim())
    assert.equal(incompleteRow.status, 'done', 'JSONL 必须保留服务端权威终态')
    assert.equal(incompleteRow.benchmark.passRate.with, undefined)

    await writeFile(results, '')
    const failed = spawnSync('bash', [baselineEval, 'app-connectors'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PASSWORD: 'fixture',
        OC_EVAL_RESULTS_FILE: results,
        FAKE_MODE: 'fetch-fail',
      },
    })
    assert.equal(failed.status, 1, failed.stderr || failed.stdout)
    const failureRow = JSON.parse((await readFile(results, 'utf8')).trim())
    assert.equal(failureRow.status, 'fetch_failed')

    const source = await readFile(baselineEval, 'utf8')
    assert.match(source, /MAX_POLLS="\$\{OC_EVAL_MAX_POLLS:-360\}"/)
    assert.match(source, /seq 1 "\$MAX_POLLS"/)
    assert.match(source, /curl -sf -b "\$COOKIE_FILE" -c "\$COOKIE_FILE" -X POST/)
    assert.match(source, /"\$V5_BASE\/api\/auth\/refresh"/)
    assert.match(source, /trap cleanup EXIT/)
  })

  test('market eval refreshes an expired bearer and cleans up with the replacement token', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-v5-market-eval-test-'))
    dirs.push(dir)
    const bin = path.join(dir, 'bin')
    const poll = path.join(dir, 'poll-count')
    const loginCount = path.join(dir, 'login-count')
    const refreshCount = path.join(dir, 'refresh-count')
    const uninstall = path.join(dir, 'uninstalled')
    await mkdir(bin)
    await writeFile(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n')
    await chmod(path.join(bin, 'sleep'), 0o755)
    await writeFile(path.join(bin, 'curl'), `#!/usr/bin/env bash
set -u
poll=${JSON.stringify(poll)}
login_count=${JSON.stringify(loginCount)}
refresh_count=${JSON.stringify(refreshCount)}
uninstall=${JSON.stringify(uninstall)}
args="$*"
case "$args" in
  *'/api/auth/login'*)
    n=0; [ -f "$login_count" ] && n=$(cat "$login_count"); n=$((n+1)); printf '%s' "$n" > "$login_count"
    printf '%s\\n' '{"access_token":"market-initial"}'
    ;;
  *'/api/auth/refresh'*)
    n=0; [ -f "$refresh_count" ] && n=$(cat "$refresh_count"); n=$((n+1)); printf '%s' "$n" > "$refresh_count"
    printf '%s\\n' '{"access_token":"market-refreshed"}'
    ;;
  *'/api/auth/logout'*) printf '%s\\n' '{"revoked":true}' ;;
  *'/api/marketplace/installed/demo'*)
    case "$args" in *'-X DELETE'*'Authorization: Bearer market-refreshed'*) : > "$uninstall" ;; *) exit 22 ;; esac
    ;;
  *'/api/marketplace/installed'*) printf '%s\\n' '{"installed":[]}' ;;
  *'/api/marketplace/install'*) printf '%s\\n' '{"ok":true}' ;;
  *'/api/marketplace/demo'*) printf '%s\\n' '{"detail":{"versionId":"v1","name":"Demo","kind":"skill"}}' ;;
  *'/api/skills/demo/evals'*) printf '%s\\n' '{"evals":{"cases":[{"id":"c1"}]}}' ;;
  *'/api/skills/demo/eval-run'*) printf '%s\\n' '{"runId":"run-market"}' ;;
  *'/api/skills'*) printf '%s\\n' '{"skills":[]}' ;;
  *'/api/skill-eval/run-market'*)
    n=0; [ -f "$poll" ] && n=$(cat "$poll"); n=$((n+1)); printf '%s' "$n" > "$poll"
    [ "$n" -eq 1 ] && exit 22
    case "$args" in *'Authorization: Bearer market-refreshed'*) ;; *) exit 22 ;; esac
    if [ "\${FAKE_MODE:-}" = incomplete ]; then
      printf '%s\\n' '{"run":{"runId":"run-market","status":"done","benchmark":{"passRate":{"without":0.5},"verdict":"评测未完成"}}}'
    else
      printf '%s\\n' '{"run":{"runId":"run-market","status":"done","benchmark":{"passRate":{"without":0.5,"with":1},"verdict":"技能有效"}}}'
    fi
    ;;
  *) exit 22 ;;
esac
`)
    await chmod(path.join(bin, 'curl'), 0o755)

    const result = spawnSync('bash', [marketEval, 'demo'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PASSWORD: 'fixture',
      },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /AUTH REFRESHED/)
    assert.equal((await readFile(loginCount, 'utf8')).trim(), '1')
    assert.equal((await readFile(refreshCount, 'utf8')).trim(), '1')
    assert.equal((await readFile(uninstall, 'utf8')).trim(), '')

    await writeFile(poll, '0')
    await rm(uninstall)
    const incomplete = spawnSync('bash', [marketEval, 'demo'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PASSWORD: 'fixture',
        FAKE_MODE: 'incomplete',
      },
    })
    assert.equal(incomplete.status, 1, incomplete.stderr || incomplete.stdout)
    assert.match(incomplete.stdout, /INCOMPLETE BENCHMARK/)
    assert.equal((await readFile(uninstall, 'utf8')).trim(), '', '失败路径仍须还原临时安装')
  })

  test('weekly baseline report is fail-closed on runner rc and incomplete platform coverage', async () => {
    const source = await readFile(baselineWeekly, 'utf8')
    const service = await readFile(baselineService, 'utf8')
    assert.match(source, /v5-evals@claudeai\.chat/)
    assert.match(source, /runner 非零退出\(rc=\{run_rc\}\)/)
    assert.match(source, /glob\.glob\(os\.path\.join\(expected_dir, '\*\/evals\/evals\.json'\)\)/)
    assert.match(source, /缺少评测结果/)
    assert.match(source, /baseline coverage: \{done_expected\}\/\{len\(expected\)\} done/)
    assert.match(service, /TimeoutStartSec=43200/, '9 个技能 × 单技能 60min 后必须保留汇总余量')
  })

  test('repository baseline eval inventory is the reviewed nine-skill set', async () => {
    const baselineSkills = path.join(root, 'packages/commercial/agent-sandbox/ccb-baseline/skills')
    const entries = await readdir(baselineSkills, { withFileTypes: true })
    const actual: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        await readFile(path.join(baselineSkills, entry.name, 'evals/evals.json'), 'utf8')
        actual.push(entry.name)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    assert.deepEqual(actual.sort(), [
      'app-connectors',
      'document-writing',
      'memory-management',
      'office-pdf',
      'office-spreadsheet',
      'scheduled-tasks',
      'scientific-figures',
      'skill-search',
      'web-context',
    ])
  })

  test('weekly baseline behavior requires one done result for every repository eval skill', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-v5-weekly-eval-test-'))
    dirs.push(dir)
    const scriptsDir = path.join(dir, 'scripts')
    const bin = path.join(dir, 'bin')
    const skillsDir = path.join(dir, 'packages/commercial/agent-sandbox/ccb-baseline/skills')
    await mkdir(scriptsDir, { recursive: true })
    await mkdir(bin)
    for (const skill of ['alpha', 'beta']) {
      const evalDir = path.join(skillsDir, skill, 'evals')
      await mkdir(evalDir, { recursive: true })
      await writeFile(path.join(evalDir, 'evals.json'), '{"cases":[{}]}')
    }
    const weekly = path.join(scriptsDir, 'v5-baseline-evals-weekly.sh')
    await cp(baselineWeekly, weekly)
    await writeFile(path.join(scriptsDir, 'v5-alert-fanout.sql'), '-- fixture\n')
    await writeFile(path.join(scriptsDir, 'run-baseline-skill-evals.sh'), `#!/usr/bin/env bash
set -u
[ "$EMAIL" = v5-evals@claudeai.chat ]
[ "$PASSWORD" = fixture-secret ]
printf '%s\\n' '{"skill":"alpha","runId":"a","status":"done","benchmark":{"passRate":{"without":0.5,"with":1},"verdict":"技能有效"}}' >> "$OC_EVAL_RESULTS_FILE"
if [ "\${FAKE_MODE:-}" != missing ]; then
  if [ "\${FAKE_MODE:-}" = incomplete ]; then
    printf '%s\\n' '{"skill":"beta","runId":"b","status":"done","benchmark":{"passRate":{"without":0.5},"verdict":"评测未完成"}}' >> "$OC_EVAL_RESULTS_FILE"
  else
    printf '%s\\n' '{"skill":"beta","runId":"b","status":"done","benchmark":{"passRate":{"without":0.5,"with":1},"verdict":"技能有效"}}' >> "$OC_EVAL_RESULTS_FILE"
  fi
fi
[ "\${FAKE_MODE:-}" = runner-fail ] && exit 7
exit 0
`)
    const psqlCapture = path.join(dir, 'psql-capture')
    await writeFile(path.join(bin, 'psql'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$PSQL_CAPTURE"\ncat >> "$PSQL_CAPTURE" || true\nexit 0\n')
    await chmod(path.join(bin, 'psql'), 0o755)
    const realPython = spawnSync('bash', ['-lc', 'command -v python3'], { encoding: 'utf8' }).stdout.trim()
    assert.ok(realPython)
    await writeFile(path.join(bin, 'python3'), `#!/usr/bin/env bash
if [ "\${FAKE_MODE:-}" = extract-fail ] && [ "\${1:-}" = -c ]; then exit 9; fi
exec ${JSON.stringify(realPython)} "$@"
`)
    await chmod(path.join(bin, 'python3'), 0o755)
    const password = path.join(dir, 'eval.password')
    const envFile = path.join(dir, 'commercial.env')
    await writeFile(password, 'fixture-secret\n')
    await writeFile(envFile, 'DATABASE_URL=postgres://fixture\n')

    const runWeekly = (mode: string, history: string, extraEnv: Record<string, string> = {}) => spawnSync('bash', [weekly], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_MODE: mode,
        OC_EVAL_HIST_DIR: history,
        OC_EVAL_PASSWORD_FILE: password,
        OC_EVAL_ENV_FILE: envFile,
        PSQL_CAPTURE: psqlCapture,
        ...extraEnv,
      },
    })

    const missing = runWeekly('missing', path.join(dir, 'hist-missing'))
    assert.equal(missing.status, 0, missing.stderr || missing.stdout)
    assert.match(missing.stdout, /回归异常 rc=0 problems=1 delivered=1/)

    const runnerFail = runWeekly('runner-fail', path.join(dir, 'hist-runner-fail'))
    assert.equal(runnerFail.status, 0, runnerFail.stderr || runnerFail.stdout)
    assert.match(runnerFail.stdout, /回归异常 rc=7 problems=1 delivered=1/)

    await writeFile(psqlCapture, '')
    const incomplete = runWeekly('incomplete', path.join(dir, 'hist-incomplete'))
    assert.equal(incomplete.status, 0, incomplete.stderr || incomplete.stdout)
    assert.match(incomplete.stdout, /回归异常 rc=0 problems=1 delivered=1/)
    assert.match(await readFile(psqlCapture, 'utf8'), /baseline coverage: 1\/2 done/)

    const summaryFail = runWeekly('complete', path.join(dir, 'hist-summary-fail'), {
      OC_EVAL_DROP_ALERT_PP: 'not-a-number',
    })
    assert.equal(summaryFail.status, 1, summaryFail.stderr || summaryFail.stdout)
    assert.match(summaryFail.stdout, /汇总基础设施失败 → 升级 OnFailure\(exit 1\)/)
    assert.doesNotMatch(summaryFail.stdout, /回归完成,全部正常/)

    const extractFail = runWeekly('extract-fail', path.join(dir, 'hist-extract-fail'))
    assert.equal(extractFail.status, 1, extractFail.stderr || extractFail.stdout)
    assert.match(extractFail.stdout, /汇总基础设施失败 → 升级 OnFailure\(exit 1\)/)
    assert.doesNotMatch(extractFail.stdout, /回归完成,全部正常/)

    const complete = runWeekly('complete', path.join(dir, 'hist-complete'))
    assert.equal(complete.status, 0, complete.stderr || complete.stdout)
    assert.match(complete.stdout, /回归完成,全部正常/)
  })
})
