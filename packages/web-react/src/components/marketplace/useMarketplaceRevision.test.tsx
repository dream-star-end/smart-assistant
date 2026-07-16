import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { AuthSession } from '../../lib/types'

const getMarketplaceRevision = vi.fn()
vi.mock('../../lib/api', () => ({
  api: {
    getMarketplaceRevision: (...args: unknown[]) => getMarketplaceRevision(...args),
  },
}))

import { MARKETPLACE_REVISION_POLL_MS, useMarketplaceRevision } from './useMarketplaceRevision'

const auth: AuthSession = createMemoryAuthSession(() => {}, 'tok')

function Harness({ onChange }: { onChange: () => void }) {
  useMarketplaceRevision({ auth, enabled: true, onChange })
  return null
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('首个 token 只建基线；相等不刷新，不相等只刷新一次', async () => {
  vi.useFakeTimers()
  getMarketplaceRevision
    .mockResolvedValueOnce({ revision: '10' })
    .mockResolvedValueOnce({ revision: '10' })
    .mockResolvedValueOnce({ revision: '13' })
  const onChange = vi.fn()
  render(<Harness onChange={onChange} />)
  await act(async () => Promise.resolve())
  expect(onChange).not.toHaveBeenCalled()

  await act(async () => vi.advanceTimersByTimeAsync(MARKETPLACE_REVISION_POLL_MS))
  expect(onChange).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(MARKETPLACE_REVISION_POLL_MS))
  expect(onChange).toHaveBeenCalledTimes(1)
})

test('页面隐藏时暂停，恢复可见立即校准', async () => {
  vi.useFakeTimers()
  let visibility: DocumentVisibilityState = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  getMarketplaceRevision.mockResolvedValue({ revision: '10' })
  render(<Harness onChange={() => {}} />)
  await act(async () => Promise.resolve())
  expect(getMarketplaceRevision).toHaveBeenCalledTimes(1)

  visibility = 'hidden'
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await act(async () => vi.advanceTimersByTimeAsync(MARKETPLACE_REVISION_POLL_MS * 2))
  expect(getMarketplaceRevision).toHaveBeenCalledTimes(1)

  visibility = 'visible'
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(getMarketplaceRevision).toHaveBeenCalledTimes(2)
})
