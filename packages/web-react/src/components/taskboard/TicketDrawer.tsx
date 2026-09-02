import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthEpochStaleError } from '../../lib/api'
import {
  type BoardAgent,
  type PipelineStage,
  TICKET_PRIORITIES,
  TICKET_STATUS_LABEL,
  TICKET_TYPE_LABEL,
  type Ticket,
  type TicketComment,
  type TicketPriority,
  type TimelineItem,
  assigneeLabel,
  isVersionConflict,
  mergeTimelineSources,
  resolveOriginSessionId,
  sortTimelineAsc,
  taskboardApi,
  taskboardErrorMessage,
} from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import { Markdown } from '../Markdown'
import { Button, Input, ListSkeleton, Select, Sheet, useToast } from '../ui'
import { TicketTimeline } from './TicketTimeline'

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

export function TicketDrawer({
  auth,
  ticket,
  ticketRef,
  open,
  desktop,
  agents,
  stages,
  sessionIds,
  startEditing = false,
  actions,
  onClose,
  onReconcile,
  onTicketUpdated,
  onOpenSession,
}: {
  auth: AuthSession
  ticket: Ticket | null
  ticketRef: string | null
  open: boolean
  desktop: boolean
  agents: BoardAgent[]
  stages: PipelineStage[]
  sessionIds: readonly string[]
  startEditing?: boolean
  actions?: ReactNode
  onClose: () => void
  onReconcile: () => void
  onTicketUpdated: (ticket: Ticket) => void
  onOpenSession?: (sessionId: string) => void
}) {
  const toast = useToast()
  const [detail, setDetail] = useState<Ticket | null>(null)
  const [stageName, setStageName] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [draftPriority, setDraftPriority] = useState<TicketPriority>('P2')
  const [draftAssignee, setDraftAssignee] = useState('')
  const [saving, setSaving] = useState(false)
  const [comment, setComment] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [patrolling, setPatrolling] = useState(false)

  const current = detail ?? ticket
  const lookup = current?.identifier ?? current?.id ?? ticketRef

  const stageById = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of stages) map.set(s.id, s.name)
    return map
  }, [stages])

  const originSessionId = resolveOriginSessionId(current?.originSessionKey, sessionIds)

  const beginEdit = useCallback((src: Ticket) => {
    setDraftTitle(src.title)
    setDraftBody(src.body)
    setDraftPriority(src.priority)
    setDraftAssignee(src.assignee ?? '')
    setEditing(true)
  }, [])

  // 只在 ticket.id 变化时重跑；父级轮询换了同一张单的对象引用时不能重置草稿。
  const latestTicketRef = useRef(ticket)
  latestTicketRef.current = ticket

  useEffect(() => {
    if (!open) {
      setEditing(false)
      setComment('')
      return
    }
    const src = latestTicketRef.current
    if (startEditing && src && src.id === ticket?.id) beginEdit(src)
    else setEditing(false)
  }, [beginEdit, open, startEditing, ticket?.id])

  // ticket.version 是「同一 lookup 被外部写入后重新拉详情」的触发器，effect 体只按 lookup 请求。
  // biome-ignore lint/correctness/useExhaustiveDependencies: ticket.version 是 refetch 触发器，删掉会少拉详情
  useEffect(() => {
    if (!open || !lookup) return
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        const [fresh, runs] = await Promise.all([
          taskboardApi.getTicketDetail(auth, lookup),
          taskboardApi.listRuns(auth, lookup),
        ])
        if (cancelled) return
        setDetail(fresh.ticket)
        setStageName(fresh.stage?.name ?? null)
        let items: TimelineItem[]
        try {
          items = await taskboardApi.listTimeline(auth, lookup)
        } catch (e) {
          if (e instanceof AuthEpochStaleError) return
          const [comments, activities] = await Promise.all([
            taskboardApi.listComments(auth, lookup).catch(() => [] as TicketComment[]),
            taskboardApi.listActivity(auth, lookup).catch(() => []),
          ])
          items = mergeTimelineSources({
            activities,
            runs: runs.items,
            comments,
          })
        }
        if (cancelled) return
        setTimeline(sortTimelineAsc(items))
      } catch (e) {
        if (e instanceof AuthEpochStaleError || cancelled) return
        toast(taskboardErrorMessage(e, '加载单据详情失败'), 'error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [auth, lookup, open, ticket?.version, toast])

  const refreshAfterWrite = async (idOrIdent: string) => {
    try {
      const [fresh, items] = await Promise.all([
        taskboardApi.getTicketDetail(auth, idOrIdent),
        taskboardApi.listTimeline(auth, idOrIdent).catch(async () => {
          const [runs, comments, activities] = await Promise.all([
            taskboardApi.listRuns(auth, idOrIdent),
            taskboardApi.listComments(auth, idOrIdent),
            taskboardApi.listActivity(auth, idOrIdent),
          ])
          return mergeTimelineSources({
            activities,
            runs: runs.items,
            comments,
          })
        }),
      ])
      setDetail(fresh.ticket)
      setStageName(fresh.stage?.name ?? null)
      setTimeline(sortTimelineAsc(items))
      onTicketUpdated(fresh.ticket)
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      /* 写成功后的对账失败交给父级轮询 */
    }
  }

  const saveEdit = async () => {
    if (!current) return
    const title = draftTitle.trim()
    if (!title) {
      toast('请填写标题', 'error')
      return
    }
    setSaving(true)
    try {
      const out = await taskboardApi.patchTicket(auth, current.id, {
        expectedVersion: current.version,
        title,
        body: draftBody,
        priority: draftPriority,
        assignee: draftAssignee || null,
      })
      setDetail(out.ticket)
      onTicketUpdated(out.ticket)
      setEditing(false)
      toast('已更新需求', 'success')
      void onReconcile()
      void refreshAfterWrite(out.ticket.identifier)
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      if (isVersionConflict(e)) {
        toast(taskboardErrorMessage(e, '单据已被更新，已刷新'), 'error')
        void onReconcile()
        void refreshAfterWrite(current.identifier)
        return
      }
      toast(taskboardErrorMessage(e, '保存需求失败'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const submitComment = async () => {
    if (!current) return
    const body = comment.trim()
    if (!body) {
      toast('请填写评论', 'error')
      return
    }
    const optimistic: TicketComment = {
      id: `local-${Date.now()}`,
      ticketId: current.id,
      authorKind: 'human',
      author: 'user:default',
      body,
      runId: null,
      createdAt: Date.now(),
    }
    setComment('')
    setCommenting(true)
    setTimeline((cur) => [
      ...cur,
      { kind: 'comment', createdAt: optimistic.createdAt, comment: optimistic },
    ])
    try {
      const out = await taskboardApi.comment(auth, current.id, { body })
      setTimeline((cur) =>
        cur.map((item) =>
          item.kind === 'comment' && item.comment.id === optimistic.id
            ? { kind: 'comment', createdAt: out.comment.createdAt, comment: out.comment }
            : item,
        ),
      )
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      setTimeline((cur) =>
        cur.filter((item) => !(item.kind === 'comment' && item.comment.id === optimistic.id)),
      )
      setComment(body)
      toast(taskboardErrorMessage(e, '发表评论失败'), 'error')
    } finally {
      setCommenting(false)
    }
  }

  const runPatrol = async () => {
    if (!current) return
    setPatrolling(true)
    try {
      const out = await taskboardApi.patrol(auth, current.id, current.version)
      setDetail(out.ticket)
      onTicketUpdated(out.ticket)
      toast('已开始巡检', 'success')
      void onReconcile()
      void refreshAfterWrite(out.ticket.identifier)
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      if (isVersionConflict(e)) {
        toast(taskboardErrorMessage(e, '单据已被更新，已刷新'), 'error')
        void onReconcile()
        void refreshAfterWrite(current.identifier)
        return
      }
      toast(taskboardErrorMessage(e, '启动巡检失败'), 'error')
    } finally {
      setPatrolling(false)
    }
  }

  const openOrigin = () => {
    if (!current?.originSessionKey) return
    if (!originSessionId || originSessionId.includes(':')) {
      toast('来源会话不在当前列表中，可能已删除或不是网页对话', 'error')
      return
    }
    onOpenSession?.(originSessionId)
  }

  const assigneeOptions = [
    { value: '', label: '未指定' },
    ...agents.map((a) => ({ value: `agent:${a.id}`, label: a.name || a.id })),
  ]
  if (current?.assignee && !assigneeOptions.some((o) => o.value === current.assignee)) {
    assigneeOptions.push({ value: current.assignee, label: current.assignee })
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      side={desktop ? 'right' : 'bottom'}
      srTitle={current ? current.identifier : '单据详情'}
      className={desktop ? 'w-[36rem] max-w-[96vw]' : undefined}
    >
      {current ? (
        <div
          data-testid="ticket-drawer"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
        >
          <div>
            <p className="font-mono text-caption text-faint">{current.identifier}</p>
            {editing ? (
              <div className="mt-2 flex flex-col gap-2">
                <Input
                  aria-label="单据标题"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                />
                <textarea
                  aria-label="单据描述"
                  placeholder="支持 Markdown：标题、列表、代码块、链接"
                  className="min-h-28 w-full rounded-lg border border-border-control bg-surface px-3.5 py-2.5 text-base leading-relaxed text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <Select
                    aria-label="优先级"
                    className="w-28"
                    inputSize="sm"
                    value={draftPriority}
                    onValueChange={(v) => setDraftPriority(v as TicketPriority)}
                    options={TICKET_PRIORITIES.map((p) => ({ value: p, label: p }))}
                  />
                  <Select
                    aria-label="执行者"
                    className="min-w-[10rem] flex-1"
                    inputSize="sm"
                    value={draftAssignee}
                    onValueChange={setDraftAssignee}
                    options={assigneeOptions}
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    size="sm"
                    loading={saving}
                    data-testid="ticket-drawer-save"
                    onClick={() => void saveEdit()}
                  >
                    保存
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <h2 className="mt-1 text-title font-semibold text-fg">{current.title}</h2>
                <p className="mt-1 text-meta text-muted">
                  {TICKET_TYPE_LABEL[current.type]} · {current.priority} ·{' '}
                  {TICKET_STATUS_LABEL[current.status]}
                  {stageName ? ` · ${stageName}` : ''}
                  {current.approvedBy
                    ? ` · 批准人 ${assigneeLabel(current.approvedBy) ?? current.approvedBy}`
                    : ''}
                </p>
              </>
            )}
          </div>

          {!editing &&
            (current.body ? (
              <TicketMarkdown testId="ticket-body-md">{current.body}</TicketMarkdown>
            ) : (
              <p className="text-meta text-faint">还没有描述</p>
            ))}

          {current.blockedReason && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-body text-danger">
              受阻：{current.blockedReason}
            </p>
          )}

          {actions}

          <div className="flex flex-wrap gap-1">
            {!editing && current.status !== 'done' && current.status !== 'canceled' && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="ticket-drawer-edit"
                onClick={() => beginEdit(current)}
              >
                改需求
              </Button>
            )}
            {current.status !== 'done' && current.status !== 'canceled' && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={patrolling}
                data-testid="ticket-drawer-patrol"
                onClick={() => void runPatrol()}
              >
                立刻巡检
              </Button>
            )}
            {current.originSessionKey && onOpenSession && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="ticket-drawer-origin-session"
                aria-disabled={!originSessionId}
                className={!originSessionId ? 'opacity-50' : undefined}
                onClick={openOrigin}
              >
                回到来源会话
              </Button>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <p className="text-meta font-medium text-muted">评论</p>
            <textarea
              aria-label="评论"
              data-testid="ticket-drawer-comment"
              className="min-h-20 w-full rounded-lg border border-border-control bg-surface px-3.5 py-2.5 text-base leading-relaxed text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
              placeholder="支持 Markdown，写一条拍板意见"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              loading={commenting}
              data-testid="ticket-drawer-comment-submit"
              onClick={() => void submitComment()}
            >
              发表评论
            </Button>
          </div>

          <TicketTimeline
            items={timeline}
            loading={loading}
            stageName={stageName}
            stageById={stageById}
          />
        </div>
      ) : (
        <div className="p-4">
          <ListSkeleton rows={5} variant="row" />
        </div>
      )}
    </Sheet>
  )
}
