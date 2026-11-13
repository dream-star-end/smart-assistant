import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SESSION_EXPIRED_MESSAGE, SESSION_SUPERSEDED_MESSAGE, useAuth } from './useAuth'

// OCV5-636: the refresh cookie is shared by every tab, so a tab left on the signed-out landing
// must rejoin when another tab signs in, and a tab kicked mid-use must say so instead of
// silently showing the marketing page. Uses the real authHint module (jsdom localStorage).
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const refreshOk = () => reply({ access_token: 'alice-a', access_exp: 9999999999, remember: true })
const invalid = () => reply({ error: { code: 'INVALID_REFRESH', message: 'refresh token invalid or expired' } }, 401)
const race = () => reply({ error: { code: 'REFRESH_RACE', message: 'refresh token rotation race' } }, 401)
const hintSet = (key = 'oc_auth_hint', newValue: string | null = '1') =>
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue })) })
const refreshCalls = (fetcher: { mock: { calls: unknown[][] } }) => fetcher.mock.calls.filter(([url]) => String(url) === '/api/auth/refresh').length
function signedInFetch() {
  return vi.fn<typeof fetch>(async url => String(url) === '/api/auth/refresh' ? refreshOk()
    : String(url) === '/api/me' ? reply({ user: { id: 'alice', role: 'user' } }) : reply({ ok: true }))
}
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

it('a signed-out tab silently re-boots when another tab signs in', async () => {
  const fetcher = signedInFetch()
  vi.stubGlobal('fetch', fetcher)
  const onBootAuthed = vi.fn()
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: vi.fn(), onBootAuthed }))
  expect(view.result.current.booting).toBe(false)
  expect(refreshCalls(fetcher)).toBe(0)
  hintSet()
  await waitFor(() => expect(view.result.current.authed).toBe(true))
  expect(view.result.current.user?.id).toBe('alice')
  expect(refreshCalls(fetcher)).toBe(1)
  expect(onBootAuthed).toHaveBeenCalledTimes(1)
})

it('ignores hint removal, other keys, reset links and tabs that are already signed in', async () => {
  const fetcher = signedInFetch()
  vi.stubGlobal('fetch', fetcher)
  const anon = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: vi.fn() }))
  hintSet('oc_auth_hint', null)
  hintSet('oc_other_key', '1')
  const reset = renderHook(() => useAuth({ demo: false, resetToken: 'reset-token', initialUser: null, onClearAuth: vi.fn() }))
  expect(anon.result.current.booting).toBe(false)
  expect(refreshCalls(fetcher)).toBe(0)
  anon.unmount()
  hintSet()
  expect(reset.result.current.booting).toBe(false)
  expect(refreshCalls(fetcher)).toBe(0)
  reset.unmount()

  localStorage.setItem('oc_auth_hint', '1')
  const signedIn = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: vi.fn() }))
  await waitFor(() => expect(signedIn.result.current.authed).toBe(true))
  hintSet()
  expect(signedIn.result.current.booting).toBe(false)
  expect(refreshCalls(fetcher)).toBe(1)
})

it('in-page invalidation and a dead boot cookie both report expiry; explicit logout stays quiet', async () => {
  const fetcher = signedInFetch()
  vi.stubGlobal('fetch', fetcher)
  localStorage.setItem('oc_auth_hint', '1')
  const onClearAuth = vi.fn()
  const onSessionExpired = vi.fn()
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth, onSessionExpired }))
  await waitFor(() => expect(view.result.current.authed).toBe(true))
  act(() => { view.result.current.authRef.current.expire(view.result.current.authRef.current.snapshot().epoch) })
  expect(view.result.current.authed).toBe(false)
  expect(onClearAuth).toHaveBeenCalledTimes(1)
  expect(onSessionExpired).toHaveBeenCalledTimes(1)
  expect(view.result.current.authError).toBe(SESSION_EXPIRED_MESSAGE)
  expect(localStorage.getItem('oc_auth_hint')).toBeNull()
  view.unmount()

  localStorage.setItem('oc_auth_hint', '1')
  const loggedOut = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: vi.fn(), onSessionExpired }))
  await waitFor(() => expect(loggedOut.result.current.authed).toBe(true))
  act(() => { loggedOut.result.current.logout() })
  expect(loggedOut.result.current.authError).toBeNull()
  loggedOut.unmount()

  localStorage.setItem('oc_auth_hint', '1')
  fetcher.mockImplementation(async url => String(url) === '/api/auth/refresh' ? invalid() : reply({ ok: true }))
  const bootClear = vi.fn()
  const deadCookie = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: bootClear, onSessionExpired }))
  await waitFor(() => expect(bootClear).toHaveBeenCalledTimes(1))
  expect(deadCookie.result.current.authError).toBe(SESSION_EXPIRED_MESSAGE)
  expect(onSessionExpired).toHaveBeenCalledTimes(2)
})

// OCV5-638: both boot rounds ran the whole REFRESH_RACE ladder without ever seeing a new cookie — this
// browser's refresh cookie was replaced by a rotation whose Set-Cookie has not landed. Say so instead of
// blaming the network, but keep the session recoverable: a late keepalive response may still land the
// new cookie (Codex r1), so the hint stays and 「重试」/F5 can still pick it up.
it('a boot whose cookie was superseded asks to sign in again but keeps retry and F5 able to recover', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>(async url => String(url) === '/api/auth/refresh' ? race() : reply({ ok: true }))
  vi.stubGlobal('fetch', fetcher)
  localStorage.setItem('oc_auth_hint', '1')
  const onClearAuth = vi.fn()
  const onSessionExpired = vi.fn()
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth, onSessionExpired }))
  expect(view.result.current.booting).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  expect(view.result.current.booting).toBe(false)
  expect(view.result.current.authed).toBe(false)
  expect(view.result.current.authError).toBe(SESSION_SUPERSEDED_MESSAGE)
  expect(view.result.current.authRecoveryAvailable).toBe(true)
  expect(onClearAuth).not.toHaveBeenCalled()
  expect(refreshCalls(fetcher)).toBe(12)
  expect(localStorage.getItem('oc_auth_hint')).toBe('1')
  // Nothing keeps hammering the stale cookie toward the server's theft window on its own.
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(refreshCalls(fetcher)).toBe(12)

  // The late cookie landed: 「重试恢复登录状态」 signs the page in.
  fetcher.mockImplementation(async url => String(url) === '/api/auth/refresh' ? refreshOk()
    : String(url) === '/api/me' ? reply({ user: { id: 'alice', role: 'user' } }) : reply({ ok: true }))
  act(() => { view.result.current.retryBoot() })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(view.result.current.authed).toBe(true)
  expect(view.result.current.authError).toBeNull()
  expect(onSessionExpired).not.toHaveBeenCalled()
})

it('a retry after the superseded notice that the server rejects shows the expiry notice, not a silent landing', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>(async url => String(url) === '/api/auth/refresh' ? race() : reply({ ok: true }))
  vi.stubGlobal('fetch', fetcher)
  localStorage.setItem('oc_auth_hint', '1')
  const onClearAuth = vi.fn()
  const onSessionExpired = vi.fn()
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth, onSessionExpired }))
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  expect(view.result.current.authError).toBe(SESSION_SUPERSEDED_MESSAGE)
  // Past the grace window the server revokes the family as theft.
  fetcher.mockImplementation(async url => String(url) === '/api/auth/refresh' ? invalid() : reply({ ok: true }))
  act(() => { view.result.current.retryBoot() })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(view.result.current.booting).toBe(false)
  expect(view.result.current.authError).toBe(SESSION_EXPIRED_MESSAGE)
  expect(onClearAuth).toHaveBeenCalledTimes(1)
  expect(onSessionExpired).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem('oc_auth_hint')).toBeNull()
})

it('one race ladder followed by a network failure keeps the network recovery path', async () => {
  vi.useFakeTimers()
  let calls = 0
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url) !== '/api/auth/refresh') return reply({ ok: true })
    calls += 1
    return calls <= 6 ? race() : reply({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'temporary outage' } }, 503)
  })
  vi.stubGlobal('fetch', fetcher)
  localStorage.setItem('oc_auth_hint', '1')
  const onSessionExpired = vi.fn()
  const view = renderHook(() => useAuth({ demo: false, initialUser: null, onClearAuth: vi.fn(), onSessionExpired }))
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  expect(view.result.current.booting).toBe(false)
  expect(view.result.current.authError).toBe('登录状态恢复失败，请检查网络后重试')
  expect(view.result.current.authRecoveryAvailable).toBe(true)
  expect(onSessionExpired).not.toHaveBeenCalled()
  expect(refreshCalls(fetcher)).toBe(7)
  expect(localStorage.getItem('oc_auth_hint')).toBe('1')
})
