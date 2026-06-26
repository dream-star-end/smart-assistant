import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { App } from './App'
import { DEMO_MESSAGES } from './lib/demo'

// ---------------------------------------------------------------------------
// Test harness
//
// The new UI is a minimal ChatGPT-style chat app (see App.tsx). It has three
// surfaces: a marketing Landing (home view), an AuthGate login form, and the
// authenticated chat workspace (Sidebar + ChatHeader + message thread +
// Composer). Auth is P2a email+password: POST /api/v4/auth/login returns an
// in-memory accessToken (never persisted) + user; authenticated requests carry
// `Authorization: Bearer <accessToken>` and NO x-openclaude-trial-* headers
// (backend derives identity from the JWT sub). The network layer is fetch-based
// (src/lib/api.ts). A `?demo=1` URL renders the workspace from local fixtures
// (src/lib/demo.ts) with NO network at all.
//
// We mirror the old suite's proven patterns: stub global.fetch with vi.fn,
// build SSE responses via okStream(), reset globals/localStorage/URL/theme in
// afterEach so each test is deterministic.
// ---------------------------------------------------------------------------

type FetchMock = ReturnType<typeof vi.fn>

/** A plain JSON 200 response shaped like the real fetch Response surface. */
function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  }
}

/**
 * A 401 response (expired/missing access token). Drives the silent-refresh path:
 * api.callWithRefresh sees status 401 and transparently POSTs /api/v4/auth/refresh.
 */
function status401(body: unknown = { error: { code: 'UNAUTHORIZED', message: '未授权' } }) {
  return {
    ok: false,
    status: 401,
    headers: { get: () => null },
    json: async () => body,
  }
}

/** A 200 SSE response that replays the given frames as `event:`/`data:` blocks. */
function okStream(frames: unknown[]) {
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    headers: {
      get: (key: string) =>
        key.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null,
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          const typed = frame as { type: string }
          controller.enqueue(encoder.encode(`event: ${typed.type}\ndata: ${JSON.stringify(frame)}\n\n`))
        }
        controller.close()
      },
    }),
  }
}

/**
 * A 200 SSE response whose frames are pushed on demand. Lets a test observe
 * mid-stream UI (e.g. a tool card, which the app clears once `done` arrives)
 * before completing the stream. push() enqueues a frame; close() ends it.
 */
function controlledStream() {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const response = {
    ok: true,
    status: 200,
    headers: {
      get: (key: string) =>
        key.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null,
    },
    body,
  }
  const push = (frame: { type: string }) =>
    controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`))
  const close = () => controller.close()
  return { response, push, close }
}

/**
 * Match the innermost element whose textContent contains `needle`. Markdown
 * splits a line across text nodes + inline tags (e.g. <strong>), so a single
 * text node never holds the whole phrase; this matches the closest element that
 * does, while excluding ancestors that merely inherit it (keeps getByText unique).
 */
function hasText(needle: string) {
  return (_content: string, node: Element | null) => {
    if (!node || !(node.textContent || '').includes(needle)) return false
    return !Array.from(node.children).some((child) => (child.textContent || '').includes(needle))
  }
}

const meUser = { id: 'rqmn', displayName: 'rqmn', roles: ['user'] }

const welcomeSession = {
  id: 'sess-welcome',
  title: '欢迎会话',
  ownerUserId: 'rqmn',
  updatedAt: '2026-06-17T00:00:00Z',
  messageCount: 1,
}

const welcomeMessages = [
  { id: 'm1', role: 'assistant', content: '已加载欢迎会话的历史消息', createdAt: '2026-06-17T00:00:00Z' },
]

/**
 * Stub fetch with the happy-path login chain: POST /auth/login -> listSessions
 * -> getMessages(firstSession). The login response carries the in-memory
 * accessToken + user (App no longer hits /me). Returns the mock so a test can
 * append more one-shot responses (e.g. a stream) before rendering.
 */
// 计费摘要常驻默认响应：P3 起 App 会在登录/计费后异步拉 /billing/summary。它不参与
// 流式/认证的顺序断言，故用 URL 分发常驻返回，绝不消费下面的顺序队列（否则任意新增 fetch
// 都会打乱 mockResolvedValueOnce 序列——这是顺序型 mock 的通病，URL 分发根治之）。
let billingBody: unknown = { ok: true, currency: 'CNY', balanceCents: 10_000, ledger: [] }
// 可选闸门：置上后 billing 响应在 release 前不 resolve（捕获发起时的 body），
// 用于复现"旧账户在途响应迟到回写"的串号竞态。
let billingGate: Promise<void> | null = null
async function billingResponse() {
  const body = billingBody // 捕获发起时刻的 body（后续 setBilling 不影响已在途的响应）
  if (billingGate) await billingGate
  return okJson(body)
}
/** 测试可设定自定义余额/账单（afterEach 重置）。 */
function setBilling(body: unknown) {
  billingBody = body
}
/** 装一道闸门并返回其 release()。调用方自行管理 billingGate（如置 null 以放行后续请求）。 */
function gateBilling(): () => void {
  let release!: () => void
  billingGate = new Promise<void>((r) => {
    release = r
  })
  return release
}

/**
 * URL 分发的 fetch mock：`/billing/summary` 走常驻默认；其余按 FIFO 顺序队列消费
 * （重定向 mockResolvedValueOnce 到自管队列，保持既有测试 .mockResolvedValueOnce/.mock.calls 用法不变）。
 */
function primeConnect(): FetchMock {
  const queue: unknown[] = []
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/v4/billing/summary')) return billingResponse()
    return queue.shift() // 队列空 → undefined（与原生 vi.fn 默认一致，由 api 层兜底）
  }) as FetchMock
  // 重定向链式 once 入队到自管 FIFO（不走 vitest 原生 once 队列，避免被 billing 旁路影响）。
  ;(fetchMock as unknown as { mockResolvedValueOnce: (r: unknown) => FetchMock }).mockResolvedValueOnce = (r: unknown) => {
    queue.push(r)
    return fetchMock
  }
  fetchMock
    .mockResolvedValueOnce(okJson({ ok: true, accessToken: 'jwt-token', user: meUser }))
    .mockResolvedValueOnce(okJson({ sessions: [welcomeSession] }))
    .mockResolvedValueOnce(okJson({ session: welcomeSession, messages: welcomeMessages }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Fill the AuthGate email+password form and submit it. Selectors come from AuthGate.tsx. */
function submitLogin(email = 'rqmn@example.com', password = 'pw-secret') {
  fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: email } })
  fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
}

/** Navigate jsdom so App's `new URLSearchParams(location.search)` sees the query. */
function navigate(path: string) {
  window.history.replaceState({}, '', path)
}

/**
 * Record every (key,value) written to local/session storage so a test can assert
 * the access token is NEVER persisted under ANY key (not just oc_token). This is
 * the hard P2a security property: token lives in memory only.
 */
function spyStorage() {
  const writes: Array<{ store: 'local' | 'session'; key: string; value: string }> = []
  const original = Storage.prototype.setItem
  const spy = vi.spyOn(Storage.prototype, 'setItem')
  spy.mockImplementation(function (this: Storage, key: string, value: string) {
    writes.push({ store: this === window.sessionStorage ? 'session' : 'local', key, value })
    // Preserve real behavior (e.g. oc_theme still persists) by delegating through.
    return original.call(this, key, value)
  })
  return {
    writes,
    /** True if `token` was written to any storage under any key. */
    persisted(token: string) {
      return writes.some((w) => w.value.includes(token))
    },
    restore() {
      spy.mockRestore()
    },
  }
}

beforeEach(() => {
  navigate('/')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  document.documentElement.className = ''
  navigate('/')
  setBilling({ ok: true, currency: 'CNY', balanceCents: 10_000, ledger: [] })
  billingGate = null
})

describe('乾元 chat app — home / landing', () => {
  test('renders the marketing landing (with login affordance) before auth, not the chat shell', () => {
    render(<App />)

    // Landing exposes both a 登录 and a 免费开始 entry point.
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /免费开始/ }).length).toBeGreaterThanOrEqual(1)
    // Protected workspace affordances (Composer / Sidebar) must NOT be present yet.
    expect(screen.queryByPlaceholderText('搜索会话')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument()
  })

  test('clicking 登录 on the landing reveals the AuthGate email+password form', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    expect(screen.getByPlaceholderText('邮箱')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('密码')).toBeInTheDocument()
    // Landing unmounts on click, so the only 登录 button now is the form submit.
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument()
    // Still pre-auth: no chat workspace.
    expect(screen.queryByPlaceholderText('搜索会话')).not.toBeInTheDocument()
  })
})

describe('乾元 chat app — auth flow', () => {
  test('the 登录 submit button stays disabled until both email and password are filled', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    const submit = screen.getByRole('button', { name: '登录' })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'rqmn@example.com' } })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'pw-secret' } })
    expect(submit).toBeEnabled()
  })

  test('logging in posts {email,password}, then loads sessions with a Bearer token and renders the workspace', async () => {
    const fetchMock = primeConnect()
    const storage = spyStorage()

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()

    // History loaded from the first session => workspace is up.
    expect(await screen.findByText('已加载欢迎会话的历史消息')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('搜索会话')).toBeInTheDocument() // Sidebar
    expect(screen.getByText('欢迎会话')).toBeInTheDocument() // session row

    // The login POST carried the email+password (no self-asserted identity headers).
    const loginCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/v4/auth/login')
    expect(loginCall).toBeDefined()
    expect(loginCall![1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        // credentials:'include' lets the browser store the HttpOnly refresh cookie set by login.
        credentials: 'include',
        body: JSON.stringify({ email: 'rqmn@example.com', password: 'pw-secret' }),
      }),
    )

    // Authenticated request carries the in-memory accessToken as a Bearer token
    // and does NOT self-assert identity via x-openclaude-trial-* (backend uses JWT sub).
    const sessionsCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/v4/chat/sessions')
    expect(sessionsCall).toBeDefined()
    const sessionsHeaders = (sessionsCall![1] as { headers: Record<string, string> }).headers
    expect(sessionsHeaders.Authorization).toBe('Bearer jwt-token')
    expect(sessionsHeaders['x-openclaude-trial-user-id']).toBeUndefined()
    expect(sessionsHeaders['x-openclaude-trial-display-name']).toBeUndefined()
    // Authed requests also send credentials so the refresh cookie travels (harmless for Bearer auth).
    expect((sessionsCall![1] as { credentials?: string }).credentials).toBe('include')

    // HARD SECURITY REQUIREMENT: the access token is held in memory only — never persisted.
    // Assert both the known legacy keys AND that the token value never landed in
    // ANY storage slot under ANY key (guards against a future regression that
    // persisted it as `accessToken`/`oc_access_token`/etc).
    expect(window.localStorage.getItem('oc_token')).toBeNull()
    expect(window.localStorage.getItem('oc_user')).toBeNull()
    expect(window.sessionStorage.getItem('oc_token')).toBeNull()
    expect(storage.persisted('jwt-token')).toBe(false)
    storage.restore()
  })

  test('a failed login surfaces the generic error and keeps the user on the login form', async () => {
    // 401 returns a generic message (backend never says which field was wrong);
    // api.login surfaces error.message verbatim.
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({ error: { message: '邮箱或密码错误' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin('bad@example.com', 'wrong-pw')

    expect(await screen.findByText('邮箱或密码错误')).toBeInTheDocument()
    // Still on the AuthGate; no workspace. No token was persisted.
    expect(screen.getByPlaceholderText('邮箱')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('搜索会话')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('oc_token')).toBeNull()
  })
})

describe('乾元 chat app — demo mode (no network)', () => {
  test('?demo=1 renders the chat workspace with the demo conversation and never calls fetch', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    navigate('/?demo=1')

    render(<App />)

    // Demo fixtures are rendered straight into the thread.
    const firstUserLine = DEMO_MESSAGES[0].content.slice(0, 12)
    const needle = new RegExp(firstUserLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    expect(screen.getByText(needle)).toBeInTheDocument()
    // The demo session list is present (Sidebar).
    expect(screen.getByText('把商业版重做成 ChatGPT 风格')).toBeInTheDocument()
    // Demo mode is fully offline.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('demo mode: sending a message echoes the user turn and streams a local assistant reply', async () => {
    navigate('/?demo=1')
    render(<App />)

    const composer = screen.getByPlaceholderText('和「全能助手」对话…')
    fireEvent.change(composer, { target: { value: '帮我做个方案' } })

    // The demo reply streams char-by-char via setTimeout outside React's act
    // boundary; drive it inside act so the final setMessages flushes.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }))
      await new Promise((r) => setTimeout(r, 1200))
    })

    // User turn is echoed.
    expect(screen.getByText('帮我做个方案')).toBeInTheDocument()
    // demoReply finalized. Its signature line sits in a markdown blockquote mixed
    // with inline <strong>, so match the containing element's full textContent.
    expect(screen.getByText(hasText('这是演示模式下的本地回复'))).toBeInTheDocument()
  })
})

describe('乾元 chat app — real streaming send', () => {
  test('sending posts {content, agentId} to the session stream, renders a tool card mid-stream, then the final reply', async () => {
    const fetchMock = primeConnect()
    const stream = controlledStream()
    fetchMock.mockResolvedValueOnce(stream.response)

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    await screen.findByText('已加载欢迎会话的历史消息')

    fireEvent.change(screen.getByPlaceholderText('和「全能助手」对话…'), { target: { value: '请检索' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    // The POST body is the backend-authoritative contract: {content, agentId}.
    const streamCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url]) => String(url) === '/api/v4/chat/sessions/sess-welcome/stream',
      )
      if (!call) throw new Error('stream not posted yet')
      return call
    })
    expect(streamCall[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: '请检索', agentId: 'general' }),
      }),
    )
    // The authenticated stream POST carries the in-memory Bearer token and NO
    // self-asserted trial identity headers (backend uses the JWT sub).
    const streamHeaders = (streamCall[1] as { headers: Record<string, string> }).headers
    expect(streamHeaders.Authorization).toBe('Bearer jwt-token')
    expect(streamHeaders['x-openclaude-trial-user-id']).toBeUndefined()
    expect(streamHeaders['x-openclaude-trial-display-name']).toBeUndefined()

    // Mid-stream: a delta renders into the assistant bubble and a tool_card
    // renders via <ToolCard/> (the app clears tool cards once `done` arrives,
    // so we must observe it before completing the stream).
    stream.push({ type: 'start', assistantMessageId: 'a-stream' } as { type: string })
    // Live delta text is intentionally DIFFERENT from the server-persisted content
    // below, so the final assertion proves `done -> onDone -> setMessages(server
    // messages)` actually ran (not the !doneFired truncation-fallback path, which
    // would re-append the accumulated delta text instead).
    stream.push({ type: 'delta', text: '临时流式片段' } as { type: string })
    stream.push({
      type: 'tool_card',
      id: 'tool.search',
      title: '检索证据',
      status: 'ok',
      evidence: ['source=demo'],
    } as { type: string })
    expect(await screen.findByText('检索证据')).toBeInTheDocument()
    // Mid-stream the live (un-persisted) delta is shown.
    expect(await screen.findByText('临时流式片段')).toBeInTheDocument()

    // Completing the stream replaces the live delta with the server-persisted thread.
    // Wrap the done/close in act so the reader's async setMessages flushes
    // deterministically before we assert (avoids a close-vs-poll race).
    await act(async () => {
      stream.push({
        type: 'done',
        session: { ...welcomeSession, messageCount: 3 },
        messages: [
          ...welcomeMessages,
          { id: 'u-send', role: 'user', content: '请检索', createdAt: '2026-06-17T00:01:00Z' },
          { id: 'a-send', role: 'assistant', content: '服务端持久化回答', createdAt: '2026-06-17T00:01:01Z' },
        ],
      } as { type: string })
      stream.close()
      await new Promise((r) => setTimeout(r, 50))
    })

    // Server-persisted content (distinct from the delta) must appear, and the
    // transient delta bubble must be gone — proving the done frame drove the thread.
    expect(await screen.findByText('服务端持久化回答')).toBeInTheDocument()
    expect(screen.queryByText('临时流式片段')).not.toBeInTheDocument()
  })
})

describe('乾元 chat app — error banner + retry', () => {
  test('a backend error frame renders an error banner with the trace id, and 重试 re-sends the same turn', async () => {
    const fetchMock = primeConnect()
    // First stream emits a backend `error` frame (M1.2/M1.3 contract: code/message/trace).
    fetchMock.mockResolvedValueOnce(
      okStream([
        { type: 'error', code: 'upstream', message: '上游暂时不可用', trace: { traceId: 'tr_e', requestId: 'req_err_42' } },
      ]),
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    await screen.findByText('已加载欢迎会话的历史消息')

    fireEvent.change(screen.getByPlaceholderText('和「全能助手」对话…'), { target: { value: '触发错误' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    // Error banner surfaces the message AND the trace id (requestId) for ops/feedback.
    expect(await screen.findByText('上游暂时不可用')).toBeInTheDocument()
    expect(screen.getByText(/req_err_42/)).toBeInTheDocument()

    // Retry re-sends the SAME turn; queue a success for the retry.
    fetchMock.mockResolvedValueOnce(
      okStream([
        { type: 'delta', text: '重试成功' },
        {
          type: 'done',
          session: { ...welcomeSession, messageCount: 3 },
          messages: [
            ...welcomeMessages,
            { id: 'u-r', role: 'user', content: '触发错误', createdAt: '2026-06-17T00:03:00Z' },
            { id: 'a-r', role: 'assistant', content: '重试成功', createdAt: '2026-06-17T00:03:01Z' },
          ],
        },
      ]),
    )
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }))

    expect(await screen.findByText('重试成功')).toBeInTheDocument()
    // Banner cleared after a successful retry.
    expect(screen.queryByText('上游暂时不可用')).not.toBeInTheDocument()

    // The retry re-posted the identical {content, agentId} turn.
    const streamCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === '/api/v4/chat/sessions/sess-welcome/stream',
    )
    expect(streamCalls.length).toBe(2)
    expect(JSON.parse(String((streamCalls[1][1] as { body: string }).body))).toEqual({
      content: '触发错误',
      agentId: 'general',
    })
  })

  test('switching agent clears a pending error banner so retry never uses the wrong context', async () => {
    const fetchMock = primeConnect()
    fetchMock.mockResolvedValueOnce(
      okStream([{ type: 'error', code: 'upstream', message: '上游暂时不可用', trace: { requestId: 'req_e2' } }]),
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    await screen.findByText('已加载欢迎会话的历史消息')
    fireEvent.change(screen.getByPlaceholderText('和「全能助手」对话…'), { target: { value: '触发错误' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('上游暂时不可用')).toBeInTheDocument()

    // Switching agent changes the retry context → banner must clear.
    fireEvent.click(screen.getByRole('button', { name: /全能助手/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /代码专家/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    expect(screen.queryByText('上游暂时不可用')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试发送' })).not.toBeInTheDocument()
  })
})

describe('乾元 chat app — silent access-token refresh', () => {
  test('an authed 401 transparently refreshes the token, retries with the NEW bearer, and keeps the user in the app', async () => {
    // Login chain (login -> listSessions -> getMessages) all 200 with jwt-token.
    const fetchMock = primeConnect()
    // First stream POST is rejected as expired (access token TTL elapsed).
    fetchMock.mockResolvedValueOnce(status401())
    // Silent refresh succeeds and rotates to a NEW access token (no re-login).
    fetchMock.mockResolvedValueOnce(okJson({ ok: true, accessToken: 'jwt-token-2', user: meUser }))
    // The retried stream POST (now carrying the new token) streams a real reply.
    fetchMock.mockResolvedValueOnce(
      okStream([
        { type: 'delta', text: '刷新后回答' },
        {
          type: 'done',
          session: { ...welcomeSession, messageCount: 3 },
          messages: [
            ...welcomeMessages,
            { id: 'u-x', role: 'user', content: '过期重试', createdAt: '2026-06-17T00:05:00Z' },
            { id: 'a-x', role: 'assistant', content: '刷新后回答', createdAt: '2026-06-17T00:05:01Z' },
          ],
        },
      ]),
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    await screen.findByText('已加载欢迎会话的历史消息')

    fireEvent.change(screen.getByPlaceholderText('和「全能助手」对话…'), { target: { value: '过期重试' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    // The transparent refresh must have been issued (POST /auth/refresh, no Authorization, no body).
    const refreshCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/v4/auth/refresh')
      if (!call) throw new Error('refresh not posted yet')
      return call
    })
    const refreshOpts = refreshCall[1] as { method: string; body?: unknown; headers: Record<string, string>; credentials?: string }
    expect(refreshOpts.method).toBe('POST')
    expect(refreshOpts.body).toBeUndefined()
    expect(refreshOpts.headers.Authorization).toBeUndefined()
    // Refresh relies on the same-origin HttpOnly cookie -> credentials must be included.
    expect(refreshOpts.credentials).toBe('include')

    // The retried stream is the second POST to the stream endpoint and uses the NEW token.
    const streamCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === '/api/v4/chat/sessions/sess-welcome/stream',
    )
    expect(streamCalls.length).toBe(2)
    const firstStreamHeaders = (streamCalls[0][1] as { headers: Record<string, string> }).headers
    const retryStreamHeaders = (streamCalls[1][1] as { headers: Record<string, string> }).headers
    expect(firstStreamHeaders.Authorization).toBe('Bearer jwt-token') // original (now-expired) token
    expect(retryStreamHeaders.Authorization).toBe('Bearer jwt-token-2') // retried with the rotated token

    // The user never left the app: the refreshed reply renders and the workspace stays mounted.
    expect(await screen.findByText('刷新后回答')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('搜索会话')).toBeInTheDocument() // Sidebar still present
    expect(screen.queryByPlaceholderText('邮箱')).not.toBeInTheDocument() // NOT back on the login form
  })

  test('when the silent refresh itself returns 401, the app clears auth and returns to the login/landing (no loop)', async () => {
    const fetchMock = primeConnect()
    // The stream POST is 401 (expired access token)...
    fetchMock.mockResolvedValueOnce(status401())
    // ...and the refresh attempt ALSO 401s (refresh cookie invalid/expired/reused) -> session is dead.
    fetchMock.mockResolvedValueOnce(status401())

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    await screen.findByText('已加载欢迎会话的历史消息')

    fireEvent.change(screen.getByPlaceholderText('和「全能助手」对话…'), { target: { value: '会话已死' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    // App returns to the marketing landing (onExpired -> clearAuth -> view 'home').
    // The 登录 affordance reappears and the workspace is gone.
    expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('搜索会话')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('和「全能助手」对话…')).not.toBeInTheDocument()

    // No infinite loop: refresh was attempted exactly once, and the stream was NOT retried.
    const refreshCalls = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v4/auth/refresh')
    expect(refreshCalls.length).toBe(1)
    const streamCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url) === '/api/v4/chat/sessions/sess-welcome/stream',
    )
    expect(streamCalls.length).toBe(1)
  })
})

describe('乾元 chat app — logout', () => {
  test('the sidebar 退出登录 control posts /auth/logout and returns the user to the landing', async () => {
    const fetchMock = primeConnect()
    // Queue the logout POST response (App ignores its result either way).
    fetchMock.mockResolvedValueOnce(okJson({ ok: true }))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    await screen.findByText('已加载欢迎会话的历史消息')

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))

    // Logout hit the backend revoke endpoint with credentials (refresh cookie).
    const logoutCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/v4/auth/logout')
      if (!call) throw new Error('logout not posted yet')
      return call
    })
    expect((logoutCall[1] as { method: string }).method).toBe('POST')
    expect((logoutCall[1] as { credentials?: string }).credentials).toBe('include')

    // State cleared -> back on the marketing landing, workspace gone.
    expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('搜索会话')).not.toBeInTheDocument()
  })
})

describe('乾元 chat app — agent picker', () => {
  test('opening the picker and choosing a different agent updates the active agent', async () => {
    navigate('/?demo=1')
    render(<App />)

    // ChatHeader shows the default agent name; click it to open the picker.
    fireEvent.click(screen.getByRole('button', { name: /全能助手/ }))

    // Picker dialog is open.
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('选择智能体')).toBeInTheDocument()

    // Pick 代码专家.
    fireEvent.click(within(dialog).getByRole('button', { name: /代码专家/ }))

    // Picker closes; ChatHeader + composer placeholder now reflect the new agent.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /代码专家/ })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('和「代码专家」对话…')).toBeInTheDocument()
  })

  test('a fresh send after switching agents carries the selected agent id', async () => {
    const fetchMock = primeConnect()
    fetchMock.mockResolvedValueOnce(
      okStream([
        { type: 'delta', text: '代码答案' },
        {
          type: 'done',
          session: { ...welcomeSession, messageCount: 3 },
          messages: [
            ...welcomeMessages,
            { id: 'u2', role: 'user', content: '写段代码', createdAt: '2026-06-17T00:02:00Z' },
            { id: 'a2', role: 'assistant', content: '代码答案', createdAt: '2026-06-17T00:02:01Z' },
          ],
        },
      ]),
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    await screen.findByText('已加载欢迎会话的历史消息')

    fireEvent.click(screen.getByRole('button', { name: /全能助手/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /代码专家/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('和「代码专家」对话…'), { target: { value: '写段代码' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByText('代码答案')).toBeInTheDocument()
    const streamCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === '/api/v4/chat/sessions/sess-welcome/stream',
    )
    expect(streamCall![1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ content: '写段代码', agentId: 'coder' }),
      }),
    )
  })
})

describe('乾元 chat app — new conversation', () => {
  test('新建会话 in demo mode clears the thread and shows the empty starter state', async () => {
    navigate('/?demo=1')
    render(<App />)

    // Demo conversation + session list are visible first.
    expect(screen.getByText('把商业版重做成 ChatGPT 风格')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '新建会话' }))

    // Empty state shows the agent name as a heading and an agent-switch button.
    expect(await screen.findByRole('heading', { name: '全能助手' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '换一个智能体' })).toBeInTheDocument()
  })
})

describe('乾元 chat app — keyboard shortcuts', () => {
  test('Ctrl/⌘+K starts a new conversation from the workspace', async () => {
    navigate('/?demo=1')
    render(<App />)

    // Demo conversation is visible first.
    expect(screen.getByText('把商业版重做成 ChatGPT 风格')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

    // New (empty) conversation → empty starter state with the agent heading.
    expect(await screen.findByRole('heading', { name: '全能助手' })).toBeInTheDocument()
  })
})

describe('乾元 chat app — theme toggle', () => {
  test('clicking the theme toggle cycles the theme and persists oc_theme', () => {
    navigate('/?demo=1')
    render(<App />)

    const toggle = screen.getByRole('button', { name: /切换主题/ })
    // Default theme is "system"; cycle order is light -> dark -> system -> light.
    fireEvent.click(toggle)
    expect(window.localStorage.getItem('oc_theme')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /切换主题/ }))
    expect(window.localStorage.getItem('oc_theme')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})

describe('乾元 chat app — 设置中心主题单一权威源 (M3)', () => {
  test('设置中心偏好切主题，与 documentElement、顶栏快捷开关共享同一状态（非各自镜像）', async () => {
    primeConnect()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    expect(await screen.findByText('已加载欢迎会话的历史消息')).toBeInTheDocument()

    // 默认 system：顶栏快捷开关与 DOM 均无 dark。
    expect(screen.getByRole('button', { name: '切换主题（当前跟随系统）' })).toBeInTheDocument()
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    // 打开设置中心 → 偏好分区 → 选「深色」。
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('tab', { name: '偏好' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '深色' }))

    // 权威源（DOM class + localStorage）即时同步 —— 证明设置中心走的是 App 同一份 useTheme。
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(window.localStorage.getItem('oc_theme')).toBe('dark')

    // 关闭面板后，顶栏快捷开关反映同一状态（深色），而非自持镜像 —— 锁定单一权威源契约。
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '切换主题（当前深色）' })).toBeInTheDocument()
  })
})

describe('乾元 chat app — regenerate', () => {
  test('the last assistant message exposes 重新生成 which resends the previous user turn (demo)', async () => {
    navigate('/?demo=1')
    render(<App />)

    fireEvent.change(screen.getByPlaceholderText('和「全能助手」对话…'), { target: { value: '原始问题ABC' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }))
      await new Promise((r) => setTimeout(r, 1300))
    })

    // 最后一条助手消息下出现「重新生成」（之前是死按钮，现已接线）。
    const regen = screen.getByRole('button', { name: '重新生成' })
    expect(regen).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(regen)
      await new Promise((r) => setTimeout(r, 1300))
    })

    // 重发了上一条用户消息 → 出现第二个相同的用户气泡。
    expect(screen.getAllByText('原始问题ABC').length).toBeGreaterThanOrEqual(2)
  })
})

describe('乾元 chat app — 账户与计费 (P3)', () => {
  test('登录后侧栏显示余额，点击打开账户面板展示余额与账单流水', async () => {
    setBilling({
      ok: true,
      currency: 'CNY',
      balanceCents: 8766,
      ledger: [
        { id: 'c1', type: 'charge', amountCents: -12, balanceAfterCents: 8766, currency: 'CNY', description: '对话计费', createdAt: '2026-06-17T09:00:00Z' },
        { id: 's1', type: 'seed_grant', amountCents: 10000, balanceAfterCents: 10000, currency: 'CNY', description: '初始额度', createdAt: '2026-06-01T00:00:00Z' },
      ],
    })
    primeConnect()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    expect(await screen.findByText('已加载欢迎会话的历史消息')).toBeInTheDocument()

    // 侧栏底部显示真实余额（异步拉取后）。
    expect(await screen.findByText('余额 ¥87.66')).toBeInTheDocument()

    // 打开账户面板，看到余额大字 + 账单流水条目（扣费/初始额度）。
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    expect(within(dialog).getByText('¥87.66')).toBeInTheDocument()
    expect(within(dialog).getByText('对话扣费')).toBeInTheDocument()
    expect(within(dialog).getByText('-¥0.12')).toBeInTheDocument()
    expect(within(dialog).getByText('初始额度')).toBeInTheDocument()
    expect(within(dialog).getByText('+¥100.00')).toBeInTheDocument()
  })

  test('余额为 0 时账户面板提示余额不足', async () => {
    setBilling({ ok: true, currency: 'CNY', balanceCents: 0, ledger: [] })
    primeConnect()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    expect(await screen.findByText('已加载欢迎会话的历史消息')).toBeInTheDocument()
    expect(await screen.findByText('余额 ¥0.00')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    expect(within(dialog).getByText(/余额不足/)).toBeInTheDocument()
  })
})

describe('乾元 chat app — 计费世代守卫 (P3)', () => {
  test('旧账户在途 billing 响应迟到不串号写入新账户状态', async () => {
    setBilling({ ok: true, currency: 'CNY', balanceCents: 8766, ledger: [] })
    const fetchMock = primeConnect()
    // A 的一条流式回复（onDone 会触发 loadBilling）。
    fetchMock.mockResolvedValueOnce(
      okStream([
        { type: 'start' },
        { type: 'delta', text: '回复' },
        {
          type: 'done',
          session: welcomeSession,
          messages: [...welcomeMessages, { id: 'a2', role: 'assistant', content: '回复', createdAt: '2026-06-17T00:00:00Z' }],
        },
      ]),
    )
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    expect(await screen.findByText('余额 ¥87.66')).toBeInTheDocument()

    // 装闸门 + 投毒：A 接下来的 loadBilling 捕获 99999 并挂起。
    const releaseA = gateBilling()
    setBilling({ ok: true, currency: 'CNY', balanceCents: 99999, ledger: [] })
    fireEvent.change(screen.getByPlaceholderText(/对话…/), { target: { value: '问题' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }))
      await new Promise((r) => setTimeout(r, 150))
    })

    // 放行后续请求（B 不被闸门），登出 → 世代自增 → 回到 landing。
    billingGate = null
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))

    // B 登录，余额 5000（即时）。
    setBilling({ ok: true, currency: 'CNY', balanceCents: 5000, ledger: [] })
    fetchMock
      .mockResolvedValueOnce(okJson({ ok: true, accessToken: 'jwt-token-B', user: { id: 'userB', displayName: 'userB', roles: ['user'] } }))
      .mockResolvedValueOnce(okJson({ sessions: [welcomeSession] }))
      .mockResolvedValueOnce(okJson({ session: welcomeSession, messages: welcomeMessages }))
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin('userb@example.com', 'pw-secret-2')
    expect(await screen.findByText('余额 ¥50.00')).toBeInTheDocument()

    // A 的投毒响应迟到放行 → 世代守卫丢弃，绝不串号覆盖 B。
    await act(async () => {
      releaseA()
      await new Promise((r) => setTimeout(r, 60))
    })
    expect(screen.getByText('余额 ¥50.00')).toBeInTheDocument()
    expect(screen.queryByText('余额 ¥999.99')).not.toBeInTheDocument()
  })
})

describe('乾元 chat app — 修改密码 (P2b-2)', () => {
  async function openAccount() {
    primeConnect()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    expect(await screen.findByText('已加载欢迎会话的历史消息')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
  }

  test('新密码与确认不一致 → 前端拦截，不发请求', async () => {
    await openAccount()
    fireEvent.change(screen.getByPlaceholderText('当前密码'), { target: { value: 'old-pass-15-chars!' } })
    fireEvent.change(screen.getByPlaceholderText(/至少 15/), { target: { value: 'new-pass-15-chars-A' } })
    fireEvent.change(screen.getByPlaceholderText('确认新密码'), { target: { value: 'mismatch-15-chars-B' } })
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }))
    expect(await screen.findByText('两次输入的新密码不一致')).toBeInTheDocument()
  })

  test('改密成功 → 提示重新登录；点「去登录」回到登录页', async () => {
    await openAccount()
    const fetchMock = global.fetch as unknown as FetchMock
    fetchMock.mockResolvedValueOnce(okJson({ ok: true })) // /auth/change-password
    fireEvent.change(screen.getByPlaceholderText('当前密码'), { target: { value: 'old-pass-15-chars!' } })
    fireEvent.change(screen.getByPlaceholderText(/至少 15/), { target: { value: 'new-strong-pass-15A' } })
    fireEvent.change(screen.getByPlaceholderText('确认新密码'), { target: { value: 'new-strong-pass-15A' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认修改' }))
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(await screen.findByText(/密码已修改成功/)).toBeInTheDocument()
    const changeCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/v4/auth/change-password')
    expect(changeCall).toBeDefined()
    expect(JSON.parse((changeCall![1] as { body: string }).body)).toEqual({ currentPassword: 'old-pass-15-chars!', newPassword: 'new-strong-pass-15A' })
    // 点「去登录」→ clearAuth → 回到 landing（无工作区）。
    fireEvent.click(screen.getByRole('button', { name: '去登录' }))
    expect(screen.queryByPlaceholderText('搜索会话')).not.toBeInTheDocument()
  })
})

describe('乾元 chat app — 设置中心 a11y (P5)', () => {
  test('Escape 关闭账户面板（Radix Dialog 键盘无障碍）', async () => {
    primeConnect()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    expect(await screen.findByText('已加载欢迎会话的历史消息')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    expect(dialog).toBeInTheDocument()
    // 按 Escape → 关闭。
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())
  })
})

describe('乾元 chat app — 移动端侧栏抽屉 (P5)', () => {
  test('汉堡菜单打开侧栏抽屉（窄屏）', async () => {
    primeConnect()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    expect(await screen.findByText('已加载欢迎会话的历史消息')).toBeInTheDocument()
    // 初始仅桌面内联侧栏一个「新建会话」。
    expect(screen.getAllByText('新建会话').length).toBe(1)
    // 点汉堡 → 抽屉渲染（多一个侧栏实例）。
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }))
    expect(screen.getAllByText('新建会话').length).toBe(2)
  })
})

describe('乾元 chat app — 设置中心改密表单隐私 (P5)', () => {
  test('关闭账户面板后重开，改密表单已清空（敏感输入不残留）', async () => {
    primeConnect()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    expect(await screen.findByText('已加载欢迎会话的历史消息')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    let dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '修改密码' }))
    fireEvent.change(within(dialog).getByPlaceholderText('当前密码'), { target: { value: 'secret-current-123' } })
    fireEvent.change(within(dialog).getByPlaceholderText(/至少 15/), { target: { value: 'secret-new-pass-123' } })
    // 关闭面板（Escape）。
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())

    // 重开 → 改密区已折叠且字段清空（不残留上次敏感输入）。
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '修改密码' }))
    expect((within(dialog).getByPlaceholderText('当前密码') as HTMLInputElement).value).toBe('')
    expect((within(dialog).getByPlaceholderText(/至少 15/) as HTMLInputElement).value).toBe('')
  })
})

describe('乾元 chat app — 流式工具卡 upsert (P4)', () => {
  test('同一 id 多帧（pending→running→ok）只渲染一张卡并更新状态，不追加多张', async () => {
    const fetchMock = primeConnect()
    const stream = controlledStream()
    fetchMock.mockResolvedValueOnce(stream.response)
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    submitLogin()
    await screen.findByText('已加载欢迎会话的历史消息')
    fireEvent.change(screen.getByPlaceholderText('和「全能助手」对话…'), { target: { value: '跑个命令' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      if (!fetchMock.mock.calls.find(([u]) => String(u).endsWith('/stream'))) throw new Error('no stream yet')
    })
    stream.push({ type: 'start', assistantMessageId: 'a1' } as { type: string })
    stream.push({ type: 'tool_card', id: 't1', title: '终端命令', status: 'pending', evidence: ['$ ls'] } as { type: string })
    expect(await screen.findByText('终端命令')).toBeInTheDocument()
    expect(screen.getByText('排队中')).toBeInTheDocument()

    stream.push({ type: 'tool_card', id: 't1', title: '终端命令', status: 'running', evidence: ['$ ls', 'a.txt'] } as { type: string })
    expect(await screen.findByText('运行中')).toBeInTheDocument()

    stream.push({ type: 'tool_card', id: 't1', title: '终端命令', status: 'ok', evidence: ['$ ls', 'a.txt'] } as { type: string })
    expect(await screen.findByText('完成')).toBeInTheDocument()

    // 关键：同 id upsert → 只有一张卡（非追加），状态为最终态。
    expect(screen.getAllByText('终端命令').length).toBe(1)
    expect(screen.queryByText('排队中')).not.toBeInTheDocument()
    expect(screen.queryByText('运行中')).not.toBeInTheDocument()

    await act(async () => {
      stream.push({ type: 'done', session: { ...welcomeSession, messageCount: 2 }, messages: welcomeMessages } as { type: string })
      stream.close()
      await new Promise((r) => setTimeout(r, 50))
    })
  })
})
