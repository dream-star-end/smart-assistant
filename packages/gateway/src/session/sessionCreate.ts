/**
 * Session creation/replacement helpers and runner lifecycle listeners
 * extracted from `_getOrCreateExclusive`.
 */
import {
  sameRemoteExecutionBackend,
  type RemoteExecutionBackend,
  type SessionWorkspaceMode,
} from '@openclaude/protocol'
import {
  hasPersistedTurnActivity,
  loadProjectContextAllowReadOnly,
  projectSessionFingerprint,
  skillOverlayManifestSha256,
  type IdentityCompatRuntimeContext,
} from '@openclaude/storage'
import { parseCc5ResumeId } from '../engine/cc5ResumeId.js'
import type { EngineAdapter } from '../engine/engineAdapter.js'
import { probeResumeArtifact } from '../engine/resumeArtifacts.js'
import { createEvent, eventBus } from '../eventBus.js'
import { normalizeEngineTag } from '../resumeStore.js'
import { reapEphemeralBgCommandsSafe } from '../sessionBgCommands.js'
import { resolveMigrationAwareStoredResume } from '../sessionCheckpointStore.js'
import { log } from '../sessionManagerLog.js'
import type { AgentSession } from '../sessionTypes.js'
import type { GetOrCreateOpts } from './types.js'

export async function computeSessionContextFingerprint(
  projectId: string | null | undefined,
  assetsRevision?: number,
): Promise<string> {
  const id = typeof projectId === 'string' ? projectId.trim() : ''
  if (!id) return projectSessionFingerprint({ projectId: null })
  try {
    const snap = await loadProjectContextAllowReadOnly(id)
    return projectSessionFingerprint({
      projectId: id,
      contextVersion: snap.version,
      assetsRevision,
      projectMdSha256:
        snap.meta.contentManifest?.projectMdSha256 ?? snap.meta.instructionsSha256 ?? null,
      skillManifestSha256: skillOverlayManifestSha256(snap.meta.contentManifest?.skills ?? []),
      officialMemoryManifestSha256: snap.meta.promotion.manifestSha256 ?? null,
    })
  } catch (err) {
    log.debug('project context fingerprint load failed; using base fingerprint', {
      projectId: id,
      err: String(err),
    })
    return projectSessionFingerprint({ projectId: id, assetsRevision })
  }
}

export function validateCreateModelSwitchGuard(
  existing: AgentSession | undefined,
  executionModel: string,
  modelSwitchId: string | undefined,
): void {
  if (!existing?._modelSwitchTransition) return
  const transition = existing._modelSwitchTransition
  if (
    transition.state === 'prepared' &&
    transition.expiresAt !== undefined &&
    Date.now() >= transition.expiresAt
  ) {
    if (executionModel === transition.sourceModel && modelSwitchId === undefined) {
      existing._modelSwitchTransition = undefined
    } else {
      throw new Error('MODEL_SWITCH_EXPIRED')
    }
  }
  const active = existing._modelSwitchTransition
  if (!active) return
  const matchesPreparedTarget =
    active.state === 'prepared' &&
    active.targetModel === executionModel &&
    modelSwitchId === active.id
  if (!matchesPreparedTarget) {
    throw new Error('MODEL_SWITCH_IN_PROGRESS')
  }
}

export function computeCanIdentityRefresh(args: {
  existing: AgentSession
  identityContext: IdentityCompatRuntimeContext
  opts: GetOrCreateOpts
  identityAgentFingerprint: string | undefined
  targetEngine: string
  executionModel: string
  cursorTransportChanged: boolean
  backendChanged: boolean
  workspaceModeChanged: boolean
  workspaceCwdChanged: boolean
  projectIdChanged: boolean
  workspaceMode: SessionWorkspaceMode
  resolveDefaultWorkspaceCwd: (mode: SessionWorkspaceMode, sessionId?: string) => string
}): boolean {
  const { existing, identityContext, opts } = args
  if (!identityContext.assets || !existing._identityCompat?.assets) return false
  if (
    JSON.stringify(identityContext.assets.profile) !==
    JSON.stringify(existing._identityCompat.assets.profile)
  ) {
    return false
  }
  const targetCwd =
    opts.workspaceCwd ??
    opts.agent.cwd ??
    args.resolveDefaultWorkspaceCwd(args.workspaceMode, opts.repoSessionId ?? opts.peerId)
  return (
    existing.agentId === opts.agent.id &&
    existing._identityAgentFingerprint !== args.identityAgentFingerprint &&
    existing.providerTag === args.targetEngine &&
    existing.model === args.executionModel &&
    !args.cursorTransportChanged &&
    !args.backendChanged &&
    !args.workspaceModeChanged &&
    !args.workspaceCwdChanged &&
    !args.projectIdChanged &&
    existing.workspaceCwd === targetCwd
  )
}

export async function resolveReplacementRebuildNotice(args: {
  existing: AgentSession
  sessionKey: string
  legacyId: string | undefined
  replacementNotice: NonNullable<AgentSession['_contextRebuildNotice']>
}): Promise<AgentSession['_contextRebuildNotice']> {
  const { existing, sessionKey, legacyId, replacementNotice } = args
  try {
    const ids = legacyId && legacyId !== sessionKey ? [sessionKey, legacyId] : [sessionKey]
    const hadPriorProviderState = existing.turns > 0 || (await hasPersistedTurnActivity(ids))
    return hadPriorProviderState ? replacementNotice : undefined
  } catch (historyErr) {
    log.warn(
      'session-replacement prior-turn read failed; preserving rebuild notice',
      { sessionKey, replacementNotice },
      historyErr,
    )
    return replacementNotice
  }
}

export async function shutdownReplacedSession(args: {
  existing: AgentSession
  sessionKey: string
  executionBackend: RemoteExecutionBackend | undefined
  identityRefreshSession: AgentSession | undefined
  engineChanged: boolean
  workspaceModeChanged: boolean
  deleteSessionIfCanonical: (sessionKey: string, expected: AgentSession) => void
}): Promise<void> {
  const { existing, sessionKey, executionBackend, identityRefreshSession } = args
  try {
    await existing.runner.shutdown()
    await reapEphemeralBgCommandsSafe(sessionKey, identityRefreshSession, log)
  } catch (err) {
    if (executionBackend || existing.runner.executionBackend) {
      existing._replacing = false
      throw err
    }
    if (identityRefreshSession) throw err
    log.warn(
      'session-replacement shutdown failed',
      {
        sessionKey,
        engineChanged: args.engineChanged,
        workspaceModeChanged: args.workspaceModeChanged,
      },
      err,
    )
  }
  if (!identityRefreshSession) {
    args.deleteSessionIfCanonical(sessionKey, existing)
  }
}

export function resolveMappedResumeForCreate(args: {
  opts: GetOrCreateOpts
  targetEngine: string
  cwd: string
  repoSessionId: string | undefined
  executionBackend: RemoteExecutionBackend | undefined
  hasAuthorizedMigration: boolean
  storedResumeId: string | undefined
  storedResumeProvider: string | undefined
  parseRemoteV4ResumeId: (id: string | null | undefined) => { bindingId: string } | null | undefined
  forgetResumeEntry: (sessionKey: string) => void
  saveResumeMap: () => void
  resumeIdFor: (sessionKey: string, wantProvider: string, workspacePath?: string) => string | undefined
  cursorWorkspacePath: (agentBaseDir: string, repoSessionId?: string, projectBound?: boolean) => string
}): { mappedResumeId: string | undefined; hadSameProviderResume: boolean } {
  const { opts, targetEngine, executionBackend } = args
  const { effectiveStoredResumeId: storedResumeForCreate, clearStaleResume } =
    resolveMigrationAwareStoredResume({
      storedResumeId: args.storedResumeId,
      executionBackend,
      hasAuthorizedMigration: args.hasAuthorizedMigration,
    })
  if (clearStaleResume) {
    args.forgetResumeEntry(opts.sessionKey)
    args.saveResumeMap()
  }
  const normalizedStoredProvider = normalizeEngineTag(args.storedResumeProvider)
  const hadSameProviderResume =
    Boolean(storedResumeForCreate) && normalizedStoredProvider === targetEngine
  if (opts.hermeticNoTools) {
    return { mappedResumeId: undefined, hadSameProviderResume }
  }
  if (executionBackend?.kind === 'cc5-interactive-v1') {
    const match =
      storedResumeForCreate &&
      parseCc5ResumeId(storedResumeForCreate)?.bindingId === executionBackend.operationId
    return { mappedResumeId: match ? storedResumeForCreate : undefined, hadSameProviderResume }
  }
  if (executionBackend?.kind === 'remote-driver-v4') {
    const match =
      storedResumeForCreate &&
      args.parseRemoteV4ResumeId(storedResumeForCreate)?.bindingId === executionBackend.operationId
    return { mappedResumeId: match ? storedResumeForCreate : undefined, hadSameProviderResume }
  }
  if (executionBackend) {
    return {
      mappedResumeId: normalizedStoredProvider === 'codex' ? storedResumeForCreate : undefined,
      hadSameProviderResume,
    }
  }
  const mappedResumeId = args.resumeIdFor(
    opts.sessionKey,
    targetEngine,
    args.cursorWorkspacePath(args.cwd, args.repoSessionId, Boolean(opts.projectId)),
  )
  return { mappedResumeId, hadSameProviderResume }
}

export interface RunnerListenerDeps {
  sessionKey: string
  targetEngine: string
  getResumeMapId: (sessionKey: string) => string | undefined
  setResumeMapId: (sessionKey: string, id: string) => void
  getResumeMapProvider: (sessionKey: string) => string | undefined
  setResumeMapProvider: (sessionKey: string, tag: string) => void
  deleteResumeMapHistory: (sessionKey: string) => void
  pushResumeHistory: (sessionKey: string, prev: string) => void
  getPromotedResumeHead: (sessionKey: string) => string | undefined
  deletePromotedResumeHead: (sessionKey: string) => void
  markResumeRejected: (sessionKey: string, id: string | null | undefined) => void
  resolveDurableResumeId: (
    sessionKey: string,
    tag: string,
    head: string | undefined,
    workspacePath?: string,
    opts?: { exclude?: string; syncRunner?: boolean },
  ) => string | undefined
  forgetResumeEntry: (sessionKey: string) => void
  saveResumeMap: () => void
  cursorWorkspacePathForSession: (session: AgentSession) => string | undefined
  onCcbTaskNotification?: (
    session: AgentSession,
    payload: {
      taskId: string
      status: string
      outputFile: string
      summary: string
      toolUseId?: string
    },
  ) => void
  onCcbTaskNotificationDelivered?: (
    session: AgentSession,
    payload: { taskId: string; deliveredBy: 'ccb-mid-turn' },
  ) => void
}

function handleRunnerSessionId(
  session: AgentSession,
  runner: EngineAdapter,
  id: string,
  deps: RunnerListenerDeps,
): void {
  if (session.runner !== runner) return
  const prevId = session.ccbSessionId ?? deps.getResumeMapId(deps.sessionKey)
  const prevProv = normalizeEngineTag(deps.getResumeMapProvider(deps.sessionKey))
  if (prevId && prevId !== id) {
    if (prevProv !== deps.targetEngine) {
      deps.deleteResumeMapHistory(deps.sessionKey)
    } else if (
      probeResumeArtifact(deps.targetEngine, prevId, {
        workspacePath: deps.cursorWorkspacePathForSession(session),
      }).exists
    ) {
      deps.pushResumeHistory(deps.sessionKey, prevId)
    }
  }
  if (deps.getPromotedResumeHead(deps.sessionKey) !== id) {
    deps.deletePromotedResumeHead(deps.sessionKey)
  }
  session.ccbSessionId = id
  deps.setResumeMapProvider(deps.sessionKey, deps.targetEngine)
  deps.saveResumeMap()
}

function handleRunnerExit(
  session: AgentSession,
  runner: EngineAdapter,
  info: { code: number | null; signal: string | null; crashed: boolean },
  deps: RunnerListenerDeps,
): void {
  if (session.runner !== runner) return
  session.currentTurnStatus = null
  if (!info.crashed) return
  log.warn('subprocess crashed', {
    sessionKey: deps.sessionKey,
    code: info.code,
    signal: info.signal,
  })
  if (session._pendingStaleResumeClear) {
    session._pendingStaleResumeClear = false
    const staleId = session.ccbSessionId ?? deps.getResumeMapId(deps.sessionKey)
    deps.markResumeRejected(deps.sessionKey, staleId)
    const promoted = session.runner.setResumeSessionId
      ? deps.resolveDurableResumeId(
          deps.sessionKey,
          deps.targetEngine,
          undefined,
          deps.cursorWorkspacePathForSession(session),
          { exclude: staleId ?? undefined },
        )
      : undefined
    if (!promoted || promoted === staleId) {
      deps.forgetResumeEntry(deps.sessionKey)
      session.ccbSessionId = null
      session.runner.clearSessionId?.()
      deps.saveResumeMap()
    }
  } else if (session.ccbSessionId) {
    deps.setResumeMapId(deps.sessionKey, session.ccbSessionId)
    deps.saveResumeMap()
  }
  eventBus.emit(
    'session.crashed',
    createEvent('session.crashed', session.agentId, {
      sessionKey: deps.sessionKey,
      peerId: session.peerId,
      ccbSessionId: session.ccbSessionId,
    }),
  )
}

export function attachSessionRunnerListeners(
  session: AgentSession,
  runner: EngineAdapter,
  deps: RunnerListenerDeps,
): void {
  runner.on(
    'task_notification',
    (payload: {
      taskId: string
      status: string
      outputFile: string
      summary: string
      toolUseId?: string
    }) => {
      if (session.runner !== runner) return
      deps.onCcbTaskNotification?.(session, payload)
    },
  )
  runner.on(
    'task_notification_delivered',
    (payload: { taskId: string; deliveredBy: 'ccb-mid-turn' }) => {
      if (session.runner !== runner) return
      deps.onCcbTaskNotificationDelivered?.(session, payload)
    },
  )
  runner.on('session_id', (id: string) => handleRunnerSessionId(session, runner, id, deps))
  runner.on('spawn', (info: { resumed: boolean }) => {
    if (session.runner !== runner) return
    if (!info.resumed) session._lastCcbCumulativeCost = 0
  })
  runner.on('exit', (info: { code: number | null; signal: string | null; crashed: boolean }) =>
    handleRunnerExit(session, runner, info, deps),
  )
}

export function needsSessionReplacement(args: {
  session: AgentSession
  opts: GetOrCreateOpts
  identityAgentFingerprint: string | undefined
  desiredEngine: string
  executionModel: string
  executionBackend: RemoteExecutionBackend | undefined
  workspaceMode: SessionWorkspaceMode
}): {
  needsReplace: boolean
  cursorTransportChanged: boolean
  backendChanged: boolean
  workspaceModeChanged: boolean
  workspaceCwdChanged: boolean
  projectIdChanged: boolean
} {
  const { session, opts, desiredEngine, executionModel, executionBackend, workspaceMode } = args
  const cursorTransportChanged = Boolean(
    (opts.model !== undefined || opts.executionAuthority !== undefined) &&
      session.runner.requiresReopenForModel?.(executionModel),
  )
  const backendChanged = !sameRemoteExecutionBackend(
    session.runner.executionBackend,
    executionBackend,
  )
  const workspaceModeChanged =
    opts.workspaceMode !== undefined && session.workspaceMode !== workspaceMode
  const workspaceCwdChanged =
    opts.workspaceCwd !== undefined && session.workspaceCwd !== opts.workspaceCwd
  const projectIdChanged =
    opts.projectId !== undefined && (session.projectId ?? null) !== (opts.projectId ?? null)
  const needsReplace =
    session.agentId !== opts.agent.id ||
    session._identityAgentFingerprint !== args.identityAgentFingerprint ||
    session.providerTag !== desiredEngine ||
    cursorTransportChanged ||
    backendChanged ||
    workspaceModeChanged ||
    workspaceCwdChanged ||
    projectIdChanged
  return {
    needsReplace,
    cursorTransportChanged,
    backendChanged,
    workspaceModeChanged,
    workspaceCwdChanged,
    projectIdChanged,
  }
}
