import { createMemoryAuthSession } from '../lib/authSession'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { identityIsCurrent } from '../lib/resolvedIdentity'
import { useAuth } from './useAuth'
import { clearAuthHint, setAuthHint } from '../lib/authHint'
vi.mock('../lib/authHint', () => ({ hasAuthHint: () => false, setAuthHint: vi.fn(), clearAuthHint: vi.fn() }))
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const wireUser = (id: string) => ({ id, role: 'user', email: `${id}@example.invalid`, display_name: id })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('a verified different UID suspends the old workspace but keeps valid credentials for explicit switching', async () => {
  const pendingMe = deferred<Response>()
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/auth/login'
    ? reply({ access_token: 'alice-a', user: wireUser('alice') })
    : String(url) === '/api/me' ? pendingMe.promise : reply({ accepted: true }))
  vi.stubGlobal('fetch', fetcher)
  const onClearAuth = vi.fn(), onLogout = vi.fn(), onAccountSwitchPending = vi.fn()
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth, onLogout, onAccountSwitchPending }))
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  const original = view.result.current.resolvedIdentity
  expect(identityIsCurrent(original, view.result.current.authRef.current, 'alice')).toBe(true)
  act(() => { view.result.current.authRef.current.commitToken(1, 'bob-b') })
  const current = view.result.current.authRef.current.snapshot()
  expect(view.result.current.user?.id).toBe('alice')
  expect(view.result.current.resolvedIdentity).toBeNull()
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/me')).toHaveLength(1))
  await act(async () => { pendingMe.resolve(reply({ user: wireUser('bob') })); await pendingMe.promise })
  await waitFor(() => expect(view.result.current.pendingAccount?.id).toBe('bob'))
  expect(view.result.current.authed).toBe(false)
  expect(view.result.current.auth).toBeNull()
  expect(view.result.current.laneReady).toBe(false)
  expect(view.result.current.resolvedIdentity).toBeNull()
  expect(view.result.current.authRef.current.snapshot()).toEqual(current)
  expect(clearAuthHint).not.toHaveBeenCalled()
  expect(setAuthHint).toHaveBeenCalledTimes(1)
  expect(onClearAuth).not.toHaveBeenCalled()
  expect(onLogout).not.toHaveBeenCalled()
  expect(onAccountSwitchPending).toHaveBeenCalledTimes(1)
  expect(identityIsCurrent(original, view.result.current.authRef.current)).toBe(false)
  act(() => { view.result.current.acceptAccountSwitch() })
  expect(view.result.current.pendingAccount).toBeNull()
  expect(view.result.current.resolvedIdentity?.userId).toBe('bob')
  expect(view.result.current.authed).toBe(true)
  expect(view.result.current.authRef.current.snapshot()).toEqual(current)
  expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/auth/login')).toHaveLength(1)
  expect(fetcher.mock.calls.some(([url]) => String(url) === '/api/auth/logout')).toBe(false)
})
it('an expired pending-account proof cannot restore that account with a later token', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/auth/login'
    ? reply({ access_token: 'alice-a', user: wireUser('alice') })
    : String(url) === '/api/me' ? reply({ user: wireUser('bob') }) : reply({ accepted: true })))
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: vi.fn() }))
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  act(() => { view.result.current.authRef.current.commitToken(1, 'bob-b') })
  await waitFor(() => expect(view.result.current.pendingAccount?.id).toBe('bob'))
  const accept = view.result.current.acceptAccountSwitch
  act(() => { view.result.current.authRef.current.commitToken(1, 'later-token') })
  act(accept)
  expect(view.result.current.authed).toBe(false)
  expect(view.result.current.accountSwitchReady).toBe(false)
  expect(view.result.current.resolvedIdentity).toBeNull()
  expect(view.result.current.authRef.current.snapshot()).toEqual({ epoch: 1, token: 'later-token' })
  expect(clearAuthHint).not.toHaveBeenCalled()
})
it('a stale /me cannot overwrite a subsequent login and a same-user fresh login creates a new capability', async () => {
  const pendingMe = deferred<Response>()
  let login = 0
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url) === '/api/auth/login') return reply({ access_token: `alice-${++login}`, user: wireUser('alice') })
    if (String(url) === '/api/me') return pendingMe.promise
    return reply({ accepted: true })
  }))
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: () => {} }))
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  const original = view.result.current.resolvedIdentity
  act(() => { view.result.current.authRef.current.commitToken(1, 'refresh-token') })
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  const current = view.result.current.resolvedIdentity
  expect(current).not.toBe(original)
  await act(async () => { pendingMe.resolve(reply({ user: wireUser('stale') })); await pendingMe.promise })
  expect(view.result.current.user?.id).toBe('alice')
  expect(view.result.current.resolvedIdentity).toBe(current)
  act(() => { view.result.current.logout() })
  expect(view.result.current.resolvedIdentity).toBeNull()
  expect(identityIsCurrent(current, view.result.current.authRef.current)).toBe(false)
})
it('failed /me leaves callbacks unresolved without a retry loop or clearing the displayed login', async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/auth/login'
    ? reply({ access_token: 'alice-a', user: wireUser('alice') })
    : String(url) === '/api/me' ? reply({ error: { code: 'INTERNAL', message: 'fixture' } }, 503) : reply({ accepted: true }))
  vi.stubGlobal('fetch', fetcher)
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: () => {} }))
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  act(() => { view.result.current.authRef.current.commitToken(1, 'alice-b') })
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/me')).toHaveLength(1))
  view.rerender()
  expect(view.result.current.authed).toBe(true)
  expect(view.result.current.user?.id).toBe('alice')
  expect(view.result.current.resolvedIdentity).toBeNull()
  expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/me')).toHaveLength(1)
})
it('verified balance updates preserve the capability; the display setter revokes it synchronously', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/auth/login'
    ? reply({ access_token: 'alice-a', user: wireUser('alice') })
    : String(url) === '/api/me' ? reply({ user: { ...wireUser('alice'), credits: '321' } }) : reply({ accepted: true })))
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: () => {} }))
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  const identity = view.result.current.resolvedIdentity
  await act(async () => { await view.result.current.refreshMe() })
  expect(view.result.current.user?.credits).toBe('321')
  expect(view.result.current.resolvedIdentity).toBe(identity)
  act(() => {
    view.result.current.setUser(previous => previous && { ...previous, displayName: 'display only' })
    expect(identityIsCurrent(identity, view.result.current.authRef.current)).toBe(false)
  })
})
it('a replacement effect subscribes to the same pending identity read after a display-only update', async () => {
  const pendingMe = deferred<Response>()
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/auth/login'
    ? reply({ access_token: 'alice-a', user: wireUser('alice') })
    : String(url) === '/api/me' ? pendingMe.promise : reply({ accepted: true }))
  vi.stubGlobal('fetch', fetcher)
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: () => {} }))
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  act(() => { view.result.current.authRef.current.commitToken(1, 'alice-b') })
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/me')).toHaveLength(1))
  act(() => { view.result.current.setUser(previous => previous && { ...previous, displayName: 'local display' }) })
  await act(async () => { pendingMe.resolve(reply({ user: wireUser('alice') })); await pendingMe.promise })
  await waitFor(() => expect(identityIsCurrent(view.result.current.resolvedIdentity, view.result.current.authRef.current, 'alice')).toBe(true))
  expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/me')).toHaveLength(1)
})

it('an auth object replacement at identical epoch/generation revalidates instead of retaining an unavailable scope', async () => {
  const fetcher = vi.fn<typeof fetch>(async url => String(url) === '/api/auth/login'
    ? reply({ access_token: 'alice-a', user: wireUser('alice') })
    : String(url) === '/api/me' ? reply({ user: wireUser('alice') }) : reply({ accepted: true }))
  vi.stubGlobal('fetch', fetcher)
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: () => {} }))
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  const original = view.result.current.resolvedIdentity
  const replacement = createMemoryAuthSession(() => {})
  replacement.commitToken(replacement.beginIdentity(), 'alice-a')
  expect(replacement.snapshot()).toEqual(view.result.current.authRef.current.snapshot())
  expect(replacement.getAccessGeneration()).toBe(view.result.current.authRef.current.getAccessGeneration())
  act(() => { view.result.current.authRef.current = replacement; view.rerender() })
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/me')).toHaveLength(1))
  await waitFor(() => expect(identityIsCurrent(view.result.current.resolvedIdentity, replacement, 'alice')).toBe(true))
  expect(identityIsCurrent(original, replacement)).toBe(false)
})
