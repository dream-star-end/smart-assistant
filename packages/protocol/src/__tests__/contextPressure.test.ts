import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Value } from '@sinclair/typebox/value'
import { AnyFrame, SessionContextPressure, SysContextCompacted } from '../frames.js'
import { GatewayEvent, GATEWAY_EVENT_TYPES } from '../events.js'

const routing = { sessionKey: 's', channel: 'webchat', peer: { id: 'p', kind: 'dm' }, agentId: 'main' }
const pressure = { engine: 'antigravity', scope: 'launch_prompt', dimension: 'transport_bytes', level: 'critical', usedRatio: 2.5 }

test('pressure and completed transformations are additive frames with distinct meanings', () => {
  const frame = { ...routing, ...pressure, type: 'session.context_pressure' }
  assert.ok(Value.Check(SessionContextPressure, frame))
  assert.ok(Value.Check(AnyFrame, frame))
  for (const usedRatio of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(Value.Check(SessionContextPressure, { ...frame, usedRatio }), false)
  assert.equal(Value.Check(SessionContextPressure, { ...frame, scope: 'unlimited' }), false)
  const done = { ...routing, type: 'sys.context_compacted', engine: 'antigravity', scope: 'launch_prompt', strategy: 'file_reference', beforeBytes: 999999, afterBytes: 800, droppedEntries: 0 }
  assert.ok(Value.Check(SysContextCompacted, done))
  assert.ok(Value.Check(AnyFrame, done))
  assert.equal(Value.Check(SysContextCompacted, { ...done, droppedEntries: -1 }), false)
  assert.ok(Value.Check(AnyFrame, { ...routing, type: 'sys.context_rebuilt', messageCount: 20 }))
})

test('pressure is registered in the protocol event catalog', () => {
  assert.ok(GATEWAY_EVENT_TYPES.includes('session.context_pressure'))
  assert.ok(Value.Check(GatewayEvent, { ...pressure, type: 'session.context_pressure', sessionKey: 's', agentId: 'main', id: 'event-id', timestamp: 1, schemaVersion: 1 }))
})
