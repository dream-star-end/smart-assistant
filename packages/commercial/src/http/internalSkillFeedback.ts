/**
 * GET /internal/v3/marketplace/skill-feedback?slug=<slug>&layer=<hub|user>
 *
 * 容器 gateway 在**起技能训练前**拉取「该用户对该技能差评过的真实使用场景引用」,把失败案例
 * 喂给训练素材(见 gateway skillEvalGen / _handleSkillTrainStart)。只回**引用**
 * `{refs:[{sessionKey, traceId, at}], total}`,不回内容 —— 会话内容在容器侧 sessions.db,
 * 主权不出容器;master 只知道"哪些 session/turn 被差评过",内容由容器自己按 sessionKey 摘录。
 *
 * 归因语义:response_rating.rating='down' ⋈ marketplace_skill_usage_events(trace_id 相等,
 *   且 user_id 相同 —— trace 本就 per-user,显式 r.user_id=e.user_id 双保险防跨用户串扰),
 *   限定 (user_id=容器身份, slug, layer),近 FEEDBACK_WINDOW_DAYS 天,DISTINCT session_key
 *   (同会话多次差评只取最近一条 → 一个失败会话一条引用),按差评时刻降序,≤ MAX_FEEDBACK_REFS。
 *
 * user_id 由 verifyContainerIdentity 从容器身份推导(**绝不信容器 query 传入的 uid**),
 * 与 skill-usage / platform-prompt-slots 等既有内部端点同信任边界(双因子:bearer + bound_ip
 * + secret hash)。GET-only、只读、无副作用。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { rootLogger, type Logger } from '../logging/logger.js'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'
import type { QueryRunner, SkillUsageLayer } from './internalSkillUsage.js'

export const SKILL_FEEDBACK_PATH = '/internal/v3/marketplace/skill-feedback'

/** 单次返回引用上限(训练素材注入侧只取 ≤3 段,10 足够富余,控制 payload)。 */
export const MAX_FEEDBACK_REFS = 10
/** 差评引用回溯窗口(天)。太久远的失败对当下训练意义弱,且限制扫描面。 */
export const FEEDBACK_WINDOW_DAYS = 90
/** slug 格式(与 internalSkillUsage / marketplaceRoutes 的 SLUG_RE 一致)。 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

/** 单条差评引用(只回定位键,不回内容)。 */
export interface SkillFeedbackRef {
  /** 会话键(容器据此从 sessions.db 摘录失败对话)。 */
  sessionKey: string
  /** 该失败 turn 的 canonical traceId(交叉定位用)。 */
  traceId: string
  /** 用户点差评的时刻(ISO 串;refs 按此降序)。 */
  at: string
}

export interface SkillFeedbackResult {
  /** 差评引用,近 FEEDBACK_WINDOW_DAYS 天、DISTINCT session_key、按 at 降序、≤ MAX_FEEDBACK_REFS。 */
  refs: SkillFeedbackRef[]
  /** 窗口内 DISTINCT session_key 的差评引用**总数**(不受 refs 上限截断;供前端"已找到 N 条"提示)。 */
  total: number
}

export interface SkillFeedbackDeps {
  identityRepo: ContainerIdentityRepo
  queryRunner: QueryRunner
  logger?: Logger
}

export type SkillFeedbackHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { hostUuid: string; boundIp: string },
) => Promise<void>

/**
 * 差评引用查询(与 handler 解耦,便于对真实 PG 做 integ 断言)。
 *
 * count(*) OVER () 在 LIMIT 之前对 CTE(每 session_key 一行)求窗口计数 → total 是未截断的
 * DISTINCT session_key 总数,refs 才受 LIMIT 截断。DISTINCT ON (session_key) 配
 * ORDER BY session_key, r.created_at DESC:同一会话多次差评只留**最近**一条的 trace。
 */
export async function querySkillFeedbackRefs(
  runner: QueryRunner,
  userId: number,
  slug: string,
  layer: SkillUsageLayer,
): Promise<SkillFeedbackResult> {
  const r = await runner.query<{
    session_key: string
    trace_id: string
    rated_at: Date | string
    total: string
  }>(
    `WITH down_refs AS (
       SELECT DISTINCT ON (e.session_key)
              e.session_key AS session_key,
              e.trace_id    AS trace_id,
              r.created_at  AS rated_at
         FROM marketplace_skill_usage_events e
         JOIN response_rating r
           ON r.trace_id = e.trace_id AND r.user_id = e.user_id
        WHERE e.user_id = $1
          AND e.slug = $2
          AND e.layer = $3
          AND e.trace_id IS NOT NULL
          AND e.session_key IS NOT NULL
          -- 有意不排除 tags 含 'implicit' 的隐式弱差评(中途打断/改写重发):它们正是
          -- 差评驱动训练的燃料来源(方案 b);公开评分/满意度统计的排除口径见 responseRatings.ts。
          AND r.rating = 'down'
          AND r.created_at >= NOW() - make_interval(days => $4)
        ORDER BY e.session_key, r.created_at DESC
     )
     SELECT session_key, trace_id, rated_at, count(*) OVER () AS total
       FROM down_refs
      ORDER BY rated_at DESC
      LIMIT $5`,
    [userId, slug, layer, FEEDBACK_WINDOW_DAYS, MAX_FEEDBACK_REFS],
  )
  const total = r.rows.length > 0 ? Number.parseInt(r.rows[0].total, 10) || 0 : 0
  const refs: SkillFeedbackRef[] = r.rows.map((x) => ({
    sessionKey: x.session_key,
    traceId: x.trace_id,
    at: x.rated_at instanceof Date ? x.rated_at.toISOString() : String(x.rated_at),
  }))
  return { refs, total }
}

function send(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify({ ...(body as object), requestId }))
}

export function makeSkillFeedbackHandler(deps: SkillFeedbackDeps): SkillFeedbackHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalSkillFeedback' })
  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    // GET-only:只读端点,无入库副作用。
    if (req.method !== 'GET') {
      send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'GET required' } }, requestId)
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

    // 解析 query:slug 必填 + SLUG_RE;layer 可选缺省 'hub',非法值 → 400(不静默 hub,
    // 避免容器意图取 user 层却被错回 hub 层引用)。
    let slug: string
    let layer: SkillUsageLayer
    try {
      const url = new URL(req.url ?? '/', 'http://internal')
      const rawSlug = url.searchParams.get('slug')
      if (!rawSlug || !SLUG_RE.test(rawSlug)) {
        send(res, 400, { error: { code: 'INVALID_SLUG', message: 'slug required and must match slug format' } }, requestId)
        return
      }
      slug = rawSlug
      const rawLayer = url.searchParams.get('layer')
      if (rawLayer === null || rawLayer === '') layer = 'hub'
      else if (rawLayer === 'hub' || rawLayer === 'user') layer = rawLayer
      else {
        send(res, 400, { error: { code: 'INVALID_LAYER', message: "layer must be 'hub' or 'user'" } }, requestId)
        return
      }
    } catch {
      send(res, 400, { error: { code: 'INVALID_QUERY', message: 'invalid query string' } }, requestId)
      return
    }

    try {
      const result = await querySkillFeedbackRefs(deps.queryRunner, identity.userId, slug, layer)
      send(res, 200, result, requestId)
    } catch (err) {
      log.error('failed to query skill feedback refs', {
        userId: identity.userId,
        slug,
        layer,
        err: err instanceof Error ? err.message : String(err),
      })
      send(res, 500, { error: { code: 'INTERNAL', message: 'failed to query skill feedback' } }, requestId)
    }
  }
}
