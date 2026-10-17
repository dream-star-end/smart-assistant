/**
 * SQLite sessions store: sidebar operations on client sessions — unread state, search, batch actions, mark read, sync delete.
 *
 * Moved verbatim out of sessionsDb.ts — FINDINGS §8 (cc2), OCV5-485. sessionsDb.ts
 * imports these back and re-exports its former exports, so its import surface is unchanged.
 */
import type Database from 'better-sqlite3'
import {
  toPlainSessionText,
  UNREAD_OUTCOME_SQL,
  LAST_D_TERMINAL_MS_SQL,
  LAST_READ_AT_MS_SQL,
  getSessionsDb,
  SESSION_SEARCH_JSON_EXPAND_MAX_BYTES,
} from './sessionsDb.js'

export const SESSION_SEARCH_LIMIT_DEFAULT = 30

export const SESSION_SEARCH_LIMIT_MAX = 50

export const SESSION_BATCH_IDS_MAX = 200

export const SEARCH_SNIPPET_MAX = 160

export const SEARCH_SNIPPET_RADIUS = 40

// 搜索 JSON 展开候选上限:TEXT LIKE/ILIKE 先收窄后按 last_at DESC 取最近 N 条再 json_each /
// json_array_elements。结果上限 50;80 给 title+message 合并排名留余量。极端账号(数十 MB
// tape、上百会话)不能把一次搜索变成对该用户全部行做 JSON 解析。
export const SESSION_SEARCH_JSON_CANDIDATE_MAX = 80

export type SessionSearchKind = 'title' | 'message'

export type SessionSearchHit = {
  sessionId: string
  title: string
  projectId: string | null
  snippet: string
  matchedAt: number
  kind: SessionSearchKind
  unread: boolean
}

export type MarkClientSessionReadResult =
  | { ok: true; updated: number }
  | { ok: false; error: 'not_found' }

export type SearchClientSessionsOpts = {
  q: string
  limit?: number
  includeArchived?: boolean
  /** undefined = no filter; null = ungrouped; string = chat_projects.id */
  projectId?: string | null
}

export function sqlProjectFilter(
  projectId: string | null | undefined,
  alias = 'cs',
): { sql: string; params: unknown[] } {
  if (projectId === undefined) return { sql: '', params: [] }
  if (projectId === null) return { sql: ` AND ${alias}.project_id IS NULL`, params: [] }
  return { sql: ` AND ${alias}.project_id = ?`, params: [projectId] }
}

export type SearchClientSessionsResult = {
  results: SessionSearchHit[]
}

export type BatchClientSessionsAction = 'archive' | 'unarchive' | 'delete' | 'move'

export type BatchSessionCasRow = {
  id: string
  projectId: string | null
  updatedAt: number
}

export type BatchClientSessionsInput = {
  ids?: unknown
  action?: unknown
  projectId?: unknown
  expectedSessions?: unknown
  operationId?: unknown
}

export type BatchClientSessionsResult =
  | {
      ok: true
      updated: number
      skipped: number
      operationId?: string
      post?: Array<{ id: string; projectId: string | null; updatedAt: number }>
    }
  | {
      ok: false
      error: 'invalid_ids' | 'invalid_action' | 'ids_limit' | 'project_not_found' | 'stale_session'
      staleIds?: string[]
    }

export function buildSearchSnippet(haystack: string, q: string): string {
  const plain = toPlainSessionText(haystack)
  if (!plain) return ''
  const needle = q.trim()
  const lower = plain.toLowerCase()
  const idx = needle ? lower.indexOf(needle.toLowerCase()) : 0
  const start = idx < 0 ? 0 : Math.max(0, idx - SEARCH_SNIPPET_RADIUS)
  const end =
    idx < 0
      ? Math.min(plain.length, SEARCH_SNIPPET_MAX)
      : Math.min(plain.length, idx + needle.length + SEARCH_SNIPPET_RADIUS)
  let slice = plain.slice(start, end)
  if (start > 0) slice = `…${slice}`
  if (end < plain.length) slice = `${slice}…`
  return slice.length > SEARCH_SNIPPET_MAX ? slice.slice(0, SEARCH_SNIPPET_MAX) : slice
}

/** LIKE/ILIKE 通配符转义;调用方配合 ESCAPE '\'。 */
export function escapeLikePattern(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function parseExpectedSessions(raw: unknown): BatchSessionCasRow[] | { invalid: true } | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return { invalid: true }
  const out: BatchSessionCasRow[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') return { invalid: true }
    const rec = row as { id?: unknown; projectId?: unknown; updatedAt?: unknown }
    if (typeof rec.id !== 'string' || !rec.id.trim()) return { invalid: true }
    if (
      rec.projectId !== null &&
      rec.projectId !== undefined &&
      typeof rec.projectId !== 'string'
    ) {
      return { invalid: true }
    }
    if (typeof rec.updatedAt !== 'number' || !Number.isFinite(rec.updatedAt))
      return { invalid: true }
    out.push({
      id: rec.id.trim(),
      projectId: rec.projectId === undefined ? null : (rec.projectId as string | null),
      updatedAt: rec.updatedAt,
    })
  }
  return out
}

export function parseSessionBatchInput(input: BatchClientSessionsInput):
  | BatchClientSessionsResult
  | {
      ids: string[]
      action: BatchClientSessionsAction
      projectId?: string | null
      expectedSessions?: BatchSessionCasRow[]
      operationId?: string
    } {
  if (!Array.isArray(input.ids)) return { ok: false, error: 'invalid_ids' }
  if (input.ids.length > SESSION_BATCH_IDS_MAX) return { ok: false, error: 'ids_limit' }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const raw of input.ids) {
    if (typeof raw !== 'string') return { ok: false, error: 'invalid_ids' }
    const id = raw.trim()
    if (id.length < 1 || id.length > 64) return { ok: false, error: 'invalid_ids' }
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (
    input.action !== 'archive' &&
    input.action !== 'unarchive' &&
    input.action !== 'delete' &&
    input.action !== 'move'
  ) {
    return { ok: false, error: 'invalid_action' }
  }
  const expectedSessions = parseExpectedSessions(input.expectedSessions)
  if (expectedSessions && 'invalid' in expectedSessions)
    return { ok: false, error: 'invalid_action' }
  if (expectedSessions && expectedSessions.length > 0) {
    if (expectedSessions.length !== ids.length)
      return { ok: false, error: 'stale_session', staleIds: ids }
    const idSet = new Set(ids)
    for (const row of expectedSessions) {
      if (!idSet.has(row.id)) return { ok: false, error: 'stale_session', staleIds: [row.id] }
    }
  }
  const operationId =
    typeof input.operationId === 'string' && input.operationId.trim()
      ? input.operationId.trim().slice(0, 80)
      : undefined
  if (input.action === 'move') {
    if (
      input.projectId !== undefined &&
      input.projectId !== null &&
      typeof input.projectId !== 'string'
    ) {
      return { ok: false, error: 'invalid_action' }
    }
    const projectId =
      input.projectId === undefined || input.projectId === null ? null : input.projectId.trim()
    if (projectId !== null && (projectId.length < 8 || projectId.length > 64)) {
      return { ok: false, error: 'invalid_action' }
    }
    return { ids, action: 'move', projectId, expectedSessions, operationId }
  }
  return { ids, action: input.action, expectedSessions, operationId }
}

export function rankSessionSearchHits<
  T extends { sessionId: string; matchedAt: number; kind: SessionSearchKind },
>(hits: T[], limit: number): T[] {
  const best = new Map<string, T>()
  for (const hit of hits) {
    const prev = best.get(hit.sessionId)
    if (
      !prev ||
      hit.matchedAt > prev.matchedAt ||
      (hit.matchedAt === prev.matchedAt && hit.kind === 'message')
    ) {
      best.set(hit.sessionId, hit)
    }
  }
  return [...best.values()].sort((a, b) => b.matchedAt - a.matchedAt).slice(0, limit)
}

function _sqliteUnreadBySessionIds(
  db: Database.Database,
  userId: string,
  ids: string[],
): Map<string, boolean> {
  const unread = new Map<string, boolean>()
  if (ids.length === 0) return unread
  const rows = db
    .prepare(`
    SELECT cs.id,
           CASE WHEN last_d.outcome IN (${UNREAD_OUTCOME_SQL})
                 AND ${LAST_D_TERMINAL_MS_SQL} > ${LAST_READ_AT_MS_SQL}
                THEN 1 ELSE 0 END AS unread
      FROM client_sessions cs
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
     WHERE cs.user_id = ? AND cs.deleted_at IS NULL
       AND cs.id IN (${ids.map(() => '?').join(',')})
  `)
    .all(userId, ...ids) as Array<{ id: string; unread: number }>
  for (const r of rows) unread.set(r.id, r.unread === 1)
  return unread
}

export async function _sqliteSearchClientSessions(
  userId: string,
  opts: SearchClientSessionsOpts,
): Promise<SearchClientSessionsResult> {
  const q = opts.q.trim()
  if (!q) return { results: [] }
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(SESSION_SEARCH_LIMIT_MAX, Math.floor(opts.limit))
      : SESSION_SEARCH_LIMIT_DEFAULT
  const includeArchived = opts.includeArchived === true
  const like = `%${escapeLikePattern(q)}%`
  const db = await getSessionsDb()
  const archiveSql = includeArchived ? '' : ' AND cs.archived_at IS NULL'
  const projectFilt = sqlProjectFilter(opts.projectId)
  const scopeSql = `${archiveSql}${projectFilt.sql}`
  const candMax = SESSION_SEARCH_JSON_CANDIDATE_MAX
  const expandMax = SESSION_SEARCH_JSON_EXPAND_MAX_BYTES
  const titleRows = db
    .prepare(`
    SELECT id, title, project_id, last_at
      FROM client_sessions cs
     WHERE cs.user_id = ? AND cs.deleted_at IS NULL${scopeSql}
       AND cs.title LIKE ? ESCAPE '\\'
  `)
    .all(userId, ...projectFilt.params, like) as Array<{
    id: string
    title: string
    project_id: string | null
    last_at: number
  }>
  // 两段式:TEXT LIKE 收窄 → 最近 N 条 → 小行才 json_each。不把 messages blob 拉进 Node,也不对未命中行做 JSON.parse。
  const msgRows = db
    .prepare(`
    SELECT cs.id, cs.title, cs.project_id,
           COALESCE(json_extract(j.value, '$.ts'), cs.last_at) AS matched_at,
           substr(COALESCE(json_extract(j.value, '$.text'), ''), 1, 400) AS msg_text
      FROM (
        SELECT id, title, project_id, last_at, messages
          FROM client_sessions cs
         WHERE cs.user_id = ? AND cs.deleted_at IS NULL${scopeSql}
           AND cs.messages LIKE ? ESCAPE '\\'
           AND length(CAST(cs.messages AS BLOB)) <= ?
         ORDER BY cs.last_at DESC
         LIMIT ?
      ) cs, json_each(cs.messages) j
     WHERE json_extract(j.value, '$.text') LIKE ? ESCAPE '\\'
  `)
    .all(userId, ...projectFilt.params, like, expandMax, candMax, like) as Array<{
    id: string
    title: string
    project_id: string | null
    matched_at: number
    msg_text: string
  }>
  const oversizedMsgRows = db
    .prepare(`
    SELECT id, title, project_id, last_at AS matched_at,
           substr(messages, max(1, instr(lower(messages), lower(?)) - 80), 400) AS msg_text
      FROM client_sessions cs
     WHERE cs.user_id = ? AND cs.deleted_at IS NULL${scopeSql}
       AND cs.messages LIKE ? ESCAPE '\\'
       AND length(CAST(cs.messages AS BLOB)) > ?
     ORDER BY last_at DESC
     LIMIT ?
  `)
    .all(q, userId, ...projectFilt.params, like, expandMax, candMax) as Array<{
    id: string
    title: string
    project_id: string | null
    matched_at: number
    msg_text: string
  }>
  const chunkRows = db
    .prepare(`
    SELECT cs.id, cs.title, cs.project_id,
           COALESCE(json_extract(j.value, '$.ts'), cs.last_at) AS matched_at,
           substr(COALESCE(json_extract(j.value, '$.text'), ''), 1, 400) AS msg_text
      FROM (
        SELECT cs.id, cs.title, cs.project_id, cs.last_at, ch.messages
          FROM client_session_archive_chunks ch
          JOIN client_sessions cs ON cs.id = ch.session_id AND cs.user_id = ch.user_id
         WHERE cs.user_id = ? AND cs.deleted_at IS NULL${scopeSql}
           AND ch.messages LIKE ? ESCAPE '\\'
           AND length(CAST(ch.messages AS BLOB)) <= ?
         ORDER BY cs.last_at DESC
         LIMIT ?
      ) cs, json_each(cs.messages) j
     WHERE json_extract(j.value, '$.text') LIKE ? ESCAPE '\\'
  `)
    .all(userId, ...projectFilt.params, like, expandMax, candMax, like) as Array<{
    id: string
    title: string
    project_id: string | null
    matched_at: number
    msg_text: string
  }>
  const oversizedChunkRows = db
    .prepare(`
    SELECT cs.id, cs.title, cs.project_id, cs.last_at AS matched_at,
           substr(ch.messages, max(1, instr(lower(ch.messages), lower(?)) - 80), 400) AS msg_text
      FROM client_session_archive_chunks ch
      JOIN client_sessions cs ON cs.id = ch.session_id AND cs.user_id = ch.user_id
     WHERE cs.user_id = ? AND cs.deleted_at IS NULL${scopeSql}
       AND ch.messages LIKE ? ESCAPE '\\'
       AND length(CAST(ch.messages AS BLOB)) > ?
     ORDER BY cs.last_at DESC
     LIMIT ?
  `)
    .all(q, userId, ...projectFilt.params, like, expandMax, candMax) as Array<{
    id: string
    title: string
    project_id: string | null
    matched_at: number
    msg_text: string
  }>
  const hits: Array<Omit<SessionSearchHit, 'unread'>> = [
    ...titleRows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      projectId: r.project_id ?? null,
      snippet: buildSearchSnippet(r.title, q),
      matchedAt: r.last_at,
      kind: 'title' as const,
    })),
    ...msgRows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      projectId: r.project_id ?? null,
      snippet: buildSearchSnippet(r.msg_text, q),
      matchedAt: Number(r.matched_at) || 0,
      kind: 'message' as const,
    })),
    ...chunkRows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      projectId: r.project_id ?? null,
      snippet: buildSearchSnippet(r.msg_text, q),
      matchedAt: Number(r.matched_at) || 0,
      kind: 'message' as const,
    })),
    ...oversizedMsgRows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      projectId: r.project_id ?? null,
      snippet: buildSearchSnippet(r.msg_text, q),
      matchedAt: Number(r.matched_at) || 0,
      kind: 'message' as const,
    })),
    ...oversizedChunkRows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      projectId: r.project_id ?? null,
      snippet: buildSearchSnippet(r.msg_text, q),
      matchedAt: Number(r.matched_at) || 0,
      kind: 'message' as const,
    })),
  ]
  const ranked = rankSessionSearchHits(hits, limit)
  const unreadMap = _sqliteUnreadBySessionIds(
    db,
    userId,
    ranked.map((h) => h.sessionId),
  )
  return {
    results: ranked.map((h) => ({ ...h, unread: unreadMap.get(h.sessionId) === true })),
  }
}

export async function _sqliteBatchClientSessions(
  userId: string,
  input: BatchClientSessionsInput,
): Promise<BatchClientSessionsResult> {
  const parsed = parseSessionBatchInput(input)
  if ('ok' in parsed) return parsed
  const { ids, action } = parsed
  if (ids.length === 0) return { ok: true, updated: 0, skipped: 0, operationId: parsed.operationId }
  const db = await getSessionsDb()
  const now = Date.now()
  try {
    return db.transaction((): BatchClientSessionsResult => {
      if (parsed.expectedSessions && parsed.expectedSessions.length > 0) {
        const staleIds: string[] = []
        const lookup = db.prepare(
          `SELECT id, project_id, updated_at, deleted_at FROM client_sessions
          WHERE user_id = ? AND id = ?`,
        )
        for (const exp of parsed.expectedSessions) {
          const live = lookup.get(userId, exp.id) as
            | {
                id: string
                project_id: string | null
                updated_at: number
                deleted_at: number | null
              }
            | undefined
          if (
            !live ||
            live.deleted_at ||
            live.updated_at !== exp.updatedAt ||
            (live.project_id ?? null) !== (exp.projectId ?? null)
          ) {
            staleIds.push(exp.id)
          }
        }
        if (staleIds.length) return { ok: false, error: 'stale_session', staleIds }
      }
      if (action === 'move' && parsed.projectId) {
        const owned = db
          .prepare(
            'SELECT 1 AS ok FROM chat_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
          )
          .get(parsed.projectId, userId) as { ok: number } | undefined
        if (!owned) return { ok: false, error: 'project_not_found' }
      }
      const ownedRows = db
        .prepare(
          `SELECT id FROM client_sessions
        WHERE user_id = ? AND deleted_at IS NULL
          AND id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(userId, ...ids) as Array<{ id: string }>
      const owned = new Set(ownedRows.map((r) => r.id))
      const skipped = ids.length - owned.size
      const targetIds = ids.filter((id) => owned.has(id))
      if (targetIds.length === 0) return { ok: true, updated: 0, skipped }
      let updated = 0
      if (action === 'delete') {
        for (const id of targetIds) {
          if (_sqliteDeleteClientSessionSync(db, id, userId, now)) updated++
        }
      } else if (action === 'archive') {
        const res = db
          .prepare(
            `UPDATE client_sessions
            SET archived_at = COALESCE(archived_at, ?), updated_at = MAX(updated_at + 1, ?)
          WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL
            AND id IN (${targetIds.map(() => '?').join(',')})`,
          )
          .run(now, now, userId, ...targetIds)
        updated = res.changes
      } else if (action === 'unarchive') {
        const res = db
          .prepare(
            `UPDATE client_sessions
            SET archived_at = NULL, updated_at = MAX(updated_at + 1, ?)
          WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NOT NULL
            AND id IN (${targetIds.map(() => '?').join(',')})`,
          )
          .run(now, userId, ...targetIds)
        updated = res.changes
      } else if (parsed.expectedSessions && parsed.expectedSessions.length > 0) {
        const post: Array<{ id: string; projectId: string | null; updatedAt: number }> = []
        const upd = db.prepare(
          `UPDATE client_sessions
            SET project_id = ?, updated_at = MAX(updated_at + 1, ?)
          WHERE id = ? AND user_id = ?
            AND deleted_at IS NULL AND archived_at IS NULL
            AND updated_at = ?
            AND ((? IS NULL AND project_id IS NULL) OR project_id = ?)
          RETURNING id, project_id, updated_at`,
        )
        for (const exp of parsed.expectedSessions) {
          const row = upd.get(
            parsed.projectId ?? null,
            now,
            exp.id,
            userId,
            exp.updatedAt,
            exp.projectId,
            exp.projectId,
          ) as { id: string; project_id: string | null; updated_at: number } | undefined
          if (!row) {
            throw Object.assign(new Error('stale_session'), { staleIds: [exp.id] })
          }
          post.push({ id: row.id, projectId: row.project_id, updatedAt: row.updated_at })
        }
        if (post.length !== parsed.expectedSessions.length) {
          throw Object.assign(new Error('stale_session'), { staleIds: ids })
        }
        return { ok: true, updated: post.length, skipped, operationId: parsed.operationId, post }
      } else {
        const res = db
          .prepare(
            `UPDATE client_sessions
            SET project_id = ?, updated_at = MAX(updated_at + 1, ?)
          WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL
            AND id IN (${targetIds.map(() => '?').join(',')})`,
          )
          .run(parsed.projectId ?? null, now, userId, ...targetIds)
        updated = res.changes
      }
      return { ok: true, updated, skipped, operationId: parsed.operationId }
    })()
  } catch (err) {
    const staleIds = (err as { staleIds?: string[] }).staleIds
    if (staleIds) return { ok: false, error: 'stale_session', staleIds }
    throw err
  }
}

export async function _sqliteMarkClientSessionRead(
  userId: string,
  sessionId: string,
): Promise<MarkClientSessionReadResult> {
  const db = await getSessionsDb()
  const now = Date.now() // epoch milliseconds; must match inbox.updated_at / list compare
  const res = db
    .prepare(
      `UPDATE client_sessions SET last_read_at = ?
      WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .run(now, userId, sessionId)
  if (res.changes === 0) return { ok: false, error: 'not_found' }
  return { ok: true, updated: res.changes }
}

export async function _sqliteMarkAllClientSessionsRead(
  userId: string,
): Promise<{ updated: number }> {
  const db = await getSessionsDb()
  const now = Date.now()
  const res = db
    .prepare(
      `UPDATE client_sessions SET last_read_at = ?
      WHERE user_id = ? AND deleted_at IS NULL`,
    )
    .run(now, userId)
  return { updated: res.changes }
}

function _sqliteDeleteClientSessionSync(
  db: Database.Database,
  id: string,
  userId: string,
  now: number,
): boolean {
  const result = db
    .prepare(
      "UPDATE client_sessions SET deleted_at = ?, updated_at = MAX(updated_at + 1, ?), messages = '[]', message_count = 0 WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .run(now, now, id, userId)
  if (result.changes === 0) return false
  db.prepare('DELETE FROM client_session_archive_chunks WHERE session_id = ?').run(id)
  db.prepare('DELETE FROM client_session_archived_ids WHERE session_id = ?').run(id)
  db.prepare('DELETE FROM pending_usage_patches WHERE parent_session_id = ?').run(id)
  db.prepare('DELETE FROM turn_dispatch_inbox WHERE session_id = ?').run(id)
  return true
}
