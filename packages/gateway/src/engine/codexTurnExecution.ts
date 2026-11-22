/**
 * Codex app-server turn execution, thread attach/resume self-heal, narrow-path retry,
 * and per-attempt state/usage lifecycle.
 *
 * Extracted from CodexAppServerRunner (codexAppServerRunner.ts) — OCV5-830.
 * The runner keeps non-async one-line forwarders calling these implementations with
 * the instance as `this`.
 */
import {
  AUTOMATIC_TURN_RETRY_MAX,
  type ServiceTier,
  turnErrorSemantics,
} from '@openclaude/protocol'
import type { ClassifiedErrorCode } from '../errorClassify.js'
import {
  buildCodexThreadPolicyParams,
  buildCodexTurnPolicyParams,
  ensureCodexTurnServiceTierSupported,
} from './codexAdvisorReadOnly.js'
import {
  _EMPTY_TOKEN_BREAKDOWN,
  _codexUsageToAnthropicShape,
  _subtractTokenBreakdown,
  isMissingRolloutError,
  type CodexTokenBreakdown,
  type JsonRpcCallError,
} from './codexAppServerProtocol.js'
import { log, type CodexAppServerRunner } from './codexAppServerRunner.js'
import type { AutomaticRetryState, CollabAgentPolicy } from './engineAdapter.js'
import { rememberImageStderr } from './imageGenerationFailure.js'

const NATIVE_COMPACTION_TIMEOUT_MS = 15 * 60_000

export interface CodexTurnExecutionHost {
  opts: CodexAppServerRunner['opts']
  proc: CodexAppServerRunner['proc']
  threadId: CodexAppServerRunner['threadId']
  effortLevel: CodexAppServerRunner['effortLevel']
  attached: CodexAppServerRunner['attached']
  initialized: CodexAppServerRunner['initialized']
  initializedPayload: CodexAppServerRunner['initializedPayload']
  shuttingDown: CodexAppServerRunner['shuttingDown']
  staleProcGeneration: CodexAppServerRunner['staleProcGeneration']
  pendingStartInterrupt: CodexAppServerRunner['pendingStartInterrupt']
  activeTurnId: CodexAppServerRunner['activeTurnId']
  activeRequestId: CodexAppServerRunner['activeRequestId']
  forcedShutdownResultEmitted: CodexAppServerRunner['forcedShutdownResultEmitted']
  currentTurnCompleter: CodexAppServerRunner['currentTurnCompleter']
  currentAssistantBuf: CodexAppServerRunner['currentAssistantBuf']
  hasCurrentStructuredOutput: CodexAppServerRunner['hasCurrentStructuredOutput']
  currentStructuredOutput: CodexAppServerRunner['currentStructuredOutput']
  currentPlanDraft: CodexAppServerRunner['currentPlanDraft']
  conversationMode: CodexAppServerRunner['conversationMode']
  priorTurnTotal: CodexAppServerRunner['priorTurnTotal']
  activeTurnTotal: CodexAppServerRunner['activeTurnTotal']
  currentTurnUsage: CodexAppServerRunner['currentTurnUsage']
  attemptHadObservableOutput: CodexAppServerRunner['attemptHadObservableOutput']
  attemptHadToolOrPermission: CodexAppServerRunner['attemptHadToolOrPermission']
  attemptEmittedTerminal: CodexAppServerRunner['attemptEmittedTerminal']
  pendingRetryAbort: CodexAppServerRunner['pendingRetryAbort']
  retryBackoffProcGone: CodexAppServerRunner['retryBackoffProcGone']
  inflightItemHandlers: CodexAppServerRunner['inflightItemHandlers']
  emittedToolUseIds: CodexAppServerRunner['emittedToolUseIds']
  reasoningItemState: CodexAppServerRunner['reasoningItemState']
  collabReceiverToSpawnId: CodexAppServerRunner['collabReceiverToSpawnId']
  collabSpawnReceivers: CodexAppServerRunner['collabSpawnReceivers']
  completedCollabSpawnResults: CodexAppServerRunner['completedCollabSpawnResults']
  currentCollabAgentPolicy: CodexAppServerRunner['currentCollabAgentPolicy']
  pendingUserInputs: CodexAppServerRunner['pendingUserInputs']
  queue: CodexAppServerRunner['queue']
  cachedOverrides: CodexAppServerRunner['cachedOverrides']
  spawnedProviderSignature: CodexAppServerRunner['spawnedProviderSignature']
  remoteInstructions: CodexAppServerRunner['remoteInstructions']
  _boundRepoBinding: CodexAppServerRunner['_boundRepoBinding']
  _serviceTier: CodexAppServerRunner['_serviceTier']
  advisorReadOnly: CodexAppServerRunner['advisorReadOnly']
  spawnedAdvisorReadOnly: CodexAppServerRunner['spawnedAdvisorReadOnly']
  advisorReadOnlyConfig: CodexAppServerRunner['advisorReadOnlyConfig']
  nativeContext: CodexAppServerRunner['nativeContext']
  outputDrainPromise: CodexAppServerRunner['outputDrainPromise']
  recycleInflight: CodexAppServerRunner['recycleInflight']
  pendingConsultRespawn: CodexAppServerRunner['pendingConsultRespawn']
  syncedPlatformGoalSignature: CodexAppServerRunner['syncedPlatformGoalSignature']
  syncedPlatformGoal: CodexAppServerRunner['syncedPlatformGoal']
  _preheatPromise: CodexAppServerRunner['_preheatPromise']
  _preheatGeneration: CodexAppServerRunner['_preheatGeneration']
  _unannouncedPreheatThread: CodexAppServerRunner['_unannouncedPreheatThread']
  _preheatedSignature: CodexAppServerRunner['_preheatedSignature']

  on: CodexAppServerRunner['on']
  off: CodexAppServerRunner['off']
  emit: CodexAppServerRunner['emit']
  shutdown: CodexAppServerRunner['shutdown']
  interrupt: CodexAppServerRunner['interrupt']
  ensureSpawned: CodexAppServerRunner['ensureSpawned']
  sendRequest: CodexAppServerRunner['sendRequest']
  syncPlatformGoal: CodexAppServerRunner['syncPlatformGoal']
  refreshDelegateContext: CodexAppServerRunner['refreshDelegateContext']
  settleAllPendingUserInputs: CodexAppServerRunner['settleAllPendingUserInputs']
  resetCallUsageAttribution: CodexAppServerRunner['resetCallUsageAttribution']
  codexRouteSignature: CodexAppServerRunner['codexRouteSignature']
  preheatSignature: CodexAppServerRunner['preheatSignature']
  _currentRepoSnapshot: CodexAppServerRunner['_currentRepoSnapshot']
  _applyRepoBindingFromSnapshot: CodexAppServerRunner['_applyRepoBindingFromSnapshot']
  remoteResumeParams: CodexAppServerRunner['remoteResumeParams']
  _startNewThread: CodexAppServerRunner['_startNewThread']
  resetAttemptState: CodexAppServerRunner['resetAttemptState']
  verifyTurnServiceTier: CodexAppServerRunner['verifyTurnServiceTier']
  buildTurnStartParams: CodexAppServerRunner['buildTurnStartParams']
  shouldRetryTurnStart: CodexAppServerRunner['shouldRetryTurnStart']
  computeRetryDelayMs: CodexAppServerRunner['computeRetryDelayMs']
  abortableDelay: CodexAppServerRunner['abortableDelay']
  consumeActiveTurnUsage: CodexAppServerRunner['consumeActiveTurnUsage']
  activeAttemptUsageIsZero: CodexAppServerRunner['activeAttemptUsageIsZero']
  _isZeroBreakdown: CodexAppServerRunner['_isZeroBreakdown']
  _consumeRateLimitsForEmit: CodexAppServerRunner['_consumeRateLimitsForEmit']
  emitResult: CodexAppServerRunner['emitResult']
  emitTurnStatus: CodexAppServerRunner['emitTurnStatus']
  emitRetryingStatus: CodexAppServerRunner['emitRetryingStatus']
  classifyErrorClass: CodexAppServerRunner['classifyErrorClass']
  recycleProcKeepQueue: CodexAppServerRunner['recycleProcKeepQueue']
  classifyRunErrorCode(errStr: string | undefined): ClassifiedErrorCode
  runWithTurnTrace<T>(threadId: string | null, traceId: string | undefined, fn: () => Promise<T>): Promise<T>
  recycleAfterUserCancelled(): Promise<void>
}

export function emitForcedShutdownResult(this: CodexTurnExecutionHost, reason: string): void {
  if (this.forcedShutdownResultEmitted) return
  if (!this.currentTurnCompleter && this.activeTurnId === null) return
  this.forcedShutdownResultEmitted = true
  const turnUsage = this.consumeActiveTurnUsage()
  const usage = turnUsage ? _codexUsageToAnthropicShape(turnUsage) : undefined
  this.emitResult({
    durationMs: 0,
    ok: false,
    error: reason,
    usage,
    requestId: this.activeRequestId,
    rateLimits: this._consumeRateLimitsForEmit(),
    stopReason: 'interrupted',
  })
}

export function consumeActiveTurnUsage(this: CodexTurnExecutionHost): CodexTokenBreakdown | null {
  if (this.activeTurnTotal === null) return null
  const baseline = this.priorTurnTotal ?? _EMPTY_TOKEN_BREAKDOWN
  const delta = _subtractTokenBreakdown(this.activeTurnTotal, baseline)
  this.currentTurnUsage = delta
  this.priorTurnTotal = this.activeTurnTotal
  this.activeTurnTotal = null
  return delta
}

export function buildTurnStartParams(
  this: CodexTurnExecutionHost,
  prompt: string,
  serviceTier: ServiceTier | null = this._serviceTier,
): Record<string, unknown> {
  if (this.opts.remote) {
    return {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
      ...(this.effortLevel ? { effort: this.effortLevel } : {}),
    }
  }
  return buildCodexTurnPolicyParams(prompt, this.threadId, {
    ...this.opts,
    effortLevel: this.effortLevel,
    serviceTier,
    mode: this.conversationMode,
    readOnly: this.advisorReadOnly,
  })
}

export async function startNewThread(
  this: CodexTurnExecutionHost,
  effectiveCwd: string,
  preheatGeneration?: number,
): Promise<void> {
  const res = (await this.sendRequest(
    'thread/start',
    this.opts.remote
      ? this.remoteInstructions !== null
        ? { baseInstructions: this.remoteInstructions }
        : {}
      : buildCodexThreadPolicyParams(
          effectiveCwd,
          this.opts.model,
          this.advisorReadOnly,
          this.advisorReadOnlyConfig,
          this.opts.hermeticNoTools,
        ),
  )) as { thread?: { id?: string } } | undefined
  const tid = res?.thread?.id
  if (typeof tid !== 'string' || !tid) {
    throw new Error('thread/start did not return thread.id')
  }
  if (preheatGeneration !== undefined && preheatGeneration !== this._preheatGeneration) {
    throw new Error('CODEX_PREHEAT_STALE')
  }
  this.threadId = tid
  this.priorTurnTotal = null
  this.activeTurnTotal = null
  this.currentTurnUsage = null
  this.resetCallUsageAttribution()
  this.syncedPlatformGoalSignature = null
  this.syncedPlatformGoal = null
  if (preheatGeneration === undefined) this.emit('session_id', tid)
  else this._unannouncedPreheatThread = true
}

export function resetAttemptState(this: CodexTurnExecutionHost): void {
  if (this.pendingUserInputs.size > 0) {
    log.error('resetAttemptState: pendingUserInputs not empty at attempt boundary', {
      sessionKey: this.opts.sessionKey,
      count: this.pendingUserInputs.size,
    })
    this.settleAllPendingUserInputs('attempt reset')
  }
  if (this.activeTurnTotal !== null) {
    const delta = _subtractTokenBreakdown(
      this.activeTurnTotal,
      this.priorTurnTotal ?? _EMPTY_TOKEN_BREAKDOWN,
    )
    if (!this._isZeroBreakdown(delta)) {
      log.error('resetAttemptState: non-zero usage delta at attempt boundary — promoting', {
        sessionKey: this.opts.sessionKey,
        delta,
      })
      this.priorTurnTotal = this.activeTurnTotal
    }
    this.activeTurnTotal = null
  }
  this.currentTurnCompleter = null
  this.activeTurnId = null
  this.currentAssistantBuf = ''
  this.hasCurrentStructuredOutput = false
  this.currentStructuredOutput = undefined
  this.currentPlanDraft = ''
  this.reasoningItemState.clear()
  this.emittedToolUseIds.clear()
  this.inflightItemHandlers.clear()
  this.collabReceiverToSpawnId.clear()
  this.collabSpawnReceivers.clear()
  this.completedCollabSpawnResults.clear()
  this.currentTurnUsage = null
  this.resetCallUsageAttribution()
  this.attemptHadObservableOutput = false
  this.attemptHadToolOrPermission = false
  this.attemptEmittedTerminal = false
  rememberImageStderr(this, null)
}

export async function verifyTurnServiceTier(
  this: CodexTurnExecutionHost,
  readOnly: boolean,
  serviceTier: ServiceTier | null,
): Promise<void> {
  const controller = new AbortController()
  this.pendingRetryAbort = controller
  this.retryBackoffProcGone = false
  try {
    await ensureCodexTurnServiceTierSupported({
      model: this.opts.model,
      readOnly,
      serviceTier,
      remote: Boolean(this.opts.remote),
      initialized: this.initializedPayload,
      signal: controller.signal,
      listModels: (cursor, sig) => this.sendRequest('model/list', cursor ? { cursor } : {}, sig),
    })
  } catch (err) {
    if (
      controller.signal.aborted &&
      controller.signal.reason === 'user-stop' &&
      !this.retryBackoffProcGone
    ) {
      this.pendingStartInterrupt = true
      return
    }
    throw err
  } finally {
    if (this.pendingRetryAbort === controller) this.pendingRetryAbort = null
  }
}

export function shouldRetryTurnStart(
  this: CodexTurnExecutionHost,
  err: unknown,
  retryState: AutomaticRetryState,
): boolean {
  if (retryState.attempt >= retryState.max) return false
  const e = err as Partial<JsonRpcCallError> | null | undefined
  if (
    !e ||
    typeof e.rpcCode !== 'number' ||
    typeof e.rpcMessage !== 'string' ||
    e.rpcMethod !== 'turn/start'
  ) {
    return false
  }
  if (!this.proc || this.proc.killed) return false
  if (this.activeTurnId !== null) return false
  if (this.currentTurnCompleter === null) return false
  if (!turnErrorSemantics(this.classifyRunErrorCode(e.rpcMessage)).retryable) return false
  if (this.attemptHadObservableOutput || this.attemptHadToolOrPermission) return false
  if (this.attemptEmittedTerminal) return false
  if (!this.activeAttemptUsageIsZero()) return false
  if (this.pendingUserInputs.size > 0) return false
  return true
}

export async function runTurn(
  this: CodexTurnExecutionHost,
  prompt: string,
  requestId?: string,
  collabAgentPolicy?: CollabAgentPolicy,
  automaticRetryState?: AutomaticRetryState,
  traceId?: string | null,
  readOnly = false,
  turnServiceTier: ServiceTier | null = this._serviceTier,
): Promise<void> {
  const turnTraceId = traceId === null ? undefined : traceId ?? this.opts.traceId
  const startedAt = Date.now()
  const timingStartedAt = performance.now()
  if (this._preheatPromise) await this._preheatPromise.catch(() => {})
  this.advisorReadOnly = readOnly
  const seenDeltas = new Set<string>()
  const observeFirstDelta = (message: any): void => {
    const delta = message?.event?.delta
    const stage =
      delta?.type === 'text_delta' && delta.text?.length
        ? 'first_text_delta'
        : delta?.type === 'thinking_delta' && delta.thinking?.length
          ? 'first_reasoning_delta'
          : null
    if (!stage || seenDeltas.has(stage) || message.session_id !== this.threadId) return
    seenDeltas.add(stage)
    log.info('codex_turn_timing', {
      traceId: turnTraceId,
      threadId: this.threadId,
      stage,
      elapsedMs: performance.now() - timingStartedAt,
    })
  }
  this.on('message', observeFirstDelta)
  this.activeRequestId = requestId
  this.forcedShutdownResultEmitted = false
  this.settleAllPendingUserInputs('next turn started')
  const repoSnap = this._currentRepoSnapshot()
  let effectiveCwd = this._applyRepoBindingFromSnapshot(repoSnap)
  log.info('codex app-server turn start', {
    traceId: turnTraceId,
    sessionKey: this.opts.sessionKey,
    resumed: this.threadId != null,
    pid: this.proc?.pid ?? null,
    reusedProc: Boolean(this.proc && this.initialized && !this.staleProcGeneration),
    promptChars: prompt.length,
    effectiveCwd,
    repoBound: this._boundRepoBinding != null,
  })
  this.currentCollabAgentPolicy = collabAgentPolicy

  const retryState = automaticRetryState ?? {
    rootClientMessageId: `local-${this.opts.sessionKey}`,
    attempt: 0,
    max: AUTOMATIC_TURN_RETRY_MAX,
  }
  try {
    if (
      this.proc &&
      !this.proc.killed &&
      ((this.spawnedAdvisorReadOnly !== null && this.spawnedAdvisorReadOnly !== readOnly) ||
        (this.spawnedProviderSignature !== null &&
          this.spawnedProviderSignature !== this.codexRouteSignature()) ||
        (this._preheatedSignature !== null &&
          this._preheatedSignature !== this.preheatSignature(repoSnap, effectiveCwd)))
    ) {
      const queuedTurns = this.queue
      this.queue = []
      try {
        await this.shutdown()
        effectiveCwd = this._applyRepoBindingFromSnapshot(repoSnap)
      } finally {
        if (queuedTurns.length > 0) {
          this.queue = queuedTurns.concat(this.queue)
        }
      }
    }
    this.currentCollabAgentPolicy = collabAgentPolicy
    if (this.pendingConsultRespawn) {
      this.pendingConsultRespawn = false
      await this.shutdown()
      this.shuttingDown = false
    }
    const reusedProcess = Boolean(this.proc && this.initialized && !this.staleProcGeneration)
    await this.ensureSpawned(repoSnap, effectiveCwd)
    log.info('codex_turn_timing', {
      traceId: turnTraceId,
      threadId: this.threadId,
      stage: 'engine_ready',
      reusedProcess,
      elapsedMs: performance.now() - timingStartedAt,
    })
    const threadStartedAt = performance.now()
    this.refreshDelegateContext(turnTraceId)

    if (!this.attached) {
      if (!this.threadId) {
        await this._startNewThread(effectiveCwd)
      } else {
        try {
          await this.sendRequest(
            'thread/resume',
            this.opts.remote
              ? this.remoteResumeParams(this.threadId)
              : {
                  ...(this.cachedOverrides?.instructionsContent !== undefined
                    ? { baseInstructions: this.cachedOverrides.instructionsContent }
                    : {}),
                  threadId: this.threadId,
                  ...buildCodexThreadPolicyParams(
                    effectiveCwd,
                    this.opts.model,
                    this.advisorReadOnly,
                    this.advisorReadOnlyConfig,
                  ),
                },
          )
        } catch (err) {
          if (!isMissingRolloutError(err)) throw err
          const staleThreadId = this.threadId
          const fallback = staleThreadId
            ? this.opts.resolveResumeFallback?.(staleThreadId)
            : undefined
          if (fallback && fallback !== staleThreadId) {
            log.warn('codex thread/resume missing rollout — resuming prior durable thread', {
              sessionKey: this.opts.sessionKey,
              staleThreadId,
              fallbackThreadId: fallback,
            })
            this.threadId = fallback
            this.priorTurnTotal = null
            this.activeTurnTotal = null
            this.currentTurnUsage = null
            this.resetCallUsageAttribution()
            this.syncedPlatformGoalSignature = null
            this.syncedPlatformGoal = null
            try {
              await this.sendRequest(
                'thread/resume',
                this.opts.remote
                  ? this.remoteResumeParams(fallback)
                  : {
                      ...(this.cachedOverrides?.instructionsContent !== undefined
                        ? { baseInstructions: this.cachedOverrides.instructionsContent }
                        : {}),
                      threadId: fallback,
                      ...buildCodexThreadPolicyParams(
                        effectiveCwd,
                        this.opts.model,
                        this.advisorReadOnly,
                        this.advisorReadOnlyConfig,
                      ),
                    },
              )
              this.emit('session_id', fallback)
              this.attached = true
            } catch (err2) {
              if (!isMissingRolloutError(err2)) throw err2
              log.warn('codex fallback thread also missing rollout — restarting fresh', {
                sessionKey: this.opts.sessionKey,
                fallbackThreadId: fallback,
              })
              this.threadId = null
              await this._startNewThread(effectiveCwd)
            }
          } else {
            log.warn('codex thread/resume missing rollout — restarting fresh', {
              sessionKey: this.opts.sessionKey,
              staleThreadId,
              rpcMessage: (err as JsonRpcCallError).rpcMessage,
            })
            this.threadId = null
            await this._startNewThread(effectiveCwd)
          }
        }
      }
      this.attached = true
    }

    const preheatedThreadClaimed = Boolean(this._unannouncedPreheatThread && this.threadId)
    if (this._unannouncedPreheatThread && this.threadId) {
      this._unannouncedPreheatThread = false
      this.emit('session_id', this.threadId)
    }
    this._preheatedSignature = null
    log.info('codex_turn_timing', {
      traceId: turnTraceId,
      threadId: this.threadId,
      stage: 'thread_ready',
      preheatedThreadClaimed,
      durationMs: performance.now() - threadStartedAt,
      elapsedMs: performance.now() - timingStartedAt,
    })
    await this.syncPlatformGoal()

    this.nativeContext.beginTurn()
    for (;;) {
      this.resetAttemptState()
      if (!this.pendingStartInterrupt) await this.verifyTurnServiceTier(readOnly, turnServiceTier)
      if (!this.pendingStartInterrupt && !this.opts.remote) {
        await this.nativeContext.compactIfNeeded({
          threadId: this.threadId,
          traceId: turnTraceId,
          timeoutMs: NATIVE_COMPACTION_TIMEOUT_MS,
          send: () => this.sendRequest('thread/compact/start', { threadId: this.threadId }),
          drainFailure: async () => {
            const drained = this.outputDrainPromise
            if (!this.shuttingDown) await this.recycleProcKeepQueue('native-context-compaction-failed')
            await drained
          },
        })
      }

      const completed = new Promise<{
        status?: string
        durationMs?: number
        error?: { message?: string; codexErrorInfo?: unknown }
      }>((resolve, reject) => {
        this.currentTurnCompleter = { resolve, reject }
      })
      void completed.catch(() => {})

      if (this.pendingStartInterrupt) {
        this.pendingStartInterrupt = false
        this.currentTurnCompleter = null
        void completed.catch(() => {})
        this.emitResult({
          durationMs: Date.now() - startedAt,
          ok: false,
          error: 'codex turn interrupted',
          requestId,
          rateLimits: this._consumeRateLimitsForEmit(),
          stopReason: 'interrupted',
          terminalCode: 'USER_CANCELLED',
        })
        return
      }

      let tres: { turn?: { id?: string } } | undefined
      try {
        log.info('codex_turn_timing', {
          traceId: turnTraceId,
          threadId: this.threadId,
          stage: 'turn_start_sent',
          elapsedMs: performance.now() - timingStartedAt,
        })
        tres = (await this.runWithTurnTrace(this.threadId, turnTraceId, () =>
          this.sendRequest('turn/start', this.buildTurnStartParams(prompt, turnServiceTier)),
        )) as { turn?: { id?: string } } | undefined
      } catch (startErr) {
        if (this.shouldRetryTurnStart(startErr, retryState)) {
          this.currentTurnCompleter = null
          void completed.catch(() => {})
          const nextAttempt = retryState.attempt + 1
          retryState.attempt = nextAttempt
          const delayMs = this.computeRetryDelayMs(nextAttempt)
          const cls = this.classifyRunErrorCode((startErr as JsonRpcCallError).rpcMessage)
          log.warn('codex turn/start rejected — auto-retrying (narrow path)', {
            sessionKey: this.opts.sessionKey,
            attempt: nextAttempt,
            nextAttempt,
            delayMs,
            errorClass: cls,
            rpcCode: (startErr as JsonRpcCallError).rpcCode,
          })
          this.emitRetryingStatus({
            attempt: nextAttempt,
            max: retryState.max,
            delayMs,
            retryAt: Date.now() + delayMs,
          })
          const controller = new AbortController()
          this.pendingRetryAbort = controller
          this.retryBackoffProcGone = false
          let interruptedDuringBackoff = false
          try {
            interruptedDuringBackoff = await this.abortableDelay(delayMs, controller.signal)
          } finally {
            this.pendingRetryAbort = null
            this.emitTurnStatus(null)
          }
          if (!this.proc || this.proc.killed || this.shuttingDown || this.retryBackoffProcGone) {
            throw new Error('codex app-server gone during retry backoff')
          }
          if (interruptedDuringBackoff) {
            this.activeTurnId = null
            this.currentTurnCompleter = null
            const cancelUsage = this.consumeActiveTurnUsage()
            this.emitResult({
              durationMs: Date.now() - startedAt,
              ok: false,
              error: 'codex turn interrupted',
              usage: cancelUsage ? _codexUsageToAnthropicShape(cancelUsage) : undefined,
              requestId,
              rateLimits: this._consumeRateLimitsForEmit(),
              stopReason: 'interrupted',
              terminalCode: 'USER_CANCELLED',
            })
            return
          }
          continue
        }
        throw startErr
      }

      log.info('codex_turn_timing', {
        traceId: turnTraceId,
        threadId: this.threadId,
        stage: 'turn_start_accepted',
        elapsedMs: performance.now() - timingStartedAt,
      })
      const turnId = tres?.turn?.id
      if (typeof turnId !== 'string' || !turnId) {
        throw new Error('turn/start did not return turn.id')
      }
      this.activeTurnId = turnId
      if (this.pendingStartInterrupt) {
        this.pendingStartInterrupt = false
        this.interrupt()
      }

      const turn = await completed

      if (this.inflightItemHandlers.size > 0) {
        await Promise.allSettled([...this.inflightItemHandlers])
      }

      this.activeTurnId = null

      const durationMs = Date.now() - startedAt
      const status = turn?.status
      const turnUsage = this.consumeActiveTurnUsage()
      log.info('codex app-server turn end', {
        sessionKey: this.opts.sessionKey,
        status,
        durationMs,
        assistantChars: this.currentAssistantBuf.length,
        ...(turnUsage
          ? {
              inputTokens: turnUsage.inputTokens,
              outputTokens: turnUsage.outputTokens,
              cachedInputTokens: turnUsage.cachedInputTokens,
              reasoningOutputTokens: turnUsage.reasoningOutputTokens,
            }
          : {}),
      })

      const usagePayload = turnUsage ? _codexUsageToAnthropicShape(turnUsage) : undefined
      const rateLimitsPayload = this._consumeRateLimitsForEmit()

      if (status === 'completed') {
        this.emitResult({
          durationMs,
          ok: true,
          text: this.currentAssistantBuf,
          usage: usagePayload,
          requestId,
          rateLimits: rateLimitsPayload,
          stopReason: 'end_turn',
        })
      } else if (status === 'failed') {
        const errMsg = turn?.error?.message ?? 'codex turn failed'
        const codexErrorInfo = turn?.error?.codexErrorInfo
        const errorClass = this.classifyErrorClass(errMsg)
        log.error('codex app-server turn failed status', {
          sessionKey: this.opts.sessionKey,
          errMsg,
          ...(errorClass ? { errorClass } : {}),
          ...(codexErrorInfo !== undefined ? { codexErrorInfo } : {}),
        })
        this.emitResult({
          durationMs,
          ok: false,
          error: errMsg,
          usage: usagePayload,
          requestId,
          rateLimits: rateLimitsPayload,
          ...(errorClass ? { errorClass } : {}),
        })
      } else if (status === 'interrupted') {
        this.activeTurnId = null
        this.currentTurnCompleter = null
        await this.recycleAfterUserCancelled()
        this.emitResult({
          durationMs,
          ok: false,
          error: 'codex turn interrupted',
          usage: usagePayload,
          requestId,
          rateLimits: rateLimitsPayload,
          stopReason: 'interrupted',
          terminalCode: 'USER_CANCELLED',
        })
      } else {
        this.emitResult({
          durationMs,
          ok: false,
          error: `codex turn unexpected status=${status ?? 'unknown'}`,
          usage: usagePayload,
          requestId,
          rateLimits: rateLimitsPayload,
        })
      }
      return
    }
  } catch (err) {
    if (this.recycleInflight) await this.recycleInflight
    if (this.inflightItemHandlers.size > 0) {
      await Promise.allSettled([...this.inflightItemHandlers])
    }
    const failedTurnUsage = this.consumeActiveTurnUsage()
    this.settleAllPendingUserInputs('turn failed')
    this.activeTurnId = null
    this.currentTurnCompleter = null
    const durationMs = Date.now() - startedAt
    if (this.pendingStartInterrupt) {
      this.pendingStartInterrupt = false
      log.info('codex turn stopped before start', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
      this.emitResult({
        durationMs,
        ok: false,
        error: 'codex turn interrupted',
        usage: failedTurnUsage ? _codexUsageToAnthropicShape(failedTurnUsage) : undefined,
        requestId,
        rateLimits: this._consumeRateLimitsForEmit(),
        stopReason: 'interrupted',
        terminalCode: 'USER_CANCELLED',
      })
      return
    }
    const errMsg = `codex app-server: ${(err as Error).message}`
    const errorClass = this.classifyErrorClass(errMsg)
    log.error('codex app-server turn failed', {
      sessionKey: this.opts.sessionKey,
      err: (err as Error).message,
      ...(errorClass ? { errorClass } : {}),
    })
    this.emitResult({
      durationMs,
      ok: false,
      error: errMsg,
      usage: failedTurnUsage ? _codexUsageToAnthropicShape(failedTurnUsage) : undefined,
      requestId,
      rateLimits: this._consumeRateLimitsForEmit(),
      ...(errorClass ? { errorClass } : {}),
    })
  } finally {
    this.off('message', observeFirstDelta)
    this.currentCollabAgentPolicy = undefined
    this.activeRequestId = undefined
    this.pendingStartInterrupt = false
  }
}
