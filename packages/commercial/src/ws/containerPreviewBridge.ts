/** Public browser ↔ authenticated per-user container preview bridge. */

import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import {
  CONTAINER_PREVIEW_ASSERTION_HEADER,
  CONTAINER_PREVIEW_MAX_BINARY_FRAME_BYTES,
  CONTAINER_PREVIEW_PROTOCOL_VERSION,
  CONTAINER_PREVIEW_PUBLIC_WS_PATH,
  CONTAINER_PREVIEW_TICKET_PROTOCOL,
  type ContainerPreviewOpenMessage,
} from '@openclaude/protocol'
import { containerPreviewTargetHash } from '@openclaude/protocol/containerPreviewAuth'
import { type RawData, WebSocket, WebSocketServer } from 'ws'

import type { NodeAgentTarget } from '../compute-pool/nodeAgentClient.js'
import type { Logger } from '../logging/logger.js'
import type { AuthoritySigner } from './authoritySigner.js'
import {
  CONTAINER_PREVIEW_TICKET_CHARS,
  type ContainerPreviewTicketRecord,
  type ContainerPreviewTicketStore,
} from './containerPreviewTickets.js'
import { ContainerUnreadyError, type ResolveContainerEndpoint } from './userChatBridge.js'

const MAX_CONTROL_BYTES = 64 * 1024
export const CONTAINER_PREVIEW_MAX_FRAME_BYTES = CONTAINER_PREVIEW_MAX_BINARY_FRAME_BYTES
const MAX_EARLY_BYTES = 128 * 1024
const MAX_EARLY_MESSAGES = 64
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024
const DEFAULT_GLOBAL_CAP = 4
const CONNECT_TIMEOUT_MS = 30_000

export interface ContainerPreviewBridgeDeps {
  tickets: ContainerPreviewTicketStore
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

export interface ContainerPreviewBridgeHandler {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  shutdown(): Promise<void>
  activeCount(): number
}

export function normalizeContainerPreviewAllowedOrigin(raw: string): string {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('commercial base URL must be HTTP(S)')
  if (parsed.username || parsed.password)
    throw new Error('commercial base URL cannot contain credentials')
  return parsed.origin
}

export function createContainerPreviewBridge(
  deps: ContainerPreviewBridgeDeps,
): ContainerPreviewBridgeHandler {
  const allowedOrigin = normalizeContainerPreviewAllowedOrigin(deps.allowedOrigin)
  const globalCap = clampGlobalCap(deps.maxGlobalSessions ?? DEFAULT_GLOBAL_CAP)
  const sessions = new Set<PublicPreviewSession>()
  const activeByUid = new Map<string, PublicPreviewSession>()
  const pendingUids = new Set<string>()
  let shuttingDown = false

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CONTROL_BYTES,
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.has(CONTAINER_PREVIEW_TICKET_PROTOCOL)
        ? CONTAINER_PREVIEW_TICKET_PROTOCOL
        : false
    },
  })

  return {
    handleUpgrade(req, socket, head): boolean {
      if (safePathname(req.url) !== CONTAINER_PREVIEW_PUBLIC_WS_PATH) return false
      if (shuttingDown) {
        rejectUpgrade(socket, 503, 'preview unavailable')
        return true
      }
      if (req.headers.origin !== allowedOrigin) {
        rejectUpgrade(socket, 403, 'origin rejected')
        return true
      }
      const ticket = parseTicketProtocols(req.headers['sec-websocket-protocol'])
      if (!ticket) {
        rejectUpgrade(socket, 401, 'preview ticket required')
        return true
      }
      // Consume synchronously before endpoint resolution or any other await.
      const record = deps.tickets.consume(ticket)
      if (!record) {
        rejectUpgrade(socket, 401, 'preview ticket invalid')
        return true
      }
      const uidKey = record.uid.toString()
      if (pendingUids.has(uidKey)) {
        rejectUpgrade(socket, 409, 'preview connection already pending')
        return true
      }
      // A device-mode switch mints a fresh valid ticket while the old TCP close
      // may still be in flight. Replace that user's own session atomically
      // instead of consuming the new ticket into a transient 409.
      const previous = activeByUid.get(uidKey)
      // The replaced session still occupies `sessions` until its close event
      // finalizes. Discount exactly that user's slot so a full pool cannot turn
      // a device-mode switch into "close old, reject new".
      if (sessions.size - (previous ? 1 : 0) >= globalCap) {
        rejectUpgrade(socket, 503, 'preview capacity reached')
        return true
      }
      if (previous) void previous.close(1000, 'preview replaced')

      pendingUids.add(uidKey)
      let accepted = false
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          accepted = true
          pendingUids.delete(uidKey)
          const session = new PublicPreviewSession({
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
        if (!accepted) pendingUids.delete(uidKey)
        deps.logger?.error('container_preview.public_upgrade_failed', {
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

interface PublicPreviewSessionOptions {
  ws: WebSocket
  ticket: ContainerPreviewTicketRecord
  deps: ContainerPreviewBridgeDeps
  onFinalize(): void
}

class PublicPreviewSession {
  private containerWs: WebSocket | null = null
  private readonly abort = new AbortController()
  private readonly early: string[] = []
  private earlyBytes = 0
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private pendingBinary: Buffer | null = null
  private finalized = false
  private containerReady = false

  constructor(private readonly options: PublicPreviewSessionOptions) {}

  start(): void {
    const { ws } = this.options
    this.connectTimer = setTimeout(() => {
      this.sendError('CONTAINER_TIMEOUT', '容器预览连接超时，请重试', true)
      void this.close(1011, 'container timeout')
    }, CONNECT_TIMEOUT_MS)
    ws.on('message', (raw, isBinary) => this.onBrowserMessage(raw, isBinary))
    ws.once('close', () => void this.finalize())
    ws.once('error', () => void this.finalize())
    this.send({ type: 'preview.status', status: 'connecting' })
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
      if (!Number.isSafeInteger(endpoint.containerId) || Number(endpoint.containerId) < 1) {
        throw new Error('resolved container has no signed identity')
      }
      const uid = Number(ticket.uid)
      if (!Number.isSafeInteger(uid) || uid < 1) throw new Error('preview uid is out of range')
      const sessionId = randomBytes(16).toString('hex')
      const targetHash = containerPreviewTargetHash(ticket.url, ticket.viewport)
      const { envelope } = deps.signer.signContainerPreviewAssertion({
        uid,
        containerId: endpoint.containerId!,
        sessionId,
        targetHash,
      })
      const traceId = randomUUID()
      const ws = endpoint.tunnel
        ? await this.connectTunnel(endpoint.tunnel, endpoint.port, envelope, traceId)
        : this.connectDirect(endpoint.host, endpoint.port, envelope, traceId)
      if (this.finalized) {
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
          if (code !== 1000) this.sendError('CONTAINER_CLOSED', '容器预览已断开，请重试', true)
          void this.close(code === 1000 ? 1000 : 1011, 'container closed')
        }
      })
      ws.once('error', (err) => {
        deps.logger?.warn('container_preview.container_socket_error', {
          uid: ticket.uid.toString(),
          error: err.message,
        })
        if (!this.finalized) {
          this.sendError('CONTAINER_UNAVAILABLE', '运行环境正在更新或暂不可用，请稍后重试', true)
          void this.close(1011, 'container unavailable')
        }
      })
    } catch (err) {
      if (this.finalized) return
      const unready = err instanceof ContainerUnreadyError
      deps.logger?.warn('container_preview.connect_failed', {
        uid: ticket.uid.toString(),
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
    const ws = new WebSocket(`ws://${host}:${port}${CONTAINER_PREVIEW_PUBLIC_WS_PATH}`, {
      headers: {
        'X-Connection-Trace-Id': traceId,
        [CONTAINER_PREVIEW_ASSERTION_HEADER]: assertion,
      },
      perMessageDeflate: false,
      maxPayload: CONTAINER_PREVIEW_MAX_FRAME_BYTES,
      handshakeTimeout: 5_000,
    })
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
    if (!this.options.deps.createTunnelContainerSocket)
      throw new Error('preview tunnel unavailable')
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
    const open: ContainerPreviewOpenMessage = {
      type: 'preview.open',
      protocolVersion: CONTAINER_PREVIEW_PROTOCOL_VERSION,
      url: this.options.ticket.url,
      viewport: this.options.ticket.viewport,
    }
    ws.send(JSON.stringify(open))
    this.containerReady = true
    for (const message of this.early) ws.send(message)
    this.early.length = 0
    this.earlyBytes = 0
  }

  private onBrowserMessage(raw: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.sendError('BAD_MESSAGE', '预览控制通道不接受二进制输入', false)
      void this.close(1008, 'binary input rejected')
      return
    }
    const message = raw.toString()
    const bytes = Buffer.byteLength(message, 'utf8')
    if (bytes > MAX_CONTROL_BYTES) {
      void this.close(1009, 'control message too large')
      return
    }
    if (
      !this.containerReady ||
      !this.containerWs ||
      this.containerWs.readyState !== WebSocket.OPEN
    ) {
      if (this.early.length >= MAX_EARLY_MESSAGES || this.earlyBytes + bytes > MAX_EARLY_BYTES) {
        this.sendError('EARLY_INPUT_OVERFLOW', '预览尚未就绪，请稍后操作', true)
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
      if (Buffer.byteLength(text, 'utf8') <= MAX_CONTROL_BYTES) {
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

  private send(message: Record<string, unknown>): void {
    if (this.options.ws.readyState !== WebSocket.OPEN) return
    try {
      this.options.ws.send(JSON.stringify(message))
    } catch {}
  }

  private sendError(code: string, message: string, retryable: boolean): void {
    this.send({ type: 'preview.error', code, message, retryable })
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
        container.close(1000, 'public preview closed')
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

function parseTicketProtocols(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string' || raw.length > 256) return null
  const parts = raw.split(',').map((part) => part.trim())
  if (parts.length !== 2 || parts[0] !== CONTAINER_PREVIEW_TICKET_PROTOCOL) return null
  const ticket = parts[1] ?? ''
  return new RegExp(`^[A-Za-z0-9_-]{${CONTAINER_PREVIEW_TICKET_CHARS}}$`).test(ticket)
    ? ticket
    : null
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw)
  return Buffer.from(raw as ArrayBuffer)
}

function clampGlobalCap(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GLOBAL_CAP
  return Math.max(1, Math.min(8, Math.trunc(value)))
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
