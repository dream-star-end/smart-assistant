/**
 * OCV5-392: a CCB crash log carries a scrubbed stderr tail.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/subprocessRunnerCrashLog.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { redactCrashStderrTail } from '../subprocessRunner.js'

describe('redactCrashStderrTail', () => {
  it('keeps the error text and file paths', () => {
    const out = redactCrashStderrTail(
      'Error: --json-schema is invalid\n    at /opt/openclaude/claude-code-best/dist/cli.js:12:3\n',
    )
    assert.match(out, /--json-schema is invalid/)
    assert.match(out, /\/opt\/openclaude\/claude-code-best\/dist\/cli\.js:12:3/)
  })

  it('scrubs credential-shaped values', () => {
    const out = redactCrashStderrTail(
      [
        'Authorization: Bearer abcdefghijklmnop',
        'ANTHROPIC_AUTH_TOKEN=supersecretvalue123',
        'key sk-ant-api03-abcdefghijklmnop',
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIzIn0.c2lnbmF0dXJl',
        `digest ${'a1'.repeat(32)}`,
      ].join('\n'),
    )
    for (const leaked of ['abcdefghijklmnop', 'supersecretvalue123', 'sk-ant', 'eyJhbGci', 'a1a1a1a1a1a1']) {
      assert.ok(!out.includes(leaked), leaked)
    }
  })

  it('keeps only the tail', () => {
    const out = redactCrashStderrTail(`${'x '.repeat(5000)}LAST LINE`)
    assert.ok(out.length <= 2000)
    assert.ok(out.endsWith('LAST LINE'))
  })
})
