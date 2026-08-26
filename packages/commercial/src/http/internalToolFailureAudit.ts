/**
 * /internal/v3/agent-audit/tool-failure — container gateway failed tool-call
 * telemetry. The gateway reports only failed tool calls, authenticated with the
 * same container identity bearer as other v3/v5 internal endpoints. Master
 * stores a compact row in agent_audit for backend optimization workflows.
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  type ToolFailureErrorClass,
  type ToolFailureKind,
  type ToolTerminationReason,
  classifyToolFailureError,
  isToolFailureErrorClass,
  isToolFailureKind,
  isToolTerminationReason,
} from '@openclaude/protocol'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export { TOOL_FAILURE_AUDIT_PATH, TOOL_CALL_ROLLUP_PATH } from '@openclaude/protocol'
export const TOOL_AUDIT_SCHEMA_HEADER = 'X-OpenClaude-Tool-Audit-Schema'

/**
 * 遥测显式开关(与容器侧 v3ToolFailureReporter 同名 env,双端一致门控)。
 *
 * 未开启 → master 不注册本路由(index.ts dispatchInternal 直接 fall through 到
 * internalProxyHandler 返 404),与"功能未部署"完全等价;容器侧把 404 分类为
 * fatal 直接 drop,不污染重试队列。必须显式 '1' 才开 —— 防止这套代码合回 v3
 * 生产分支时,靠容器必备 env 的存在性静默对现网用户开启明文遥测。
 */
export function isToolFailureAuditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_TOOL_FAILURE_AUDIT === '1'
}

// A rollup can contain at most 256 bounded dimensions. 512 KiB covers their
// worst-case UTF-8 representation while keeping the authenticated endpoint
// strictly memory-bounded; raw failure previews remain capped at 4 KiB each.
const MAX_BODY_BYTES = 512 * 1024
const REPORT_MAX_AGE_MS = 25 * 60 * 60 * 1000
const REPORT_MAX_FUTURE_SKEW_MS = 10 * 60 * 1000

interface ToolFailureAuditBase {
  eventId: string
  sessionKey: string
  agentId: string
  turnIndex: number
  toolName: string
  durationMs: number
  timestamp: number
}

export interface ToolFailureAuditBodyV1 extends ToolFailureAuditBase {
  schemaVersion: 1
  inputPreview?: string
  outputPreview?: string
}

export interface ToolFailureAuditBodyV2 extends ToolFailureAuditBase {
  schemaVersion: 2
  inputHash?: string
  outputHash?: string
  errorClass: ToolFailureErrorClass
}

export interface ToolFailureAuditBodyV3 extends ToolFailureAuditBase {
  schemaVersion: 3
  inputHash?: string
  outputHash?: string
  errorClass: ToolFailureErrorClass
  failureKind: ToolFailureKind
  exitCode?: number
  terminationReason?: ToolTerminationReason
}

export interface ToolFailureAuditBodyV4 extends Omit<ToolFailureAuditBodyV3, 'schemaVersion'> {
  schemaVersion: 4
  traceId?: string
}

export type ToolFailureAuditBody =
  | ToolFailureAuditBodyV1
  | ToolFailureAuditBodyV2
  | ToolFailureAuditBodyV3
  | ToolFailureAuditBodyV4

export interface ToolCallRollupCountBody {
  agentId: string
  toolName: string
  outcome: 'success' | 'failure'
  errorClass: ToolFailureErrorClass | 'none'
  failureKind: ToolFailureKind | 'none'
  count: number
  totalDurationMs?: number
  maxDurationMs?: number
}

export interface ToolCallRollupBody {
  schemaVersion: 1 | 2
  reportId: string
  reporterRunId: string
  sequence: number
  windowStartedAt: number
  windowEndedAt: number
  counts: ToolCallRollupCountBody[]
}

export interface ToolFailureAuditCtx {
  hostUuid: string
  boundIp: string
}

export interface ToolFailureAuditDeps {
  identityRepo: ContainerIdentityRepo
  queryRunner: QueryRunner
  logger?: Logger
  now?: () => number
}

export interface QueryResultLike<Row = any> {
  rows: Row[]
  rowCount: number | null
}

export interface QueryRunner {
  query<Row = any>(sql: string, params?: readonly unknown[]): Promise<QueryResultLike<Row>>
}

export type ToolFailureAuditHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ToolFailureAuditCtx,
) => Promise<void>

export type ToolCallRollupHandler = ToolFailureAuditHandler

function send(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ ...(body as object), requestId }))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    total += (c as Buffer).length
    if (total > MAX_BODY_BYTES) {
      const err = new Error('body too large')
      ;(err as any).statusCode = 413
      throw err
    }
    chunks.push(c as Buffer)
  }
  if (chunks.length === 0) throw new Error('empty body')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid JSON')
  }
}

function sha256OrNull(value: string | undefined): string | null {
  return value === undefined ? null : createHash('sha256').update(value).digest('hex')
}

function requiredString(obj: Record<string, unknown>, key: string, max: number): string | null {
  const v = obj[key]
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined | null {
  const v = obj[key]
  if (v === undefined) return undefined
  return typeof v === 'string' && v.length <= max ? v : null
}

function requiredInt(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | null {
  const v = obj[key]
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : null
}

function optionalInt(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined | null {
  if (obj[key] === undefined) return undefined
  return requiredInt(obj, key, min, max)
}

const SHA256_RE = /^[0-9a-f]{64}$/

function optionalSha256(obj: Record<string, unknown>, key: string): string | undefined | null {
  const value = obj[key]
  if (value === undefined) return undefined
  return typeof value === 'string' && SHA256_RE.test(value) ? value : null
}

function reportTimeAccepted(timestamp: number, nowMs: number): boolean {
  return (
    timestamp >= nowMs - REPORT_MAX_AGE_MS &&
    timestamp <= nowMs + REPORT_MAX_FUTURE_SKEW_MS
  )
}

function validateBody(raw: unknown, nowMs: number): ToolFailureAuditBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const commonAllowed = [
    'schemaVersion',
    'eventId',
    'sessionKey',
    'agentId',
    'turnIndex',
    'toolName',
    'durationMs',
    'timestamp',
  ]
  const allowed = new Set(
    obj.schemaVersion === 1
      ? [...commonAllowed, 'inputPreview', 'outputPreview']
      : obj.schemaVersion === 2
        ? [...commonAllowed, 'inputHash', 'outputHash', 'errorClass']
        : obj.schemaVersion === 3 || obj.schemaVersion === 4
          ? [
              ...commonAllowed,
              'inputHash',
              'outputHash',
              'errorClass',
              'failureKind',
              'exitCode',
              'terminationReason',
              ...(obj.schemaVersion === 4 ? ['traceId'] : []),
            ]
          : commonAllowed,
  )
  if (Object.keys(obj).some((k) => !allowed.has(k))) return null
  if (![1, 2, 3, 4].includes(Number(obj.schemaVersion))) return null
  const eventId = requiredString(obj, 'eventId', 128)
  const sessionKey = requiredString(obj, 'sessionKey', 512)
  const agentId = requiredString(obj, 'agentId', 128)
  const toolName = requiredString(obj, 'toolName', 128)
  const turnIndex = requiredInt(obj, 'turnIndex', 0, 1_000_000)
  const durationMs = requiredInt(obj, 'durationMs', 0, 24 * 60 * 60 * 1000)
  const timestamp = requiredInt(obj, 'timestamp', 0, Number.MAX_SAFE_INTEGER)
  if (
    !eventId ||
    !sessionKey ||
    !agentId ||
    !toolName ||
    turnIndex === null ||
    durationMs === null ||
    timestamp === null ||
    !reportTimeAccepted(timestamp, nowMs)
  )
    return null

  const base = {
    eventId,
    sessionKey,
    agentId,
    turnIndex,
    toolName,
    durationMs,
    timestamp,
  }
  if (obj.schemaVersion === 1) {
    const inputPreview = optionalString(obj, 'inputPreview', 4_096)
    const outputPreview = optionalString(obj, 'outputPreview', 4_096)
    if (inputPreview === null || outputPreview === null) return null
    return {
      schemaVersion: 1,
      ...base,
      ...(inputPreview !== undefined ? { inputPreview } : {}),
      ...(outputPreview !== undefined ? { outputPreview } : {}),
    }
  }

  const inputHash = optionalSha256(obj, 'inputHash')
  const outputHash = optionalSha256(obj, 'outputHash')
  const errorClass = obj.errorClass
  if (inputHash === null || outputHash === null || !isToolFailureErrorClass(errorClass)) return null
  if (obj.schemaVersion === 2) {
    return {
      schemaVersion: 2,
      ...base,
      ...(inputHash !== undefined ? { inputHash } : {}),
      ...(outputHash !== undefined ? { outputHash } : {}),
      errorClass,
    }
  }
  const failureKind = obj.failureKind
  const exitCode = optionalInt(obj, 'exitCode', 0, 255)
  const terminationReason = obj.terminationReason
  if (
    !isToolFailureKind(failureKind) ||
    exitCode === null ||
    (terminationReason !== undefined && !isToolTerminationReason(terminationReason))
  )
    return null
  const traceId = obj.schemaVersion === 4 ? optionalString(obj, 'traceId', 128) : undefined
  if (traceId === null || (traceId !== undefined && !/^[0-9a-f]{32}$/.test(traceId))) return null
  return {
    schemaVersion: obj.schemaVersion as 3 | 4,
    ...base,
    ...(inputHash !== undefined ? { inputHash } : {}),
    ...(outputHash !== undefined ? { outputHash } : {}),
    errorClass,
    failureKind,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(terminationReason !== undefined ? { terminationReason } : {}),
    ...(traceId !== undefined ? { traceId } : {}),
  } as ToolFailureAuditBodyV3 | ToolFailureAuditBodyV4
}

const REPORT_ID_RE = /^[0-9a-f]{32}$/
const MAX_ROLLUP_COUNTS = 256

function validateRollupCount(raw: unknown, requireDurations = false): ToolCallRollupCountBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const allowed = new Set([
    'agentId','toolName','outcome','errorClass','failureKind','count',
    'totalDurationMs','maxDurationMs',
  ])
  if (Object.keys(obj).some((key) => !allowed.has(key))) return null
  const agentId = requiredString(obj, 'agentId', 128)
  const toolName = requiredString(obj, 'toolName', 128)
  const count = requiredInt(obj, 'count', 1, 1_000_000)
  const outcome = obj.outcome
  const errorClass = obj.errorClass
  if (requireDurations && (obj.totalDurationMs === undefined || obj.maxDurationMs === undefined)) return null
  const totalDurationMs = obj.totalDurationMs === undefined
    ? 0 : requiredInt(obj, 'totalDurationMs', 0, Number.MAX_SAFE_INTEGER)
  const maxDurationMs = obj.maxDurationMs === undefined
    ? 0 : requiredInt(obj, 'maxDurationMs', 0, 24 * 60 * 60 * 1000)
  const failureKind = obj.failureKind
  if (!agentId || !toolName || count === null || totalDurationMs === null || maxDurationMs === null) return null
  if (outcome !== 'success' && outcome !== 'failure') return null
  if (outcome === 'success') {
    if (errorClass !== 'none' || failureKind !== 'none') return null
  } else if (!isToolFailureErrorClass(errorClass) || !isToolFailureKind(failureKind)) {
    return null
  }
  return {
    agentId,
    toolName,
    outcome,
    errorClass: errorClass as ToolFailureErrorClass | 'none',
    failureKind: failureKind as ToolFailureKind | 'none',
    count,
    totalDurationMs,
    maxDurationMs,
  }
}

function validateRollupBody(raw: unknown, nowMs: number): ToolCallRollupBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const allowed = new Set([
    'schemaVersion',
    'reportId',
    'reporterRunId',
    'sequence',
    'windowStartedAt',
    'windowEndedAt',
    'counts',
  ])
  if (Object.keys(obj).some((key) => !allowed.has(key))) return null
  if (obj.schemaVersion !== 1 && obj.schemaVersion !== 2) return null
  const reportId = requiredString(obj, 'reportId', 32)
  const reporterRunId = requiredString(obj, 'reporterRunId', 32)
  const sequence = requiredInt(obj, 'sequence', 1, 2_147_483_647)
  const windowStartedAt = requiredInt(obj, 'windowStartedAt', 0, Number.MAX_SAFE_INTEGER)
  const windowEndedAt = requiredInt(obj, 'windowEndedAt', 0, Number.MAX_SAFE_INTEGER)
  if (
    !reportId ||
    !REPORT_ID_RE.test(reportId) ||
    !reporterRunId ||
    !REPORT_ID_RE.test(reporterRunId) ||
    sequence === null ||
    windowStartedAt === null ||
    windowEndedAt === null ||
    windowEndedAt < windowStartedAt ||
    windowEndedAt - windowStartedAt > 24 * 60 * 60 * 1000 ||
    !reportTimeAccepted(windowEndedAt, nowMs) ||
    !Array.isArray(obj.counts) ||
    obj.counts.length > MAX_ROLLUP_COUNTS
  )
    return null
  const counts: ToolCallRollupCountBody[] = []
  const dimensions = new Set<string>()
  for (const rawCount of obj.counts) {
    const count = validateRollupCount(rawCount, obj.schemaVersion === 2)
    if (!count) return null
    const key = JSON.stringify([
      count.agentId,
      count.toolName,
      count.outcome,
      count.errorClass,
      count.failureKind,
    ])
    if (dimensions.has(key)) return null
    dimensions.add(key)
    counts.push(count)
  }
  return {
    schemaVersion: obj.schemaVersion as 1 | 2,
    reportId,
    reporterRunId,
    sequence,
    windowStartedAt,
    windowEndedAt,
    counts,
  }
}

export async function insertToolCallRollup(
  runner: QueryRunner,
  userId: number,
  containerId: number,
  body: ToolCallRollupBody,
): Promise<{ duplicate: boolean }> {
  const counts = body.counts.map((count) => ({
    agent_id: count.agentId,
    tool: count.toolName,
    outcome: count.outcome,
    error_class: count.errorClass,
    failure_kind: count.failureKind,
    call_count: count.count,
    total_duration_ms: count.totalDurationMs ?? 0,
    max_duration_ms: count.maxDurationMs ?? 0,
  }))
  const result = await runner.query<{ inserted: boolean }>(
    `WITH inserted_report AS (
       INSERT INTO agent_tool_rollup_reports(
         report_id, user_id, container_id, reporter_run_id, sequence,
         window_started_at, window_ended_at
       ) VALUES (
         $1,$2,$3,$4,$5,to_timestamp($6::double precision / 1000.0),
         to_timestamp($7::double precision / 1000.0)
       )
       ON CONFLICT DO NOTHING
       RETURNING report_id
     ), inserted_counts AS (
       INSERT INTO agent_tool_rollup_counts(
         report_id,agent_id,tool,outcome,error_class,failure_kind,call_count,
         total_duration_ms,max_duration_ms
       )
       SELECT inserted_report.report_id,c.agent_id,c.tool,c.outcome,
              c.error_class,c.failure_kind,c.call_count,
              c.total_duration_ms,c.max_duration_ms
         FROM inserted_report
         CROSS JOIN LATERAL jsonb_to_recordset($8::jsonb) AS c(
           agent_id text,tool text,outcome text,error_class text,
           failure_kind text,call_count integer,total_duration_ms bigint,max_duration_ms integer
         )
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT EXISTS(SELECT 1 FROM inserted_report) AS inserted`,
    [
      body.reportId,
      userId,
      containerId,
      body.reporterRunId,
      body.sequence,
      body.windowStartedAt,
      body.windowEndedAt,
      JSON.stringify(counts),
    ],
  )
  return { duplicate: result.rows[0]?.inserted !== true }
}

export async function insertToolFailureAudit(
  runner: QueryRunner,
  userId: number,
  body: ToolFailureAuditBody,
): Promise<{ duplicate: boolean }> {
  const existing = await runner.query<{ id: string }>(
    "SELECT id::text AS id FROM agent_audit WHERE user_id=$1 AND input_meta->>'event_id'=$2 LIMIT 1",
    [userId, body.eventId],
  )
  if ((existing.rowCount ?? existing.rows.length) > 0) return { duplicate: true }

  const inputHash =
    body.schemaVersion === 1 ? sha256OrNull(body.inputPreview) : (body.inputHash ?? null)
  const outputHash =
    body.schemaVersion === 1 ? sha256OrNull(body.outputPreview) : (body.outputHash ?? null)
  const errorClass =
    body.schemaVersion === 1 ? classifyToolFailureError(body.outputPreview) : body.errorClass
  const richBody = body.schemaVersion === 3 || body.schemaVersion === 4 ? body : null
  const inputMeta = {
    schema_version: body.schemaVersion,
    event_id: body.eventId,
    agent_id: body.agentId,
    turn_index: body.turnIndex,
    timestamp: body.timestamp,
    error_class: errorClass,
    ...(richBody ? { failure_kind: richBody.failureKind } : {}),
    ...(richBody?.exitCode !== undefined ? { exit_code: richBody.exitCode } : {}),
    ...(richBody?.terminationReason !== undefined
      ? { termination_reason: richBody.terminationReason }
      : {}),
  }
  const traceId = body.schemaVersion === 4 ? (body.traceId ?? null) : null
  await runner.query(
    `INSERT INTO agent_audit(
       user_id,session_id,tool,input_meta,input_hash,output_hash,
       duration_ms,success,error_msg,occurred_at,trace_id,dispatch_id
     ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,false,$8,
               to_timestamp($9::double precision / 1000.0),$10,
               (SELECT dispatch_id FROM turn_traces WHERE trace_id=$10 AND user_id=$1 LIMIT 1))`,
    [
      userId,
      body.sessionKey,
      body.toolName,
      JSON.stringify(inputMeta),
      inputHash,
      outputHash,
      body.durationMs,
      null,
      body.timestamp,
      traceId,
    ],
  )
  return { duplicate: false }
}

export function makeToolFailureAuditHandler(deps: ToolFailureAuditDeps): ToolFailureAuditHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalToolFailureAudit' })
  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    // New runtimes use this on 400 to distinguish a current-master validation
    // failure from an old master that only understands schema v2.
    res.setHeader(TOOL_AUDIT_SCHEMA_HEADER, '4')
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    if (req.method !== 'POST') {
      send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } }, requestId)
      return
    }

    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        send(
          res,
          401,
          { error: { code: 'UNAUTHORIZED', message: 'identity verification failed' } },
          requestId,
        )
        return
      }
      throw err
    }

    let body: ToolFailureAuditBody
    try {
      const parsed = validateBody(await readJsonBody(req), deps.now?.() ?? Date.now())
      if (!parsed) {
        send(
          res,
          400,
          { error: { code: 'INVALID_BODY', message: 'invalid tool failure body' } },
          requestId,
        )
        return
      }
      body = parsed
    } catch (err) {
      const status = (err as any)?.statusCode === 413 ? 413 : 400
      send(
        res,
        status,
        { error: { code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BODY' } },
        requestId,
      )
      return
    }

    try {
      const r = await insertToolFailureAudit(deps.queryRunner, identity.userId, body)
      send(res, 200, { ok: true, duplicate: r.duplicate }, requestId)
    } catch (err) {
      log.error('failed to insert tool failure audit', {
        userId: identity.userId,
        eventId: body.eventId,
        err: err instanceof Error ? err.message : String(err),
      })
      send(
        res,
        500,
        { error: { code: 'INTERNAL', message: 'failed to record tool failure' } },
        requestId,
      )
    }
  }
}

export function makeToolCallRollupHandler(deps: ToolFailureAuditDeps): ToolCallRollupHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalToolCallRollup' })
  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    if (req.method !== 'POST') {
      send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } }, requestId)
      return
    }

    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        send(
          res,
          401,
          { error: { code: 'UNAUTHORIZED', message: 'identity verification failed' } },
          requestId,
        )
        return
      }
      throw err
    }

    let body: ToolCallRollupBody
    try {
      const parsed = validateRollupBody(await readJsonBody(req), deps.now?.() ?? Date.now())
      if (!parsed) {
        send(
          res,
          400,
          { error: { code: 'INVALID_BODY', message: 'invalid tool rollup body' } },
          requestId,
        )
        return
      }
      body = parsed
    } catch (err) {
      const status = (err as any)?.statusCode === 413 ? 413 : 400
      send(
        res,
        status,
        { error: { code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BODY' } },
        requestId,
      )
      return
    }

    try {
      const result = await insertToolCallRollup(
        deps.queryRunner,
        identity.userId,
        identity.containerId,
        body,
      )
      send(res, 200, { ok: true, duplicate: result.duplicate }, requestId)
    } catch (err) {
      log.error('failed to insert tool call rollup', {
        userId: identity.userId,
        containerId: identity.containerId,
        reportId: body.reportId,
        err: err instanceof Error ? err.message : String(err),
      })
      send(
        res,
        500,
        { error: { code: 'INTERNAL', message: 'failed to record tool rollup' } },
        requestId,
      )
    }
  }
}
