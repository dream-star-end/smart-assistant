import { createServer } from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'
import { preheatRunner, type SessionLifecycleHost } from '../sessionLifecycle.js'
import { clearUnusedPreheats } from '../speculativePreheat.js'
import type { AgentSession } from '../sessionTypes.js'
const preparation = { model: 'gpt-6.1-sol', codexRoute: { modelProvider: 'fixture', baseUrl: 'http://127.0.0.1:9' } }
function fixture() {
  const events: string[] = []
  const runner = { engineId: 'codex', model: 'gpt-6.1-sol', isRunning: false,
    setCodexRoute: () => events.push('route'), preheat: async () => { events.push('preheat') }, shutdown: async () => {} }
  const session = { sessionKey: 'fixture', runner, lock: Promise.resolve() } as unknown as AgentSession
  const host = { sessions: new Map([['fixture', session]]), _preheatActive: 0, _preheatInFlight: new Map(),
    _promptQueueHolds: () => false } as unknown as SessionLifecycleHost
  return { host, session, runner, events }
}
test('route binding is inside the session lock and a changed model cancels speculative work', async () => {
  const f = fixture()
  let unlock = () => {}
  f.session.lock = new Promise<void>(r => { unlock = r })
  const work = preheatRunner.call(f.host, f.session, preparation)
  await Promise.resolve()
  assert.deepEqual(f.events, [])
  f.runner.model = 'gpt-6-luna'
  unlock()
  assert.equal(await work, 'skipped_busy')
  assert.deepEqual(f.events, [])
  clearUnusedPreheats(f.host)
})
test('matching model binds route immediately before initialization; a running engine stays untouched', async () => {
  const f = fixture()
  assert.equal(await preheatRunner.call(f.host, f.session, preparation), 'started')
  assert.deepEqual(f.events, ['route', 'preheat'])
  clearUnusedPreheats(f.host)
  f.runner.isRunning = true
  f.events.length = 0
  assert.equal(await preheatRunner.call(f.host, f.session, preparation), 'already_running')
  assert.deepEqual(f.events, [])
})

test('effective effort mismatch under lock skips without changing the runner', async () => {
  const f = fixture()
  Object.assign(f.runner, { effortLevel: 'medium' })
  assert.equal(await preheatRunner.call(f.host, f.session, { ...preparation, effortLevel: 'high' }), 'skipped_busy')
  assert.deepEqual(f.events, [])
  clearUnusedPreheats(f.host)
  assert.equal(await preheatRunner.call(f.host, f.session, { ...preparation, effortLevel: 'medium' }), 'started')
  clearUnusedPreheats(f.host)
})

test('destroying a session during fresh privacy cancels speculative preheat', async () => {
  const f = fixture()
  const { promptPrivacyFingerprint } = await import('../promptPrivacyPolicy.js')
  Object.assign(f.runner, { promptPolicyFingerprint: promptPrivacyFingerprint({ schemaVersion: 1, profile: null }, undefined),
    setPromptPrivacy() {}, clearPromptPrivacy() {}, assertPromptPrivacyStopped() {} })
  const priorUrl = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  const priorToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'synthetic-fixture-only'
  let respond!: () => void
  let enter!: () => void
  const reading = new Promise<void>(resolve => { enter = resolve })
  const server = createServer((_req, res) => {
    respond = () => res.end(JSON.stringify({ slots: [], promptPolicy: { schemaVersion: 1, profile: null } }))
    enter()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const work = preheatRunner.call(f.host, f.session, preparation)
    await reading
    f.session._plannedTeardown = 'service_restart'
    await f.runner.shutdown()
    f.host.sessions.delete(f.session.sessionKey)
    respond()
    assert.notEqual(await work, 'started')
    assert.equal(f.events.includes('preheat'), false)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (priorUrl === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_MASTER_BASE_URL'); else process.env.OPENCLAUDE_V3_MASTER_BASE_URL = priorUrl
    if (priorToken === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_CONTAINER_TOKEN'); else process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = priorToken
    clearUnusedPreheats(f.host)
  }
})
