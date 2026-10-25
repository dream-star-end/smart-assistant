import { afterEach, expect, test, vi } from 'vitest'
import { api, ApiError } from './api'
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

test.each([
  new TypeError('network'),
  new ApiError({ status: 503, code: 'MODEL_SWITCH_UNAVAILABLE', message: '暂不可用' }),
  new ApiError({ status: 409, code: 'MODEL_SWITCH_UNAVAILABLE', message: '暂不可用' }),
])(
  'unavailable remains retryable for queued sends and offline admission never mints consent: %s',
  async (error) => {
    vi.spyOn(api, 'modelSwitchCost').mockRejectedValue(error)
    const confirmDialog = vi.fn()
    const authorize = createModelSwitchCostAuthorizer({
      authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
      confirmDialog,
      toast: vi.fn(),
    })
    const input = {
      sessionId: 'own',
      requestId: 'm-retryable',
      targetModel: 'gpt-6-astra',
      agentId: 'main',
    }
    await expect(authorize(input, { interactive: false })).rejects.toBe(error)
    expect(await authorize(input, { allowOfflineQueue: true })).toEqual({
      requestId: input.requestId,
      choice: true,
    })
    expect(confirmDialog).not.toHaveBeenCalled()
  },
)

test.each([true, false])(
  'silent insufficient quote preserves its balance code (requiresConfirmation=%s)',
  async (requiresConfirmation) => {
    const input = {
      sessionId: 'own',
      requestId: 'm-balance',
      targetModel: 'gpt-6-astra',
      agentId: 'main',
    }
    vi.spyOn(api, 'modelSwitchCost').mockResolvedValue({
      ...fixtureSwitchQuote(input),
      canConfirm: false,
      requiresConfirmation,
      quoteToken: 'fixture-quote',
    })
    const confirmDialog = vi.fn()
    const authorize = createModelSwitchCostAuthorizer({
      authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
      confirmDialog,
      toast: vi.fn(),
    })
    await expect(authorize(input, { interactive: false })).rejects.toMatchObject({
      code: 'MODEL_SWITCH_INSUFFICIENT_BALANCE',
    })
    expect(confirmDialog).not.toHaveBeenCalled()
  },
)

test('silent API business refusals retain their code instead of becoming missing consent', async () => {
  const error = new ApiError({
    status: 409,
    code: 'MODEL_SWITCH_QUOTE_CHANGED',
    message: '报价已变更',
  })
  vi.spyOn(api, 'modelSwitchCost').mockRejectedValue(error)
  const authorize = createModelSwitchCostAuthorizer({
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
    confirmDialog: vi.fn(),
    toast: vi.fn(),
  })
  await expect(
    authorize(
      { sessionId: 'own', requestId: 'm-changed', targetModel: 'gpt-6-astra', agentId: 'main' },
      { interactive: false },
    ),
  ).rejects.toBe(error)
})

test('direct-switch alt confirms the paid quote and returns its consent', async () => {
  const input = { sessionId: 'own', requestId: 'm-paid-alt', targetModel: 'gpt-6-astra', agentId: 'main' }
  const quote = { ...fixtureSwitchQuote(input), requiresConfirmation: true, quoteToken: 'quote-alt' }
  const request = vi.spyOn(api, 'modelSwitchCost')
    .mockResolvedValueOnce(quote)
    .mockResolvedValueOnce({ ...quote, requiresConfirmation: false, consent: 'paid-alt-consent' })
  const confirmDialog = vi.fn().mockResolvedValue('alt')
  const authorize = createModelSwitchCostAuthorizer({
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') }, confirmDialog, toast: vi.fn(),
  })
  expect(await authorize(input, { notice: { title: '切换模型？', altText: '直接切换' } }))
    .toEqual({ requestId: input.requestId, choice: 'alt', consent: 'paid-alt-consent' })
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1][2]).toEqual({ quoteToken: 'quote-alt' })
})
