/**
 * OCV5-915 P3-2 — L0 Pure ToolBroker Channel Protocol & Multiplexed Client.
 *
 * L0 Contract Invariant (R2-contract-node): ZERO `node:*` imports allowed.
 * Shared across master (`interface-ws`, `compute-pool`), container (`gateway-runtime`,
 * `gateway-interface`, `gateway-engines`, `mcp-memory`), and tests without cross-layer coupling.
 */
import type {
  ExecEnvChannelKind,
  ExecEnvHostKind,
  ToolBrokerTransport,
  ToolCallEnvelope,
  ToolCatalogEntry,
  ToolResultEnvelope,
  ToolStreamFrame,
} from './contracts.js'

export const TOOL_BROKER_LOCAL_PREFIX = '/internal/v3/tool-broker'

/** Strip ToolBroker credential/endpoint env variables before spawning untrusted child tools. */
export function scrubToolBrokerEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    if (key.startsWith('OPENCLAUDE_TOOL_BROKER_') || key.startsWith('OC_TOOL_BROKER_')) continue
    clean[key] = value
  }
  return clean
}

/** Validate that a ToolBroker URL strictly targets loopback HTTP (`127.0.0.1` / `::1` / `localhost`). */
export function isLoopbackBrokerUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:') return false
    const host = parsed.hostname.toLowerCase()
    return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost'
  } catch (err) {
    void err
    return false
  }
}

export interface FrameLinkLike {
  send(frame: string): void
  onFrame(cb: (frame: string) => void): () => void
  onClose?(cb: (reason: string) => void): () => void
}

export interface ToolBrokerRebindAck {
  readonly leaseId: string
  readonly brainGen: number
  readonly fencingToken: string
}

export type ToolBrokerWireFrame =
  | {
      readonly type: 'broker.list_catalog'
      readonly channelId: string
      readonly requestId: string
      readonly leaseId: string
      readonly fencingToken: string
      readonly brainGen?: number
    }
  | {
      readonly type: 'broker.invoke'
      readonly channelId: string
      readonly requestId: string
      readonly leaseId: string
      readonly fencingToken: string
      readonly brainGen?: number
      readonly sessionKey?: string
      readonly capabilityToken?: string
      readonly wantStream?: boolean
      readonly call: ToolCallEnvelope
    }
  | {
      readonly type: 'broker.stream'
      readonly channelId: string
      readonly requestId: string
      readonly callId: string
      readonly frame: ToolStreamFrame
    }
  | {
      readonly type: 'broker.result'
      readonly channelId: string
      readonly requestId: string
      readonly result?: ToolResultEnvelope
      readonly catalog?: readonly ToolCatalogEntry[]
      readonly rebindAck?: ToolBrokerRebindAck
    }
  | {
      readonly type: 'broker.cancel'
      readonly channelId: string
      readonly requestId?: string
      readonly leaseId: string
      readonly fencingToken: string
      readonly brainGen?: number
      readonly callId: string
      readonly reason: string
    }
  | {
      readonly type: 'broker.rebind'
      readonly channelId: string
      readonly requestId: string
      readonly leaseId: string
      readonly expectedCurrentBrainGen: number
      readonly nextBrainGen: number
      readonly nextFencingToken: string
      readonly rebindAuthToken: string
    }
  | {
      readonly type: 'broker.error'
      readonly channelId: string
      readonly requestId: string
      readonly code: string
      readonly message: string
    }

const BROKER_FRAME_TYPES: ReadonlySet<string> = new Set([
  'broker.list_catalog',
  'broker.invoke',
  'broker.stream',
  'broker.result',
  'broker.cancel',
  'broker.rebind',
  'broker.error',
])

const HOST_KIND_DEFAULT_CHANNEL: Readonly<Record<ExecEnvHostKind, ExecEnvChannelKind>> =
  Object.freeze({
    'local-docker': 'uds_jsonrpc',
    'compute-pool-docker': 'ws_tunnel',
    'desktop-virtual': 'ws_tunnel',
  })

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

let fallbackIdSeq = 0

function randomShortId(): string {
  const webCrypto = globalThis.crypto
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID().replace(/-/g, '').slice(0, 12)
  }
  fallbackIdSeq += 1
  const timePart = Date.now().toString(36)
  const randPart = Math.floor(Math.random() * 0xffffffff).toString(36)
  return `${timePart}${fallbackIdSeq.toString(36)}${randPart}`.slice(0, 12)
}

function unrefTimerIfSupported(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    const maybe = timer as { unref?: unknown }
    if (typeof maybe.unref === 'function') {
      maybe.unref()
    }
  }
}

export class ToolBrokerTransportError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'ToolBrokerTransportError'
    this.code = code
  }
}

/**
 * Returns `true` for ANY object whose `type` starts with `broker.` (valid, malformed,
 * or future protocol versions) so shared transports reserve the entire `broker.*`
 * namespace and never leak malformed broker frames to browser chat queues (W03).
 */
export function isReservedToolBrokerFrame(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const type = (value as Record<string, unknown>).type
  return typeof type === 'string' && type.startsWith('broker.')
}

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLeaseAuthFrame(rec: Record<string, unknown>): boolean {
  return typeof rec.leaseId === 'string' && typeof rec.fencingToken === 'string'
}

function isBrokerDataFrame(rec: Record<string, unknown>): boolean {
  if (rec.type === 'broker.invoke') {
    return typeof rec.requestId === 'string' && isLeaseAuthFrame(rec) && isNonArrayObject(rec.call)
  }
  if (rec.type === 'broker.stream') {
    return typeof rec.requestId === 'string' && typeof rec.callId === 'string' && isNonArrayObject(rec.frame)
  }
  return rec.type === 'broker.result' && typeof rec.requestId === 'string'
}

function isBrokerControlFrame(rec: Record<string, unknown>): boolean {
  if (rec.type === 'broker.list_catalog') {
    return typeof rec.requestId === 'string' && isLeaseAuthFrame(rec)
  }
  if (rec.type === 'broker.cancel') {
    return isLeaseAuthFrame(rec) && typeof rec.callId === 'string' && typeof rec.reason === 'string'
  }
  if (rec.type === 'broker.rebind') {
    return (
      typeof rec.requestId === 'string' &&
      typeof rec.leaseId === 'string' &&
      typeof rec.expectedCurrentBrainGen === 'number' &&
      typeof rec.nextBrainGen === 'number' &&
      typeof rec.nextFencingToken === 'string' &&
      typeof rec.rebindAuthToken === 'string'
    )
  }
  return (
    rec.type === 'broker.error' &&
    typeof rec.requestId === 'string' &&
    typeof rec.code === 'string' &&
    typeof rec.message === 'string'
  )
}

export function isToolBrokerWireFrame(value: unknown): value is ToolBrokerWireFrame {
  if (!isNonArrayObject(value)) return false
  if (
    typeof value.type !== 'string' ||
    !BROKER_FRAME_TYPES.has(value.type) ||
    typeof value.channelId !== 'string' ||
    value.channelId.length === 0
  ) {
    return false
  }
  return isBrokerDataFrame(value) || isBrokerControlFrame(value)
}

export function parseToolBrokerWireFrame(raw: string): ToolBrokerWireFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isToolBrokerWireFrame(parsed) ? parsed : null
  } catch (err) {
    void err
    return null
  }
}

/**
 * In-memory full-duplex `FrameLinkLike` pair for local multiplexing and unit/integration tests
 * (zero network sockets, zero polling).
 */
export function createInMemoryFrameLinkPair(): readonly [FrameLinkLike, FrameLinkLike] {
  const listenersA = new Set<(frame: string) => void>()
  const listenersB = new Set<(frame: string) => void>()

  const deliver = (targets: Set<(frame: string) => void>, frame: string) => {
    queueMicrotask(() => {
      for (const cb of [...targets]) {
        cb(frame)
      }
    })
  }

  const endA: FrameLinkLike = {
    send(frame: string) {
      deliver(listenersB, frame)
    },
    onFrame(cb: (frame: string) => void) {
      listenersA.add(cb)
      return () => {
        listenersA.delete(cb)
      }
    },
  }

  const endB: FrameLinkLike = {
    send(frame: string) {
      deliver(listenersA, frame)
    },
    onFrame(cb: (frame: string) => void) {
      listenersB.add(cb)
      return () => {
        listenersB.delete(cb)
      }
    },
  }

  return [endA, endB] as const
}

export interface ContainerLinkToolBrokerClientOptions {
  readonly link: FrameLinkLike
  readonly leaseId: string
  readonly fencingToken: string
  readonly brainGen?: number
  readonly sessionKey?: string
  readonly hostKind?: ExecEnvHostKind
  readonly channelKind?: ExecEnvChannelKind
  readonly channelId?: string
  readonly requestTimeoutMs?: number
}

interface PendingRequest {
  readonly resolve: (frame: Extract<ToolBrokerWireFrame, { type: 'broker.result' }>) => void
  readonly reject: (err: Error) => void
  readonly onStream?: (frame: ToolStreamFrame) => void
  readonly timer: ReturnType<typeof setTimeout> | null
}

export class ContainerLinkToolBrokerClient implements ToolBrokerTransport {
  readonly channelKind: ExecEnvChannelKind
  readonly hostKind: ExecEnvHostKind
  readonly channelId: string

  private readonly link: FrameLinkLike
  private readonly leaseId: string
  private fencingToken: string
  private brainGen?: number
  private readonly sessionKey?: string
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<string, PendingRequest>()
  private readonly unsubscribe: () => void
  private readonly unsubscribeClose?: () => void
  private closed = false

  constructor(opts: ContainerLinkToolBrokerClientOptions) {
    this.link = opts.link
    this.leaseId = opts.leaseId
    this.fencingToken = opts.fencingToken
    this.brainGen = opts.brainGen
    this.sessionKey = opts.sessionKey
    this.hostKind = opts.hostKind ?? 'compute-pool-docker'
    this.channelKind = opts.channelKind ?? HOST_KIND_DEFAULT_CHANNEL[this.hostKind]
    this.channelId = opts.channelId ?? `ch_${randomShortId()}`
    this.requestTimeoutMs = Math.max(
      1,
      Math.floor(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    )

    this.unsubscribe = this.link.onFrame((raw) => {
      if (this.closed) return
      const frame = parseToolBrokerWireFrame(raw)
      if (!frame || frame.channelId !== this.channelId) return
      this.handleInboundFrame(frame)
    })
    if (typeof this.link.onClose === 'function') {
      this.unsubscribeClose = this.link.onClose((reason) => {
        this.close(reason || 'transport_closed')
      })
    }
  }

  get activeFencingToken(): string {
    return this.fencingToken
  }

  get activeBrainGen(): number | undefined {
    return this.brainGen
  }

  get isClosed(): boolean {
    return this.closed
  }

  async listCatalog(): Promise<readonly ToolCatalogEntry[]> {
    const requestId = this.nextRequestId()
    const reply = await this.sendRequest(requestId, {
      type: 'broker.list_catalog',
      channelId: this.channelId,
      requestId,
      leaseId: this.leaseId,
      fencingToken: this.fencingToken,
      ...(this.brainGen === undefined ? {} : { brainGen: this.brainGen }),
    })
    return reply.catalog ?? []
  }

  async invoke(
    call: ToolCallEnvelope,
    extra?: { readonly capabilityToken?: string; readonly sessionKey?: string },
  ): Promise<ToolResultEnvelope> {
    const requestId = this.nextRequestId()
    const reply = await this.sendRequest(requestId, {
      type: 'broker.invoke',
      channelId: this.channelId,
      requestId,
      leaseId: this.leaseId,
      fencingToken: this.fencingToken,
      ...(this.brainGen === undefined ? {} : { brainGen: this.brainGen }),
      ...(extra?.sessionKey ?? this.sessionKey
        ? { sessionKey: extra?.sessionKey ?? this.sessionKey }
        : {}),
      ...(extra?.capabilityToken === undefined ? {} : { capabilityToken: extra.capabilityToken }),
      wantStream: false,
      call,
    })
    if (!reply.result) {
      throw new ToolBrokerTransportError('BROKER_EMPTY_RESULT', 'Host returned empty tool result')
    }
    return reply.result
  }

  async *stream(
    call: ToolCallEnvelope,
    extra?: { readonly capabilityToken?: string; readonly sessionKey?: string },
  ): AsyncIterable<ToolStreamFrame> {
    const requestId = this.nextRequestId()
    const frames: ToolStreamFrame[] = []
    let done = false
    let error: Error | null = null
    let wake: (() => void) | null = null

    const notify = () => {
      if (wake) {
        const fn = wake
        wake = null
        fn()
      }
    }

    const reqPromise = this.sendRequest(
      requestId,
      {
        type: 'broker.invoke',
        channelId: this.channelId,
        requestId,
        leaseId: this.leaseId,
        fencingToken: this.fencingToken,
        ...(this.brainGen === undefined ? {} : { brainGen: this.brainGen }),
        ...(extra?.sessionKey ?? this.sessionKey
          ? { sessionKey: extra?.sessionKey ?? this.sessionKey }
          : {}),
        ...(extra?.capabilityToken === undefined ? {} : { capabilityToken: extra.capabilityToken }),
        wantStream: true,
        call,
      },
      (streamFrame) => {
        frames.push(streamFrame)
        notify()
      },
    )
      .then(() => {
        done = true
        notify()
      })
      .catch((err) => {
        error = err instanceof Error ? err : new Error(String(err))
        done = true
        notify()
      })

    try {
      while (!done || frames.length > 0) {
        if (frames.length > 0) {
          yield frames.shift()!
        } else {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      }
      if (error) throw error
    } finally {
      await reqPromise.catch((err) => {
        void err
      })
    }
  }

  async cancel(callId: string, reason: string): Promise<void> {
    if (this.closed) return
    const requestId = this.nextRequestId()
    await this.sendRequest(requestId, {
      type: 'broker.cancel',
      channelId: this.channelId,
      requestId,
      leaseId: this.leaseId,
      fencingToken: this.fencingToken,
      ...(this.brainGen === undefined ? {} : { brainGen: this.brainGen }),
      callId,
      reason,
    })
  }

  async rebind(
    nextBrainGen: number,
    nextFencingToken: string,
    auth: {
      readonly expectedCurrentBrainGen?: number
      readonly rebindAuthToken: string
    },
  ): Promise<ToolBrokerRebindAck> {
    const expectedCurrentBrainGen = auth.expectedCurrentBrainGen ?? this.brainGen
    if (
      expectedCurrentBrainGen === undefined ||
      !Number.isSafeInteger(expectedCurrentBrainGen) ||
      expectedCurrentBrainGen < 1 ||
      typeof auth.rebindAuthToken !== 'string' ||
      auth.rebindAuthToken.trim().length === 0
    ) {
      throw new ToolBrokerTransportError(
        'EXEC_REBIND_UNAUTHORIZED',
        'Client rebind requires expectedCurrentBrainGen and rebindAuthToken',
      )
    }
    const requestId = this.nextRequestId()
    const reply = await this.sendRequest(requestId, {
      type: 'broker.rebind',
      channelId: this.channelId,
      requestId,
      leaseId: this.leaseId,
      expectedCurrentBrainGen,
      nextBrainGen,
      nextFencingToken,
      rebindAuthToken: auth.rebindAuthToken,
    })
    const ack = reply.rebindAck
    if (!ack) {
      throw new ToolBrokerTransportError('BROKER_REBIND_ACK_MISSING', 'Missing rebind ack')
    }
    this.brainGen = ack.brainGen
    this.fencingToken = ack.fencingToken
    return ack
  }

  close(reason = 'channel_closed'): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    this.unsubscribeClose?.()
    for (const [id, req] of this.pending) {
      if (req.timer) clearTimeout(req.timer)
      req.reject(new ToolBrokerTransportError('BROKER_CHANNEL_CLOSED', `Channel closed: ${reason}`))
      this.pending.delete(id)
    }
  }

  private nextRequestId(): string {
    return `req_${randomShortId()}`
  }

  private sendRequest(
    requestId: string,
    frame: ToolBrokerWireFrame,
    onStream?: (streamFrame: ToolStreamFrame) => void,
  ): Promise<Extract<ToolBrokerWireFrame, { type: 'broker.result' }>> {
    if (this.closed) {
      return Promise.reject(
        new ToolBrokerTransportError('BROKER_CHANNEL_CLOSED', 'ToolBroker channel is closed'),
      )
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(
          new ToolBrokerTransportError(
            'BROKER_REQUEST_TIMEOUT',
            `ToolBroker request ${requestId} timed out after ${this.requestTimeoutMs}ms`,
          ),
        )
      }, this.requestTimeoutMs)
      unrefTimerIfSupported(timer)

      this.pending.set(requestId, { resolve, reject, onStream, timer })
      try {
        this.link.send(JSON.stringify(frame))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(
          err instanceof Error
            ? err
            : new ToolBrokerTransportError('BROKER_SEND_FAILED', String(err)),
        )
      }
    })
  }

  private handleInboundFrame(frame: ToolBrokerWireFrame): void {
    if (frame.type === 'broker.stream') {
      const req = this.pending.get(frame.requestId)
      req?.onStream?.(frame.frame)
      return
    }
    if (frame.type === 'broker.result') {
      const req = this.pending.get(frame.requestId)
      if (!req) return
      if (req.timer) clearTimeout(req.timer)
      this.pending.delete(frame.requestId)
      req.resolve(frame)
      return
    }
    if (frame.type === 'broker.error') {
      const req = this.pending.get(frame.requestId)
      if (!req) return
      if (req.timer) clearTimeout(req.timer)
      this.pending.delete(frame.requestId)
      req.reject(new ToolBrokerTransportError(frame.code, frame.message))
    }
  }
}

export interface OpenToolBrokerChannelOptions {
  readonly link: FrameLinkLike
  readonly hostKind: ExecEnvHostKind
  readonly leaseId: string
  readonly fencingToken: string
  readonly brainGen?: number
  readonly sessionKey?: string
  readonly channelKind?: ExecEnvChannelKind
  readonly channelId?: string
  readonly requestTimeoutMs?: number
}

/**
 * Opens a multiplexed `tool-broker` channel over a shared `FrameLinkLike` across any
 * `ExecEnvHostKind` (`local-docker`, `compute-pool-docker`, `desktop-virtual`).
 */
export function openExecEnvToolBrokerChannel(
  channelName: 'tool-broker',
  opts: OpenToolBrokerChannelOptions,
): ContainerLinkToolBrokerClient {
  if (channelName !== 'tool-broker') {
    throw new ToolBrokerTransportError(
      'UNSUPPORTED_CHANNEL_NAME',
      `Unsupported channel "${String(channelName)}"`,
    )
  }
  return new ContainerLinkToolBrokerClient(opts)
}
