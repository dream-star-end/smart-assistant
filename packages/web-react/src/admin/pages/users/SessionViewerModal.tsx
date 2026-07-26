import { Eye, MessageSquareText, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageList, type MessageListArchive } from '../../../components/MessageRenderer'
import { MessageListSkeleton } from '../../../components/chat/HistorySkeleton'
import type { PermissionRespond } from '../../../components/chat/PermissionCard'
import {
  captureVisibleVirtualRowAnchor,
  restoreVisibleVirtualRowAnchor,
  type VisibleVirtualRowAnchor,
} from '../../../components/chat/archivePaging'
import type { CardCallbacks } from '../../../components/chat/cards'
import { MediaSignProvider } from '../../../components/chat/media'
import { Alert, Badge, Button, EmptyState, Modal } from '../../../components/ui'
import type { ChatMessage } from '../../../lib/chat/model'
import { DeferredPayloadQueue } from '../../../lib/chat/deferredPayloadQueue'
import { mergeTimelineHistoryPage } from '../../../lib/persist'
import { parseTapeRecordPayload, type TapePayloadExpectation } from '../../../lib/chat/tapePayload'
import { ApiError, adminGet, adminGetExactPayload, adminSend, apiErrorMessage } from '../../lib/adminApi'
import { fmtInt } from './format'
import type { UserSessionSummary } from './types'

const HISTORY_PAGE_SIZE = 100
const READ_ONLY_PERMISSION: PermissionRespond = () => {}

type ChatSessionPayload = {
  session: {
    id: string
    user_id: string
    agent_id: string
    title: string
    pinned: boolean
    created_at: number
    last_at: number
    updated_at: number
    messages: ChatMessage[]
    archived_count: number
    archived_through_seq: number
    timeline_generation: number
    timeline_cursor: string | null
    timeline_has_more: boolean
    timeline_snapshot_max_seq: number
  }
}

type TimelinePayload = {
  session_id: string
  messages: ChatMessage[]
  next_cursor: string | null
  has_more: boolean
  timeline_generation: number
}

type MediaSignPayload = { urls: Record<string, string>; expMs: number }

type ScrollAnchor = {
  token: number
  capturedScrollTop: number
  timelineGeneration: number | null
  row: VisibleVirtualRowAnchor | null
  ready: boolean
  cancelled: boolean
  restoring: boolean
  settle: () => void
}

/**
 * admin 用户会话只读查看器。
 *
 * 消息渲染完全复用用户端 MessageList；这里只负责 admin 鉴权数据源、归档游标、目标用户
 * 媒体短签和弹窗滚动。这样工具/思考/团队卡随用户端演进自动保持同一展示语义。
 */
export function SessionViewerModal({
  session,
  userId,
  userEmail,
  onClose,
}: {
  session: UserSessionSummary | null
  userId: string | null
  userEmail?: string | null
  onClose: () => void
}) {
  const [payload, setPayload] = useState<ChatSessionPayload['session'] | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [timelineCursor, setTimelineCursor] = useState<string | null>(null)
  const [timelineGeneration, setTimelineGeneration] = useState<number | null>(null)
  const timelineGenerationRef = useRef<number | null>(timelineGeneration)
  timelineGenerationRef.current = timelineGeneration
  const [archiveHasMore, setArchiveHasMore] = useState(false)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveError, setArchiveError] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null)
  const bindScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    setScrollParent((current) => current === node ? current : node)
  }, [])
  const initialScrollPendingRef = useRef(false)
  const archiveScrollAnchorRef = useRef<ScrollAnchor | null>(null)
  const archiveRequestTokenRef = useRef(0)
  const settleArchiveAnchor = useCallback((token?: number) => {
    const anchor = archiveScrollAnchorRef.current
    if (!anchor || (token !== undefined && anchor.token !== token)) return
    archiveScrollAnchorRef.current = null
    anchor.settle()
  }, [])
  const loadGenerationRef = useRef(0)
  const deferredPayloadCacheRef = useRef<{ key: string; records: ChatMessage[] } | null>(null)
  const deferredPayloadQueueRef = useRef<DeferredPayloadQueue<ChatMessage[]> | null>(null)
  if (!deferredPayloadQueueRef.current) {
    deferredPayloadQueueRef.current = new DeferredPayloadQueue<ChatMessage[]>(2)
  }

  const sessionId = session?.session_id ?? null

  const loadSession = useCallback(() => {
    settleArchiveAnchor()
    const generation = ++loadGenerationRef.current
    archiveRequestTokenRef.current += 1
    setPayload(null)
    setMessages([])
    setError(null)
    setTimelineCursor(null)
    setTimelineGeneration(null)
    setArchiveHasMore(false)
    setArchiveLoading(false)
    setArchiveError(false)
    deferredPayloadQueueRef.current?.cancelAll()
    deferredPayloadCacheRef.current = null
    initialScrollPendingRef.current = false
    if (!sessionId || !userId) {
      setLoading(false)
      return
    }

    setLoading(true)
    void adminGet<ChatSessionPayload>(`/sessions/${encodeURIComponent(sessionId)}`, {
      user_id: userId,
      view: 'timeline',
    })
      .then((result) => {
        if (generation !== loadGenerationRef.current) return
        const next = result.session
        const nextMessages = Array.isArray(next.messages) ? next.messages : []
        setPayload(next)
        setMessages(nextMessages)
        setTimelineCursor(next.timeline_cursor)
        setTimelineGeneration(next.timeline_generation)
        setArchiveHasMore(next.timeline_has_more === true)
        initialScrollPendingRef.current = true
      })
      .catch((err) => {
        if (generation === loadGenerationRef.current) setError(err)
      })
      .finally(() => {
        if (generation === loadGenerationRef.current) setLoading(false)
      })
  }, [sessionId, settleArchiveAnchor, userId])

  useEffect(() => {
    loadSession()
    return () => {
      loadGenerationRef.current++
      archiveRequestTokenRef.current++
      settleArchiveAnchor()
      deferredPayloadQueueRef.current?.cancelAll()
    }
  }, [loadSession, settleArchiveAnchor])

  // 初载像用户打开会话一样落在最新消息；只有对应归档响应 ready 后才消费前插锚点。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (initialScrollPendingRef.current) {
      initialScrollPendingRef.current = false
      el.scrollTop = el.scrollHeight
      return
    }
    const anchor = archiveScrollAnchorRef.current
    if (!anchor?.ready) return
    if (
      anchor.cancelled || !anchor.row ||
      anchor.timelineGeneration !== timelineGeneration
    ) {
      settleArchiveAnchor(anchor.token)
      return
    }
    if (anchor.restoring) return
    anchor.restoring = true
    void restoreVisibleVirtualRowAnchor(
      el,
      anchor.row,
      () => {
        const current = archiveScrollAnchorRef.current
        return !current || current.token !== anchor.token || current.cancelled ||
          current.timelineGeneration !== timelineGenerationRef.current
      },
    ).finally(() => settleArchiveAnchor(anchor.token))
  }, [archiveLoading, messages, settleArchiveAnchor, timelineGeneration])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    const anchor = archiveScrollAnchorRef.current
    if (
      el && anchor && !anchor.cancelled && !anchor.restoring &&
      Math.abs(el.scrollTop - anchor.capturedScrollTop) > 1
    ) {
      anchor.cancelled = true
    }
  }, [])

  const cancelArchiveCorrection = useCallback(() => {
    const anchor = archiveScrollAnchorRef.current
    if (anchor) anchor.cancelled = true
  }, [])

  const loadOlder = useCallback(async () => {
    if (
      !sessionId || !userId || archiveLoading || !archiveHasMore ||
      !timelineCursor || timelineGeneration === null
    ) return
    const generation = loadGenerationRef.current
    settleArchiveAnchor()
    const token = ++archiveRequestTokenRef.current
    const el = scrollRef.current
    let resolveAnchor: (() => void) | null = null
    const anchorSettled = el
      ? new Promise<void>((resolve) => { resolveAnchor = resolve })
      : Promise.resolve()
    const settle = () => {
      const resolve = resolveAnchor
      resolveAnchor = null
      resolve?.()
    }
    archiveScrollAnchorRef.current = el
      ? {
        token,
        capturedScrollTop: el.scrollTop,
        timelineGeneration,
        row: captureVisibleVirtualRowAnchor(el),
        ready: false,
        cancelled: false,
        restoring: false,
        settle,
      }
      : null
    setArchiveLoading(true)
    setArchiveError(false)
    try {
      const requestedCursor = timelineCursor
      const page = await adminGet<TimelinePayload>(
        `/sessions/${encodeURIComponent(sessionId)}/timeline`,
        { user_id: userId, cursor: requestedCursor, limit: HISTORY_PAGE_SIZE },
      )
      if (generation !== loadGenerationRef.current) return
      if (
        page.session_id !== sessionId ||
        page.timeline_generation !== timelineGeneration
      ) {
        settleArchiveAnchor(token)
        loadSession()
        return
      }
      const older = Array.isArray(page.messages) ? page.messages : []
      if (older.length > 0) {
        const anchor = archiveScrollAnchorRef.current
        if (anchor?.token === token) anchor.ready = true
        const pageKey = `admin-history:${timelineGeneration}:${requestedCursor}`
        setMessages((current) => mergeTimelineHistoryPage(current, older.map((message) => ({
          ...message,
          _timelineRecord: true,
          _historyPageLoadedFrom: requestedCursor,
          _historyPageKey: pageKey,
        }))))
      }
      setTimelineCursor(page.next_cursor)
      setArchiveHasMore(page.has_more && typeof page.next_cursor === 'string')
      if (older.length === 0 && archiveScrollAnchorRef.current?.token === token) {
        settleArchiveAnchor(token)
      }
    } catch (err) {
      if (
        generation !== loadGenerationRef.current ||
        archiveRequestTokenRef.current !== token
      ) return
      settleArchiveAnchor(token)
      if (err instanceof ApiError && err.status === 409) {
        loadSession()
        return
      }
      setArchiveError(true)
    } finally {
      if (
        generation === loadGenerationRef.current &&
        archiveRequestTokenRef.current === token
      ) setArchiveLoading(false)
    }
    await anchorSettled
  }, [
    archiveHasMore,
    archiveLoading,
    loadSession,
    sessionId,
    settleArchiveAnchor,
    timelineCursor,
    timelineGeneration,
    userId,
  ])

  const archive = useMemo<MessageListArchive | undefined>(() => {
    if (!payload) return undefined
    return {
      hasMore: archiveHasMore,
      loading: archiveLoading,
      error: archiveError,
      onLoadOlder: loadOlder,
    }
  }, [archiveError, archiveHasMore, archiveLoading, loadOlder, payload])

  const signMedia = useCallback(
    async (paths: string[]) => {
      if (!sessionId || !userId) return {}
      const result = await adminSend<MediaSignPayload>(
        'POST',
        `/sessions/${encodeURIComponent(sessionId)}/media-sign?user_id=${encodeURIComponent(userId)}`,
        { paths },
      )
      return result.urls
    },
    [sessionId, userId],
  )

  const fetchExactPayload = useCallback(async (
    path: string,
    cacheKey: string,
    expected: TapePayloadExpectation,
    signal?: AbortSignal,
  ): Promise<ChatMessage[] | null> => {
    if (!userId || signal?.aborted) return null
    if (deferredPayloadCacheRef.current?.key === cacheKey) {
      return deferredPayloadCacheRef.current.records
    }
    const generation = loadGenerationRef.current
    return deferredPayloadQueueRef.current!.request(cacheKey, async (queueSignal) => {
      const payload = await adminGetExactPayload(path, { user_id: userId }, queueSignal)
      const records = await parseTapeRecordPayload(payload, expected, queueSignal)
      if (queueSignal.aborted || generation !== loadGenerationRef.current) {
        throw new DOMException('session changed', 'AbortError')
      }
      deferredPayloadCacheRef.current = { key: cacheKey, records }
      return records
    }, signal)
  }, [userId])

  const fetchTapePayload = useCallback<NonNullable<CardCallbacks['onFetchTapeRecordPayload']>>((
    tapeId,
    recordOrdinal,
    expected,
    signal,
  ) => {
    if (!sessionId) return Promise.resolve(null)
    return fetchExactPayload(
      `/sessions/${encodeURIComponent(sessionId)}/tape/${encodeURIComponent(tapeId)}` +
        `/records/${recordOrdinal}/payload`,
      JSON.stringify([userId, sessionId, 'tape', tapeId, recordOrdinal, expected]),
      expected,
      signal,
    )
  }, [fetchExactPayload, sessionId, userId])

  const fetchUserPayload = useCallback<NonNullable<CardCallbacks['onFetchUserMessagePayload']>>((
    messageId,
    expected,
    signal,
  ) => {
    if (!sessionId) return Promise.resolve(null)
    return fetchExactPayload(
      `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/payload`,
      JSON.stringify([userId, sessionId, 'user', messageId, expected]),
      expected,
      signal,
    )
  }, [fetchExactPayload, sessionId, userId])

  const cardCallbacks = useMemo<CardCallbacks>(() => ({
    onFetchTapeRecordPayload: fetchTapePayload,
    onFetchUserMessagePayload: fetchUserPayload,
  }), [fetchTapePayload, fetchUserPayload])

  const displayTitle = payload?.title || session?.title || '(无标题)'
  const recordCount = session?.message_count ?? messages.length

  return (
    <Modal
      open={session !== null && userId !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <MessageSquareText size={17} className="shrink-0 text-accent" />
          <span className="truncate">{displayTitle}</span>
          <Badge tone="neutral" className="shrink-0 gap-1">
            <Eye size={11} /> 只读
          </Badge>
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{userEmail || `用户 #${userId}`}</span>
          <span aria-hidden>·</span>
          <code>{payload?.agent_id || session?.agent_id || '—'}</code>
          <span aria-hidden>·</span>
          <span>{fmtInt(recordCount)} 条记录</span>
          {sessionId && (
            <>
              <span aria-hidden>·</span>
              <code className="max-w-[18rem] truncate" title={sessionId}>
                {sessionId}
              </code>
            </>
          )}
        </span>
      }
      // 高度上限走 --oc-center-max-h 而不是 max-h-*:.oc-center-dialog 是未分层的普通 CSS
      // 规则,其 max-height 打得过 @layer utilities 里的工具类,写 max-h-[56rem] 会被它
      // 压回 85dvh(会话查看器要的是接近全屏)。变量参与 min() 运算,可视区兜底仍生效。
      className="h-[calc(100dvh-2rem)] [--oc-center-max-h:56rem] max-w-5xl bg-bg sm:w-[calc(100vw-3rem)]"
      bodyClassName="overflow-hidden p-0"
    >
      <MediaSignProvider
        sign={signMedia}
        authKey={sessionId && userId ? `admin-session:${userId}:${sessionId}` : null}
      >
        <div
          ref={bindScroll}
          onScroll={onScroll}
          onWheel={cancelArchiveCorrection}
          onTouchStart={cancelArchiveCorrection}
          onPointerDown={cancelArchiveCorrection}
          onKeyDown={cancelArchiveCorrection}
          className="chat-scroll-area h-full min-h-0 overflow-y-auto overflow-x-hidden bg-bg"
        >
          {loading && !payload ? (
            <MessageListSkeleton />
          ) : error ? (
            <div className="mx-auto flex max-w-xl flex-col gap-3 px-5 py-12">
              <Alert tone="danger">加载会话失败：{apiErrorMessage(error, '请求失败')}</Alert>
              <Button variant="secondary" className="mx-auto gap-1.5" onClick={loadSession}>
                <RefreshCw size={14} /> 重试
              </Button>
            </div>
          ) : payload && messages.length === 0 ? (
            <div className="flex min-h-full items-center justify-center px-5 py-12">
              <EmptyState
                icon={MessageSquareText}
                title="该会话暂无消息"
                hint="会话元数据存在，但还没有可展示的对话内容。"
              />
            </div>
          ) : payload ? (
            <MessageList
              key={`${userId}:${sessionId}`}
              messages={messages}
              sending={false}
              archive={archive}
              cb={cardCallbacks}
              onRespondPermission={READ_ONLY_PERMISSION}
              readOnly
              scrollParent={scrollParent}
              historyGeneration={timelineGeneration ?? 'legacy'}
            />
          ) : null}
        </div>
      </MediaSignProvider>
    </Modal>
  )
}
