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
  boardErrorCode,
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
import { useTimelineHistory } from './timelineHistory'

// Share reads from background, initial and post-write reconciliation. A slow
// response may be shared, but its owner/version is checked before it is applied.
function joinRead<T>(
  pending: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const active = pending.get(key)
  if (active) return active
  const next = load().finally(() => pending.delete(key))
  pending.set(key, next)
  return next
}

function mergeExecution(items: TimelineItem[], execution: TicketRun | null): TimelineItem[] {
  if (!execution) return items
  const active =
    execution.status === 'running' || execution.status === 'queued' || execution.settling === true
  let found = false
  const merged = items.map((item) => {
    if (item.kind !== 'run' || item.run.id !== execution.id) return item
    found = true
    const terminal = item.run.status !== 'running' && item.run.status !== 'queued'
    const actualModels = [
      ...new Set([...(item.run.actualModels ?? []), ...(execution.actualModels ?? [])]),
    ]
    if (terminal) return { ...item, run: { ...item.run, actualModels } }
    if (!active) return item // Full terminal output comes only from the timeline.
    const preview =
      (execution.preview?.lastActivityAt ?? 0) < (item.run.preview?.lastActivityAt ?? 0)
        ? item.run.preview
        : execution.preview
    return { ...item, run: { ...item.run, ...execution, actualModels, preview } }
  })
  if (!found) merged.push({ kind: 'run', createdAt: execution.createdAt, run: execution })
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
  onConfigureStage,
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
  onConfigureStage?: () => void
}) {
  const toast = useToast()
  const [descriptionOpen, setDescriptionOpen] = useState(desktop)
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
  const [executionNeedsSetup, setExecutionNeedsSetup] = useState(false)
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
  const [history, historyStatus] = useTimelineHistory(auth, ownerLookup)
  const openRef = useRef(open)
  openRef.current = open
  const historyRef = useRef(history)
  historyRef.current = history
  const resultRequests = history.resultRequests
  const [resultError, setResultError] = useState(false)
  const scrollContainer = useRef<HTMLDivElement>(null)
  const paintedOwnerRef = useRef<string | null>(null)
  if (paintedOwnerRef.current !== ownerLookup || (!open && paintedOwnerRef.current !== null)) {
    setDescriptionOpen(desktop)
    if (resultError) setResultError(false)
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
    if (executionNeedsSetup) setExecutionNeedsSetup(false)
    paintedOwnerRef.current = open ? ownerLookup : null
  }
  const current =
    belongsToOwner(detail) && (!belongsToOwner(ticket) || detail!.version >= ticket!.version)
      ? detail
      : belongsToOwner(ticket)
        ? ticket
        : null
  const lookup = ownerLookup
  const commentingRef = useRef(commenting)
  commentingRef.current = commenting
  const currentRef = useRef(current)
  currentRef.current = current
  const timelineRef = useRef(timeline)
  timelineRef.current = timeline
  const executionRef = useRef(execution)
  executionRef.current = execution
  const activeExecution =
    execution &&
    (execution.status === 'running' || execution.status === 'queued' || execution.settling === true)
      ? execution
      : null
  const applyExecution = useCallback((next: TicketRun | null | undefined) => {
    if (next === undefined) return false
    const previous = executionRef.current
    const previousTerminal =
      previous &&
      next &&
      previous.id === next.id &&
      previous.status !== 'running' &&
      previous.status !== 'queued'
    const knownTerminal =
      previousTerminal ||
      (next &&
        timelineRef.current.some(
          (item) =>
            item.kind === 'run' &&
            item.run.id === next.id &&
            item.run.status !== 'running' &&
            item.run.status !== 'queued',
        ))
    if (next && knownTerminal && (next.status === 'running' || next.status === 'queued'))
      return false
    executionRef.current = next
    setExecution(next)
    if (!next || (next.status !== 'running' && next.status !== 'queued' && !next.settling))
      setStopState(null)
    else if (next.stopRequested) setStopState('stopping')
    else if (previous?.id !== next.id) setStopState(null)
    setTimeline((items) => mergeExecution(items, next))
    return (
      previous?.id !== next?.id ||
      previous?.status !== next?.status ||
      previous?.settling !== next?.settling
    )
  }, [])
  const currentStage =
    detailStage?.id === current?.stageId
      ? detailStage
      : (stages.find((stage) => stage.id === current?.stageId) ?? null)
  const needsSetup = currentStage?.kind === 'ai' && (!currentStage.agentId || executionNeedsSetup)
  const canRetry =
    !needsSetup &&
    !activeExecution &&
    !!execution &&
    !!current &&
    execution.stageId === current.stageId &&
    (current.status === 'blocked' ||
      current.status === 'ready' ||
      current.status === 'waiting_human') &&
    currentStage?.kind === 'ai'
  const canStart =
    !needsSetup &&
    !canRetry &&
    !activeExecution &&
    !!current &&
    (current.status === 'ready' || current.status === 'waiting_human') &&
    currentStage?.kind === 'ai'
  const reads = useMemo(() => {
    const details = new Map<string, ReturnType<typeof taskboardApi.getTicketDetail>>()
    const timelines = new Map<string, ReturnType<typeof taskboardApi.listTimeline>>()
    return {
      detail: (id: string) => joinRead(details, id, () => taskboardApi.getTicketDetail(auth, id)),
      timeline: (id: string) => joinRead(timelines, id, () => history.fetchLatest(id)),
    }
  }, [auth, history])
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
        const fresh = await reads.detail(requested)
        if (cancelled || ownerGen.current !== gen || ownerLookupRef.current !== requested) return
        const runs =
          fresh.execution !== undefined
            ? { items: [] as TicketRun[], total: 0 }
            : await taskboardApi.listRuns(auth, requested)
        if (cancelled || ownerGen.current !== gen || ownerLookupRef.current !== requested) return
        if (currentRef.current && fresh.ticket.version < currentRef.current.version) return
        currentRef.current = fresh.ticket
        setDetail(fresh.ticket)
        setStageName(fresh.stage?.name ?? null)
        setDetailStage(fresh.stage ?? null)
        onDetailLoadedRef.current?.(fresh.ticket)
        applyExecution(fresh.execution !== undefined ? fresh.execution : (runs.items[0] ?? null))
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
        setTimeline(mergeExecution(history.acceptLatest(items), executionRef.current))
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
  }, [applyExecution, auth, lookup, open, reads, ticket?.version, toast, history])

  // Refresh only the open owner. Do not reload project metadata or blank the
  // timeline on a background tick. Visibility resume also catches comments.
  useEffect(() => {
    if (!open || !lookup) return
    const requested = lookup
    const gen = ownerGen.current
    let stopped = false
    let inFlight = false
    let resumeRequested = false
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
        if (!owned() || (currentRef.current && fresh.ticket.version < currentRef.current.version))
          return
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
          const accepted = history.acceptLatest(items)
          setTimeline((cur) =>
            mergeExecution(
              [
                ...accepted,
                ...cur.filter(
                  (item) =>
                    item.kind === 'comment' && item.comment.id.startsWith(LOCAL_COMMENT_ID_PREFIX),
                ),
              ],
              executionRef.current,
            ),
          )
          lastTimelineAt = Date.now()
        }
      } catch (e) {
        if (!(e instanceof AuthEpochStaleError)) failures = Math.min(failures + 1, 4)
      } finally {
        inFlight = false
        if (owned() && visible()) {
          const interval =
            executionRef.current?.status === 'running' ||
            executionRef.current?.status === 'queued' ||
            executionRef.current?.settling
              ? 2_000
              : currentRef.current?.status === 'running'
                ? 3_000
                : 15_000
          const resume = resumeRequested
          resumeRequested = false
          timer = setTimeout(
            () => void tick(resume),
            resume ? 0 : Math.min(60_000, interval * 2 ** failures),
          )
        }
      }
    }
    const resume = () => {
      clearTimeout(timer)
      if (visible()) {
        if (inFlight) resumeRequested = true
        else void tick(true)
      }
    }
    // Initial detail metadata arrives after this effect; use the active cadence for the first follow-up.
    timer = setTimeout(() => void tick(), 2_000)
    document.addEventListener('visibilitychange', resume)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [applyExecution, lookup, open, reads, history])

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
      if (!commentingRef.current)
        setTimeline(mergeExecution(history.acceptLatest(items), executionRef.current))
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
      history.acceptWrite({
        kind: 'comment',
        createdAt: out.comment.createdAt,
        comment: out.comment,
      })
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

  const hydrateResult = useCallback(
    (run: TicketRun): void => {
      if (run.status === 'running' || run.status === 'queued' || run.settling) return
      if (resultRequests.has(run.id)) return
      const gen = ownerGen.current
      const ticketId = currentRef.current?.id
      const requestedOwner = ownerLookupRef.current
      const present = history.fullRun(run.id)
      if (present || run.outputMd != null) {
        const full = present ?? run
        history.acceptRun(full)
        history.resultFailures.delete(run.id)
        setResultError(history.resultFailures.size > 0)
        return
      }
      const request = taskboardApi
        .getRun(auth, run.id)
        .then((full) => {
          if (
            ownerGen.current !== gen ||
            historyRef.current !== history ||
            full.ticketId !== ticketId ||
            full.id !== run.id
          )
            return
          setTimeline(mergeExecution(history.acceptRun(full), executionRef.current))
          history.resultFailures.delete(run.id)
          setResultError(history.resultFailures.size > 0)
        })
        .catch((error) => {
          resultRequests.delete(run.id)
          if (ownerGen.current !== gen || error instanceof AuthEpochStaleError) return
          if (history.fullRun(run.id)) return
          history.resultFailures.set(run.id, run)
          setResultError(true)
        })
        .finally(() => {
          if (resultRequests.get(run.id) === request) resultRequests.delete(run.id)
          const latest = executionRef.current
          if (
            ownerGen.current !== gen &&
            historyRef.current === history &&
            ownerLookupRef.current === requestedOwner &&
            latest?.id === run.id
          )
            hydrateResult(latest)
        })
      resultRequests.set(run.id, request)
    },
    [auth, history, resultRequests],
  )

  useEffect(() => {
    if (open && execution) hydrateResult(execution)
  }, [open, execution, hydrateResult])

  const loadEarlier = async () => {
    if (!lookup) return
    const gen = ownerGen.current
    const scroller = scrollContainer.current
    const anchor = scroller
      ? [...scroller.querySelectorAll<HTMLElement>('[data-testid="ticket-timeline-group"]')].find(
          (node) => node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top,
        )
      : undefined
    const top = anchor?.getBoundingClientRect().top ?? 0
    const height = scroller?.scrollHeight ?? 0
    const scrollTop = scroller?.scrollTop ?? 0
    try {
      const items = await history.loadEarlier(lookup)
      if (ownerGen.current !== gen) return
      setTimeline(mergeExecution(items, executionRef.current))
      requestAnimationFrame(() => {
        if (!scroller || ownerGen.current !== gen) return
        scroller.scrollTop = anchor?.isConnected
          ? scroller.scrollTop + anchor.getBoundingClientRect().top - top
          : scrollTop + scroller.scrollHeight - height
      })
    } catch (error) {
      if (!(error instanceof AuthEpochStaleError) && ownerGen.current === gen)
        toast(taskboardErrorMessage(error, '加载历史失败'), 'error')
    }
  }

  const runPatrol = async (retry = false) => {
    if (!current) return
    const gen = ownerGen.current
    setPatrolling(true)
    try {
      let ready = current
      if (retry && executionRef.current) hydrateResult(executionRef.current)
      if (retry && current.status !== 'ready') {
        ready = (await taskboardApi.ready(auth, current.id, current.version)).ticket
        if (ownerGen.current !== gen) return
        if (!currentRef.current || ready.version >= currentRef.current.version) {
          currentRef.current = ready
          setDetail(ready)
          onTicketUpdated(ready)
        }
      }
      const out = await taskboardApi.patrol(auth, ready.id, ready.version)
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
      if (['stage_agent_unavailable', 'stage_model_unavailable'].includes(boardErrorCode(e) ?? ''))
        setExecutionNeedsSetup(true)
      toast(taskboardErrorMessage(e, '启动巡检失败'), 'error')
    } finally {
      if (ownerGen.current === gen) setPatrolling(false)
    }
  }

  const stopRun = async () => {
    if (!current || !activeExecution || stopState) return
    const gen = ownerGen.current
    const requestedRunId = activeExecution.id
    const stillOwnsRun = () =>
      executionRef.current?.id === requestedRunId &&
      (executionRef.current.status === 'running' ||
        executionRef.current.status === 'queued' ||
        executionRef.current.settling === true)
    setStopState('requesting')
    try {
      const out = await taskboardApi.stopRun(auth, current.id, current.version, requestedRunId)
      if (ownerGen.current !== gen || !stillOwnsRun()) return
      if (!currentRef.current || out.ticket.version >= currentRef.current.version) {
        currentRef.current = out.ticket
        setDetail(out.ticket)
        onTicketUpdated(out.ticket)
      }
      setStopState(out.state === 'stopping' ? 'stopping' : null)
      toast(
        out.state === 'stopping' ? '已请求停止，正在保留输出并收尾' : '本次执行已结束',
        'success',
      )
      void refreshAfterWrite(current.identifier, gen)
    } catch (error) {
      if (ownerGen.current !== gen || !stillOwnsRun()) return
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
          ref={scrollContainer}
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
                  <output className="block text-caption text-warning">
                    任务已被更新，当前草稿已保留。保存时会检查冲突；可放弃修改后重新编辑最新内容。
                  </output>
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
              <details
                open={desktop}
                onToggle={(event) => setDescriptionOpen(event.currentTarget.open)}
                className="rounded-lg border border-border px-3 py-2"
              >
                <summary className="cursor-pointer text-caption font-medium text-muted">
                  任务说明
                </summary>
                {descriptionOpen && (
                  <div className="mt-2">
                    <TicketMarkdown testId="ticket-body-md">{current.body}</TicketMarkdown>
                  </div>
                )}
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
          {needsSetup && (
            <div className="rounded-lg border border-border bg-hover px-3 py-2 text-body">
              <p>执行助手待配置，请先选择已安装且可用的助手。</p>
              {onConfigureStage && (
                <Button
                  type="button"
                  className="mt-2 min-h-11"
                  variant="secondary"
                  data-testid="ticket-configure-execution"
                  onClick={onConfigureStage}
                >
                  配置执行助手
                </Button>
              )}
            </div>
          )}

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
              <Button
                type="button"
                size="sm"
                variant="danger"
                className="min-h-11"
                data-testid="ticket-drawer-stop"
                loading={stopState === 'requesting'}
                disabled={stopState !== null}
                onClick={() => void stopRun()}
              >
                {stopState === 'requesting'
                  ? '请求停止…'
                  : stopState === 'stopping'
                    ? '停止处理中'
                    : '停止本次执行'}
              </Button>
            )}
            {canRetry && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="min-h-11"
                loading={patrolling}
                data-testid="ticket-drawer-retry"
                onClick={() => void runPatrol(true)}
              >
                重新执行本阶段
              </Button>
            )}
            {canStart && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={patrolling}
                data-testid="ticket-drawer-patrol"
                className="min-h-11"
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
                title={
                  originUsable ? undefined : '来源会话不在当前列表中，可能已删除或不是网页对话'
                }
                onClick={openOrigin}
              >
                回到来源会话
              </Button>
            )}
          </div>

          {historyStatus.initialized &&
            (historyStatus.hasMore || !historyStatus.supported || historyStatus.error) && (
              <div
                className="flex flex-wrap items-center gap-2 text-caption text-muted"
                data-testid="timeline-history-controls"
              >
                <span>
                  {historyStatus.hasGap
                    ? '有活动尚未载入'
                    : historyStatus.supported
                      ? '显示最近记录，可继续查看更早历史'
                      : '历史可能尚未完整载入'}
                </span>
                {historyStatus.hasMore && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="min-h-11"
                    data-testid="timeline-load-earlier"
                    loading={historyStatus.loading}
                    onClick={() => void loadEarlier()}
                  >
                    {historyStatus.hasGap ? '加载缺失记录' : '加载更早记录'}
                  </Button>
                )}
                {historyStatus.error && <output>{historyStatus.error}</output>}
              </div>
            )}
          {resultError && (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              data-testid="retry-run-result"
              onClick={() => {
                for (const failed of history.resultFailures.values()) hydrateResult(failed)
              }}
            >
              完整结果暂未加载，点击重试
            </Button>
          )}
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
