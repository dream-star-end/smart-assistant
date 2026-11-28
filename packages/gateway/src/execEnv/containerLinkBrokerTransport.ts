/**
 * OCV5-890 / OCV5-915 Layer 3 — Multiplexed ContainerLink ToolBroker Host & Re-exports.
 *
 * Pure L0 wire types, parser, in-memory pair, and `ContainerLinkToolBrokerClient` live in
 * `@openclaude/protocol/exec-env` (`brokerChannel.ts`) and are re-exported here so existing
 * runtime callers keep full compatibility while keeping this file compact (`<= 520L`).
 *
 * Architecture invariants:
 * - R3-net: ZERO imports of `node:http`, `node:net`, `ws`, `fetch`, etc.
 * - R3-env / R3-crypto / R3-special-case: zero violations.
 */
import type { ToolResultEnvelope } from '@openclaude/protocol'
import {
  ContainerLinkToolBrokerClient,
  TOOL_BROKER_LOCAL_PREFIX,
  ToolBrokerTransportError,
  createInMemoryFrameLinkPair,
  isReservedToolBrokerFrame,
  isToolBrokerWireFrame,
  openExecEnvToolBrokerChannel,
  parseToolBrokerWireFrame,
  type ContainerLinkToolBrokerClientOptions,
  type FrameLinkLike,
  type OpenToolBrokerChannelOptions,
  type ToolBrokerRebindAck,
  type ToolBrokerWireFrame,
} from '@openclaude/protocol/exec-env'
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

export {
  ContainerLinkToolBrokerClient,
  TOOL_BROKER_LOCAL_PREFIX,
  ToolBrokerTransportError,
  createInMemoryFrameLinkPair,
  isReservedToolBrokerFrame,
  isToolBrokerWireFrame,
  openExecEnvToolBrokerChannel as openChannel,
  parseToolBrokerWireFrame,
}
export type {
  ContainerLinkToolBrokerClientOptions,
  FrameLinkLike,
  OpenToolBrokerChannelOptions,
  ToolBrokerRebindAck,
  ToolBrokerWireFrame,
  ToolResultEnvelope,
}

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
  private readonly activeCallsByLease = new Map<string, Set<string>>()
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

  dispose(reason = 'broker_host_disposed'): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    for (const [leaseId, callIds] of this.activeCallsByLease) {
      for (const callId of callIds) {
        void this.server.cancel(callId, reason, leaseId).catch((err) => {
          void err
        })
      }
      this.server.markLeaseDisconnected(leaseId, reason)
    }
    this.activeCallsByLease.clear()
  }

  private trackCall(leaseId: string, callId: string): () => void {
    let set = this.activeCallsByLease.get(leaseId)
    if (!set) {
      set = new Set()
      this.activeCallsByLease.set(leaseId, set)
    }
    set.add(callId)
    return () => {
      const cur = this.activeCallsByLease.get(leaseId)
      if (!cur) return
      cur.delete(callId)
      if (cur.size === 0) this.activeCallsByLease.delete(leaseId)
    }
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
        const untrack = this.trackCall(frame.leaseId, frame.call.callId)
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
        } finally {
          untrack()
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

      case 'broker.rebind':
        await this.handleRebindFrame(frame)
        return

      default:
        return
    }
  }

  private async handleRebindFrame(
    frame: Extract<ToolBrokerWireFrame, { type: 'broker.rebind' }>,
  ): Promise<void> {
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
      const currentSessionKey = this.verifyCurrentRebindLease(frame)
      await this.authorizeRebindFrame(frame, currentSessionKey)
      if (!this.leaseManager) {
        throw new ToolBrokerTransportError(
          'EXEC_REBIND_UNAUTHORIZED',
          'Host has no leaseManager configured to enforce atomic rebind',
        )
      }
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
        rebindAck: { leaseId: lease.leaseId, brainGen: lease.brainGen, fencingToken: lease.fencingToken },
      })
    } catch (err) {
      this.sendError(frame.channelId, frame.requestId, err)
    }
  }

  private verifyCurrentRebindLease(
    frame: Extract<ToolBrokerWireFrame, { type: 'broker.rebind' }>,
  ): string {
    if (!this.leaseManager) return ''
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
    return currentLease.sessionKey
  }

  private async authorizeRebindFrame(
    frame: Extract<ToolBrokerWireFrame, { type: 'broker.rebind' }>,
    currentSessionKey: string,
  ): Promise<void> {
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
        throw new ToolBrokerTransportError('EXEC_REBIND_UNAUTHORIZED', 'Migration rebind authorization rejected')
      }
      return
    }
    if (!this.rebindAuthority) {
      throw new ToolBrokerTransportError(
        'EXEC_REBIND_UNAUTHORIZED',
        'Host has no rebind authorization verifier configured',
      )
    }
    try {
      this.rebindAuthority.verifyAndConsumeToken(frame.rebindAuthToken, {
        toolName: REBIND_AUTH_TOOL_NAME,
        sessionKey: currentSessionKey,
        leaseId: frame.leaseId,
        callId: formatRebindAuthCallId(frame.expectedCurrentBrainGen, frame.nextBrainGen, frame.nextFencingToken),
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
