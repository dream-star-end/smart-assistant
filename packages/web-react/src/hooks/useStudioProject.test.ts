import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const project = vi.fn()
vi.mock('../lib/studio/api', () => ({
  studioApi: { project: (...args: unknown[]) => project(...args) },
  StudioApiError: class StudioApiError extends Error {},
}))
vi.mock('../lib/api', () => ({ AuthEpochStaleError: class AuthEpochStaleError extends Error {} }))

import { STUDIO_POLL_MS, useStudioProject } from './useStudioProject'

const view = (status: string) => ({
  project: { id: 'p', status },
  shots: [],
  lines: [],
  assets: [],
  takes: [],
  events: [],
})

beforeEach(() => {
  vi.useFakeTimers()
  project.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('useStudioProject polling (OCV5-593 code r1 P1)', () => {
  test('a response slower than the poll period still lands; no overlapping polls', async () => {
    project.mockResolvedValueOnce(view('running'))
    const auth = {} as never
    const { result } = renderHook(() => useStudioProject(auth, 'p'))
    await act(async () => {})
    expect(result.current.state).toMatchObject({
      state: 'ready',
      view: { project: { status: 'running' } },
    })

    // Every later GET takes 4 s, longer than the 3 s poll period.
    project.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(view('done')), 4000)),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STUDIO_POLL_MS)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STUDIO_POLL_MS)
    })
    expect(project).toHaveBeenCalledTimes(2) // initial + one poll; the second tick was skipped
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(result.current.state).toMatchObject({
      state: 'ready',
      view: { project: { status: 'done' } },
    })
  })
})
