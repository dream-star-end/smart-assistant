import { Archive, Columns3 } from 'lucide-react'
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import type { BoardColumn, Ticket } from '../../lib/taskboard'
import { cn } from '../../lib/utils'
import { Badge, EmptyState } from '../ui'
import { TicketCard } from './TicketCard'
import {
  BACKLOG_DROP_ID,
  allowedDropIds,
  dropIdForMove,
  homeDropId,
  stageIdFromDropId,
} from './ticketMove'

export function BoardColumns({
  columns,
  backlogTickets = [],
  onOpenTicket,
  renderActions,
  onMove,
  ticketTypeLabel,
}: {
  columns: BoardColumn[]
  backlogTickets?: Ticket[]
  onOpenTicket?: (ticket: Ticket) => void
  renderActions?: (ticket: Ticket) => ReactNode
  onMove?: (ticket: Ticket, toStageId: string | null) => void
  ticketTypeLabel?: string
}) {
  const [dragging, setDragging] = useState<Ticket | null>(null)
  const [hoverDropId, setHoverDropId] = useState<string | null>(null)
  const overflowCleanup = useRef<(() => void) | null>(null)
  const [overflow, setOverflow] = useState({ left: false, right: false })

  const allowed = dragging ? allowedDropIds(dragging) : null
  const originDropId = dragging ? homeDropId(dragging) : null

  const scrollerRef = (el: HTMLDivElement | null) => {
    overflowCleanup.current?.()
    overflowCleanup.current = null
    if (!el) return
    const update = () => {
      const max = el.scrollWidth - el.clientWidth
      const next = {
        left: el.scrollLeft > 8,
        right: max > 8 && el.scrollLeft < max - 8,
      }
      setOverflow((prev) => (prev.left === next.left && prev.right === next.right ? prev : next))
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
    if (target?.closest('select, button, a, input, textarea, label')) {
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

  const renderCard = (ticket: Ticket) => (
    <TicketCard
      key={ticket.id}
      ticket={ticket}
      compact
      onOpen={onOpenTicket}
      actions={renderActions?.(ticket)}
      draggable={!!onMove && (ticket.allowedMoves?.length ?? 0) > 0}
      dragging={dragging?.id === ticket.id}
      onDragStart={(e) => beginDrag(ticket, e)}
      onDragEnd={endDrag}
    />
  )

  if (columns.length === 0 && backlogTickets.length === 0) {
    return (
      <EmptyState
        icon={Columns3}
        title="还没有流水线列"
        hint="选一个项目后，单据会按当前流水线阶段分列。"
      />
    )
  }

  const overflowing = overflow.left || overflow.right

  return (
    <div className="relative min-h-0 flex-1" data-testid="board-columns-shell">
      <div
        ref={scrollerRef}
        data-testid="board-columns-scroller"
        data-overflow-left={overflow.left ? 'true' : undefined}
        data-overflow-right={overflow.right ? 'true' : undefined}
        aria-label={overflowing ? '看板列，可横向滚动' : '看板列'}
        className="flex h-full min-h-0 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-4"
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
        {columns.map((col) => {
          const dropId = dropIdForMove(col.stage.id)
          return (
            <BoardColumnFrame
              key={col.stage.id}
              dropId={dropId}
              stageId={col.stage.id}
              title={col.stage.name}
              count={col.tickets.length}
              variant="stage"
              kind={col.stage.kind}
              allowed={allowed}
              originDropId={originDropId}
              hoverDropId={hoverDropId}
              onDragOver={overColumn}
              onDrop={dropOnColumn}
              onDragLeave={leaveColumn}
            >
              {col.tickets.length === 0 && hoverDropId !== dropId ? (
                <ColumnEmpty>这一列还没有单据</ColumnEmpty>
              ) : (
                col.tickets.map(renderCard)
              )}
            </BoardColumnFrame>
          )
        })}
      </div>
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
          className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-bg to-transparent"
        />
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
      <p className="text-center text-meta text-faint">{children}</p>
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
  variant: 'backlog' | 'stage'
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
      data-testid={backlog ? 'taskboard-backlog-column' : 'taskboard-column'}
      data-stage-id={backlog ? BACKLOG_DROP_ID : stageId}
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
        'flex w-72 shrink-0 flex-col rounded-xl',
        backlog || empty
          ? 'border border-dashed border-border bg-hover'
          : 'border border-transparent bg-bg',
        dragging && canDrop && 'border-solid border-accent bg-accent-soft',
        hover && 'border-accent ring-2 ring-accent',
        forbidden && 'opacity-40',
      )}
    >
      <header className="sticky top-0 z-10 bg-inherit px-1 py-2">
        <h3 className="flex min-w-0 items-center gap-1.5 text-section font-semibold text-fg">
          {backlog && <Archive size={14} className="shrink-0 text-faint" aria-hidden />}
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
        {!backlog && kind && (
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
