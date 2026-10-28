import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Value } from '@sinclair/typebox/value'
import { USER_ERROR_CATALOG, USER_ERROR_ACTION_LABELS, getUserError, withUserError } from '../userErrorCatalog.js'
import { TURN_ERROR_TAXONOMY, turnErrorSemantics } from '../turnErrorTaxonomy.js'
import { UserErrorSchema } from '../userErrorSchema.js'
import { automaticRetryStatus } from '../automaticRetryStatus.js'

describe('user error catalog contract', () => {
test('every catalog error has safe Chinese copy, known actions and a valid wire envelope', () => {
  for (const entry of Object.values(USER_ERROR_CATALOG)) {
    assert.ok(Value.Check(UserErrorSchema, entry), entry.code)
    assert.match(entry.message, /[\u4e00-\u9fff]/, entry.code)
    assert.doesNotMatch(entry.message, /cost=|oceng-|traceId|request_id|\b[A-Z]+_[A-Z_]+\b/, entry.code)
    assert.equal(entry.userMessageKey, `errors.${entry.code}`)
    for (const action of entry.actions) assert.ok(USER_ERROR_ACTION_LABELS[action])
  }
  for (const code of Object.keys(TURN_ERROR_TAXONOMY)) {
    assert.equal(getUserError(code).code, code)
    assert.equal(getUserError(code).retryable, turnErrorSemantics(code).retryable)
  }
})

test('display aliases do not modify billing or automatic recovery policy', () => {
  assert.equal(getUserError('PROMPT_TOO_LARGE').code, 'context_too_long')
  assert.equal(getUserError('ANTIGRAVITY_PROMPT_TOO_LARGE').code, 'context_too_long')
  assert.equal(getUserError('BOX_CONTEXT_TOO_LARGE').code, 'request_too_large')
  assert.equal(getUserError('PAYLOAD_TOO_LARGE').code, 'request_too_large')
  assert.equal(getUserError('ANTIGRAVITY_CREDENTIAL_EXPIRED').code, 'platform_credential_expired')
  assert.equal(getUserError('DISPATCH_NOT_ACCEPTED').code, 'durable_dispatch_unavailable')
  assert.equal(getUserError('RUNNER_ERROR').code, 'runner_crashed')
  assert.deepEqual(turnErrorSemantics('PROMPT_TOO_LARGE'), { retryable: false, cta: 'none' })
})

test('HTTP and WS envelopes preserve all legacy fields and never interpolate raw errors', () => {
  const raw = 'cost=123 oceng-private-request at /root/private.ts:3'
  const error = { code: 'INTERNAL', message: raw, request_id: 'private-id', nextAction: 'inspect' }
  const body = { error }
  const wire = withUserError(body, 500)
  assert.equal(wire.error, error)
  assert.equal(body.error.message, raw)
  assert.ok(wire.userError)
  assert.doesNotMatch(wire.userError.message, /cost=|oceng-|private/)
  assert.equal(withUserError(body, 200), body)
  assert.equal(withUserError({ type: 'outbound.codex_billing', error: raw }).userError, undefined)
  const unknown = withUserError({ type: 'error', code: '__proto__', message: raw })
  assert.equal(unknown.userError?.code, 'unexpected_error')
  assert.equal(getUserError('oceng-unknown').code, 'unexpected_error')
})

test('retry presentation distinguishes queued, accepted, exhausted and unknown legacy limits', () => {
  assert.equal(automaticRetryStatus('scheduled', 2, 3).message, '正在等待自动重试（2/3），请稍候。')
  assert.equal(automaticRetryStatus('running', 2, 3).message, '正在自动重试（2/3）。')
  assert.equal(automaticRetryStatus('running', 2).maxAttempts, undefined)
  assert.doesNotMatch(automaticRetryStatus('running', 2).message, /\/10/)
  assert.equal(automaticRetryStatus('running', 4, 3).maxAttempts, undefined)
  for (const state of ['exhausted', 'paused'] as const) {
    assert.deepEqual(automaticRetryStatus(state, 3, 3).actions, ['switch_model', 'retry', 'contact_admin'])
  }
})

})
