import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryAuthSession } from '../lib/authSession'
import { useInbox } from './useInbox'
const getInboxUnreadCount = vi.hoisted(() => vi.fn())
vi.mock('../lib/api', () => ({ api: { getInboxUnreadCount } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('a confirmed fresh unread snapshot retires an older in-flight poll response', async () => {
  let resolveOld!: (count: number) => void
  getInboxUnreadCount.mockImplementationOnce(() => new Promise<number>(resolve => { resolveOld = resolve }))
  const auth = createMemoryAuthSession(() => {}, 'synthetic-access')
  const { result } = renderHook(() => useInbox(auth, true))
  await waitFor(() => expect(getInboxUnreadCount).toHaveBeenCalledTimes(1))
  act(() => { result.current.applyUnreadCountSnapshot(3) })
  expect(result.current.unreadCount).toBe(3)
  await act(async () => { resolveOld(99) })
  expect(result.current.unreadCount).toBe(3)
})
it('identity changes drop an older poll and wait for a new access token before requesting the next account', async () => {
  let resolveOld!: (count: number) => void
  getInboxUnreadCount.mockImplementationOnce(() => new Promise<number>(resolve => { resolveOld = resolve })).mockResolvedValueOnce(5)
  const auth = createMemoryAuthSession(() => {}, 'synthetic-a')
  const view = renderHook(() => useInbox(auth, true))
  await waitFor(() => expect(getInboxUnreadCount).toHaveBeenCalledTimes(1))
  act(() => { auth.beginIdentity() })
  await act(async () => { resolveOld(99) })
  expect(view.result.current.unreadCount).toBe(0)
  expect(getInboxUnreadCount).toHaveBeenCalledTimes(1)
  act(() => { auth.commitToken(auth.snapshot().epoch, 'synthetic-b') })
  await waitFor(() => expect(view.result.current.unreadCount).toBe(5))
  expect(getInboxUnreadCount).toHaveBeenCalledTimes(2)
})
