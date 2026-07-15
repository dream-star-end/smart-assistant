import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { App } from './App'
import { byteCacheKey, imageByteCache } from './lib/chat/imageBytes'

// ---------------------------------------------------------------------------
// v5 商业版前端骨架（P2）测试
//
// 三个表层：营销 Landing（home）、AuthGate 登录表单、登录后的工作区（侧栏 + 顶栏 +
// Composer）。鉴权是 v5：POST /api/auth/login 返回内存态 access_token（绝不落地）+ user，
// refresh 走 HttpOnly cookie。对话传输（WS）P4 才接入，本期发送回 P4 占位消息。
// `?demo=1` 用本地 fixtures 渲染工作区，无任何网络。
// ---------------------------------------------------------------------------

type FetchMock = ReturnType<typeof vi.fn>

function okJson(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body }
}
function errJson(status: number, body: unknown) {
  return { ok: false, status, headers: { get: () => null }, json: async () => body }
}

const LOGIN_OK = okJson({
  user: {
    id: 'u1',
    email: 'a@b.com',
    email_verified: true,
    role: 'user',
    display_name: 'Alice',
    avatar_url: null,
    credits: '300',
    created_at: '2026-01-01T00:00:00.000Z',
  },
  access_token: 'tok-1',
  access_exp: 1234,
  refresh_exp: 5678,
  remember: false,
})

// 公开配置：canary 默认 turnstile_bypass:true（AuthGate fail-closed，bypass 关闭才需真 widget）。
const PUBLIC_CONFIG = okJson({
  turnstile_site_key: '',
  turnstile_bypass: true,
  require_email_verified: false,
  feature_remote_ssh: false,
  feature_image2: false,
  allow_registration: true,
})

// 启动静默续期(App boot):无 refresh cookie → 400 VALIDATION。mock 必须显式处理本路径,否则
// catch-all 的 200 空体/LOGIN_OK 会让 boot 自动进工作区,登录流用例找不到 Landing。
const REFRESH_401 = errJson(400, { error: { code: 'VALIDATION', message: 'refresh_token is required' } })
// 静默续期成功(自动登录用例):v5 refresh 仅回 access token,user 由 GET /api/me 拿。
const REFRESH_OK = okJson({ access_token: 'tok-r', access_exp: 1234, remember: true })

// ─── P3 对话前置 fixtures（后端 wire 形态，snake_case） ────────────────────────
const MODELS = {
  models: [
    { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', supported_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', supported_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', supported_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'glm-5.2', display_name: 'GLM-5.2', supported_efforts: ['high', 'max'] },
    { id: 'deepseek', display_name: 'DeepSeek' },
    { id: 'MiniMax-M3', display_name: 'MiniMax M3' },
  ],
}
const AGENT_READY = {
  runtime_ready: true,
  subscription: {
    id: 'sub1',
    plan: 'agent',
    status: 'active',
    start_at: '2026-01-01T00:00:00.000Z',
    end_at: '2026-07-01T00:00:00.000Z',
    auto_renew: false,
    last_renewed_at: null,
  },
  container: {
    id: 'c1',
    subscription_id: 'sub1',
    docker_id: 'd1',
    docker_name: 'n1',
    image: 'img',
    status: 'running',
    last_started_at: null,
    last_stopped_at: null,
    volume_gc_at: null,
    last_error: null,
  },
}
const AGENT_UNSUB = { runtime_ready: true, subscription: null, container: null }
const AGENT_OPEN_202 = {
  subscription_id: 'sub1',
  container_id: 'c1',
  status: 'provisioning',
  start_at: '2026-01-01T00:00:00.000Z',
  end_at: '2026-07-01T00:00:00.000Z',
  balance_after: '180',
  ledger_id: 'l1',
  docker_name: 'n1',
  workspace_volume: 'w1',
  home_volume: 'h1',
}

/**
 * 按 URL 路由的 fetch mock。默认：login OK、模型 OK、agent 状态 ready。
 * overrides 可注入 unsubscribed 状态 / open 应答 / 让 open 后状态翻转为 ready。
 */
function routedFetch(over?: {
  status?: unknown
  statusAfterOpen?: unknown
  open?: unknown
  models?: unknown
  preferences?: unknown
}) {
  let opened = false
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/auth/refresh')) return REFRESH_401
    if (u.includes('/api/auth/login')) return LOGIN_OK
    if (u.includes('/api/public/config')) return PUBLIC_CONFIG
    if (u.includes('/api/public/models')) return okJson(over?.models ?? MODELS)
    if (u.includes('/api/me/preferences')) return okJson(over?.preferences ?? { prefs: {} })
    if (u.includes('/api/agent/open')) {
      opened = true
      return over?.open ?? okJson(AGENT_OPEN_202, 202)
    }
    if (u.includes('/api/agent/status')) {
      if (opened && over?.statusAfterOpen) return okJson(over.statusAfterOpen)
      return okJson(over?.status ?? AGENT_READY)
    }
    if (u.includes('/api/me'))
      return okJson({ user: { id: 'u1', email: 'a@b.com', role: 'user', display_name: 'Alice', credits: '300' } })
    return okJson({})
  }) as unknown as FetchMock
}

let fetchMock: FetchMock

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  localStorage.clear()
  imageByteCache.clear()
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  cleanup()
  imageByteCache.clear()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

async function loginViaUi() {
  // 启动静默续期期间是 splash(无 Landing):等 refresh 401 落定、Landing 出现再点。
  const landingLogin = await screen.findByRole('button', { name: '登录' })
  fireEvent.click(landingLogin) // Landing 登录 → AuthGate
  fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'a@b.com' } })
  fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'password123' } })
  // AuthGate fail-closed：公开配置（turnstile_bypass）加载完前登录按钮禁用。等其就绪再提交
  // （生产同样：登录页拉到 config 后按钮才可点）。
  const submit = screen.getByRole('button', { name: '登录' })
  await waitFor(() => expect(submit).not.toBeDisabled())
  await act(async () => {
    fireEvent.click(submit)
  })
}

describe('Aurora v5 skeleton — landing (de-branded)', () => {
  test('renders neutral brand, no legacy 乾元 / v4-trial branding', async () => {
    fetchMock = vi.fn(async () => REFRESH_401) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    render(<App />)
    // 启动续期 401 落定后 Landing 才出现(splash → Landing)。
    expect((await screen.findAllByText('Aurora')).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('乾元')
    expect(document.body.textContent).not.toContain('易经')
  })
})

describe('Aurora v5 skeleton — auth → workspace', () => {
  test('登录与退出清空图片 Blob 缓存，跨账号相同容器路径不得复用', async () => {
    const key = byteCacheKey('/home/agent/same-path.png', null)
    imageByteCache.set(key, new Blob(['account-a']))
    fetchMock = routedFetch()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()
    await waitFor(() => expect(screen.getByRole('button', { name: /新建会话/ })).toBeInTheDocument())
    expect(imageByteCache.get(key)).toBeNull()

    imageByteCache.set(key, new Blob(['account-b']))
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument())
    expect(imageByteCache.get(key)).toBeNull()
  })

  test('login posts to v5 /api/auth/login (credentials include) and enters workspace', async () => {
    fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/api/auth/refresh')
        ? REFRESH_401
        : String(url).includes('/api/public/config')
          ? PUBLIC_CONFIG
          : LOGIN_OK,
    ) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    await waitFor(() => expect(screen.getByRole('button', { name: /新建会话/ })).toBeInTheDocument())
    expect(screen.getByText('暂无会话')).toBeInTheDocument()

    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/auth/login')
    expect(call).toBeTruthy()
    expect((call![1] as RequestInit).credentials).toBe('include')
  })

  test('boot silent refresh: 有效 refresh cookie → 免登录直接恢复工作区', async () => {
    // refresh 200 + getMe 200 → 不显示 Landing/AuthGate,直接进工作区(F5 不掉登录)。
    fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/auth/refresh')) return REFRESH_OK
      if (u.includes('/api/public/models')) return okJson(MODELS)
      if (u.includes('/api/agent/status')) return okJson(AGENT_READY)
      if (u.includes('/api/me'))
        return okJson({ user: { id: 'u1', email: 'a@b.com', role: 'user', display_name: 'Alice', credits: '300' } })
      return okJson({})
    }) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)

    // 工作区标志(新建会话按钮)直接出现,全程没有点过任何登录 UI。
    await waitFor(() => expect(screen.getByRole('button', { name: /新建会话/ })).toBeInTheDocument())
    expect(screen.queryByPlaceholderText('邮箱')).not.toBeInTheDocument()
    // refresh 走了 cookie(credentials include)。
    const refreshCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/auth/refresh'))
    expect(refreshCall).toBeTruthy()
    expect((refreshCall![1] as RequestInit).credentials).toBe('include')
  })

  test('boot transient refresh failure stays in recovery and does not flash the login page', async () => {
    let refreshCalls = 0
    fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/auth/refresh')) {
        refreshCalls += 1
        if (refreshCalls === 1) {
          return errJson(503, { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'temporary outage' } })
        }
        return REFRESH_OK
      }
      if (u.includes('/api/public/models')) return okJson(MODELS)
      if (u.includes('/api/agent/status')) return okJson(AGENT_READY)
      if (u.includes('/api/me'))
        return okJson({ user: { id: 'u1', email: 'a@b.com', role: 'user', display_name: 'Alice', credits: '300' } })
      return okJson({})
    }) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /新建会话/ })).toBeInTheDocument(), { timeout: 4_000 })
    expect(refreshCalls).toBe(2)
    expect(screen.queryByPlaceholderText('邮箱')).not.toBeInTheDocument()
  })

  test('StrictMode effect replay shares the same boot refresh flight', async () => {
    let refreshCalls = 0
    fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/auth/refresh')) {
        refreshCalls += 1
        return REFRESH_OK
      }
      if (u.includes('/api/public/models')) return okJson(MODELS)
      if (u.includes('/api/agent/status')) return okJson(AGENT_READY)
      if (u.includes('/api/me'))
        return okJson({ user: { id: 'u1', email: 'a@b.com', role: 'user', display_name: 'Alice', credits: '300' } })
      return okJson({})
    }) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<StrictMode><App /></StrictMode>)
    await waitFor(() => expect(screen.getByRole('button', { name: /新建会话/ })).toBeInTheDocument())
    expect(refreshCalls).toBe(1)
  })

  test('login error localizes the backend code to friendly Chinese (no raw English / trace id)', async () => {
    // 生产实况：后端 message 是英文 "invalid credentials" + x-request-id 头（追踪号来源）。
    const invalidCreds = {
      ok: false,
      status: 401,
      headers: { get: (h: string) => (h === 'x-request-id' ? '0f0ac9caa' : null) },
      json: async () => ({ error: { code: 'INVALID_CREDENTIALS', message: 'invalid credentials' } }),
    }
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/auth/refresh')) return REFRESH_401
      return String(url).includes('/api/public/config') ? PUBLIC_CONFIG : invalidCreds
    }) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    // 红条展示友好中文；绝不把后端英文 message / 追踪号怼给用户。
    await waitFor(() => expect(screen.getByText('邮箱或密码错误')).toBeInTheDocument())
    expect(screen.queryByText(/invalid credentials/)).toBeNull()
    expect(screen.queryByText(/追踪号/)).toBeNull()
  })

  test('Landing「免费开始」进入登录表单（login，非注册）；新用户经登录页「立即注册」不受阻', async () => {
    // Bug2：「免费开始」入口从 register 改为 login。登录页自带「立即注册」链接，新用户不受阻。
    fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/api/auth/refresh')
        ? REFRESH_401
        : String(url).includes('/api/public/config')
          ? PUBLIC_CONFIG
          : okJson({}),
    ) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    // splash → Landing：等「免费开始」CTA 出现再点（nav 按钮为首个匹配）。
    const start = (await screen.findAllByRole('button', { name: /免费开始/ }))[0]
    fireEvent.click(start)

    // 进登录表单：有「登录」提交按钮，无「创建账号」按钮（注册表单标志）。
    await waitFor(() => expect(screen.getByRole('button', { name: /登录/ })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /创建账号/ })).toBeNull()
    // 登录页仍提供「立即注册」入口，新用户不受阻。
    expect(screen.getByRole('button', { name: '立即注册' })).toBeInTheDocument()
  })

  test('authenticated send goes through the real WS engine — optimistic user bubble, no SSE/v4 chat', async () => {
    // P4：对话经 WS user-chat-bridge（ChatSocket service）。容器就绪门放行后 Composer 可用。
    // jsdom 无 WebSocket，connect() 优雅降级 → 消息进离线队列（status=queued），但用户气泡
    // 仍乐观渲染。关键不变量：绝不走 SSE /api/chat、绝不走 v4-trial 端点。
    fetchMock = routedFetch()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    const ta = await screen.findByPlaceholderText('和「全能助手」对话…')
    await waitFor(() => expect(ta).not.toBeDisabled())

    fireEvent.change(ta, { target: { value: '你好' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }))
    })

    // 用户消息乐观入流（"你好" 至少出现一处：会话标题 / 用户气泡）。
    await waitFor(() => expect(screen.getAllByText('你好').length).toBeGreaterThan(0))
    // 不再有 P2 占位回复文案。
    expect(screen.queryByText(/对话传输将在后续版本接入/)).not.toBeInTheDocument()
    // 关键不变量：无 SSE /api/chat、无 v4-trial 端点（对话走 WS，不走这些 REST）。
    const chatLike = fetchMock.mock.calls.filter(([url]) =>
      /\/api\/chat|\/api\/v4/.test(String(url)),
    )
    expect(chatLike.length).toBe(0)
  })

  test('team mode switch persists while reopening the agent picker', async () => {
    fetchMock = routedFetch()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    fireEvent.click(await screen.findByRole('button', { name: /全能助手/ }))
    const sw = await screen.findByRole('switch', { name: '启用团队模式' })
    expect(sw).not.toBeChecked()

    fireEvent.click(sw)
    expect(sw).toBeChecked()
    expect(localStorage.getItem('oc_v5_team_mode')).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() =>
      expect(screen.queryByRole('switch', { name: '启用团队模式' })).not.toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: /全能助手/ }))
    expect(await screen.findByRole('switch', { name: '启用团队模式' })).toBeChecked()
  })

  test('team mode restores from localStorage after a fresh App mount', async () => {
    localStorage.setItem('oc_v5_team_mode', '1')
    fetchMock = routedFetch()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    fireEvent.click(await screen.findByRole('button', { name: /全能助手/ }))
    expect(await screen.findByRole('switch', { name: '启用团队模式' })).toBeChecked()
  })
})

describe('Aurora v5 skeleton — demo mode (no network)', () => {
  test('renders workspace from local fixtures with no fetch', () => {
    window.history.replaceState({}, '', '/?demo=1')
    const noFetch = vi.fn(() => {
      throw new Error('demo mode must not hit the network')
    })
    vi.stubGlobal('fetch', noFetch as unknown as typeof fetch)

    render(<App />)
    // 工作区直接从 fixtures 渲染：Composer 占位可见，且全程零网络。
    expect(screen.getByPlaceholderText('和「全能助手」对话…')).toBeInTheDocument()
    expect(screen.getByText('锂金属负极枝晶抑制机理综述')).toBeInTheDocument()
    expect(noFetch).not.toHaveBeenCalled()
  })
})

describe('Aurora v5 skeleton — theme', () => {
  test('cycling theme toggle persists oc_theme', async () => {
    fetchMock = vi.fn(async () => REFRESH_401) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    render(<App />)
    const toggles = await screen.findAllByRole('button', { name: /主题|theme/i })
    fireEvent.click(toggles[0])
    expect(['light', 'dark', 'system']).toContain(localStorage.getItem('oc_theme'))
  })
})

// ---------------------------------------------------------------------------
// P3 对话前置：模型选择器（GET /api/public/models 驱动）+ Agent 订阅/容器就绪门
// （GET /api/agent/status、POST /api/agent/open 202/402）。WS 对话本体是 P4。
// ---------------------------------------------------------------------------
describe('Aurora v5 — P3 对话前置（模型选择器 + 订阅/容器门）', () => {
  test('model selector reflects GET /api/public/models (no hardcoded list)', async () => {
    fetchMock = routedFetch() // ready + MODELS（首项 GPT-5.6-Sol）
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    // 顶栏模型选择器与 Composer 底部均展示后端返回的首个模型名。
    await waitFor(() => expect(screen.getAllByText('GPT-5.6-Sol').length).toBeGreaterThan(0))
    const modelsCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/public/models'))
    expect(modelsCall).toBeTruthy()
  })

  test('default_model preference wins over the first public model during one-shot hydrate', async () => {
    fetchMock = routedFetch({
      preferences: { prefs: { default_model: 'gpt-5.6-terra', default_effort: 'max' } },
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    await waitFor(() => {
      const trigger = screen.getByRole('button', { name: '选择对话模型' })
      expect(trigger.textContent).toContain('GPT-5.6-Terra')
    })
  })

  test('unsubscribed → 开通智能体 calls /api/agent/open then provisions to ready', async () => {
    // 初次 status=未订阅；open 之后 status 翻转为 running。
    fetchMock = routedFetch({ status: AGENT_UNSUB, statusAfterOpen: AGENT_READY })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    // 未订阅 → 引导面板 + 开通 CTA（Composer 仍禁用）。
    const openBtn = await screen.findByRole('button', { name: /开通智能体/ })
    expect(screen.getByPlaceholderText('和「全能助手」对话…')).toBeDisabled()

    await act(async () => {
      fireEvent.click(openBtn)
    })

    // open 受理 → 轮询容器至 running → 放行（Composer 可用）。
    await waitFor(() =>
      expect(screen.getByPlaceholderText('和「全能助手」对话…')).not.toBeDisabled(),
    )
    const openCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/agent/open'))
    expect(openCall).toBeTruthy()
    expect((openCall![1] as RequestInit).method).toBe('POST')
  })

  test('402 余额不足 surfaces insufficient panel with top-up CTA', async () => {
    fetchMock = routedFetch({
      status: AGENT_UNSUB,
      open: errJson(402, {
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: '积分余额不足',
          issues: [{ path: 'shortfall', message: '120' }],
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    const openBtn = await screen.findByRole('button', { name: /开通智能体/ })
    await act(async () => {
      fireEvent.click(openBtn)
    })

    // 402 → 余额不足面板（含缺口积分）+ 去充值入口，绝不放行 Composer。
    await waitFor(() => expect(screen.getByText('余额不足')).toBeInTheDocument())
    expect(screen.getByText(/120/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /去充值/ })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('和「全能助手」对话…')).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// P6 历史会话加载：登录后 listSessions 填侧栏；selectSession → getSession 拉历史并
// 合并进 WS service（server canonical）。jsdom 无 IndexedDB，本地注水降级 no-op，
// 故此用例验证的是 server 历史链路（listSessions + getSession + 渲染）。
// ---------------------------------------------------------------------------
const HIST_META = {
  sessions: [
    {
      id: 'webhist01',
      agentId: 'main',
      title: '历史会话甲',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messageCount: 1,
      updatedAt: 2,
    },
  ],
}
const HIST_DETAIL = {
  id: 'webhist01',
  userId: 'u1',
  agentId: 'main',
  title: '历史会话甲',
  pinned: false,
  createdAt: 1,
  lastAt: 2,
  messages: [{ id: 'mm1', role: 'assistant', text: '历史答复正文', ts: 1 }],
  updatedAt: 2,
  isPartial: false,
  totalMessageCount: 1,
  maxSeq: 5,
}

describe('Aurora v5 — P6 历史会话加载', () => {
  test('listSessions 填侧栏；选中会话 → getSession 拉历史并渲染', async () => {
    fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/auth/refresh')) return REFRESH_401
      if (u.includes('/api/auth/login')) return LOGIN_OK
      if (u.includes('/api/public/config')) return okJson({ turnstile_bypass: true })
      if (u.includes('/api/public/models')) return okJson(MODELS)
      if (u.includes('/api/sessions/list')) return okJson(HIST_META)
      if (/\/api\/sessions\/webhist01/.test(u)) return okJson(HIST_DETAIL)
      if (u.includes('/api/agent/status')) return okJson(AGENT_READY)
      if (u.includes('/api/me'))
        return okJson({ user: { id: 'u1', email: 'a@b.com', role: 'user', display_name: 'Alice', credits: '300' } })
      return okJson({})
    }) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    // listSessions 填侧栏：历史会话标题出现。
    await waitFor(() => expect(screen.getByText('历史会话甲')).toBeInTheDocument())

    // 选中 → getSession 拉历史。
    await act(async () => {
      fireEvent.click(screen.getByText('历史会话甲'))
    })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => /\/api\/sessions\/webhist01/.test(String(u))),
      ).toBe(true),
    )
    // 合并进 WS service 后渲染历史正文。
    await waitFor(() => expect(screen.getByText('历史答复正文')).toBeInTheDocument())
  })
})

// ---------------------------------------------------------------------------
// P7 最小路由（无路由库）：会话可链接（/s/<id> 镜像;会话间导航 pushState,后退=上一个
// 会话）、boot 深链恢复（URL 指定 > 最近会话）、popstate 切会话、面板深链（?panel=…）。
// ---------------------------------------------------------------------------
// 两个历史会话：乙（webother02）updatedAt 更新 = "最近会话"，甲（webhist01）较旧。
const HIST_META_TWO = {
  sessions: [
    {
      id: 'webother02',
      agentId: 'main',
      title: '更近的会话乙',
      pinned: false,
      createdAt: 3,
      lastAt: 4,
      messageCount: 1,
      updatedAt: 4,
    },
    {
      id: 'webhist01',
      agentId: 'main',
      title: '历史会话甲',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messageCount: 1,
      updatedAt: 2,
    },
  ],
}
const OTHER_DETAIL = {
  ...HIST_DETAIL,
  id: 'webother02',
  title: '更近的会话乙',
  messages: [{ id: 'mm2', role: 'assistant', text: '乙会话正文', ts: 3 }],
}

/** boot 静默续期成功 + 双历史会话的路由用 fetch mock。 */
function routedFetchTwoSessions() {
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/auth/refresh')) return REFRESH_OK
    if (u.includes('/api/public/models')) return okJson(MODELS)
    if (u.includes('/api/sessions/list')) return okJson(HIST_META_TWO)
    if (u.includes('/api/sessions/webhist01')) return okJson(HIST_DETAIL)
    if (u.includes('/api/sessions/webother02')) return okJson(OTHER_DETAIL)
    if (u.includes('/api/agent/status')) return okJson(AGENT_READY)
    if (u.includes('/api/me'))
      return okJson({ user: { id: 'u1', email: 'a@b.com', role: 'user', display_name: 'Alice', credits: '300' } })
    return okJson({})
  }) as unknown as FetchMock
}

describe('Aurora v5 — P7 最小路由', () => {
  test('boot 恢复 /s/<id>：URL 指定的会话优先于"最近会话"自动选中', async () => {
    // 深链到较旧的甲：若按"最近会话"逻辑会选中乙 —— 本用例锁定 URL 指定 > 最近会话。
    window.history.replaceState({}, '', '/s/webhist01')
    fetchMock = routedFetchTwoSessions()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await waitFor(() => expect(screen.getByText('历史答复正文')).toBeInTheDocument())
    expect(window.location.pathname).toBe('/s/webhist01')
    // 乙没有被自动选中拉历史（深链恢复期间自动选中被暂停，之后 activeId 已有值不再接管）。
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/api/sessions/webother02')),
    ).toBe(false)
  })

  test('boot 深链会话不存在：listSessions 落定后回落，自动选中最近会话', async () => {
    window.history.replaceState({}, '', '/s/nosuchsession99')
    fetchMock = routedFetchTwoSessions()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    // 放弃深链（瞬间回 /）后"自动选中上次会话"解锁 → 选中最近的乙，URL 镜像之。
    await waitFor(() => expect(screen.getByText('乙会话正文')).toBeInTheDocument())
    await waitFor(() => expect(window.location.pathname).toBe('/s/webother02'))
  })

  test('popstate：按 URL 切会话（后退/前进）', async () => {
    fetchMock = routedFetchTwoSessions()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    // 自动选中最近会话乙，URL 镜像 /s/webother02。
    await waitFor(() => expect(screen.getByText('乙会话正文')).toBeInTheDocument())
    await waitFor(() => expect(window.location.pathname).toBe('/s/webother02'))

    // 模拟浏览器后退/前进：URL 变为 /s/webhist01 并派发 popstate。
    await act(async () => {
      window.history.replaceState({}, '', '/s/webhist01')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitFor(() => expect(screen.getByText('历史答复正文')).toBeInTheDocument())
    expect(window.location.pathname).toBe('/s/webhist01')

    // popstate 回 /：清选中回空会话态。
    await act(async () => {
      window.history.replaceState({}, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitFor(() => expect(window.location.pathname).toBe('/'))
  })

  test('选中会话 → URL 镜像 /s/<id>；新建会话 → 回 /', async () => {
    fetchMock = routedFetchTwoSessions()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    // 先等 boot 自动选中最近会话乙落定(与兄弟用例同套路):否则点击与自动选中赛跑,
    // 起点不确定(CI 实证曾停在 /s/webother02 断言超时),push/replace 分支也随之漂移。
    await waitFor(() => expect(window.location.pathname).toBe('/s/webother02'))
    await waitFor(() => expect(screen.getByText('历史会话甲')).toBeInTheDocument())
    // 点侧栏选中甲 → URL 镜像。
    await act(async () => {
      fireEvent.click(screen.getByText('历史会话甲'))
    })
    await waitFor(() => expect(window.location.pathname).toBe('/s/webhist01'))
    // 新建会话（空 draft 不占 URL）→ 回 /。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /新建会话/ }))
    })
    await waitFor(() => expect(window.location.pathname).toBe('/'))
  })

  test('会话间导航压栈：history.back() 回上一个会话（首次自动选中不压栈）', async () => {
    fetchMock = routedFetchTwoSessions()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    // boot 自动选中最近会话乙（replace，不压栈）。
    await waitFor(() => expect(window.location.pathname).toBe('/s/webother02'))
    const baseLen = window.history.length

    // 用户切到甲 → pushState 压一条。
    await act(async () => {
      fireEvent.click(screen.getByText('历史会话甲'))
    })
    await waitFor(() => expect(window.location.pathname).toBe('/s/webhist01'))
    expect(window.history.length).toBe(baseLen + 1)

    // 后退 = 回上一个会话乙（jsdom back() 异步派发 popstate）。
    await act(async () => {
      window.history.back()
      await new Promise((r) => setTimeout(r, 20))
    })
    await waitFor(() => expect(window.location.pathname).toBe('/s/webother02'))
    await waitFor(() => expect(screen.getByText('乙会话正文')).toBeInTheDocument())
  })

  test('面板深链：?panel=settings boot 后自动打开设置中心并保参', async () => {
    window.history.replaceState({}, '', '/?panel=settings')
    fetchMock = routedFetchTwoSessions()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    // boot 读到 ?panel=settings → 设置中心随工作区打开（Dialog.Title「设置」）。
    // SettingsCenter 是 React.lazy 懒块(App.tsx:87),测试内 idle 预取(3s setTimeout)等不到 →
    // 冷 chunk 在本测试内现取现 transform;机器有后台负载时 >1s 即超 waitFor 默认超时。
    // 实证:canonical 树(96f08ecb,无本批改动)同环境同样 3/5 失败——纯环境时序,非应用回归。
    // 与 MessageRenderer.test.tsx markdown 懒块测试同款处理:给足 5s 余量(隔离/静载秒过)。
    await waitFor(
      () => expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument(),
      { timeout: 5000 },
    )
    // 打开态与 URL 参数一致（同步 effect no-op 保参）。
    expect(window.location.search).toContain('panel=settings')
  })

  test('教程深链：?panel=help&topic=<稳定 id> 打开对应教程并保留可分享 URL', async () => {
    window.history.replaceState({}, '', '/?campaign=docs&panel=help&topic=models-reasoning')
    fetchMock = routedFetchTwoSessions()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await waitFor(
      () => expect(screen.getByRole('heading', { name: '选择模型与思考深度' })).toBeInTheDocument(),
      { timeout: 5000 },
    )
    expect(window.location.search).toContain('panel=help')
    expect(window.location.search).toContain('topic=models-reasoning')
    expect(window.location.search).toContain('campaign=docs')
  })

  test('教程 CTA 联动真实功能：反馈教程直达设置·反馈，且不会自动提交', async () => {
    window.history.replaceState({}, '', '/?panel=help&topic=feedback-support')
    fetchMock = routedFetchTwoSessions()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await waitFor(
      () =>
        expect(
          screen.getByRole('heading', { name: '提交问题、建议与体验反馈' }),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    )
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))

    await waitFor(() => expect(screen.getByRole('form', { name: '反馈表单' })).toBeInTheDocument())
    expect(screen.getByLabelText('反馈内容')).toHaveValue('')
    expect(window.location.search).toContain('panel=settings')
    expect(window.location.search).not.toContain('topic=')
  })

  test('教程 CTA 回到页面功能时，把键盘焦点交给真实入口', async () => {
    window.history.replaceState({}, '', '/?panel=help&topic=chat-basics')
    fetchMock = routedFetchTwoSessions()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getClientRects')
      .mockImplementation(function getClientRects(this: HTMLElement) {
        return (this.hasAttribute('data-product-feature') ? [{}] : []) as unknown as DOMRectList
      })

    try {
      render(<App />)
      await waitFor(
        () =>
          expect(screen.getByRole('heading', { name: '开始一场高质量对话' })).toBeInTheDocument(),
        { timeout: 5000 },
      )
      fireEvent.click(screen.getByRole('button', { name: '回到功能位置' }))

      await waitFor(
        () =>
          expect((document.activeElement as HTMLElement | null)?.dataset.productFeature).toBe(
            'chat-basics',
          ),
        { timeout: 3000 },
      )
      expect(window.location.search).not.toContain('panel=help')
    } finally {
      rectSpy.mockRestore()
    }
  })
})
