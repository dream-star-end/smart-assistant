/**
 * Universal Seamless Auto-Compact & Overflow Auto-Recovery (OCV5-841 Wave 2).
 *
 * Gives users infinite, zero-learning-cost conversations across ALL engines
 * (CCB / Codex Local & Remote / Antigravity / Cursor / Grok / ZCode):
 *  1. Tracks per-session context watermark (exact tokens when available,
 *     conservative byte/window estimate for engines that omit call usage).
 *  2. Silently compacts before the next turn once ratio >= 0.78 (default),
 *     distinguishing the caller's own single inbound client turn from real
 *     concurrent competitors (B3), protected by 3-min cooldown & 3/15m cap.
 *  3. Transparently recovers from pre-admission `context_too_long` / `413` /
 *     `PROMPT_TOO_LONG` rejections on ANY engine (both thrown errors AND
 *     resolved error TurnSummaries from Cursor/Antigravity, B4) using the
 *     original raw user input and exact checkpoint generation ACK (B5).
 */
import {
  BOX_NATIVE_CONTEXT_OWNER,
  isBoxApiModel,
  resolveEffectiveModelHistoryContextWindow,
} from '@openclaude/protocol'
import { isCcbSlashCommandPrompt } from './ccbNativeCompaction.js'
import { reconcileAntigravitySwarmDirectiveAfterCompaction } from './engine/antigravitySwarmDirective.js'
import type { SessionStreamEvent, TurnSummary } from './engine/engineEvents.js'
import type { HistoricalTurnInput } from './historicalContextPayload.js'
import { peekPendingCheckpoint } from './sessionCheckpointStore.js'
import {
  extractCurrentUserTextFromTurnInput,
  hasCompactableHistoryFromSources,
  isAutoCompactAllowedChannel,
  resolveCompactHistoryLoader,
} from './sessionHistoryCompactSource.js'
import {
  compactSession,
  type SessionCompactOptions,
  type SessionLifecycleHost,
} from './sessionLifecycle.js'
import { buildRollingCheckpointPayload, type PromptQueueExecutionFence } from './sessionManager.js'
import { log } from './sessionManagerLog.js'
import type { AgentSession } from './sessionTypes.js'

export const DEFAULT_AUTO_COMPACT_RATIO = 0.78
export const AUTO_COMPACT_COOLDOWN_MS = 3 * 60_000
export const AUTO_COMPACT_WINDOW_MS = 15 * 60_000
export const AUTO_COMPACT_MAX_PER_WINDOW = 3

export interface SessionContextWatermark {
  usedRatio: number
  usedTokens: number
  windowTokens: number
  estimatedBytes: number
  updatedAt: number
}

interface SessionAutoCompactState {
  watermark: SessionContextWatermark
  /** Epoch ms timestamps of recent successful auto-compactions (pruned to 15m window). */
  recentRuns: number[]
}

const sessionAutoStates = new Map<string, SessionAutoCompactState>()
/** B3: Marks a session whose inbound caller just called beginClientTurn(session) before submit(),
 *  preserving any active prompt-queue execution fence so inner local CCB `/compact` shares the same owner. */
const selfClientTurnPending = new WeakMap<
  AgentSession,
  { queueExecutionFence?: PromptQueueExecutionFence }
>()
/** B5: Per-turn original raw user input, active checkpoint generation & master historicalMessages (survives inner retries). */
const turnOverflowContexts = new WeakMap<
  AgentSession,
  {
    rawUserInput?: HistoricalTurnInput
    activeCheckpointGeneration?: string
    overflowRetried?: boolean
    historicalMessages?: unknown[]
  }
>()

export function markSelfClientTurnForAutoCompact(
  session: AgentSession,
  queueExecutionFence?: PromptQueueExecutionFence,
): void {
  selfClientTurnPending.set(session, {
    ...(queueExecutionFence ? { queueExecutionFence } : {}),
  })
}

export function consumeSelfClientTurnForAutoCompact(
  session: AgentSession,
): { queueExecutionFence?: PromptQueueExecutionFence } | null {
  const entry = selfClientTurnPending.get(session)
  if (!entry) return null
  selfClientTurnPending.delete(session)
  return entry
}

export function beginTurnOverflowContext(
  session: AgentSession,
  rawUserInput: HistoricalTurnInput,
  initialCheckpointGeneration?: string,
  historicalMessages?: readonly unknown[],
): void {
  turnOverflowContexts.set(session, {
    rawUserInput,
    ...(initialCheckpointGeneration ? { activeCheckpointGeneration: initialCheckpointGeneration } : {}),
    ...(Array.isArray(historicalMessages) ? { historicalMessages: [...historicalMessages] } : {}),
  })
}

export function getTurnHistoricalMessages(session: AgentSession): readonly unknown[] | undefined {
  return turnOverflowContexts.get(session)?.historicalMessages
}

export function getTurnRawUserInput(session: AgentSession): HistoricalTurnInput | undefined {
  return turnOverflowContexts.get(session)?.rawUserInput
}

export function setTurnActiveCheckpointGeneration(session: AgentSession, generation: string): void {
  const existing = turnOverflowContexts.get(session)
  if (existing) {
    existing.activeCheckpointGeneration = generation
  } else {
    turnOverflowContexts.set(session, { activeCheckpointGeneration: generation })
  }
}

export function getTurnActiveCheckpointGeneration(session: AgentSession): string | undefined {
  return turnOverflowContexts.get(session)?.activeCheckpointGeneration
}

export function clearTurnOverflowContext(session: AgentSession): void {
  turnOverflowContexts.delete(session)
}

export function hasAttemptedUniversalOverflowRetry(session: AgentSession): boolean {
  return turnOverflowContexts.get(session)?.overflowRetried === true
}

export function markUniversalOverflowRetryAttempted(session: AgentSession): void {
  const existing = turnOverflowContexts.get(session)
  if (existing) existing.overflowRetried = true
  else turnOverflowContexts.set(session, { overflowRetried: true })
}

/**
 * B4: Typed retry signal thrown from `_runOneTurn` BEFORE persisting an error terminal
 * when an adapter resolved a zero-progress, zero-usage, explicit pre-admission overflow
 * rejection (covering Cursor / Antigravity / CCB / Codex / explicit-rejection remote).
 */
export class SafeUniversalOverflowRetryError extends Error {
  constructor(
    message: string,
    readonly explicitPreAdmissionRejection: boolean,
  ) {
    super(message)
    this.name = 'SafeUniversalOverflowRetryError'
  }
}

/** Enabled by default; `OC_AUTO_COMPACT=off|0|false` acts as emergency bypass. */
export function isAutoCompactEnabled(): boolean {
  const raw = process.env.OC_AUTO_COMPACT?.trim().toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false') return false
  return true
}

/** Auto-compact trigger ratio (default 0.78, clamped to [0.5, 0.95]). */
export function resolveAutoCompactRatio(): number {
  const raw = Number(process.env.OC_AUTO_COMPACT_RATIO)
  if (!Number.isFinite(raw)) return DEFAULT_AUTO_COMPACT_RATIO
  return Math.min(0.95, Math.max(0.5, raw))
}

function getOrCreateState(sessionKey: string): SessionAutoCompactState {
  let state = sessionAutoStates.get(sessionKey)
  if (!state) {
    state = {
      watermark: {
        usedRatio: 0,
        usedTokens: 0,
        windowTokens: 200_000,
        estimatedBytes: 0,
        updatedAt: 0,
      },
      recentRuns: [],
    }
    sessionAutoStates.set(sessionKey, state)
  }
  return state
}

/** Update per-session watermark from exact tokens or conservative byte delta. */
export function recordSessionContextWatermark(
  sessionKey: string,
  input: {
    engine?: string
    usedTokens?: number
    windowTokens?: number | null
    turnBytesDelta?: number
    nowMs?: number
  },
): SessionContextWatermark {
  const state = getOrCreateState(sessionKey)
  const now = input.nowMs ?? Date.now()
  const windowTokens = resolveEffectiveModelHistoryContextWindow(
    input.windowTokens,
    input.engine,
  )
  state.watermark.windowTokens = windowTokens
  if (typeof input.turnBytesDelta === 'number' && input.turnBytesDelta > 0) {
    state.watermark.estimatedBytes += Math.floor(input.turnBytesDelta)
  }
  if (typeof input.usedTokens === 'number' && input.usedTokens > 0) {
    state.watermark.usedTokens = Math.round(input.usedTokens)
    state.watermark.estimatedBytes = Math.max(
      state.watermark.estimatedBytes,
      Math.round(state.watermark.usedTokens * 3.5),
    )
  } else if (state.watermark.estimatedBytes > 0) {
    state.watermark.usedTokens = Math.ceil(state.watermark.estimatedBytes / 3.5)
  }
  state.watermark.usedRatio =
    windowTokens > 0 ? Number((state.watermark.usedTokens / windowTokens).toFixed(4)) : 0
  state.watermark.updatedAt = now
  return { ...state.watermark }
}

export function getSessionContextWatermark(sessionKey: string): SessionContextWatermark | null {
  const state = sessionAutoStates.get(sessionKey)
  return state ? { ...state.watermark } : null
}

/** Reset watermark after a successful compaction so the next turn starts cleanly. */
export function resetSessionContextWatermark(
  sessionKey: string,
  after?: { afterTokens?: number; afterBytes?: number },
  nowMs = Date.now(),
): void {
  const state = getOrCreateState(sessionKey)
  const afterBytes = Math.max(0, Math.floor(after?.afterBytes ?? 0))
  const afterTokens =
    typeof after?.afterTokens === 'number' && after.afterTokens >= 0
      ? Math.round(after.afterTokens)
      : Math.ceil(afterBytes / 3.5)
  state.watermark.estimatedBytes = afterBytes
  state.watermark.usedTokens = afterTokens
  state.watermark.usedRatio =
    state.watermark.windowTokens > 0
      ? Number((afterTokens / state.watermark.windowTokens).toFixed(4))
      : 0
  state.watermark.updatedAt = nowMs
}

/** Clean up in-memory watermark and debounce state when a session is destroyed. */
export function clearSessionAutoCompactState(sessionKey: string): void {
  sessionAutoStates.delete(sessionKey)
}

/** Check anti-loop guard: >=3min cooldown & <3 auto-compactions in last 15 minutes. */
export function canRunAutoCompact(sessionKey: string, nowMs = Date.now()): boolean {
  if (!isAutoCompactEnabled()) return false
  const state = sessionAutoStates.get(sessionKey)
  if (!state || state.recentRuns.length === 0) return true
  const windowCutoff = nowMs - AUTO_COMPACT_WINDOW_MS
  state.recentRuns = state.recentRuns.filter((ts) => ts > windowCutoff)
  if (state.recentRuns.length >= AUTO_COMPACT_MAX_PER_WINDOW) return false
  const lastRun = state.recentRuns[state.recentRuns.length - 1]
  if (lastRun !== undefined && nowMs - lastRun < AUTO_COMPACT_COOLDOWN_MS) return false
  return true
}

export function recordAutoCompactRun(sessionKey: string, nowMs = Date.now()): void {
  const state = getOrCreateState(sessionKey)
  const windowCutoff = nowMs - AUTO_COMPACT_WINDOW_MS
  state.recentRuns = state.recentRuns.filter((ts) => ts > windowCutoff)
  state.recentRuns.push(nowMs)
}

const OVERFLOW_ERR_RE =
  /context_too_long|prompt_too_long|prompt is too long|context length exceeded|maximum context length|context window exceeded|payload too large|\b413\b/i

/** Detect context overflow errors across ALL engines (Antigravity/Cursor/Grok/ZCode/CCB/Codex).
 * Excludes deterministic media/body-size `request_too_large` rejections (compacting chat history
 * cannot shrink an oversized uploaded attachment). */
export function isUniversalOverflowError(message: string, errorClass?: string): boolean {
  if (errorClass === 'request_too_large') return false
  if (errorClass === 'context_too_long') return true
  return OVERFLOW_ERR_RE.test(message)
}

/** Check whether the session actually has persisted conversation history that can be compacted
 * into a rolling checkpoint. Prefers master-injected turn `historicalMessages` (commercial/PG
 * container truth) before falling back to local SQLite. Fail-closed (`false`) on empty/unavailable
 * history so `_runOneTurn` preserves the authoritative error tape instead of discarding it. */
export async function hasCompactableSessionHistory(
  session: AgentSession,
  historicalMessages?: readonly unknown[] | null,
  currentUserText?: string,
): Promise<boolean> {
  const effectiveCurrent =
    currentUserText ??
    (extractCurrentUserTextFromTurnInput(getTurnRawUserInput(session)) ||
      session.currentUserText ||
      '')
  return hasCompactableHistoryFromSources(
    session,
    historicalMessages ?? getTurnHistoricalMessages(session),
    effectiveCurrent,
  )
}

const AMBIGUOUS_REMOTE_ERR_RE =
  /timeout|timed?\s*out|econnreset|connection\s+reset|socket\s+hang\s+up|eof|broken\s+pipe|network\s+error|stream\s+dropped|upstream\s+50[234]|bad\s+gateway|service\s+unavailable/i

/**
 * B4: Verifiable pre-admission rejection proof for remote execution backends.
 * Requires explicit overflow rejection evidence (adapter `preAdmissionRejected` flag OR
 * explicit 413 / PROMPT_TOO_LONG / context_too_long rejection detail) and rejects any
 * ambiguous transport/network/timeout failure.
 */
export function hasExplicitRemotePreAdmissionOverflowProof(
  result: TurnSummary,
  errorClass?: string,
): boolean {
  const detail = [result.errorDetail ?? '', result.assistantText ?? ''].join(' ').trim()
  if (detail && AMBIGUOUS_REMOTE_ERR_RE.test(detail)) return false
  const preAdmissionFlag = (result as TurnSummary & { preAdmissionRejected?: boolean }).preAdmissionRejected === true
  if (preAdmissionFlag) return isUniversalOverflowError(detail, errorClass ?? result.errorClass)
  if (!detail) return false
  return OVERFLOW_ERR_RE.test(detail)
}

/**
 * B4: Strict safety gate for converting a resolved error TurnSummary into a single
 * pre-persistence overflow auto-recovery retry (before writing an error terminal).
 * Requires: explicit overflow rejection, ZERO visible assistant/thinking/tool/permission/
 * structured output, ZERO token/cost usage, and NOT stopped/aborted.
 * For remote executionBackends, ONLY permits verifiable pre-admission rejection proofs
 * (never blind-retries unknown/timeout/network remote failures).
 */
export function isSafeUniversalOverflowSummary(params: {
  session?: AgentSession
  result: TurnSummary | null
  errorClass?: string
  hasUsage: boolean
  turnBlockCount: number
  turnPermissionCount: number
  turnToolCallCount: number
  structuredBlockCount: number
  priorAssistantSegments: number
  stoppedOrAborted: boolean
  isCcbSingleDiagnostic?: boolean
}): boolean {
  if (!isAutoCompactEnabled()) return false
  if (params.session && hasAttemptedUniversalOverflowRetry(params.session)) return false
  const { result } = params
  if (!result || result.isError !== true) return false
  if (params.stoppedOrAborted) return false
  if (params.hasUsage) return false
  if (params.priorAssistantSegments > 0) return false
  if (params.turnPermissionCount > 0 || params.turnToolCallCount > 0 || params.structuredBlockCount > 0) {
    return false
  }
  const detail = [result.errorDetail ?? '', result.assistantText ?? ''].join(' ')
  if (!isUniversalOverflowError(detail, params.errorClass ?? result.errorClass)) return false
  if (params.session?.runner?.executionBackend) {
    if (!hasExplicitRemotePreAdmissionOverflowProof(result, params.errorClass)) return false
  }
  const allowedDiag = params.isCcbSingleDiagnostic === true
  if (params.turnBlockCount > (allowedDiag ? 1 : 0)) return false
  if (!allowedDiag && result.assistantText.trim().length > 0) return false
  if (!allowedDiag && result.assistantSegments.length > 0) return false
  if (result.thinkingText.length > 0 || result.thinkingSegments.length > 0) return false
  if (result.tools.length > 0) return false
  return true
}

function emitQuietCompactedEvent(
  onEvent: (e: SessionStreamEvent) => void,
  session: AgentSession,
  outcome: {
    engine: string
    strategy?: 'native_summary' | 'checkpoint_reset'
    beforeBytes?: number
    afterBytes?: number
    beforeTokens?: number
    afterTokens?: number
    droppedEntries?: number
    summaryPreview?: string
  },
): void {
  if (!outcome.strategy) return
  try {
    onEvent({
      kind: 'context_compacted',
      compaction: {
        engine: outcome.engine,
        scope: 'native_context',
        strategy: outcome.strategy,
        ...(outcome.beforeBytes !== undefined ? { beforeBytes: outcome.beforeBytes } : {}),
        ...(outcome.afterBytes !== undefined ? { afterBytes: outcome.afterBytes } : {}),
        ...(outcome.droppedEntries !== undefined ? { droppedEntries: outcome.droppedEntries } : {}),
        ...(outcome.beforeTokens !== undefined ? { beforeTokens: outcome.beforeTokens } : {}),
        ...(outcome.afterTokens !== undefined ? { afterTokens: outcome.afterTokens } : {}),
        ...(outcome.summaryPreview ? { summaryPreview: outcome.summaryPreview } : {}),
        sessionId: session.peerId,
      },
    })
  } catch {
    /* fail-open: never break turn on UX receipt emission */
  }
}

/**
 * Silent pre-turn auto-compact hook (called in `sessionSubmit.ts` BEFORE taking `session.lock`).
 * B3: Distinguishes caller's own single inbound client turn (`allowSingleSelfClientTurn`)
 * from real concurrent competitors (`_activeClientTurnCount >= 2` or `_activeTurnCount >= 1`).
 */
export async function maybeAutoCompactBeforeTurn(
  host: SessionLifecycleHost,
  session: AgentSession,
  userTextOrBlocks: HistoricalTurnInput,
  onEvent: (e: SessionStreamEvent) => void,
  opts?: {
    model?: string
    executionDescriptor?: { contextOwner?: string }
    _internalCompact?: boolean
    modelSwitchInternal?: string
    allowSingleSelfClientTurn?: boolean
    queueExecutionFence?: PromptQueueExecutionFence
    nowMs?: number
    loadHistoryMessages?: SessionCompactOptions['loadHistoryMessages']
    historicalMessages?: readonly unknown[]
    checkpointDir?: string
  },
): Promise<{ compacted: boolean; strategy?: string; reason?: string }> {
  const selfMark = consumeSelfClientTurnForAutoCompact(session)
  const allowSingleSelfClientTurn = Boolean(selfMark) || opts?.allowSingleSelfClientTurn === true
  const queueExecutionFence = opts?.queueExecutionFence ?? selfMark?.queueExecutionFence
  if (!isAutoCompactEnabled()) return { compacted: false, reason: 'disabled' }
  if (opts?._internalCompact || opts?.modelSwitchInternal !== undefined) {
    return { compacted: false, reason: 'internal_turn' }
  }
  if (!isAutoCompactAllowedChannel(session.channel)) {
    return { compacted: false, reason: 'excluded_channel' }
  }
  if (isCcbSlashCommandPrompt(userTextOrBlocks)) return { compacted: false, reason: 'slash_cmd' }
  // OCV5-755 × OCV5-841: Box-native CCB sessions own their own context budget
  // (autocompact + pre-expiry deferred idle compaction with signed authority);
  // never fire an unsigned pre-turn `/compact` that busts warm Box prompt cache.
  const effectiveModel = opts?.model ?? session.model
  if (
    session._idlePreExpiryTimer !== undefined ||
    session._idlePreExpiryActive ||
    session._idleRunning ||
    opts?.executionDescriptor?.contextOwner === BOX_NATIVE_CONTEXT_OWNER ||
    session._boxContextOwner === BOX_NATIVE_CONTEXT_OWNER ||
    isBoxApiModel(effectiveModel)
  ) {
    return { compacted: false, reason: 'box_native_owned' }
  }

  const state = sessionAutoStates.get(session.sessionKey)
  const threshold = resolveAutoCompactRatio()
  if (!state || state.watermark.usedRatio < threshold) {
    return { compacted: false, reason: 'below_threshold' }
  }
  const now = opts?.nowMs ?? Date.now()
  if (!canRunAutoCompact(session.sessionKey, now)) {
    return { compacted: false, reason: 'throttled' }
  }

  const loadHistoryMessages = resolveCompactHistoryLoader(session, {
    loadHistoryMessages: opts?.loadHistoryMessages,
    historicalMessages: opts?.historicalMessages ?? getTurnHistoricalMessages(session),
    currentUserText:
      extractCurrentUserTextFromTurnInput(userTextOrBlocks) || session.currentUserText || '',
  })

  try {
    const outcome = await compactSession.call(host, session, {
      mode: 'auto',
      allowSingleSelfClientTurn,
      ...(queueExecutionFence ? { queueExecutionFence } : {}),
      loadHistoryMessages,
      ...(opts?.checkpointDir ? { checkpointDir: opts.checkpointDir } : {}),
    })
    if (outcome.ok && outcome.strategy) {
      recordAutoCompactRun(session.sessionKey, now)
      resetSessionContextWatermark(
        session.sessionKey,
        { afterTokens: outcome.afterTokens, afterBytes: outcome.afterBytes },
        now,
      )
      emitQuietCompactedEvent(onEvent, session, outcome)
      log.info('auto_compact_completed', {
        sessionKey: session.sessionKey,
        engine: outcome.engine,
        strategy: outcome.strategy,
        beforeBytes: outcome.beforeBytes,
        afterBytes: outcome.afterBytes,
      })
      return { compacted: true, strategy: outcome.strategy }
    }
    return { compacted: false, reason: outcome.error ?? 'not_compacted' }
  } catch (err) {
    log.warn('auto_compact_failed_fail_open', { sessionKey: session.sessionKey }, err)
    return { compacted: false, reason: 'error' }
  }
}

/**
 * Universal overflow auto-recovery (called once per logical turn inside `runOneTurnWithRetry`
 * when ANY engine rejects with pre-admission overflow before emitting visible output).
 * B5: Wraps the original un-prefixed `rawUserInput` (NEVER bloated prior `runnerPayload`)
 * and records the newly created checkpoint `generation` so outer `submit()` ACKs it on
 * genuine turn completion and preserves it on failure/cancel.
 */
export async function tryUniversalOverflowAutoCompact(
  host: SessionLifecycleHost,
  session: AgentSession,
  fallbackInput: HistoricalTurnInput,
  onEvent: (e: SessionStreamEvent) => void,
  opts?: {
    nowMs?: number
    loadHistoryMessages?: SessionCompactOptions['loadHistoryMessages']
    historicalMessages?: readonly unknown[]
    checkpointDir?: string
  },
): Promise<HistoricalTurnInput | null> {
  if (!isAutoCompactEnabled()) return null
  markUniversalOverflowRetryAttempted(session)
  const now = opts?.nowMs ?? Date.now()
  const rawInputForCurrent = getTurnRawUserInput(session) ?? fallbackInput
  const loadHistoryMessages = resolveCompactHistoryLoader(session, {
    loadHistoryMessages: opts?.loadHistoryMessages,
    historicalMessages: opts?.historicalMessages ?? getTurnHistoricalMessages(session),
    currentUserText:
      extractCurrentUserTextFromTurnInput(rawInputForCurrent) || session.currentUserText || '',
  })
  try {
    const outcome = await compactSession.call(host, session, {
      mode: 'auto',
      skipLock: true,
      forceCheckpointReset: true,
      loadHistoryMessages,
      ...(opts?.checkpointDir ? { checkpointDir: opts.checkpointDir } : {}),
    })
    if (!outcome.ok || !outcome.strategy) return null
    const checkpoint = peekPendingCheckpoint(session.sessionKey, opts?.checkpointDir)
    const summary = checkpoint?.summary || outcome.summaryPreview
    if (!summary) return null

    if (checkpoint?.generation) {
      setTurnActiveCheckpointGeneration(session, checkpoint.generation)
      session._historicalContextInjected = true
      session._historicalContextInjectedKey = `checkpoint-reset:${checkpoint.generation}`
    }

    recordAutoCompactRun(session.sessionKey, now)
    resetSessionContextWatermark(
      session.sessionKey,
      { afterTokens: outcome.afterTokens, afterBytes: outcome.afterBytes },
      now,
    )
    emitQuietCompactedEvent(onEvent, session, outcome)
    log.info('overflow_auto_compact_recovered', {
      sessionKey: session.sessionKey,
      engine: outcome.engine,
      strategy: outcome.strategy,
      generation: checkpoint?.generation,
    })
    // B5: Always wrap original rawUserInput (blocks/attachments intact), never bloated runnerPayload!
    const rawInput = getTurnRawUserInput(session) ?? fallbackInput
    const swarmCompaction = session._antigravitySwarmCompaction
    const reconciledRawInput = swarmCompaction
      ? reconcileAntigravitySwarmDirectiveAfterCompaction(
          rawInput,
          swarmCompaction,
          { resetKind: 'rolling_checkpoint' },
        )
      : rawInput
    if (swarmCompaction) session._antigravitySwarmCompaction = undefined
    return buildRollingCheckpointPayload(summary, reconciledRawInput)
  } catch (err) {
    log.warn('overflow_auto_compact_failed', { sessionKey: session.sessionKey }, err)
    return null
  }
}

/** Convenience helper called at turn completion in `sessionTurnRunner.ts`. */
export function recordTurnContextWatermarkForAutoCompact(
  session: AgentSession,
  params: {
    usedTokens?: number
    modelContextWindow?: number | null
    userText?: string
    assistantText?: string
    toolsBytes?: number
  },
): void {
  const userBytes = params.userText ? Buffer.byteLength(params.userText, 'utf8') : 0
  const assistantBytes = params.assistantText ? Buffer.byteLength(params.assistantText, 'utf8') : 0
  const delta = userBytes + assistantBytes + Math.max(0, Math.floor(params.toolsBytes ?? 0))
  recordSessionContextWatermark(session.sessionKey, {
    engine: session.providerTag || session.runner.engineId,
    usedTokens: params.usedTokens,
    windowTokens: params.modelContextWindow,
    turnBytesDelta: delta,
  })
}
