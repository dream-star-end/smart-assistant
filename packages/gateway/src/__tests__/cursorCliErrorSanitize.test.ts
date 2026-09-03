import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CURSOR_CLI_FAILURE_DETAIL_MAX,
  formatCursorCliFailureDetail,
  formatCursorCliFailureLog,
  sanitizeCursorCliError,
} from '../engine/cursorCliErrorSanitize.js'

describe('cursor CLI error sanitization', () => {
  test('keeps the first-line Sand root cause under the tape cap', () => {
    const raw = [
      'RetriableError: [invalid_argument] Sand traffic is not supported on this endpoint',
      '    at AgentService (/opt/openclaude/openclaude-v5-selfhost/packages/gateway/src/engine/cursorAdapter.ts:88:3)',
      'sk-abcdefghijklmnopqrstuvwxyz123456 dumped',
    ].join('\n')
    const detail = formatCursorCliFailureDetail(raw)
    assert.equal(detail.startsWith('Cursor CLI failed: '), true)
    assert.match(detail, /Sand traffic is not supported on this endpoint/)
    assert.equal(detail.includes('/opt/openclaude'), false)
    assert.equal(detail.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), false)
    assert.equal(detail.length <= CURSOR_CLI_FAILURE_DETAIL_MAX, true)
    assert.equal(detail.includes('\n'), false)
  })

  test('redacts absolute paths, tokens, and quoted user content', () => {
    const raw = 'fail at /home/agent/.openclaude/workspace/secret/prompt.ts token=ghp_abcdefghijklmnopqrstuvwxyz123456 prompt="please summarize this long private user paragraph that should never leak into tape"'
    const sanitized = sanitizeCursorCliError(raw)
    assert.equal(sanitized.includes('/home/agent'), false)
    assert.match(sanitized, /\[path\]/)
    assert.equal(sanitized.includes('ghp_abcdefghijklmnopqrstuvwxyz123456'), false)
    assert.equal(sanitized.includes('please summarize this long private user paragraph'), false)
  })

  test('empty input falls back to the generic Cursor CLI failed label', () => {
    assert.equal(formatCursorCliFailureDetail('   \nnext line'), 'Cursor CLI failed')
    assert.equal(formatCursorCliFailureLog('').startsWith('Cursor CLI failed'), true)
  })

  test('truncates a long first line to 200 characters', () => {
    const raw = `RetriableError: ${'x'.repeat(400)}`
    const detail = formatCursorCliFailureDetail(raw)
    assert.equal(detail.length, CURSOR_CLI_FAILURE_DETAIL_MAX)
    assert.equal(detail.endsWith('…'), true)
    assert.equal(detail.startsWith('Cursor CLI failed: RetriableError: '), true)
  })
})
