import {
  ArrowRightLeft,
  FolderCog,
  FolderPlus,
  Kanban,
  Library,
  List,
  Menu,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Settings,
  Settings2,
  Workflow,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { BoardViewParam } from '../../hooks/useAppRoute'
import { useMdViewport } from '../../hooks/useMdViewport'
import { useProjectScope } from '../../hooks/useProjectScope'
import { UNBOUND_BOARD_COPY, boardWorkQuery } from '../../lib/projectScope'
import {
  TICKET_TYPES,
  TICKET_TYPE_LABEL,
  type Ticket,
  type TicketType,
  boardErrorWhy,
  taskboardErrorMessage,
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
  Field,
  IconButton,
  Input,
  ListSkeleton,
  ProjectScopeSelect,
  SegmentedControl,
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

type ProjectPanelMode = 'create' | 'edit' | null

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
  onOpenProjectSettings,
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
  onOpenProjectSettings?: (projectId: string) => void
}) {
  const projectScope = useProjectScope()
  const workQuery = boardWorkQuery(projectScope.scope)
  const lockedProjectId = 'projectId' in workQuery ? workQuery.projectId : null
  // 锁定项目只有一条加载路径:useTaskboard.loadInitial 以 lockedProjectId 为准。以前这里还有一个
  // selectProject(lockedProjectId) effect 与它同一 commit 抢跑,把首屏 projects / agents 整个丢掉
  // (审计 T-01);selectProject 现在只留给项目创建 / 归档后的显式切换。
  const board = useTaskboard(auth, Boolean(lockedProjectId), ticketTypeFromUrl, lockedProjectId)
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const [promptText, promptEl] = usePrompt()
  const desktop = useMdViewport()
  const [creating, setCreating] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [draftType, setDraftType] = useState<TicketType>('bug')
  const [draftReady, setDraftReady] = useState(false)
  const [reviseOpen, setReviseOpen] = useState(false)
  const [lastTaskView, setLastTaskView] = useState<'board' | 'list'>(
    view === 'list' ? 'list' : 'board',
  )
  // 四个配置面板由本组件受控打开:桌面用各自的按钮,移动端收进一个「配置」菜单,
  // 看板空态里的「配置流水线 / 套用模板 / 新建项目」也从这里进(审计 T-10 / T-16)。
  const [projectMode, setProjectMode] = useState<ProjectPanelMode>(null)
  const [stageSettingsOpen, setStageSettingsOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [guardrailsOpen, setGuardrailsOpen] = useState(false)
  // 只让被点的那个按钮转圈,其余禁用(审计 T-19)。
  const [pendingAction, setPendingAction] = useState<{ ticketId: string; testId: string } | null>(
    null,
  )
  // 深链打开的单不在当前已加载列表里时,详情由抽屉自己拉;这里留一份只读副本算操作按钮(审计 T-30)。
  const [detailTicket, setDetailTicket] = useState<Ticket | null>(null)

  useEffect(() => {
    if (view === 'board' || view === 'list') setLastTaskView(view)
  }, [view])

  useEffect(() => {
    if (pendingAction && !board.pending.includes(pendingAction.ticketId)) setPendingAction(null)
  }, [board.pending, pendingAction])

  const selected = useMemo(() => {
    if (!ticketId) return null
    const match = (t: Ticket) => t.identifier === ticketId || t.id === ticketId
    const fromList = board.tickets?.find(match)
    if (fromList) return fromList
    const fromBacklogTab = board.backlogTickets?.find(match)
    if (fromBacklogTab) return fromBacklogTab
    const fromBacklog = board.board?.backlog?.tickets?.find(match)
    if (fromBacklog) return fromBacklog
    return (board.board?.columns ?? []).flatMap((c) => c.tickets ?? []).find(match) ?? null
  }, [board.backlogTickets, board.board, board.tickets, ticketId])

  const actionTicket =
    selected ??
    (detailTicket && ticketId && (detailTicket.identifier === ticketId || detailTicket.id === ticketId)
      ? detailTicket
      : null)

  const openTicket = (ticket: Ticket) => onOpenTicket(ticket.identifier)

  const currentProject = board.projects?.find((p) => p.id === board.projectId) ?? null

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
        cancelText: '先不移动',
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
        cancelText: '先不移动',
        danger: true,
      })
      if (ok) return runMove(ticket, toStageId, { ...extras, cancelRunningRun: true })
      return false
    }
    if (code === 'version_conflict') {
      // 与 useTaskboard / TicketDrawer 同一句(moveTicket 已经触发对账,不用让人再手动刷新)。
      toast(taskboardErrorMessage(outcome.error, '单据已被其他人更新，已刷新最新内容'), 'error')
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

  type ActionTone = 'secondary' | 'danger' | 'ghost'
  type TicketAction = {
    label: string
    testId: string
    onClick: () => void
    variant: ActionTone
    kind: 'primary' | 'secondary' | 'destructive'
  }

  // 按钮文案就是动作本身:「取消单据」「标记受阻」,不再与「关闭 / 放弃编辑」的「取消」同词(审计 T-07)。
  const collectActions = (ticket: Ticket): TicketAction[] => {
    const items: TicketAction[] = []
    if (ticket.status === 'backlog') {
      items.push({
        label: '批准',
        testId: 'ticket-approve',
        onClick: () => void board.runAction(ticket, { kind: 'approve' }),
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
        label: '标记受阻',
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
                confirmText: '标记完成',
                cancelText: '返回',
              })
              if (ok) void board.runAction(ticket, { kind: 'done' })
            })()
          },
          variant: 'secondary',
          kind: 'secondary',
        },
        {
          label: '取消单据',
          testId: 'ticket-cancel',
          onClick: () => {
            void (async () => {
              const ok = await confirm({
                title: `取消单据 ${ticket.identifier}？`,
                body: '取消后单据进入终态，不再参与巡检，也不能再改动。',
                confirmText: '取消单据',
                cancelText: '返回',
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
    const isPendingOne = (testId: string) =>
      busy && pendingAction?.ticketId === ticket.id && pendingAction.testId === testId
    const btn = (action: TicketAction) => (
      <Button
        key={action.testId}
        type="button"
        size="sm"
        variant={action.variant}
        loading={isPendingOne(action.testId)}
        disabled={busy && !isPendingOne(action.testId)}
        data-testid={action.testId}
        aria-label={action.label}
        onClick={() => {
          setPendingAction({ ticketId: ticket.id, testId: action.testId })
          action.onClick()
        }}
      >
        {action.label}
      </Button>
    )
    const MOVE_MENU_ID = 'ticket-move-menu'
    const startMove = (toStageId: string | null) => {
      setPendingAction({ ticketId: ticket.id, testId: MOVE_MENU_ID })
      void runMove(ticket, toStageId)
    }
    const moveMenu = (trigger: ReactNode) =>
      moves.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuLabel>移动到…</DropdownMenuLabel>
            {moves.map((m) => (
              <DropdownMenuItem
                key={`${m.action}:${dropIdForMove(m.toStageId)}`}
                data-testid="ticket-move-option"
                disabled={busy}
                onSelect={() => startMove(m.toStageId)}
              >
                {moveOptionLabel(m, stageNameById)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null
    if (layout !== 'board') {
      // 详情抽屉:所有动作平铺成带文字的按钮(移动端也一样,不再折叠成一个无标签的「···」,审计 T-06);
      // 「移动到…」单独做成带文字的按钮。
      if (!items.length && !moves.length) return null
      return (
        <div className="flex flex-wrap gap-1" data-testid="ticket-actions-full">
          {items.map(btn)}
          {moveMenu(
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid={MOVE_MENU_ID}
              loading={isPendingOne(MOVE_MENU_ID)}
              disabled={busy && !isPendingOne(MOVE_MENU_ID)}
            >
              <ArrowRightLeft size={14} />
              移动到…
            </Button>,
          )}
        </div>
      )
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
                      onSelect={() => startMove(m.toStageId)}
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
                  onSelect={() => {
                    setPendingAction({ ticketId: ticket.id, testId: action.testId })
                    action.onClick()
                  }}
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

  const submitCreate = async () => {
    if (board.createBusy) return
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
      body: draftBody.trim() || undefined,
      source: 'manual',
      ...(draftReady ? { status: 'ready' as const } : {}),
    })
    if (created) {
      setDraftTitle('')
      setDraftBody('')
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
  // 旧的 inbox / backlog 深链早已被 useAppRoute 归一到列表,这里同样只认 board / list(审计 T-20)。
  const taskView = view === 'board' || view === 'list' || view === 'inbox' || view === 'backlog'
  const effectiveTaskView: 'board' | 'list' = view === 'board' ? 'board' : 'list'
  const sectionView = taskView ? 'tasks' : view

  const switchSection = (next: string) => {
    onViewChange(next === 'tasks' ? lastTaskView : (next as BoardViewParam))
  }

  const toggleTaskView = () => {
    onViewChange(effectiveTaskView === 'board' ? 'list' : 'board')
  }

  const openCreate = () => {
    if (!board.projectId) {
      toast('请先选择项目', 'error')
      return
    }
    setCreating(true)
  }

  const nextStepControl = (
    <SegmentedControl
      aria-label="下一步"
      size="sm"
      className="self-start"
      value={draftReady ? 'ready' : 'backlog'}
      onValueChange={(v) => setDraftReady(v === 'ready')}
      options={[
        { value: 'backlog', label: '先放积压' },
        { value: 'ready', label: '直接开工' },
      ]}
    />
  )

  const renderCreateForm = (mobile: boolean) => (
    <div
      data-testid="ticket-create-form"
      className={
        mobile
          ? 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4'
          : 'mx-4 mb-3 flex flex-col gap-3 rounded-xl border border-border bg-surface p-3'
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className={mobile ? 'text-title font-semibold text-fg' : 'text-section font-semibold text-fg'}>
            新建单据
          </h2>
          <p className="mt-1 text-caption text-muted">
            先记入积压最稳妥；确定要马上处理时再选直接开工。
          </p>
        </div>
        {!mobile && (
          <IconButton
            type="button"
            size="sm"
            shape="square"
            aria-label="关闭新建表单"
            onClick={() => setCreating(false)}
          >
            <X size={16} />
          </IconButton>
        )}
      </div>
      <div className={mobile ? 'flex flex-col gap-3' : 'flex flex-wrap items-end gap-3'}>
        <Field label="类型" className={mobile ? undefined : 'w-32'}>
          <Select
            aria-label="单据类型"
            inputSize="sm"
            value={draftType}
            onValueChange={(v) => setDraftType(v as TicketType)}
            options={TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABEL[t] }))}
          />
        </Field>
        <Field label="标题" required className={mobile ? undefined : 'min-w-[12rem] flex-1'}>
          <Input
            aria-label="单据标题"
            inputSize="sm"
            placeholder="一句话说明要解决什么"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !board.createBusy) void submitCreate()
            }}
          />
        </Field>
      </div>
      <Field label="正文" hint="支持 Markdown：复现步骤、验收标准、范围内外">
        <textarea
          aria-label="单据正文"
          data-testid="ticket-create-body"
          placeholder="复现步骤 / 验收标准 / 范围内外"
          className={
            mobile
              ? 'min-h-28 w-full rounded-lg border border-border-control bg-surface px-3.5 py-2.5 text-base leading-relaxed text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring'
              : 'min-h-20 w-full rounded-lg border border-border-control bg-surface px-3.5 py-2.5 text-base leading-relaxed text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:text-sm'
          }
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-meta font-medium text-muted">下一步</span>
        {nextStepControl}
        <p className="text-caption text-muted">
          积压里的单 AI 不会处理；直接开工会进入流水线第一站。
        </p>
      </div>
      <div className={mobile ? 'mt-auto flex gap-2' : 'flex gap-2'}>
        <Button
          type="button"
          size="sm"
          variant="primary"
          aria-label="创建"
          data-testid="ticket-create-submit"
          className={mobile ? 'flex-1' : undefined}
          loading={board.createBusy}
          disabled={board.createBusy}
          onClick={() => void submitCreate()}
        >
          {board.createBusy ? '创建中…' : '创建单据'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
          {mobile ? '关闭' : '收起'}
        </Button>
      </div>
    </div>
  )

  const configMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="taskboard-config-menu"
          aria-label="配置"
          className="shrink-0"
        >
          <Settings2 size={15} />
          配置
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {currentProject ? (
          <DropdownMenuItem data-testid="project-edit-open" onSelect={() => setProjectMode('edit')}>
            <FolderCog size={14} />
            管理项目
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem data-testid="project-create-open" onSelect={() => setProjectMode('create')}>
          <FolderPlus size={14} />
          新建项目
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="stage-settings-open"
          disabled={!board.projectId}
          onSelect={() => setStageSettingsOpen(true)}
        >
          <Workflow size={14} />
          流水线配置
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="template-library-open" onSelect={() => setTemplatesOpen(true)}>
          <Library size={14} />
          流水线模板
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="board-settings-open" onSelect={() => setGuardrailsOpen(true)}>
          <Settings size={14} />
          护栏设置
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const panelId = `taskboard-section-panel-${sectionView}`

  const renderTaskContent = () => {
    if (board.loading && !board.tickets) {
      return (
        <div className="px-4">
          <ListSkeleton rows={6} variant={effectiveTaskView === 'board' ? 'card' : 'row'} />
        </div>
      )
    }
    if (board.error) {
      return (
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
      )
    }
    if (!lockedProjectId) {
      return (
        <EmptyState
          icon={Kanban}
          title={'blocked' in workQuery ? workQuery.blocked : UNBOUND_BOARD_COPY}
          hint={
            projectScope.scope.kind === 'all'
              ? '任务看板按工作项目组织。请在上方选择一个具体的工作项目。'
              : projectScope.scope.kind === 'chat'
                ? '当前会话项目还没有绑定看板。请在上方选择一个已绑定的工作项目。'
                : '任务看板按工作项目组织。请在上方选择一个具体的工作项目，或先把当前会话归入某个项目。'
          }
          action={
            projectScope.scope.kind === 'all' ? (
              <Button
                type="button"
                onClick={() => {
                  const el = document.getElementById('taskboard-project-scope')
                  el?.scrollIntoView({ block: 'nearest' })
                  el?.focus()
                }}
              >
                选择工作项目
              </Button>
            ) : projectScope.scope.kind === 'chat' && onOpenProjectSettings && projectScope.scope.chatProject ? (
              <Button
                type="button"
                onClick={() => onOpenProjectSettings(projectScope.scope.chatProject!.id)}
              >
                去项目设置绑定
              </Button>
            ) : undefined
          }
        />
      )
    }
    if (!board.projectId || (lockedProjectId && board.projectId !== lockedProjectId && !board.board)) {
      return (
        <EmptyState
          icon={Kanban}
          title="还没有项目"
          hint="新建一个项目后即可开始建单。创建时会自动带上四条默认流水线。"
          action={
            <Button type="button" data-testid="board-empty-create-project" onClick={() => setProjectMode('create')}>
              <FolderPlus size={14} />
              新建项目
            </Button>
          }
        />
      )
    }
    if (effectiveTaskView === 'board') {
      return (
        <BoardColumns
          columns={board.board?.columns ?? []}
          backlogTickets={board.board?.backlog?.tickets ?? []}
          inboxTickets={board.board?.inbox ?? []}
          ticketTypeLabel={shownType ? TICKET_TYPE_LABEL[shownType] : undefined}
          onOpenTicket={openTicket}
          renderActions={(ticket) => renderActions(ticket, 'board')}
          onMove={(ticket, toStageId) => void runMove(ticket, toStageId)}
          onCreateTicket={openCreate}
          onOpenStageSettings={() => setStageSettingsOpen(true)}
          onOpenTemplates={() => setTemplatesOpen(true)}
        />
      )
    }
    return (
      <TicketListView
        tickets={board.tickets ?? []}
        query={board.listQuery}
        agents={board.agents}
        onQueryChange={(q) => void board.applyListQuery(q)}
        onOpenTicket={openTicket}
        renderActions={(ticket) => renderActions(ticket, 'board')}
        total={board.listTotal}
        onLoadMore={() => void board.loadMoreTickets()}
        loadingMore={board.listLoadingMore}
        onCreateTicket={openCreate}
      />
    )
  }

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
          <ProjectScopeSelect
            id="taskboard-project-scope"
            variant="work"
            className="min-w-0 flex-1 md:w-56 md:max-w-[16rem] md:flex-none"
          />
          {/* 移动端:四个配置入口收进一个菜单,不再是四个带 10px 标签的图标(审计 T-10)。
              面板组件只挂一份:桌面显示它们自带的按钮,移动端隐藏按钮、由菜单受控打开
              (Sheet 走 Portal,父级 display:none 不影响)。 */}
          {!desktop && configMenu}
          <div className={desktop ? 'flex shrink-0 items-center gap-1' : 'hidden'}>
            <ProjectSettings
              auth={auth}
              current={currentProject}
              mode={projectMode}
              onModeChange={setProjectMode}
              hideTrigger={!desktop}
              onCreate={async (input) => {
                const created = await board.createProject(input)
                if (created) {
                  await projectScope.refreshWorkProjects()
                  projectScope.setToken(created.id)
                }
                return created
              }}
              onPatch={async (id, input) => {
                const updated = await board.patchProject(id, input)
                if (updated) await projectScope.refreshWorkProjects()
                return updated
              }}
              onArchive={async (id) => {
                const archived = await board.archiveProject(id)
                if (archived) await projectScope.refreshWorkProjects()
                return archived
              }}
              onUnarchive={async (id) => {
                const restored = await board.unarchiveProject(id)
                if (restored) await projectScope.refreshWorkProjects()
                return Boolean(restored)
              }}
            />
            <StageSettings
              auth={auth}
              projectId={board.projectId}
              onChanged={() => void board.reconcile()}
              open={stageSettingsOpen}
              onOpenChange={setStageSettingsOpen}
              hideTrigger={!desktop}
            />
            <TemplateLibrary
              auth={auth}
              projectId={board.projectId}
              onChanged={() => void board.reconcile()}
              open={templatesOpen}
              onOpenChange={setTemplatesOpen}
              hideTrigger={!desktop}
            />
            <BoardSettingsPanel
              auth={auth}
              open={guardrailsOpen}
              onOpenChange={setGuardrailsOpen}
              hideTrigger={!desktop}
            />
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="order-2 ml-auto shrink-0 md:order-3 md:ml-0"
          data-testid="ticket-create-toggle"
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
          mountedPanels={[sectionView]}
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
              aria-label={effectiveTaskView === 'board' ? '切换到列表展示' : '切换到看板展示'}
              title={effectiveTaskView === 'board' ? '切换到列表展示' : '切换到看板展示'}
              onClick={toggleTaskView}
            >
              {effectiveTaskView === 'board' ? <List size={15} /> : <Kanban size={15} />}
              <span className="hidden md:inline">{effectiveTaskView === 'board' ? '列表' : '看板'}</span>
            </Button>
            {effectiveTaskView === 'board' && (
              <Select
                aria-label="看板类型"
                className="w-24 md:w-36"
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

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`taskboard-section-tab-${sectionView}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {view === 'cost' ? (
          <CostStatsView auth={auth} />
        ) : view === 'weekly' ? (
          <WeeklyReportView auth={auth} />
        ) : (
          renderTaskContent()
        )}
      </div>

      {!desktop && (
        <Sheet
          open={creating}
          onOpenChange={(next) => {
            if (!next) setCreating(false)
          }}
          side="bottom"
          srTitle="新建单据"
        >
          <div className="flex items-center justify-end px-3 pt-2">
            <IconButton
              type="button"
              size="sm"
              shape="square"
              aria-label="关闭"
              data-testid="ticket-create-close"
              onClick={() => setCreating(false)}
            >
              <X size={16} />
            </IconButton>
          </div>
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
        stages={(board.board?.columns ?? []).map((c) => c.stage).filter(Boolean)}
        sessionIds={sessionIds}
        startEditing={reviseOpen}
        actions={actionTicket ? renderActions(actionTicket, 'full') : null}
        onClose={() => {
          setReviseOpen(false)
          onOpenTicket(null)
        }}
        onReconcile={() => void board.reconcile()}
        onTicketUpdated={board.replaceTicket}
        onDetailLoaded={setDetailTicket}
        onOpenSession={onOpenSession}
      />
      {confirmEl}
      {promptEl}
    </div>
  )
}
