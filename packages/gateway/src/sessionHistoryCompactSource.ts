/**
 * Unified history source resolution for cross-engine auto-compaction and
 * universal 413/overflow auto-recovery (commercial PG containers + local SQLite).
 *
 * Single authority for both `hasCompactableHistoryFromSources` and
 * `resolveCompactHistoryLoader`:
 *  1. Selects base history: authoritative master `historicalMessages` (when non-empty
 *     after stripping trailing current-turn rows) else local SQLite `getEngineContextMessages`
 *     (also stripped of trailing current-turn/optimistic rows).
 *  2. Appends any unacknowledged `session._pendingExternalExchanges` on top of the
 *     already-stripped base (non-mutating), so pending paid answers are preserved
 *     WITHOUT displacing local base history or shifting current-turn rows into the middle.
 */
import {
  modelHistorySemanticRole,
  modelHistorySemanticText,
  projectModelHistoryForReplay,
} from '@openclaude/protocol'
import { getEngineContextMessages } from '@openclaude/storage'
import type { HistoricalTurnInput } from './historicalContextPayload.js'
import type { SessionCompactOptions } from './sessionLifecycle.js'
import type { AgentSession } from './sessionTypes.js'

/** Internal/ephemeral/automated non-chat channels that should not trigger pre-turn auto-compact. */
const AUTO_COMPACT_EXCLUDED_CHANNELS = new Set([
  'auto-dream',
  'cron',
  'delegate',
  'swarm',
  'advisor',
  'system-help',
  'taskboard',
  'task',
  'webhook',
])

/** Allow auto-compact across all user-facing chat channels (webchat, wechat, telegram, feishu, qq, etc.). */
export function isAutoCompactAllowedChannel(channel: string | undefined): boolean {
  const normalized = typeof channel === 'string' ? channel.trim().toLowerCase() : ''
  if (!normalized) return false
  return !AUTO_COMPACT_EXCLUDED_CHANNELS.has(normalized)
}

function normForCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function extractTextFromContentBlocks(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim()) parts.push(item)
      continue
    }
    if (!item || typeof item !== 'object') continue
    const block = item as Record<string, unknown>
    if (typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text)
    } else if (typeof block.content === 'string' && block.content.trim()) {
      parts.push(block.content)
    }
  }
  return parts.join('\n')
}

/** Extract plain user text from string or multimodal content-block turn inputs. */
export function extractCurrentUserTextFromTurnInput(
  input: HistoricalTurnInput | string | null | undefined,
): string {
  if (typeof input === 'string') return input
  if (Array.isArray(input)) return extractTextFromContentBlocks(input)
  return ''
}

function normalizeRecordShape(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.text === 'string') return rec
  if (typeof rec.content === 'string') return { ...rec, text: rec.content }
  if (Array.isArray(rec.content)) {
    const text = extractTextFromContentBlocks(rec.content)
    return text ? { ...rec, text } : rec
  }
  if (typeof rec.message === 'string') return { ...rec, text: rec.message }
  return rec
}

/**
 * Non-mutating merge of unacknowledged `session._pendingExternalExchanges` on top of
 * an already-stripped base history array.
 */
export function mergePendingExternalExchangesForCompact(
  session: Pick<AgentSession, '_pendingExternalExchanges'>,
  messages: readonly unknown[],
): unknown[] {
  const pending = session._pendingExternalExchanges
  if (!pending?.length) return [...messages]
  const ids = new Set<string>()
  for (const raw of messages) {
    if (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string') {
      ids.add((raw as { id: string }).id)
    }
  }
  const merged = [...messages]
  for (const exchange of pending) {
    if (ids.has(exchange.assistant.id)) continue
    const hasEquivalentUser = merged.some((raw) => {
      const rec = normalizeRecordShape(raw)
      if (!rec) return false
      return (
        rec.role === 'user' &&
        typeof rec.text === 'string' &&
        normForCompare(rec.text) === normForCompare(exchange.user.text)
      )
    })
    if (!hasEquivalentUser && !ids.has(exchange.user.id)) {
      merged.push(exchange.user)
    }
    merged.push(exchange.assistant)
    ids.add(exchange.assistant.id)
  }
  return merged
}

/**
 * Convert history entries into `modelHistory`-compatible objects without mutating
 * caller arrays/records. Uses the exact same trailing strip rules as
 * `buildHistoricalContextPrompt` (drops trailing non-replayable/system rows,
 * optimistic `sending`/`queued` rows, and stateless copies of `currentUserText`) so
 * turn-1 empty sessions stay fail-closed and checkpoints never duplicate the live prompt.
 */
export function normalizeHistoricalMessagesForCompact(
  messages: readonly unknown[] | null | undefined,
  currentUserText?: string,
): unknown[] {
  if (!Array.isArray(messages) || messages.length === 0) return []
  const out: unknown[] = []
  for (const raw of messages) {
    const rec = normalizeRecordShape(raw)
    if (rec) out.push(rec)
  }
  const currentNorm = normForCompare(currentUserText ?? '')
  let end = out.length
  while (end > 0) {
    const raw = out[end - 1]
    if (!raw || typeof raw !== 'object') {
      end -= 1
      continue
    }
    const msg = raw as Record<string, unknown>
    if (msg.system === true) {
      end -= 1
      continue
    }
    const role = modelHistorySemanticRole(msg as Parameters<typeof modelHistorySemanticRole>[0])
    if (!role) {
      end -= 1
      continue
    }
    const text = modelHistorySemanticText(
      msg as Parameters<typeof modelHistorySemanticText>[0],
    ).trim()
    if (!text) {
      end -= 1
      continue
    }
    const lastNorm = normForCompare(text)
    const isCurrent =
      role === 'user' &&
      (msg.status === 'sending' ||
        msg.status === 'queued' ||
        (Boolean(currentNorm) && (lastNorm === currentNorm || currentNorm.startsWith(lastNorm))))
    if (!isCurrent) break
    end -= 1
  }
  return end === out.length ? out : out.slice(0, end)
}

/** True when normalized history contains at least one replayable semantic message. */
export function hasCompactableMessages(
  messages: readonly unknown[] | null | undefined,
  currentUserText?: string,
): boolean {
  const normalized = normalizeHistoricalMessagesForCompact(messages, currentUserText)
  if (normalized.length === 0) return false
  const projected = projectModelHistoryForReplay(normalized, { recentFullTurns: 2 })
  return projected.some((row) => row.text.trim().length > 0)
}

/**
 * Single authoritative loader shared by both `hasCompactableHistoryFromSources`
 * (413 gate) and `resolveCompactHistoryLoader` (actual checkpoint builder):
 *  1. Resolve base history (master `historicalMessages` first; if empty after
 *     stripping current-turn rows, fall back to local SQLite `getEngineContextMessages`).
 *  2. Strip current-turn/optimistic trailing rows BEFORE merging `_pendingExternalExchanges`
 *     so un-ACKed exchanges supplement the full history without burying a trailing current prompt.
 */
async function loadAuthoritativeCompactHistory(
  session: AgentSession,
  historicalMessages: readonly unknown[] | null | undefined,
  currentUserText: string,
): Promise<unknown[]> {
  let base = normalizeHistoricalMessagesForCompact(historicalMessages, currentUserText)
  if (!hasCompactableMessages(base, '') && session.peerId) {
    try {
      const engine = session.providerTag || session.runner.engineId || 'ccb'
      const local = await getEngineContextMessages(session.peerId, session.userId ?? 'default', {
        engine,
        currentUserText,
      })
      base = normalizeHistoricalMessagesForCompact(local ?? [], currentUserText)
    } catch {
      base = []
    }
  }
  return mergePendingExternalExchangesForCompact(session, base)
}

/**
 * Check whether a session has compactable history using the exact same authoritative
 * source & stripping logic as `resolveCompactHistoryLoader`.
 */
export async function hasCompactableHistoryFromSources(
  session: AgentSession,
  historicalMessages?: readonly unknown[] | null,
  currentUserText?: string,
): Promise<boolean> {
  const effectiveCurrent = currentUserText ?? session.currentUserText ?? ''
  const resolved = await loadAuthoritativeCompactHistory(
    session,
    historicalMessages,
    effectiveCurrent,
  )
  return hasCompactableMessages(resolved, '')
}

/**
 * Resolve `SessionCompactOptions['loadHistoryMessages']`:
 *  1. Explicit caller `loadHistoryMessages` wins (tests & manual control-plane callers).
 *  2. Always uses `loadAuthoritativeCompactHistory` so pre-turn auto-compact and 413
 *     recovery share identical base selection (master vs local SQLite), current-turn
 *     stripping, and `_pendingExternalExchanges` supplementation.
 */
export function resolveCompactHistoryLoader(
  session: AgentSession,
  opts?: {
    loadHistoryMessages?: SessionCompactOptions['loadHistoryMessages']
    historicalMessages?: readonly unknown[] | null
    currentUserText?: string
  },
): NonNullable<SessionCompactOptions['loadHistoryMessages']> {
  if (opts?.loadHistoryMessages) return opts.loadHistoryMessages
  const effectiveCurrent = opts?.currentUserText ?? session.currentUserText ?? ''
  return () =>
    loadAuthoritativeCompactHistory(session, opts?.historicalMessages, effectiveCurrent)
}
