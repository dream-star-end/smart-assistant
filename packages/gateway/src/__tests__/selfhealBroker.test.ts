import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { SelfhealCallbackPhase } from '@openclaude/storage'
import {
  type BrokerRequest,
  type BrokerResponse,
  InMemoryBrokerClaimStore,
  type RepairAuthority,
  SelfhealBroker,
  releaseHttpStatusFor,
} from '../selfheal/broker.js'
import { type CommandRunner, type RunResult, TIER1_ACTIONS } from '../selfheal/brokerActions.js'
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
      actions: TIER1_ACTIONS,
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
      actions: TIER1_ACTIONS,
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
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      actions: TIER1_ACTIONS,
      repairAuthority: activeAuthority,
    })
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
      actions: TIER1_ACTIONS,
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
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      actions: TIER1_ACTIONS,
      repairAuthority: activeAuthority,
    })
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
      actions: TIER1_ACTIONS,
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
      actions: TIER1_ACTIONS,
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
      actions: TIER1_ACTIONS,
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
    setOrUnset('OC_SELFHEAL_RESTART_UNITS', undefined)
  })

  // Block C trust-model change: the capability NEVER reaches the ocheal/codex
  // side (M-capability), so a socket request cannot be required to present it.
  // Authorization = socket ACL + ACTIVE repair; a presented-but-wrong capability
  // is still always rejected (previous test above).
  it('allows a request WITHOUT a capability for an active repair (block C posture)', async () => {
    const { run } = stubRunner(() => ({ code: 0 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      actions: TIER1_ACTIONS,
      repairAuthority: activeAuthority,
      run,
    })
    const resp = await broker.handleRequest({
      repairId: 'r1',
      actionKind: 'switch_node',
      params: {},
    })
    assert.equal(resp.status, 'reserved', 'no-capability request reaches the action')
  })

  it('rejects when the repair is not in an active state', async () => {
    const { run } = stubRunner(() => ({ code: 0 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      actions: TIER1_ACTIONS,
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

// ── block C: context / verify / report socket kinds ──────────────────────────

function fetchStub(
  handler: (url: string, init?: RequestInit) => { status: number; body?: unknown },
) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = handler(String(url), init)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => JSON.stringify(r.body ?? {}),
      json: async () => r.body ?? {},
    }
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('broker context kind — root-held capability, transparent JSON', () => {
  it('GETs the master context with Bearer <job capability> and returns the JSON', async () => {
    const { impl, calls } = fetchStub(() => ({
      status: 200,
      body: { incident: { id: 'inc-1' }, level: 'auto_repair' },
    }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      callbackBaseUrl: 'http://127.0.0.1:18796',
      fetchImpl: impl,
    })
    const resp = await broker.handleRequest({
      repairId: 'ctx-1',
      actionKind: 'context',
      params: {},
    })
    assert.equal(resp.ok, true)
    assert.equal(resp.status, 'ok')
    assert.deepEqual(resp.detail?.context, { incident: { id: 'inc-1' }, level: 'auto_repair' })
    assert.equal(calls[0]?.url, 'http://127.0.0.1:18796/internal/v5/repairs/ctx-1/context')
    assert.equal(
      (calls[0]?.init?.headers as Record<string, string>)?.Authorization,
      `Bearer ${CAP}`,
      'the ROOT-held job capability authenticates the fetch — never supplied by the caller',
    )
  })

  it('maps a master error to context_failed (retryable — claim released)', async () => {
    const { impl } = fetchStub(() => ({ status: 503 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      callbackBaseUrl: 'http://127.0.0.1:18796',
      fetchImpl: impl,
    })
    const r1 = await broker.handleRequest({ repairId: 'ctx-2', actionKind: 'context', params: {} })
    assert.equal(r1.status, 'context_failed')
    // Failure released the claim → the retry re-executes (not in_progress).
    const r2 = await broker.handleRequest({ repairId: 'ctx-2', actionKind: 'context', params: {} })
    assert.equal(r2.status, 'context_failed')
  })

  it('rejects when the callback base url is not configured', async () => {
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
    })
    const resp = await broker.handleRequest({
      repairId: 'ctx-3',
      actionKind: 'context',
      params: {},
    })
    assert.equal(resp.status, 'rejected')
  })
})

describe('broker verify kind — de-privileged four-layer run via verifier', () => {
  it('returns allPassed + verificationRef + signed file path + layer summary', async () => {
    const seen: {
      repairId: string
      sha: string
      clonePath: string
      canonicalRepo: string
      canonicalBranch: string
    }[] = []
    const SHA = 'd'.repeat(40)
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      verificationDir: '/var/lib/test-verifications',
      canonicalRepo: '/trusted/v5',
      canonicalBranch: 'repair-main',
      verifyRunner: async (input) => {
        seen.push(input)
        return {
          verificationRef: input.repairId,
          signed: {
            result: {
              repairId: input.repairId,
              sha: input.sha,
              clonePath: input.clonePath,
              layers: [
                { name: 'lint', ok: true, code: 0, durationMs: 1 },
                { name: 'typecheck', ok: true, code: 0, durationMs: 1 },
              ],
              allPassed: true,
              verifiedAt: new Date().toISOString(),
            },
            sig: 'unused',
          },
        }
      },
    })
    const resp = await broker.handleRequest({
      repairId: 'v-1',
      actionKind: 'verify',
      params: { sha: SHA },
    })
    assert.equal(resp.ok, true)
    assert.equal(resp.status, 'verified')
    assert.equal(resp.detail?.allPassed, true)
    assert.equal(resp.detail?.verificationRef, 'v-1')
    assert.equal(resp.detail?.file, '/var/lib/test-verifications/v-1.json')
    assert.deepEqual(resp.detail?.layers, [
      { name: 'lint', ok: true, code: 0 },
      { name: 'typecheck', ok: true, code: 0 },
    ])
    assert.deepEqual(seen, [
      {
        repairId: 'v-1',
        sha: SHA,
        clonePath: '/home/ocheal/selfheal/v-1',
        canonicalRepo: '/trusted/v5',
        canonicalBranch: 'repair-main',
      },
    ])
  })

  it('rejects a malformed sha', async () => {
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      verifyRunner: async () => {
        throw new Error('must not be called')
      },
    })
    const resp = await broker.handleRequest({
      repairId: 'v-2',
      actionKind: 'verify',
      params: { sha: 'short' },
    })
    assert.equal(resp.status, 'rejected')
  })

  it('maps a thrown verification to verify_failed', async () => {
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      verifyRunner: async () => {
        throw new Error('worktree add failed')
      },
    })
    const resp = await broker.handleRequest({
      repairId: 'v-3',
      actionKind: 'verify',
      params: { sha: 'e'.repeat(40) },
    })
    assert.equal(resp.status, 'verify_failed')
    assert.match(String(resp.detail?.reason), /worktree add failed/)
  })
})

describe('broker report kind — redacted, length-capped capability POST', () => {
  function reportBroker(handler?: Parameters<typeof fetchStub>[0]) {
    const { impl, calls } = fetchStub(handler ?? (() => ({ status: 200, body: { ok: true } })))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      callbackBaseUrl: 'http://127.0.0.1:18796',
      fetchImpl: impl,
      reportMessageMaxChars: 50,
      reportDetailMaxChars: 60,
    })
    return { broker, calls }
  }

  it('POSTs the outcome-specific callback with Bearer capability', async () => {
    const { broker, calls } = reportBroker()
    const resp = await broker.handleRequest({
      repairId: 'rp-1',
      actionKind: 'report',
      params: { outcome: 'progress', message: 'starting layer 2' },
    })
    assert.equal(resp.ok, true)
    assert.equal(resp.status, 'reported')
    assert.equal(calls[0]?.url, 'http://127.0.0.1:18796/internal/v5/repairs/rp-1/progress')
    assert.equal(
      (calls[0]?.init?.headers as Record<string, string>)?.Authorization,
      `Bearer ${CAP}`,
    )
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { message: 'starting layer 2' })
  })

  // MED1: the v5 callback schema requires `detail` to be a JSON OBJECT — the
  // CLI/socket contract stays string-only, so the broker wraps it as { text }.
  it('redacts secrets, enforces the length caps, and wraps detail as an OBJECT {text}', async () => {
    const { broker, calls } = reportBroker()
    const resp = await broker.handleRequest({
      repairId: 'rp-2',
      actionKind: 'report',
      params: {
        outcome: 'done',
        message: `token sk-abcdefgh12345678 ${'y'.repeat(100)}`,
        detail: `Bearer very.secret.jwt and password=hunter2 ${'z'.repeat(100)}`,
      },
    })
    assert.equal(resp.ok, true)
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      message: string
      detail: { text: string }
    }
    assert.ok(!body.message.includes('sk-abcdefgh12345678'), 'api key redacted')
    assert.ok(body.message.length <= 50, 'message capped')
    assert.equal(typeof body.detail, 'object', 'detail is an object (v5 schema)')
    assert.equal(typeof body.detail.text, 'string', 'string detail wrapped as {text}')
    assert.ok(!body.detail.text.includes('very.secret.jwt'), 'bearer redacted')
    assert.ok(!body.detail.text.includes('hunter2'), 'password value redacted')
    assert.ok(body.detail.text.length <= 60, 'detail capped')
  })

  it('omits detail entirely when the caller sent none (no empty wrapper)', async () => {
    const { broker, calls } = reportBroker()
    await broker.handleRequest({
      repairId: 'rp-nodetail',
      actionKind: 'report',
      params: { outcome: 'progress', message: 'no detail here' },
    })
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    assert.equal('detail' in body, false)
  })

  it('rejects an unknown outcome and a missing message', async () => {
    const { broker } = reportBroker()
    const bad1 = await broker.handleRequest({
      repairId: 'rp-3',
      actionKind: 'report',
      params: { outcome: 'exploded', message: 'x' },
    })
    assert.equal(bad1.status, 'rejected')
    const bad2 = await broker.handleRequest({
      repairId: 'rp-3',
      actionKind: 'report',
      params: { outcome: 'done' },
    })
    assert.equal(bad2.status, 'rejected')
  })

  it('a master 5xx is report_failed (claim released → retry re-sends)', async () => {
    let n = 0
    const { broker, calls } = reportBroker(() => ({ status: ++n === 1 ? 502 : 200 }))
    const p = { outcome: 'failed', message: 'gave up' }
    const r1 = await broker.handleRequest({ repairId: 'rp-4', actionKind: 'report', params: p })
    assert.equal(r1.status, 'report_failed')
    const r2 = await broker.handleRequest({ repairId: 'rp-4', actionKind: 'report', params: p })
    assert.equal(r2.status, 'reported')
    assert.equal(calls.length, 2)
  })

  it('an identical successful report is replayed, different messages both send', async () => {
    const { broker, calls } = reportBroker()
    const p = { outcome: 'progress', message: 'step 1' }
    await broker.handleRequest({ repairId: 'rp-5', actionKind: 'report', params: p })
    const replay = await broker.handleRequest({ repairId: 'rp-5', actionKind: 'report', params: p })
    assert.equal(replay.detail?.replayed, true)
    assert.equal(calls.length, 1, 'identical report deduped')
    await broker.handleRequest({
      repairId: 'rp-5',
      actionKind: 'report',
      params: { outcome: 'progress', message: 'step 2' },
    })
    assert.equal(calls.length, 2, 'a NEW message is a fresh params-keyed claim')
  })
})

// ── block C: release is NEVER a socket action; releaseApproved is in-process ──

describe('release structural isolation (design §C2 R2-BLOCKER2)', () => {
  it('the socket path categorically rejects kind=release (even with a valid capability)', async () => {
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      deployDriver: async () => {
        throw new Error('must never be reached from the socket')
      },
    })
    for (const kind of ['release', 'release_approved']) {
      const resp = await broker.handleRequest({
        repairId: 'rl-sock',
        capability: CAP,
        actionKind: kind,
        params: {},
      })
      assert.equal(resp.status, 'rejected', kind)
      assert.match(String(resp.detail?.reason), /not a socket action/)
    }
  })
})

describe('releaseApproved — re-verifies pending record + ancestry + denylist', () => {
  const SHA = 'f'.repeat(40)

  // Fully self-contained fixture per test (no shared mutable state — tests may
  // interleave). `ancestry.ok` is mutable so a test can flip it AFTER parking
  // the pending cutover, exercising the release-time re-check.
  function releaseFixture(opts: { deployStatus?: string; deployOk?: boolean } = {}) {
    const vdir = mkdtempSync(join(tmpdir(), 'oc-verif-rel-'))
    const store = new InMemoryBrokerClaimStore()
    const deployed: string[] = []
    const ancestry = { ok: true }
    // Mutable release fuse (HIGH3): a test flips it AFTER parking the pending
    // cutover to model a cancel of the (terminal) job revoking the release.
    const revoked = { v: false }
    const { run } = stubRunner((cmd, args) => {
      if (cmd === 'git' && args.includes('merge-base')) {
        return { code: ancestry.ok ? 0 : 1 }
      }
      return { code: 0 }
    })
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store,
      repairAuthority: async () => ({
        status: 'running',
        capability: CAP,
        releaseRevoked: revoked.v,
      }),
      verifyKey: VERIFY_KEY,
      verificationDir: vdir,
      canonicalRepo: '/canon',
      run,
      autoDeployTier2: false, // default posture → cutover parks in pending_release
      deployDriver: async (sha) => {
        deployed.push(sha)
        return {
          ok: opts.deployOk ?? true,
          status: opts.deployStatus ?? 'deployed',
          detail: { sha },
        }
      },
    })
    async function parkPendingCutover(repairId: string): Promise<void> {
      const result = {
        repairId,
        sha: SHA,
        clonePath: `/home/ocheal/selfheal/${repairId}`,
        layers: [{ name: 'typecheck', ok: true, code: 0, durationMs: 1 }],
        allPassed: true,
        verifiedAt: new Date().toISOString(),
      }
      writeSignedVerification(vdir, result)
      const resp = await broker.handleRequest({
        repairId,
        capability: CAP,
        actionKind: 'cutover',
        params: { sha: SHA, verificationRef: repairId },
      })
      assert.equal(resp.status, 'pending_release')
    }
    const cleanup = () => rmSync(vdir, { recursive: true, force: true })
    return { broker, store, deployed, ancestry, revoked, parkPendingCutover, cleanup }
  }

  it('happy path: pending record found → ancestry re-checked → driver deploys; replay is idempotent', async () => {
    const fx = releaseFixture()
    await fx.parkPendingCutover('rl-1')
    const resp = await fx.broker.releaseApproved('rl-1')
    assert.equal(resp.status, 'deployed')
    assert.equal(resp.ok, true)
    assert.deepEqual(fx.deployed, [SHA])
    // The durable cutover record now reflects the deployed outcome.
    const rec = await fx.store.get('rl-1:cutover')
    assert.equal(JSON.parse(rec?.response ?? '{}').status, 'deployed')
    // A duplicate release replays — the deploy runs EXACTLY once.
    const again = await fx.broker.releaseApproved('rl-1')
    assert.equal(again.status, 'deployed')
    assert.equal(again.detail?.replayed, true)
    assert.deepEqual(fx.deployed, [SHA], 'at-most-once deploy')
    fx.cleanup()
  })

  it('refuses when there is no pending cutover record', async () => {
    const fx = releaseFixture()
    const resp = await fx.broker.releaseApproved('rl-none')
    assert.equal(resp.status, 'rejected')
    assert.match(String(resp.detail?.reason), /no committed cutover record/)
    assert.deepEqual(fx.deployed, [])
    fx.cleanup()
  })

  it('re-runs ancestry at release time and refuses a non-descendant (deploy never invoked)', async () => {
    const fx = releaseFixture()
    await fx.parkPendingCutover('rl-anc')
    // Ancestry passed at cutover time; canonical moved on → flip it for release.
    fx.ancestry.ok = false
    const resp = await fx.broker.releaseApproved('rl-anc')
    assert.equal(resp.status, 'rejected')
    assert.match(String(resp.detail?.reason), /not a descendant/)
    assert.deepEqual(fx.deployed, [], 'deploy never invoked')
    fx.cleanup()
  })

  it('denylist refusal from the driver leaves the release retryable and NOT deployed', async () => {
    const fx = releaseFixture({ deployOk: false, deployStatus: 'pending_release' })
    await fx.parkPendingCutover('rl-deny')
    const resp = await fx.broker.releaseApproved('rl-deny')
    assert.equal(resp.status, 'pending_release', 'toolchain-touching sha stays held')
    // The release claim was released → a later legitimate attempt can retry.
    const releaseRec = await fx.store.get('rl-deny:release_approved')
    assert.equal(releaseRec, null)
    // The cutover record still says pending_release (not deployed).
    const cutRec = await fx.store.get('rl-deny:cutover')
    assert.equal(JSON.parse(cutRec?.response ?? '{}').status, 'pending_release')
    fx.cleanup()
  })

  it('a second release of an already-deployed cutover replays without re-deploying', async () => {
    const fx = releaseFixture()
    await fx.parkPendingCutover('rl-twice')
    assert.equal((await fx.broker.releaseApproved('rl-twice')).status, 'deployed')
    // Replay path returns the recorded deploy; the driver ran once.
    assert.equal((await fx.broker.releaseApproved('rl-twice')).detail?.replayed, true)
    assert.equal(fx.deployed.length, 1)
    fx.cleanup()
  })

  it('refuses a release revoked by a terminal-job cancel (HIGH3 fuse — deploy never invoked)', async () => {
    const fx = releaseFixture()
    await fx.parkPendingCutover('rl-revoked')
    // Cancel of the terminal job flips the durable fuse after the park.
    fx.revoked.v = true
    const resp = await fx.broker.releaseApproved('rl-revoked')
    assert.equal(resp.status, 'rejected')
    assert.equal(resp.detail?.reason, 'release_revoked')
    assert.deepEqual(fx.deployed, [], 'deploy never invoked')
    // The fuse is checked at ENTRY: no release claim was consumed either.
    assert.equal(await fx.store.get('rl-revoked:release_approved'), null)
    fx.cleanup()
  })
})

// ── BLOCKER1: release endpoint HTTP mapping (server.ts consumes this) ─────────

describe('releaseHttpStatusFor — 5-tier release HTTP mapping matrix', () => {
  it('maps every broker release outcome onto the seam contract', () => {
    // deployed → 200, including an idempotent replay of a deployed record.
    assert.equal(releaseHttpStatusFor({ ok: true, status: 'deployed' }), 200)
    assert.equal(
      releaseHttpStatusFor({ ok: true, status: 'deployed', detail: { replayed: true } }),
      200,
    )
    // gate refusals (ancestry / denylist / missing record / release_revoked)
    // and a still-held pending → 409.
    assert.equal(releaseHttpStatusFor({ ok: false, status: 'pending_release' }), 409)
    assert.equal(releaseHttpStatusFor({ ok: false, status: 'rejected' }), 409)
    assert.equal(
      releaseHttpStatusFor({
        ok: false,
        status: 'rejected',
        detail: { reason: 'release_revoked' },
      }),
      409,
    )
    // an unfinalized prior release → 423.
    assert.equal(releaseHttpStatusFor({ ok: false, status: 'in_progress' }), 423)
    // driver failure → 500.
    assert.equal(releaseHttpStatusFor({ ok: false, status: 'deploy_failed' }), 500)
    // anything unexpected is a server error, never a 2xx.
    assert.equal(releaseHttpStatusFor({ ok: false, status: 'error' }), 500)
  })
})

describe('broker → master callback seam (durable outbox — BLOCKER2)', () => {
  const SHA = 'b'.repeat(40)
  type Enq = { repairId: string; phase: string; message: string; detail: Record<string, unknown> }
  function seamFixture(opts: { outboxThrows?: boolean; autoDeploy?: boolean } = {}) {
    const vdir = mkdtempSync(join(tmpdir(), 'oc-verif-seam-'))
    // The broker must NOT talk to the master for these callbacks anymore —
    // every direct fetch is recorded so the tests can assert its absence.
    const calls: { url: string; init?: RequestInit }[] = []
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const repairId = /\/repairs\/([^/]+)\/context/.exec(String(url))?.[1] ?? ''
      const context = {
        repairId,
        incidentId: '88',
        conditionKey: 'ops.monitor:svc_v5',
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(context),
        json: async () => context,
      }
    }) as unknown as typeof fetch
    // Atomic commit model (审计R2 BLOCKER): the outbox row is written INSIDE the
    // claim store's finalizeWithCallback transaction. The in-memory store keeps
    // a test-visible mirror; `outboxThrows` simulates the whole combined commit
    // failing (disk full) — the claim must then stay held (fail-closed).
    class SeamStore extends InMemoryBrokerClaimStore {
      override async finalizeWithCallback(
        finalize: { claimKey: string; response: string }[],
        overwriteCommitted: { claimKey: string; response: string } | undefined,
        callback: {
          repairId: string
          phase: SelfhealCallbackPhase
          message: string
          detail: Record<string, unknown>
        },
      ): Promise<void> {
        if (opts.outboxThrows) throw new Error('outbox disk full')
        await super.finalizeWithCallback(finalize, overwriteCommitted, callback)
      }
    }
    const store = new SeamStore()
    const enqueued: Enq[] = store.outbox
    const { run } = stubRunner((cmd, args) => {
      if (cmd === 'git' && args.includes('merge-base')) return { code: 0 }
      return { code: 0 }
    })
    const deployed: string[] = []
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store,
      repairAuthority: activeAuthority,
      verifyKey: VERIFY_KEY,
      verificationDir: vdir,
      canonicalRepo: '/canon',
      run,
      autoDeployTier2: opts.autoDeploy ?? false,
      callbackBaseUrl: 'http://127.0.0.1:18796',
      fetchImpl: impl,
      deployDriver: async (sha) => {
        deployed.push(sha)
        return {
          ok: true,
          status: 'deployed',
          detail: {
            sha,
            healthCheck: {
              kind: 'deploy-v5-smoke',
              ok: true,
              target: 'service:v5',
              checkedAt: '2026-07-13T02:00:00.000Z',
            },
          },
        }
      },
    })
    function park(repairId: string) {
      writeSignedVerification(vdir, {
        repairId,
        sha: SHA,
        clonePath: `/home/ocheal/selfheal/${repairId}`,
        layers: [{ name: 'typecheck', ok: true, code: 0, durationMs: 1 }],
        allPassed: true,
        verifiedAt: new Date().toISOString(),
      })
      return broker.handleRequest({
        repairId,
        capability: CAP,
        actionKind: 'cutover',
        params: { sha: SHA, verificationRef: repairId },
      })
    }
    return {
      broker,
      calls,
      enqueued,
      deployed,
      park,
      cleanup: () => rmSync(vdir, { recursive: true, force: true }),
    }
  }

  it('a gated cutover ENQUEUES the pending_release marker (detail.phase object) — no direct POST', async () => {
    const fx = seamFixture()
    const resp = await fx.park('seam-1')
    assert.equal(resp.status, 'pending_release')
    assert.equal(fx.enqueued.length, 1)
    assert.equal(fx.enqueued[0]?.repairId, 'seam-1')
    assert.equal(fx.enqueued[0]?.phase, 'pending_release')
    assert.equal(
      fx.enqueued[0]?.detail.phase,
      'pending_release',
      "master's release gate reads detail->>'phase' — the pump delivers this object verbatim",
    )
    assert.equal(fx.enqueued[0]?.detail.sha, SHA)
    assert.match(fx.enqueued[0]?.message ?? '', /pending_release/)
    // Durable delivery is the PUMP's job: the broker itself must not have
    // POSTed the callback (best-effort direct sends are the bug being removed).
    assert.equal(
      fx.calls.some((c) => c.url.endsWith('/progress')),
      false,
      'no direct progress POST from the broker',
    )
    fx.cleanup()
  })

  it('releaseApproved ENQUEUES done (phase=deployed) after a successful human release', async () => {
    const fx = seamFixture()
    await fx.park('seam-2')
    const resp = await fx.broker.releaseApproved('seam-2')
    assert.equal(resp.status, 'deployed')
    assert.deepEqual(fx.deployed, [SHA])
    const done = fx.enqueued.find((e) => e.phase === 'done')
    assert.ok(done, 'the broker (not codex) closes the loop after release — durably')
    assert.equal(done?.repairId, 'seam-2')
    assert.equal(done?.detail.phase, 'deployed')
    assert.equal(done?.detail.sha, SHA)
    assert.equal(
      fx.calls.some((c) => c.url.endsWith('/done')),
      false,
      'no direct done POST from the broker',
    )
    fx.cleanup()
  })

  it('an auto-deployed cutover (AUTO_DEPLOY_TIER2=1) enqueues done as well', async () => {
    const fx = seamFixture({ autoDeploy: true })
    const resp = await fx.park('seam-auto')
    assert.equal(resp.status, 'deployed')
    const done = fx.enqueued.find((e) => e.phase === 'done')
    assert.equal(done?.detail.phase, 'deployed')
    assert.deepEqual(done?.detail.trusted_attestation, {
      version: 1,
      repairId: 'seam-auto',
      incidentId: '88',
      conditionKey: 'ops.monitor:svc_v5',
      target: 'service:v5',
      action: 'deploy_v5',
      executionMode: 'fully_automatic',
      executed: true,
      remoteResult: {
        ok: true,
        target: 'service:v5',
        healthOk: true,
        checkedAt: (done?.detail.trusted_attestation as any).remoteResult.checkedAt,
      },
    })
    assert.equal(
      fx.enqueued.some((e) => e.phase === 'pending_release'),
      false,
    )
    fx.cleanup()
  })

  it('combined commit failure is FAIL-CLOSED: commit_failed + claim held, never a silent success', async () => {
    // 审计R2 BLOCKER:enqueue 失败绝不允许 outcome 照常 committed(那会永久
    // 孤儿化 master 状态机)。失败 = commit_failed,claim 保持,重试报 in_progress。
    const fx = seamFixture({ outboxThrows: true })
    const parked = await fx.park('seam-3')
    assert.equal(parked.status, 'commit_failed', 'cutover outcome must not silently commit')
    assert.equal(fx.enqueued.length, 0)
    const retry = await fx.park('seam-3')
    assert.equal(retry.status, 'in_progress', 'claim held fail-closed — never re-executed blindly')
    fx.cleanup()
  })

  it('release combined commit failure holds the release claim and never re-deploys', async () => {
    const fx = seamFixture()
    await fx.park('seam-3b')
    // Flip the store into failure mode only for the release commit.
    ;(fx as unknown as { failNext?: boolean }).failNext = true
    const store = fx.broker as unknown as { store: { finalizeWithCallback: unknown } }
    const orig = store.store.finalizeWithCallback as (...a: unknown[]) => Promise<void>
    store.store.finalizeWithCallback = async () => {
      throw new Error('outbox disk full')
    }
    const rel = await fx.broker.releaseApproved('seam-3b')
    assert.equal(rel.status, 'commit_failed', 'deploy ran but commit failed — reported honestly')
    assert.equal(fx.deployed.length, 1)
    store.store.finalizeWithCallback = orig
    const retry = await fx.broker.releaseApproved('seam-3b')
    assert.equal(retry.status, 'in_progress', 'claim held — the deploy is never blindly re-run')
    assert.equal(fx.deployed.length, 1, 'no second deploy')
    fx.cleanup()
  })

  it('a terminal-cancel fuse set AFTER the entry check still blocks the deploy (per-repair fence)', async () => {
    // HIGH2(审计R2):releaseApproved 的终检在 per-repair 锁内 fresh 读 fuse。
    // 模拟:入口检查时未 revoked,锁内终检时已 revoked(cancel 先赢)。
    const vdir = mkdtempSync(join(tmpdir(), 'oc-verif-fence-'))
    const { run } = stubRunner((cmd, args) => {
      if (cmd === 'git' && args.includes('merge-base')) return { code: 0 }
      return { code: 0 }
    })
    let reads = 0
    const flippingAuthority: RepairAuthority = async () => {
      reads += 1
      // 1st read: handleRequest authorize; 2nd: release entry check; 3rd+ (locked
      // re-check): revoked.
      return { status: 'running', capability: CAP, releaseRevoked: reads >= 3 }
    }
    const deployed: string[] = []
    const store = new InMemoryBrokerClaimStore()
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store,
      repairAuthority: flippingAuthority,
      verifyKey: VERIFY_KEY,
      verificationDir: vdir,
      canonicalRepo: '/canon',
      run,
      autoDeployTier2: false,
      deployDriver: async (sha) => {
        deployed.push(sha)
        return { ok: true, status: 'deployed', detail: { sha } }
      },
    })
    writeSignedVerification(vdir, {
      repairId: 'fence-1',
      sha: SHA,
      clonePath: '/home/ocheal/selfheal/fence-1',
      layers: [{ name: 'typecheck', ok: true, code: 0, durationMs: 1 }],
      allPassed: true,
      verifiedAt: new Date().toISOString(),
    })
    const parked = await broker.handleRequest({
      repairId: 'fence-1',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'fence-1' },
    })
    assert.equal(parked.status, 'pending_release')
    const rel = await broker.releaseApproved('fence-1')
    assert.equal(rel.status, 'rejected')
    assert.equal(rel.detail?.reason, 'release_revoked')
    assert.equal(deployed.length, 0, 'the fuse won the fence — driver never ran')
    rmSync(vdir, { recursive: true, force: true })
  })

  it('a replayed cutover does not enqueue a second marker', async () => {
    const fx = seamFixture()
    await fx.park('seam-4')
    const replay = await fx.park('seam-4')
    assert.equal(replay.detail?.replayed, true)
    assert.equal(fx.enqueued.length, 1, 'idempotent replay leaves the outbox untouched')
    fx.cleanup()
  })
})

// ── batch0: Tier1 positive enablement + server-side drill authorization ─────

describe('Tier1 positive enablement (default = no actions)', () => {
  it('default construction rejects Tier1 kinds as unknown actions (fail-closed)', async () => {
    process.env.OC_SELFHEAL_RESTART_UNITS = 'openclaude-v5'
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      run,
    })
    for (const actionKind of ['restart_service', 'clean_disk', 'switch_node']) {
      const resp = await broker.handleRequest({
        repairId: `r-default-${actionKind}`,
        capability: CAP,
        actionKind,
        params: actionKind === 'restart_service' ? { unit: 'openclaude-v5' } : { target: 'docker' },
      })
      assert.equal(resp.status, 'rejected', `${actionKind} must be rejected without enablement`)
      assert.match(String(resp.detail?.reason), /unknown action/)
    }
    assert.equal(calls.length, 0, 'no command may ever run without positive enablement')
    setOrUnset('OC_SELFHEAL_RESTART_UNITS', undefined)
  })
})

describe('drill authorization — frozen condition key, server-side allowlist', () => {
  const drillAuthority: RepairAuthority = async () => ({
    status: 'running',
    capability: CAP,
    conditionKey: 'selfheal.drill:transport_v1',
  })

  function drillBroker(run?: CommandRunner) {
    return new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: drillAuthority,
      actions: TIER1_ACTIONS,
      ...(run ? { run } : {}),
    })
  }

  it('rejects verify / cutover / Tier1 for a drill repair BEFORE any side effect', async () => {
    process.env.OC_SELFHEAL_RESTART_UNITS = 'openclaude-v5'
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    const broker = drillBroker(run)
    const attempts: Array<{ actionKind: string; params: Record<string, unknown> }> = [
      { actionKind: 'verify', params: { sha: 'a'.repeat(40) } },
      { actionKind: 'cutover', params: { sha: 'a'.repeat(40), verificationRef: 'r-drill' } },
      { actionKind: 'restart_service', params: { unit: 'openclaude-v5' } },
      { actionKind: 'clean_disk', params: { target: 'docker' } },
    ]
    for (const a of attempts) {
      const resp = await broker.handleRequest({
        repairId: 'r-drill',
        capability: CAP,
        actionKind: a.actionKind,
        params: a.params,
      })
      assert.equal(resp.status, 'rejected', `${a.actionKind} must be drill-rejected`)
      assert.match(String(resp.detail?.reason), /drill repair may only context\/report/)
    }
    assert.equal(calls.length, 0, 'a drill repair must never reach a command runner')
    setOrUnset('OC_SELFHEAL_RESTART_UNITS', undefined)
  })

  it('context and report pass the drill gate (they fail later only for unrelated reasons)', async () => {
    const broker = drillBroker()
    const ctx = await broker.handleRequest({
      repairId: 'r-drill-ctx',
      capability: CAP,
      actionKind: 'context',
      params: {},
    })
    // No callbackBaseUrl in this fixture — the rejection reason proves the
    // request got PAST the drill gate into the real handler.
    assert.doesNotMatch(String(ctx.detail?.reason ?? ''), /drill repair/)
    const rep = await broker.handleRequest({
      repairId: 'r-drill-rep',
      capability: CAP,
      actionKind: 'report',
      params: { outcome: 'progress', message: 'drill 已接单' },
    })
    assert.doesNotMatch(String(rep.detail?.reason ?? ''), /drill repair/)
  })

  it('a NON-drill (or unfrozen) condition key is not drill-gated', async () => {
    const realAuthority: RepairAuthority = async () => ({
      status: 'running',
      capability: CAP,
      conditionKey: 'ops.monitor:svc_v5',
    })
    const legacyAuthority: RepairAuthority = async () => ({ status: 'running', capability: CAP })
    for (const repairAuthority of [realAuthority, legacyAuthority]) {
      const broker = new SelfhealBroker({
        socketPath: '/unused',
        store: new InMemoryBrokerClaimStore(),
        repairAuthority,
      })
      const resp = await broker.handleRequest({
        repairId: 'r-real',
        capability: CAP,
        actionKind: 'verify',
        params: { sha: 'a'.repeat(40) },
      })
      assert.doesNotMatch(String(resp.detail?.reason ?? ''), /drill repair/)
    }
  })
})
