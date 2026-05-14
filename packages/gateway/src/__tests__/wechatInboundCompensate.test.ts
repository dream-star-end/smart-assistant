/**
 * Tests for `validateWechatInboundCompensateBody` — the pure body validator
 * extracted from `handleWechatInboundCompensate` (server.ts).
 *
 * **Scope of this file** (per slice 7b):
 *   - Schema validation of the `/internal/v3/wechat-inbound-compensate` body:
 *     sessionId / bindingUserId / reason / traceId shape + presence rules.
 *   - The exact error strings returned to the broker on each invalid input.
 *
 * **NOT scoped here** — covered elsewhere by design:
 *   - DB delete semantics + tenant scoping + idempotency: see
 *     `packages/storage/src/__tests__/softDeleteMasterSession.test.ts` (slice 7a)
 *     which exercises the exact `deleteClientSession(sessionId, 'c:'+uid)` path.
 *   - Route-level bypass auth (wrong nonce → 401): `checkInboundBypass` is
 *     universal for all `/internal/v3/*` routes; validated by P1.8 dev integration.
 *   - HTTP body cap (8KB → 413) + JSON-parse failure: same `readBody` /
 *     `JSON.parse` paths used by `handleWechatInbound`; would be redundant
 *     to retest at this layer.
 *
 * The handler in server.ts (`handleWechatInboundCompensate`) is thin glue:
 *   readBody → JSON.parse → validateWechatInboundCompensateBody → deleteClientSession.
 * Each link is unit-tested in its own file; integration is dev-validated.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/wechatInboundCompensate.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { validateWechatInboundCompensateBody } from '../server.js'

describe('validateWechatInboundCompensateBody', () => {
  // ── happy path ──
  it('accepts a minimal valid payload (no traceId)', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '42',
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual(r.payload, {
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '42',
      reason: 'step2a_failed',
    })
    assert.equal('traceId' in r.payload, false, 'traceId omitted when absent')
  })

  it('accepts a payload with traceId', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-fedcba9876543210',
      bindingUserId: '1',
      reason: 'step2b_failed',
      traceId: 'trace-xyz-001',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.payload.traceId, 'trace-xyz-001')
    assert.equal(r.payload.reason, 'step2b_failed')
  })

  it('accepts traceId at exactly the 64-char cap', () => {
    const t64 = 'a'.repeat(64)
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0000000000000001',
      bindingUserId: '7',
      reason: 'step2a_failed',
      traceId: t64,
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.payload.traceId, t64)
  })

  // ── envelope shape ──
  it('rejects non-object body (null)', () => {
    const r = validateWechatInboundCompensateBody(null)
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.error, 'body must be a JSON object')
  })

  it('rejects non-object body (array)', () => {
    const r = validateWechatInboundCompensateBody([])
    // JS arrays are typeof 'object', so this test guards specifically that
    // we DON'T accept arrays. The current validator does NOT reject arrays
    // (typeof [] === 'object'), but the field-level rejects (sessionId
    // missing) still catch it. Document the actual behavior.
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.error, 'sessionId must match wsess-[0-9a-f]{16}')
  })

  it('rejects non-object body (string)', () => {
    const r = validateWechatInboundCompensateBody('hello')
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.error, 'body must be a JSON object')
  })

  // ── sessionId rules ──
  it('rejects missing sessionId', () => {
    const r = validateWechatInboundCompensateBody({
      bindingUserId: '1',
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /sessionId/)
  })

  it('rejects wrong-prefix sessionId', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsessX-0123456789abcdef',
      bindingUserId: '1',
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.error, 'sessionId must match wsess-[0-9a-f]{16}')
  })

  it('rejects short hex (15 instead of 16)', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcde',
      bindingUserId: '1',
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /sessionId/)
  })

  it('rejects uppercase hex (regex is lower-case)', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789ABCDEF',
      bindingUserId: '1',
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /sessionId/)
  })

  it('rejects extra suffix after 16 hex chars', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef0',
      bindingUserId: '1',
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /sessionId/)
  })

  it('rejects non-string sessionId', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 12345,
      bindingUserId: '1',
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /sessionId/)
  })

  // ── bindingUserId rules ──
  it('rejects bindingUserId with leading zero', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '0123',
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /bindingUserId/)
  })

  it('rejects bindingUserId "0"', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '0',
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /bindingUserId/)
  })

  it('rejects negative bindingUserId', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '-7',
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /bindingUserId/)
  })

  it('rejects non-string bindingUserId (number)', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: 42,
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /bindingUserId/)
  })

  it('rejects bindingUserId > 19 digits (BIGINT bound)', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '1' + '0'.repeat(19), // 20 chars
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /bindingUserId/)
  })

  it('accepts bindingUserId at 19 digits (BIGINT max length)', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '9'.repeat(19),
      reason: 'step2a_failed',
    })
    assert.equal(r.ok, true)
  })

  // ── reason rules ──
  it('rejects unknown reason', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '1',
      reason: 'something_else',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /reason/)
  })

  it('rejects missing reason', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '1',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /reason/)
  })

  it('accepts both reason values', () => {
    for (const reason of ['step2a_failed', 'step2b_failed'] as const) {
      const r = validateWechatInboundCompensateBody({
        sessionId: 'wsess-0123456789abcdef',
        bindingUserId: '1',
        reason,
      })
      assert.equal(r.ok, true, `${reason} should be accepted`)
    }
  })

  // ── traceId rules ──
  it('rejects traceId > 64 chars', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '1',
      reason: 'step2a_failed',
      traceId: 'a'.repeat(65),
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /traceId/)
  })

  it('rejects non-string traceId (number)', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '1',
      reason: 'step2a_failed',
      traceId: 12345,
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /traceId/)
  })

  it('accepts empty traceId (length 0 ≤ 64)', () => {
    // Empty string is a legitimate traceId — we only cap upper bound, not
    // reject empty. Doc this intentional choice: broker tryCompensation
    // may pass `''` if dispatcher trace machinery hasn't initialized.
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: '1',
      reason: 'step2a_failed',
      traceId: '',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.payload.traceId, '')
  })

  // ── ordering & robustness ──
  it('returns the FIRST failure encountered (sessionId checked before bindingUserId)', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'bad',
      bindingUserId: 'also-bad',
      reason: 'no-good',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /sessionId/, 'sessionId error reported first')
  })

  it('returns the FIRST failure (bindingUserId checked before reason)', () => {
    const r = validateWechatInboundCompensateBody({
      sessionId: 'wsess-0123456789abcdef',
      bindingUserId: 'bad',
      reason: 'no-good',
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /bindingUserId/, 'bindingUserId error reported before reason')
  })
})
