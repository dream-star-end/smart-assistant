import { Bug, FlaskConical, Sparkles, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { DragEvent, ReactNode } from 'react'
import {
  type AllowedMove,
  type RunStatus,
  TICKET_PRIORITY_TONE,
  TICKET_STATUS_LABEL,
  TICKET_TYPE_LABEL,
  TICKET_TYPE_TONE,
  type Ticket,
  type TicketPriority,
  type TicketType,
  assigneeLabel,
  latestRunHint,
} from '../../lib/taskboard'
import { cn } from '../../lib/utils'
import { Badge, Card } from '../ui'
import { dropIdForMove, stageIdFromDropId } from './ticketMove'

const TYPE_ICON: Record<TicketType, LucideIcon> = {
  bug: Bug,
  feature: Sparkles,
  spike: FlaskConical,
  chore: Wrench,
}

const TYPE_ICON_CLASS: Record<TicketType, string> = {
  bug: 'text-danger',
  feature: 'text-info',
  spike: 'text-accent',
  chore: 'text-faint',
}

export function ticketTypeIcon(type: TicketType): LucideIcon {
  return TYPE_ICON[type]
}

export function ticketTypeIconClass(type: TicketType): string {
  return TYPE_ICON_CLASS[type]
}

export function ticketPriorityTone(priority: TicketPriority) {
  return TICKET_PRIORITY_TONE[priority]
}

export function TicketCard({
  ticket,
  latestRunStatus,
  onOpen,
  actions,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  moveOptions,
  moveOptionLabel,
  onMoveSelect,
}: {
  ticket: Ticket
  latestRunStatus?: RunStatus | null
  onOpen?: (ticket: Ticket) => void
  actions?: ReactNode
  draggable?: boolean
  dragging?: boolean
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd?: (e: DragEvent<HTMLDivElement>) => void
  moveOptions?: AllowedMove[]
  moveOptionLabel?: (move: AllowedMove) => string
  onMoveSelect?: (toStageId: string | null) => void
}) {
  const Icon = TYPE_ICON[ticket.type]
  const runHint = latestRunHint(ticket.status, latestRunStatus)
  const agent = assigneeLabel(ticket.assignee)
  const moves = moveOptions ?? ticket.allowedMoves ?? []
  return (
    <Card
      data-testid="ticket-card"
      data-ticket-id={ticket.id}
      padding="sm"
      interactive={!!onOpen}
      className={cn(
        'relative flex flex-col gap-2',
        draggable && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-50',
      )}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen ? () => onOpen(ticket) : undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen(ticket)
              }
            }
          : undefined
      }
    >
      {ticket.status === 'blocked' && (
        <span
          className="absolute right-0 top-0 rounded-bl-md rounded-tr-xl bg-danger px-1.5 py-0.5 text-caption font-medium text-white"
          title={ticket.blockedReason || TICKET_STATUS_LABEL.blocked}
        >
          受阻
        </span>
      )}
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-hover',
            TYPE_ICON_CLASS[ticket.type],
          )}
          title={TICKET_TYPE_LABEL[ticket.type]}
          aria-label={TICKET_TYPE_LABEL[ticket.type]}
        >
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-caption text-faint">{ticket.identifier}</span>
            {runHint === 'running' && (
              <span
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent"
                title="跑动中"
              />
            )}
            {runHint === 'failed' && (
              <span className="size-1.5 shrink-0 rounded-full bg-danger" title="最近执行失败" />
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 break-words text-body font-medium text-fg">
            {ticket.title}
          </p>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge tone={TICKET_TYPE_TONE[ticket.type]} size="sm">
          {TICKET_TYPE_LABEL[ticket.type]}
        </Badge>
        <Badge tone={TICKET_PRIORITY_TONE[ticket.priority]} size="sm">
          {ticket.priority}
        </Badge>
        <Badge tone={ticket.status === 'blocked' ? 'danger' : 'neutral'} size="sm">
          {TICKET_STATUS_LABEL[ticket.status]}
        </Badge>
        {agent && <span className="min-w-0 truncate text-caption text-muted">{agent}</span>}
      </div>
      {(moves.length > 0 || actions) && (
        <div
          className="flex min-w-0 flex-wrap items-center gap-1"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {moves.length > 0 && onMoveSelect && (
            <select
              aria-label="移动到…"
              data-testid="ticket-move-select"
              className="max-w-full truncate rounded-md border border-border bg-surface px-2 py-1 text-caption text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
              defaultValue=""
              onChange={(e) => {
                const raw = e.target.value
                e.target.value = ''
                if (!raw) return
                onMoveSelect(stageIdFromDropId(raw))
              }}
            >
              <option value="" disabled>
                移动到…
              </option>
              {moves.map((m) => (
                <option
                  key={`${m.action}:${dropIdForMove(m.toStageId)}`}
                  value={dropIdForMove(m.toStageId)}
                >
                  {moveOptionLabel ? moveOptionLabel(m) : m.label}
                </option>
              ))}
            </select>
          )}
          {actions}
        </div>
      )}
    </Card>
  )
}
