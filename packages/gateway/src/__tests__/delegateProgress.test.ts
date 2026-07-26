import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  makeDelegateBlockPassthrough,
  makeDelegateProgressBlock,
  makeDelegateUsageProgressBlock,
  normalizeDelegateGoalKey,
  sanitizeDelegateProgressText,
  summarizeDelegateProgressEvent,
} from '../delegateProgress.js'

describe('delegate progress sanitization', () => {
  it('strips control chars and truncates text', () => {
    const out = sanitizeDelegateProgressText(` hello\u0000\u0007  world ${'x'.repeat(20)}`, 16)
    assert.equal(out, 'hello world xxx…')
  })

  it('streams text as a delegate_progress compatibility summary', () => {
    const block = summarizeDelegateProgressEvent(
      { kind: 'block', block: { kind: 'text', text: 'child result' } },
      'run-1',
      'researcher',
    )
    assert.deepEqual(block, {
      kind: 'delegate_progress',
      runId: 'run-1',
      agentId: 'researcher',
      phase: 'text',
      text: 'child result',
    })
  })

  it('drops chain-of-thought so the delegate card is not a wall of reasoning', () => {
    const block = summarizeDelegateProgressEvent(
      { kind: 'block', block: { kind: 'thinking', text: 'let me reason about this privately' } },
      'run-1',
      'researcher',
    )
    assert.equal(block, null)
  })

  it('preserves text delta edge whitespace so browser merging keeps word boundaries', () => {
    const block = summarizeDelegateProgressEvent(
      { kind: 'block', block: { kind: 'text', text: ' world' } },
      'run-1',
      'researcher',
    )
    assert.equal(block?.text, ' world')
  })

  it('does not expose raw tool_result preview or tail output', () => {
    const result = summarizeDelegateProgressEvent(
      {
        kind: 'block',
        block: {
          kind: 'tool_result',
          toolName: 'Bash',
          isError: false,
          preview: 'SECRET_TOKEN=abc123',
        },
      },
      'run-1',
      'coder',
    )
    assert.equal(result?.text, 'Bash 执行完成')
    assert.doesNotMatch(JSON.stringify(result), /SECRET_TOKEN/)

    const tail = summarizeDelegateProgressEvent(
      {
        kind: 'block',
        block: {
          kind: 'tool_output_tail',
          tail: 'SECRET_TAIL',
          totalBytes: 11,
          truncatedHead: false,
        },
      },
      'run-1',
      'coder',
    )
    assert.doesNotMatch(JSON.stringify(tail), /SECRET_TAIL/)
  })

  it('keeps tool_use input to a short preview and omits parsed inputJson', () => {
    const block = summarizeDelegateProgressEvent(
      {
        kind: 'block',
        block: {
          kind: 'tool_use',
          toolName: 'Read',
          inputPreview: 'path=/tmp/example.txt',
          inputJson: { path: '/tmp/example.txt', secret: 'nope' },
        },
      },
      'run-1',
      'coder',
    )
    assert.match(block?.text || '', /调用工具 Read/)
    assert.doesNotMatch(JSON.stringify(block), /nope/)
  })

  it('allows delegate completion summaries to use a larger explicit limit', () => {
    const block = makeDelegateProgressBlock({
      runId: 'run-1',
      agentId: 'reviewer',
      phase: 'done',
      text: 'x'.repeat(1200),
      maxLen: 1200,
    })
    assert.equal(block.text?.length, 1200)
  })

  it('carries goal on the start frame as the (agentId, goal) correlation key', () => {
    const block = makeDelegateProgressBlock({
      runId: 'run-1',
      agentId: 'researcher',
      phase: 'start',
      text: '开始委派给 researcher: 调研黄金趋势',
      goal: '调研黄金趋势',
    })
    assert.equal(block.goal, '调研黄金趋势')
  })

  it('omits goal when not provided (only the start frame carries it)', () => {
    const block = makeDelegateProgressBlock({
      runId: 'run-1',
      agentId: 'researcher',
      phase: 'text',
      text: 'partial output',
    })
    assert.equal('goal' in block, false)
  })

  it('carries one exact child run absolute usage snapshot without text projection', () => {
    const block = makeDelegateUsageProgressBlock({
      runId: 'visible-run',
      usageRunId: 'exact-child-run',
      agentId: 'researcher',
      usage: { totalTokens: 321, inputTokens: 300, outputTokens: 21 },
    })
    assert.deepEqual(block, {
      kind: 'delegate_progress',
      runId: 'visible-run',
      usageRunId: 'exact-child-run',
      agentId: 'researcher',
      phase: 'usage',
      usage: { totalTokens: 321, inputTokens: 300, outputTokens: 21 },
    })
  })
})

describe('normalizeDelegateGoalKey (frontend-matched correlation key)', () => {
  it('normalizes newlines and trims without folding internal whitespace', () => {
    // Internal double-space is preserved (unlike sanitizeDelegateProgressText)
    // so it stays byte-identical to the leader tool_use input.goal the frontend
    // compares against (which applies the same trim + slice).
    assert.equal(normalizeDelegateGoalKey('  a\r\nb  c  \r\n'), 'a\nb  c')
  })

  it('caps overlong goals so the wire field stays bounded', () => {
    assert.equal(normalizeDelegateGoalKey('x'.repeat(2000)).length, 1024)
  })

  it('coerces null/undefined to empty string', () => {
    assert.equal(normalizeDelegateGoalKey(undefined), '')
    assert.equal(normalizeDelegateGoalKey(null), '')
  })
})

describe('makeDelegateBlockPassthrough (rich forward for main-chat-style rendering)', () => {
  it('forwards full text block + keeps legacy phase/text', () => {
    const out = makeDelegateBlockPassthrough(
      { kind: 'block', block: { kind: 'text', text: 'hi there' } },
      'r1',
      'researcher',
    ) as any
    assert.equal(out.kind, 'delegate_progress')
    assert.equal(out.phase, 'text')
    assert.equal(out.text, 'hi there') // legacy fallback for old clients
    assert.deepEqual(out.block, { kind: 'text', text: 'hi there' }) // rich payload
  })

  it('forwards thinking (no longer dropped) as a frame with block + phase=thinking', () => {
    const out = makeDelegateBlockPassthrough(
      { kind: 'block', block: { kind: 'thinking', text: 'let me reason' } },
      'r1',
      'researcher',
    ) as any
    assert.notEqual(out, null)
    assert.equal(out.phase, 'thinking')
    assert.deepEqual(out.block, { kind: 'thinking', text: 'let me reason' })
  })

  it('forwards tool_use with full inputJson (not truncated to 180) + preserves whitespace', () => {
    const code = 'def f():\n    return  1' // double space + indent must survive
    const out = makeDelegateBlockPassthrough(
      {
        kind: 'block',
        block: { kind: 'tool_use', blockId: 'b1', toolName: 'Write', inputPreview: 'x', inputJson: code, partial: false },
      },
      'r1',
      'coder',
    ) as any
    assert.equal(out.phase, 'tool')
    assert.equal(out.block.kind, 'tool_use')
    assert.equal(out.block.blockId, 'b1')
    assert.equal(out.block.inputJson, code) // whitespace/indent preserved, not collapsed
  })

  it('forwards complete tool_result and structured plan records; returns null for non-block', () => {
    const exactOutput = `${'x'.repeat(40_000)}EXACT_DELEGATE_TOOL_END`
    const tr = makeDelegateBlockPassthrough(
      { kind: 'block', block: { kind: 'tool_result', blockId: 'b1:result', toolUseBlockId: 'b1', toolName: 'Bash', isError: true, preview: 'boom', output: exactOutput } },
      'r1',
      'coder',
    ) as any
    assert.equal(tr.block.kind, 'tool_result')
    assert.equal(tr.block.isError, true)
    assert.equal(tr.block.preview, 'boom')
    assert.equal(tr.block.output, exactOutput)
    assert.deepEqual(
      (makeDelegateBlockPassthrough(
        { kind: 'block', block: { kind: 'plan', steps: [{ step: '完整步骤', status: 'pending' }] } },
        'r1',
        'a',
      ) as any).block,
      { kind: 'plan', steps: [{ step: '完整步骤', status: 'pending' }] },
    )
    assert.equal(makeDelegateBlockPassthrough({ kind: 'error', error: 'x' }, 'r1', 'a'), null)
  })

  it('does not rewrite or truncate authoritative rich text', () => {
    const text = `a b\u0007c\td\ne${'z'.repeat(40_000)}EXACT_RICH_END`
    const out = makeDelegateBlockPassthrough(
      { kind: 'block', block: { kind: 'text', text } },
      'r1',
      'a',
    ) as any
    assert.equal(out.block.text, text)
  })
})
