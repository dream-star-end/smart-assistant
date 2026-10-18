import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentSession } from '../sessionTypes.js'
import { reserveUnusedPreheat, armUnusedPreheat, consumeUnusedPreheat, clearUnusedPreheats } from '../speculativePreheat.js'
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
function fixture() {
  let stops = 0
  const host = { sessions: new Map<string, AgentSession>(), _promptQueueHolds: () => false }
  const make = (key: string) => {
    const s = { sessionKey: key, lock: Promise.resolve(), runner: { shutdown: async () => { stops++ } } } as unknown as AgentSession
    host.sessions.set(key, s)
    return s
  }
  return { host, a: make('a'), b: make('b'), stops: () => stops }
}
test('only one unused runner resides; TTL releases its capacity and process', async () => {
  const f = fixture()
  assert.equal(reserveUnusedPreheat(f.host, f.a), 'reserved')
  assert.equal(reserveUnusedPreheat(f.host, f.a), 'already_running')
  assert.equal(reserveUnusedPreheat(f.host, f.b), 'skipped_cap')
  armUnusedPreheat(f.host, f.a, 5)
  await delay(30)
  assert.equal(f.stops(), 1)
  assert.equal(reserveUnusedPreheat(f.host, f.b), 'reserved')
  clearUnusedPreheats(f.host)
})
test('real turn claiming an unused runner prevents TTL shutdown', async () => {
  const f = fixture()
  reserveUnusedPreheat(f.host, f.a)
  armUnusedPreheat(f.host, f.a, 5)
  f.a._activeTurnCount = 1
  consumeUnusedPreheat(f.host, f.a)
  await delay(30)
  assert.equal(f.stops(), 0)
  assert.equal(reserveUnusedPreheat(f.host, f.b), 'reserved')
  clearUnusedPreheats(f.host)
})
test('TTL queued behind a lock rechecks ownership after an accepted turn', async () => {
  const f = fixture()
  let unlock = () => {}
  f.a.lock = new Promise<void>(r => { unlock = r })
  reserveUnusedPreheat(f.host, f.a)
  armUnusedPreheat(f.host, f.a, 1)
  await delay(15)
  f.a._activeTurnCount = 1
  consumeUnusedPreheat(f.host, f.a)
  unlock()
  await f.a.lock
  assert.equal(f.stops(), 0)
  clearUnusedPreheats(f.host)
})

test('cancelled admission keeps its unused capacity until TTL cleanup', async () => {
  const f = fixture()
  let release = () => {}
  f.a.lock = new Promise<void>(r => { release = r })
  f.a._activeTurnCount = 1
  reserveUnusedPreheat(f.host, f.a)
  armUnusedPreheat(f.host, f.a, 1)
  await delay(15)
  assert.equal(reserveUnusedPreheat(f.host, f.b), 'skipped_cap')
  // Stop/permission failure returns before runner.submitTurn.
  f.a._activeTurnCount = 0
  release()
  await f.a.lock
  assert.equal(f.stops(), 1)
  assert.equal(reserveUnusedPreheat(f.host, f.b), 'reserved')
  clearUnusedPreheats(f.host)
})

test('failed TTL shutdown retains capacity rather than allowing more unused runners', async () => {
  const f = fixture()
  f.a.runner.shutdown = async () => { throw Error('not closed') }
  reserveUnusedPreheat(f.host, f.a)
  armUnusedPreheat(f.host, f.a, 1)
  await delay(30)
  assert.equal(reserveUnusedPreheat(f.host, f.b), 'skipped_cap')
  clearUnusedPreheats(f.host)
})
