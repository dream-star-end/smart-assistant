/**
 * @baseline-v7.4 — Fix B per-segment row id baseline lock.
 *
 * Captures the CURRENT (buggy) behavior of CcbMessageParser when an Anthropic
 * agent emits the pattern `text₁ → tool_use → tool_result → text₂` within a
 * single turn:
 *
 *   parser stamps BOTH text emits with the same `assistantMessageId`
 *   → frontend merges into ONE assistant row (id-union)
 *   → row ts = text₁ first-token ts (preserved by v7.2 same-id merge)
 *   → ts-sort places the merged row ABOVE the tool card (whose ts > text₁'s)
 *   → user sees: [text₁ text₂] then [tool card] — wrong order vs live stream.
 *
 * This test exists to lock that protocol-level invariant in place BEFORE
 * Fix B flips it. When Fix B lands:
 *   - the two text emits MUST stamp DIFFERENT messageIds
 *     (`srv-...-tN-s0` and `srv-...-tN-s1`)
 *   - this test must be updated/replaced (do not just delete — preserve the
 *     "what changed and why" delta for archaeology).
 *
 * Plan: docs/wip/fixb-per-segment-row-id-PLAN.md §5.1
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbMessageParserSegmentBaseline.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CcbMessageParser,
  type SessionStreamEvent,
} from '../ccbMessageParser.js'

function createParser() {
  const events: SessionStreamEvent[] = []
  const parser = new CcbMessageParser({
    toolUseIdToName: new Map(),
    onEvent: (e) => events.push(e),
    onFinish: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
    assistantMessageId: 'srv-peer1-agent1-t5',
    thinkingMessageId: 'srv-peer1-agent1-t5-thinking',
    toolMessageIdFactory: (blockId) => `srv-peer1-agent1-t5-tool-${blockId}`,
  })
  return { parser, events }
}

const textDelta = (text: string) =>
  ({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  }) as unknown as Record<string, unknown>

const toolUseStart = (blockId: string, name: string) =>
  ({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: blockId, name },
    },
  }) as unknown as Record<string, unknown>

describe('@baseline-v7.4 CcbMessageParser: text → tool_use → text in a single turn', () => {
  it('BUGGY-BY-DESIGN: both text emits stamp the SAME assistantMessageId', () => {
    const { parser, events } = createParser()
    parser.parse(textDelta('hello '))
    parser.parse(toolUseStart('tu_abc', 'Read'))
    parser.parse(textDelta('here is the answer'))

    const textBlocks = events
      .filter((e) => e.kind === 'block')
      .map((e) => (e.kind === 'block' ? e.block : null))
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .filter((b) => (b as { kind: string }).kind === 'text')

    assert.equal(textBlocks.length, 2, 'two text emits across the tool boundary')
    const ids = textBlocks.map((b) => (b as { messageId?: string }).messageId)
    assert.deepEqual(
      ids,
      ['srv-peer1-agent1-t5', 'srv-peer1-agent1-t5'],
      'BASELINE: both texts stamp the SAME canonical id — root cause of the ' +
        'ordering bug; Fix B will change s0/s1 distinct ids',
    )
  })

  it('BUGGY-BY-DESIGN: thinking → tool_use → thinking stamp same thinkingMessageId', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'part1 ' },
      },
    } as unknown as Record<string, unknown>)
    parser.parse(toolUseStart('tu_abc', 'Read'))
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'part2' },
      },
    } as unknown as Record<string, unknown>)

    const thinkingBlocks = events
      .filter((e) => e.kind === 'block')
      .map((e) => (e.kind === 'block' ? e.block : null))
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .filter((b) => (b as { kind: string }).kind === 'thinking')

    assert.equal(thinkingBlocks.length, 2)
    const ids = thinkingBlocks.map((b) => (b as { messageId?: string }).messageId)
    assert.deepEqual(
      ids,
      ['srv-peer1-agent1-t5-thinking', 'srv-peer1-agent1-t5-thinking'],
      'BASELINE: thinking has the same single-id-authority bug; Fix B fixes both',
    )
  })
})
