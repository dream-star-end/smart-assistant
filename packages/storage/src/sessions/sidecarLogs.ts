import { cjkFtsColumn, literalFtsQuery } from '../ftsQuery.js'
import { pruneOrphanedSessionsFtsRows } from '../sessionsDbIndexes.js'
import { getSessionsDb } from './sqliteHandle.js'
import type {
  EventLogEntry,
  InsertUsageLogResult,
  SearchHit,
  SessionMeta,
  UsageLogEntry,
  UsageSummary,
  UsageTerminalStatus,
} from './types.js'

interface EventLogDbRow {
  id: string
  type: string
  timestamp: number
  agent_id: string
  session_key: string | null
  schema_version: number
  payload: string
  peer_id: string | null
  channel: string | null
}

function mapEventLogRow(r: EventLogDbRow): EventLogEntry {
  return {
    id: r.id,
    type: r.type,
    timestamp: r.timestamp,
    agentId: r.agent_id,
    sessionKey: r.session_key ?? undefined,
    schemaVersion: r.schema_version,
    payload: r.payload,
    peerId: r.peer_id || undefined,
    channel: r.channel || undefined,
  }
}

export async function upsertSessionMeta(meta: SessionMeta): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(`
    INSERT INTO sessions_meta (id, agent_id, channel, peer_id, title, started_at, last_at, turn_count, total_cost_usd)
    VALUES (@id, @agentId, @channel, @peerId, @title, @startedAt, @lastAt, @turnCount, @totalCostUSD)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      last_at = excluded.last_at,
      turn_count = excluded.turn_count,
      total_cost_usd = excluded.total_cost_usd
  `).run(meta)
}

export async function indexTurn(
  sessionId: string,
  turnIdx: number,
  userText: string,
  assistantText: string,
): Promise<void> {
  const db = await getSessionsDb()
  const stmt = db.prepare(
    'INSERT INTO sessions_fts (session_id, turn_idx, role, content, content_fts) VALUES (?, ?, ?, ?, ?)',
  )
  if (userText) stmt.run(sessionId, turnIdx, 'user', userText, cjkFtsColumn(userText))
  if (assistantText) {
    stmt.run(sessionId, turnIdx, 'assistant', assistantText, cjkFtsColumn(assistantText))
  }
}

export async function getMaxTurnIdx(sessionIds: string[]): Promise<number> {
  if (sessionIds.length === 0) return 0
  const db = await getSessionsDb()
  const placeholders = sessionIds.map(() => '?').join(',')
  const row = db
    .prepare(`SELECT MAX(turn_idx) AS m FROM sessions_fts WHERE session_id IN (${placeholders})`)
    .get(...sessionIds) as { m: number | null } | undefined
  return row?.m == null ? 0 : Math.floor(row.m)
}

export async function hasPersistedTurnActivity(sessionIds: string[]): Promise<boolean> {
  if (sessionIds.length === 0) return false
  const db = await getSessionsDb()
  const placeholders = sessionIds.map(() => '?').join(',')
  const maxOf = (
    table: 'session_turn_counters' | 'sessions_fts' | 'sessions_meta',
    column: 'last_reserved_turn' | 'turn_idx' | 'turn_count',
    idColumn: 'session_id' | 'id',
  ): number => {
    const row = db
      .prepare(
        `SELECT MAX(CAST(${column} AS INTEGER)) AS m
           FROM ${table}
          WHERE ${idColumn} IN (${placeholders})`,
      )
      .get(...sessionIds) as { m: number | null } | undefined
    return row?.m == null ? 0 : Math.floor(row.m)
  }
  return (
    maxOf('session_turn_counters', 'last_reserved_turn', 'session_id') > 0 ||
    maxOf('sessions_fts', 'turn_idx', 'session_id') > 0 ||
    maxOf('sessions_meta', 'turn_count', 'id') > 0
  )
}

export async function reserveTurnIndex(
  sessionId: string,
  opts: { minimumLastTurn?: number; legacySessionIds?: string[] } = {},
): Promise<number> {
  const db = await getSessionsDb()
  const ids = [
    ...new Set([sessionId, ...(opts.legacySessionIds ?? []).filter((id) => id.length > 0)]),
  ]
  const reserve = db.transaction((): number => {
    const placeholders = ids.map(() => '?').join(',')
    const counter = db
      .prepare(
        `SELECT MAX(last_reserved_turn) AS m
           FROM session_turn_counters
          WHERE session_id IN (${placeholders})`,
      )
      .get(...ids) as { m: number | null } | undefined
    const fts = db
      .prepare(
        `SELECT MAX(CAST(turn_idx AS INTEGER)) AS m
           FROM sessions_fts
          WHERE session_id IN (${placeholders})`,
      )
      .get(...ids) as { m: number | null } | undefined
    const meta = db
      .prepare(
        `SELECT MAX(turn_count) AS m
           FROM sessions_meta
          WHERE id IN (${placeholders})`,
      )
      .get(...ids) as { m: number | null } | undefined
    const minimum =
      Number.isSafeInteger(opts.minimumLastTurn) && (opts.minimumLastTurn ?? 0) > 0
        ? opts.minimumLastTurn!
        : 0
    const last = Math.max(
      minimum,
      counter?.m == null ? 0 : Math.floor(counter.m),
      fts?.m == null ? 0 : Math.floor(fts.m),
      meta?.m == null ? 0 : Math.floor(meta.m),
    )
    const next = last + 1
    db.prepare(
      `INSERT INTO session_turn_counters(session_id,last_reserved_turn)
       VALUES (?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_reserved_turn=MAX(session_turn_counters.last_reserved_turn,excluded.last_reserved_turn)`,
    ).run(sessionId, next)
    return next
  })
  return reserve.immediate()
}

export async function searchSessions(
  query: string,
  limit: number | null = 5,
  agentId?: string,
): Promise<SearchHit[]> {
  const db = await getSessionsDb()
  const cleanQuery = literalFtsQuery(query)
  if (!cleanQuery) return []
  const agentFilter = agentId ? 'AND m.agent_id = ?' : ''
  const boundedLimit = limit === null ? null : Math.max(1, Math.floor(limit))
  const params = agentId
    ? boundedLimit === null
      ? [cleanQuery, agentId]
      : [cleanQuery, agentId, boundedLimit * 4]
    : boundedLimit === null
      ? [cleanQuery]
      : [cleanQuery, boundedLimit * 4]
  const rows = db
    .prepare(
      `
    SELECT
      f.session_id,
      f.turn_idx,
      snippet(sessions_fts, 3, '<mark>', '</mark>', '…', 16) AS snippet,
      bm25(sessions_fts) AS score,
      m.agent_id,
      m.channel,
      m.peer_id,
      m.title,
      m.last_at
    FROM sessions_fts f
    LEFT JOIN sessions_meta m ON m.id = f.session_id
    WHERE sessions_fts MATCH ?
    ${agentFilter}
    ORDER BY score
    ${boundedLimit === null ? '' : 'LIMIT ?'}
  `,
    )
    .all(...params) as Array<{
    session_id: string
    turn_idx: number
    snippet: string
    score: number
    agent_id: string | null
    channel: string | null
    peer_id: string | null
    title: string | null
    last_at: number | null
  }>

  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const r of rows) {
    if (seen.has(r.session_id)) continue
    seen.add(r.session_id)
    out.push({
      sessionId: r.session_id,
      agentId: r.agent_id ?? 'unknown',
      channel: r.channel ?? 'unknown',
      peerId: r.peer_id ?? 'unknown',
      title: r.title ?? '(untitled)',
      lastAt: r.last_at ?? 0,
      snippet: r.snippet,
      score: r.score,
    })
    if (boundedLimit !== null && out.length >= boundedLimit) break
  }
  return out
}

export async function loadSessionTurns(
  sessionId: string,
  limit: number | null = 200,
): Promise<Array<{ role: string; content: string; turnIdx: number }>> {
  const db = await getSessionsDb()
  const boundedLimit = limit === null ? null : Math.max(1, Math.floor(limit))
  const rows = db
    .prepare(`
      SELECT turn_idx, role, content FROM sessions_fts
      WHERE session_id = ?
      ORDER BY turn_idx DESC, rowid DESC
      ${boundedLimit === null ? '' : 'LIMIT ?'}
    `)
    .all(...(boundedLimit === null ? [sessionId] : [sessionId, boundedLimit])) as Array<{
    turn_idx: number
    role: string
    content: string
  }>
  return rows.reverse().map((r) => ({ turnIdx: r.turn_idx, role: r.role, content: r.content }))
}

export async function insertEvent(entry: EventLogEntry): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(`
    INSERT OR IGNORE INTO event_log (id, type, timestamp, agent_id, session_key, schema_version, payload, peer_id, channel)
    VALUES (@id, @type, @timestamp, @agentId, @sessionKey, @schemaVersion, @payload, @peerId, @channel)
  `).run({ ...entry, peerId: entry.peerId ?? '', channel: entry.channel ?? '' })
}

export async function queryEvents(opts: {
  type?: string
  agentId?: string
  sessionKey?: string
  since?: number
  limit?: number
}): Promise<EventLogEntry[]> {
  const db = await getSessionsDb()
  const conditions: string[] = []
  const params: Record<string, unknown> = {}
  if (opts.type) {
    conditions.push('type = @type')
    params.type = opts.type
  }
  if (opts.agentId) {
    conditions.push('agent_id = @agentId')
    params.agentId = opts.agentId
  }
  if (opts.sessionKey) {
    conditions.push('session_key = @sessionKey')
    params.sessionKey = opts.sessionKey
  }
  if (opts.since != null) {
    conditions.push('timestamp >= @since')
    params.since = opts.since
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  params.limit = opts.limit ?? 100
  const rows = db
    .prepare(
      `SELECT id, type, timestamp, agent_id, session_key, schema_version, payload, peer_id, channel
       FROM event_log ${where} ORDER BY timestamp DESC LIMIT @limit`,
    )
    .all(params) as EventLogDbRow[]
  return rows.map(mapEventLogRow)
}

export async function loadSessionEvents(sessionKey: string): Promise<EventLogEntry[]> {
  const db = await getSessionsDb()
  const rows = db
    .prepare(
      `SELECT id, type, timestamp, agent_id, session_key, schema_version, payload, peer_id, channel
         FROM event_log
        WHERE session_key = ?
        ORDER BY timestamp ASC, id ASC`,
    )
    .all(sessionKey) as EventLogDbRow[]
  return rows.map(mapEventLogRow)
}

export async function loadSessionUsage(sessionId: string): Promise<UsageLogEntry[]> {
  const db = await getSessionsDb()
  const rows = db
    .prepare(
      `SELECT id, session_id, agent_id, turn_index, timestamp, model,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              cost_usd, duration_ms, tool_calls, terminal_status
         FROM usage_log
        WHERE session_id = ?
        ORDER BY turn_index ASC, timestamp ASC, id ASC`,
    )
    .all(sessionId) as Array<{
    id: string
    session_id: string
    agent_id: string
    turn_index: number
    timestamp: number
    model: string | null
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    cost_usd: number
    duration_ms: number
    tool_calls: number
    terminal_status: string | null
  }>
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    turnIndex: row.turn_index,
    timestamp: row.timestamp,
    model: row.model ?? undefined,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    toolCalls: row.tool_calls,
    terminalStatus: (row.terminal_status ?? 'completed') as UsageTerminalStatus,
  }))
}

export async function loadSessionUsageModels(
  sessionIds: readonly string[],
): Promise<Record<string, string[]>> {
  const keys = [...new Set(sessionIds)]
  if (keys.length > 200) throw new RangeError('session model lookup exceeds 200 keys')
  const result: Record<string, string[]> = Object.create(null)
  if (keys.length === 0) return result
  const db = await getSessionsDb()
  const rows = db
    .prepare(`
      SELECT session_id, model, MIN(timestamp) AS first_at
      FROM usage_log
      WHERE session_id IN (${keys.map(() => '?').join(',')})
        AND model IS NOT NULL AND model <> '' AND model <> 'auto'
      GROUP BY session_id, model
      ORDER BY session_id, first_at, model
    `)
    .all(...keys) as Array<{ session_id: string; model: string }>
  for (const row of rows) (result[row.session_id] ??= []).push(row.model)
  return result
}

export async function insertUsageLog(entry: UsageLogEntry): Promise<InsertUsageLogResult> {
  const db = await getSessionsDb()
  const bound = {
    ...entry,
    model: entry.model ?? null,
    terminalStatus: entry.terminalStatus ?? 'completed',
  }
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO usage_log
        (id, session_id, agent_id, turn_index, model, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, tool_calls, timestamp,
         terminal_status)
      VALUES (@id, @sessionId, @agentId, @turnIndex, @model, @inputTokens, @outputTokens,
              @cacheReadTokens, @cacheCreationTokens, @costUsd, @durationMs, @toolCalls, @timestamp,
              @terminalStatus)
    `)
    .run(bound)
  if (result.changes === 1) return { status: 'inserted' }
  const existing = db
    .prepare(
      `SELECT duration_ms, tool_calls, input_tokens, output_tokens
         FROM usage_log
        WHERE session_id = ? AND turn_index = ?`,
    )
    .get(entry.sessionId, entry.turnIndex) as
    | {
        duration_ms: number
        tool_calls: number
        input_tokens: number
        output_tokens: number
      }
    | undefined
  const conflict =
    !!existing &&
    (existing.duration_ms !== entry.durationMs ||
      existing.tool_calls !== entry.toolCalls ||
      existing.input_tokens !== entry.inputTokens ||
      existing.output_tokens !== entry.outputTokens)
  return { status: 'duplicate', conflict }
}

export async function pruneLocalObservability(input: {
  eventBeforeMs: number
  usageBeforeMs: number
}): Promise<{ previewsScrubbed: number; eventsDeleted: number; usageDeleted: number }> {
  const db = await getSessionsDb()
  const run = db.transaction(() => {
    const previews = db
      .prepare(`
        UPDATE event_log
           SET payload = json_remove(payload, '$.inputPreview', '$.outputPreview')
         WHERE type = 'tool.called'
           AND json_valid(payload) = 1
           AND (
             json_type(payload, '$.inputPreview') IS NOT NULL
             OR json_type(payload, '$.outputPreview') IS NOT NULL
           )
      `)
      .run()
    const events = db.prepare('DELETE FROM event_log WHERE timestamp < ?').run(input.eventBeforeMs)
    const usage = db.prepare('DELETE FROM usage_log WHERE timestamp < ?').run(input.usageBeforeMs)
    return {
      previewsScrubbed: Number(previews.changes),
      eventsDeleted: Number(events.changes),
      usageDeleted: Number(usage.changes),
    }
  })
  return run()
}

export async function getUsageSummary(opts: {
  agentId?: string
  sessionId?: string
  since?: number
}): Promise<UsageSummary> {
  const db = await getSessionsDb()
  const conditions: string[] = []
  const params: Record<string, unknown> = {}
  if (opts.agentId) {
    conditions.push('agent_id = @agentId')
    params.agentId = opts.agentId
  }
  if (opts.sessionId) {
    conditions.push('session_id = @sessionId')
    params.sessionId = opts.sessionId
  }
  if (opts.since != null) {
    conditions.push('timestamp >= @since')
    params.since = opts.since
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as total_cost,
              COALESCE(SUM(input_tokens), 0) as total_in,
              COALESCE(SUM(output_tokens), 0) as total_out,
              COUNT(*) as total_turns
       FROM usage_log ${where}`,
    )
    .get(params) as {
    total_cost: number
    total_in: number
    total_out: number
    total_turns: number
  }
  return {
    totalCostUsd: row.total_cost,
    totalInputTokens: row.total_in,
    totalOutputTokens: row.total_out,
    totalTurns: row.total_turns,
  }
}

export async function pruneOrphanedSessionsFts(): Promise<number> {
  return pruneOrphanedSessionsFtsRows(await getSessionsDb())
}
