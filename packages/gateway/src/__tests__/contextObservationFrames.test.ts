import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Value } from '@sinclair/typebox/value'
import { AnyFrame, type OutboundMessage } from '@openclaude/protocol'
import { deliver, type WsConnectionHost } from '../wsConnection.js'
import { OutboundRingBuffer } from '../outboundRing.js'
import type { ChannelAdapter } from '@openclaude/plugin-sdk'
import { buildContextObservationFrame } from '../contextObservationFrames.js'

const out: OutboundMessage & { _userId?: string } = { type: 'outbound.message', sessionKey: 's', channel: 'webchat', peer: { id: 'p', kind: 'dm' }, blocks: [], isFinal: false, _userId: 'tenant-1', traceId: 'trace123456789012' }

test('context observations retain tenant and turn routing', () => {
  const pressure = buildContextObservationFrame(out, 'main', { kind: 'context_pressure', pressure: { engine: 'antigravity', scope: 'launch_prompt', dimension: 'transport_bytes', level: 'critical', usedRatio: 1.5 } })
  const compacted = buildContextObservationFrame(out, 'main', { kind: 'context_compacted', compaction: { engine: 'antigravity', scope: 'launch_prompt', strategy: 'history_suffix', beforeBytes: 500000, afterBytes: 250000, droppedEntries: 3 } })
  for (const frame of [pressure, compacted]) {
    assert.equal(frame._userId, 'tenant-1')
    assert.equal(frame.traceId, out.traceId)
    assert.equal(frame.sessionKey, 's')
    assert.equal(frame.agentId, 'main')
    assert.ok(Value.Check(AnyFrame, frame))
    assert.ok(!('blocks' in frame))
  }
})


test('delivery strips private routing, skips channel adapters, and retains the completion frame for replay', () => {
  const ring = new OutboundRingBuffer()
  // Start at a nonzero cursor; zero intentionally requests cold reconciliation.
  const cursor = ring.nextSeq('s')
  let channelCalls = 0
  const adapter = { send: async () => { channelCalls++ } } as unknown as ChannelAdapter
  const sent: string[] = []
  const host = {
    _outboundRing: ring,
    _recordRingEvictions: () => {},
    clientsByPeer: { get: (key: string) => {
      assert.ok(key.includes('tenant-1'))
      return new Set([{ send: (data: string) => sent.push(data) }])
    } },
  } as unknown as WsConnectionHost
  const event = { kind: 'context_compacted' as const, compaction: {
    engine: 'antigravity', scope: 'launch_prompt' as const, strategy: 'file_reference' as const,
    beforeBytes: 900000, afterBytes: 900, droppedEntries: 0,
  } }
  deliver.call(host, buildContextObservationFrame(out, 'main', event), adapter)
  assert.equal(channelCalls, 0)
  assert.equal(sent.length, 1)
  const frame = JSON.parse(sent[0]!)
  assert.equal(frame._userId, undefined)
  assert.equal(frame.frameSeq, cursor + 1)
  const replay = ring.peekReplay('s', cursor, Date.now())
  assert.ok(replay.ok)
  assert.deepEqual(replay.sent.map((f) => f.data), sent)
})
