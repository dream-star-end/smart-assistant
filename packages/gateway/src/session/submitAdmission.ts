/**
 * Submit-path admission gates, identity/compat verification, and replay-lifecycle hooks.
 */
import {
  IdentityAssetsError,
  getTurnDispatchByDispatchId,
  resolveRuntimeExecutionAgent,
  type AgentDef,
  type IdentityCompatRuntimeContext,
} from '@openclaude/storage'
import type { SessionStreamEvent } from '../engine/engineEvents.js'
import { log } from '../sessionManagerLog.js'
import type { AgentSession } from '../sessionTypes.js'
import { getV3MasterSinkOrNull } from '../v3MasterSink.js'
import { assertPromptQueueExecutionAdmission } from './sessionUtils.js'
import type { PromptQueueExecutionFence, SubmitOpts, SubmitReplayLifecycle } from './types.js'

export function normalizeToolsetListForCompare(toolsets: unknown): string[] | undefined {
  if (!Array.isArray(toolsets) || toolsets.length === 0) return undefined
  const out: string[] = []
  for (const value of toolsets) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out.length > 0 ? out.sort() : undefined
}

export function sameToolsetsForCompare(a: unknown, b: unknown): boolean {
  const left = normalizeToolsetListForCompare(a)
  const right = normalizeToolsetListForCompare(b)
  if (!left && !right) return true
  if (!left || !right) return false
  return left.length === right.length && left.every((value, idx) => value === right[idx])
}

export function checkSubmitCommercialAndBillingGuards(args: {
  session: AgentSession
  requestId: string | undefined
  traceId: string | undefined
  modelSwitchInternal: string | undefined
  onEvent: (e: SessionStreamEvent) => void
  isCommercialManagedRuntime: () => boolean
  isEngineLocalTurnExempt: () => boolean
}): boolean {
  const { session, requestId, traceId, modelSwitchInternal, onEvent } = args
  if (args.isCommercialManagedRuntime() && getV3MasterSinkOrNull() === null) {
    log.error('commercial turn rejected: lossless sink unavailable', {
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      channel: session.channel,
    })
    return false
  }
  const hasValidRequestId = typeof requestId === 'string' && /^[0-9a-f]{32}$/.test(requestId)
  if (
    session.runner.capabilities.needsServerRequestId &&
    !hasValidRequestId &&
    args.isCommercialManagedRuntime() &&
    !args.isEngineLocalTurnExempt() &&
    modelSwitchInternal === undefined
  ) {
    log.error('codex turn rejected: missing/malformed server-owned requestId (billing guard)', {
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      engineId: session.runner.engineId,
      requestIdShape: requestId === undefined ? 'undefined' : `len=${String(requestId).length}`,
      ...(traceId ? { traceId } : {}),
    })
    onEvent({
      kind: 'error',
      error:
        'CODEX_BILLING_GUARD: codex turn requires a server-owned requestId in commercial runtime — turn rejected (fail-closed)',
    })
    return false
  }
  return true
}

export function resolveModelSwitchAdmission(
  session: AgentSession,
  model: string | undefined,
  opts: SubmitOpts | undefined,
): {
  transition: AgentSession['_modelSwitchTransition']
  consumingModelSwitch: boolean
} {
  let transition = session._modelSwitchTransition
  if (
    transition?.state === 'prepared' &&
    transition.expiresAt !== undefined &&
    Date.now() >= transition.expiresAt
  ) {
    if (model === transition.sourceModel && opts?.modelSwitchId === undefined) {
      session._modelSwitchTransition = undefined
      transition = undefined
    } else {
      throw new Error('MODEL_SWITCH_EXPIRED')
    }
  }
  const internalSwitchCompact =
    transition !== undefined && opts?.modelSwitchInternal === transition.id
  let consumingModelSwitch = false
  if (transition && !internalSwitchCompact) {
    if (
      transition.state !== 'prepared' ||
      model !== transition.targetModel ||
      opts?.modelSwitchId !== transition.id
    ) {
      throw new Error('MODEL_SWITCH_IN_PROGRESS')
    }
    transition.state = 'consuming'
    consumingModelSwitch = true
  }
  return { transition, consumingModelSwitch }
}

export function validateSubmitQueueAdmission(args: {
  session: AgentSession
  queueTurn: boolean
  queueExecutionFence: PromptQueueExecutionFence | undefined
  ownsDispatchFence: boolean
  hasQueueExecutionSession: boolean
  hasQueueExecutionKey: boolean
  hasDispatchFenceKey: boolean
}): void {
  if (args.queueExecutionFence && !args.ownsDispatchFence) {
    throw new Error('PROMPT_QUEUE_EXECUTION_INVARIANT: stale queue execution fence')
  }
  assertPromptQueueExecutionAdmission(
    args.queueTurn,
    args.session._activeTurnCount ?? 0,
    args.session._activeClientTurnCount ?? 0,
    args.hasQueueExecutionSession ||
      args.hasQueueExecutionKey ||
      (args.hasDispatchFenceKey && !args.ownsDispatchFence),
  )
}

export async function isDispatchCancelledBeforeStart(
  dispatchContext: AgentSession['_currentDispatch'] | undefined,
): Promise<boolean> {
  if (!dispatchContext) return false
  const current = await getTurnDispatchByDispatchId(
    dispatchContext.dispatchId,
    dispatchContext.attemptNo,
  )
  return (
    current?.state === 'rejected' &&
    current.userId === dispatchContext.userId &&
    current.sessionId === dispatchContext.sessionId &&
    current.clientMessageId === dispatchContext.clientMessageId &&
    current.dispatchId === dispatchContext.dispatchId &&
    current.attemptNo === dispatchContext.attemptNo
  )
}

export async function validateRuntimeIdentityAdmission(
  session: AgentSession,
  restartRunnerForConfigChange: (runner: AgentSession['runner']) => Promise<void>,
): Promise<{ agent: AgentDef; context: IdentityCompatRuntimeContext }> {
  const hermeticNoTools = session._identityCreationOpts?.hermeticNoTools === true
  const admission = hermeticNoTools
    ? { agent: session._identityCreationOpts?.agent ?? { id: session.agentId }, context: {} }
    : await resolveRuntimeExecutionAgent(
        session._identityCreationOpts?.agent ?? { id: session.agentId },
      )
  if (admission.agent.id !== session.agentId) {
    throw new Error('COMPAT_CONFIG_CONFLICT: runner identity changed; reopen this session')
  }
  if (
    admission.context.assets &&
    session.providerTag !== 'ccb' &&
    admission.context.assets.effectivePermissionMode !== undefined &&
    admission.context.assets.effectivePermissionMode !== 'bypassPermissions'
  ) {
    throw new IdentityAssetsError(
      'COMPAT_PERMISSION_CONFLICT',
      'COMPAT_PERMISSION_CONFLICT: selected engine cannot enforce the registered permission mode',
    )
  }
  if (
    admission.context.assets &&
    session._identityAgentFingerprint !== JSON.stringify(admission.agent)
  ) {
    throw new Error(
      'COMPAT_CONFIG_CONFLICT: execution configuration changed while awaiting the safe turn boundary; retry',
    )
  }
  if (session._identityCompat) {
    const changed = session._identityCompat.fingerprint !== admission.context.fingerprint
    Object.assign(
      session._identityCompat,
      { assets: undefined, fingerprint: undefined },
      admission.context,
    )
    if (changed) {
      log.info('runner_config_restart', { sessionKey: session.sessionKey, identityCompatChanged: true })
      await restartRunnerForConfigChange(session.runner)
    }
  } else if (admission.context.assets && session.channel !== 'auto-dream') {
    throw new Error('COMPAT_CONFIG_CONFLICT: runner has no validated identity context')
  }
  return admission
}

export function startReplayLifecycleSafely(
  session: AgentSession,
  replayLifecycle: SubmitReplayLifecycle | undefined,
): boolean {
  if (!replayLifecycle) return false
  session._runningClientMessageId = replayLifecycle.clientMessageId
  try {
    replayLifecycle.onStart()
  } catch (err) {
    log.warn('active-turn replay start hook failed', { sessionKey: session.sessionKey }, err)
  }
  return true
}
