import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { workspaceWantPath } from '../../hooks/useAppRoute'
import { ApiError } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import {
  type PipelineStage,
  type Project,
  TICKET_TYPE_LABEL,
  TICKET_TYPE_TONE,
  type Ticket,
  type TicketActivity,
  type TicketComment,
  type TicketRun,
  isConcurrencyFull,
  isForbidden,
  isLeaseHeld,
  isVersionConflict,
  mergeTimelineSources,
  resolveOriginSessionId,
  sessionIdFromOriginKey,
  skipReasonLabel,
  taskboardApi,
  taskboardErrorMessage,
} from '../../lib/taskboard'
import { ToastProvider, TooltipProvider } from '../ui'
import { BoardSettingsPanel } from './BoardSettingsPanel'
import { StageSettings } from './StageSettings'
import { TaskboardView } from './TaskboardView'
import { TicketCard, ticketPriorityTone, ticketTypeIconClass } from './TicketCard'
import { TicketDrawer } from './TicketDrawer'
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
      backlog: { tickets: [] },
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

function sampleStage(over: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: 's1',
    pipelineId: 'pipe1',
    ordinal: 0,
    name: '实现',
    kind: 'ai',
    agentId: 'coding-assistant',
    promptTemplate: null,
    toolsets: null,
    effort: null,
    patrolCron: null,
    patrolEnabled: true,
    patrolTimezone: 'Asia/Shanghai',
    quietHoursStart: null,
    quietHoursEnd: null,
    maxRunsPerDay: 20,
    timeoutSec: 2400,
    maxRetries: 1,
    circuitBreakerThreshold: 3,
    onSuccess: 'wait_human',
    onFailure: 'block',
    autoClose: false,
    entryCondition: null,
    exitChecklist: null,
    requireHumanAck: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function sampleRun(over: Partial<TicketRun> = {}): TicketRun {
  return {
    id: 'r1',
    ticketId: 't1',
    stageId: 's1',
    agentId: 'coding-assistant',
    trigger: 'manual',
    sessionKey: 'agent:coding-assistant:taskboard:t1:s1:r1',
    status: 'skipped',
    skipReason: 'concurrency_full',
    leaseOwner: null,
    leaseExpiresAt: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
    summary: null,
    outputMd: null,
    error: null,
    createdAt: 1_700_000_200_000,
    ...over,
  }
}

function sampleComment(over: Partial<TicketComment> = {}): TicketComment {
  return {
    id: 'c1',
    ticketId: 't1',
    authorKind: 'human',
    author: 'user:default',
    body: '可以合',
    runId: null,
    createdAt: 1_700_000_300_000,
    ...over,
  }
}

function sampleActivity(over: Partial<TicketActivity> = {}): TicketActivity {
  return {
    id: 'a1',
    ticketId: 't1',
    actor: 'human',
    actorId: 'user:default',
    action: 'status_changed',
    field: 'status',
    fromValue: 'backlog',
    toValue: 'ready',
    createdAt: 1_700_000_100_000,
    ...over,
  }
}

function sampleSettings() {
  return {
    maxConcurrentRuns: 2,
    maxRunsPerDay: 200,
    maxCostPerDayUsd: null as number | null,
    quietHoursStart: 23,
    quietHoursEnd: 8,
    circuitBreakerThreshold: 3,
    maxStageLoops: 5,
    maxRunsPerTick: 2,
    patrolPaused: false,
    usage: { runsToday: 3, costTodayUsd: 0.12, activeRuns: 0 },
  }
}

function mockDrawerApis(ticket: Ticket, runs: TicketRun[] = []) {
  vi.spyOn(taskboardApi, 'getTicketDetail').mockResolvedValue({
    ticket,
    pipeline: null,
    stage: sampleStage(),
  })
  vi.spyOn(taskboardApi, 'listRuns').mockResolvedValue({ items: runs, total: runs.length })
  vi.spyOn(taskboardApi, 'listTimeline').mockResolvedValue(
    mergeTimelineSources({
      runs,
      comments: [sampleComment()],
      activities: [sampleActivity()],
    }),
  )
}

function renderDrawer(ticket: Ticket, over: Partial<ComponentProps<typeof TicketDrawer>> = {}) {
  const onOpenSession = vi.fn()
  const view = render(
    <ToastProvider>
      <TooltipProvider>
        <TicketDrawer
          auth={auth}
          ticket={ticket}
          ticketRef={ticket.identifier}
          open
          desktop
          agents={[{ id: 'coding-assistant', name: '编码助手' }]}
          stages={[sampleStage()]}
          sessionIds={[]}
          onClose={() => {}}
          onReconcile={() => {}}
          onTicketUpdated={() => {}}
          onOpenSession={onOpenSession}
          {...over}
        />
      </TooltipProvider>
    </ToastProvider>,
  )
  return { ...view, onOpenSession }
}

describe('originSessionKey 映射', () => {
  test('webchat key 抽出 peerId，且绝不带冒号', () => {
    expect(sessionIdFromOriginKey('agent:main:webchat:dm:webabc12345')).toBe('webabc12345')
    expect(sessionIdFromOriginKey('agent:main:taskboard:t1:s1:r1')).toBeNull()
    expect(sessionIdFromOriginKey('agent:main:webchat:dm:webabc12345')?.includes(':')).toBe(false)
  })

  test('只在侧栏会话列表命中时才返回 id', () => {
    expect(
      resolveOriginSessionId('agent:main:webchat:dm:webabc12345', ['webabc12345', 'other']),
    ).toBe('webabc12345')
    expect(resolveOriginSessionId('agent:main:webchat:dm:webabc12345', ['other'])).toBeNull()
    expect(resolveOriginSessionId('agent:main:taskboard:t1:s1:r1', ['t1'])).toBeNull()
  })
})

describe('429 concurrency_full 与 settings 客户端', () => {
  test('429 / concurrency_full 给出并发满中文提示', () => {
    const err = new ApiError({
      status: 429,
      message: 'taskboard concurrency full',
      code: 'concurrency_full',
    })
    expect(isConcurrencyFull(err)).toBe(true)
    expect(taskboardErrorMessage(err, '启动巡检失败')).toBe('巡检并发已满，请稍后再试')
    expect(skipReasonLabel('concurrency_full')).toBe('巡检并发已满')
  })

  test('GET/PATCH /api/board/settings', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === '/api/board/settings' && (!init || init.method === undefined)) {
        return ok(sampleSettings())
      }
      return ok({ ok: true, ...sampleSettings(), patrolPaused: true })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const got = await taskboardApi.getSettings(auth)
    expect(got.maxConcurrentRuns).toBe(2)
    expect(got.usage.runsToday).toBe(3)
    await taskboardApi.patchSettings(auth, { patrolPaused: true })
    const patchCall = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(
      (c) => c[1]?.method === 'PATCH',
    )
    expect(patchCall?.[0]).toBe('/api/board/settings')
  })
})

describe('时间线合并', () => {
  test('activity + run + comment 按时间倒序', () => {
    const items = mergeTimelineSources({
      activities: [sampleActivity({ createdAt: 10 })],
      runs: [sampleRun({ createdAt: 30 })],
      comments: [sampleComment({ createdAt: 20 })],
    })
    expect(items.map((i) => i.kind)).toEqual(['run', 'comment', 'activity'])
  })
})

describe('TicketDrawer 详情', () => {
  test('来源会话：列表命中才打开，传入的是 Session.id 而不是 sessionKey', async () => {
    const ticket = sampleTicket({
      originSessionKey: 'agent:main:webchat:dm:webabc12345',
    })
    mockDrawerApis(ticket)
    const { onOpenSession } = renderDrawer(ticket, { sessionIds: ['webabc12345'] })
    const btn = await screen.findByTestId('ticket-drawer-origin-session')
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(onOpenSession).toHaveBeenCalledTimes(1)
    expect(onOpenSession).toHaveBeenCalledWith('webabc12345')
    expect(String(onOpenSession.mock.calls[0]?.[0])).not.toContain(':')
  })

  test('来源会话：列表找不到则不调用 onOpenSession，并给出中文说明', async () => {
    const ticket = sampleTicket({
      originSessionKey: 'agent:main:webchat:dm:webabc12345',
    })
    mockDrawerApis(ticket)
    const { onOpenSession } = renderDrawer(ticket, { sessionIds: [] })
    const btn = await screen.findByTestId('ticket-drawer-origin-session')
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(onOpenSession).not.toHaveBeenCalled()
    expect(
      await screen.findByText('来源会话不在当前列表中，可能已删除或不是网页对话'),
    ).toBeInTheDocument()
  })

  test('巡检 sessionKey 不能当来源会话 id', async () => {
    const ticket = sampleTicket({
      originSessionKey: 'agent:main:taskboard:t1:s1:r1',
    })
    mockDrawerApis(ticket)
    const { onOpenSession } = renderDrawer(ticket, { sessionIds: ['t1', 'r1'] })
    const btn = await screen.findByTestId('ticket-drawer-origin-session')
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(onOpenSession).not.toHaveBeenCalled()
  })

  test('评论失败回滚乐观条目', async () => {
    const ticket = sampleTicket()
    mockDrawerApis(ticket)
    vi.spyOn(taskboardApi, 'comment').mockRejectedValue(
      new ApiError({ status: 500, message: 'internal error' }),
    )
    renderDrawer(ticket)
    await screen.findByTestId('ticket-drawer-comment')
    fireEvent.change(screen.getByTestId('ticket-drawer-comment'), {
      target: { value: '先别合' },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('ticket-drawer-comment-submit'))
    })
    await waitFor(() => {
      expect(screen.getByText('发表评论失败')).toBeInTheDocument()
    })
    const timeline = screen.getByTestId('ticket-timeline')
    expect(timeline.textContent).not.toContain('先别合')
    expect((screen.getByTestId('ticket-drawer-comment') as HTMLTextAreaElement).value).toBe(
      '先别合',
    )
  })

  test('改需求 409 冲突提示后强制对账', async () => {
    const ticket = sampleTicket({ version: 3 })
    mockDrawerApis(ticket)
    const reconcile = vi.fn()
    vi.spyOn(taskboardApi, 'patchTicket').mockRejectedValue(
      new ApiError({ status: 409, message: 'version conflict', code: 'version_conflict' }),
    )
    renderDrawer(ticket, { startEditing: true, onReconcile: reconcile })
    await screen.findByTestId('ticket-drawer-save')
    fireEvent.change(screen.getByLabelText('单据标题'), { target: { value: '新标题' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('ticket-drawer-save'))
    })
    expect(await screen.findByText('单据已被其他人更新，已刷新最新内容')).toBeInTheDocument()
    expect(reconcile).toHaveBeenCalled()
  })

  test('手动巡检 429 concurrency_full 给出中文提示', async () => {
    const ticket = sampleTicket({ status: 'ready' })
    mockDrawerApis(ticket)
    vi.spyOn(taskboardApi, 'patrol').mockRejectedValue(
      new ApiError({
        status: 429,
        message: 'taskboard concurrency full',
        code: 'concurrency_full',
      }),
    )
    renderDrawer(ticket)
    const btn = await screen.findByTestId('ticket-drawer-patrol')
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(await screen.findByText('巡检并发已满，请稍后再试')).toBeInTheDocument()
  })

  test('run 明细把 skipReason 翻成人话，空用量降级', async () => {
    const ticket = sampleTicket()
    const run = sampleRun({ skipReason: 'concurrency_full', durationMs: null, costUsd: null })
    mockDrawerApis(ticket, [run])
    renderDrawer(ticket)
    expect(await screen.findByText('跳过：巡检并发已满')).toBeInTheDocument()
    expect(screen.getByText(/耗时未记录/)).toBeInTheDocument()
    expect(screen.getByText(/用量未记录/)).toBeInTheDocument()
  })
})

describe('TaskboardView 来源会话不把 key 当 id', () => {
  test('命中侧栏 id 才回调，回调值不含冒号', async () => {
    const ticket = sampleTicket({
      originSessionKey: 'agent:main:webchat:dm:webabc12345',
    })
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
    vi.spyOn(taskboardApi, 'listTickets').mockResolvedValue({ items: [ticket], total: 1 })
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
      inbox: [ticket],
      backlog: { tickets: [] },
    })
    mockDrawerApis(ticket)
    const onOpenSession = vi.fn()
    render(
      <ToastProvider>
        <TooltipProvider>
          <TaskboardView
            auth={auth}
            view="inbox"
            ticketId="OCV5-42"
            onViewChange={() => {}}
            onOpenTicket={() => {}}
            onOpenMobileNav={() => {}}
            onOpenSession={onOpenSession}
            sessionIds={['webabc12345']}
          />
        </TooltipProvider>
      </ToastProvider>,
    )
    const btn = await screen.findByTestId('ticket-drawer-origin-session')
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(onOpenSession).toHaveBeenCalledWith('webabc12345')
    expect(String(onOpenSession.mock.calls[0]?.[0])).not.toMatch(/:/)
  })
})

describe('BoardSettingsPanel', () => {
  test('非 human 403 收口成中文', async () => {
    vi.spyOn(taskboardApi, 'getSettings').mockResolvedValue(sampleSettings())
    vi.spyOn(taskboardApi, 'patchSettings').mockRejectedValue(
      new ApiError({ status: 403, message: 'forbidden', code: 'forbidden' }),
    )
    render(
      <ToastProvider>
        <TooltipProvider>
          <BoardSettingsPanel auth={auth} />
        </TooltipProvider>
      </ToastProvider>,
    )
    fireEvent.click(screen.getByTestId('board-settings-open'))
    const save = await screen.findByTestId('board-settings-save')
    await act(async () => {
      fireEvent.click(save)
    })
    expect(await screen.findByText('当前身份无权执行此操作')).toBeInTheDocument()
  })

  test('急停开关要二次确认，取消不发请求', async () => {
    vi.spyOn(taskboardApi, 'getSettings').mockResolvedValue(sampleSettings())
    const patch = vi.spyOn(taskboardApi, 'patchSettings').mockResolvedValue({
      ok: true,
      ...sampleSettings(),
      patrolPaused: true,
    })
    render(
      <ToastProvider>
        <TooltipProvider>
          <BoardSettingsPanel auth={auth} />
        </TooltipProvider>
      </ToastProvider>,
    )
    fireEvent.click(screen.getByTestId('board-settings-open'))
    const pause = await screen.findByTestId('board-settings-pause')
    await act(async () => {
      fireEvent.click(pause)
    })
    expect(await screen.findByText('急停全部巡检？')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
    })
    expect(patch).not.toHaveBeenCalled()
  })
})

function sampleProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    key: 'OCV5',
    name: 'V5 自用',
    description: null,
    workspace: null,
    labels: [],
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function samplePipeline(over: Partial<import('../../lib/taskboard').Pipeline> = {}) {
  return {
    id: 'pipe1',
    projectId: 'p1',
    name: '问题单默认线',
    ticketType: 'bug' as const,
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function mockEmptyBoard() {
  vi.spyOn(taskboardApi, 'listTickets').mockResolvedValue({ items: [], total: 0 })
  vi.spyOn(taskboardApi, 'listAgents').mockResolvedValue([
    { id: 'coding-assistant', name: '编码助手' },
    { id: 'research', name: '调研助手' },
  ])
  vi.spyOn(taskboardApi, 'getProjectBoard').mockResolvedValue({
    project: sampleProject(),
    pipeline: samplePipeline(),
    ticketType: 'bug',
    columns: [],
    inbox: [],
    backlog: { tickets: [] },
  })
}

function renderBoard(over: Partial<ComponentProps<typeof TaskboardView>> = {}) {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <TaskboardView
          auth={auth}
          view="board"
          ticketId={null}
          onViewChange={() => {}}
          onOpenTicket={() => {}}
          onOpenMobileNav={() => {}}
          {...over}
        />
      </TooltipProvider>
    </ToastProvider>,
  )
}

describe('项目管理', () => {
  test('空库时能通过界面建项目并自动切过去', async () => {
    let stored: ReturnType<typeof sampleProject>[] = []
    vi.spyOn(taskboardApi, 'listProjects').mockImplementation(async () => stored)
    mockEmptyBoard()
    const createProject = vi
      .spyOn(taskboardApi, 'createProject')
      .mockImplementation(async (_a, body) => {
        const project = sampleProject({
          id: 'p-new',
          key: body.key,
          name: body.name,
          description: body.description ?? null,
        })
        stored = [project]
        return { ok: true, project }
      })

    renderBoard()
    expect(await screen.findByText('还没有项目')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-create-open'))
    await screen.findByTestId('project-create')
    fireEvent.change(screen.getByTestId('project-key'), { target: { value: 'ocv5' } })
    fireEvent.change(screen.getByTestId('project-name'), { target: { value: 'V5 自用' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create-submit'))
    })

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith(
        auth,
        expect.objectContaining({ key: 'OCV5', name: 'V5 自用', description: null }),
      )
    })
    await waitFor(() => {
      expect(screen.getByLabelText('项目')).toHaveValue('p-new')
    })
    expect(taskboardApi.getProjectBoard).toHaveBeenCalledWith(auth, 'p-new', undefined)
    expect(screen.queryByText('还没有项目')).not.toBeInTheDocument()
  })

  test('归档项目默认不出现在下拉里', async () => {
    vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue([
      sampleProject({ id: 'p1', key: 'OCV5', name: '在用' }),
      sampleProject({ id: 'p-arch', key: 'OLD', name: '旧项目', archivedAt: 99 }),
    ])
    mockEmptyBoard()
    renderBoard()
    const select = await screen.findByLabelText('项目')
    const values = [...(select as HTMLSelectElement).options].map((o) => o.value)
    expect(values).toContain('p1')
    expect(values).not.toContain('p-arch')
  })
})

describe('流水线 / 阶段配置', () => {
  function mockStageApis(stageOver: Partial<PipelineStage> = {}) {
    const pipeline = samplePipeline()
    const stage = sampleStage({
      id: 's1',
      pipelineId: pipeline.id,
      name: '定位根因',
      kind: 'ai',
      agentId: 'coding-assistant',
      promptTemplate: '查根因',
      patrolCron: '*/30 9-19 * * 1-5',
      patrolEnabled: true,
      ...stageOver,
    })
    vi.spyOn(taskboardApi, 'listPipelines').mockResolvedValue([pipeline])
    vi.spyOn(taskboardApi, 'getPipeline').mockResolvedValue({ pipeline, stages: [stage] })
    vi.spyOn(taskboardApi, 'listAgents').mockResolvedValue([
      { id: 'coding-assistant', name: '编码助手' },
      { id: 'research', name: '调研助手' },
    ])
    return { pipeline, stage }
  }

  async function openStageEditor() {
    render(
      <ToastProvider>
        <TooltipProvider>
          <StageSettings auth={auth} projectId="p1" />
        </TooltipProvider>
      </ToastProvider>,
    )
    fireEvent.click(screen.getByTestId('stage-settings-open'))
    await screen.findByTestId('stage-settings')
    const edit = await screen.findByTestId('stage-edit-s1')
    await act(async () => {
      fireEvent.click(edit)
    })
    await screen.findByTestId('stage-editor-s1')
  }

  test('阶段配置能加载 agent 下拉，hidden agent 不出现', async () => {
    mockStageApis()
    await openStageEditor()
    const agentSelect = screen.getByLabelText('绑定 agent') as HTMLSelectElement
    const values = [...agentSelect.options].map((o) => o.value)
    expect(values).toContain('coding-assistant')
    expect(values).toContain('research')
    expect(values).not.toContain('hidden-reviewer')
    expect(screen.queryByText('hidden-reviewer')).not.toBeInTheDocument()
    expect(taskboardApi.listAgents).toHaveBeenCalled()
  })

  test('修改 stage 的 agentId / promptTemplate / patrolCron 会发出正确的 PATCH', async () => {
    mockStageApis()
    const patchStage = vi.spyOn(taskboardApi, 'patchStage').mockResolvedValue({
      ok: true,
      stage: sampleStage({
        id: 's1',
        agentId: 'research',
        promptTemplate: '新提示词',
        patrolCron: '0 10 * * 1-5',
      }),
    })
    await openStageEditor()
    fireEvent.change(screen.getByLabelText('绑定 agent'), { target: { value: 'research' } })
    fireEvent.change(screen.getByLabelText('提示词模板'), { target: { value: '新提示词' } })
    fireEvent.change(screen.getByLabelText('巡检表达式'), { target: { value: '0 10 * * 1-5' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('stage-save-s1'))
    })
    await waitFor(() => {
      expect(patchStage).toHaveBeenCalled()
    })
    const body = patchStage.mock.calls[0]?.[2]
    expect(body).toEqual(
      expect.objectContaining({
        agentId: 'research',
        promptTemplate: '新提示词',
        patrolCron: '0 10 * * 1-5',
      }),
    )
    expect(patchStage.mock.calls[0]?.[1]).toBe('s1')
  })

  test('kind=human 时巡检 cron 被挡住', async () => {
    mockStageApis({ kind: 'ai', patrolCron: '*/30 * * * *', patrolEnabled: true })
    const patchStage = vi.spyOn(taskboardApi, 'patchStage').mockResolvedValue({
      ok: true,
      stage: sampleStage({ id: 's1', kind: 'human', patrolCron: null, patrolEnabled: false }),
    })
    await openStageEditor()
    fireEvent.change(screen.getByLabelText('阶段类型'), { target: { value: 'human' } })
    expect(screen.getByLabelText('巡检表达式')).toBeDisabled()
    expect(screen.getByLabelText('启用巡检')).toBeDisabled()
    expect(screen.getByText(/人工阶段不参与巡检/)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByTestId('stage-save-s1'))
    })
    await waitFor(() => {
      expect(patchStage).toHaveBeenCalled()
    })
    expect(patchStage.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        kind: 'human',
        patrolCron: null,
        patrolEnabled: false,
        agentId: null,
      }),
    )
  })

  test('保存遇 409 时提示并重读', async () => {
    const { pipeline, stage } = mockStageApis()
    const listPipelines = vi.spyOn(taskboardApi, 'listPipelines')
    const getPipeline = vi.spyOn(taskboardApi, 'getPipeline')
    vi.spyOn(taskboardApi, 'patchStage').mockRejectedValue(
      new ApiError({ status: 409, message: 'version conflict', code: 'version_conflict' }),
    )
    await openStageEditor()
    const pipelinesBefore = listPipelines.mock.calls.length
    const getBefore = getPipeline.mock.calls.length
    fireEvent.change(screen.getByLabelText('提示词模板'), { target: { value: '会被丢掉的本地值' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('stage-save-s1'))
    })
    expect(await screen.findByText('配置已被其他人更新，已重新加载')).toBeInTheDocument()
    await waitFor(() => {
      expect(listPipelines.mock.calls.length).toBeGreaterThan(pipelinesBefore)
      expect(getPipeline.mock.calls.length).toBeGreaterThan(getBefore)
      expect(screen.getByLabelText('提示词模板')).toHaveValue(stage.promptTemplate ?? '')
    })
    expect(getPipeline).toHaveBeenCalledWith(auth, pipeline.id)
  })

  test('listPipelines / patchStage / listAgents 走真实端点', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url)
      if (path.startsWith('/api/board/pipelines?')) return ok({ items: [] })
      if (path === '/api/board/pipelines' && init?.method === 'POST') {
        return ok({ ok: true, pipeline: samplePipeline() }, 201)
      }
      if (path.includes('/stages') && init?.method === 'POST') {
        return ok({ ok: true, stage: sampleStage() }, 201)
      }
      if (path.startsWith('/api/board/stages/') && init?.method === 'PATCH') {
        return ok({ ok: true, stage: sampleStage() })
      }
      if (path === '/api/board/agents') return ok({ items: [] })
      if (path.startsWith('/api/board/projects/') && init?.method === 'PATCH') {
        return ok({ ok: true, project: sampleProject() })
      }
      return ok({ items: [] })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    await taskboardApi.listPipelines(auth, 'p1')
    expect(String((fetchMock.mock.calls as unknown as [string][])[0]?.[0])).toBe(
      '/api/board/pipelines?projectId=p1',
    )
    await taskboardApi.patchStage(auth, 's1', { agentId: 'research', promptTemplate: 'x' })
    const patchCall = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(
      (c) => c[1]?.method === 'PATCH' && String(c[0]).includes('/stages/'),
    )
    expect(patchCall?.[0]).toBe('/api/board/stages/s1')
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      agentId: 'research',
      promptTemplate: 'x',
    })
    await taskboardApi.listAgents(auth)
    expect(
      (fetchMock.mock.calls as unknown as [string][]).some((c) => c[0] === '/api/board/agents'),
    ).toBe(true)
    await taskboardApi.patchProject(auth, 'p1', { name: '改名' })
    const projPatch = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(
      (c) => c[1]?.method === 'PATCH' && String(c[0]).includes('/projects/'),
    )
    expect(projPatch?.[0]).toBe('/api/board/projects/p1')
  })
})
