import { modelHistorySemanticRole, modelHistorySemanticText } from '@openclaude/protocol'
import type { MessageLike } from '@openclaude/storage'
import { captureCompactionOriginal } from './compactionArchive.js'
import {
  attachCompactionRecoveryContext,
  renderCompactionRecoveryContext,
  type OriginalUserInstruction,
} from './compactionContract.js'
import { personalCompactionEnabled, type CompactionActiveTask } from './compactionTasks.js'
import type { HistoricalTurnInput } from './historicalContextPayload.js'
import type { AgentSession } from './sessionTypes.js'
import type { EngineEvent, PartialSnapshot } from './engine/engineEvents.js'
import { log } from './sessionManagerLog.js'

/** Longest the first turn after a compaction waits for a capture still in flight. */
export const COMPACTION_SOURCE_WAIT_MS = 10_000

export interface CompactionRecoverySources {
  archiveId: string
  userInstructions: OriginalUserInstruction[]
  plan?: unknown
}

const enabledFor = (session: AgentSession): boolean =>
  personalCompactionEnabled() && session.channel === 'webchat'

function sourcesFrom(timeline: readonly MessageLike[], archiveId: string, currentInput?: string): CompactionRecoverySources {
  const userInstructions = timeline.filter(message => modelHistorySemanticRole(message) === 'user')
    .map((message, index) => ({
      id: typeof message.id === 'string' ? message.id : `source-${index}`,
      text: modelHistorySemanticText(message),
      ...(typeof message._seq === 'number' ? { orderSeq: message._seq } : {}),
    }))
  // The compacting turn's own request may not be persisted yet.
  if (currentInput && userInstructions.at(-1)?.text !== currentInput) {
    userInstructions.push({ id: 'compacting-turn-input', text: currentInput })
  }
  return { archiveId, userInstructions, plan: timeline.filter(message => message.role === 'plan').at(-1) }
}

/** Best effort and off the send path: a failure is logged and never reaches the user. */
function startCapture(session: AgentSession, trigger: string, partial?: PartialSnapshot): void {
  const currentInput = session.currentUserText
  const traceId = session._currentTurnTraceId
  const promise = captureCompactionOriginal({
    ownerUserId: session.userId ?? 'default', sessionId: session.peerId, sessionKey: session.sessionKey,
    traceId, trigger, currentInput, partial, allowMissingTimeline: session.turns === 0,
  }).then(({ manifest, timeline }) => sourcesFrom(timeline, manifest.archiveId, currentInput), (error: unknown) => {
    log.warn('compaction original capture failed; user turns are unaffected', {
      sessionKey: session.sessionKey, traceId, trigger,
      code: error instanceof Error ? error.message : String(error),
    })
    return null
  })
  const capture = { promise, done: false }
  session._compactionCapture = capture
  void promise.then(() => { capture.done = true })
}

/** A compaction boundary: the next dispatch carries the recovery contract and
 * the platform originals are retained in the background. Never throws. */
export function noteCompactionBoundary(session: AgentSession, trigger: string, partial?: PartialSnapshot): void {
  if (!enabledFor(session)) return
  session._compactionEpoch = (session._compactionEpoch ?? 0) + 1
  if (session._compactionCapture && !session._compactionCapture.done) return
  startCapture(session, trigger, partial)
}

export function observeCompactionOriginal(
  session: AgentSession, event: EngineEvent, snapshot: () => PartialSnapshot | undefined,
): void {
  if (event.kind === 'turn_status' && event.status === 'compacting') {
    noteCompactionBoundary(session, 'compacting', snapshot())
  } else if (event.kind === 'context_compacted' && event.compaction.strategy !== 'file_reference') {
    // file_reference keeps every byte in a file; it drops nothing to recover.
    noteCompactionBoundary(session, `context_compacted:${event.compaction.strategy}`, snapshot())
  }
}

/** Under the session lock, once per logical turn. Returns a dispatch wrapper
 * only for the first turn after an observed compaction. Never rejects. */
export async function prepareCompactionRecovery(
  session: AgentSession,
  readTasks: () => readonly CompactionActiveTask[],
): Promise<((input: HistoricalTurnInput) => HistoricalTurnInput) | undefined> {
  if (!enabledFor(session)) return undefined
  const epoch = session._compactionEpoch ?? 0
  if (epoch <= (session._compactionRecoveredEpoch ?? 0)) return undefined
  session._compactionRecoveredEpoch = epoch
  // An in-turn capture can race a mutating timeline; retry once now that the turn is over.
  if (!session._compactionCapture || (session._compactionCapture.done && !(await session._compactionCapture.promise))) {
    startCapture(session, 'next_turn')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const sources = await Promise.race([
    session._compactionCapture!.promise,
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), COMPACTION_SOURCE_WAIT_MS) }),
  ])
  clearTimeout(timer)
  if (!sources) {
    log.warn('compaction recovery dispatches without original user turns', {
      sessionKey: session.sessionKey, traceId: session._currentTurnTraceId,
    })
  }
  // Antigravity budgets its complete stdin envelope and can externalize the
  // current input itself; other engines fit the recovery into their argv cap.
  const maxBytes = session.providerTag === 'antigravity' ? undefined : session.runner.capabilities.maxPromptBytes
  return (input: HistoricalTurnInput): HistoricalTurnInput => {
    const context = renderCompactionRecoveryContext({
      userInstructions: sources?.userInstructions ?? null, archiveId: sources?.archiveId,
      plan: sources?.plan, goal: session._platformGoal, activeTasks: readTasks(),
    })
    const attached = attachCompactionRecoveryContext(input, context, maxBytes)
    if (!attached) {
      log.warn('compaction recovery does not fit the transport budget; dispatching the original input', {
        sessionKey: session.sessionKey, traceId: session._currentTurnTraceId,
      })
    }
    return attached ?? input
  }
}
