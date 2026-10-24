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

test('navigation preserves a submitted cheap task but never opens its fee prompt in another session', async () => {
  const input = {
    sessionId: 'A',
    requestId: 'm-frozen-task',
    targetModel: 'gpt-6-astra',
    agentId: 'main',
  }
  for (const requiresConfirmation of [false, true]) {
    let resolve!: (value: ReturnType<typeof fixtureSwitchQuote>) => void
    vi.spyOn(api, 'modelSwitchCost').mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const confirmDialog = vi.fn()
    let selected = true
    const authorize = createModelSwitchCostAuthorizer({
      authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
      confirmDialog,
      toast: vi.fn(),
    })
    const pending = authorize(input, { isCurrent: () => true, canPrompt: () => selected })
    selected = false
    resolve({
      ...fixtureSwitchQuote(input),
      requiresConfirmation,
      ...(requiresConfirmation ? { quoteToken: 'fixture-quote' } : {}),
    })
    const result = await pending
    if (requiresConfirmation) expect(result).toBeNull()
    else expect(result?.requestId).toBe(input.requestId)
    expect(confirmDialog).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  }
})

test('known insufficient balance does not silently authorize a low-cost switch', async () => {
  const input = {
    sessionId: 'own',
    requestId: 'm-small-insufficient',
    targetModel: 'gpt-6-astra',
    agentId: 'main',
  }
  vi.spyOn(api, 'modelSwitchCost').mockResolvedValue({
    ...fixtureSwitchQuote(input),
    balanceCredits: '1',
    canConfirm: false,
  })
  const confirmDialog = vi.fn()
  const toast = vi.fn()
  const authorize = createModelSwitchCostAuthorizer({
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
    confirmDialog,
    toast,
  })
  expect(await authorize(input, { allowOfflineQueue: true })).toBeNull()
  expect(confirmDialog).not.toHaveBeenCalled()
  expect(toast).toHaveBeenCalled()
})
