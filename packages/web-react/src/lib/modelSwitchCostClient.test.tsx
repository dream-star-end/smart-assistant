import { afterEach, expect, test, vi } from 'vitest'
import { api } from './api'
import { createMemoryAuthSession } from './authSession'
import { createModelSwitchCostAuthorizer } from './modelSwitchCostClient'
import { fixtureSwitchQuote } from '../../browser-tests/model-switch-cost-fixture.mjs'
afterEach(() => vi.restoreAllMocks())
test('malformed successful API data cannot authorize a switch or masquerade as offline work', async () => {
  vi.spyOn(api, 'modelSwitchCost').mockResolvedValue({} as never)
  const confirmDialog = vi.fn()
  const authorize = createModelSwitchCostAuthorizer({
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
    confirmDialog,
    toast: vi.fn(),
  })
  expect(
    await authorize(
      {
        sessionId: 'own',
        requestId: 'm-invalid-quote',
        targetModel: 'gpt-6-astra',
        agentId: 'main',
      },
      { allowOfflineQueue: true },
    ),
  ).toBeNull()
  expect(confirmDialog).not.toHaveBeenCalled()
})
test('bounded short fixture estimate remains below the mandatory warning threshold', async () => {
  const input = {
    sessionId: 'own',
    requestId: 'm-short-quote',
    targetModel: 'gpt-6-astra',
    agentId: 'main',
  }
  vi.spyOn(api, 'modelSwitchCost').mockResolvedValue(fixtureSwitchQuote(input))
  const confirmDialog = vi.fn()
  const authorize = createModelSwitchCostAuthorizer({
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
    confirmDialog,
    toast: vi.fn(),
  })
  expect((await authorize(input))?.requestId).toBe(input.requestId)
  expect(confirmDialog).not.toHaveBeenCalled()
})
