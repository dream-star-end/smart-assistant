import { isClientMessageId, type OutboundAck } from '@openclaude/protocol'
import { rejectedDispatchFailureCode } from '../dispatch/attachmentTotalFailure.js'
import type { Pool } from 'pg'
import { casAdmittedToAccepted, casToTerminal, getDispatchByLogicalKey } from '../dispatch/turnDispatchStore.js'
import { markRecoveryContainerReceipt, type ClaimedRecoveryJob } from '../dispatch/turnRecoveryStore.js'
import { recoveryRunningFrame } from './recoveryPresentation.js'

type Receipt = {
  clientMessageId?: unknown; dispatchId?: unknown; attemptNo?: unknown
  sessionId?: unknown; state?: unknown; outcome?: unknown
  userFailureCode?: unknown
}
type ReceiptRecord = {
  clientMessageId: string; sessionId: string; dispatchId: string; attemptNo: number
  leaseEpoch: number; leaseOwnerId: string; recoveryJob?: ClaimedRecoveryJob
}
type ClaimResult = { kind: 'claimed' } | { kind: 'rejected' } | { kind: 'delivery_unknown' }
type ReceiptContext<R extends ReceiptRecord, E extends { record: R }> = {
  pool: Pool | null | undefined
  uid: bigint
  admittedDispatches: ReadonlyMap<string, R>
  enrichmentDispatches: Map<string, E>
  claimEnrichmentTerminalization(state: E): boolean
  acceptEnrichmentReceipt(record: R): boolean
  dropAdmittedDispatch(clientMessageId: string): void
  settleCronOriginClaim(dispatchId: string, result: ClaimResult): void
  hasCronOriginClaim(dispatchId: string): boolean
  noteDispatchStreamFrame(sessionId: string, clientMessageId: string, final: boolean): void
  broadcast(frame: unknown): void
  warn(message: string, meta: Record<string, unknown>): void
}

export function classifyTurnDispatchReceipt(
  receipt: Receipt,
  expected: Pick<ReceiptRecord, 'dispatchId' | 'attemptNo' | 'sessionId' | 'clientMessageId'>,
): 'accepted' | 'rejected' | 'invalid' {
  if (receipt.dispatchId !== expected.dispatchId || receipt.attemptNo !== expected.attemptNo ||
    receipt.sessionId !== expected.sessionId || receipt.clientMessageId !== expected.clientMessageId) return 'invalid'
  if (receipt.state === 'rejected') {
    return receipt.outcome === 'not_accepted' || receipt.outcome === null ? 'rejected' : 'invalid'
  }
  if (receipt.state === 'terminal') {
    return receipt.outcome === 'completed' || receipt.outcome === 'interrupted' || receipt.outcome === 'crashed'
      ? 'accepted' : 'invalid'
  }
  return receipt.outcome === null && ['queued', 'running', 'recovery_pending', 'sink_staged', 'sink_stage_failed'].includes(receipt.state as string)
    ? 'accepted' : 'invalid'
}

/** Consume the internal inbox receipt. Only a committed admission CAS emits
 * browser acceptance; transport receipt parsing itself never confirms it. */
export function handleTurnDispatchReceipt<R extends ReceiptRecord, E extends { record: R }>(
  text: string | null, context: ReceiptContext<R, E>,
): boolean {
  if (text === null || !text.includes('"outbound.control.turn_dispatch_receipt"')) return false
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return false }
  if (!parsed || typeof parsed !== 'object' ||
    (parsed as { type?: unknown }).type !== 'outbound.control.turn_dispatch_receipt') return false
  const receipt = parsed as Receipt
  const rec = isClientMessageId(receipt.clientMessageId) ? context.admittedDispatches.get(receipt.clientMessageId) : undefined
  if (!rec) return true
  const disposition = classifyTurnDispatchReceipt(receipt, rec)
  if (disposition === 'invalid') {
    context.warn('user-chat-bridge: invalid dispatch receipt ignored', {
      dispatchId: receipt.dispatchId, clientMessageId: receipt.clientMessageId,
      attemptNo: receipt.attemptNo, state: receipt.state,
    })
    return true
  }
  const pool = context.pool
  if (disposition === 'rejected') {
    const enrichment = context.enrichmentDispatches.get(rec.clientMessageId)
    if (enrichment?.record === rec && !context.claimEnrichmentTerminalization(enrichment)) return true
    const cleanup = () => {
      if (context.enrichmentDispatches.get(rec.clientMessageId) === enrichment) {
        context.enrichmentDispatches.delete(rec.clientMessageId)
      }
      context.dropAdmittedDispatch(rec.clientMessageId)
    }
    if (!pool) {
      context.settleCronOriginClaim(rec.dispatchId, { kind: 'delivery_unknown' })
      cleanup()
      return true
    }
    void (async () => {
      let persisted = false
      try {
        // A rejected inbox identity is an irreversible container tombstone.
        // Keep the commercial terminal handoff so recovery selects a new cmid.
        persisted = await casToTerminal(pool, {
          dispatchId: rec.dispatchId, outcome: 'not_accepted',
          failureCode: rejectedDispatchFailureCode({ kind: 'ok', userFailureCode: receipt.userFailureCode }),
          clientNotified: false, fromStatuses: ['admitted'], expectedEpoch: rec.leaseEpoch,
        }) !== null
      } catch (err) {
        context.warn('user-chat-bridge: rejected receipt convergence failed', { dispatchId: rec.dispatchId, err })
      } finally {
        context.settleCronOriginClaim(rec.dispatchId, { kind: persisted ? 'rejected' : 'delivery_unknown' })
        cleanup()
      }
    })()
    return true
  }
  // Claim the enrichment fence synchronously, before the PG await or a close.
  if (!context.acceptEnrichmentReceipt(rec)) return true
  context.noteDispatchStreamFrame(rec.sessionId, rec.clientMessageId, false)
  const acceptedFrame = (): OutboundAck => ({
    type: 'outbound.ack', peer: { id: rec.sessionId, kind: 'dm' },
    clientMessageId: rec.clientMessageId, accepted: true,
  })
  if (!pool) {
    context.settleCronOriginClaim(rec.dispatchId, { kind: 'delivery_unknown' })
    context.dropAdmittedDispatch(rec.clientMessageId)
  } else if (rec.recoveryJob) {
    void markRecoveryContainerReceipt(pool, {
      dispatchId: rec.dispatchId, dispatchAttemptNo: rec.attemptNo,
      expectedDispatchLeaseEpoch: rec.leaseEpoch,
    }).then((accepted) => {
      // The atomic recovery statement verifies this exact attempt/epoch is
      // accepted before it commits forwarded; duplicate receipts cannot win it.
      if (accepted) {
        context.broadcast(acceptedFrame())
        context.broadcast(recoveryRunningFrame(rec.recoveryJob!))
      }
    }).catch(() => {})
    context.dropAdmittedDispatch(rec.clientMessageId)
  } else {
    void (async () => {
      let claimed = false
      const mustConfirmCronClaim = context.hasCronOriginClaim(rec.dispatchId)
      try {
        const accepted = await casAdmittedToAccepted(pool, {
          dispatchId: rec.dispatchId, expectedEpoch: rec.leaseEpoch,
        })
        if (accepted !== null) {
          claimed = true
          context.broadcast(acceptedFrame())
        } else if (mustConfirmCronClaim) {
          const durable = await getDispatchByLogicalKey(pool, {
            userId: context.uid, sessionId: rec.sessionId, clientMessageId: rec.clientMessageId,
          })
          claimed = durable?.dispatchId === rec.dispatchId && durable.attemptNo === rec.attemptNo && durable.status === 'accepted'
        }
      } catch (err) {
        context.warn('user-chat-bridge: dispatch receipt CAS failed', { dispatchId: rec.dispatchId, err })
      } finally {
        context.settleCronOriginClaim(rec.dispatchId, { kind: claimed ? 'claimed' : 'delivery_unknown' })
        context.dropAdmittedDispatch(rec.clientMessageId)
      }
    })()
  }
  return true
}
