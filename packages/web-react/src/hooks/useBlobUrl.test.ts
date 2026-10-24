import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const blobTicket = vi.fn()
vi.mock('../lib/studio/api', () => ({
  studioApi: { blobTicket: (...a: unknown[]) => blobTicket(...a) },
}))

import { __resetBlobTickets, useBlobUrl } from './useBlobUrl'

const auth = { snapshot: () => ({ token: 't', epoch: 1 }) } as never

beforeEach(() => {
  vi.useFakeTimers()
  __resetBlobTickets()
  blobTicket.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('useBlobUrl (OCV5-593 FE-2a code r1)', () => {
  test('never returns the previous sha URL while the new ticket is pending', async () => {
    let release: (v: unknown) => void = () => {}
    blobTicket.mockImplementation(async (_a: unknown, sha: string) =>
      sha === 'A' ? { url: '/a', expiresInSeconds: 900 } : new Promise((r) => (release = r)),
    )
    const { result, rerender } = renderHook(({ sha }) => useBlobUrl(auth, sha), {
      initialProps: { sha: 'A' },
    })
    await act(async () => {})
    expect(result.current).toBe('/a')
    rerender({ sha: 'B' })
    expect(result.current).toBeNull()
    await act(async () => release({ url: '/b', expiresInSeconds: 900 }))
    expect(result.current).toBe('/b')
  })

  test('a failed ticket request is retried with backoff instead of ending the chain', async () => {
    blobTicket
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ url: '/a', expiresInSeconds: 900 })
    const { result } = renderHook(() => useBlobUrl(auth, 'A'))
    await act(async () => {})
    expect(result.current).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(blobTicket).toHaveBeenCalledTimes(2)
    expect(result.current).toBe('/a')
  })
})
