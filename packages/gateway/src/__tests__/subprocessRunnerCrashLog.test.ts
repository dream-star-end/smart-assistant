/**
 * OCV5-392: a CCB crash log carries a scrubbed stderr tail.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/subprocessRunnerCrashLog.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { appendCrashStderrTail, redactCrashStderrTail } from '../subprocessRunner.js'

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

describe('appendCrashStderrTail', () => {
  it('never keeps a credential value without its marker', () => {
    let tail = appendCrashStderrTail('', 'TOKEN=shortsecret123456')
    tail = appendCrashStderrTail(tail, '\n'.repeat(1983))
    tail = appendCrashStderrTail(tail, 'x\n'.repeat(4000))
    assert.ok(!tail.includes('shortsecret123456'))
    assert.ok(!redactCrashStderrTail(tail).includes('shortsecret123456'))
  })

  it('drops a cut line rather than keeping half of it', () => {
    const tail = appendCrashStderrTail('', `ANTHROPIC_AUTH_TOKEN=${'s'.repeat(7990)}secret\nlast\n`)
    assert.equal(tail, 'last\n')
  })

  it('redacts a marker and value on one line even near the start of the tail', () => {
    const tail = appendCrashStderrTail(`${'y'.repeat(7000)}\n`, `TOKEN=shortsecret123456\n${'z\n'.repeat(1000)}`)
    const out = redactCrashStderrTail(tail)
    assert.ok(!out.includes('shortsecret123456'))
    assert.ok(out.length <= 2000)
  })
})
