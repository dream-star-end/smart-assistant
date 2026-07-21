import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createHash } from 'node:crypto'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('chart.js/auto', () => ({
  default: class {
    destroy() {}
  },
}))

// jsdom has no layout engine, so render the virtual list's logical items while
// keeping production on react-virtuoso's real viewport implementation.
vi.mock('react-virtuoso', async () => {
  const React = await import('react')
  return {
    VirtuosoMockContext: React.createContext(null),
    Virtuoso: ({ data = [], itemContent, components = {}, context }: any) => React.createElement(
      React.Fragment,
      null,
      components.Header ? React.createElement(components.Header, { context }) : null,
      ...data.map((item: unknown, index: number) => itemContent(index, item)),
      components.Footer ? React.createElement(components.Footer, { context }) : null,
    ),
  }
})

vi.mock('../../../lib/adminApi', () => ({
  ApiError: class ApiError extends Error {},
  adminGet: vi.fn(),
  adminGetExactPayload: vi.fn(),
  adminSend: vi.fn(),
  adminText: vi.fn(),
}))

import { ToastProvider, TooltipProvider } from '../../../../components/ui'
import { adminGet, adminGetExactPayload, adminSend, adminText } from '../../../lib/adminApi'
import { SessionViewerModal } from '../SessionViewerModal'
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
const mockExactPayload = adminGetExactPayload as unknown as ReturnType<typeof vi.fn>

function exactPayload(record: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(JSON.stringify(record))
  return {
    bytes: bytes.buffer as ArrayBuffer,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    recordId: String(record.id),
    role: String(record.role),
  }
}

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
          timeline_generation: 1,
          timeline_cursor: 'cursor-web-1',
          timeline_has_more: true,
          timeline_snapshot_max_seq: 4,
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
    if (path === '/sessions/web-1/timeline')
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
        next_cursor: null,
        has_more: false,
        timeline_generation: 1,
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
          timeline_generation: 1,
          timeline_cursor: null,
          timeline_has_more: false,
          timeline_snapshot_max_seq: 1,
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
  mockExactPayload.mockRejectedValue(new Error('unexpected exact payload'))
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
      view: 'timeline',
    })

    fireEvent.click(screen.getByRole('button', { name: /查看更早历史记录/ }))
    expect(await screen.findByText('云端更早的问题')).toBeTruthy()
    expect(mockGet).toHaveBeenCalledWith('/sessions/web-1/timeline', {
      user_id: '1',
      cursor: 'cursor-web-1',
      limit: 100,
    })
    expect(screen.queryByRole('button', { name: /查看更早历史记录/ })).toBeNull()
  })

  test('切换会话后丢弃上一会话迟到的归档响应，绝不混入当前会话', async () => {
    let resolveArchive!: (value: unknown) => void
    const delayedArchive = new Promise((resolve) => {
      resolveArchive = resolve
    })
    const fixtureGet = mockGet.getMockImplementation()! as (...args: any[]) => any
    mockGet.mockImplementation((path: string, params?: Record<string, unknown>) => {
      if (path === '/sessions/web-1/timeline') return delayedArchive
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
    fireEvent.click(screen.getByRole('button', { name: /查看更早历史记录/ }))
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith('/sessions/web-1/timeline', {
        user_id: '1',
        cursor: 'cursor-web-1',
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
        next_cursor: null,
        has_more: false,
        timeline_generation: 1,
      })
      await delayedArchive
    })

    expect(screen.getByText('会话 B 的独立消息')).toBeTruthy()
    expect(screen.queryByText('不应混入 B 的 A 归档消息')).toBeNull()
  })

  test('历史请求在途时重复点击只发一页，真实记录提交后常驻', async () => {
    let resolveArchive!: (value: unknown) => void
    const delayedArchive = new Promise((resolve) => { resolveArchive = resolve })
    mockGet.mockImplementation((path: string) => {
      if (path === '/sessions/admin-fifo') {
        return Promise.resolve({
          session: {
            id: 'admin-fifo', user_id: 'c:1', agent_id: 'main', title: '串行分页会话',
            pinned: false, created_at: 1, last_at: 3, updated_at: 3,
            archived_count: 1, archived_through_seq: 1,
            timeline_generation: 7, timeline_cursor: 'cursor-fifo',
            timeline_has_more: true, timeline_snapshot_max_seq: 3,
            messages: [
              {
                id: 'fifo-answer', role: 'assistant', text: '当前最新回答', ts: 3,
                _timelineRecord: true, _timelineUnitKey: 'hot:3',
              },
            ],
          },
        })
      }
      if (path === '/sessions/admin-fifo/timeline') return delayedArchive
      return Promise.reject(new Error(`unexpected path ${path}`))
    })

    renderPage(
      <SessionViewerModal
        session={{
          session_id: 'admin-fifo', title: '串行分页会话', agent_id: 'main', message_count: 3,
          created_at: '2026-07-01T00:00:00.000Z', last_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-01T00:00:00.000Z',
        }}
        userId="1"
        userEmail="alice@example.com"
        onClose={() => {}}
      />,
    )

    expect(await screen.findByText('当前最新回答')).toBeTruthy()
    const loadButton = screen.getByRole('button', { name: /查看更早历史记录/ })
    fireEvent.click(loadButton)
    fireEvent.click(loadButton)
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(
      '/sessions/admin-fifo/timeline',
      { user_id: '1', cursor: 'cursor-fifo', limit: 100 },
    ))
    expect(mockGet.mock.calls.filter(([path]) => path === '/sessions/admin-fifo/timeline')).toHaveLength(1)

    await act(async () => resolveArchive({
      session_id: 'admin-fifo',
      messages: [
        {
          id: 'fifo-archive', role: 'user', text: '历史页真实问题', ts: 1,
          _timelineRecord: true, _timelineUnitKey: 'archive:1',
        },
        {
          id: 'fifo-thinking', role: 'thinking', text: '更早真实思考', ts: 2,
          _timelineRecord: true, _timelineUnitKey: 'tape:0',
        },
      ],
      next_cursor: null,
      has_more: false,
      timeline_generation: 7,
    }))
    expect(await screen.findByText('历史页真实问题')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /已思考/ }))
    expect(await screen.findByText('更早真实思考')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /查看更早历史记录/ })).toBeNull()
  })

  test('管理员时间线代次变化时自动重载最新快照，不会用失效游标反复重试', async () => {
    let detailReads = 0
    mockGet.mockImplementation((path: string) => {
      if (path === '/sessions/admin-stale') {
        detailReads += 1
        const refreshed = detailReads > 1
        return Promise.resolve({
          session: {
            id: 'admin-stale', user_id: 'c:1', agent_id: 'main', title: '代次刷新会话',
            pinned: false, created_at: 1, last_at: refreshed ? 4 : 3, updated_at: refreshed ? 4 : 3,
            archived_count: 1, archived_through_seq: 1,
            timeline_generation: refreshed ? 8 : 7,
            timeline_cursor: refreshed ? null : 'cursor-stale',
            timeline_has_more: !refreshed, timeline_snapshot_max_seq: refreshed ? 4 : 3,
            messages: [{
              id: refreshed ? 'fresh-answer' : 'stale-answer',
              role: 'assistant',
              text: refreshed ? '代次变化后的真实最新回答' : '变化前的回答',
              ts: refreshed ? 4 : 3,
              _timelineRecord: true,
              _timelineUnitKey: refreshed ? 'outer:4:fresh-answer' : 'outer:3:stale-answer',
            }],
          },
        })
      }
      if (path === '/sessions/admin-stale/timeline') {
        return Promise.resolve({
          session_id: 'admin-stale',
          messages: [],
          next_cursor: null,
          has_more: false,
          timeline_generation: 8,
        })
      }
      return Promise.reject(new Error(`unexpected path ${path}`))
    })

    renderPage(
      <SessionViewerModal
        session={{
          session_id: 'admin-stale', title: '代次刷新会话', agent_id: 'main', message_count: 3,
          created_at: '2026-07-01T00:00:00.000Z', last_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-01T00:00:00.000Z',
        }}
        userId="1"
        userEmail="alice@example.com"
        onClose={() => {}}
      />,
    )

    expect(await screen.findByText('变化前的回答')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /查看更早历史记录/ }))

    expect(await screen.findByText('代次变化后的真实最新回答')).toBeTruthy()
    expect(screen.queryByText('变化前的回答')).toBeNull()
    expect(detailReads).toBe(2)
    expect(mockGet.mock.calls.filter(([path]) => path === '/sessions/admin-stale/timeline')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /查看更早历史记录/ })).toBeNull()
  })

  test('管理员查看器懒加载超长 user/final，并可展开同页完整真实思考', async () => {
    const userRecord = {
      id: 'cm:user:admin', role: 'user', text: '管理员看到的完整超长提问', ts: 1,
    }
    const finalRecord = {
      id: 'srv-final-admin', role: 'assistant', text: '管理员看到的完整最终回答', ts: 3,
    }
    const userPayload = exactPayload(userRecord)
    const finalPayload = exactPayload(finalRecord)
    mockGet.mockImplementation((path: string) => {
      if (path === '/sessions/admin-lazy') {
        return Promise.resolve({
          session: {
            id: 'admin-lazy', user_id: 'c:1', agent_id: 'main', title: '懒加载会话',
            pinned: false, created_at: 1, last_at: 3, updated_at: 3,
            archived_count: 0, archived_through_seq: 0,
            timeline_generation: 4, timeline_cursor: null,
            timeline_has_more: false, timeline_snapshot_max_seq: 3,
            messages: [
              {
                id: userRecord.id, role: 'user', text: '', ts: 1, status: 'replied',
                _payloadDeferred: true, _userPayloadDeferred: true,
                _payloadSha256: userPayload.contentSha256,
                _timelineRecord: true, _timelineUnitKey: 'user:1',
              },
              {
                id: 'thinking-admin', role: 'thinking', text: '管理员展开的真实思考', ts: 2,
                _timelineRecord: true, _timelineUnitKey: 'tape:0',
              },
              {
                id: finalRecord.id, role: 'assistant', text: '', ts: 3,
                _payloadDeferred: true, _recordOrdinal: 2,
                _turnTapeId: 'tape-admin', _turnTapeSha256: 'e'.repeat(64),
                _payloadSha256: finalPayload.contentSha256,
                _timelineRecord: true, _timelineUnitKey: 'tape:2',
              },
            ],
          },
        })
      }
      return Promise.reject(new Error(`unexpected path ${path}`))
    })
    mockExactPayload.mockImplementation((path: string) => {
      if (path.includes('/messages/')) return Promise.resolve(userPayload)
      if (path.includes('/records/2/payload')) return Promise.resolve(finalPayload)
      return Promise.reject(new Error(`unexpected exact path ${path}`))
    })

    renderPage(
      <SessionViewerModal
        session={{
          session_id: 'admin-lazy', title: '懒加载会话', agent_id: 'main', message_count: 3,
          created_at: '2026-07-01T00:00:00.000Z', last_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-01T00:00:00.000Z',
        }}
        userId="1"
        userEmail="alice@example.com"
        onClose={() => {}}
      />,
    )

    expect(await screen.findByText('管理员看到的完整超长提问')).toBeTruthy()
    expect(await screen.findByText('管理员看到的完整最终回答')).toBeTruthy()
    expect(mockExactPayload).toHaveBeenCalledWith(
      '/sessions/admin-lazy/messages/cm%3Auser%3Aadmin/payload',
      { user_id: '1' },
      expect.any(AbortSignal),
    )
    fireEvent.click(await screen.findByRole('button', { name: /已思考/ }))
    expect(await screen.findByText(/管理员展开的真实思考/)).toBeTruthy()
    expect(screen.queryByText(/Agent 调用过程|查看原始思考记录/)).toBeNull()
  })
})
