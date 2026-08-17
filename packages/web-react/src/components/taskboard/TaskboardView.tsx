import { Kanban, Menu, PanelLeft, PenSquare, Plus } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import type { BoardViewParam } from '../../hooks/useAppRoute'
import { useMdViewport } from '../../hooks/useMdViewport'
import { TICKET_TYPES, TICKET_TYPE_LABEL, type Ticket, type TicketType } from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import {
  Button,
  EmptyState,
  IconButton,
  Input,
  ListSkeleton,
  Select,
  Tabs,
  useConfirm,
  usePrompt,
  useToast,
} from '../ui'
import { BoardColumns } from './BoardColumns'
import { BoardSettingsPanel } from './BoardSettingsPanel'
import { ProjectSettings } from './ProjectSettings'
import { StageSettings } from './StageSettings'
import { TicketDrawer } from './TicketDrawer'
import { TicketListView } from './TicketListView'
import { useTaskboard } from './useTaskboard'

export function TaskboardView({
  auth,
  view,
  ticketId,
  onViewChange,
  onOpenTicket,
  onOpenMobileNav,
  onOpenSession,
  sessionIds = [],
  sidebarCollapsed,
  onExpandSidebar,
}: {
  auth: AuthSession
  view: BoardViewParam
  ticketId: string | null
  onViewChange: (view: BoardViewParam) => void
  onOpenTicket: (identifier: string | null) => void
  onOpenMobileNav: () => void
  onOpenSession?: (sessionId: string) => void
  sessionIds?: readonly string[]
  sidebarCollapsed?: boolean
  onExpandSidebar?: () => void
}) {
  const board = useTaskboard(auth, true)
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const [promptText, promptEl] = usePrompt()
  const desktop = useMdViewport()
  const [creating, setCreating] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftType, setDraftType] = useState<TicketType>('bug')
  const [reviseOpen, setReviseOpen] = useState(false)

  const selected = useMemo(() => {
    if (!ticketId) return null
    const fromList = board.tickets?.find((t) => t.identifier === ticketId || t.id === ticketId)
    if (fromList) return fromList
    return (
      board.board?.columns
        .flatMap((c) => c.tickets)
        .find((t) => t.identifier === ticketId || t.id === ticketId) ?? null
    )
  }, [board.board, board.tickets, ticketId])

  const openTicket = (ticket: Ticket) => onOpenTicket(ticket.identifier)

  const askReason = async (title: string, confirmText: string) => {
    const reason = await promptText({
      title,
      confirmText,
      placeholder: '请填写理由',
      maxLength: 500,
    })
    return reason
  }

  const renderActions = (ticket: Ticket) => {
    const busy = board.isPending(ticket.id)
    const btn = (
      label: string,
      testId: string,
      onClick: () => void,
      variant: 'secondary' | 'danger' | 'ghost' = 'secondary',
    ) => (
      <Button
        key={label}
        type="button"
        size="sm"
        variant={variant}
        loading={busy}
        data-testid={testId}
        aria-label={label}
        onClick={onClick}
      >
        {label}
      </Button>
    )
    const items: ReactNode[] = []
    if (ticket.status === 'backlog') {
      items.push(
        btn('批准开工', 'ticket-ready', () => void board.runAction(ticket, { kind: 'ready' })),
      )
    }
    if (ticket.status === 'waiting_human') {
      items.push(
        btn('通过', 'inbox-approve', () => void board.runAction(ticket, { kind: 'approve' })),
        btn(
          '打回',
          'inbox-reject',
          async () => {
            const reason = await askReason(`打回 ${ticket.identifier}？`, '打回')
            if (reason) void board.runAction(ticket, { kind: 'reject', reason })
          },
          'danger',
        ),
        btn(
          '改需求',
          'inbox-revise',
          () => {
            setReviseOpen(true)
            onOpenTicket(ticket.identifier)
          },
          'ghost',
        ),
      )
    }
    if (ticket.status !== 'done' && ticket.status !== 'canceled' && ticket.status !== 'blocked') {
      items.push(
        btn(
          '受阻',
          'ticket-block',
          async () => {
            const reason = await askReason(`将 ${ticket.identifier} 标为受阻？`, '标记受阻')
            if (reason) void board.runAction(ticket, { kind: 'block', reason })
          },
          'ghost',
        ),
      )
    }
    if (ticket.status !== 'done' && ticket.status !== 'canceled') {
      items.push(
        btn('完成', 'ticket-done', async () => {
          const ok = await confirm({
            title: `完成 ${ticket.identifier}？`,
            body: '完成后不再参与巡检。',
            confirmText: '完成',
          })
          if (ok) void board.runAction(ticket, { kind: 'done' })
        }),
        btn(
          '取消',
          'ticket-cancel',
          async () => {
            const ok = await confirm({
              title: `取消 ${ticket.identifier}？`,
              body: '取消后单据进入终态。',
              confirmText: '取消单据',
              danger: true,
            })
            if (ok) void board.runAction(ticket, { kind: 'cancel' })
          },
          'danger',
        ),
      )
    }
    return items.length ? <div className="flex flex-wrap gap-1">{items}</div> : null
  }

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
    })
    if (created) {
      setDraftTitle('')
      setCreating(false)
      onOpenTicket(created.identifier)
    }
  }

  return (
    <div data-testid="taskboard-root" className="flex h-full min-h-0 flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-2 px-3 pb-2.5 header-safe-t">
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
        <div className="flex min-w-0 items-center gap-2">
          <Kanban size={16} className="text-faint" />
          <h1 className="truncate text-title font-semibold">任务面板</h1>
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Select
            aria-label="项目"
            className="w-40"
            inputSize="sm"
            value={board.projectId ?? ''}
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
          />
          <StageSettings
            auth={auth}
            projectId={board.projectId}
            onChanged={() => void board.reconcile()}
          />
          <BoardSettingsPanel auth={auth} />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!board.projectId}
            onClick={() => setCreating((v) => !v)}
          >
            <Plus size={14} />
            新建单据
          </Button>
        </div>
      </header>

      <div className="flex items-center gap-3 px-4 pb-2">
        <Tabs
          value={view}
          onValueChange={(v) => onViewChange(v as BoardViewParam)}
          layout="scroll"
          idBase="taskboard"
          aria-label="任务面板视图"
          items={[
            { value: 'board', label: '看板' },
            { value: 'list', label: '列表' },
            {
              value: 'inbox',
              label: `待我确认${board.inboxTickets.length ? ` ${board.inboxTickets.length}` : ''}`,
            },
          ]}
        />
      </div>

      {creating && (
        <div className="mx-4 mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3">
          <Select
            aria-label="单据类型"
            className="w-32"
            inputSize="sm"
            value={draftType}
            onValueChange={(v) => setDraftType(v as TicketType)}
            options={TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABEL[t] }))}
          />
          <Input
            aria-label="单据标题"
            inputSize="sm"
            className="min-w-[12rem] flex-1"
            placeholder="一句话标题"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCreate()
            }}
          />
          <Button type="button" size="sm" onClick={() => void submitCreate()}>
            创建
          </Button>
        </div>
      )}

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
      ) : view === 'board' ? (
        <BoardColumns
          columns={board.board?.columns ?? []}
          onOpenTicket={openTicket}
          renderActions={renderActions}
        />
      ) : view === 'list' ? (
        <TicketListView
          tickets={board.tickets ?? []}
          query={board.listQuery}
          agents={board.agents}
          onQueryChange={(q) => void board.applyListQuery(q)}
          onOpenTicket={openTicket}
          renderActions={renderActions}
        />
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
          renderActions={renderActions}
        />
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
        actions={selected ? renderActions(selected) : null}
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
