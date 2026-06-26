/**
 * Fix B per-segment row id — new-behavior tests.
 *
 * Replaces the @baseline-v7.4 baseline lock (preserved in git history of
 * this file at commit e5c60122). Verifies that when an Anthropic agent
 * emits `text₁ → tool_use → text₂` within a single turn:
 *
 *   - the two text emits stamp DIFFERENT messageIds — `srv-...-tN-s0` and
 *     `srv-...-tN-s1` — so the frontend `_findOrCreateStreamingRow` creates
 *     two distinct rows that ts-sort can interleave with the tool row;
 *   - parser.assistantSegments[] surfaces both segments with their own ts;
 *   - back-to-back tool_use boundaries are idempotent on the bump flag
 *     (segments[0..1] not [0..2]);
 *   - tool-first patterns keep first text in s0 (no pre-segment to bump from);
 *   - thinking → tool → thinking does the same on the thinking counter.
 *
 * Plan: docs/wip/fixb-per-segment-row-id-PLAN.md §5.2
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbMessageParserSegmentBaseline.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CcbMessageParser,
  type SessionStreamEvent,
} from '../ccbMessageParser.js'
import type { SdkMessage } from '../subprocessRunner.js'

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
  }) as unknown as SdkMessage

const thinkingDelta = (thinking: string) =>
  ({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking },
    },
  }) as unknown as SdkMessage

const toolUseStart = (blockId: string, name: string) =>
  ({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: blockId, name },
    },
  }) as unknown as SdkMessage

function textBlocks(events: SessionStreamEvent[]) {
  return events
    .filter((e) => e.kind === 'block')
    .map((e) => (e.kind === 'block' ? e.block : null))
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .filter((b) => (b as { kind: string }).kind === 'text')
}

function thinkingBlocks(events: SessionStreamEvent[]) {
  return events
    .filter((e) => e.kind === 'block')
    .map((e) => (e.kind === 'block' ? e.block : null))
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .filter((b) => (b as { kind: string }).kind === 'thinking')
}

describe('Fix B: per-segment row id (text)', () => {
  it('text → tool → text emits two distinct -sN ids and two assistantSegments', () => {
    const { parser, events } = createParser()
    parser.parse(textDelta('hello '))
    parser.parse(toolUseStart('tu_abc', 'Read'))
    parser.parse(textDelta('here is the answer'))

    const ids = textBlocks(events).map((b) => (b as { messageId?: string }).messageId)
    assert.deepEqual(ids, [
      'srv-peer1-agent1-t5-s0',
      'srv-peer1-agent1-t5-s1',
    ])

    assert.equal(parser.assistantSegments.length, 2)
    assert.equal(parser.assistantSegments[0].index, 0)
    assert.equal(parser.assistantSegments[0].text, 'hello ')
    assert.equal(parser.assistantSegments[1].index, 1)
    assert.equal(parser.assistantSegments[1].text, 'here is the answer')
    assert.ok(
      parser.assistantSegments[1].ts >= parser.assistantSegments[0].ts,
      'segment ts is monotonic — s1.ts >= s0.ts',
    )
  })

  it('back-to-back tool_use boundaries are idempotent on the bump flag (s0 → s1 not s0 → s2)', () => {
    const { parser, events } = createParser()
    parser.parse(textDelta('first'))
    parser.parse(toolUseStart('tu_a', 'Read'))
    parser.parse(toolUseStart('tu_b', 'Read'))
    parser.parse(textDelta('second'))

    const ids = textBlocks(events).map((b) => (b as { messageId?: string }).messageId)
    assert.deepEqual(ids, [
      'srv-peer1-agent1-t5-s0',
      'srv-peer1-agent1-t5-s1',
    ])
    assert.deepEqual(
      parser.assistantSegments.map((s) => s.index),
      [0, 1],
      'second segment is s1 not s2',
    )
  })

  it('tool-first turn keeps the first text in s0 (no pre-segment to bump from)', () => {
    const { parser, events } = createParser()
    parser.parse(toolUseStart('tu_a', 'Read'))
    parser.parse(textDelta('a'))
    parser.parse(textDelta('b'))

    const ids = textBlocks(events).map((b) => (b as { messageId?: string }).messageId)
    assert.deepEqual(ids, [
      'srv-peer1-agent1-t5-s0',
      'srv-peer1-agent1-t5-s0',
    ])
    assert.equal(parser.assistantSegments.length, 1)
    assert.equal(parser.assistantSegments[0].index, 0)
    assert.equal(parser.assistantSegments[0].text, 'ab')
  })

  it('text → tool → (no further text) yields one segment (pending bump unconsumed)', () => {
    const { parser, events } = createParser()
    parser.parse(textDelta('only one'))
    parser.parse(toolUseStart('tu_a', 'Read'))

    const ids = textBlocks(events).map((b) => (b as { messageId?: string }).messageId)
    assert.deepEqual(ids, ['srv-peer1-agent1-t5-s0'])
    assert.equal(parser.assistantSegments.length, 1, 'no empty s1 leftover')
  })

  it('tool-only turn yields zero assistantSegments', () => {
    const { parser } = createParser()
    parser.parse(toolUseStart('tu_a', 'Read'))
    assert.equal(parser.assistantSegments.length, 0)
  })
})

describe('Fix B: per-segment row id (thinking)', () => {
  it('thinking → tool → thinking emits two distinct -thinking-sN ids', () => {
    const { parser, events } = createParser()
    parser.parse(thinkingDelta('part1 '))
    parser.parse(toolUseStart('tu_abc', 'Read'))
    parser.parse(thinkingDelta('part2'))

    const ids = thinkingBlocks(events).map((b) => (b as { messageId?: string }).messageId)
    assert.deepEqual(ids, [
      'srv-peer1-agent1-t5-thinking-s0',
      'srv-peer1-agent1-t5-thinking-s1',
    ])

    assert.equal(parser.thinkingSegments.length, 2)
    assert.equal(parser.thinkingSegments[0].text, 'part1 ')
    assert.equal(parser.thinkingSegments[1].text, 'part2')
  })

  it('text and thinking counters are independent', () => {
    const { parser, events } = createParser()
    parser.parse(textDelta('t1 '))
    parser.parse(thinkingDelta('think1 '))
    parser.parse(toolUseStart('tu_a', 'Read'))
    parser.parse(textDelta('t2'))

    const tids = textBlocks(events).map((b) => (b as { messageId?: string }).messageId)
    const thIds = thinkingBlocks(events).map((b) => (b as { messageId?: string }).messageId)
    // text counter bumped once; thinking had only one segment so far + no
    // new thinking delta, so still s0.
    assert.deepEqual(tids, [
      'srv-peer1-agent1-t5-s0',
      'srv-peer1-agent1-t5-s1',
    ])
    assert.deepEqual(thIds, ['srv-peer1-agent1-t5-thinking-s0'])
  })
})

describe('Fix B: tool arrivedAt (card appearance time, not result completion)', () => {
  function makeToolResult(toolUseId: string, output: string) {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: output,
            is_error: false,
          },
        ],
      },
    } as unknown as SdkMessage
  }

  function makeToolUseAssistantSnapshot(toolUseId: string, name: string) {
    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name, input: {} }],
      },
    } as unknown as SdkMessage
  }

  it('completedTools[].arrivedAt is the tool_use first-observation time, distinct from ts (tool_result arrival)', async () => {
    const { parser } = createParser()
    // content_block_start fires first → stamps arrivedAt at T0.
    parser.parse(toolUseStart('tu_a', 'Read'))
    const T0 = Date.now()
    // Sleep a short interval so tool_result lands later than tool_use start.
    await new Promise((r) => setTimeout(r, 20))
    parser.parse(makeToolUseAssistantSnapshot('tu_a', 'Read')) // finalized
    parser.parse(makeToolResult('tu_a', 'ok'))
    assert.equal(parser.completedTools.length, 1)
    const e = parser.completedTools[0]
    // arrivedAt must reflect tool_use start (≤ T0 + a few ms).
    assert.ok(
      e.arrivedAt <= T0 + 5,
      `tool arrivedAt (${e.arrivedAt}) should be tool_use observation time (~${T0})`,
    )
    // ts is the tool_result arrival time (kept for legacy schema; should
    // be at least T0 + 20 since we slept).
    assert.ok(
      e.ts >= T0 + 15,
      `tool ts (${e.ts}) should reflect tool_result arrival (≥ T0+15 after 20ms sleep)`,
    )
  })

  it('Codex runner path (no content_block_start, only assistant snapshot) still stamps arrivedAt', async () => {
    const { parser } = createParser()
    const T0 = Date.now()
    parser.parse(makeToolUseAssistantSnapshot('tu_b', 'mcp_skill'))
    await new Promise((r) => setTimeout(r, 20))
    parser.parse(makeToolResult('tu_b', 'ok'))
    assert.equal(parser.completedTools.length, 1)
    assert.ok(
      parser.completedTools[0].arrivedAt <= T0 + 10,
      'arrivedAt is stamped on Codex runner path even without content_block_start',
    )
  })
})
