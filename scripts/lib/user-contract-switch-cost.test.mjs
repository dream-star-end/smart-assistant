import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeContractModelSwitch } from './user-contract-switch-cost.mjs'

const input = Object.freeze({ sessionId: 's435', requestId: 'm435-2', targetModel: 'gpt-6-luna', agentId: 'main', text: 'reply 2', mediaCount: 0 })
const { sessionId, ...request } = input
const quote = patch => ({ requestId: input.requestId, targetModel: input.targetModel, mode: 'risk', requiresConfirmation: true, canConfirm: true, expiresAt: Date.now() + 60000, quoteToken: 'quote-fixture', ...patch })
function mock(responses) {
  const calls = []
  const api = async (path, init) => {
    calls.push({ path, method: init.method, body: JSON.parse(init.body) })
    const next = responses[calls.length - 1]
    if (next instanceof Error) throw next
    return next
  }
  return { api, calls }
}

test('risk consent comes from a second API call bound to the exact follow-up input', async () => {
  const { api, calls } = mock([quote(), quote({ requiresConfirmation: false, consent: 'consent-fixture' })])
  assert.deepEqual(await authorizeContractModelSwitch(api, input), { mode: 'risk', confirmed: true, consent: 'consent-fixture' })
  assert.deepEqual(calls, [
    { path: '/api/me/sessions/s435/model-switch-estimate', method: 'POST', body: request },
    { path: '/api/me/sessions/s435/model-switch-estimate', method: 'POST', body: { ...request, quoteToken: 'quote-fixture' } },
  ])
})

test('exempt and low-cost quotes do not manufacture consent', async () => {
  for (const mode of ['exempt', 'estimate']) {
    const { api, calls } = mock([quote({ mode, requiresConfirmation: false })])
    assert.deepEqual(await authorizeContractModelSwitch(api, input), { mode, confirmed: false })
    assert.equal(calls.length, 1)
  }
})

test('insufficient balance blocks both mandatory and low-cost quotes before confirmation', async () => {
  for (const requiresConfirmation of [true, false]) {
    const { api, calls } = mock([quote({ canConfirm: false, requiresConfirmation })])
    await assert.rejects(authorizeContractModelSwitch(api, input), /cannot be confirmed/)
    assert.equal(calls.length, 1)
  }
})

test('malformed, expired and mismatched quotes never reach confirmation', async () => {
  for (const value of [null, {}, [], quote({ requestId: 'other' }), quote({ targetModel: 'other' }), quote({ mode: 'other' }), quote({ requiresConfirmation: 'yes' }), quote({ expiresAt: 1 }), quote({ quoteToken: '' }), quote({ quoteToken: 'x'.repeat(4097) })]) {
    const { api, calls } = mock([value])
    await assert.rejects(authorizeContractModelSwitch(api, input))
    assert.equal(calls.length, 1)
  }
})

test('confirmation must return a fresh matching authorized grant', async () => {
  for (const value of [quote(), quote({ mode: 'estimate', requiresConfirmation: false, consent: 'consent-fixture' }), quote({ requiresConfirmation: false }), quote({ requiresConfirmation: false, consent: 'x'.repeat(4097) }), quote({ requiresConfirmation: false, consent: 'consent-fixture', requestId: 'other' })]) {
    const { api, calls } = mock([quote(), value])
    await assert.rejects(authorizeContractModelSwitch(api, input))
    assert.equal(calls.length, 2)
  }
})

test('API failures propagate without refreshing or replaying the request', async () => {
  for (const responses of [[new Error('network')], [quote(), new Error('HTTP 409')]]) {
    const { api, calls } = mock(responses)
    await assert.rejects(authorizeContractModelSwitch(api, input))
    assert.equal(calls.length, responses.length)
  }
})
