/**
 * Unit tests for CcbMessageParser.
 * Tests the CCB stream-json message parsing logic in isolation.
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbMessageParser.test.ts
 */
import { Buffer } from 'node:buffer'
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CcbMessageParser,
  MAX_THINKING_BUFFER_BYTES,
  type SessionStreamEvent,
} from '../ccbMessageParser.js'

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

  it('caps thinkingBuf at MAX_THINKING_BUFFER_BYTES with truncation tail', () => {
    const { parser } = createParser()
    // Generate 16KB of ASCII (well over the 8KB cap)
    const giant = 'a'.repeat(16 * 1024)
    emitThinking(parser, giant)
    const bufBytes = Buffer.byteLength(parser.thinkingBuf, 'utf8')
    assert.ok(bufBytes <= MAX_THINKING_BUFFER_BYTES, `bufBytes ${bufBytes} <= cap ${MAX_THINKING_BUFFER_BYTES}`)
    assert.ok(parser.thinkingBuf.endsWith('…[truncated]'), 'tail marker present')
  })

  it('truncated flag is sticky: subsequent deltas are dropped', () => {
    const { parser } = createParser()
    emitThinking(parser, 'a'.repeat(16 * 1024))
    const lenAfter1 = parser.thinkingBuf.length
    emitThinking(parser, 'should be ignored')
    emitThinking(parser, 'also ignored')
    assert.equal(parser.thinkingBuf.length, lenAfter1, 'no growth after first truncation')
  })

  it('UTF-8 multi-byte boundary safe (does not split CJK characters)', () => {
    const { parser } = createParser()
    // Each Chinese char is 3 bytes in UTF-8. Build a string that lands the
    // cap cut squarely inside a multi-byte sequence to verify we walk back
    // to a leading byte instead of producing U+FFFD.
    const cjk = '中' // 3 bytes
    // Use enough '中' to push us well past the cap on a sub-byte alignment.
    const giant = cjk.repeat(4096) // 12 KB total
    emitThinking(parser, giant)
    // Decode round-trip should produce no replacement character before tail.
    const beforeTail = parser.thinkingBuf.replace(/…\[truncated\]$/u, '')
    assert.ok(!beforeTail.includes('\uFFFD'), 'no replacement character in truncated buffer')
    // Every preserved byte triplet must form a valid CJK char.
    for (const ch of beforeTail) {
      assert.equal(ch, '中', `unexpected char ${ch.codePointAt(0)?.toString(16)}`)
    }
  })

  it('UTF-8 4-byte sequence boundary safe (does not split emoji)', () => {
    // Emoji like 😀 (U+1F600) is 4 bytes in UTF-8 and surfaces as a JS
    // surrogate pair. The slice-back loop must walk all 3 continuation
    // bytes back to the lead byte for a clean cut. Failing to do so would
    // leave an orphan high surrogate or invalid byte sequence.
    const { parser } = createParser()
    const emoji = '😀' // 4 bytes UTF-8, 2 JS code units (surrogate pair)
    const giant = emoji.repeat(2200) // ≈ 8800 bytes — over the 8KB cap
    emitThinking(parser, giant)
    const beforeTail = parser.thinkingBuf.replace(/…\[truncated\]$/u, '')
    assert.ok(!beforeTail.includes('\uFFFD'), 'no replacement char in truncated buffer')
    // Every code point must be the full emoji (not an orphan surrogate).
    for (const ch of beforeTail) {
      assert.equal(ch, emoji, `unexpected code point 0x${ch.codePointAt(0)?.toString(16)}`)
    }
    // Bytes still under cap.
    const bufBytes = Buffer.byteLength(parser.thinkingBuf, 'utf8')
    assert.ok(bufBytes <= MAX_THINKING_BUFFER_BYTES, `bufBytes ${bufBytes} <= cap`)
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

  it('truncates long previews to 3000 chars', () => {
    const { parser, events, toolUseIdToName } = createParser()
    toolUseIdToName.set('tu_6', 'Bash')

    parser.parse({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_6', content: 'x'.repeat(5000) }],
      },
    } as any)

    assert.equal(events.length, 1)
    if (events[0].kind === 'block' && events[0].block.kind === 'tool_result') {
      assert.ok((events[0].block as any).preview.length <= 3001) // 3000 + '…'
      assert.ok((events[0].block as any).preview.length > 3000)
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
    // Only the top-level Agent tool is recorded; tu_sub excluded.
    assert.equal(result.tools.length, 1)
    assert.equal(result.tools[0].toolUseId, 'tu_agent')
    assert.equal(result.tools[0].toolName, 'Agent')
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

  it('_capToolEntry truncates oversized output and stamps outputTruncated=true', () => {
    const { parser, getResult } = createParser()
    parser.parse({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_big', name: 'Bash', input: {} }] },
    } as any)
    // 9 KB of content — _handleUser caps preview at 3000 chars, so
    // _capToolEntry receives a 3001-char string and won't trigger output cap
    // (PARSER_TOOL_OUTPUT_MAX_BYTES is 8 KB). Use 3000-cap-aware case below.
    // To verify the parser-level cap actually fires, send the result with a
    // very large content array — preview building converts each block to
    // JSON, which can grow past the 3000 cap before slicing applies.
    const longContent = 'y'.repeat(20 * 1024)
    parser.parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_big', content: longContent }] },
    } as any)
    parser.parse({ type: 'result', total_cost_usd: 0.01, usage: {} } as any)

    const result = getResult()
    assert.equal(result.tools.length, 1)
    const entry = result.tools[0]
    // _handleUser caps preview to 3000 chars + `…`. Output is the preview, so
    // it is bounded but may not trigger _capToolEntry's 8 KB cap.
    assert.ok(entry.output.length <= 3001, 'preview cap applied at _handleUser level')
  })

  it('inputJson cap: per-field cap shrinks oversized string values to 3000 chars + ellipsis', () => {
    // Two-tier cap: _handleAssistant first applies a per-string-field 3000-char
    // cap when the full input > 8000 chars. _capToolEntry's overall-bytes cap
    // is a backstop for many-small-fields edge cases. The common path (one
    // huge payload field) hits the per-field cap.
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
    // _handleAssistant's per-field cap kicks in first → object preserved with
    // each oversized string truncated to 3000 chars + '…' (3001 total).
    assert.equal(typeof entry.inputJson, 'object')
    const payload = (entry.inputJson as { payload: string }).payload
    assert.equal(payload.length, 3001)
    assert.ok(payload.endsWith('…'))
    // Final blob fits well under the master schema cap (16 KB).
    assert.ok(JSON.stringify(entry.inputJson).length <= 16 * 1024)
  })

  it('inputJson backstop cap: many-small-fields path triggers _capToolEntry sentinel + inputTruncated=true', () => {
    // Each value is < 3000 chars, so _handleAssistant's per-field cap does NOT
    // fire; total serialized size still > PARSER_TOOL_INPUT_JSON_MAX_BYTES (8 KB).
    // _capToolEntry's overall-byte cap kicks in with the JSON-encoded sentinel.
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
    // Backstop triggers: serialized string with sentinel suffix.
    assert.equal(typeof entry.inputJson, 'string')
    assert.ok((entry.inputJson as string).endsWith('…[truncated]'))
    assert.equal(entry.inputTruncated, true)
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

console.log('CcbMessageParser tests passed.')
