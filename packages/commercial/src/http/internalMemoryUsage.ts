import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export const MEMORY_USAGE_PATH = '/internal/v3/memory-usage'
const MAX_BODY_BYTES = 128 * 1024
const MAX_EVENTS = 100
const MAX_AGE_MS = 25 * 60 * 60 * 1000
const HEX64 = /^[0-9a-f]{64}$/
const OPERATIONS = new Set([
  'index_injected',
  'core_search',
  'core_read',
  'core_write',
  'core_update',
  'core_delete',
  'profile_write',
  'session_search',
  'archival_add',
  'archival_search',
  'archival_delete',
  'auto_add',
  'auto_skip',
  'auto_refuse',
])
const MEMORY_TYPES = new Set(['core', 'profile', 'recall', 'archival', 'system'])
const OUTCOMES = new Set(['hit', 'no_match', 'success', 'denied', 'error', 'skipped'])
const MODES = new Set(['lexical', 'semantic', 'hybrid', 'bm25', 'none'])

export type MemoryUsageWireEvent = {
  schemaVersion: 1
  eventId: string
  sessionHash: string | null
  agentId: string
  turnIndex: number | null
  operation: string
  memoryType: string
  outcome: string
  policyReason: string | null
  retrievalMode: string | null
  resultCount: number | null
  latencyMs: number
  queryHash: string | null
  queryChars: number | null
  topMatchHash: string | null
  freshnessGap: boolean | null
  timestamp: number
}

export interface MemoryUsageHandlerDeps {
  identityRepo: ContainerIdentityRepo
  queryRunner: {
    query<Row = unknown>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: Row[]; rowCount: number | null }>
  }
  logger?: Logger
  now?: () => number
}

function send(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ ...(body as object), requestId }))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('too_large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function boundedString(value: unknown, max: number): string | null | undefined {
  if (value === null) return null
  if (value === undefined) return undefined
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

function validateEvent(raw: unknown, now: number): MemoryUsageWireEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const allowed = new Set([
    'schemaVersion',
    'eventId',
    'sessionHash',
    'agentId',
    'turnIndex',
    'operation',
    'memoryType',
    'outcome',
    'policyReason',
    'retrievalMode',
    'resultCount',
    'latencyMs',
    'queryHash',
    'queryChars',
    'topMatchHash',
    'freshnessGap',
    'timestamp',
  ])
  if (Object.keys(row).some((key) => !allowed.has(key))) return null
  if (row.schemaVersion !== 1) return null
  const eventId = boundedString(row.eventId, 128)
  const sessionHash = boundedString(row.sessionHash, 64)
  const agentId = boundedString(row.agentId, 128)
  const policyReason = boundedString(row.policyReason, 64)
  const retrievalMode = boundedString(row.retrievalMode, 16)
  const queryHash = boundedString(row.queryHash, 64)
  const topMatchHash = boundedString(row.topMatchHash, 64)
  const turnIndex = row.turnIndex
  const resultCount = row.resultCount
  const latencyMs = row.latencyMs
  const queryChars = row.queryChars
  const timestamp = row.timestamp
  if (!eventId || !agentId) return null
  if (sessionHash !== null && sessionHash !== undefined && !HEX64.test(sessionHash)) return null
  if (queryHash !== null && queryHash !== undefined && !HEX64.test(queryHash)) return null
  if (topMatchHash !== null && topMatchHash !== undefined && !HEX64.test(topMatchHash)) return null
  if (!OPERATIONS.has(String(row.operation)) || !MEMORY_TYPES.has(String(row.memoryType)))
    return null
  if (!OUTCOMES.has(String(row.outcome))) return null
  if (retrievalMode !== null && retrievalMode !== undefined && !MODES.has(retrievalMode))
    return null
  if (
    policyReason === undefined ||
    retrievalMode === undefined ||
    sessionHash === undefined ||
    queryHash === undefined ||
    topMatchHash === undefined
  )
    return null
  if (turnIndex !== null && (!Number.isInteger(turnIndex) || Number(turnIndex) < 1)) return null
  if (
    resultCount !== null &&
    (!Number.isInteger(resultCount) || Number(resultCount) < 0 || Number(resultCount) > 1_000_000)
  )
    return null
  if (
    !Number.isInteger(latencyMs) ||
    Number(latencyMs) < 0 ||
    Number(latencyMs) > 24 * 60 * 60 * 1000
  )
    return null
  if (
    queryChars !== null &&
    (!Number.isInteger(queryChars) || Number(queryChars) < 0 || Number(queryChars) > 1_000_000)
  )
    return null
  if (row.freshnessGap !== null && typeof row.freshnessGap !== 'boolean') return null
  if (
    !Number.isSafeInteger(timestamp) ||
    Number(timestamp) < now - MAX_AGE_MS ||
    Number(timestamp) > now + 10 * 60_000
  )
    return null
  return {
    schemaVersion: 1,
    eventId,
    sessionHash,
    agentId,
    turnIndex: turnIndex === null ? null : Number(turnIndex),
    operation: String(row.operation),
    memoryType: String(row.memoryType),
    outcome: String(row.outcome),
    policyReason,
    retrievalMode,
    resultCount: resultCount === null ? null : Number(resultCount),
    latencyMs: Number(latencyMs),
    queryHash,
    queryChars: queryChars === null ? null : Number(queryChars),
    topMatchHash,
    freshnessGap: row.freshnessGap as boolean | null,
    timestamp: Number(timestamp),
  }
}

export async function insertMemoryUsageEvents(
  deps: MemoryUsageHandlerDeps,
  userId: number,
  containerId: number,
  events: MemoryUsageWireEvent[],
): Promise<number> {
  const result = await deps.queryRunner.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(
         event_id text,session_hash text,agent_id text,turn_index integer,operation text,
         memory_type text,outcome text,policy_reason text,retrieval_mode text,result_count integer,
         latency_ms integer,query_hash text,query_chars integer,top_match_hash text,
         freshness_gap boolean,observed_at timestamptz
       )
     )
     INSERT INTO memory_usage_events(
       event_id,user_id,container_id,session_hash,agent_id,turn_index,operation,memory_type,
       outcome,policy_reason,retrieval_mode,result_count,latency_ms,query_hash,query_chars,
       top_match_hash,freshness_gap,observed_at
     )
     SELECT event_id,$1,$2,session_hash,agent_id,turn_index,operation,memory_type,outcome,
            policy_reason,retrieval_mode,result_count,latency_ms,query_hash,query_chars,
            top_match_hash,freshness_gap,observed_at
       FROM input
     ON CONFLICT(event_id) DO NOTHING`,
    [
      userId,
      containerId,
      JSON.stringify(
        events.map((event) => ({
          event_id: event.eventId,
          session_hash: event.sessionHash,
          agent_id: event.agentId,
          turn_index: event.turnIndex,
          operation: event.operation,
          memory_type: event.memoryType,
          outcome: event.outcome,
          policy_reason: event.policyReason,
          retrieval_mode: event.retrievalMode,
          result_count: event.resultCount,
          latency_ms: event.latencyMs,
          query_hash: event.queryHash,
          query_chars: event.queryChars,
          top_match_hash: event.topMatchHash,
          freshness_gap: event.freshnessGap,
          observed_at: new Date(event.timestamp).toISOString(),
        })),
      ),
    ],
  )
  return result.rowCount ?? 0
}

export function makeMemoryUsageHandler(deps: MemoryUsageHandlerDeps) {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalMemoryUsage' })
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: { hostUuid: string; boundIp: string },
  ) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    if (req.method !== 'POST')
      return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } }, requestId)
    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError)
        return send(res, 401, { error: { code: 'UNAUTHORIZED' } }, requestId)
      throw err
    }
    let raw: unknown
    try {
      raw = await readBody(req)
    } catch {
      return send(res, 400, { error: { code: 'INVALID_BODY' } }, requestId)
    }
    const list =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { events?: unknown }).events
        : null
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_EVENTS) {
      return send(res, 400, { error: { code: 'INVALID_BODY' } }, requestId)
    }
    const now = deps.now?.() ?? Date.now()
    const events = list.map((event) => validateEvent(event, now))
    if (events.some((event) => event === null)) {
      return send(res, 400, { error: { code: 'INVALID_EVENT' } }, requestId)
    }
    try {
      const inserted = await insertMemoryUsageEvents(
        deps,
        identity.userId,
        identity.containerId,
        events as MemoryUsageWireEvent[],
      )
      return send(res, 200, { ok: true, inserted }, requestId)
    } catch (err) {
      log.error(
        'memory usage insert failed',
        { events: events.length },
        err instanceof Error ? err : undefined,
      )
      return send(res, 500, { error: { code: 'INTERNAL' } }, requestId)
    }
  }
}
