import {
  CONTAINER_PREVIEW_PUBLIC_WS_PATH,
  CONTAINER_PREVIEW_TICKET_PROTOCOL,
  type ContainerPreviewClientMessage,
  type ContainerPreviewElementTarget,
  type ContainerPreviewFrameHeader,
  type ContainerPreviewServerMessage,
  type ContainerPreviewViewport,
  decodeContainerPreviewFrame,
} from '@openclaude/protocol/containerPreview'
import { useCallback, useEffect, useRef, useState } from 'react'

import { api, apiErrorMessage } from '../lib/api'
import type { AuthSession } from '../lib/types'

export type ContainerPreviewPhase =
  | 'idle'
  | 'ticket'
  | 'connecting'
  | 'probing'
  | 'launching'
  | 'loading'
  | 'ready'
  | 'closed'

export type ContainerPreviewFrame = {
  header: ContainerPreviewFrameHeader
  jpeg: Uint8Array
  receivedAt: number
}

export type ContainerPreviewSelectionEvent = {
  sequence: number
  target: ContainerPreviewElementTarget | null
}

export type ContainerPreviewResolvedEvent = {
  sequence: number
  selector: string
  target: ContainerPreviewElementTarget | null
}

export type ContainerPreviewNavigation = {
  sequence: number
  url: string
  title: string
  pageRevision: number
}

export function containerPreviewWebSocketUrl(origin: string): string {
  const url = new URL(CONTAINER_PREVIEW_PUBLIC_WS_PATH, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export function useContainerPreview({
  auth,
  url,
  viewport,
  enabled,
  reconnectKey,
  onFrame,
}: {
  auth: AuthSession | null
  url: string
  viewport: ContainerPreviewViewport
  enabled: boolean
  reconnectKey: number
  onFrame: (frame: ContainerPreviewFrame) => void
}) {
  const socketRef = useRef<WebSocket | null>(null)
  const onFrameRef = useRef(onFrame)
  const lastFrameRef = useRef<{ revision: number; sequence: number }>({ revision: 0, sequence: 0 })
  const explicitCloseRef = useRef(false)
  const eventSequenceRef = useRef(0)
  const [phase, setPhase] = useState<ContainerPreviewPhase>('idle')
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null)
  const [ready, setReady] = useState<{
    url: string
    title: string
    viewport: ContainerPreviewViewport
  } | null>(null)
  const [selection, setSelection] = useState<ContainerPreviewSelectionEvent | null>(null)
  const [resolved, setResolved] = useState<ContainerPreviewResolvedEvent | null>(null)
  const [navigation, setNavigation] = useState<ContainerPreviewNavigation | null>(null)

  onFrameRef.current = onFrame

  const send = useCallback((message: ContainerPreviewClientMessage): boolean => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }, [])

  useEffect(() => {
    // reconnectKey is an explicit session-generation input: changing it must
    // tear down the current one-use ticket/socket even when URL and viewport
    // are unchanged (manual retry).
    void reconnectKey
    if (!enabled || !auth || !url) {
      setPhase('idle')
      return
    }
    let cancelled = false
    explicitCloseRef.current = false
    lastFrameRef.current = { revision: 0, sequence: 0 }
    setPhase('ticket')
    setError(null)
    setReady(null)
    setSelection(null)
    setResolved(null)
    setNavigation(null)

    void api
      .createContainerPreviewTicket(auth, url, viewport)
      .then((issued) => {
        if (cancelled) return
        const socket = new WebSocket(containerPreviewWebSocketUrl(window.location.origin), [
          CONTAINER_PREVIEW_TICKET_PROTOCOL,
          issued.ticket,
        ])
        socket.binaryType = 'arraybuffer'
        socketRef.current = socket
        setPhase('connecting')

        socket.onopen = () => {
          if (socket.protocol !== CONTAINER_PREVIEW_TICKET_PROTOCOL) {
            setError({ message: '网页预览安全协议协商失败，请重试', retryable: true })
            socket.close(1002, 'preview protocol mismatch')
          }
        }

        socket.onmessage = (event) => {
          if (cancelled) return
          if (event.data instanceof ArrayBuffer) {
            try {
              const frame = decodeContainerPreviewFrame(event.data)
              const last = lastFrameRef.current
              if (
                frame.header.pageRevision < last.revision ||
                (frame.header.pageRevision === last.revision &&
                  frame.header.frameSequence <= last.sequence)
              )
                return
              lastFrameRef.current = {
                revision: frame.header.pageRevision,
                sequence: frame.header.frameSequence,
              }
              onFrameRef.current({ ...frame, receivedAt: performance.now() })
            } catch {
              // A malformed binary frame cannot be rendered; leave the last good
              // frame visible and let the session continue or close server-side.
            }
            return
          }
          if (typeof event.data !== 'string') return
          let message: ContainerPreviewServerMessage
          try {
            message = JSON.parse(event.data) as ContainerPreviewServerMessage
          } catch {
            return
          }
          switch (message.type) {
            case 'preview.status':
              setPhase(message.status)
              return
            case 'preview.ready':
              setReady({ url: message.url, title: message.title, viewport: message.viewport })
              setNavigation({
                sequence: ++eventSequenceRef.current,
                url: message.url,
                title: message.title,
                pageRevision: 0,
              })
              setPhase('ready')
              return
            case 'preview.navigation':
              setNavigation({ ...message, sequence: ++eventSequenceRef.current })
              return
            case 'preview.selection':
              setSelection({ sequence: ++eventSequenceRef.current, target: message.target })
              return
            case 'preview.resolved':
              setResolved({ ...message, sequence: ++eventSequenceRef.current })
              return
            case 'preview.error':
              setError({ message: message.message, retryable: message.retryable })
              return
          }
        }
        socket.onclose = () => {
          if (socketRef.current === socket) socketRef.current = null
          if (!cancelled && !explicitCloseRef.current) setPhase('closed')
        }
        socket.onerror = () => {
          if (!cancelled) {
            setError(
              (current) => current ?? { message: '网页预览连接失败，请重试', retryable: true },
            )
          }
        }
      })
      .catch((err) => {
        if (cancelled) return
        setError({ message: apiErrorMessage(err, '网页预览暂不可用，请稍后重试'), retryable: true })
        setPhase('closed')
      })

    return () => {
      cancelled = true
      explicitCloseRef.current = true
      const socket = socketRef.current
      socketRef.current = null
      if (socket?.readyState === WebSocket.OPEN) {
        try {
          socket.send(
            JSON.stringify({ type: 'preview.close' } satisfies ContainerPreviewClientMessage),
          )
        } catch {
          /* noop */
        }
      }
      try {
        socket?.close(1000, 'preview closed')
      } catch {
        /* noop */
      }
    }
  }, [auth, enabled, reconnectKey, url, viewport])

  return { phase, error, ready, selection, resolved, navigation, send }
}
