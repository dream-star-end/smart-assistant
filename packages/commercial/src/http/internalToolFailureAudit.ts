/**
 * /internal/v3/agent-audit/tool-failure — container gateway failed tool-call
 * telemetry. The gateway reports only failed tool calls, authenticated with the
 * same container identity bearer as other v3/v5 internal endpoints. Master
 * stores a compact row in agent_audit for backend optimization workflows.
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { rootLogger, type Logger } from '../logging/logger.js'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export const TOOL_FAILURE_AUDIT_PATH = '/internal/v3/agent-audit/tool-failure'

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

const MAX_BODY_BYTES = 32 * 1024
const MAX_ERROR_MSG_CHARS = 2_000

export interface ToolFailureAuditBody {
  schemaVersion: 1
  eventId: string
  sessionKey: string
  agentId: string
  turnIndex: number
  toolName: string
  durationMs: number
  inputPreview?: string
  outputPreview?: string
  timestamp: number
}

export interface ToolFailureAuditCtx {
  hostUuid: string
  boundIp: string
}

export interface ToolFailureAuditDeps {
  identityRepo: ContainerIdentityRepo
  queryRunner: QueryRunner
  logger?: Logger
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

function cap(value: string | undefined, max: number): string | null {
  if (value === undefined) return null
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 12))}…[truncated]`
}

function requiredString(obj: Record<string, unknown>, key: string, max: number): string | null {
  const v = obj[key]
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
}

function optionalString(obj: Record<string, unknown>, key: string, max: number): string | undefined | null {
  const v = obj[key]
  if (v === undefined) return undefined
  return typeof v === 'string' && v.length <= max ? v : null
}

function requiredInt(obj: Record<string, unknown>, key: string, min: number, max: number): number | null {
  const v = obj[key]
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : null
}

function validateBody(raw: unknown): ToolFailureAuditBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const allowed = new Set([
    'schemaVersion',
    'eventId',
    'sessionKey',
    'agentId',
    'turnIndex',
    'toolName',
    'durationMs',
    'inputPreview',
    'outputPreview',
    'timestamp',
  ])
  if (Object.keys(obj).some((k) => !allowed.has(k))) return null
  if (obj.schemaVersion !== 1) return null
  const eventId = requiredString(obj, 'eventId', 128)
  const sessionKey = requiredString(obj, 'sessionKey', 512)
  const agentId = requiredString(obj, 'agentId', 128)
  const toolName = requiredString(obj, 'toolName', 128)
  const turnIndex = requiredInt(obj, 'turnIndex', 0, 1_000_000)
  const durationMs = requiredInt(obj, 'durationMs', 0, 24 * 60 * 60 * 1000)
  const timestamp = requiredInt(obj, 'timestamp', 0, Number.MAX_SAFE_INTEGER)
  const inputPreview = optionalString(obj, 'inputPreview', 4_096)
  const outputPreview = optionalString(obj, 'outputPreview', 4_096)
  if (
    !eventId || !sessionKey || !agentId || !toolName ||
    turnIndex === null || durationMs === null || timestamp === null ||
    inputPreview === null || outputPreview === null
  ) return null
  return {
    schemaVersion: 1,
    eventId,
    sessionKey,
    agentId,
    turnIndex,
    toolName,
    durationMs,
    ...(inputPreview !== undefined ? { inputPreview } : {}),
    ...(outputPreview !== undefined ? { outputPreview } : {}),
    timestamp,
  }
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

  const inputMeta = {
    schema_version: body.schemaVersion,
    event_id: body.eventId,
    agent_id: body.agentId,
    turn_index: body.turnIndex,
    timestamp: body.timestamp,
    input_preview: body.inputPreview ?? null,
  }
  await runner.query(
    `INSERT INTO agent_audit(
       user_id, session_id, tool, input_meta, input_hash, output_hash,
       duration_ms, success, error_msg
     ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,false,$8)`,
    [
      userId,
      body.sessionKey,
      body.toolName,
      JSON.stringify(inputMeta),
      sha256OrNull(body.inputPreview),
      sha256OrNull(body.outputPreview),
      body.durationMs,
      cap(body.outputPreview, MAX_ERROR_MSG_CHARS),
    ],
  )
  return { duplicate: false }
}

export function makeToolFailureAuditHandler(deps: ToolFailureAuditDeps): ToolFailureAuditHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalToolFailureAudit' })
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
        send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'identity verification failed' } }, requestId)
        return
      }
      throw err
    }

    let body: ToolFailureAuditBody
    try {
      const parsed = validateBody(await readJsonBody(req))
      if (!parsed) {
        send(res, 400, { error: { code: 'INVALID_BODY', message: 'invalid tool failure body' } }, requestId)
        return
      }
      body = parsed
    } catch (err) {
      const status = (err as any)?.statusCode === 413 ? 413 : 400
      send(res, status, { error: { code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BODY' } }, requestId)
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
      send(res, 500, { error: { code: 'INTERNAL', message: 'failed to record tool failure' } }, requestId)
    }
  }
}
