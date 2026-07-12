import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  type BrokerRequest,
  type BrokerResponse,
  InMemoryBrokerClaimStore,
  type RepairAuthority,
  SelfhealBroker,
} from '../selfheal/broker.js'
import type { CommandRunner, RunResult } from '../selfheal/brokerActions.js'
import { type VerificationResult, signVerification } from '../selfheal/verifier.js'

const VERIFY_KEY = 'test-verify-hmac-signing-key-1234'

// Capability authorization test fixtures: an active repair holding CAP.
const CAP = 'test-capability-token-xyz'
const activeAuthority: RepairAuthority = async () => ({ status: 'running', capability: CAP })

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

function writeSignedVerification(dir: string, result: VerificationResult): void {
  const signed = signVerification(result, VERIFY_KEY)
  writeFileSync(join(dir, `${result.repairId}.json`), JSON.stringify(signed))
}

function setOrUnset(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe('SelfhealBroker Tier1', () => {
  const savedUnits = process.env.OC_SELFHEAL_RESTART_UNITS
  afterEach(() => {
    setOrUnset('OC_SELFHEAL_RESTART_UNITS', savedUnits)
  })

  it('restart_service runs systemctl for an allowlisted unit', async () => {
    process.env.OC_SELFHEAL_RESTART_UNITS = 'openclaude-v5, openclaude-v5-egress'
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      run,
    })
    const resp = await broker.handleRequest({
      repairId: 'r1',
      capability: CAP,
      actionKind: 'restart_service',
      params: { unit: 'openclaude-v5' },
    })
    assert.equal(resp.ok, true)
    assert.equal(resp.status, 'restarted')
    assert.deepEqual(calls[0], { cmd: 'systemctl', args: ['restart', 'openclaude-v5'] })
  })

  it('restart_service rejects a unit not in the allowlist', async () => {
    process.env.OC_SELFHEAL_RESTART_UNITS = 'openclaude-v5'
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      run,
    })
    const resp = await broker.handleRequest({
      repairId: 'r2',
      capability: CAP,
      actionKind: 'restart_service',
      params: { unit: 'sshd' },
    })
    assert.equal(resp.ok, false)
    assert.equal(resp.status, 'rejected')
    assert.equal(calls.length, 0, 'no command must run for a rejected unit')
  })

  it('rejects an unknown action kind', async () => {
    const broker = new SelfhealBroker({ socketPath: '/unused', store: new InMemoryBrokerClaimStore(), repairAuthority: activeAuthority })
    const resp = await broker.handleRequest({
      repairId: 'r3',
      capability: CAP,
      actionKind: 'rm_rf_slash',
      params: {},
    })
    assert.equal(resp.status, 'rejected')
  })

  it('clean_disk docker prunes objects only (never volumes)', async () => {
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      run,
    })
    const resp = await broker.handleRequest({
      repairId: 'r4',
      capability: CAP,
      actionKind: 'clean_disk',
      params: { target: 'docker' },
    })
    assert.equal(resp.ok, true)
    assert.deepEqual(calls[0], { cmd: 'docker', args: ['system', 'prune', '-f'] })
    assert.ok(!calls[0]!.args.includes('--volumes'), 'must never prune volumes (data red-line)')
  })

  it('switch_node is a reserved no-op', async () => {
    const broker = new SelfhealBroker({ socketPath: '/unused', store: new InMemoryBrokerClaimStore(), repairAuthority: activeAuthority })
    const resp = await broker.handleRequest({
      repairId: 'r5',
      capability: CAP,
      actionKind: 'switch_node',
      params: {},
    })
    assert.equal(resp.status, 'reserved')
  })

  it('is idempotent per repairId+actionKind (replay protection)', async () => {
    process.env.OC_SELFHEAL_RESTART_UNITS = 'openclaude-v5'
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      run,
    })
    const req: BrokerRequest = {
      repairId: 'r6',
      capability: CAP,
      actionKind: 'restart_service',
      params: { unit: 'openclaude-v5' },
    }
    const first = await broker.handleRequest(req)
    const second = await broker.handleRequest(req)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(second.detail?.replayed, true)
    assert.equal(calls.length, 1, 'a replayed request must NOT re-execute')
  })
})

describe('SelfhealBroker authorization (capability + repair record)', () => {
  it('rejects when the repair is unknown (forged repairId)', async () => {
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: async () => null, // no such repair
      run,
    })
    const resp = await broker.handleRequest({
      repairId: 'ghost',
      capability: CAP,
      actionKind: 'switch_node',
      params: {},
    })
    assert.equal(resp.status, 'unauthorized')
    assert.match(String(resp.detail?.reason), /unknown repair/)
    assert.equal(calls.length, 0)
  })

  it('rejects a wrong capability and does not execute', async () => {
    process.env.OC_SELFHEAL_RESTART_UNITS = 'openclaude-v5'
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      run,
    })
    const resp = await broker.handleRequest({
      repairId: 'r1',
      capability: 'wrong-token-of-len',
      actionKind: 'restart_service',
      params: { unit: 'openclaude-v5' },
    })
    assert.equal(resp.status, 'unauthorized')
    assert.match(String(resp.detail?.reason), /capability mismatch/)
    assert.equal(calls.length, 0, 'unauthorized request must never execute')
    delete process.env.OC_SELFHEAL_RESTART_UNITS
  })

  it('rejects a missing capability', async () => {
    const { run } = stubRunner(() => ({ code: 0 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      run,
    })
    const resp = await broker.handleRequest({
      repairId: 'r1',
      actionKind: 'switch_node',
      params: {},
    })
    assert.equal(resp.status, 'unauthorized')
  })

  it('rejects when the repair is not in an active state', async () => {
    const { run } = stubRunner(() => ({ code: 0 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: async () => ({ status: 'succeeded', capability: CAP }),
      run,
    })
    const resp = await broker.handleRequest({
      repairId: 'r1',
      capability: CAP,
      actionKind: 'switch_node',
      params: {},
    })
    assert.equal(resp.status, 'unauthorized')
    assert.match(String(resp.detail?.reason), /not active/)
  })
})

describe('SelfhealBroker Tier2 cutover', () => {
  let vdir: string
  const SHA = 'a'.repeat(40)

  beforeEach(() => {
    vdir = mkdtempSync(join(tmpdir(), 'oc-verif-'))
  })
  afterEach(() => {
    rmSync(vdir, { recursive: true, force: true })
  })

  function passingVerification(repairId: string, sha = SHA): VerificationResult {
    return {
      repairId,
      sha,
      clonePath: `/home/ocheal/selfheal/${repairId}`,
      layers: [{ name: 'typecheck', ok: true, code: 0, durationMs: 1 }],
      allPassed: true,
      verifiedAt: new Date().toISOString(),
    }
  }

  function makeBroker(opts: Partial<ConstructorParameters<typeof SelfhealBroker>[0]> = {}) {
    const { run, calls } = stubRunner((cmd, args) => {
      // ancestry check: merge-base --is-ancestor → exit 0 (descendant)
      if (cmd === 'git' && args.includes('merge-base')) return { code: 0 }
      return { code: 0 }
    })
    const pending: { repairId: string; sha: string }[] = []
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      verifyKey: VERIFY_KEY,
      verificationDir: vdir,
      canonicalRepo: '/canon',
      run,
      notifyPendingRelease: (i) => pending.push(i),
      ...opts,
    })
    return { broker, calls, pending }
  }

  it('default posture (AUTO_DEPLOY_TIER2 off) holds a fully-gated cutover for release', async () => {
    writeSignedVerification(vdir, passingVerification('c1'))
    let deployed = false
    const { broker, pending } = makeBroker({
      autoDeployTier2: false,
      deployDriver: async () => {
        deployed = true
        return { ok: true, status: 'deployed' }
      },
    })
    const resp = await broker.handleRequest({
      repairId: 'c1',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c1' },
    })
    assert.equal(resp.status, 'pending_release')
    assert.equal(resp.ok, false)
    assert.equal(deployed, false, 'must NOT auto-deploy when AUTO_DEPLOY_TIER2=0')
    assert.deepEqual(pending, [{ repairId: 'c1', sha: SHA }])
  })

  it('AUTO_DEPLOY_TIER2 on runs the trusted deploy driver after all gates', async () => {
    writeSignedVerification(vdir, passingVerification('c2'))
    const seen: string[] = []
    const { broker } = makeBroker({
      autoDeployTier2: true,
      deployDriver: async (sha) => {
        seen.push(sha)
        return { ok: true, status: 'deployed', detail: { sha } }
      },
    })
    const resp = await broker.handleRequest({
      repairId: 'c2',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c2' },
    })
    assert.equal(resp.status, 'deployed')
    assert.deepEqual(seen, [SHA])
  })

  it('rejects a tampered verification signature', async () => {
    // Write a valid signed verification, then corrupt the stored signature.
    const result = passingVerification('c3')
    const signed = signVerification(result, VERIFY_KEY)
    signed.sig = `${signed.sig.slice(0, -2)}00`
    writeFileSync(join(vdir, 'c3.json'), JSON.stringify(signed))
    const { broker } = makeBroker({ autoDeployTier2: true })
    const resp = await broker.handleRequest({
      repairId: 'c3',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c3' },
    })
    assert.equal(resp.status, 'rejected')
    assert.match(String(resp.detail?.reason), /signature invalid/)
  })

  it('rejects when verification did not pass all layers', async () => {
    const result = { ...passingVerification('c4'), allPassed: false }
    writeSignedVerification(vdir, result)
    const { broker } = makeBroker({ autoDeployTier2: true })
    const resp = await broker.handleRequest({
      repairId: 'c4',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c4' },
    })
    assert.equal(resp.status, 'rejected')
    assert.match(String(resp.detail?.reason), /did not pass/)
  })

  it('rejects when sha is not a descendant of canonical branch', async () => {
    writeSignedVerification(vdir, passingVerification('c5'))
    const { run } = stubRunner((cmd, args) => {
      if (cmd === 'git' && args.includes('merge-base')) return { code: 1 } // NOT ancestor
      return { code: 0 }
    })
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      verifyKey: VERIFY_KEY,
      verificationDir: vdir,
      autoDeployTier2: true,
      run,
      deployDriver: async () => ({ ok: true, status: 'deployed' }),
    })
    const resp = await broker.handleRequest({
      repairId: 'c5',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c5' },
    })
    assert.equal(resp.status, 'rejected')
    assert.match(String(resp.detail?.reason), /not a descendant/)
  })

  it('rejects a verification whose sha does not match the request', async () => {
    writeSignedVerification(vdir, passingVerification('c6', 'b'.repeat(40)))
    const { broker } = makeBroker({ autoDeployTier2: true })
    const resp = await broker.handleRequest({
      repairId: 'c6',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c6' },
    })
    assert.equal(resp.status, 'rejected')
    assert.match(String(resp.detail?.reason), /sha mismatch/)
  })

  it('rejects a malformed sha before touching anything', async () => {
    const { broker } = makeBroker({ autoDeployTier2: true })
    const resp: BrokerResponse = await broker.handleRequest({
      repairId: 'c7',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: 'not-a-sha', verificationRef: 'c7' },
    })
    assert.equal(resp.status, 'rejected')
  })
})
