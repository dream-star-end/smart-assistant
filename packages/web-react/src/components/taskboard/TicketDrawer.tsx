import { X } from 'lucide-react'
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
  type TicketRun,
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
import { Button, Field, IconButton, Input, ListSkeleton, Select, Sheet, useToast } from '../ui'
import { LOCAL_COMMENT_ID_PREFIX, TicketTimeline } from './TicketTimeline'

// Share reads from background, initial and post-write reconciliation. A slow
// response may be shared, but its owner/version is checked before it is applied.
function joinRead<T>(pending: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const active = pending.get(key)
  if (active) return active
  const next = load().finally(() => pending.delete(key))
  pending.set(key, next)
  return next
}

function mergeExecution(items: TimelineItem[], execution: TicketRun | null): TimelineItem[] {
  if (!execution) return items
  const active = execution.status === 'running' || execution.status === 'queued'
  let found = false
  const merged = items.map((item) => {
    if (item.kind !== 'run' || item.run.id !== execution.id) return item
    found = true
    const terminal = item.run.status !== 'running' && item.run.status !== 'queued'
    const actualModels = [...new Set([...(item.run.actualModels ?? []), ...(execution.actualModels ?? [])])]
    if (terminal) return { ...item, run: { ...item.run, actualModels } }
    if (!active) return item // Full terminal output comes only from the timeline.
    const preview = (execution.preview?.lastActivityAt ?? 0) < (item.run.preview?.lastActivityAt ?? 0) ? item.run.preview : execution.preview
    return { ...item, run: { ...item.run, ...execution, actualModels, preview } }
  })
  if (!found && active) merged.push({ kind: 'run', createdAt: execution.createdAt, run: execution })
  return sortTimelineAsc(merged)
}

function TicketMarkdown({
  children,
  testId,
}: {
  children: string
  testId?: string
}) {
  // 正文里的 h1/h2 压到 text-section:它们是单据描述里的小节,不能比单据标题(text-title)还醒目(审计 T-18 ③)。
  // Markdown 内部的 `.prose h2 { font-size: 1.28em }` 是未分层样式,会压过任何分层 utility,所以这里必须带 `!`。
  return (
    <div
      data-testid={testId}
      className="text-body text-fg [&_.prose]:text-body! [&_.prose_h1]:text-section! [&_.prose_h1]:mt-4! [&_.prose_h1]:mb-1! [&_.prose_h2]:text-section! [&_.prose_h2]:mt-4! [&_.prose_h2]:mb-1! [&_.prose_h3]:text-body! [&_.prose_h3]:mt-3! [&_.prose_h3]:mb-1! [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-hover [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_ul]:list-disc [&_ul]:pl-5"
    >
      <Markdown readOnly>{children}</Markdown>
    </div>
  )
}

/** 抽屉顶部常驻的一行:编号 + 关闭。移动端贴底抽屉没有 Esc,遮罩只剩顶部 15%,必须有它(审计 T-05)。 */
function DrawerBar({
  desktop,
  label,
  onClose,
}: {
  desktop: boolean
  label: string
  onClose: () => void
}) {
  return (
    <div
      className={`sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-1 ${
        desktop ? 'bg-sidebar' : 'bg-elevated'
      }`}
    >
      <p className="min-w-0 truncate font-mono text-caption text-faint">{label}</p>
      <IconButton
        type="button"
        size="sm"
        shape="square"
        aria-label="关闭"
        data-testid="ticket-drawer-close"
        onClick={onClose}
      >
        <X size={16} />
      </IconButton>
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
  onDetailLoaded,
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
  /**
   * 详情拉到后回灌给父级(只读,不触发列表 epoch)。深链打开一张不在当前列表里的单时,
   * 父级靠它才能算出状态操作按钮(审计 T-30);`onTicketUpdated` 是写路径,不能拿来做这件事。
   */
  onDetailLoaded?: (ticket: Ticket) => void
  onOpenSession?: (sessionId: string) => void
}) {
  const toast = useToast()
  const [detail, setDetail] = useState<Ticket | null>(null)
  const [stageName, setStageName] = useState<string | null>(null)
  const [detailStage, setDetailStage] = useState<PipelineStage | null>(null)
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editVersion, setEditVersion] = useState<number | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [draftPriority, setDraftPriority] = useState<TicketPriority>('P2')
  const [draftAssignee, setDraftAssignee] = useState('')
  const [saving, setSaving] = useState(false)
  const [comment, setComment] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [patrolling, setPatrolling] = useState(false)
  const [execution, setExecution] = useState<TicketRun | null>(null)
  const [stopState, setStopState] = useState<'requesting' | 'stopping' | null>(null)

  const ownerLookup = ticketRef || ticket?.identifier || ticket?.id || null
  const ownerGen = useRef(0)
  const ownerLookupRef = useRef(ownerLookup)
  const openRef = useRef(open)
  if (ownerLookupRef.current !== ownerLookup) {
    ownerGen.current += 1
    ownerLookupRef.current = ownerLookup
  }
  if (openRef.current && !open) ownerGen.current += 1
  openRef.current = open
  const belongsToOwner = (row: Ticket | null | undefined) =>
    !!row && !!ownerLookup && (row.id === ownerLookup || row.identifier === ownerLookup)
  const paintedOwnerRef = useRef<string | null>(null)
  if (paintedOwnerRef.current !== ownerLookup || (!open && paintedOwnerRef.current !== null)) {
    if (detail) setDetail(null)
    if (timeline.length) setTimeline([])
    if (stageName) setStageName(null)
    if (detailStage) setDetailStage(null)
    if (comment) setComment('')
    if (saving) setSaving(false)
    if (commenting) setCommenting(false)
    if (patrolling) setPatrolling(false)
    if (execution) setExecution(null)
    if (stopState) setStopState(null)
    paintedOwnerRef.current = open ? ownerLookup : null
  }
  const current = belongsToOwner(detail) && (!belongsToOwner(ticket) || detail!.version >= ticket!.version)
    ? detail : belongsToOwner(ticket) ? ticket : null
  const lookup = ownerLookup
  const commentingRef = useRef(commenting)
  commentingRef.current = commenting
  const currentRef = useRef(current)
  currentRef.current = current
  const timelineRef = useRef(timeline)
  timelineRef.current = timeline
  const executionRef = useRef(execution)
  executionRef.current = execution
  const activeExecution = execution && (execution.status === 'running' || execution.status === 'queued') ? execution : null
  const applyExecution = useCallback((next: TicketRun | null | undefined) => {
    if (next === undefined) return false
    const previous = executionRef.current
    const knownTerminal = next && timelineRef.current.some((item) => item.kind === 'run' && item.run.id === next.id && item.run.status !== 'running' && item.run.status !== 'queued')
    if (next && knownTerminal && (next.status === 'running' || next.status === 'queued')) return false
    executionRef.current = next
    setExecution(next)
    if (next?.stopRequested) setStopState('stopping')
    else if (!next || (next.status !== 'running' && next.status !== 'queued')) setStopState(null)
    setTimeline((items) => mergeExecution(items, next))
    return previous?.id !== next?.id || previous?.status !== next?.status
  }, [])
  const currentStage = detailStage?.id === current?.stageId
    ? detailStage
    : stages.find((stage) => stage.id === current?.stageId) ?? null
  const canStart = !activeExecution && !!current && (current.status === 'ready' || current.status === 'waiting_human') && currentStage?.kind === 'ai'
  const reads = useMemo(() => {
    const details = new Map<string, ReturnType<typeof taskboardApi.getTicketDetail>>()
    const timelines = new Map<string, ReturnType<typeof taskboardApi.listTimeline>>()
    return {
      detail: (id: string) => joinRead(details, id, () => taskboardApi.getTicketDetail(auth, id)),
      timeline: (id: string) => joinRead(timelines, id, () => taskboardApi.listTimeline(auth, id)),
    }
  }, [auth])
  const editingRef = useRef(false)

  const stageById = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of stages) map.set(s.id, s.name)
    return map
  }, [stages])

  const originSessionId = resolveOriginSessionId(current?.originSessionKey, sessionIds)

  const beginEdit = useCallback((src: Ticket) => {
    setEditVersion(src.version)
    setDraftTitle(src.title)
    setDraftBody(src.body)
    setDraftPriority(src.priority)
    setDraftAssignee(src.assignee ?? '')
    setEditing(true)
  }, [])
  editingRef.current = editing

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

  const onDetailLoadedRef = useRef(onDetailLoaded)
  onDetailLoadedRef.current = onDetailLoaded

  // ticket.version 是「同一 owner 被外部写入后重新拉详情」的触发器；身份只看显式 ownerLookup。
  // biome-ignore lint/correctness/useExhaustiveDependencies: ticket.version 是 refetch 触发器，删掉会少拉详情
  useEffect(() => {
    if (!open || !lookup) return
    const gen = ownerGen.current
    const requested = lookup
    let cancelled = false
    setLoading(timelineRef.current.length === 0)
    const load = async () => {
      try {
        const [fresh, runs] = await Promise.all([
          reads.detail(requested),
          taskboardApi.listRuns(auth, requested),
        ])
        if (cancelled || ownerGen.current !== gen || ownerLookupRef.current !== requested) return
        if (currentRef.current && fresh.ticket.version < currentRef.current.version) return
        currentRef.current = fresh.ticket
        setDetail(fresh.ticket)
        setStageName(fresh.stage?.name ?? null)
        setDetailStage(fresh.stage ?? null)
        onDetailLoadedRef.current?.(fresh.ticket)
        applyExecution(fresh.execution !== undefined ? fresh.execution : runs.items[0] ?? null)
        let items: TimelineItem[]
        try {
          items = await reads.timeline(requested)
        } catch (e) {
          if (e instanceof AuthEpochStaleError) return
          const [comments, activities] = await Promise.all([
            taskboardApi.listComments(auth, requested).catch(() => [] as TicketComment[]),
            taskboardApi.listActivity(auth, requested).catch(() => []),
          ])
          items = mergeTimelineSources({
            activities,
            runs: runs.items,
            comments,
          })
        }
        if (cancelled || ownerGen.current !== gen || ownerLookupRef.current !== requested) return
        if (currentRef.current?.version !== fresh.ticket.version || commentingRef.current) return
        setTimeline(mergeExecution(items, executionRef.current))
      } catch (e) {
        if (e instanceof AuthEpochStaleError || cancelled || ownerGen.current !== gen) return
        toast(taskboardErrorMessage(e, '加载单据详情失败'), 'error')
      } finally {
        if (!cancelled && ownerGen.current === gen) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [applyExecution, auth, lookup, open, reads, ticket?.version, toast])

  // Refresh only the open owner. Do not reload project metadata or blank the
  // timeline on a background tick. Visibility resume also catches comments.
  useEffect(() => {
    if (!open || !lookup) return
    const requested = lookup
    const gen = ownerGen.current
    let stopped = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let lastTimelineAt = Date.now()
    const owned = () => !stopped && ownerGen.current === gen && ownerLookupRef.current === requested
    const visible = () => document.visibilityState !== 'hidden'
    const tick = async (forceTimeline = false) => {
      if (!owned() || inFlight || !visible()) return
      inFlight = true
      try {
        const fresh = await reads.detail(requested)
        if (!owned() || (currentRef.current && fresh.ticket.version < currentRef.current.version)) return
        failures = 0
        const executionChanged = applyExecution(fresh.execution)
        setStageName(fresh.stage?.name ?? null)
        setDetailStage(fresh.stage ?? null)
        const changed = fresh.ticket.version !== currentRef.current?.version
        if (changed) {
          currentRef.current = fresh.ticket
          setDetail(fresh.ticket)
          onDetailLoadedRef.current?.(fresh.ticket)
        }
        if (changed || executionChanged || forceTimeline || Date.now() - lastTimelineAt >= 15_000) {
          const version = fresh.ticket.version
          const items = await reads.timeline(requested)
          if (!owned() || currentRef.current?.version !== version || commentingRef.current) return
          setTimeline((cur) => mergeExecution([
            ...items,
            ...cur.filter((item) => item.kind === 'comment' && item.comment.id.startsWith(LOCAL_COMMENT_ID_PREFIX)),
          ], executionRef.current))
          lastTimelineAt = Date.now()
        }
      } catch (e) {
        if (!(e instanceof AuthEpochStaleError)) failures = Math.min(failures + 1, 4)
      } finally {
        inFlight = false
        if (owned() && visible()) {
          const interval = executionRef.current?.status === 'running' || executionRef.current?.status === 'queued' ? 2_000 : currentRef.current?.status === 'running' ? 3_000 : 15_000
          timer = setTimeout(() => void tick(), Math.min(60_000, interval * 2 ** failures))
        }
      }
    }
    const resume = () => {
      clearTimeout(timer)
      if (visible()) void tick(true)
    }
    timer = setTimeout(() => void tick(), currentRef.current?.status === 'running' ? 3_000 : 15_000)
    document.addEventListener('visibilitychange', resume)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [applyExecution, lookup, open, reads])

  const refreshAfterWrite = async (idOrIdent: string, gen: number) => {
    try {
      const requested = ownerLookupRef.current ?? idOrIdent
      const [fresh, items] = await Promise.all([
        reads.detail(requested),
        reads.timeline(requested).catch(async () => {
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
      if (ownerGen.current !== gen) return
      const owner = ownerLookupRef.current
      if (owner && fresh.ticket.id !== owner && fresh.ticket.identifier !== owner) return
      if (currentRef.current && fresh.ticket.version < currentRef.current.version) return
      currentRef.current = fresh.ticket
      setDetail(fresh.ticket)
      setStageName(fresh.stage?.name ?? null)
      setDetailStage(fresh.stage ?? null)
      applyExecution(fresh.execution)
      if (!commentingRef.current) setTimeline(mergeExecution(items, executionRef.current))
      onTicketUpdated(fresh.ticket)
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      /* 写成功后的对账失败交给父级轮询 */
    }
  }

  const saveEdit = async () => {
    if (!current) return
    const gen = ownerGen.current
    const title = draftTitle.trim()
    if (!title) {
      toast('请填写标题', 'error')
      return
    }
    setSaving(true)
    try {
      const out = await taskboardApi.patchTicket(auth, current.id, {
        expectedVersion: editVersion ?? current.version,
        title,
        body: draftBody,
        priority: draftPriority,
        assignee: draftAssignee || null,
      })
      if (ownerGen.current !== gen) return
      if (!currentRef.current || out.ticket.version >= currentRef.current.version) {
        currentRef.current = out.ticket
        setDetail(out.ticket)
        onTicketUpdated(out.ticket)
      }
      setEditing(false)
      toast('已更新需求', 'success')
      void onReconcile()
      void refreshAfterWrite(out.ticket.identifier, gen)
    } catch (e) {
      if (e instanceof AuthEpochStaleError || ownerGen.current !== gen) return
      if (isVersionConflict(e)) {
        toast(taskboardErrorMessage(e, '单据已被更新，已刷新'), 'error')
        void onReconcile()
        void refreshAfterWrite(current.identifier, gen)
        return
      }
      toast(taskboardErrorMessage(e, '保存需求失败'), 'error')
    } finally {
      if (ownerGen.current === gen) setSaving(false)
    }
  }

  const submitComment = async () => {
    if (!current) return
    const gen = ownerGen.current
    const body = comment.trim()
    if (!body) {
      toast('请填写评论', 'error')
      return
    }
    const optimistic: TicketComment = {
      id: `${LOCAL_COMMENT_ID_PREFIX}${Date.now()}`,
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
      if (ownerGen.current !== gen) return
      setTimeline((cur) =>
        cur.map((item) =>
          item.kind === 'comment' && item.comment.id === optimistic.id
            ? { kind: 'comment', createdAt: out.comment.createdAt, comment: out.comment }
            : item,
        ),
      )
    } catch (e) {
      if (e instanceof AuthEpochStaleError || ownerGen.current !== gen) return
      setTimeline((cur) =>
        cur.filter((item) => !(item.kind === 'comment' && item.comment.id === optimistic.id)),
      )
      setComment(body)
      toast(taskboardErrorMessage(e, '发表评论失败'), 'error')
    } finally {
      if (ownerGen.current === gen) setCommenting(false)
    }
  }

  const runPatrol = async () => {
    if (!current) return
    const gen = ownerGen.current
    setPatrolling(true)
    try {
      const out = await taskboardApi.patrol(auth, current.id, current.version)
      if (ownerGen.current !== gen) return
      if (!currentRef.current || out.ticket.version >= currentRef.current.version) {
        currentRef.current = out.ticket
        setDetail(out.ticket)
        onTicketUpdated(out.ticket)
      }
      toast('已开始巡检', 'success')
      void onReconcile()
      void refreshAfterWrite(out.ticket.identifier, gen)
    } catch (e) {
      if (e instanceof AuthEpochStaleError || ownerGen.current !== gen) return
      if (isVersionConflict(e)) {
        toast(taskboardErrorMessage(e, '单据已被更新，已刷新'), 'error')
        void onReconcile()
        void refreshAfterWrite(current.identifier, gen)
        return
      }
      toast(taskboardErrorMessage(e, '启动巡检失败'), 'error')
    } finally {
      if (ownerGen.current === gen) setPatrolling(false)
    }
  }

  const stopRun = async () => {
    if (!current || !activeExecution || stopState) return
    const gen = ownerGen.current
    setStopState('requesting')
    try {
      const out = await taskboardApi.stopRun(auth, current.id, current.version, activeExecution.id)
      if (ownerGen.current !== gen) return
      if (!currentRef.current || out.ticket.version >= currentRef.current.version) {
        currentRef.current = out.ticket
        setDetail(out.ticket)
        onTicketUpdated(out.ticket)
      }
      setStopState(out.state === 'stopping' ? 'stopping' : null)
      toast(out.state === 'stopping' ? '已请求停止，正在保留输出并收尾' : '本次执行已结束', 'success')
      void refreshAfterWrite(current.identifier, gen)
    } catch (error) {
      if (ownerGen.current !== gen) return
      setStopState(null)
      if (error instanceof AuthEpochStaleError) return
      toast(taskboardErrorMessage(error, '停止执行失败，请稍后重试'), 'error')
      void refreshAfterWrite(current.identifier, gen)
    }
  }

  // 来源会话在当前列表里命中、且是网页对话 id(不带冒号的巡检 sessionKey)才可跳转;
  // 否则按钮真正禁用并用 title 说明,而不是半透明还能点、点了才 toast(审计 T-29)。
  const originUsable = !!originSessionId && !originSessionId.includes(':')
  const openOrigin = () => {
    if (!current?.originSessionKey || !originUsable || !originSessionId) return
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
      className={desktop ? 'w-[36rem] max-w-[96vw]' : 'h-[94dvh] max-h-[94dvh]'}
    >
      <DrawerBar
        desktop={desktop}
        label={current?.identifier ?? ticketRef ?? '单据详情'}
        onClose={onClose}
      />
      {current ? (
        <div
          data-testid="ticket-drawer"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 pt-1"
        >
          <div>
            {editing ? (
              <div className="flex flex-col gap-2" data-testid="ticket-drawer-edit-form">
                <Field label="标题" required>
                  <Input
                    aria-label="单据标题"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                  />
                </Field>
                <Field label="描述" hint="支持 Markdown：标题、列表、代码块、链接">
                  <textarea
                    aria-label="单据描述"
                    placeholder="写清复现步骤、验收标准、范围内外"
                    className="min-h-28 w-full rounded-lg border border-border-control bg-surface px-3.5 py-2.5 text-base leading-relaxed text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
                    value={draftBody}
                    onChange={(e) => setDraftBody(e.target.value)}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="优先级">
                    <Select
                      aria-label="优先级"
                      inputSize="sm"
                      value={draftPriority}
                      onValueChange={(v) => setDraftPriority(v as TicketPriority)}
                      options={TICKET_PRIORITIES.map((p) => ({ value: p, label: p }))}
                    />
                  </Field>
                  <Field label="执行者">
                    <Select
                      aria-label="执行者"
                      inputSize="sm"
                      value={draftAssignee}
                      onValueChange={setDraftAssignee}
                      options={assigneeOptions}
                    />
                  </Field>
                </div>
                {editVersion !== null && editVersion !== current.version && (
                  <output className="block text-caption text-warning">任务已被更新，当前草稿已保留。保存时会检查冲突；可放弃修改后重新编辑最新内容。</output>
                )}
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
                    放弃修改
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
              <details open={desktop} className="rounded-lg border border-border px-3 py-2">
                <summary className="cursor-pointer text-caption font-medium text-muted">任务说明</summary>
                <div className="mt-2"><TicketMarkdown testId="ticket-body-md">{current.body}</TicketMarkdown></div>
              </details>
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
            {activeExecution && (
              <Button type="button" size="sm" variant="danger" data-testid="ticket-drawer-stop" loading={stopState === 'requesting'} disabled={stopState !== null} onClick={() => void stopRun()}>
                {stopState === 'requesting' ? '请求停止…' : stopState === 'stopping' ? '停止处理中' : '停止本次执行'}
              </Button>
            )}
            {canStart && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={patrolling}
                data-testid="ticket-drawer-patrol"
                onClick={() => void runPatrol()}
              >
                {current.status === 'waiting_human' ? '重新执行本阶段' : '开始执行'}
              </Button>
            )}
            {current.originSessionKey && onOpenSession && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="ticket-drawer-origin-session"
                disabled={!originUsable}
                title={originUsable ? undefined : '来源会话不在当前列表中，可能已删除或不是网页对话'}
                onClick={openOrigin}
              >
                回到来源会话
              </Button>
            )}
          </div>

          <TicketTimeline
            items={timeline}
            loading={loading}
            stageName={stageName}
            stageById={stageById}
            composer={
              <div className="flex flex-col gap-2 pt-1" data-testid="ticket-drawer-composer">
                <textarea
                  aria-label="评论"
                  data-testid="ticket-drawer-comment"
                  className="min-h-20 w-full rounded-lg border border-border-control bg-surface px-3.5 py-2.5 text-base leading-relaxed text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
                  placeholder="写一条拍板意见，支持 Markdown"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <div>
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
              </div>
            }
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
