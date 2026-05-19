/**
 * Tests for the tolerant partial-JSON parser in
 * `packages/web/public/modules/partialJson.js`.
 *
 * The parser drives partial Edit/Write tool-card rendering while the
 * gateway is still streaming `input_json_delta` events. It must:
 *   - never throw on any input
 *   - extract closed top-level string fields verbatim
 *   - extract a partial trailing string field (in-progress streaming) with
 *     escapes decoded, dropping truncated `\` / `\uXXXX` fragments
 *   - extract complete number/bool/null primitives
 *   - skip unbalanced nested objects/arrays (no inventing structure)
 *   - return {} for non-object top-level shapes
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePartialJson } from '../public/modules/partialJson.js'

describe('parsePartialJson', () => {
  it('returns {} on empty / whitespace / non-string input', () => {
    assert.deepEqual(parsePartialJson(''), {})
    assert.deepEqual(parsePartialJson('   '), {})
    // @ts-expect-error: testing runtime tolerance
    assert.deepEqual(parsePartialJson(null), {})
    // @ts-expect-error: testing runtime tolerance
    assert.deepEqual(parsePartialJson(undefined), {})
    // @ts-expect-error: testing runtime tolerance
    assert.deepEqual(parsePartialJson(42), {})
  })

  it('parses a complete object via fast path', () => {
    assert.deepEqual(parsePartialJson('{"a":"b","c":42}'), { a: 'b', c: 42 })
  })

  it('returns {} when top-level is an array', () => {
    assert.deepEqual(parsePartialJson('["a","b"]'), {})
  })

  it('returns {} when top-level is a string', () => {
    assert.deepEqual(parsePartialJson('"hello"'), {})
  })

  it('handles `{` only', () => {
    assert.deepEqual(parsePartialJson('{'), {})
  })

  it('handles `{}` empty object', () => {
    assert.deepEqual(parsePartialJson('{}'), {})
  })

  it('handles key without colon yet', () => {
    assert.deepEqual(parsePartialJson('{"a"'), {})
  })

  it('handles key with colon but no value', () => {
    assert.deepEqual(parsePartialJson('{"a":'), {})
  })

  it('handles value just opened', () => {
    assert.deepEqual(parsePartialJson('{"a":"'), { a: '' })
  })

  it('extracts in-progress string value (partial)', () => {
    assert.deepEqual(parsePartialJson('{"a":"hel'), { a: 'hel' })
  })

  it('extracts closed string value', () => {
    assert.deepEqual(parsePartialJson('{"a":"hello"'), { a: 'hello' })
  })

  it('extracts two fields, second still streaming', () => {
    assert.deepEqual(parsePartialJson('{"a":"b","c":"de'), { a: 'b', c: 'de' })
  })

  it('decodes JSON escapes in partial string', () => {
    const r = parsePartialJson('{"a":"line1\\nline2')
    assert.deepEqual(r, { a: 'line1\nline2' })
  })

  it('drops trailing lone backslash from partial value', () => {
    const r = parsePartialJson('{"a":"hello\\')
    assert.deepEqual(r, { a: 'hello' })
  })

  it('drops truncated \\uXXXX escape from partial value', () => {
    const r = parsePartialJson('{"a":"x\\u00')
    assert.deepEqual(r, { a: 'x' })
  })

  it('handles a complete \\uXXXX escape in partial string', () => {
    const r = parsePartialJson('{"a":"x\\u00e9y')
    assert.deepEqual(r, { a: 'xéy' })
  })

  it('handles a quote escape in partial string', () => {
    const r = parsePartialJson('{"a":"sa\\"id')
    assert.deepEqual(r, { a: 'sa"id' })
  })

  it('extracts complete number', () => {
    assert.deepEqual(parsePartialJson('{"n":42}'), { n: 42 })
    assert.deepEqual(parsePartialJson('{"n":-3.14e2,'), { n: -314 })
  })

  it('skips unterminated number at end', () => {
    // "42" with nothing after — could still be partial; we skip rather than
    // commit. Caller will see field appear once value terminator arrives.
    assert.deepEqual(parsePartialJson('{"n":42'), {})
  })

  it('extracts true / false / null', () => {
    assert.deepEqual(parsePartialJson('{"a":true,"b":false,"c":null}'), {
      a: true, b: false, c: null,
    })
  })

  it('skips half-typed bool', () => {
    assert.deepEqual(parsePartialJson('{"a":tru'), {})
  })

  it('parses closed nested object', () => {
    assert.deepEqual(parsePartialJson('{"a":{"b":"c"}}'), { a: { b: 'c' } })
  })

  it('skips unbalanced nested object', () => {
    // We deliberately do NOT invent partial structure; the field is omitted
    // until balanced (then the final inputJson frame will carry truth).
    assert.deepEqual(parsePartialJson('{"file_path":"/x","extra":{"b":"c'), {
      file_path: '/x',
    })
  })

  it('parses closed array of strings', () => {
    assert.deepEqual(parsePartialJson('{"a":["x","y"]}'), { a: ['x', 'y'] })
  })

  it('skips unbalanced array', () => {
    assert.deepEqual(parsePartialJson('{"p":"q","a":["x","y'), { p: 'q' })
  })

  it('Edit-like payload mid-stream is rendered usefully', () => {
    // file_path closed, old_string streaming.
    const r = parsePartialJson(
      '{"file_path":"/tmp/x.ts","old_string":"const a = 1\\nconst b = 2',
    )
    assert.equal(r.file_path, '/tmp/x.ts')
    assert.equal(r.old_string, 'const a = 1\nconst b = 2')
  })

  it('Write-like payload mid-stream: file_path closed, content streaming', () => {
    const r = parsePartialJson(
      '{"file_path":"/tmp/out.json","content":"{\\"x\\": 1, \\"y\\": 2',
    )
    assert.equal(r.file_path, '/tmp/out.json')
    assert.equal(r.content, '{"x": 1, "y": 2')
  })

  it('never throws on adversarial input', () => {
    // Stress: many shapes that real `JSON.parse` would reject.
    const garbage = [
      '{"a":"b",}',           // trailing comma
      '{"a"::"b"}',           // double colon
      '{"a":undefined}',      // not JSON
      '{,,,}',                 // commas only
      '{"a":"\u0000"',        // raw control char
      '{"a":"\\x"',           // illegal escape — parser keeps both chars
      '{"\\u"',               // truncated escape inside key
      '{' + '"a":"b",'.repeat(2000), // big input
    ]
    for (const g of garbage) {
      assert.doesNotThrow(() => parsePartialJson(g))
    }
  })

  it('handles a 60 KiB partial input without throwing or hanging', () => {
    const big = '{"file_path":"/x","new_string":"' + 'x'.repeat(60 * 1024)
    const r = parsePartialJson(big)
    assert.equal(r.file_path, '/x')
    assert.equal(typeof r.new_string, 'string')
    // partial string should be ~60 KiB of 'x'
    assert.ok(r.new_string.length >= 60 * 1024 - 8)
  })

  it('idempotent on the closed final state', () => {
    const closed = '{"file_path":"/x","new_string":"hello"}'
    assert.deepEqual(parsePartialJson(closed), { file_path: '/x', new_string: 'hello' })
  })
})
