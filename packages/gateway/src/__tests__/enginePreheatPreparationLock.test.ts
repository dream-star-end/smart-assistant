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
