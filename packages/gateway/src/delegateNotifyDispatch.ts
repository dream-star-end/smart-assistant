/**
 * OCV5-22 R0/R1: JobTerminal emit + durable notify intent + retry.
 *
 * Delivery is a side channel: failure never rolls back the job terminal
 * state. Completer still owns callback_state; this module only advances
 * pending→injecting→delivered for origin-inject jobs when the notifier
 * flag is on (so Completer's origin-inject path can be skipped).
 */
import {
  classifyNotifyLane,
  delegateNotifyId,
  isDelegateTerminalState,
  type EngineNotifier,
  type NotifyLane,
  type NotifyResult,
} from '@openclaude/protocol'
import type { DelegateJobSnapshot, DelegateJobStore } from './delegateJobs.js'
import {
  buildJobTerminalFromSnapshot,
  isHeartbeatSilentOutput,
  laneForCallback,
  parseParentEngine,
  resultRefFromSnapshot,
} from './jobTerminal.js'

export type NotifyFence = { claimToken: string; fencingEpoch: number }

export type NotifyDispatchHooks = {
  resolveParentEngine?: (job: DelegateJobSnapshot) => ReturnType<typeof parseParentEngine>
  resolveNativeId?: (job: DelegateJobSnapshot) => string | undefined
  resolveGoal?: (job: DelegateJobSnapshot) => string | undefined
  resolveCallbackOrigin?: (job: DelegateJobSnapshot) => string | undefined
  onDelivered?: (job: DelegateJobSnapshot) => void | Promise<void>
}

function fenceOf(job: DelegateJobSnapshot): NotifyFence | undefined {
  if (!job.claimToken) return undefined
  return { claimToken: job.claimToken, fencingEpoch: job.fencingEpoch }
}

export function persistNotifyIntent(
  store: DelegateJobStore,
  job: DelegateJobSnapshot,
  patch: { parentEngine?: string; notifyLane: NotifyLane; notifyId: string },
): boolean {
  return store.patchNotifyIntent(job.id, patch, fenceOf(job))
}

async function ackDelivered(
  store: DelegateJobStore,
  job: DelegateJobSnapshot,
  hooks: NotifyDispatchHooks,
  notifyId: string,
  lane: NotifyLane,
): Promise<NotifyResult> {
  await hooks.onDelivered?.(store.snapshotOf(job.id) ?? job)
  return { ok: true, lane, notifyId }
}

export async function dispatchJobTerminalNotify(
  store: DelegateJobStore,
  job: DelegateJobSnapshot,
  notifier: EngineNotifier,
  hooks: NotifyDispatchHooks = {},
): Promise<NotifyResult | { skipped: true; reason: string }> {
  if (!isDelegateTerminalState(job.state)) {
    return { skipped: true, reason: 'not_terminal' }
  }

  const parentEngine =
    hooks.resolveParentEngine?.(job) ?? parseParentEngine(job.parentEngine)
  const notifyId = delegateNotifyId(job.id, job.callbackEpoch > 0 ? job.callbackEpoch : 1)
  const silent =
    job.callbackState === 'skipped_silent' ||
    job.callback === 'none' ||
    isHeartbeatSilentOutput(resultRefFromSnapshot(job))

  if (job.callbackState === 'delivered' || job.callbackState === 'abandoned') {
    const lane = (job.notifyLane as NotifyLane | undefined) ?? laneForCallback(job.callback, parentEngine)
    return ackDelivered(store, job, hooks, notifyId, lane)
  }

  if (silent) {
    persistNotifyIntent(store, job, {
      parentEngine: parentEngine ?? job.parentEngine,
      notifyLane: 'skipped_silent',
      notifyId,
    })
    return { ok: true, lane: 'skipped_silent', notifyId }
  }

  if (job.callback === 'stdout-wait') {
    persistNotifyIntent(store, job, {
      parentEngine: parentEngine ?? job.parentEngine,
      notifyLane: 'stdout-wait',
      notifyId,
    })
    return { ok: true, lane: 'stdout-wait', notifyId }
  }

  // Cron Completer is still the producer for cron-origin-inject (stage 2).
  // Record the intent so columns are populated, but do not deliver here.
  if (job.callback === 'cron-origin-inject') {
    persistNotifyIntent(store, job, {
      parentEngine: parentEngine ?? job.parentEngine,
      notifyLane: parentEngine ? classifyNotifyLane(parentEngine) : 'resume-inject',
      notifyId,
    })
    return { skipped: true, reason: 'cron_completer_owns_inject' }
  }

  if (!parentEngine) {
    persistNotifyIntent(store, job, {
      notifyLane: 'resume-inject',
      notifyId,
    })
    if (job.callback === 'origin-inject') {
      store.deferPendingNotify(job.id, fenceOf(job))
    }
    return { ok: false, failureClass: 'internal' }
  }

  const preferred = laneForCallback(job.callback, parentEngine)
  persistNotifyIntent(store, job, {
    parentEngine,
    notifyLane: preferred,
    notifyId,
  })

  const live = store.snapshotOf(job.id) ?? job
  const event = buildJobTerminalFromSnapshot(live, {
    parentEngine,
    parentNativeId: hooks.resolveNativeId?.(live),
    goal: hooks.resolveGoal?.(live),
    callbackOriginSessionKey: hooks.resolveCallbackOrigin?.(live),
  })
  if (!event) return { ok: false, failureClass: 'internal' }

  let deliveryToken: string | undefined
  if (job.callback === 'origin-inject') {
    const claimed = store.claimNotifyDelivery(job.id, fenceOf(live))
    if (!claimed.ok) return { skipped: true, reason: 'lost_claim' }
    deliveryToken = claimed.token
  }

  const result = await notifier.notify(event)
  if (result.ok) {
    if (result.lane !== preferred) {
      persistNotifyIntent(store, live, {
        parentEngine,
        notifyLane: result.lane,
        notifyId: result.notifyId,
      })
    }
    if (job.callback === 'origin-inject' && deliveryToken) {
      const delivered = store.completeNotifyDelivery(job.id, deliveryToken, fenceOf(live))
      if (delivered) await hooks.onDelivered?.(store.snapshotOf(job.id) ?? live)
    }
    return result
  }

  if (job.callback === 'origin-inject' && deliveryToken) {
    store.releaseNotifyClaim(job.id, deliveryToken, fenceOf(live))
  } else if (job.callback === 'origin-inject') {
    store.deferPendingNotify(job.id, fenceOf(live))
  }
  return result
}

export async function retryPendingNotifies(
  store: DelegateJobStore,
  notifier: EngineNotifier,
  hooks: NotifyDispatchHooks = {},
  opts: { dueOnly?: boolean } = {},
): Promise<{ scanned: number; delivered: number; failed: number; skipped: number }> {
  const summary = { scanned: 0, delivered: 0, failed: 0, skipped: 0 }
  const jobs = opts.dueOnly ? store.listDueNotify() : store.listPendingNotify()
  for (const job of jobs) {
    summary.scanned += 1
    const result = await dispatchJobTerminalNotify(store, job, notifier, hooks)
    if ('skipped' in result) {
      summary.skipped += 1
      continue
    }
    if (result.ok) summary.delivered += 1
    else summary.failed += 1
  }
  return summary
}

/** Milliseconds until the next pending/injecting notify is due, or undefined. */
export function delayUntilNextNotifyRetry(
  store: DelegateJobStore,
  now = Date.now(),
): number | undefined {
  let next: number | undefined
  for (const job of store.listPendingNotify()) {
    const at =
      job.callbackState === 'injecting'
        ? (job.notifyClaimedUntil ?? now)
        : (job.notifyRetryAt ?? now)
    if (next === undefined || at < next) next = at
  }
  if (next === undefined) return undefined
  return Math.max(0, next - now)
}
