import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { workspaceWantPath } from '../../hooks/useAppRoute'
import { ApiError } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import {
  TICKET_TYPE_LABEL,
  TICKET_TYPE_TONE,
  type Ticket,
  isForbidden,
  isLeaseHeld,
  isVersionConflict,
  taskboardApi,
  taskboardErrorMessage,
} from '../../lib/taskboard'
import { ToastProvider, TooltipProvider } from '../ui'
import { TicketCard, ticketPriorityTone, ticketTypeIconClass } from './TicketCard'
import { useTaskboard } from './useTaskboard'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const auth = createMemoryAuthSession(() => {}, 'tok-board')

function jsonErr(status: number, error: string, code?: string) {
  return {
    ok: false,
    status,
    headers: { get: (h: string) => (h === 'x-request-id' ? 'req-board' : null) },
    json: async () => (code ? { error, code } : { error }),
  }
}

function ok(body: unknown, status = 200) {
  return {
    ok: true,
    status,
    headers: { get: () => null },
    json: async () => body,
  }
}

function sampleTicket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    identifier: 'OCV5-42',
    projectId: 'p1',
    type: 'bug',
    title: '登录 500',
    body: '复现步骤',
    status: 'waiting_human',
    stageId: 's1',
    pipelineId: 'pipe1',
    priority: 'P0',
    severity: 'major',
    labels: ['auth'],
    assignee: 'agent:coding-assistant',
    reporter: 'user:default',
    source: 'manual',
    originSessionKey: null,
    dueDate: null,
    startDate: null,
    version: 3,
    blockedReason: null,
    stageLoopCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    closedAt: null,
    ...over,
  }
}

describe('workspaceWantPath', () => {
  test('board 工作区无论是否有会话都产出 /board', () => {
    expect(workspaceWantPath('board', 'sess-1', false)).toBe('/board')
    expect(workspaceWantPath('board', undefined, false)).toBe('/board')
    expect(workspaceWantPath('board', 'draft', true)).toBe('/board')
  })

  test('chat 工作区保持会话路径语义', () => {
    expect(workspaceWantPath('chat', 'sess-1', false)).toBe('/s/sess-1')
    expect(workspaceWantPath('chat', 'draft', true)).toBe('/')
    expect(workspaceWantPath('chat', undefined, false)).toBe('/')
  })
})

describe('taskboard 错误码映射', () => {
  test('409 / version_conflict 给出刷新提示', () => {
    const err = new ApiError({
      status: 409,
      message: 'version conflict',
      code: 'version_conflict',
    })
    expect(isVersionConflict(err)).toBe(true)
    expect(taskboardErrorMessage(err, '更新单据失败')).toBe('单据已被其他人更新，已刷新最新内容')
  })

  test('423 / lease_held 给出占用提示', () => {
    const err = new ApiError({
      status: 423,
      message: 'lease held',
      body: { error: 'lease held', code: 'lease_held' },
    })
    expect(isLeaseHeld(err)).toBe(true)
    expect(taskboardErrorMessage(err, '更新单据失败')).toBe('该单据正在执行中，请稍后再试')
  })

  test('403 / forbidden 给出越权提示', () => {
    const err = new ApiError({ status: 403, message: 'forbidden', code: 'forbidden' })
    expect(isForbidden(err)).toBe(true)
    expect(taskboardErrorMessage(err, '更新单据失败')).toBe('当前身份无权执行此操作')
  })

  test('API 客户端把 gateway 409 信封映射成版本冲突', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonErr(409, 'version conflict', 'version_conflict'),
      ) as unknown as typeof fetch,
    )
    await expect(
      taskboardApi.patchTicket(auth, 'OCV5-42', { expectedVersion: 1, title: 'x' }),
    ).rejects.toSatisfy(
      (e) =>
        isVersionConflict(e) && taskboardErrorMessage(e, '改单失败').includes('已被其他人更新'),
    )
  })

  test('API 客户端把 423 映射成 lease 占用', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonErr(423, 'lease held', 'lease_held')) as unknown as typeof fetch,
    )
    await expect(taskboardApi.ready(auth, 'OCV5-42', 3)).rejects.toSatisfy((e) => isLeaseHeld(e))
  })

  test('API 客户端把 403 映射成越权', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonErr(403, 'forbidden', 'forbidden')) as unknown as typeof fetch,
    )
    await expect(taskboardApi.done(auth, 'OCV5-42', 3)).rejects.toSatisfy((e) => isForbidden(e))
  })

  test('GET /tickets 带筛选 query', async () => {
    const fetchMock = vi.fn(async () => ok({ items: [], total: 0 }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    await taskboardApi.listTickets(auth, { status: 'waiting_human', type: 'bug', limit: 50 })
    expect(fetchMock).toHaveBeenCalled()
    const calledUrl = String((fetchMock.mock.calls as unknown as [string][])[0]?.[0])
    expect(calledUrl).toBe('/api/board/tickets?status=waiting_human&type=bug&limit=50')
  })
})

describe('TicketCard 类型 / 优先级映射', () => {
  test('问题单红、需求单蓝、调研单紫、杂务单灰，优先级 tone 对齐', () => {
    expect(TICKET_TYPE_LABEL.bug).toBe('问题单')
    expect(TICKET_TYPE_LABEL.feature).toBe('需求单')
    expect(TICKET_TYPE_LABEL.spike).toBe('调研单')
    expect(TICKET_TYPE_LABEL.chore).toBe('杂务单')
    expect(TICKET_TYPE_TONE.bug).toBe('danger')
    expect(TICKET_TYPE_TONE.feature).toBe('info')
    expect(TICKET_TYPE_TONE.spike).toBe('accent')
    expect(TICKET_TYPE_TONE.chore).toBe('neutral')
    expect(ticketTypeIconClass('bug')).toContain('text-danger')
    expect(ticketTypeIconClass('feature')).toContain('text-info')
    expect(ticketTypeIconClass('spike')).toContain('text-accent')
    expect(ticketTypeIconClass('chore')).toContain('text-faint')
    expect(ticketPriorityTone('P0')).toBe('danger')
    expect(ticketPriorityTone('P1')).toBe('warning')
    expect(ticketPriorityTone('P2')).toBe('info')
    expect(ticketPriorityTone('P3')).toBe('neutral')
  })

  test('卡片渲染 identifier、类型、优先级、绑定 agent 与阻塞角标', () => {
    render(
      <ToastProvider>
        <TooltipProvider>
          <TicketCard
            ticket={sampleTicket({
              type: 'feature',
              priority: 'P1',
              status: 'blocked',
              blockedReason: '被 OCV5-7 挡住',
              assignee: 'agent:research',
            })}
          />
        </TooltipProvider>
      </ToastProvider>,
    )
    expect(screen.getByText('OCV5-42')).toBeInTheDocument()
    expect(screen.getByText('需求单')).toBeInTheDocument()
    expect(screen.getByText('P1')).toBeInTheDocument()
    expect(screen.getByText('research')).toBeInTheDocument()
    expect(screen.getAllByText('受阻').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('需求单')).toBeInTheDocument()
  })
})

function BoardHarness() {
  const tb = useTaskboard(auth, true)
  const ticket = tb.tickets?.[0]
  return (
    <div>
      <span>
        {ticket ? `${ticket.identifier}:${ticket.status}` : tb.loading ? 'loading' : 'empty'}
      </span>
      {ticket && (
        <button type="button" onClick={() => void tb.runAction(ticket, { kind: 'approve' })}>
          通过
        </button>
      )}
    </div>
  )
}

describe('useTaskboard 乐观更新', () => {
  test('409 版本冲突回滚并重新拉取，不留下乐观状态', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const waiting = sampleTicket({ status: 'waiting_human', version: 3 })
    const refreshed = sampleTicket({ status: 'waiting_human', version: 4, title: '已被别人改' })
    vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue([
      {
        id: 'p1',
        key: 'OCV5',
        name: 'V5',
        description: null,
        workspace: null,
        labels: [],
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    const listTickets = vi
      .spyOn(taskboardApi, 'listTickets')
      .mockResolvedValueOnce({ items: [waiting], total: 1 })
      .mockResolvedValue({ items: [refreshed], total: 1 })
    vi.spyOn(taskboardApi, 'listAgents').mockResolvedValue([])
    vi.spyOn(taskboardApi, 'getProjectBoard').mockResolvedValue({
      project: {
        id: 'p1',
        key: 'OCV5',
        name: 'V5',
        description: null,
        workspace: null,
        labels: [],
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
      },
      pipeline: {
        id: 'pipe1',
        projectId: 'p1',
        name: 'bug',
        ticketType: 'bug',
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
      ticketType: 'bug',
      columns: [],
      inbox: [waiting],
    })
    vi.spyOn(taskboardApi, 'approve').mockRejectedValue(
      new ApiError({ status: 409, message: 'version conflict', code: 'version_conflict' }),
    )

    render(
      <ToastProvider>
        <BoardHarness />
      </ToastProvider>,
    )
    expect(await screen.findByText('OCV5-42:waiting_human')).toBeInTheDocument()

    await act(async () => {
      screen.getByRole('button', { name: '通过' }).click()
    })

    await waitFor(() => {
      expect(listTickets.mock.calls.length).toBeGreaterThan(1)
    })
    expect(screen.getByText('OCV5-42:waiting_human')).toBeInTheDocument()
    expect(screen.queryByText('OCV5-42:ready')).not.toBeInTheDocument()
    expect(screen.getByText('单据已被其他人更新，已刷新最新内容')).toBeInTheDocument()
  })
})
