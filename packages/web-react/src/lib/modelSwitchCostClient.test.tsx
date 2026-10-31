import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { api, ApiError } from './api'
import { createMemoryAuthSession } from './authSession'
import { createModelSwitchCostAuthorizer } from './modelSwitchCostClient'
import { fixtureSwitchQuote } from '../../browser-tests/model-switch-cost-fixture.mjs'
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
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

const switchInput = (requestId: string) => ({
  sessionId: 'own',
  requestId,
  targetModel: 'gpt-6-astra',
  agentId: 'main',
})

test('a confirmed switch is not asked again when the send quote still needs a token', async () => {
  const select = switchInput('m-select')
  vi.spyOn(api, 'modelSwitchCost').mockImplementation(async (_auth, input, proof) => {
    if (proof?.quoteToken) {
      return {
        ...fixtureSwitchQuote(input),
        requiresConfirmation: false,
        consent: `c-${proof.quoteToken}`,
      }
    }
    if (proof?.consent) {
      return { ...fixtureSwitchQuote(input), requiresConfirmation: true, quoteToken: 'q-send' }
    }
    return { ...fixtureSwitchQuote(input), requiresConfirmation: true, quoteToken: 'q-select' }
  })
  const confirmDialog = vi.fn().mockResolvedValue(true)
  const authorize = createModelSwitchCostAuthorizer({
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
    confirmDialog,
    toast: vi.fn(),
  })
  expect(
    await authorize(select, {
      notice: { title: '切换模型？', confirmText: '压缩并切换', altText: '直接切换' },
      primeNextTurn: true,
    }),
  ).toEqual({ requestId: 'm-select', choice: true, consent: 'c-q-select' })
  expect(confirmDialog).toHaveBeenCalledTimes(1)
  expect(confirmDialog.mock.calls[0]?.[0]).toMatchObject({
    title: '切换模型？',
    confirmText: '压缩并切换',
    altText: '直接切换',
  })
  expect(
    await authorize(
      { ...select, requestId: 'm-send' },
      { useCachedRequestId: true },
    ),
  ).toEqual({ requestId: 'm-select', choice: true, consent: 'c-q-send' })
  expect(confirmDialog).toHaveBeenCalledTimes(1)
})

test('a notice-only confirm is reused when the later send needs a quote token', async () => {
  const select = switchInput('m-notice')
  let calls = 0
  vi.spyOn(api, 'modelSwitchCost').mockImplementation(async (_auth, input, proof) => {
    calls += 1
    if (proof?.quoteToken) {
      return { ...fixtureSwitchQuote(input), requiresConfirmation: false, consent: 'c-send' }
    }
    if (calls === 1) return fixtureSwitchQuote(input)
    return { ...fixtureSwitchQuote(input), requiresConfirmation: true, quoteToken: 'q-send' }
  })
  const confirmDialog = vi.fn().mockResolvedValue(true)
  const authorize = createModelSwitchCostAuthorizer({
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
    confirmDialog,
    toast: vi.fn(),
  })
  expect(
    await authorize(select, { notice: { title: '切换模型？' }, primeNextTurn: true }),
  ).toEqual({ requestId: 'm-notice', choice: true })
  expect(confirmDialog).toHaveBeenCalledTimes(1)
  expect(
    await authorize({ ...select, requestId: 'm-send' }, { useCachedRequestId: true }),
  ).toEqual({ requestId: 'm-notice', choice: true, consent: 'c-send' })
  expect(confirmDialog).toHaveBeenCalledTimes(1)
})

test('an exempt prime that never showed a dialog still asks on the send', async () => {
  const select = switchInput('m-unconfirmed')
  let calls = 0
  vi.spyOn(api, 'modelSwitchCost').mockImplementation(async (_auth, input, proof) => {
    calls += 1
    if (proof?.quoteToken) {
      return { ...fixtureSwitchQuote(input), requiresConfirmation: false, consent: 'c-later' }
    }
    if (calls === 1) return fixtureSwitchQuote(input)
    return { ...fixtureSwitchQuote(input), requiresConfirmation: true, quoteToken: 'q-later' }
  })
  const confirmDialog = vi.fn().mockResolvedValue(true)
  const authorize = createModelSwitchCostAuthorizer({
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
    confirmDialog,
    toast: vi.fn(),
  })
  expect(await authorize(select, { primeNextTurn: true })).toEqual({
    requestId: 'm-unconfirmed',
    choice: true,
  })
  expect(confirmDialog).not.toHaveBeenCalled()
  expect(
    await authorize({ ...select, requestId: 'm-send' }, { useCachedRequestId: true }),
  ).toEqual({ requestId: 'm-unconfirmed', choice: true, consent: 'c-later' })
  expect(confirmDialog).toHaveBeenCalledTimes(1)
})

test('cancelling the switch does not suppress the next prompt', async () => {
  const input = switchInput('m-cancel')
  vi.spyOn(api, 'modelSwitchCost').mockImplementation(async (_auth, quoted, proof) => {
    if (proof?.quoteToken) {
      return { ...fixtureSwitchQuote(quoted), requiresConfirmation: false, consent: 'c-after-cancel' }
    }
    return { ...fixtureSwitchQuote(quoted), requiresConfirmation: true, quoteToken: 'q-cancel' }
  })
  const confirmDialog = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const authorize = createModelSwitchCostAuthorizer({
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
    confirmDialog,
    toast: vi.fn(),
  })
  expect(await authorize(input, { notice: { title: '切换模型？' }, primeNextTurn: true })).toBeNull()
  expect(
    await authorize(input, { primeNextTurn: true }),
  ).toEqual({ requestId: 'm-cancel', choice: true, consent: 'c-after-cancel' })
  expect(confirmDialog).toHaveBeenCalledTimes(2)
})

test('a non-interactive send does not treat the earlier confirm as silent consent', async () => {
  const select = switchInput('m-silent')
  vi.spyOn(api, 'modelSwitchCost').mockImplementation(async (_auth, input, proof) => {
    if (proof?.quoteToken) {
      return { ...fixtureSwitchQuote(input), requiresConfirmation: false, consent: 'c-silent' }
    }
    return { ...fixtureSwitchQuote(input), requiresConfirmation: true, quoteToken: 'q-silent' }
  })
  const confirmDialog = vi.fn().mockResolvedValue(true)
  const authorize = createModelSwitchCostAuthorizer({
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
    confirmDialog,
    toast: vi.fn(),
  })
  expect(
    await authorize(select, { notice: { title: '切换模型？' }, primeNextTurn: true }),
  ).toMatchObject({ consent: 'c-silent' })
  expect(
    await authorize({ ...select, requestId: 'm-send' }, { useCachedRequestId: true, interactive: false }),
  ).toBeNull()
  expect(confirmDialog).toHaveBeenCalledTimes(1)
})

async function openPriceDialog(listedX?: { from?: number; to?: number }, quotePatch?: object) {
  const input = switchInput(`m-price-${listedX?.to ?? 'x'}-${quotePatch ? 'patch' : 'plain'}`)
  vi.spyOn(api, 'modelSwitchCost').mockResolvedValue({
    ...fixtureSwitchQuote(input),
    ...quotePatch,
  } as never)
  const confirmDialog = vi.fn().mockResolvedValue(false)
  const authorize = createModelSwitchCostAuthorizer({
    authRef: { current: createMemoryAuthSession(() => {}, 'fixture') },
    confirmDialog,
    toast: vi.fn(),
  })
  expect(await authorize(input, { notice: { title: '切换模型？' }, listedX })).toBeNull()
  expect(confirmDialog).toHaveBeenCalledTimes(1)
  render(confirmDialog.mock.calls[0]?.[0].body)
}

test('listed price direction overrides a higher first-turn estimate', async () => {
  await openPriceDialog({ from: 5, to: 1 })
  expect(screen.getByText('切换后首次会话将重建全部上下文，价格更低')).toBeInTheDocument()
  expect(screen.queryByText('切换后首次会话将重建全部上下文，价格较高')).toBeNull()
})

test('without a list price, a higher first-turn estimate still says 价格较高', async () => {
  await openPriceDialog()
  expect(screen.getByText('切换后首次会话将重建全部上下文，价格较高')).toBeInTheDocument()
})

test('an equal list price says 价格相同', async () => {
  await openPriceDialog({ from: 2, to: 2 })
  expect(screen.getByText('切换后首次会话将重建全部上下文，价格相同')).toBeInTheDocument()
})

test('an exempt quote with no prices drops the price adjective', async () => {
  await openPriceDialog(undefined, {
    mode: 'exempt',
    contextTokens: null,
    outputTokens: null,
    targetCost: null,
    currentCost: null,
    targetUnitPrice: null,
    balanceCredits: null,
    requiresConfirmation: false,
  })
  expect(screen.getByText('切换后首次会话将重建全部上下文')).toBeInTheDocument()
  expect(screen.queryByText(/价格/)).toBeNull()
})
