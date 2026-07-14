import { afterEach, expect, test, vi } from 'vitest'
import { ApiError, api, apiErrorMessage, authErrorMessage } from './api'
import type { AuthSession } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 带 x-request-id 头的后端错误响应（模拟 commercial `{error:{code,message}}` 信封 + 追踪号）。 */
function authErr(status: number, code: string, message: string, reqId = 'req-abc123') {
  return {
    ok: false,
    status,
    headers: { get: (h: string) => (h === 'x-request-id' ? reqId : null) },
    json: async () => ({ error: { code, message } }),
  }
}

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
  const [a, b] = await Promise.all([api.getMe(session), api.getMe(session)])

  expect(refreshCalls).toBe(1) // 关键：只刷新一次，不会触发后端 reuse 撤 family
  expect(a.id).toBe('u1')
  expect(b.id).toBe('u1')
})

test('orgTopup preserves mutually exclusive desktop/mobile payment URLs from the unified response envelope', async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    ok({
      ok: true,
      data: {
        order_no: 'org-order-1',
        qrcode_url: 'https://pay.test/qr.png',
        mobile_url: 'https://pay.test/mobile',
        amount_cents: '3800',
      },
    }),
  )
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session } = makeSession('tok1')
  await expect(api.orgTopup(session, '3800')).resolves.toEqual({
    orderNo: 'org-order-1',
    qr: 'https://pay.test/qr.png',
    mobileUrl: 'https://pay.test/mobile',
    amountCents: '3800',
  })
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/org/topup')
})

test('submitFeedback sends only the allowlisted settings payload with Bearer auth', async () => {
  const fetchMock = vi.fn(async () => ok({ ok: true, id: '901' }))
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session } = makeSession('tok-feedback')
  const input = {
    category: 'feature',
    description: '希望设置中心增加更清晰的反馈入口。',
    version: 'a1b2c3d4',
    session_id: 'must-not-send',
    meta: {
      source: 'settings',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      conversation: 'must-not-send',
    },
  } as unknown as Parameters<typeof api.submitFeedback>[1]
  const result = await api.submitFeedback(session, input)

  expect(result).toEqual({ ok: true, id: '901' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('/api/feedback')
  expect(init.method).toBe('POST')
  expect(init.credentials).toBe('include')
  expect(init.headers).toMatchObject({
    Accept: 'application/json',
    Authorization: 'Bearer tok-feedback',
    'content-type': 'application/json',
  })
  expect(JSON.parse(String(init.body))).toEqual({
    category: 'feature',
    description: '希望设置中心增加更清晰的反馈入口。',
    version: 'a1b2c3d4',
    meta: { source: 'settings', locale: 'zh-CN', timezone: 'Asia/Shanghai' },
  })
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
  await expect(api.getMe(session)).rejects.toThrow()
  expect(refreshCalls).toBe(1)
  expect(expired()).toBe(true)
})

// ─── Bug1：auth 错误族 code→友好中文（单一权威 AUTH_ERROR_MESSAGES） ───────────────

test('login localizes a known auth code to friendly Chinese and strips the trace id', async () => {
  // 后端原始 message 是英文 "invalid credentials" + x-request-id 头（生产实况）。
  const fetchMock = vi.fn(async () => authErr(401, 'INVALID_CREDENTIALS', 'invalid credentials'))
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  await expect(api.login('a@b.com', 'wrong', 'bypass')).rejects.toMatchObject({
    code: 'INVALID_CREDENTIALS',
    message: '邮箱或密码错误',
  })
  // 把 promise 再取一次断言「不含英文/追踪号」。
  const err = (await api.login('a@b.com', 'wrong', 'bypass').catch((e) => e)) as ApiError
  expect(err).toBeInstanceOf(ApiError)
  expect(err.message).toBe('邮箱或密码错误')
  expect(err.message).not.toContain('invalid credentials')
  expect(err.message).not.toContain('追踪号')
})

test('login keeps the raw message + trace id for an UNKNOWN code (排障兜底)', async () => {
  const fetchMock = vi.fn(async () => authErr(500, 'SOME_UNKNOWN_CODE', 'weird backend failure', 'req-xyz789'))
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const err = (await api.login('a@b.com', 'pw', 'bypass').catch((e) => e)) as ApiError
  expect(err).toBeInstanceOf(ApiError)
  expect(err.code).toBe('SOME_UNKNOWN_CODE')
  // 未知 code：原 message + 追踪号原样保留（追踪号只服务未知错误排障）。
  expect(err.message).toBe('weird backend failure（追踪号 req-xyz789）')
})

test('authErrorMessage maps the whole auth error family from ApiError.code (one table)', () => {
  const cases: Array<[string, string]> = [
    ['INVALID_CREDENTIALS', '邮箱或密码错误'],
    ['RATE_LIMITED', '尝试次数过多，请稍后再试'],
    ['CONFLICT', '该邮箱已注册，可直接登录'],
    ['EMAIL_DOMAIN_BLOCKED', '该邮箱域名不支持注册，请更换邮箱'],
    ['VALIDATION', '输入格式有误，请检查邮箱与密码'],
    ['WEAK_PASSWORD', '密码需为 8-72 位，请重新设置'],
    ['INVALID_TOKEN', '验证码或重置链接无效或已过期，请重新获取'],
    ['EMAIL_NOT_VERIFIED', '邮箱尚未验证，请查收邮件完成验证后再登录'],
    ['TURNSTILE_FAILED', '人机验证未通过，请刷新后重试'],
  ]
  for (const [code, zh] of cases) {
    const err = new ApiError({ status: 400, code, message: `raw english（追踪号 r1）` })
    expect(authErrorMessage(err)).toBe(zh)
  }
  // 未知 code → 原样（含追踪号）。
  const unknown = new ApiError({ status: 400, code: 'NOPE', message: 'raw msg（追踪号 r2）' })
  expect(authErrorMessage(unknown)).toBe('raw msg（追踪号 r2）')
  // 非 ApiError（网络错误等）→ 原 message，保持与旧行为一致。
  expect(authErrorMessage(new Error('Failed to fetch'))).toBe('Failed to fetch')
})

// ─── apiErrorMessage：业务/管理面板展示层错误文案单一收口 ────────────────────

test('apiErrorMessage: 后端中文文案直接展示（并剥掉追踪号后缀，不被“追踪号”三字误判）', () => {
  // 后端有意写给用户的中文文案（内容安全/校验），throwApi 已烙入追踪号后缀。
  const err = new ApiError({
    status: 400,
    message: '商品页文案被静态安全扫描拦截,请修正后重试（追踪号 req-1）',
    requestId: 'req-1',
  })
  expect(apiErrorMessage(err, '发布失败')).toBe('商品页文案被静态安全扫描拦截,请修正后重试')
})

test('apiErrorMessage: 英文/技术 message 不外露，改用中文 fallback + 追踪号', () => {
  const err = new ApiError({
    status: 401,
    message: 'invalid credentials（追踪号 req-2）',
    requestId: 'req-2',
  })
  const out = apiErrorMessage(err, '加载订阅信息失败')
  expect(out).toBe('加载订阅信息失败（追踪号 req-2）')
  expect(out).not.toContain('invalid credentials')
})

test('apiErrorMessage: 英文 message 无 requestId → 纯 fallback（不带追踪号）', () => {
  const err = new ApiError({ status: 500, message: 'sync failed' })
  expect(apiErrorMessage(err, '同步失败')).toBe('同步失败')
})

test('apiErrorMessage: 通用兜底「请求失败 (NNN)」视作无有效文案 → fallback + 追踪号', () => {
  const err = new ApiError({
    status: 502,
    message: '请求失败 (502)（追踪号 req-3）',
    requestId: 'req-3',
  })
  expect(apiErrorMessage(err, '创建定时任务失败')).toBe('创建定时任务失败（追踪号 req-3）')
})

test('apiErrorMessage: RATE_LIMITED 跨域通用码 → 标准中文（忽略英文 message）', () => {
  const err = new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'too many requests' })
  expect(apiErrorMessage(err, '操作失败')).toBe('操作过于频繁，请稍后再试')
})

test('apiErrorMessage: fetch 网络失败（TypeError）→ 标准网络中文，不外露英文', () => {
  expect(apiErrorMessage(new TypeError('Failed to fetch'), '加载失败')).toBe(
    '网络连接不可用，请检查网络后重试',
  )
  expect(apiErrorMessage(new TypeError('fetch failed'), '加载失败')).toBe(
    '网络连接不可用，请检查网络后重试',
  )
})

test('apiErrorMessage: 非 Error 入参 / 中文 Error → 分别回退与直显', () => {
  // 非 Error（字符串 / undefined / 未知）→ fallback。
  expect(apiErrorMessage('boom', '删除失败')).toBe('删除失败')
  expect(apiErrorMessage(undefined, '删除失败')).toBe('删除失败')
  // 非 ApiError 但 message 恰为中文 → 直接用（前端主动 throw 的中文）。
  expect(apiErrorMessage(new Error('容器开机失败，请稍后重试'), '操作失败')).toBe(
    '容器开机失败，请稍后重试',
  )
  // 非 ApiError 英文 Error（非网络形态）→ fallback（不外露）。
  expect(apiErrorMessage(new Error('boom internal'), '删除失败')).toBe('删除失败')
})

test('chat transport moved off api into the WS engine (api has no chat stub)', () => {
  // P4：对话传输从 api.chat（占位抛错）迁到 lib/chat/socket.ts 的 ChatSocket service。
  // api 只剩 REST，不再暴露 chat 入口。
  expect((api as unknown as { chat?: unknown }).chat).toBeUndefined()
})
