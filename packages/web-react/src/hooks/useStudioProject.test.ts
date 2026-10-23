import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const project = vi.fn()
vi.mock('../lib/studio/api', () => ({
  studioApi: { project: (...args: unknown[]) => project(...args) },
  StudioApiError: class StudioApiError extends Error {},
}))
vi.mock('../lib/api', () => ({ AuthEpochStaleError: class AuthEpochStaleError extends Error {} }))

import { emitStudioPush } from '../lib/studio/push'
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
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

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

describe('useStudioProject push (OCV5-593 FE-6)', () => {
  test('a push for this project reloads it; other projects do not; a reopened socket does', async () => {
    project.mockResolvedValue(view('done'))
    const auth = {} as never
    renderHook(() => useStudioProject(auth, 'p'))
    await act(async () => {})
    expect(project).toHaveBeenCalledTimes(1)
    await act(async () => {
      emitStudioPush('other')
    })
    expect(project).toHaveBeenCalledTimes(1)
    await act(async () => {
      emitStudioPush('p')
    })
    expect(project).toHaveBeenCalledTimes(2)
    await act(async () => {
      emitStudioPush(null)
    })
    expect(project).toHaveBeenCalledTimes(3)
  })

  test('a push during a request reloads once more after it, not in parallel', async () => {
    project.mockResolvedValueOnce(view('done'))
    const auth = {} as never
    const { result } = renderHook(() => useStudioProject(auth, 'p'))
    await act(async () => {})
    let release: (v: unknown) => void = () => {}
    project.mockImplementationOnce(() => new Promise((r) => (release = r)))
    project.mockResolvedValueOnce(view('running'))
    await act(async () => {
      emitStudioPush('p')
      emitStudioPush('p')
    })
    expect(project).toHaveBeenCalledTimes(2)
    await act(async () => {
      release(view('done'))
    })
    expect(project).toHaveBeenCalledTimes(3)
    expect(result.current.state).toMatchObject({ view: { project: { status: 'running' } } })
  })
})
