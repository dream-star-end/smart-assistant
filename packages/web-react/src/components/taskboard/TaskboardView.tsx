import {
  Archive,
  Kanban,
  List,
  Menu,
  MoreHorizontal,
  PanelLeft,
  PenSquare,
  Plus,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { BoardViewParam } from '../../hooks/useAppRoute'
import { useMdViewport } from '../../hooks/useMdViewport'
import {
  TICKET_TYPES,
  TICKET_TYPE_LABEL,
  type Ticket,
  type TicketType,
  boardErrorWhy,
  taskboardApi,
} from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  ListSkeleton,
  Select,
  Sheet,
  Tabs,
  useConfirm,
  usePrompt,
  useToast,
} from '../ui'
import { BoardColumns } from './BoardColumns'
import { BoardSettingsPanel } from './BoardSettingsPanel'
import { CostStatsView } from './CostStatsView'
import { ProjectSettings } from './ProjectSettings'
import { StageSettings } from './StageSettings'
import { TemplateLibrary } from './TemplateLibrary'
import { TicketDrawer } from './TicketDrawer'
import { TicketListView } from './TicketListView'
import { WeeklyReportView } from './WeeklyReportView'
import {
  dropIdForMove,
  formatBlockersMessage,
  formatConfirmSkipMessage,
  formatMoveSuccess,
  formatNoIntentMessage,
  formatRunningRunMessage,
  moveOptionLabel,
} from './ticketMove'
import { useTaskboard } from './useTaskboard'

export function TaskboardView({
  auth,
  view,
  ticketId,
  ticketType: ticketTypeFromUrl = null,
  onViewChange,
  onOpenTicket,
  onTicketTypeChange,
  onOpenMobileNav,
  onOpenSession,
  sessionIds = [],
  sidebarCollapsed,
  onExpandSidebar,
}: {
  auth: AuthSession
  view: BoardViewParam
  ticketId: string | null
  ticketType?: TicketType | null
  onViewChange: (view: BoardViewParam) => void
  onOpenTicket: (identifier: string | null) => void
  onTicketTypeChange?: (type: TicketType | null) => void
  onOpenMobileNav: () => void
  onOpenSession?: (sessionId: string) => void
  sessionIds?: readonly string[]
  sidebarCollapsed?: boolean
  onExpandSidebar?: () => void
}) {
  const board = useTaskboard(auth, true, ticketTypeFromUrl)
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const [promptText, promptEl] = usePrompt()
  const desktop = useMdViewport()
  const [creating, setCreating] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftType, setDraftType] = useState<TicketType>('bug')
  const [draftReady, setDraftReady] = useState(false)
  const [reviseOpen, setReviseOpen] = useState(false)
  const [backlogTypeFilter, setBacklogTypeFilter] = useState<TicketType | ''>('')
  const [lastTaskView, setLastTaskView] = useState<'board' | 'list'>(
    view === 'list' ? 'list' : 'board',
  )

  useEffect(() => {
    if (view === 'board' || view === 'list') setLastTaskView(view)
  }, [view])

  const selected = useMemo(() => {
    if (!ticketId) return null
    const match = (t: Ticket) => t.identifier === ticketId || t.id === ticketId
    const fromList = board.tickets?.find(match)
    if (fromList) return fromList
    const fromBacklogTab = board.backlogTickets.find(match)
    if (fromBacklogTab) return fromBacklogTab
    const fromBacklog = board.board?.backlog?.tickets.find(match)
    if (fromBacklog) return fromBacklog
    return board.board?.columns.flatMap((c) => c.tickets).find(match) ?? null
  }, [board.backlogTickets, board.board, board.tickets, ticketId])

  const openTicket = (ticket: Ticket) => onOpenTicket(ticket.identifier)

  const stageNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const col of board.board?.columns ?? []) map.set(col.stage.id, col.stage.name)
    return map
  }, [board.board])

  const askReason = async (title: string, confirmText: string, body?: string) => {
    const reason = await promptText({
      title,
      body,
      confirmText,
      placeholder: '请填写理由',
      maxLength: 500,
    })
    return reason
  }

  const runMove = async (
    ticket: Ticket,
    toStageId: string | null,
    extras: { reason?: string; confirmSkippedStages?: boolean; cancelRunningRun?: boolean } = {},
  ) => {
    const outcome = await board.moveTicket(ticket, { toStageId, ...extras })
    if (outcome.ok) {
      const destName =
        outcome.result.move.toStageId === null
          ? null
          : stageNameById.get(outcome.result.move.toStageId)
      toast(formatMoveSuccess(outcome.result.move, destName), 'success')
      return true
    }
    const code = outcome.code
    const detail = outcome.detail ?? {}
    if (code === 'confirm_required') {
      const skippedStages = Array.isArray(detail.skippedStages)
        ? (detail.skippedStages as Array<{ name: string }>)
        : []
      const abandonedStage =
        detail.abandonedStage && typeof detail.abandonedStage === 'object'
          ? (detail.abandonedStage as { name: string })
          : null
      const copy = formatConfirmSkipMessage({ skippedStages, abandonedStage })
      const ok = await confirm({
        title: copy.title,
        body: copy.body,
        confirmText: '确认移动',
      })
      if (ok) {
        return runMove(ticket, toStageId, { ...extras, confirmSkippedStages: true })
      }
      return false
    }
    if (code === 'reason_required') {
      const reason = await askReason(
        `打回 ${ticket.identifier}？`,
        '打回',
        '这条理由会作为评论交给目标站的 agent。',
      )
      if (reason) return runMove(ticket, toStageId, { ...extras, reason })
      return false
    }
    if (code === 'running_run_active') {
      const runId = typeof detail.runId === 'string' ? detail.runId : null
      const ok = await confirm({
        title: '单据正在执行',
        body: formatRunningRunMessage(runId),
        confirmText: '取消并移动',
        danger: true,
      })
      if (ok) return runMove(ticket, toStageId, { ...extras, cancelRunningRun: true })
      return false
    }
    if (code === 'version_conflict') {
      toast('单据已被改动，请刷新看板后重试', 'error')
      return false
    }
    if (code === 'blocked_dependency') {
      const blockers = Array.isArray(detail.blockers)
        ? (detail.blockers as Array<{ identifier?: string; title?: string }>)
        : []
      toast(formatBlockersMessage(blockers), 'error')
      return false
    }
    if (code === 'stage_pipeline_mismatch' || code === 'no_interpretable_intent') {
      toast(formatNoIntentMessage(boardErrorWhy(outcome.error) ?? (detail.why as string)), 'error')
      return false
    }
    if (code === 'forbidden') {
      toast('当前身份无权执行此操作', 'error')
      return false
    }
    toast(outcome.error instanceof Error ? outcome.error.message : '移动单据失败', 'error')
    return false
  }

  const promoteTicket = async (ticket: Ticket) => {
    const fromMoves = ticket.allowedMoves?.find((m) => m.action === 'promote')?.toStageId
    if (fromMoves) {
      await runMove(ticket, fromMoves)
      return
    }
    if (ticket.type === board.board?.ticketType) {
      const first = board.board.columns[0]?.stage.id
      if (first) {
        await runMove(ticket, first)
        return
      }
    }
    try {
      const snap = await taskboardApi.getProjectBoard(auth, ticket.projectId, ticket.type)
      const first = snap.columns[0]?.stage.id
      if (!first) {
        toast('这条流水线还没有阶段，无法开工', 'error')
        return
      }
      await runMove(ticket, first)
    } catch {
      toast('无法解析开工目标站', 'error')
    }
  }

  type ActionTone = 'secondary' | 'danger' | 'ghost'
  type TicketAction = {
    label: string
    testId: string
    onClick: () => void
    variant: ActionTone
    kind: 'primary' | 'secondary' | 'destructive'
  }

  const collectActions = (ticket: Ticket): TicketAction[] => {
    const items: TicketAction[] = []
    if (ticket.status === 'backlog') {
      items.push({
        label: '批准开工',
        testId: 'ticket-ready',
        onClick: () => void promoteTicket(ticket),
        variant: 'secondary',
        kind: 'primary',
      })
    }
    if (ticket.status === 'waiting_human') {
      items.push(
        {
          label: '通过',
          testId: 'inbox-approve',
          onClick: () => void board.runAction(ticket, { kind: 'approve' }),
          variant: 'secondary',
          kind: 'primary',
        },
        {
          label: '打回',
          testId: 'inbox-reject',
          onClick: () => {
            void (async () => {
              const reason = await askReason(`打回 ${ticket.identifier}？`, '打回')
              if (reason) void board.runAction(ticket, { kind: 'reject', reason })
            })()
          },
          variant: 'danger',
          kind: 'destructive',
        },
        {
          label: '改需求',
          testId: 'inbox-revise',
          onClick: () => {
            setReviseOpen(true)
            onOpenTicket(ticket.identifier)
          },
          variant: 'ghost',
          kind: 'secondary',
        },
      )
    }
    if (ticket.status !== 'done' && ticket.status !== 'canceled' && ticket.status !== 'blocked') {
      items.push({
        label: '受阻',
        testId: 'ticket-block',
        onClick: () => {
          void (async () => {
            const reason = await askReason(`将 ${ticket.identifier} 标为受阻？`, '标记受阻')
            if (reason) void board.runAction(ticket, { kind: 'block', reason })
          })()
        },
        variant: 'ghost',
        kind: 'secondary',
      })
    }
    if (ticket.status !== 'done' && ticket.status !== 'canceled') {
      items.push(
        {
          label: '完成',
          testId: 'ticket-done',
          onClick: () => {
            void (async () => {
              const ok = await confirm({
                title: `完成 ${ticket.identifier}？`,
                body: '完成后不再参与巡检。',
                confirmText: '完成',
              })
              if (ok) void board.runAction(ticket, { kind: 'done' })
            })()
          },
          variant: 'secondary',
          kind: 'secondary',
        },
        {
          label: '取消',
          testId: 'ticket-cancel',
          onClick: () => {
            void (async () => {
              const ok = await confirm({
                title: `取消 ${ticket.identifier}？`,
                body: '取消后单据进入终态。',
                confirmText: '取消单据',
                danger: true,
              })
              if (ok) void board.runAction(ticket, { kind: 'cancel' })
            })()
          },
          variant: 'danger',
          kind: 'destructive',
        },
      )
    }
    return items
  }

  const renderActions = (ticket: Ticket, layout: 'board' | 'full' = 'full') => {
    const busy = board.isPending(ticket.id)
    const items = collectActions(ticket)
    const moves = ticket.allowedMoves ?? []
    const btn = (action: TicketAction) => (
      <Button
        key={action.testId}
        type="button"
        size="sm"
        variant={action.variant}
        loading={busy}
        data-testid={action.testId}
        aria-label={action.label}
        onClick={action.onClick}
      >
        {action.label}
      </Button>
    )
    if (layout !== 'board') {
      if (!items.length) return null
      return <div className="flex flex-wrap gap-1">{items.map(btn)}</div>
    }
    const primary = items.find((a) => a.kind === 'primary')
    const menuItems = items.filter((a) => a !== primary)
    const showMenu = menuItems.length > 0 || moves.length > 0
    if (!primary && !showMenu) return null
    return (
      <div className="flex shrink-0 items-center gap-0.5">
        {primary ? btn(primary) : null}
        {showMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                type="button"
                size="sm"
                shape="square"
                variant="ghost"
                aria-label="更多操作"
                data-testid="ticket-more-actions"
                disabled={busy}
              >
                <MoreHorizontal size={14} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              {moves.length > 0 && (
                <>
                  <DropdownMenuLabel>移动到…</DropdownMenuLabel>
                  {moves.map((m) => (
                    <DropdownMenuItem
                      key={`${m.action}:${dropIdForMove(m.toStageId)}`}
                      data-testid="ticket-move-option"
                      disabled={busy}
                      onSelect={() => void runMove(ticket, m.toStageId)}
                    >
                      {moveOptionLabel(m, stageNameById)}
                    </DropdownMenuItem>
                  ))}
                  {menuItems.length > 0 && <DropdownMenuSeparator />}
                </>
              )}
              {menuItems.map((action) => (
                <DropdownMenuItem
                  key={action.testId}
                  data-testid={action.testId}
                  destructive={action.variant === 'danger'}
                  disabled={busy}
                  onSelect={() => action.onClick()}
                >
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    )
  }

  const visibleBacklogTickets = useMemo(() => {
    if (!backlogTypeFilter) return board.backlogTickets
    return board.backlogTickets.filter((t) => t.type === backlogTypeFilter)
  }, [backlogTypeFilter, board.backlogTickets])

  const submitCreate = async () => {
    const title = draftTitle.trim()
    if (!title) {
      toast('请填写标题', 'error')
      return
    }
    if (!board.projectId) {
      toast('请先选择项目', 'error')
      return
    }
    const created = await board.createTicket({
      projectId: board.projectId,
      type: draftType,
      title,
      source: 'manual',
      ...(draftReady ? { status: 'ready' as const } : {}),
    })
    if (created) {
      setDraftTitle('')
      setDraftReady(false)
      setCreating(false)
      onOpenTicket(created.identifier)
    }
  }

  const switchTicketType = (type: TicketType) => {
    void board.selectTicketType(type)
    onTicketTypeChange?.(type)
  }

  const shownType = board.board?.ticketType || board.ticketType || ''
  const taskView = view === 'board' || view === 'list' || view === 'inbox' || view === 'backlog'
  const sectionView = taskView ? 'tasks' : view

  const switchSection = (next: string) => {
    onViewChange(next === 'tasks' ? lastTaskView : (next as BoardViewParam))
  }

  const toggleTaskView = () => {
    onViewChange(view === 'board' ? 'list' : 'board')
  }

  const projectLabel = useMemo(() => {
    const current = (board.projects ?? []).find((p) => p.id === board.projectId && !p.archivedAt)
    return current ? `${current.key} ${current.name}` : undefined
  }, [board.projectId, board.projects])

  const renderCreateForm = (mobile: boolean) => (
    <div
      data-testid="ticket-create-form"
      className={
        mobile
          ? 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4'
          : 'mx-4 mb-3 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-3'
      }
    >
      {mobile && (
        <div>
          <h2 className="text-title font-semibold text-fg">新建单据</h2>
          <p className="mt-1 text-caption text-muted">
            先记入积压最稳妥；确定要马上处理时再选直接开工。
          </p>
        </div>
      )}
      <Select
        aria-label="单据类型"
        className={mobile ? 'w-full' : 'w-32'}
        inputSize="sm"
        value={draftType}
        onValueChange={(v) => setDraftType(v as TicketType)}
        options={TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABEL[t] }))}
      />
      <Input
        aria-label="单据标题"
        inputSize="sm"
        className={mobile ? 'w-full' : 'min-w-[12rem] flex-1'}
        placeholder="一句话说明要解决什么"
        value={draftTitle}
        onChange={(e) => setDraftTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submitCreate()
        }}
      />
      <fieldset className="flex flex-col gap-1">
        <legend className="text-caption text-muted">下一步</legend>
        <div className="flex flex-wrap gap-3">
          <label className="inline-flex min-h-9 items-center gap-1.5 text-body text-fg">
            <input
              type="radio"
              name="ticket-create-status"
              value="backlog"
              aria-label="记为积压"
              checked={!draftReady}
              onChange={() => setDraftReady(false)}
            />
            先放积压
          </label>
          <label className="inline-flex min-h-9 items-center gap-1.5 text-body text-fg">
            <input
              type="radio"
              name="ticket-create-status"
              value="ready"
              aria-label="直接开工"
              checked={draftReady}
              onChange={() => setDraftReady(true)}
            />
            直接开工
          </label>
        </div>
        <p className="text-caption text-faint">
          积压里的单 AI 不会处理；直接开工会进入流水线第一站。
        </p>
      </fieldset>
      <div className={mobile ? 'mt-auto flex gap-2' : 'flex gap-2'}>
        <Button
          type="button"
          size="sm"
          aria-label="创建"
          className={mobile ? 'flex-1' : undefined}
          onClick={() => void submitCreate()}
        >
          创建单据
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
          取消
        </Button>
      </div>
    </div>
  )

  return (
    <div data-testid="taskboard-root" className="flex h-full min-h-0 flex-col bg-bg">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 pb-2.5 header-safe-t md:h-14 md:flex-nowrap md:border-b-0">
        <div className="order-1 flex min-w-0 items-center gap-2">
          <IconButton
            data-product-control
            onClick={onOpenMobileNav}
            aria-label="打开菜单"
            shape="square"
            className="md:hidden"
          >
            <Menu size={18} />
          </IconButton>
          {sidebarCollapsed && (
            <IconButton
              data-product-control
              onClick={onExpandSidebar}
              aria-label="展开侧栏"
              shape="square"
              className="hidden md:inline-flex"
            >
              <PanelLeft size={18} />
            </IconButton>
          )}
          <Kanban size={16} className="shrink-0 text-faint" />
          <h1 className="truncate text-title font-semibold">任务面板</h1>
        </div>
        <div
          data-testid="taskboard-responsive-toolbar"
          className="order-3 flex w-full min-w-0 items-center gap-2 md:order-2 md:ml-auto md:w-auto"
        >
          <Select
            aria-label="项目"
            className="min-w-0 flex-1 md:w-56 md:max-w-[16rem] md:flex-none"
            inputSize="sm"
            value={board.projectId ?? ''}
            title={projectLabel}
            onValueChange={(id) => void board.selectProject(id)}
            options={(board.projects ?? [])
              .filter((p) => !p.archivedAt)
              .map((p) => ({ value: p.id, label: `${p.key} ${p.name}` }))}
            placeholder="选择项目"
          />
          <ProjectSettings
            auth={auth}
            current={board.projects?.find((p) => p.id === board.projectId) ?? null}
            onCreate={(input) => board.createProject(input)}
            onPatch={(id, input) => board.patchProject(id, input)}
            onArchive={(id) => board.archiveProject(id)}
            onUnarchive={(id) => board.unarchiveProject(id).then((p) => !!p)}
            compact={!desktop}
          />
          <StageSettings
            auth={auth}
            projectId={board.projectId}
            onChanged={() => void board.reconcile()}
            compact={!desktop}
          />
          <TemplateLibrary
            auth={auth}
            projectId={board.projectId}
            onChanged={() => void board.reconcile()}
            compact={!desktop}
          />
          <BoardSettingsPanel auth={auth} />
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="order-2 ml-auto shrink-0 md:order-3 md:ml-0"
          disabled={!board.projectId}
          aria-expanded={creating}
          onClick={() => setCreating((v) => !v)}
        >
          <Plus size={14} />
          新建单据
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
        <Tabs
          value={sectionView}
          onValueChange={switchSection}
          layout="scroll"
          idBase="taskboard-section"
          aria-label="任务面板功能"
          items={[
            { value: 'tasks', label: '任务' },
            { value: 'cost', label: '成本' },
            { value: 'weekly', label: '周报' },
          ]}
        />
        {taskView && (
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="taskboard-layout-toggle"
              aria-label={view === 'board' ? '切换到列表展示' : '切换到看板展示'}
              title={view === 'board' ? '切换到列表展示' : '切换到看板展示'}
              onClick={toggleTaskView}
            >
              {view === 'board' ? <List size={15} /> : <Kanban size={15} />}
              {view === 'board' ? '列表' : '看板'}
            </Button>
            {view === 'board' && (
              <Select
                aria-label="看板类型"
                className="w-36"
                inputSize="sm"
                value={shownType}
                onValueChange={(v) => switchTicketType(v as TicketType)}
                options={TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABEL[t] }))}
                placeholder="单据类型"
              />
            )}
          </div>
        )}
      </div>

      {creating && desktop && renderCreateForm(false)}

      {board.loading && !board.tickets ? (
        <div className="px-4">
          <ListSkeleton rows={6} variant={view === 'board' ? 'card' : 'row'} />
        </div>
      ) : board.error ? (
        <EmptyState
          icon={Kanban}
          title="任务面板加载失败"
          hint={board.error}
          action={
            <Button type="button" variant="secondary" onClick={() => void board.refresh()}>
              重试
            </Button>
          }
        />
      ) : !board.projectId ? (
        <EmptyState
          icon={Kanban}
          title="还没有项目"
          hint="新建一个项目后即可开始建单。创建时会自动带上四条默认流水线。"
        />
      ) : view === 'cost' ? (
        <CostStatsView
          auth={auth}
          projectId={board.projectId}
          projects={(board.projects ?? []).filter((p) => !p.archivedAt)}
        />
      ) : view === 'weekly' ? (
        <WeeklyReportView
          auth={auth}
          projectId={board.projectId}
          projects={(board.projects ?? []).filter((p) => !p.archivedAt)}
        />
      ) : view === 'board' ? (
        <BoardColumns
          columns={board.board?.columns ?? []}
          backlogTickets={board.board?.backlog?.tickets ?? []}
          ticketTypeLabel={shownType ? TICKET_TYPE_LABEL[shownType] : undefined}
          onOpenTicket={openTicket}
          renderActions={(ticket) => renderActions(ticket, 'board')}
          onMove={(ticket, toStageId) => void runMove(ticket, toStageId)}
        />
      ) : view === 'list' ? (
        <TicketListView
          tickets={board.tickets ?? []}
          query={board.listQuery}
          agents={board.agents}
          onQueryChange={(q) => void board.applyListQuery(q)}
          onOpenTicket={openTicket}
          renderActions={(ticket) => renderActions(ticket, 'board')}
        />
      ) : view === 'backlog' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
            <Select
              aria-label="积压类型"
              className="w-36"
              inputSize="sm"
              value={backlogTypeFilter}
              onValueChange={(v) => setBacklogTypeFilter((v as TicketType) || '')}
              options={[
                { value: '', label: '全部' },
                ...TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABEL[t] })),
              ]}
            />
          </div>
          {visibleBacklogTickets.length === 0 ? (
            <EmptyState
              icon={Archive}
              title={board.backlogTickets.length === 0 ? '积压是空的' : '没有这类积压单'}
              hint={
                board.backlogTickets.length === 0
                  ? '遗留问题可以先记进积压，准备做的时候再批准开工或拖进看板。'
                  : '换一个类型，或选「全部」看看其它积压单。'
              }
            />
          ) : (
            <TicketListView
              tickets={visibleBacklogTickets}
              query={{ status: 'backlog' }}
              agents={board.agents}
              onQueryChange={() => {}}
              onOpenTicket={openTicket}
              renderActions={(ticket) => renderActions(ticket, 'board')}
              hideFilters
            />
          )}
        </div>
      ) : board.inboxTickets.length === 0 ? (
        <EmptyState
          icon={PenSquare}
          title="没有待确认的单据"
          hint="agent 做完并等人拍板的单会出现在这里。"
        />
      ) : (
        <TicketListView
          tickets={board.inboxTickets}
          query={{ status: 'waiting_human' }}
          agents={board.agents}
          onQueryChange={() => {}}
          onOpenTicket={openTicket}
          renderActions={(ticket) => renderActions(ticket, 'board')}
        />
      )}

      {!desktop && (
        <Sheet
          open={creating}
          onOpenChange={(next) => {
            if (!next) setCreating(false)
          }}
          side="bottom"
          srTitle="新建单据"
        >
          {renderCreateForm(true)}
        </Sheet>
      )}

      <TicketDrawer
        auth={auth}
        ticket={selected}
        ticketRef={ticketId}
        open={!!ticketId}
        desktop={desktop}
        agents={board.agents}
        stages={board.board?.columns.map((c) => c.stage) ?? []}
        sessionIds={sessionIds}
        startEditing={reviseOpen}
        actions={selected ? renderActions(selected, desktop ? 'full' : 'board') : null}
        onClose={() => {
          setReviseOpen(false)
          onOpenTicket(null)
        }}
        onReconcile={() => void board.reconcile()}
        onTicketUpdated={board.replaceTicket}
        onOpenSession={onOpenSession}
      />
      {confirmEl}
      {promptEl}
    </div>
  )
}
