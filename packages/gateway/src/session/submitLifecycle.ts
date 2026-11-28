/**
 * Submit-path liveness watchdog, idle-timeout settlement, checkpoint ack,
 * and post-turn cleanup helpers.
 */
import { paths } from '@openclaude/storage'
import type { SessionStreamEvent } from '../engine/engineEvents.js'
import { notifyAuthorityCheckpointAck, type SessionAuthorityRuntimePort } from '../sessionAuthorityHook.js'
import {
  ackPendingCheckpointIfTurnSucceeded,
  resetUnackedCheckpointSessionFlags,
  type PersistedCheckpointRecord,
} from '../sessionCheckpointStore.js'
import { log } from '../sessionManagerLog.js'
import type { AgentSession } from '../sessionTypes.js'
import { shouldTripIdleWatchdog } from './sessionUtils.js'
import type { SubmitOpts } from './types.js'

export class TurnIdleTimeoutError extends Error {
  readonly code = 'TURN_IDLE_TIMEOUT'
}

export function createTurnLivenessWatchdog(args: {
  session: AgentSession
  logicalTurnAbort: AbortController
  pickIdleTimeoutMs: (
    status: AgentSession['currentTurnStatus'],
    pendingToolCalls: number,
    providerTag?: string,
    model?: string,
  ) => number
}): { promise: Promise<never>; stop: () => void } {
  const CHECK_INTERVAL = 15_000
  let livenessTimer: NodeJS.Timeout | null = null
  const promise = new Promise<never>((_, reject) => {
    livenessTimer = setInterval(() => {
      const idleMs =
        Date.now() -
        (args.session.runner.idleWatchdogActivityAt ?? args.session.runner.lastActivityAt)
      const threshold = args.pickIdleTimeoutMs(
        args.session.currentTurnStatus,
        args.session.runner.pendingToolCalls,
        args.session.providerTag,
        args.session.model,
      )
      if (
        shouldTripIdleWatchdog({
          waitingForUserInput: args.session.runner.waitingForUserInput === true,
          idleMs,
          thresholdMs: threshold,
        })
      ) {
        const error = new TurnIdleTimeoutError(
          `idle timeout (${Math.round(idleMs / 1000)}s no output)`,
        )
        args.logicalTurnAbort.abort(error)
        reject(error)
      }
    }, CHECK_INTERVAL)
  })
  return {
    promise,
    stop: () => {
      if (livenessTimer) {
        clearInterval(livenessTimer)
        livenessTimer = null
      }
    },
  }
}

export function isTurnIdleTimeoutError(err: unknown): err is Error {
  if (err instanceof TurnIdleTimeoutError) return true
  return (
    err instanceof Error &&
    (err as Error & { code?: unknown }).code === 'TURN_IDLE_TIMEOUT'
  )
}

export async function handleTurnIdleTimeoutError(args: {
  err: Error
  session: AgentSession
  traceId: string | undefined
  logicalTurnAbort: AbortController
  logicalTurnRun: Promise<void> | null
  onEvent: (e: SessionStreamEvent) => void
  trackPersistence: (p: Promise<unknown>) => void
}): Promise<void> {
  const { err, session, traceId, logicalTurnAbort, logicalTurnRun, onEvent, trackPersistence } = args
  const persistTimedOutTurn = session._persistActiveTurn
  try {
    session.runner.interrupt()
  } catch (interruptErr) {
    log.debug('runner interrupt on idle timeout failed', {
      sessionKey: session.sessionKey,
      err: String(interruptErr),
    })
  }
  const m = /\((\d+)s/.exec(String(err.message))
  const minutes = m ? Math.round(Number(m[1]) / 60) : null
  const detail = minutes ? `约 ${minutes} 分钟无输出` : '长时间无输出'
  const reason = `任务${detail}，已中断。本轮已自动免单，积分将原路退回；请重试。`
  if (persistTimedOutTurn) {
    const persistence = persistTimedOutTurn(
      'interrupted',
      reason,
      'LIVENESS_TIMEOUT',
      'idle_timeout',
    )
    trackPersistence(persistence)
    await persistence
  } else {
    onEvent({ kind: 'error', error: reason })
  }
  await logicalTurnRun?.catch((runErr) => {
    if (runErr !== logicalTurnAbort.signal.reason) throw runErr
  })
  log.error(
    'idle timeout, interrupted',
    { sessionKey: session.sessionKey, ...(traceId ? { traceId } : {}) },
    err,
  )
}

export function ackTurnCheckpointOnSuccess(args: {
  session: AgentSession
  activeCkptGen: string | undefined
  opts: SubmitOpts | undefined
  requestId: string | undefined
  authorityStateRuntime: SessionAuthorityRuntimePort | undefined
}): boolean {
  const { session, activeCkptGen, opts, requestId, authorityStateRuntime } = args
  if (!activeCkptGen) return false
  const ckptTurnKey =
    opts?.dispatchContext?.dispatchId ??
    opts?.replayLifecycle?.clientMessageId ??
    requestId ??
    'turn-ack'
  const acked = ackPendingCheckpointIfTurnSucceeded(session, activeCkptGen, undefined, () =>
    authorityStateRuntime?.persistPendingCheckpointAckIntent?.(
      session.sessionKey,
      activeCkptGen,
      ckptTurnKey,
    ),
  )
  if (!acked) return false
  notifyAuthorityCheckpointAck({
    authorityRuntime: authorityStateRuntime,
    sessionKey: session.sessionKey,
    checkpointGeneration: activeCkptGen,
    turnKey: ckptTurnKey,
  })
  return true
}

export interface SubmitCleanupDeps {
  clearRunnerPromptPrivacy: (runner: AgentSession['runner']) => void
  getTurnActiveCheckpointGeneration: (session: AgentSession) => string | undefined
  clearTurnOverflowContext: (session: AgentSession) => void
  finalizeEfficiencyTurn: (session: AgentSession) => Promise<void>
  boxTurnMayIdle: (input: { model?: string; contextOwner?: string }) => boolean
  writeIdleCandidate: (
    dir: string,
    candidate: { v: 1; sessionKey: string; sessionId: string; turnKey: string; createdAt: number },
  ) => void
  currentIdleSource: (dir: string, sessionKey: string) => unknown
  isIdleCompactRejected: (err: unknown) => boolean
  releasePromptQueueSession: (session: AgentSession) => void
  scheduleIdleDrain: (session: AgentSession) => void
}

export async function runSubmitPreBarrierCleanup(args: {
  session: AgentSession
  closeIdleWait: (() => void) | undefined
  closeHelpLogical: (() => void) | undefined
  consumingModelSwitch: boolean
  transition: AgentSession['_modelSwitchTransition']
  checkpointAcked: boolean
  pendingCheckpoint: PersistedCheckpointRecord | null
  deps: SubmitCleanupDeps
}): Promise<void> {
  const { session, deps } = args
  args.closeIdleWait?.()
  if (!session._idleWaiters?.size && !session._idleInternalTurns) session._idleDeadline = undefined
  args.closeHelpLogical?.()
  deps.clearRunnerPromptPrivacy(session.runner)
  if (
    args.consumingModelSwitch &&
    args.transition &&
    session._modelSwitchTransition === args.transition &&
    args.transition.state === 'consuming'
  ) {
    args.transition.state = 'prepared'
    args.transition.summaryInjected = false
  }
  const unackedCkptGen = !args.checkpointAcked
    ? (deps.getTurnActiveCheckpointGeneration(session) ?? args.pendingCheckpoint?.generation)
    : undefined
  if (unackedCkptGen) resetUnackedCheckpointSessionFlags(session, unackedCkptGen)
  deps.clearTurnOverflowContext(session)
  await deps.finalizeEfficiencyTurn(session).catch((err) => {
    log.debug('efficiency guard finalize failed', {
      sessionKey: session.sessionKey,
      err: String(err),
    })
  })
}

function recordPostTurnIdleCandidate(args: {
  session: AgentSession
  unhandledTurnError: unknown
  modelSwitchInternal: string | undefined
  deps: SubmitCleanupDeps
}): boolean {
  const { session, unhandledTurnError, modelSwitchInternal, deps } = args
  const idleSessionId = session.runner.nativeSessionId ?? undefined
  const idleTurnKey = session._currentTurnKey
  if (unhandledTurnError !== undefined || !idleSessionId || !idleTurnKey || modelSwitchInternal !== undefined) {
    return false
  }
  try {
    if (
      !session.runner.executionBackend &&
      deps.boxTurnMayIdle({ model: session.model, contextOwner: session._boxContextOwner })
    ) {
      deps.writeIdleCandidate(paths.home, {
        v: 1,
        sessionKey: session.sessionKey,
        sessionId: idleSessionId,
        turnKey: idleTurnKey,
        createdAt: Date.now(),
      })
    }
    return deps.currentIdleSource(paths.home, session.sessionKey) !== undefined
  } catch (idleErr) {
    if (!deps.isIdleCompactRejected(idleErr)) {
      log.warn('idle compact failed closed', { sessionKey: session.sessionKey }, idleErr)
    }
    return false
  }
}

export function finalizeSubmitReplayAndState(args: {
  session: AgentSession
  opts: SubmitOpts | undefined
  replayLifecycleStarted: boolean
  unhandledTurnError: unknown
  logicalTurnAbort: AbortController
  queueTurn: boolean
  deps: SubmitCleanupDeps
}): boolean {
  const { session, opts, replayLifecycleStarted, unhandledTurnError, logicalTurnAbort, queueTurn, deps } = args
  try {
    if (replayLifecycleStarted) {
      try {
        opts?.replayLifecycle?.onBeforeRelease(unhandledTurnError)
      } catch (err) {
        log.warn('active-turn replay before-release hook failed', { sessionKey: session.sessionKey }, err)
      }
    }
  } finally {
    if (replayLifecycleStarted) {
      try {
        opts?.replayLifecycle?.onEnd()
      } catch (err) {
        log.warn('active-turn replay end hook failed', { sessionKey: session.sessionKey }, err)
      }
    }
  }
  if (
    opts?.replayLifecycle &&
    session._runningClientMessageId === opts.replayLifecycle.clientMessageId
  ) {
    session._runningClientMessageId = undefined
  }
  if (session._externalTurnAbort === logicalTurnAbort) {
    session._externalTurnAbort = undefined
  }
  const idleFollowUp = recordPostTurnIdleCandidate({
    session,
    unhandledTurnError,
    modelSwitchInternal: opts?.modelSwitchInternal,
    deps,
  })
  session._activeTurnCount = Math.max(0, (session._activeTurnCount ?? 0) - 1)
  session._currentTurnKey = undefined
  session._currentTurnIndex = undefined
  session._currentDispatch = undefined
  session._turnCreditBudgetFen = undefined
  session._turnReadOnly = undefined
  session._turnServiceTier = undefined
  session._antigravitySwarmCompaction = undefined
  if (queueTurn) deps.releasePromptQueueSession(session)
  return idleFollowUp
}
