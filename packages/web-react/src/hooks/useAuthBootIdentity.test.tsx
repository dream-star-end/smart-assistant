import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { identityIsCurrent } from '../lib/resolvedIdentity'
import { useAuth } from './useAuth'
vi.mock('../lib/authHint', () => ({ hasAuthHint: () => true, setAuthHint: () => {}, clearAuthHint: () => {} }))
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const refresh = () => reply({ access_token: 'alice-a', access_exp: 9999999999, remember: false })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('a malformed current /me identity fails closed once instead of retrying the unchanged token indefinitely', async () => {
  const fetcher = vi.fn<typeof fetch>(async url => String(url) === '/api/auth/refresh' ? refresh()
    : String(url) === '/api/me' ? reply({ user: { id: 17, role: 'user' } }) : reply({ accepted: true }))
  vi.stubGlobal('fetch', fetcher)
  const onClearAuth = vi.fn()
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth }))
  await waitFor(() => expect(view.result.current.booting).toBe(false))
  expect(view.result.current.authed).toBe(false)
  expect(view.result.current.resolvedIdentity).toBeNull()
  expect(onClearAuth).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/me')).toHaveLength(1)
})
it('a stale /me during same-epoch token change rechecks the actual current attempt without clearing that identity', async () => {
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  let reads = 0
  const fetcher = vi.fn<typeof fetch>(async url => String(url) === '/api/auth/refresh' ? refresh()
    : String(url) === '/api/me' ? ++reads === 1 ? pending : reply({ user: { id: 'alice', role: 'user' } }) : reply({ accepted: true }))
  vi.stubGlobal('fetch', fetcher)
  const onClearAuth = vi.fn()
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth }))
  await waitFor(() => expect(reads).toBe(1))
  await act(async () => {
    view.result.current.authRef.current.commitToken(0, 'alice-b')
    release(reply({ user: { id: 'alice', role: 'user' } }))
    await pending
  })
  await waitFor(() => expect(view.result.current.booting).toBe(false))
  expect(view.result.current.authed).toBe(true)
  expect(identityIsCurrent(view.result.current.resolvedIdentity, view.result.current.authRef.current, 'alice')).toBe(true)
  expect(onClearAuth).not.toHaveBeenCalled()
  expect(reads).toBe(2)
})
