import { createHmac, randomBytes, randomUUID } from 'node:crypto'

import { getSessionsDb } from './sessionsDb.js'

export type MemoryUsageOperation =
  | 'index_injected'
  | 'core_search'
  | 'core_read'
  | 'core_write'
  | 'core_update'
  | 'core_delete'
  | 'profile_write'
  | 'session_search'
  | 'archival_add'
  | 'archival_search'
  | 'archival_delete'
  | 'auto_add'
  | 'auto_skip'
  | 'auto_refuse'

export type MemoryUsageType = 'core' | 'profile' | 'recall' | 'archival' | 'system'
export type MemoryUsageOutcome = 'hit' | 'no_match' | 'success' | 'denied' | 'error' | 'skipped'
export type MemoryRetrievalMode = 'lexical' | 'semantic' | 'hybrid' | 'bm25' | 'none'

export interface MemoryUsageEventInput {
  eventId?: string
  timestamp?: number
  agentId: string
  sessionKey?: string | null
  turnIndex?: number | null
  operation: MemoryUsageOperation
  memoryType: MemoryUsageType
  outcome: MemoryUsageOutcome
  policyReason?: string | null
  retrievalMode?: MemoryRetrievalMode | null
  resultCount?: number | null
  latencyMs?: number
  query?: string | null
  topMatchKey?: string | null
  metadata?: Record<string, unknown>
}

export interface MemoryUsageEventRow {
  eventId: string
  timestamp: number
  agentId: string
  sessionKey: string | null
  sessionHash: string | null
  turnIndex: number | null
  operation: MemoryUsageOperation
  memoryType: MemoryUsageType
  outcome: MemoryUsageOutcome
  policyReason: string | null
  retrievalMode: MemoryRetrievalMode | null
  resultCount: number | null
  latencyMs: number
  queryHash: string | null
  queryChars: number | null
  topMatchHash: string | null
  freshnessGap: boolean | null
  timestampIso: string
}

const DYNAMIC_INTENT_RULES: ReadonlyArray<{ kind: string; re: RegExp }> = [
  {
    kind: 'runtime_status',
    re: /(?:(?:当前|现在|此刻|目前).{0,12}(?:状态|运行|正常|故障|报错|版本|配置|账号池|服务)|\b(?:current|now|live).{0,24}(?:status|version|config|runtime|service)\b)/i,
  },
  {
    kind: 'release_status',
    re: /(?:(?:是否|是不是|有没有|已经).{0,8}(?:上线|发布|部署|生效|切换)|\b(?:deployed|released|rolled out|enabled)\b)/i,
  },
  {
    kind: 'latest_fact',
    re: /(?:(?:最新|今天|今日|实时).{0,12}(?:价格|政策|版本|数据|情况|状态|配置)|\b(?:latest|today|real-time).{0,24}(?:price|policy|version|data|status|config)\b)/i,
  },
  { kind: 'direct_status', re: /(?:healthz|systemd|release|runtime|线上|现网|运行中)/i },
]

let privacyKeyValue: string | null = null
let privacyKeyLoading: Promise<string> | null = null

export function classifyCurrentFactIntent(text: string): { current: boolean; kind: string | null } {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').slice(0, 8_000)
  for (const rule of DYNAMIC_INTENT_RULES) {
    if (rule.re.test(normalized)) return { current: true, kind: rule.kind }
  }
  return { current: false, kind: null }
}

async function privacyKey(): Promise<string> {
  if (privacyKeyValue) return privacyKeyValue
  if (privacyKeyLoading) return await privacyKeyLoading
  privacyKeyLoading = (async () => {
    const db = await getSessionsDb()
    const row = db.prepare("SELECT value FROM memory_usage_kv WHERE key='hmac_key'").get() as
      | { value: string }
      | undefined
    if (row?.value && /^[0-9a-f]{64}$/.test(row.value)) return row.value
    const value = randomBytes(32).toString('hex')
    db.prepare("INSERT OR IGNORE INTO memory_usage_kv(key,value) VALUES ('hmac_key',?)").run(value)
    const stored = db.prepare("SELECT value FROM memory_usage_kv WHERE key='hmac_key'").get() as {
      value: string
    }
    return stored.value
  })()
  try {
    privacyKeyValue = await privacyKeyLoading
    return privacyKeyValue
  } finally {
    privacyKeyLoading = null
  }
}

async function privateHash(value: string | null | undefined): Promise<string | null> {
  const normalized = value?.normalize('NFKC').trim()
  if (!normalized) return null
  return createHmac('sha256', await privacyKey())
    .update(normalized)
    .digest('hex')
}

export async function currentReservedTurnIndex(
  sessionKey: string | null | undefined,
): Promise<number | null> {
  if (!sessionKey) return null
  const db = await getSessionsDb()
  const row = db
    .prepare('SELECT last_reserved_turn AS value FROM session_turn_counters WHERE session_id=?')
    .get(sessionKey) as { value: number } | undefined
  return row && Number.isSafeInteger(row.value) && row.value > 0 ? row.value : null
}

export async function recordMemoryUsageEvent(input: MemoryUsageEventInput): Promise<string> {
  const db = await getSessionsDb()
  const eventId = input.eventId ?? randomUUID()
  const timestamp = input.timestamp ?? Date.now()
  const sessionKey = input.sessionKey?.trim() || null
  const turnIndex = input.turnIndex ?? (await currentReservedTurnIndex(sessionKey))
  const query = input.query?.normalize('NFKC').trim() || null
  const queryHash = await privateHash(query)
  const topMatchHash = await privateHash(input.topMatchKey)
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO memory_usage_events(
        event_id,timestamp,agent_id,session_key,turn_index,operation,memory_type,outcome,
        policy_reason,retrieval_mode,result_count,latency_ms,query_hash,query_chars,
        top_match_hash,metadata_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      eventId,
      timestamp,
      input.agentId,
      sessionKey,
      turnIndex,
      input.operation,
      input.memoryType,
      input.outcome,
      input.policyReason ?? null,
      input.retrievalMode ?? null,
      input.resultCount ?? null,
      Math.max(0, Math.floor(input.latencyMs ?? 0)),
      queryHash,
      query ? [...query].length : null,
      topMatchHash,
      JSON.stringify(input.metadata ?? {}),
    )
    if (sessionKey && turnIndex != null) {
      db.prepare(`
        UPDATE memory_turn_context
           SET memory_used=1
         WHERE session_key=? AND turn_index=?
      `).run(sessionKey, turnIndex)
    }
  })()
  return eventId
}

export async function beginMemoryTurnObservation(input: {
  sessionKey: string
  turnIndex: number
  agentId: string
  userText: string
  softReminderActive?: boolean
  createdAt?: number
}): Promise<void> {
  const db = await getSessionsDb()
  const intent = classifyCurrentFactIntent(input.userText)
  db.prepare(`
    INSERT INTO memory_turn_context(
      session_key,turn_index,agent_id,current_fact_intent,intent_kind,
      soft_reminder_active,created_at
    ) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(session_key,turn_index) DO UPDATE SET
      agent_id=excluded.agent_id,
      current_fact_intent=excluded.current_fact_intent,
      intent_kind=excluded.intent_kind,
      soft_reminder_active=excluded.soft_reminder_active
  `).run(
    input.sessionKey,
    input.turnIndex,
    input.agentId,
    intent.current ? 1 : 0,
    intent.kind,
    input.softReminderActive === false ? 0 : 1,
    input.createdAt ?? Date.now(),
  )
}

export async function markMemoryTurnEvidence(sessionKey: string, turnIndex: number): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(`
    UPDATE memory_turn_context SET evidence_seen=1
     WHERE session_key=? AND turn_index=?
  `).run(sessionKey, turnIndex)
}

export async function completeMemoryTurnObservation(
  sessionKey: string,
  turnIndex: number,
  completedAt = Date.now(),
): Promise<void> {
  const db = await getSessionsDb()
  db.transaction(() => {
    db.prepare(`
      UPDATE memory_turn_context
         SET completed_at=?,
             freshness_gap=CASE
               WHEN current_fact_intent=1 AND memory_used=1 AND evidence_seen=0 THEN 1
               ELSE 0
             END
       WHERE session_key=? AND turn_index=?
    `).run(completedAt, sessionKey, turnIndex)
    db.prepare(`
      UPDATE memory_usage_events
         SET freshness_gap=(
           SELECT freshness_gap FROM memory_turn_context c
            WHERE c.session_key=memory_usage_events.session_key
              AND c.turn_index=memory_usage_events.turn_index
         )
       WHERE session_key=? AND turn_index=?
    `).run(sessionKey, turnIndex)
  })()
}

function mapUsageRow(
  row: Record<string, unknown>,
  sessionHash: string | null,
): MemoryUsageEventRow {
  const timestamp = Number(row.timestamp)
  return {
    eventId: String(row.event_id),
    timestamp,
    agentId: String(row.agent_id),
    sessionKey: row.session_key == null ? null : String(row.session_key),
    sessionHash,
    turnIndex: row.turn_index == null ? null : Number(row.turn_index),
    operation: row.operation as MemoryUsageOperation,
    memoryType: row.memory_type as MemoryUsageType,
    outcome: row.outcome as MemoryUsageOutcome,
    policyReason: row.policy_reason == null ? null : String(row.policy_reason),
    retrievalMode: row.retrieval_mode == null ? null : (row.retrieval_mode as MemoryRetrievalMode),
    resultCount: row.result_count == null ? null : Number(row.result_count),
    latencyMs: Number(row.latency_ms),
    queryHash: row.query_hash == null ? null : String(row.query_hash),
    queryChars: row.query_chars == null ? null : Number(row.query_chars),
    topMatchHash: row.top_match_hash == null ? null : String(row.top_match_hash),
    freshnessGap: row.freshness_gap == null ? null : Number(row.freshness_gap) === 1,
    timestampIso: new Date(timestamp).toISOString(),
  }
}

async function rowsWithPrivateSessionHash(
  rows: Array<Record<string, unknown>>,
): Promise<MemoryUsageEventRow[]> {
  return await Promise.all(
    rows.map(async (row) =>
      mapUsageRow(row, await privateHash(row.session_key == null ? null : String(row.session_key))),
    ),
  )
}

export async function listPendingMemoryUsageEvents(limit = 100): Promise<MemoryUsageEventRow[]> {
  const db = await getSessionsDb()
  const staleBefore = Date.now() - 2 * 60 * 60 * 1000
  db.transaction(() => {
    db.prepare(`
      UPDATE memory_turn_context
         SET completed_at=?,
             freshness_gap=CASE
               WHEN current_fact_intent=1 AND memory_used=1 AND evidence_seen=0 THEN 1
               ELSE 0
             END
       WHERE completed_at IS NULL AND created_at < ?
    `).run(Date.now(), staleBefore)
    db.prepare(`
      UPDATE memory_usage_events
         SET freshness_gap=(
           SELECT freshness_gap FROM memory_turn_context c
            WHERE c.session_key=memory_usage_events.session_key
              AND c.turn_index=memory_usage_events.turn_index
         )
       WHERE reported_at IS NULL AND timestamp < ?
    `).run(staleBefore)
  })()
  const rows = db
    .prepare(`
    SELECT e.* FROM memory_usage_events e
    LEFT JOIN memory_turn_context c
      ON c.session_key=e.session_key AND c.turn_index=e.turn_index
     WHERE e.reported_at IS NULL
       AND (
         e.session_key IS NULL OR e.turn_index IS NULL
         OR c.session_key IS NULL OR c.completed_at IS NOT NULL
       )
     ORDER BY e.timestamp ASC,e.event_id ASC
     LIMIT ?
  `)
    .all(Math.max(1, Math.min(100, Math.floor(limit)))) as Array<Record<string, unknown>>
  return await rowsWithPrivateSessionHash(rows)
}

export async function markMemoryUsageEventsReported(
  eventIds: string[],
  at = Date.now(),
): Promise<void> {
  if (eventIds.length === 0) return
  const db = await getSessionsDb()
  const update = db.prepare('UPDATE memory_usage_events SET reported_at=? WHERE event_id=?')
  db.transaction(() => {
    for (const id of eventIds) update.run(at, id)
  })()
}

export interface MemoryUsageDashboard {
  window: { days: number; from: string; to: string }
  totals: {
    events: number
    sessions: number
    hits: number
    noMatch: number
    errors: number
    denied: number
    freshnessGaps: number
  }
  byOperation: Array<{
    operation: string
    memoryType: string
    events: number
    sessions: number
    hits: number
    noMatch: number
    p50Ms: number
    p95Ms: number
  }>
  recentSessions: Array<{
    sessionKey: string
    title: string
    lastAt: number
    events: number
    searches: number
    writes: number
    freshnessGaps: number
  }>
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0
}

export async function getMemoryUsageDashboard(input: {
  agentId: string
  days?: number
}): Promise<MemoryUsageDashboard> {
  const db = await getSessionsDb()
  const days = Math.max(1, Math.min(90, Math.floor(input.days ?? 30)))
  const now = Date.now()
  const from = now - days * 24 * 60 * 60 * 1000
  const rows = db
    .prepare(`
    SELECT * FROM memory_usage_events
     WHERE agent_id=? AND timestamp>=?
     ORDER BY timestamp DESC,event_id DESC
  `)
    .all(input.agentId, from) as Array<Record<string, unknown>>
  const freshness = db
    .prepare(`
    SELECT COUNT(*) AS value
      FROM memory_turn_context
     WHERE agent_id=? AND created_at>=? AND freshness_gap=1
  `)
    .get(input.agentId, from) as { value: number }
  const sessions = new Set(
    rows.flatMap((row) => (row.session_key == null ? [] : [String(row.session_key)])),
  )
  const groups = new Map<string, Array<Record<string, unknown>>>()
  for (const row of rows) {
    const key = `${String(row.operation)}\u0000${String(row.memory_type)}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  const recent = db
    .prepare(`
    SELECT e.session_key,COALESCE(m.title,'未命名会话') AS title,MAX(e.timestamp) AS last_at,
           COUNT(*) AS events,
           SUM(CASE WHEN e.operation IN ('core_search','session_search','archival_search') THEN 1 ELSE 0 END) AS searches,
           SUM(CASE WHEN e.operation IN ('core_write','core_update','core_delete','profile_write','archival_add','archival_delete','auto_add') THEN 1 ELSE 0 END) AS writes,
           COUNT(DISTINCT CASE WHEN e.freshness_gap=1 THEN e.turn_index END) AS freshness_gaps
      FROM memory_usage_events e
 LEFT JOIN sessions_meta m ON m.id=e.session_key
     WHERE e.agent_id=? AND e.timestamp>=? AND e.session_key IS NOT NULL
     GROUP BY e.session_key,m.title
     ORDER BY last_at DESC
     LIMIT 50
  `)
    .all(input.agentId, from) as Array<Record<string, unknown>>
  return {
    window: { days, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    totals: {
      events: rows.length,
      sessions: sessions.size,
      hits: rows.filter((row) => row.outcome === 'hit').length,
      noMatch: rows.filter((row) => row.outcome === 'no_match').length,
      errors: rows.filter((row) => row.outcome === 'error').length,
      denied: rows.filter((row) => row.outcome === 'denied').length,
      freshnessGaps: Number(freshness.value),
    },
    byOperation: [...groups.values()]
      .map((bucket) => {
        const latencies = bucket.map((row) => Number(row.latency_ms)).filter(Number.isFinite)
        return {
          operation: String(bucket[0]!.operation),
          memoryType: String(bucket[0]!.memory_type),
          events: bucket.length,
          sessions: new Set(
            bucket.flatMap((row) => (row.session_key == null ? [] : [String(row.session_key)])),
          ).size,
          hits: bucket.filter((row) => row.outcome === 'hit').length,
          noMatch: bucket.filter((row) => row.outcome === 'no_match').length,
          p50Ms: percentile(latencies, 0.5),
          p95Ms: percentile(latencies, 0.95),
        }
      })
      .sort((a, b) => b.events - a.events || a.operation.localeCompare(b.operation)),
    recentSessions: recent.map((row) => ({
      sessionKey: String(row.session_key),
      title: String(row.title),
      lastAt: Number(row.last_at),
      events: Number(row.events),
      searches: Number(row.searches),
      writes: Number(row.writes),
      freshnessGaps: Number(row.freshness_gaps),
    })),
  }
}

export async function pruneMemoryUsage(
  beforeMs: number,
): Promise<{ eventsDeleted: number; turnsDeleted: number }> {
  const db = await getSessionsDb()
  return db.transaction(() => {
    const events = db.prepare('DELETE FROM memory_usage_events WHERE timestamp < ?').run(beforeMs)
    const turns = db.prepare('DELETE FROM memory_turn_context WHERE created_at < ?').run(beforeMs)
    return { eventsDeleted: Number(events.changes), turnsDeleted: Number(turns.changes) }
  })()
}

export const _memoryUsageInternals = { privateHash }
