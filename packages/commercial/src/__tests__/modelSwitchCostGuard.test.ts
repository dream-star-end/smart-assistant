import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkModelSwitchFrame,
  promptQueueDispositionForCode,
  _recoveryRefusalAction,
} from '../ws/modelSwitchCostGuard.js'
import { ModelSwitchCostError, type ModelSwitchCostService } from '../billing/modelSwitchCost.js'
const input = {
  sessionId: 'own',
  requestId: 'm-cost-guard',
  targetModel: 'gpt-6-astra',
  text: 'question',
  temporaryImageFeature: false,
}
function fixture() {
  const calls: unknown[] = []
  const service = {
    assertAuthorized: async (...args: unknown[]) => {
      calls.push(args)
    },
  } as unknown as ModelSwitchCostService
  return { calls, service }
}
test('ordinary paid frames require resolved target and a valid request identity', async () => {
  const f = fixture()
  assert.equal(
    (await checkModelSwitchFrame(f.service, '765', {}, { ...input, targetModel: null }))?.code,
    'UNRESOLVED_AGENT_MODEL',
  )
  assert.equal(
    (await checkModelSwitchFrame(f.service, '765', {}, { ...input, requestId: null }))?.code,
    'MODEL_SWITCH_REQUEST_ID_REQUIRED',
  )
  assert.equal(f.calls.length, 0)
})
test('raw imageEdit cannot bypass; only the validated fixed-price branch skips this guard', async () => {
  const f = fixture()
  await checkModelSwitchFrame(f.service, '765', { content: { imageEdit: {} } }, input)
  assert.equal(f.calls.length, 1)
  await checkModelSwitchFrame(
    f.service,
    '765',
    { content: { imageEdit: {} } },
    { ...input, temporaryImageFeature: true },
  )
  assert.equal(f.calls.length, 1)
})
test('authority target, formatted input and consent reach the one shared service', async () => {
  const f = fixture()
  assert.equal(
    await checkModelSwitchFrame(
      f.service,
      '765',
      { agentId: 'main', modelSwitchConsent: 'fixture-consent' },
      input,
    ),
    null,
  )
  assert.deepEqual(f.calls[0], [
    '765',
    {
      sessionId: 'own',
      requestId: 'm-cost-guard',
      targetModel: 'gpt-6-astra',
      agentId: 'main',
      teamMode: false,
      text: 'question',
      mediaCount: 0,
    },
    'fixture-consent',
  ])
})
test('refusal pauses for confirmation while unavailable errors fail closed and requeue', async () => {
  for (const thrown of [
    new ModelSwitchCostError('MODEL_SWITCH_CONFIRMATION_REQUIRED', 'confirm'),
    new Error('db'),
  ]) {
    const service = {
      assertAuthorized: async () => {
        throw thrown
      },
    } as unknown as ModelSwitchCostService
    const refusal = await checkModelSwitchFrame(service, '765', {}, input)
    assert.ok(refusal?.code.startsWith('MODEL_SWITCH_'))
    const needsAction = thrown instanceof ModelSwitchCostError
    assert.equal(
      promptQueueDispositionForCode(refusal!.code),
      needsAction ? 'user_action_required' : 'retryable',
    )
    assert.equal(_recoveryRefusalAction(refusal!.code), needsAction ? 'pause' : 'requeue')
  }
})

test('only explicit user-action codes pause recovery', () => {
  for (const code of [
    'MODEL_SWITCH_CONFIRMATION_REQUIRED',
    'MODEL_SWITCH_INSUFFICIENT_BALANCE',
    'MODEL_SWITCH_QUOTE_CHANGED',
    'MODEL_SWITCH_REQUEST_ID_REQUIRED',
    'UNAUTHORIZED_MODEL',
    'MODEL_NOT_AVAILABLE',
    'UNRESOLVED_AGENT_MODEL',
    'AGENT_NOT_FOUND',
    'INVALID_REQUEST',
    'ERR_FRAME_TOO_BIG',
    'ERR_INSUFFICIENT_CREDITS',
    'INSUFFICIENT_CREDITS',
  ]) {
    assert.equal(_recoveryRefusalAction(code), 'pause', code)
  }
  for (const code of [
    'MODEL_SWITCH_UNAVAILABLE',
    'MODEL_SWITCH_FUTURE_TRANSIENT',
    'MODEL_NOT_AVAILABLE_LATER',
    'INVALID_FUTURE_TRANSIENT',
  ]) {
    assert.equal(_recoveryRefusalAction(code), 'requeue', code)
  }
})
