import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  type HistoryProjection,
  type MessageLike,
  projectClientSessionMessagesForChat,
} from '../sessionsDb.js'

function runtime(
  id: string,
  seq: number,
  tapeId: string,
  event: Record<string, unknown>,
): MessageLike {
  return {
    id,
    role: 'runtime-event',
    text: JSON.stringify(event),
    ts: seq,
    _seq: seq,
    _source: 'server',
    _turnTapeId: tapeId,
    _turnTapeSha256: 'a'.repeat(64),
    _turnTapeExpanded: true,
    _runtimeEvent: event,
  }
}

describe('browser chat history projection', () => {
  test('orders projected history by frozen _orderSeq when a patch made _seq non-chronological', () => {
    const chat = projectClientSessionMessagesForChat([
      { id: 'u1', role: 'user', text: 'one', ts: 100, _seq: 5, _orderSeq: 1 },
      // Duplicate mutable seq is a storage anomaly, but can no longer make
      // presentation order ambiguous because the axes are independent.
      { id: 'u2', role: 'user', text: 'two', ts: 300, _seq: 5, _orderSeq: 3 },
      { id: 'a1', role: 'assistant', text: 'patched', ts: 200, _seq: 13, _orderSeq: 2 },
    ])

    assert.deepEqual(chat.map((row) => row.id), ['u1', 'a1', 'u2'])
  })

  test('20k large hidden runtime rows collapse to one tiny checkpoint', () => {
    const blob = 'x'.repeat(4096)
    const exact = Array.from({ length: 20_000 }, (_, i) =>
      runtime(`raw-${i}`, 7, 'tape-hidden', {
        type: 'stream_event',
        index: i,
        blob,
      }),
    )
    assert.ok(Buffer.byteLength(JSON.stringify(exact)) > 80 * 1024 * 1024)

    const chat = projectClientSessionMessagesForChat(exact)
    assert.equal(chat.length, 1)
    assert.deepEqual(chat[0]!._historyProjection, { kind: 'checkpoint' })
    assert.equal(chat[0]!._seq, 7)
    assert.equal('_runtimeEvent' in chat[0]!, false)
    assert.ok(Buffer.byteLength(JSON.stringify(chat)) < 1024)
  })

  test('20k Bash snapshots coalesce deterministically and cap UTF-8 tail bytes', () => {
    const commonTail = 'y'.repeat(4096)
    const exact = Array.from({ length: 20_000 }, (_, i) =>
      runtime(`tail-${i}`, 9, 'tape-tail', {
        type: 'system',
        subtype: 'bash_output_tail',
        tool_use_id: 'tool-1',
        tail: commonTail,
        total_bytes: i,
        truncated_head: false,
      }),
    )
    exact.push(runtime('tail-equal-later', 9, 'tape-tail', {
      type: 'system',
      subtype: 'bash_output_tail',
      tool_use_id: 'tool-1',
      tail: '😀'.repeat(100_000),
      total_bytes: 19_999,
      truncated_head: false,
    }))
    assert.ok(Buffer.byteLength(JSON.stringify(exact)) > 80 * 1024 * 1024)

    const chat = projectClientSessionMessagesForChat(exact)
    assert.equal(chat.length, 1)
    const patch = chat[0]!._historyProjection as HistoryProjection | undefined
    assert.equal(patch?.kind, 'bash-tail')
    if (patch?.kind !== 'bash-tail') throw new Error('missing bash-tail projection')
    assert.equal(patch.totalBytes, 19_999)
    assert.equal(patch.truncatedHead, true)
    assert.ok(Buffer.byteLength(patch.tail, 'utf8') <= 256 * 1024)
    assert.equal(patch.tail.includes('\uFFFD'), false, 'UTF-8 suffix starts on a code-point boundary')
    assert.equal('_runtimeEvent' in chat[0]!, false)
    assert.ok(Buffer.byteLength(JSON.stringify(chat)) < 300 * 1024)
  })

  test('coalesced-away runtime-only tapes retain stable sequence checkpoints', () => {
    const exact = [
      runtime('old', 10, 'tape-old', {
        type: 'system', subtype: 'bash_output_tail', tool_use_id: 'tool-1',
        tail: 'old', total_bytes: 10,
      }),
      runtime('new', 11, 'tape-new', {
        type: 'system', subtype: 'bash_output_tail', tool_use_id: 'tool-1',
        tail: 'new', total_bytes: 11,
      }),
    ]
    const first = projectClientSessionMessagesForChat(exact)
    const second = projectClientSessionMessagesForChat(exact)
    assert.deepEqual(second, first)
    assert.deepEqual(first.map((m) => m._seq), [10, 11])
    assert.equal((first[0]!._historyProjection as HistoryProjection).kind, 'checkpoint')
    assert.equal((first[1]!._historyProjection as HistoryProjection).kind, 'bash-tail')
  })

  test('tail ids stay collision-free and invalid routing ids become checkpoints', () => {
    const exact = [
      runtime('plain-surrogate-token', 1, 'tape-a', {
        type: 'system', subtype: 'bash_output_tail', tool_use_id: 'tool-uD800',
        tail: 'a', total_bytes: 1,
      }),
      runtime('plain-replacement-token', 2, 'tape-b', {
        type: 'system', subtype: 'bash_output_tail', tool_use_id: 'tool-uFFFD',
        tail: 'b', total_bytes: 2,
      }),
      runtime('numeric-id', 3, 'tape-c', {
        type: 'system', subtype: 'bash_output_tail', tool_use_id: 123,
        tail: 'ignored', total_bytes: 3,
      }),
      runtime('invalid-parent', 4, 'tape-d', {
        type: 'system', subtype: 'bash_output_tail', tool_use_id: 'tool-valid',
        parent_tool_use_id: { nested: true }, tail: 'ignored', total_bytes: 4,
      }),
      runtime('backslash-id', 5, 'tape-e', {
        type: 'system', subtype: 'bash_output_tail', tool_use_id: String.raw`tool-\u0000`,
        tail: 'ignored', total_bytes: 5,
      }),
    ]

    const chat = projectClientSessionMessagesForChat(exact)
    const patches = chat.flatMap((message) => {
      const projection = message._historyProjection as HistoryProjection | undefined
      return projection?.kind === 'bash-tail' ? [projection] : []
    })
    assert.deepEqual(patches.map((patch) => patch.toolUseId).sort(), ['tool-uD800', 'tool-uFFFD'])
    assert.equal(chat.filter((message) =>
      (message._historyProjection as HistoryProjection | undefined)?.kind === 'checkpoint').length, 3)
  })
})
