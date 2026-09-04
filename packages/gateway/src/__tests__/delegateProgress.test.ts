import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  coalesceDelegateTranscript,
  formatDelegateLiveWorkingDetail,
  formatDelegateParentWorkingDetail,
  makeDelegateBlockPassthrough,
  makeDelegateProgressBlock,
  makeDelegateUsageProgressBlock,
  normalizeDelegateGoalKey,
  sanitizeDelegateProgressText,
  summarizeDelegateProgressEvent,
  summarizeDelegateToolForLiveHint,
} from '../delegateProgress.js'

describe('coalesceDelegateTranscript', () => {
  it('merges per-token text deltas into one block (Cursor grok regression)', () => {
    // Real shape from a cursor-grok-4.6-high delegate: one block per token.
    const tokens = ['我', '先', '读取', '这两个', '环境', '变量', '，', '再', '按', '要求', '只', '回', '一行', '。']
    const transcript = tokens.map((text) => ({ kind: 'text', text, messageId: 'a-1-s0' }))
    const out = coalesceDelegateTranscript(transcript)
    assert.deepEqual(out, [{ kind: 'text', text: '我先读取这两个环境变量，再按要求只回一行。', messageId: 'a-1-s0' }])
  })

  it('keeps tool blocks as boundaries and merges around them', () => {
    const out = coalesceDelegateTranscript([
      { kind: 'thinking', text: 'a' },
      { kind: 'thinking', text: 'b' },
      { kind: 'text', text: 'hel' },
      { kind: 'text', text: 'lo' },
      { kind: 'tool_use', blockId: 't1', toolName: 'Bash', inputJson: { command: 'env' } },
      { kind: 'tool_result', toolUseBlockId: 't1', output: 'x=1' },
      { kind: 'text', text: 'done' },
      { kind: 'text', text: '.' },
      { kind: 'final', meta: {} },
    ])
    assert.deepEqual(out, [
      { kind: 'thinking', text: 'ab' },
      { kind: 'text', text: 'hello' },
      { kind: 'tool_use', blockId: 't1', toolName: 'Bash', inputJson: { command: 'env' } },
      { kind: 'tool_result', toolUseBlockId: 't1', output: 'x=1' },
      { kind: 'text', text: 'done.' },
      { kind: 'final', meta: {} },
    ])
  })

  it('does not merge text into or across a thinking block', () => {
    const out = coalesceDelegateTranscript([
      { kind: 'text', text: 'a' },
      { kind: 'thinking', text: 'hmm' },
      { kind: 'text', text: 'b' },
    ])
    assert.deepEqual(out, [
      { kind: 'text', text: 'a' },
      { kind: 'thinking', text: 'hmm' },
      { kind: 'text', text: 'b' },
    ])
  })

  it('folds tool_use partial snapshots by blockId (INC-20260905 13079-child team card)', () => {
    // Real shape from a Cursor delegate Write: one snapshot per input_json_delta.
    const partials = Array.from({ length: 50 }, (_, i) => ({
      kind: 'tool_use',
      blockId: 'call_w',
      toolName: 'Write',
      messageId: 'm1',
      partial: true,
      inputPreview: '{"file_path":"/x"'.slice(0, Math.min(17, i + 1)),
      partialJsonDelta: 'x',
      partialJsonOffset: i,
    }))
    const finalSnap = {
      kind: 'tool_use',
      blockId: 'call_w',
      toolName: 'Write',
      messageId: 'm1',
      partial: false,
      inputPreview: '{"file_path":"/x"',
      inputJson: { file_path: '/x', content: 'hello' },
    }
    const out = coalesceDelegateTranscript([
      { kind: 'thinking', text: 'plan' },
      ...partials,
      { kind: 'tool_use', blockId: 'call_b', toolName: 'Bash', partial: true, inputPreview: '{"com' },
      finalSnap,
      { kind: 'tool_use', blockId: 'call_b', toolName: 'Bash', partial: false, inputJson: { command: 'ls' } },
      { kind: 'tool_result', toolUseBlockId: 'call_w', output: 'ok' },
      { kind: 'tool_result', toolUseBlockId: 'call_b', output: 'a b' },
      { kind: 'final', meta: {} },
    ])
    assert.equal(out.length, 6)
    assert.deepEqual(out[0], { kind: 'thinking', text: 'plan' })
    // First-seen position kept, latest content wins, streaming deltas dropped.
    assert.deepEqual(out[1], finalSnap)
    assert.deepEqual(out[2], {
      kind: 'tool_use', blockId: 'call_b', toolName: 'Bash', partial: false,
      inputPreview: '{"com', inputJson: { command: 'ls' },
    })
    assert.equal((out[3] as { kind: string }).kind, 'tool_result')
    assert.equal((out[4] as { kind: string }).kind, 'tool_result')
    assert.deepEqual(out[5], { kind: 'final', meta: {} })
    for (const b of out) {
      assert.ok(!('partialJsonDelta' in (b as object)), 'streaming delta must not persist')
    }
  })

  it('does not erase a final inputJson with a later inputJson-less snapshot and keeps distinct blockIds apart', () => {
    const out = coalesceDelegateTranscript([
      { kind: 'tool_use', blockId: 'a', toolName: 'Bash', partial: false, inputJson: { command: 'x' } },
      { kind: 'tool_use', blockId: 'a', toolName: 'Bash', partial: true, inputPreview: '{' },
      { kind: 'tool_use', blockId: 'b', toolName: 'Read', partial: false, inputJson: { file_path: '/y' } },
      { kind: 'tool_use', toolName: 'NoId', partial: true },
    ])
    assert.equal(out.length, 3)
    assert.deepEqual(out[0], { kind: 'tool_use', blockId: 'a', toolName: 'Bash', partial: false, inputJson: { command: 'x' }, inputPreview: '{' })
    assert.deepEqual(out[1], { kind: 'tool_use', blockId: 'b', toolName: 'Read', partial: false, inputJson: { file_path: '/y' } })
    assert.deepEqual(out[2], { kind: 'tool_use', toolName: 'NoId', partial: true })
  })

  it('treats nested-delegate marker blocks as hard boundaries', () => {
    const marker = {
      kind: 'text',
      text: '【嵌套委派 · researcher】\n目标：x\n状态：ok',
      _nestedDelegateRunId: 'dlg-2',
      _nestedDelegateAgentId: 'researcher',
      _nestedDelegateStatus: 'ok',
    }
    const out = coalesceDelegateTranscript([
      { kind: 'text', text: 'parent ' },
      { kind: 'text', text: 'says' },
      marker,
      { kind: 'text', text: 'child ' },
      { kind: 'text', text: 'says' },
    ])
    assert.deepEqual(out, [
      { kind: 'text', text: 'parent says' },
      marker,
      { kind: 'text', text: 'child says' },
    ])
  })

  it('drops empty text/thinking blocks and passes through non-object entries', () => {
    const out = coalesceDelegateTranscript([
      { kind: 'text', text: '' },
      { kind: 'thinking' },
      null,
      { kind: 'text', text: 'ok' },
      { kind: 'error', error: 'boom' },
    ])
    assert.deepEqual(out, [null, { kind: 'text', text: 'ok' }, { kind: 'error', error: 'boom' }])
  })

  it('does not mutate the input blocks', () => {
    const first = { kind: 'text', text: 'a' }
    const input = [first, { kind: 'text', text: 'b' }]
    coalesceDelegateTranscript(input)
    assert.equal(first.text, 'a')
    assert.equal(input.length, 2)
  })
})

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

describe('parent live-row working-detail from delegate_progress', () => {
  it('formats member + tool + command, with ×N for parallel', () => {
    assert.equal(
      formatDelegateLiveWorkingDetail({
        agentLabel: '编程助手',
        toolName: 'Bash',
        summary: 'npm run build',
      }),
      '子任务 编程助手: Bash npm run build',
    )
    assert.equal(
      formatDelegateLiveWorkingDetail({
        agentLabel: '编程助手',
        toolName: 'Read',
        summary: 'foo.ts',
        parallelCount: 2,
      }),
      '子任务 编程助手: Read foo.ts ×2',
    )
    assert.equal(
      formatDelegateLiveWorkingDetail({ agentLabel: '编程助手' }),
      '子任务 编程助手',
    )
  })

  it('does not leak oc-memory --goal / Task prompt in the live hint', () => {
    assert.equal(
      summarizeDelegateToolForLiveHint({
        inputJson: { command: 'HOME=/x oc-memory delegate --goal "整段 prompt 不可泄漏"' },
      }),
      '',
    )
    assert.equal(
      summarizeDelegateToolForLiveHint({
        inputJson: { command: 'npm run build -- --watch' },
      }),
      'npm run build -- --watch',
    )
    assert.equal(
      summarizeDelegateToolForLiveHint({
        inputJson: {
          description: '修卡片',
          prompt: 'You are running inside OpenClaude uid=3 HOME=/home/agent',
        },
      }),
      '修卡片',
    )
  })

  it('emits working-detail for start and tool_use, not for results', () => {
    const start = makeDelegateProgressBlock({
      runId: 'r1',
      agentId: 'coding-assistant',
      phase: 'start',
      text: '开始委派',
      goal: '修卡片',
    })
    assert.equal(
      formatDelegateParentWorkingDetail({ block: start, agentLabel: '编程助手' }),
      '子任务 编程助手',
    )

    const toolUse = makeDelegateBlockPassthrough(
      {
        kind: 'block',
        block: {
          kind: 'tool_use',
          toolName: 'Bash',
          inputPreview: 'npm run build',
          inputJson: { command: 'npm run build' },
        },
      },
      'r1',
      'coding-assistant',
    )
    assert.ok(toolUse)
    assert.equal(
      formatDelegateParentWorkingDetail({
        block: toolUse!,
        agentLabel: '编程助手',
        parallelCount: 1,
      }),
      '子任务 编程助手: Bash npm run build',
    )

    const result = makeDelegateBlockPassthrough(
      {
        kind: 'block',
        block: { kind: 'tool_result', toolName: 'Bash', isError: false, preview: 'ok' },
      },
      'r1',
      'coding-assistant',
    )
    assert.equal(
      formatDelegateParentWorkingDetail({ block: result!, agentLabel: '编程助手' }),
      null,
    )
  })

  it('_runDelegateTaskCore emitProgress forwards parent working-detail on the existing turn_status channel', () => {
    const src = readFileSync(
      join(fileURLToPath(new URL('..', import.meta.url)), 'server.ts'),
      'utf8',
    )
    assert.match(src, /formatDelegateParentWorkingDetail/)
    assert.match(src, /_buildTurnStatusFrame\([\s\S]{0,500}status: 'working'/)
  })
})
