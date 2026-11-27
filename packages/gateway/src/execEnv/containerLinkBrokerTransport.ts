/**
 * OCV5-890 Layer 3 — Multiplexed ContainerLink ToolBroker Transport.
 *
 * Eliminates bind-mount socket coupling (`/run/oc/cc5-remote-*`) and 15ms/20ms short polling
 * by multiplexing structured JSON request/response + streaming frames over an abstract duplex
 * `FrameLinkLike` channel across all `ExecEnvHostKind`s (`local-docker`, `compute-pool-docker`,
 * `desktop-virtual`).
 *
 * Architecture invariants:
 * - R3-net: ZERO imports of `node:http`, `node:net`, `ws`, `fetch`, etc.
 * - R3-env / R3-crypto / R3-special-case: zero violations.
 */
import { randomUUID } from 'node:crypto'
import type {
  ExecEnvChannelKind,
  ExecEnvHostKind,
  ToolBrokerTransport,
  ToolCallEnvelope,
  ToolCatalogEntry,
  ToolResultEnvelope,
  ToolStreamFrame,
} from '@openclaude/protocol'
import { ExecEnvLeaseError, type ExecEnvLeaseManager } from './execEnvLease.js'
import {
  ScopedCapabilityTokenError,
  type ScopedCapabilityTokenAuthority,
} from './scopedCapabilityToken.js'
import {
  ToolBrokerPolicyError,
  type ToolBrokerResultEnvelope,
  type ToolBrokerServer,
} from './toolBroker.js'

export const REBIND_AUTH_TOOL_NAME = '__exec_env_rebind__'

export function formatRebindAuthCallId(
  expectedCurrentBrainGen: number,
  nextBrainGen: number,
  nextFencingToken: string,
): string {
  return `rebind:${expectedCurrentBrainGen}->${nextBrainGen}:${nextFencingToken}`
}

export function issueRebindAuthToken(
  authority: ScopedCapabilityTokenAuthority,
  input: {
    readonly leaseId: string
    readonly sessionKey: string
    readonly expectedCurrentBrainGen: number
    readonly nextBrainGen: number
    readonly nextFencingToken: string
    readonly ttlMs?: number
  },
): string {
  return authority.issueToken({
    callId: formatRebindAuthCallId(
      input.expectedCurrentBrainGen,
      input.nextBrainGen,
      input.nextFencingToken,
    ),
    toolName: REBIND_AUTH_TOOL_NAME,
    sessionKey: input.sessionKey,
    leaseId: input.leaseId,
    brainGen: input.nextBrainGen,
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  }).token
}

export interface FrameLinkLike {
  send(frame: string): void
  onFrame(cb: (frame: string) => void): () => void
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
      readonly result?: ToolBrokerResultEnvelope
      readonly catalog?: readonly ToolCatalogEntry[]
      readonly rebindAck?: {
        readonly leaseId: string
        readonly brainGen: number
        readonly fencingToken: string
      }
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

export class ToolBrokerTransportError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'ToolBrokerTransportError'
    this.code = code
  }
}

export function parseToolBrokerWireFrame(raw: string): ToolBrokerWireFrame | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.type !== 'string' ||
      !BROKER_FRAME_TYPES.has(parsed.type) ||
      typeof parsed.channelId !== 'string'
    ) {
      return null
    }
    return parsed as unknown as ToolBrokerWireFrame
  } catch {
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

export interface RebindAuthVerifyContext {
  readonly leaseId: string
  readonly channelId: string
  readonly expectedCurrentBrainGen: number
  readonly nextBrainGen: number
  readonly nextFencingToken: string
  readonly rebindAuthToken: string
  readonly sessionKey: string
}

export type VerifyRebindAuthFn = (ctx: RebindAuthVerifyContext) => boolean | Promise<boolean>

export interface ContainerLinkToolBrokerHostOptions {
  readonly link: FrameLinkLike
  readonly server: ToolBrokerServer
  readonly leaseManager?: ExecEnvLeaseManager
  readonly rebindAuthority?: ScopedCapabilityTokenAuthority
  readonly verifyRebindAuth?: VerifyRebindAuthFn
  readonly channelId?: string
}

export class ContainerLinkToolBrokerHost {
  private readonly link: FrameLinkLike
  private readonly server: ToolBrokerServer
  private readonly leaseManager?: ExecEnvLeaseManager
  private readonly rebindAuthority?: ScopedCapabilityTokenAuthority
  private readonly verifyRebindAuth?: VerifyRebindAuthFn
  private readonly channelId?: string
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(opts: ContainerLinkToolBrokerHostOptions) {
    this.link = opts.link
    this.server = opts.server
    this.leaseManager = opts.leaseManager
    this.rebindAuthority = opts.rebindAuthority
    this.verifyRebindAuth = opts.verifyRebindAuth
    this.channelId = opts.channelId
    this.unsubscribe = this.link.onFrame((raw) => {
      if (this.disposed) return
      const frame = parseToolBrokerWireFrame(raw)
      if (!frame) return
      if (this.channelId !== undefined && frame.channelId !== this.channelId) return
      void this.handleFrame(frame)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
  }

  private send(frame: ToolBrokerWireFrame): void {
    if (this.disposed) return
    this.link.send(JSON.stringify(frame))
  }

  private async handleFrame(frame: ToolBrokerWireFrame): Promise<void> {
    switch (frame.type) {
      case 'broker.list_catalog': {
        try {
          if (this.leaseManager) {
            this.leaseManager.validateFencingToken(
              frame.leaseId,
              frame.fencingToken,
              frame.brainGen,
            )
          }
          this.send({
            type: 'broker.result',
            channelId: frame.channelId,
            requestId: frame.requestId,
            catalog: this.server.listCatalog(),
          })
        } catch (err) {
          this.sendError(frame.channelId, frame.requestId, err)
        }
        return
      }

      case 'broker.invoke': {
        try {
          const invokeReq = {
            ...frame.call,
            leaseId: frame.leaseId,
            fencingToken: frame.fencingToken,
            ...(frame.brainGen === undefined ? {} : { brainGen: frame.brainGen }),
            ...(frame.sessionKey === undefined ? {} : { sessionKey: frame.sessionKey }),
            ...(frame.capabilityToken === undefined
              ? {}
              : { capabilityToken: frame.capabilityToken }),
          }

          if (frame.wantStream) {
            let finalResult: ToolBrokerResultEnvelope | undefined
            for await (const streamFrame of this.server.stream(invokeReq)) {
              this.send({
                type: 'broker.stream',
                channelId: frame.channelId,
                requestId: frame.requestId,
                callId: frame.call.callId,
                frame: streamFrame,
              })
              if (streamFrame.kind === 'tool_result') {
                finalResult = streamFrame.envelope as ToolBrokerResultEnvelope
              }
            }
            if (finalResult) {
              this.send({
                type: 'broker.result',
                channelId: frame.channelId,
                requestId: frame.requestId,
                result: finalResult,
              })
            }
          } else {
            const result = await this.server.invoke(invokeReq)
            this.send({
              type: 'broker.result',
              channelId: frame.channelId,
              requestId: frame.requestId,
              result,
            })
          }
        } catch (err) {
          this.sendError(frame.channelId, frame.requestId, err)
        }
        return
      }

      case 'broker.cancel': {
        const replyRequestId = frame.requestId ?? frame.callId
        try {
          if (this.leaseManager) {
            if (!frame.leaseId || !frame.fencingToken) {
              throw new ExecEnvLeaseError(
                'EXEC_FENCING_TOKEN_STALE',
                'Missing leaseId or fencingToken on broker.cancel frame',
              )
            }
            this.leaseManager.validateFencingToken(
              frame.leaseId,
              frame.fencingToken,
              frame.brainGen,
            )
          }
          await this.server.cancel(frame.callId, frame.reason, frame.leaseId)
          if (frame.requestId !== undefined) {
            this.send({
              type: 'broker.result',
              channelId: frame.channelId,
              requestId: frame.requestId,
            })
          }
        } catch (err) {
          this.sendError(frame.channelId, replyRequestId, err)
        }
        return
      }

      case 'broker.rebind': {
        try {
          if (
            typeof frame.expectedCurrentBrainGen !== 'number' ||
            !Number.isSafeInteger(frame.expectedCurrentBrainGen) ||
            frame.expectedCurrentBrainGen < 1 ||
            typeof frame.rebindAuthToken !== 'string' ||
            frame.rebindAuthToken.trim().length === 0
          ) {
            throw new ToolBrokerTransportError(
              'EXEC_REBIND_UNAUTHORIZED',
              'broker.rebind requires expectedCurrentBrainGen and rebindAuthToken',
            )
          }

          let currentSessionKey = ''
          if (this.leaseManager) {
            const currentLease = this.leaseManager.getLease(frame.leaseId)
            if (!currentLease) {
              throw new ToolBrokerTransportError(
                'EXEC_REBIND_UNAUTHORIZED',
                `Lease ${frame.leaseId} not found for rebind`,
              )
            }
            if (frame.expectedCurrentBrainGen !== currentLease.brainGen) {
              throw new ToolBrokerTransportError(
                'EXEC_REBIND_UNAUTHORIZED',
                `Stale expectedCurrentBrainGen (${frame.expectedCurrentBrainGen}) !== active (${currentLease.brainGen})`,
              )
            }
            currentSessionKey = currentLease.sessionKey
          }

          if (this.verifyRebindAuth) {
            const authorized = await this.verifyRebindAuth({
              leaseId: frame.leaseId,
              channelId: frame.channelId,
              expectedCurrentBrainGen: frame.expectedCurrentBrainGen,
              nextBrainGen: frame.nextBrainGen,
              nextFencingToken: frame.nextFencingToken,
              rebindAuthToken: frame.rebindAuthToken,
              sessionKey: currentSessionKey,
            })
            if (!authorized) {
              throw new ToolBrokerTransportError(
                'EXEC_REBIND_UNAUTHORIZED',
                'Migration rebind authorization rejected',
              )
            }
          } else if (this.rebindAuthority) {
            try {
              this.rebindAuthority.verifyAndConsumeToken(frame.rebindAuthToken, {
                toolName: REBIND_AUTH_TOOL_NAME,
                sessionKey: currentSessionKey,
                leaseId: frame.leaseId,
                callId: formatRebindAuthCallId(
                  frame.expectedCurrentBrainGen,
                  frame.nextBrainGen,
                  frame.nextFencingToken,
                ),
                minBrainGen: frame.nextBrainGen,
              })
            } catch (err) {
              const reason =
                err instanceof ScopedCapabilityTokenError
                  ? `${err.code}: ${err.message}`
                  : err instanceof Error
                    ? err.message
                    : String(err)
              throw new ToolBrokerTransportError('EXEC_REBIND_UNAUTHORIZED', reason)
            }
          } else {
            throw new ToolBrokerTransportError(
              'EXEC_REBIND_UNAUTHORIZED',
              'Host has no rebind authorization verifier configured',
            )
          }

          if (!this.leaseManager) {
            throw new ToolBrokerTransportError(
              'EXEC_REBIND_UNAUTHORIZED',
              'Host has no leaseManager configured to enforce atomic rebind',
            )
          }
          // Post-await atomic CAS check: ensure no concurrent rebind shifted brainGen while
          // verifyRebindAuth was awaiting.
          const postAuthLease = this.leaseManager.getLease(frame.leaseId)
          if (!postAuthLease || postAuthLease.brainGen !== frame.expectedCurrentBrainGen) {
            throw new ToolBrokerTransportError(
              'EXEC_REBIND_UNAUTHORIZED',
              `Concurrent rebind race: expected brainGen ${frame.expectedCurrentBrainGen}, active ${postAuthLease?.brainGen ?? 'missing'}`,
            )
          }
          const { lease } = await this.leaseManager.rebindBrain(
            frame.leaseId,
            frame.nextBrainGen,
            frame.nextFencingToken,
          )
          this.send({
            type: 'broker.result',
            channelId: frame.channelId,
            requestId: frame.requestId,
            rebindAck: {
              leaseId: lease.leaseId,
              brainGen: lease.brainGen,
              fencingToken: lease.fencingToken,
            },
          })
        } catch (err) {
          this.sendError(frame.channelId, frame.requestId, err)
        }
        return
      }

      default:
        return
    }
  }

  private sendError(channelId: string, requestId: string, err: unknown): void {
    const code =
      err instanceof ExecEnvLeaseError
        ? err.code
        : err instanceof ToolBrokerTransportError
          ? err.code
          : err instanceof ToolBrokerPolicyError
            ? err.code
            : 'BROKER_TRANSPORT_ERROR'
    const message = err instanceof Error ? err.message : String(err)
    this.send({
      type: 'broker.error',
      channelId,
      requestId,
      code,
      message,
    })
  }
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
  readonly timer: NodeJS.Timeout | null
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

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
  private closed = false

  constructor(opts: ContainerLinkToolBrokerClientOptions) {
    this.link = opts.link
    this.leaseId = opts.leaseId
    this.fencingToken = opts.fencingToken
    this.brainGen = opts.brainGen
    this.sessionKey = opts.sessionKey
    this.hostKind = opts.hostKind ?? 'compute-pool-docker'
    this.channelKind = opts.channelKind ?? HOST_KIND_DEFAULT_CHANNEL[this.hostKind]
    this.channelId = opts.channelId ?? `ch_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    this.requestTimeoutMs = Math.max(1, Math.floor(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS))

    this.unsubscribe = this.link.onFrame((raw) => {
      if (this.closed) return
      const frame = parseToolBrokerWireFrame(raw)
      if (!frame || frame.channelId !== this.channelId) return
      this.handleInboundFrame(frame)
    })
  }

  get activeFencingToken(): string {
    return this.fencingToken
  }

  get activeBrainGen(): number | undefined {
    return this.brainGen
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
  ): Promise<ToolBrokerResultEnvelope> {
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
      await reqPromise.catch(() => {})
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
  ): Promise<{ readonly leaseId: string; readonly brainGen: number; readonly fencingToken: string }> {
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
    for (const [id, req] of this.pending) {
      if (req.timer) clearTimeout(req.timer)
      req.reject(new ToolBrokerTransportError('BROKER_CHANNEL_CLOSED', `Channel closed: ${reason}`))
      this.pending.delete(id)
    }
  }

  private nextRequestId(): string {
    return `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`
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
      timer.unref()

      this.pending.set(requestId, { resolve, reject, onStream, timer })
      this.link.send(JSON.stringify(frame))
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
export function openChannel(
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

export type { ToolResultEnvelope }
