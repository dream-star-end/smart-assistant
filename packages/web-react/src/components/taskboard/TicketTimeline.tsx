import { ChevronDown, ChevronRight, History, MessageSquare } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
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
  isLongComment,
  partitionTimeline,
  skipReasonLabel,
} from '../../lib/taskboard'
import { Markdown } from '../Markdown'
import { Badge, Button, ListSkeleton, TimeAgo } from '../ui'

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
      className="text-body text-fg [&_.prose]:text-body! [&_.prose_h1]:text-section! [&_.prose_h1]:mt-3! [&_.prose_h1]:mb-1! [&_.prose_h2]:text-section! [&_.prose_h2]:mt-3! [&_.prose_h2]:mb-1! [&_.prose_h3]:text-body! [&_.prose_h3]:mt-2! [&_.prose_h3]:mb-1! [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-hover [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_ul]:list-disc [&_ul]:pl-5"
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

function authorLabel(author: string, kind: string, pending = false): string {
  // 乐观评论此刻还不知道服务端会记成谁,写「我」而不是把占位的 user:default 念成「default」。
  const name = pending && kind === 'human' ? '我' : (assigneeLabel(author) ?? author)
  if (kind === 'human') return `${name} · 人`
  if (kind === 'agent') return `${name} · agent`
  return `${name} · 系统`
}

function DiscussionComment({ comment }: { comment: TicketComment }) {
  const long = isLongComment(comment.body)
  const [open, setOpen] = useState(false)
  const collapsed = long && !open
  const preview = collapsed ? `${comment.body.slice(0, 160).trimEnd()}…` : comment.body
  const pending = isLocalComment(comment)
  return (
    <li
      data-testid="ticket-timeline-item"
      data-kind="comment"
      data-pending={pending ? 'true' : undefined}
      className={`rounded-lg border border-border bg-surface px-3 py-2 ${pending ? 'opacity-70' : ''}`}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-caption text-muted">
            {authorLabel(comment.author, comment.authorKind, pending)}
          </span>
          {pending ? (
            <span className="shrink-0 text-caption text-faint">发送中…</span>
          ) : (
            <TimeAgo value={comment.createdAt} className="shrink-0 text-caption text-faint" />
          )}
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
  const costText = formatRunReferenceCost(run)
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
        // 快照哈希 / 上下文版本是排障用的技术细节,折叠起来,不再在时间线正文里裸露
        // 「快照 a3f9c1d2e4b5 · 启动 v2。仅审计、不可逐字重放」(审计 T-14)。
        <details className="text-caption text-muted" data-testid="ticket-run-context">
          {/* 触屏 44px 命中(a11y-B taskboard#2):summary 原本只有 16px 行高;桌面不变。 */}
          <summary className="cursor-pointer select-none text-faint [@media(hover:none)]:py-3.5">
            执行时的项目信息快照
          </summary>
          <p className="mt-1">
            这次执行带上的项目信息版本 v{run.contextVersion ?? '—'}
            {run.contextSha256 ? `（指纹 ${run.contextSha256.slice(0, 12)}）` : ''}
            。快照只用于事后对照，不能逐字还原当时的输入。
          </p>
        </details>
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
  composer,
}: {
  items: TimelineItem[]
  loading: boolean
  stageName: string | null
  stageById: Map<string, string>
  /** 评论输入区。放在讨论列表**之后**:先看完别人说了什么再写(审计 T-18 ①)。 */
  composer?: ReactNode
}) {
  const { discussion, system } = useMemo(() => partitionTimeline(items), [items])
  const [systemOpen, setSystemOpen] = useState(false)

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-3" data-testid="ticket-timeline">
      <section data-testid="ticket-discussion" className="flex flex-col gap-2">
        <p className="flex items-center gap-1.5 text-meta font-medium text-muted">
          <MessageSquare size={14} aria-hidden />
          讨论{discussion.length ? `（${discussion.length}）` : ''}
        </p>
        {loading && items.length === 0 ? (
          <ListSkeleton rows={3} variant="row" />
        ) : discussion.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-caption text-muted">
            还没有评论。人和 agent 的讨论会出现在这里，你可以在下方先写一条。
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {discussion.map((item) =>
              item.kind === 'comment' ? (
                <DiscussionComment key={item.comment.id} comment={item.comment} />
              ) : null,
            )}
          </ol>
        )}
        {composer}
      </section>

      <section data-testid="ticket-system-activity" className="flex flex-col gap-2">
        <button
          type="button"
          className="flex items-center gap-1.5 text-left text-meta font-medium text-muted [@media(hover:none)]:min-h-11"
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
