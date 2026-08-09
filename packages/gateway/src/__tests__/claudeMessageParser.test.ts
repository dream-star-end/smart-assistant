/**
 * Unit tests for ClaudeMessageParser.
 * Tests the claude stream-json message parsing logic in isolation.
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbMessageParser.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ClaudeMessageParser, type SessionStreamEvent } from '../claudeMessageParser.js'

function createParser(opts?: { onToolUse?: (t: any) => void }) {
  const events: SessionStreamEvent[] = []
  let finished = false
  let finishResult: any = null
  const toolUseIdToName = new Map<string, string>()

  const parser = new ClaudeMessageParser({
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
describe('ClaudeMessageParser: text streaming', () => {
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

  it('emits goal blocks from codex openclaude_goal payloads', () => {
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
        createdAt: 1779999999,
        updatedAt: 1780000000,
        cleared: false,
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
      assert.equal(b.createdAt, 1779999999)
      assert.equal(b.updatedAt, 1780000000)
      assert.equal(b.cleared, false)
    }
    assert.equal(parser.assistantBuf, '')
  })
})

// ── System status ──
describe('ClaudeMessageParser: system status', () => {
  it('tracks compaction and emits turn_status side-channel events', () => {
    const { parser, events } = createParser()

    parser.parse({ type: 'system', subtype: 'status', status: 'compacting' } as any)
    parser.parse({ type: 'system', subtype: 'status', status: 'compacting' } as any)

    assert.equal(parser.isCompacting, true)
    assert.equal(events.length, 2)
    assert.deepEqual(events[0], { kind: 'turn_status', status: 'compacting' })
    assert.deepEqual(events[1], { kind: 'turn_status', status: 'compacting' })

    parser.parse({ type: 'system', subtype: 'status', status: null } as any)
    assert.equal(parser.isCompacting, false)
    assert.deepEqual(events[2], { kind: 'turn_status', status: null })
  })
})

// ── Tool use ──
describe('ClaudeMessageParser: tool_use', () => {
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

  it('keeps a large tool input exact while shortening only its preview', () => {
    const { parser, events } = createParser()
    const content = '完整输入'.repeat(3000)

    parser.parse({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_large_input',
            name: 'Write',
            input: { file: 'large.txt', content },
          },
        ],
      },
    } as any)

    assert.equal(events.length, 1)
    if (events[0].kind === 'block') {
      const block = events[0].block as any
      assert.ok(block.inputPreview.length <= 400)
      assert.equal(block.inputJson.content, content)
      assert.equal(Buffer.byteLength(block.inputJson.content), Buffer.byteLength(content))
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
describe('ClaudeMessageParser: tool_result', () => {
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

  it('keeps the complete tool result while shortening only its preview', () => {
    const { parser, events, toolUseIdToName } = createParser()
    toolUseIdToName.set('tu_6', 'Bash')

    parser.parse({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_6', content: 'x'.repeat(4000) }],
      },
    } as any)

    if (events[0].kind === 'block' && events[0].block.kind === 'tool_result') {
      const preview = (events[0].block as any).preview
      assert.equal(preview.length, 3001) // 3000 + '…'
      assert.ok(preview.endsWith('…'))
      assert.equal((events[0].block as any).output, 'x'.repeat(4000))
      assert.equal((events[0].block as any).outputJson, 'x'.repeat(4000))
    }
  })
})

// ── Result / finalization ──
describe('ClaudeMessageParser: result', () => {
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

  it('computes per-turn cost as delta of claude cumulative total_cost_usd', () => {
    // Shared sessionTotals (mimics gateway holding per-session reference)
    const sessionTotals = { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 }
    const mkParser = () => {
      let result: any = null
      const parser = new ClaudeMessageParser({
        toolUseIdToName: new Map(),
        onEvent: () => {},
        onFinish: (r) => {
          result = r
        },
        sessionTotals,
      })
      return { parser, getResult: () => result }
    }

    // Turn 1: claude reports cumulative 0.05 → delta = 0.05
    const t1 = mkParser()
    t1.parser.parse({ type: 'result', total_cost_usd: 0.05, usage: {} } as any)
    assert.equal(t1.getResult().cost, 0.05)
    assert.equal(sessionTotals.totalCostUSD, 0.05)
    assert.equal(sessionTotals._lastCcbCumulativeCost, 0.05)

    // Turn 2: claude reports cumulative 0.12 → delta = 0.07 (NOT 0.12)
    const t2 = mkParser()
    t2.parser.parse({ type: 'result', total_cost_usd: 0.12, usage: {} } as any)
    assert.ok(Math.abs(t2.getResult().cost - 0.07) < 1e-9)
    assert.ok(Math.abs(sessionTotals.totalCostUSD - 0.12) < 1e-9)

    // Turn 3 (phantom-style): cumulative unchanged → delta = 0
    const t3 = mkParser()
    t3.parser.parse({ type: 'result', total_cost_usd: 0.12, usage: {} } as any)
    assert.equal(t3.getResult().cost, 0)
    assert.ok(Math.abs(sessionTotals.totalCostUSD - 0.12) < 1e-9)

    // Turn 4: claude process restarted (cumulative drops to 0.03) → delta = 0.03
    const t4 = mkParser()
    t4.parser.parse({ type: 'result', total_cost_usd: 0.03, usage: {} } as any)
    assert.equal(t4.getResult().cost, 0.03)
    assert.ok(Math.abs(sessionTotals.totalCostUSD - 0.15) < 1e-9)
    assert.equal(sessionTotals._lastCcbCumulativeCost, 0.03)
  })

  it('attributes full cost after gateway-initiated claude restart (cumulative ≥ old prev)', () => {
    // Simulates gateway flow: after AUTH_ERROR / PHANTOM_TURN / effort-change
    // the gateway shuts down claude and resets _lastCcbCumulativeCost to 0 before
    // the next turn. Without that reset, a new claude whose first turn costs more
    // than the old process's final cumulative would be UNDER-counted.
    const sessionTotals = { totalCostUSD: 0.01, turns: 1, _lastCcbCumulativeCost: 0.01 }
    // Gateway respawns claude and explicitly resets the tracker:
    sessionTotals._lastCcbCumulativeCost = 0

    // First turn on the fresh claude reports cumulative 0.03 (real per-turn cost).
    let result: any = null
    const parser = new ClaudeMessageParser({
      toolUseIdToName: new Map(),
      onEvent: () => {},
      onFinish: (r) => {
        result = r
      },
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
describe('ClaudeMessageParser: system', () => {
  it('ignores system messages silently', () => {
    const { parser, events } = createParser()
    parser.parse({ type: 'system', session_id: 'test-123' } as any)
    assert.equal(events.length, 0)
  })

  it('ignores system/bash_output_tail (fork-only side-channel; official claude never emits it)', () => {
    // The old in-repo fork emitted a 1 Hz bash tail as a source patch to its
    // BashTool. Official Claude Code has no such message in headless stream-json
    // mode, so the parser no longer special-cases it — it's just an ignored
    // system subtype now (no tool_output_tail block).
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'bash_output_tail',
      tool_use_id: 'toolu_bash_123',
      tail: 'line1\nline2\n',
      total_bytes: 12,
      truncated_head: false,
    } as any)
    assert.equal(events.length, 0)
  })

  it('ignores non-workflow system subtypes (init) and rows without task_id', () => {
    const { parser, events } = createParser()
    parser.parse({ type: 'system', subtype: 'init', session_id: 'x' } as any)
    // task_* without a task_id is not a recognised workflow row → no event.
    parser.parse({ type: 'system', subtype: 'task_progress' } as any)
    assert.equal(events.length, 0)
  })
})

// ── Background-workflow (ultracode) progress side-channel ──
describe('ClaudeMessageParser: workflow_progress side-channel', () => {
  it('task_started → workflow_progress{stage:started} with name/tool/description', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'task_started',
      task_id: 'w2hh61dpp',
      tool_use_id: 'toolu_abc',
      description: 'Run two parallel agents',
      task_type: 'local_workflow',
      workflow_name: 'minimal-parallel-ok',
      prompt: 'export const meta = {...}',
    } as any)
    assert.equal(events.length, 1)
    const e = events[0] as any
    assert.equal(e.kind, 'workflow_progress')
    assert.equal(e.stage, 'started')
    assert.equal(e.taskId, 'w2hh61dpp')
    assert.equal(e.toolUseId, 'toolu_abc')
    assert.equal(e.workflowName, 'minimal-parallel-ok')
    assert.equal(e.description, 'Run two parallel agents')
  })

  it('task_progress → carries usage (snake→camel) + workflow_progress items', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'w2hh61dpp',
      tool_use_id: 'toolu_abc',
      description: 'Run: agent-2',
      last_tool_name: 'agent-2',
      summary: 'Run two parallel agents',
      usage: { total_tokens: 11390, tool_uses: 0, duration_ms: 2136 },
      workflow_progress: [
        { type: 'workflow_agent', index: 2, label: 'agent-2', phaseTitle: 'Run', state: 'done' },
      ],
    } as any)
    assert.equal(events.length, 1)
    const e = events[0] as any
    assert.equal(e.stage, 'progress')
    assert.equal(e.lastTool, 'agent-2')
    assert.deepEqual(e.usage, { totalTokens: 11390, toolUses: 0, durationMs: 2136 })
    assert.equal(e.items.length, 1)
    assert.equal(e.items[0].label, 'agent-2')
    assert.equal(e.items[0].state, 'done')
  })

  it('tolerates usage/workflow_progress arriving as JSON strings', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      usage: '{"total_tokens": 5, "tool_uses": 1, "duration_ms": 99}',
      workflow_progress: '[{"type":"workflow_phase","index":1,"title":"Run"}]',
    } as any)
    const e = events[0] as any
    assert.deepEqual(e.usage, { totalTokens: 5, toolUses: 1, durationMs: 99 })
    assert.equal(e.items[0].title, 'Run')
  })

  it('task_updated{completed} → workflow_progress{stage:updated,status:completed}', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'w2hh61dpp',
      patch: { status: 'completed', end_time: 1782059427031 },
    } as any)
    assert.equal(events.length, 1)
    const e = events[0] as any
    assert.equal(e.stage, 'updated')
    assert.equal(e.status, 'completed')
  })

  it('workflow_progress is a side-channel: never a block, never finalizes', () => {
    const { parser, events, getFinished } = createParser()
    parser.parse({ type: 'system', subtype: 'task_started', task_id: 't1' } as any)
    parser.parse({
      type: 'system',
      subtype: 'task_updated',
      task_id: 't1',
      patch: { status: 'completed' },
    } as any)
    assert.equal(getFinished(), false)
    assert.ok(events.every((e) => e.kind === 'workflow_progress'))
  })
})

// ── Stable text/thinking blockId (Phase 1 — agent-display-identity root-fix) ──
describe('ClaudeMessageParser: stable text/thinking blockId', () => {
  const sev = (event: any) => ({ type: 'stream_event', event }) as any
  const delta = (index: number, d: any) => sev({ type: 'content_block_delta', index, delta: d })

  it('text block carries blockId `${messageId}:${index}` after message_start', () => {
    const { parser, events } = createParser()
    parser.parse(sev({ type: 'message_start', message: { id: 'msg_abc' } }))
    parser.parse(delta(0, { type: 'text_delta', text: 'Hello' }))
    assert.equal(events.length, 1)
    if (events[0].kind === 'block') assert.equal((events[0].block as any).blockId, 'msg_abc:0')
  })

  it('thinking block uses the same blockId scheme', () => {
    const { parser, events } = createParser()
    parser.parse(sev({ type: 'message_start', message: { id: 'msg_t' } }))
    parser.parse(delta(1, { type: 'thinking_delta', thinking: 'hmm' }))
    if (events[0].kind === 'block') assert.equal((events[0].block as any).blockId, 'msg_t:1')
  })

  it('multiple deltas of the SAME content-block index share ONE blockId (web routes to one message)', () => {
    const { parser, events } = createParser()
    parser.parse(sev({ type: 'message_start', message: { id: 'msg_x' } }))
    parser.parse(delta(0, { type: 'text_delta', text: 'Hel' }))
    parser.parse(delta(0, { type: 'text_delta', text: 'lo' }))
    assert.equal(events.length, 2)
    assert.deepEqual(
      events.map((e) => (e.kind === 'block' ? (e.block as any).blockId : null)),
      ['msg_x:0', 'msg_x:0'],
    )
  })

  it('tool-separated text segments (different content-block index) get DISTINCT blockIds', () => {
    const { parser, events } = createParser()
    parser.parse(sev({ type: 'message_start', message: { id: 'msg_y' } }))
    parser.parse(delta(0, { type: 'text_delta', text: 'before' }))
    parser.parse(delta(2, { type: 'text_delta', text: 'after' }))
    assert.deepEqual(
      events.filter((e) => e.kind === 'block').map((e) => (e.block as any).blockId),
      ['msg_y:0', 'msg_y:2'],
    )
  })

  it('falls back to `:index` when message_start was not seen (turnId prefix disambiguates cross-turn)', () => {
    const { parser, events } = createParser()
    parser.parse(delta(0, { type: 'text_delta', text: 'orphan' }))
    if (events[0].kind === 'block') assert.equal((events[0].block as any).blockId, ':0')
  })

  it('synthetic API-error assistant text also carries a blockId', () => {
    const { parser, events } = createParser()
    parser.parse({
      type: 'assistant',
      error: 'API error',
      message: { id: 'msg_err', content: [{ type: 'text', text: 'rate limited' }] },
    } as any)
    assert.equal(events.length, 1)
    if (events[0].kind === 'block') {
      assert.equal(events[0].block.kind, 'text')
      assert.equal((events[0].block as any).blockId, 'msg_err:0')
    }
  })
})

console.log('ClaudeMessageParser tests passed.')
