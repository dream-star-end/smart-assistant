import {
  availableModelHistoryTokens,
  estimateModelHistoryTokens,
  exactModelHistoryTextSuffix,
  MODEL_HISTORY_EXACT_SUFFIX_MARKER,
  modelHistoryReservedTokens,
  modelHistorySemanticRole,
  modelHistorySemanticText,
  resolveModelHistoryContextWindow,
  type LiveUnitsPage,
} from '@openclaude/protocol'
import type Database from 'better-sqlite3'
import {
  compareMessagesByOrder,
  deriveArchivedOrderSeqsForRead,
  deriveOrderSeqsForRead,
  isValidOrderSeq,
} from './orderAndSeq.js'
import { getSessionsDb } from './sqliteHandle.js'
import {
  type ClientSessionLiveFramePage,
  type ClientSessionReadOptions,
  type ClientTimelineCursor,
  ClientTimelineCursorStaleError,
  type ClientTimelinePage,
  type EngineContextReadOptions,
  type MessageLike,
  type ReadArchivedMessagesResult,
  safeParseMessageArray,
} from './types.js'

const DEFAULT_SAFE_ENGINE_CONTEXT_WINDOW = 200_000

function buildTruncatedSuffixMessage(row: MessageLike, text: string, remaining: number): MessageLike | null {
  if (remaining <= 64) return null
  const suffix = exactModelHistoryTextSuffix(
    text,
    Math.max(0, remaining - estimateModelHistoryTokens(MODEL_HISTORY_EXACT_SUFFIX_MARKER) - 4),
  )
  if (!suffix) return null
  const role = modelHistorySemanticRole(row)!
  return {
    role,
    text: MODEL_HISTORY_EXACT_SUFFIX_MARKER + suffix,
    ...(typeof row.id === 'string' ? { id: row.id } : {}),
    ...(typeof row._clientMessageId === 'string' ? { _clientMessageId: row._clientMessageId } : {}),
    ...(typeof row.status === 'string' ? { status: row.status } : {}),
    ...(typeof row.ts === 'number' ? { ts: row.ts } : {}),
  }
}

export function selectEngineContextSuffix(
  messages: MessageLike[],
  options: EngineContextReadOptions = {},
): { messages: MessageLike[]; truncated: boolean } {
  const rows = messages.filter((message) => {
    if (!message || modelHistorySemanticRole(message) === null) return false
    if (message.system === true) return false
    if (
      options.excludeClientMessageId &&
      (message.id === options.excludeClientMessageId ||
        message._clientMessageId === options.excludeClientMessageId)
    ) {
      return false
    }
    return modelHistorySemanticText(message).trim().length > 0
  })
  const contextWindow = resolveModelHistoryContextWindow(options.contextWindow, options.engine)
  if (contextWindow === null) return { messages: rows, truncated: false }

  let remaining = availableModelHistoryTokens(
    contextWindow,
    options.currentUserText ?? '',
    modelHistoryReservedTokens(options.engine),
  )
  const selected: MessageLike[] = []
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    const text = modelHistorySemanticText(row)
    const rowTokens = estimateModelHistoryTokens(text) + 4
    if (rowTokens > remaining) {
      const partial = buildTruncatedSuffixMessage(row, text, remaining)
      if (partial) selected.unshift(partial)
      return { messages: selected, truncated: true }
    }
    selected.unshift(row)
    remaining -= rowTokens
  }
  return { messages: selected, truncated: false }
}

export async function _sqliteReadArchivedMessages(
  sessId: string,
  userId: string,
  beforeSeq = 0,
  limit = 100,
  _options: ClientSessionReadOptions = {},
): Promise<ReadArchivedMessagesResult> {
  const db = await getSessionsDb()
  const cappedLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 100)))

  const row = db
    .prepare(
      'SELECT archived_through_seq, history_revision FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .get(sessId, userId) as
    | { archived_through_seq: number | null; history_revision: number }
    | undefined
  if (!row) return { messages: [], hasMore: false, oldestSeq: null }
  const watermark = typeof row.archived_through_seq === 'number' ? row.archived_through_seq : 0
  const effectiveBefore = Number.isFinite(beforeSeq) && beforeSeq > 0 ? beforeSeq : watermark + 1
  if (effectiveBefore <= 1) {
    return { messages: [], hasMore: false, oldestSeq: null, historyRevision: row.history_revision }
  }

  const chunkRows = db
    .prepare(
      `SELECT messages FROM client_session_archive_chunks
         WHERE session_id = ? AND user_id = ? AND first_seq < ?
         ORDER BY last_seq DESC`,
    )
    .iterate(sessId, userId, effectiveBefore) as Iterable<{ messages: string }>

  const pool: MessageLike[] = []
  for (const cr of chunkRows) {
    for (const m of deriveArchivedOrderSeqsForRead(safeParseMessageArray(cr.messages))) {
      const s = isValidOrderSeq(m?._orderSeq) ? m._orderSeq : -1
      if (s >= 0 && s < effectiveBefore) pool.push(m)
    }
    if (pool.length > cappedLimit) break
  }

  pool.sort(compareMessagesByOrder)
  const hasMore = pool.length > cappedLimit
  const page = pool.slice(Math.max(0, pool.length - cappedLimit))
  const oldestSeq = page.length > 0 && isValidOrderSeq(page[0]!._orderSeq) ? page[0]!._orderSeq : null
  return { messages: page, hasMore, oldestSeq, historyRevision: row.history_revision }
}

export async function _sqliteReadClientSessionLiveFrames(
  sessId: string,
  userId: string,
  _afterRecordId = 0,
  _limit = 200,
  _options?: { seekTail?: boolean; afterSeq?: number; clientMessageId?: string; streamKey?: string },
): Promise<ClientSessionLiveFramePage | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare('SELECT 1 FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(sessId, userId)
  return row
    ? {
        frames: [],
        nextCursor: null,
        hasMore: false,
        hasMoreBefore: false,
        streamClientMessageIds: [],
        hasTapeProjection: false,
        tapeProjectionVersion: 0,
      }
    : null
}

export async function _sqliteReadClientSessionLiveUnits(
  sessId: string,
  userId: string,
  _options?: {
    n?: number
    k?: number
    before?: string | null
    group?: string | null
    nestedBefore?: string | null
    deadlineMs?: number
    maxBytes?: number
  },
): Promise<LiveUnitsPage | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare('SELECT 1 FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(sessId, userId)
  return row
    ? {
        view: 'units',
        units: [],
        n: 20,
        hasMoreBefore: false,
        beforeCursor: null,
        streamClientMessageIds: [],
        openDispatch: false,
        hasTapeProjection: false,
        tapeProjectionVersion: 0,
        reducerEpoch: '1',
        degraded: false,
      }
    : null
}

export async function _sqliteReadLiveOrTapeFramePayload(
  sessId: string,
  userId: string,
  _ref: { recordId?: string | null; sha256?: string | null },
): Promise<{ source: 'live' | 'tape'; payload: unknown; sha256?: string } | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare('SELECT 1 FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(sessId, userId)
  return row ? null : null
}

export async function _sqliteConvergeFinalizedTapeLiveStreams(): Promise<{ converged: number }> {
  return { converged: 0 }
}

export async function _sqliteGetEngineContextMessages(
  sessionId: string,
  userId: string,
  options: EngineContextReadOptions = {},
): Promise<MessageLike[] | null> {
  const effectiveOptions: EngineContextReadOptions =
    resolveModelHistoryContextWindow(options.contextWindow, options.engine) === null
      ? { ...options, contextWindow: DEFAULT_SAFE_ENGINE_CONTEXT_WINDOW }
      : options
  const db = await getSessionsDb()
  const row = db
    .prepare(
      'SELECT messages, archived_through_seq FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .get(sessionId, userId) as { messages: string; archived_through_seq: number | null } | undefined
  if (!row) return null
  const msgs = safeParseMessageArray(row.messages)
  let selected = selectEngineContextSuffix(
    deriveOrderSeqsForRead(msgs, row.archived_through_seq ?? 0),
    effectiveOptions,
  )
  if (selected.truncated) return selected.messages

  const chunks = db
    .prepare(
      `SELECT messages FROM client_session_archive_chunks
         WHERE session_id = ? AND user_id = ?
         ORDER BY last_seq DESC`,
    )
    .iterate(sessionId, userId) as Iterable<{ messages: string }>
  for (const chunk of chunks) {
    const archived = deriveArchivedOrderSeqsForRead(safeParseMessageArray(chunk.messages))
    const combined = [...archived, ...selected.messages]
    combined.sort(compareMessagesByOrder)
    selected = selectEngineContextSuffix(combined, effectiveOptions)
    if (selected.truncated) break
  }
  return selected.messages
}

function hasCompletedClientMessage(messages: MessageLike[], clientMessageId: string): boolean {
  return messages.some(
    (message) =>
      message?.role === 'assistant' &&
      message._clientMessageId === clientMessageId &&
      message.status === 'completed' &&
      message._errorCode === undefined &&
      message._isError !== true,
  )
}

export async function _sqliteHasCompletedClientTurn(
  sessionId: string,
  userId: string,
  clientMessageId: string,
): Promise<boolean> {
  const db = await getSessionsDb()
  const row = db
    .prepare('SELECT messages FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(sessionId, userId) as { messages: string } | undefined
  if (!row) return false
  const hot = safeParseMessageArray(row.messages)
  if (hasCompletedClientMessage(hot, clientMessageId)) return true
  const hotContainsClientMessage = hot.some(
    (message) => message?.id === clientMessageId || message?._clientMessageId === clientMessageId,
  )
  if (hotContainsClientMessage) return false
  const archivedId = db
    .prepare('SELECT 1 FROM client_session_archived_ids WHERE session_id = ? AND msg_id = ?')
    .get(sessionId, clientMessageId)
  if (!archivedId) return false
  const chunks = db
    .prepare(
      `SELECT messages FROM client_session_archive_chunks
         WHERE session_id = ? AND user_id = ? ORDER BY last_seq DESC`,
    )
    .iterate(sessionId, userId) as Iterable<{ messages: string }>
  for (const chunk of chunks) {
    if (hasCompletedClientMessage(safeParseMessageArray(chunk.messages), clientMessageId)) {
      return true
    }
  }
  return false
}

function computeSnapshotMaxSeq(hot: readonly MessageLike[], archivedThrough: number): number {
  let snapshotMaxSeq = 0
  for (const message of hot) {
    if (
      typeof message._seq === 'number' &&
      Number.isSafeInteger(message._seq) &&
      message._seq > snapshotMaxSeq
    ) {
      snapshotMaxSeq = message._seq
    }
  }
  return snapshotMaxSeq === 0 ? archivedThrough : snapshotMaxSeq
}

function appendArchivedTimelineMessages(
  db: Database.Database,
  sessionId: string,
  userId: string,
  beforeOrderSeq: number,
  cappedLimit: number,
  pool: MessageLike[],
): void {
  const chunks = db
    .prepare(
      `SELECT messages FROM client_session_archive_chunks
        WHERE session_id = ? AND user_id = ? AND first_seq < ?
        ORDER BY last_seq DESC`,
    )
    .iterate(sessionId, userId, beforeOrderSeq) as Iterable<{ messages: string }>
  for (const chunk of chunks) {
    for (const message of deriveArchivedOrderSeqsForRead(safeParseMessageArray(chunk.messages))) {
      if (isValidOrderSeq(message._orderSeq) && message._orderSeq < beforeOrderSeq) {
        pool.push(message)
      }
    }
    if (pool.length > cappedLimit) break
  }
}

export async function _sqliteReadClientTimelinePage(
  sessionId: string,
  userId: string,
  cursor: ClientTimelineCursor | null = null,
  limit = 100,
): Promise<ClientTimelinePage | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare(
      `SELECT messages, archived_through_seq, history_revision, timeline_generation
         FROM client_sessions
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .get(sessionId, userId) as
    | {
        messages: string
        archived_through_seq: number | null
        history_revision: number
        timeline_generation: number
      }
    | undefined
  if (!row) return null
  const generation =
    Number.isSafeInteger(row.timeline_generation) && row.timeline_generation > 0
      ? row.timeline_generation
      : 1
  if (cursor && cursor.timelineGeneration !== generation) {
    throw new ClientTimelineCursorStaleError()
  }
  const cappedLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 100)))
  const beforeOrderSeq = cursor?.beforeOrderSeq ?? Number.MAX_SAFE_INTEGER
  const archivedThrough = typeof row.archived_through_seq === 'number' ? row.archived_through_seq : 0
  const hot = deriveOrderSeqsForRead(safeParseMessageArray(row.messages), archivedThrough)
  const snapshotMaxSeq = computeSnapshotMaxSeq(hot, archivedThrough)

  const pool = hot.filter(
    (message) => isValidOrderSeq(message._orderSeq) && message._orderSeq < beforeOrderSeq,
  )
  if (pool.length <= cappedLimit && archivedThrough > 0) {
    appendArchivedTimelineMessages(db, sessionId, userId, beforeOrderSeq, cappedLimit, pool)
  }
  pool.sort(compareMessagesByOrder)
  const hasMore = pool.length > cappedLimit
  const page = pool.slice(Math.max(0, pool.length - cappedLimit)).map((message) => ({
    ...message,
    _timelineRecord: true,
    _timelineUnitKey: `outer:${String(message._orderSeq)}:${String(message.id ?? '')}`,
  }))
  const oldest = page[0]
  const nextCursor =
    hasMore && oldest && isValidOrderSeq(oldest._orderSeq)
      ? { version: 1 as const, timelineGeneration: generation, beforeOrderSeq: oldest._orderSeq }
      : null
  return {
    messages: page,
    nextCursor,
    hasMore,
    timelineGeneration: generation,
    historyRevision: row.history_revision,
    snapshotMaxSeq,
  }
}

export async function _sqliteListTurnTapeRecords(
  _sessionId: string,
  _userId: string,
  _tapeId: string,
  _cursor: number,
  _limit: number,
  _before?: number | null,
): Promise<{ records: MessageLike[]; nextCursor: number | null; total: number } | null> {
  return null
}

export async function _sqliteReadTapeRecordPayload(
  _sessionId: string,
  _userId: string,
  _tapeId: string,
  _recordOrdinal: number,
  _offset = 0,
  _length?: number,
): Promise<{
  payload: Buffer
  totalBytes: number
  offset: number
  msgId: string
  role: string
  contentSha256: string
  tapeSha256: string
} | null> {
  return null
}

export async function _sqliteReadTapeRecordPayloadChunk(
  _sessionId: string,
  _userId: string,
  _tapeId: string,
  _recordOrdinal: number,
  _offset: number,
  _requestedBytes?: number,
): Promise<{
  chunk: Buffer
  nextOffset: number | null
  totalBytes: number
  start: number
  endExclusive: number
  msgId: string
  role: string
  contentSha256: string
  tapeSha256: string
} | null> {
  return null
}

export async function _sqliteReadUserMessagePayload(
  _sessionId: string,
  _userId: string,
  _msgId: string,
  _offset = 0,
  _length?: number,
): Promise<{
  payload: Buffer
  totalBytes: number
  offset: number
  msgId: string
  role: 'user'
  contentSha256: string
} | null> {
  return null
}
