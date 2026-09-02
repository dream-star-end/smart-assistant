import { ChevronDown, ChevronRight, History, MessageSquare } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  RUN_STATUS_LABEL,
  RUN_TRIGGER_LABEL,
  type TicketComment,
  type TicketRun,
  type TimelineItem,
  assigneeLabel,
  formatActivityLine,
  formatDurationMs,
  formatRunCostUsd,
  isLongComment,
  partitionTimeline,
  skipReasonLabel,
} from '../../lib/taskboard'
import { Markdown } from '../Markdown'
import { Badge, Button, EmptyState, ListSkeleton, TimeAgo } from '../ui'

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
      className="text-body text-fg [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-hover [&_code]:px-1 [&_h1]:text-title [&_h2]:text-title [&_h3]:text-section [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_ul]:list-disc [&_ul]:pl-5"
    >
      <Markdown readOnly>{children}</Markdown>
    </div>
  )
}

function authorLabel(author: string, kind: string): string {
  const name = assigneeLabel(author) ?? author
  if (kind === 'human') return `${name} · 人`
  if (kind === 'agent') return `${name} · agent`
  return `${name} · 系统`
}

function DiscussionComment({ comment }: { comment: TicketComment }) {
  const long = isLongComment(comment.body)
  const [open, setOpen] = useState(false)
  const collapsed = long && !open
  const preview = collapsed ? `${comment.body.slice(0, 160).trimEnd()}…` : comment.body
  return (
    <li
      data-testid="ticket-timeline-item"
      data-kind="comment"
      className="rounded-lg border border-border bg-surface px-3 py-2"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-caption text-muted">
            {authorLabel(comment.author, comment.authorKind)}
          </span>
          <TimeAgo value={comment.createdAt} className="shrink-0 text-caption text-faint" />
        </div>
        <TicketMarkdown testId="ticket-comment-md">{preview}</TicketMarkdown>
        {long && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="ticket-comment-expand"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '收起' : '展开全文'}
          </Button>
        )}
      </div>
    </li>
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
}: {
  run: TicketRun
  stageName: string | null | undefined
}) {
  const duration = formatDurationMs(run.durationMs)
  const cost = formatRunCostUsd(run.costUsd)
  const costText = `${cost ?? '成本未记录'}${run.costImprecise ? '（不精确）' : ''}`
  const skip = skipReasonLabel(run.skipReason)
  const tokens =
    run.tokensIn == null && run.tokensOut == null
      ? null
      : `token ${run.tokensIn ?? '—'} / ${run.tokensOut ?? '—'}`
  return (
    <div className="flex flex-col gap-1.5" data-testid="ticket-run-detail">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={runStatusTone(run.status)} size="sm">
          {RUN_STATUS_LABEL[run.status] ?? run.status}
        </Badge>
        <span className="text-body text-fg">{stageName || '未知阶段'}</span>
        <span className="text-caption text-faint">
          {RUN_TRIGGER_LABEL[run.trigger] ?? run.trigger}
        </span>
        <TimeAgo value={run.createdAt} className="ml-auto text-caption text-faint" />
      </div>
      <p className="text-caption text-muted">
        {[duration ?? '耗时未记录', tokens ?? '用量未记录', costText].filter(Boolean).join(' · ')}
      </p>
      {skip && <p className="text-body text-warning">跳过：{skip}</p>}
      {(run.contextSha256 || run.contextVersion != null) && (
        <p className="text-caption text-muted" data-testid="ticket-run-context">
          快照 {run.contextSha256 ? run.contextSha256.slice(0, 12) : '—'} · 启动 v
          {run.contextVersion ?? '—'}
          。仅审计、不可逐字重放。
        </p>
      )}
      {(run.outputMd?.trim() || run.summary) && (
        <TicketMarkdown testId="ticket-run-md">
          {run.outputMd?.trim() || run.summary || ''}
        </TicketMarkdown>
      )}
      {run.error && <p className="whitespace-pre-wrap text-body text-danger">{run.error}</p>}
    </div>
  )
}

export function TicketTimeline({
  items,
  loading,
  stageName,
  stageById,
}: {
  items: TimelineItem[]
  loading: boolean
  stageName: string | null
  stageById: Map<string, string>
}) {
  const { discussion, system } = useMemo(() => partitionTimeline(items), [items])
  const [systemOpen, setSystemOpen] = useState(false)

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-3" data-testid="ticket-timeline">
      <section data-testid="ticket-discussion" className="flex flex-col gap-2">
        <p className="flex items-center gap-1.5 text-meta font-medium text-muted">
          <MessageSquare size={14} aria-hidden />
          讨论
        </p>
        {loading && items.length === 0 ? (
          <ListSkeleton rows={3} variant="row" />
        ) : discussion.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="还没有评论"
            hint="人和 agent 的讨论会出现在这里。"
          />
        ) : (
          <ol className="flex flex-col gap-2">
            {discussion.map((item) =>
              item.kind === 'comment' ? (
                <DiscussionComment key={item.comment.id} comment={item.comment} />
              ) : null,
            )}
          </ol>
        )}
      </section>

      <section data-testid="ticket-system-activity" className="flex flex-col gap-2">
        <button
          type="button"
          className="flex items-center gap-1.5 text-left text-meta font-medium text-muted"
          data-testid="ticket-system-toggle"
          aria-expanded={systemOpen}
          onClick={() => setSystemOpen((v) => !v)}
        >
          {systemOpen ? (
            <ChevronDown size={14} aria-hidden />
          ) : (
            <ChevronRight size={14} aria-hidden />
          )}
          <History size={14} aria-hidden />
          系统活动{system.length ? `（${system.length}）` : ''}
        </button>
        {systemOpen &&
          (system.length === 0 ? (
            <p className="text-caption text-faint">还没有状态变更或执行记录。</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {system.map((item) => (
                <li
                  key={`${item.kind}-${item.kind === 'run' ? item.run.id : item.activity.id}`}
                  data-testid="ticket-timeline-item"
                  data-kind={item.kind}
                  className="rounded-lg border border-border bg-hover px-3 py-2"
                >
                  {item.kind === 'activity' && (
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-body text-fg">{formatActivityLine(item.activity)}</p>
                      <TimeAgo
                        value={item.activity.createdAt}
                        className="shrink-0 text-caption text-faint"
                      />
                    </div>
                  )}
                  {item.kind === 'run' && (
                    <SystemRun
                      run={item.run}
                      stageName={stageById.get(item.run.stageId) ?? stageName}
                    />
                  )}
                </li>
              ))}
            </ol>
          ))}
      </section>
    </div>
  )
}
