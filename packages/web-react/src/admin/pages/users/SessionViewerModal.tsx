import { Eye, MessageSquareText, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageList, type MessageListArchive } from '../../../components/MessageRenderer'
import { MessageListSkeleton } from '../../../components/chat/HistorySkeleton'
import type { PermissionRespond } from '../../../components/chat/PermissionCard'
import { correctedScrollTop, loadedArchivedMetrics } from '../../../components/chat/archivePaging'
import type { CardCallbacks } from '../../../components/chat/cards'
import { MediaSignProvider } from '../../../components/chat/media'
import { Alert, Badge, Button, EmptyState, Modal } from '../../../components/ui'
import type { ChatMessage } from '../../../lib/chat/model'
import { adminGet, adminSend, apiErrorMessage } from '../../lib/adminApi'
import { fmtInt } from './format'
import type { UserSessionSummary } from './types'

const ARCHIVE_PAGE_SIZE = 100
const EMPTY_CARD_CALLBACKS: CardCallbacks = Object.freeze({})
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
  }
}

type ArchivePayload = {
  session_id: string
  messages: ChatMessage[]
  oldest_seq: number | null
  has_more: boolean
}

type MediaSignPayload = { urls: Record<string, string>; expMs: number }

type ScrollAnchor = { prevHeight: number; prevTop: number }

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
  const [archiveBefore, setArchiveBefore] = useState(0)
  const [archiveHasMore, setArchiveHasMore] = useState(false)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveError, setArchiveError] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const initialScrollPendingRef = useRef(false)
  const archiveScrollAnchorRef = useRef<ScrollAnchor | null>(null)
  const loadGenerationRef = useRef(0)

  const sessionId = session?.session_id ?? null

  const loadSession = useCallback(() => {
    const generation = ++loadGenerationRef.current
    setPayload(null)
    setMessages([])
    setError(null)
    setArchiveBefore(0)
    setArchiveHasMore(false)
    setArchiveLoading(false)
    setArchiveError(false)
    archiveScrollAnchorRef.current = null
    initialScrollPendingRef.current = false
    if (!sessionId || !userId) {
      setLoading(false)
      return
    }

    setLoading(true)
    void adminGet<ChatSessionPayload>(`/sessions/${encodeURIComponent(sessionId)}`, {
      user_id: userId,
      view: 'chat',
    })
      .then((result) => {
        if (generation !== loadGenerationRef.current) return
        const next = result.session
        const nextMessages = Array.isArray(next.messages) ? next.messages : []
        setPayload(next)
        setMessages(nextMessages)
        setArchiveHasMore((next.archived_count ?? 0) > 0)
        initialScrollPendingRef.current = true
      })
      .catch((err) => {
        if (generation === loadGenerationRef.current) setError(err)
      })
      .finally(() => {
        if (generation === loadGenerationRef.current) setLoading(false)
      })
  }, [sessionId, userId])

  useEffect(() => {
    loadSession()
    return () => {
      loadGenerationRef.current++
    }
  }, [loadSession])

  // 初载像用户打开会话一样落在最新消息；前插归档后按高度差校正，原可见位置不跳。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅 messages 改变后 DOM 高度才已更新，loading 重渲不能提前消费 anchor。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (initialScrollPendingRef.current) {
      initialScrollPendingRef.current = false
      el.scrollTop = el.scrollHeight
      return
    }
    const anchor = archiveScrollAnchorRef.current
    if (!anchor) return
    if (el.scrollHeight > anchor.prevHeight) {
      el.scrollTop = correctedScrollTop(anchor.prevHeight, el.scrollHeight, anchor.prevTop)
    }
    archiveScrollAnchorRef.current = null
  }, [messages])

  const loadOlder = useCallback(async () => {
    if (!sessionId || !userId || archiveLoading || !archiveHasMore) return
    const generation = loadGenerationRef.current
    const el = scrollRef.current
    if (el) {
      archiveScrollAnchorRef.current = {
        prevHeight: el.scrollHeight,
        prevTop: el.scrollTop,
      }
    }
    setArchiveLoading(true)
    setArchiveError(false)
    try {
      const page = await adminGet<ArchivePayload>(
        `/sessions/${encodeURIComponent(sessionId)}/archive`,
        { user_id: userId, before: archiveBefore, limit: ARCHIVE_PAGE_SIZE },
      )
      if (generation !== loadGenerationRef.current) return
      if (page.session_id !== sessionId) throw new Error('会话归档响应不匹配')
      const older = Array.isArray(page.messages) ? page.messages : []
      if (older.length > 0) setMessages((current) => [...older, ...current])
      if (page.oldest_seq != null) setArchiveBefore(page.oldest_seq)
      setArchiveHasMore(page.has_more)
      if (older.length === 0) archiveScrollAnchorRef.current = null
    } catch {
      if (generation !== loadGenerationRef.current) return
      archiveScrollAnchorRef.current = null
      setArchiveError(true)
    } finally {
      if (generation === loadGenerationRef.current) setArchiveLoading(false)
    }
  }, [archiveBefore, archiveHasMore, archiveLoading, sessionId, userId])

  const archive = useMemo<MessageListArchive | undefined>(() => {
    if (!payload) return undefined
    const loaded = loadedArchivedMetrics(messages, payload.archived_through_seq).anchors
    return {
      // 后端明确已翻尽时以实际 distinct anchor 数收口，避免存量异常计数留下幽灵按钮。
      archivedCount: archiveHasMore ? payload.archived_count : loaded,
      archivedThroughSeq: payload.archived_through_seq,
      loading: archiveLoading,
      error: archiveError,
      onLoadOlder: () => void loadOlder(),
    }
  }, [archiveError, archiveHasMore, archiveLoading, loadOlder, messages, payload])

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
      className="h-[calc(100dvh-2rem)] max-h-[56rem] max-w-5xl bg-bg sm:w-[calc(100vw-3rem)]"
      bodyClassName="overflow-hidden p-0"
    >
      <MediaSignProvider
        sign={signMedia}
        authKey={sessionId && userId ? `admin-session:${userId}:${sessionId}` : null}
      >
        <div ref={scrollRef} className="h-full min-h-0 overflow-y-auto overflow-x-hidden bg-bg">
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
              messages={messages}
              sending={false}
              archive={archive}
              cb={EMPTY_CARD_CALLBACKS}
              onRespondPermission={READ_ONLY_PERMISSION}
              readOnly
            />
          ) : null}
        </div>
      </MediaSignProvider>
    </Modal>
  )
}
