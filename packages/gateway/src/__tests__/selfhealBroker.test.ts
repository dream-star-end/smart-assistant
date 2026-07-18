import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { ReleaseJobInsertInput, SelfhealCallbackPhase } from '@openclaude/storage'
import {
  type BrokerRequest,
  type BrokerResponse,
  type CutoverClassifier,
  InMemoryBrokerClaimStore,
  type RepairAuthority,
  SELFHEAL_DRILL_RELEASE_KEY,
  SelfhealBroker,
} from '../selfheal/broker.js'
import {
  type CommandRunner,
  type RunResult,
  TIER1_ACTION_KINDS,
  TIER1_ACTIONS,
} from '../selfheal/brokerActions.js'
import { type VerificationResult, signVerification } from '../selfheal/verifier.js'

const VERIFY_KEY = 'test-verify-hmac-signing-key-1234'

// Cutover classification is stubbed in these broker fixtures — the classifier's
// own logic (raw-diff parsing, glob, argv, plan hash) is exercised end-to-end in
// selfhealDeploySurfaces.test.ts. Here we only assert the broker PLUMBS the
// classification into the durable record + pending_release callback.
const CLS_BASE = 'b'.repeat(40)
const CLS_HASH = 'e'.repeat(64)
const CLS_PLAN = 'a'.repeat(64)
function stubClassifier(manual: { path: string; reason: string }[] = []): CutoverClassifier {
  const isManual = manual.length > 0
  return async () => ({
    baseSha: CLS_BASE,
    classification: {
      surfaces: isManual ? [] : ['web'],
      deployArgs: isManual ? [] : ['--dist'],
      manual,
      verifyLayers: ['lint', 'test:gateway', 'test:web', 'typecheck'],
      requiredAxes: [],
      changedFiles: { paths: ['packages/web-react/App.tsx'], total: 1 },
      manifestVersion: 1,
      manifestHash: CLS_HASH,
      deployPlanHash: CLS_PLAN,
    },
  })
}

// Capability authorization test fixtures: an active repair holding CAP with a
// frozen (non-drill) condition key — the batch0 posture every real repair has
// by the time a socket action arrives.
const CAP = 'test-capability-token-xyz'
const activeAuthority: RepairAuthority = async () => ({
  status: 'running',
  capability: CAP,
  conditionKey: 'ops.monitor:svc_v5',
  incidentId: 'inc-active-1',
})

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

  it('clean_disk is not registered because cleanup cannot be scoped to V5', async () => {
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
    assert.equal(resp.ok, false)
    assert.equal(resp.status, 'rejected')
    assert.match(String(resp.detail?.reason), /unknown action/)
    assert.equal(calls.length, 0, 'a removed global cleanup action must never reach the runner')
    assert.deepEqual(TIER1_ACTION_KINDS.sort(), ['restart_service', 'switch_node'])
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
      classifyCutover: stubClassifier(),
      notifyPendingRelease: (i) => pending.push(i),
      ...opts,
    })
    return { broker, calls, pending }
  }

  it('default posture (AUTO_DEPLOY_TIER2 off) holds a fully-gated cutover for release', async () => {
    writeSignedVerification(vdir, passingVerification('c1'))
    const { broker, pending } = makeBroker({ autoDeployTier2: false })
    const resp = await broker.handleRequest({
      repairId: 'c1',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c1' },
    })
    // batch1b §11: the broker no longer deploys synchronously — a fully-gated
    // cutover parks pending_release; deploy is the release worker's job.
    assert.equal(resp.status, 'pending_release')
    assert.equal(resp.ok, false)
    assert.deepEqual(pending, [{ repairId: 'c1', sha: SHA }])
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
      classifyCutover: stubClassifier(),
      run,
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

  it('pending_release detail is enriched with the frozen deploy plan (§11 shape)', async () => {
    writeSignedVerification(vdir, passingVerification('c-enrich'))
    const { broker } = makeBroker({ autoDeployTier2: false })
    const resp = await broker.handleRequest({
      repairId: 'c-enrich',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c-enrich' },
    })
    assert.equal(resp.status, 'pending_release')
    // Authoritative durable cutover record detail — the personal release-job
    // intake re-checks sha/deployPlanHash/manifestHash against it (fail-closed).
    const d = resp.detail as Record<string, unknown>
    assert.equal(d.sha, SHA)
    assert.equal(d.baseSha, CLS_BASE)
    assert.equal(d.deployPlanHash, CLS_PLAN)
    assert.equal(d.manifestHash, CLS_HASH)
    assert.equal(d.manifestVersion, 1)
    assert.deepEqual((d.classification as { surfaces: string[] }).surfaces, ['web'])
    assert.deepEqual((d.classification as { deployArgs: string[] }).deployArgs, ['--dist'])
    assert.deepEqual((d.classification as { manual: unknown[] }).manual, [])
    assert.deepEqual(d.changedFiles, { paths: ['packages/web-react/App.tsx'], total: 1 })
    // verification block records the layers actually run + the ref.
    const v = d.verification as { layers: { name: string }[]; ref: string }
    assert.equal(v.ref, 'c-enrich')
    assert.deepEqual(
      v.layers.map((l) => l.name),
      ['typecheck'],
    )
  })

  it('a classifier throw is a fail-closed cutover refusal (never parks un-classified)', async () => {
    writeSignedVerification(vdir, passingVerification('c-clsfail'))
    const { broker } = makeBroker({
      autoDeployTier2: false,
      classifyCutover: async () => {
        throw new Error('git show manifest failed')
      },
    })
    const resp = await broker.handleRequest({
      repairId: 'c-clsfail',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c-clsfail' },
    })
    assert.equal(resp.status, 'rejected')
    assert.match(String(resp.detail?.reason), /classification failed/)
  })

  it('a manual classification still parks pending_release, carrying manual reasons', async () => {
    writeSignedVerification(vdir, passingVerification('c-manual'))
    const manual = [{ path: 'scripts/deploy-v5.sh', reason: 'manual_glob:**/*.sh' }]
    const { broker, pending } = makeBroker({
      autoDeployTier2: false,
      classifyCutover: stubClassifier(manual),
    })
    const resp = await broker.handleRequest({
      repairId: 'c-manual',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c-manual' },
    })
    assert.equal(resp.status, 'pending_release')
    const cls = (resp.detail as Record<string, unknown>).classification as {
      manual: { path: string }[]
      deployArgs: string[]
    }
    assert.deepEqual(cls.manual, manual)
    assert.deepEqual(cls.deployArgs, [], 'manual short-circuits the deploy argv')
    // The pending notification carries the manual paths (transitional field).
    assert.deepEqual(pending, [{ repairId: 'c-manual', sha: SHA, toolchain: [manual[0].path] }])
  })

  // ── R2-4: auto-deploy release job inserted in the SAME atomic commit ────────

  it('R2-4: an auto cutover records the release job in the SAME commit as the cutover finalize', async () => {
    writeSignedVerification(vdir, passingVerification('c-auto'))
    const store = new InMemoryBrokerClaimStore()
    const { broker } = makeBroker({ autoDeployTier2: true, store })
    const resp = await broker.handleRequest({
      repairId: 'c-auto',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c-auto' },
    })
    assert.equal(resp.status, 'queued')
    assert.equal(resp.ok, true)
    // "cutover committed ⟺ job present": both landed via finalizeWithCallback.
    assert.equal((await store.get('c-auto:cutover'))?.status, 'committed')
    assert.equal(store.releaseJobs.length, 1, 'exactly one release job recorded atomically')
    const job = store.releaseJobs[0]
    assert.equal(job.origin, 'auto')
    assert.equal(job.repairId, 'c-auto')
    assert.equal(job.approvedSha, SHA)
    assert.equal(job.deployPlanHash, CLS_PLAN)
    assert.equal(job.manifestHash, CLS_HASH)
    assert.match(job.releaseRequestId, /^auto-c-auto-/)
    // The wire response carries the rrid but NEVER the internal releaseJobInsert.
    assert.equal((resp as { releaseJobInsert?: unknown }).releaseJobInsert, undefined)
    assert.equal((resp.detail as { releaseRequestId?: string }).releaseRequestId, job.releaseRequestId)
  })

  it('R2-4: a combined-commit failure is FAIL-CLOSED — commit_failed, claim held, NO job', async () => {
    // The atomic finalize+insert failing (disk full) must NOT leave the cutover
    // committed nor the job present; the claim is held so a retry reports in_progress.
    writeSignedVerification(vdir, passingVerification('c-auto2'))
    class ThrowStore extends InMemoryBrokerClaimStore {
      override async finalizeWithCallback(): Promise<void> {
        throw new Error('combined commit disk full (injected)')
      }
    }
    const store = new ThrowStore()
    const { broker } = makeBroker({ autoDeployTier2: true, store })
    const resp = await broker.handleRequest({
      repairId: 'c-auto2',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c-auto2' },
    })
    assert.equal(resp.status, 'commit_failed', 'never a silent success')
    assert.equal(store.releaseJobs.length, 0, 'no job recorded on a failed commit')
    assert.equal((await store.get('c-auto2:cutover'))?.status, 'claimed', 'claim held (not committed)')
    const retry = await broker.handleRequest({
      repairId: 'c-auto2',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'c-auto2' },
    })
    assert.equal(retry.status, 'in_progress', 'claim held fail-closed — never re-executed blindly')
  })

  it('R2-4: a replayed auto cutover does NOT record a second job (idempotent)', async () => {
    writeSignedVerification(vdir, passingVerification('c-auto3'))
    const store = new InMemoryBrokerClaimStore()
    const { broker } = makeBroker({ autoDeployTier2: true, store })
    const run = () =>
      broker.handleRequest({
        repairId: 'c-auto3',
        capability: CAP,
        actionKind: 'cutover',
        params: { sha: SHA, verificationRef: 'c-auto3' },
      })
    await run()
    const replay = await run()
    assert.equal(replay.status, 'queued', 'idempotent replay of the committed outcome')
    assert.equal(store.releaseJobs.length, 1, 'no duplicate release job on replay')
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
      extraLayers?: string[]
    }[] = []
    const SHA = 'd'.repeat(40)
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: activeAuthority,
      verificationDir: '/var/lib/test-verifications',
      canonicalRepo: '/trusted/v5',
      canonicalBranch: 'repair-main',
      // batch1b §6: verify resolves surface-specific extra layers from the
      // classification and threads them into the runner.
      classifyClone: async () => ({ verifyLayers: ['lint', 'typecheck'] }),
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
        extraLayers: ['lint', 'typecheck'],
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
      classifyClone: async () => ({ verifyLayers: [] }),
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
        callback:
          | { repairId: string; phase: SelfhealCallbackPhase; message: string; detail: Record<string, unknown> }
          | undefined,
        releaseJobInsert?: ReleaseJobInsertInput,
      ): Promise<void> {
        if (opts.outboxThrows) throw new Error('outbox disk full')
        await super.finalizeWithCallback(finalize, overwriteCommitted, callback, releaseJobInsert)
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
      classifyCutover: stubClassifier(),
      autoDeployTier2: opts.autoDeploy ?? false,
      callbackBaseUrl: 'http://127.0.0.1:18796',
      fetchImpl: impl,
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

  it('release-drill repair may verify/cutover but NOT any Tier1 opcode', async () => {
    process.env.OC_SELFHEAL_RESTART_UNITS = 'openclaude-v5'
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    const releaseDrillAuthority: RepairAuthority = async () => ({
      status: 'running',
      capability: CAP,
      conditionKey: SELFHEAL_DRILL_RELEASE_KEY,
    })
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: releaseDrillAuthority,
      actions: TIER1_ACTIONS,
      // Stub the verify-layer classifier so verify's §6 classification doesn't
      // reach the shared runner — this test asserts a drill never reaches the
      // runner via a Tier1 opcode, not via verify's manifest read.
      classifyClone: async () => ({ verifyLayers: [] }),
      run,
    })
    // verify + cutover PASS the drill gate (they fail later for unrelated
    // reasons — no uid / no verification file — which proves they got past it).
    const verify = await broker.handleRequest({
      repairId: 'r-rel-drill',
      capability: CAP,
      actionKind: 'verify',
      params: { sha: 'a'.repeat(40) },
    })
    assert.doesNotMatch(String(verify.detail?.reason ?? ''), /drill repair/)
    const cutover = await broker.handleRequest({
      repairId: 'r-rel-drill',
      capability: CAP,
      actionKind: 'cutover',
      params: { sha: 'a'.repeat(40), verificationRef: 'r-rel-drill' },
    })
    assert.doesNotMatch(String(cutover.detail?.reason ?? ''), /drill repair/)
    // Tier1 host opcodes are still rejected for a release drill.
    for (const a of [
      { actionKind: 'restart_service', params: { unit: 'openclaude-v5' } },
      { actionKind: 'clean_disk', params: { target: 'docker' } },
    ]) {
      const resp = await broker.handleRequest({
        repairId: 'r-rel-drill',
        capability: CAP,
        actionKind: a.actionKind,
        params: a.params,
      })
      assert.equal(resp.status, 'rejected', `${a.actionKind} must be drill-rejected`)
      assert.match(
        String(resp.detail?.reason),
        /drill repair may only context\/report\/verify\/cutover/,
      )
    }
    assert.equal(
      calls.length,
      0,
      'a drill repair must never reach a command runner via a Tier1 opcode',
    )
    setOrUnset('OC_SELFHEAL_RESTART_UNITS', undefined)
  })

  it('a NON-drill frozen condition key is not drill-gated', async () => {
    const realAuthority: RepairAuthority = async () => ({
      status: 'running',
      capability: CAP,
      conditionKey: 'ops.monitor:svc_v5',
    })
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: realAuthority,
    })
    const resp = await broker.handleRequest({
      repairId: 'r-real',
      capability: CAP,
      actionKind: 'verify',
      params: { sha: 'a'.repeat(40) },
    })
    assert.doesNotMatch(String(resp.detail?.reason ?? ''), /drill repair|not frozen/)
  })

  it('an UNFROZEN condition key rejects EVERY action (pre-freeze window is closed)', async () => {
    process.env.OC_SELFHEAL_RESTART_UNITS = 'openclaude-v5'
    const { run, calls } = stubRunner(() => ({ code: 0 }))
    // A job stuck in 'starting' whose context fetch keeps failing — its key was
    // never frozen. A guessed repairId must get NOTHING, not non-drill powers.
    const unfrozenAuthority: RepairAuthority = async () => ({
      status: 'starting',
      capability: CAP,
    })
    const broker = new SelfhealBroker({
      socketPath: '/unused',
      store: new InMemoryBrokerClaimStore(),
      repairAuthority: unfrozenAuthority,
      actions: TIER1_ACTIONS,
      run,
    })
    const attempts: Array<{ actionKind: string; params: Record<string, unknown> }> = [
      { actionKind: 'context', params: {} },
      { actionKind: 'report', params: { outcome: 'progress', message: 'hi' } },
      { actionKind: 'verify', params: { sha: 'a'.repeat(40) } },
      { actionKind: 'cutover', params: { sha: 'a'.repeat(40), verificationRef: 'r-x' } },
      { actionKind: 'restart_service', params: { unit: 'openclaude-v5' } },
    ]
    for (const a of attempts) {
      const resp = await broker.handleRequest({
        repairId: 'r-unfrozen',
        capability: CAP,
        actionKind: a.actionKind,
        params: a.params,
      })
      assert.equal(resp.status, 'rejected', `${a.actionKind} must be rejected while unfrozen`)
      assert.match(String(resp.detail?.reason), /not frozen/)
    }
    assert.equal(calls.length, 0)
    setOrUnset('OC_SELFHEAL_RESTART_UNITS', undefined)
  })
})
