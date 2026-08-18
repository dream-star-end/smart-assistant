import { Archive, Columns3 } from 'lucide-react'
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import type { BoardColumn, Ticket } from '../../lib/taskboard'
import { cn } from '../../lib/utils'
import { EmptyState } from '../ui'
import { TicketCard } from './TicketCard'
import {
  BACKLOG_DROP_ID,
  allowedDropIds,
  dropIdForMove,
  moveOptionLabel,
  stageIdFromDropId,
} from './ticketMove'

export function BoardColumns({
  columns,
  backlogTickets = [],
  onOpenTicket,
  renderActions,
  onMove,
}: {
  columns: BoardColumn[]
  backlogTickets?: Ticket[]
  onOpenTicket?: (ticket: Ticket) => void
  renderActions?: (ticket: Ticket) => ReactNode
  onMove?: (ticket: Ticket, toStageId: string | null) => void
}) {
  const [dragging, setDragging] = useState<Ticket | null>(null)
  const [hoverDropId, setHoverDropId] = useState<string | null>(null)

  const allowed = dragging ? allowedDropIds(dragging) : null
  const stageNameById = new Map<string, string>(
    columns.map((col) => [col.stage.id, col.stage.name]),
  )

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
      moveOptions={ticket.allowedMoves}
      moveOptionLabel={(m) => moveOptionLabel(m, stageNameById)}
      onMoveSelect={onMove ? (toStageId) => onMove(ticket, toStageId) : undefined}
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

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-4">
      <BoardColumnFrame
        dropId={BACKLOG_DROP_ID}
        title="积压"
        count={backlogTickets.length}
        variant="backlog"
        allowed={allowed}
        hoverDropId={hoverDropId}
        onDragOver={overColumn}
        onDrop={dropOnColumn}
        onDragLeave={leaveColumn}
      >
        {backlogTickets.length === 0 && hoverDropId !== BACKLOG_DROP_ID ? (
          <p className="px-1 py-6 text-center text-meta text-faint">
            还没有积压单。遗留问题可以先记在这里。
          </p>
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
            hoverDropId={hoverDropId}
            onDragOver={overColumn}
            onDrop={dropOnColumn}
            onDragLeave={leaveColumn}
          >
            {col.tickets.length === 0 && hoverDropId !== dropId ? (
              <p className="px-1 py-6 text-center text-meta text-faint">这一列还没有单据</p>
            ) : (
              col.tickets.map(renderCard)
            )}
          </BoardColumnFrame>
        )
      })}
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
  count,
  variant,
  kind,
  allowed,
  hoverDropId,
  onDragOver,
  onDrop,
  onDragLeave,
  children,
}: {
  dropId: string
  stageId?: string
  title: string
  count: number
  variant: 'backlog' | 'stage'
  kind?: 'ai' | 'human' | 'gate'
  allowed: Set<string> | null
  hoverDropId: string | null
  onDragOver: (dropId: string, e: DragEvent) => void
  onDrop: (dropId: string, e: DragEvent) => void
  onDragLeave: (dropId: string) => void
  children: ReactNode
}) {
  const dragDepth = useRef(0)
  const dragging = allowed !== null
  const canDrop = allowed?.has(dropId) ?? false
  const forbidden = dragging && !canDrop
  const hover = dragging && canDrop && hoverDropId === dropId
  const backlog = variant === 'backlog'

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
      data-drop-allowed={dragging ? (canDrop ? 'true' : undefined) : undefined}
      data-drop-disabled={forbidden ? 'true' : undefined}
      data-drop-hover={hover ? 'true' : undefined}
      aria-disabled={forbidden || undefined}
      onDragEnter={handleDragEnter}
      onDragOver={(e) => onDragOver(dropId, e)}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-xl',
        backlog ? 'border border-dashed border-border bg-hover' : 'border border-transparent bg-bg',
        dragging && canDrop && 'border-solid border-accent bg-accent-soft',
        hover && 'border-accent ring-2 ring-accent',
        forbidden && 'opacity-40',
      )}
    >
      <header className="sticky top-0 z-10 flex items-start justify-between gap-2 bg-inherit px-1 py-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 truncate text-section font-semibold text-fg">
            {backlog && <Archive size={14} className="shrink-0 text-faint" aria-hidden />}
            {title}
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
        </div>
        <span className="shrink-0 pt-0.5 text-caption text-faint">{count}</span>
      </header>
      <div className="flex min-h-[12rem] min-w-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
        {hover && <DropPlaceholder />}
        {children}
      </div>
    </section>
  )
}
