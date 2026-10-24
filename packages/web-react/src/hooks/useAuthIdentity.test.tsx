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
  const onClearAuth = vi.fn()
  const onLogout = vi.fn()
  const onAccountSwitchPending = vi.fn()
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
it('generation revalidation retries transient failures twice, then offers an explicit recovery without losing login', async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/auth/login'
    ? reply({ access_token: 'alice-a', user: wireUser('alice') })
    : String(url) === '/api/me' ? reply({ error: { code: 'INTERNAL', message: 'fixture' } }, 503) : reply({ accepted: true }))
  vi.stubGlobal('fetch', fetcher)
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: vi.fn() }))
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  act(() => { view.result.current.authRef.current.commitToken(1, 'alice-b') })
  expect(view.result.current.resolvedIdentity).toBeNull()
  await waitFor(() => expect(view.result.current.authRecoveryAvailable).toBe(true))
  view.rerender()
  expect(view.result.current.authed).toBe(true)
  expect(view.result.current.user?.id).toBe('alice')
  expect(view.result.current.resolvedIdentity).toBeNull()
  expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/me')).toHaveLength(2)
  expect(clearAuthHint).not.toHaveBeenCalled()
  fetcher.mockImplementation(async url => String(url) === '/api/auth/refresh'
    ? reply({ access_token: 'alice-b', access_exp: 9999999999, remember: false })
    : reply({ user: wireUser('alice') }))
  act(() => { view.result.current.retryBoot() })
  await waitFor(() => expect(identityIsCurrent(view.result.current.resolvedIdentity, view.result.current.authRef.current, 'alice')).toBe(true))
  expect(view.result.current.authRecoveryAvailable).toBe(false)
  expect(clearAuthHint).not.toHaveBeenCalled()
})
it('a transient generation check recovers automatically on its bounded second read', async () => {
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/auth/login'
    ? reply({ access_token: 'alice-a', user: wireUser('alice') })
    : String(url) === '/api/me' ? ++reads === 1 ? reply({}, 503) : reply({ user: wireUser('alice') }) : reply({ accepted: true })))
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: vi.fn() }))
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  act(() => { view.result.current.authRef.current.commitToken(1, 'alice-b') })
  expect(view.result.current.resolvedIdentity).toBeNull()
  await waitFor(() => expect(identityIsCurrent(view.result.current.resolvedIdentity, view.result.current.authRef.current, 'alice')).toBe(true))
  expect(reads).toBe(2)
})
it('401 reads that rotate tokens cannot turn generation revalidation into an unbounded refresh loop', async () => {
  let refreshes = 0
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/auth/login'
    ? reply({ access_token: 'alice-a', user: wireUser('alice') })
    : String(url) === '/api/auth/refresh' ? reply({ access_token: `alice-refresh-${++refreshes}`, access_exp: 9999999999, remember: false })
    : String(url) === '/api/me' ? reply({}, 401) : reply({ accepted: true }))
  vi.stubGlobal('fetch', fetcher)
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: vi.fn() }))
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  act(() => { view.result.current.authRef.current.commitToken(1, 'alice-b') })
  await waitFor(() => expect(view.result.current.authRecoveryAvailable).toBe(true))
  view.rerender()
  expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/me')).toHaveLength(4)
  expect(refreshes).toBe(2)
  expect(view.result.current.authed).toBe(true)
  expect(view.result.current.resolvedIdentity).toBeNull()
  expect(clearAuthHint).not.toHaveBeenCalled()
})
it('verified balance and same-account display updates preserve the current proof', async () => {
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
    expect(identityIsCurrent(identity, view.result.current.authRef.current)).toBe(true)
  })
  expect(view.result.current.resolvedIdentity).toBe(identity)
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

it('a display setter cannot grant another UID or revive a revoked proof when its id returns', async () => {
  const pending = deferred<Response>()
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/auth/login'
    ? reply({ access_token: 'alice-a', user: wireUser('alice') }) : String(url) === '/api/me' ? pending.promise : reply({ accepted: true })))
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: vi.fn() }))
  await act(async () => { await view.result.current.login('fixture', 'fixture', 'fixture') })
  const original = view.result.current.resolvedIdentity
  act(() => {
    view.result.current.setUser(previous => previous && { ...previous, id: 'unverified-display-id' })
    expect(identityIsCurrent(original, view.result.current.authRef.current)).toBe(false)
  })
  expect(view.result.current.resolvedIdentity).toBeNull()
  act(() => { view.result.current.setUser(previous => previous && { ...previous, id: 'alice' }) })
  expect(identityIsCurrent(original, view.result.current.authRef.current)).toBe(false)
  expect(view.result.current.resolvedIdentity).toBeNull()
  await act(async () => { pending.resolve(reply({ user: wireUser('alice') })); await pending.promise })
  await waitFor(() => expect(view.result.current.resolvedIdentity).not.toBeNull())
  expect(view.result.current.resolvedIdentity).not.toBe(original)
})
