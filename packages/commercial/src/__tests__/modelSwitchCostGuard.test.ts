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
test('refusal and unavailable errors fail closed; queues and recovery pause for confirmation', async () => {
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
    assert.equal(promptQueueDispositionForCode(refusal!.code), 'user_action_required')
    assert.equal(_recoveryRefusalAction(refusal!.code), 'pause')
  }
})
