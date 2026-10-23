// OCV5-569 (plan §7.4): egress step 0 binds the turn trace per request, or says why there is none,
// and counts both; requests that did not pass step 0 get no fields (old log shapes stay).
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { describe, test } from 'node:test'
import {
  bindEgressTrace,
  dispatchTraceFallback,
  egressTraceBindingCounts,
  egressTraceFields,
  egressTurnRoute,
} from '../http/egressTrace.js'
import { buildSafeUpstreamHeaders } from '../http/proxy/shared.js'

const T = '0a1b2c3d4e5f60718293a4b5c6d7e8f9'
const req = (headers: Record<string, string | string[]> = {}) =>
  ({ headers }) as unknown as IncomingMessage
const PREFIXES = {
  codex: '/internal/codex-relay',
  grok: '/internal/grok-relay',
  zcode: '/internal/zcode-relay',
  antigravity: '/internal/antigravity-relay',
}

describe('egress trace binding (step 0)', () => {
  test('a valid header is bound; a repeated header uses its first value', () => {
    const r = req({ 'x-openclaude-trace-id': T })
    assert.deepEqual(bindEgressTrace(r, 'messages'), { traceId: T })
    assert.deepEqual(egressTraceFields(r), { traceId: T })
    const twice = req({ 'x-openclaude-trace-id': [T, 'other-value-0000000'] })
    assert.deepEqual(bindEgressTrace(twice, 'codex-relay'), { traceId: T })
  })

  test('missing: no-header on /v1/messages, relay-without-trace on a relay; invalid is bad-header (raw never kept)', () => {
    assert.deepEqual(bindEgressTrace(req(), 'messages'), {
      traceId: null,
      traceIdMissing: 'no-header',
    })
    assert.deepEqual(bindEgressTrace(req(), 'grok-relay'), {
      traceId: null,
      traceIdMissing: 'relay-without-trace',
    })
    const bad = bindEgressTrace(req({ 'x-openclaude-trace-id': 'x\n{"forged":1}' }), 'zcode-relay')
    assert.deepEqual(bad, { traceId: null, traceIdMissing: 'bad-header' })
    assert.ok(!JSON.stringify(bad).includes('forged'))
  })

  test('the legacy x-trace-id alias is not read at egress (only our containers call it)', () => {
    assert.deepEqual(bindEgressTrace(req({ 'x-trace-id': T }), 'messages'), {
      traceId: null,
      traceIdMissing: 'no-header',
    })
  })

  test('a request that did not pass step 0 gets no fields', () => {
    assert.deepEqual(egressTraceFields(req({ 'x-openclaude-trace-id': T })), {})
  })

  test('counts per route and result, missing ones included (they stay in the denominator)', () => {
    const before = egressTraceBindingCounts()
    const n = (route: string, result: string) =>
      (egressTraceBindingCounts()[route]?.[result] ?? 0) - (before[route]?.[result] ?? 0)
    bindEgressTrace(req({ 'x-openclaude-trace-id': T }), 'antigravity-relay')
    bindEgressTrace(req(), 'antigravity-relay')
    bindEgressTrace(req(), 'antigravity-relay')
    assert.equal(n('antigravity-relay', 'bound'), 1)
    assert.equal(n('antigravity-relay', 'relay-without-trace'), 2)
  })

  test('/v1/messages: the upstream headers are an allowlist, so the trace header never reaches the provider', () => {
    const out = buildSafeUpstreamHeaders({ 'x-openclaude-trace-id': T, 'x-trace-id': T })
    assert.equal(out['x-openclaude-trace-id'], undefined)
    assert.equal(out['x-trace-id'], undefined)
  })

  test('turn routes: /v1/messages and the four relays (prefix or below); health and box internals are not', () => {
    assert.equal(egressTurnRoute('/v1/messages', PREFIXES), 'messages')
    assert.equal(egressTurnRoute('/internal/codex-relay/responses', PREFIXES), 'codex-relay')
    assert.equal(egressTurnRoute('/internal/grok-relay', PREFIXES), 'grok-relay')
    assert.equal(egressTurnRoute('/internal/zcode-relay/x/v1/messages', PREFIXES), 'zcode-relay')
    assert.equal(egressTurnRoute('/internal/antigravity-relay/v1internal', PREFIXES), 'antigravity-relay')
    assert.equal(egressTurnRoute('/internal/codex-relayX', PREFIXES), null)
    assert.equal(egressTurnRoute('/internal/v5/egress-health', PREFIXES), null)
    assert.equal(egressTurnRoute('/v1/messages/count_tokens', PREFIXES), null)
  })

  test('dispatch fallback (OCV5-599): used only when step 0 bound no trace; a bound header wins', () => {
    const D = 'd'.repeat(32)
    assert.equal(dispatchTraceFallback({ traceId: T }, D), null)
    assert.equal(dispatchTraceFallback({ traceId: null, traceIdMissing: 'no-header' }, D), D)
    assert.equal(dispatchTraceFallback({ traceId: null, traceIdMissing: 'bad-header' }, D), D)
    assert.equal(dispatchTraceFallback({}, D), D)
    assert.equal(dispatchTraceFallback({ traceId: null, traceIdMissing: 'no-header' }, null), null)
    assert.equal(dispatchTraceFallback({}, undefined), null)
  })
})
