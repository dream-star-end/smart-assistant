/**
 * /internal/v3/skill-shadow — sampled skill retrieval quality telemetry.
 *
 * Container identity determines user_id. The body contains only a message
 * SHA-256, ranked skill names, turn identifiers, and successful skill_view
 * names; raw user text and skill bodies are never accepted or stored.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import type { QueryRunner } from './internalSkillUsage.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export const SKILL_SHADOW_PATH = '/internal/v3/skill-shadow'

const MAX_BODY_BYTES = 16 * 1024
const TRACE_RE = /^[0-9a-f]{32}$/
const HASH_RE = /^[0-9a-f]{64}$/
const SKILL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const ROUTES = ['existing_keyword_fallback', 'zh_lexical', 'char_ngram', 'bm25_multiquery'] as const
type Route = (typeof ROUTES)[number]

export interface SkillShadowSelectionEvent {
  kind: 'selection'
  traceId: string
  sessionKey: string
  agentId: string
  messageHash: string
  sampleRate: number
  status: 'ok' | 'timeout' | 'error'
  routes: Record<Route, string[]>
  catalogSize: number
  elapsedMs: number
}

export interface SkillShadowUsageEvent {
  kind: 'usage'
  traceId: string
  skillName: string
}

export type SkillShadowEvent = SkillShadowSelectionEvent | SkillShadowUsageEvent

export interface SkillShadowCtx {
  hostUuid: string
  boundIp: string
}

export interface SkillShadowDeps {
  identityRepo: ContainerIdentityRepo
  queryRunner: QueryRunner
  logger?: Logger
}

export type SkillShadowHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SkillShadowCtx,
) => Promise<void>

/** Missing/zero/invalid is disabled; explicit `default`/`true` means 10%. */
export function skillShadowSampleRate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OC_SKILL_SHADOW_SAMPLE_RATE
  if (raw === undefined) return 0
  const value = raw.trim().toLocaleLowerCase()
  if (value === 'default' || value === 'true') return 0.1
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0
}

export function isSkillShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return skillShadowSampleRate(env) > 0
}

/** Validated docker env assignments; shared by supervisor and unit tests. */
export function skillShadowContainerEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const rate = skillShadowSampleRate(env)
  return rate > 0 ? [`OC_SKILL_SHADOW_SAMPLE_RATE=${String(rate)}`] : []
}

function send(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ ...(body as object), requestId }))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) {
      const error = new Error('body too large')
      ;(error as { statusCode?: number }).statusCode = 413
      throw error
    }
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) throw new Error('empty body')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function validShortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function validateRoutes(raw: unknown): Record<Route, string[]> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (Object.keys(obj).some((key) => !ROUTES.includes(key as Route))) return null
  const result = {} as Record<Route, string[]>
  for (const route of ROUTES) {
    const names = obj[route]
    if (!Array.isArray(names) || names.length > 5) return null
    if (!names.every((name) => typeof name === 'string' && SKILL_RE.test(name))) return null
    if (new Set(names).size !== names.length) return null
    result[route] = names
  }
  return result
}

export function validateSkillShadowEvent(raw: unknown): SkillShadowEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.traceId !== 'string' || !TRACE_RE.test(obj.traceId)) return null
  if (obj.kind === 'usage') {
    if (Object.keys(obj).some((key) => !['kind', 'traceId', 'skillName'].includes(key))) return null
    if (typeof obj.skillName !== 'string' || !SKILL_RE.test(obj.skillName)) return null
    return { kind: 'usage', traceId: obj.traceId, skillName: obj.skillName }
  }
  if (obj.kind !== 'selection') return null
  const selectionKeys = new Set([
    'kind',
    'traceId',
    'sessionKey',
    'agentId',
    'messageHash',
    'sampleRate',
    'status',
    'routes',
    'catalogSize',
    'elapsedMs',
  ])
  if (Object.keys(obj).some((key) => !selectionKeys.has(key))) return null
  if (!validShortString(obj.sessionKey, 512) || !validShortString(obj.agentId, 128)) return null
  if (typeof obj.messageHash !== 'string' || !HASH_RE.test(obj.messageHash)) return null
  if (
    typeof obj.sampleRate !== 'number' ||
    !Number.isFinite(obj.sampleRate) ||
    obj.sampleRate <= 0 ||
    obj.sampleRate > 1
  ) {
    return null
  }
  if (obj.status !== 'ok' && obj.status !== 'timeout' && obj.status !== 'error') return null
  const routes = validateRoutes(obj.routes)
  if (!routes) return null
  if (
    !Number.isInteger(obj.catalogSize) ||
    (obj.catalogSize as number) < 0 ||
    (obj.catalogSize as number) > 10_000
  ) {
    return null
  }
  if (
    typeof obj.elapsedMs !== 'number' ||
    !Number.isFinite(obj.elapsedMs) ||
    obj.elapsedMs < 0 ||
    obj.elapsedMs > 60_000
  ) {
    return null
  }
  return {
    kind: 'selection',
    traceId: obj.traceId,
    sessionKey: obj.sessionKey,
    agentId: obj.agentId,
    messageHash: obj.messageHash,
    sampleRate: obj.sampleRate,
    status: obj.status,
    routes,
    catalogSize: obj.catalogSize as number,
    elapsedMs: obj.elapsedMs,
  }
}

export async function upsertSkillShadowEvent(
  runner: QueryRunner,
  userId: number,
  event: SkillShadowEvent,
): Promise<number> {
  if (event.kind === 'usage') {
    const result = await runner.query(
      `INSERT INTO skill_retrieval_shadow_events
         (user_id, trace_id, status, actual_skills)
       VALUES ($1, $2, 'pending', ARRAY[$3]::text[])
       ON CONFLICT (trace_id) DO UPDATE SET
         actual_skills = CASE
           WHEN $3 = ANY(skill_retrieval_shadow_events.actual_skills)
             THEN skill_retrieval_shadow_events.actual_skills
           ELSE array_append(skill_retrieval_shadow_events.actual_skills, $3)
         END,
         updated_at = NOW()
       WHERE skill_retrieval_shadow_events.user_id = EXCLUDED.user_id`,
      [userId, event.traceId, event.skillName],
    )
    return result.rowCount ?? 0
  }

  const result = await runner.query(
    `INSERT INTO skill_retrieval_shadow_events
       (user_id, trace_id, session_key, agent_id, message_hash, sample_rate,
        status, routes, catalog_size, elapsed_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
     ON CONFLICT (trace_id) DO UPDATE SET
       session_key = EXCLUDED.session_key,
       agent_id = EXCLUDED.agent_id,
       message_hash = EXCLUDED.message_hash,
       sample_rate = EXCLUDED.sample_rate,
       status = EXCLUDED.status,
       routes = EXCLUDED.routes,
       catalog_size = EXCLUDED.catalog_size,
       elapsed_ms = EXCLUDED.elapsed_ms,
       updated_at = NOW()
     WHERE skill_retrieval_shadow_events.user_id = EXCLUDED.user_id`,
    [
      userId,
      event.traceId,
      event.sessionKey,
      event.agentId,
      event.messageHash,
      event.sampleRate,
      event.status,
      JSON.stringify(event.routes),
      event.catalogSize,
      event.elapsedMs,
    ],
  )
  return result.rowCount ?? 0
}

export function makeSkillShadowHandler(deps: SkillShadowDeps): SkillShadowHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalSkillShadow' })
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
    } catch (error) {
      if (error instanceof ContainerIdentityError) {
        send(res, 401, { error: { code: 'UNAUTHORIZED' } }, requestId)
        return
      }
      throw error
    }

    let event: SkillShadowEvent | null
    try {
      event = validateSkillShadowEvent(await readJsonBody(req))
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode === 413 ? 413 : 400
      send(
        res,
        status,
        { error: { code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BODY' } },
        requestId,
      )
      return
    }
    if (!event) {
      send(res, 400, { error: { code: 'INVALID_BODY' } }, requestId)
      return
    }

    try {
      const accepted = await upsertSkillShadowEvent(deps.queryRunner, identity.userId, event)
      if (accepted === 0) {
        send(res, 409, { error: { code: 'TRACE_OWNERSHIP_CONFLICT' } }, requestId)
        return
      }
      send(res, 200, { ok: true }, requestId)
    } catch (error) {
      log.error('failed to store skill shadow event', {
        kind: event.kind,
        userId: identity.userId,
        err: error instanceof Error ? error.message : String(error),
      })
      send(res, 500, { error: { code: 'INTERNAL' } }, requestId)
    }
  }
}
