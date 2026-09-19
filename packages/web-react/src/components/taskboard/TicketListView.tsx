import { ListFilter, Plus, SlidersHorizontal, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useMdViewport } from '../../hooks/useMdViewport'
import {
  ACTIVE_LIST_STATUSES,
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

/** 搜索 / 标签输入到真正发请求的等待时间(毫秒)。 */
export const LIST_QUERY_DEBOUNCE_MS = 300

/** 状态筛选的默认值 = 只看在途;它不算「用户加的筛选」。 */
export function isDefaultStatusFilter(status: string | undefined): boolean {
  return status === ACTIVE_LIST_STATUSES
}

/** 默认视图之外、用户主动加的筛选项个数(供「筛选 N」与「清除筛选」使用)。 */
export function countActiveFilters(query: TicketListQuery): number {
  return [
    query.type,
    query.priority,
    isDefaultStatusFilter(query.status) ? undefined : 'status',
    query.assignee,
    query.label,
  ].filter(Boolean).length
}

/**
 * 单据列表:桌面表格 / 移动卡片 + 筛选。
 *
 * 审计 T-04 / T-13 / T-16 ④ / T-17 之后的约定:
 * - 状态下拉有显式的「在途(默认)」与「全部状态(含已完成 / 已取消)」两项。默认值不计入
 *   「筛选 N」,「清除筛选」恢复到默认在途而不是删掉 status 让终态单突然涌进来。
 * - 搜索 / 标签输入本地即时回显,停顿 300ms 才发一次请求;中文输入法组合期间不发。
 * - 空态区分「项目还没有单据」「没有在途单据」「筛选没命中」三种情况,各给下一步。
 */
export function TicketListView({
  tickets,
  query,
  agents,
  onQueryChange,
  onOpenTicket,
  renderActions,
  hideFilters = false,
  total,
  loadedCount,
  onLoadMore,
  loadingMore = false,
  onCreateTicket,
}: {
  tickets: Ticket[]
  query: TicketListQuery
  agents?: BoardAgent[]
  onQueryChange: (next: TicketListQuery) => void
  onOpenTicket?: (ticket: Ticket) => void
  renderActions?: (ticket: Ticket) => ReactNode
  hideFilters?: boolean
  total?: number
  /** Number loaded before client-side filtering; pagination is not based on visible rows. */
  loadedCount?: number
  onLoadMore?: () => void
  loadingMore?: boolean
  /** 空态里「新建单据」的入口。 */
  onCreateTicket?: () => void
}) {
  const desktop = useMdViewport()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const agentOptions = [
    { value: '', label: '全部执行者' },
    ...(agents ?? []).map((a) => ({ value: `agent:${a.id}`, label: a.name || a.id })),
  ]
  const activeFilters = countActiveFilters(query)
  const clearFilters = () => {
    onQueryChange({ ...(query.q ? { q: query.q } : {}), status: ACTIVE_LIST_STATUSES })
    setFiltersOpen(false)
  }

  // ── 搜索 / 标签:本地草稿 + debounce ──────────────────────────────────────
  const [qDraft, setQDraft] = useState(query.q ?? '')
  const [labelDraft, setLabelDraft] = useState(query.label ?? '')
  const queryRef = useRef(query)
  queryRef.current = query
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<Partial<TicketListQuery>>({})
  const composingRef = useRef(false)
  useEffect(() => {
    setQDraft(query.q ?? '')
  }, [query.q])
  useEffect(() => {
    setLabelDraft(query.label ?? '')
  }, [query.label])
  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    },
    [],
  )
  const flushPending = () => {
    timerRef.current = null
    const patch = pendingRef.current
    pendingRef.current = {}
    if (Object.keys(patch).length === 0) return
    onQueryChange({ ...queryRef.current, ...patch })
  }
  const scheduleQuery = (patch: Partial<TicketListQuery>) => {
    pendingRef.current = { ...pendingRef.current, ...patch }
    if (composingRef.current) return
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(flushPending, LIST_QUERY_DEBOUNCE_MS)
  }
  const compositionHandlers = {
    onCompositionStart: () => {
      composingRef.current = true
    },
    onCompositionEnd: () => {
      composingRef.current = false
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(flushPending, LIST_QUERY_DEBOUNCE_MS)
    },
  }

  const statusValue = query.status ?? ''
  const statusOptions = [
    { value: ACTIVE_LIST_STATUSES, label: '在途（默认）' },
    ...TICKET_STATUSES.map((s) => ({ value: s, label: TICKET_STATUS_LABEL[s] })),
    { value: '', label: '全部状态（含已完成 / 已取消）' },
  ]

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
        className="w-full md:w-44"
        inputSize="sm"
        value={statusValue}
        onValueChange={(status) => onQueryChange({ ...query, status: status || undefined })}
        options={statusOptions}
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
        value={labelDraft}
        onChange={(e) => {
          setLabelDraft(e.target.value)
          scheduleQuery({ label: e.target.value || undefined })
        }}
        {...compositionHandlers}
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

  const renderEmpty = () => {
    const searching = !!query.q
    if (activeFilters === 0 && !searching) {
      // 默认视图下什么都没有:项目里没有在途单,或者压根还没有单。
      return (
        <EmptyState
          icon={ListFilter}
          title={isDefaultStatusFilter(query.status) ? '没有在途的单据' : '这个项目还没有单据'}
          hint={
            isDefaultStatusFilter(query.status)
              ? '已完成 / 已取消的单在状态筛选里选「全部状态」可以看到；也可以直接新建一条。'
              : '新建第一条单据后，它会出现在这里。'
          }
          action={
            onCreateTicket ? (
              <Button type="button" data-testid="list-empty-create" onClick={onCreateTicket}>
                <Plus size={14} />
                {isDefaultStatusFilter(query.status) ? '新建一条单据' : '新建第一条单据'}
              </Button>
            ) : undefined
          }
        />
      )
    }
    return (
      <EmptyState
        icon={ListFilter}
        title="没有符合筛选的单据"
        hint="换一个类型、状态或执行者再看；也可以一键清除筛选回到在途视图。"
        action={
          <Button type="button" variant="secondary" onClick={clearFilters}>
            <X size={14} />
            清除筛选
          </Button>
        }
      />
    )
  }

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
              value={qDraft}
              onChange={(e) => {
                setQDraft(e.target.value)
                scheduleQuery({ q: e.target.value || undefined })
              }}
              {...compositionHandlers}
            />
            {!desktop && (
              <Button
                type="button"
                size="sm"
                variant={filtersOpen || activeFilters > 0 ? 'secondary' : 'ghost'}
                aria-expanded={filtersOpen}
                // 面板收起时不落 aria-controls:指向不存在的节点在读屏上是静默失败(审计 T-17)。
                aria-controls={filtersOpen ? 'ticket-list-advanced-filters' : undefined}
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
        renderEmpty()
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
                  <th className="px-2 py-2 font-medium">
                    <span className="sr-only">操作</span>
                  </th>
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
                          <Icon size={13} className={ticketTypeIconClass(ticket.type)} aria-hidden />
                          {TICKET_TYPE_LABEL[ticket.type]}
                        </span>
                      </td>
                      <td className="px-2 py-2">
                        <Badge tone={TICKET_PRIORITY_TONE[ticket.priority]} size="sm">
                          {ticket.priority}
                        </Badge>
                      </td>
                      <td className="px-2 py-2">{TICKET_STATUS_LABEL[ticket.status]}</td>
                      <td className="max-w-[10rem] truncate px-2 py-2 text-muted">
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
      {typeof total === 'number' && total > (loadedCount ?? tickets.length) && (
        <div
          data-testid="ticket-list-truncated"
          className="mt-3 flex flex-wrap items-center justify-between gap-2 text-caption text-muted"
        >
          <p>
            {loadedCount == null ? '已显示' : '已加载'} {loadedCount ?? tickets.length} / {total} 条
          </p>
          {onLoadMore ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="ticket-list-load-more"
              loading={loadingMore}
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              继续加载
            </Button>
          ) : (
            <p>列表超过一页，请继续加载查看后续单据。</p>
          )}
        </div>
      )}
    </div>
  )
}
