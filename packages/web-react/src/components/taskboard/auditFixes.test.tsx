/**
 * 任务面板阶段 B 修复的回归用例(对应 docs/audit/taskboard.md §4 各条编号)。
 * 每条逻辑改动至少一个用例;纯视觉项(T-09 / T-10 布局 / T-11 / T-24 / T-25 / T-28)以 ui-preview after 截图为证。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { ProjectScopeProvider } from '../../hooks/useProjectScope'
import { api } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import {
  ACTIVE_LIST_STATUSES,
  LAST_PROJECT_STORAGE_KEY,
  type PipelineStage,
  type Project,
  TICKET_STATUS_LABEL,
  type Ticket,
  type TicketComment,
  type WeeklyReport,
  taskboardApi,
} from '../../lib/taskboard'
import { ToastProvider, TooltipProvider } from '../ui'
import { BoardSettingsPanel } from './BoardSettingsPanel'
import { CostStatsView } from './CostStatsView'
import { ProjectSettings } from './ProjectSettings'
import { TaskboardView } from './TaskboardView'
import { TemplateLibrary } from './TemplateLibrary'
import { TicketCard } from './TicketCard'
import { TicketDrawer } from './TicketDrawer'
import { LIST_QUERY_DEBOUNCE_MS, TicketListView, countActiveFilters } from './TicketListView'
import { WeeklyReportView } from './WeeklyReportView'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.removeItem(LAST_PROJECT_STORAGE_KEY)
  history.replaceState({}, '', '/')
})

beforeAll(async () => {
  await import('../MarkdownImpl')
})

const auth = createMemoryAuthSession(() => {}, 'tok-audit')

function project(over: Partial<Project> = {}): Project {
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

function stage(over: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: 's1',
    pipelineId: 'pipe1',
    ordinal: 0,
    name: '复现确认',
    kind: 'ai',
    agentId: 'coding-assistant',
    model: null,
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

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    identifier: 'OCV5-42',
    projectId: 'p1',
    type: 'bug',
    title: '登录 500',
    body: '复现步骤',
    status: 'running',
    stageId: 's1',
    pipelineId: 'pipe1',
    priority: 'P0',
    severity: 'major',
    labels: [],
    assignee: 'agent:coding-assistant',
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
    approvedBy: null,
    approvedAt: null,
    ...over,
  }
}

const pipeline = {
  id: 'pipe1',
  projectId: 'p1',
  name: '问题单默认线',
  ticketType: 'bug' as const,
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
}

function stubBoard(input: {
  columns?: Array<{ stage: PipelineStage; tickets: Ticket[] }>
  backlog?: Ticket[]
  inbox?: Ticket[]
  list?: Ticket[]
} = {}) {
  const columns = input.columns ?? [{ stage: stage(), tickets: [] }]
  const backlog = input.backlog ?? []
  const inbox = input.inbox ?? []
  const listProjects = vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue([project()])
  const listAgents = vi
    .spyOn(taskboardApi, 'listAgents')
    .mockResolvedValue([{ id: 'coding-assistant', name: '编码助手' }])
  const listTickets = vi.spyOn(taskboardApi, 'listTickets').mockImplementation(async (_a, q) => {
    if (q?.status === 'backlog') return { items: backlog, total: backlog.length }
    const items = input.list ?? [...backlog, ...inbox, ...columns.flatMap((c) => c.tickets)]
    return { items, total: items.length }
  })
  const getProjectBoard = vi.spyOn(taskboardApi, 'getProjectBoard').mockResolvedValue({
    project: project(),
    pipeline,
    ticketType: 'bug',
    columns,
    inbox,
    backlog: { tickets: backlog },
  })
  return { listProjects, listAgents, listTickets, getProjectBoard }
}

function renderBoard(over: Partial<ComponentProps<typeof TaskboardView>> = {}) {
  history.replaceState({}, '', '/board?project=chat-project-p1')
  return render(
    <ProjectScopeProvider
      auth={auth}
      chatProjects={[{ id: 'chat-project-p1', name: 'V5 会话', boardProjectId: 'p1' }]}
      userId="audit-fixes"
    >
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
      </ToastProvider>
    </ProjectScopeProvider>,
  )
}

async function openConfigMenu() {
  const trigger = await screen.findByTestId('taskboard-config-menu')
  trigger.focus()
  await act(async () => {
    fireEvent.keyDown(trigger, { key: 'Enter' })
  })
}

function mockDrawerApis(t: Ticket) {
  vi.spyOn(taskboardApi, 'getTicketDetail').mockResolvedValue({
    ticket: t,
    pipeline,
    stage: stage(),
  })
  vi.spyOn(taskboardApi, 'listRuns').mockResolvedValue({ items: [], total: 0 })
  vi.spyOn(taskboardApi, 'listTimeline').mockResolvedValue([])
}

function wrap(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  )
}

describe('T-01 首屏一次加载即拿到 projects / agents', () => {
  test('锁定项目后 listProjects 只被 Provider + hook 各调一次、看板恰一次；无需等对账即有「管理项目」与执行者筛选', async () => {
    const { listProjects, listAgents, getProjectBoard } = stubBoard({
      columns: [{ stage: stage(), tickets: [ticket()] }],
    })
    renderBoard({ view: 'list' })
    expect(await screen.findByText('登录 500')).toBeInTheDocument()
    await waitFor(() => {
      expect(getProjectBoard).toHaveBeenCalledTimes(1)
    })
    // Provider 拉一次工作项目列表,hook.loadInitial 拉一次;以前 selectProject 抢跑会多出第三次。
    expect(listProjects).toHaveBeenCalledTimes(2)
    expect(listAgents).toHaveBeenCalledTimes(1)
    // agents 没有被抢跑丢掉:执行者筛选里有具名 agent(jsdom 是窄屏,先展开筛选面板)。
    fireEvent.click(screen.getByRole('button', { name: /^筛选/ }))
    const assignee = screen.getByLabelText('按执行者筛选') as HTMLSelectElement
    expect([...assignee.options].map((o) => o.value)).toContain('agent:coding-assistant')
    // projects 没有被丢掉:「管理项目」入口第一屏就在(以前要等 60s 对账)。
    await openConfigMenu()
    expect(await screen.findByTestId('project-edit-open')).toBeInTheDocument()
  })
})

describe('T-03 看板接口失败落到错误态并可重试', () => {
  test('getProjectBoard 502 → 「任务面板加载失败」+ 重试；重试成功后画出看板', async () => {
    const { getProjectBoard } = stubBoard({ columns: [{ stage: stage(), tickets: [ticket()] }] })
    getProjectBoard.mockRejectedValueOnce(new Error('网关 502：上游任务服务暂时不可用'))
    renderBoard()
    expect(await screen.findByText('任务面板加载失败')).toBeInTheDocument()
    expect(screen.getByText('网关 502：上游任务服务暂时不可用')).toBeInTheDocument()
    expect(screen.queryByText(/还没有.*流水线/)).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
    })
    expect(await screen.findByText('登录 500')).toBeInTheDocument()
    expect(getProjectBoard).toHaveBeenCalledTimes(2)
  })
})

describe('T-04 默认「在途」筛选可见、可回到', () => {
  test('默认状态显示「在途（默认）」且不计入筛选数；选「全部」后计 1 个筛选，清除回到在途', () => {
    const onQueryChange = vi.fn()
    const { rerender } = wrap(
      <TicketListView
        tickets={[ticket()]}
        query={{ status: ACTIVE_LIST_STATUSES }}
        onQueryChange={onQueryChange}
      />,
    )
    // jsdom 是窄屏:先展开筛选面板。
    fireEvent.click(screen.getByRole('button', { name: '筛选' }))
    const status = screen.getByLabelText('按状态筛选') as HTMLSelectElement
    expect(status).toHaveDisplayValue('在途（默认）')
    expect(screen.queryByRole('button', { name: '清除筛选' })).not.toBeInTheDocument()
    expect(countActiveFilters({ status: ACTIVE_LIST_STATUSES })).toBe(0)

    fireEvent.change(status, { target: { value: '' } })
    expect(onQueryChange).toHaveBeenLastCalledWith({ status: undefined })

    rerender(
      <ToastProvider>
        <TooltipProvider>
          <TicketListView tickets={[ticket()]} query={{}} onQueryChange={onQueryChange} />
        </TooltipProvider>
      </ToastProvider>,
    )
    expect(countActiveFilters({})).toBe(1)
    expect(screen.getByLabelText('按状态筛选')).toHaveDisplayValue('全部状态（含已完成 / 已取消）')
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(onQueryChange).toHaveBeenLastCalledWith({ status: ACTIVE_LIST_STATUSES })
  })
})

describe('T-13 搜索输入 debounce', () => {
  test('连输 3 个字符只发一次请求，且带最终值', () => {
    vi.useFakeTimers()
    const onQueryChange = vi.fn()
    wrap(
      <TicketListView
        tickets={[ticket()]}
        query={{ status: ACTIVE_LIST_STATUSES }}
        onQueryChange={onQueryChange}
      />,
    )
    const search = screen.getByLabelText('搜索单据') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'a' } })
    fireEvent.change(search, { target: { value: 'ab' } })
    fireEvent.change(search, { target: { value: 'abc' } })
    expect(search.value).toBe('abc')
    expect(onQueryChange).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(LIST_QUERY_DEBOUNCE_MS + 10)
    })
    expect(onQueryChange).toHaveBeenCalledTimes(1)
    expect(onQueryChange).toHaveBeenCalledWith({ status: ACTIVE_LIST_STATUSES, q: 'abc' })
  })

  test('中文输入法组合期间不发，compositionend 后才发', () => {
    vi.useFakeTimers()
    const onQueryChange = vi.fn()
    wrap(
      <TicketListView
        tickets={[ticket()]}
        query={{ status: ACTIVE_LIST_STATUSES }}
        onQueryChange={onQueryChange}
      />,
    )
    const search = screen.getByLabelText('搜索单据')
    fireEvent.compositionStart(search)
    fireEvent.change(search, { target: { value: 'deng' } })
    act(() => {
      vi.advanceTimersByTime(LIST_QUERY_DEBOUNCE_MS * 3)
    })
    expect(onQueryChange).not.toHaveBeenCalled()
    fireEvent.change(search, { target: { value: '登录' } })
    fireEvent.compositionEnd(search)
    act(() => {
      vi.advanceTimersByTime(LIST_QUERY_DEBOUNCE_MS + 10)
    })
    expect(onQueryChange).toHaveBeenCalledTimes(1)
    expect(onQueryChange).toHaveBeenCalledWith({ status: ACTIVE_LIST_STATUSES, q: '登录' })
  })
})

describe('T-16 空态给出下一步', () => {
  test('有流水线、零单据 → 「还没有单据」+ 新建第一条单据（打开新建表单）', async () => {
    stubBoard({ columns: [{ stage: stage(), tickets: [] }] })
    renderBoard()
    expect(await screen.findByText('还没有单据')).toBeInTheDocument()
    expect(screen.queryByTestId('taskboard-column')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('board-empty-create'))
    expect(await screen.findByTestId('ticket-create-form')).toBeInTheDocument()
  })

  test('没有流水线 → 说清「这个项目还没有问题单流水线」并能直接去配置 / 套用模板', async () => {
    stubBoard({ columns: [] })
    vi.spyOn(taskboardApi, 'listPipelines').mockResolvedValue([])
    vi.spyOn(taskboardApi, 'listTemplates').mockResolvedValue([])
    vi.spyOn(api, 'getPublicModels').mockResolvedValue({ models: [], lockedModels: [] })
    renderBoard()
    expect(await screen.findByText('这个项目还没有问题单流水线')).toBeInTheDocument()
    expect(screen.queryByText('还没有流水线列')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('board-empty-configure'))
    expect(await screen.findByTestId('stage-settings')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('stage-settings-close'))
    await waitFor(() => expect(screen.queryByTestId('stage-settings')).not.toBeInTheDocument())
    fireEvent.click(screen.getByTestId('board-empty-templates'))
    expect(await screen.findByTestId('template-library')).toBeInTheDocument()
  })

  test('列表默认视图为空 → 「没有在途的单据」而不是「没有符合筛选的单据」', () => {
    const onCreate = vi.fn()
    wrap(
      <TicketListView
        tickets={[]}
        query={{ status: ACTIVE_LIST_STATUSES }}
        onQueryChange={() => {}}
        onCreateTicket={onCreate}
      />,
    )
    expect(screen.getByText('没有在途的单据')).toBeInTheDocument()
    expect(screen.queryByText('没有符合筛选的单据')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('list-empty-create'))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  test('带筛选为空 → 「没有符合筛选的单据」+ 一键清除', () => {
    const onQueryChange = vi.fn()
    wrap(
      <TicketListView
        tickets={[]}
        query={{ status: ACTIVE_LIST_STATUSES, type: 'bug' }}
        onQueryChange={onQueryChange}
      />,
    )
    expect(screen.getByText('没有符合筛选的单据')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '清除筛选' })[0])
    expect(onQueryChange).toHaveBeenCalledWith({ status: ACTIVE_LIST_STATUSES })
  })
})

describe('T-05 / T-06 / T-07 / T-30 单据抽屉', () => {
  test('抽屉常驻关闭按钮；移动端也平铺全部动作，「取消单据」「标记受阻」不再叫「取消」「受阻」', async () => {
    const running = ticket({ allowedMoves: [] })
    stubBoard({ columns: [{ stage: stage(), tickets: [running] }] })
    mockDrawerApis(running)
    const onOpenTicket = vi.fn()
    renderBoard({ ticketId: 'OCV5-42', onOpenTicket })
    const actions = await screen.findByTestId('ticket-actions-full')
    expect(within(actions).getByRole('button', { name: '完成' })).toBeInTheDocument()
    expect(within(actions).getByRole('button', { name: '取消单据' })).toBeInTheDocument()
    expect(within(actions).getByRole('button', { name: '标记受阻' })).toBeInTheDocument()
    expect(within(actions).queryByTestId('ticket-more-actions')).not.toBeInTheDocument()
    expect(within(actions).queryByRole('button', { name: '取消' })).not.toBeInTheDocument()

    // 确认框:[返回] [取消单据],不再是 [取消] [取消单据] 并排。
    fireEvent.click(within(actions).getByRole('button', { name: '取消单据' }))
    const dialog = await screen.findByRole('dialog', { name: '取消单据 OCV5-42？' })
    expect(within(dialog).getByRole('button', { name: '返回' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '取消单据' })).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '返回' }))
    })

    fireEvent.click(screen.getByTestId('ticket-drawer-close'))
    expect(onOpenTicket).toHaveBeenCalledWith(null)
  })

  test('T-19 只有被点的按钮转圈，其余禁用', async () => {
    const running = ticket({
      allowedMoves: [
        {
          toStageId: null,
          action: 'return_to_backlog',
          label: '退回积压',
          requiresReason: false,
          requiresConfirm: false,
        },
      ],
    })
    stubBoard({ columns: [{ stage: stage(), tickets: [running] }] })
    mockDrawerApis(running)
    vi.spyOn(taskboardApi, 'moveTicket').mockImplementation(() => new Promise(() => {}))
    renderBoard({ ticketId: 'OCV5-42' })
    const actions = await screen.findByTestId('ticket-actions-full')
    // 抽屉里「移动到…」是带文字的按钮(审计 T-06),键盘打开菜单选一项。
    const moveMenu = within(actions).getByTestId('ticket-move-menu')
    moveMenu.focus()
    await act(async () => {
      fireEvent.keyDown(moveMenu, { key: 'Enter' })
    })
    const option = await screen.findByRole('menuitem', { name: /退回积压/ })
    option.focus()
    await act(async () => {
      fireEvent.keyDown(option, { key: 'Enter' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('ticket-move-menu')).toHaveAttribute('aria-busy', 'true')
    })
    // 以前所有按钮一起转圈;现在其余只是禁用。
    expect(screen.getByTestId('ticket-done')).toBeDisabled()
    expect(screen.getByTestId('ticket-done')).not.toHaveAttribute('aria-busy')
    expect(screen.getByTestId('ticket-cancel')).toBeDisabled()
    expect(screen.getByTestId('ticket-cancel')).not.toHaveAttribute('aria-busy')
  })

  test('T-30 深链到不在已加载列表里的单，详情到位后也有状态操作', async () => {
    stubBoard({ columns: [{ stage: stage(), tickets: [ticket()] }] })
    const hidden = ticket({ id: 't-99', identifier: 'OCV5-99', title: '翻页之外的单', status: 'ready' })
    mockDrawerApis(hidden)
    renderBoard({ ticketId: 'OCV5-99' })
    expect(await screen.findByRole('heading', { name: '翻页之外的单' })).toBeInTheDocument()
    const actions = await screen.findByTestId('ticket-actions-full')
    expect(within(actions).getByRole('button', { name: '完成' })).toBeInTheDocument()
    expect(within(actions).getByRole('button', { name: '标记受阻' })).toBeInTheDocument()
  })

  test('T-27 乐观评论显示「我 · 人」与发送中，而不是 default', async () => {
    const t = ticket()
    mockDrawerApis(t)
    let resolveComment: (v: { ok: true; comment: TicketComment }) => void = () => {}
    vi.spyOn(taskboardApi, 'comment').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveComment = resolve
        }),
    )
    wrap(
      <TicketDrawer
        auth={auth}
        ticket={t}
        ticketRef={t.identifier}
        open
        desktop={false}
        agents={[]}
        stages={[stage()]}
        sessionIds={[]}
        onClose={() => {}}
        onReconcile={() => {}}
        onTicketUpdated={() => {}}
      />,
    )
    await screen.findByTestId('ticket-drawer-comment')
    fireEvent.change(screen.getByTestId('ticket-drawer-comment'), { target: { value: '先看看' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('ticket-drawer-comment-submit'))
    })
    const pendingItem = screen.getByTestId('ticket-timeline-item')
    expect(pendingItem).toHaveAttribute('data-pending', 'true')
    expect(pendingItem).toHaveTextContent('我 · 人')
    expect(pendingItem).toHaveTextContent('发送中')
    expect(pendingItem).not.toHaveTextContent('default')
    await act(async () => {
      resolveComment({
        ok: true,
        comment: {
          id: 'c-1',
          ticketId: t.id,
          authorKind: 'human',
          author: 'user:alice',
          body: '先看看',
          runId: null,
          createdAt: Date.now(),
        },
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('ticket-timeline-item')).toHaveTextContent('alice · 人')
    })
  })
})

describe('T-08 状态术语统一', () => {
  test('backlog / waiting_human 以列头文案为唯一权威，终态用「已完成 / 已取消」', () => {
    expect(TICKET_STATUS_LABEL.backlog).toBe('积压')
    expect(TICKET_STATUS_LABEL.waiting_human).toBe('待确认')
    expect(TICKET_STATUS_LABEL.done).toBe('已完成')
    expect(TICKET_STATUS_LABEL.canceled).toBe('已取消')
    wrap(<TicketCard ticket={ticket({ status: 'backlog' })} />)
    expect(screen.getByText('积压')).toBeInTheDocument()
    expect(screen.queryByText('待立项')).not.toBeInTheDocument()
  })
})

describe('T-15 卡片语义', () => {
  test('容器不再是 role=button；标题是真按钮承载打开；操作按钮不嵌在按钮里', () => {
    const onOpen = vi.fn()
    wrap(
      <TicketCard
        ticket={ticket()}
        onOpen={onOpen}
        actions={
          <button type="button" data-testid="fake-action">
            批准
          </button>
        }
      />,
    )
    const card = screen.getByTestId('ticket-card')
    expect(card).not.toHaveAttribute('role')
    expect(card).not.toHaveAttribute('tabindex')
    const title = screen.getByRole('button', { name: '登录 500' })
    expect(title).toHaveAttribute('data-drag-through', 'true')
    fireEvent.click(title)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('fake-action').closest('[role="button"]')).toBeNull()
    // 卡片态的执行者不再被截成「codin…」:完整文本在 DOM 里,带图标不带「批准人 」前缀。
    expect(screen.getByTestId('ticket-assignee')).toHaveTextContent('coding-assistant')
  })

  test('紧凑态隐藏状态徽章（列名已表达），受阻仍保留', () => {
    wrap(<TicketCard ticket={ticket({ status: 'ready' })} compact hideStatus />)
    expect(screen.queryByText('待执行')).not.toBeInTheDocument()
    cleanup()
    wrap(<TicketCard ticket={ticket({ status: 'blocked', blockedReason: '等文案' })} compact hideStatus />)
    expect(screen.getAllByText('受阻').length).toBeGreaterThan(0)
  })
})

describe('T-17 a11y 细节', () => {
  test('分区 Tabs 只给已挂载面板落 aria-controls，且面板真的在 DOM 里', async () => {
    stubBoard()
    renderBoard()
    const tab = await screen.findByRole('tab', { name: '任务' })
    expect(tab).toHaveAttribute('aria-controls', 'taskboard-section-panel-tasks')
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAttribute('id', 'taskboard-section-panel-tasks')
    expect(panel).toHaveAttribute('aria-labelledby', 'taskboard-section-tab-tasks')
    expect(screen.getByRole('tab', { name: '成本' })).not.toHaveAttribute('aria-controls')
    expect(screen.getByRole('tab', { name: '周报' })).not.toHaveAttribute('aria-controls')
  })

  test('移动端「筛选」按钮收起时不落 aria-controls；展开后才指向面板', () => {
    wrap(
      <TicketListView
        tickets={[ticket()]}
        query={{ status: ACTIVE_LIST_STATUSES }}
        onQueryChange={() => {}}
      />,
    )
    const btn = screen.getByRole('button', { name: '筛选' })
    expect(btn).not.toHaveAttribute('aria-controls')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-controls', 'ticket-list-advanced-filters')
    expect(document.getElementById('ticket-list-advanced-filters')).not.toBeNull()
  })
})

describe('T-22 护栏设置', () => {
  const settings = {
    maxConcurrentRuns: 2,
    maxRunsPerDay: 200,
    maxCostPerDayUsd: null,
    quietHoursStart: 23,
    quietHoursEnd: 8,
    circuitBreakerThreshold: 3,
    maxStageLoops: 5,
    maxRunsPerTick: 2,
    patrolPaused: false,
    usage: { runsToday: 3, costTodayUsd: 0, activeRuns: 1 },
  }

  test('清空数字输入不变 0；保存时校验；三个原本缺失的字段有输入项；静默开始=结束有提示', async () => {
    vi.spyOn(taskboardApi, 'getSettings').mockResolvedValue(settings)
    const patch = vi.spyOn(taskboardApi, 'patchSettings').mockResolvedValue({ ok: true, ...settings })
    wrap(<BoardSettingsPanel auth={auth} />)
    fireEvent.click(screen.getByTestId('board-settings-open'))
    const concurrent = (await screen.findByLabelText('同时执行上限')) as HTMLInputElement
    fireEvent.change(concurrent, { target: { value: '' } })
    expect(concurrent.value).toBe('')
    await act(async () => {
      fireEvent.click(screen.getByTestId('board-settings-save'))
    })
    expect(await screen.findByText('同时执行上限至少为 1')).toBeInTheDocument()
    expect(patch).not.toHaveBeenCalled()

    expect(screen.getByLabelText('连续失败熔断')).toHaveValue(3)
    expect(screen.getByLabelText('同一阶段最多打回次数')).toHaveValue(5)
    expect(screen.getByLabelText('每轮巡检最多启动')).toHaveValue(2)

    fireEvent.change(concurrent, { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('连续失败熔断'), { target: { value: '6' } })
    fireEvent.change(screen.getByLabelText('静默结束'), { target: { value: '23' } })
    expect(screen.getByTestId('board-settings-quiet-hint')).toHaveTextContent('不设静默时段')
    await act(async () => {
      fireEvent.click(screen.getByTestId('board-settings-save'))
    })
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith(
        auth,
        expect.objectContaining({ maxConcurrentRuns: 4, circuitBreakerThreshold: 6, quietHoursEnd: 23 }),
      )
    })
    // 用量块拆成三行,不再一句话塞五个数字。
    const usage = screen.getByTestId('board-settings-usage')
    expect(usage).toHaveTextContent('今天已执行')
    expect(usage).toHaveTextContent('正在执行')
  })
})

describe('T-23 危险操作', () => {
  test('废弃项目记忆需二次确认；归档移到底部「危险操作」区', async () => {
    const p = project({ workspaceSpec: { kind: 'isolated' } })
    vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue([])
    vi.spyOn(taskboardApi, 'getProjectContext').mockResolvedValue({ version: 1, workspaceSpec: { kind: 'isolated' } })
    vi.spyOn(taskboardApi, 'listProjectMemories').mockResolvedValue({
      projectId: p.id,
      official: [{ projectId: p.id, slug: 'coding-conventions', contentSha256: 'sha', version: 2 }],
      candidates: [],
    })
    const deprecate = vi.spyOn(taskboardApi, 'deprecateProjectMemory').mockResolvedValue({
      ok: true,
      official: { projectId: p.id, slug: 'coding-conventions', contentSha256: 'sha', version: 3, deprecated: true },
    })
    wrap(
      <ProjectSettings
        auth={auth}
        current={p}
        onCreate={async () => null}
        onPatch={async () => null}
        onArchive={async () => false}
        onUnarchive={async () => false}
      />,
    )
    fireEvent.click(screen.getByTestId('project-edit-open'))
    const deprecateBtn = await screen.findByTestId('project-memory-deprecate-coding-conventions')
    await act(async () => {
      fireEvent.click(deprecateBtn)
    })
    expect(await screen.findByText('废弃记忆「coding-conventions」？')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '返回' }))
    })
    expect(deprecate).not.toHaveBeenCalled()
    const danger = screen.getByTestId('project-danger-zone')
    expect(within(danger).getByTestId('project-archive')).toHaveTextContent('归档项目')
    // 「保存」不再和归档并排。
    expect(screen.getByTestId('project-edit-save').parentElement).not.toContainElement(
      screen.getByTestId('project-archive'),
    )
    // T-14:开发者术语不再出现。
    expect(screen.queryByText(/OPENCLAUDE_DEFAULT_WORKSPACE|memory\/\*\.md|version|JSON/)).toBeNull()
    fireEvent.click(screen.getByTestId('project-edit-close'))
    await waitFor(() => expect(screen.queryByTestId('project-edit')).not.toBeInTheDocument())
  })

  test('模板库抽屉有关闭按钮', async () => {
    vi.spyOn(taskboardApi, 'listTemplates').mockResolvedValue([])
    wrap(<TemplateLibrary auth={auth} projectId="p1" />)
    fireEvent.click(screen.getByTestId('template-library-open'))
    expect(await screen.findByTestId('template-library')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('template-library-close'))
    await waitFor(() => expect(screen.queryByTestId('template-library')).not.toBeInTheDocument())
  })
})

describe('T-14 / T-21 成本与周报', () => {
  const report: WeeklyReport = {
    period: {
      week: '2099-W01',
      fromYmd: '2098-12-29',
      toYmd: '2099-01-04',
      fromMs: 1,
      toMs: 2,
      timeZone: 'Asia/Shanghai',
    },
    projectId: 'p1',
    flow: { created: 0, completed: 0, canceled: 0, waitingHuman: 0, blockedNow: 0, statusTransitions: [] },
    stages: [],
    cost: {
      runCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      priced: { runCount: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
      unpriced: { runCount: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
      unknownRunCount: 0,
      coverage: 'full',
    },
    blocked: [],
    failedRuns: [],
  }

  function renderScoped(node: ReactNode) {
    history.replaceState({}, '', '/board?project=chat-project-p1')
    return render(
      <ProjectScopeProvider
        auth={auth}
        chatProjects={[{ id: 'chat-project-p1', name: 'V5 会话', boardProjectId: 'p1' }]}
        userId="audit-scope"
      >
        <ToastProvider>
          <TooltipProvider>{node}</TooltipProvider>
        </ToastProvider>
      </ProjectScopeProvider>,
    )
  }

  test('周报覆盖到今天时「下一周」禁用；工具栏不再有第二个项目选择器', async () => {
    vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue([project()])
    vi.spyOn(taskboardApi, 'getWeeklyReport').mockResolvedValue(report)
    renderScoped(<WeeklyReportView auth={auth} />)
    await waitFor(() => expect(screen.getByTestId('weekly-period')).toHaveTextContent('2099-W01'))
    expect(screen.getByTestId('weekly-next')).toBeDisabled()
    expect(screen.getByTestId('weekly-prev')).toBeEnabled()
    expect(screen.queryByTestId('project-scope-select-work')).not.toBeInTheDocument()
    expect(screen.getByTestId('weekly-report').textContent).not.toMatch(/usage_records/)
  })

  test('成本页首句是用户语言；起止倒置时提示并禁用刷新', async () => {
    vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue([project()])
    const getCost = vi.spyOn(taskboardApi, 'getCostStats').mockResolvedValue({
      from: '2026-09-01',
      to: '2026-09-07',
      timeZone: 'Asia/Shanghai',
      groupBy: 'day',
      totals: report.cost,
      buckets: [],
    })
    renderScoped(<CostStatsView auth={auth} />)
    await waitFor(() => expect(getCost).toHaveBeenCalled())
    const root = screen.getByTestId('cost-stats')
    expect(root.textContent).not.toMatch(/tb_project|usage_records/)
    expect(screen.queryByTestId('project-scope-select-work')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('成本起始日'), { target: { value: '2099-01-02' } })
    fireEvent.change(screen.getByLabelText('成本结束日'), { target: { value: '2099-01-01' } })
    expect(await screen.findByText('起始日不能晚于结束日')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
  })
})
