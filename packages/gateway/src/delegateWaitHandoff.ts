/** Preserve existing callback delivery without creating new billable parent turns. */
import type { IncomingMessage } from 'node:http'
import { parseOriginWebchatSessionKey } from './cronOriginSession.js'
import { DELEGATE_CONTEXT_HEADER, verifyDelegateContextToken } from './delegateContext.js'
import type { DelegateRuntimeHost } from './delegateRuntime.js'
import type { DelegateCallbacksHost } from './delegateCallbacks.js'
import type { DelegateJobStore } from './delegateJobs.js'

type HandoffRetryHost = Pick<DelegateCallbacksHost,
  '_delegateJobs' | '_activeSendToAgentCallbacks' | '_ensureDurableSendToAgentCallback' | 'log'>

/** Reuse the gateway notify timer for the legacy delivery path's handed-off subset. */
export function handedOffDelegateRetryDelay(store: DelegateJobStore, now = Date.now()): number | undefined {
  const jobs = store.listPendingNotify().filter((job) => job.kind === 'delegate' && job.callback === 'origin-inject' && job.callbackOriginSessionKey)
  if (jobs.length === 0) return undefined
  return Math.max(0, Math.min(...jobs.map((job) => job.callbackState === 'injecting'
    ? job.notifyClaimedUntil ?? now
    : job.notifyRetryAt ?? now)) - now)
}

export async function retryHandedOffDelegateNotifies(host: HandoffRetryHost): Promise<void> {
  const jobs = host._delegateJobs?.listDueNotify() ?? []
  for (const job of jobs) {
    if (job.kind !== 'delegate' || job.callback !== 'origin-inject' || !job.callbackOriginSessionKey) continue
    const active = host._activeSendToAgentCallbacks?.get(job.id)
    try {
      await host._ensureDurableSendToAgentCallback(job, {
        v: 1,
        jobId: job.id,
        originSessionKey: job.callbackOriginSessionKey,
        userId: job.callbackOriginUserId,
        agentId: job.agentId,
        goal: active?.goal ?? '',
        createdAt: job.createdAt ?? Date.now(),
      })
    } catch (err) {
      host.log.warn('delegate handoff callback retry failed', { jobId: job.id }, err as Error)
    }
  }
}

export async function handoffDelegateWait(
  host: DelegateRuntimeHost,
  req: IncomingMessage,
  jobId: string,
  _goal: unknown,
): Promise<boolean> {
  const raw = req.headers[DELEGATE_CONTEXT_HEADER]
  const token = Array.isArray(raw) ? raw[0] : raw
  const caller = typeof token === 'string' ? verifyDelegateContextToken(token) : null
  const origin = caller && parseOriginWebchatSessionKey(caller.sessionKey)
  const store = host._delegateJobs
  const job = store?.snapshotOf(jobId)
  if (!caller || !origin || caller.agentId !== origin.agentId || !store || !host._delegateReconcileReady) return false
  if (!job || job.kind !== 'delegate' || job.parentSessionKey !== caller.sessionKey) return false
  // A job-level callback starts a normal paid parent turn. Independent fan-out
  // completions cannot preserve the original tool's aggregate delivery boundary,
  // so new stdout jobs must retain the existing CLI aggregate continuation.
  // Old clients may still request handoff; only already-owned callbacks qualify.
  return job.callback === 'origin-inject'
    && job.callbackOriginSessionKey === caller.sessionKey
    && job.callbackState !== 'skipped_silent'
}
