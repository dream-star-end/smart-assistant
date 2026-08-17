import { Bug, FlaskConical, Sparkles, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
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
import { Badge, Card } from '../ui'

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
}: {
  ticket: Ticket
  latestRunStatus?: RunStatus | null
  onOpen?: (ticket: Ticket) => void
  actions?: ReactNode
}) {
  const Icon = TYPE_ICON[ticket.type]
  const runHint = latestRunHint(ticket.status, latestRunStatus)
  const agent = assigneeLabel(ticket.assignee)
  return (
    <Card
      data-testid="ticket-card"
      padding="sm"
      interactive={!!onOpen}
      className="relative flex flex-col gap-2"
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
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
          <p className="mt-0.5 line-clamp-2 text-body font-medium text-fg">{ticket.title}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={TICKET_TYPE_TONE[ticket.type]} size="sm">
          {TICKET_TYPE_LABEL[ticket.type]}
        </Badge>
        <Badge tone={TICKET_PRIORITY_TONE[ticket.priority]} size="sm">
          {ticket.priority}
        </Badge>
        <Badge tone={ticket.status === 'blocked' ? 'danger' : 'neutral'} size="sm">
          {TICKET_STATUS_LABEL[ticket.status]}
        </Badge>
        {agent && <span className="truncate text-caption text-muted">{agent}</span>}
      </div>
      {actions && (
        <div
          className="flex flex-wrap gap-1"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {actions}
        </div>
      )}
    </Card>
  )
}
