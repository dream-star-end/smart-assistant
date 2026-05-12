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
  toolMessageIdFactory?: (blockId: string) => string
}): ParserBag {
  const events: SessionStreamEvent[] = []
  const parser = new CcbMessageParser({
    toolUseIdToName: new Map(),
    onEvent: (e) => events.push(e),
    onFinish: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
    assistantMessageId: opts.assistantMessageId,
    thinkingMessageId: opts.thinkingMessageId,
    toolMessageIdFactory: opts.toolMessageIdFactory,
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

// ── v7.1 tool_use stamping ──────────────────────────────────────────────────
//
// Extends the same single-id-authority architecture from v7.0 (text/thinking)
// to tool_use rows. Canonical id format: `srv-${peerId}-t${turnIndex}-tool-${blockId}`,
// minted by `toolMessageIdFactory` in sessionManager (matches master's
// internalServerAuthored.ts:511). Stamping happens at three emission sites:
//   1. content_block_start  — partial tool_use with empty input
//   2. input_json_delta     — streaming partial input deltas
//   3. _handleAssistant     — finalized snapshot with full input
// Plus a non-stamping safety: `Agent` tool name MUST be excluded from
// `completedTools`, otherwise the durable server-authored row will collide
// with the client-side `role: 'agent-group'` card.
describe('CcbMessageParser: v7.1 tool_use messageId stamping', () => {
  const factory = (blockId: string) => `srv-peer1-t5-tool-${blockId}`

  it('content_block_start: main-agent partial tool_use carries canonical id when factory configured', () => {
    const { parser, events } = createParser({ toolMessageIdFactory: factory })
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_abc', name: 'Read' },
      },
    } as any)
    assert.equal(events.length, 1)
    if (events[0].kind !== 'block') throw new Error('expected block event')
    const block = events[0].block as any
    assert.equal(block.kind, 'tool_use')
    assert.equal(block.partial, true)
    assert.equal(block.blockId, 'tu_abc')
    assert.equal(block.messageId, 'srv-peer1-t5-tool-tu_abc')
  })

  it('input_json_delta: partial tool_use deltas carry SAME canonical id as start', () => {
    const { parser, events } = createParser({ toolMessageIdFactory: factory })
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_xyz', name: 'Write' },
      },
    } as any)
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file":"a' },
      },
    } as any)
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '.txt"}' },
      },
    } as any)
    assert.equal(events.length, 3)
    const ids = events.map((e) => (e.kind === 'block' ? (e.block as any).messageId : null))
    assert.deepEqual(ids, [
      'srv-peer1-t5-tool-tu_xyz',
      'srv-peer1-t5-tool-tu_xyz',
      'srv-peer1-t5-tool-tu_xyz',
    ])
  })

  it('_handleAssistant: finalized tool_use snapshot carries canonical id', () => {
    const { parser, events } = createParser({ toolMessageIdFactory: factory })
    parser.parse({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_final',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
    } as any)
    assert.equal(events.length, 1)
    if (events[0].kind !== 'block') throw new Error('expected block event')
    const block = events[0].block as any
    assert.equal(block.kind, 'tool_use')
    assert.equal(block.partial, false)
    assert.equal(block.messageId, 'srv-peer1-t5-tool-tu_final')
  })

  it('factory absent: all three tool_use emission sites OMIT messageId (backwards-compat)', () => {
    const { parser, events } = createParser({}) // no factory
    // 1. content_block_start
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_legacy', name: 'Grep' },
      },
    } as any)
    // 2. input_json_delta
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
      },
    } as any)
    // 3. _handleAssistant final
    parser.parse({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_legacy',
            name: 'Grep',
            input: { q: 'x' },
          },
        ],
      },
    } as any)
    assert.equal(events.length, 3)
    for (const e of events) {
      if (e.kind !== 'block') throw new Error('expected block event')
      assert.equal((e.block as any).messageId, undefined,
        'no factory → no stamp on any tool_use site (legacy callers unaffected)')
    }
  })

  it('subagent tool_use (parentToolUseId set) does NOT carry messageId even with factory', () => {
    const { parser, events } = createParser({ toolMessageIdFactory: factory })
    parser.parse({
      type: 'stream_event',
      parent_tool_use_id: 'parent_agent_tool',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_sub', name: 'Read' },
      },
    } as any)
    parser.parse({
      type: 'assistant',
      parent_tool_use_id: 'parent_agent_tool',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_sub', name: 'Read', input: { file: 'x' } },
        ],
      },
    } as any)
    assert.equal(events.length, 2)
    for (const e of events) {
      if (e.kind !== 'block') throw new Error('expected block event')
      const block = e.block as any
      assert.equal(block.parentToolUseId, 'parent_agent_tool', 'parent marker preserved')
      assert.equal(block.messageId, undefined,
        'subagent tool_use lives in childBlocks of Agent card, must NOT be stamped')
    }
  })

  it('Agent tool: tool_result handling excludes Agent from completedTools (avoids agent-group / tool role conflict)', () => {
    const { parser } = createParser({ toolMessageIdFactory: factory })
    // 1. _handleAssistant: tool_use for Agent
    parser.parse({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { prompt: 'sub task' } },
        ],
      },
    } as any)
    // 2. tool_result arrival
    parser.parse({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_agent', content: 'sub result' }],
      },
    } as any)
    // Agent tool_use IS still emitted to UI (for live streaming card), but
    // it MUST NOT be persisted as a server-authored 'tool' row.
    assert.equal(parser.completedTools.length, 0,
      'Agent tool excluded — durability belongs to the client-side agent-group card')
  })

  it('Agent filter is case-insensitive (mirrors web `/^Agent$/i` discriminator)', () => {
    const { parser } = createParser({ toolMessageIdFactory: factory })
    parser.parse({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_agent_lc', name: 'agent', input: { prompt: 'p' } },
        ],
      },
    } as any)
    parser.parse({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_agent_lc', content: 'r' }],
      },
    } as any)
    assert.equal(parser.completedTools.length, 0,
      'case variants of "agent" also excluded — keeps parser aligned with client casing')
  })

  it('Non-Agent tools still land in completedTools as before (regression guard)', () => {
    const { parser } = createParser({ toolMessageIdFactory: factory })
    parser.parse({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    } as any)
    parser.parse({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_bash', content: 'a\nb\nc' }],
      },
    } as any)
    assert.equal(parser.completedTools.length, 1, 'normal tools still persisted')
    assert.equal(parser.completedTools[0].toolName, 'Bash')
    assert.equal(parser.completedTools[0].blockId, 'tu_bash')
  })
})
