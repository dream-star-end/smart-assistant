import { Archive, Columns3, Plus, Workflow } from 'lucide-react'
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import type { BoardColumn, Ticket } from '../../lib/taskboard'
import { collectInboxTickets, stageColumnTickets } from '../../lib/taskboard'
import { cn } from '../../lib/utils'
import { Badge, Button, EmptyState } from '../ui'
import { TicketCard } from './TicketCard'
import {
  BACKLOG_DROP_ID,
  INBOX_DROP_ID,
  allowedDropIds,
  dropIdForMove,
  homeDropId,
  stageIdFromDropId,
} from './ticketMove'

export function BoardColumns({
  columns,
  backlogTickets = [],
  inboxTickets = [],
  onOpenTicket,
  renderActions,
  onMove,
  ticketTypeLabel,
  onCreateTicket,
  onOpenStageSettings,
  onOpenTemplates,
}: {
  columns: BoardColumn[]
  backlogTickets?: Ticket[]
  inboxTickets?: Ticket[]
  onOpenTicket?: (ticket: Ticket) => void
  renderActions?: (ticket: Ticket) => ReactNode
  onMove?: (ticket: Ticket, toStageId: string | null) => void
  ticketTypeLabel?: string
  /** 空态「新建单据」的下一步入口(审计 T-16)。 */
  onCreateTicket?: () => void
  /** 没有流水线时的两个下一步:去配置 / 套用模板(审计 T-03 / T-16)。 */
  onOpenStageSettings?: () => void
  onOpenTemplates?: () => void
}) {
  const [dragging, setDragging] = useState<Ticket | null>(null)
  const [hoverDropId, setHoverDropId] = useState<string | null>(null)
  const overflowCleanup = useRef<(() => void) | null>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const [overflow, setOverflow] = useState({ left: false, right: false })
  const [activeDropId, setActiveDropId] = useState(BACKLOG_DROP_ID)

  const allowed = dragging ? allowedDropIds(dragging) : null
  const originDropId = dragging ? homeDropId(dragging) : null
  const waitingTickets = collectInboxTickets({ inbox: inboxTickets, columns })

  const scrollerRef = (el: HTMLElement | null) => {
    overflowCleanup.current?.()
    overflowCleanup.current = null
    scroller.current = el
    if (!el) return
    const update = () => {
      const max = el.scrollWidth - el.clientWidth
      const next = {
        left: el.scrollLeft > 8,
        right: max > 8 && el.scrollLeft < max - 8,
      }
      setOverflow((prev) => (prev.left === next.left && prev.right === next.right ? prev : next))
      const center = el.scrollLeft + el.clientWidth / 2
      const frames = Array.from(el.children).filter(
        (node): node is HTMLElement => node instanceof HTMLElement && !!node.dataset.dropId,
      )
      const nearest = frames.reduce<HTMLElement | null>((best, frame) => {
        if (!best) return frame
        const distance = Math.abs(frame.offsetLeft + frame.offsetWidth / 2 - center)
        const bestDistance = Math.abs(best.offsetLeft + best.offsetWidth / 2 - center)
        return distance < bestDistance ? frame : best
      }, null)
      if (nearest?.dataset.dropId) setActiveDropId(nearest.dataset.dropId)
    }
    update()
    const raf = requestAnimationFrame(update)
    el.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    ro?.observe(el)
    overflowCleanup.current = () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      ro?.disconnect()
    }
  }

  const beginDrag = (ticket: Ticket, e: DragEvent) => {
    const target = e.target as HTMLElement | null
    // 卡片标题现在是个真按钮(读屏可达,见 TicketCard),从它上面起拖仍要放行;
    // 其余控件(批准 / 更多操作 / 下拉)保持禁止起拖。
    if (target?.closest('select, button:not([data-drag-through]), a, input, textarea, label')) {
      e.preventDefault()
      return
    }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', ticket.id)
    setDragging(ticket)
    setHoverDropId(null)
  }

  const endDrag = () => {
    setDragging(null)
    setHoverDropId(null)
  }

  const jumpToColumn = (dropId: string) => {
    const el = scroller.current
    if (!el) return
    const frame = Array.from(el.children).find(
      (node): node is HTMLElement => node instanceof HTMLElement && node.dataset.dropId === dropId,
    )
    if (!frame) return
    setActiveDropId(dropId)
    const left = Math.max(0, frame.offsetLeft - 16)
    if (typeof el.scrollTo === 'function') el.scrollTo({ left, behavior: 'smooth' })
    else el.scrollLeft = left
  }

  const overColumn = (dropId: string, e: DragEvent) => {
    if (!dragging || !allowed) return
    if (allowed.has(dropId)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (hoverDropId !== dropId) setHoverDropId(dropId)
    } else {
      e.dataTransfer.dropEffect = 'none'
      if (hoverDropId !== null) setHoverDropId(null)
    }
  }

  const leaveColumn = (dropId: string) => {
    setHoverDropId((cur) => (cur === dropId ? null : cur))
  }

  const dropOnColumn = (dropId: string, e: DragEvent) => {
    e.preventDefault()
    const ticket = dragging
    endDrag()
    if (!ticket || !onMove) return
    if (!allowedDropIds(ticket).has(dropId)) return
    onMove(ticket, stageIdFromDropId(dropId))
  }

  // 列名已经表达了状态(积压列 / 待确认列 / 阶段列),卡片上不再重复画状态徽章;受阻仍保留。
  const renderCard = (ticket: Ticket) => (
    <TicketCard
      key={ticket.id}
      ticket={ticket}
      compact
      hideStatus
      onOpen={onOpenTicket}
      actions={renderActions?.(ticket)}
      draggable={!!onMove && (ticket.allowedMoves?.length ?? 0) > 0}
      dragging={dragging?.id === ticket.id}
      onDragStart={(e) => beginDrag(ticket, e)}
      onDragEnd={endDrag}
    />
  )

  if (columns.length === 0 && backlogTickets.length === 0 && waitingTickets.length === 0) {
    // 项目已选但没有流水线:说清是「这个项目还没有 X 流水线」,并给出两个下一步,
    // 而不是「选一个项目后…」这种与现状相反的解释(审计 T-03 / T-16 ②)。
    return (
      <EmptyState
        icon={Columns3}
        title={`这个项目还没有${ticketTypeLabel ?? ''}流水线`}
        hint="配置流水线或套用一条模板后，单据会按阶段分列显示。"
        action={
          onOpenStageSettings || onOpenTemplates ? (
            <div className="flex flex-wrap justify-center gap-2">
              {onOpenStageSettings && (
                <Button type="button" data-testid="board-empty-configure" onClick={onOpenStageSettings}>
                  <Workflow size={14} />
                  配置流水线
                </Button>
              )}
              {onOpenTemplates && (
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="board-empty-templates"
                  onClick={onOpenTemplates}
                >
                  套用模板
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
    )
  }

  const stageTicketCount = columns.reduce(
    (sum, col) => sum + stageColumnTickets(col.tickets).length,
    0,
  )
  if (stageTicketCount === 0 && backlogTickets.length === 0 && waitingTickets.length === 0) {
    // 项目零单据:不画 6 个空列让人对着一排最低对比度的灰框猜下一步(审计 T-16 ①)。
    return (
      <EmptyState
        icon={Columns3}
        title="还没有单据"
        hint={`流水线已就位（${columns.map((c) => c.stage.name).join(' → ')}）。新建第一条单据后，它会出现在积压里或直接进入第一站。`}
        action={
          onCreateTicket ? (
            <Button type="button" data-testid="board-empty-create" onClick={onCreateTicket}>
              <Plus size={14} />
              新建第一条单据
            </Button>
          ) : undefined
        }
      />
    )
  }

  const overflowing = overflow.left || overflow.right
  const navItems = [
    { id: BACKLOG_DROP_ID, label: '积压', count: backlogTickets.length },
    { id: INBOX_DROP_ID, label: '待确认', count: waitingTickets.length },
    ...columns.map((col) => {
      const tickets = stageColumnTickets(col.tickets)
      return {
        id: dropIdForMove(col.stage.id),
        label: col.stage.name,
        count: tickets.length,
      }
    }),
  ]

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="board-columns-shell">
      <nav
        aria-label="看板阶段"
        data-testid="board-mobile-stage-nav"
        className="no-scrollbar flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-2 md:hidden"
      >
        {navItems.map((item) => {
          const active = activeDropId === item.id
          // 走 Button 原语拿触控靶(触屏 ≥44px),不再手写 36px 的裸 button(审计 T-11)。
          return (
            <Button
              key={item.id}
              type="button"
              size="sm"
              shape="pill"
              variant={active ? 'accent' : 'secondary'}
              aria-current={active ? 'page' : undefined}
              aria-label={`查看${item.label}，${item.count}条单据`}
              className="shrink-0 gap-1 px-3 text-caption"
              onClick={() => jumpToColumn(item.id)}
            >
              <span>{item.label}</span>
              <span className={active ? 'opacity-80' : 'text-faint'}>{item.count}</span>
            </Button>
          )
        })}
      </nav>
      <section
        ref={scrollerRef}
        data-testid="board-columns-scroller"
        data-overflow-left={overflow.left ? 'true' : undefined}
        data-overflow-right={overflow.right ? 'true' : undefined}
        aria-label={overflowing ? '看板列，可横向滚动' : '看板列'}
        className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-4 pb-4 md:snap-none"
      >
        <BoardColumnFrame
          dropId={BACKLOG_DROP_ID}
          title="积压"
          typeLabel={ticketTypeLabel}
          count={backlogTickets.length}
          variant="backlog"
          allowed={allowed}
          originDropId={originDropId}
          hoverDropId={hoverDropId}
          onDragOver={overColumn}
          onDrop={dropOnColumn}
          onDragLeave={leaveColumn}
        >
          {backlogTickets.length === 0 && hoverDropId !== BACKLOG_DROP_ID ? (
            <ColumnEmpty>还没有积压单。遗留问题可以先记在这里。</ColumnEmpty>
          ) : (
            backlogTickets.map(renderCard)
          )}
        </BoardColumnFrame>
        <BoardColumnFrame
          dropId={INBOX_DROP_ID}
          title="待确认"
          typeLabel={ticketTypeLabel}
          count={waitingTickets.length}
          variant="inbox"
          allowed={allowed}
          originDropId={originDropId}
          hoverDropId={hoverDropId}
          onDragOver={overColumn}
          onDrop={dropOnColumn}
          onDragLeave={leaveColumn}
        >
          {waitingTickets.length === 0 && hoverDropId !== INBOX_DROP_ID ? (
            <ColumnEmpty>agent 做完等人拍板的单会出现在这里。</ColumnEmpty>
          ) : (
            waitingTickets.map(renderCard)
          )}
        </BoardColumnFrame>
        {columns.map((col) => {
          const dropId = dropIdForMove(col.stage.id)
          const tickets = stageColumnTickets(col.tickets)
          return (
            <BoardColumnFrame
              key={col.stage.id}
              dropId={dropId}
              stageId={col.stage.id}
              title={col.stage.name}
              count={tickets.length}
              variant="stage"
              kind={col.stage.kind}
              allowed={allowed}
              originDropId={originDropId}
              hoverDropId={hoverDropId}
              onDragOver={overColumn}
              onDrop={dropOnColumn}
              onDragLeave={leaveColumn}
            >
              {tickets.length === 0 && hoverDropId !== dropId ? (
                <ColumnEmpty>这一列还没有单据</ColumnEmpty>
              ) : (
                tickets.map(renderCard)
              )}
            </BoardColumnFrame>
          )
        })}
      </section>
      {overflow.left && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-bg to-transparent"
        />
      )}
      {overflow.right && (
        <div
          data-testid="board-overflow-hint"
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 flex w-16 items-center justify-end bg-gradient-to-l from-bg via-bg/80 to-transparent pr-1 text-faint"
        >
          <span className="text-body">→</span>
        </div>
      )}
    </div>
  )
}

function ColumnEmpty({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="column-empty"
      className="flex min-h-[10rem] flex-1 items-center justify-center rounded-lg border border-dashed border-border bg-hover px-3 py-6"
    >
      <p className="text-center text-meta text-muted">{children}</p>
    </div>
  )
}

function DropPlaceholder() {
  return (
    <div
      data-testid="drop-placeholder"
      data-drop-placeholder="true"
      aria-hidden
      className="pointer-events-none h-9 shrink-0 rounded-lg border-2 border-dashed border-accent bg-accent-soft"
    />
  )
}

function BoardColumnFrame({
  dropId,
  stageId,
  title,
  typeLabel,
  count,
  variant,
  kind,
  allowed,
  originDropId,
  hoverDropId,
  onDragOver,
  onDrop,
  onDragLeave,
  children,
}: {
  dropId: string
  stageId?: string
  title: string
  typeLabel?: string
  count: number
  variant: 'backlog' | 'inbox' | 'stage'
  kind?: 'ai' | 'human' | 'gate'
  allowed: Set<string> | null
  originDropId: string | null
  hoverDropId: string | null
  onDragOver: (dropId: string, e: DragEvent) => void
  onDrop: (dropId: string, e: DragEvent) => void
  onDragLeave: (dropId: string) => void
  children: ReactNode
}) {
  const dragDepth = useRef(0)
  const dragging = allowed !== null
  const isOrigin = originDropId !== null && originDropId === dropId
  const canDrop = !isOrigin && (allowed?.has(dropId) ?? false)
  const forbidden = dragging && !isOrigin && !canDrop
  const hover = dragging && canDrop && hoverDropId === dropId
  const backlog = variant === 'backlog'
  const inbox = variant === 'inbox'
  const empty = count === 0

  useEffect(() => {
    if (!dragging) dragDepth.current = 0
  }, [dragging])

  const handleDragEnter = (e: DragEvent<HTMLElement>) => {
    dragDepth.current += 1
    onDragOver(dropId, e)
  }

  const handleDragLeave = (e: DragEvent<HTMLElement>) => {
    dragDepth.current -= 1
    if (dragDepth.current > 0) return
    dragDepth.current = 0
    const related = e.relatedTarget
    if (related instanceof Node && e.currentTarget.contains(related)) {
      dragDepth.current = 1
      return
    }
    onDragLeave(dropId)
  }

  const handleDrop = (e: DragEvent<HTMLElement>) => {
    dragDepth.current = 0
    onDrop(dropId, e)
  }

  return (
    <section
      data-testid={
        backlog ? 'taskboard-backlog-column' : inbox ? 'taskboard-inbox-column' : 'taskboard-column'
      }
      data-stage-id={backlog ? BACKLOG_DROP_ID : inbox ? INBOX_DROP_ID : stageId}
      data-drop-id={dropId}
      data-drop-allowed={dragging && canDrop ? 'true' : undefined}
      data-drop-source={isOrigin ? 'true' : undefined}
      data-drop-disabled={forbidden ? 'true' : undefined}
      data-drop-hover={hover ? 'true' : undefined}
      aria-disabled={forbidden || undefined}
      onDragEnter={handleDragEnter}
      onDragOver={(e) => onDragOver(dropId, e)}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
      className={cn(
        // 桌面列宽随容器伸缩(14–18rem):1440px 视口下六列尽量排开,不再固定 288px 把最后一列
        // 整个推到视口外(审计 T-24);仍溢出时右侧有渐隐 + 箭头提示。
        'flex w-[calc(100vw-2rem)] max-w-[20rem] shrink-0 snap-start flex-col rounded-xl md:w-[clamp(14rem,calc((100%_-_5.75rem)/6),18rem)] md:max-w-none md:snap-none',
        backlog || inbox || empty
          ? 'border border-dashed border-border bg-hover'
          : 'border border-transparent bg-bg',
        dragging && canDrop && 'border-solid border-accent bg-accent-soft',
        hover && 'border-accent ring-2 ring-accent',
        forbidden && 'opacity-40',
      )}
    >
      <header className="sticky top-0 z-10 bg-inherit px-1 py-2">
        <h3 className="flex min-w-0 items-center gap-1.5 text-section font-semibold text-fg">
          {(backlog || inbox) && <Archive size={14} className="shrink-0 text-faint" aria-hidden />}
          <span className="truncate">{title}</span>
          {typeLabel && (
            <span data-testid="column-type-filter" className="shrink-0 font-normal text-faint">
              · {typeLabel}
            </span>
          )}
          <Badge tone="neutral" size="sm" data-testid="column-count">
            {count}
          </Badge>
        </h3>
        {backlog && (
          <p className="mt-0.5 text-caption text-faint">
            这里的单 AI 不会碰，拖进右边的站才会开工。
          </p>
        )}
        {inbox && (
          <p className="mt-0.5 text-caption text-faint">人来拍板。通过后才会继续往下走。</p>
        )}
        {!backlog && !inbox && kind && (
          <p className="mt-0.5 text-caption text-faint">
            {kind === 'ai' ? 'AI 站' : kind === 'human' ? '人工站' : '闸门'}
          </p>
        )}
      </header>
      <div className="flex min-h-[12rem] min-w-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
        {hover && <DropPlaceholder />}
        {children}
      </div>
    </section>
  )
}
