import { isClientMessageId } from '@openclaude/protocol'
import type { Pool } from 'pg'
import { casAdmittedToRejecting, getDispatchByLogicalKey } from '../dispatch/turnDispatchStore.js'

type RejectedDispatch = {
  clientMessageId: string; sessionId: string; dispatchId: string; attemptNo: number
  leaseEpoch: number; leaseOwnerId: string
}

/** A refusal is only a reason to ask the durable inbox for proof. A delayed
 * duplicate may be refused after an earlier copy has already started. */
export function handleDispatchAuthorityRejection<R extends RejectedDispatch>(text: string | null, context: {
  pool: Pool | null | undefined
  uid: bigint
  admittedDispatches: ReadonlyMap<string, R>
  acceptEnrichmentReceipt(record: R): boolean
  dropAdmittedDispatch(clientMessageId: string): void
  settleCronOriginClaim(dispatchId: string, result: { kind: 'delivery_unknown' }): void
  warn(message: string, meta: Record<string, unknown>): void
}): boolean {
  if (text === null || !text.includes('MODEL_AUTHORITY_REJECTED')) return false
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return false }
  if (!parsed || typeof parsed !== 'object') return false
  const frame = parsed as Record<string, unknown>
  if (frame.type !== 'error' || frame.code !== 'MODEL_AUTHORITY_REJECTED') return false
  const rec = isClientMessageId(frame.clientMessageId) ? context.admittedDispatches.get(frame.clientMessageId) : undefined
  const peer = frame.peer as { id?: unknown; kind?: unknown } | undefined
  const pool = context.pool
  if (frame.authorityExpired !== true || !isClientMessageId(frame.clientMessageId) ||
    typeof peer?.id !== 'string' || peer.kind !== 'dm' || typeof frame.dispatchId !== 'string' ||
    !Number.isSafeInteger(frame.attemptNo) || !pool) return true
  if (rec && (frame.dispatchId !== rec.dispatchId || frame.attemptNo !== rec.attemptNo ||
    peer.id !== rec.sessionId || !context.acceptEnrichmentReceipt(rec))) return true
  // Stop renewing this owner immediately, including if PG is temporarily down.
  // The normal lease reconciler remains the durable fallback.
  if (rec) {
    context.dropAdmittedDispatch(rec.clientMessageId)
    context.settleCronOriginClaim(rec.dispatchId, { kind: 'delivery_unknown' })
  }
  void (async () => {
    const durable = rec ?? await getDispatchByLogicalKey(pool, {
      userId: context.uid, sessionId: peer.id as string, clientMessageId: frame.clientMessageId as string,
    })
    if (!durable || ('status' in durable && durable.status !== 'admitted') ||
      durable.dispatchId !== frame.dispatchId || durable.attemptNo !== frame.attemptNo) return
    await casAdmittedToRejecting(pool, {
      dispatchId: durable.dispatchId, expectedEpoch: durable.leaseEpoch,
      ownerId: rec?.leaseOwnerId ?? `authority-rejection:${context.uid}`,
      failureCode: 'DISPATCH_AUTHORITY_EXPIRED',
    })
  })().catch((err) => context.warn('dispatch authority rejection convergence failed', { dispatchId: frame.dispatchId, err }))
  return true
}
