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

const ME_BODY = {
  user: {
    id: 'u1',
    email: 'a@b.com',
    email_verified: true,
    role: 'user',
    display_name: 'Alice',
    avatar_url: null,
    credits: '123456789012345678',
    created_at: '2026-01-01T00:00:00.000Z',
  },
}

test('login maps v5 wire shape (access_token / display_name / credits string) without numericizing', async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    ok({
      user: ME_BODY.user,
      access_token: 'tok-login',
      access_exp: 1234,
      refresh_exp: 5678,
      remember: true,
    }),
  )
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const r = await api.login('a@b.com', 'pw')
  expect(r.accessToken).toBe('tok-login')
  expect(r.user.displayName).toBe('Alice')
  expect(r.user.roles).toEqual(['user'])
  // credits 是字符串大数，必须原样保留（不得越过 2^53 被破坏）。
  expect(r.user.credits).toBe('123456789012345678')
  // 登录走同源 credentials:'include'（让浏览器收下 HttpOnly refresh cookie）。
  const call = fetchMock.mock.calls[0]
  expect(String(call[0])).toBe('/api/auth/login')
  expect(call[1]?.credentials).toBe('include')
})

test('concurrent 401s trigger only ONE /api/auth/refresh (singleflight) and both retry with the new token', async () => {
  let refreshCalls = 0
  const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const u = String(url)
    if (u.includes('/api/auth/refresh')) {
      refreshCalls += 1
      return ok({ access_token: 'tok2', access_exp: 999, remember: false })
    }
    const auth = init?.headers?.Authorization
    if (auth === 'Bearer tok1') return unauthorized() // 旧 token 一律 401
    return ok(ME_BODY) // 新 token → 成功
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session } = makeSession('tok1')
  // 两个并发鉴权请求同时拿旧 token → 同时 401。
  const [a, b] = await Promise.all([api.me(session), api.me(session)])

  expect(refreshCalls).toBe(1) // 关键：只刷新一次，不会触发后端 reuse 撤 family
  expect(a.id).toBe('u1')
  expect(b.id).toBe('u1')
})

test('a failed refresh calls onExpired exactly once and surfaces the original error', async () => {
  let refreshCalls = 0
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/auth/refresh')) {
      refreshCalls += 1
      return unauthorized()
    }
    return unauthorized() // authed call also 401
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session, expired } = makeSession('tok1')
  await expect(api.me(session)).rejects.toThrow()
  expect(refreshCalls).toBe(1)
  expect(expired()).toBe(true)
})

test('chat transport is an explicit P4 stub — calling it rejects, never pretends to work', async () => {
  const { session } = makeSession('tok1')
  await expect(
    api.chat.send(session, 's1', 'hi', { onDelta: () => {}, onDone: () => {} }),
  ).rejects.toThrow(/P4/)
})
