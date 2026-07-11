/**
 * /internal/v3/marketplace/skill-usage — 容器 gateway skillUsageReporter 批量上报
 * 「hub 技能被使用(skill_view)」的低敏信号(只记 slug/agent/trace,不记内容)。
 *
 * 与 tool-failure(诊断遥测,默认关)语义相反:这是**产品质量信号**,默认开
 * (OC_MARKET_SKILL_USAGE 显式 '0' 才关)—— 用于市场目录透出「30 天使用次数/人数」+
 * 评分归因(response_rating.trace_id ⋈ 本表 trace_id)。user_id 由 verifyContainerIdentity
 * 从容器身份推导,**绝不信容器 body 传入的 uid**;created_at 落库以 master NOW() 为准
 * (不信容器时钟,body.at 仅作参考不入库)。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { rootLogger, type Logger } from '../logging/logger.js'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export const SKILL_USAGE_PATH = '/internal/v3/marketplace/skill-usage'

/**
 * 门控(与容器侧 skillUsageReporter 同名 env,双端一致):**默认开**,显式 '0' 才关。
 *
 * 与 isToolFailureAuditEnabled(必须显式 '1')相反 —— 使用信号是低敏产品质量信号,
 * 上线即应生效,不需要逐环境手动打开。关闭时 master 不注册本路由(index.ts dispatchInternal
 * fall through 到 internalProxyHandler 返 404,容器侧把 404 分类为 fatal 直接 drop,与
 * "功能未部署"等价);v3supervisor 对应地在 '0' 时才透传 '0',否则注入 '1'。
 */
export function isSkillUsageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_MARKET_SKILL_USAGE !== '0'
}

/** 单批上限(与容器侧 flush 批大小对齐;超出视为 sender bug → 400)。 */
export const MAX_EVENTS_PER_BATCH = 100
const MAX_BODY_BYTES = 64 * 1024
/** slug 格式(与 marketplaceRoutes / internalMarketplaceAgent 的 SLUG_RE 一致)。 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
/** traceId = 32 hex(与 bridge 铸造的 canonical traceId 空间一致)。 */
const TRACE_RE = /^[0-9a-f]{32}$/

/** 技能层:hub=市场上架技能(进目录聚合);user=用户自建技能(用户私有,只喂技能训练)。 */
export type SkillUsageLayer = 'hub' | 'user'

/** 落库形状(已过校验;agentId/sessionKey/traceId 归一为 string|null;layer 缺省 'hub')。 */
export interface SkillUsageEvent {
  eventId: string
  slug: string
  agentId: string | null
  sessionKey: string | null
  traceId: string | null
  layer: SkillUsageLayer
}

export interface SkillUsageCtx {
  hostUuid: string
  boundIp: string
}

export interface QueryResultLike<Row = any> {
  rows: Row[]
  rowCount: number | null
}

export interface QueryRunner {
  query<Row = any>(sql: string, params?: readonly unknown[]): Promise<QueryResultLike<Row>>
}

export interface SkillUsageDeps {
  identityRepo: ContainerIdentityRepo
  queryRunner: QueryRunner
  logger?: Logger
}

export type SkillUsageHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SkillUsageCtx,
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

/** 归一化可空字符串:缺省/非串 → null;超长视为非法(返回 undefined 触发整批 400)。 */
function optNullableString(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  if (v.length > max) return undefined
  return v
}

/**
 * 校验单条事件。任一字段结构违约 → null(handler 据此整批 400,loud-fail sender bug)。
 * slug 只做 SLUG_RE 格式校验(不校验 listing 是否存在——事件先于/晚于上架都合法)。
 */
function validateEvent(raw: unknown): SkillUsageEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const eventId = typeof o.eventId === 'string' && o.eventId.length > 0 && o.eventId.length <= 128 ? o.eventId : null
  if (!eventId) return null
  const slug = typeof o.slug === 'string' && SLUG_RE.test(o.slug) ? o.slug : null
  if (!slug) return null
  const agentId = optNullableString(o.agentId, 128)
  if (agentId === undefined) return null
  const sessionKey = optNullableString(o.sessionKey, 512)
  if (sessionKey === undefined) return null
  // traceId:缺省/null → null;是串则必须 32 hex,否则整批违约(不静默降级为 null,避免
  // sender 铸错 traceId 却被当作"无归因"而无声吞掉)。
  let traceId: string | null
  if (o.traceId === undefined || o.traceId === null) traceId = null
  else if (typeof o.traceId === 'string' && TRACE_RE.test(o.traceId)) traceId = o.traceId
  else return null
  // layer:缺省/null → 'hub'(向后兼容旧容器,与 0128 单层语义一致);是串则必须 'hub'|'user',
  // 越界值整批违约(与 traceId 同风格:非法值 loud-fail sender bug,不静默降级 —— 若把非法 layer
  // 静默当 'hub',user 层数据可能被错误计入市场聚合,污染信号)。
  let layer: SkillUsageLayer
  if (o.layer === undefined || o.layer === null) layer = 'hub'
  else if (o.layer === 'hub' || o.layer === 'user') layer = o.layer
  else return null
  // at 仅作参考,不入库(created_at 以 master NOW() 为准);此处不强校验其格式。
  return { eventId, slug, agentId, sessionKey, traceId, layer }
}

/** 校验整个 body,返回事件数组或 null(结构违约)/'TOO_MANY'(超批)。 */
function validateBody(raw: unknown): SkillUsageEvent[] | 'TOO_MANY' | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const events = (raw as Record<string, unknown>).events
  if (!Array.isArray(events) || events.length === 0) return null
  if (events.length > MAX_EVENTS_PER_BATCH) return 'TOO_MANY'
  const out: SkillUsageEvent[] = []
  for (const e of events) {
    const v = validateEvent(e)
    if (!v) return null
    out.push(v)
  }
  return out
}

/**
 * 批量落库:批内先按 eventId 去重(容器幂等键,防同批重复行让计数失真),再单条
 * INSERT ... ON CONFLICT (user_id, event_id) DO NOTHING。返回 accepted(实际新增)/
 * duplicate(原批中未落库=已存在或批内重复)计数。created_at 走列默认 NOW()。
 */
export async function insertSkillUsageEvents(
  runner: QueryRunner,
  userId: number,
  events: readonly SkillUsageEvent[],
): Promise<{ accepted: number; duplicate: number }> {
  const seen = new Set<string>()
  const unique: SkillUsageEvent[] = []
  for (const e of events) {
    if (seen.has(e.eventId)) continue
    seen.add(e.eventId)
    unique.push(e)
  }
  if (unique.length === 0) return { accepted: 0, duplicate: events.length }

  const cols = 7
  const placeholders: string[] = []
  const params: unknown[] = []
  unique.forEach((e, i) => {
    const b = i * cols
    placeholders.push(
      `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`,
    )
    params.push(userId, e.slug, e.agentId, e.sessionKey, e.traceId, e.eventId, e.layer)
  })
  const r = await runner.query(
    `INSERT INTO marketplace_skill_usage_events
       (user_id, slug, agent_id, session_key, trace_id, event_id, layer)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (user_id, event_id) DO NOTHING`,
    params,
  )
  const accepted = r.rowCount ?? 0
  return { accepted, duplicate: events.length - accepted }
}

export function makeSkillUsageHandler(deps: SkillUsageDeps): SkillUsageHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalSkillUsage' })
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

    let events: SkillUsageEvent[]
    try {
      const parsed = validateBody(await readJsonBody(req))
      if (parsed === 'TOO_MANY') {
        send(res, 400, { error: { code: 'TOO_MANY_EVENTS', message: `batch exceeds ${MAX_EVENTS_PER_BATCH}` } }, requestId)
        return
      }
      if (!parsed) {
        send(res, 400, { error: { code: 'INVALID_BODY', message: 'invalid skill usage body' } }, requestId)
        return
      }
      events = parsed
    } catch (err) {
      const status = (err as any)?.statusCode === 413 ? 413 : 400
      send(res, status, { error: { code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BODY' } }, requestId)
      return
    }

    try {
      const r = await insertSkillUsageEvents(deps.queryRunner, identity.userId, events)
      send(res, 200, { ok: true, accepted: r.accepted, duplicate: r.duplicate }, requestId)
    } catch (err) {
      log.error('failed to insert skill usage events', {
        userId: identity.userId,
        count: events.length,
        err: err instanceof Error ? err.message : String(err),
      })
      send(res, 500, { error: { code: 'INTERNAL', message: 'failed to record skill usage' } }, requestId)
    }
  }
}
