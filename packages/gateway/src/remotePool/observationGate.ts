/**
 * Unified observation gate (`remote-driver-v4`) shared by master relay and container lane.
 *
 * Replaces per-engine observation gates for v4 lanes:
 * - Consumes normalized `RemoteSecurityEvent`s (`toolCallObserved`, `disallowedItem`),
 * - Enforces strict monotonic `seq` ordering and binding scope (`operationId`, `generation`, `profileId`, `authEpoch`),
 * - Independently recomputes `remoteCanonicalSha256(arguments)`,
 * - Atomically burns `claimedCallIds` BEFORE awaiting so concurrent requests for one `callId` never double-execute.
 */
import { EventEmitter } from 'node:events'
import {
  remoteCanonicalSha256,
  validatePendingToolRequest,
  validateSecurityEvent,
  type RemotePendingToolRequest,
  type RemoteSecurityEvent,
} from '@openclaude/protocol'
import { validateCc5NativeToolInput } from '../cc5NativeTool.js'
import { remotePoolNeed } from './types.js'

export interface ObservedRemoteToolCall {
  readonly operationId: string
  readonly generation: string
  readonly profileId: string
  readonly authEpoch: string
  readonly nativeSessionId: string
  readonly nativeTurnId?: string
  readonly callId: string
  readonly name: string
  readonly argsHash: string
  readonly arguments: Readonly<Record<string, unknown>>
  completed: boolean
}

export interface RemoteObservationScope {
  readonly operationId: string
  readonly generation: string
  readonly profileId: string
  readonly authEpoch: string
}

export class RemoteObservationGate {
  private readonly events = new EventEmitter()
  private readonly observed = new Map<string, ObservedRemoteToolCall>()
  private readonly seenCallIds = new Set<string>()
  private readonly claimedCallIds = new Set<string>()
  private fencedReason?: string
  private boundSessionId?: string
  private activeTurn = false
  private lastSeq = 0

  constructor(
    private readonly scope: RemoteObservationScope,
    private readonly allowedToolAliases: ReadonlySet<string>,
    private readonly onFence: (reason: string) => void,
    /**
     * Test-only fault-injection hook strictly rejected unless `allowTestBypassInTmp === true`
     * (used ONLY in isolated Conformance Group 3 red control to prove the suite catches a broken gate).
     */
    private readonly options: {
      testFaultBypassObservation?: boolean
      testFaultAllowDuplicateClaim?: boolean
      allowTestBypassInTmp?: boolean
      authorizeTimeoutMs?: number
    } = {},
  ) {
    if (
      (options.testFaultBypassObservation || options.testFaultAllowDuplicateClaim) &&
      !options.allowTestBypassInTmp
    ) {
      throw new Error('REMOTE_OBSERVATION_BYPASS_FORBIDDEN')
    }
    this.events.setMaxListeners(128)
  }

  get isFenced(): boolean {
    return this.fencedReason !== undefined
  }

  get fenceCode(): string | undefined {
    return this.fencedReason
  }

  get nativeSessionId(): string | undefined {
    return this.boundSessionId
  }

  bindSession(nativeSessionId: string): void {
    remotePoolNeed(!this.fencedReason && nativeSessionId.length > 0, 'REMOTE_OBSERVATION_SESSION_INVALID')
    if (this.boundSessionId && this.boundSessionId !== nativeSessionId) {
      this.revoke('REMOTE_OBSERVATION_SESSION_CHANGED')
      throw new Error('REMOTE_OBSERVATION_SESSION_CHANGED')
    }
    this.boundSessionId = nativeSessionId
  }

  beginTurn(): void {
    remotePoolNeed(!this.fencedReason, this.fencedReason ?? 'REMOTE_OBSERVATION_FENCED')
    this.observed.clear()
    this.activeTurn = true
  }

  endTurn(): void {
    this.activeTurn = false
    this.observed.clear()
  }

  revoke(reason = 'REMOTE_OBSERVATION_REJECTED'): void {
    if (this.fencedReason) return
    this.fencedReason = reason
    this.activeTurn = false
    this.events.emit('change')
    this.onFence(reason)
  }

  ingestSecurityEvent(rawEvent: unknown): RemoteSecurityEvent {
    try {
      remotePoolNeed(!this.fencedReason, this.fencedReason ?? 'REMOTE_OBSERVATION_FENCED')
      const ev = validateSecurityEvent(rawEvent)
      remotePoolNeed(
        ev.operationId === this.scope.operationId &&
          ev.generation === this.scope.generation &&
          ev.profileId === this.scope.profileId &&
          ev.authEpoch === this.scope.authEpoch,
        'REMOTE_OBSERVATION_SCOPE_MISMATCH',
      )
      remotePoolNeed(ev.seq > this.lastSeq, 'REMOTE_EVENT_SEQ_ORDER_INVALID')
      this.lastSeq = ev.seq

      if (ev.nativeSessionId && ev.nativeSessionId !== 'unassigned') {
        this.bindSession(ev.nativeSessionId)
      }

      const payload = ev.payload
      if (payload.kind === 'disallowedItem') {
        throw new Error('REMOTE_DISALLOWED_ITEM')
      }

      if (payload.kind === 'toolCallObserved') {
        remotePoolNeed(this.activeTurn, 'REMOTE_TOOL_OBSERVED_OUTSIDE_TURN')
        remotePoolNeed(
          ev.nativeSessionId && ev.nativeSessionId !== 'unassigned',
          'REMOTE_TOOL_OBSERVED_WITHOUT_SESSION',
        )
        remotePoolNeed(this.allowedToolAliases.has(payload.name), 'REMOTE_TOOL_ALIAS_NOT_ALLOWED')
        validateCc5NativeToolInput(`mcp__ocbridge__${payload.name}`, payload.arguments)
        const recomputedHash = remoteCanonicalSha256(payload.arguments)
        remotePoolNeed(recomputedHash === payload.argsHash, 'REMOTE_TOOL_ARGS_HASH_MISMATCH')

        if (payload.phase === 'started') {
          remotePoolNeed(
            !this.seenCallIds.has(payload.callId) && this.seenCallIds.size < 10_000,
            'REMOTE_TOOL_DUPLICATE_CALL_ID',
          )
          this.seenCallIds.add(payload.callId)
          this.observed.set(payload.callId, {
            operationId: ev.operationId,
            generation: ev.generation,
            profileId: ev.profileId,
            authEpoch: ev.authEpoch,
            nativeSessionId: ev.nativeSessionId,
            ...(ev.nativeTurnId ? { nativeTurnId: ev.nativeTurnId } : {}),
            callId: payload.callId,
            name: payload.name,
            argsHash: recomputedHash,
            arguments: structuredClone(payload.arguments),
            completed: false,
          })
        } else {
          const prior = this.observed.get(payload.callId)
          remotePoolNeed(
            prior !== undefined &&
              prior.nativeSessionId === ev.nativeSessionId &&
              prior.name === payload.name &&
              prior.argsHash === recomputedHash &&
              prior.nativeTurnId === ev.nativeTurnId,
            'REMOTE_TOOL_COMPLETION_MISMATCH',
          )
          prior.completed = true
        }
        this.events.emit('change')
      }

      return ev
    } catch (err) {
      const code = err instanceof Error ? err.message : 'REMOTE_OBSERVATION_REJECTED'
      this.revoke(code)
      throw err
    }
  }

  async authorize(
    rawRequest: RemotePendingToolRequest & {
      operationId?: string
      generation?: string
      profileId?: string
      authEpoch?: string
    },
    timeoutMs = this.options.authorizeTimeoutMs ?? 10_000,
  ): Promise<ObservedRemoteToolCall> {
    remotePoolNeed(!this.fencedReason, this.fencedReason ?? 'REMOTE_OBSERVATION_FENCED')
    remotePoolNeed(this.activeTurn, 'REMOTE_TOOL_REQUEST_OUTSIDE_TURN')
    const req = validatePendingToolRequest({
      rpcId: rawRequest.rpcId,
      callId: rawRequest.callId,
      nativeSessionId: rawRequest.nativeSessionId,
      ...(rawRequest.nativeTurnId ? { nativeTurnId: rawRequest.nativeTurnId } : {}),
      server: rawRequest.server,
      name: rawRequest.name,
      arguments: rawRequest.arguments,
      argsHash: rawRequest.argsHash,
    })

    if (rawRequest.operationId !== undefined) {
      remotePoolNeed(rawRequest.operationId === this.scope.operationId, 'REMOTE_TOOL_SCOPE_MISMATCH')
    }
    if (rawRequest.generation !== undefined) {
      remotePoolNeed(rawRequest.generation === this.scope.generation, 'REMOTE_TOOL_SCOPE_MISMATCH')
    }
    if (rawRequest.profileId !== undefined) {
      remotePoolNeed(rawRequest.profileId === this.scope.profileId, 'REMOTE_TOOL_SCOPE_MISMATCH')
    }
    if (rawRequest.authEpoch !== undefined) {
      remotePoolNeed(rawRequest.authEpoch === this.scope.authEpoch, 'REMOTE_TOOL_SCOPE_MISMATCH')
    }

    // Atomic claim burn BEFORE awaiting: two concurrent requests for the same `callId` can NEVER both pass!
    if (
      this.claimedCallIds.has(req.callId) &&
      !(this.options.testFaultAllowDuplicateClaim && this.options.allowTestBypassInTmp)
    ) {
      this.revoke('REMOTE_TOOL_CONCURRENT_OR_REPLAYED_CLAIM')
      throw new Error('REMOTE_TOOL_CONCURRENT_OR_REPLAYED_CLAIM')
    }
    this.claimedCallIds.add(req.callId)

    try {
      remotePoolNeed(this.allowedToolAliases.has(req.name), 'REMOTE_TOOL_ALIAS_NOT_ALLOWED')
      validateCc5NativeToolInput(`mcp__ocbridge__${req.name}`, req.arguments)
      const actualHash = remoteCanonicalSha256(req.arguments)
      remotePoolNeed(actualHash === req.argsHash, 'REMOTE_TOOL_ARGS_HASH_MISMATCH')

      if (this.options.testFaultBypassObservation && this.options.allowTestBypassInTmp) {
        return {
          ...this.scope,
          nativeSessionId: req.nativeSessionId,
          ...(req.nativeTurnId ? { nativeTurnId: req.nativeTurnId } : {}),
          callId: req.callId,
          name: req.name,
          argsHash: actualHash,
          arguments: structuredClone(req.arguments),
          completed: false,
        }
      }

      return await new Promise<ObservedRemoteToolCall>((resolve, reject) => {
        const finish = (err?: Error, value?: ObservedRemoteToolCall) => {
          clearTimeout(timer)
          this.events.removeListener('change', check)
          if (err) reject(err)
          else resolve(value!)
        }

        const check = () => {
          if (this.fencedReason) {
            finish(new Error(this.fencedReason))
            return
          }
          const obs = this.observed.get(req.callId)
          if (!obs) return
          const turnMatches =
            obs.nativeTurnId === undefined ||
            (req.nativeTurnId !== undefined && obs.nativeTurnId === req.nativeTurnId)
          const matches =
            obs.nativeSessionId === req.nativeSessionId &&
            obs.name === req.name &&
            obs.argsHash === actualHash &&
            turnMatches
          if (!matches) {
            finish(new Error('REMOTE_TOOL_SCOPE_MISMATCH'))
            return
          }
          finish(undefined, structuredClone(obs))
        }

        const timer = setTimeout(() => finish(new Error('REMOTE_TOOL_NOT_OBSERVED')), timeoutMs)
        timer.unref()
        this.events.on('change', check)
        check()
      })
    } catch (err) {
      this.revoke(err instanceof Error ? err.message : 'REMOTE_OBSERVATION_REJECTED')
      throw err
    }
  }
}
