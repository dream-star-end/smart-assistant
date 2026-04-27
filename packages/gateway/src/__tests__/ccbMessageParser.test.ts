/**
 * Unit tests for CcbMessageParser.
 * Tests the CCB stream-json message parsing logic in isolation.
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbMessageParser.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CcbMessageParser, type SessionStreamEvent } from '../ccbMessageParser.js'

function createParser(opts?: { onToolUse?: (t: any) => void }) {
  const events: SessionStreamEvent[] = []
  let finished = false
  let finishResult: any = null
  const toolUseIdToName = new Map<string, string>()

  const parser = new CcbMessageParser({
    toolUseIdToName,
    onEvent: (e) => events.push(e),
    onToolUse: opts?.onToolUse,
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

  it('truncates long previews to 500 chars', () => {
    const { parser, events, toolUseIdToName } = createParser()
    toolUseIdToName.set('tu_6', 'Bash')

    parser.parse({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_6', content: 'x'.repeat(1000) }],
      },
    } as any)

    if (events[0].kind === 'block' && events[0].block.kind === 'tool_result') {
      assert.ok((events[0].block as any).preview.length <= 501) // 500 + '…'
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
})

console.log('CcbMessageParser tests passed.')
