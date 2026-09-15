import { Bot, Bug, FlaskConical, Sparkles, UserCheck, Wrench } from 'lucide-react'
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

/**
 * 工单卡片。看板紧凑态(compact)与列表卡片态共用。
 *
 * 审计 T-09 / T-15 / T-24 之后的两条约定:
 * 1. 容器不再是 `role="button"`:里面还嵌着「批准」「更多操作」这些真按钮,读屏会把整张卡
 *    连同按钮文字念成一个按钮。现在**标题本身是按钮**(accessible name = 标题),承载键盘与
 *    读屏的打开动作;整卡点击仍然可用,只是不再给语义。拖拽属性留在容器上,标题按钮标了
 *    `data-drag-through`,BoardColumns 的 beginDrag 会放行它(其余按钮仍禁止起拖)。
 * 2. meta 行不再把徽章、人员、时间、操作塞进一行 `overflow-hidden` 让执行者截成「codin…」:
 *    紧凑态只留优先级 + 执行者(状态由列名表达,受阻另有角标);卡片态分成徽章行 / 人员行 /
 *    时间+操作行,人员带图标而不是「批准人 」前缀。
 */
export function TicketCard({
  ticket,
  latestRunStatus,
  onOpen,
  actions,
  compact,
  hideStatus = false,
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
  /** 所在列已经表达了状态(阶段列 / 积压列 / 待确认列)时隐藏状态徽章;受阻仍显示。 */
  hideStatus?: boolean
  showUpdatedAt?: boolean
  draggable?: boolean
  dragging?: boolean
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd?: (e: DragEvent<HTMLDivElement>) => void
}) {
  const Icon = TYPE_ICON[ticket.type] ?? Bug
  const runHint = latestRunHint(ticket.status, latestRunStatus)
  const agent = assigneeLabel(ticket.assignee)
  const approver =
    ticket.approvedBy && ticket.status !== 'backlog'
      ? (assigneeLabel(ticket.approvedBy) ?? ticket.approvedBy)
      : null
  const showStatus = !hideStatus || ticket.status === 'blocked'
  const titleClass = cn(ticket.status === 'canceled' && 'line-through')
  const title = (
    <p className="mt-0.5 line-clamp-2 break-words text-body font-medium text-fg">
      {onOpen ? (
        <button
          type="button"
          data-testid="ticket-open"
          data-drag-through="true"
          title={ticket.title}
          className={cn(
            'text-left outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring',
            titleClass,
          )}
          onClick={(e) => {
            e.stopPropagation()
            onOpen(ticket)
          }}
        >
          {ticket.title}
        </button>
      ) : (
        <span title={ticket.title} className={titleClass || undefined}>
          {ticket.title}
        </span>
      )}
    </p>
  )
  const people =
    agent || approver ? (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted">
        {agent && (
          <span data-testid="ticket-assignee" className="inline-flex min-w-0 items-center gap-1">
            <Bot size={12} className="shrink-0 text-faint" aria-hidden />
            <span className="sr-only">{'执行者 '}</span>
            <span className="truncate" title={agent}>
              {agent}
            </span>
          </span>
        )}
        {approver && (
          <span data-testid="ticket-approver" className="inline-flex min-w-0 items-center gap-1">
            <UserCheck size={12} className="shrink-0 text-faint" aria-hidden />
            <span className="sr-only">{'批准人 '}</span>
            <span className="truncate" title={approver}>
              {approver}
            </span>
          </span>
        )}
      </div>
    ) : null
  const actionSlot = actions ? (
    <div
      className="flex shrink-0 items-center gap-0.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {actions}
    </div>
  ) : null
  return (
    <Card
      data-testid="ticket-card"
      data-ticket-id={ticket.id}
      padding="sm"
      interactive={!!onOpen}
      className={cn(
        'relative flex flex-col',
        compact ? 'gap-1.5 p-2' : 'gap-2',
        (ticket.status === 'canceled' || ticket.status === 'done') && 'opacity-60',
        draggable && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-50',
      )}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen ? () => onOpen(ticket) : undefined}
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
          aria-hidden
        >
          <Icon size={compact ? 12 : 14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-caption text-faint">{ticket.identifier}</span>
            {/* 紧凑态没有类型徽章,类型只靠图标表达 —— 给读屏补一份文字;卡片态由徽章承载,不重复。 */}
            {compact && <span className="sr-only">{TICKET_TYPE_LABEL[ticket.type]}</span>}
            {runHint === 'running' && (
              <span
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent"
                title="执行中"
              />
            )}
            {runHint === 'failed' && (
              <span className="size-1.5 shrink-0 rounded-full bg-danger" title="最近执行失败" />
            )}
          </div>
          {title}
        </div>
      </div>
      {compact ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge tone={TICKET_PRIORITY_TONE[ticket.priority]} size="sm" className="shrink-0">
            {ticket.priority}
          </Badge>
          {showStatus && (
            <Badge
              tone={ticket.status === 'blocked' ? 'danger' : 'neutral'}
              size="sm"
              className="shrink-0"
            >
              {TICKET_STATUS_LABEL[ticket.status]}
            </Badge>
          )}
          <div className="min-w-0 flex-1">{people}</div>
          {actionSlot}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={TICKET_TYPE_TONE[ticket.type]} size="sm">
              {TICKET_TYPE_LABEL[ticket.type]}
            </Badge>
            <Badge tone={TICKET_PRIORITY_TONE[ticket.priority]} size="sm">
              {ticket.priority}
            </Badge>
            {showStatus && (
              <Badge tone={ticket.status === 'blocked' ? 'danger' : 'neutral'} size="sm">
                {TICKET_STATUS_LABEL[ticket.status]}
              </Badge>
            )}
          </div>
          {people}
          {(showUpdatedAt || actionSlot) && (
            <div className="flex min-w-0 items-center justify-between gap-1.5">
              {showUpdatedAt ? (
                <TimeAgo
                  value={ticket.updatedAt}
                  format="short"
                  className="shrink-0 text-caption text-faint"
                />
              ) : (
                <span />
              )}
              {actionSlot}
            </div>
          )}
        </>
      )}
    </Card>
  )
}
