import { modelHistorySemanticRole, modelHistorySemanticText, type PromptPrivacyPolicy } from '@openclaude/protocol'
import { captureCompactionOriginal, appendCompactionTurnOriginal } from './compactionArchive.js'
import { attachCompactionRecoveryContext, buildCompactionRecoveryContext } from './compactionContract.js'
import { personalCompactionEnabled, type CompactionActiveTask } from './compactionTasks.js'
import type { HistoricalTurnInput } from './historicalContextPayload.js'
import type { AgentSession } from './sessionTypes.js'
import type { EngineEvent, PartialSnapshot } from './engine/engineEvents.js'
import { log } from './sessionManagerLog.js'

export async function prepareCompactionTurn(
  session: AgentSession,
  originalInput: HistoricalTurnInput,
  policy: PromptPrivacyPolicy | undefined,
  tasks: readonly CompactionActiveTask[] = [],
) {
  if (!personalCompactionEnabled() || session.channel !== 'webchat') return null
  const activeTasks = [...tasks, ...(session._compactionPendingTools?.values() ?? [])]
  const agent = session._identityCreationOpts?.agent
  const captured = await captureCompactionOriginal({
    ownerUserId: session.userId ?? 'default', sessionId: session.peerId,
    sessionKey: session.sessionKey, traceId: session._currentTurnTraceId,
    currentInput: originalInput, activeIds: activeTasks, allowMissingTimeline: session.turns === 0,
    platformContext: async timeline => {
      const userInstructions = timeline.filter(message => modelHistorySemanticRole(message) === 'user')
        .map((message, index) => ({
          id: typeof message.id === 'string' ? message.id : `source-${index}`,
          text: modelHistorySemanticText(message),
          orderSeq: typeof message._seq === 'number' ? message._seq : undefined,
        }))
      const plan = timeline.filter(message => message.role === 'plan').at(-1)
      return (await buildCompactionRecoveryContext({
        promptContext: {
          agentId: session.agentId, sessionKey: session.sessionKey, sessionId: session.peerId,
          persona: agent?.persona, identityCompat: session._identityCompat?.assets,
          provider: session.providerTag === 'codex' ? 'codex-native' : session.providerTag,
          model: session.model, effortLevel: session.runner.effortLevel,
          promptPolicy: policy,
          projectId: session.projectId ?? undefined,
          frozenProjectContext: session.frozenProjectContext,
          // Recovery reasserts rules; the native spawn owns the actual tool catalog.
          availableMcpTools: [],
        },
        userInstructions, plan, goal: session._platformGoal, activeTasks,
      })).text
    },
  })
  session._compactionOriginal = captured.reference
  return (input: HistoricalTurnInput): HistoricalTurnInput => attachCompactionRecoveryContext(input, {
    context: typeof captured.snapshot.platformContext === 'string' ? captured.snapshot.platformContext : '',
    textReference: captured.reference.textPath,
    // Antigravity budgets its complete JSON stdin envelope and can externalize
    // even the current input. Preserve that existing fallback instead of
    // rejecting here before its adapter can publish the exact file reference.
    maxPromptBytes: session.providerTag === 'antigravity' ? undefined : session.runner.capabilities.maxPromptBytes,
  })
}

/** Preserve platform-visible original output before any compact boundary.
 * Opaque native CLI internals are deliberately not described as platform text. */
export function observeCompactionOriginal(
  session: AgentSession, event: EngineEvent, snapshot: () => PartialSnapshot | undefined,
): void {
  if (!session._compactionOriginal) return
  if (event.kind === 'tool_use_detected') {
    ;(session._compactionPendingTools ??= new Map()).set(event.tool.id, {
      kind: 'tool', id: event.tool.id, state: 'running', sessionKey: session.sessionKey,
    })
  } else if (event.kind === 'tool_result_detected') {
    session._compactionPendingTools?.delete(event.result.toolUseId)
  } else if (event.kind === 'final') {
    for (const tool of session._compactionPendingTools?.values() ?? []) {
      tool.state = 'unconfirmed_after_turn'
    }
  }
  const boundary = (event.kind === 'turn_status' && event.status === 'compacting') || event.kind === 'context_compacted'
  if (!boundary && event.kind !== 'final') return
  try {
    appendCompactionTurnOriginal(session._compactionOriginal, {
      kind: boundary ? 'compact_boundary' : event.kind,
      payload: snapshot() ?? event,
      pendingTools: [...(session._compactionPendingTools?.values() ?? [])],
    })
  } catch (error) {
    // Never let an observation callback crash the adapter or mutate originals.
    log.error('compaction original observation could not be retained', {
      sessionKey: session.sessionKey, traceId: session._currentTurnTraceId,
    }, error)
  }
}
