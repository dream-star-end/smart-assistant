import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { AuthSession } from '../lib/types'
import { createMemoryAuthSession } from '../lib/authSession'
import { api } from '../lib/api'
import { useWorkspacePreparation } from './useWorkspacePreparation'
vi.mock('../lib/api', () => ({ api: { prepareWorkspace: vi.fn(() => Promise.resolve({ accepted: true })) } }))
const auth = createMemoryAuthSession(() => {})
auth.commitToken(auth.beginIdentity(), 'fixture-only')
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks() })
test('visible authenticated workspace prepares before hydration and only once per identity', () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { rerender } = renderHook(({ a, id }) => useWorkspacePreparation(a, true, id),
    { initialProps: { a: auth as AuthSession | null, id: '1' as string | null } })
  expect(api.prepareWorkspace).toHaveBeenCalledTimes(1)
  rerender({ a: { ...auth }, id: '1' })
  expect(api.prepareWorkspace).toHaveBeenCalledTimes(1)
  expect(vi.mocked(api.prepareWorkspace).mock.calls[0][1]?.aborted).toBe(false)
  rerender({ a: null, id: null })
  rerender({ a: auth, id: '2' })
  expect(api.prepareWorkspace).toHaveBeenCalledTimes(2)
})
test('anonymous, nonworkspace and hidden pages do not wake containers; foreground starts once', () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const { rerender } = renderHook(({ enabled, a }) => useWorkspacePreparation(a, enabled, '1'),
    { initialProps: { enabled: false, a: null as AuthSession | null } })
  rerender({ enabled: false, a: auth })
  rerender({ enabled: true, a: auth })
  expect(api.prepareWorkspace).not.toHaveBeenCalled()
  visibility.mockReturnValue('visible')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(api.prepareWorkspace).toHaveBeenCalledTimes(1)
})
test('best effort preparation failure does not change the normal socket path', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.mocked(api.prepareWorkspace).mockRejectedValueOnce(Error('offline'))
  renderHook(() => useWorkspacePreparation(auth, true, '1'))
  await act(async () => { await Promise.resolve() })
  expect(api.prepareWorkspace).toHaveBeenCalledTimes(1)
})

test('StrictMode replay leaves a live preparation request', () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  renderHook(() => useWorkspacePreparation(auth, true, '1'),
    { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> })
  const calls = vi.mocked(api.prepareWorkspace).mock.calls
  expect(calls.length).toBeGreaterThanOrEqual(1)
  expect(calls.at(-1)?.[1]?.aborted).toBe(false)
})
