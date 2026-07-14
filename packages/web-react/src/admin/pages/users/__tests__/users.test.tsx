import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('chart.js/auto', () => ({
  default: class {
    destroy() {}
  },
}))

vi.mock('../../../lib/adminApi', () => ({
  ApiError: class ApiError extends Error {},
  adminGet: vi.fn(),
  adminSend: vi.fn(),
  adminText: vi.fn(),
}))

import { ToastProvider, TooltipProvider } from '../../../../components/ui'
import { adminGet, adminSend, adminText } from '../../../lib/adminApi'
import { UserDetailSheet } from '../UserDetailSheet'
import UsersPage from '../index'

// 镜像 admin/main.tsx 的根 Provider 树（useToast / TimeAgo Tooltip 依赖之）。
function renderPage(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  )
}

const mockGet = adminGet as unknown as ReturnType<typeof vi.fn>
const mockSend = adminSend as unknown as ReturnType<typeof vi.fn>
const mockText = adminText as unknown as ReturnType<typeof vi.fn>

const USER1 = {
  id: '1',
  email: 'alice@example.com',
  email_verified: true,
  display_name: 'Alice',
  avatar_url: null,
  role: 'user',
  credits: '5000',
  status: 'active',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  deleted_at: null,
  today_requests: 20,
  today_errors: 1,
  total_topup_cents: '10000',
  last_active_at: '2026-07-10T00:00:00.000Z',
  containers_active: 0,
}

function installFixtures() {
  mockGet.mockImplementation((path: string) => {
    if (path === '/users/stats')
      return Promise.resolve({
        total_users: 5000,
        active_users: 4800,
        banned_users: 5,
        deleted_users: 195,
        new_7d: 40,
        active_7d: 300,
        paying_7d: 12,
        avg_credits_cents: '3000',
        total_credits_cents: '150000',
      })
    if (path === '/stats/funnel')
      return Promise.resolve({
        days: 7,
        cohort_total: 40,
        verified: 30,
        first_topup: 8,
        first_request: 20,
        eligible_for_d1: 35,
        eligible_for_d7: 10,
        d1_retained: 12,
        d7_retained: 3,
      })
    if (path === '/users') return Promise.resolve({ rows: [USER1], next_cursor: null })
    if (/^\/users\/\d+\/detail$/.test(path))
      return Promise.resolve({
        user: USER1,
        lifecycle: {
          first_topup_at: '2026-06-02T00:00:00.000Z',
          first_request_at: '2026-06-02T01:00:00.000Z',
          last_active_at: '2026-07-10T00:00:00.000Z',
        },
        topups: [
          { id: 't1', delta: '10000', memo: '首充', created_at: '2026-06-02T00:00:00.000Z' },
        ],
        recent_requests: [
          {
            id: 'r1',
            model: 'gpt-5.6',
            status: 'success',
            cost_credits: '12',
            session_id: 's1',
            created_at: '2026-07-09T00:00:00.000Z',
          },
        ],
        recent_sessions: [
          {
            session_id: 'web-1',
            title: '会话一',
            agent_id: 'main',
            message_count: 12,
            created_at: '2026-07-01T00:00:00.000Z',
            last_at: '2026-07-09T00:00:00.000Z',
            updated_at: '2026-07-09T00:00:00.000Z',
          },
          {
            session_id: 'web-2',
            title: '会话二',
            agent_id: 'codex',
            message_count: 2,
            created_at: '2026-07-02T00:00:00.000Z',
            last_at: '2026-07-08T00:00:00.000Z',
            updated_at: '2026-07-08T00:00:00.000Z',
          },
        ],
      })
    if (/^\/users\/\d+\/model-grants$/.test(path))
      return Promise.resolve({
        rows: [
          {
            id: 'g1',
            model_id: 'claude-opus-4-8',
            granted_at: '2026-06-05T00:00:00.000Z',
            granted_by: '9',
          },
        ],
      })
    if (path === '/sessions/web-1')
      return Promise.resolve({
        session: {
          id: 'web-1',
          user_id: 'c:1',
          agent_id: 'main',
          title: '会话一',
          pinned: false,
          created_at: 1,
          last_at: 4,
          updated_at: 4,
          archived_count: 1,
          archived_through_seq: 1,
          messages: [
            {
              id: 'hot-user',
              role: 'user',
              text: '管理员看到的用户问题',
              ts: 2,
              _seq: 2,
              status: 'sent',
            },
            {
              id: 'hot-assistant',
              role: 'assistant',
              text: '管理员看到的助手回答',
              ts: 3,
              _seq: 3,
            },
            {
              id: 'hot-permission',
              role: 'permission',
              text: '',
              ts: 4,
              _seq: 4,
              requestId: 'perm-1',
              toolName: 'Bash',
              _resolved: false,
              inputPreview: 'ls -la',
            },
          ],
        },
      })
    if (path === '/sessions/web-1/archive')
      return Promise.resolve({
        session_id: 'web-1',
        messages: [
          {
            id: 'archived-user',
            role: 'user',
            text: '云端更早的问题',
            ts: 1,
            _seq: 1,
            status: 'sent',
          },
        ],
        oldest_seq: 1,
        has_more: false,
      })
    if (path === '/sessions/web-2')
      return Promise.resolve({
        session: {
          id: 'web-2',
          user_id: 'c:1',
          agent_id: 'codex',
          title: '会话二',
          pinned: false,
          created_at: 10,
          last_at: 11,
          updated_at: 11,
          archived_count: 0,
          archived_through_seq: 0,
          messages: [
            {
              id: 'session-b-user',
              role: 'user',
              text: '会话 B 的独立消息',
              ts: 11,
              _seq: 1,
              status: 'sent',
            },
          ],
        },
      })
    return Promise.reject(new Error(`unexpected path ${path}`))
  })
}

beforeEach(() => {
  window.location.hash = ''
  installFixtures()
  mockSend.mockResolvedValue({ ledger_id: '99', balance_after: '5100', audit_id: '7' })
  mockText.mockResolvedValue('id,email\n1,alice@example.com')
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UsersPage', () => {
  test('渲染 KPI / 漏斗 / 用户表', async () => {
    renderPage(<UsersPage />)
    expect(await screen.findByText('总用户数')).toBeTruthy()
    expect(screen.getByText('5,000')).toBeTruthy() // total_users
    expect(screen.getByText('cohort 总数')).toBeTruthy()
    expect(await screen.findByText('alice@example.com')).toBeTruthy() // 表格行
  })

  test('点击「± 余额」→ 填写并提交 → POST /users/:id/credits（¥→cents）', async () => {
    renderPage(<UsersPage />)
    const adjustBtns = await screen.findAllByRole('button', { name: '± 余额' })
    fireEvent.click(adjustBtns[0])

    const amount = await screen.findByPlaceholderText('例如 1.00 或 -0.50')
    const memo = screen.getByPlaceholderText('如：补偿 / 退款 / 测试')
    fireEvent.change(amount, { target: { value: '1.00' } })
    fireEvent.change(memo, { target: { value: '补偿' } })

    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend).toHaveBeenCalledWith('POST', '/users/1/credits', {
      delta: '100',
      memo: '补偿',
    })
  })

  test("导出 CSV → adminText('/users.csv', 过滤参数)", async () => {
    const createObjSpy = vi.fn(() => 'blob:mock')
    const revokeSpy = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL: createObjSpy, revokeObjectURL: revokeSpy })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    renderPage(<UsersPage />)
    fireEvent.click(await screen.findByRole('button', { name: '导出 CSV' }))

    await waitFor(() => expect(mockText).toHaveBeenCalledTimes(1))
    expect(mockText).toHaveBeenCalledWith('/users.csv', {
      q: '',
      status: '',
      registered_within: '',
      funnel_state: '',
    })

    clickSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})

describe('UserDetailSheet — 封禁', () => {
  const noop = () => {}
  test("点击封禁 → 二次确认 → PATCH /users/:id {status:'banned'}", async () => {
    renderPage(
      <UserDetailSheet
        userId="1"
        onClose={noop}
        onChanged={noop}
        onAdjust={noop}
        onNavigate={noop}
      />,
    )
    // 详情载入后出现封禁按钮
    const banBtn = await screen.findByRole('button', { name: /封禁/ })
    fireEvent.click(banBtn)

    // useConfirm 弹窗出现（含 session 撤销文案），点确认「封禁」
    expect(await screen.findByText(/封号将即时撤销该用户全部活跃 session/)).toBeTruthy()
    const confirmBtns = screen.getAllByRole('button', { name: '封禁' })
    fireEvent.click(confirmBtns[confirmBtns.length - 1])

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend).toHaveBeenCalledWith('PATCH', '/users/1', { status: 'banned' })
  })
})

describe('UserDetailSheet — 会话只读查看器', () => {
  const noop = () => {}

  test('点击会话后复用聊天 UI 展示完整消息，可加载归档且不暴露审批动作', async () => {
    renderPage(
      <UserDetailSheet
        userId="1"
        onClose={noop}
        onChanged={noop}
        onAdjust={noop}
        onNavigate={noop}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '查看会话：会话一' }))

    expect(await screen.findByText('管理员看到的用户问题')).toBeTruthy()
    expect(await screen.findByText('管理员看到的助手回答')).toBeTruthy()
    expect(screen.getByText('只读')).toBeTruthy()
    expect(screen.getByText(/只读查看 · 需由用户在原会话中处理/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull()
    expect(mockGet).toHaveBeenCalledWith('/sessions/web-1', {
      user_id: '1',
      view: 'chat',
    })

    fireEvent.click(screen.getByRole('button', { name: /从云端加载更早的历史/ }))
    expect(await screen.findByText('云端更早的问题')).toBeTruthy()
    expect(mockGet).toHaveBeenCalledWith('/sessions/web-1/archive', {
      user_id: '1',
      before: 0,
      limit: 100,
    })
    expect(screen.queryByRole('button', { name: /从云端加载更早的历史/ })).toBeNull()
  })

  test('切换会话后丢弃上一会话迟到的归档响应，绝不混入当前会话', async () => {
    let resolveArchive!: (value: unknown) => void
    const delayedArchive = new Promise((resolve) => {
      resolveArchive = resolve
    })
    const fixtureGet = mockGet.getMockImplementation()!
    mockGet.mockImplementation((path: string, params?: Record<string, unknown>) => {
      if (path === '/sessions/web-1/archive') return delayedArchive
      return fixtureGet(path, params)
    })

    renderPage(
      <UserDetailSheet
        userId="1"
        onClose={noop}
        onChanged={noop}
        onAdjust={noop}
        onNavigate={noop}
      />,
    )

    const sessionA = await screen.findByRole('button', { name: '查看会话：会话一' })
    const sessionB = screen.getByRole('button', { name: '查看会话：会话二' })
    fireEvent.click(sessionA)
    expect(await screen.findByText('管理员看到的用户问题')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /从云端加载更早的历史/ }))
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith('/sessions/web-1/archive', {
        user_id: '1',
        before: 0,
        limit: 100,
      }),
    )

    const closeButtons = screen.getAllByRole('button', { name: '关闭' })
    fireEvent.click(closeButtons[closeButtons.length - 1])
    fireEvent.click(sessionB)
    expect(await screen.findByText('会话 B 的独立消息')).toBeTruthy()

    await act(async () => {
      resolveArchive({
        session_id: 'web-1',
        messages: [
          {
            id: 'late-session-a',
            role: 'user',
            text: '不应混入 B 的 A 归档消息',
            ts: 1,
            _seq: 1,
            status: 'sent',
          },
        ],
        oldest_seq: 1,
        has_more: false,
      })
      await delayedArchive
    })

    expect(screen.getByText('会话 B 的独立消息')).toBeTruthy()
    expect(screen.queryByText('不应混入 B 的 A 归档消息')).toBeNull()
  })
})
