/**
 * v7 (2026-05-12) — CcbMessageParser messageId stamping.
 *
 * Verifies that the parser, when given canonical assistant/thinking message
 * ids at construction time, stamps every main-agent text/thinking outbound
 * block with that id. Subagent blocks (parentToolUseId set) must NEVER be
 * stamped — they live in childBlocks of the parent Agent card, not as
 * top-level rows.
 *
 * This is the gateway half of the v7 single-id-authority architecture; see
 * /tmp/v7-plan.md for the full design rationale.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbMessageParserMessageId.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CcbMessageParser,
  type SessionStreamEvent,
} from '../ccbMessageParser.js'

interface ParserBag {
  parser: CcbMessageParser
  events: SessionStreamEvent[]
}

function createParser(opts: {
  assistantMessageId?: string
  thinkingMessageId?: string
}): ParserBag {
  const events: SessionStreamEvent[] = []
  const parser = new CcbMessageParser({
    toolUseIdToName: new Map(),
    onEvent: (e) => events.push(e),
    onFinish: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
    assistantMessageId: opts.assistantMessageId,
    thinkingMessageId: opts.thinkingMessageId,
  })
  return { parser, events }
}

function streamEvent(
  delta: Record<string, unknown>,
  parentToolUseId?: string,
) {
  return {
    type: 'stream_event',
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    event: { type: 'content_block_delta', delta },
  } as any
}

describe('CcbMessageParser: v7 messageId stamping', () => {
  // ── Text blocks ──

  it('main-agent text emit carries assistantMessageId when configured', () => {
    const { parser, events } = createParser({
      assistantMessageId: 'srv-peer1-t5',
    })
    parser.parse(streamEvent({ type: 'text_delta', text: 'hello' }))
    assert.equal(events.length, 1)
    if (events[0].kind !== 'block') throw new Error('expected block event')
    const block = events[0].block as any
    assert.equal(block.kind, 'text')
    assert.equal(block.messageId, 'srv-peer1-t5')
  })

  it('main-agent text emit OMITS messageId when assistantMessageId not configured', () => {
    const { parser, events } = createParser({})
    parser.parse(streamEvent({ type: 'text_delta', text: 'hello' }))
    assert.equal(events.length, 1)
    if (events[0].kind !== 'block') throw new Error('expected block event')
    const block = events[0].block as any
    assert.equal(block.kind, 'text')
    assert.equal(block.messageId, undefined,
      'block.messageId stays undefined for legacy callers (backwards-compat)')
  })

  it('subagent text emit (parentToolUseId set) does NOT carry assistantMessageId', () => {
    const { parser, events } = createParser({
      assistantMessageId: 'srv-peer1-t5',
    })
    parser.parse(
      streamEvent({ type: 'text_delta', text: 'sub-text' }, 'tool-use-abc'),
    )
    assert.equal(events.length, 1)
    if (events[0].kind !== 'block') throw new Error('expected block event')
    const block = events[0].block as any
    assert.equal(block.kind, 'text')
    assert.equal(block.parentToolUseId, 'tool-use-abc', 'parent marker preserved')
    assert.equal(block.messageId, undefined,
      'subagent blocks must NOT be stamped — they live in childBlocks, not as rows')
  })

  // ── Thinking blocks ──

  it('main-agent thinking emit carries thinkingMessageId when configured', () => {
    const { parser, events } = createParser({
      thinkingMessageId: 'srv-peer1-t5-thinking',
    })
    parser.parse(streamEvent({ type: 'thinking_delta', thinking: 'pondering…' }))
    assert.equal(events.length, 1)
    if (events[0].kind !== 'block') throw new Error('expected block event')
    const block = events[0].block as any
    assert.equal(block.kind, 'thinking')
    assert.equal(block.messageId, 'srv-peer1-t5-thinking')
  })

  it('main-agent thinking emit OMITS messageId when thinkingMessageId not configured', () => {
    const { parser, events } = createParser({})
    parser.parse(streamEvent({ type: 'thinking_delta', thinking: 'pondering' }))
    assert.equal(events.length, 1)
    if (events[0].kind !== 'block') throw new Error('expected block event')
    const block = events[0].block as any
    assert.equal(block.kind, 'thinking')
    assert.equal(block.messageId, undefined)
  })

  it('subagent thinking emit does NOT carry thinkingMessageId', () => {
    const { parser, events } = createParser({
      thinkingMessageId: 'srv-peer1-t5-thinking',
    })
    parser.parse(
      streamEvent({ type: 'thinking_delta', thinking: 'sub-think' }, 'tool-use-abc'),
    )
    assert.equal(events.length, 1)
    if (events[0].kind !== 'block') throw new Error('expected block event')
    const block = events[0].block as any
    assert.equal(block.kind, 'thinking')
    assert.equal(block.parentToolUseId, 'tool-use-abc')
    assert.equal(block.messageId, undefined,
      'subagent thinking must NOT be stamped')
  })

  // ── Cross-cutting: independence of assistant / thinking ids ──

  it('text uses assistantMessageId, thinking uses thinkingMessageId (independent)', () => {
    const { parser, events } = createParser({
      assistantMessageId: 'srv-peer1-t5',
      thinkingMessageId: 'srv-peer1-t5-thinking',
    })
    parser.parse(streamEvent({ type: 'thinking_delta', thinking: 'a' }))
    parser.parse(streamEvent({ type: 'text_delta', text: 'b' }))
    assert.equal(events.length, 2)
    if (events[0].kind !== 'block' || events[1].kind !== 'block') {
      throw new Error('expected two block events')
    }
    assert.equal((events[0].block as any).messageId, 'srv-peer1-t5-thinking')
    assert.equal((events[1].block as any).messageId, 'srv-peer1-t5')
  })

  it('only assistantMessageId set: thinking deltas still omit messageId', () => {
    const { parser, events } = createParser({ assistantMessageId: 'srv-peer1-t5' })
    parser.parse(streamEvent({ type: 'thinking_delta', thinking: 'x' }))
    parser.parse(streamEvent({ type: 'text_delta', text: 'y' }))
    assert.equal(events.length, 2)
    if (events[0].kind !== 'block' || events[1].kind !== 'block') {
      throw new Error('expected two block events')
    }
    assert.equal((events[0].block as any).messageId, undefined,
      'thinking has no thinkingMessageId configured → no stamp')
    assert.equal((events[1].block as any).messageId, 'srv-peer1-t5')
  })

  it('multiple deltas to the same row all carry the same canonical id', () => {
    const { parser, events } = createParser({
      assistantMessageId: 'srv-peer1-t7',
    })
    parser.parse(streamEvent({ type: 'text_delta', text: 'Hello ' }))
    parser.parse(streamEvent({ type: 'text_delta', text: 'world!' }))
    assert.equal(events.length, 2)
    const ids = events.map((e) =>
      e.kind === 'block' ? (e.block as any).messageId : null,
    )
    assert.deepEqual(ids, ['srv-peer1-t7', 'srv-peer1-t7'])
  })
})
