/**
 * v3 commercial WeChat broker — 主动投递接收点:容器 → master「主动微信推送」。
 *
 * 路径:`POST /internal/v3/wechat-proactive`(与 wechat-outbound 同挂 18443/18791)。
 *
 * 与 outboundReceiver 的区别(为什么单独一个 handler 而非复用):
 *   - outboundReceiver 服务「回复某条微信入站」:收件人(senderId)由容器从入站 frame
 *     的 peer.displayName 带回,wsess 由容器声明 —— 容器**知道**这轮发给谁。
 *   - proactiveReceiver 服务「无入站触发的主动推送」(cron / 提醒):容器**不知道**也
 *     **不应该指定**收件人。收件人由 master 凭容器身份(bindingUserId)权威解析:
 *     senderId = binding.loginUserId(绑定者本人,= contextTokens 主键,见 pairing.ts)。
 *     body 不接受 senderId/wsess —— 杜绝 compromised container 跨用户/指定他人收件。
 *
 * iLink 硬约束:发送需 contextTokens[senderId],只能从入站获得且会过期。缺 → 返回
 * `no_context_token`,容器据此回退 web 并标注未送达(不入队,避免 outbox permanent-fail 噪音)。
 *
 * **trust boundary**(与 outboundReceiver 同源):
 *   - bindingUserId = String(identity.userId);不从 body 取任何身份/收件人字段。
 *   - 所有「发给谁/能否发/是否该发」由 master 权威判定,返回 outcome 给容器决策。
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Pool } from "pg"
import { z } from "zod"

import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js"
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  readJsonBody,
  sendError,
  sendJson,
  setSecurityHeaders,
} from "./../http/util.js"
import { rootLogger, type Logger } from "../logging/logger.js"
import { enqueue } from "./outboxStore.js"
import { renderAssistantText } from "./rendererPipeline.js"

/** 容器 → master 主动投递 endpoint。挂在 master:18443 + self-host:18791。 */
export { WECHAT_PROACTIVE_PATH } from "@openclaude/protocol"

const IM_WECHAT_SUFFIX = "@im.wechat"

/**
 * 剥 iLink wire 后缀 `@im.wechat` → canonical senderId。
 *
 * 关键不变量:`wechat_bindings.login_user_id` 以 wire 形态 `<base64url>@im.wechat` 存,
 * 但 `binding.contextTokens` 的 key 是 canonical(rowToBinding 对 context_tokens 做了
 * canonicalize 剥后缀)。因此用 raw loginUserId 去 `contextTokens[senderId]` 永远 miss →
 * 永久 no_context_token。发送目标 senderId 必须是 canonical,才能命中 contextTokens,
 * 并与既有 outbound 路径(inboundDispatcher 的 senderId 为 canonical)一致。
 *
 * 本地实现而非 import `@openclaude/channel-wechat`.canonicalSenderId:该包 index 未
 * re-export 它,且本修复限定 master-only(避免触发 runtime image rebuild)—— 与
 * `storage/wechatBindings.ts` 的 stripImWechatSuffix 同款本地剥后缀先例(包层级倒挂回避)。
 */
export function canonicalWechatSenderId(raw: string): string {
  return raw.endsWith(IM_WECHAT_SUFFIX) ? raw.slice(0, -IM_WECHAT_SUFFIX.length) : raw
}

/** outboundId charset/长度,与 outboundReceiver 对齐(URL/log safe)。 */
const OUTBOUND_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/
/** agentId charset 与 internalServerAuthored 对齐(`main` / `codex` 等)。 */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const TRACE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

/** 提醒文本上限 —— readJsonBody 自身有 body 上限兜底,这里再前置挡住异常长文本。 */
const MAX_TEXT_LEN = 32 * 1024

const BodySchema = z
  .object({
    /** 主动推送的纯文本(cron/提醒产出)。master 侧 renderAssistantText 投影成 IlinkPart[]。 */
    text: z.string().min(1).max(MAX_TEXT_LEN),
    outboundId: z
      .string()
      .regex(OUTBOUND_ID_RE, { message: "outboundId must match [A-Za-z0-9._:-]{8,128}" }),
    /** 可选 — `main` / `codex` 等;仅审计 / 未来 routing,不参与权威解析。 */
    agentId: z
      .string()
      .regex(AGENT_ID_RE, { message: "agentId must match [A-Za-z0-9_-]{1,64}" })
      .optional(),
    traceId: z
      .string()
      .regex(TRACE_ID_RE, { message: "traceId must match [A-Za-z0-9._:-]{1,128}" })
      .optional(),
  })
  .strict()

export type ProactiveReceiverBody = z.infer<typeof BodySchema>

/**
 * outcome 供容器 onDeliver 决策(全部 HTTP 200,除 identity 401 / body 400):
 *   queued / already_sent / pending — outbox 状态机(同 outboundReceiver)
 *   pref_off          — 用户关了主动微信推送 → 容器走正常 web(不标注)
 *   no_binding        — 无 active 微信绑定 → 容器回退 web + 标注
 *   no_context_token  — 会话过期/未入站过,iLink 发不出 → 容器回退 web + 标注
 *   no_session        — 无 wsess 指针(从未入站过) → 容器回退 web + 标注
 *   empty_render      — 文本渲染后为空 → 容器回退 web
 */
export type ProactiveOutcome =
  | "queued"
  | "already_sent"
  | "pending"
  | "pref_off"
  | "no_binding"
  | "no_context_token"
  | "no_session"
  | "empty_render"

export interface ProactiveReceiverDeps {
  identityRepo: ContainerIdentityRepo
  pool: Pool
  /**
   * 凭 bindingUserId 权威解析绑定者收件人。null = 无 active 绑定。
   * senderId 必须 = binding.loginUserId(绑定者本人,contextTokens 主键)。
   */
  resolveRecipient: (
    bindingUserId: string,
  ) => Promise<{ senderId: string; contextTokens: Record<string, string> } | null>
  /** per-user 偏好:主动微信推送是否开启(未设 + 已绑微信 → 端点传 true)。 */
  isProactiveEnabled: (userId: number) => Promise<boolean>
  /** binding 当前 wsess 指针;从未入站过 → null。 */
  getSessionId: (pool: Pool, bindingUserId: string) => Promise<string | null>
  /** @deprecated 仅保留滚动升级配置兼容;出站重试不再封顶。 */
  maxAttempts?: number
  logger?: Logger
  now?: () => number
}

export type ProactiveReceiverHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { hostUuid: string; boundIp: string },
) => Promise<void>

export function makeProactiveReceiverHandler(
  deps: ProactiveReceiverDeps,
): ProactiveReceiverHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "wechatProactiveReceiver" })
  const now = deps.now ?? (() => Date.now())

  const reply = (
    res: ServerResponse,
    requestId: string,
    outcome: ProactiveOutcome,
    outboxId?: number,
  ): void => {
    const scheduled = outcome === "queued" || outcome === "pending"
    sendJson(
      res,
      200,
      { ok: true, accepted: true, outcome, scheduled, ...(outboxId !== undefined ? { outboxId } : {}) },
      { [REQUEST_ID_HEADER]: requestId },
    )
  }

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    const reqLog = log.child({ requestId, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp })

    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId)
      return
    }

    // 1) Container identity — bindingUserId 严格取自 identity,绝不从 body。
    let identity
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn("identity_failed", { errcode: err.code })
        sendError(res, 401, "UNAUTHORIZED", "container identity verification failed", requestId)
        return
      }
      throw err
    }
    const bindingUserId = String(identity.userId)
    const userLog = reqLog.child({ uid: identity.userId, containerId: identity.containerId })

    // 2) Body 读 + zod parse
    let body: ProactiveReceiverBody
    try {
      const raw = await readJsonBody(req)
      const parsed = BodySchema.safeParse(raw)
      if (!parsed.success) {
        userLog.warn("bad_body", { issues: parsed.error.issues })
        sendError(res, 400, "INVALID_BODY", "body schema rejected", requestId)
        return
      }
      body = parsed.data
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, requestId)
        return
      }
      throw err
    }

    // 3) 投递意图(per-user 偏好;未设 + 已绑 → true)。关 → pref_off,容器走正常 web。
    //    fail-closed:主动发微信是 opt-out 隐私偏好,与"显示 tool calls"不同 —— 偏好查询
    //    失败时宁可回退 web(用户仍在 web 收到),也不在意图不确定时把消息推到用户微信。
    let enabled = false
    try {
      enabled = await deps.isProactiveEnabled(identity.userId)
    } catch (err) {
      userLog.warn("proactive_pref_lookup_failed_fail_closed", { err: err as Error })
    }
    if (!enabled) {
      userLog.info("pref_off", { outboundId: body.outboundId })
      reply(res, requestId, "pref_off")
      return
    }

    // 4) 权威解析收件人 — senderId = binding.loginUserId。无 active 绑定 → no_binding。
    const recipient = await deps.resolveRecipient(bindingUserId)
    if (!recipient || !recipient.senderId) {
      userLog.info("no_binding", { outboundId: body.outboundId })
      reply(res, requestId, "no_binding")
      return
    }

    // 5) context_token 前置判断(缺 → iLink 永久发不出,不入队避免 outbox permanent-fail 噪音)。
    if (!recipient.contextTokens[recipient.senderId]) {
      userLog.info("no_context_token", { outboundId: body.outboundId })
      reply(res, requestId, "no_context_token")
      return
    }

    // 6) 当前 wsess 指针(outbox 行需要 session_id;从未入站过 → null)。
    const sessionId = await deps.getSessionId(deps.pool, bindingUserId)
    if (!sessionId) {
      userLog.info("no_session", { outboundId: body.outboundId })
      reply(res, requestId, "no_session")
      return
    }

    // 7) 渲染 → IlinkPart[];空 → empty_render。
    const parts = renderAssistantText(body.text)
    if (parts.length === 0) {
      userLog.info("empty_render", { outboundId: body.outboundId })
      reply(res, requestId, "empty_render")
      return
    }

    // 8) Enqueue(outboundId UNIQUE 保证幂等;outcome 映射 outbox 状态机)。
    let result
    try {
      result = await enqueue(
        deps.pool,
        {
          outboundId: body.outboundId,
          bindingUserId,
          senderId: recipient.senderId,
          sessionId,
          payload: parts,
          rawPayload: body,
          now: now(),
        },
        deps.maxAttempts,
      )
    } catch (err) {
      userLog.error("enqueue_threw", { outboundId: body.outboundId, err: err as Error })
      sendError(res, 500, "STORAGE_ERROR", "enqueue failed", requestId)
      return
    }

    userLog.info("proactive_enqueued", {
      outboundId: body.outboundId,
      outcome: result.outcome,
      outboxId: result.outboxId,
    })
    reply(res, requestId, result.outcome, result.outboxId)
  }
}
