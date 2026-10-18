import test from 'node:test'
import assert from 'node:assert/strict'
import { measureLogWrite, takeLogWriteTimingSnapshot } from '@openclaude/protocol'
import { reportLogTiming, startLogTimingReporter } from '../logging/logTimingReporter.js'
import { createLogger } from '../logging/logger.js'
test('reporting is one numeric summary without recursive writes; its write is counted next window', () => {
  takeLogWriteTimingSnapshot()
  const records: unknown[] = []
  let resets = 0
  const histogram = { count: 3, max: 4e6, percentile: () => 2e6, reset: () => { resets++ } }
  reportLogTiming({ info: (kind, fields) => {
    assert.equal(kind, 'log_io_timing')
    records.push(fields)
    measureLogWrite(() => {}, 20, () => 1)
  } }, histogram)
  assert.equal(records.length, 1)
  assert.equal(resets, 1)
  assert.equal((records[0] as Record<string, unknown>).eventLoopP99Ms, 2)
  assert.equal(takeLogWriteTimingSnapshot().writeCalls, 1)
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|prompt|token|content/)
})
test('duplicate installation shares one reporter and stop is idempotent', () => {
  const log = createLogger({ out: () => {} })
  const stop1 = startLogTimingReporter(log)
  const stop2 = startLogTimingReporter(log)
  stop1(); stop1(); stop2(); stop2()
})
