import { Bug, FlaskConical, Sparkles, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { DragEvent, ReactNode } from 'react'
import {
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
import { Badge, Card, TimeAgo } from '../ui'

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
  compact,
  showUpdatedAt = false,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  ticket: Ticket
  latestRunStatus?: RunStatus | null
  onOpen?: (ticket: Ticket) => void
  actions?: ReactNode
  compact?: boolean
  showUpdatedAt?: boolean
  draggable?: boolean
  dragging?: boolean
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd?: (e: DragEvent<HTMLDivElement>) => void
}) {
  const Icon = TYPE_ICON[ticket.type]
  const runHint = latestRunHint(ticket.status, latestRunStatus)
  const agent = assigneeLabel(ticket.assignee)
  return (
    <Card
      data-testid="ticket-card"
      data-ticket-id={ticket.id}
      padding="sm"
      interactive={!!onOpen}
      className={cn(
        'relative flex flex-col',
        compact ? 'gap-1 p-2' : 'gap-2',
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
            'mt-0.5 flex shrink-0 items-center justify-center rounded-lg bg-hover',
            compact ? 'size-6' : 'size-7',
            TYPE_ICON_CLASS[ticket.type],
          )}
          title={TICKET_TYPE_LABEL[ticket.type]}
          aria-label={TICKET_TYPE_LABEL[ticket.type]}
        >
          <Icon size={compact ? 12 : 14} />
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
          <p
            title={ticket.title}
            className={cn(
              'mt-0.5 break-words text-body font-medium text-fg',
              compact ? 'line-clamp-1' : 'line-clamp-2',
            )}
          >
            {ticket.title}
          </p>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {!compact && (
            <Badge tone={TICKET_TYPE_TONE[ticket.type]} size="sm">
              {TICKET_TYPE_LABEL[ticket.type]}
            </Badge>
          )}
          <Badge tone={TICKET_PRIORITY_TONE[ticket.priority]} size="sm">
            {ticket.priority}
          </Badge>
          <Badge
            tone={ticket.status === 'blocked' ? 'danger' : 'neutral'}
            size="sm"
            className="max-w-[6rem] truncate"
            title={TICKET_STATUS_LABEL[ticket.status]}
          >
            {TICKET_STATUS_LABEL[ticket.status]}
          </Badge>
          {agent && (
            <span
              data-testid="ticket-assignee"
              className="min-w-0 truncate text-caption text-muted"
              title={agent}
            >
              {agent}
            </span>
          )}
          {showUpdatedAt && (
            <TimeAgo
              value={ticket.updatedAt}
              format="short"
              className="ml-auto shrink-0 text-caption text-faint"
            />
          )}
        </div>
        {actions ? (
          <div
            className="flex shrink-0 items-center gap-0.5"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </Card>
  )
}
