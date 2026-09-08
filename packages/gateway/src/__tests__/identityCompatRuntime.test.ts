import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'

const home = await mkdtemp(join(tmpdir(), 'ocv5-179-runtime-'))
process.env.OPENCLAUDE_HOME = home
for (const key of ['OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN', 'OC_USER_ID', 'OC_RUNTIME_CHANNEL', 'OC_MODEL_AUTHORITY']) delete process.env[key]
const { SessionManager } = await import('../sessionManager.js')
const { Gateway } = await import('../server.js')
const { registerEngine } = await import('../engine/registry.js')
const { setV3MasterSinkSingleton } = await import('../v3MasterSink.js')
const { paths, writeAgentsConfig, identityCompatEnvironment } = await import('@openclaude/storage')
const { CronScheduler } = await import('../cron.js')
const { DelegateResumeRegistry } = await import('../delegateResume.js')
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
let executed: { agent: string; key: string; soul: string; env: Record<string,string>; native: string }[] = []
class EvidenceEngine extends EventEmitter {
  engineId = 'ccb'; model = 'glm-5.2'; isRunning = false; lastActivityAt = Date.now(); nativeSessionId = 'unchanged-native'; sessionId = 'unchanged-native'; shutdowns = 0
  capabilities = { billingMode: 'proxy', supportsEffort: true, resumeKind: 'ccb-session', needsServerRequestId: false, historyMode: 'native-resume', permissionModel: 'native', emitsCallUsage: true, emitsToolInputDeltas: true, supportsNativeCompact: true, multimodalInput: 'native' }
  constructor(readonly opts: any) { super() }
  async start() { this.isRunning = true }
  async shutdown() { this.shutdowns++; this.isRunning = false }
  setTraceId() {} setEffortLevel() {} setModel(model: string) { this.model = model } setToolsets() {} interrupt() { return true }
  clearSessionId() {} async waitForOutputDrain() {}
  submitTurn(params: any) {
    const soul = this.opts.identityCompat?.assets?.buildSoul().content ?? 'unregistered'
    executed.push({ agent: this.opts.agentId, key: this.opts.sessionKey, soul, env: identityCompatEnvironment(this.opts.identityCompat), native: this.nativeSessionId })
    params.onEvent({ kind: 'block', block: { kind: 'text', text: soul, blockId: 'answer' } })
    const summary = { usage: { cost: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 2 }, assistantText: soul, thinkingText: '', assistantSegments: [{ text: soul }], thinkingSegments: [], tools: [], runtimeEvents: [], stopReason: 'end_turn', numTurns: 1, isError: false, staleResumeId: false, phantomSignals: { apiState: 'skipped', skipReason: 'test-engine' } }
    return { submitted: Promise.resolve(), summary: Promise.resolve(summary), end() {}, getPartialSnapshot: () => ({ assistantText: soul, thinkingText: '', assistantSegments: [], thinkingSegments: [], tools: [], runtimeEvents: [] }), getPhantomSignals: () => summary.phantomSignals, finalized: true, pendingToolCalls: 0 }
  }
}
registerEngine('ccb', (opts) => new EvidenceEngine(opts) as any)
const managers: InstanceType<typeof SessionManager>[] = []
const manager = () => { const sm = new SessionManager(config); managers.push(sm); return sm }
beforeEach(async () => {
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${port}`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'fixture-token'
  process.env.OC_USER_ID = '3'
  projection = { schema: 1, userId: '3', profiles: [{ profile, readiness: 'ready' }] }; status = 200; executed = []; fetches = 0
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
  await writeFile(join(home, 'openclaude.json'), JSON.stringify(config))
  await writeAgentsConfig({ agents, default: profile.legacyAgentId, routes: [] })
  setV3MasterSinkSingleton({ persistOrQueue: async () => ({ ok: true }), attemptOnce: async () => {} } as any)
})
after(async () => { for (const sm of managers) await sm.shutdownAll(); setV3MasterSinkSingleton(null); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }) })

for (const requested of [0, 1]) test(`registered entry ${requested}: canonical execution with original key and both sources`, async () => {
  const sm = manager(); const key = `agent:${agents[requested].id}:cron:dm:existing-job:existing-delivery`
  const session = await sm.getOrCreate({ sessionKey: key, agent: agents[requested], channel: 'cron', peerId: 'existing-job' })
  await sm.submit(session, 'read both manuals', () => {}, undefined, 'glm-5.2')
  assert.equal(session.agentId, profile.canonicalAgentId)
  assert.equal(executed.length, 1)
  assert.equal(executed[0].key, key)
  assert.equal(executed[0].agent, profile.canonicalAgentId)
  assert.match(executed[0].soul, /LOCAL MANUAL v1/); assert.match(executed[0].soul, /MARKET PERSONA/)
  assert.deepEqual(JSON.parse(executed[0].env.OC_IDENTITY_COMPAT_PROFILE), profile)
  assert.ok(fetches >= 2, 'fresh admission is not a display TTL')
})

test('warm next turn rechecks readiness and manual; native and logical key survive', async () => {
  const sm = manager(); const key = 'agent:old-fixture:webchat:dm:old-session'
  const session = await sm.getOrCreate({ sessionKey: key, agent: agents[0], channel: 'webchat', peerId: 'old-session' })
  await sm.submit(session, 'first', () => {})
  await writeFile(paths.agentClaudeMd(profile.legacyAgentId), 'LOCAL MANUAL v2')
  await sm.submit(session, 'second', () => {})
  assert.equal(executed.length, 2); assert.match(executed[1].soul, /LOCAL MANUAL v2/)
  assert.equal(executed[1].native, executed[0].native); assert.equal(executed[1].key, key)
  assert.ok((session.runner as any).shutdowns >= 1)
  assert.equal(await readFile(paths.agentClaudeMd(profile.canonicalAgentId), 'utf8'), 'MARKET PERSONA')
  projection.profiles[0].readiness = 'unavailable'
  await assert.rejects(sm.submit(session, 'must not run', () => {}, undefined, 'glm-5.2'), /not ready/)
  assert.equal(executed.length, 2)
})

for (const failure of ['unavailable', 'http', 'missing', 'wrong-user']) test(`new and warm executions fail closed: ${failure}`, async () => {
  const sm = manager(); const session = await sm.getOrCreate({ sessionKey: `agent:old-fixture:webchat:dm:${failure}`, agent: agents[0] })
  if (failure === 'unavailable') projection.profiles[0].readiness = 'unavailable'
  if (failure === 'http') status = 503
  if (failure === 'missing') projection = undefined
  if (failure === 'wrong-user') projection.userId = '4'
  for (const agent of agents) await assert.rejects(sm.getOrCreate({ sessionKey: `agent:${agent.id}:webchat:dm:blocked`, agent, model: 'glm-5.2' }), /authority|not ready/)
  await assert.rejects(sm.submit(session, 'blocked', () => {}, undefined, 'glm-5.2'), /authority|not ready/)
  assert.equal(executed.length, 0)
})

test('explicit empty registration preserves ordinary local agent', async () => {
  projection.profiles = []
  const sm = manager(); const session = await sm.getOrCreate({ sessionKey: 'agent:old-fixture:webchat:dm:plain', agent: agents[0] })
  await sm.submit(session, 'ordinary', () => {})
  assert.equal(executed[0].agent, profile.legacyAgentId); assert.equal(executed[0].env.OC_IDENTITY_COMPAT_PROFILE, '')
})

test('legacy resume accepts registered semantic pair only after exact parent validation, including replay', () => {
  const registry = new DelegateResumeRegistry()
  const first = registry.preflight({ parentSessionKey: 'original-parent', targetAgentId: profile.legacyAgentId, sourceAgent: 'main' })
  assert.equal(first.ok, true); if (!first.ok) return
  registry.release(first.sessionKey)
  const resumed = registry.preflight({ resumeSessionKey: first.sessionKey, parentSessionKey: 'original-parent', targetAgentId: profile.canonicalAgentId, sourceAgent: 'main', idempotencyKey: 'same', identityProjection: projection })
  assert.equal(resumed.ok, true); assert.equal(resumed.ok && resumed.sessionKey, first.sessionKey)
  const wrong = registry.preflight({ resumeSessionKey: first.sessionKey, parentSessionKey: 'wrong-parent', targetAgentId: profile.canonicalAgentId, sourceAgent: 'main', idempotencyKey: 'same', identityProjection: projection })
  assert.equal(wrong.ok, false)
})

test('management keeps manual editable, refuses fake execution saves, publishes explicit projection', async () => {
  const gateway: any = Object.create(Gateway.prototype)
  gateway.deps = { config }; gateway.router = { reload() {} }
  gateway._getAgentsConfigUserView = async () => ({ agents, default: profile.legacyAgentId, routes: [] })
  let body: any = {}; let result: any
  gateway.readJsonBody = async () => body
  gateway.sendJson = (_res: any, status: number, body: unknown) => { result = { status, body } }
  gateway.sendError = (_res: any, status: number, error: string) => { result = { status, body: { error } } }
  await gateway.handleAgentsCollection({ method: 'GET' }, {})
  assert.deepEqual(result.body.identityCompat, projection)
  body = { model: 'fake', persona: 'fake' }
  await gateway.handleAgentItem({ method: 'PUT' }, {}, profile.legacyAgentId)
  assert.equal(result.status, 409); assert.equal(result.body.code, 'IDENTITY_COMPAT_MANAGED')
  body = { text: 'USER EDITED MANUAL' }
  await gateway.handlePersona({ method: 'PUT' }, {}, profile.legacyAgentId)
  assert.equal(result.status, 200)
  assert.equal(await readFile(paths.agentClaudeMd(profile.legacyAgentId), 'utf8'), body.text)
  assert.equal(await readFile(paths.agentClaudeMd(profile.canonicalAgentId), 'utf8'), 'MARKET PERSONA')
})


test('fresh locked gate rejects direct warm submit after preflight readiness was revoked', async () => {
  const sm = manager(); const session = await sm.getOrCreate({ sessionKey: 'agent:old-fixture:webchat:dm:lock-gate', agent: agents[0] })
  // Deliberately bypass getOrCreate on this subsequent call; readiness must be
  // checked by submit itself, not merely by the normal server preflight path.
  session._identityCreationOpts = undefined
  projection.profiles[0].readiness = 'unavailable'
  await assert.rejects(sm.submit(session, 'do not execute', () => {}, undefined, 'glm-5.2'), /not ready/)
  assert.equal(executed.length, 0)
})

test('self-delegation cannot be bypassed by requesting the registered other ID', async () => {
  const gateway: any = Object.create(Gateway.prototype)
  gateway.deps = { config }; gateway.getUserId = () => '3'
  gateway.readBody = async () => JSON.stringify({ goal: 'must reject before enqueue', sourceAgent: profile.canonicalAgentId })
  let result: any
  gateway.sendError = (_res: any, status: number, error: string) => { result = { status, error } }
  await gateway.handleDelegateTask({ method: 'POST', headers: {} }, {}, profile.legacyAgentId)
  assert.equal(result.status, 400); assert.match(result.error, /allowSelf|自己/)
  assert.equal(executed.length, 0)
})

test('real cron runJob executes canonical but prepared occurrence, callbacks and cleanup retain original key', async () => {
  const sm = manager(); const delivery = { dueMinuteKey: 100, deliveryId: 'old-delivery' }
  const job = { id: 'old-job', schedule: '* * * * *', agent: profile.legacyAgentId, prompt: 'read manuals', deliver: 'local' }
  const key = `agent:${profile.legacyAgentId}:cron:dm:${job.id}:${delivery.deliveryId}`
  const recordFile = join(home, 'old-prepared-occurrence.json')
  await writeFile(recordFile, JSON.stringify({ state: 'prepared', sessionKey: key, claimOwner: profile.legacyAgentId, deliveryId: delivery.deliveryId }))
  const scheduler: any = new CronScheduler(config, sm, async () => {})
  const seen: string[] = []
  const outcome = await scheduler.runJob(job, agents[0], {
    async consumeOccurrence() { const row = JSON.parse(await readFile(recordFile, 'utf8')); seen.push(row.sessionKey); assert.equal(sm.getByKey(row.sessionKey)?.agentId, profile.canonicalAgentId) },
    async markSubmitStarted() { const row = JSON.parse(await readFile(recordFile, 'utf8')); seen.push(row.sessionKey); assert.ok(sm.getByKey(row.sessionKey)); assert.equal(row.claimOwner, profile.legacyAgentId) },
    recordEvent() {}, async stageDelivery() {}, async markCompleted() {}, async markDelivered() {},
  }, delivery)
  assert.ok(['completed', 'silent'].includes(outcome.kind), JSON.stringify(outcome))
  assert.deepEqual(seen, [key, key]); assert.equal(executed.length, 1)
  assert.equal(executed[0].key, key); assert.equal(executed[0].agent, profile.canonicalAgentId)
  assert.equal(sm.getByKey(key), undefined, 'cleanup targets the same original key')
  assert.equal(JSON.parse(await readFile(recordFile, 'utf8')).sessionKey, key)
  assert.equal(job.agent, profile.legacyAgentId)
})


test('old parent progress keeps the original address and rejects wrong user/parent', async () => {
  const sm = manager(); const key = 'agent:old-fixture:webchat:dm:progress-parent'
  const parent = await sm.getOrCreate({ sessionKey: key, agent: agents[0], userId: '3', channel: 'webchat', peerId: 'progress-parent' })
  const gateway: any = Object.create(Gateway.prototype); gateway.sessions = sm
  const route = gateway._resolveDelegateProgressTarget({ parentSessionKey: key, sourceAgent: profile.legacyAgentId })
  assert.deepEqual(route.target, { sessionKey: key, channel: 'webchat', peerId: 'progress-parent', userId: '3' })
  assert.equal(gateway._resolveDelegateProgressTarget({ parentSessionKey: 'wrong-parent', sourceAgent: profile.legacyAgentId }), null)
  parent.userId = '4'
  assert.equal(gateway._resolveDelegateProgressTarget({ parentSessionKey: key, sourceAgent: profile.legacyAgentId }), null)
})
