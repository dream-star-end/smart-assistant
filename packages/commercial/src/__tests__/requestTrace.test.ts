import assert from 'node:assert/strict'
// OCV5-564 (plan §7.1): HTTP trace header names are a contract. x-openclaude-trace-id wins,
// x-trace-id is a one-cycle alias, and a generated id is never presented as a client trace.
import { describe, test } from 'node:test'
import { TRACE_ID_HEADER, TRACE_ID_REGEX } from '@openclaude/protocol'
import { LEGACY_TRACE_ID_HEADER, resolveRequestTrace } from '../http/requestTrace.js'

const A = '0a1b2c3d4e5f60718293a4b5c6d7e8f9'
const B = 'ffeeddccbbaa99887766554433221100'

describe('resolveRequestTrace', () => {
  test('header names are pinned (cross-language contract)', () => {
    assert.equal(TRACE_ID_HEADER, 'x-openclaude-trace-id')
    assert.equal(LEGACY_TRACE_ID_HEADER, 'x-trace-id')
  })
  test('canonical header wins over the alias', () => {
    assert.deepEqual(resolveRequestTrace({ [TRACE_ID_HEADER]: A, 'x-trace-id': B }), {
      traceId: A,
      traceIdOrigin: 'header',
    })
  })
  test('the alias is accepted when the canonical header is absent or invalid', () => {
    assert.deepEqual(resolveRequestTrace({ 'x-trace-id': B }), {
      traceId: B,
      traceIdOrigin: 'legacy-header',
    })
    assert.deepEqual(resolveRequestTrace({ [TRACE_ID_HEADER]: 'not a trace', 'x-trace-id': B }), {
      traceId: B,
      traceIdOrigin: 'legacy-header',
    })
  })
  test('array headers use the first value', () => {
    assert.deepEqual(resolveRequestTrace({ [TRACE_ID_HEADER]: [A, B] as unknown as string }), {
      traceId: A,
      traceIdOrigin: 'header',
    })
  })
  test('no valid header: a fresh well-formed id, marked generated', () => {
    const a = resolveRequestTrace({})
    const b = resolveRequestTrace({ 'x-trace-id': '../../etc/passwd' })
    assert.equal(a.traceIdOrigin, 'generated')
    assert.equal(b.traceIdOrigin, 'generated')
    assert.match(a.traceId, TRACE_ID_REGEX)
    assert.notEqual(a.traceId, b.traceId)
  })
})
