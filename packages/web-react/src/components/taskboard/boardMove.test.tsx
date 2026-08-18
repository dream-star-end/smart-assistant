import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import {
  type AllowedMove,
  type PipelineStage,
  type Project,
  type Ticket,
  taskboardApi,
} from '../../lib/taskboard'
import { ToastProvider, TooltipProvider } from '../ui'
import { TaskboardView } from './TaskboardView'
import {
  formatBlockersMessage,
  formatConfirmSkipMessage,
  formatMoveSuccess,
  formatNoIntentMessage,
} from './ticketMove'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const auth = createMemoryAuthSession(() => {}, 'tok-move')

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

function sampleStage(over: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: 's1',
    pipelineId: 'pipe1',
    ordinal: 0,
    name: '复现确认',
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
    requireHumanAck: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
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
    status: 'backlog',
    stageId: null,
    pipelineId: 'pipe1',
    priority: 'P0',
    severity: 'major',
    labels: [],
    assignee: null,
    reporter: 'user:default',
    source: 'manual',
    originSessionKey: null,
    dueDate: null,
    startDate: null,
    version: 3,
    blockedReason: null,
    stageLoopCount: 0,
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
    ...over,
  }
}

function move(
  over: Partial<AllowedMove> & Pick<AllowedMove, 'toStageId' | 'action' | 'label'>,
): AllowedMove {
  return {
    requiresReason: false,
    requiresConfirm: false,
    ...over,
  }
}

const s1 = sampleStage({ id: 's1', name: '复现确认', ordinal: 0 })
const s2 = sampleStage({ id: 's2', name: '定位根因', ordinal: 1 })
const s3 = sampleStage({ id: 's3', name: '自验', ordinal: 2, kind: 'ai' })

function fakeDt() {
  return {
    data: {} as Record<string, string>,
    effectAllowed: 'move',
    dropEffect: 'none',
    setData(type: string, val: string) {
      this.data[type] = val
    },
    getData(type: string) {
      return this.data[type]
    },
  }
}

function column(id: string): HTMLElement {
  const el = document.querySelector(`[data-stage-id="${id}"]`)
  expect(el, `missing column ${id}`).toBeTruthy()
  return el as HTMLElement
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

function stubBoard(input: {
  backlog?: Ticket[]
  columns?: Array<{ stage: PipelineStage; tickets: Ticket[] }>
  ticketType?: Ticket['type']
  list?: Ticket[]
}) {
  const backlog = input.backlog ?? []
  const columns = input.columns ?? [
    { stage: s1, tickets: [] },
    { stage: s2, tickets: [] },
    { stage: s3, tickets: [] },
  ]
  const ticketType = input.ticketType ?? 'feature'
  vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue([sampleProject()])
  vi.spyOn(taskboardApi, 'listAgents').mockResolvedValue([])
  vi.spyOn(taskboardApi, 'listTickets').mockImplementation(async (_a, q) => {
    if (q?.status === 'backlog') return { items: backlog, total: backlog.length }
    return { items: input.list ?? [...backlog, ...columns.flatMap((c) => c.tickets)], total: 0 }
  })
  const getBoard = vi
    .spyOn(taskboardApi, 'getProjectBoard')
    .mockImplementation(async (_a, _id, type) => ({
      project: sampleProject(),
      pipeline: {
        id: 'pipe1',
        projectId: 'p1',
        name: '线',
        ticketType: type ?? ticketType,
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
      ticketType: type ?? ticketType,
      columns,
      inbox: [],
      backlog: { tickets: type && type !== ticketType ? [] : backlog },
    }))
  return { getBoard }
}

describe('积压列与有条件拖动', () => {
  test('渲染固定积压列；积压卡拖到第一站触发 promote', async () => {
    const card = sampleTicket({
      allowedMoves: [
        move({ toStageId: 's1', action: 'promote', label: '批准开工' }),
        move({
          toStageId: 's2',
          action: 'promote_at_stage',
          label: '批准并指定入站',
          requiresConfirm: true,
        }),
      ],
    })
    stubBoard({ backlog: [card], ticketType: 'bug' })
    const moveTicket = vi.spyOn(taskboardApi, 'moveTicket').mockResolvedValue({
      ticket: { ...card, status: 'ready', stageId: 's1', version: 4 },
      move: {
        action: 'promote',
        label: '批准开工',
        fromStageId: null,
        toStageId: 's1',
        skippedStages: [],
        abandonedStage: null,
        commentId: 'c1',
      },
    })
    renderBoard()
    const col = await screen.findByTestId('taskboard-backlog-column')
    expect(col).toHaveTextContent('积压')
    expect(col).toHaveTextContent('这里的单 AI 不会碰')
    expect(screen.getByText('登录 500')).toBeInTheDocument()

    const dt = fakeDt()
    fireEvent.dragStart(screen.getByTestId('ticket-card'), { dataTransfer: dt })
    const first = column('s1')
    expect(first).toHaveAttribute('data-drop-allowed', 'true')
    fireEvent.dragOver(first, { dataTransfer: dt })
    await act(async () => {
      fireEvent.drop(first, { dataTransfer: dt })
    })
    await waitFor(() => {
      expect(moveTicket).toHaveBeenCalledWith(
        auth,
        't1',
        expect.objectContaining({ toStageId: 's1', expectedVersion: 3 }),
      )
    })
    expect(await screen.findByText('已批准开工到「复现确认」站')).toBeInTheDocument()
  })

  test('send_back 缺理由 → 弹理由输入 → 补齐后重试成功', async () => {
    const card = sampleTicket({
      id: 't2',
      identifier: 'OCV5-7',
      status: 'waiting_human',
      stageId: 's2',
      title: '修完待确认',
      allowedMoves: [
        move({ toStageId: 's1', action: 'send_back', label: '打回重做', requiresReason: true }),
      ],
    })
    stubBoard({
      columns: [
        { stage: s1, tickets: [] },
        { stage: s2, tickets: [card] },
        { stage: s3, tickets: [] },
      ],
    })
    const moveTicket = vi
      .spyOn(taskboardApi, 'moveTicket')
      .mockRejectedValueOnce(
        new ApiError({
          status: 422,
          message: '打回必须填写理由',
          code: 'reason_required',
          body: {
            error: '打回必须填写理由',
            code: 'reason_required',
            detail: { action: 'send_back' },
          },
        }),
      )
      .mockResolvedValueOnce({
        ticket: { ...card, stageId: 's1', version: 4 },
        move: {
          action: 'send_back',
          label: '打回重做',
          fromStageId: 's2',
          toStageId: 's1',
          commentId: 'c2',
        },
      })
    renderBoard()
    expect(await screen.findByText('修完待确认')).toBeInTheDocument()
    const dt = fakeDt()
    fireEvent.dragStart(screen.getByTestId('ticket-card'), { dataTransfer: dt })
    await act(async () => {
      fireEvent.drop(column('s1'), { dataTransfer: dt })
    })
    expect(await screen.findByText('这条理由会作为评论交给目标站的 agent。')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('请填写理由'), {
      target: { value: '根因判断错了，请重做' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '打回' }))
    })
    await waitFor(() => {
      expect(moveTicket).toHaveBeenCalledTimes(2)
    })
    expect(moveTicket.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({
        toStageId: 's1',
        reason: '根因判断错了，请重做',
        expectedVersion: 3,
      }),
    )
    expect(await screen.findByText('已打回重做到「复现确认」站')).toBeInTheDocument()
  })

  test('confirm_required 确认框展示 abandonedStage 与 skippedStages', async () => {
    const card = sampleTicket({
      id: 't3',
      status: 'ready',
      stageId: 's1',
      title: '跳站',
      allowedMoves: [
        move({
          toStageId: 's3',
          action: 'skip_forward',
          label: '跳站前进',
          requiresConfirm: true,
          abandonedStage: { id: 's1', name: '复现确认', kind: 'ai' },
          skippedStages: [{ id: 's2', name: '定位根因', kind: 'ai' }],
        }),
      ],
    })
    stubBoard({
      columns: [
        { stage: s1, tickets: [card] },
        { stage: s2, tickets: [] },
        { stage: s3, tickets: [] },
      ],
    })
    const moveTicket = vi
      .spyOn(taskboardApi, 'moveTicket')
      .mockRejectedValueOnce(
        new ApiError({
          status: 422,
          message: '需要确认',
          code: 'confirm_required',
          body: {
            error: '需要确认',
            code: 'confirm_required',
            detail: {
              action: 'skip_forward',
              abandonedStage: { id: 's1', name: '复现确认', kind: 'ai' },
              skippedStages: [{ id: 's2', name: '定位根因', kind: 'ai' }],
            },
          },
        }),
      )
      .mockResolvedValueOnce({
        ticket: { ...card, stageId: 's3', version: 4 },
        move: { action: 'skip_forward', label: '跳站前进', fromStageId: 's1', toStageId: 's3' },
      })
    renderBoard()
    expect(await screen.findByText('跳站')).toBeInTheDocument()
    const dt = fakeDt()
    fireEvent.dragStart(screen.getByTestId('ticket-card'), { dataTransfer: dt })
    const dest = screen
      .getAllByTestId('taskboard-column')
      .find((el) => el.getAttribute('data-stage-id') === 's3')
    expect(dest).toBeTruthy()
    await act(async () => {
      fireEvent.drop(dest as HTMLElement, { dataTransfer: dt })
    })
    expect(await screen.findByText(/「复现确认」站的工作将被视为不需要/)).toBeInTheDocument()
    expect(screen.getByText(/「定位根因」/)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认移动' }))
    })
    await waitFor(() => {
      expect(moveTicket).toHaveBeenCalledTimes(2)
    })
    expect(moveTicket.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ toStageId: 's3', confirmSkippedStages: true }),
    )
  })

  test('running_run_active 询问取消 run 后重试', async () => {
    const card = sampleTicket({
      id: 't4',
      status: 'running',
      stageId: 's1',
      title: '正在跑的单',
      allowedMoves: [
        move({ toStageId: 's2', action: 'skip_forward', label: '跳站前进', requiresConfirm: true }),
      ],
    })
    stubBoard({
      columns: [
        { stage: s1, tickets: [card] },
        { stage: s2, tickets: [] },
        { stage: s3, tickets: [] },
      ],
    })
    const moveTicket = vi
      .spyOn(taskboardApi, 'moveTicket')
      .mockRejectedValueOnce(
        new ApiError({
          status: 409,
          message: 'run active',
          code: 'running_run_active',
          body: {
            error: 'run active',
            code: 'running_run_active',
            detail: { runId: 'run-99' },
          },
        }),
      )
      .mockResolvedValueOnce({
        ticket: { ...card, status: 'ready', stageId: 's2', version: 4 },
        move: { action: 'skip_forward', label: '跳站前进', fromStageId: 's1', toStageId: 's2' },
      })
    renderBoard()
    expect(await screen.findByText('正在跑的单')).toBeInTheDocument()
    const dt = fakeDt()
    fireEvent.dragStart(screen.getByTestId('ticket-card'), { dataTransfer: dt })
    await act(async () => {
      fireEvent.drop(column('s2'), { dataTransfer: dt })
    })
    expect(await screen.findByText(/run-99/)).toBeInTheDocument()
    expect(screen.getByText(/取消当前 run 后再移动/)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消并移动' }))
    })
    await waitFor(() => expect(moveTicket).toHaveBeenCalledTimes(2))
    expect(moveTicket.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ cancelRunningRun: true, toStageId: 's2' }),
    )
  })

  test('version_conflict 提示刷新且没有静默重试', async () => {
    const card = sampleTicket({
      id: 't5',
      status: 'backlog',
      allowedMoves: [move({ toStageId: 's1', action: 'promote', label: '批准开工' })],
    })
    stubBoard({ backlog: [card] })
    const moveTicket = vi.spyOn(taskboardApi, 'moveTicket').mockRejectedValue(
      new ApiError({
        status: 409,
        message: 'version conflict',
        code: 'version_conflict',
        body: { error: 'version conflict', code: 'version_conflict' },
      }),
    )
    renderBoard()
    expect(await screen.findByText('登录 500')).toBeInTheDocument()
    const dt = fakeDt()
    fireEvent.dragStart(screen.getByTestId('ticket-card'), { dataTransfer: dt })
    await act(async () => {
      fireEvent.drop(column('s1'), { dataTransfer: dt })
    })
    expect(await screen.findByText('单据已被改动，请刷新看板后重试')).toBeInTheDocument()
    await act(async () => {
      await Promise.resolve()
    })
    expect(moveTicket).toHaveBeenCalledTimes(1)
  })

  test('非法落点在拖动时被禁用', async () => {
    const card = sampleTicket({
      id: 't6',
      status: 'waiting_human',
      stageId: 's2',
      title: '只能打回',
      allowedMoves: [
        move({ toStageId: 's1', action: 'send_back', label: '打回重做', requiresReason: true }),
        move({ toStageId: null, action: 'return_to_backlog', label: '退回积压' }),
      ],
    })
    stubBoard({
      columns: [
        { stage: s1, tickets: [] },
        { stage: s2, tickets: [card] },
        { stage: s3, tickets: [] },
      ],
    })
    const moveTicket = vi.spyOn(taskboardApi, 'moveTicket')
    renderBoard()
    expect(await screen.findByText('只能打回')).toBeInTheDocument()
    const dt = fakeDt()
    fireEvent.dragStart(screen.getByTestId('ticket-card'), { dataTransfer: dt })
    const cols = screen.getAllByTestId('taskboard-column')
    const col = (id: string) =>
      cols.find((el) => el.getAttribute('data-stage-id') === id) as HTMLElement
    expect(col('s1')).toHaveAttribute('data-drop-allowed', 'true')
    expect(col('s1')).not.toHaveAttribute('data-drop-disabled')
    expect(col('s3')).toHaveAttribute('data-drop-disabled', 'true')
    expect(col('s3')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('taskboard-backlog-column')).toHaveAttribute(
      'data-drop-allowed',
      'true',
    )
    await act(async () => {
      fireEvent.drop(col('s3'), { dataTransfer: dt })
    })
    expect(moveTicket).not.toHaveBeenCalled()
  })

  test('类型切换器切换后按新 ticketType 重新请求', async () => {
    const { getBoard } = stubBoard({ ticketType: 'feature', backlog: [] })
    renderBoard()
    const switcher = await screen.findByLabelText('看板类型')
    await waitFor(() => {
      expect(switcher).toHaveValue('feature')
    })
    expect(getBoard).toHaveBeenCalledWith(auth, 'p1', undefined)
    await act(async () => {
      fireEvent.change(switcher, { target: { value: 'spike' } })
    })
    await waitFor(() => {
      expect(getBoard).toHaveBeenCalledWith(auth, 'p1', 'spike')
    })
  })

  test('「移动到…」键盘路径能完成一次移动', async () => {
    const card = sampleTicket({
      allowedMoves: [move({ toStageId: 's1', action: 'promote', label: '批准开工' })],
    })
    stubBoard({ backlog: [card] })
    const moveTicket = vi.spyOn(taskboardApi, 'moveTicket').mockResolvedValue({
      ticket: { ...card, status: 'ready', stageId: 's1', version: 4 },
      move: { action: 'promote', label: '批准开工', fromStageId: null, toStageId: 's1' },
    })
    renderBoard()
    const select = await screen.findByLabelText('移动到…')
    await act(async () => {
      fireEvent.change(select, { target: { value: 's1' } })
    })
    await waitFor(() => {
      expect(moveTicket).toHaveBeenCalledWith(
        auth,
        't1',
        expect.objectContaining({ toStageId: 's1', expectedVersion: 3 }),
      )
    })
    expect(await screen.findByText('已批准开工到「复现确认」站')).toBeInTheDocument()
  })
})

describe('积压 tab 与新建单据', () => {
  test('积压 tab 列出跨类型积压并走 /move 批准开工', async () => {
    const leftover = sampleTicket({
      id: 't-feat',
      identifier: 'OCV5-9',
      type: 'feature',
      title: '遗留需求',
      status: 'backlog',
    })
    stubBoard({ backlog: [leftover], ticketType: 'bug' })
    const moveTicket = vi.spyOn(taskboardApi, 'moveTicket').mockResolvedValue({
      ticket: { ...leftover, status: 'ready', stageId: 's1', version: 4 },
      move: { action: 'promote', label: '批准开工', fromStageId: null, toStageId: 's1' },
    })
    renderBoard({ view: 'backlog' })
    expect(await screen.findByRole('tab', { name: /积压 1/ })).toBeInTheDocument()
    expect(screen.getByText('遗留需求')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByTestId('ticket-ready'))
    })
    await waitFor(() => {
      expect(moveTicket).toHaveBeenCalledWith(
        auth,
        't-feat',
        expect.objectContaining({ toStageId: 's1' }),
      )
    })
  })

  test('新建单据默认记为积压，直接开工才传 status=ready', async () => {
    stubBoard({ backlog: [] })
    const created = sampleTicket({ identifier: 'OCV5-80', title: '随手记下' })
    const create = vi.spyOn(taskboardApi, 'createTicket').mockResolvedValue({
      ok: true,
      ticket: created,
    })
    renderBoard()
    await waitFor(() => {
      expect(screen.getByLabelText('项目')).toHaveValue('p1')
    })
    fireEvent.click(screen.getByRole('button', { name: '新建单据' }))
    expect(await screen.findByRole('radio', { name: '记为积压' })).toBeChecked()
    fireEvent.change(screen.getByLabelText('单据标题'), { target: { value: '随手记下' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }))
    })
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ title: '随手记下', type: 'bug', source: 'manual' }),
    )
    expect(create.mock.calls[0]?.[1]).not.toHaveProperty('status')

    fireEvent.click(screen.getByRole('button', { name: '新建单据' }))
    fireEvent.click(screen.getByRole('radio', { name: '直接开工' }))
    fireEvent.change(screen.getByLabelText('单据标题'), { target: { value: '马上做' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '创建' }))
    })
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ status: 'ready', title: '马上做' }),
    )
  })
})

describe('其余移动错误码', () => {
  test('no_interpretable_intent 展示 why；blocked_dependency 列出 blockers；forbidden 提示无权限', async () => {
    const card = sampleTicket({
      allowedMoves: [move({ toStageId: 's1', action: 'promote', label: '批准开工' })],
    })
    stubBoard({ backlog: [card] })
    const moveTicket = vi
      .spyOn(taskboardApi, 'moveTicket')
      .mockRejectedValueOnce(
        new ApiError({
          status: 422,
          message: '无法解析',
          code: 'no_interpretable_intent',
          body: {
            error: '无法解析',
            code: 'no_interpretable_intent',
            detail: { why: 'unmapped_drag' },
          },
        }),
      )
      .mockRejectedValueOnce(
        new ApiError({
          status: 422,
          message: 'blocked',
          code: 'blocked_dependency',
          body: {
            error: 'blocked',
            code: 'blocked_dependency',
            detail: { blockers: [{ identifier: 'OCV5-1', title: '先做这个', status: 'ready' }] },
          },
        }),
      )
      .mockRejectedValueOnce(
        new ApiError({
          status: 403,
          message: 'forbidden',
          code: 'forbidden',
          body: { error: 'forbidden', code: 'forbidden' },
        }),
      )
    renderBoard()
    const select = await screen.findByLabelText('移动到…')
    await act(async () => {
      fireEvent.change(select, { target: { value: 's1' } })
    })
    expect(await screen.findByText(/这次拖动没有可解释的语义/)).toBeInTheDocument()
    expect(screen.getByText(/unmapped_drag/)).toBeInTheDocument()

    await act(async () => {
      fireEvent.change(select, { target: { value: 's1' } })
    })
    expect(await screen.findByText('依赖未解除：OCV5-1')).toBeInTheDocument()

    await act(async () => {
      fireEvent.change(select, { target: { value: 's1' } })
    })
    expect(await screen.findByText('当前身份无权执行此操作')).toBeInTheDocument()
    expect(moveTicket).toHaveBeenCalledTimes(3)
  })
})

describe('移动文案', () => {
  test('成功反馈带动作名；确认框说清被放弃的当前站', () => {
    expect(formatMoveSuccess({ label: '打回重做', toStageId: 's1' }, '定位根因')).toBe(
      '已打回重做到「定位根因」站',
    )
    expect(formatMoveSuccess({ label: '退回积压', toStageId: null })).toBe('已退回积压')
    const copy = formatConfirmSkipMessage({
      abandonedStage: { name: '定位根因' },
      skippedStages: [{ name: '自验' }],
    })
    expect(copy.body).toContain('「定位根因」站的工作将被视为不需要')
    expect(copy.body).toContain('「自验」')
    expect(formatBlockersMessage([{ identifier: 'OCV5-1' }])).toBe('依赖未解除：OCV5-1')
    expect(formatNoIntentMessage('目标阶段不属于该单据当前流水线。')).toContain(
      '这次拖动没有可解释的语义',
    )
  })
})

describe('拖动落点占位', () => {
  test('合法列出现占位，离开或拖到非法列后消失', async () => {
    const card = sampleTicket({
      id: 't-ph',
      status: 'waiting_human',
      stageId: 's2',
      title: '只能打回',
      allowedMoves: [
        move({ toStageId: 's1', action: 'send_back', label: '打回重做', requiresReason: true }),
        move({ toStageId: null, action: 'return_to_backlog', label: '退回积压' }),
      ],
    })
    stubBoard({
      columns: [
        { stage: s1, tickets: [] },
        { stage: s2, tickets: [card] },
        { stage: s3, tickets: [] },
      ],
    })
    renderBoard()
    expect(await screen.findByText('只能打回')).toBeInTheDocument()
    expect(screen.queryByTestId('drop-placeholder')).not.toBeInTheDocument()

    const dt = fakeDt()
    fireEvent.dragStart(screen.getByTestId('ticket-card'), { dataTransfer: dt })
    const legal = column('s1')
    const illegal = column('s3')

    fireEvent.dragOver(legal, { dataTransfer: dt })
    const ph = await screen.findByTestId('drop-placeholder')
    expect(ph).toHaveAttribute('data-drop-placeholder', 'true')
    expect(legal.querySelector('[data-drop-placeholder]')).toBeTruthy()
    expect(illegal.querySelector('[data-drop-placeholder]')).toBeFalsy()

    fireEvent.dragOver(illegal, { dataTransfer: dt })
    expect(screen.queryByTestId('drop-placeholder')).not.toBeInTheDocument()

    fireEvent.dragOver(legal, { dataTransfer: dt })
    expect(await screen.findByTestId('drop-placeholder')).toBeInTheDocument()
    fireEvent.dragLeave(legal, { relatedTarget: document.body, dataTransfer: dt })
    expect(screen.queryByTestId('drop-placeholder')).not.toBeInTheDocument()
  })
})

describe('看板卡片操作收整', () => {
  test('破坏性动作不在看板卡一级，菜单里可达；「移动到…」仍可用', async () => {
    const card = sampleTicket({
      id: 't-wh',
      status: 'waiting_human',
      stageId: 's2',
      title: '等人确认',
      allowedMoves: [
        move({ toStageId: 's1', action: 'send_back', label: '打回重做', requiresReason: true }),
      ],
    })
    stubBoard({
      columns: [
        { stage: s1, tickets: [] },
        { stage: s2, tickets: [card] },
        { stage: s3, tickets: [] },
      ],
    })
    const moveTicket = vi.spyOn(taskboardApi, 'moveTicket').mockResolvedValue({
      ticket: { ...card, stageId: 's1', version: 4 },
      move: { action: 'send_back', label: '打回重做', fromStageId: 's2', toStageId: 's1' },
    })
    renderBoard()
    const cardEl = await screen.findByTestId('ticket-card')
    expect(within(cardEl).getByRole('button', { name: '通过' })).toBeInTheDocument()
    expect(within(cardEl).queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
    expect(within(cardEl).queryByRole('button', { name: '打回' })).not.toBeInTheDocument()
    expect(within(cardEl).queryByTestId('ticket-cancel')).not.toBeInTheDocument()
    expect(within(cardEl).queryByTestId('ticket-done')).not.toBeInTheDocument()

    const moveSelect = within(cardEl).getByLabelText('移动到…')
    expect(moveSelect).toBeInTheDocument()

    fireEvent.pointerDown(within(cardEl).getByTestId('ticket-more-actions'), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    expect(await screen.findByRole('menuitem', { name: '取消' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '打回' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '完成' })).toBeInTheDocument()
    expect(screen.getByTestId('ticket-cancel')).toBeInTheDocument()

    await act(async () => {
      fireEvent.change(moveSelect, { target: { value: 's1' } })
    })
    await waitFor(() => {
      expect(moveTicket).toHaveBeenCalledWith(
        auth,
        't-wh',
        expect.objectContaining({ toStageId: 's1', expectedVersion: 3 }),
      )
    })
  })
})

describe('积压 tab 类型筛选', () => {
  test('切换类型后列表内容随之变化', async () => {
    stubBoard({
      backlog: [
        sampleTicket({
          id: 'b1',
          identifier: 'OCV5-1',
          type: 'bug',
          title: '积压问题',
          status: 'backlog',
        }),
        sampleTicket({
          id: 'f1',
          identifier: 'OCV5-2',
          type: 'feature',
          title: '积压需求',
          status: 'backlog',
        }),
      ],
      ticketType: 'bug',
    })
    renderBoard({ view: 'backlog' })
    expect(await screen.findByText('积压问题')).toBeInTheDocument()
    expect(screen.getByText('积压需求')).toBeInTheDocument()
    const filter = screen.getByLabelText('积压类型')
    expect(filter).toHaveValue('')
    expect(filter).toHaveTextContent('问题单')
    expect(filter).toHaveTextContent('需求单')
    expect(filter).toHaveTextContent('调研单')
    expect(filter).toHaveTextContent('杂务单')

    await act(async () => {
      fireEvent.change(filter, { target: { value: 'feature' } })
    })
    expect(screen.getByText('积压需求')).toBeInTheDocument()
    expect(screen.queryByText('积压问题')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.change(filter, { target: { value: 'spike' } })
    })
    expect(screen.getByText('没有这类积压单')).toBeInTheDocument()
    expect(screen.queryByText('积压需求')).not.toBeInTheDocument()
  })
})
