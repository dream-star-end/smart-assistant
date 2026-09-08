import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'

const home = await mkdtemp(join(tmpdir(), 'ocv5-179-pairing-'))
process.env.HOME = home
process.env.OPENCLAUDE_HOME = join(home, '.openclaude')
await mkdir(process.env.OPENCLAUDE_HOME, { recursive: true })
for (const key of ['OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN', 'OC_USER_ID', 'OC_RUNTIME_CHANNEL', 'OC_MODEL_AUTHORITY', ...Object.keys(process.env).filter(k => k.startsWith('OC_DELEGATE_'))]) delete process.env[key]
const { SessionManager } = await import('../sessionManager.js')
const { Gateway, PerTurnDelegationGuard } = await import('../server.js')
const { registerEngine } = await import('../engine/registry.js')
const { setV3MasterSinkSingleton, makeV3MasterSink } = await import('../v3MasterSink.js')
const { paths, writeAgentsConfig, identityCompatEnvironment, upsertClientSession, getClientSession, getEngineContextMessages } = await import('@openclaude/storage')
const { makeV3MasterRetryQueue } = await import('../v3MasterRetryQueue.js')
const profile = { profileId: 'registered-fixture', legacyAgentId: 'old-fixture', canonicalAgentId: 'market-fixture', localPersonaPath: 'agents/old-fixture/CLAUDE.md', localSkillStorageId: 'old-fixture' }
let projection: any = { schema: 1, userId: '3', profiles: [{ profile, readiness: 'ready' }] }
let status = 200
let fetches = 0
const server = createServer((req, res) => {
  assert.equal(req.url, '/internal/v3/marketplace/sync')
  assert.equal(req.headers.authorization, 'Bearer fixture-token')
  fetches++
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ skills: [], agents: [], identityCompat: projection }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as any).port
const config: any = { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: 'test' }, auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(home, 'sessions.db') }, defaults: { model: 'glm-5.2', permissionMode: 'default' } }
const agents = [{ id: profile.legacyAgentId, model: 'glm-5.2', persona: paths.agentClaudeMd(profile.legacyAgentId) }, { id: profile.canonicalAgentId, source: 'marketplace' as const, model: 'glm-5.2', persona: paths.agentClaudeMd(profile.canonicalAgentId) }]
let failNextConstruction = false
let coldNativeFixture = false
let onEngine: ((engine: EvidenceEngine, input: unknown) => Promise<void>) | undefined
let executed: { agent: string; key: string; soul: string; env: Record<string,string>; native: string | null; input: unknown }[] = []
class EvidenceEngine extends EventEmitter {
  engineId = 'ccb'; model = 'glm-5.2'; isRunning = false; lastActivityAt = Date.now(); nativeSessionId: string | null = 'unchanged-native'; sessionId = 'unchanged-native'; shutdowns = 0
  capabilities = { billingMode: 'proxy', supportsEffort: true, resumeKind: 'ccb-session', needsServerRequestId: false, historyMode: 'native-resume', permissionModel: 'native', emitsCallUsage: true, emitsToolInputDeltas: true, supportsNativeCompact: true, multimodalInput: 'native' }
  constructor(readonly opts: any) { super(); if (coldNativeFixture) this.nativeSessionId = opts.resumeSessionId ?? null }
  async start() { this.isRunning = true }
  async shutdown() { this.shutdowns++; this.isRunning = false; if (this.failShutdown) throw new Error('fixture shutdown failure') }
  failShutdown = false
  setTraceId() {} setEffortLevel() {} setModel(model: string) { this.model = model } setToolsets() {} interrupt() { return true }
  clearSessionId() {} async waitForOutputDrain() {} setGoalState() {}
  submitTurn(params: any) {
    const soul = this.opts.identityCompat?.assets?.buildSoul().content ?? 'unregistered'
    executed.push({ agent: this.opts.agentId, key: this.opts.sessionKey, soul, env: identityCompatEnvironment(this.opts.identityCompat), native: this.nativeSessionId, input: params.input })
    params.onEvent({ kind: 'block', block: { kind: 'text', text: soul, blockId: 'answer' } })
    const summary = { ...(typeof params.input === 'string' && params.input.startsWith('/compact') ? { nativeCompactionSummary: 'Native compact evidence: preserve user goal and original session.' } : {}), usage: { cost: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 2 }, assistantText: soul, thinkingText: '', assistantSegments: [{ text: soul }], thinkingSegments: [], tools: [], runtimeEvents: [], stopReason: 'end_turn', numTurns: 1, isError: false, staleResumeId: false, phantomSignals: { apiState: 'skipped', skipReason: 'test-engine' } }
    return { submitted: Promise.resolve(), summary: Promise.resolve().then(async () => { await onEngine?.(this, params.input); params.sessionTotals.turns += 1; return summary }), end() {}, getPartialSnapshot: () => ({ assistantText: soul, thinkingText: '', assistantSegments: [], thinkingSegments: [], tools: [], runtimeEvents: [] }), getPhantomSignals: () => summary.phantomSignals, finalized: true, pendingToolCalls: 0 }
  }
}
registerEngine('ccb', (opts) => {
  if (failNextConstruction) { failNextConstruction = false; throw new Error('fixture constructor failure') }
  return new EvidenceEngine(opts) as any
})
const managers: InstanceType<typeof SessionManager>[] = []
const manager = () => { const sm = new SessionManager(config); managers.push(sm); return sm }
beforeEach(async () => {
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${port}`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'fixture-token'
  process.env.OC_USER_ID = '3'
  projection = { schema: 1, userId: '3', profiles: [{ profile, readiness: 'ready' }] }; status = 200; executed = []; fetches = 0; onEngine = undefined; failNextConstruction = false; coldNativeFixture = false
  await mkdir(paths.agentDir(profile.legacyAgentId), { recursive: true })
  await mkdir(paths.agentDir(profile.canonicalAgentId), { recursive: true })
  await mkdir(join(home, 'core'), { recursive: true })
  await writeFile(join(home, 'CORE.md'), 'fixture index')
  for (const id of [profile.legacyAgentId, profile.canonicalAgentId]) {
    for (const [target, dest] of [[join(home, 'core'), join(paths.agentDir(id), 'memory')], [join(home, 'CORE.md'), join(paths.agentDir(id), 'MEMORY.md')]]) {
      try { await symlink(target, dest) } catch (err: any) { if (err.code !== 'EEXIST') throw err }
    }
  }
  await writeFile(paths.agentClaudeMd(profile.legacyAgentId), 'LOCAL MANUAL v1')
  await writeFile(paths.agentClaudeMd(profile.canonicalAgentId), 'MARKET PERSONA')
  await writeFile(join(paths.home, 'openclaude.json'), JSON.stringify(config))
  await writeAgentsConfig({ agents: [...agents, {id: 'pair-child', model: 'glm-5.2'}], default: profile.legacyAgentId, routes: [] })
  setV3MasterSinkSingleton({ persistOrQueue: async () => ({ ok: true }), attemptOnce: async () => {} } as any)
})
after(async () => { for (const sm of managers) await sm.shutdownAll(); setV3MasterSinkSingleton(null); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }) })


function latch() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
function gateway(sm: InstanceType<typeof SessionManager>) {
  const gw: any = Object.create(Gateway.prototype)
  Object.assign(gw, {
    _shuttingDown: false, _activeDelegations: 0, _activeDelegationsByParent: new Map(),
    _hiddenDelegateGuard: new PerTurnDelegationGuard(), _memberDelegateGuard: new PerTurnDelegationGuard(8),
    _delegateQueuePollMs: 10, _readDelegateMemoryPressure: () => null,
    log: {debug() {}, info() {}, warn() {}, error() {}}, deps: {config}, sessions: sm,
    _getAgentsConfig: async () => ({default: profile.legacyAgentId, agents: [...agents, {id: 'pair-child', model: 'glm-5.2'}]}),
    _runLog: {start: () => ({}), complete() {}}, deliver() {}, getUserId: () => '3',
  })
  return gw
}
async function delegate(gw: any, parentKey: string) {
  gw.readBody = async () => JSON.stringify({goal: 'pair child result', model: 'glm-5.2', sourceAgent: profile.legacyAgentId, parentSessionKey: parentKey})
  let status = 0, body = ''
  const res = {writeHead: (n: number) => { status = n }, end: (s: unknown) => {body = String(s ?? '')}}
  await gw.handleDelegateTask({method: 'POST', headers: {}}, res, 'pair-child')
  return {status, body: body ? JSON.parse(body) : {}}
}
async function durableHarness() {
  const dir = await mkdtemp(join(home, 'receipts-'))
  const queue = makeV3MasterRetryQueue({dir, attemptSend: async () => {throw new Error('isolated master offline')}})
  const sink = makeV3MasterSink({
    config: {baseUrl: 'http://master.invalid:18791', bearer: `oc-v3.3.${'a'.repeat(64)}`},
    retryQueue: {...queue, kick() {}},
    attemptSendImpl: async () => {throw new Error('isolated master offline')},
  })
  setV3MasterSinkSingleton(sink)
  return {
    queue,
    async payloads() {
      const names = (await readdir(dir)).filter(n => n.endsWith('.json'))
      return Promise.all(names.map(async name => JSON.parse(await readFile(join(dir, name), 'utf8')).payload))
    },
  }
}

for (const mode of ['next-turn', 'unavailable', 'http', 'identity-refresh'] as const) test(`A4+B1 real launch keeps original owner through ${mode}`, {timeout: 30000}, async () => {
  const sm = manager(), gw = gateway(sm), durable = await durableHarness()
  const key = `agent:old-fixture:webchat:dm:pair-${mode}`, peer = `pair-${mode}`
  const parent = await sm.getOrCreate({sessionKey: key, agent: agents[0], channel: 'webchat', peerId: peer, userId: '3'})
  assert.equal(parent.agentId, profile.canonicalAgentId)
  const childStarted = latch(), completeChild = latch()
  let job: Promise<{status: number; body: any}> | undefined
  let childOptions: any, owner: any, nextOwner: any
  const oldRunner = parent.runner
  onEngine = async (engine, input) => {
    if (engine.opts.agentId === 'pair-child') {
      childOptions = engine.opts
      owner = {parentSessionId: parent.peerId, parentTurnKey: parent._currentTurnKey, turnIndex: parent._currentTurnIndex}
      childStarted.resolve()
      await completeChild.promise
    } else if (String(input).includes('T2 subsequent turn')) {
      const live = sm.getByKey(key)!
      nextOwner = {key: live._currentTurnKey, turnIndex: live._currentTurnIndex}
      if (mode === 'identity-refresh') {
        assert.equal(live._activeClientTurnCount, 1)
        assert.equal(live._activeTurnCount, 1)
      }
    } else if (String(input).includes('T1 launch')) {
      job = delegate(gw, key)
      void job.catch(() => {})
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          childStarted.promise,
          job.then(result => { throw new Error(`delegate returned before child execution: ${JSON.stringify(result)}`) }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('child did not start')), 8000) }),
        ])
      } finally { clearTimeout(timer) }
    }
  }
  try {
    const fence = sm.beginPromptQueueExecutionFence(key)
    sm.beginClientTurn(parent)
    try {
      await sm.submit(parent, 'T1 launch', () => {}, undefined, undefined, undefined, undefined, undefined, {
        queueExecutionFence: fence, queueLifecycle: {queueTurn: true, async onTurnReserved() {}},
      })
    } finally { sm.endClientTurn(parent, 'completed'); fence.release() }
    assert.ok(job && owner?.parentTurnKey, `real parent execution reached real delegate launch: ${JSON.stringify({executed, launched: !!job})}`)
    assert.equal(childOptions.usageAttribution.parentTurnKey, owner.parentTurnKey)
    assert.equal(childOptions.usageAttribution.parentSessionId, peer)
    assert.equal(sm.getByKey(key)?._sealedOwnerTurnKeys?.has(owner.parentTurnKey), true, 'T1 actual finalization sealed its owner')
    const routing = gw._resolveDelegateProgressTarget({parentSessionKey: key, sourceAgent: profile.legacyAgentId})
    assert.equal(routing.target.sessionKey, key); assert.equal(routing.target.peerId, peer)
    assert.equal(gw._resolveDelegateProgressTarget({parentSessionKey: key + '-wrong', sourceAgent: profile.legacyAgentId}), null)
    const originalUser = parent.userId; parent.userId = '4'
    assert.equal(gw._resolveDelegateProgressTarget({parentSessionKey: key, sourceAgent: profile.legacyAgentId}), null)
    parent.userId = originalUser
    const before = executed.length
    if (mode === 'next-turn' || mode === 'identity-refresh') {
      if (mode === 'identity-refresh') {
        await writeFile(join(paths.home, 'openclaude.json'), JSON.stringify({...config, defaults: {...config.defaults, permissionMode: 'bypassPermissions'}}))
        const nextFence = sm.beginPromptQueueExecutionFence(key)
        sm.beginClientTurn(parent)
        try {
          await sm.submit(parent, 'T2 subsequent turn', () => {}, undefined, undefined, undefined, undefined, undefined, {
            queueExecutionFence: nextFence, queueLifecycle: {queueTurn: true, async onTurnReserved() {}},
          })
        } finally { sm.endClientTurn(parent, 'completed'); nextFence.release() }
        assert.notEqual(sm.getByKey(key)!.runner, oldRunner, 'real identity runner rebuilt')
        assert.equal(sm.getByKey(key), parent, 'identity refresh retains a single logical session')
        assert.equal(parent._activeClientTurnCount, 0)
        assert.equal(parent._activeTurnCount, 0)
      } else {
        await sm.submit(parent, 'T2 subsequent turn', () => {})
      }
      assert.ok(nextOwner?.key, 'T2 really executed with a reserved owner')
      assert.notEqual(nextOwner.key, owner.parentTurnKey)
      assert.equal(sm.getByKey(key)!._sealedOwnerTurnKeys?.has(nextOwner.key), true)
    } else {
      if (mode === 'unavailable') projection.profiles[0].readiness = 'unavailable'
      else status = 503
      await assert.rejects(sm.submit(parent, 'blocked new turn', () => {}), /not ready|authority/)
      assert.equal(executed.length, before, 'new execution denied before engine')
    }
    completeChild.resolve()
    const result = await job!
    assert.equal(result.status, 200, JSON.stringify(result))
    await sm.awaitPendingPersistence()
    let payloads = await durable.payloads()
    const late = payloads.filter(p => p.continuationOfTurnKey === owner.parentTurnKey)
    assert.equal(late.length, 1, 'exactly one durable T1 continuation receipt')
    const rootReceipts = payloads.filter(p => p.sessionId === peer && !p.continuationOfTurnKey)
    assert.equal(rootReceipts.length, mode === 'next-turn' || mode === 'identity-refresh' ? 2 : 1)
    assert.ok(rootReceipts.some(p => p.turnKey === owner.parentTurnKey && p.turnIndex === owner.turnIndex))
    if (nextOwner) assert.ok(rootReceipts.some(p => p.turnKey === nextOwner.key && p.turnIndex === nextOwner.turnIndex))
    assert.equal(late[0].sessionId, peer); assert.equal(late[0].turnIndex, owner.turnIndex)
    assert.equal(late[0].agentGroups.length, 1)
    assert.equal(late[0].agentGroups[0].status, 'ok')
    assert.match(late[0].agentGroups[0].resultSummary, /unregistered/)
    const runId = late[0].agentGroups[0].runId
    assert.ok(runId)
    for (const p of payloads.filter(p => p.sessionId === peer && !p.continuationOfTurnKey)) assert.equal((p.agentGroups ?? []).length, 0, 'no old card in T1/T2 root tape')
    assert.equal(executed.filter(e => e.agent === profile.canonicalAgentId).length, mode === 'next-turn' || mode === 'identity-refresh' ? 2 : 1)
    assert.equal(executed.filter(e => e.agent === 'pair-child').length, 1)
    const beforeRetry = executed.length
    assert.equal(await sm.deliverLateDelegateAgentGroup({owner, group: late[0].agentGroups[0], sessionKey: key}), true)
    await sm.awaitPendingPersistence()
    payloads = await durable.payloads()
    assert.equal(payloads.filter(p => p.continuationOfTurnKey === owner.parentTurnKey).length, 1)
    assert.equal(executed.length, beforeRetry, 'durable completion retry does not start another engine turn')
  } finally {
    completeChild.resolve(); await job?.catch(() => {}); onEngine = undefined
    await sm.awaitPendingPersistence(); durable.queue.stopPeriodic()
  }
})

// Unlike a manual-text refresh, changing the validated effective permission
// formerly replaced the AgentSession object and lost client/owner state.
// The fix must actually replace the runner while keeping the logical owner.
test('A4+B1 real identity runner replacement preserves client lifecycle and current queue ownership', {timeout: 30000}, async () => {
  const sm = manager(), key = 'agent:old-fixture:webchat:dm:pair-replace'
  const old = await sm.getOrCreate({sessionKey: key, agent: agents[0], channel: 'webchat', peerId: 'pair-replace', userId: '3'})
  let firstOwner: string | undefined
  onEngine = async () => { firstOwner = old._currentTurnKey }
  const firstEvents: unknown[] = []
  await sm.submit(old, 'first before replacement', e => { firstEvents.push(e) })
  onEngine = undefined
  assert.ok(firstOwner && old._sealedOwnerTurnKeys?.has(firstOwner), JSON.stringify(firstEvents))
  await writeFile(join(paths.home, 'openclaude.json'), JSON.stringify({...config, defaults: {...config.defaults, permissionMode: 'bypassPermissions'}}))
  const oldRunner = old.runner
  const fence = sm.beginPromptQueueExecutionFence(key)
  sm.beginClientTurn(old)
  try {
    await sm.submit(old, 'replacement queued turn', () => {}, undefined, undefined, undefined, undefined, undefined, {
      queueExecutionFence: fence, queueLifecycle: {queueTurn: true, async onTurnReserved() {}},
    })
  } finally {sm.endClientTurn(old, 'completed'); fence.release()}
  const current = sm.getByKey(key)!
  assert.equal(current, old, 'single logical AgentSession owns both client lifetime and execution')
  assert.notEqual(current.runner, oldRunner, 'a new runner enforces the updated identity configuration')
  assert.equal((oldRunner as unknown as EvidenceEngine).shutdowns, 1)
  assert.equal(current._sealedOwnerTurnKeys?.has(firstOwner!), true)
  assert.equal((current.runner as unknown as EvidenceEngine).opts.permissionMode, 'bypassPermissions')
  current.runner.emit('session_id', 'current-native')
  current.currentTurnStatus = 'compacting'
  oldRunner.emit('session_id', 'stale-native')
  oldRunner.emit('spawn', {resumed: false})
  oldRunner.emit('exit', {code: 1, signal: null, crashed: true})
  assert.equal(current.ccbSessionId, 'current-native')
  assert.equal(current.currentTurnStatus, 'compacting')
  const alienFence = sm.beginPromptQueueExecutionFence(key + '-other-owner')
  try {
    await assert.rejects(sm.submit(current, 'alien owner', () => {}, undefined, undefined, undefined, undefined, undefined, {queueExecutionFence: alienFence}), /PROMPT_QUEUE_EXECUTION_INVARIANT/)
  } finally {alienFence.release()}

  assert.equal(current.sessionKey, key); assert.equal(current.peerId, old.peerId); assert.equal(current.userId, '3')
  assert.equal(current._activeTurnCount ?? 0, 0); assert.equal(current._activeClientTurnCount ?? 0, 0)
  assert.equal(old._activeClientTurnCount ?? 0, 0)
  assert.equal(executed.length, 2)
  await assert.rejects(sm.submit(current, 'old ticket', () => {}, undefined, undefined, undefined, undefined, undefined, {queueExecutionFence: fence}), /PROMPT_QUEUE_EXECUTION_INVARIANT/)
  await sm.submit(current, 'ordinary subsequent turn', () => {})
  assert.equal(executed.length, 3)
})

for (const failure of ['construct', 'shutdown'] as const) test(`identity refresh ${failure} failure keeps old fingerprint retryable without execution`, async () => {
  const sm = manager(), key = `agent:old-fixture:webchat:dm:failure-${failure}`
  const old = await sm.getOrCreate({sessionKey: key, agent: agents[0], channel: 'webchat', peerId: `failure-${failure}`, userId: '3'})
  await sm.submit(old, 'initial execution', () => {})
  const oldFingerprint = old._identityAgentFingerprint, oldRunner = old.runner as unknown as EvidenceEngine
  await writeFile(join(paths.home, 'openclaude.json'), JSON.stringify({...config, defaults: {...config.defaults, permissionMode: 'bypassPermissions'}}))
  if (failure === 'construct') failNextConstruction = true
  else oldRunner.failShutdown = true
  await assert.rejects(sm.submit(old, 'must not execute', () => {}), /fixture (constructor|shutdown) failure/)
  assert.equal(executed.length, 1)
  assert.equal(sm.getByKey(key), old)
  assert.equal(old._identityAgentFingerprint, oldFingerprint)
  assert.equal(old.runner, oldRunner)
  assert.equal(old._replacing, false)
  oldRunner.failShutdown = false
  await sm.submit(old, 'safe retry', () => {})
  assert.equal(executed.length, 2)
  assert.notEqual(old.runner, oldRunner)
  assert.equal((old.runner as unknown as EvidenceEngine).opts.permissionMode, 'bypassPermissions')
  assert.notEqual(old._identityAgentFingerprint, oldFingerprint)
})

for (const resume of [false, true]) test(`identity runner refresh restores historical input without replaying a valid native resume (${resume})`, async () => {
  coldNativeFixture = true
  const sm = manager(), peer = `history-refresh-${resume}`, key = `agent:old-fixture:webchat:dm:${peer}`
  const now = Date.now(), marker = 'HISTORY_EVIDENCE_A4_KEEP_ME'
  await upsertClientSession({
    id: peer, userId: '3', agentId: profile.legacyAgentId, title: 'fixture', pinned: false,
    createdAt: now, lastAt: now, updatedAt: now,
    messages: [{id: 'u-history-1', role: 'user', text: marker, ts: now}],
  })
  const before = JSON.stringify((await getClientSession(peer, '3'))?.messages)
  assert.match(JSON.stringify(await getEngineContextMessages(peer, '3')), /HISTORY_EVIDENCE_A4_KEEP_ME/)
  const session = await sm.getOrCreate({sessionKey: key, agent: agents[0], channel: 'webchat', peerId: peer, userId: '3'})
  await sm.submit(session, 'first execution', () => {})
  assert.equal(executed.length, 1)
  assert.match(String(executed[0].input), /HISTORY_EVIDENCE_A4_KEEP_ME/)
  assert.equal(session._historicalContextInjected, true, 'production path set history cache')
  const oldRunner = session.runner
  const nativeId = '11111111-1111-4111-8111-111111111179'
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(home, `native-history-${resume}`)
  try {
    const artifacts = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture')
    await mkdir(artifacts, {recursive: true})
    if (resume) {
      await writeFile(join(artifacts, nativeId + '.jsonl'), JSON.stringify({type: 'user', message: {role: 'user', content: marker}}) + '\n')
      oldRunner.emit('session_id', nativeId)
      await sm.awaitResumeMapFlush()
    }
    await writeFile(join(paths.home, 'openclaude.json'), JSON.stringify({...config, defaults: {...config.defaults, permissionMode: 'bypassPermissions'}}))
    await sm.submit(session, 'second execution on fresh runner', () => {})
    assert.equal(executed.length, 2)
    assert.equal(sm.getByKey(key), session)
    assert.notEqual(session.runner, oldRunner)
    if (resume) {
      assert.equal((session.runner as unknown as EvidenceEngine).opts.resumeSessionId, nativeId, 'real artifact resolver retained native resume')
      assert.equal(String(executed[1].input), 'second execution on fresh runner', 'native context needs no duplicate historical injection')
    } else {
      assert.equal(session.runner.nativeSessionId, null)
      assert.match(String(executed[1].input), /HISTORY_EVIDENCE_A4_KEEP_ME/)
    }
    assert.equal(JSON.stringify((await getClientSession(peer, '3'))?.messages), before, 'stored historical messages remain byte-identical')
  } finally {
    await sm.awaitResumeMapFlush()
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
})
