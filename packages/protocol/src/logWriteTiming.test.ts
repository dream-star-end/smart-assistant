import test from 'node:test'
import assert from 'node:assert/strict'
import { measureLogWrite, takeLogWriteTimingSnapshot } from './logWriteTiming.js'
test('write counters include slow/failed calls, retain no content, and reset atomically', () => {
  takeLogWriteTimingSnapshot()
  const clock = [10, 12, 20, 35]
  const now = () => clock.shift()!
  measureLogWrite(() => {}, 8, now)
  assert.throws(() => measureLogWrite(() => { throw Error('PRIVATE') }, 5, now), /PRIVATE/)
  assert.deepEqual(takeLogWriteTimingSnapshot(), { writeCalls: 2, writeBytes: 13,
    writeTotalMs: 17, writeMaxMs: 15, slowWriteCalls: 1, failedWriteCalls: 1 })
  assert.deepEqual(Object.values(takeLogWriteTimingSnapshot()), [0, 0, 0, 0, 0, 0])
})
