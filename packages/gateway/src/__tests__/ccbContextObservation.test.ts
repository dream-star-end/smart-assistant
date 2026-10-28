import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Value } from '@sinclair/typebox/value'
import { AnyFrame, type ContextObservation } from '@openclaude/protocol'
import { CcbMessageParser } from '../ccbMessageParser.js'
import { buildContextObservationFrame } from '../contextObservationFrames.js'
import { parseCcbContextObservation } from '../ccbContextObservation.js'
import type { SdkMessage } from '../subprocessRunner.js'
import type { SessionStreamEvent } from '../engine/engineEvents.js'

const pressure: ContextObservation = { kind: 'context_pressure', pressure: {
  engine: 'claude-code', scope: 'native_context', dimension: 'transport_bytes', level: 'critical', usedRatio: 2.5,
} }
const compacted: ContextObservation = { kind: 'context_compacted', compaction: {
  engine: 'claude-code', scope: 'native_context', strategy: 'file_reference', beforeBytes: 25_000_000, afterBytes: 1000, droppedEntries: 0,
} }

test('CCB SDK observations reach existing routed frames without becoming content or billing', () => {
  const events: SessionStreamEvent[] = []
  const parser = new CcbMessageParser({ toolUseIdToName: new Map(), onEvent: e => events.push(e), onFinish: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 } })
  for (const observation of [pressure, compacted]) {
    parser.parse({ type: 'system', subtype: 'context_observation', observation } as unknown as SdkMessage)
  }
  assert.deepEqual(events, [pressure, compacted])
  for (const event of [pressure, compacted]) {
    const frame = buildContextObservationFrame({ type: 'outbound.message', sessionKey: 'same-ui-session', channel: 'webchat', peer: { id: 'p', kind: 'dm' }, blocks: [], isFinal: false, _userId: '3' }, 'main', event)
    assert.equal(frame.sessionKey, 'same-ui-session')
    assert.equal(frame._userId, '3')
    assert.ok(Value.Check(AnyFrame, frame))
    assert.equal('blocks' in frame, false)
  }
})

test('only known CCB scalar measurements are forwarded', () => {
  assert.deepEqual(parseCcbContextObservation({ ...pressure, pressure: { ...pressure.pressure, file: '/private/path', body: 'SECRET' } }), pressure)
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(parseCcbContextObservation({ ...pressure, pressure: { ...pressure.pressure, usedRatio: value } }), null)
  }
  assert.equal(parseCcbContextObservation({ ...pressure, pressure: { ...pressure.pressure, scope: 'launch_prompt' } }), null)
  assert.equal(parseCcbContextObservation({ ...compacted, compaction: { ...compacted.compaction, droppedEntries: 1 } }), null)
  assert.equal(parseCcbContextObservation({ ...compacted, compaction: { ...compacted.compaction, strategy: 'native_summary' } }), null)
})
