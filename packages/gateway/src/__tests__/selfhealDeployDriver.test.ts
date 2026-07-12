import * as assert from 'node:assert/strict'
/**
 * Deploy driver tests (block C / design §C1). Mock runner throughout — a real
 * deploy is NEVER run by unit tests.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/selfhealDeployDriver.test.ts
 */
import { describe, it } from 'node:test'
import { createLogger } from '../logger.js'
import type { CommandRunner, RunResult } from '../selfheal/brokerActions.js'
import {
  createDeployDriver,
  listToolchainTouches,
  touchesDeployToolchain,
} from '../selfheal/deployDriver.js'

const log = createLogger({ module: 'test' })
const SHA = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)

function stubRunner(script: {
  diffFiles?: string[]
  headCode?: number
  diffCode?: number
  mergeCode?: number
  deployCode?: number
}) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = []
  const run: CommandRunner = async (cmd, args, opts): Promise<RunResult> => {
    calls.push({ cmd, args, cwd: opts?.cwd })
    if (cmd === 'git' && args.includes('rev-parse')) {
      return { code: script.headCode ?? 0, stdout: `${HEAD}\n`, stderr: '' }
    }
    if (cmd === 'git' && args.includes('diff')) {
      return {
        code: script.diffCode ?? 0,
        stdout: `${(script.diffFiles ?? []).join('\n')}\n`,
        stderr: '',
      }
    }
    if (cmd === 'git' && args.includes('merge')) {
      return { code: script.mergeCode ?? 0, stdout: '', stderr: 'merge-err' }
    }
    if (cmd === 'bash') {
      return { code: script.deployCode ?? 0, stdout: 'deployed ok', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
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

describe('createDeployDriver — three-layer sequence', () => {
  it('clean diff: diff → ff-only merge → canonical deploy script (--with-dist, cwd=repo)', async () => {
    const { run, calls } = stubRunner({ diffFiles: ['packages/gateway/src/x.ts'] })
    const notices: string[] = []
    const driver = createDeployDriver({
      canonicalRepo: '/canon',
      canonicalBranch: 'main',
      run,
      notify: (t) => notices.push(t),
    })
    const resp = await driver(SHA, { log, repairId: 'r-1' })
    assert.equal(resp.status, 'deployed')
    assert.equal(resp.ok, true)

    const seq = calls.map((c) => `${c.cmd} ${c.args[0] === '-C' ? c.args[2] : c.args[0]}`)
    assert.deepEqual(seq, [
      'git rev-parse',
      'git diff',
      'git merge',
      'bash /canon/scripts/deploy-v5.sh',
    ])
    const merge = calls[2]
    assert.deepEqual(merge?.args, ['-C', '/canon', 'merge', '--ff-only', SHA])
    const dep = calls[3]
    assert.deepEqual(dep?.args, ['/canon/scripts/deploy-v5.sh', '--with-dist'])
    assert.equal(dep?.cwd, '/canon')
    assert.equal(notices.length, 1) // success notice
  })

  it('toolchain touch: forced pending_release, NO merge, NO deploy — even on the auto path', async () => {
    const { run, calls } = stubRunner({ diffFiles: ['scripts/deploy-v5.sh', 'src/ok.ts'] })
    const notices: string[] = []
    const driver = createDeployDriver({
      canonicalRepo: '/canon',
      canonicalBranch: 'main',
      run,
      notify: (t) => notices.push(t),
    })
    const resp = await driver(SHA, { log, repairId: 'r-2' })
    assert.equal(resp.status, 'pending_release')
    assert.equal(resp.ok, false)
    assert.equal(resp.detail?.toolchain, true)
    assert.ok((resp.detail?.files as string[]).includes('scripts/deploy-v5.sh'))
    assert.ok(!calls.some((c) => c.args.includes('merge')), 'never merges')
    assert.ok(!calls.some((c) => c.cmd === 'bash'), 'never deploys')
    assert.ok(notices[0]?.includes('人工线下'), 'annotated for manual offline review')
  })

  it('ff-merge failure → deploy_failed, deploy script never runs', async () => {
    const { run, calls } = stubRunner({ diffFiles: [], mergeCode: 1 })
    const driver = createDeployDriver({ canonicalRepo: '/canon', canonicalBranch: 'main', run })
    const resp = await driver(SHA, { log })
    assert.equal(resp.status, 'deploy_failed')
    assert.equal(resp.detail?.step, 'ff-merge')
    assert.ok(!calls.some((c) => c.cmd === 'bash'))
  })

  it('deploy script failure → deploy_failed with the output tail', async () => {
    const { run } = stubRunner({ diffFiles: [], deployCode: 2 })
    const driver = createDeployDriver({ canonicalRepo: '/canon', canonicalBranch: 'main', run })
    const resp = await driver(SHA, { log })
    assert.equal(resp.status, 'deploy_failed')
    assert.equal(resp.detail?.step, 'deploy')
    assert.equal(resp.detail?.code, 2)
  })

  it('git head/diff failure fails CLOSED (no merge, no deploy)', async () => {
    const { run, calls } = stubRunner({ headCode: 1 })
    const driver = createDeployDriver({ canonicalRepo: '/canon', canonicalBranch: 'main', run })
    const resp = await driver(SHA, { log })
    assert.equal(resp.status, 'deploy_failed')
    assert.ok(!calls.some((c) => c.args.includes('merge')))
    assert.ok(!calls.some((c) => c.cmd === 'bash'))
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
