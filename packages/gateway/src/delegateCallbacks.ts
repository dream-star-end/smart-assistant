/**
 * Gateway delegate callbacks: send-to-agent / CCB local-agent callback delivery, delegate notify retry, orphaned stdout-wait adoption
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-473. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. DelegateCallbacksHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { clientSessionIsActive } from './routes/clientSessions.js'
import { isDelegateTerminalState } from '@openclaude/protocol'
import { appendServerAuthoredMessage } from '@openclaude/storage'
import { parseOriginWebchatSessionKey, type CronOriginFireResult } from './cronOriginSession.js'
import {
  buildSendToAgentCallbackText,
  callbackPayloadFromDurableJob,
  decideCallbackDispatchAfterPersist,
  sendToAgentCallbackClientMessageId,
  sendToAgentCallbackIdempotencyKey,
} from './sendToAgentCallback.js'
import {
  abandonCcbLocalAgentInject,
  ackCcbTaskNotificationDelivered,
  beginCcbLocalAgentInject,
  buildCcbLocalAgentCallbackText,
  ccbLocalAgentCallbackClientMessageId,
  ccbLocalAgentCallbackIdempotencyKey,
  completeCcbLocalAgentInject,
  evaluateCcbLocalAgentInjectLimit,
  failCcbLocalAgentInject,
  getCcbLocalAgentCallbackState,
  finalizeCcbLocalAgentPendingInjections,
  noteCcbLocalAgentFinalizeRoundExhausted,
  noteCcbTaskNotification,
  sessionHasInFlightTurn,
  type CcbLocalAgentNotification,
} from './ccbLocalAgentCallback.js'
import { runBoundedOriginInjectBackoff } from './originInjectBackoff.js'
import {
  persistSendToAgentIntent,
  recoverInterruptedSendToAgentIntents,
  removeSendToAgentIntent,
  type SendToAgentIntent,
} from './sendToAgentIntentStore.js'
import { postCronOriginInject, readV3CronOriginInjectConfig } from './v3CronOriginInject.js'
import type { DelegateJobSnapshot } from './delegateJobs.js'
import {
  isDelegateDurableEffective,
  isDelegateNotifierEffective,
  resolveDelegateCallbackOwner,
} from './delegateSmFlag.js'
import { dispatchJobTerminalNotify, retryPendingNotifies } from './delegateNotifyDispatch.js'
import { parseParentEngine } from './jobTerminal.js'
import { delegateCallbackMessageId, persistDelegateJobSnapshots } from './delegateCompleter.js'
import { getTurnDispatchState, normalizeDispatchUserId } from './turnDispatchInbox.js'
import type { Gateway } from './server.js'
import type { RunDelegateInput } from './delegatePolicy.js'

export interface DelegateCallbacksHost {
  _acquireSyntheticTurnBarrier: Gateway['_acquireSyntheticTurnBarrier']
  _activeSendToAgentCallbacks: Gateway['_activeSendToAgentCallbacks']
  _armNotifyRetryScheduler: Gateway['_armNotifyRetryScheduler']
  _delegateJobs: Gateway['_delegateJobs']
  _delegateReconcileReady: Gateway['_delegateReconcileReady']
  _deliverInterruptedSendToAgentIntent: Gateway['_deliverInterruptedSendToAgentIntent']
  _dispatchDelegateNotify: Gateway['_dispatchDelegateNotify']
  _ensureDurableSendToAgentCallback: Gateway['_ensureDurableSendToAgentCallback']
  _ensureEngineNotifier: Gateway['_ensureEngineNotifier']
  _isIdempotencyDuplicate: Gateway['_isIdempotencyDuplicate']
  _notifyDispatchHooks: Gateway['_notifyDispatchHooks']
  _resolveDelegateParentEngine: Gateway['_resolveDelegateParentEngine']
  _runtimeRecycleDrainUntil: Gateway['_runtimeRecycleDrainUntil']
  _sendToAgentCallbackTurnAlreadyQueued: Gateway['_sendToAgentCallbackTurnAlreadyQueued']
  _shuttingDown: Gateway['_shuttingDown']
  dispatchInbound: Gateway['dispatchInbound']
  injectCcbLocalAgentCallback: Gateway['injectCcbLocalAgentCallback']
  injectSendToAgentCallback: Gateway['injectSendToAgentCallback']
  log: Gateway['log']
  queueCcbLocalAgentInject: Gateway['queueCcbLocalAgentInject']
  sessions: Gateway['sessions']
  tryCcbLocalAgentCallbackDispatch: Gateway['tryCcbLocalAgentCallbackDispatch']
  trySendToAgentCallbackDispatch: Gateway['trySendToAgentCallbackDispatch']
}

export async function _dispatchDelegateNotify(
  this: DelegateCallbacksHost,
  job: DelegateJobSnapshot,
): Promise<void> {
  const store = this._delegateJobs
  const notifier = this._ensureEngineNotifier()
  if (!store || !notifier) return
  try {
    const result = await dispatchJobTerminalNotify(
      store,
      job,
      notifier,
      this._notifyDispatchHooks(),
    )
    if ('skipped' in result) return
    if (!result.ok) {
      this.log.warn('delegate notify failed', {
        jobId: job.id,
        failureClass: result.failureClass,
        degradedTo: result.degradedTo,
      })
    }
  } catch (err) {
    this.log.warn('delegate notify threw', { jobId: job.id }, err as Error)
  } finally {
    this._armNotifyRetryScheduler()
  }
}

/**
 * Turn-end adoption of `delegate_task` background jobs.
 *
 * `delegate_task` rows are created as callback `stdout-wait`: the parent is
 * expected to long-poll `/api/delegate/wait`. When the parent turn ends
 * first (Cursor MCP 60s ceiling, model chose not to wait, user interrupted),
 * nothing ever wakes the parent — the sub-task finishes into the void.
 * Flip those rows to origin-inject so the EngineNotifier ResumeInject path
 * (same one `send_to_agent callbackOnComplete` uses) opens a fresh parent
 * turn on terminal. Consumed results (`/api/delegate/wait` returned
 * done/failed) are already skipped_silent and never match.
 *
 * Only webchat dm parents (ResumeInject target) and only when the notifier
 * side channel is effective; otherwise the flip would strand a pending row.
 */
export function _adoptOrphanedStdoutWaitDelegates(
  this: DelegateCallbacksHost,
  parentSessionKey: string | undefined,
  meta: { userId?: string; turnStartedAt?: number },
): void {
  if (!parentSessionKey || !isDelegateNotifierEffective()) return
  const store = this._delegateJobs
  if (!store || !this._delegateReconcileReady) return
  if (!parseOriginWebchatSessionKey(parentSessionKey)) return
  let adopted: DelegateJobSnapshot[]
  try {
    adopted = store.adoptOrphanedStdoutWait(parentSessionKey, {
      callbackOriginUserId: meta.userId,
      parentEngine: this._resolveDelegateParentEngine(parentSessionKey),
      terminalCreatedAfter: meta.turnStartedAt,
    })
  } catch (err) {
    this.log.warn('delegate stdout-wait adoption failed', { parentSessionKey }, err as Error)
    return
  }
  if (adopted.length === 0) return
  this.log.info('delegate stdout-wait jobs adopted for origin-inject', {
    parentSessionKey,
    jobIds: adopted.map((j) => j.id),
    terminal: adopted.filter((j) => isDelegateTerminalState(j.state)).length,
  })
  for (const job of adopted) {
    if (!isDelegateTerminalState(job.state)) continue
    // Already terminal: commit() does not re-fire onTerminal, dispatch now.
    void this._dispatchDelegateNotify(job)
  }
}

export async function _retryDelegateNotifies(
  this: DelegateCallbacksHost,
  opts: { dueOnly?: boolean } = {},
): Promise<void> {
  const store = this._delegateJobs
  const notifier = this._ensureEngineNotifier()
  if (!store || !notifier) return
  try {
    const summary = await retryPendingNotifies(store, notifier, this._notifyDispatchHooks(), opts)
    if (summary.scanned > 0) this.log.info('delegate notify retry', summary)
  } catch (err) {
    this.log.warn('delegate notify retry threw', undefined, err as Error)
  }
}

export function _persistSendToAgentIntent(
  this: DelegateCallbacksHost,
  intent: SendToAgentIntent,
): Promise<void> {
  return persistSendToAgentIntent(intent)
}

export async function _deliverInterruptedSendToAgentIntent(
  this: DelegateCallbacksHost,
  intent: SendToAgentIntent,
): Promise<boolean> {
  const origin = parseOriginWebchatSessionKey(intent.originSessionKey)
  if (!origin) return true
  const userId = intent.userId || process.env.OC_USER_ID?.trim() || 'default'
  const result = await appendServerAuthoredMessage(origin.peerId, userId, {
    id: `sta-restart-${intent.jobId}`,
    role: 'system',
    text: `后台任务（${intent.agentId}：${intent.goal.slice(0, 120)}）在服务重启时未确认完成，请重新发起。`,
    ts: Date.now(),
    status: 'interrupted',
  })
  return result.applied || result.reason === 'already_exists' || result.reason === 'session_deleted'
}

export async function _persistInterruptedSendToAgentCallbacks(
  this: DelegateCallbacksHost,
): Promise<void> {
  const owner = resolveDelegateCallbackOwner()
  if (this._delegateJobs && !isDelegateDurableEffective()) {
    await persistDelegateJobSnapshots(this._delegateJobs)
  }
  this._activeSendToAgentCallbacks.clear()
  await recoverInterruptedSendToAgentIntents(
    (intent) => this._deliverInterruptedSendToAgentIntent(intent),
    process.env,
    {
      callbackOwner: owner,
      resolveJob: (jobId) => this._delegateJobs?.snapshotOf(jobId),
      ensureCallback: (job, intent) => this._ensureDurableSendToAgentCallback(job, intent),
    },
  )
}

export async function _ensureDurableSendToAgentCallback(
  this: DelegateCallbacksHost,
  job: DelegateJobSnapshot,
  intent: SendToAgentIntent,
): Promise<boolean> {
  if (isDelegateNotifierEffective() && this._delegateJobs) {
    const notifier = this._ensureEngineNotifier()
    if (!notifier) return false
    const result = await dispatchJobTerminalNotify(this._delegateJobs, job, notifier, {
      resolveParentEngine: (row) =>
        this._resolveDelegateParentEngine(
          row.callbackOriginSessionKey ?? intent.originSessionKey ?? row.parentSessionKey,
        ) ?? parseParentEngine(row.parentEngine),
      resolveGoal: () => intent.goal,
      resolveCallbackOrigin: (row) => row.callbackOriginSessionKey ?? intent.originSessionKey,
      onDelivered: async () => {
        this._activeSendToAgentCallbacks.delete(job.id)
        await removeSendToAgentIntent(job.id)
      },
    })
    return !('skipped' in result) && result.ok === true
  }
  if (job.kind === 'delegate' && job.callback === 'origin-inject' && this._delegateJobs) {
    // Dynamic MCP handoff can race completion with the intent-persist catch-up.
    // Use the same claim and callback identity regardless of callbackOwner.
    const store = this._delegateJobs
    const live = store.snapshotOf(job.id)
    if (!live) return false
    if (live.callbackState === 'delivered') return true
    const fence = live.claimToken
      ? { claimToken: live.claimToken, fencingEpoch: live.fencingEpoch }
      : undefined
    const claim = store.claimNotifyDelivery(job.id, fence)
    if (!claim.ok) return false
    const payload = callbackPayloadFromDurableJob(claim.snapshot)
    try {
      const result = await this.injectSendToAgentCallback({
        parentSessionKey: intent.originSessionKey,
        jobId: intent.jobId,
        agentId: intent.agentId,
        goal: intent.goal,
        userId: intent.userId,
        output: payload.output,
        error: payload.error,
        clientMessageId: delegateCallbackMessageId(intent.jobId, claim.snapshot.callbackEpoch || 1),
      })
      if (result.kind !== 'injected') return false
      const delivered = store.completeNotifyDelivery(job.id, claim.token, fence)
      if (delivered) {
        this._activeSendToAgentCallbacks?.delete(job.id)
        await removeSendToAgentIntent(job.id)
      }
      return delivered
    } finally {
      store.releaseNotifyClaim(job.id, claim.token, fence)
      this._armNotifyRetryScheduler()
    }
  }
  const epoch = job.callbackEpoch || 1
  const payload = callbackPayloadFromDurableJob(job)
  const result = await this.injectSendToAgentCallback({
    parentSessionKey: intent.originSessionKey,
    jobId: intent.jobId,
    agentId: intent.agentId,
    goal: intent.goal,
    userId: intent.userId,
    output: payload.output,
    error: payload.error,
    clientMessageId: delegateCallbackMessageId(intent.jobId, epoch),
  })
  if (result.kind === 'injected') {
    const fence = job.claimToken
      ? { claimToken: job.claimToken, fencingEpoch: job.fencingEpoch }
      : undefined
    return this._delegateJobs?.patchCallbackState(intent.jobId, 'delivered', fence) === true
  }
  return false
}

export function handleCcbLocalAgentNotification(
  this: DelegateCallbacksHost,
  session: {
    sessionKey: string
    userId?: string
    _activeTurnCount?: number
    _activeClientTurnCount?: number
  },
  payload: CcbLocalAgentNotification,
): void {
  const taskId = (payload.taskId || '').trim()
  if (!taskId) return
  const decision = noteCcbTaskNotification({
    sessionKey: session.sessionKey,
    notification: { ...payload, taskId },
    hasInFlightTurn: sessionHasInFlightTurn(session),
    userId: session.userId,
  })
  this.log.info('ccb local-agent callback noted', {
    sessionKey: session.sessionKey,
    taskId,
    decision,
  })
  if (decision !== 'inject') return
  this.queueCcbLocalAgentInject(session.sessionKey, payload, session.userId)
}

export function handleCcbLocalAgentDelivered(
  this: DelegateCallbacksHost,
  sessionKey: string,
  taskId: string,
): void {
  const id = (taskId || '').trim()
  if (!id) return
  const decision = ackCcbTaskNotificationDelivered({ sessionKey, taskId: id })
  this.log.info('ccb local-agent callback acked', { sessionKey, taskId: id, decision })
}

export function flushCcbLocalAgentPendingOnFinalize(
  this: DelegateCallbacksHost,
  session: { sessionKey: string; userId?: string },
): void {
  const { inject, dropped } = finalizeCcbLocalAgentPendingInjections(session.sessionKey)
  for (const item of dropped) {
    this.log.info('ccb local-agent callback dropped', {
      sessionKey: item.sessionKey,
      taskId: item.taskId,
      toolUseId: item.toolUseId,
      reason: item.reason,
    })
  }
  for (const item of inject) {
    this.queueCcbLocalAgentInject(session.sessionKey, item.payload, item.userId ?? session.userId)
  }
}

export function queueCcbLocalAgentInject(
  this: DelegateCallbacksHost,
  sessionKey: string,
  payload: CcbLocalAgentNotification,
  userId?: string,
): void {
  void this.injectCcbLocalAgentCallback({
    sessionKey,
    userId,
    taskId: payload.taskId,
    status: payload.status,
    outputFile: payload.outputFile,
    summary: payload.summary,
  }).catch((err) => {
    this.log.warn('ccb local-agent callback inject failed', {
      sessionKey,
      taskId: payload.taskId,
      err: String(err),
    })
  })
}

export type InjectCcbLocalAgentCallbackArgs = {
    sessionKey: string
    userId?: string
    taskId: string
    status?: string
    outputFile?: string
    summary?: string
  }

/**
 * Origin-inject a CCB local-agent completion after the parent turn is
 * idle and no mid-turn delivered ack arrived. Retries with the same
 * bounded backoff as send_to_agent. Parent CCB process already dead
 * is not covered.
 */
export async function injectCcbLocalAgentCallback(
  this: DelegateCallbacksHost,
  args: InjectCcbLocalAgentCallbackArgs,
): Promise<CronOriginFireResult> {
  const origin = parseOriginWebchatSessionKey(args.sessionKey)
  if (!origin) {
    this.log.warn('ccb local-agent callback skipped: session is not webchat dm', {
      taskId: args.taskId,
      sessionKey: args.sessionKey,
    })
    abandonCcbLocalAgentInject(args.sessionKey, args.taskId)
    return { kind: 'fallback' }
  }
  if (!beginCcbLocalAgentInject(args.sessionKey, args.taskId)) {
    this.log.info('ccb local-agent inject skipped: not pending', {
      sessionKey: args.sessionKey,
      taskId: args.taskId,
      state: getCcbLocalAgentCallbackState(args.sessionKey, args.taskId),
    })
    return { kind: 'fallback' }
  }
  const preLimit = evaluateCcbLocalAgentInjectLimit(args.sessionKey, args.taskId)
  if (preLimit) {
    this.log.warn('ccb local-agent inject abandoned after finalize-round or TTL limit', {
      taskId: args.taskId,
      sessionKey: args.sessionKey,
      reason: preLimit,
    })
    return { kind: 'fallback' }
  }
  const text = buildCcbLocalAgentCallbackText({
    taskId: args.taskId,
    status: args.status,
    outputFile: args.outputFile,
    summary: args.summary,
  })
  const clientMessageId = ccbLocalAgentCallbackClientMessageId(args.taskId)
  let budgetExhausted = false
  const result = await runBoundedOriginInjectBackoff({
    isShuttingDown: () => this._shuttingDown,
    shouldAbort: () => getCcbLocalAgentCallbackState(args.sessionKey, args.taskId) === 'delivered',
    tryOnce: async () => {
      if (getCcbLocalAgentCallbackState(args.sessionKey, args.taskId) === 'delivered') {
        return { kind: 'fallback' }
      }
      const barrier = await this._acquireSyntheticTurnBarrier(origin.sessionKey)
      let queued = false
      try {
        const parent = this.sessions.getByKey(origin.sessionKey)
        if (sessionHasInFlightTurn(parent)) {
          return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_BUSY' }
        }
        const userId =
          (typeof args.userId === 'string' && args.userId.trim()) ||
          parent?.userId ||
          process.env.OC_USER_ID?.trim() ||
          'default'
        return await this.tryCcbLocalAgentCallbackDispatch({
          origin,
          userId,
          text,
          clientMessageId,
          taskId: args.taskId,
          sessionKey: origin.sessionKey,
          barrierOwner: barrier.owner,
          onQueued: () => {
            queued = true
            barrier.release()
          },
        })
      } finally {
        if (!queued) barrier.release()
      }
    },
    onBudgetExhausted: () => {
      budgetExhausted = true
      this.log.warn('ccb local-agent callback retry budget exhausted', {
        taskId: args.taskId,
        sessionKey: args.sessionKey,
      })
    },
  })
  if (result.kind === 'injected') {
    completeCcbLocalAgentInject(args.sessionKey, args.taskId)
  } else if (budgetExhausted) {
    failCcbLocalAgentInject(args.sessionKey, args.taskId)
    const reason = noteCcbLocalAgentFinalizeRoundExhausted(args.sessionKey, args.taskId)
    if (reason) {
      this.log.warn('ccb local-agent inject abandoned after finalize-round or TTL limit', {
        taskId: args.taskId,
        sessionKey: args.sessionKey,
        reason,
      })
    }
  } else if (result.kind === 'fallback' || result.kind === 'terminal_failure') {
    abandonCcbLocalAgentInject(args.sessionKey, args.taskId)
  } else {
    failCcbLocalAgentInject(args.sessionKey, args.taskId)
  }
  return result
}

export async function tryCcbLocalAgentCallbackDispatch(
  this: DelegateCallbacksHost,
  args: {
    origin: {
      sessionKey: string
      agentId: string
      channel: 'webchat'
      peerKind: 'dm'
      peerId: string
    }
    userId: string
    text: string
    clientMessageId: string
    taskId: string
    sessionKey: string
    barrierOwner?: string
    onQueued?: () => void
  },
): Promise<CronOriginFireResult> {
  if (this._shuttingDown || this._runtimeRecycleDrainUntil > Date.now()) {
    return { kind: 'retryable_failure', code: 'NO_TRANSPORT' }
  }
  try {
    const existing = await clientSessionIsActive(args.origin.peerId, args.userId)
    if (existing) {
      const persisted = await appendServerAuthoredMessage(args.origin.peerId, args.userId, {
        id: args.clientMessageId,
        role: 'user',
        text: args.text,
        ts: Date.now(),
      })
      if (!persisted.applied) {
        if (persisted.reason === 'already_exists') {
          // same task retry — continue to dispatch
        } else if (
          persisted.reason === 'session_deleted' ||
          persisted.reason === 'malformed' ||
          persisted.reason === 'oversized'
        ) {
          return { kind: 'fallback' }
        } else {
          return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_PERSIST_FAILED' }
        }
      }
    } else if (!this.sessions.getByKey(args.origin.sessionKey)) {
      this.log.warn('ccb local-agent callback skipped: parent session gone', {
        taskId: args.taskId,
      })
      return { kind: 'fallback' }
    }
  } catch (err) {
    this.log.warn('ccb local-agent callback persist failed', { taskId: args.taskId }, err as Error)
    return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_PERSIST_FAILED' }
  }
  try {
    let wasQueued = false
    await this.dispatchInbound({
      type: 'inbound.message',
      channel: args.origin.channel,
      peer: { id: args.origin.peerId, kind: args.origin.peerKind },
      agentId: args.origin.agentId,
      content: { text: args.text },
      ts: Date.now(),
      idempotencyKey: ccbLocalAgentCallbackIdempotencyKey(args.sessionKey, args.taskId),
      clientMessageId: args.clientMessageId,
      _userId: args.userId,
      _skipRateLimit: true,
      _syntheticBarrierOwner: args.barrierOwner,
      _onSyntheticQueued: () => {
        wasQueued = true
        args.onQueued?.()
      },
    } as any)
    if (!wasQueued) return { kind: 'retryable_failure', code: 'NO_TRANSPORT' }
  } catch (err) {
    this.log.warn('ccb local-agent callback dispatch failed', { taskId: args.taskId }, err as Error)
    return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_DISPATCH_FAILED' }
  }
  return { kind: 'injected' }
}

export function _queueSendToAgentCallback(
  this: DelegateCallbacksHost,
  runInput: RunDelegateInput,
  args: { jobId: string; agentId: string; goal: string; output?: string; error?: string },
): void {
  const snapshot = this._delegateJobs?.snapshotOf(args.jobId)
  if (snapshot?.kind === 'delegate' && snapshot.callback === 'origin-inject' && snapshot.callbackOriginSessionKey) {
    if (isDelegateNotifierEffective()) return
    const active = this._activeSendToAgentCallbacks?.get(args.jobId)
    void this._ensureDurableSendToAgentCallback(snapshot, {
      v: 1,
      jobId: args.jobId,
      originSessionKey: snapshot.callbackOriginSessionKey,
      userId: snapshot.callbackOriginUserId ?? active?.userId,
      agentId: args.agentId,
      goal: active?.goal ?? args.goal,
      createdAt: Date.now(),
    }).catch((err) => {
      this.log.warn('delegate handoff callback failed', { jobId: args.jobId }, err as Error)
    })
    return
  }
  if (runInput.callbackOnComplete !== 'origin-inject') return
  // Stage 2: EngineNotifier owns origin-inject (and cron-origin-inject)
  // delivery when the flag is on. Completer must not also inject.
  if (isDelegateNotifierEffective()) return
  const owner = resolveDelegateCallbackOwner()
  const snap = this._delegateJobs?.snapshotOf(args.jobId)
  const epoch = snap?.callbackEpoch || 1
  const clientMessageId = owner === 'job' ? delegateCallbackMessageId(args.jobId, epoch) : undefined
  const fence =
    runInput.claimToken && runInput.fencingEpoch !== undefined
      ? { claimToken: runInput.claimToken, fencingEpoch: runInput.fencingEpoch }
      : undefined
  if (owner === 'job') {
    const injecting = this._delegateJobs?.patchCallbackState(args.jobId, 'injecting', fence)
    if (!injecting) return
  }
  void this.injectSendToAgentCallback({
    parentSessionKey: runInput.callbackOriginSessionKey ?? runInput.parentSessionKey,
    jobId: args.jobId,
    agentId: args.agentId,
    goal: args.goal,
    output: args.output,
    error: args.error,
    userId:
      runInput.callbackOriginUserId ??
      this.sessions.getByKey(runInput.parentSessionKey || '')?.userId,
    clientMessageId,
  })
    .then(async (result) => {
      if (result.kind !== 'injected') {
        if (owner === 'job') {
          this._delegateJobs?.patchCallbackState(args.jobId, 'pending', fence)
        }
        return
      }
      if (owner === 'job') {
        const delivered = this._delegateJobs?.patchCallbackState(args.jobId, 'delivered', fence)
        if (!delivered) {
          this._delegateJobs?.patchCallbackState(args.jobId, 'pending', fence)
          return
        }
      }
      this._activeSendToAgentCallbacks.delete(args.jobId)
      await removeSendToAgentIntent(args.jobId)
    })
    .catch((err) => {
      this.log.warn('send_to_agent callback inject failed', {
        jobId: args.jobId,
        err: String(err),
      })
    })
}

export type InjectSendToAgentCallbackArgs = {
    parentSessionKey?: string
    jobId: string
    agentId: string
    goal: string
    output?: string
    error?: string
    userId?: string
    clientMessageId?: string
    /** Stage 2 notifier: one try, BUSY returns to pending instead of 12-then-fallback. */
    once?: boolean
  }

/**
 * send_to_agent 完成后注入父 webchat：等父 turn 不在飞，再写 user 行并
 * dispatchInbound 新开父 turn。不走 lastActiveChannel 的 📨 WS 旁路。
 */
export async function injectSendToAgentCallback(
  this: DelegateCallbacksHost,
  args: InjectSendToAgentCallbackArgs,
): Promise<CronOriginFireResult> {
  const origin = parseOriginWebchatSessionKey(args.parentSessionKey || '')
  if (!origin) {
    this.log.warn('send_to_agent callback skipped: parent is not webchat dm', {
      jobId: args.jobId,
      parentSessionKey: args.parentSessionKey,
    })
    return { kind: 'fallback' }
  }
  const text = buildSendToAgentCallbackText({
    agentId: args.agentId,
    goal: args.goal,
    output: args.output,
    error: args.error,
  })
  const clientMessageId = args.clientMessageId || sendToAgentCallbackClientMessageId(args.jobId)
  const tryOnce = async (): Promise<CronOriginFireResult> => {
    // Billing parity with cron-origin-inject (2026-09-05): when a master is
    // reachable the callback turn MUST be admitted by master (admitUserTurn →
    // turn_dispatches row + billingRequestId) and come back down as a durable
    // frame. The local dispatchInbound path below builds a frame with no
    // requestId, so cursorAdapter.finish() never emits external_billing /
    // durable billing — the parent's callback turn ran for free and
    // turn_traces had no row (master logged "first-visible record failed").
    // Only the legacy no-master (standalone) deployment keeps the local path.
    const masterCfg = readV3CronOriginInjectConfig()
    if (masterCfg) {
      const posted = await postCronOriginInject(
        {
          sessionId: origin.peerId,
          text,
          clientMessageId,
          agentId: origin.agentId,
        },
        { config: masterCfg },
      )
      if (posted.kind === 'injected') return { kind: 'injected' }
      if (posted.kind === 'gone') return { kind: 'fallback' }
      // Master says another turn is open → same busy contract as the local
      // path so the notifier parks the job as pending instead of degrading.
      if (posted.kind === 'in_flight') {
        return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_BUSY' }
      }
      return { kind: 'retryable_failure', code: posted.code }
    }
    const barrier = await this._acquireSyntheticTurnBarrier(origin.sessionKey)
    let queued = false
    try {
      const parent = this.sessions.getByKey(origin.sessionKey)
      if ((parent?._activeTurnCount ?? 0) > 0 || (parent?._activeClientTurnCount ?? 0) > 0) {
        return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_BUSY' }
      }
      const userId =
        (typeof args.userId === 'string' && args.userId.trim()) ||
        parent?.userId ||
        process.env.OC_USER_ID?.trim() ||
        'default'
      return await this.trySendToAgentCallbackDispatch({
        origin,
        userId,
        text,
        clientMessageId,
        jobId: args.jobId,
        barrierOwner: barrier.owner,
        onQueued: () => {
          queued = true
          barrier.release()
        },
      })
    } finally {
      if (!queued) barrier.release()
    }
  }
  if (args.once) return tryOnce()
  return runBoundedOriginInjectBackoff({
    isShuttingDown: () => this._shuttingDown,
    tryOnce,
    onBudgetExhausted: () => {
      this.log.warn('send_to_agent callback retry budget exhausted', { jobId: args.jobId })
    },
  })
}

export async function trySendToAgentCallbackDispatch(
  this: DelegateCallbacksHost,
  args: {
    origin: {
      sessionKey: string
      agentId: string
      channel: 'webchat'
      peerKind: 'dm'
      peerId: string
    }
    userId: string
    text: string
    clientMessageId: string
    jobId: string
    barrierOwner?: string
    onQueued?: () => void
  },
): Promise<CronOriginFireResult> {
  if (this._shuttingDown || this._runtimeRecycleDrainUntil > Date.now()) {
    return { kind: 'retryable_failure', code: 'NO_TRANSPORT' }
  }
  try {
    const existing = await clientSessionIsActive(args.origin.peerId, args.userId)
    if (existing) {
      const persisted = await appendServerAuthoredMessage(args.origin.peerId, args.userId, {
        id: args.clientMessageId,
        role: 'user',
        text: args.text,
        ts: Date.now(),
      })
      if (!persisted.applied) {
        if (persisted.reason === 'already_exists') {
          const turnAlreadyQueued = await this._sendToAgentCallbackTurnAlreadyQueued({
            jobId: args.jobId,
            userId: args.userId,
            sessionKey: args.origin.sessionKey,
            sessionId: args.origin.peerId,
            clientMessageId: args.clientMessageId,
          })
          const decision = decideCallbackDispatchAfterPersist({
            persistApplied: false,
            persistReason: persisted.reason,
            turnAlreadyQueued,
          })
          if (decision === 'ack_injected') {
            args.onQueued?.()
            return { kind: 'injected' }
          }
          // Message persisted, turn not queued yet — continue dispatchInbound.
        } else if (
          persisted.reason === 'session_deleted' ||
          persisted.reason === 'malformed' ||
          persisted.reason === 'oversized'
        ) {
          return { kind: 'fallback' }
        } else {
          return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_PERSIST_FAILED' }
        }
      }
    } else if (!this.sessions.getByKey(args.origin.sessionKey)) {
      this.log.warn('send_to_agent callback skipped: parent session gone', {
        jobId: args.jobId,
      })
      return { kind: 'fallback' }
    }
  } catch (err) {
    this.log.warn('send_to_agent callback persist failed', { jobId: args.jobId }, err as Error)
    return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_PERSIST_FAILED' }
  }
  try {
    let wasQueued = false
    await this.dispatchInbound({
      type: 'inbound.message',
      channel: args.origin.channel,
      peer: { id: args.origin.peerId, kind: args.origin.peerKind },
      agentId: args.origin.agentId,
      content: { text: args.text },
      ts: Date.now(),
      idempotencyKey: sendToAgentCallbackIdempotencyKey(args.jobId),
      clientMessageId: args.clientMessageId,
      _userId: args.userId,
      _skipRateLimit: true,
      _syntheticBarrierOwner: args.barrierOwner,
      _onSyntheticQueued: () => {
        wasQueued = true
        args.onQueued?.()
      },
    } as any)
    if (!wasQueued) return { kind: 'retryable_failure', code: 'NO_TRANSPORT' }
  } catch (err) {
    this.log.warn('send_to_agent callback dispatch failed', { jobId: args.jobId }, err as Error)
    return { kind: 'retryable_failure', code: 'ORIGIN_SESSION_DISPATCH_FAILED' }
  }
  return { kind: 'injected' }
}

export type SendToAgentCallbackTurnAlreadyQueuedArgs = {
    jobId: string
    userId: string
    sessionKey: string
    sessionId: string
    clientMessageId: string
  }

export async function _sendToAgentCallbackTurnAlreadyQueued(
  this: DelegateCallbacksHost,
  args: SendToAgentCallbackTurnAlreadyQueuedArgs,
): Promise<boolean> {
  if (this._isIdempotencyDuplicate(sendToAgentCallbackIdempotencyKey(args.jobId))) return true
  const live = this.sessions.getByKey(args.sessionKey) as
    | { _currentDispatch?: { clientMessageId?: string } }
    | undefined
  if (live?._currentDispatch?.clientMessageId === args.clientMessageId) return true
  try {
    const row = await getTurnDispatchState({
      userId: normalizeDispatchUserId(args.userId),
      sessionId: args.sessionId,
      clientMessageId: args.clientMessageId,
    })
    if (!row) return false
    return row.state !== 'rejected'
  } catch {
    return false
  }
}
