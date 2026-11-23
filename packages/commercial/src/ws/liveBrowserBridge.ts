/**
 * Public browser ↔ authenticated per-user container live-browser WebSocket bridge (OCV5-857).
 *
 * Mirrors `containerPreviewBridge.ts` security & backpressure invariants:
 * - Public path `/ws/live-browser` authenticated via exact `Origin` + single-use
 *   `Sec-WebSocket-Protocol: live-browser-v1, ticket.<ticket>` consumed synchronously.
 * - Signs a domain-separated Ed25519 `X-OpenClaude-Live-Browser-Assertion` bound to
 *   `uid`, `containerId`, `agentId`, and single-use `sessionId`.
 * - Works transparently across BOTH local Docker bridge containers and remote node-agent
 *   mTLS+PSK tunnels (`containerWsPath: '/ws/live-browser'`).
 * - Relays JSON control frames and binary `OCLB` video frames with latest-only 2 MiB backpressure.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import {
  LIVE_BROWSER_ASSERTION_HEADER,
  LIVE_BROWSER_INTERNAL_WS_PATH,
  LIVE_BROWSER_MAX_BINARY_FRAME_BYTES,
  LIVE_BROWSER_PUBLIC_WS_PATH,
  LIVE_BROWSER_TICKET_PROTOCOL,
} from '@openclaude/protocol'
import { type RawData, WebSocket, WebSocketServer } from 'ws'

import type { NodeAgentTarget } from '../compute-pool/nodeAgentClient.js'
import type { Logger } from '../logging/logger.js'
import type { AuthoritySigner } from './authoritySigner.js'
import {
  LIVE_BROWSER_TICKET_CHARS,
  type LiveBrowserTicketRecord,
  type LiveBrowserTicketStore,
} from './liveBrowserTickets.js'
import { ContainerUnreadyError, type ResolveContainerEndpoint } from './userChatBridge.js'

const MAX_CONTROL_BYTES = 64 * 1024
export const LIVE_BROWSER_MAX_FRAME_BYTES = LIVE_BROWSER_MAX_BINARY_FRAME_BYTES
const MAX_EARLY_BYTES = 128 * 1024
const MAX_EARLY_MESSAGES = 64
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024
const DEFAULT_GLOBAL_CAP = 8
const CONNECT_TIMEOUT_MS = 30_000
const UPGRADE_PENDING_TIMEOUT_MS = 5_000

const ALLOWED_CLIENT_CONTROL_TYPES: ReadonlySet<string> = new Set([
  'takeover',
  'handoff_watch',
  'pointer',
  'wheel',
  'key',
  'insert_text',
  'navigate',
  'history',
  'tab',
  'resize',
  'dialog',
  'open',
  'close_browser',
  'ping',
])

const ALLOWED_SERVER_CONTROL_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'state',
  'cursor',
  'handoff_ready',
  'handoff_vetoed',
  'error',
  'pong',
])

function isAllowedControlMessage(text: string, allowedTypes: ReadonlySet<string>): boolean {
  try {
    const parsed = JSON.parse(text) as { type?: unknown }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    return typeof parsed.type === 'string' && allowedTypes.has(parsed.type)
  } catch {
    return false
  }
}

export interface LiveBrowserBridgeDeps {
  tickets: LiveBrowserTicketStore
  signer: AuthoritySigner
  resolveContainerEndpoint: ResolveContainerEndpoint
  allowedOrigin: string
  logger?: Logger
  maxGlobalSessions?: number
  createContainerSocket?: (
    host: string,
    port: number,
    assertion: string,
    connectionTraceId: string,
    signal: AbortSignal,
  ) => WebSocket
  createTunnelContainerSocket?: (
    tunnel: { hostId: string; containerInternalId: string; nodeAgent: NodeAgentTarget },
    containerPort: number,
    assertion: string,
    connectionTraceId: string,
    signal: AbortSignal,
  ) => Promise<WebSocket>
}

export interface LiveBrowserBridgeHandler {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  shutdown(): Promise<void>
  activeCount(): number
}

export function normalizeLiveBrowserAllowedOrigin(raw: string): string {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('commercial base URL must be HTTP(S)')
  }
  if (parsed.username || parsed.password) {
    throw new Error('commercial base URL cannot contain credentials')
  }
  return parsed.origin
}

export function createLiveBrowserBridge(deps: LiveBrowserBridgeDeps): LiveBrowserBridgeHandler {
  const allowedOrigin = normalizeLiveBrowserAllowedOrigin(deps.allowedOrigin)
  const globalCap = clampGlobalCap(deps.maxGlobalSessions ?? DEFAULT_GLOBAL_CAP)
  const sessions = new Set<PublicLiveBrowserSession>()
  const activeByUid = new Map<string, PublicLiveBrowserSession>()
  const pendingUids = new Set<string>()
  let shuttingDown = false

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CONTROL_BYTES,
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.has(LIVE_BROWSER_TICKET_PROTOCOL) ? LIVE_BROWSER_TICKET_PROTOCOL : false
    },
  })

  return {
    handleUpgrade(req, socket, head): boolean {
      if (safePathname(req.url) !== LIVE_BROWSER_PUBLIC_WS_PATH) return false
      if (shuttingDown) {
        rejectUpgrade(socket, 503, 'live browser stream unavailable')
        return true
      }
      if (req.headers.origin !== allowedOrigin) {
        rejectUpgrade(socket, 403, 'origin rejected')
        return true
      }
      const ticket = parseTicketProtocols(req.headers['sec-websocket-protocol'])
      if (!ticket) {
        rejectUpgrade(socket, 401, 'live browser ticket required')
        return true
      }
      const record = deps.tickets.consume(ticket)
      if (!record) {
        rejectUpgrade(socket, 401, 'live browser ticket invalid')
        return true
      }
      const uidKey = record.uid.toString()
      if (pendingUids.has(uidKey)) {
        rejectUpgrade(socket, 409, 'live browser connection already pending')
        return true
      }
      const existingForUid = activeByUid.get(uidKey)
      if (sessions.size - (existingForUid ? 1 : 0) >= globalCap) {
        rejectUpgrade(socket, 503, 'live browser capacity reached')
        return true
      }

      pendingUids.add(uidKey)
      let pendingCleared = false
      const clearPending = () => {
        if (pendingCleared) return
        pendingCleared = true
        pendingUids.delete(uidKey)
        clearTimeout(pendingTimer)
        socket.off('close', clearPending)
        socket.off('error', clearPending)
      }
      const pendingTimer = setTimeout(clearPending, UPGRADE_PENDING_TIMEOUT_MS)
      pendingTimer.unref?.()
      socket.once('close', clearPending)
      socket.once('error', clearPending)

      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          clearPending()
          if (shuttingDown) {
            try {
              ws.close(1001, 'server restart')
            } catch {}
            return
          }
          // Replace the user's prior active session ONLY after upgrade succeeds.
          const previous = activeByUid.get(uidKey)
          if (previous) void previous.close(1000, 'live browser replaced')

          const session = new PublicLiveBrowserSession({
            ws,
            ticket: record,
            deps,
            onFinalize: () => {
              sessions.delete(session)
              if (activeByUid.get(uidKey) === session) activeByUid.delete(uidKey)
            },
          })
          sessions.add(session)
          activeByUid.set(uidKey, session)
          session.start()
        })
      } catch (err) {
        clearPending()
        deps.logger?.error('live_browser.public_upgrade_failed', {
          error: (err as Error)?.message ?? String(err),
        })
        try {
          socket.destroy()
        } catch {}
      }
      return true
    },

    async shutdown(): Promise<void> {
      if (shuttingDown) return
      shuttingDown = true
      await Promise.allSettled(
        [...sessions].map((session) => session.close(1001, 'server restart')),
      )
      sessions.clear()
      activeByUid.clear()
      pendingUids.clear()
      await new Promise<void>((resolve) => {
        try {
          wss.close(() => resolve())
        } catch {
          resolve()
        }
      })
    },

    activeCount(): number {
      return sessions.size
    },
  }
}

interface PublicLiveBrowserSessionOptions {
  ws: WebSocket
  ticket: LiveBrowserTicketRecord
  deps: LiveBrowserBridgeDeps
  onFinalize(): void
}

class PublicLiveBrowserSession {
  private containerWs: WebSocket | null = null
  private readonly abort = new AbortController()
  private readonly early: string[] = []
  private earlyBytes = 0
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private pendingBinary: Buffer | null = null
  private finalized = false
  private containerReady = false

  constructor(private readonly options: PublicLiveBrowserSessionOptions) {}

  start(): void {
    const { ws } = this.options
    this.connectTimer = setTimeout(() => {
      this.sendError('CONTAINER_TIMEOUT', '云端浏览器流连接超时，请重试', true)
      void this.close(1011, 'container timeout')
    }, CONNECT_TIMEOUT_MS)
    ws.on('message', (raw, isBinary) => this.onBrowserMessage(raw, isBinary))
    ws.once('close', () => void this.finalize())
    ws.once('error', () => void this.finalize())
    void this.connectContainer()
  }

  async close(code = 1000, reason = 'closed'): Promise<void> {
    if (this.options.ws.readyState === WebSocket.OPEN) {
      try {
        this.options.ws.close(code, reason)
      } catch {}
    }
    await this.finalize()
  }

  private async connectContainer(): Promise<void> {
    const { ticket, deps } = this.options
    try {
      const endpoint = await deps.resolveContainerEndpoint(ticket.uid)
      // P0 #1: re-check lifecycle BEFORE constructing any container WebSocket.
      if (this.finalized || this.abort.signal.aborted) return
      if (!Number.isSafeInteger(endpoint.containerId) || Number(endpoint.containerId) < 1) {
        throw new Error('resolved container has no signed identity')
      }
      const uid = Number(ticket.uid)
      if (!Number.isSafeInteger(uid) || uid < 1) {
        throw new Error('live browser uid is out of range')
      }
      const sessionId = randomBytes(16).toString('hex')
      const { envelope } = deps.signer.signLiveBrowserAssertion({
        uid,
        containerId: endpoint.containerId!,
        agentId: ticket.agentId,
        sessionId,
      })
      const traceId = randomUUID()
      const ws = endpoint.tunnel
        ? await this.connectTunnel(endpoint.tunnel, endpoint.port, envelope, traceId)
        : this.connectDirect(endpoint.host, endpoint.port, envelope, traceId)
      // Always install an error handler synchronously before any terminate() or next-tick error event.
      const onContainerError = (err: Error) => {
        if (this.finalized) return
        deps.logger?.warn('live_browser.container_socket_error', {
          uid: ticket.uid.toString(),
          agentId: ticket.agentId,
          error: err.message,
        })
        this.sendError('CONTAINER_UNAVAILABLE', '运行环境正在更新或暂不可用，请稍后重试', true)
        void this.close(1011, 'container unavailable')
      }
      ws.on('error', onContainerError)
      if (this.finalized || this.abort.signal.aborted) {
        try {
          ws.terminate()
        } catch {}
        return
      }
      this.containerWs = ws
      ws.binaryType = 'nodebuffer'
      ws.once('open', () => this.onContainerOpen(ws))
      ws.on('message', (raw, isBinary) => this.onContainerMessage(raw, isBinary))
      ws.once('close', (code) => {
        if (!this.finalized) {
          if (code !== 1000 && code !== 4001) {
            this.sendError('CONTAINER_CLOSED', '云端浏览器连接已断开，请重试', true)
          }
          void this.close(code === 1000 || code === 4001 ? code : 1011, 'container closed')
        }
      })
    } catch (err) {
      if (this.finalized) return
      const unready = err instanceof ContainerUnreadyError
      deps.logger?.warn('live_browser.connect_failed', {
        uid: ticket.uid.toString(),
        agentId: ticket.agentId,
        error: (err as Error)?.message ?? String(err),
      })
      this.sendError(
        unready ? 'CONTAINER_UNREADY' : 'CONTAINER_UNAVAILABLE',
        unready ? '运行环境正在启动，请稍后重试' : '运行环境暂不可用，请稍后重试',
        true,
      )
      await this.close(1011, 'container unavailable')
    }
  }

  private connectDirect(host: string, port: number, assertion: string, traceId: string): WebSocket {
    if (this.options.deps.createContainerSocket) {
      return this.options.deps.createContainerSocket(
        host,
        port,
        assertion,
        traceId,
        this.abort.signal,
      )
    }
    const ws = new WebSocket(`ws://${host}:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
      headers: {
        'X-Connection-Trace-Id': traceId,
        [LIVE_BROWSER_ASSERTION_HEADER]: assertion,
      },
      perMessageDeflate: false,
      maxPayload: LIVE_BROWSER_MAX_FRAME_BYTES,
      handshakeTimeout: 5_000,
    })
    // Guard against unhandled 'error' if abort triggers terminate() before caller attaches listeners.
    ws.on('error', () => {})
    this.abort.signal.addEventListener(
      'abort',
      () => {
        try {
          ws.terminate()
        } catch {}
      },
      { once: true },
    )
    return ws
  }

  private async connectTunnel(
    tunnel: { hostId: string; containerInternalId: string; nodeAgent: NodeAgentTarget },
    port: number,
    assertion: string,
    traceId: string,
  ): Promise<WebSocket> {
    if (!this.options.deps.createTunnelContainerSocket) {
      throw new Error('live browser tunnel unavailable')
    }
    return this.options.deps.createTunnelContainerSocket(
      tunnel,
      port,
      assertion,
      traceId,
      this.abort.signal,
    )
  }

  private onContainerOpen(ws: WebSocket): void {
    if (this.finalized || ws !== this.containerWs) return
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
    this.containerReady = true
    for (const message of this.early) {
      try {
        ws.send(message)
      } catch {}
    }
    this.early.length = 0
    this.earlyBytes = 0
  }

  private onBrowserMessage(raw: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.sendError('BAD_MESSAGE', '控制通道不接受二进制输入', false)
      void this.close(1008, 'binary input rejected')
      return
    }
    const message = raw.toString()
    const bytes = Buffer.byteLength(message, 'utf8')
    if (bytes > MAX_CONTROL_BYTES) {
      void this.close(1009, 'control message too large')
      return
    }
    if (!isAllowedControlMessage(message, ALLOWED_CLIENT_CONTROL_TYPES)) {
      this.sendError('BAD_MESSAGE', '不支持或格式无效的控制消息', false)
      return
    }
    if (
      !this.containerReady ||
      !this.containerWs ||
      this.containerWs.readyState !== WebSocket.OPEN
    ) {
      if (this.early.length >= MAX_EARLY_MESSAGES || this.earlyBytes + bytes > MAX_EARLY_BYTES) {
        this.sendError('EARLY_INPUT_OVERFLOW', '浏览器尚未就绪，请稍后操作', true)
        void this.close(1009, 'early input overflow')
        return
      }
      this.early.push(message)
      this.earlyBytes += bytes
      return
    }
    try {
      this.containerWs.send(message)
    } catch {}
  }

  private onContainerMessage(raw: RawData, isBinary: boolean): void {
    if (this.finalized || this.options.ws.readyState !== WebSocket.OPEN) return
    if (!isBinary) {
      const text = raw.toString()
      if (
        Buffer.byteLength(text, 'utf8') <= MAX_CONTROL_BYTES &&
        isAllowedControlMessage(text, ALLOWED_SERVER_CONTROL_TYPES)
      ) {
        try {
          this.options.ws.send(text)
        } catch {}
      }
      return
    }
    const frame = toBuffer(raw)
    if (this.options.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.pendingBinary = frame
      this.scheduleDrain()
      return
    }
    try {
      this.options.ws.send(frame, { binary: true })
    } catch {}
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.finalized) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      if (this.options.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.scheduleDrain()
        return
      }
      const pending = this.pendingBinary
      this.pendingBinary = null
      if (pending && this.options.ws.readyState === WebSocket.OPEN) {
        try {
          this.options.ws.send(pending, { binary: true })
        } catch {}
      }
    }, 25)
  }

  private sendError(code: string, message: string, retryable: boolean): void {
    if (this.options.ws.readyState !== WebSocket.OPEN) return
    try {
      this.options.ws.send(JSON.stringify({ type: 'error', code, message, retryable }))
    } catch {}
  }

  private async finalize(): Promise<void> {
    if (this.finalized) return
    this.finalized = true
    this.abort.abort()
    if (this.connectTimer) clearTimeout(this.connectTimer)
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.pendingBinary = null
    this.early.length = 0
    const container = this.containerWs
    this.containerWs = null
    if (container && container.readyState !== WebSocket.CLOSED) {
      try {
        container.close(1000, 'public live browser closed')
      } catch {}
      setTimeout(() => {
        try {
          container.terminate()
        } catch {}
      }, 250).unref?.()
    }
    this.options.onFinalize()
  }
}

export function parseLiveBrowserTicketProtocols(raw: string | string[] | undefined): string | null {
  return parseTicketProtocols(raw)
}

function parseTicketProtocols(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string' || raw.length > 256) return null
  const parts = raw.split(',').map((part) => part.trim())
  if (parts.length !== 2 || parts[0] !== LIVE_BROWSER_TICKET_PROTOCOL) return null
  const tokenPart = parts[1] ?? ''
  if (!tokenPart.startsWith('ticket.')) return null
  const ticket = tokenPart.slice('ticket.'.length)
  return new RegExp(`^[A-Za-z0-9_-]{${LIVE_BROWSER_TICKET_CHARS}}$`).test(ticket) ? ticket : null
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw)
  return Buffer.from(raw as ArrayBuffer)
}

function clampGlobalCap(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GLOBAL_CAP
  return Math.max(1, Math.min(128, Math.trunc(value)))
}

function safePathname(raw: string | undefined): string {
  try {
    return new URL(raw ?? '/', 'http://public.invalid').pathname
  } catch {
    return raw ?? '/'
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const reason =
    status === 401
      ? 'Unauthorized'
      : status === 403
        ? 'Forbidden'
        : status === 409
          ? 'Conflict'
          : 'Service Unavailable'
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    )
  } catch {}
  try {
    socket.destroy()
  } catch {}
}

/**
 * R2 #2: Commercial Master ALWAYS claims `/ws/live-browser` upgrades.
 * If `liveBrowserBridge` was not mounted (e.g. authority signer or runtime unavailable),
 * respond 503 Service Unavailable immediately so the request NEVER falls through to
 * Gateway's standalone live-browser upgrade handler.
 */
export function claimUnavailableLiveBrowserUpgrade(
  req: IncomingMessage,
  socket: Duplex,
): boolean {
  if (safePathname(req.url) !== LIVE_BROWSER_PUBLIC_WS_PATH) return false
  rejectUpgrade(socket, 503, 'live browser stream unavailable')
  return true
}
