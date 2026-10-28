/**
 * Focused session-display page: real ChatSocket, MessageList, Composer, and
 * the queued-send list. Product components are not modified. The page is
 * served by the mock gateway so visibility and offline hit a real WebSocket.
 */
import { Component, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { Composer } from '../../src/components/Composer'
import { MessageList } from '../../src/components/MessageRenderer'
import { BackgroundTurnBanner } from '../../src/components/chat/BackgroundTurnBanner'
import { QueuedSendList } from '../../src/components/chat/QueuedSendList'
import { useBackgroundTurn } from '../../src/hooks/useBackgroundTurn'
import { ToastProvider } from '../../src/components/ui/Toast'
import { TooltipProvider } from '../../src/components/ui/Tooltip'
import { type ChatMessage, isTurnDetached } from '../../src/lib/chat/model'
import { ChatSocket } from '../../src/lib/chat/socket'

const SESSION_ID = 'sdsession1'
const AGENT = 'main'

type SessionPayload = {
  agentId?: string
  messages?: ChatMessage[]
  maxSeq?: number
  openDispatch?: {
    dispatchId: string
    clientMessageId: string
    status: string
  }
  timelineGeneration?: number
  updatedAt?: number
  historyRevision?: number
}

type SdDebug = {
  sending: boolean
  label: string
  cls: string
  detached: boolean
  turn: string
  texts: string[]
}

declare global {
  interface Window {
    __sd?: SdDebug
  }
}

function applyDetail(socket: ChatSocket, sessId: string, detail: SessionPayload): void {
  socket.applyServerMessages(
    sessId,
    detail.agentId || AGENT,
    Array.isArray(detail.messages) ? detail.messages : [],
    true,
    detail.maxSeq,
    {
      openDispatch: detail.openDispatch,
      timelineGeneration: detail.timelineGeneration ?? 1,
      serverUpdatedAt: detail.updatedAt,
      historyRevision: detail.historyRevision ?? 1,
    },
  )
}

function createSocket(): ChatSocket {
  const box: { socket?: ChatSocket } = {}
  const socket = new ChatSocket({
    getToken: () => 'sd-token',
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: 'transient', epoch, retryAfterMs: 3_600_000 }),
    onAuthExpired: () => {},
    defaultAgentId: AGENT,
    syncSession: async (sessId) => {
      const current = box.socket
      if (!current) return false
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessId)}`)
      if (!res.ok) return false
      applyDetail(current, sessId, (await res.json()) as SessionPayload)
      return true
    },
  })
  box.socket = socket
  return socket
}

class HarnessBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }

  static getDerivedStateFromError(error: Error): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  render() {
    if (this.state.error) {
      return <pre data-testid="harness-error">{this.state.error}</pre>
    }
    return this.props.children
  }
}

function SessionDisplay() {
  const socketRef = useRef<ChatSocket | null>(null)
  if (!socketRef.current) socketRef.current = createSocket()
  const socket = socketRef.current
  const snap = useSyncExternalStore(socket.subscribe, socket.getSnapshot)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const session = snap.sessions.get(SESSION_ID)
  const messages = session?.messages ?? []
  const sending = socket.isSessionBusy(SESSION_ID)
  const queued = messages.filter(
    (message) => message.role === 'user' && message.status === 'queued',
  )
  const backgroundTurn = useBackgroundTurn({
    chat: {
      status: snap.status,
      dispatchStatus: (sessId) => (sessId ? socket.getDispatchStatus(sessId) : null),
    },
    sess: session,
    enabled: true,
    queuedCount: queued.length,
    compact: false,
    confirm: async () => true,
  })

  useEffect(() => {
    let cancelled = false
    const boot = new URLSearchParams(location.search).get('boot')
    const run = async () => {
      if (boot === 'cold') {
        const res = await fetch(`/api/sessions/${encodeURIComponent(SESSION_ID)}`)
        const detail = (await res.json()) as SessionPayload
        if (cancelled) return
        applyDetail(socket, SESSION_ID, detail)
      } else {
        socket.ensureSession(SESSION_ID, AGENT, '边界剧本')
      }
      if (cancelled) return
      socket.start()
      socket.setGateReady(true)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [socket])

  useEffect(() => {
    const turn = session?._turnStatus
    window.__sd = {
      sending,
      label: snap.status.label,
      cls: snap.status.cls,
      detached: session ? isTurnDetached(session) : false,
      turn: typeof turn === 'string' ? turn : turn ? 'object' : '',
      texts: messages.map(
        (message) => `${message.role}:${message.status ?? ''}:${message.text ?? ''}`,
      ),
    }
  }, [messages, sending, session, snap.status.cls, snap.status.label])

  return (
    <div data-testid="session-display" style={{ minHeight: 360 }}>
      <div ref={setScroller} className="chat-scroll-area" style={{ minHeight: 200 }}>
        <MessageList
          processDisclosure
          messages={messages}
          sending={sending}
          turnActivity={
            sending
              ? {
                  startedAt: session?._turnStartedAt ?? null,
                  lastFrameAt: session?._lastFrameAt,
                  transport: snap.status.cls,
                  detached: session ? isTurnDetached(session) : false,
                  progressHint: session?._turnProgressHint,
                  turnStatus: session?._turnStatus ?? null,
                  agentName: '助手',
                }
              : null
          }
          cb={{}}
          onRespondPermission={() => {}}
          scrollParent={scroller}
          historyGeneration={`session-display::${SESSION_ID}`}
          sessionId={SESSION_ID}
        />
      </div>
      <QueuedSendList
        messages={queued}
        onEdit={() => {}}
        onDelete={() => {}}
        onSendNow={() => {}}
      />
      {backgroundTurn.notice ? <BackgroundTurnBanner notice={backgroundTurn.notice} /> : null}
      <Composer
        busy={sending}
        onStop={() => socket.stopTurn(SESSION_ID)}
        onSend={(text) => {
          void socket.sendMessage({ sessId: SESSION_ID, agentId: AGENT, text })
        }}
      />
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(
  <HarnessBoundary>
    <ToastProvider>
      <TooltipProvider>
        <SessionDisplay />
      </TooltipProvider>
    </ToastProvider>
  </HarnessBoundary>,
)
