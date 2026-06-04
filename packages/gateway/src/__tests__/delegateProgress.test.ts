import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  makeDelegateProgressBlock,
  sanitizeDelegateProgressText,
  summarizeDelegateProgressEvent,
} from '../delegateProgress.js'

describe('delegate progress sanitization', () => {
  it('strips control chars and truncates text', () => {
    const out = sanitizeDelegateProgressText(` hello\u0000\u0007  world ${'x'.repeat(20)}`, 16)
    assert.equal(out, 'hello world xxx…')
  })

  it('streams text and thinking as bounded delegate_progress blocks', () => {
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
})
