import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { api } from '../lib/api'
import type { User } from '../lib/types'
import { useAuth } from './useAuth'
vi.mock('../lib/authHint', () => ({ hasAuthHint: () => false, setAuthHint: () => {}, clearAuthHint: () => {}, subscribeAuthHintSet: () => () => {} }))
vi.mock('../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, api: { ...actual.api,
    login: vi.fn(), getMe: vi.fn(), prepareWorkspace: vi.fn(() => Promise.resolve({ accepted: true })) } }
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks() })
test('login starts preparation after lane decision before any chat hydration; balance refresh does not repeat it', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const user: Awaited<ReturnType<typeof api.getMe>> = { id: '42', email: 'fixture@example.invalid', role: 'user', displayName: 'Fixture', roles: [], lane: null }
  vi.mocked(api.login).mockResolvedValueOnce({ accessToken: 'fixture-only', user, lane: null } as Awaited<ReturnType<typeof api.login>>)
  vi.mocked(api.getMe).mockResolvedValue(user)
  const { result } = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: () => {} }))
  expect(api.prepareWorkspace).not.toHaveBeenCalled()
  await act(async () => { await result.current.login('fixture@example.invalid', 'fixture-only', 'fixture-only') })
  expect(result.current.laneReady).toBe(true)
  expect(api.prepareWorkspace).toHaveBeenCalledTimes(1)
  expect(vi.mocked(api.prepareWorkspace).mock.calls[0][1]?.aborted).toBe(false)
  await act(async () => { await result.current.refreshMe() })
  expect(api.prepareWorkspace).toHaveBeenCalledTimes(1)
  act(() => result.current.clearAuth())
  expect(vi.mocked(api.prepareWorkspace).mock.calls[0][1]?.aborted).toBe(true)
})
test('demo never asks for container preparation', () => {
  renderHook(() => useAuth({ demo: true, initialUser: { id: 'demo' } as User, onClearAuth: () => {} }))
  expect(api.prepareWorkspace).not.toHaveBeenCalled()
})
