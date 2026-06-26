import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { App } from './App'

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

// ─── P3 对话前置 fixtures（后端 wire 形态，snake_case） ────────────────────────
const MODELS = {
  models: [
    { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
    { id: 'glm-5.2', display_name: 'GLM-5.2' },
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
}) {
  let opened = false
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/auth/login')) return LOGIN_OK
    if (u.includes('/api/public/models')) return okJson(over?.models ?? MODELS)
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
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

async function loginViaUi() {
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
  fireEvent.change(screen.getByPlaceholderText('邮箱'), { target: { value: 'a@b.com' } })
  fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'password123' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
  })
}

describe('Aurora v5 skeleton — landing (de-branded)', () => {
  test('renders neutral brand, no legacy 乾元 / v4-trial branding', () => {
    render(<App />)
    expect(screen.getAllByText('Aurora').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('乾元')
    expect(document.body.textContent).not.toContain('易经')
  })
})

describe('Aurora v5 skeleton — auth → workspace', () => {
  test('login posts to v5 /api/auth/login (credentials include) and enters workspace', async () => {
    fetchMock = vi.fn(async () => LOGIN_OK) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    await waitFor(() => expect(screen.getByRole('button', { name: /新建会话/ })).toBeInTheDocument())
    expect(screen.getByText('暂无会话')).toBeInTheDocument()

    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/auth/login')
    expect(call).toBeTruthy()
    expect((call![1] as RequestInit).credentials).toBe('include')
  })

  test('login error surfaces the backend message', async () => {
    fetchMock = vi.fn(async () =>
      errJson(401, { error: { code: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' } }),
    ) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    await waitFor(() => expect(screen.getByText('邮箱或密码错误')).toBeInTheDocument())
  })

  test('authenticated send returns an explicit P4 placeholder (no fake streaming, no network chat)', async () => {
    // P3：对话前置门要求容器就绪后才放行 Composer，故 mock 一个 ready 的 agent 状态。
    fetchMock = routedFetch()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    // 等容器就绪门放行（Composer 由 disabled 变可用）。
    const ta = await screen.findByPlaceholderText('和「全能助手」对话…')
    await waitFor(() => expect(ta).not.toBeDisabled())

    fireEvent.change(ta, { target: { value: '你好' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }))
    })

    // "你好" 同时出现在会话标题与用户气泡，断言至少一处 + 占位回复唯一文案。
    expect(screen.getAllByText('你好').length).toBeGreaterThan(0)
    expect(screen.getByText(/对话传输将在后续版本接入/)).toBeInTheDocument()
    // 关键不变量：本期绝不走真实对话传输（无 SSE /api/chat、无 v4-trial 端点）。
    // 前置链路的 REST（status/models）是合法的；只断言没有对话发送类网络。
    const chatLike = fetchMock.mock.calls.filter(([url]) =>
      /\/api\/chat|\/api\/v4|\/api\/sessions/.test(String(url)),
    )
    expect(chatLike.length).toBe(0)
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
  test('cycling theme toggle persists oc_theme', () => {
    render(<App />)
    const toggles = screen.getAllByRole('button', { name: /主题|theme/i })
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
    fetchMock = routedFetch() // ready + MODELS（首项 Claude Opus 4.7）
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()

    // 顶栏模型选择器与 Composer 底部均展示后端返回的首个模型名。
    await waitFor(() => expect(screen.getAllByText('Claude Opus 4.7').length).toBeGreaterThan(0))
    const modelsCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/public/models'))
    expect(modelsCall).toBeTruthy()
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
