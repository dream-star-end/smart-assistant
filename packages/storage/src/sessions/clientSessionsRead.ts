import Database from 'better-sqlite3'
import { paths } from '../paths.js'
import {
  scanUploadReferenceRows,
  UPLOAD_REFERENCE_MAX_BYTES,
  type UploadReferenceOptions,
  type UploadReferenceRow,
} from '../sessionUploadReferences.js'
import { _sqliteReadClientTimelinePage } from './clientSessionsTimeline.js'
import { deriveOrderSeqsForRead } from './orderAndSeq.js'
import { getSessionsDb } from './sqliteHandle.js'
import {
  type ClientSession,
  type ClientSessionCollabParent,
  type ClientSessionLifecycle,
  type ClientSessionLifecycleRef,
  type ClientSessionMeta,
  type ClientSessionPartial,
  type ClientSessionReadOptions,
  LAST_D_TERMINAL_MS_SQL,
  LAST_MESSAGE_PREVIEW_TAIL_MAX,
  LAST_READ_AT_MS_SQL,
  type ListClientSessionsOpts,
  type ListClientSessionsResult,
  type MessageLike,
  SESSION_LIST_LIMIT_MAX,
  SESSION_SEARCH_JSON_EXPAND_MAX_BYTES,
  UNREAD_OUTCOME_SQL,
  mapClientSessionLastOutcome,
  safeParseMessageArray,
  toLastMessagePreview,
} from './types.js'

const SQLITE_LAST_PREVIEW_SQL = `
  CASE
    WHEN length(CAST(cs.messages AS BLOB)) > ${SESSION_SEARCH_JSON_EXPAND_MAX_BYTES} THEN NULL
    ELSE (
      SELECT substr(trim(COALESCE(json_extract(j.value, '$.text'), '')), 1, 240)
        FROM json_each(cs.messages) j
       WHERE CAST(j.key AS INTEGER) >= json_array_length(cs.messages) - ${LAST_MESSAGE_PREVIEW_TAIL_MAX}
         AND length(trim(COALESCE(json_extract(j.value, '$.text'), ''))) > 0
       ORDER BY CAST(j.key AS INTEGER) DESC
       LIMIT 1
    )
  END`

interface ClientSessionMetaRow {
  id: string
  agent_id: string
  title: string
  pinned: number
  created_at: number
  last_at: number
  updated_at: number
  msg_count: number
  model_id: string | null
  project_id: string | null
  run_state: string
  last_outcome: string | null
  archived_at: number | null
  last_preview_raw: string | null
  unread: number
}

function mapClientSessionMetaRow(r: ClientSessionMetaRow): ClientSessionMeta {
  const preview = toLastMessagePreview(r.last_preview_raw)
  return {
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    lastAt: r.last_at,
    messageCount: r.msg_count,
    updatedAt: r.updated_at,
    projectId: r.project_id ?? null,
    runState: r.run_state === 'running' ? 'running' : 'idle',
    lastOutcome: mapClientSessionLastOutcome(r.last_outcome),
    lastErrorCode: null,
    archived: r.archived_at != null,
    unread: r.unread === 1,
    ...(preview ? { lastMessagePreview: preview } : {}),
    ...(r.model_id ? { modelId: r.model_id } : {}),
  }
}

export async function _sqliteListClientSessions(
  userId: string,
  opts: ListClientSessionsOpts = {},
): Promise<ListClientSessionsResult> {
  const db = await getSessionsDb()
  const includeArchived = opts.includeArchived === true
  const before =
    typeof opts.before === 'number' && Number.isFinite(opts.before) && opts.before > 0
      ? Math.floor(opts.before)
      : undefined
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(SESSION_LIST_LIMIT_MAX, Math.floor(opts.limit))
      : undefined
  const params: unknown[] = [userId]
  let where = 'cs.user_id = ? AND cs.deleted_at IS NULL'
  if (!includeArchived) where += ' AND cs.archived_at IS NULL'
  if (before !== undefined) {
    where += ' AND cs.last_at < ?'
    params.push(before)
  }
  const limitSql = limit !== undefined ? ' LIMIT ?' : ''
  if (limit !== undefined) params.push(limit + 1)
  const rows = db
    .prepare(`
      SELECT cs.id, cs.agent_id, cs.title, cs.pinned, cs.created_at, cs.last_at, cs.updated_at,
             cs.message_count as msg_count, cs.model_id, cs.project_id, cs.archived_at,
             ${SQLITE_LAST_PREVIEW_SQL} AS last_preview_raw,
             CASE WHEN open_d.session_id IS NOT NULL THEN 'running' ELSE 'idle' END AS run_state,
             last_d.outcome AS last_outcome,
             CASE WHEN last_d.outcome IN (${UNREAD_OUTCOME_SQL})
                   AND ${LAST_D_TERMINAL_MS_SQL} > ${LAST_READ_AT_MS_SQL}
                  THEN 1 ELSE 0 END AS unread
      FROM client_sessions cs
      LEFT JOIN (
        SELECT session_id FROM turn_dispatch_inbox
         WHERE state NOT IN ('terminal', 'rejected')
         GROUP BY session_id
      ) open_d ON open_d.session_id = cs.id
      LEFT JOIN (
        SELECT session_id, outcome, terminal_at FROM (
          SELECT session_id, outcome, updated_at AS terminal_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY session_id
                   ORDER BY updated_at DESC, client_message_id DESC
                 ) AS rn
            FROM turn_dispatch_inbox
           WHERE state IN ('terminal', 'rejected')
        ) ranked
        WHERE rn = 1
      ) last_d ON last_d.session_id = cs.id
      WHERE ${where}
      ORDER BY cs.last_at DESC${limitSql}
    `)
    .all(...params) as ClientSessionMetaRow[]
  let nextCursor: number | undefined
  let sliced = rows
  if (limit !== undefined && rows.length > limit) {
    sliced = rows.slice(0, limit)
    const last = sliced[sliced.length - 1]
    if (last) nextCursor = last.last_at
  }
  return {
    sessions: sliced.map(mapClientSessionMetaRow),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  }
}

interface ClientSessionDbRow {
  id: string
  user_id: string
  agent_id: string
  title: string
  pinned: number
  created_at: number
  last_at: number
  messages: string
  updated_at: number
  archived_through_seq: number | null
  archived_count: number | null
  history_revision: number
  timeline_generation: number
  model_id: string | null
}

export async function _sqliteGetClientSession(
  id: string,
  userId?: string,
  options: ClientSessionReadOptions = {},
): Promise<ClientSession | null> {
  const db = await getSessionsDb()
  const sql = userId
    ? 'SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count, history_revision, timeline_generation, model_id FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    : 'SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count, history_revision, timeline_generation, model_id FROM client_sessions WHERE id = ? AND deleted_at IS NULL'
  const row = (userId ? db.prepare(sql).get(id, userId) : db.prepare(sql).get(id)) as
    | ClientSessionDbRow
    | undefined
  if (!row) return null
  const archivedThroughOrderSeq = row.archived_through_seq ?? 0
  const exactMessages = deriveOrderSeqsForRead(
    JSON.parse(row.messages) as MessageLike[],
    archivedThroughOrderSeq,
  )
  const timelinePage =
    options.view === 'timeline'
      ? await _sqliteReadClientTimelinePage(row.id, row.user_id, null, 100)
      : null
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    lastAt: row.last_at,
    messages: timelinePage?.messages ?? exactMessages,
    updatedAt: row.updated_at,
    historyRevision: row.history_revision,
    timelineGeneration: timelinePage?.timelineGeneration ?? row.timeline_generation,
    ...(timelinePage
      ? {
          timelineCursor: timelinePage.nextCursor,
          timelineHasMore: timelinePage.hasMore,
          timelineSnapshotMaxSeq: timelinePage.snapshotMaxSeq,
        }
      : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    archivedCount: row.archived_count ?? 0,
    archivedThroughSeq: archivedThroughOrderSeq,
  }
}

export async function _sqliteGetClientSessionCollabParent(
  sessionId: string,
  userId: string,
): Promise<ClientSessionCollabParent | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare(
      'SELECT id, user_id, agent_id, model_id FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .get(sessionId, userId) as
    | { id: string; user_id: string; agent_id: string; model_id: string | null }
    | undefined
  if (!row) return null
  return {
    sessionId: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    ...(row.model_id ? { modelId: row.model_id } : {}),
  }
}

export async function _sqliteClassifyClientSessions(
  refs: readonly ClientSessionLifecycleRef[],
): Promise<ClientSessionLifecycle[]> {
  if (refs.length === 0) return []
  const db = await getSessionsDb()
  const stmt = db.prepare('SELECT deleted_at FROM client_sessions WHERE id = ? AND user_id = ?')
  return refs.map((ref) => {
    const row = stmt.get(ref.sessionId, ref.userId) as { deleted_at: number | null } | undefined
    return {
      ...ref,
      state: row === undefined ? 'missing' : row.deleted_at === null ? 'active' : 'deleted',
    }
  })
}

async function buildTimelinePartialResult(
  row: ClientSessionDbRow,
  archivedCount: number,
  archivedThroughSeq: number,
): Promise<ClientSessionPartial | null> {
  const page = await _sqliteReadClientTimelinePage(row.id, row.user_id, null, 100)
  if (!page) return null
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    lastAt: row.last_at,
    messages: page.messages,
    updatedAt: row.updated_at,
    historyRevision: page.historyRevision,
    timelineGeneration: page.timelineGeneration,
    timelineCursor: page.nextCursor,
    timelineHasMore: page.hasMore,
    timelineSnapshotMaxSeq: page.snapshotMaxSeq,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    totalMessageCount: page.messages.length + archivedCount,
    maxSeq: page.snapshotMaxSeq,
    isPartial: false,
    archivedCount,
    archivedThroughSeq,
  }
}

export async function _sqliteGetClientSessionPartial(
  id: string,
  userId: string,
  sinceSeq: number,
  options: ClientSessionReadOptions = {},
): Promise<ClientSessionPartial | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare(
      'SELECT id, user_id, agent_id, title, pinned, created_at, last_at, messages, updated_at, archived_through_seq, archived_count, history_revision, timeline_generation, model_id FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .get(id, userId) as ClientSessionDbRow | undefined
  if (!row) return null
  const archivedCount = row.archived_count ?? 0
  const archivedThroughSeq = row.archived_through_seq ?? 0

  if (options.view === 'timeline') {
    return buildTimelinePartialResult(row, archivedCount, archivedThroughSeq)
  }

  const allMsgs = deriveOrderSeqsForRead(safeParseMessageArray(row.messages), archivedThroughSeq)
  const anyMissingSeq = allMsgs.some(
    (m) => !m || typeof m._seq !== 'number' || !Number.isFinite(m._seq as number),
  )
  let maxSeq = 0
  for (const m of allMsgs) {
    const s = typeof m?._seq === 'number' ? m._seq : 0
    if (s > maxSeq) maxSeq = s
  }
  const sinceIsValid = Number.isFinite(sinceSeq) && sinceSeq > 0
  const historyRevisionMatches =
    Number.isSafeInteger(options.sinceHistoryRevision) &&
    options.sinceHistoryRevision === row.history_revision
  const isPartial = !anyMissingSeq && sinceIsValid && historyRevisionMatches
  const messages = isPartial
    ? allMsgs.filter((m) => typeof m?._seq === 'number' && (m._seq as number) > sinceSeq)
    : allMsgs

  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    lastAt: row.last_at,
    messages,
    updatedAt: row.updated_at,
    historyRevision: row.history_revision,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    totalMessageCount: allMsgs.length + archivedCount,
    maxSeq,
    isPartial,
    archivedCount,
    archivedThroughSeq,
  }
}

function summarizeUnclaimedMessages(raw: string): string {
  const msgs = safeParseMessageArray(raw) as Array<{ role?: string; text?: string }>
  const userMsgs = msgs.filter((m) => m.role === 'user').slice(0, 3)
  const summary = userMsgs.map((m) => (m.text || '').slice(0, 80)).join(' / ')
  return summary.length > 200 ? `${summary.slice(0, 200)}…` : summary
}

export async function _sqliteListUnclaimedSessions(): Promise<
  Array<{
    id: string
    agentId: string
    title: string
    createdAt: number
    lastAt: number
    messageCount: number
    summary: string
  }>
> {
  const db = await getSessionsDb()
  const rows = db
    .prepare(`
      SELECT id, agent_id, title, created_at, last_at, messages,
             message_count as msg_count
      FROM client_sessions
      WHERE user_id = 'default' AND deleted_at IS NULL
      ORDER BY last_at DESC
    `)
    .all() as Array<{
    id: string
    agent_id: string
    title: string
    created_at: number
    last_at: number
    messages: string
    msg_count: number
  }>
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    createdAt: r.created_at,
    lastAt: r.last_at,
    messageCount: r.msg_count,
    summary: summarizeUnclaimedMessages(r.messages),
  }))
}

export async function _sqliteAllMasterWsessRows(): Promise<
  Array<{ id: string; userId: string; createdAt: number }>
> {
  const db = await getSessionsDb()
  return db
    .prepare(`
      SELECT id, user_id AS userId, created_at AS createdAt
      FROM client_sessions
      WHERE id GLOB 'wsess-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
        AND origin_channel = 'wechat'
        AND deleted_at IS NULL
    `)
    .all() as Array<{ id: string; userId: string; createdAt: number }>
}

export async function _sqliteScanRecentClientSessionMessages(
  opts: UploadReferenceOptions,
  visit: (body: string) => void,
): Promise<boolean> {
  const db = new Database(opts.sessionsDb ?? paths.sessionsDb, {
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  })
  try {
    const cap = Math.min(opts.maxBytes ?? UPLOAD_REFERENCE_MAX_BYTES, UPLOAD_REFERENCE_MAX_BYTES)
    const rows = db
      .prepare(`
        SELECT id AS sessionId, user_id AS userId,
               CASE WHEN length(CAST(messages AS BLOB)) < ? THEN messages ELSE NULL END AS messages
          FROM client_sessions WHERE last_at >= ? AND deleted_at IS NULL AND (? IS NULL OR user_id = ?)
        UNION ALL
        SELECT s.id AS sessionId, s.user_id AS userId,
               CASE WHEN length(CAST(c.messages AS BLOB)) < ? THEN c.messages ELSE NULL END AS messages
          FROM client_session_archive_chunks c JOIN client_sessions s ON s.id = c.session_id AND s.user_id = c.user_id
         WHERE s.last_at >= ? AND s.deleted_at IS NULL AND (? IS NULL OR s.user_id = ?)
      `)
      .iterate(
        cap,
        opts.sinceMs,
        opts.userId,
        opts.userId,
        cap,
        opts.sinceMs,
        opts.userId,
        opts.userId,
      ) as Iterable<UploadReferenceRow>
    return await scanUploadReferenceRows(rows, visit, opts)
  } finally {
    db.close()
  }
}
