/** Actual receipt branch of dispatchJobTerminalNotify, not a second notifier. */
import { delegateNotifyId, type EngineNotifier, type NotifyResult } from '@openclaude/protocol'
import { type DelegateJobSnapshot, type DelegateJobStore, nextNotifyBackoffMs } from './delegateJobs.js'
import type { NotifyDispatchHooks } from './delegateNotifyDispatch.js'
import { NOTIFY_CLAIM_FENCE, type NotifyClaimFence } from './engineNotifier.js'
import { buildJobTerminalFromSnapshot, parseParentEngine } from './jobTerminal.js'

export async function dispatchReceiptTerminalNotify(store: DelegateJobStore, requested: DelegateJobSnapshot,
  notifier: EngineNotifier, hooks: NotifyDispatchHooks): Promise<NotifyResult | { skipped: true; reason: string }> {
  const outcome = await store.dispatchReceiptNotification(requested.id, requested.generation, async claim => {
    const live = store.snapshotOf(requested.id)
    if (!live || live.generation !== requested.generation || live.callbackEpoch !== claim.callbackEpoch) {
      throw new Error('receipt notify snapshot changed')
    }
    const parentEngine = hooks.resolveParentEngine?.(live) ?? parseParentEngine(live.parentEngine)
    if (!parentEngine) {
      claim.release(Date.now() + nextNotifyBackoffMs(live.notifyAttempt ?? 0))
      return { ok: false, failureClass: 'internal' } as NotifyResult
    }
    const event = buildJobTerminalFromSnapshot(live, { parentEngine,
      parentNativeId: hooks.resolveNativeId?.(live), goal: hooks.resolveGoal?.(live),
      callbackOriginSessionKey: hooks.resolveCallbackOrigin?.(live) })
    if (!event || event.callback !== 'origin-inject') throw new Error('receipt notify event unavailable')
    const fence: NotifyClaimFence = { ...claim, receiptDelivery: true }
    Object.defineProperty(event, NOTIFY_CLAIM_FENCE, { value: fence })
    // Throw/unknown retains the durable claim. Reclaim uses stable callback id,
    // never the old abandon/silent paths. The physical lock spans this await.
    const result = await notifier.notify(event)
    if (result.ok) {
      if (result.notifyId !== delegateNotifyId(live.id, claim.callbackEpoch) ||
          !['inline-push', 'resume-inject'].includes(result.lane)) throw new Error('receipt notify not delivered')
      if (!claim.ackDelivered()) throw new Error('receipt notify ACK not committed')
    } else if (!result.hold) {
      claim.release(Date.now() + nextNotifyBackoffMs(live.notifyAttempt ?? 0))
    }
    return result
  })
  if (outcome.kind === 'already_notified') return { skipped: true, reason: 'receipt_already_notified' }
  if (outcome.kind === 'not_ready') return { skipped: true, reason: 'receipt_owner_not_ready' }
  if (outcome.acknowledged) await hooks.onDelivered?.(store.snapshotOf(requested.id) ?? requested)
  return outcome.value
}
