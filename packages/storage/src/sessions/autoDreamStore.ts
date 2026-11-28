import { getSessionsDb } from './sqliteHandle.js'
import type { AutoDreamSuccessfulSession, SessionMeta } from './types.js'

interface AutoDreamSuccessDbRow {
  seq: number
  session_id: string
  agent_id: string
  channel: string
  completed_at: number
}

function mapAutoDreamSuccessRow(row: AutoDreamSuccessDbRow): AutoDreamSuccessfulSession {
  return {
    seq: row.seq,
    id: row.session_id,
    agentId: row.agent_id,
    channel: row.channel,
    completedAt: row.completed_at,
  }
}

/** All retained session metadata for the optimizer's first consented audit. */
export async function listAutoDreamAuditSessions(agentId: string): Promise<SessionMeta[]> {
  const db = await getSessionsDb()
  const rows = db
    .prepare(
      `SELECT id, agent_id, channel, peer_id, title, started_at, last_at, turn_count, total_cost_usd
         FROM sessions_meta
        WHERE agent_id = ?
        ORDER BY last_at ASC, id ASC`,
    )
    .all(agentId) as Array<{
    id: string
    agent_id: string
    channel: string
    peer_id: string
    title: string | null
    started_at: number
    last_at: number
    turn_count: number
    total_cost_usd: number
  }>
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    channel: row.channel,
    peerId: row.peer_id,
    title: row.title ?? '(untitled)',
    startedAt: row.started_at,
    lastAt: row.last_at,
    turnCount: row.turn_count,
    totalCostUSD: row.total_cost_usd,
  }))
}

async function queryAutoDreamSuccessWindow(opts: {
  agentId: string
  channels: readonly string[]
  afterSeq?: number
  limit?: number | null
  order: 'oldest' | 'newest'
}): Promise<{ sessions: AutoDreamSuccessfulSession[]; throughSeq: number }> {
  const channels = [...new Set(opts.channels.filter(Boolean))]
  const afterSeq = Math.max(0, Math.floor(opts.afterSeq ?? 0))
  if (channels.length === 0) return { sessions: [], throughSeq: afterSeq }
  const db = await getSessionsDb()
  const placeholders = channels.map(() => '?').join(',')
  const upperRow = db
    .prepare(
      `SELECT COALESCE(MAX(seq), 0) AS seq
         FROM auto_dream_success_events
        WHERE agent_id = ?
          AND channel IN (${placeholders})`,
    )
    .get(opts.agentId, ...channels) as { seq: number }
  const throughSeq = Math.max(afterSeq, Number(upperRow.seq) || 0)
  if (throughSeq <= afterSeq) return { sessions: [], throughSeq }
  const newest = opts.order === 'newest'
  const limitClause = opts.limit != null ? '\n        LIMIT ?' : ''
  const params: unknown[] = [opts.agentId, ...channels, afterSeq, throughSeq]
  if (opts.limit != null) params.push(opts.limit)
  const rows = db
    .prepare(
      `WITH first_events AS (
         SELECT session_id, ${newest ? 'MAX' : 'MIN'}(seq) AS seq
           FROM auto_dream_success_events
          WHERE agent_id = ?
            AND channel IN (${placeholders})
            AND seq > ?
            AND seq <= ?
          GROUP BY session_id
       )
       SELECT e.seq, e.session_id, e.agent_id, e.channel, e.completed_at
         FROM first_events f
         JOIN auto_dream_success_events e ON e.seq = f.seq
        ORDER BY e.seq ${newest ? 'DESC' : 'ASC'}${limitClause}`,
    )
    .all(...params) as AutoDreamSuccessDbRow[]
  return {
    sessions: rows.map(mapAutoDreamSuccessRow),
    throughSeq,
  }
}

export async function listAutoDreamSuccessfulSessionsBetween(opts: {
  agentId: string
  channels: readonly string[]
  afterSeq?: number
}): Promise<{ sessions: AutoDreamSuccessfulSession[]; throughSeq: number }> {
  return queryAutoDreamSuccessWindow({ ...opts, limit: null, order: 'oldest' })
}

/** Persisted only from the signed, proven-success gateway terminal hook. */
export async function recordAutoDreamSuccessfulSession(input: {
  agentId: string
  sessionId: string
  channel: string
  completedAt: number
}): Promise<number> {
  const db = await getSessionsDb()
  const result = db
    .prepare(`
      INSERT INTO auto_dream_success_events (agent_id, session_id, channel, completed_at)
      VALUES (@agentId, @sessionId, @channel, @completedAt)
    `)
    .run(input)
  return Number(result.lastInsertRowid)
}

export async function scanAutoDreamSuccessfulSessions(opts: {
  agentId: string
  channels: readonly string[]
  afterSeq?: number
  limit?: number
  order?: 'oldest' | 'newest'
}): Promise<{ sessions: AutoDreamSuccessfulSession[]; throughSeq: number }> {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 32)))
  return queryAutoDreamSuccessWindow({
    agentId: opts.agentId,
    channels: opts.channels,
    afterSeq: opts.afterSeq,
    limit,
    order: opts.order === 'newest' ? 'newest' : 'oldest',
  })
}

/** Best-effort compaction after the durable state watermark has advanced. */
export async function pruneAutoDreamSuccessEvents(
  agentId: string,
  throughSeq: number,
): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(`DELETE FROM auto_dream_success_events WHERE agent_id = ? AND seq <= ?`).run(
    agentId,
    Math.max(0, Math.floor(throughSeq)),
  )
}
