import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { CommandRunner, RunResult } from '../selfheal/brokerActions.js'
import {
  type VerificationResult,
  loadSignedVerification,
  prepareClone,
  signVerification,
  stableStringify,
  verify,
  verifySignature,
} from '../selfheal/verifier.js'

const KEY = 'verifier-test-hmac-signing-key-abc'

function baseResult(over: Partial<VerificationResult> = {}): VerificationResult {
  return {
    repairId: 'v1',
    sha: 'c'.repeat(40),
    clonePath: '/home/ocheal/selfheal/v1',
    layers: [{ name: 'typecheck', ok: true, code: 0, durationMs: 5 }],
    allPassed: true,
    verifiedAt: '2026-07-11T00:00:00.000Z',
    ...over,
  }
}

function stubRunner(handler: (cmd: string, args: string[]) => Partial<RunResult> | undefined): {
  run: CommandRunner
  calls: { cmd: string; args: string[] }[]
} {
  const calls: { cmd: string; args: string[] }[] = []
  const run: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args })
    const r = handler(cmd, args) ?? {}
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  return { run, calls }
}

describe('verifier signing', () => {
  it('stableStringify is key-order independent', () => {
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
    assert.equal(stableStringify({ a: [3, { y: 1, x: 2 }] }), '{"a":[3,{"x":2,"y":1}]}')
  })

  it('sign + verify round-trips', () => {
    const signed = signVerification(baseResult(), KEY)
    assert.equal(verifySignature(signed, KEY), true)
  })

  it('detects a tampered result (allPassed flip)', () => {
    const signed = signVerification(baseResult(), KEY)
    signed.result.allPassed = false
    assert.equal(verifySignature(signed, KEY), false)
  })

  it('detects a wrong key', () => {
    const signed = signVerification(baseResult(), KEY)
    assert.equal(verifySignature(signed, 'a-different-key-of-sufficient-len'), false)
  })

  it('requires a signing key of adequate length', () => {
    assert.throws(() => signVerification(baseResult(), 'short'), /required/)
  })
})

describe('verifier.verify orchestration', () => {
  let vdir: string
  let cwd: string
  beforeEach(() => {
    vdir = mkdtempSync(join(tmpdir(), 'oc-vout-'))
    cwd = mkdtempSync(join(tmpdir(), 'oc-clone-'))
  })
  afterEach(() => {
    rmSync(vdir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('runs install + 4 layers, signs, and persists a loadable result on success', async () => {
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    const out = await verify({
      repairId: 'v2',
      sha: 'd'.repeat(40),
      clonePath: cwd,
      worktreeDir: join(cwd, '.verify'),
      verificationDir: vdir,
      signingKey: KEY,
      run,
    })
    assert.equal(out.signed.result.allPassed, true)
    // worktree add, then install, then the 4 layers = 6 runner calls
    assert.equal(calls[0]!.cmd, 'git')
    assert.ok(calls[0]!.args.includes('worktree'))
    const npmScripts = calls.filter((c) => c.cmd === 'npm').map((c) => c.args.join(' '))
    assert.deepEqual(npmScripts, [
      `--prefix ${join(cwd, '.verify')} ci`,
      `--prefix ${join(cwd, '.verify')} run lint`,
      `--prefix ${join(cwd, '.verify')} run typecheck`,
      `--prefix ${join(cwd, '.verify')} run test:gateway`,
      `--prefix ${join(cwd, '.verify')} run test:web`,
    ])
    // Persisted + loadable + signature valid.
    const loaded = loadSignedVerification('v2', vdir)
    assert.equal(verifySignature(loaded, KEY), true)
    assert.equal(loaded.result.allPassed, true)
  })

  it('short-circuits on a failing layer (allPassed=false, later layers skipped)', async () => {
    const { run, calls } = stubRunner((cmd, args) => {
      if (cmd === 'npm' && args.includes('typecheck')) return { code: 2, stderr: 'boom' }
      return { code: 0 }
    })
    const out = await verify({
      repairId: 'v3',
      sha: 'e'.repeat(40),
      clonePath: cwd,
      worktreeDir: join(cwd, '.verify'),
      verificationDir: vdir,
      signingKey: KEY,
      run,
    })
    assert.equal(out.signed.result.allPassed, false)
    const ran = calls.filter((c) => c.cmd === 'npm').map((c) => c.args[c.args.length - 1])
    // install, lint, typecheck ran; test:gateway / test:web must NOT run.
    assert.ok(ran.includes('typecheck'))
    assert.ok(!ran.includes('test:gateway'), 'must fail fast before later layers')
  })
})

describe('verifier.prepareClone', () => {
  it('clones from canonical, strips origin, and chowns to ocheal', async () => {
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    const res = await prepareClone({
      repairId: 'p1',
      canonicalRepo: '/opt/openclaude/openclaude-v5-aurora',
      canonicalBranch: 'feat/v5-aurora-rewrite',
      ochealSelfhealRoot: '/home/ocheal/selfheal',
      ochealUid: 997,
      ochealGid: 998,
      run,
    })
    assert.equal(res.clonePath, '/home/ocheal/selfheal/p1')
    const cmds = calls.map((c) => `${c.cmd} ${c.args.slice(0, 3).join(' ')}`)
    assert.ok(cmds.some((c) => c.startsWith('git clone --no-hardlinks')))
    assert.ok(
      calls.some((c) => c.cmd === 'git' && c.args.join(' ').includes('remote remove origin')),
    )
    assert.ok(
      calls.some((c) => c.cmd === 'chown' && c.args.includes('997:998')),
      'must chown the clone to ocheal',
    )
  })

  it('fails closed when the clone command fails', async () => {
    const { run } = stubRunner((cmd, args) => {
      if (cmd === 'git' && args[0] === 'clone') return { code: 128, stderr: 'fatal' }
      return { code: 0 }
    })
    await assert.rejects(
      prepareClone({
        repairId: 'p2',
        canonicalRepo: '/canon',
        canonicalBranch: 'feat/v5-aurora-rewrite',
        ochealUid: 997,
        ochealGid: 998,
        run,
      }),
      /clone failed/,
    )
  })
})
