/**
 * Submit-path history merging, provider resume resolution, native model handoff,
 * rolling checkpoint injection, and fallback historical context injection.
 */
import {
  collectModelHistoryMediaPathHints,
  modelHistorySemanticRole,
  modelHistorySemanticText,
} from '@openclaude/protocol'
import { getEngineContextMessages } from '@openclaude/storage'
import { isCc5ResumeId, parseCc5ResumeId } from '../engine/cc5ResumeId.js'
import {
  cursorSandBoxCcResumeInnerId,
  cursorSandOfficialCcResumeInnerId,
  cursorSandResumeInnerId,
  usableCursorResumeId,
} from '../engine/cursorAdapter.js'
import { isCcbSlashCommandPrompt } from '../ccbNativeCompaction.js'
import {
  applyPendingCheckpointToSession,
  beginCheckpointTurnOutcome,
  peekPendingCheckpoint,
  type PersistedCheckpointRecord,
} from '../sessionCheckpointStore.js'
import { log } from '../sessionManagerLog.js'
import type { AgentSession } from '../sessionTypes.js'
import {
  buildNativeModelHandoffPayload,
  buildRollingCheckpointPayload,
  historicalContextInjectionKey,
  normForCompare,
  providerGapMessagesAfterOwnTurn,
  shouldAttemptHistoricalContextInjection,
  shouldEmitContextRebuilt,
} from './historyContext.js'
import type {
  ChatHistoryMessage,
  PendingExternalExchange,
  SubmitOpts,
  TurnUserInput,
} from './types.js'

export interface SubmitContextPrepDeps {
  isRemoteV4ResumeId: (id: string | null | undefined) => boolean
  parseRemoteV4ResumeId: (id: string | null | undefined) => { bindingId: string } | null | undefined
  buildHistoricalContextPrompt: (
    messages: unknown[],
    currentUserText: string,
    maxHistoryChars?: number,
  ) => string | null
  buildHistoricalContextPayload: (
    messages: unknown[],
    userTextOrBlocks: TurnUserInput,
    maxPromptBytes?: number,
  ) => TurnUserInput | null
  prepareEfficiencyTurnNote: (session: AgentSession, userText: string) => Promise<string | null>
  getResumeMapId: (sessionKey: string) => string | undefined
  getResumeHeadPromotedFromHistory: (sessionKey: string) => string | undefined
  forgetResumeEntry: (sessionKey: string) => void
  saveResumeMap: () => void
  awaitResumeMapFlush: () => Promise<void>
  cursorWorkspacePathForSession: (session: AgentSession) => string | undefined
  ccbJsonlExists: (resumeId: string) => boolean
  resumeIdFor: (sessionKey: string, wantProvider: string, workspacePath?: string) => string | undefined
}

export function extractHistoryText(msg: ChatHistoryMessage): string {
  if (typeof msg.text === 'string') return msg.text
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export function mergePendingExternalHistory(
  session: AgentSession,
  messages: unknown[],
): unknown[] {
  const pending = session._pendingExternalExchanges
  if (!pending?.length) return messages
  const ids = new Set(
    messages
      .filter(
        (raw): raw is { id: string } =>
          !!raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string',
      )
      .map((raw) => raw.id),
  )
  const remaining: PendingExternalExchange[] = []
  const merged = [...messages]
  for (const exchange of pending) {
    if (ids.has(exchange.assistant.id)) continue
    remaining.push(exchange)
    const hasEquivalentUser = merged.some((raw) => {
      if (!raw || typeof raw !== 'object') return false
      const msg = raw as ChatHistoryMessage
      return (
        msg.role === 'user' &&
        normForCompare(extractHistoryText(msg)) === normForCompare(exchange.user.text)
      )
    })
    if (!hasEquivalentUser && !ids.has(exchange.user.id)) merged.push(exchange.user)
    merged.push(exchange.assistant)
    ids.add(exchange.assistant.id)
  }
  session._pendingExternalExchanges = remaining.length > 0 ? remaining : undefined
  return merged
}

export function buildContextOverflowRetryInputs(
  effectiveMasterHistoricalMessages: unknown[] | null,
  userTextOrBlocks: TurnUserInput,
  buildPrompt: SubmitContextPrepDeps['buildHistoricalContextPrompt'],
): string[] {
  if (!effectiveMasterHistoricalMessages || typeof userTextOrBlocks !== 'string') return []
  const totalChars = effectiveMasterHistoricalMessages.reduce<number>((total, raw) => {
    if (!raw || typeof raw !== 'object') return total
    const msg = raw as ChatHistoryMessage
    if (msg.system === true || !modelHistorySemanticRole(msg)) return total
    return total + modelHistorySemanticText(msg).length
  }, 0)
  if (totalChars <= 0) return []
  return [4, 16, 64]
    .map((divisor) =>
      buildPrompt(
        effectiveMasterHistoricalMessages,
        userTextOrBlocks,
        Math.max(1, Math.ceil(totalChars / divisor)),
      ),
    )
    .filter((prompt): prompt is string => prompt !== null)
}

function resolveBoundResumeIds(
  session: AgentSession,
  deps: SubmitContextPrepDeps,
): { liveCc5ResumeId: string | undefined; isAnyBoundResume: (id: string | null | undefined) => boolean } {
  const liveNativeId = session.runner.nativeSessionId
  const storedCc5Resume = deps.getResumeMapId(session.sessionKey)
  const parseBoundResume = (id: string | null | undefined) =>
    session.runner.executionBackend?.kind === 'remote-driver-v4'
      ? deps.parseRemoteV4ResumeId(id)
      : parseCc5ResumeId(id)
  const isAnyBoundResume = (id: string | null | undefined) =>
    isCc5ResumeId(id) || deps.isRemoteV4ResumeId(id)
  const backend = session.runner.executionBackend
  if (
    backend &&
    ((isAnyBoundResume(liveNativeId) && parseBoundResume(liveNativeId)?.bindingId !== backend.operationId) ||
      (isAnyBoundResume(storedCc5Resume) &&
        parseBoundResume(storedCc5Resume)?.bindingId !== backend.operationId))
  ) {
    throw new Error('CC5_TEST_REMOTE_RESUME_UNSUPPORTED')
  }
  if (!backend) return { liveCc5ResumeId: undefined, isAnyBoundResume }
  const liveMatch =
    liveNativeId && parseBoundResume(liveNativeId)?.bindingId === backend.operationId
      ? liveNativeId
      : undefined
  const storedMatch =
    storedCc5Resume && parseBoundResume(storedCc5Resume)?.bindingId === backend.operationId
      ? storedCc5Resume
      : undefined
  return { liveCc5ResumeId: liveMatch ?? storedMatch, isAnyBoundResume }
}

function resolveCursorResumeCandidate(
  session: AgentSession,
  spawnCwd: string | undefined,
  isAnyBoundResume: (id: string | null | undefined) => boolean,
  deps: SubmitContextPrepDeps,
): string | undefined {
  if (session.providerTag !== 'cursor') return undefined
  const liveNativeId = session.runner.nativeSessionId
  if (cursorSandBoxCcResumeInnerId(liveNativeId)) return liveNativeId ?? undefined
  const liveSandJsonlId =
    cursorSandResumeInnerId(liveNativeId) ?? cursorSandOfficialCcResumeInnerId(liveNativeId)
  if (liveSandJsonlId && deps.ccbJsonlExists(liveSandJsonlId)) return liveNativeId ?? undefined
  const mappedRaw = deps.getResumeMapId(session.sessionKey)
  return usableCursorResumeId({
    workspacePath: spawnCwd,
    liveId: liveNativeId,
    mappedId: isAnyBoundResume(mappedRaw) ? undefined : mappedRaw,
  })
}

async function resolveProviderResumeAndGap(args: {
  session: AgentSession
  opts: SubmitOpts | undefined
  effectiveMasterHistoricalMessages: unknown[] | null
  deps: SubmitContextPrepDeps
}): Promise<{
  providerResumeId: string | undefined
  injectionKey: string | null
  providerGapDelta: unknown[] | null
}> {
  const { session, opts, effectiveMasterHistoricalMessages, deps } = args
  if (opts?.resetNativeSession === true && session.providerTag === 'grok') {
    await session.runner.shutdown()
    deps.forgetResumeEntry(session.sessionKey)
    session.ccbSessionId = null
    session.runner.clearSessionId()
    deps.saveResumeMap()
    await deps.awaitResumeMapFlush()
    session._historicalContextInjected = false
    session._historicalContextInjectedKey = undefined
    session._contextRebuildNotice = 'native-resume-loss'
    log.warn('automatic recovery reset poisoned Grok native session', {
      sessionKey: session.sessionKey,
    })
  }
  const spawnCwd = deps.cursorWorkspacePathForSession(session)
  const { liveCc5ResumeId, isAnyBoundResume } = resolveBoundResumeIds(session, deps)
  const usableCursorId = resolveCursorResumeCandidate(session, spawnCwd, isAnyBoundResume, deps)
  let providerResumeId =
    liveCc5ResumeId ??
    usableCursorId ??
    deps.resumeIdFor(session.sessionKey, session.providerTag, spawnCwd)
  if (
    providerResumeId &&
    session.runner.isResumeIdCompatible &&
    !session.runner.isResumeIdCompatible(providerResumeId)
  ) {
    log.info('native resume belongs to a different engine transport — rebuilding bounded history', {
      sessionKey: session.sessionKey,
      provider: session.providerTag,
    })
    session._forceHistoricalContextOnFirstTurn = true
    session._contextRebuildNotice ??= 'native-resume-loss'
    providerResumeId = undefined
  }
  if (session._forceHistoricalContextOnFirstTurn) providerResumeId = undefined
  const injectionKey = historicalContextInjectionKey({
    messages: effectiveMasterHistoricalMessages,
    peerId: session.peerId,
    agentId: session.agentId,
    hasProviderResumeId: !!providerResumeId,
  })
  const providerGapDelta =
    providerResumeId &&
    injectionKey !== null &&
    effectiveMasterHistoricalMessages &&
    deps.getResumeHeadPromotedFromHistory(session.sessionKey) !== providerResumeId
      ? providerGapMessagesAfterOwnTurn({
          messages: effectiveMasterHistoricalMessages,
          peerId: session.peerId,
          agentId: session.agentId,
        })
      : null
  if (providerGapDelta) {
    log.info('master history gap kept native resume; injecting missing rows only', {
      sessionKey: session.sessionKey,
      provider: session.providerTag,
      injectionKey,
      missingCount: providerGapDelta.length,
    })
  } else if (providerResumeId && injectionKey !== null && !session.runner.executionBackend) {
    log.warn('master history gap invalidated native resume before context rebuild', {
      sessionKey: session.sessionKey,
      provider: session.providerTag,
      injectionKey,
    })
    await session.runner.shutdown()
    deps.forgetResumeEntry(session.sessionKey)
    session.ccbSessionId = null
    session.runner.clearSessionId?.()
    deps.saveResumeMap()
    session._historicalContextInjected = false
    session._historicalContextInjectedKey = undefined
    session._contextRebuildNotice = 'native-resume-loss'
    providerResumeId = undefined
  }
  if (providerResumeId) session._contextRebuildNoticeSent = false
  return { providerResumeId, injectionKey, providerGapDelta }
}

async function loadLocalEngineContextMessages(
  session: AgentSession,
  opts: SubmitOpts | undefined,
): Promise<unknown[]> {
  return mergePendingExternalHistory(
    session,
    (await getEngineContextMessages(session.peerId, session.userId ?? 'default', {
      contextWindow:
        opts?.modelAuthority?.executionDescriptor.contextWindow ??
        (session.providerTag === 'codex' ? null : undefined),
      engine: session.providerTag,
      currentUserText: session.currentUserText ?? '',
      ...(opts?.replayLifecycle?.clientMessageId
        ? { excludeClientMessageId: opts.replayLifecycle.clientMessageId }
        : {}),
    })) ?? [],
  )
}

async function applyNativeHandoffIfNeeded(args: {
  session: AgentSession
  userTextOrBlocks: TurnUserInput
  opts: SubmitOpts | undefined
  effectiveMasterHistoricalMessages: unknown[] | null
  nativeHandoff: NonNullable<AgentSession['_modelSwitchTransition']>
}): Promise<TurnUserInput> {
  const { session, userTextOrBlocks, opts, nativeHandoff } = args
  let historyForMedia = args.effectiveMasterHistoricalMessages
  if (!historyForMedia) {
    try {
      historyForMedia = await loadLocalEngineContextMessages(session, opts)
    } catch (err) {
      log.debug('native handoff media history load failed', { sessionKey: session.sessionKey, err: String(err) })
      historyForMedia = []
    }
  }
  const mediaPathHints = collectModelHistoryMediaPathHints(
    historyForMedia,
    nativeHandoff.summaryText ?? '',
  )
  const payload = buildNativeModelHandoffPayload(
    nativeHandoff.summaryText!,
    userTextOrBlocks,
    mediaPathHints,
  )
  nativeHandoff.summaryInjected = true
  session._historicalContextInjected = true
  session._historicalContextInjectedKey = `native-switch:${nativeHandoff.id}`
  session._contextRebuildNotice = undefined
  session._forceHistoricalContextOnFirstTurn = false
  return payload
}

async function tryInjectFallbackHistoricalContext(args: {
  session: AgentSession
  userTextOrBlocks: TurnUserInput
  opts: SubmitOpts | undefined
  masterHistoricalMessages: unknown[] | null
  effectiveMasterHistoricalMessages: unknown[] | null
  providerResumeId: string | undefined
  injectionKey: string | null
  providerGapDelta: unknown[] | null
  deps: SubmitContextPrepDeps
}): Promise<TurnUserInput | null> {
  const { session, userTextOrBlocks, opts, providerGapDelta, injectionKey, deps } = args
  try {
    const historyMessages =
      providerGapDelta ??
      args.effectiveMasterHistoricalMessages ??
      (await loadLocalEngineContextMessages(session, opts))
    const hasHistoricalContextRows = historyMessages
      ? deps.buildHistoricalContextPayload(historyMessages, userTextOrBlocks) !== null
      : false
    const historicalPrompt = historyMessages
      ? deps.buildHistoricalContextPayload(
          historyMessages,
          userTextOrBlocks,
          session.runner.capabilities.maxPromptBytes,
        )
      : null
    if (!historicalPrompt) {
      if (!hasHistoricalContextRows) {
        session._contextRebuildNotice = undefined
        session._forceHistoricalContextOnFirstTurn = false
      }
      return null
    }
    session._historicalContextInjected = true
    session._historicalContextInjectedKey = injectionKey ?? 'local:no-provider-resume'
    const injectedCount = Array.isArray(historyMessages) ? historyMessages.length : 0
    log.info('injected historical context for provider switch / non-native resume', {
      sessionKey: session.sessionKey,
      provider: session.providerTag,
      source: args.masterHistoricalMessages ? 'master-frame' : 'local-storage',
      mode: providerGapDelta ? 'gap-delta-on-native-resume' : 'full-rebuild',
      injectionKey: session._historicalContextInjectedKey,
      messageCount: injectedCount,
    })
    const shouldNotifyContextRebuilt =
      !providerGapDelta &&
      shouldEmitContextRebuilt({
        historyMode: session.runner.capabilities.historyMode,
        reason: session._contextRebuildNotice,
        alreadyNotified: session._contextRebuildNoticeSent,
      })
    if (shouldNotifyContextRebuilt && opts?.emitContextRebuilt) {
      try {
        opts.emitContextRebuilt({
          messageCount: injectedCount,
          reason: session._contextRebuildNotice ?? 'native-resume-loss',
        })
        session._contextRebuildNoticeSent = true
      } catch (emitErr) {
        log.warn('emit sys.context_rebuilt failed', { sessionKey: session.sessionKey }, emitErr)
      }
    }
    session._contextRebuildNotice = undefined
    session._forceHistoricalContextOnFirstTurn = false
    return historicalPrompt
  } catch (err) {
    log.warn('historical context injection failed', { sessionKey: session.sessionKey }, err)
    return null
  }
}

async function prependEfficiencyNoteIfEligible(
  session: AgentSession,
  runnerPayload: TurnUserInput,
  opts: SubmitOpts | undefined,
  deps: SubmitContextPrepDeps,
): Promise<TurnUserInput> {
  const skipPromptRewrite =
    opts?.modelSwitchInternal !== undefined || isCcbSlashCommandPrompt(runnerPayload)
  if (skipPromptRewrite) return runnerPayload
  try {
    const efficiencyNote = await deps.prepareEfficiencyTurnNote(
      session,
      session.currentUserText ?? '',
    )
    if (efficiencyNote && typeof runnerPayload === 'string') {
      return `${efficiencyNote}\n\n${runnerPayload}`
    }
  } catch (err) {
    log.debug('efficiency guard prepare failed', {
      sessionKey: session.sessionKey,
      err: String(err),
    })
  }
  return runnerPayload
}

function selectActiveNativeHandoff(
  session: AgentSession,
  consumingModelSwitch: boolean,
  transition: AgentSession['_modelSwitchTransition'],
): NonNullable<AgentSession['_modelSwitchTransition']> | null {
  if (
    consumingModelSwitch &&
    transition &&
    transition.sourceEngine !== session.providerTag &&
    transition.summaryText &&
    transition.summaryInjected !== true
  ) {
    return transition
  }
  return null
}

export async function prepareSubmitRunnerPayload(args: {
  session: AgentSession
  userTextOrBlocks: TurnUserInput
  opts: SubmitOpts | undefined
  consumingModelSwitch: boolean
  transition: AgentSession['_modelSwitchTransition']
  deps: SubmitContextPrepDeps
}): Promise<{
  runnerPayload: TurnUserInput
  pendingCheckpoint: PersistedCheckpointRecord | null
  effectiveMasterHistoricalMessages: unknown[] | null
  contextOverflowRetryInputs: string[]
}> {
  const { session, userTextOrBlocks, opts, consumingModelSwitch, transition, deps } = args
  let runnerPayload = await prependEfficiencyNoteIfEligible(session, userTextOrBlocks, opts, deps)
  const masterHistoricalMessages = Array.isArray(opts?.historicalMessages)
    ? opts.historicalMessages
    : null
  const effectiveMasterHistoricalMessages = masterHistoricalMessages
    ? mergePendingExternalHistory(session, masterHistoricalMessages)
    : null
  const contextOverflowRetryInputs = buildContextOverflowRetryInputs(
    effectiveMasterHistoricalMessages,
    userTextOrBlocks,
    deps.buildHistoricalContextPrompt,
  )
  const { providerResumeId, injectionKey, providerGapDelta } = await resolveProviderResumeAndGap({
    session, opts, effectiveMasterHistoricalMessages, deps,
  })
  const allowContextInjection =
    opts?.modelSwitchInternal === undefined && !isCcbSlashCommandPrompt(userTextOrBlocks)
  const nativeHandoff = selectActiveNativeHandoff(session, consumingModelSwitch, transition)
  if (nativeHandoff) {
    runnerPayload = await applyNativeHandoffIfNeeded({
      session, userTextOrBlocks, opts, effectiveMasterHistoricalMessages, nativeHandoff,
    })
  }
  const pendingCheckpoint =
    !nativeHandoff && allowContextInjection ? peekPendingCheckpoint(session.sessionKey) : null
  if (pendingCheckpoint) {
    beginCheckpointTurnOutcome(session)
    runnerPayload = applyPendingCheckpointToSession(
      session, pendingCheckpoint, buildRollingCheckpointPayload, userTextOrBlocks,
    )
  }
  if (
    !nativeHandoff &&
    !pendingCheckpoint &&
    allowContextInjection &&
    shouldAttemptHistoricalContextInjection({
      alreadyInjected: session._historicalContextInjected,
      lastInjectedKey: session._historicalContextInjectedKey,
      injectionKey,
      channel: session.channel,
      userTextOrBlocks,
      hasProviderResumeId: !!providerResumeId,
    })
  ) {
    const injected = await tryInjectFallbackHistoricalContext({
      session, userTextOrBlocks, opts, masterHistoricalMessages,
      effectiveMasterHistoricalMessages, providerResumeId, injectionKey, providerGapDelta, deps,
    })
    if (injected) runnerPayload = injected
  }
  if (session.turns === 0 && session.currentUserText) {
    const title = session.currentUserText.slice(0, 50).replace(/\s+/g, ' ').trim()
    if (title) session.title = title
  }
  return {
    runnerPayload,
    pendingCheckpoint,
    effectiveMasterHistoricalMessages,
    contextOverflowRetryInputs,
  }
}
