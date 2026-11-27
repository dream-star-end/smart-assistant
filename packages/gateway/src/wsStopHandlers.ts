/**
 * OCV5-435 / OCV5-923 — Pre-start Stop handler for admitted webchat turns
 * (`gateway-interface` L5, matching `*Handlers.ts`).
 */
import type { AdmittedClientTurnMeta } from './turnDispatch.js'
import type { HandleStopFrame, WsConnectionHost } from './wsConnection.js'

export interface PreStartStopDeps {
  readonly preStartStopKey: (peerId: string, clientMessageId: string) => string
  readonly isHiddenSystemAgentId: (agentId: string) => boolean
  readonly interruptRemoteSwarm: (
    host: WsConnectionHost,
    sessionKey: string,
    reason: string,
  ) => Promise<boolean>
}

function resolveTargetSessionKeyForPreStart(
  meta: AdmittedClientTurnMeta | undefined,
  frame: HandleStopFrame,
  safePeerId: string,
): string | undefined {
  if (meta) return meta.targetSessionKey
  const explicitFrameAgentId =
    typeof frame.agentId === 'string' && frame.agentId.trim() ? frame.agentId.trim() : undefined
  if (!explicitFrameAgentId) return undefined
  return `agent:${explicitFrameAgentId}:${frame.channel}:${frame.peer.kind}:${safePeerId}`
}

function fenceEarlierSameSessionTurns(
  host: WsConnectionHost,
  admittedKey: string,
  targetSessionKey: string,
  seq: number,
): void {
  if (!host._admittedClientTurnMeta) return
  for (const [otherKey, otherMeta] of host._admittedClientTurnMeta.entries()) {
    if (otherKey !== admittedKey && otherMeta.targetSessionKey === targetSessionKey && otherMeta.seq < seq) {
      host.sessions.fencePreStartStop(otherMeta.peerId, otherMeta.clientMessageId)
    }
  }
}

function lookupLiveSessionForStop(
  host: WsConnectionHost,
  targetSessionKey: string,
): { sessionKey: string; _runningClientMessageId?: string; _persistActiveTurn?: unknown } | undefined {
  if (typeof host.sessions.getByKey === 'function') {
    return host.sessions.getByKey(targetSessionKey) as
      | { sessionKey: string; _runningClientMessageId?: string; _persistActiveTurn?: unknown }
      | undefined
  }
  return host.sessions.list().find((live) => live.sessionKey === targetSessionKey) as
    | { sessionKey: string; _runningClientMessageId?: string; _persistActiveTurn?: unknown }
    | undefined
}

function classifyOlderBlockingTurn(
  host: WsConnectionHost,
  peerId: string,
  clientMessageId: string,
  meta: AdmittedClientTurnMeta,
  blockingLive: { _runningClientMessageId?: string; _persistActiveTurn?: unknown },
  makeStopKey: (peerId: string, cmid: string) => string,
): { kind: 'cmid'; runningCmid: string } | { kind: 'persist_only' } | null {
  const runningCmid = blockingLive._runningClientMessageId
  const hasActivePersist = Boolean(blockingLive._persistActiveTurn)
  if (runningCmid === clientMessageId) return null
  if (typeof runningCmid === 'string' && runningCmid.length > 0) {
    const runningMeta = host._admittedClientTurnMeta?.get(makeStopKey(peerId, runningCmid))
    const provenOlder =
      (runningMeta !== undefined && runningMeta.seq < meta.seq) ||
      (runningMeta === undefined && meta.runningCmidAtAdmission === runningCmid)
    return provenOlder ? { kind: 'cmid', runningCmid } : null
  }
  if (hasActivePersist && meta.hadActivePersistAtAdmission === true) {
    return { kind: 'persist_only' }
  }
  return null
}

async function tryInterruptProvenOlderBlockingTurn(
  host: WsConnectionHost,
  peerId: string,
  clientMessageId: string,
  targetSessionKey: string,
  meta: AdmittedClientTurnMeta | undefined,
  deps: PreStartStopDeps,
): Promise<{ interrupted: boolean; blockingClientMessageId?: string }> {
  const blockingLive = lookupLiveSessionForStop(host, targetSessionKey)
  if (!blockingLive || !meta) return { interrupted: false }
  const older = classifyOlderBlockingTurn(
    host,
    peerId,
    clientMessageId,
    meta,
    blockingLive,
    deps.preStartStopKey,
  )
  if (!older) return { interrupted: false }
  const blockingSelf =
    older.kind === 'cmid'
      ? host.sessions.interruptClientTurn(blockingLive.sessionKey, older.runningCmid)
      : host.sessions.interrupt(blockingLive.sessionKey, 'user')
  if (!blockingSelf) return { interrupted: false }
  const runningCmid = older.kind === 'cmid' ? older.runningCmid : undefined
  const blockingDelegates = host._interruptDelegationsForParent(blockingLive.sessionKey)
  const blockingSwarm = await deps.interruptRemoteSwarm(host, blockingLive.sessionKey, 'user_stop')
  host._settlePendingPermissionsForStop(blockingLive.sessionKey, runningCmid)
  return {
    interrupted: blockingSelf || blockingDelegates || blockingSwarm,
    blockingClientMessageId: runningCmid,
  }
}

export async function handlePreStartStop(
  host: WsConnectionHost,
  frame: HandleStopFrame,
  clientMessageId: string,
  admittedKey: string,
  safePeerId: string,
  suffix: string,
  deps: PreStartStopDeps,
): Promise<boolean> {
  host.sessions.fencePreStartStop(frame.peer.id, clientMessageId)
  const meta = host._admittedClientTurnMeta?.get(admittedKey)
  const targetSessionKey = resolveTargetSessionKeyForPreStart(meta, frame, safePeerId)

  let interruptedBlockingTurn = false
  let blockingClientMessageId: string | undefined

  if (targetSessionKey) {
    const targetAgentId = targetSessionKey.split(':')[1]
    if (!targetAgentId || !deps.isHiddenSystemAgentId(targetAgentId)) {
      if (meta) fenceEarlierSameSessionTurns(host, admittedKey, targetSessionKey, meta.seq)
      const outcome = await tryInterruptProvenOlderBlockingTurn(
        host,
        frame.peer.id,
        clientMessageId,
        targetSessionKey,
        meta,
        deps,
      )
      interruptedBlockingTurn = outcome.interrupted
      blockingClientMessageId = outcome.blockingClientMessageId
    }
  }

  host.log.info('interrupt', {
    sessionKey: targetSessionKey ?? `*${suffix}`,
    clientMessageId,
    ok: true,
    preStart: true,
    interruptedBlockingTurn,
    ...(blockingClientMessageId ? { blockingClientMessageId } : {}),
  })
  return true
}
