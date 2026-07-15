/**
 * /internal/v3/agent-audit/tool-failure — container gateway failed tool-call
 * telemetry. The gateway reports only failed tool calls, authenticated with the
 * same container identity bearer as other v3/v5 internal endpoints. Master
 * stores a compact row in agent_audit for backend optimization workflows.
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  classifyToolFailureError,
  isToolFailureErrorClass,
  type ToolFailureErrorClass,
} from '@openclaude/protocol'

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

export type ToolFailureAuditBody = ToolFailureAuditBodyV1 | ToolFailureAuditBodyV2

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

const SHA256_RE = /^[0-9a-f]{64}$/

function optionalSha256(obj: Record<string, unknown>, key: string): string | undefined | null {
  const value = obj[key]
  if (value === undefined) return undefined
  return typeof value === 'string' && SHA256_RE.test(value) ? value : null
}

function validateBody(raw: unknown): ToolFailureAuditBody | null {
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
        : commonAllowed,
  )
  if (Object.keys(obj).some((k) => !allowed.has(k))) return null
  if (obj.schemaVersion !== 1 && obj.schemaVersion !== 2) return null
  const eventId = requiredString(obj, 'eventId', 128)
  const sessionKey = requiredString(obj, 'sessionKey', 512)
  const agentId = requiredString(obj, 'agentId', 128)
  const toolName = requiredString(obj, 'toolName', 128)
  const turnIndex = requiredInt(obj, 'turnIndex', 0, 1_000_000)
  const durationMs = requiredInt(obj, 'durationMs', 0, 24 * 60 * 60 * 1000)
  const timestamp = requiredInt(obj, 'timestamp', 0, Number.MAX_SAFE_INTEGER)
  if (
    !eventId || !sessionKey || !agentId || !toolName ||
    turnIndex === null || durationMs === null || timestamp === null
  ) return null

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
  if (
    inputHash === null || outputHash === null ||
    !isToolFailureErrorClass(errorClass)
  ) return null
  return {
    schemaVersion: 2,
    ...base,
    ...(inputHash !== undefined ? { inputHash } : {}),
    ...(outputHash !== undefined ? { outputHash } : {}),
    errorClass,
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

  const inputHash = body.schemaVersion === 2
    ? body.inputHash ?? null
    : sha256OrNull(body.inputPreview)
  const outputHash = body.schemaVersion === 2
    ? body.outputHash ?? null
    : sha256OrNull(body.outputPreview)
  const errorClass = body.schemaVersion === 2
    ? body.errorClass
    : classifyToolFailureError(body.outputPreview)
  const inputMeta = {
    schema_version: body.schemaVersion,
    event_id: body.eventId,
    agent_id: body.agentId,
    turn_index: body.turnIndex,
    timestamp: body.timestamp,
    error_class: errorClass,
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
      inputHash,
      outputHash,
      body.durationMs,
      null,
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
