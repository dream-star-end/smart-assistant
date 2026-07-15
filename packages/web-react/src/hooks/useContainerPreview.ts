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
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import { type ContainerPreviewTicketResponse, api, apiErrorMessage } from '../lib/api'
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

export type ContainerPreviewTransport = 'direct' | 'legacy'

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

const DIRECT_MESSAGE_SOURCE = 'oc-direct-preview-v1'
const DIRECT_READY_TIMEOUT_MS = 8_000
const DIRECT_HEARTBEAT_MS = 30_000

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
  iframeRef,
  onFrame,
}: {
  auth: AuthSession | null
  url: string
  viewport: ContainerPreviewViewport
  enabled: boolean
  reconnectKey: number
  iframeRef: RefObject<HTMLIFrameElement | null>
  onFrame: (frame: ContainerPreviewFrame) => void
}) {
  const socketRef = useRef<WebSocket | null>(null)
  const onFrameRef = useRef(onFrame)
  const lastFrameRef = useRef<{ revision: number; sequence: number }>({ revision: 0, sequence: 0 })
  const explicitCloseRef = useRef(false)
  const eventSequenceRef = useRef(0)
  const transportRef = useRef<ContainerPreviewTransport>('legacy')
  const directOriginRef = useRef<string | null>(null)
  const directSessionIdRef = useRef<string | null>(null)
  const fallbackRef = useRef<(() => void) | null>(null)
  const [phase, setPhase] = useState<ContainerPreviewPhase>('idle')
  const [transport, setTransport] = useState<ContainerPreviewTransport>('legacy')
  const [directUrl, setDirectUrl] = useState<string | null>(null)
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

  const send = useCallback(
    (message: ContainerPreviewClientMessage): boolean => {
      if (transportRef.current === 'direct') {
        const origin = directOriginRef.current
        const frame = iframeRef.current?.contentWindow
        if (!origin || !frame) return false
        frame.postMessage({ source: DIRECT_MESSAGE_SOURCE, message }, origin)
        return true
      }
      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) return false
      socket.send(JSON.stringify(message))
      return true
    },
    [iframeRef],
  )

  const useLegacyFallback = useCallback(() => {
    fallbackRef.current?.()
  }, [])

  useEffect(() => {
    void reconnectKey
    if (!enabled || !auth || !url) {
      setPhase('idle')
      return
    }
    let cancelled = false
    let directReadyTimer: ReturnType<typeof setTimeout> | null = null
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let issuedTicket: ContainerPreviewTicketResponse | null = null
    let legacyStarted = false
    let fallingBack = false
    explicitCloseRef.current = false
    lastFrameRef.current = { revision: 0, sequence: 0 }
    transportRef.current = 'legacy'
    directOriginRef.current = null
    directSessionIdRef.current = null
    setTransport('legacy')
    setDirectUrl(null)
    setPhase('ticket')
    setError(null)
    setReady(null)
    setSelection(null)
    setResolved(null)
    setNavigation(null)

    const openLegacy = (issued: ContainerPreviewTicketResponse): void => {
      if (cancelled || legacyStarted) return
      legacyStarted = true
      transportRef.current = 'legacy'
      directOriginRef.current = null
      directSessionIdRef.current = null
      setTransport('legacy')
      setDirectUrl(null)
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
            // Keep the last good frame; a later frame can recover.
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
        applyServerMessage(message, viewport)
      }
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        if (!cancelled && !explicitCloseRef.current) setPhase('closed')
      }
      socket.onerror = () => {
        if (!cancelled) {
          setError((current) => current ?? { message: '网页预览连接失败，请重试', retryable: true })
        }
      }
    }

    const revokeDirect = (): void => {
      const sessionId = directSessionIdRef.current
      if (!sessionId) return
      directSessionIdRef.current = null
      void api.revokeContainerPreview(auth, sessionId).catch(() => undefined)
    }

    const fallback = (): void => {
      if (cancelled || legacyStarted || fallingBack || !issuedTicket) return
      fallingBack = true
      if (directReadyTimer) clearTimeout(directReadyTimer)
      directReadyTimer = null
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = null
      setPhase('ticket')
      void (async () => {
        // Revocation is independent cleanup. Do not put its network latency in
        // front of the compatibility path: at the 8-second readiness deadline
        // the fresh legacy ticket starts immediately.
        revokeDirect()
        if (cancelled) return
        try {
          // A direct session may have been open longer than the legacy
          // ticket's 30-second lifetime. Mint a fresh legacy-only ticket so
          // manual compatibility mode and late tunnel failures always work.
          const fresh = await api.createContainerPreviewTicket(auth, url, viewport, {
            direct: false,
          })
          if (cancelled) return
          fallingBack = false
          openLegacy(fresh)
        } catch (err) {
          if (cancelled) return
          fallingBack = false
          transportRef.current = 'legacy'
          directOriginRef.current = null
          setTransport('legacy')
          setDirectUrl(null)
          setPhase('closed')
          setError({ message: apiErrorMessage(err, '兼容预览连接失败，请重试'), retryable: true })
        }
      })()
    }
    fallbackRef.current = fallback

    const applyServerMessage = (
      message: ContainerPreviewServerMessage,
      canonicalViewport: ContainerPreviewViewport,
    ): void => {
      switch (message.type) {
        case 'preview.status':
          setPhase(message.status)
          return
        case 'preview.ready':
          setReady({ url: message.url, title: message.title, viewport: canonicalViewport })
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

    const onDirectMessage = (event: MessageEvent): void => {
      if (
        cancelled ||
        transportRef.current !== 'direct' ||
        event.origin !== directOriginRef.current ||
        event.source !== iframeRef.current?.contentWindow
      )
        return
      const message = parseDirectMessage(event.data, url, viewport)
      if (!message) return
      if (message.type === 'preview.ready') {
        if (directReadyTimer) clearTimeout(directReadyTimer)
        directReadyTimer = null
        if (!heartbeatTimer) {
          heartbeatTimer = setInterval(() => {
            const sessionId = directSessionIdRef.current
            if (!sessionId || cancelled) return
            void api.heartbeatContainerPreview(auth, sessionId).catch(() => fallback())
          }, DIRECT_HEARTBEAT_MS)
        }
      }
      applyServerMessage(message, viewport)
    }
    window.addEventListener('message', onDirectMessage)

    void api
      .createContainerPreviewTicket(auth, url, viewport)
      .then((issued) => {
        if (cancelled) {
          if (issued.direct) {
            void api.revokeContainerPreview(auth, issued.direct.sessionId).catch(() => undefined)
          }
          return
        }
        issuedTicket = issued
        if (!issued.direct) {
          openLegacy(issued)
          return
        }
        directSessionIdRef.current = issued.direct.sessionId
        let directOrigin: string
        try {
          const parsed = new URL(issued.direct.url)
          if (
            parsed.protocol !== 'https:' ||
            !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(parsed.hostname) ||
            !/^[0-9a-f]{32}$/.test(issued.direct.sessionId)
          ) {
            throw new Error('invalid direct preview endpoint')
          }
          directOrigin = parsed.origin
        } catch {
          fallback()
          return
        }
        transportRef.current = 'direct'
        directOriginRef.current = directOrigin
        setTransport('direct')
        setDirectUrl(issued.direct.url)
        setPhase('loading')
        directReadyTimer = setTimeout(fallback, DIRECT_READY_TIMEOUT_MS)
      })
      .catch((err) => {
        if (cancelled) return
        setError({ message: apiErrorMessage(err, '网页预览暂不可用，请稍后重试'), retryable: true })
        setPhase('closed')
      })

    return () => {
      cancelled = true
      fallbackRef.current = null
      window.removeEventListener('message', onDirectMessage)
      if (directReadyTimer) clearTimeout(directReadyTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      explicitCloseRef.current = true
      const directSessionId = directSessionIdRef.current
      directSessionIdRef.current = null
      if (directSessionId)
        void api.revokeContainerPreview(auth, directSessionId).catch(() => undefined)
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
      directOriginRef.current = null
    }
  }, [auth, enabled, iframeRef, reconnectKey, url, viewport])

  return {
    phase,
    transport,
    directUrl,
    error,
    ready,
    selection,
    resolved,
    navigation,
    send,
    useLegacyFallback,
  }
}

function parseDirectMessage(
  value: unknown,
  sourceUrl: string,
  viewport: ContainerPreviewViewport,
): ContainerPreviewServerMessage | null {
  if (
    !isRecord(value) ||
    value.source !== DIRECT_MESSAGE_SOURCE ||
    typeof value.type !== 'string'
  ) {
    return null
  }
  switch (value.type) {
    case 'preview.ready': {
      if (typeof value.url !== 'string' || typeof value.title !== 'string') return null
      return {
        type: 'preview.ready',
        protocolVersion: 1,
        url: mapDirectNavigationUrl(value.url, sourceUrl),
        title: value.title.slice(0, 512),
        viewport,
      }
    }
    case 'preview.navigation': {
      if (
        typeof value.url !== 'string' ||
        typeof value.title !== 'string' ||
        !Number.isSafeInteger(value.pageRevision) ||
        Number(value.pageRevision) < 0
      )
        return null
      return {
        type: 'preview.navigation',
        url: mapDirectNavigationUrl(value.url, sourceUrl),
        title: value.title.slice(0, 512),
        pageRevision: Number(value.pageRevision),
      }
    }
    case 'preview.selection': {
      const target = parseElementTarget(value.target)
      if (value.target !== null && !target) return null
      return { type: 'preview.selection', target }
    }
    case 'preview.resolved': {
      if (typeof value.selector !== 'string' || value.selector.length > 512) return null
      const target = parseElementTarget(value.target)
      if (value.target !== null && !target) return null
      return { type: 'preview.resolved', selector: value.selector, target }
    }
    case 'preview.error':
      if (
        typeof value.code !== 'string' ||
        typeof value.message !== 'string' ||
        typeof value.retryable !== 'boolean'
      )
        return null
      return {
        type: 'preview.error',
        code: value.code.slice(0, 64),
        message: value.message.slice(0, 512),
        retryable: value.retryable,
      }
    default:
      return null
  }
}

function parseElementTarget(value: unknown): ContainerPreviewElementTarget | null {
  if (value === null) return null
  if (
    !isRecord(value) ||
    typeof value.selector !== 'string' ||
    value.selector.length < 1 ||
    value.selector.length > 512 ||
    typeof value.tag !== 'string' ||
    value.tag.length < 1 ||
    value.tag.length > 64 ||
    !isRecord(value.bounds)
  )
    return null
  const { x, y, width, height } = value.bounds
  if (![x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return null
  }
  if (Number(width) < 0 || Number(height) < 0) return null
  const optional = (key: 'role' | 'ariaLabel' | 'text', max: number): string | undefined => {
    const field = value[key]
    return typeof field === 'string' && field.length <= max ? field : undefined
  }
  return {
    selector: value.selector,
    tag: value.tag,
    ...(optional('role', 128) ? { role: optional('role', 128) } : {}),
    ...(optional('ariaLabel', 256) ? { ariaLabel: optional('ariaLabel', 256) } : {}),
    ...(optional('text', 512) ? { text: optional('text', 512) } : {}),
    bounds: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) },
  }
}

function mapDirectNavigationUrl(publicUrl: string, sourceUrl: string): string {
  try {
    const current = new URL(publicUrl)
    const source = new URL(sourceUrl)
    source.pathname = current.pathname
    source.search = current.search
    source.hash = current.hash
    return source.toString()
  } catch {
    return sourceUrl
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
