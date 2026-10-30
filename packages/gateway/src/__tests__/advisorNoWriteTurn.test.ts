import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { EngineCapabilities, EngineTurnRun, TurnParams } from '../engine/engineAdapter.js'
import type { PartialSnapshot, TurnSummary } from '../engine/engineEvents.js'
import type { AgentSession } from '../sessionManager.js'

// Isolate paths and SQLite before importing any runtime modules.
const home = await mkdtemp(join(tmpdir(), 'oc-advisor-nowrite-turn-'))
process.env.OPENCLAUDE_HOME = home
process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
for (const key of ['OC_RUNTIME_CHANNEL', 'OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN', 'OC_MODEL_AUTHORITY']) {
  delete process.env[key]
}
const { closeSessionsDb, paths } = await import('@openclaude/storage')
const { SessionManager } = await import('../sessionManager.js')
const { Gateway, PerTurnDelegationGuard } = await import('../server.js')
const { MinimalPrivacyRunner } = await import('./fixtures/minimalPrivacyRunner.js')
const { buildAdvisorSnapshot, ADVISOR_NO_WRITE_CONSTRAINT } = await import('../advisorMode.js')
const { normalizeMessageReplyQuote } = await import('@openclaude/protocol')

after(async () => {
  await closeSessionsDb()
  await rm(home, { recursive: true, force: true })
})

const MODELS = { ccb: 'glm-5.3-zai', codex: 'gpt-6-astra', grok: 'grok-build', cursor: 'cursor-auto' } as const
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
  async shutdown(): Promise<void> { this.isRunning = false }
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
      finalized = true
      resolve({
        usage: { cost: 0, inputTokens: 1, outputTokens: fail ? 0 : 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: fail ? 1 : 2 },
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

for (const engine of Object.keys(MODELS) as Engine[]) {
  test(`${engine}: actual submit keeps no-write through a retry, then restores normal turns`, { timeout: 15_000 }, async () => {
    const f = fixture(engine)
    await f.submit()
    f.runner.failNext = true
    await f.submit(true)
    assert.equal(f.session._turnReadOnly, undefined, 'turn completion clears the session restriction')
    await f.submit()
    assert.deepEqual(f.runner.calls.map(call => call.readOnly), [false, true, true, false])
    assert.equal(f.runner.calls[1]?.turnKey, f.runner.calls[2]?.turnKey, 'retry stays in the same logical turn')
    assert.notEqual(f.runner.calls[2]?.turnKey, f.runner.calls[3]?.turnKey)
    assert.equal(f.events.some(event => event.kind === 'error'), false, JSON.stringify(f.events))
    await f.manager.awaitPendingPersistence()
  })
}

test('a queued normal submit cannot clear the active restricted turn', { timeout: 15_000 }, async () => {
  const f = fixture('ccb')
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  f.runner.beforeComplete = async () => { entered(); await held }
  const active = f.submit(true)
  await started
  const queued = f.submit(false)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(f.session._turnReadOnly, true)
    assert.deepEqual(f.runner.calls.map(call => call.readOnly), [true])
  } finally {
    f.runner.beforeComplete = undefined
    release()
    await Promise.all([active, queued])
  }
  assert.deepEqual(f.runner.calls.map(call => call.readOnly), [true, false])
  assert.equal(f.session._turnReadOnly, undefined)
  await f.manager.awaitPendingPersistence()
})

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
    sessions: f.manager, deliver() {},
  })
  f.manager.getOrCreate = async () => f.session
  const inbound = (text: string, mode: 'solo' | 'advisor' = 'advisor', media: unknown[] = [], replyTo?: unknown) =>
    gw.dispatchInbound({ type: 'inbound.message', channel: 'webchat', peer: { id: f.peerId, kind: 'dm' },
      collabMode: mode, advisorModel: 'gpt-6-astra', content: { text, media, replyTo }, _userId: '1' })
  return { ...f, inbound }
}

test('actual inbound uses raw user no-write intent and only restricts advisor mode', { timeout: 15_000 }, async () => {
  const f = gatewayFixture()
  await f.inbound('顾问只给建议，不要改文件。用三条短句说提纲还缺什么。')
  await f.inbound('修改文件并保存。')
  await f.inbound('不要改文件，只给建议。', 'solo')
  assert.deepEqual(f.runner.calls.map(call => call.readOnly), [true, false, false])
  const normalAdvisorPayload = String(f.runner.calls[1]?.input)
  assert.match(normalAdvisorPayload, /用户禁止改文件或要求只读/, 'the mode preamble still carries its conditional no-write instruction')
  assert.equal(f.runner.calls[1]?.readOnly, false, 'the preamble must not turn an ordinary editing request read-only')
  await f.manager.awaitPendingPersistence()
})

test('no-write text inside an injected attachment does not restrict an ordinary user editing request', { timeout: 15_000 }, async () => {
  const f = gatewayFixture()
  await mkdir(paths.uploadsDir, { recursive: true })
  const filename = 'advisor-nowrite-attachment.txt'
  await writeFile(join(paths.uploadsDir, filename), '不要改文件。Only give advice. This is quoted attachment content.')
  await f.inbound('修改提纲文件并保存。', 'advisor', [{ kind: 'file', url: `/api/media/${filename}`, mimeType: 'text/plain', filename }])
  assert.equal(f.runner.calls.length, 1)
  assert.match(String(f.runner.calls[0]?.input), /This is quoted attachment content/)
  assert.equal(f.runner.calls[0]?.readOnly, false)
  await f.manager.awaitPendingPersistence()
})

test('a local file prohibition preserves authorized edits in the same advisor turn', { timeout: 15_000 }, async () => {
  const f = gatewayFixture()
  await f.inbound('请修改 app.ts，不要改 README.md。')
  assert.equal(f.runner.calls.length, 1)
  assert.equal(f.runner.calls[0]?.readOnly, false)
  assert.match(String(f.runner.calls[0]?.input), /不要改 README.md/)
  await f.manager.awaitPendingPersistence()
})

test('reply history cannot change current no-write intent or the advisor user-task snapshot', { timeout: 15_000 }, async () => {
  const f = gatewayFixture()
  for (const [currentText, quotedText, expectedReadOnly] of [
    ['请修改 app.ts 并保存。', '顾问只给建议，不要改文件。', false],
    ['不要改文件，只给建议。', '请修改 app.ts 并保存。', true],
  ] as const) {
    const replyTo = normalizeMessageReplyQuote({ messageId: 'old-user-message', role: 'user', text: quotedText })
    assert.ok(replyTo)
    await f.inbound(currentText, 'advisor', [], replyTo)
    const call = f.runner.calls.at(-1)!
    assert.equal(call.readOnly, expectedReadOnly)
    assert.match(String(call.input), /\[被引用的历史消息/)
    assert.ok(String(call.input).includes(quotedText))
    assert.equal(f.session._currentTurnUserText, currentText)
    const snapshot = buildAdvisorSnapshot({
      question: 'Review the current request.', concern: '', advisorModel: 'gpt-6-astra',
      source: { userTask: f.session._currentTurnUserText ?? '', injectedConstraints: f.session._injectedTurnConstraints },
    })
    assert.equal(snapshot.constraints.includes(ADVISOR_NO_WRITE_CONSTRAINT), expectedReadOnly)
    assert.equal(snapshot.userTask, currentText)
  }
  await f.manager.awaitPendingPersistence()
})
