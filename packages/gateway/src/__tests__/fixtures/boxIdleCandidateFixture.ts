/** Business-path proof shared by the regression and pinned release gate.
 * All model execution is a neutral adapter; no external model or wallet is used. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile, readFile, appendFile } from 'node:fs/promises'
import { utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { TurnParams, EngineTurnRun } from '../../engine/engineAdapter.js'
import type { TurnSummary } from '../../engine/engineEvents.js'
import type { AgentSession } from '../../sessionManager.js'
import type { OpenClaudeConfig } from '@openclaude/storage'

export async function proveBoxIdleCandidateRecovery(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 't1642u-idle-'))
  const env = { ...process.env }
  process.env.OPENCLAUDE_HOME = home
  for (const key of ['OC_RUNTIME_CHANNEL', 'OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN',
    'OC_MODEL_AUTHORITY', 'OC_USER_ID', 'OC_BOX_IDLE_COMPACT_ALWAYS']) delete process.env[key]
  process.env.OC_BOX_IDLE_PROOF_WAIT_MS = '0'
  const { closeSessionsDb, upsertClientSession, getClientSession } = await import('@openclaude/storage')
  const { SessionManager } = await import('../../sessionManager.js')
  const idle = await import('../../boxIdleCompact.js')
  const { setV3MasterSinkSingleton } = await import('../../v3MasterSink.js')
  const settlements = join(home, 'settlements.jsonl')
  await writeFile(settlements, '')
  setV3MasterSinkSingleton({
    async persistOrQueue(payload: unknown) { await appendFile(settlements, `${JSON.stringify(payload)}\n`); return { ok: true } },
    async attemptOnce() {},
  } as never)
  const modelBox = 'box-api-claude-opus-5-5'
  const modelGpt = 'gpt-6-astra'
  const calls: Array<{ path: string; turn: string }> = []
  let proofMode: 'unknown' | 'failed' | 'missing' = 'unknown'
  let closeOnStop = false
  let protectedTurn: string | undefined
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/internal/v3/marketplace/sync')) {
      res.end(JSON.stringify({ agents: [], skills: [], identityCompat: { schema: 1, userId: '3', profiles: [] } })); return
    }
    if (!req.url?.startsWith('/internal/box/')) { res.statusCode = 404; res.end('{}'); return }
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw)
      calls.push({ path: req.url!, turn: body.oc_turn_key })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/internal/box/stop') {
        if (closeOnStop && body.oc_turn_key !== protectedTurn) proofMode = 'failed'
        // Even a positive ACK must not release without a subsequent proof.
        res.end(JSON.stringify({ status: 'stopped' })); return
      }
      if (proofMode === 'missing') { res.statusCode = 404; res.end('{}'); return }
      res.end(JSON.stringify(proofMode === 'failed' && body.oc_turn_key !== protectedTurn
        ? { status: 'failed', sessionId: body.session_id, turnKey: body.oc_turn_key, requestIds: ['original-box-run'] }
        : { status: 'pending', reason: 'continuation_unknown' }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  process.env.ANTHROPIC_BASE_URL = process.env.OPENCLAUDE_V3_MASTER_BASE_URL = base
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.fixture'
  process.env.OC_USER_ID = '3'

  class Runner extends EventEmitter {
    engineId = 'ccb'
    model = modelBox
    nativeSessionId: string | null = 'native-t1642u'
    capabilities = { billingMode: 'proxy', supportsEffort: true, resumeKind: 'ccb-session',
      needsServerRequestId: false, historyMode: 'native-resume', permissionModel: 'native',
      emitsCallUsage: false, emitsToolInputDeltas: false, supportsNativeCompact: false, multimodalInput: 'text-only' }
    isRunning = true
    lastActivityAt = Date.now()
    pendingToolCalls = 0
    effortLevel: string | undefined
    inputs: TurnParams['input'][] = []
    failNext = false
    stopMode: 'ok' | 'lie' | 'throw' = 'ok'
    async start() { this.isRunning = true }
    async shutdown() { if (this.stopMode === 'throw') throw new Error('still alive'); if (this.stopMode === 'ok') this.isRunning = false }
    async waitForOutputDrain() {}
    interrupt() { return false }
    clearSessionId() { this.nativeSessionId = null }
    setModel(m: string | undefined) { this.model = m ?? modelBox }
    setEffortLevel(e: string | undefined) { this.effortLevel = e }
    setTraceId() {}
    getBoundRepoBinding() { return null }
    getPartialSnapshot() { return { assistantText: '', thinkingText: '', completedTools: [], assistantSegments: [], thinkingSegments: [], runtimeEvents: [] } }
    submitTurn(p: TurnParams): EngineTurnRun {
      this.isRunning = true
      this.inputs.push(p.input)
      const fail = this.failNext
      this.failNext = false
      let done = false
      const summary = new Promise<TurnSummary>(resolve => setImmediate(() => {
        p.sessionTotals.turns += 1
        if (!fail) p.onEvent({ kind: 'block', block: { kind: 'text', text: 'Recovered answer' } })
        p.onEvent({ kind: 'final', meta: { cost: fail ? 0 : 0.125, inputTokens: 1, outputTokens: fail ? 0 : 1 } })
        done = true
        resolve({ usage: { cost: fail ? 0 : 0.125, inputTokens: 1, outputTokens: fail ? 0 : 1,
          cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: fail ? 1 : 2 },
          assistantText: fail ? '' : 'Recovered answer', thinkingText: '', assistantSegments: [], thinkingSegments: [],
          tools: [], runtimeEvents: [], stopReason: fail ? null : 'end_turn', numTurns: 1,
          isError: fail, staleResumeId: false, phantomSignals: { apiState: 'called', skipReason: null },
          ...(fail ? { errorKind: 'other', errorClass: 'unknown', errorDetail: 'BOX_EXEC_HTTP_417 / continuation_unknown' } : {}),
        } as TurnSummary)
      }))
      return { submitted: Promise.resolve(), summary, end() {}, get finalized() { return done },
        getPartialSnapshot: () => this.getPartialSnapshot(), getPhantomSignals: () => ({ apiState: 'called', skipReason: null }), pendingToolCalls: 0 } as EngineTurnRun
    }
  }
  let serial = 0
  function fixture() {
    const peerId = `t1642u-${++serial}`
    const key = `agent:main:webchat:dm:${peerId}`
    const manager = new SessionManager({ version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
      auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: '' }, defaults: { model: modelBox },
      channels: {} } as unknown as OpenClaudeConfig)
    // Drive recovery deterministically via submit, without background timers.
    ;(manager as unknown as { scheduleIdleDrain(): void }).scheduleIdleDrain = () => {}
    const runner = new Runner()
    const session = { sessionKey: key, agentId: 'main', channel: 'webchat', userId: '3', peerId, title: peerId,
      startedAt: Date.now(), runner, model: modelBox, lock: Promise.resolve(), lastUsedAt: 0,
      totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0, turns: 0, _lastCcbCumulativeCost: 0, toolUseIdToName: new Map(),
      executionTarget: { kind: 'local' }, providerTag: 'anthropic' } as unknown as AgentSession
    const history = [{ id: 'old-user', role: 'user', text: 'Keep my complete original question', ts: 1 },
      { id: 'old-answer', role: 'assistant', text: 'Keep the existing answer and tool transcript', ts: 2 }]
    const submit = (model = modelBox) => manager.submit(session, 'Next question', () => {}, undefined, model,
      undefined, undefined, undefined, { historicalMessages: history, modelAuthority: { executionDescriptor: { contextOwner: 'box-native-v1' } } as never })
    const seed = (old = true, legacy = false) => {
      idle.writeIdleCandidate(home, { v: 1, sessionKey: key, sessionId: 'native-t1642u', turnKey: 'd'.repeat(64),
        ...(!legacy ? { createdAt: Date.now() - (old ? idle.IDLE_CANDIDATE_STUCK_MS + 1000 : 0) } : {}) })
      if (legacy) { const t = (Date.now() - idle.IDLE_CANDIDATE_STUCK_MS - 1000) / 1000
        utimesSync(join(home, 'idle-candidates', `${encodeURIComponent(key)}.json`), t, t) }
    }
    return { manager, runner, session, key, submit, seed, history }
  }
  try {
    for (const model of [modelBox, modelGpt]) {
      const f = fixture()
      f.runner.failNext = true
      await f.submit()
      await f.manager.awaitPendingPersistence()
      assert.equal(f.runner.inputs.length, 1, 'failed turn must execute exactly once')
      const failedFinal = JSON.parse((await readFile(settlements, 'utf8')).trim().split('\n').at(-1)!)
      assert.equal(failedFinal.status, 'crashed', 'original failure is durably recorded')
      assert.equal(failedFinal.waiveReason, 'no_response', 'existing no-response billing policy stays intact')
      const candidate = idle.readIdleCandidate(home, f.key)
      assert.ok(candidate, 'real failed Box turn must persist its source candidate')
      idle.writeIdleCandidate(home, { ...candidate, createdAt: Date.now() - idle.IDLE_CANDIDATE_STUCK_MS - 1000 })
      await upsertClientSession({ id: f.session.peerId, userId: '3', agentId: 'main', title: 'Preserve history',
        pinned: false, createdAt: 1, lastAt: 2, updatedAt: 2, messages: f.history })
      const historyBefore = (await getClientSession(f.session.peerId, '3'))!.messages
      const before = await readFile(settlements, 'utf8')
      proofMode = 'unknown'; closeOnStop = false
      await assert.rejects(f.submit(model), /IDLE_HISTORY_PENDING/, 'unknown stop ACK must stay protected')
      assert.equal(f.runner.inputs.length, 1)
      assert.equal(await readFile(settlements, 'utf8'), before, 'blocked submit cannot settle or charge another turn')
      assert.equal(idle.readIdleCandidate(home, f.key)?.observedPending, true)
      // A fresh manager and runner have no prior in-memory proof state.
      const fresh = fixture()
      fresh.session.sessionKey = f.key; fresh.session.peerId = f.session.peerId
      closeOnStop = true
      if (model === modelGpt) { fresh.runner.engineId = 'codex'; fresh.runner.model = modelGpt; fresh.session.model = modelGpt }
      await fresh.manager.submit(fresh.session, 'Next question', e => { if (e.kind === 'error') throw new Error(JSON.stringify(e)) }, undefined, model,
        undefined, undefined, undefined, { historicalMessages: f.history })
      await fresh.manager.awaitPendingPersistence()
      assert.equal(fresh.runner.inputs.length, 1, 'proved recovery must admit exactly one subsequent turn')
      assert.equal(fresh.session.model, model)
      assert.deepEqual((await getClientSession(f.session.peerId, '3'))!.messages, historyBefore, 'stored original history remains intact')
      const lines = (await readFile(settlements, 'utf8')).slice(before.length).trim().split('\n').filter(Boolean)
      assert.equal(lines.length, 1, 'one persisted final for the next turn')
      assert.match(lines[0]!, /Recovered answer/)
      const cleared = JSON.parse(await readFile(join(home, 'idle-candidates', `${encodeURIComponent(f.key)}.json.done`), 'utf8'))
      assert.equal(cleared.turnKey, candidate.turnKey, 'retired evidence names the original failed turn')
    }
    for (const legacy of [false, true]) {
      const f = fixture(); f.seed(true, legacy)
      proofMode = 'unknown'; closeOnStop = true
      await f.submit()
      assert.equal(f.runner.inputs.length, 1, 'old and legacy candidates recover with proof')
    }
    const young = fixture(); young.seed(false)
    proofMode = 'unknown'; closeOnStop = true
    const stops = calls.filter(c => c.path.endsWith('/stop')).length
    await assert.rejects(young.submit(), /IDLE_HISTORY_PENDING/)
    assert.equal(calls.filter(c => c.path.endsWith('/stop')).length, stops, 'young continuation is allowed to finish')
    assert.equal(young.runner.inputs.length, 0)

    const missing = fixture(); missing.seed()
    proofMode = 'unknown'; closeOnStop = false
    await assert.rejects(missing.submit(), /IDLE_HISTORY_PENDING/)
    proofMode = 'missing'
    const restarted = fixture()
    restarted.session.sessionKey = missing.key
    await assert.rejects(restarted.submit(modelGpt), /IDLE_HISTORY_PENDING/)
    assert.ok(idle.readIdleCandidate(home, missing.key), 'known unknown cannot become not-executed after restart')

    for (const mode of ['lie', 'throw'] as const) {
      const f = fixture(); f.seed(); f.runner.stopMode = mode
      proofMode = 'unknown'; closeOnStop = true
      const before = calls.filter(c => c.path.endsWith('/stop')).length
      await assert.rejects(f.submit(), /IDLE_HISTORY_PENDING/)
      assert.equal(calls.filter(c => c.path.endsWith('/stop')).length, before, 'no remote stop without local fence')
      assert.ok(idle.readIdleCandidate(home, f.key))
    }

    const reset = fixture(); reset.seed()
    idle.requestIdleReset(home, reset.key)
    reset.session.ccbSessionId = 'native-t1642u'
    reset.session._historicalContextInjected = true
    proofMode = 'unknown'; closeOnStop = false
    await assert.rejects(reset.submit(), /IDLE_HISTORY_PENDING/)
    assert.ok(idle.readIdleReset(home, reset.key), 'reset intent survives ambiguous stop')
    assert.equal(reset.session.ccbSessionId, 'native-t1642u')
    assert.ok(idle.readIdleCandidate(home, reset.key))
    closeOnStop = true
    await reset.submit(modelGpt)
    assert.equal(idle.readIdleReset(home, reset.key), undefined)
    assert.equal(reset.session.ccbSessionId, null)
    assert.equal(reset.runner.inputs.length, 1)
    assert.match(String(reset.runner.inputs[0]), /Keep my complete original question/, 'reset rebuilds history context')
    await reset.manager.awaitPendingPersistence()

    const multi = fixture()
    for (const digit of ['a', 'b']) idle.writeIdleOp(home, {
      v: 1, sessionKey: multi.key, sourceSessionId: 'native-t1642u', sourceTurnKey: digit.repeat(64),
      idleTurnKey: (digit === 'a' ? 'c' : 'e').repeat(64), revision: digit.repeat(64), frozenTail: [], attachments: [],
    })
    idle.requestIdleReset(home, multi.key)
    protectedTurn = 'e'.repeat(64); proofMode = 'failed'; closeOnStop = true
    await assert.rejects(multi.submit(), /IDLE_HISTORY_PENDING/)
    assert.equal(idle.readPendingIdleOps(home, multi.key).length, 2, 'one live identity preserves every pending op')
    assert.ok(idle.readIdleReset(home, multi.key))
    assert.equal(multi.runner.inputs.length, 0)
    protectedTurn = undefined
    await multi.submit()
    assert.equal(idle.readPendingIdleOps(home, multi.key).length, 0)
    assert.equal(idle.readIdleReset(home, multi.key), undefined)
    await multi.manager.awaitPendingPersistence()
    return '[t1642u-box-idle-recovery] PASS'
  } finally {
    await new Promise<void>(r => server.close(() => r()))
    setV3MasterSinkSingleton(null)
    await closeSessionsDb()
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
    Object.assign(process.env, env)
    await rm(home, { recursive: true, force: true })
  }
}
