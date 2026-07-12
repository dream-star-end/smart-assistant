import * as assert from 'node:assert/strict'
/**
 * Deploy driver tests (block C / design §C1 + HIGH1 race hardening). Mock
 * runner AND mock lock throughout — a real deploy / a real /var/lock flock is
 * NEVER touched by unit tests.
 *
 * HIGH1 semantics under test: the whole diff→merge→deploy→final-verify runs
 * under an injected cutover lock; after the ff-only merge HEAD must EQUAL the
 * target sha (an already-ancestor sha merges as a silent no-op when canonical
 * moved past it — must abort, not deploy); after the deploy script HEAD must
 * STILL equal the sha (concurrent advance mid-deploy ⇒ deployed tree may be
 * ahead — reported, never claimed 'deployed').
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/selfhealDeployDriver.test.ts
 */
import { describe, it } from 'node:test'
import { createLogger } from '../logger.js'
import type { CommandRunner, RunResult } from '../selfheal/brokerActions.js'
import {
  type LockAcquirer,
  createDeployDriver,
  listToolchainTouches,
  touchesDeployToolchain,
} from '../selfheal/deployDriver.js'

const log = createLogger({ module: 'test' })
const SHA = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const DRIFT = 'c'.repeat(40)

/**
 * Stateful runner: `git rev-parse HEAD` reflects the simulated canonical HEAD,
 * which a successful ff-only merge fast-forwards to the merged sha (unless the
 * scenario pins a drift), and which the deploy step may concurrently advance.
 */
function stubRunner(script: {
  diffFiles?: string[]
  headCode?: number
  diffCode?: number
  mergeCode?: number
  deployCode?: number
  /** HEAD after a "successful" merge (default: the merged sha). Models the
   *  ff-only no-op when canonical already moved past the target sha. */
  headAfterMerge?: string
  /** HEAD after the deploy script ran (default: unchanged). Models a
   *  concurrent canonical advance mid-deploy. */
  headAfterDeploy?: string
}) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = []
  let head = HEAD
  const run: CommandRunner = async (cmd, args, opts): Promise<RunResult> => {
    calls.push({ cmd, args, cwd: opts?.cwd })
    if (cmd === 'git' && args.includes('rev-parse')) {
      return { code: script.headCode ?? 0, stdout: `${head}\n`, stderr: '' }
    }
    if (cmd === 'git' && args.includes('diff')) {
      return {
        code: script.diffCode ?? 0,
        stdout: `${(script.diffFiles ?? []).join('\n')}\n`,
        stderr: '',
      }
    }
    if (cmd === 'git' && args.includes('merge')) {
      const code = script.mergeCode ?? 0
      if (code === 0) head = script.headAfterMerge ?? (args[args.length - 1] as string)
      return { code, stdout: '', stderr: 'merge-err' }
    }
    if (cmd === 'bash') {
      if ((script.deployCode ?? 0) === 0 && script.headAfterDeploy !== undefined) {
        head = script.headAfterDeploy
      }
      return { code: script.deployCode ?? 0, stdout: 'deployed ok', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

/** Injected cutover lock: records acquire/release order; can simulate a held
 *  lock (timeout). */
function fakeLock(opts: { busy?: boolean } = {}) {
  const events: string[] = []
  const paths: string[] = []
  const acquire: LockAcquirer = async (lockPath, timeoutSec) => {
    paths.push(lockPath)
    if (opts.busy) {
      throw new Error(`cutover flock ${lockPath} not acquired within ${timeoutSec}s`)
    }
    events.push('acquire')
    return () => {
      events.push('release')
    }
  }
  return { events, paths, acquire }
}

function makeDriver(
  runner: ReturnType<typeof stubRunner>,
  lock: ReturnType<typeof fakeLock>,
  extra: Partial<Parameters<typeof createDeployDriver>[0]> = {},
) {
  return createDeployDriver({
    canonicalRepo: '/canon',
    canonicalBranch: 'main',
    run: runner.run,
    acquireLock: lock.acquire,
    ...extra,
  })
}

describe('touchesDeployToolchain — denylist matcher', () => {
  it('flags scripts/**, deploy/**, .github/**, root package.json, and any *.sh', () => {
    assert.deepEqual(
      touchesDeployToolchain([
        'scripts/deploy-v5.sh',
        'deploy/unit.service',
        '.github/workflows/ci.yml',
        'package.json',
        'packages/gateway/tools/fix.sh',
        'packages/gateway/src/server.ts',
        'packages/web-react/package.json',
      ]),
      [
        'scripts/deploy-v5.sh',
        'deploy/unit.service',
        '.github/workflows/ci.yml',
        'package.json',
        'packages/gateway/tools/fix.sh',
      ],
    )
  })
  it('does not flag ordinary source files', () => {
    assert.deepEqual(touchesDeployToolchain(['packages/gateway/src/a.ts', 'docs/x.md']), [])
  })
})

describe('createDeployDriver — locked sequence + HEAD assertions (HIGH1)', () => {
  it('clean diff: lock → diff → ff-only merge → HEAD==sha → deploy → HEAD still==sha → release', async () => {
    const runner = stubRunner({ diffFiles: ['packages/gateway/src/x.ts'] })
    const lock = fakeLock()
    const notices: string[] = []
    const driver = makeDriver(runner, lock, { notify: (t) => notices.push(t) })
    const resp = await driver(SHA, { log, repairId: 'r-1' })
    assert.equal(resp.status, 'deployed')
    assert.equal(resp.ok, true)
    assert.equal(resp.detail?.sha, SHA)
    assert.equal(resp.detail?.headAfterDeploy, SHA, 'final HEAD reported')

    // Sequence: toolchain probe (rev-parse+diff), merge, post-merge assert,
    // deploy, post-deploy assert.
    const seq = runner.calls.map((c) => `${c.cmd} ${c.args[0] === '-C' ? c.args[2] : c.args[0]}`)
    assert.deepEqual(seq, [
      'git rev-parse',
      'git diff',
      'git merge',
      'git rev-parse',
      'bash /canon/scripts/deploy-v5.sh',
      'git rev-parse',
    ])
    const merge = runner.calls[2]
    assert.deepEqual(merge?.args, ['-C', '/canon', 'merge', '--ff-only', SHA])
    const dep = runner.calls[4]
    assert.deepEqual(dep?.args, ['/canon/scripts/deploy-v5.sh', '--with-dist'])
    assert.equal(dep?.cwd, '/canon')
    assert.equal(notices.length, 1) // success notice
    // The lock brackets the WHOLE cutover.
    assert.deepEqual(lock.events, ['acquire', 'release'])
    assert.deepEqual(lock.paths, ['/var/lock/oc-selfheal-cutover.lock'])
  })

  it('lock held elsewhere: deploy_failed(step=lock), ZERO git/bash activity', async () => {
    const runner = stubRunner({ diffFiles: [] })
    const lock = fakeLock({ busy: true })
    const driver = makeDriver(runner, lock)
    const resp = await driver(SHA, { log, repairId: 'r-lock' })
    assert.equal(resp.status, 'deploy_failed')
    assert.equal(resp.detail?.step, 'lock')
    assert.match(String(resp.detail?.reason), /not acquired/)
    assert.equal(runner.calls.length, 0, 'nothing runs without the lock')
  })

  it('HEAD drift after merge (canonical moved past sha): abort, NO deploy, lock released', async () => {
    // ff-only "merge" of an already-ancestor sha exits 0 but leaves HEAD ahead.
    const runner = stubRunner({ diffFiles: [], headAfterMerge: DRIFT })
    const lock = fakeLock()
    const driver = makeDriver(runner, lock)
    const resp = await driver(SHA, { log, repairId: 'r-drift' })
    assert.equal(resp.status, 'deploy_failed')
    assert.equal(resp.detail?.step, 'head-assert')
    assert.equal(resp.detail?.head, DRIFT)
    assert.match(
      String(resp.detail?.reason),
      /canonical moved past target sha — re-release required/,
    )
    assert.ok(!runner.calls.some((c) => c.cmd === 'bash'), 'deploy script never runs')
    assert.deepEqual(lock.events, ['acquire', 'release'])
  })

  it('HEAD drift DURING deploy: deploy_failed with {sha, headAfterDeploy}, never claims deployed', async () => {
    const runner = stubRunner({ diffFiles: [], headAfterDeploy: DRIFT })
    const lock = fakeLock()
    const notices: string[] = []
    const driver = makeDriver(runner, lock, { notify: (t) => notices.push(t) })
    const resp = await driver(SHA, { log, repairId: 'r-mid' })
    assert.equal(resp.status, 'deploy_failed')
    assert.equal(resp.ok, false)
    assert.equal(resp.detail?.step, 'post-deploy-assert')
    assert.equal(resp.detail?.sha, SHA)
    assert.equal(resp.detail?.headAfterDeploy, DRIFT)
    assert.match(String(resp.detail?.reason), /deployed tree may be ahead/)
    assert.ok(
      notices.some((n) => n.includes('人工核对')),
      'flagged for manual verification',
    )
    assert.deepEqual(lock.events, ['acquire', 'release'])
  })

  it('toolchain touch: forced pending_release, NO merge, NO deploy — lock still released', async () => {
    const runner = stubRunner({ diffFiles: ['scripts/deploy-v5.sh', 'src/ok.ts'] })
    const lock = fakeLock()
    const notices: string[] = []
    const driver = makeDriver(runner, lock, { notify: (t) => notices.push(t) })
    const resp = await driver(SHA, { log, repairId: 'r-2' })
    assert.equal(resp.status, 'pending_release')
    assert.equal(resp.ok, false)
    assert.equal(resp.detail?.toolchain, true)
    assert.ok((resp.detail?.files as string[]).includes('scripts/deploy-v5.sh'))
    assert.ok(!runner.calls.some((c) => c.args.includes('merge')), 'never merges')
    assert.ok(!runner.calls.some((c) => c.cmd === 'bash'), 'never deploys')
    assert.ok(notices[0]?.includes('人工线下'), 'annotated for manual offline review')
    assert.deepEqual(lock.events, ['acquire', 'release'])
  })

  it('ff-merge failure → deploy_failed, deploy script never runs, lock released', async () => {
    const runner = stubRunner({ diffFiles: [], mergeCode: 1 })
    const lock = fakeLock()
    const driver = makeDriver(runner, lock)
    const resp = await driver(SHA, { log })
    assert.equal(resp.status, 'deploy_failed')
    assert.equal(resp.detail?.step, 'ff-merge')
    assert.ok(!runner.calls.some((c) => c.cmd === 'bash'))
    assert.deepEqual(lock.events, ['acquire', 'release'])
  })

  it('deploy script failure → deploy_failed with the output tail', async () => {
    const runner = stubRunner({ diffFiles: [], deployCode: 2 })
    const lock = fakeLock()
    const driver = makeDriver(runner, lock)
    const resp = await driver(SHA, { log })
    assert.equal(resp.status, 'deploy_failed')
    assert.equal(resp.detail?.step, 'deploy')
    assert.equal(resp.detail?.code, 2)
    assert.deepEqual(lock.events, ['acquire', 'release'])
  })

  it('git head/diff failure fails CLOSED (no merge, no deploy)', async () => {
    const runner = stubRunner({ headCode: 1 })
    const lock = fakeLock()
    const driver = makeDriver(runner, lock)
    const resp = await driver(SHA, { log })
    assert.equal(resp.status, 'deploy_failed')
    assert.ok(!runner.calls.some((c) => c.args.includes('merge')))
    assert.ok(!runner.calls.some((c) => c.cmd === 'bash'))
    assert.deepEqual(lock.events, ['acquire', 'release'])
  })

  it('a custom lock path is honored', async () => {
    const runner = stubRunner({ diffFiles: [] })
    const lock = fakeLock()
    const driver = makeDriver(runner, lock, { cutoverLockPath: '/tmp/custom-cutover.lock' })
    await driver(SHA, { log })
    assert.deepEqual(lock.paths, ['/tmp/custom-cutover.lock'])
  })
})

describe('listToolchainTouches', () => {
  it('returns null on git failure (callers fail closed)', async () => {
    const { run } = stubRunner({ diffCode: 1 })
    assert.equal(await listToolchainTouches(run, '/canon', SHA), null)
  })
  it('returns only the denylisted files', async () => {
    const { run } = stubRunner({ diffFiles: ['a.ts', 'deploy/x.service'] })
    assert.deepEqual(await listToolchainTouches(run, '/canon', SHA), ['deploy/x.service'])
  })
})
