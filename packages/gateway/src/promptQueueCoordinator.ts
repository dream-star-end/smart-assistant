import { randomUUID } from 'node:crypto'
import type { PromptQueueMutationFrame, PromptQueueSnapshot } from '@openclaude/protocol'
import type {
  PromptQueueClaimResult,
  PromptQueueClientApi,
  PromptQueueDetail,
  PromptQueueWireOwner,
} from './promptQueueClient.js'

const GRANT_TIMEOUT_MS = 25_000
const RECOVERY_RETRY_MS = 2_000
const LEASE_RENEW_MARGIN_MS = 10_000

export const PROMPT_QUEUE_DISPATCH_REQUEST_TYPE = 'outbound.prompt_queue.dispatch_request'
export const PROMPT_QUEUE_DISPATCH_RESULT_TYPE = 'outbound.prompt_queue.dispatch_result'
export const PROMPT_QUEUE_DISPATCH_CANCEL_TYPE = 'outbound.prompt_queue.dispatch_cancel'
export const PROMPT_QUEUE_GRANT_FIELD = '__oc_prompt_queue_grant'

export interface PromptQueueSessionContext {
  owner: PromptQueueWireOwner
  /** Routing-only identity. It is never serialized into a P1 request body. */
  userId: string
}

export interface PromptQueueDispatchRequest {
  type: typeof PROMPT_QUEUE_DISPATCH_REQUEST_TYPE
  grantId: string
  owner: PromptQueueWireOwner
  claim: { epoch: string; claimToken: string }
  item: {
    itemId: string
    clientMessageId: string
    contentHash: string
    content: Record<string, unknown>
    requestedExecution: PromptQueueDetail['requestedExecution']
  }
}

export interface PromptQueueGrantMarker {
  grantId: string
  itemId: string
  contentHash: string
  epoch: string
  claimToken: string
}

export interface PromptQueueDispatchResult {
  type: typeof PROMPT_QUEUE_DISPATCH_RESULT_TYPE
  grantId: string
  owner: PromptQueueWireOwner
  itemId: string
  contentHash: string
  epoch: string
  claimToken: string
  outcome: 'rejected'
  disposition: 'retryable' | 'user_action_required'
  reasonCode: string
}

export interface PromptQueueDispatchCancel {
  type: typeof PROMPT_QUEUE_DISPATCH_CANCEL_TYPE
  grantId: string
  owner: PromptQueueWireOwner
  itemId: string
  contentHash: string
  epoch: string
  claimToken: string
  reasonCode: string
}

export interface PromptQueueTurnLifecycle {
  readonly queueTurn: true
  /** Aborted if the exact accepted claim is lost before activation. Consumers
   * must fence paid/runtime work at their final preflight boundary. */
  readonly signal: AbortSignal
  onTurnReserved(reservation: {
    turnIndex: number
    turnKey: string
    traceId?: string
  }): Promise<void>
  onPreflightRejected(
    disposition: 'retryable' | 'user_action_required',
    reasonCode: string,
  ): Promise<void>
  onSettled(error?: unknown): Promise<void>
}

export interface PromptQueueCoordinatorCallbacks {
  broadcast(context: PromptQueueSessionContext, snapshot: PromptQueueSnapshot): void
  direct(context: PromptQueueSessionContext, requester: object, snapshot: PromptQueueSnapshot): void
  sendDispatch(context: PromptQueueSessionContext, frame: PromptQueueDispatchRequest): boolean
  interruptExact(context: PromptQueueSessionContext, turnId: string): Promise<boolean>
  persistInterrupted?(args: {
    context: PromptQueueSessionContext
    detail: PromptQueueDetail
    turnId: string
    turnIndex: number
  }): Promise<void>
  kickPersistence?(): void
  log?: {
    info(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
    error(message: string, fields?: Record<string, unknown>): void
  }
}

type Claim = NonNullable<PromptQueueClaimResult['claim']>

interface PendingClaim {
  claim: Claim
  detail: PromptQueueDetail
  grantId: string
  grantDeadlineAt: number
  grantTimer: ReturnType<typeof setTimeout> | null
  renewTimer: ReturnType<typeof setTimeout> | null
  grantAccepted: boolean
  lifecycleAbort: AbortController | null
  cancelCommercial: ((frame: PromptQueueDispatchCancel) => boolean) | null
}

interface ActiveReceipt {
  turnId: string
  turnIndex: number
}

interface CoordinatorState {
  context: PromptQueueSessionContext
  tail: Promise<void>
  clients: Set<object>
  pending: PendingClaim | null
  activeReceipt: ActiveReceipt | null
  recoveredTurnId: string | null
  recoveryTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
}

/**
 * Per-session queue authority coordinator. PG owns every durable state; this
 * object owns only short promises/timers and can be discarded on restart.
 */
export class PromptQueueCoordinator {
  private readonly states = new Map<string, CoordinatorState>()

  constructor(
    private readonly client: PromptQueueClientApi,
    private readonly callbacks: PromptQueueCoordinatorCallbacks,
    private readonly timing: {
      grantTimeoutMs?: number
      leaseRenewMarginMs?: number
      leaseRetryMs?: number
    } = {},
  ) {}

  async hello(context: PromptQueueSessionContext, requester: object): Promise<void> {
    const state = this.stateFor(context)
    state.clients.add(requester)
    await this.serial(state, async () => {
      const snapshot = await this.client.snapshot(context.owner)
      // Hello ordering is intentional: the gateway awaits ring replay before
      // calling here, then this fresh PG projection is sent only to this tab.
      this.callbacks.direct(context, requester, snapshot)
      await this.reconcileLocked(state, snapshot)
    })
  }

  async mutate(
    context: PromptQueueSessionContext,
    mutation: PromptQueueMutationFrame,
    requester: object,
  ): Promise<void> {
    const state = this.stateFor(context)
    state.clients.add(requester)
    await this.serial(state, async () => {
      const result = await this.client.mutate(context.owner, mutation)
      const outcome = result.snapshot.mutation?.outcome
      if (outcome === 'version_conflict' || outcome === 'rejected') {
        this.callbacks.direct(context, requester, result.snapshot)
      } else {
        this.callbacks.broadcast(context, result.snapshot)
      }

      if (
        mutation.type === 'inbound.prompt_queue.interject' &&
        mutation.mode === 'interrupt_then_head' &&
        outcome === 'delivery_pending' &&
        result.snapshot.activeTurn?.id === mutation.expectedTurnId
      ) {
        const stopped = await this.callbacks.interruptExact(context, mutation.expectedTurnId)
        if (stopped) {
          const ack = await this.client.claim(context.owner, {
            action: 'interrupt_ack',
            turnId: mutation.expectedTurnId,
          })
          this.callbacks.broadcast(context, ack.snapshot)
        }
      }
      await this.reconcileLocked(state, result.snapshot)
    })
  }

  /** Consume a commercial dispatch grant only when every server-owned field
   * still matches the one live claim. Late or browser-forged grants return null. */
  acceptGrant(
    context: PromptQueueSessionContext,
    marker: unknown,
    cancelCommercial?: (frame: PromptQueueDispatchCancel) => boolean,
  ): PromptQueueTurnLifecycle | null {
    const state = this.states.get(context.owner.sessionKey)
    const parsed = parseGrantMarker(marker)
    const pending = state?.pending
    if (!state || !pending || !parsed) return null
    if (
      pending.grantAccepted ||
      pending.grantId !== parsed.grantId ||
      pending.claim.itemId !== parsed.itemId ||
      pending.detail.contentHash !== parsed.contentHash ||
      pending.claim.epoch !== parsed.epoch ||
      pending.claim.claimToken !== parsed.claimToken
    )
      return null
    pending.grantAccepted = true
    pending.lifecycleAbort = new AbortController()
    pending.cancelCommercial = cancelCommercial ?? null
    // The commercial bridge has consumed this exact grant, so the short
    // acknowledgement deadline no longer applies. Keep renewing the PG claim
    // until the real SessionManager reservation activates it; otherwise a
    // slow attachment/preflight step can lose the claim underneath a valid
    // accepted grant.
    if (pending.grantTimer) clearTimeout(pending.grantTimer)
    pending.grantTimer = null

    let reserved = false
    let activated = false
    let settled = false
    return {
      queueTurn: true,
      signal: pending.lifecycleAbort.signal,
      onTurnReserved: async ({ turnIndex, turnKey, traceId }) => {
        if (reserved) throw new Error('prompt queue reservation callback repeated')
        reserved = true
        await this.serial(state, async () => {
          if (state.pending !== pending || state.closed) {
            throw new Error('prompt queue claim changed before turn reservation')
          }
          const activation = await this.client.claim(context.owner, {
            action: 'activate',
            epoch: pending.claim.epoch,
            claimToken: pending.claim.claimToken,
            turnId: turnKey,
            turnIndex,
            ...(traceId ? { traceId } : {}),
            // P2 keeps native/fork steering dark. Both engines therefore use
            // the lossless turn-boundary fallback until their later tasks land.
            steerDelivery: 'turn-boundary',
          })
          if (activation.outcome !== 'activated') {
            throw new Error(
              `prompt queue activation rejected: ${activation.code ?? activation.outcome}`,
            )
          }
          this.clearPendingTimers(pending)
          pending.cancelCommercial = null
          state.pending = null
          state.activeReceipt = { turnId: turnKey, turnIndex }
          activated = true
          this.callbacks.broadcast(context, activation.snapshot)
        })
      },
      onPreflightRejected: async (disposition, reasonCode) => {
        if (settled || activated) return
        settled = true
        await this.serial(state, async () => {
          if (state.pending === pending) {
            await this.releasePendingLocked(state, reasonCode, true, disposition)
          }
        })
      },
      onSettled: async (error) => {
        if (settled) return
        settled = true
        this.callbacks.kickPersistence?.()
        await this.serial(state, async () => {
          if (!activated && state.pending === pending) {
            await this.releasePendingLocked(state, error ? 'DISPATCH_FAILED' : 'NOT_RESERVED')
            return
          }
          if (state.activeReceipt) await this.completeLocked(state, state.activeReceipt)
        })
      },
    }
  }

  /** A trusted commercial bridge can reject a grant before it returns an
   * inbound.message. Correlation is exact and single-use; late/forged results
   * cannot release a newer claim. */
  async rejectGrant(context: PromptQueueSessionContext, value: unknown): Promise<boolean> {
    const result = parseDispatchResult(value)
    const state = this.states.get(context.owner.sessionKey)
    const pending = state?.pending
    if (!state || !pending || !result || !sameOwner(result.owner, context.owner)) return false
    if (
      pending.grantAccepted ||
      pending.grantId !== result.grantId ||
      pending.claim.itemId !== result.itemId ||
      pending.detail.contentHash !== result.contentHash ||
      pending.claim.epoch !== result.epoch ||
      pending.claim.claimToken !== result.claimToken
    )
      return false
    pending.grantAccepted = true
    await this.serial(state, async () => {
      if (state.pending === pending) {
        await this.releasePendingLocked(state, result.reasonCode, true, result.disposition)
      }
    })
    return true
  }

  async reconcile(context: PromptQueueSessionContext): Promise<void> {
    const state = this.stateFor(context)
    await this.serial(state, async () => {
      await this.reconcileLocked(state, await this.client.snapshot(context.owner))
    })
  }

  async disconnect(context: PromptQueueSessionContext, requester: object): Promise<void> {
    const state = this.states.get(context.owner.sessionKey)
    if (!state) return
    await this.serial(state, async () => {
      state.clients.delete(requester)
      if (state.clients.size > 0) return
      // Once commercial preparation has accepted a grant it no longer belongs
      // to any browser tab. Releasing it on the final-tab disconnect races the
      // still-running attachment/preflight path and can invalidate paid work.
      // Keep the exact lease alive until activation or an explicit rejection.
      if (state.pending && !state.pending.grantAccepted) {
        await this.releasePendingLocked(state, 'NO_CLIENT')
      }
      if (!state.activeReceipt) {
        this.clearRecovery(state)
        state.closed = true
        this.states.delete(context.owner.sessionKey)
      }
    })
  }

  shutdown(): void {
    for (const state of this.states.values()) {
      state.closed = true
      if (state.pending) this.clearPendingTimers(state.pending)
      if (state.recoveryTimer) clearTimeout(state.recoveryTimer)
    }
    this.states.clear()
  }

  private stateFor(context: PromptQueueSessionContext): CoordinatorState {
    let state = this.states.get(context.owner.sessionKey)
    if (!state) {
      state = {
        context,
        tail: Promise.resolve(),
        clients: new Set(),
        pending: null,
        activeReceipt: null,
        recoveredTurnId: null,
        recoveryTimer: null,
        closed: false,
      }
      this.states.set(context.owner.sessionKey, state)
    } else {
      state.context = context
    }
    return state
  }

  private async serial(state: CoordinatorState, operation: () => Promise<void>): Promise<void> {
    const next = state.tail.then(operation, operation)
    state.tail = next.catch((err) => {
      this.callbacks.log?.error('prompt_queue.transition_failed', {
        sessionKey: state.context.owner.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      })
      this.scheduleRecovery(state)
    })
    return next
  }

  private async reconcileLocked(
    state: CoordinatorState,
    initialSnapshot: PromptQueueSnapshot,
  ): Promise<void> {
    if (state.closed) return
    let snapshot = initialSnapshot
    if (snapshot.activeTurn) {
      const detail = await this.client.detail(state.context.owner, snapshot.activeTurn.sourceItemId)
      const turnIndex = readTurnIndex(detail.engineReceipt)
      if (turnIndex === null) {
        this.callbacks.log?.warn('prompt_queue.active_missing_engine_receipt', {
          sessionKey: state.context.owner.sessionKey,
          turnId: snapshot.activeTurn.id,
        })
        this.scheduleRecovery(state)
        return
      }
      const liveReceipt = state.activeReceipt
      const ownedByThisProcess =
        liveReceipt?.turnId === snapshot.activeTurn.id && liveReceipt.turnIndex === turnIndex
      if (!ownedByThisProcess && state.recoveredTurnId !== snapshot.activeTurn.id) {
        if (!this.callbacks.persistInterrupted) {
          this.callbacks.log?.error('prompt_queue.restart_recovery_unavailable', {
            sessionKey: state.context.owner.sessionKey,
            turnId: snapshot.activeTurn.id,
          })
          this.scheduleRecovery(state)
          return
        }
        state.recoveredTurnId = snapshot.activeTurn.id
        try {
          await this.callbacks.persistInterrupted({
            context: state.context,
            detail,
            turnId: snapshot.activeTurn.id,
            turnIndex,
          })
          this.callbacks.kickPersistence?.()
        } catch (err) {
          state.recoveredTurnId = null
          throw err
        }
      }
      state.activeReceipt = { turnId: snapshot.activeTurn.id, turnIndex }
      await this.completeLocked(state, state.activeReceipt)
      return
    }

    state.activeReceipt = null
    state.recoveredTurnId = null
    if (state.clients.size === 0) {
      this.clearRecovery(state)
      state.closed = true
      this.states.delete(state.context.owner.sessionKey)
      return
    }
    if (state.pending) return
    const acquired = await this.client.claim(state.context.owner, {
      action: 'acquire',
      expectedVersion: snapshot.version,
    })
    snapshot = acquired.snapshot
    if (acquired.outcome === 'empty') return
    if ((acquired.outcome !== 'acquired' && acquired.outcome !== 'renewed') || !acquired.claim) {
      if (acquired.code !== 'CLAIM_HELD' && acquired.code !== 'ACTIVE_TURN') {
        this.callbacks.log?.warn('prompt_queue.acquire_rejected', {
          sessionKey: state.context.owner.sessionKey,
          code: acquired.code,
        })
      }
      return
    }
    this.callbacks.broadcast(state.context, snapshot)
    let detail: PromptQueueDetail
    try {
      detail = await this.client.detail(state.context.owner, acquired.claim.itemId)
    } catch (err) {
      // A claim without its immutable payload must never linger until TTL and
      // accidentally dispatch after the caller has already seen a failure.
      // Release with the exact server-issued epoch/token; a failed release is
      // still safe because P1 lease expiry remains the final fence.
      try {
        const released = await this.client.claim(state.context.owner, {
          action: 'release',
          epoch: acquired.claim.epoch,
          claimToken: acquired.claim.claimToken,
          disposition: 'retryable',
          reasonCode: 'DETAIL_UNAVAILABLE',
        })
        this.callbacks.broadcast(state.context, released.snapshot)
      } catch (releaseErr) {
        this.callbacks.log?.warn('prompt_queue.detail_release_failed', {
          sessionKey: state.context.owner.sessionKey,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        })
      }
      this.scheduleRecovery(state)
      this.callbacks.log?.warn('prompt_queue.detail_failed', {
        sessionKey: state.context.owner.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    const pending: PendingClaim = {
      claim: acquired.claim,
      detail,
      grantId: randomUUID(),
      grantDeadlineAt: Date.now() + (this.timing.grantTimeoutMs ?? GRANT_TIMEOUT_MS),
      grantTimer: null,
      renewTimer: null,
      grantAccepted: false,
      lifecycleAbort: null,
      cancelCommercial: null,
    }
    state.pending = pending
    this.scheduleClaimTimers(state, pending)
    const sent = this.callbacks.sendDispatch(state.context, {
      type: PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
      grantId: pending.grantId,
      owner: state.context.owner,
      claim: { epoch: pending.claim.epoch, claimToken: pending.claim.claimToken },
      item: {
        itemId: detail.itemId,
        clientMessageId: detail.clientMessageId,
        contentHash: detail.contentHash,
        content: detail.content,
        requestedExecution: detail.requestedExecution,
      },
    })
    if (!sent) await this.releasePendingLocked(state, 'NO_BRIDGE')
  }

  private async completeLocked(state: CoordinatorState, receipt: ActiveReceipt): Promise<void> {
    const completed = await this.client.claim(state.context.owner, {
      action: 'complete',
      turnId: receipt.turnId,
      turnIndex: receipt.turnIndex,
    })
    if (completed.outcome === 'completed') {
      state.activeReceipt = null
      state.recoveredTurnId = null
      this.clearRecovery(state)
      this.callbacks.broadcast(state.context, completed.snapshot)
      await this.reconcileLocked(state, completed.snapshot)
      return
    }
    if (completed.code === 'TAPE_NOT_ACKED') {
      this.scheduleRecovery(state)
      return
    }
    if (completed.code === 'TURN_CHANGED') {
      state.activeReceipt = null
      state.recoveredTurnId = null
      this.clearRecovery(state)
      await this.reconcileLocked(state, completed.snapshot)
      return
    }
    this.callbacks.log?.warn('prompt_queue.complete_rejected', {
      sessionKey: state.context.owner.sessionKey,
      code: completed.code,
    })
    this.scheduleRecovery(state)
  }

  private scheduleClaimTimers(state: CoordinatorState, pending: PendingClaim): void {
    if (!pending.grantAccepted) {
      const grantDelay = Math.max(
        1,
        Math.min(
          pending.grantDeadlineAt - Date.now(),
          pending.claim.leaseUntil - Date.now() - 100,
        ),
      )
      pending.grantTimer = setTimeout(() => {
        void this.serial(state, async () => {
          if (state.pending === pending && !pending.grantAccepted) {
            await this.releasePendingLocked(state, 'GRANT_TIMEOUT')
          }
        })
      }, grantDelay)
    }
    this.scheduleRenewTimer(state, pending)
  }

  private scheduleRenewTimer(
    state: CoordinatorState,
    pending: PendingClaim,
    retryDelayMs?: number,
  ): void {
    if (pending.renewTimer) clearTimeout(pending.renewTimer)
    const renewDelay = retryDelayMs ?? Math.max(
      1,
      pending.claim.leaseUntil - Date.now()
        - (this.timing.leaseRenewMarginMs ?? LEASE_RENEW_MARGIN_MS),
    )
    pending.renewTimer = setTimeout(() => {
      pending.renewTimer = null
      void this.serial(state, async () => {
        if (state.pending !== pending) return
        let renewed: PromptQueueClaimResult
        try {
          const snapshot = await this.client.snapshot(state.context.owner)
          renewed = await this.client.claim(state.context.owner, {
            action: 'acquire',
            expectedVersion: snapshot.version,
          })
        } catch (err) {
          this.callbacks.log?.warn('prompt_queue.renew_failed', {
            sessionKey: state.context.owner.sessionKey,
            error: err instanceof Error ? err.message : String(err),
          })
          await this.retryRenewalOrLoseLocked(state, pending)
          return
        }

        if (renewed.outcome === 'rejected' && renewed.code === 'VERSION_CONFLICT') {
          // A concurrent queue mutation can change snapshot.version between the
          // fresh read and acquire. It says nothing about lease ownership.
          await this.retryRenewalOrLoseLocked(state, pending)
          return
        }

        const exactRenewal =
          renewed.outcome === 'renewed' &&
          renewed.claim?.renewed === true &&
          renewed.claim.itemId === pending.claim.itemId &&
          renewed.claim.epoch === pending.claim.epoch &&
          renewed.claim.claimToken === pending.claim.claimToken
        if (!exactRenewal || !renewed.claim) {
          // `acquired` after expiry rotates the server epoch/token. That is a
          // new claim and can never authorize an already accepted grant. Give
          // it back with its own exact receipt, abort the old lifecycle, and
          // let normal reconciliation issue a fresh commercial grant.
          const releaseClaim = renewed.outcome === 'acquired' ? renewed.claim : pending.claim
          await this.releasePendingLocked(
            state,
            'LEASE_LOST',
            true,
            'retryable',
            releaseClaim,
          )
          return
        }

        pending.claim = renewed.claim
        this.scheduleRenewTimer(state, pending)
      })
    }, renewDelay)
  }

  private async retryRenewalOrLoseLocked(
    state: CoordinatorState,
    pending: PendingClaim,
  ): Promise<void> {
    if (state.pending !== pending) return
    const remaining = pending.claim.leaseUntil - Date.now()
    if (remaining <= 0) {
      await this.releasePendingLocked(state, 'LEASE_LOST')
      return
    }
    const retryDelay = Math.max(
      1,
      Math.min(this.timing.leaseRetryMs ?? RECOVERY_RETRY_MS, remaining),
    )
    this.scheduleRenewTimer(state, pending, retryDelay)
  }

  private async releasePendingLocked(
    state: CoordinatorState,
    reasonCode: string,
    callServer = true,
    disposition: 'retryable' | 'user_action_required' = 'retryable',
    releaseClaim?: Claim,
  ): Promise<void> {
    const pending = state.pending
    if (!pending) return
    this.clearPendingTimers(pending)
    state.pending = null
    if (pending.grantAccepted && pending.cancelCommercial) {
      const cancel = pending.cancelCommercial
      pending.cancelCommercial = null
      try {
        cancel({
          type: PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
          grantId: pending.grantId,
          owner: state.context.owner,
          itemId: pending.claim.itemId,
          contentHash: pending.detail.contentHash,
          epoch: pending.claim.epoch,
          claimToken: pending.claim.claimToken,
          reasonCode,
        })
      } catch (err) {
        this.callbacks.log?.warn('prompt_queue.commercial_cancel_failed', {
          sessionKey: state.context.owner.sessionKey,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (pending.lifecycleAbort && !pending.lifecycleAbort.signal.aborted) {
      pending.lifecycleAbort.abort(new Error(`prompt queue claim released: ${reasonCode}`))
    }
    if (callServer) {
      try {
        const exactClaim = releaseClaim ?? pending.claim
        const released = await this.client.claim(state.context.owner, {
          action: 'release',
          epoch: exactClaim.epoch,
          claimToken: exactClaim.claimToken,
          disposition,
          reasonCode,
        })
        this.callbacks.broadcast(state.context, released.snapshot)
      } catch (err) {
        this.callbacks.log?.warn('prompt_queue.release_failed', {
          sessionKey: state.context.owner.sessionKey,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    this.scheduleRecovery(state)
  }

  private scheduleRecovery(state: CoordinatorState): void {
    if (state.closed || state.recoveryTimer) return
    state.recoveryTimer = setTimeout(() => {
      state.recoveryTimer = null
      void this.reconcile(state.context)
    }, RECOVERY_RETRY_MS)
  }

  private clearRecovery(state: CoordinatorState): void {
    if (state.recoveryTimer) clearTimeout(state.recoveryTimer)
    state.recoveryTimer = null
  }

  private clearPendingTimers(pending: PendingClaim): void {
    if (pending.grantTimer) clearTimeout(pending.grantTimer)
    if (pending.renewTimer) clearTimeout(pending.renewTimer)
    pending.grantTimer = null
    pending.renewTimer = null
  }
}

function parseGrantMarker(value: unknown): PromptQueueGrantMarker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const marker = value as Record<string, unknown>
  const keys = Object.keys(marker)
  if (
    keys.length !== 5 ||
    !keys.every((key) => ['grantId', 'itemId', 'contentHash', 'epoch', 'claimToken'].includes(key))
  )
    return null
  if (
    typeof marker.grantId !== 'string' ||
    typeof marker.itemId !== 'string' ||
    typeof marker.contentHash !== 'string' ||
    typeof marker.epoch !== 'string' ||
    typeof marker.claimToken !== 'string'
  )
    return null
  return marker as unknown as PromptQueueGrantMarker
}

function parseDispatchResult(value: unknown): PromptQueueDispatchResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  const allowed = [
    'type',
    'grantId',
    'owner',
    'itemId',
    'contentHash',
    'epoch',
    'claimToken',
    'outcome',
    'disposition',
    'reasonCode',
  ]
  if (
    Object.keys(result).length !== allowed.length ||
    !Object.keys(result).every((key) => allowed.includes(key))
  )
    return null
  if (
    result.type !== PROMPT_QUEUE_DISPATCH_RESULT_TYPE ||
    result.outcome !== 'rejected' ||
    (result.disposition !== 'retryable' && result.disposition !== 'user_action_required') ||
    typeof result.grantId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(result.grantId) ||
    typeof result.itemId !== 'string' ||
    typeof result.contentHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(result.contentHash) ||
    typeof result.epoch !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(result.epoch) ||
    typeof result.claimToken !== 'string' ||
    !/^[0-9a-f]{64}$/.test(result.claimToken) ||
    typeof result.reasonCode !== 'string' ||
    !/^[A-Z0-9_]{1,64}$/.test(result.reasonCode) ||
    !parseOwner(result.owner)
  )
    return null
  return result as unknown as PromptQueueDispatchResult
}

function parseOwner(value: unknown): PromptQueueWireOwner | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const owner = value as Record<string, unknown>
  if (
    Object.keys(owner).length !== 4 ||
    !Object.keys(owner).every((key) =>
      ['sessionKey', 'clientSessionId', 'agentId', 'peer'].includes(key),
    )
  )
    return null
  const peer = owner.peer
  if (!peer || typeof peer !== 'object' || Array.isArray(peer)) return null
  const peerRecord = peer as Record<string, unknown>
  if (
    Object.keys(peerRecord).length !== 2 ||
    peerRecord.kind !== 'dm' ||
    typeof peerRecord.id !== 'string' ||
    peerRecord.id !== owner.clientSessionId ||
    typeof owner.sessionKey !== 'string' ||
    typeof owner.clientSessionId !== 'string' ||
    typeof owner.agentId !== 'string'
  )
    return null
  const safeId = peerRecord.id.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (owner.sessionKey !== `agent:${owner.agentId}:webchat:dm:${safeId}`) return null
  return owner as unknown as PromptQueueWireOwner
}

function sameOwner(left: PromptQueueWireOwner, right: PromptQueueWireOwner): boolean {
  return (
    left.sessionKey === right.sessionKey &&
    left.clientSessionId === right.clientSessionId &&
    left.agentId === right.agentId &&
    left.peer.kind === right.peer.kind &&
    left.peer.id === right.peer.id
  )
}

function readTurnIndex(receipt: Record<string, unknown> | undefined): number | null {
  const value = receipt?.turnIndex
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}
