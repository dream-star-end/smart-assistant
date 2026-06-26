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

function okJson(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }
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
    fetchMock = vi.fn(async () => LOGIN_OK) as unknown as FetchMock
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(<App />)
    await loginViaUi()
    await waitFor(() => expect(screen.getByRole('button', { name: /新建会话/ })).toBeInTheDocument())

    const ta = screen.getByPlaceholderText('和「全能助手」对话…')
    fireEvent.change(ta, { target: { value: '你好' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }))
    })

    // "你好" 同时出现在会话标题与用户气泡，断言至少一处 + 占位回复唯一文案。
    expect(screen.getAllByText('你好').length).toBeGreaterThan(0)
    expect(screen.getByText(/对话传输将在后续版本接入/)).toBeInTheDocument()
    const chatCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes('/api/auth/login'))
    expect(chatCalls.length).toBe(0)
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
