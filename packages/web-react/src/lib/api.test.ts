import { afterEach, expect, test, vi } from 'vitest'
import { ApiError, AuthEpochStaleError, api, apiErrorMessage, authErrorMessage, callWithRefresh } from './api'
import { createMemoryAuthSession } from './authSession'
import type { AuthSession } from './types'

afterEach(() => {
  vi.useRealTimers()
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

function makeSession(initial: string): {
  session: AuthSession
  expired: () => boolean
  expireCount: () => number
  token: () => string
} {
  let expiredCount = 0
  const session = createMemoryAuthSession(() => {
    expiredCount += 1
  }, initial)
  return {
    session,
    expired: () => expiredCount > 0,
    expireCount: () => expiredCount,
    token: () => session.snapshot().token,
  }
}

function ok(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }
}
function unauthorized() {
  return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) }
}

function base64urlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

test('getSession pairs since cursor with history revision and omits invalid revisions', async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ok({
    id: 'web-session-1', messages: [], isPartial: true, maxSeq: 42, historyRevision: 7,
    timelineGeneration: 1,
  }))
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session } = makeSession('tok-history')

  await api.getSession(session, 'web-session-1', 42, 7)
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    '/api/sessions/web-session-1?since=42&since_history_revision=7',
  )

  fetchMock.mockClear()
  await api.getSession(session, 'web-session-1', 42, -1)
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/sessions/web-session-1?since=42')
})

test('getSession rejects an old incremental wire after one unconditional full capability check', async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (fetchMock.mock.calls.length === 1) {
      return ok({ id: 'web-session-1', messages: [], isPartial: true, maxSeq: 42 })
    }
    return ok({ id: 'web-session-1', messages: [{ role: 'user', content: 'full' }], isPartial: false })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session } = makeSession('tok-history-legacy')

  await expect(api.getSession(session, 'web-session-1', 42, 0)).rejects.toMatchObject({
    status: 409,
    code: 'TIMELINE_CAPABILITY_MISMATCH',
  })

  expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
    '/api/sessions/web-session-1?since=42&since_history_revision=0',
    '/api/sessions/web-session-1',
  ])
})

test('getSession rejects an initial full response without unified timeline capability', async () => {
  const fetchMock = vi.fn(async () => ok({
    id: 'web-session-1', messages: [], isPartial: false, maxSeq: 0,
  }))
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session } = makeSession('tok-history-legacy-full')

  await expect(api.getSession(session, 'web-session-1')).rejects.toMatchObject({
    status: 409,
    code: 'TIMELINE_CAPABILITY_MISMATCH',
  })

  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('getTapeRecordPayload resolves metadata with a one-byte Range and reconstructs exact bytes', async () => {
  const source = new Uint8Array(2 * 1024 * 1024 + 17)
  for (let index = 0; index < source.length; index += 1) source[index] = index % 251
  const hash = 'a'.repeat(64)
  const ranges: string[] = []
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range') ?? ''
    ranges.push(range)
    const matched = /^bytes=(\d+)-(\d+)$/.exec(range)
    if (!matched) throw new Error(`missing range: ${range}`)
    const start = Number(matched[1])
    const end = Number(matched[2])
    return new Response(source.slice(start, end + 1), {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${end}/${source.length}`,
        'x-openclaude-content-sha256': hash,
        'x-openclaude-record-id': 'record-range',
        'x-openclaude-record-role': 'tool',
      },
    })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session } = makeSession('tok-tape-range')

  const result = await api.getTapeRecordPayload(
    session,
    'session-range-1',
    'tape-range-1',
    7,
  )
  const reconstructed = new Uint8Array(result.bytes)
  expect(fetchMock).toHaveBeenCalledTimes(4)
  expect(ranges).toEqual([
    'bytes=0-0',
    'bytes=1-1048576',
    'bytes=1048577-2097152',
    `bytes=2097153-${source.length - 1}`,
  ])
  expect(result).toMatchObject({
    contentSha256: hash,
    recordId: 'record-range',
    role: 'tool',
  })
  expect(reconstructed.length).toBe(source.length)
  expect(reconstructed.every((byte, index) => byte === source[index])).toBe(true)
})

test('getTapeRecordPayload prefers and decodes the Unicode base64url record id on every range', async () => {
  const source = new Uint8Array([1, 2])
  const hash = 'c'.repeat(64)
  const recordId = 'call-one\n记录-🙂'
  const encoded = base64urlUtf8(recordId)
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range')
    const start = range === 'bytes=0-0' ? 0 : 1
    return new Response(source.slice(start, start + 1), {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${start}/2`,
        'x-openclaude-content-sha256': hash,
        'x-openclaude-record-id': 'legacy-must-not-win',
        'x-openclaude-record-id-base64url': encoded,
        'x-openclaude-record-role': 'tool',
      },
    })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session } = makeSession('tok-encoded-record')

  const result = await api.getTapeRecordPayload(session, 'session-encoded', 'tape-encoded', 1)
  expect(result.recordId).toBe(recordId)
  expect(Array.from(new Uint8Array(result.bytes))).toEqual([1, 2])
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test.each([
  ['invalid alphabet', 'Zg='],
  ['impossible length', 'A'],
  ['noncanonical trailing bits', 'Zh'],
  ['invalid UTF-8', '_w'],
])('getTapeRecordPayload rejects a present malformed alternate id: %s', async (_label, encoded) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
    status: 206,
    headers: {
      'content-range': 'bytes 0-0/1',
      'x-openclaude-content-sha256': 'd'.repeat(64),
      'x-openclaude-record-id': 'legacy-must-not-fallback',
      'x-openclaude-record-id-base64url': encoded,
      'x-openclaude-record-role': 'tool',
    },
  })))
  const { session } = makeSession('tok-malformed-record')
  await expect(api.getTapeRecordPayload(session, 'session-malformed', 'tape-malformed', 1))
    .rejects.toThrow('invalid immutable deferred payload record id encoding')
})

test('getTapeRecordPayload rejects a decoded record identity change on a later range', async () => {
  const hash = 'e'.repeat(64)
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const first = new Headers(init?.headers).get('range') === 'bytes=0-0'
    return new Response(new Uint8Array([first ? 1 : 2]), {
      status: 206,
      headers: {
        'content-range': first ? 'bytes 0-0/2' : 'bytes 1-1/2',
        'x-openclaude-content-sha256': hash,
        'x-openclaude-record-id-base64url': base64urlUtf8(first ? 'record-one' : 'record-two'),
        'x-openclaude-record-role': 'tool',
      },
    })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session } = makeSession('tok-mixed-record')
  await expect(api.getTapeRecordPayload(session, 'session-mixed', 'tape-mixed', 1))
    .rejects.toThrow('immutable deferred payload range identity mismatch')
})

test('getTapeRecordPayload rejects an ignored Range before consuming the full response body', async () => {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(8 * 1024 * 1024))
  const cancel = vi.fn(async () => undefined)
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(8 * 1024 * 1024) }),
    body: { cancel },
    arrayBuffer,
  }) as unknown as Response))
  const { session } = makeSession('tok-range-ignored')

  await expect(api.getTapeRecordPayload(session, 's1', 'tape-ignored', 1))
    .rejects.toThrow('invalid immutable deferred payload metadata')
  expect(arrayBuffer).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledTimes(1)
})

test('getTapeRecordPayload validates every later range before consuming its body', async () => {
  const hash = 'b'.repeat(64)
  const badArrayBuffer = vi.fn(async () => new ArrayBuffer(2 * 1024 * 1024))
  const cancel = vi.fn(async () => undefined)
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range')
    if (range === 'bytes=0-0') {
      return new Response(new Uint8Array([1]), {
        status: 206,
        headers: {
          'content-range': `bytes 0-0/${1024 * 1024 + 2}`,
          'x-openclaude-content-sha256': hash,
          'x-openclaude-record-id': 'record-bad-later-range',
          'x-openclaude-record-role': 'tool',
        },
      })
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { cancel },
      arrayBuffer: badArrayBuffer,
    } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session } = makeSession('tok-bad-later-range')

  await expect(api.getTapeRecordPayload(session, 's1', 'tape-bad-later', 2))
    .rejects.toThrow('immutable deferred payload range identity mismatch')
  expect(badArrayBuffer).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledTimes(1)
})

test('getTapeRecordPayload aborts the active range when its viewport subscriber leaves', async () => {
  const hash = 'f'.repeat(64)
  const seenSignals: AbortSignal[] = []
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
    if (init?.signal) seenSignals.push(init.signal)
    const range = new Headers(init?.headers).get('range')
    if (range === 'bytes=0-0') {
      return new Response(new Uint8Array([123]), {
        status: 206,
        headers: {
          'content-range': `bytes 0-0/${2 * 1024 * 1024}`,
          'x-openclaude-content-sha256': hash,
          'x-openclaude-record-id': 'record-abort',
          'x-openclaude-record-role': 'tool',
        },
      })
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session } = makeSession('tok-tape-abort')
  const controller = new AbortController()

  const pending = api.getTapeRecordPayload(
    session,
    'session-abort-1',
    'tape-abort-1',
    9,
    controller.signal,
  )
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  controller.abort()

  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(seenSignals).toEqual([controller.signal, controller.signal])
})

test('getUserMessagePayload uses the user sidecar URL and the same exact range contract', async () => {
  const source = new TextEncoder().encode(JSON.stringify({
    id: 'cm:user:1', role: 'user', text: '完整超长用户消息', ts: 1,
  }))
  const hash = 'b'.repeat(64)
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/sessions/session-user-1/messages/cm%3Auser%3A1/payload')
    const range = new Headers(init?.headers).get('range')
    const matched = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')!
    const start = Number(matched[1])
    const end = Number(matched[2])
    return new Response(source.slice(start, end + 1), {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${end}/${source.length}`,
        'x-openclaude-content-sha256': hash,
        'x-openclaude-record-id': 'cm:user:1',
        'x-openclaude-record-role': 'user',
      },
    })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session } = makeSession('tok-user-payload')

  const result = await api.getUserMessagePayload(session, 'session-user-1', 'cm:user:1')
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(Array.from(new Uint8Array(result.bytes))).toEqual(Array.from(source))
  expect(result).toMatchObject({
    contentSha256: hash,
    recordId: 'cm:user:1',
    role: 'user',
  })
})

test('appendUserMessage forwards the complete exact-replay metadata to master', async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ok({ ok: true }))
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session } = makeSession('tok-user-persist')
  const message = {
    id: 'cm-user-persist',
    text: '显示正文',
    ts: 123,
    media: [{ kind: 'image', url: '/api/media/guide.png' }],
    _retryMedia: [
      { kind: 'image', url: '/api/media/source.png', hidden: true },
      { kind: 'image', url: '/api/media/guide.png' },
    ],
    _imageEdit: { clientJobId: 'a'.repeat(32), sourceIndex: 0, guideIndex: 1 },
    _modelText: '显示正文\n[模型附件提示]',
    _replyTo: {
      messageId: 'assistant-before',
      role: 'assistant',
      text: '被引用的完整回答',
    },
    _routing: { model: 'gpt-5.6-sol', teamMode: true, effortLevel: 'high' },
    _sendAttempt: 0,
  }

  await api.appendUserMessage(session, 'session-user-persist', message)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/sessions/session-user-persist/user-message')
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual(message)
})

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

test('REFRESH_RACE retries inside grace and commits the sibling-rotated cookie result', async () => {
  vi.useFakeTimers()
  let refreshCalls = 0
  const reports: Array<Record<string, unknown>> = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/client-errors')) {
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ok({})
    }
    refreshCalls += 1
    if (refreshCalls === 1) return authErr(401, 'REFRESH_RACE', 'refresh token rotation race')
    return ok({ access_token: 'tok-race-winner', access_exp: 999, remember: true })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session, token } = makeSession('tok-old')
  const pending = api.refresh(session)
  await vi.advanceTimersByTimeAsync(250)
  await expect(pending).resolves.toMatchObject({ kind: 'success', epoch: 0 })
  expect(refreshCalls).toBe(2)
  expect(token()).toBe('tok-race-winner')
  expect(reports).toEqual([expect.objectContaining({
    surface: 'auth', stage: 'refresh', code: 'REFRESH_RACE', outcome: 'recovered',
  })])
})

test('repeated REFRESH_RACE is bounded and degrades to transient, never expiry', async () => {
  vi.useFakeTimers()
  let refreshCalls = 0
  const reports: Array<Record<string, unknown>> = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/client-errors')) {
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ok({})
    }
    refreshCalls += 1
    return authErr(401, 'REFRESH_RACE', 'refresh token rotation race')
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session, expireCount } = makeSession('tok-old')
  const pending = api.refresh(session)
  await vi.advanceTimersByTimeAsync(5_000)
  await expect(pending).resolves.toMatchObject({ kind: 'transient', epoch: 0 })
  expect(refreshCalls).toBe(6)
  expect(expireCount()).toBe(0)
  expect(reports).toEqual([expect.objectContaining({
    code: 'REFRESH_RACE', outcome: 'failed', attempts: 1,
  })])
})

test('transient refresh preserves the original 401 response and applies a shared cooldown', async () => {
  let refreshCalls = 0
  const original = unauthorized()
  const reports: Array<Record<string, unknown>> = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/client-errors')) {
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ok({})
    }
    refreshCalls += 1
    return authErr(503, 'UPSTREAM_UNAVAILABLE', 'temporary outage')
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session, expireCount } = makeSession('tok-old')
  const first = await callWithRefresh(session, async () => original as unknown as Response)
  const second = await callWithRefresh(session, async () => original as unknown as Response)
  expect(first).toBe(original)
  expect(second).toBe(original)
  expect(refreshCalls).toBe(1)
  expect(expireCount()).toBe(0)
  expect(reports).toEqual([expect.objectContaining({
    code: 'REFRESH_TRANSIENT', outcome: 'failed', attempts: 1,
  })])
})

test('refresh friction keeps one correlation through admin/WS recovery', async () => {
  vi.useFakeTimers()
  let refreshCalls = 0
  const reports: Array<Record<string, unknown>> = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/client-errors')) {
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ok({})
    }
    refreshCalls += 1
    return refreshCalls === 1
      ? authErr(503, 'UPSTREAM_UNAVAILABLE', 'temporary outage')
      : ok({ access_token: 'tok-recovered', access_exp: 999, remember: false })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session } = makeSession('tok-old')
  await expect(api.refresh(session, 0, 'admin_auth')).resolves.toMatchObject({ kind: 'transient' })
  await vi.advanceTimersByTimeAsync(500)
  await expect(api.refresh(session, 0, 'ws_auth')).resolves.toMatchObject({ kind: 'success' })

  expect(reports).toHaveLength(2)
  expect(reports[0]).toEqual(expect.objectContaining({
    surface: 'admin_auth', code: 'REFRESH_TRANSIENT', outcome: 'failed', attempts: 1,
  }))
  expect(reports[1]).toEqual(expect.objectContaining({
    event_id: reports[0]?.event_id,
    surface: 'admin_auth', code: 'REFRESH_TRANSIENT', outcome: 'recovered', attempts: 2,
  }))
})

test('malformed 200 refresh body is transient and never commits or expires auth', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ok({ access_token: '', access_exp: 'bad' })) as unknown as typeof fetch)
  const { session, token, expireCount } = makeSession('tok-old')
  await expect(api.refresh(session)).resolves.toMatchObject({ kind: 'transient', epoch: 0 })
  expect(token()).toBe('tok-old')
  expect(expireCount()).toBe(0)
})

test('hung refresh is internally aborted and classified transient', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')))
    }),
  )
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session, expireCount } = makeSession('tok-old')

  const pending = api.refresh(session)
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(pending).resolves.toMatchObject({ kind: 'transient', epoch: 0 })
  expect(expireCount()).toBe(0)
})

test('late refresh success cannot overwrite a newer identity', async () => {
  let resolveRefresh!: (value: unknown) => void
  const refreshResponse = new Promise((resolve) => {
    resolveRefresh = resolve
  })
  vi.stubGlobal('fetch', vi.fn(async () => refreshResponse) as unknown as typeof fetch)

  const { session, token } = makeSession('account-a')
  const pending = api.refresh(session)
  await Promise.resolve()
  const nextEpoch = session.beginIdentity()
  expect(session.commitToken(nextEpoch, 'account-b')).toBe(true)
  resolveRefresh(ok({ access_token: 'late-account-a', access_exp: 999, remember: true }))

  await expect(pending).resolves.toEqual({ kind: 'stale', epoch: 0 })
  expect(token()).toBe('account-b')
})

test('late invalid refresh cannot expire a newer identity', async () => {
  let resolveRefresh!: (value: unknown) => void
  const refreshResponse = new Promise((resolve) => {
    resolveRefresh = resolve
  })
  vi.stubGlobal('fetch', vi.fn(async () => refreshResponse) as unknown as typeof fetch)

  const { session, token, expireCount } = makeSession('account-a')
  const pending = api.refresh(session)
  await Promise.resolve()
  const nextEpoch = session.beginIdentity()
  session.commitToken(nextEpoch, 'account-b')
  resolveRefresh(authErr(401, 'INVALID_REFRESH', 'old family expired'))

  await expect(pending).resolves.toEqual({ kind: 'stale', epoch: 0 })
  expect(token()).toBe('account-b')
  expect(expireCount()).toBe(0)
})

test('an old 401 is never replayed with a newly logged-in account token', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const seen: string[] = []
  const { session } = makeSession('account-a')
  const pending = callWithRefresh(session, async (token) => {
    seen.push(token)
    await gate
    return unauthorized() as unknown as Response
  })

  await Promise.resolve()
  const nextEpoch = session.beginIdentity()
  session.commitToken(nextEpoch, 'account-b')
  release()
  await expect(pending).rejects.toBeInstanceOf(AuthEpochStaleError)
  expect(seen).toEqual(['account-a'])
})

test('a replay response arriving after an identity switch is discarded before callers can parse it', async () => {
  let releaseReplay!: () => void
  let markReplayStarted!: () => void
  const replayGate = new Promise<void>((resolve) => {
    releaseReplay = resolve
  })
  const replayStarted = new Promise<void>((resolve) => {
    markReplayStarted = resolve
  })
  const seen: string[] = []
  const { session } = makeSession('account-a-expired')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ok({ access_token: 'account-a-fresh', access_exp: 999, remember: true })) as unknown as typeof fetch,
  )
  const pending = callWithRefresh(session, async (token) => {
    seen.push(token)
    if (token === 'account-a-expired') return unauthorized() as unknown as Response
    markReplayStarted()
    await replayGate
    return ok({ user: { id: 'account-a-private' } }) as unknown as Response
  })

  await replayStarted
  const nextEpoch = session.beginIdentity()
  session.commitToken(nextEpoch, 'account-b')
  releaseReplay()

  await expect(pending).rejects.toBeInstanceOf(AuthEpochStaleError)
  expect(seen).toEqual(['account-a-expired', 'account-a-fresh'])
})

test('an ordinary successful response arriving after an identity switch is also discarded', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { session } = makeSession('account-a')
  const pending = callWithRefresh(session, async () => {
    await gate
    return ok({ user: { id: 'account-a-private' } }) as unknown as Response
  })

  await Promise.resolve()
  const nextEpoch = session.beginIdentity()
  session.commitToken(nextEpoch, 'account-b')
  release()

  await expect(pending).rejects.toBeInstanceOf(AuthEpochStaleError)
})

test('a response body that finishes parsing after an identity switch is discarded', async () => {
  let releaseBody!: () => void
  let markBodyStarted!: () => void
  const bodyGate = new Promise<void>((resolve) => {
    releaseBody = resolve
  })
  const bodyStarted = new Promise<void>((resolve) => {
    markBodyStarted = resolve
  })
  const { session } = makeSession('account-a')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        markBodyStarted()
        await bodyGate
        return ME_BODY
      },
    })) as unknown as typeof fetch,
  )
  const pending = api.getMe(session)

  await bodyStarted
  const nextEpoch = session.beginIdentity()
  session.commitToken(nextEpoch, 'account-b')
  releaseBody()

  await expect(pending).rejects.toBeInstanceOf(AuthEpochStaleError)
})

test('shared invalid refresh expires the matching epoch exactly once', async () => {
  let refreshCalls = 0
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/auth/refresh')) {
      refreshCalls += 1
      return authErr(401, 'INVALID_REFRESH', 'refresh token invalid or expired')
    }
    return unauthorized()
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session, expireCount } = makeSession('tok-old')
  const settled = await Promise.allSettled([api.getMe(session), api.getMe(session)])
  expect(settled.every((item) => item.status === 'rejected')).toBe(true)
  expect(refreshCalls).toBe(1)
  expect(expireCount()).toBe(1)
})

test('logout aborts and settles an in-flight refresh before its cookie-clear request', async () => {
  const order: string[] = []
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (String(url).includes('/api/auth/refresh')) {
      order.push('refresh:start')
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          order.push('refresh:abort')
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }
    order.push('logout')
    return Promise.resolve(ok({}))
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session } = makeSession('tok-old')
  const refreshing = api.refresh(session)
  await Promise.resolve()
  session.beginIdentity()
  const loggingOut = api.logout(session)
  await Promise.all([refreshing, loggingOut])
  expect(order).toEqual(['refresh:start', 'refresh:abort', 'logout'])
})

test('rapid logout then login is FIFO-ordered in the same tab', async () => {
  let releaseLogout!: () => void
  const logoutGate = new Promise<void>((resolve) => {
    releaseLogout = resolve
  })
  const order: string[] = []
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/auth/logout')) {
      order.push('logout:start')
      await logoutGate
      order.push('logout:end')
      return ok({})
    }
    order.push('login')
    return ok({
      user: ME_BODY.user,
      access_token: 'tok-login',
      access_exp: 1234,
      refresh_exp: 5678,
      remember: true,
    })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const logout = api.logout()
  await Promise.resolve()
  const login = api.login('a@b.com', 'pw')
  await Promise.resolve()
  expect(order).toEqual(['logout:start'])
  releaseLogout()
  await Promise.all([logout, login])
  expect(order).toEqual(['logout:start', 'logout:end', 'login'])
})

test('a hung logout times out so the cookie-mutation FIFO cannot starve a later login forever', async () => {
  vi.useFakeTimers()
  const order: string[] = []
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (String(url).includes('/api/auth/logout')) {
      order.push('logout:start')
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          order.push('logout:abort')
          reject(new DOMException('timeout', 'AbortError'))
        })
      })
    }
    order.push('login')
    return Promise.resolve(ok({
      user: ME_BODY.user,
      access_token: 'tok-login',
      access_exp: 1234,
      refresh_exp: 5678,
      remember: true,
    }))
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const logout = api.logout()
  await Promise.resolve()
  const login = api.login('a@b.com', 'pw')
  expect(order).toEqual(['logout:start'])
  await vi.advanceTimersByTimeAsync(30_000)
  await Promise.all([logout, login])
  expect(order).toEqual(['logout:start', 'logout:abort', 'login'])
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

test('submitFeedback rebuilds the message payload and drops every non-allowlisted field', async () => {
  const fetchMock = vi.fn(async () => ok({ ok: true, id: '902' }))
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session } = makeSession('tok-message-feedback')
  const input = {
    category: 'response',
    description: '工具失败',
    version: 'must-not-send',
    requestId: 'trace-1',
    sessionId: 'session-1',
    conversation: 'must-not-send',
    meta: {
      source: 'message',
      messageId: 'message-1',
      role: 'assistant',
      errorCode: 'UPSTREAM_TIMEOUT',
      reason: '工具失败',
      responseExcerpt: '可见回复摘录',
      locale: 'must-not-send',
      timezone: 'must-not-send',
      stack: 'must-not-send',
      url: 'must-not-send',
    },
  } as unknown as Parameters<typeof api.submitFeedback>[1]

  await expect(api.submitFeedback(session, input)).resolves.toEqual({ ok: true, id: '902' })
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(JSON.parse(String(init.body))).toEqual({
    category: 'response',
    description: '工具失败',
    request_id: 'trace-1',
    session_id: 'session-1',
    meta: {
      source: 'message',
      message_id: 'message-1',
      role: 'assistant',
      error_code: 'UPSTREAM_TIMEOUT',
      reason: '工具失败',
      response_excerpt: '可见回复摘录',
    },
  })
})

test('submitFeedback refreshes and replays when a supplied Bearer is expired', async () => {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const calls = fetchMock.mock.calls.length
    if (String(url).includes('/api/auth/refresh')) {
      return ok({ access_token: 'tok-feedback-new', access_exp: 999, remember: true })
    }
    return calls === 1 ? authErr(401, 'UNAUTHORIZED', 'expired') : ok({ ok: true, id: '903' })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

  const { session, token } = makeSession('tok-feedback-old')
  await expect(api.submitFeedback(session, {
    category: 'bug',
    description: '短反馈',
    meta: { source: 'settings' },
  })).resolves.toEqual({ ok: true, id: '903' })

  expect(token()).toBe('tok-feedback-new')
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    '/api/feedback',
    '/api/auth/refresh',
    '/api/feedback',
  ])
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
    'Bearer tok-feedback-old',
  )
  expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('authorization')).toBe(
    'Bearer tok-feedback-new',
  )
})

test('a failed refresh calls onExpired exactly once and surfaces the original error', async () => {
  let refreshCalls = 0
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/auth/refresh')) {
      refreshCalls += 1
      return authErr(401, 'INVALID_REFRESH', 'refresh token invalid or expired')
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

test('refresh 限频早返带 throttled 标记且不发真实网络请求(2026-07-18 CI flake 根因锁)', async () => {
  // 背景:api 层 nextAllowedAt 与消费层 setTimeout 是两个时钟,消费层睡满 retryAfterMs
  // 醒来仍可能因亚毫秒早醒撞进限频分支。限频早返若不与真实网络失败区分,boot 恢复循环
  // 会把它计成一次失败 → "只发一次网络请求就放弃恢复"(App.test flake 的根因,生产同错)。
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/auth/refresh'))
      return authErr(503, 'UPSTREAM_UNAVAILABLE', 'temporary outage')
    return ok({})
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  const { session } = makeSession('')
  const epoch = session.snapshot().epoch
  const refreshCalls = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/auth/refresh')).length

  // 第一次:真实网络失败 → transient 且不带 throttled(真实失败必须计入重试)。
  const first = await api.refresh(session, epoch)
  expect(first.kind).toBe('transient')
  expect(first.kind === 'transient' && first.throttled).toBeFalsy()
  expect(refreshCalls()).toBe(1)

  // nextAllowedAt 未到,立即再调:限频早返 → throttled=true + 剩余窗口,且零网络请求。
  const second = await api.refresh(session, epoch)
  expect(second.kind).toBe('transient')
  expect(second.kind === 'transient' && second.throttled).toBe(true)
  expect(second.kind === 'transient' && second.retryAfterMs > 0).toBe(true)
  expect(refreshCalls()).toBe(1)
})
