import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassiveStageTiming } from '../passiveStageTiming.js'

test('late events retain captured process identity and emit each stage once', () => {
  const identity = { engine: 'ccb', traceId: 'old', generation: 1 }
  const events: unknown[] = []
  let now = 100
  const timer = new PassiveStageTiming(identity, event => events.push(event), () => now)
  identity.traceId = 'new'; identity.generation = 2
  now = 105; timer.once('first_stdout'); timer.once('first_stdout')
  assert.deepEqual(events, [{ engine: 'ccb', traceId: 'old', generation: 1, stage: 'first_stdout', elapsedMs: 5 }])
})

test('a telemetry sink failure never changes the engine control flow', () => {
  const timer = new PassiveStageTiming({ engine: 'grok' }, () => { throw new Error('sink failure') })
  assert.doesNotThrow(() => timer.once('spawned'))
})

test('a retried process has its own generation/timer with the same frozen turn identity', () => {
  const events: unknown[] = []
  let now = 100
  const parent = new PassiveStageTiming({ engine: 'grok', traceId: 'turn', generation: 1 },
    event => events.push(event), () => now)
  now = 200
  const retry = parent.fork(2)
  now = 205; retry.once('spawned')
  now = 210; parent.once('first_text')
  assert.deepEqual(events, [
    { engine: 'grok', traceId: 'turn', generation: 2, stage: 'spawned', elapsedMs: 5 },
    { engine: 'grok', traceId: 'turn', generation: 1, stage: 'first_text', elapsedMs: 110 },
  ])
})
