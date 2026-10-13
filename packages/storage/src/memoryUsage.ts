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
  /** Snapshot diffs are file-stamp observations, not proof the turn used memory. */
  affectsMemoryUsed?: boolean
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

const EFFICIENCY_GUARD_BLOCK_RE = /<oc-efficiency-guard>[\s\S]*?<\/oc-efficiency-guard>/g

// Copied locally to avoid importing gateway/web-react (cycle risk).
// Sources:
//   packages/gateway/src/sessionManager.ts TRANSIENT_RETRY_INPUT
//   packages/commercial/src/db/pgSessionsBackend.ts ~1824
//   packages/web-react/src/lib/chat/pure.ts INTERRUPTED_CONTINUE_PROMPT
// For the interrupted-continue prompt, only the stem through 「从断点继续。」 is
// required; call sites may append variant boilerplate after that.
export const RECOVERY_CONTINUATION_PREFIXES: readonly string[] = [
  '上一条消息因上游瞬时错误中断，请继续完成该任务。',
  '继续完成刚才因临时异常中断的任务。以本会话中已经生成并持久化的思考、工具结果和部分回答为依据，从断点继续。',
]

// Official full recovery prompt (same sources as above). Matched first so the
// known tail — which contains `release` / live-status wording — is not treated
// as user text when no extra utterance is appended.
const OFFICIAL_INTERRUPTED_CONTINUE_PROMPT =
  '继续完成刚才因临时异常中断的任务。以本会话中已经生成并持久化的思考、工具结果和部分回答为依据，从断点继续。这是一条断点续接指令，不是重放原始请求：不要重新执行已经完成的步骤，不要重复已经输出的内容。若中断前有外部写操作或部署操作，先查询其当前可观察状态（如 release 指针、进程、日志、健康检查或目标资源）并据此继续。只有在无法通过查询区分成功或失败、且重复执行可能造成不可逆后果时，才明确说明具体无法确认的操作和风险，并仅询问完成任务所必需的决定；不要泛泛要求用户再说“继续”。'

function continuationPrefixesForMatch(): string[] {
  return [OFFICIAL_INTERRUPTED_CONTINUE_PROMPT, ...RECOVERY_CONTINUATION_PREFIXES]
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((a, b) => b.length - a.length)
}

export function stripSystemInjectedPrefix(text: string): string {
  let remaining = text.replace(EFFICIENCY_GUARD_BLOCK_RE, '').trim()
  for (const prefix of continuationPrefixesForMatch()) {
    if (remaining === prefix) return ''
    if (remaining.startsWith(prefix)) {
      remaining = remaining.slice(prefix.length).trim()
      break
    }
  }
  return remaining
}

let privacyKeyValue: string | null = null
let privacyKeyLoading: Promise<string> | null = null

export function classifyCurrentFactIntent(text: string): { current: boolean; kind: string | null } {
  const remaining = stripSystemInjectedPrefix(text)
  if (!remaining) return { current: false, kind: null }
  const normalized = remaining.normalize('NFKC').replace(/\s+/g, ' ').slice(0, 8_000)
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
    if (input.affectsMemoryUsed !== false && sessionKey && turnIndex != null) {
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

export interface MemoryWriteSources {
  uiUserSaves: number
  autoDreamWrites: number
  unattributedWrites: number
}

/** Engine acceptance of the memory index is not measured. Never a count. */
export interface MemoryIndexDelivery {
  status: 'unavailable'
  reason: 'missing_engine_acceptance_receipt'
}

export interface MemoryUsageDashboard {
  window: { days: number; from: string; to: string }
  totals: {
    /** Every stored row in the window, including unverified history. Not confirmed use. */
    events: number
    confirmedOperations: number
    sessions: number
    hits: number
    noMatch: number
    errors: number
    denied: number
    freshnessGaps: number
  }
  indexDelivery: MemoryIndexDelivery
  legacyUnverifiedIndexVisibility: number
  writeSources: MemoryWriteSources
  freshnessSignal: {
    kind: 'mixed_shadow'
    provesUsage: false
    provesDelivery: false
    provesWrongAnswer: false
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
    uiUserSaves: number
    autoDreamWrites: number
    unattributedWrites: number
    freshnessGaps: number
  }>
}

const SEARCH_OPERATIONS = new Set(['core_search', 'session_search', 'archival_search'])
const WRITE_OPERATIONS = new Set([
  'core_write',
  'core_update',
  'core_delete',
  'profile_write',
  'archival_add',
  'archival_delete',
  'auto_add',
])

type WriteSourceKind = 'ui_user_save' | 'auto_dream' | 'unattributed'

function readUsageMetadata(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.metadata_json
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Successful writes only. Known sources are ui and auto_dream; everything else is unattributed. */
function classifySuccessfulWrite(row: Record<string, unknown>): WriteSourceKind | null {
  if (!WRITE_OPERATIONS.has(String(row.operation)) || row.outcome !== 'success') return null
  const metadata = readUsageMetadata(row)
  const source = typeof metadata.source === 'string' ? metadata.source : ''
  const attribution = typeof metadata.attribution === 'string' ? metadata.attribution : ''
  if (
    !source ||
    source === 'turn_snapshot' ||
    attribution === 'ambiguous' ||
    attribution === 'unknown'
  ) {
    return 'unattributed'
  }
  if (source === 'ui') return 'ui_user_save'
  if (source === 'auto_dream') return 'auto_dream'
  return 'unattributed'
}

function isConfirmedMemoryOperation(row: Record<string, unknown>): boolean {
  if (String(row.operation) === 'index_injected') return false
  const write = classifySuccessfulWrite(row)
  if (write === 'ui_user_save' || write === 'auto_dream') return true
  if (write === 'unattributed') return false
  return !WRITE_OPERATIONS.has(String(row.operation))
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
  const nonIndex = rows.filter((row) => String(row.operation) !== 'index_injected')
  const confirmed = rows.filter((row) => isConfirmedMemoryOperation(row))
  const operationRows = confirmed.filter((row) => classifySuccessfulWrite(row) == null)
  const groups = new Map<string, Array<Record<string, unknown>>>()
  for (const row of operationRows) {
    const key = `${String(row.operation)}\u0000${String(row.memory_type)}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  const writeSources: MemoryWriteSources = {
    uiUserSaves: 0,
    autoDreamWrites: 0,
    unattributedWrites: 0,
  }
  for (const row of rows) {
    const kind = classifySuccessfulWrite(row)
    if (kind === 'ui_user_save') writeSources.uiUserSaves += 1
    else if (kind === 'auto_dream') writeSources.autoDreamWrites += 1
    else if (kind === 'unattributed') writeSources.unattributedWrites += 1
  }
  const titles = new Map<string, string>()
  const titleRows = db
    .prepare(`
    SELECT m.id AS session_key, m.title AS title
      FROM sessions_meta m
     WHERE m.id IN (
       SELECT DISTINCT session_key FROM memory_usage_events
        WHERE agent_id=? AND timestamp>=? AND session_key IS NOT NULL
     )
  `)
    .all(input.agentId, from) as Array<{ session_key: string; title: string | null }>
  for (const row of titleRows) {
    if (row.title) titles.set(String(row.session_key), String(row.title))
  }
  const sessions = new Map<
    string,
    {
      lastAt: number
      events: number
      searches: number
      uiUserSaves: number
      autoDreamWrites: number
      unattributedWrites: number
      freshnessTurns: Set<number>
    }
  >()
  for (const row of rows) {
    if (row.session_key == null) continue
    const sessionKey = String(row.session_key)
    let bucket = sessions.get(sessionKey)
    if (!bucket) {
      bucket = {
        lastAt: 0,
        events: 0,
        searches: 0,
        uiUserSaves: 0,
        autoDreamWrites: 0,
        unattributedWrites: 0,
        freshnessTurns: new Set<number>(),
      }
      sessions.set(sessionKey, bucket)
    }
    const timestamp = Number(row.timestamp)
    if (timestamp > bucket.lastAt) bucket.lastAt = timestamp
    if (isConfirmedMemoryOperation(row)) bucket.events += 1
    if (SEARCH_OPERATIONS.has(String(row.operation))) bucket.searches += 1
    const kind = classifySuccessfulWrite(row)
    if (kind === 'ui_user_save') bucket.uiUserSaves += 1
    else if (kind === 'auto_dream') bucket.autoDreamWrites += 1
    else if (kind === 'unattributed') bucket.unattributedWrites += 1
    if (Number(row.freshness_gap) === 1 && row.turn_index != null) {
      bucket.freshnessTurns.add(Number(row.turn_index))
    }
  }
  return {
    window: { days, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    totals: {
      events: rows.length,
      confirmedOperations: confirmed.length,
      sessions: new Set(
        confirmed.flatMap((row) => (row.session_key == null ? [] : [String(row.session_key)])),
      ).size,
      hits: nonIndex.filter((row) => row.outcome === 'hit').length,
      noMatch: nonIndex.filter((row) => row.outcome === 'no_match').length,
      errors: nonIndex.filter((row) => row.outcome === 'error').length,
      denied: nonIndex.filter((row) => row.outcome === 'denied').length,
      freshnessGaps: Number(freshness.value),
    },
    indexDelivery: {
      status: 'unavailable',
      reason: 'missing_engine_acceptance_receipt',
    },
    legacyUnverifiedIndexVisibility: rows.filter((row) => String(row.operation) === 'index_injected')
      .length,
    writeSources,
    freshnessSignal: {
      kind: 'mixed_shadow',
      provesUsage: false,
      provesDelivery: false,
      provesWrongAnswer: false,
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
    recentSessions: [...sessions.entries()]
      .sort((a, b) => b[1].lastAt - a[1].lastAt || a[0].localeCompare(b[0]))
      .slice(0, 50)
      .map(([sessionKey, bucket]) => ({
        sessionKey,
        title: titles.get(sessionKey) || '未命名会话',
        lastAt: bucket.lastAt,
        events: bucket.events,
        searches: bucket.searches,
        uiUserSaves: bucket.uiUserSaves,
        autoDreamWrites: bucket.autoDreamWrites,
        unattributedWrites: bucket.unattributedWrites,
        freshnessGaps: bucket.freshnessTurns.size,
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
