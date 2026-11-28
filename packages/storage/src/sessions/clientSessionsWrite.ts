import type Database from 'better-sqlite3'
import {
  planAppendServerAuthored,
  planSpillOverflow,
  type SpillChunkPlan,
} from '../clientSessionsPlan.js'
import { _stripClientPutMessages, mergePreservingServerAuthored } from './mergeAndStrip.js'
import {
  _warnSeqAnomaly,
  hasInvisibleHistoryMutation,
  hasInvisibleMessageRemoval,
  normalizeAndAssignSeqs,
} from './orderAndSeq.js'
import { getSessionsDb } from './sqliteHandle.js'
import {
  type ClientSession,
  MAX_SESSION_BYTES,
  type MessageLike,
  type PatchServerAuthoredResult,
  type ServerAuthoredAppendResult,
  type SpillOverflowResult,
  type UpsertClientSessionResult,
  safeParseMessageArray,
} from './types.js'

const STALE_WRITE_ROLLBACK = new Error('__stale_write_rollback__')

export function _executeSpillPlan(
  db: Database.Database,
  sessId: string,
  userId: string,
  chunksToInsert: SpillChunkPlan[],
  idsToInsert: string[],
  now: number,
): number {
  if (chunksToInsert.length === 0) return 0
  const insertChunk = db.prepare(
    `INSERT OR IGNORE INTO client_session_archive_chunks
       (session_id, user_id, first_seq, last_seq, message_count, messages, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertId = db.prepare(
    'INSERT OR IGNORE INTO client_session_archived_ids (session_id, msg_id) VALUES (?, ?)',
  )
  let archivedDelta = 0
  for (const chunk of chunksToInsert) {
    const cr = insertChunk.run(
      sessId,
      userId,
      chunk.firstSeq,
      chunk.lastSeq,
      chunk.messageCount,
      JSON.stringify(chunk.messages),
      now,
    )
    if (cr.changes > 0) archivedDelta += chunk.messageCount
  }
  for (const id of idsToInsert) insertId.run(sessId, id)
  return archivedDelta
}

export function _spillOverflowCore(
  db: Database.Database,
  sessId: string,
  userId: string,
  msgs: MessageLike[],
  opts: { currentArchivedThroughSeq: number; now?: number },
): SpillOverflowResult {
  const now = opts.now ?? Date.now()
  const plan = planSpillOverflow(msgs, opts.currentArchivedThroughSeq)
  const archivedDelta = _executeSpillPlan(
    db,
    sessId,
    userId,
    plan.chunksToInsert,
    plan.idsToInsert,
    now,
  )
  return { tail: plan.tail, archivedDelta, archivedThroughSeq: plan.archivedThroughSeq }
}

function filterOutArchivedIncoming(
  db: Database.Database,
  sessId: string,
  msgs: MessageLike[],
): MessageLike[] {
  const ids: string[] = []
  for (const m of msgs) if (typeof m?.id === 'string') ids.push(m.id)
  if (ids.length === 0) return msgs

  const archived = new Set<string>()
  const chunkSize = 400
  for (let off = 0; off < ids.length; off += chunkSize) {
    const batch = ids.slice(off, off + chunkSize)
    const placeholders = batch.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT msg_id FROM client_session_archived_ids WHERE session_id = ? AND msg_id IN (${placeholders})`,
      )
      .all(sessId, ...batch) as Array<{ msg_id: string }>
    for (const r of rows) archived.add(r.msg_id)
  }
  if (archived.size === 0) return msgs
  return msgs.filter((m) => !(typeof m?.id === 'string' && archived.has(m.id)))
}

interface ExistingClientSessionRow {
  messages: string
  updated_at: number
  next_seq: number | null
  archived_through_seq: number | null
  archived_count: number | null
  history_revision: number
}

function runUpsertTransaction(
  db: Database.Database,
  session: ClientSession,
  baseSyncedAt: number,
): UpsertClientSessionResult {
  const existing = db
    .prepare(
      'SELECT messages, updated_at, next_seq, archived_through_seq, archived_count, history_revision FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .get(session.id, session.userId) as ExistingClientSessionRow | undefined
  if (existing && existing.updated_at > baseSyncedAt) return 'rejected_stale'

  const oldMsgs = existing ? safeParseMessageArray(existing.messages) : []
  const clientMsgsRaw = _stripClientPutMessages(session.messages, oldMsgs)
  const clientMsgs = filterOutArchivedIncoming(db, session.id, clientMsgsRaw)
  const merged = mergePreservingServerAuthored(oldMsgs, clientMsgs) as MessageLike[]
  const currentNextSeq =
    existing && typeof existing.next_seq === 'number' && existing.next_seq > 0
      ? existing.next_seq
      : 1
  const { messages: finalMessages, nextSeq } = normalizeAndAssignSeqs(
    oldMsgs,
    merged,
    currentNextSeq,
    _warnSeqAnomaly,
    existing?.archived_through_seq ?? 0,
  )

  const now = Date.now()
  const spill = _spillOverflowCore(db, session.id, session.userId, finalMessages, {
    currentArchivedThroughSeq: existing?.archived_through_seq ?? 0,
    now,
  })
  const newArchivedCount = (existing?.archived_count ?? 0) + spill.archivedDelta
  const tail = spill.tail
  const historyRevisionDelta =
    existing && (hasInvisibleHistoryMutation(oldMsgs, finalMessages, tail) || spill.archivedDelta > 0)
      ? 1
      : 0
  const timelineGenerationDelta =
    existing && hasInvisibleMessageRemoval(oldMsgs, finalMessages) ? 1 : 0

  const finalJson = JSON.stringify(tail)
  if (Buffer.byteLength(finalJson, 'utf8') > MAX_SESSION_BYTES) {
    return 'oversized'
  }

  const result = db
    .prepare(`
      INSERT INTO client_sessions (id, user_id, agent_id, title, pinned, created_at, last_at, messages, message_count, updated_at, next_seq, archived_through_seq, archived_count, history_revision, model_id)
      VALUES (@id, @userId, @agentId, @title, @pinned, @createdAt, @lastAt, @messages, @messageCount, MAX(@updatedAt, @updatedAtFloor), @nextSeq, @archivedThroughSeq, @archivedCount, 0, @modelId)
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        title = excluded.title,
        pinned = excluded.pinned,
        last_at = excluded.last_at,
        messages = excluded.messages,
        message_count = excluded.message_count,
        model_id = COALESCE(excluded.model_id, client_sessions.model_id),
        updated_at = MAX(client_sessions.updated_at + 1, @updatedAtFloor, excluded.updated_at),
        next_seq = excluded.next_seq,
        archived_through_seq = excluded.archived_through_seq,
        archived_count = excluded.archived_count,
        history_revision = client_sessions.history_revision + @historyRevisionDelta,
        timeline_generation = client_sessions.timeline_generation + @timelineGenerationDelta
      WHERE client_sessions.updated_at <= @baseSyncedAt
        AND client_sessions.user_id = @userId
    `)
    .run({
      id: session.id,
      userId: session.userId,
      agentId: session.agentId,
      title: session.title,
      pinned: session.pinned ? 1 : 0,
      createdAt: session.createdAt,
      lastAt: session.lastAt,
      messages: finalJson,
      messageCount: tail.length + newArchivedCount,
      modelId: session.modelId ?? null,
      updatedAt: session.updatedAt,
      updatedAtFloor: now,
      baseSyncedAt,
      nextSeq,
      archivedThroughSeq: spill.archivedThroughSeq,
      archivedCount: newArchivedCount,
      historyRevisionDelta,
      timelineGenerationDelta,
    })
  if (result.changes > 0) return 'applied'
  throw STALE_WRITE_ROLLBACK
}

export async function _sqliteUpsertClientSession(
  session: ClientSession,
  baseSyncedAt = 0,
): Promise<UpsertClientSessionResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): UpsertClientSessionResult =>
    runUpsertTransaction(db, session, baseSyncedAt),
  )
  try {
    return txn()
  } catch (err) {
    if (err === STALE_WRITE_ROLLBACK) return 'rejected_stale'
    throw err
  }
}

export function _appendServerAuthoredCore(
  db: Database.Database,
  sessId: string,
  userId: string,
  message: MessageLike & { id: string },
): ServerAuthoredAppendResult {
  const row = db
    .prepare(
      'SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count FROM client_sessions WHERE id = ? AND user_id = ?',
    )
    .get(sessId, userId) as
    | {
        messages: string
        next_seq: number | null
        deleted_at: number | null
        archived_through_seq: number | null
        archived_count: number | null
      }
    | undefined
  if (!row) return { applied: false, reason: 'session_not_found' }
  if (row.deleted_at !== null) return { applied: false, reason: 'session_deleted' }

  const archivedHit = db
    .prepare('SELECT 1 FROM client_session_archived_ids WHERE session_id = ? AND msg_id = ?')
    .get(sessId, message.id)
  if (archivedHit) return { applied: false, reason: 'already_exists' }

  let msgs: MessageLike[]
  try {
    const parsed: unknown = JSON.parse(row.messages)
    if (!Array.isArray(parsed)) return { applied: false, reason: 'malformed' }
    msgs = parsed as MessageLike[]
  } catch {
    return { applied: false, reason: 'malformed' }
  }

  const currentNextSeq = typeof row.next_seq === 'number' && row.next_seq > 0 ? row.next_seq : 1
  const plan = planAppendServerAuthored(msgs, message, currentNextSeq, row.archived_through_seq ?? 0)
  if (plan.kind === 'already_exists') return { applied: false, reason: 'already_exists' }
  if (plan.kind === 'oversized') return { applied: false, reason: 'oversized' }

  const now = Date.now()
  const archivedDelta = _executeSpillPlan(
    db,
    sessId,
    userId,
    plan.chunksToInsert,
    plan.idsToInsert,
    now,
  )
  const newArchivedCount = (row.archived_count ?? 0) + archivedDelta
  const tail = plan.tail
  const historyRevisionDelta = hasInvisibleMessageRemoval(msgs, tail) || archivedDelta > 0 ? 1 : 0

  const update = db
    .prepare(
      'UPDATE client_sessions SET messages = ?, message_count = ?, last_at = ?, updated_at = MAX(updated_at + 1, ?), next_seq = ?, archived_through_seq = ?, archived_count = ?, history_revision = history_revision + ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .run(
      plan.finalJson,
      tail.length + newArchivedCount,
      now,
      now,
      plan.nextSeq,
      plan.archivedThroughSeq,
      newArchivedCount,
      historyRevisionDelta,
      sessId,
      userId,
    )
  if (update.changes !== 1) return { applied: false, reason: 'session_deleted' }
  return { applied: true }
}

export async function _sqliteAppendServerAuthoredMessage(
  sessId: string,
  userId: string,
  message: {
    id: string
    role: 'assistant' | 'user' | 'system' | 'thinking' | 'tool' | 'agent-group' | 'permission'
    text?: string
    ts?: number
    [k: string]: unknown
  },
): Promise<{
  applied: boolean
  reason?: 'session_not_found' | 'session_deleted' | 'already_exists' | 'malformed' | 'oversized'
}> {
  const db = await getSessionsDb()
  const txn = db.transaction((): ServerAuthoredAppendResult =>
    _appendServerAuthoredCore(db, sessId, userId, message as MessageLike & { id: string }),
  )
  const r = txn()
  return r.applied ? { applied: true } : { applied: false, reason: r.reason }
}

export async function _sqlitePatchServerAuthoredMessage(
  sessId: string,
  userId: string,
  msgId: string,
  patch: Record<string, unknown>,
): Promise<PatchServerAuthoredResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): PatchServerAuthoredResult => {
    const row = db
      .prepare('SELECT messages, next_seq, deleted_at FROM client_sessions WHERE id = ? AND user_id = ?')
      .get(sessId, userId) as
      | { messages: string; next_seq: number | null; deleted_at: number | null }
      | undefined
    if (!row) return { applied: false, reason: 'session_not_found' }
    if (row.deleted_at !== null) return { applied: false, reason: 'session_deleted' }
    let msgs: MessageLike[]
    try {
      const parsed: unknown = JSON.parse(row.messages)
      if (!Array.isArray(parsed)) return { applied: false, reason: 'not_found' }
      msgs = parsed as MessageLike[]
    } catch {
      return { applied: false, reason: 'not_found' }
    }
    const idx = msgs.findIndex((m) => m && m.id === msgId)
    if (idx < 0) return { applied: false, reason: 'not_found' }
    const nextSeq = typeof row.next_seq === 'number' && row.next_seq > 0 ? row.next_seq : 1
    msgs[idx] = { ...msgs[idx], ...patch, id: msgId, _source: 'server', _seq: nextSeq }
    const now = Date.now()
    const update = db
      .prepare(
        'UPDATE client_sessions SET messages = ?, updated_at = MAX(updated_at + 1, ?), next_seq = ?, history_revision = history_revision + 1 WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      )
      .run(JSON.stringify(msgs), now, nextSeq + 1, sessId, userId)
    if (update.changes !== 1) return { applied: false, reason: 'session_deleted' }
    return { applied: true }
  })
  return txn()
}

export async function _sqliteDeleteClientSession(id: string, userId?: string): Promise<boolean> {
  const db = await getSessionsDb()
  const sql = userId
    ? "UPDATE client_sessions SET deleted_at = ?, updated_at = MAX(updated_at + 1, ?), messages = '[]', message_count = 0 WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    : "UPDATE client_sessions SET deleted_at = ?, updated_at = MAX(updated_at + 1, ?), messages = '[]', message_count = 0 WHERE id = ? AND deleted_at IS NULL"
  const now = Date.now()
  const txn = db.transaction((): boolean => {
    const result = userId
      ? db.prepare(sql).run(now, now, id, userId)
      : db.prepare(sql).run(now, now, id)
    if (result.changes === 0) return false
    db.prepare('DELETE FROM client_session_archive_chunks WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM client_session_archived_ids WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM pending_usage_patches WHERE parent_session_id = ?').run(id)
    db.prepare('DELETE FROM turn_dispatch_inbox WHERE session_id = ?').run(id)
    return true
  })
  return txn()
}

export async function _sqliteRenameClientSession(
  id: string,
  userId: string,
  title: string,
): Promise<{ ok: boolean; updatedAt: number }> {
  const db = await getSessionsDb()
  const now = Date.now()
  const row = db
    .prepare(
      'UPDATE client_sessions SET title = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND user_id = ? AND deleted_at IS NULL RETURNING updated_at',
    )
    .get(title, now, id, userId) as { updated_at: number } | undefined
  return { ok: !!row, updatedAt: row ? row.updated_at : now }
}

export async function _sqliteSetClientSessionModel(
  id: string,
  userId: string,
  modelId: string,
): Promise<{ ok: boolean; updatedAt: number }> {
  const db = await getSessionsDb()
  const now = Date.now()
  const row = db
    .prepare(
      'UPDATE client_sessions SET model_id = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND user_id = ? AND deleted_at IS NULL RETURNING updated_at',
    )
    .get(modelId, now, id, userId) as { updated_at: number } | undefined
  return { ok: !!row, updatedAt: row ? row.updated_at : now }
}

export async function _sqliteBumpClientSessionHistoryRevision(
  id: string,
  userId: string,
): Promise<boolean> {
  const db = await getSessionsDb()
  const result = db
    .prepare(
      'UPDATE client_sessions SET history_revision = history_revision + 1, timeline_generation = timeline_generation + 1, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .run(Date.now(), id, userId)
  return result.changes > 0
}

export async function _sqliteUpsertMasterClientSession(input: {
  sessionId: string
  userId: string
  agentId: string
  originChannel: 'wechat' | 'qqbot'
  title: string
  createdAt: number
  lastAt: number
}): Promise<void> {
  const db = await getSessionsDb()
  const nowMs = Date.now()
  db.prepare(`
    INSERT INTO client_sessions
      (id, user_id, agent_id, title, created_at, last_at, updated_at, origin_channel)
    VALUES
      (@sessionId, @userId, @agentId, @title, @createdAt, @lastAt, MAX(@lastAt, @nowMs), @originChannel)
  `).run({
    sessionId: input.sessionId,
    userId: input.userId,
    agentId: input.agentId,
    title: input.title,
    createdAt: input.createdAt,
    lastAt: input.lastAt,
    nowMs,
    originChannel: input.originChannel,
  })
}

export async function _sqliteSoftDeleteMasterSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  return _sqliteDeleteClientSession(sessionId, userId)
}

export async function _sqliteClaimSession(sessionId: string, userId: string): Promise<boolean> {
  const db = await getSessionsDb()
  const result = db
    .prepare(`
      UPDATE client_sessions SET user_id = ?, updated_at = MAX(updated_at + 1, ?)
      WHERE id = ? AND user_id = 'default' AND deleted_at IS NULL
    `)
    .run(userId, Date.now(), sessionId)
  return result.changes > 0
}
