/**
 * OCV5-22 stage 2: JobTerminal emit + durable notify intent + retry.
 *
 * Delivery is a side channel: failure never rolls back the job terminal
 * state. Completer decides callback_state; this module advances
 * pending→injecting→delivered for ResumeInject callbacks (origin-inject
 * and cron-origin-inject) when the notifier flag is on, so Completer
 * must skip those inject paths to avoid double delivery.
 */
import {
  delegateNotifyId,
  isDelegateTerminalState,
  type EngineNotifier,
  type NotifyLane,
  type NotifyResult,
} from '@openclaude/protocol'
import {
  isResumeInjectCallback,
  type DelegateJobSnapshot,
  type DelegateJobStore,
} from './delegateJobs.js'
import { createLogger } from './logger.js'
import {
  buildJobTerminalFromSnapshot,
  isHeartbeatSilentOutput,
  laneForCallback,
  parseParentEngine,
  resultRefFromSnapshot,
} from './jobTerminal.js'
import {
  isLegacyCronOriginLane,
  parseOriginWebchatSessionKey,
} from './cronOriginSession.js'
import { NOTIFY_CLAIM_FENCE, type NotifyClaimFence } from './engineNotifier.js'

const log = createLogger({ module: 'delegateNotifyDispatch' })

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

  let parentEngine =
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

  // Isolated cron Completer already delivered via onDeliver. No origin
  // session to ResumeInject; ack skipped_silent so retries do not stick.
  if (job.callback === 'cron-origin-inject') {
    const originKey =
      hooks.resolveCallbackOrigin?.(job) ?? job.callbackOriginSessionKey ?? job.parentSessionKey
    if (!originKey || !parseOriginWebchatSessionKey(originKey)) {
      persistNotifyIntent(store, job, {
        parentEngine: parentEngine ?? job.parentEngine,
        notifyLane: 'skipped_silent',
        notifyId,
      })
      store.patchCallbackState(job.id, 'skipped_silent', fenceOf(job))
      return { ok: true, lane: 'skipped_silent', notifyId }
    }
    // Flag-off Completer already injected with cron-origin-* ids. ACK the
    // pending row so a later Notifier generation cannot dlgcb-replay it.
    if (isLegacyCronOriginLane(job.notifyLane)) {
      const liveLegacy = store.snapshotOf(job.id) ?? job
      const claimed = store.claimNotifyDelivery(job.id, fenceOf(liveLegacy))
      if (!claimed.ok) {
        const latest = store.snapshotOf(job.id) ?? liveLegacy
        if (latest.callbackState === 'delivered') {
          return ackDelivered(store, latest, hooks, notifyId, 'resume-inject')
        }
        return { skipped: true, reason: 'lost_claim' }
      }
      const delivered = store.completeNotifyDelivery(job.id, claimed.token, fenceOf(liveLegacy))
      if (delivered) await hooks.onDelivered?.(store.snapshotOf(job.id) ?? liveLegacy)
      return { ok: true, lane: 'resume-inject', notifyId }
    }
  }

  const owned = isResumeInjectCallback(job.callback)
  // Origin session may not be loaded; ResumeInject (档 B) still works
  // without a live runner. Default cursor so JobTerminal can be built.
  if (!parentEngine && owned) parentEngine = 'cursor'

  if (!parentEngine) {
    persistNotifyIntent(store, job, {
      notifyLane: 'resume-inject',
      notifyId,
    })
    if (owned) {
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
  if (owned) {
    const claimed = store.claimNotifyDelivery(job.id, fenceOf(live))
    if (!claimed.ok) return { skipped: true, reason: 'lost_claim' }
    deliveryToken = claimed.token
    const token = claimed.token
    const fence: NotifyClaimFence = {
      isLive: () => store.isNotifyClaimLive(live.id, token),
      ackDelivered: () => {
        try {
          return store.completeNotifyDelivery(live.id, token, fenceOf(live))
        } catch {
          return false
        }
      },
      markAAttempted: () => {
        try {
          return store.markNotifyAAttempted(live.id, token, fenceOf(live))
        } catch {
          return false
        }
      },
      hasAAttempted: () => store.hasNotifyAAttempted(live.id),
      aAttemptedAt: () => store.snapshotOf(live.id)?.notifyAAttemptedAt ?? undefined,
    }
    Object.defineProperty(event, NOTIFY_CLAIM_FENCE, {
      value: fence,
      enumerable: false,
      configurable: true,
    })
  }

  let result: NotifyResult
  try {
    result = await notifier.notify(event)
  } catch (err) {
    // A write may already have landed. Never release a delivered receipt;
    // leave injecting so reclaim must CAS against delivered.
    if (owned && deliveryToken) {
      const latest = store.snapshotOf(job.id)
      if (latest?.callbackState !== 'delivered') {
        store.releaseNotifyClaim(job.id, deliveryToken, fenceOf(live))
      }
    }
    if (owned && store.shouldAbandonNotify(job.id)) {
      const latest = store.snapshotOf(job.id) ?? live
      store.abandonNotify(latest.id, fenceOf(latest))
      log.warn('delegate notify abandoned after retry budget', {
        jobId: latest.id,
        callback: latest.callback,
        notifyAttempt: latest.notifyAttempt,
        terminalCommittedAt: latest.terminalCommittedAt,
      })
      const lane = (latest.notifyLane as NotifyLane | undefined) ?? preferred
      return ackDelivered(store, store.snapshotOf(job.id) ?? latest, hooks, notifyId, lane)
    }
    throw err
  }
  if (result.ok) {
    if (result.lane !== preferred) {
      persistNotifyIntent(store, live, {
        parentEngine,
        notifyLane: result.lane,
        notifyId: result.notifyId,
      })
    }
    if (owned && deliveryToken) {
      let delivered = false
      try {
        delivered = store.completeNotifyDelivery(job.id, deliveryToken, fenceOf(live))
      } catch {
        delivered = store.snapshotOf(job.id)?.callbackState === 'delivered'
      }
      if (delivered) await hooks.onDelivered?.(store.snapshotOf(job.id) ?? live)
    }
    return result
  }

  if (owned && deliveryToken) {
    if (!result.hold) {
      store.releaseNotifyClaim(job.id, deliveryToken, fenceOf(live))
    }
  } else if (owned) {
    store.deferPendingNotify(job.id, fenceOf(live))
  }
  if (owned && !result.hold && store.shouldAbandonNotify(job.id)) {
    const latest = store.snapshotOf(job.id) ?? live
    store.abandonNotify(latest.id, fenceOf(latest))
    log.warn('delegate notify abandoned after retry budget', {
      jobId: latest.id,
      callback: latest.callback,
      notifyAttempt: latest.notifyAttempt,
      terminalCommittedAt: latest.terminalCommittedAt,
      failureClass: result.failureClass,
    })
    const lane = (latest.notifyLane as NotifyLane | undefined) ?? preferred
    return ackDelivered(store, store.snapshotOf(job.id) ?? latest, hooks, notifyId, lane)
  }
  return result
}

export async function retryPendingNotifies(
  store: DelegateJobStore,
  notifier: EngineNotifier,
  hooks: NotifyDispatchHooks = {},
  opts: { dueOnly?: boolean; callbacks?: readonly string[] } = {},
): Promise<{ scanned: number; delivered: number; failed: number; skipped: number }> {
  const summary = { scanned: 0, delivered: 0, failed: 0, skipped: 0 }
  const jobs = (opts.dueOnly ? store.listDueNotify() : store.listPendingNotify()).filter(
    (job) => !opts.callbacks || opts.callbacks.includes(job.callback),
  )
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
  opts: { callbacks?: readonly string[]; skipLegacyCron?: boolean } = {},
): number | undefined {
  let next: number | undefined
  for (const job of store.listPendingNotify()) {
    if (opts.callbacks && !opts.callbacks.includes(job.callback)) continue
    if (opts.skipLegacyCron && job.callback === 'cron-origin-inject' && isLegacyCronOriginLane(job.notifyLane)) {
      continue
    }
    const at =
      job.callbackState === 'injecting'
        ? (job.notifyClaimedUntil ?? now)
        : (job.notifyRetryAt ?? now)
    if (next === undefined || at < next) next = at
  }
  if (next === undefined) return undefined
  return Math.max(0, next - now)
}
