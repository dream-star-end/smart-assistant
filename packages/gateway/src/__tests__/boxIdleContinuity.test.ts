import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, appendFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { EngineCapabilities, EngineTurnRun, TurnParams } from '../engine/engineAdapter.js'
import type { PartialSnapshot, TurnSummary } from '../engine/engineEvents.js'
import type { AgentSession } from '../sessionManager.js'

// Isolate paths and SQLite before importing any runtime modules.
const home = await mkdtemp(join(tmpdir(), 'oc-idle-747-'))
process.env.OPENCLAUDE_HOME = home
process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
for (const key of ['OC_RUNTIME_CHANNEL', 'OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN', 'OC_MODEL_AUTHORITY']) {
  delete process.env[key]
}
const { closeSessionsDb, paths } = await import('@openclaude/storage')
const { SessionManager } = await import('../sessionManager.js')
const { setV3MasterSinkSingleton } = await import('../v3MasterSink.js')
const settledPath = join(home, 'user-settlements.jsonl')
setV3MasterSinkSingleton({
  async persistOrQueue(payload) { await appendFile(settledPath, JSON.stringify(payload) + '\n'); return { ok: true } },
  async attemptOnce() {},
})

const { Gateway, PerTurnDelegationGuard } = await import('../server.js')
const { MinimalPrivacyRunner } = await import('./fixtures/minimalPrivacyRunner.js')
const { buildAdvisorSnapshot, ADVISOR_NO_WRITE_CONSTRAINT } = await import('../advisorMode.js')
const { normalizeMessageReplyQuote } = await import('@openclaude/protocol')

after(async () => {
  setV3MasterSinkSingleton(null)
  await closeSessionsDb()
  await rm(home, { recursive: true, force: true })
})

const MODELS = { ccb: 'box-api-claude-opus-5-5', codex: 'gpt-6-astra', grok: 'grok-build', cursor: 'cursor-auto' } as const
type Engine = keyof typeof MODELS
const EMPTY: PartialSnapshot = {
  assistantText: '', thinkingText: '', completedTools: [], assistantSegments: [], thinkingSegments: [], runtimeEvents: [],
}

/** The actual SessionManager and turn runner run through this neutral engine boundary. */
class RecordingEngine extends MinimalPrivacyRunner {
  readonly calls: Array<{ readOnly: boolean; input: TurnParams['input']; turnKey?: string }> = []
  readonly capabilities: EngineCapabilities
  readonly nativeSessionId = null
  readonly executionTarget = { kind: 'local' as const }
  readonly toolsets = undefined
  readonly pendingToolCalls = 0
  isRunning = true
  lastActivityAt = Date.now()
  effortLevel: string | undefined
  model: string | undefined
  idleHook?: (p: TurnParams) => Promise<TurnSummary>
  failNext = false
  beforeComplete?: () => Promise<void>

  constructor(readonly engineId: Engine) {
    super()
    this.model = MODELS[engineId]
    this.capabilities = {
      billingMode: engineId === 'codex' ? 'engine-reported' : engineId === 'ccb' ? 'proxy' : 'external',
      supportsEffort: true,
      resumeKind: engineId === 'ccb' ? 'ccb-session' : engineId === 'codex' ? 'codex-thread' : engineId === 'grok' ? 'grok-session' : 'cursor-session',
      needsServerRequestId: engineId === 'codex', historyMode: 'native-resume',
      permissionModel: engineId === 'ccb' || engineId === 'codex' ? 'native' : 'forced-unattended',
      emitsCallUsage: false, emitsToolInputDeltas: false, supportsNativeCompact: false, multimodalInput: 'text-only',
    }
  }

  async start(): Promise<void> { this.isRunning = true }
  stopFails = false
  async shutdown(): Promise<void> { if (this.stopFails) throw new Error('still alive'); this.isRunning = false }
  async waitForOutputDrain(): Promise<void> {}
  clearSessionId(): void {}
  interrupt(): boolean { return false }
  setTraceId(): void {}
  setModel(model: string | undefined): void { this.model = model }
  setEffortLevel(effort: string | undefined): void { this.effortLevel = effort }
  getBoundRepoBinding(): null { return null }
  getPartialSnapshot(): PartialSnapshot { return structuredClone(EMPTY) }

  submitTurn(params: TurnParams): EngineTurnRun {
    this.recordBuiltPromptPrivacy()
    this.isRunning = true
    this.calls.push({ readOnly: params.readOnly === true, input: params.input, turnKey: params.turnKey })
    if (String(params.input).startsWith('/compact') && this.idleHook) {
      return { submitted: Promise.resolve(), summary: this.idleHook(params), end() {} } as EngineTurnRun
    }
    const fail = this.failNext
    this.failNext = false
    let finalized = false
    let resolve!: (value: TurnSummary | null) => void
    const summary = new Promise<TurnSummary | null>(r => { resolve = r })
    setImmediate(async () => {
      await this.beforeComplete?.()
      if (finalized) return
      params.sessionTotals.turns += 1
      const text = fail ? '' : '已完成只读核验，建议见回复。'
      if (!fail) params.onEvent({ kind: 'block', block: { kind: 'text', text } })
      params.onEvent({ kind: 'final', meta: { cost: 0.125, inputTokens: 1, outputTokens: 1 } })
      finalized = true
      resolve({
        usage: { cost: 0.125, inputTokens: 1, outputTokens: fail ? 0 : 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: fail ? 1 : 2 },
        assistantText: text, thinkingText: '', assistantSegments: [], thinkingSegments: [], tools: [], runtimeEvents: [],
        stopReason: fail ? null : 'end_turn', numTurns: 1, isError: fail, staleResumeId: false,
        phantomSignals: { apiState: 'called', skipReason: null },
        ...(fail ? { errorKind: 'other' as const, errorClass: 'model_capacity' as const, errorDetail: 'Selected model is at capacity. Please try a different model.' } : {}),
      })
    })
    return {
      submitted: Promise.resolve(), summary,
      end: () => { if (!finalized) { finalized = true; resolve(null) } },
      getPartialSnapshot: () => this.getPartialSnapshot(),
      getPhantomSignals: () => ({ apiState: 'called', skipReason: null }),
      get finalized() { return finalized }, pendingToolCalls: 0,
    }
  }
}

let serial = 0
function fixture(engine: Engine) {
  const peerId = `advisor-nowrite-${engine}-${++serial}`
  const sessionKey = `agent:main:webchat:dm:${peerId}`
  const config = {
    version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: '' },
    defaults: { model: MODELS[engine] }, channels: { webchat: { enabled: true } },
  } as unknown as OpenClaudeConfig
  const manager = new SessionManager(config)
  const runner = new RecordingEngine(engine)
  const session = {
    sessionKey, agentId: 'main', channel: 'unit', peerId, title: peerId,
    startedAt: Date.now(), runner, model: MODELS[engine], lock: Promise.resolve(), lastUsedAt: 0,
    totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
    turns: 0, _lastCcbCumulativeCost: 0, toolUseIdToName: new Map(),
    executionTarget: { kind: 'local' }, providerTag: engine,
  } as unknown as AgentSession
  ;(manager as any).sessions.set(sessionKey, session)
  ;(manager as any)._transientRetryDelayMs = () => 0
  const events: any[] = []
  const submit = (readOnly?: boolean) => manager.submit(session, '当前任务', event => events.push(event),
    undefined, undefined, undefined, undefined, undefined, readOnly === undefined ? undefined : { readOnly })
  return { manager, runner, session, events, submit, config, peerId, sessionKey }
}

function gatewayFixture() {
  const f = fixture('ccb')
  const agent = { id: 'main', provider: 'anthropic', model: MODELS.ccb }
  const gw = Object.create(Gateway.prototype) as any
  Object.assign(gw, {
    _shuttingDown: false, _runtimeRecycleIngressActive: 0, _runtimeRecycleDrainUntil: 0,
    clientsByPeer: new Map(), lastActiveChannel: new Map(), _seenIdempotencyKeys: new Map(),
    _hiddenDelegateGuard: new PerTurnDelegationGuard(),
    log: { debug() {}, info() {}, warn() {}, error() {} }, rateLimiter: { check: () => true },
    router: { route: () => ({ sessionKey: f.sessionKey, agent }) }, deps: { config: f.config },
    _getAgentsConfig: async () => ({ default: 'main', agents: [agent] }),
    _isIdempotencyDuplicate: () => false, _markIdempotencyKey() {},
    _runLog: { start: () => ({}), complete() {} }, _adoptOrphanedStdoutWaitDelegates() {},
    _freezeAdvisorTurn: async () => ({ ok: true, advisorModel: 'gpt-6-astra' }),
    sessions: f.manager, deliver(frame: unknown) { f.events.push(frame) },
  })
  f.manager.getOrCreate = async () => f.session
  const inbound = (text: string, mode: 'solo' | 'advisor' = 'solo', media: unknown[] = [], replyTo?: unknown) =>
    gw.dispatchInbound({ type: 'inbound.message', channel: 'webchat', peer: { id: f.peerId, kind: 'dm' },
      collabMode: mode, advisorModel: 'gpt-6-astra', content: { text, media, replyTo }, _userId: '1' })
  return { ...f, inbound }
}


const { createServer } = await import('node:http')
const { writeIdleCandidate, writeIdleNative, writeIdleOp, readIdleOp, assembleIdleArtifact } = await import('../boxIdleCompact.js')
const revision = 'b'.repeat(64), idleKey = 'c'.repeat(64), sourceKey = 'd'.repeat(64)
const nativeId = '74700000-0000-4000-8000-000000000001'
function seed(key: string) {
  const artifact = assembleIdleArtifact({ opId: idleKey, summaryText: 'summary', tail: [], attachments: [] })
  writeIdleCandidate(home, { v: 1, sessionKey: key, sessionId: nativeId, turnKey: sourceKey, createdAt: Date.now() })
  writeIdleOp(home, { v: 1, sessionKey: key, sourceSessionId: nativeId, sourceTurnKey: sourceKey,
    revision, idleTurnKey: idleKey, frozenTail: [], attachments: [], summaryText: 'summary', artifact })
  writeIdleNative(home, { v: 1, sessionId: nativeId, revision, opId: idleKey, summaryText: 'summary',
    modelStarted: true, modelCalls: 1, frozenTail: [], attachments: [],
    rollbackTip: '74700000-0000-4000-8000-000000000002' })
  return artifact
}
async function proofServer(unknownProof = false, proofSessionId = nativeId) {
  process.env.OC_USER_ID = '3'
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/internal/v3/marketplace/sync')) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ agents: [], skills: [], identityCompat: { schema: 1, userId: '3', profiles: [] } })); return
    }
    if (req.url?.startsWith('/internal/v3/platform-prompt-slots')) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ slots: [], promptPolicy: { schemaVersion: 1, profile: null } })); return
    }
    if (!req.url?.startsWith('/internal/box/')) { res.statusCode = 404; res.end('{}'); return }
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.url?.endsWith('/stop') ? { status: 'stopped' } :
        unknownProof && body.oc_turn_key === idleKey ? { status: 'pending', reason: 'unknown' } :
        { status: 'terminal', sessionId: proofSessionId, turnKey: body.oc_turn_key, requestId: 'request',
          revision, compactRequired: true, capsuleSha256: 'a'.repeat(64),
          ...(body.oc_turn_key === idleKey ? { summaryText: 'summary' } : {}) }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  process.env.ANTHROPIC_BASE_URL = process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${port}/`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.fixture'
  process.env.OC_BOX_IDLE_PROOF_WAIT_MS = '0'
  return async () => {
    delete process.env.OC_USER_ID
    delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
    delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    await new Promise<void>(r => server.close(() => r()))
  }
}
for (const mode of ['receipt', 'missing', 'unstoppable', 'unknown-proof', 'hung-stop', 'false-stop', 'corrupt'] as const) {
  test(`OCV5-747 real inbound + submit: ${mode}`, { timeout: 30000 }, async () => {
    const f = gatewayFixture()
    f.session.channel = 'webchat'
    const artifact = seed(f.sessionKey)
    const close = await proofServer(mode === 'unknown-proof')
    const rejected = ['unstoppable', 'unknown-proof', 'hung-stop', 'false-stop', 'corrupt'].includes(mode)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(r => { release = r })
    const started = new Promise<void>(r => { entered = r })
    f.runner.idleHook = async () => {
      entered()
      if (mode === 'corrupt') return { isError: true, errorDetail: 'IDLE_RECOVERY_CORRUPT' } as TurnSummary
      if (mode === 'receipt') await held
      return mode === 'receipt' ? { nativeIdleReceipt: { opId: idleKey, digest: artifact.digest } } as TurnSummary : {} as TurnSummary
    }
    f.runner.stopFails = mode === 'unstoppable'
    if (mode === 'false-stop') f.runner.shutdown = async () => {}
    if (mode === 'hung-stop') {
      f.runner.shutdown = () => new Promise<void>(() => {})
      f.session._idleDeadline = Date.now() + 100
    }
    try {
      if (mode === 'receipt') (f.manager as any).scheduleIdleDrain(f.session)
      if (mode === 'receipt') await started
      const work = f.inbound('continue once')
      void work.catch((e: unknown) => { f.events.push({ testError: String(e) }) })
      for (let i = 0; i < 100 && !f.events.some(e => e.type === 'outbound.turn_status' && e.status === 'compacting'); i++)
        await new Promise(r => setTimeout(r, 50))
      const status = f.events.find(e => e.type === 'outbound.turn_status' && e.status === 'compacting')
      if (mode === 'receipt') assert.ok(status, 'waiting client receives compacting: ' + JSON.stringify(f.events))
      if (mode === 'receipt') {
        assert.equal(f.session.currentTurnStatus, 'compacting', 'hello reconnect has phase cache while waiting')
        release()
      }
      if (rejected) {
        await assert.rejects(work, mode === 'corrupt' ? /IDLE_RECOVERY_CORRUPT/ : /IDLE_RECOVERY_PENDING:[1-9]/)
        assert.equal(f.runner.calls.filter(c => !String(c.input).startsWith('/compact')).length, 0)
        assert.equal(readIdleOp(home, f.sessionKey, revision)?.disposition, undefined)
      } else {
        await work
        const finals = f.events.filter(e => e.type === 'outbound.message' && e.isFinal)
        assert.equal(finals.length, 1, 'one user completion/settlement: ' + JSON.stringify(f.events))
        assert.equal(finals[0].meta.cost, 0.125, 'one final usage amount, no idle duplicate charge')
        assert.equal(f.runner.calls.filter(c => !String(c.input).startsWith('/compact')).length, 1, 'one billable user execution')
        assert.ok(JSON.stringify(f.events).includes('已完成只读核验'), 'client gets the actual normal reply')
        if (mode === 'missing') assert.equal(readIdleOp(home, f.sessionKey, revision)?.abandonReason, 'idle_apply_unconfirmed')
      }
      assert.ok(status, 'all idle wait paths report compacting')
      assert.equal(f.session._idleWaiters?.size ?? 0, 0)
      assert.equal(f.session._idleDeadline, undefined, 'an exhausted wait cannot permanently poison recovery')
      if (mode === 'hung-stop') {
        f.runner.shutdown = async () => { f.runner.isRunning = false }
        await f.inbound('recover after stop becomes available')
        assert.equal(f.runner.calls.filter(c => !String(c.input).startsWith('/compact')).length, 1)
        assert.equal(f.events.filter(e => e.type === 'outbound.message' && e.isFinal).length, 1)
        assert.equal(readIdleOp(home, f.sessionKey, revision)?.abandonReason, 'idle_apply_unconfirmed')
      }
      await f.manager.awaitPendingPersistence()
      if (!rejected) {
        const records = (await readFile(settledPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l))
        const matching = records.filter(r => JSON.stringify(r).includes(f.peerId))
        assert.equal(matching.length, 1, 'one durable user-turn result, not idle output')
      }
    } finally { release(); await close() }
  })
}

for (const partial of [false, true]) {
  test(`OCV5-747 proof-only recovery: ${partial ? 'legacy partial stays blocked' : 'first apply safely abandons'}`, async () => {
    const f = gatewayFixture()
    f.session.channel = 'webchat'
    const sid = `74700000-0000-4000-8000-${partial ? '000000000021' : '000000000020'}`
    const tip = '74700000-0000-4000-8000-000000000022'
    const { readIdleNative } = await import('../boxIdleCompact.js')
    const { resumeIdleSummary } = await import('../../../../claude-code-best/src/services/compact/idleRecover.js')
    const { readIdleRollbacks } = await import('@openclaude/storage')
    writeIdleCandidate(home, { v: 1, sessionKey: f.sessionKey, sessionId: sid, turnKey: sourceKey, createdAt: Date.now() })
    writeIdleOp(home, { v: 1, sessionKey: f.sessionKey, sourceSessionId: sid, sourceTurnKey: sourceKey,
      revision, idleTurnKey: idleKey, frozenTail: [], attachments: [] })
    if (partial) writeIdleNative(home, { v: 1, sessionId: sid, revision, opId: idleKey,
      summaryText: 'summary', modelCalls: 1, modelStarted: true, frozenTail: [], attachments: [],
      artifact: assembleIdleArtifact({ opId: idleKey, summaryText: 'summary', tail: [], attachments: [] }) })
    let tipReads = 0
    f.runner.idleHook = async () => {
      // Real CCB preparation; the engine boundary drops the apply receipt.
      await resumeIdleSummary({ sessionId: sid, home, messages: [], loadOriginalTip: async () => {
        tipReads++
        return partial ? 'unsafe-current-partial-tip' : tip
      } })
      return {} as TurnSummary
    }
    const close = await proofServer(false, sid)
    try {
      if (partial) {
        await assert.rejects(f.inbound('continue original context'), /IDLE_RECOVERY_PENDING:/)
        assert.equal(tipReads, 0, 'never recapture a possibly post-apply tip')
        assert.equal(readIdleNative(home, sid, revision)?.rollbackTip, undefined)
        assert.equal(readIdleOp(home, f.sessionKey, revision)?.disposition, undefined)
        assert.equal(readIdleRollbacks(home, sid).length, 0)
        assert.equal(f.runner.calls.filter(c => !String(c.input).startsWith('/compact')).length, 0)
      } else {
        await f.inbound('continue original context')
        assert.equal(tipReads, 1)
        assert.equal(readIdleNative(home, sid, revision)?.rollbackTip, tip)
        assert.equal(readIdleOp(home, f.sessionKey, revision)?.disposition, 'abandoned')
        assert.equal(readIdleRollbacks(home, sid)[0]?.restoreTip, tip)
        assert.equal(f.runner.calls.filter(c => !String(c.input).startsWith('/compact')).length, 1)
        assert.ok(JSON.stringify(f.events).includes('已完成只读核验'))
        const finals = f.events.filter(e => e.type === 'outbound.message' && e.isFinal)
        assert.equal(finals.length, 1)
        assert.equal(finals[0].meta.cost, 0.125)
        await f.manager.awaitPendingPersistence()
        const records = (await readFile(settledPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l))
        assert.equal(records.filter(r => JSON.stringify(r).includes(f.peerId)).length, 1)
      }
    } finally { await close() }
  })
}

test('OCV5-747 two real inbound waiters: first unsafe exit preserves second compacting then one reply', { timeout: 30000 }, async () => {
  const f = gatewayFixture()
  f.session.channel = 'webchat'
  seed(f.sessionKey)
  const close = await proofServer()
  let releaseFirst!: () => void, releaseSecond!: () => void, firstEntered!: () => void, secondEntered!: () => void
  const firstGate = new Promise<void>(r => { releaseFirst = r })
  const secondGate = new Promise<void>(r => { releaseSecond = r })
  const startedFirst = new Promise<void>(r => { firstEntered = r })
  const startedSecond = new Promise<void>(r => { secondEntered = r })
  let applies = 0
  const pending: Promise<unknown>[] = []
  f.runner.stopFails = true
  f.runner.idleHook = async () => {
    if (++applies === 1) { firstEntered(); await firstGate }
    else { secondEntered(); await secondGate }
    return {} as TurnSummary
  }
  try {
    const first = assert.rejects(f.inbound('first unsafe waiter'), /IDLE_RECOVERY_PENDING:/)
    pending.push(first)
    await startedFirst
    const second = f.inbound('second safe waiter')
    pending.push(second)
    void second.catch(() => {}) // observed below, including assertion-failure cleanup
    // dispatchInbound has async preparation before entering submit/session.lock.
    for (let i = 0; i < 100 && f.session._idleWaiters?.size !== 2; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal(f.session._idleWaiters?.size, 2)
    const firstExitIndex = f.events.length
    releaseFirst()
    await first
    await startedSecond
    assert.equal(f.session._idleWaiters?.size, 1)
    assert.equal(f.session.currentTurnStatus, 'compacting')
    assert.ok(!f.events.slice(firstExitIndex).some(e => e.type === 'outbound.turn_status' && e.status === null))
    f.runner.stopFails = false
    releaseSecond()
    await second
    assert.equal(f.session._idleWaiters?.size, 0)
    assert.equal(f.runner.calls.filter(c => !String(c.input).startsWith('/compact')).length, 1)
    assert.equal(f.events.filter(e => e.type === 'outbound.message' && e.isFinal).length, 1)
    assert.ok(JSON.stringify(f.events).includes('已完成只读核验'))
  } finally {
    f.runner.stopFails = false
    releaseFirst(); releaseSecond()
    await Promise.allSettled(pending)
    await close()
  }
})
