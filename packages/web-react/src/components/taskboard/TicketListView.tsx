import { ListFilter, SlidersHorizontal, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useMdViewport } from '../../hooks/useMdViewport'
import {
  type BoardAgent,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_TONE,
  TICKET_STATUSES,
  TICKET_STATUS_LABEL,
  TICKET_TYPES,
  TICKET_TYPE_LABEL,
  type Ticket,
  type TicketListQuery,
  assigneeLabel,
} from '../../lib/taskboard'
import { cn } from '../../lib/utils'
import { Badge, Button, EmptyState, Input, Select, TimeAgo } from '../ui'
import { TicketCard, ticketTypeIcon, ticketTypeIconClass } from './TicketCard'

const PRIORITY_LABEL = {
  P0: 'P0 紧急',
  P1: 'P1 高',
  P2: 'P2 中',
  P3: 'P3 低',
} as const

export function TicketListView({
  tickets,
  query,
  agents,
  onQueryChange,
  onOpenTicket,
  renderActions,
  hideFilters = false,
}: {
  tickets: Ticket[]
  query: TicketListQuery
  agents?: BoardAgent[]
  onQueryChange: (next: TicketListQuery) => void
  onOpenTicket?: (ticket: Ticket) => void
  renderActions?: (ticket: Ticket) => ReactNode
  hideFilters?: boolean
}) {
  const desktop = useMdViewport()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const agentOptions = [
    { value: '', label: '全部执行者' },
    ...(agents ?? []).map((a) => ({ value: `agent:${a.id}`, label: a.name || a.id })),
  ]
  const activeFilters = [
    query.type,
    query.priority,
    query.status,
    query.assignee,
    query.label,
  ].filter(Boolean).length
  const clearFilters = () => {
    onQueryChange({ ...(query.q ? { q: query.q } : {}) })
    setFiltersOpen(false)
  }
  const advancedFilters = (
    <div
      id="ticket-list-advanced-filters"
      data-testid="ticket-list-advanced-filters"
      className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-end"
    >
      <Select
        aria-label="按类型筛选"
        className="w-full md:w-36"
        inputSize="sm"
        value={query.type ?? ''}
        onValueChange={(type) => onQueryChange({ ...query, type: type || undefined })}
        options={[
          { value: '', label: '全部类型' },
          ...TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABEL[t] })),
        ]}
      />
      <Select
        aria-label="按优先级筛选"
        className="w-full md:w-36"
        inputSize="sm"
        value={query.priority ?? ''}
        onValueChange={(priority) => onQueryChange({ ...query, priority: priority || undefined })}
        options={[
          { value: '', label: '全部优先级' },
          ...TICKET_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })),
        ]}
      />
      <Select
        aria-label="按状态筛选"
        className="w-full md:w-36"
        inputSize="sm"
        value={query.status ?? ''}
        onValueChange={(status) => onQueryChange({ ...query, status: status || undefined })}
        options={[
          { value: '', label: '全部状态' },
          ...TICKET_STATUSES.map((s) => ({ value: s, label: TICKET_STATUS_LABEL[s] })),
        ]}
      />
      <Select
        aria-label="按执行者筛选"
        className="w-full md:w-40"
        inputSize="sm"
        value={query.assignee ?? ''}
        onValueChange={(assignee) => onQueryChange({ ...query, assignee: assignee || undefined })}
        options={agentOptions}
      />
      <Input
        aria-label="按标签筛选"
        inputSize="sm"
        className="col-span-2 w-full md:w-36"
        placeholder="输入标签"
        value={query.label ?? ''}
        onChange={(e) => onQueryChange({ ...query, label: e.target.value || undefined })}
      />
      {activeFilters > 0 && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="col-span-2 justify-center md:col-span-1"
          onClick={clearFilters}
        >
          <X size={14} />
          清除筛选
        </Button>
      )}
    </div>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
      {hideFilters ? null : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              aria-label="搜索单据"
              inputSize="sm"
              className="min-w-0 flex-1"
              placeholder="搜索标题 / 编号"
              value={query.q ?? ''}
              onChange={(e) => onQueryChange({ ...query, q: e.target.value || undefined })}
            />
            {!desktop && (
              <Button
                type="button"
                size="sm"
                variant={filtersOpen || activeFilters > 0 ? 'secondary' : 'ghost'}
                aria-expanded={filtersOpen}
                aria-controls="ticket-list-advanced-filters"
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <SlidersHorizontal size={14} />
                筛选{activeFilters > 0 ? ` ${activeFilters}` : ''}
              </Button>
            )}
          </div>
          {(desktop || filtersOpen) && advancedFilters}
        </div>
      )}
      {tickets.length === 0 ? (
        <EmptyState
          icon={ListFilter}
          title="没有符合筛选的单据"
          hint="换一个类型、状态或执行者再看。周会过一遍时建议先清筛选。"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {desktop ? (
            <table className="w-full border-collapse text-left text-body">
              <thead className="sticky top-0 bg-bg text-caption text-faint">
                <tr>
                  <th className="px-2 py-2 font-medium">编号</th>
                  <th className="px-2 py-2 font-medium">标题</th>
                  <th className="px-2 py-2 font-medium">类型</th>
                  <th className="px-2 py-2 font-medium">优先级</th>
                  <th className="px-2 py-2 font-medium">状态</th>
                  <th className="px-2 py-2 font-medium">执行者</th>
                  <th className="px-2 py-2 font-medium">更新</th>
                  <th className="px-2 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => {
                  const Icon = ticketTypeIcon(ticket.type)
                  return (
                    <tr
                      key={ticket.id}
                      data-testid="ticket-card"
                      className={cn('border-t border-border', onOpenTicket && 'hover:bg-hover')}
                    >
                      <td className="px-2 py-2 font-mono text-caption text-faint">
                        {ticket.identifier}
                      </td>
                      <td className="max-w-[18rem] truncate px-2 py-2 font-medium text-fg">
                        {onOpenTicket ? (
                          <button
                            type="button"
                            className="truncate text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => onOpenTicket(ticket)}
                          >
                            {ticket.title}
                          </button>
                        ) : (
                          ticket.title
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <span className="inline-flex items-center gap-1">
                          <Icon size={13} className={ticketTypeIconClass(ticket.type)} />
                          {TICKET_TYPE_LABEL[ticket.type]}
                        </span>
                      </td>
                      <td className="px-2 py-2">
                        <Badge tone={TICKET_PRIORITY_TONE[ticket.priority]} size="sm">
                          {ticket.priority}
                        </Badge>
                      </td>
                      <td className="px-2 py-2">{TICKET_STATUS_LABEL[ticket.status]}</td>
                      <td className="max-w-[8rem] truncate px-2 py-2 text-muted">
                        {assigneeLabel(ticket.assignee) || '—'}
                      </td>
                      <td className="px-2 py-2 text-muted">
                        <TimeAgo value={ticket.updatedAt} format="short" />
                      </td>
                      <td className="px-2 py-2">{renderActions?.(ticket)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div className="flex flex-col gap-2" data-testid="ticket-list-cards">
              {tickets.map((ticket) => (
                <TicketCard
                  key={ticket.id}
                  ticket={ticket}
                  showUpdatedAt
                  onOpen={onOpenTicket}
                  actions={renderActions?.(ticket)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
