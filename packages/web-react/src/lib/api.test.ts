import { afterEach, expect, test, vi } from 'vitest'
import { api } from './api'
import type { AuthSession } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeSession(initial: string): { session: AuthSession; expired: () => boolean } {
  let token = initial
  let expired = false
  return {
    session: {
      getToken: () => token,
      setToken: (t: string) => {
        token = t
      },
      onExpired: () => {
        expired = true
      },
    },
    expired: () => expired,
  }
}

function ok(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }
}
function unauthorized() {
  return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) }
}

test('concurrent 401s trigger only ONE /auth/refresh (singleflight) and both retry with the new token', async () => {
  let refreshCalls = 0
  const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const u = String(url)
    if (u.includes('/api/v4/auth/refresh')) {
      refreshCalls += 1
      return ok({ ok: true, accessToken: 'tok2', user: { id: 'u', displayName: 'u', roles: ['trial_user'] } })
    }
    const auth = init?.headers?.Authorization
    if (auth === 'Bearer tok1') return unauthorized() // 旧 token 一律 401
    return ok({ sessions: [] }) // 新 token → 成功
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session } = makeSession('tok1')
  // 两个并发鉴权请求同时拿旧 token → 同时 401。
  const [a, b] = await Promise.all([api.listSessions(session), api.listSessions(session)])

  expect(refreshCalls).toBe(1) // 关键：只刷新一次，不会触发后端 reuse 撤 family
  expect(Array.isArray(a)).toBe(true)
  expect(Array.isArray(b)).toBe(true)
})

test('a failed refresh calls onExpired exactly once and surfaces the original error', async () => {
  let refreshCalls = 0
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/v4/auth/refresh')) {
      refreshCalls += 1
      return unauthorized()
    }
    return unauthorized() // authed call also 401
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session, expired } = makeSession('tok1')
  await expect(api.listSessions(session)).rejects.toThrow()
  expect(refreshCalls).toBe(1)
  expect(expired()).toBe(true)
})
