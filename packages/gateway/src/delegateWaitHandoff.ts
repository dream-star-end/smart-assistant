/** Transfer a single MCP wait to the existing durable callback delivery lane. */
import type { IncomingMessage } from 'node:http'
import { isDelegateTerminalState } from '@openclaude/protocol'
import { parseOriginWebchatSessionKey } from './cronOriginSession.js'
import { DELEGATE_CONTEXT_HEADER, verifyDelegateContextToken } from './delegateContext.js'
import { removeSendToAgentIntent, type SendToAgentIntent } from './sendToAgentIntentStore.js'
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
  goal: unknown,
): Promise<boolean> {
  const raw = req.headers[DELEGATE_CONTEXT_HEADER]
  const token = Array.isArray(raw) ? raw[0] : raw
  const caller = typeof token === 'string' ? verifyDelegateContextToken(token) : null
  const origin = caller && parseOriginWebchatSessionKey(caller.sessionKey)
  const store = host._delegateJobs
  const job = store?.snapshotOf(jobId)
  if (!caller || !origin || caller.agentId !== origin.agentId || !store || !host._delegateReconcileReady) return false
  if (!job || job.kind !== 'delegate' || job.parentSessionKey !== caller.sessionKey) return false
  if (job.callback === 'origin-inject' && job.callbackOriginSessionKey === caller.sessionKey) {
    return job.callbackState !== 'skipped_silent'
  }
  if (job.callback !== 'stdout-wait' || job.callbackState !== 'none') return false

  const intent: SendToAgentIntent = {
    v: 1,
    jobId,
    originSessionKey: caller.sessionKey,
    userId: host.sessions.getByKey(caller.sessionKey)?.userId,
    agentId: job.agentId,
    goal: typeof goal === 'string' ? goal.slice(0, 4_000) : '',
    createdAt: Date.now(),
  }
  try {
    // The intent is a restart fallback even when the Notifier flag is off.
    await host._persistSendToAgentIntent(intent)
  } catch (err) {
    host.log.warn('delegate wait handoff persistence failed', { jobId }, err as Error)
    return false
  }
  const adopted = store.handoffStdoutWait(jobId, caller.sessionKey, {
    callbackOriginUserId: intent.userId,
    parentEngine: host._resolveDelegateParentEngine(caller.sessionKey),
  })
  if (!adopted) {
    // A concurrent handoff may own this same intent now. Only a terminal
    // stdout consumer makes it safe to remove our unused persistence record.
    const latest = store.snapshotOf(jobId)
    if (latest?.callback === 'stdout-wait' && latest.callbackState === 'skipped_silent') {
      await removeSendToAgentIntent(jobId).catch(() => {})
    }
    return false
  }
  if (adopted.callbackState === 'delivered' || adopted.callbackState === 'abandoned') {
    await removeSendToAgentIntent(jobId).catch(() => {})
    return true
  }
  ;(host._activeSendToAgentCallbacks ??= new Map()).set(jobId, {
    originSessionKey: intent.originSessionKey,
    userId: intent.userId,
    agentId: intent.agentId,
    goal: intent.goal,
  })
  // Completion can win while the intent is being persisted. It previously
  // saw stdout-wait, so dispatch the newly owned terminal explicitly.
  if (isDelegateTerminalState(adopted.state)) {
    void host._ensureDurableSendToAgentCallback(adopted, intent).catch((err) => {
      host.log.warn('delegate wait handoff callback failed', { jobId }, err as Error)
    })
  }
  return true
}
