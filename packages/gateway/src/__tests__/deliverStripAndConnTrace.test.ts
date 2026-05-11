/**
 * V3 S12e CG6 — gateway/server.ts pure helper tests:
 *   - _parseConnectionTraceIdFromUpgrade: WS upgrade trace header parser
 *   - _stripPrivateRoutingFields:         deliver() wire sanitiser
 *
 * Both helpers are exported with `_` prefix as test seams. Tests live next to
 * other gateway tests (matched by `npx tsx --test packages/gateway/src/__tests__/*.test.ts`,
 * see root package.json `test:gateway` script).
 *
 * Repository convention: import from `../server.js` (TS source resolves via
 * tsx; `.js` extension matches NodeNext + the existing askUserQuestionSanitize
 * test pattern).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  _parseConnectionTraceIdFromUpgrade,
  _stripPrivateRoutingFields,
} from '../server.js'

// ── _parseConnectionTraceIdFromUpgrade ──

function makeLog() {
  const logs: Array<{ msg: string; ctx: any }> = []
  const log = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, ctx?: any) => {
      logs.push({ msg, ctx })
    },
    error: () => {},
  }
  return { log, logs }
}

test('parse: valid lowercase header → raw traceId, no warn', () => {
  const { log, logs } = makeLog()
  const id = _parseConnectionTraceIdFromUpgrade(
    { 'x-connection-trace-id': '01234567890abcdef01234567890abcd' },
    log as any,
  )
  assert.equal(id, '01234567890abcdef01234567890abcd')
  assert.equal(logs.length, 0)
})

test('parse: missing header → fallback newTraceId + warn issue=missing, no raw leaked', () => {
  const { log, logs } = makeLog()
  const id = _parseConnectionTraceIdFromUpgrade({}, log as any)
  assert.match(id, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].msg, 'ws.upgrade.connection_trace_invalid')
  assert.equal(logs[0].ctx.issue, 'missing')
  // anti-log-injection: warn ctx must NOT carry any raw value field
  const ctxKeys = Object.keys(logs[0].ctx)
  assert.deepEqual(ctxKeys, ['issue'])
})

test('parse: bad-charset header → fallback + warn issue=bad-charset, raw not leaked', () => {
  const { log, logs } = makeLog()
  const poison = 'EVIL_INJECTED_LINE_aa$$$$'
  const id = _parseConnectionTraceIdFromUpgrade(
    { 'x-connection-trace-id': poison },
    log as any,
  )
  assert.match(id, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(logs[0].ctx.issue, 'bad-charset')
  // The full log record(msg + ctx)serialised must not contain the poison.
  const serialised = JSON.stringify(logs[0])
  assert.equal(serialised.includes('EVIL'), false)
  assert.equal(serialised.includes('INJECTED'), false)
})

test('parse: too-short → fallback + warn issue=too-short', () => {
  const { log, logs } = makeLog()
  const id = _parseConnectionTraceIdFromUpgrade(
    { 'x-connection-trace-id': 'short123' },
    log as any,
  )
  assert.match(id, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(logs[0].ctx.issue, 'too-short')
})

test('parse: empty string → fallback + warn issue=empty', () => {
  const { log, logs } = makeLog()
  const id = _parseConnectionTraceIdFromUpgrade(
    { 'x-connection-trace-id': '' },
    log as any,
  )
  assert.match(id, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(logs[0].ctx.issue, 'empty')
})

test('parse: array header → first value unwrap (matches Go ParseHeader)', () => {
  const { log, logs } = makeLog()
  const id = _parseConnectionTraceIdFromUpgrade(
    { 'x-connection-trace-id': ['01234567890abcdef01234567890abcd', 'second'] },
    log as any,
  )
  assert.equal(id, '01234567890abcdef01234567890abcd')
  assert.equal(logs.length, 0)
})

test('parse: empty array → fallback + warn issue=missing (first value is undefined)', () => {
  const { log, logs } = makeLog()
  const id = _parseConnectionTraceIdFromUpgrade(
    // Realistic Node behaviour: missing header → key absent. But callers may
    // synthesise `[]`; first-element-undefined must collapse to `missing`.
    { 'x-connection-trace-id': [] },
    log as any,
  )
  assert.match(id, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(logs[0].ctx.issue, 'missing')
})

// ── _stripPrivateRoutingFields ──

test('strip: removes all 4 private fields, returns each', () => {
  const out = {
    type: 'message',
    channel: 'webchat',
    peer: { id: 'p1' },
    sessionKey: 'sk1',
    _userId: 'u1',
    _traceId: 't1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    _connectionTraceId: 'c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    _peerId: 'p2',
    text: 'hi',
  } as any
  const { wire, userId, traceId, connectionTraceId, peerId } =
    _stripPrivateRoutingFields(out)
  assert.equal(userId, 'u1')
  assert.equal(traceId, 't1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(connectionTraceId, 'c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(peerId, 'p2')
  // wire must not retain any underscore-prefixed routing field
  assert.deepEqual(
    Object.keys(wire).filter((k) => k.startsWith('_')),
    [],
  )
  // public fields preserved verbatim
  assert.equal((wire as any).text, 'hi')
  assert.equal((wire as any).sessionKey, 'sk1')
  assert.equal((wire as any).type, 'message')
})

test('strip: out without any private field → all stripped fields undefined, wire equals input shape', () => {
  const out = {
    type: 'error',
    channel: 'webchat',
    peer: { id: 'p1' },
    error: 'oops',
  } as any
  const { wire, userId, traceId, connectionTraceId, peerId } =
    _stripPrivateRoutingFields(out)
  assert.equal(userId, undefined)
  assert.equal(traceId, undefined)
  assert.equal(connectionTraceId, undefined)
  assert.equal(peerId, undefined)
  assert.deepEqual(wire, out)
})

test('strip: returns a NEW object (rest-spread), does not mutate input', () => {
  const out = {
    type: 'message',
    channel: 'webchat',
    peer: { id: 'p1' },
    _userId: 'u1',
    text: 'hi',
  } as any
  const { wire } = _stripPrivateRoutingFields(out)
  assert.notStrictEqual(wire, out)
  // input still has _userId; only wire is stripped
  assert.equal((out as any)._userId, 'u1')
  assert.equal((wire as any)._userId, undefined)
})
