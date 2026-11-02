import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { EngineCreateOpts } from '../engine/registry.js'
import type { SubprocessRunner } from '../subprocessRunner.js'

const home = await mkdtemp(join(tmpdir(), 'cc5-backend-session-'))
process.env.OPENCLAUDE_HOME = home
Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')
Reflect.deleteProperty(process.env, 'OC_MODEL_AUTHORITY')
Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_MASTER_BASE_URL')
Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_CONTAINER_TOKEN')
const { closeSessionsDb } = await import('@openclaude/storage')
const { SessionManager } = await import('../sessionManager.js')
const { ResumeStore } = await import('../resumeStore.js')
const { CcbAdapter } = await import('../engine/ccbAdapter.js')
const { registerEngine } = await import('../engine/registry.js')
const { MinimalPrivacyRunner } = await import('./fixtures/minimalPrivacyRunner.js')
const { readIdleCandidate } = await import('../boxIdleCompact.js')
const { cc5ResumeId } = await import('../engine/cc5ResumeId.js')
const { CC5_NATIVE_MODEL } = await import('@openclaude/protocol')

after(async () => { await closeSessionsDb(); await rm(home, { recursive: true, force: true }) })

class FixtureRunner extends MinimalPrivacyRunner {
  sessionId: string | null = null
  isRunning = false
  lastActivityAt = Date.now()
  shutdowns = 0
  model: string | undefined
  constructor(opts: EngineCreateOpts) { super(); this.model = opts.model }
  async start() { throw new Error('NO_MODEL_OR_PROCESS_ALLOWED') }
  async shutdown() { this.shutdowns++; this.isRunning = false }
  clearSessionId() { this.sessionId = null }
  setModel(model: string | undefined) { this.model = model }
  setResumeSessionId(id: string) { this.sessionId = id }
  async waitForOutputDrain() {}
  interrupt() { return false }
}
const runners = new WeakMap<object, FixtureRunner>()
let constructions = 0
registerEngine('ccb', (opts) => {
  constructions++
  const runner = new FixtureRunner(opts)
  const port = opts.executionBackend ? {
    executionBackend: opts.executionBackend, canonicalModel: CC5_NATIVE_MODEL,
    bindingId: opts.executionBackend.operationId,
    async prepare() { throw new Error('NO_MODEL_OR_PROCESS_ALLOWED') },
    async admit() { throw new Error('NO_MODEL_OR_PROCESS_ALLOWED') },
    async renew() {}, async close() {},
  } : undefined
  const adapter = new CcbAdapter({ ...opts, cc5BridgePort: port }, runner as unknown as SubprocessRunner)
  runners.set(adapter, runner)
  return adapter
})
const config = { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
  auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: '' },
  defaults: { model: CC5_NATIVE_MODEL },
} as unknown as OpenClaudeConfig
let serial = 0
function fixture() {
  const sm = new SessionManager(config)
  const m = sm as any
  m._saveResumeMap = () => {}
  m._resumeMap.clear(); m._resumeMapProvider.clear(); m._resumeMapHistory.clear()
  const peer = `cc5_native_${++serial}`
  const sessionKey = `agent:main:webchat:dm:${peer}`
  const backend = { kind: 'cc5-interactive-v1' as const, sessionKey, operationId: randomUUID() }
  const base = { sessionKey, peerId: peer, channel: 'webchat', agent: { id: 'main', cwd: home },
    model: CC5_NATIVE_MODEL, workspaceCwd: home,
  }
  const local = { ...base, executionAuthority: { engine: 'ccb' as const,
    canonicalModel: CC5_NATIVE_MODEL, source: 'local_catalog' as const } }
  const remote = { ...base, executionAuthority: { engine: 'ccb' as const,
    canonicalModel: CC5_NATIVE_MODEL, source: 'bridge_signed' as const, executionBackend: backend } }
  const authority = { authorityEnvelope: 'synthetic-only', leaseEnvelope: 'synthetic-only',
    executionDescriptor: { canonicalModel: CC5_NATIVE_MODEL, executionBackend: backend,
      contextOwner: 'box-native-v1' as const, contextWindow: 200000, capabilityZero: true,
      supportsThinking: true, supportsVision: false, supportedEfforts: [] } }
  return { sm, m, backend, local, remote, authority }
}

test('same Sonnet/ccb keeps ordinary path and replaces only an empty preheated runner for the signed backend', async () => {
  const f = fixture()
  const local = await f.sm.getOrCreate(f.local)
  const remote = await f.sm.getOrCreate(f.remote)
  assert.notEqual(remote, local)
  assert.equal(runners.get(local.runner)!.shutdowns, 1)
  assert.deepEqual(remote.runner.executionBackend, f.backend)
  assert.equal(remote.providerTag, 'ccb')
  assert.equal(remote.model, CC5_NATIVE_MODEL)
  assert.equal(await f.sm.getOrCreate(f.remote), remote)
  await assert.rejects(f.sm.getOrCreate(f.local), /BACKEND_SCOPE_CHANGED/)
  await assert.rejects(f.sm.getOrCreate({ ...f.remote, executionAuthority: {
    ...f.remote.executionAuthority, executionBackend: { ...f.backend, operationId: randomUUID() },
  } }), /BACKEND_SCOPE_CHANGED/)
})

test('history and durable resume cannot be silently moved to the remote backend', async () => {
  for (const kind of ['turn', 'resume'] as const) {
    const f = fixture()
    const local = await f.sm.getOrCreate(f.local)
    if (kind === 'turn') local.turns = 1
    else f.m._resumeMap.set(f.local.sessionKey, randomUUID())
    const before = constructions
    await assert.rejects(f.sm.getOrCreate(f.remote), /REQUIRES_NEW_SESSION/)
    assert.equal(constructions, before)
    assert.equal(runners.get(local.runner)!.shutdowns, 0)
  }
})

test('local catalog and a different chat cannot grant the remote backend', async () => {
  const f = fixture()
  const before = constructions
  await assert.rejects(f.sm.getOrCreate({ ...f.remote, executionAuthority: {
    ...f.remote.executionAuthority, source: 'local_catalog',
  } }), /BACKEND_SCOPE_INVALID/)
  await assert.rejects(f.sm.getOrCreate({ ...f.remote, sessionKey: `${f.remote.sessionKey}other` }), /BACKEND_SCOPE_INVALID/)
  assert.equal(constructions, before)
})

test('direct warm submit cannot drop the signed backend or substitute another operation', async () => {
  const f = fixture()
  const session = await f.sm.getOrCreate(f.remote)
  let calls = 0
  f.m.runOneTurnWithRetry = async () => { calls++ }
  await assert.rejects(f.sm.submit(session, 'synthetic', () => {}), /BACKEND_SCOPE_CHANGED/)
  await assert.rejects(f.sm.submit(session, 'synthetic', () => {}, undefined, undefined,
    undefined, undefined, undefined, { modelAuthority: { ...f.authority, executionDescriptor: {
      ...f.authority.executionDescriptor, executionBackend: { ...f.backend, operationId: randomUUID() },
    } } }), /BACKEND_SCOPE_CHANGED/)
  assert.equal(calls, 0)
})

test('native backend does not enter automatic retry or Box idle follow-ups under the normal Sonnet model', async () => {
  const f = fixture()
  const session = await f.sm.getOrCreate(f.remote)
  let attempts = 0
  f.m._runOneTurn = async () => { attempts++; throw new Error('PHANTOM_TURN') }
  await assert.rejects(f.m.runOneTurnWithRetry(session, 'synthetic', () => {}, undefined,
    undefined, undefined, f.authority), /PHANTOM_TURN/)
  assert.equal(attempts, 1)

  const next = fixture()
  const nextSession = await next.sm.getOrCreate(next.remote)
  next.m.runOneTurnWithRetry = async () => {
    const id = cc5ResumeId(next.backend.operationId, randomUUID())
    runners.get(nextSession.runner)!.sessionId = id
    nextSession.runner.emit('session_id', id)
  }
  await next.sm.submit(nextSession, 'synthetic', () => {}, undefined, undefined,
    undefined, undefined, undefined, { modelAuthority: next.authority })
  assert.equal(readIdleCandidate(home, next.remote.sessionKey), undefined)
})

test('a local turn completing while the new-backend replacement waits cannot be moved remotely', async () => {
  const f = fixture()
  const local = await f.sm.getOrCreate(f.local)
  let release!: () => void
  local.lock = new Promise<void>((resolve) => { release = resolve })
  const pending = f.sm.getOrCreate(f.remote)
  const observed = pending.then(() => undefined, error => error)
  try {
    const deadline = Date.now() + 3000
    while (!local._replacing && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    assert.equal(local._replacing, true, 'the real replacement path must be awaiting the local turn')
    local.turns = 1
    runners.get(local.runner)!.sessionId = randomUUID()
    release()
    assert.match(String((await observed)?.message), /REQUIRES_NEW_SESSION/)
    assert.equal(runners.get(local.runner)!.shutdowns, 0)
    assert.equal(f.m.sessions.get(local.sessionKey), local)
    assert.equal(local._replacing, false)
  } finally { release() }
})

test('a restarted manager refuses automatic local Sonnet replay of a persisted remote ID', async () => {
  const f = fixture()
  const file = join(home, 'restart-scope-resume-map.json')
  const store = new ResumeStore(file)
  const remoteId = cc5ResumeId(f.backend.operationId, randomUUID())
  store.ids.set(f.remote.sessionKey, remoteId)
  store.timestamps.set(f.remote.sessionKey, Date.now())
  store.provider.set(f.remote.sessionKey, 'ccb')
  store.persist(store.serialize([]))
  await store.flush()
  const restarted = new SessionManager(config)
  const m = restarted as any
  m.resumeMapPath = file
  m._loadResumeMap()
  m._saveResumeMap = () => {}
  assert.equal(m._resumeMap.get(f.remote.sessionKey), remoteId)
  const before = constructions
  await assert.rejects(restarted.getOrCreate(f.local), /NEW_CHAT_REQUIRED/)
  assert.equal(constructions, before)
  const other = await restarted.getOrCreate({ ...f.local, model: 'glm-5.3-zai', executionAuthority: {
    engine: 'ccb', canonicalModel: 'glm-5.3-zai', source: 'local_catalog',
  } })
  assert.equal(other.runner.executionBackend, undefined)
  assert.equal(other.runner.nativeSessionId, null)
})
