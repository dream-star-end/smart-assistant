/**
 * Unit tests for CcbMessageParser.
 * Tests the CCB stream-json message parsing logic in isolation.
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbMessageParser.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CcbMessageParser,
  type SessionStreamEvent,
} from '../ccbMessageParser.js'

function createParser(opts?: {
  onToolUse?: (t: any) => void
  onPostFinalRuntimeEvent?: (event: any, block: any) => void
}) {
  const events: SessionStreamEvent[] = []
  let finished = false
  let finishResult: any = null
  const toolUseIdToName = new Map<string, string>()

  const parser = new CcbMessageParser({
    toolUseIdToName,
    onEvent: (e) => events.push(e),
    onToolUse: opts?.onToolUse,
    onPostFinalRuntimeEvent: opts?.onPostFinalRuntimeEvent,
    onFinish: (result) => {
      finished = true
      finishResult = result
    },
    sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
  })

  return {
    parser,
    events,
    getFinished: () => finished,
    getResult: () => finishResult,
    toolUseIdToName,
  }
}

// ── Text streaming ──
describe('CcbMessageParser: text streaming', () => {
  it('emits text blocks from stream_event text_delta', () => {
    const { parser, events } = createParser()

    parser.parse({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
    } as any)
    parser.parse({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
    } as any)

    assert.equal(events.length, 2)
    assert.equal(events[0].kind, 'block')
    if (events[0].kind === 'block') {
      assert.equal(events[0].block.kind, 'text')
      assert.equal((events[0].block as any).text, 'Hello ')
    }
    assert.equal(parser.assistantBuf, 'Hello world')
  })

  it('emits thinking blocks from thinking_delta', () => {
    const { parser, events } = createParser()

    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Let me think...' },
      },
    } as any)

    assert.equal(events.length, 1)
    if (events[0].kind === 'block') {
      assert.equal(events[0].block.kind, 'thinking')
    }
  })

  it('emits plan blocks from codex openclaude_plan payloads', () => {
    const { parser, events } = createParser()

    parser.parse({
      type: 'openclaude_plan',
      plan: {
        blockId: 'codex-plan',
        explanation: 'verify first',
        steps: [
          { step: 'inspect code', status: 'completed' },
          { step: 'patch UI', status: 'inProgress' },
        ],
        partial: true,
      },
    } as any)

    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'block')
    if (events[0].kind === 'block') {
      const b = events[0].block as any
      assert.equal(b.kind, 'plan')
      assert.equal(b.blockId, 'codex-plan')
      assert.equal(b.explanation, 'verify first')
      assert.deepEqual(b.steps, [
        { step: 'inspect code', status: 'completed' },
        { step: 'patch UI', status: 'inProgress' },
      ])
      assert.equal(b.partial, true)
    }
  })

  it('emits goal blocks from codex openclaude_goal payloads without touching assistantBuf', () => {
    const { parser, events } = createParser()

    parser.parse({
      type: 'openclaude_goal',
      goal: {
        blockId: 'codex-goal',
        objective: 'adapt goals',
        status: 'blocked',
        tokenBudget: null,
        tokensUsed: 42,
        timeUsedSeconds: 7,
        updatedAt: 1780000000,
        cleared: false,
        platformGoalId: '11111111-1111-4111-8111-111111111111',
        platformStateRevision: 9,
      },
    } as any)

    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'block')
    if (events[0].kind === 'block') {
      const b = events[0].block as any
      assert.equal(b.kind, 'goal')
      assert.equal(b.blockId, 'codex-goal')
      assert.equal(b.objective, 'adapt goals')
      assert.equal(b.status, 'blocked')
      assert.equal(b.tokenBudget, null)
      assert.equal(b.tokensUsed, 42)
      assert.equal(b.timeUsedSeconds, 7)
      assert.equal(b.updatedAt, 1780000000)
      assert.equal(b.cleared, false)
      assert.equal(b.platformGoalId, '11111111-1111-4111-8111-111111111111')
      assert.equal(b.platformStateRevision, 9)
    }
    assert.equal(parser.assistantBuf, '')
  })
})

// ── Thinking accumulation (Phase 0.4 server-authored persistence) ──
describe('CcbMessageParser: thinking accumulation', () => {
  function emitThinking(parser: CcbMessageParser, text: string, parentToolUseId?: string) {
    parser.parse({
      type: 'stream_event',
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: text },
      },
    } as any)
  }

  it('concatenates main-agent thinking_delta into thinkingBuf', () => {
    const { parser } = createParser()
    emitThinking(parser, 'Step 1. ')
    emitThinking(parser, 'Step 2. ')
    emitThinking(parser, 'Step 3.')
    assert.equal(parser.thinkingBuf, 'Step 1. Step 2. Step 3.')
  })

  it('excludes subagent thinking from thinkingBuf', () => {
    const { parser } = createParser()
    emitThinking(parser, 'main agent thinks')
    emitThinking(parser, 'child thinks too', 'toolu_subagent')
    // Only the main-agent delta is captured; subagent thinking is UI-only.
    assert.equal(parser.thinkingBuf, 'main agent thinks')
  })

  it('retains an oversized thinking stream byte-for-byte', () => {
    const { parser } = createParser()
    const giant = 'a'.repeat(16 * 1024)
    emitThinking(parser, giant)
    assert.equal(parser.thinkingBuf, giant)
  })

  it('retains every thinking delta after a large first delta', () => {
    const { parser } = createParser()
    const first = 'a'.repeat(16 * 1024)
    emitThinking(parser, first)
    emitThinking(parser, 'second')
    emitThinking(parser, 'third')
    assert.equal(parser.thinkingBuf, `${first}secondthird`)
  })

  it('retains large CJK thinking exactly', () => {
    const { parser } = createParser()
    const giant = '中'.repeat(4096)
    emitThinking(parser, giant)
    assert.equal(parser.thinkingBuf, giant)
  })

  it('retains large emoji thinking exactly', () => {
    const { parser } = createParser()
    const giant = '😀'.repeat(2200)
    emitThinking(parser, giant)
    assert.equal(parser.thinkingBuf, giant)
  })

  it('thinkingText is forwarded into TurnResult on result event', () => {
    const { parser, getResult } = createParser()
    emitThinking(parser, 'Reasoning A')
    emitThinking(parser, 'Reasoning B')
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)
    const r = getResult()
    assert.equal(r.thinkingText, 'Reasoning AReasoning B')
  })

  it('empty thinkingBuf when no thinking_delta seen', () => {
    const { parser, getResult } = createParser()
    parser.parse({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'plain answer' } },
    } as any)
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)
    assert.equal(parser.thinkingBuf, '')
    assert.equal(getResult().thinkingText, '')
  })
})

// ── Tool use ──
describe('CcbMessageParser: tool_use', () => {
  it('emits partial tool_use on content_block_start', () => {
    const { parser, events } = createParser()

    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'Read' },
      },
    } as any)

    assert.equal(events.length, 1)
    if (events[0].kind === 'block') {
      assert.equal(events[0].block.kind, 'tool_use')
      assert.equal((events[0].block as any).partial, true)
      assert.equal((events[0].block as any).toolName, 'Read')
    }
  })

  it('emits final tool_use on assistant snapshot', () => {
    const { parser, events } = createParser()

    parser.parse({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_2',
            name: 'Write',
            input: { file: 'test.txt', content: 'hello' },
          },
        ],
      },
    } as any)

    assert.equal(events.length, 1)
    if (events[0].kind === 'block') {
      assert.equal((events[0].block as any).partial, false)
      assert.equal((events[0].block as any).toolName, 'Write')
    }
  })

  it('calls onToolUse callback for detected tools', () => {
    const detected: any[] = []
    const { parser } = createParser({ onToolUse: (t) => detected.push(t) })

    parser.parse({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_3',
            name: 'CronCreate',
            input: { cron: '0 9 * * *', prompt: 'test' },
          },
        ],
      },
    } as any)

    assert.equal(detected.length, 1)
    assert.equal(detected[0].name, 'CronCreate')
    assert.equal(detected[0].input.cron, '0 9 * * *')
  })

  // input_json_delta streaming — drives partial Edit/Write body rendering on web.
  // Append-only delta protocol: each frame carries just the NEW chunk
  // (`partialJsonDelta`) and the position it should land at
  // (`partialJsonOffset` = accumulator length BEFORE the delta). The web
  // client validates the offset matches its current buffer and appends, or
  // degrades on mismatch.
  it('emits partialJsonDelta + partialJsonOffset on every input_json_delta partial frame', () => {
    const { parser, events } = createParser()

    // content_block_start: emits empty-input partial frame (no delta yet).
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_p1', name: 'Edit' },
      },
    } as any)
    // First delta.
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/x"' },
      },
    } as any)
    // Second delta.
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: ',"old_string":"hello' },
      },
    } as any)

    // start frame + 2 delta frames
    assert.equal(events.length, 3)
    const startFrame = events[0] as any
    const delta1 = events[1] as any
    const delta2 = events[2] as any

    // content_block_start: no delta yet, partial true.
    assert.equal(startFrame.block.partial, true)
    assert.equal(startFrame.block.partialJsonDelta, undefined)
    assert.equal(startFrame.block.partialJsonOffset, undefined)

    // First delta: append at offset 0.
    assert.equal(delta1.block.partial, true)
    assert.equal(delta1.block.partialJsonDelta, '{"file_path":"/x"')
    assert.equal(delta1.block.partialJsonOffset, 0)
    assert.equal(delta1.block.inputPreview, '{"file_path":"/x"')

    // Second delta: append at offset = len(first delta).
    assert.equal(delta2.block.partial, true)
    assert.equal(delta2.block.partialJsonDelta, ',"old_string":"hello')
    assert.equal(delta2.block.partialJsonOffset, '{"file_path":"/x"'.length)
  })

  it('retains an unmatched tool call and its exact raw partial JSON for crash persistence', () => {
    const { parser } = createParser()
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-pending', name: 'Write' },
      },
    } as any)
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/full"' },
      },
    } as any)
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: ',"content":"全部细节' },
      },
    } as any)

    const tools = parser.snapshotToolsForPersistence()
    assert.equal(tools.length, 1)
    assert.equal(tools[0].toolUseId, 'tool-pending')
    assert.equal(tools[0].toolName, 'Write')
    assert.equal(
      tools[0].partialInputJson,
      '{"file_path":"/tmp/full","content":"全部细节',
    )
    assert.equal(tools[0].completed, false)
    assert.equal(tools[0].output, '')
  })

  it('keeps emitting partialJsonDelta past 64 KiB — no bandwidth cap', () => {
    // Old protocol dropped the cumulative buffer above 64 KiB. With the
    // delta protocol each frame is bounded by the SDK chunk size, so big
    // tool inputs (multi-KB Write content) stream all the way through.
    const { parser, events } = createParser()

    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_p2', name: 'Write' },
      },
    } as any)

    const big = '{"content":"' + 'x'.repeat(64 * 1024) // pushes accumulator past 64 KiB
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: big },
      },
    } as any)
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'y' },
      },
    } as any)

    const first = events[1] as any
    const second = events[2] as any

    assert.equal(first.block.partialJsonDelta, big)
    assert.equal(first.block.partialJsonOffset, 0)

    // Second frame still arrives even though accumulator is now >64 KiB.
    assert.equal(second.block.partialJsonDelta, 'y')
    assert.equal(second.block.partialJsonOffset, big.length)
    assert.equal(second.block.partial, true)
  })

  it('skips emitting a frame for empty input_json_delta chunks', () => {
    // Anthropic SSE occasionally sends a delta event with an empty
    // `partial_json` (e.g. trailing keepalive). We must not emit a
    // zero-length-delta frame — web's offset check would see
    // `partialJsonOffset === current.length` and the append is a no-op,
    // but the wire byte is still wasted. Cheap to drop at the source.
    const { parser, events } = createParser()

    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_p_empty', name: 'Edit' },
      },
    } as any)
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '' },
      },
    } as any)

    // Only the content_block_start frame was emitted; empty delta dropped.
    assert.equal(events.length, 1)
    assert.equal((events[0] as any).block.partial, true)
  })

  it('final assistant snapshot carries full inputJson and no delta fields', () => {
    const { parser, events } = createParser()

    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_p3', name: 'Edit' },
      },
    } as any)
    parser.parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/x","new_string":"abc' },
      },
    } as any)
    // Final SDK snapshot — uses c.input verbatim, not the partial accumulator.
    parser.parse({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_p3',
            name: 'Edit',
            input: { file_path: '/x', new_string: 'abc' },
          },
        ],
      },
    } as any)

    const finalFrame = events[events.length - 1] as any
    assert.equal(finalFrame.block.partial, false)
    assert.deepEqual(finalFrame.block.inputJson, { file_path: '/x', new_string: 'abc' })
    // Final frame intentionally has no delta fields — clients should prefer inputJson.
    assert.equal(finalFrame.block.partialJsonDelta, undefined)
    assert.equal(finalFrame.block.partialJsonOffset, undefined)
  })
})

// ── Tool result ──
describe('CcbMessageParser: tool_result', () => {
  it('emits tool_result from user snapshot', () => {
    const { parser, events, toolUseIdToName } = createParser()
    toolUseIdToName.set('tu_4', 'Read')

    parser.parse({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_4', content: 'file contents here' }],
      },
    } as any)

    assert.equal(events.length, 1)
    if (events[0].kind === 'block') {
      assert.equal(events[0].block.kind, 'tool_result')
      assert.equal((events[0].block as any).toolName, 'Read')
      assert.equal((events[0].block as any).preview, 'file contents here')
    }
  })

  it('deduplicates tool_result emissions', () => {
    const { parser, events, toolUseIdToName } = createParser()
    toolUseIdToName.set('tu_5', 'Bash')

    const msg = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_5', content: 'output' }],
      },
    } as any

    parser.parse(msg)
    parser.parse(msg)

    assert.equal(events.length, 1, 'should emit only once')
  })

  it('keeps a short display preview alongside the complete authoritative output', () => {
    const { parser, events, toolUseIdToName } = createParser()
    toolUseIdToName.set('tu_6', 'Bash')
    const output = `${'x'.repeat(5000)}EXACT_TOOL_RESULT_END`

    parser.parse({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_6', content: output }],
      },
    } as any)

    assert.equal(events.length, 1)
    if (events[0].kind === 'block' && events[0].block.kind === 'tool_result') {
      assert.ok((events[0].block as any).preview.length <= 3001) // 3000 + '…'
      assert.ok((events[0].block as any).preview.length > 3000)
      assert.equal((events[0].block as any).output, output)
    }
  })
})

// ── Result / finalization ──
describe('CcbMessageParser: result', () => {
  it('emits final event and calls onFinish with turn result', () => {
    const { parser, events, getFinished, getResult } = createParser()

    // Simulate some text first
    parser.parse({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
    } as any)

    // Then result
    parser.parse({
      type: 'result',
      total_cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 200 },
    } as any)

    assert.ok(getFinished())
    const result = getResult()
    assert.equal(result.cost, 0.05)
    assert.equal(result.inputTokens, 1000)
    assert.equal(result.outputTokens, 200)
    assert.equal(result.assistantText, 'answer')

    // Should have emitted a 'final' event
    const finalEvent = events.find((e) => e.kind === 'final')
    assert.ok(finalEvent)
    if (finalEvent?.kind === 'final') {
      assert.equal(finalEvent.meta?.cost, 0.05)
      assert.equal(finalEvent.meta?.turn, 1)
    }
  })

  it('forwards result.structured_output only on the final event that carries it', () => {
    const withStructured = createParser()
    const structuredOutput = { upserts: [], deletes: [], summary: 'noop' }
    withStructured.parser.parse({
      type: 'result',
      total_cost_usd: 0.01,
      usage: {},
      structured_output: structuredOutput,
    } as any)
    const structuredFinal = withStructured.events.find((event) => event.kind === 'final')
    assert.ok(structuredFinal?.kind === 'final')
    assert.deepEqual(structuredFinal.meta?.structuredOutput, structuredOutput)

    const withoutStructured = createParser()
    withoutStructured.parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)
    const plainFinal = withoutStructured.events.find((event) => event.kind === 'final')
    assert.ok(plainFinal?.kind === 'final')
    assert.equal(
      Object.prototype.hasOwnProperty.call(plainFinal.meta ?? {}, 'structuredOutput'),
      false,
    )
  })

  it('ignores messages after finalization', () => {
    const { parser, events } = createParser()

    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)
    const countAfterResult = events.length

    parser.parse({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'late' } },
    } as any)

    assert.equal(events.length, countAfterResult, 'should not emit after finalization')
  })

  it('computes per-turn cost as delta of CCB cumulative total_cost_usd', () => {
    // Shared sessionTotals (mimics gateway holding per-session reference)
    const sessionTotals = { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 }
    const mkParser = () => {
      let result: any = null
      const parser = new CcbMessageParser({
        toolUseIdToName: new Map(),
        onEvent: () => {},
        onFinish: (r) => { result = r },
        sessionTotals,
      })
      return { parser, getResult: () => result }
    }

    // Turn 1: CCB reports cumulative 0.05 → delta = 0.05
    const t1 = mkParser()
    t1.parser.parse({ type: 'result', total_cost_usd: 0.05, usage: {} } as any)
    assert.equal(t1.getResult().cost, 0.05)
    assert.equal(sessionTotals.totalCostUSD, 0.05)
    assert.equal(sessionTotals._lastCcbCumulativeCost, 0.05)

    // Turn 2: CCB reports cumulative 0.12 → delta = 0.07 (NOT 0.12)
    const t2 = mkParser()
    t2.parser.parse({ type: 'result', total_cost_usd: 0.12, usage: {} } as any)
    assert.ok(Math.abs(t2.getResult().cost - 0.07) < 1e-9)
    assert.ok(Math.abs(sessionTotals.totalCostUSD - 0.12) < 1e-9)

    // Turn 3 (phantom-style): cumulative unchanged → delta = 0
    const t3 = mkParser()
    t3.parser.parse({ type: 'result', total_cost_usd: 0.12, usage: {} } as any)
    assert.equal(t3.getResult().cost, 0)
    assert.ok(Math.abs(sessionTotals.totalCostUSD - 0.12) < 1e-9)

    // Turn 4: CCB process restarted (cumulative drops to 0.03) → delta = 0.03
    const t4 = mkParser()
    t4.parser.parse({ type: 'result', total_cost_usd: 0.03, usage: {} } as any)
    assert.equal(t4.getResult().cost, 0.03)
    assert.ok(Math.abs(sessionTotals.totalCostUSD - 0.15) < 1e-9)
    assert.equal(sessionTotals._lastCcbCumulativeCost, 0.03)
  })

  it('attributes full cost after gateway-initiated CCB restart (cumulative ≥ old prev)', () => {
    // Simulates gateway flow: after AUTH_ERROR / PHANTOM_TURN / effort-change
    // the gateway shuts down CCB and resets _lastCcbCumulativeCost to 0 before
    // the next turn. Without that reset, a new CCB whose first turn costs more
    // than the old process's final cumulative would be UNDER-counted.
    const sessionTotals = { totalCostUSD: 0.01, turns: 1, _lastCcbCumulativeCost: 0.01 }
    // Gateway respawns CCB and explicitly resets the tracker:
    sessionTotals._lastCcbCumulativeCost = 0

    // First turn on the fresh CCB reports cumulative 0.03 (real per-turn cost).
    let result: any = null
    const parser = new CcbMessageParser({
      toolUseIdToName: new Map(),
      onEvent: () => {},
      onFinish: (r) => { result = r },
      sessionTotals,
    })
    parser.parse({ type: 'result', total_cost_usd: 0.03, usage: {} } as any)

    // With the reset, delta = 0.03 - 0 = 0.03 (correct). Without it, delta
    // would be 0.03 - 0.01 = 0.02 (0.01 of real charges would vanish).
    assert.equal(result.cost, 0.03)
    assert.ok(Math.abs(sessionTotals.totalCostUSD - 0.04) < 1e-9)
    assert.equal(sessionTotals._lastCcbCumulativeCost, 0.03)
  })
})

// ── System messages ──
describe('CcbMessageParser: system', () => {
  it('ignores system messages silently', () => {
    const { parser, events } = createParser()
    parser.parse({ type: 'system', session_id: 'test-123' } as any)
    assert.equal(events.length, 0)
  })

  it('emits tool_output_tail block for system bash_output_tail', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'bash_output_tail',
      tool_use_id: 'toolu_bash_123',
      tail: 'line1\nline2\n',
      total_bytes: 12,
      truncated_head: false,
    } as any)
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'block')
    if (events[0].kind === 'block') {
      const b = events[0].block as any
      assert.equal(b.kind, 'tool_output_tail')
      assert.equal(b.toolUseBlockId, 'toolu_bash_123')
      assert.equal(b.tail, 'line1\nline2\n')
      assert.equal(b.totalBytes, 12)
      assert.equal(b.truncatedHead, false)
      assert.equal(b.parentToolUseId, undefined)
    }
  })

  it('routes post-final bash tails through the durable continuation callback before live delivery', () => {
    const continuations: Array<{ event: any; block: any }> = []
    const { parser, events } = createParser({
      onPostFinalRuntimeEvent: (event, block) => continuations.push({ event, block }),
    })
    parser.finish()
    const raw = {
      type: 'system',
      subtype: 'bash_output_tail',
      tool_use_id: 'toolu_bg',
      tail: 'late paid output',
      total_bytes: 16,
      truncated_head: false,
    }
    parser.parse(raw as any)
    assert.equal(events.length, 0, 'callback owns delivery after durable staging')
    assert.equal(continuations.length, 1)
    assert.deepEqual(continuations[0].event.payload, raw)
    assert.equal(continuations[0].event.source, 'ccb')
    assert.equal(continuations[0].block.kind, 'tool_output_tail')
    assert.equal(continuations[0].block.tail, 'late paid output')
  })

  it('forwards parent_tool_use_id on bash_output_tail for subagent routing', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'bash_output_tail',
      tool_use_id: 'toolu_bash_child',
      parent_tool_use_id: 'toolu_agent_parent',
      tail: 'sub output',
      total_bytes: 10,
      truncated_head: true,
    } as any)
    assert.equal(events.length, 1)
    if (events[0].kind === 'block') {
      const b = events[0].block as any
      assert.equal(b.parentToolUseId, 'toolu_agent_parent')
      assert.equal(b.truncatedHead, true)
    }
  })

  it('drops bash_output_tail with missing/empty tool_use_id (no orphan blocks)', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'bash_output_tail',
      tail: 'orphan',
      total_bytes: 6,
      truncated_head: false,
    } as any)
    parser.parse({
      type: 'system',
      subtype: 'bash_output_tail',
      tool_use_id: '',
      tail: 'empty id',
      total_bytes: 8,
      truncated_head: false,
    } as any)
    assert.equal(events.length, 0)
  })

  it('coerces missing tail/total_bytes to safe defaults', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'bash_output_tail',
      tool_use_id: 'toolu_x',
    } as any)
    assert.equal(events.length, 1)
    if (events[0].kind === 'block') {
      const b = events[0].block as any
      assert.equal(b.tail, '')
      assert.equal(b.totalBytes, 0)
      assert.equal(b.truncatedHead, false)
    }
  })

  it('ignores other system subtypes (e.g. task_progress, init)', () => {
    const { parser, events } = createParser()
    parser.parse({ type: 'system', subtype: 'init', session_id: 'x' } as any)
    parser.parse({ type: 'system', subtype: 'task_progress', task_id: 't1' } as any)
    parser.parse({ type: 'system', subtype: 'task_started', task_id: 't1' } as any)
    assert.equal(events.length, 0)
  })

  // Plan 2 (compact-progress-frame) — system.status 转 kind:'turn_status'
  // 受控枚举(coreSchemas.ts:SDKStatusSchema 只 'compacting' | null),parser 不
  // 透传 CCB raw 字符串。未来 CCB 加新 status 时,gateway 没显式映射会被 normalize
  // 到 null,前端永远只看到受控值。这套测试覆盖:
  //   1) 'compacting' 直通
  //   2) null 直通(compact_end)
  //   3) 其它字符串 normalize 到 null(防 CCB 偷偷扩枚举)
  //   4) 不影响 bash_output_tail 路径(同一 system 分支内)
  it('emits turn_status compacting for system status compacting', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      session_id: 'sess-1',
      uuid: 'u-1',
    } as any)
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'turn_status')
    if (events[0].kind === 'turn_status') {
      assert.equal(events[0].status, 'compacting')
    }
  })

  it('emits turn_status null for system status null (compact_end)', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'status',
      status: null,
      session_id: 'sess-1',
      uuid: 'u-2',
    } as any)
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'turn_status')
    if (events[0].kind === 'turn_status') {
      assert.equal(events[0].status, null)
    }
  })

  it('normalizes unknown status string to null (guards against CCB enum drift)', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'status',
      status: 'restoring',
      session_id: 'sess-1',
    } as any)
    parser.parse({
      type: 'system',
      subtype: 'status',
      status: 42,
      session_id: 'sess-1',
    } as any)
    parser.parse({
      type: 'system',
      subtype: 'status',
      session_id: 'sess-1',
    } as any)
    assert.equal(events.length, 3)
    for (const ev of events) {
      assert.equal(ev.kind, 'turn_status')
      if (ev.kind === 'turn_status') assert.equal(ev.status, null)
    }
  })

  it('maps native CCB api_retry into the controlled retrying turn status', () => {
    const { parser, events } = createParser()
    const before = Date.now()
    parser.parse({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 597.47,
      error: 'unknown',
    } as any)
    const after = Date.now()
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'turn_status')
    if (events[0].kind === 'turn_status') {
      if (typeof events[0].status === 'object' && events[0].status) {
        assert.equal(events[0].status.status, 'retrying')
        assert.equal(events[0].status.retry.attempt, 1)
        assert.equal(events[0].status.retry.max, 10)
        assert.equal(events[0].status.retry.delayMs, 597)
        assert.ok(events[0].status.retry.retryAt >= before + 597)
        assert.ok(events[0].status.retry.retryAt <= after + 598)
      } else assert.fail('expected retrying object status')
    }
  })

  it('ignores malformed native CCB api_retry metadata', () => {
    const { parser, events } = createParser()
    for (const raw of [
      { attempt: 0, max_retries: 10, retry_delay_ms: 1 },
      { attempt: Number.NaN, max_retries: 10, retry_delay_ms: 1 },
      { attempt: 1, max_retries: 0, retry_delay_ms: 1 },
      { attempt: 1, max_retries: 10, retry_delay_ms: -1 },
    ]) {
      parser.parse({ type: 'system', subtype: 'api_retry', ...raw } as any)
    }
    assert.equal(events.length, 0)
  })
})

// ── Phase 1: durable tools[] collection on TurnResult ──
// Why: SessionManager.persistServerAuthoredTurn pulls TurnResult.tools to send
// to the v3 sink so each completed top-level tool gets a `_source:'server'`
// row that survives refresh. Pin the rules:
//   - top-level (no parentToolUseId) tools are collected
//   - subagent tools are EXCLUDED (Phase 2 handles them separately)
//   - arrival order preserved (tool_result arrival, not tool_use)
//   - _capToolEntry caps output / inputJson with sentinel suffix
//   - completedTools is public so the interrupt/crash flush in sessionManager
//     can read whatever completed before CCB died
describe('CcbMessageParser: top-level tools collection (Phase 1)', () => {
  it('TurnResult.tools collects completed top-level tools in tool_result arrival order', () => {
    const { parser, getResult } = createParser()
    // tool_use A
    parser.parse({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_A', name: 'Bash', input: { cmd: 'ls' } }] },
    } as any)
    // tool_use B
    parser.parse({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_B', name: 'Read', input: { path: '/etc/hosts' } }] },
    } as any)
    // tool_result B arrives first
    parser.parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_B', content: 'host data' }] },
    } as any)
    // tool_result A arrives second
    parser.parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_A', content: 'a.txt b.txt' }] },
    } as any)
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)

    const result = getResult()
    assert.equal(result.tools.length, 2)
    // Order is by tool_result arrival: B first, then A
    assert.equal(result.tools[0].toolUseId, 'tu_B')
    assert.equal(result.tools[0].blockId, 'tu_B')
    assert.equal(result.tools[0].toolName, 'Read')
    assert.equal(result.tools[0].output, 'host data')
    assert.equal(result.tools[0].isError, false)
    assert.equal(result.tools[1].toolUseId, 'tu_A')
    assert.equal(result.tools[1].toolName, 'Bash')
    assert.equal(result.tools[1].output, 'a.txt b.txt')
    // inputJson preserved
    assert.deepEqual(result.tools[1].inputJson, { cmd: 'ls' })
    assert.deepEqual(result.tools[0].inputJson, { path: '/etc/hosts' })
  })

  it('subagent tools (parent_tool_use_id present) are NOT collected — Agent card owns durability', () => {
    // v1.0.135: the top-level Agent tool itself is ALSO excluded from
    // completedTools — the client renders it as `role: 'agent-group'`, and
    // persisting a parallel `srv-*-tool-*` row would collide on canonical
    // id with role mismatch (see ccbMessageParser.ts:832 docstring +
    // ccbMessageParserMessageId.test.ts "Agent tool" suite). Subagent tools
    // (parent_tool_use_id set) are also excluded — pre-v1.0.135 behavior.
    const { parser, getResult } = createParser()
    // Top-level Agent tool_use
    parser.parse({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { task: 'x' } }] },
    } as any)
    // Subagent issues a Bash tool_use (parent_tool_use_id = tu_agent)
    parser.parse({
      type: 'assistant',
      parent_tool_use_id: 'tu_agent',
      message: { content: [{ type: 'tool_use', id: 'tu_sub', name: 'Bash', input: { cmd: 'pwd' } }] },
    } as any)
    // Subagent's tool_result (parent_tool_use_id same)
    parser.parse({
      type: 'user',
      parent_tool_use_id: 'tu_agent',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_sub', content: '/' }] },
    } as any)
    // Top-level Agent tool_result
    parser.parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_agent', content: 'done' }] },
    } as any)
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)

    const result = getResult()
    // Both subagent (tu_sub) AND top-level Agent (tu_agent) are excluded.
    assert.equal(result.tools.length, 0,
      'Agent excluded by name filter; subagent tools excluded by parentToolUseId guard')
  })

  it('completedTools is publicly exposed for partial flush on interrupt/crash (sessionManager reads it)', () => {
    const { parser } = createParser()
    parser.parse({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_X', name: 'Bash', input: {} }] },
    } as any)
    parser.parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_X', content: 'partial' }] },
    } as any)
    // No `result` message — simulates CCB crashed mid-turn. SessionManager's
    // crash/interrupt handler reads parser.completedTools directly to flush.
    assert.equal(parser.completedTools.length, 1)
    assert.equal(parser.completedTools[0].toolUseId, 'tu_X')
    assert.equal(parser.completedTools[0].output, 'partial')
  })

  it('retains oversized tool output while keeping the live preview bounded', () => {
    const { parser, getResult, events } = createParser()
    parser.parse({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_big', name: 'Bash', input: {} }] },
    } as any)
    const longContent = 'y'.repeat(20 * 1024)
    parser.parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_big', content: longContent }] },
    } as any)
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)

    const result = getResult()
    assert.equal(result.tools.length, 1)
    const entry = result.tools[0]
    assert.equal(entry.output, longContent)
    const liveResult = events.find(
      (event) => event.kind === 'block' && event.block.kind === 'tool_result',
    )
    assert.ok(liveResult && liveResult.kind === 'block')
    assert.ok(String((liveResult.block as any).preview).length <= 3001)
  })

  it('retains the exact structured tool_result content alongside its text rendering', () => {
    const { parser, events, getResult } = createParser()
    parser.parse({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_struct', name: 'Read', input: {} }] },
    } as any)
    const structured = [
      { type: 'text', text: 'first' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
      { future_field: { nested: [1, 2, 3] } },
    ]
    parser.parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_struct', content: structured }] },
    } as any)
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)
    assert.deepEqual(getResult().tools[0].outputJson, structured)
    const liveResult = events.find(
      (event) => event.kind === 'block' && event.block.kind === 'tool_result',
    )
    assert.ok(liveResult && liveResult.kind === 'block')
    assert.deepEqual((liveResult.block as any).outputJson, structured)
  })

  it('retains oversized tool input values exactly', () => {
    const { parser, getResult } = createParser()
    const big = 'z'.repeat(20 * 1024)
    parser.parse({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_inp', name: 'Bash', input: { payload: big } }] },
    } as any)
    parser.parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_inp', content: 'ok' }] },
    } as any)
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)

    const result = getResult()
    const entry = result.tools[0]
    assert.equal(typeof entry.inputJson, 'object')
    const payload = (entry.inputJson as { payload: string }).payload
    assert.equal(payload, big)
  })

  it('retains many-field tool input exactly', () => {
    const { parser, getResult } = createParser()
    const fields: Record<string, string> = {}
    // 200 fields × ~50 char value + ~5 char key ≈ 11 KB — over 8 KB cap
    // but each value is below the 3000-char per-field threshold.
    for (let i = 0; i < 200; i++) {
      fields[`f${i}`] = 'a'.repeat(50)
    }
    parser.parse({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_many', name: 'Bash', input: fields }] },
    } as any)
    parser.parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_many', content: 'ok' }] },
    } as any)
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)

    const result = getResult()
    const entry = result.tools[0]
    assert.deepEqual(entry.inputJson, fields)
  })

  it('tool_result for a tool_use we never saw still records with empty input fallback', () => {
    const { parser, getResult } = createParser()
    // No prior tool_use — directly emit a tool_result. This can happen on
    // cross-turn replay (parser instantiated AFTER tool_use was emitted).
    parser.parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_orphan', content: 'x' }] },
    } as any)
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)

    const result = getResult()
    assert.equal(result.tools.length, 1)
    assert.equal(result.tools[0].toolUseId, 'tu_orphan')
    // Fallback: empty inputJson + empty inputPreview rather than crashing.
    assert.deepEqual(result.tools[0].inputJson, {})
    assert.equal(result.tools[0].inputPreview, '')
  })

  it('isError=true on tool_result propagates to TurnResult.tools[i].isError', () => {
    const { parser, getResult } = createParser()
    parser.parse({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_err', name: 'Bash', input: {} }] },
    } as any)
    parser.parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_err', content: 'oops', is_error: true }] },
    } as any)
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)

    const result = getResult()
    assert.equal(result.tools[0].isError, true)
  })

  it('empty tools[] when turn made no tool calls', () => {
    const { parser, getResult } = createParser()
    parser.parse({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'just text' } },
    } as any)
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)
    const result = getResult()
    assert.deepEqual(result.tools, [])
  })
})

describe('CcbMessageParser: lossless raw runtime tape', () => {
  it('retains assistant_error, progress, future system fields and exact result error', () => {
    const { parser, events, getResult } = createParser()
    const assistantError = {
      type: 'assistant_error',
      error: 'provider exact failure',
      future: { nested: ['kept', 7] },
    }
    const progress = {
      type: 'tool_progress',
      tool_use_id: 'tu-progress',
      elapsed_time_seconds: 12.5,
      full_output: 'x'.repeat(20_000),
    }
    const futureSystem = {
      type: 'system',
      subtype: 'future_task_event',
      payload: { every: 'field', values: Array.from({ length: 100 }, (_, i) => i) },
    }
    const resultMessage = {
      type: 'result',
      subtype: 'error_during_execution',
      total_cost_usd: 0.25,
      is_error: true,
      result: 'full provider response',
      errors: ['first exact error', 'second exact error'],
      usage: { input_tokens: 4, output_tokens: 5 },
    }
    parser.parse(assistantError as any)
    parser.parse(progress as any)
    parser.parse(futureSystem as any)
    parser.parse(resultMessage as any)

    const result = getResult()
    assert.deepEqual(result.runtimeEvents.map((event: any) => event.ordinal), [0, 1, 2, 3])
    assert.deepEqual(result.runtimeEvents.map((event: any) => event.payload), [
      assistantError,
      progress,
      futureSystem,
      resultMessage,
    ])
    assert.equal(result.errorDetail, JSON.stringify({
      subtype: 'error_during_execution',
      result: 'full provider response',
      errors: ['first exact error', 'second exact error'],
    }))
    assert.ok(events.some((event) =>
      event.kind === 'error' && event.error === 'provider exact failure'))
  })

  it('captures exact Codex JSON-RPC on a side channel without perturbing live events', () => {
    const { parser, events, getResult } = createParser()
    const raw = {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'printf exact',
          aggregatedOutput: 'y'.repeat(30_000),
          exitCode: 17,
          futureField: { untouched: true },
        },
      },
    }
    parser.captureRuntimeEvent(raw, 'codex-jsonrpc')
    assert.deepEqual(events, [])
    parser.parse({ type: 'result', total_cost_usd: 0, usage: {} } as any)
    const result = getResult()
    assert.equal(result.runtimeEvents[0].source, 'codex-jsonrpc')
    assert.deepEqual(result.runtimeEvents[0].payload, raw)
  })
})

console.log('CcbMessageParser tests passed.')
