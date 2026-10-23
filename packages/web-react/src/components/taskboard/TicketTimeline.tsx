import { ArrowLeftRight, BadgeCheck, Flag, History, MessageSquare, Play } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  RUN_STATUS_LABEL,
  RUN_TRIGGER_LABEL,
  type TicketComment,
  type TicketRun,
  type TimelineItem,
  assigneeLabel,
  formatActivityLine,
  formatDurationMs,
  formatRunReferenceCost,
  skipReasonLabel,
} from '../../lib/taskboard'
import {
  TIMELINE_FILTERS,
  type TicketTimelineFilter,
  type TicketTimelineGroup,
  type TicketTimelineKind,
  type TicketTimelineNode,
  buildTicketTimeline,
  formatShanghaiAbsolute,
  formatTimelineTime,
  isTimelineCommentLong,
  timelineAuthorLabel,
  timelineSourcesFromItems,
} from '../../lib/ticketTimeline'
import { Markdown } from '../Markdown'
import { Badge, Button, ListSkeleton } from '../ui'

function TicketMarkdown({
  children,
  testId,
}: {
  children: string
  testId?: string
}) {
  return (
    <div
      data-testid={testId}
      className="min-w-0 max-w-full text-body text-fg break-words [&_.prose]:max-w-full [&_.prose]:text-body! [&_.prose_h1]:mt-3! [&_.prose_h1]:mb-1! [&_.prose_h1]:text-section! [&_.prose_h2]:mt-3! [&_.prose_h2]:mb-1! [&_.prose_h2]:text-section! [&_.prose_h3]:mt-2! [&_.prose_h3]:mb-1! [&_.prose_h3]:text-body! [&_a]:break-all [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-hover [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_ul]:list-disc [&_ul]:pl-5"
    >
      <Markdown readOnly>{children}</Markdown>
    </div>
  )
}

/** 抽屉里乐观插入、还没拿到服务端回执的评论 id 前缀(见 TicketDrawer.submitComment)。 */
export const LOCAL_COMMENT_ID_PREFIX = 'local-'

export function isLocalComment(comment: Pick<TicketComment, 'id'>): boolean {
  return comment.id.startsWith(LOCAL_COMMENT_ID_PREFIX)
}

const FILTER_LABEL: Record<TicketTimelineFilter, string> = {
  all: '全部',
  comment: '评论',
  status: '状态',
  run: '执行',
}

function useNow(refreshMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (refreshMs <= 0) return
    const timer = setInterval(() => setNow(Date.now()), refreshMs)
    return () => clearInterval(timer)
  }, [refreshMs])
  return now
}

function kindLabel(kind: TicketTimelineKind): string {
  if (kind === 'comment') return '评论'
  if (kind === 'approval') return '审批'
  if (kind === 'status') return '状态变更'
  if (kind === 'run_start') return '开始执行'
  if (kind === 'run_end') return '执行结束'
  return '动态'
}

function dotClass(node: TicketTimelineNode): string {
  if (node.kind === 'comment') return 'border-accent bg-accent-soft text-accent'
  if (node.kind === 'approval') return 'border-success bg-success-soft text-success'
  if (node.kind === 'status') return 'border-warning bg-warning-soft text-warning'
  if (node.kind === 'run_start') return 'border-info bg-info-soft text-info'
  if (node.kind === 'run_end') {
    const status = node.run?.status
    if (status === 'failed' || status === 'timeout') return 'border-danger bg-danger-soft text-danger'
    if (status === 'skipped') return 'border-warning bg-warning-soft text-warning'
    if (status === 'succeeded') return 'border-success bg-success-soft text-success'
    return 'border-info bg-info-soft text-info'
  }
  return 'border-border bg-hover text-muted'
}

function KindIcon({ kind }: { kind: TicketTimelineKind }) {
  const props = { size: 12, 'aria-hidden': true as const }
  if (kind === 'comment') return <MessageSquare {...props} />
  if (kind === 'approval') return <BadgeCheck {...props} />
  if (kind === 'status') return <ArrowLeftRight {...props} />
  if (kind === 'run_start') return <Play {...props} />
  if (kind === 'run_end') return <Flag {...props} />
  return <History {...props} />
}

function authorChipClass(kind: string): string {
  if (kind === 'agent') return 'bg-accent-soft text-accent'
  if (kind === 'human') return 'bg-hover text-fg'
  return 'bg-hover text-muted'
}

function authorChipText(kind: string): string {
  if (kind === 'agent') return 'agent'
  if (kind === 'human') return '人'
  return '系统'
}

function TimelineTime({
  value,
  title,
  pending,
  now,
}: {
  value: number
  title: string
  pending: boolean
  now: number
}) {
  if (pending) return <span className="shrink-0 text-caption text-faint">发送中…</span>
  return (
    <time
      dateTime={new Date(value).toISOString()}
      title={title}
      className="shrink-0 cursor-default text-caption text-faint tabular-nums"
    >
      {formatTimelineTime(value, now)}
      <span className="sr-only">（{title}）</span>
    </time>
  )
}

function stageText(
  node: TicketTimelineNode,
  stageById: Map<string, string>,
  stageName: string | null,
): string | null {
  if (node.stageId) {
    const named = stageById.get(node.stageId)
    if (named) return named
    if (node.run && stageName) return stageName
  } else if (node.run && stageName) {
    return stageName
  }
  if (node.stageHint && !node.stageId) return node.stageHint
  return null
}

/** max-h-40 = 10rem = 160px。超过这个渲染高度才折叠。 */
const COLLAPSE_MAX_PX = 160

function MeasuredCollapse({
  signature,
  fallbackLong,
  children,
}: {
  signature: string
  fallbackLong: boolean
  children: ReactNode
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(fallbackLong)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setOpen(false)
    const el = contentRef.current
    if (!el) return
    const measure = () => {
      const height = el.scrollHeight
      // jsdom 没有布局，scrollHeight 为 0，回落到按显示宽度估算。
      setOverflows(height > 0 ? height > COLLAPSE_MAX_PX : fallbackLong)
    }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [signature, fallbackLong])

  const collapsed = overflows && !open
  return (
    <div className="min-w-0">
      <div className={collapsed ? 'relative max-h-40 overflow-hidden' : 'relative min-w-0'}>
        <div ref={contentRef}>{children}</div>
        {collapsed && (
          <div
            aria-hidden
            data-testid="ticket-comment-fade"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-elevated to-transparent md:from-sidebar"
          />
        )}
      </div>
      {overflows && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="ticket-comment-expand"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '收起' : '展开'}
        </Button>
      )}
    </div>
  )
}

function CollapsibleMarkdown({
  body,
  testId,
}: {
  body: string
  testId?: string
}) {
  return (
    <MeasuredCollapse signature={body} fallbackLong={isTimelineCommentLong(body)}>
      <TicketMarkdown testId={testId}>{body}</TicketMarkdown>
    </MeasuredCollapse>
  )
}

function runStatusTone(status: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'timeout') return 'danger'
  if (status === 'skipped') return 'warning'
  if (status === 'running' || status === 'queued') return 'info'
  return 'neutral'
}

function SystemRun({
  run,
  stageName,
  compact,
}: {
  run: TicketRun
  stageName: string | null | undefined
  compact: boolean
}) {
  const duration = formatDurationMs(run.durationMs)
  const costText = formatRunReferenceCost(run)
  const skip = skipReasonLabel(run.skipReason)
  const tokens =
    run.tokensIn == null && run.tokensOut == null
      ? null
      : `token ${run.tokensIn ?? '—'} / ${run.tokensOut ?? '—'}`
  if (compact) {
    return (
      <div className="min-w-0" data-testid="ticket-run-detail">
        <p className="text-caption text-muted">
          {RUN_TRIGGER_LABEL[run.trigger] ?? run.trigger} · 开始执行
        </p>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="ticket-run-detail">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={runStatusTone(run.status)} size="sm">
          {RUN_STATUS_LABEL[run.status] ?? run.status}
        </Badge>
        <span className="text-body text-fg">{stageName || '未知阶段'}</span>
        <span className="text-caption text-faint">
          {RUN_TRIGGER_LABEL[run.trigger] ?? run.trigger}
        </span>
      </div>
      <p className="text-caption text-muted break-words">
        {[duration ?? '耗时未记录', tokens ?? '用量未记录', costText].filter(Boolean).join(' · ')}
      </p>
      {skip && <p className="text-body text-warning">跳过：{skip}</p>}
      {(run.contextSha256 || run.contextVersion != null) && (
        <details className="text-caption text-muted" data-testid="ticket-run-context">
          <summary className="cursor-pointer select-none text-faint [@media(hover:none)]:py-3.5">
            执行时的项目信息快照
          </summary>
          <p className="mt-1 break-words">
            这次执行带上的项目信息版本 v{run.contextVersion ?? '—'}
            {run.contextSha256 ? `（指纹 ${run.contextSha256.slice(0, 12)}）` : ''}
            。快照只用于事后对照，不能逐字还原当时的输入。
          </p>
        </details>
      )}
      {(run.outputMd?.trim() || run.summary) && (
        <CollapsibleMarkdown
          testId="ticket-run-md"
          body={run.outputMd?.trim() || run.summary || ''}
        />
      )}
      {run.error && (
        <p className="break-words whitespace-pre-wrap text-body text-danger">{run.error}</p>
      )}
    </div>
  )
}

function CommentBody({
  comment,
  measured = true,
}: {
  comment: TicketComment
  /** 同组多条评论由外层一起量高度，这里不再各折一次。 */
  measured?: boolean
}) {
  const pending = isLocalComment(comment)
  return (
    <div
      data-testid="ticket-timeline-item"
      data-kind="comment"
      data-pending={pending ? 'true' : undefined}
      className={`min-w-0 ${pending ? 'opacity-70' : ''}`}
    >
      {measured ? (
        <CollapsibleMarkdown testId="ticket-comment-md" body={comment.body} />
      ) : (
        <TicketMarkdown testId="ticket-comment-md">{comment.body}</TicketMarkdown>
      )}
    </div>
  )
}

function activityText(node: TicketTimelineNode): string {
  if (!node.activity) return kindLabel(node.kind)
  const line = formatActivityLine(node.activity)
  const who = assigneeLabel(node.activity.actorId) ?? node.activity.actor
  if (who !== 'unidentified' || !line.startsWith('unidentified')) return line
  const label = timelineAuthorLabel(node.author, node.authorKind)
  return `${label}${line.slice('unidentified'.length)}`
}

function NodeBody({
  node,
  stageById,
  stageName,
}: {
  node: TicketTimelineNode
  stageById: Map<string, string>
  stageName: string | null
}) {
  if (node.kind === 'comment' && node.comment) return <CommentBody comment={node.comment} />
  if (node.run) {
    return (
      <div data-testid="ticket-timeline-item" data-kind={node.kind} className="min-w-0">
        <SystemRun
          run={node.run}
          stageName={stageText(node, stageById, stageName)}
          compact={node.runPhase === 'start'}
        />
      </div>
    )
  }
  return (
    <div data-testid="ticket-timeline-item" data-kind={node.kind} className="min-w-0">
      <p className="text-body text-fg break-words">
        {activityText(node)}
      </p>
    </div>
  )
}

function GroupHeader({
  group,
  stageById,
  stageName,
  now,
}: {
  group: TicketTimelineGroup
  stageById: Map<string, string>
  stageName: string | null
  now: number
}) {
  const first = group.nodes[0]
  const last = group.nodes[group.nodes.length - 1]
  if (!first || !last) return null
  const pending = group.nodes.some((node) => node.comment && isLocalComment(node.comment))
  const startAbs = formatShanghaiAbsolute(first.createdAt)
  const endAbs = formatShanghaiAbsolute(last.createdAt)
  const title = startAbs === endAbs ? startAbs : `${startAbs} – ${endAbs}`
  const stage = stageText(first, stageById, stageName)
  return (
    <div className="flex min-w-0 items-start justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-caption font-medium text-fg">{kindLabel(first.kind)}</span>
        <span className="inline-flex min-w-0 items-center gap-1">
          <span className="max-w-40 truncate text-caption text-muted">
            {timelineAuthorLabel(first.author, first.authorKind, pending)}
          </span>
          <span
            className={`shrink-0 rounded px-1 text-caption ${authorChipClass(first.authorKind)}`}
          >
            {authorChipText(first.authorKind)}
          </span>
        </span>
        {stage && (
          <Badge tone="neutral" size="sm">
            {stage}
          </Badge>
        )}
      </div>
      <TimelineTime value={last.createdAt} title={title} pending={pending} now={now} />
    </div>
  )
}

function stackedCommentSignature(group: TicketTimelineGroup): string | null {
  if (group.nodes.length < 2) return null
  if (!group.nodes.every((node) => node.kind === 'comment' && node.comment)) return null
  return group.nodes.map((node) => node.comment?.body ?? '').join('\n')
}

function GroupBodies({
  group,
  stageById,
  stageName,
}: {
  group: TicketTimelineGroup
  stageById: Map<string, string>
  stageName: string | null
}) {
  const stacked = stackedCommentSignature(group)
  if (stacked) {
    return (
      <div className="mt-1 min-w-0">
        <MeasuredCollapse signature={stacked} fallbackLong={isTimelineCommentLong(stacked)}>
          <div className="flex min-w-0 flex-col gap-2">
            {group.nodes.map((node) =>
              node.comment ? (
                <CommentBody key={node.id} comment={node.comment} measured={false} />
              ) : null,
            )}
          </div>
        </MeasuredCollapse>
      </div>
    )
  }
  return (
    <div className="mt-1 flex min-w-0 flex-col gap-2">
      {group.nodes.map((node) => (
        <NodeBody key={node.id} node={node} stageById={stageById} stageName={stageName} />
      ))}
    </div>
  )
}

function TimelineGroupView({
  group,
  stageById,
  stageName,
  now,
  isFirst,
  isLast,
}: {
  group: TicketTimelineGroup
  stageById: Map<string, string>
  stageName: string | null
  now: number
  isFirst: boolean
  isLast: boolean
}) {
  const head = group.nodes[0]
  if (!head) return null
  const lineClass = isFirst && isLast ? 'hidden' : isFirst ? 'top-3 bottom-0' : isLast ? 'top-0 h-3' : 'inset-y-0'
  return (
    <li data-testid="ticket-timeline-group" className="relative flex gap-3">
      <div className="relative w-6 shrink-0">
        <span className={`absolute left-1/2 w-px -translate-x-1/2 bg-border ${lineClass}`} aria-hidden />
        <span
          className={`relative z-10 mt-0.5 flex h-6 w-6 items-center justify-center rounded-full border ${dotClass(head)}`}
          title={kindLabel(head.kind)}
        >
          <KindIcon kind={head.kind} />
        </span>
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <GroupHeader group={group} stageById={stageById} stageName={stageName} now={now} />
        <GroupBodies group={group} stageById={stageById} stageName={stageName} />
      </div>
    </li>
  )
}

export function TicketTimeline({
  items,
  loading,
  stageName,
  stageById,
  composer,
}: {
  items: TimelineItem[]
  loading: boolean
  stageName: string | null
  stageById: Map<string, string>
  /** 评论输入区。放在时间线末尾，发表后新评论排在旧→新的最后。 */
  composer?: ReactNode
}) {
  const [filter, setFilter] = useState<TicketTimelineFilter>('all')
  const now = useNow()
  const endRef = useRef<HTMLDivElement>(null)
  const seenLocal = useRef(new Set<string>())
  const model = useMemo(() => {
    const sources = timelineSourcesFromItems(items)
    return buildTicketTimeline(sources.comments, sources.runs, sources.events, { filter })
  }, [filter, items])

  useEffect(() => {
    let fresh = false
    for (const item of items) {
      if (item.kind !== 'comment' || !isLocalComment(item.comment)) continue
      if (seenLocal.current.has(item.comment.id)) continue
      seenLocal.current.add(item.comment.id)
      fresh = true
    }
    if (!fresh) return
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [items])

  const emptyText =
    filter === 'all'
      ? '还没有评论或动态。你可以在下方先写一条。'
      : '这个筛选下还没有记录。'

  return (
    <div
      className="flex min-w-0 max-w-full shrink-0 flex-col gap-3 overflow-x-hidden border-t border-border pt-3"
      data-testid="ticket-timeline"
      data-filter={filter}
    >
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="时间线筛选">
        {TIMELINE_FILTERS.map((id) => {
          const selected = filter === id
          const count = model.counts[id]
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`ticket-timeline-filter-${id}`}
              className={`rounded-full border px-2.5 py-1 text-caption [@media(hover:none)]:min-h-11 ${
                selected
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border bg-surface text-muted'
              }`}
              onClick={() => setFilter(id)}
            >
              {FILTER_LABEL[id]}
              {count ? ` ${count}` : ''}
            </button>
          )
        })}
        <button
          type="button"
          data-testid="ticket-timeline-jump"
          className="ml-auto rounded-full px-2.5 py-1 text-caption text-accent [@media(hover:none)]:min-h-11"
          onClick={() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}
        >
          跳到最新
        </button>
      </div>

      {loading && items.length === 0 ? (
        <ListSkeleton rows={3} variant="row" />
      ) : model.groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-caption text-muted">
          {emptyText}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0" aria-label="单据时间线">
          {model.groups.map((group, index) => (
            <TimelineGroupView
              key={group.id}
              group={group}
              stageById={stageById}
              stageName={stageName}
              now={now}
              isFirst={index === 0}
              isLast={index === model.groups.length - 1}
            />
          ))}
        </ol>
      )}
      <div ref={endRef} className="min-w-0">
        {composer}
      </div>
    </div>
  )
}
