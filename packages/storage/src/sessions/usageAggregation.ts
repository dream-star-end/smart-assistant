import type Database from 'better-sqlite3'
import { planCostPatch, planDelegateCostMerge } from '../clientSessionsPlan.js'
import { _appendServerAuthoredCore, _executeSpillPlan } from './clientSessionsWrite.js'
import { getSessionsDb } from './sqliteHandle.js'
import {
  type AppendCostCreditsResult,
  type AppendForRequestResult,
  type DrainDelegateCostResult,
  type MessageLike,
  type UsageAggregationGcStats,
  safeParseMessageArray,
} from './types.js'

const PENDING_AGING_MS = 60 * 60_000
const PENDING_HARD_DELETE_MS = 24 * 60 * 60_000
const MAP_HARD_DELETE_MS = 7 * 24 * 60 * 60_000

function parsePositiveBigInt(raw: string): bigint {
  try {
    const v = BigInt(raw)
    return v > 0n ? v : 0n
  } catch {
    return 0n
  }
}

function parseBaseBigInt(raw: unknown): bigint {
  try {
    return BigInt((raw as string) ?? '0')
  } catch {
    return 0n
  }
}

export async function _sqliteAppendServerAuthoredMessageForRequest(
  requestId: string,
  sessId: string,
  userId: string,
  message: MessageLike & { id: string },
): Promise<AppendForRequestResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): AppendForRequestResult => {
    const existingMap = db
      .prepare(
        'SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = ? AND user_id = ?',
      )
      .get(requestId, userId) as { session_id: string; msg_id: string } | undefined
    if (existingMap && (existingMap.session_id !== sessId || existingMap.msg_id !== message.id)) {
      throw new Error(
        `[sqliteSessions] server_authored_request_map 拒绝重映射: (requestId=${requestId},userId=${userId}) ` +
          `已映射 (${existingMap.session_id},${existingMap.msg_id}),本次欲映射 (${sessId},${message.id})`,
      )
    }

    const pending = db
      .prepare('SELECT cost_credits FROM pending_usage_patches WHERE request_id = ? AND user_id = ?')
      .get(requestId, userId) as { cost_credits: string } | undefined

    let msgToWrite: MessageLike & { id: string } = message
    if (pending) {
      const existingUsage =
        message.usage && typeof message.usage === 'object'
          ? (message.usage as Record<string, unknown>)
          : {}
      msgToWrite = {
        ...message,
        usage: { ...existingUsage, costCredits: pending.cost_credits },
      }
    }

    const r = _appendServerAuthoredCore(db, sessId, userId, msgToWrite)
    if (!r.applied) {
      if (pending && (r.reason === 'session_deleted' || r.reason === 'oversized')) {
        db.prepare('DELETE FROM pending_usage_patches WHERE request_id = ? AND user_id = ?').run(
          requestId,
          userId,
        )
      }
      return r
    }

    if (!existingMap) {
      db.prepare(
        `INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (request_id, user_id) DO NOTHING`,
      ).run(requestId, userId, sessId, message.id)
    }
    if (pending) {
      db.prepare('DELETE FROM pending_usage_patches WHERE request_id = ? AND user_id = ?').run(
        requestId,
        userId,
      )
    }
    return { applied: true }
  })
  return txn()
}

export async function _sqliteAppendServerAuthoredMessageDrainByUser<
  T extends MessageLike & { id: string },
>(
  sessId: string,
  userId: string,
  message: T,
  agentSessionId?: string | null,
): Promise<AppendForRequestResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): AppendForRequestResult => {
    const pendings = (
      agentSessionId
        ? db
            .prepare(
              'SELECT request_id, cost_credits FROM pending_usage_patches WHERE user_id = ? AND session_id = ?',
            )
            .all(userId, agentSessionId)
        : db
            .prepare('SELECT request_id, cost_credits FROM pending_usage_patches WHERE user_id = ?')
            .all(userId)
    ) as Array<{ request_id: string; cost_credits: string }>
    let sum = 0n
    for (const p of pendings) sum += parsePositiveBigInt(p.cost_credits)

    let msgToWrite: MessageLike & { id: string } = message
    if (sum > 0n) {
      const existingUsage =
        message.usage && typeof message.usage === 'object'
          ? (message.usage as Record<string, unknown>)
          : {}
      const base = parseBaseBigInt(existingUsage.costCredits)
      msgToWrite = {
        ...message,
        usage: { ...existingUsage, costCredits: (base + sum).toString() },
      }
    }

    const r = _appendServerAuthoredCore(db, sessId, userId, msgToWrite)
    if (!r.applied) return r
    if (pendings.length) {
      const del = db.prepare(
        'DELETE FROM pending_usage_patches WHERE user_id = ? AND request_id = ?',
      )
      for (const p of pendings) del.run(userId, p.request_id)
    }
    return { applied: true }
  })
  return txn()
}

function tryPatchMappedCostCredits(
  db: Database.Database,
  mapRow: { session_id: string; msg_id: string },
  userId: string,
  costCredits: string,
): AppendCostCreditsResult | null {
  const sess = db
    .prepare(
      'SELECT messages, next_seq, deleted_at, archived_through_seq, archived_count FROM client_sessions WHERE id = ? AND user_id = ?',
    )
    .get(mapRow.session_id, userId) as
    | {
        messages: string
        next_seq: number | null
        deleted_at: number | null
        archived_through_seq: number | null
        archived_count: number | null
      }
    | undefined
  if (!sess) return null
  if (sess.deleted_at !== null) return { applied: 'noop' }

  const msgs = safeParseMessageArray(sess.messages)
  const currentNextSeq = typeof sess.next_seq === 'number' && sess.next_seq > 0 ? sess.next_seq : 1
  const plan = planCostPatch(
    msgs,
    mapRow.msg_id,
    costCredits,
    currentNextSeq,
    sess.archived_through_seq ?? 0,
  )
  if (plan.kind === 'noop') return { applied: 'noop' }
  if (plan.kind === 'patch') {
    const nowMs = Date.now()
    const archivedDelta = _executeSpillPlan(
      db,
      mapRow.session_id,
      userId,
      plan.chunksToInsert,
      plan.idsToInsert,
      nowMs,
    )
    const newArchivedCount = (sess.archived_count ?? 0) + archivedDelta
    const historyRevisionDelta = archivedDelta > 0 ? 1 : 0
    db.prepare(
      'UPDATE client_sessions SET messages = ?, message_count = ?, last_at = ?, updated_at = MAX(updated_at + 1, ?), next_seq = next_seq + 1, archived_through_seq = ?, archived_count = ?, history_revision = history_revision + ? WHERE id = ? AND user_id = ?',
    ).run(
      plan.finalJson,
      plan.tail.length + newArchivedCount,
      nowMs,
      nowMs,
      plan.archivedThroughSeq,
      newArchivedCount,
      historyRevisionDelta,
      mapRow.session_id,
      userId,
    )
    return { applied: 'patched' }
  }
  const archivedHit = db
    .prepare('SELECT 1 FROM client_session_archived_ids WHERE session_id = ? AND msg_id = ?')
    .get(mapRow.session_id, mapRow.msg_id)
  return archivedHit ? { applied: 'noop' } : null
}

export async function _sqliteAppendCostCredits(
  requestId: string,
  userId: string,
  costCredits: string,
  sessionId?: string | null,
  parentSessionId?: string | null,
  delegateAgentId?: string | null,
  turnKey?: string | null,
  parentTurnKey?: string | null,
): Promise<AppendCostCreditsResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): AppendCostCreditsResult => {
    const mapRow = db
      .prepare(
        'SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id = ? AND user_id = ?',
      )
      .get(requestId, userId) as { session_id: string; msg_id: string } | undefined

    if (mapRow) {
      const patched = tryPatchMappedCostCredits(db, mapRow, userId, costCredits)
      if (patched) return patched
    }

    db.prepare(
      `INSERT INTO pending_usage_patches
         (request_id, user_id, session_id, parent_session_id, delegate_agent_id,
          turn_key, parent_turn_key, cost_credits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id, user_id) DO UPDATE SET
         cost_credits = excluded.cost_credits,
         session_id = excluded.session_id,
         parent_session_id = excluded.parent_session_id,
         delegate_agent_id = excluded.delegate_agent_id,
         turn_key = excluded.turn_key,
         parent_turn_key = excluded.parent_turn_key,
         created_at = (CAST(strftime('%s','now') AS INTEGER)*1000)`,
    ).run(
      requestId,
      userId,
      sessionId ?? null,
      parentSessionId ?? null,
      delegateAgentId ?? null,
      turnKey ?? null,
      parentTurnKey ?? null,
      costCredits,
    )
    return { applied: 'pending' }
  })
  return txn()
}

export async function _sqliteDrainDelegateCostForClientSession(
  clientSessionId: string,
  userId: string,
  msgId: string,
): Promise<DrainDelegateCostResult> {
  const db = await getSessionsDb()
  const txn = db.transaction((): DrainDelegateCostResult => {
    const pendings = db
      .prepare(
        'SELECT request_id, cost_credits, delegate_agent_id FROM pending_usage_patches WHERE user_id = ? AND parent_session_id = ?',
      )
      .all(userId, clientSessionId) as Array<{
      request_id: string
      cost_credits: string
      delegate_agent_id: string | null
    }>
    if (pendings.length === 0) return { merged: '0', drained: 0 }

    const sess = db
      .prepare(
        'SELECT messages, next_seq, archived_through_seq, archived_count FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      )
      .get(clientSessionId, userId) as
      | {
          messages: string
          next_seq: number | null
          archived_through_seq: number | null
          archived_count: number | null
        }
      | undefined

    const msgs = sess ? safeParseMessageArray(sess.messages) : null
    const currentNextSeq =
      sess && typeof sess.next_seq === 'number' && sess.next_seq > 0 ? sess.next_seq : 1
    const currentArchivedThroughSeq = sess?.archived_through_seq ?? 0

    const plan = planDelegateCostMerge(
      msgs,
      msgId,
      pendings.map((p) => ({ costCredits: p.cost_credits, delegateAgentId: p.delegate_agent_id })),
      currentNextSeq,
      currentArchivedThroughSeq,
    )

    const del = db.prepare('DELETE FROM pending_usage_patches WHERE user_id = ? AND request_id = ?')
    if (plan.kind === 'no_positive_cost') {
      for (const p of pendings) del.run(userId, p.request_id)
      return { merged: '0', drained: pendings.length }
    }
    if (plan.kind === 'target_not_ready') return { merged: '0', drained: 0 }

    const nowMs = Date.now()
    const archivedDelta = _executeSpillPlan(
      db,
      clientSessionId,
      userId,
      plan.chunksToInsert,
      plan.idsToInsert,
      nowMs,
    )
    const newArchivedCount = (sess!.archived_count ?? 0) + archivedDelta
    const historyRevisionDelta = archivedDelta > 0 ? 1 : 0
    db.prepare(
      'UPDATE client_sessions SET messages = ?, message_count = ?, last_at = ?, updated_at = MAX(updated_at + 1, ?), next_seq = next_seq + 1, archived_through_seq = ?, archived_count = ?, history_revision = history_revision + ? WHERE id = ? AND user_id = ?',
    ).run(
      plan.finalJson,
      plan.tail.length + newArchivedCount,
      nowMs,
      nowMs,
      plan.archivedThroughSeq,
      newArchivedCount,
      historyRevisionDelta,
      clientSessionId,
      userId,
    )
    for (const p of pendings) del.run(userId, p.request_id)
    return {
      merged: plan.merged,
      drained: pendings.length,
      ...(plan.delegates.length > 0 ? { delegates: plan.delegates } : {}),
    }
  })
  return txn()
}

export async function _sqliteSweepUsageAggregationGc(
  now: number = Date.now(),
): Promise<UsageAggregationGcStats> {
  const db = await getSessionsDb()
  const txn = db.transaction((): UsageAggregationGcStats => {
    const agingThreshold = now - PENDING_AGING_MS
    const expiredThreshold = now - PENDING_HARD_DELETE_MS
    const mapThreshold = now - MAP_HARD_DELETE_MS

    const aging = db
      .prepare(
        `SELECT COUNT(*) AS n FROM pending_usage_patches
         WHERE created_at <= ? AND created_at > ?`,
      )
      .get(agingThreshold, expiredThreshold) as { n: number }
    const delPending = db
      .prepare(
        `DELETE FROM pending_usage_patches
         WHERE created_at <= ? AND turn_key IS NULL AND parent_turn_key IS NULL`,
      )
      .run(expiredThreshold)
    const delMap = db
      .prepare('DELETE FROM server_authored_request_map WHERE written_at <= ?')
      .run(mapThreshold)

    return {
      pendingAging: aging.n,
      pendingExpired: delPending.changes,
      mapExpired: delMap.changes,
      pendingFolded: 0,
      pendingFoldAnomaly: 0,
      pendingUnreachableExpired: 0,
      tapePartsPurged: 0,
    }
  })
  return txn()
}
