/**
 * v3 commercial WeChat broker — HTTP handler:容器 → master 出站消息接收点。
 *
 * 详见 docs/v3/wechat-broker-design.md §4.3 / §4.4。
 *
 * 路径:`POST /internal/v3/wechat-outbound`(挂在 master:18443 mTLS listener;
 * self-host 18791 同样路由,容器→broker 复用 anthropicProxy 双因子)
 *
 * 职责:
 *   1) 双因子 identity 校验(同 anthropicProxy);bindingUserId 严格取自 identity,
 *      **绝不**从 body 取 — 防止 compromised container 跨用户写他人 outbox
 *   2) zod 严格 parse;blocks 用 discriminatedUnion(kind),同时保留扩展字段
 *   3) outbound rate-limit 检查(P1 noop,但保留调用便于 P3 切换)
 *   4) renderWechatBlocks 把 OutboundContentBlock 投影成 IlinkPart[]:
 *        - text/thinking → 合并连续块,按 iLink 单条上限无损分片
 *        - tool_use/tool_result/tool_output_tail/goal → 发送完整 JSON
 *        - parentToolUseId 非空 → 加子 Agent 标记后完整发送
 *   5) 若渲染后 parts 为空 → 200 `outcome:"empty_render"`,**不**入队,**不**进 retry
 *      (避免 worker drainOne 走 invalid_payload 路径;receiver 侧前置一刀)
 *   6) 调 `enqueue(pool, params)`,把 EnqueueResult 翻成 HTTP 应答:
 *        - queued/pending  → 202 scheduled:true
 *        - already_sent    → 200 scheduled:false(永久 tombstone 拒二次下发)
 *
 * **trust boundary** (与 internalServerAuthored 同源):
 *   - bindingUserId = String(identity.userId)
 *   - 不接受 body.bindingUserId / body.peer.meta.userId(schema 不声明此字段)
 *   - 不在此层做"binding 是否仍 active"二次 SELECT 防御 — drainOne 已经在出站时
 *     forceFail("binding_gone")兜底;receive 层重复 SELECT 是 over-defense
 *     (Codex slice 4 plan r2 PASS 接受 active-binding-gate 拒绝)
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Pool } from "pg"
import { z } from "zod"

import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js"
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  setSecurityHeaders,
} from "./../http/util.js"
import { rootLogger, type Logger } from "../logging/logger.js"
import { enqueue, type EnqueueOutcome } from "./outboxStore.js"
import { splitText, WECHAT_MAX_TEXT } from "./rendererPipeline.js"
import { expandTextWithWechatMediaParts } from "./outboundMedia.js"
import { type RateLimiter } from "./rateLimiter.js"
import { clearRunningSession } from "./sessionPointer.js"
import { WECHAT_SESSION_ID_REGEX, type IlinkPart } from "./types.js"

/** Container → master 出站 endpoint。挂在 master:18443 + self-host 18791。 */
export const WECHAT_OUTBOUND_PATH = "/internal/v3/wechat-outbound"

/** outboundId charset 与长度,与 server-authored requestId 思路一致(URL/log safe)。 */
const OUTBOUND_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/

/** wsess- 命名空间 — 与 sessionPointer / outboxStore 对齐。 */
const WSESS_ID_RE = WECHAT_SESSION_ID_REGEX

/** agentId charset 与 internalServerAuthored 对齐(`main` / `codex` 等),最长 64。 */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** senderId(WeChat openid 衍生 base64url)长度上界 — 实际典型 < 64 字符,留 256 余量。 */
const SENDER_ID_RE = /^[A-Za-z0-9_-]{1,256}$/

/** traceId 字符集与长度,容器侧 traceId 通常 hex/uuid。 */
const TRACE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

// ─── Block schemas — 镜像 packages/protocol/src/frames.ts OutboundContentBlock ───
//
// 不直接复用 protocol 的 TypeBox schema(包间 import 拓扑顾虑 + zod 与 typebox 双解析),
// 而是手抄一份 zod 镜像。protocol union 演化时本文件需同步(由 P2 整合时 lift 到一处)。

const TextBlock = z
  .object({
    kind: z.literal("text"),
    text: z.string(),
    parentToolUseId: z.string().optional(),
    messageId: z.string().optional(),
  })
  .passthrough()

const ToolUseBlock = z
  .object({
    kind: z.literal("tool_use"),
    blockId: z.string().optional(),
    toolName: z.string().min(1),
    summary: z.string().optional(),
    inputPreview: z.string().optional(),
    inputJson: z.unknown().optional(),
    partial: z.boolean().optional(),
    parentToolUseId: z.string().optional(),
    messageId: z.string().optional(),
  })
  .passthrough()

const ToolResultBlock = z
  .object({
    kind: z.literal("tool_result"),
    blockId: z.string().optional(),
    toolUseBlockId: z.string().optional(),
    toolName: z.string().min(1),
    isError: z.boolean(),
    preview: z.string().optional(),
    parentToolUseId: z.string().optional(),
  })
  .passthrough()

const ThinkingBlock = z
  .object({
    kind: z.literal("thinking"),
    text: z.string(),
    parentToolUseId: z.string().optional(),
    messageId: z.string().optional(),
  })
  .passthrough()

const GoalBlock = z
  .object({
    kind: z.literal("goal"),
    blockId: z.string().optional(),
    objective: z.string().optional(),
    status: z.string().optional(),
    tokenBudget: z.union([z.number(), z.null()]).optional(),
    tokensUsed: z.number().optional(),
    timeUsedSeconds: z.number().optional(),
    updatedAt: z.number().optional(),
    cleared: z.boolean().optional(),
    parentToolUseId: z.string().optional(),
  })
  .passthrough()

const ToolOutputTailBlock = z
  .object({
    kind: z.literal("tool_output_tail"),
    toolUseBlockId: z.string().min(1),
    tail: z.string(),
    totalBytes: z.number(),
    truncatedHead: z.boolean(),
    parentToolUseId: z.string().optional(),
  })
  .passthrough()

const BlockSchema = z.discriminatedUnion("kind", [
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  GoalBlock,
  ToolOutputTailBlock,
])

/**
 * Wire body schema —— peer.meta 走结构化字段而非裸 colon 拼 peer.id,避免歧义解析。
 *
 * Trust 不变量:peer.meta.senderId 是**用户/容器声明**的目标 WeChat openid;broker
 * 用它 + bindingUserId(从 identity)去 binding.contextTokens 表里取 contextToken。
 * 没匹配 → drainOne 走 no_context_token 永久失败,本层不前置拦(避免主动 SELECT)。
 */
const BodySchema = z
  .object({
    sessionId: z
      .string()
      .regex(WSESS_ID_RE, {
        message: "sessionId must match wsess-[0-9a-f]{16}",
      }),
    /** 可选 — `main` / `codex` 等;不参与 outbox 行键,仅审计 / 未来 routing 用。 */
    agentId: z
      .string()
      .regex(AGENT_ID_RE, { message: "agentId must match [A-Za-z0-9_-]{1,64}" })
      .optional(),
    channel: z.literal("wechat"),
    peer: z
      .object({
        kind: z.union([z.literal("dm"), z.literal("group")]),
        meta: z
          .object({
            senderId: z
              .string()
              .regex(SENDER_ID_RE, { message: "senderId must match [A-Za-z0-9_-]{1,256}" }),
          })
          .strict()
          .passthrough(),
      })
      .strict(),
    blocks: z.array(BlockSchema).min(1),
    /** Container marks final/error outbound so master can clear running-session state. */
    isFinal: z.boolean().optional(),
    outboundId: z
      .string()
      .regex(OUTBOUND_ID_RE, {
        message: "outboundId must match [A-Za-z0-9._:-]{8,128}",
      }),
    /** ms epoch;不影响 outbox 行 createdAt(broker 用 `now()` 自打)。仅审计。 */
    createdAt: z.number().int().positive().optional(),
    traceId: z
      .string()
      .regex(TRACE_ID_RE, { message: "traceId must match [A-Za-z0-9._:-]{1,128}" })
      .optional(),
  })
  .strict()

export type OutboundReceiverBody = z.infer<typeof BodySchema>

const CodexBillingBodySchema = z
  .object({
    type: z.literal("outbound.codex_billing"),
    requestId: z.string().regex(/^[0-9a-f]{32}$/, {
      message: "requestId must be 32 lowercase hex chars",
    }),
    turnKey: z.string().regex(/^[0-9a-f]{64}$/, {
      message: "turnKey must be 64 lowercase hex chars",
    }).optional(),
    parentTurnKey: z.string().regex(/^[0-9a-f]{64}$/, {
      message: "parentTurnKey must be 64 lowercase hex chars",
    }).optional(),
    parentSessionId: z.string().min(1).max(256).optional(),
    delegateAgentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    status: z.union([z.literal("success"), z.literal("error")]),
    durationMs: z.number().finite().nonnegative(),
    usage: z
      .object({
        input_tokens: z.number().finite().optional(),
        output_tokens: z.number().finite().optional(),
        cache_read_input_tokens: z.number().finite().optional(),
        cache_creation_input_tokens: z.number().finite().optional(),
        reasoning_output_tokens: z.number().finite().optional(),
      })
      .strict()
      .optional(),
    errorReason: z.string().optional(),
    rateLimits: z
      .object({
        util5h: z.number().finite().optional(),
        reset5h: z.string().max(128).optional(),
        util7d: z.number().finite().optional(),
        reset7d: z.string().max(128).optional(),
      })
      .strict()
      .optional(),
    traceId: z
      .string()
      .regex(TRACE_ID_RE, { message: "traceId must match [A-Za-z0-9._:-]{1,128}" })
      .optional(),
  })
  .strict()

export type WechatCodexBillingBody = z.infer<typeof CodexBillingBodySchema>

/** 渲染结果分类。renderEmpty 时不入队,返 200 + `outcome:"empty_render"`。 */
type RenderResult = { parts: IlinkPart[]; dropped: number }

export interface RenderWechatBlocksOptions {
  /** 兼容旧调用端;无损模式始终保留工具和思考过程。 */
  showToolCalls?: boolean
}

function formatGoalBlock(block: z.infer<typeof GoalBlock>): string {
  if (block.cleared) return "🎯 当前 Codex goal 已清除。"
  const lines = ["🎯 目标更新：", block.objective || "Codex goal 已更新。"]
  if (block.status) lines.push(`状态：${block.status}`)
  if (typeof block.tokensUsed === "number") {
    lines.push(
      typeof block.tokenBudget === "number"
        ? `Tokens：${block.tokensUsed}/${block.tokenBudget}`
        : `Tokens：${block.tokensUsed}`,
    )
  }
  if (typeof block.timeUsedSeconds === "number" && Number.isFinite(block.timeUsedSeconds)) {
    lines.push(`用时：${Math.max(0, Math.round(block.timeUsedSeconds))}s`)
  }
  return lines.join("\n")
}

/**
 * 把 OutboundContentBlock 投影成 IlinkPart[]。
 *
 * **规则**(详见模块头注释):
 *   - parentToolUseId 非空 → 加标记但不丢弃。
 *   - text/thinking → 合并相邻增量,再按 iLink 单条长度无损分片。
 *   - tool_use/tool_result/tool_output_tail/goal → 显示提示和完整原始 JSON。
 *
 * 返回 `dropped` 计数仅用于审计 / 测试断言(broker 关心"是否完全空"由 caller 判断)。
 */
export function renderWechatBlocks(
  blocks: OutboundReceiverBody["blocks"],
  _options: RenderWechatBlocksOptions = {},
): RenderResult {
  const parts: IlinkPart[] = []
  let dropped = 0
  let textBuffer = ""
  let textParent: string | undefined
  let thinkingBuffer = ""
  let thinkingParent: string | undefined

  const prefix = (parentToolUseId?: string): string =>
    parentToolUseId ? `【子 Agent ${parentToolUseId}】\n` : ""
  const pushRendered = (text: string): void => {
    if (text.length === 0) return
    for (const chunk of splitText(text, WECHAT_MAX_TEXT)) {
      parts.push({ type: "text", text: chunk })
    }
  }
  const flushText = () => {
    if (textBuffer.length === 0) return
    pushRendered(`${prefix(textParent)}${textBuffer}`)
    textBuffer = ""
    textParent = undefined
  }
  const flushThinking = () => {
    if (thinkingBuffer.length === 0) return
    pushRendered(`${prefix(thinkingParent)}💭 思考过程：\n${thinkingBuffer}`)
    thinkingBuffer = ""
    thinkingParent = undefined
  }
  const flushAll = () => {
    flushThinking()
    flushText()
  }

  for (const block of blocks) {
    switch (block.kind) {
      case "text": {
        flushThinking()
        if (textBuffer.length > 0 && textParent !== block.parentToolUseId) flushText()
        textParent = block.parentToolUseId
        textBuffer += block.text
        break
      }
      case "thinking": {
        flushText()
        if (thinkingBuffer.length > 0 && thinkingParent !== block.parentToolUseId) flushThinking()
        thinkingParent = block.parentToolUseId
        thinkingBuffer += block.text
        break
      }
      case "tool_use": {
        flushAll()
        pushRendered(
          `${prefix(block.parentToolUseId)}🔧 工具调用：${block.toolName}\n${JSON.stringify(block, null, 2)}`,
        )
        break
      }
      case "tool_result": {
        flushAll()
        pushRendered(
          `${prefix(block.parentToolUseId)}${block.isError ? "❌" : "✅"} 工具结果：${block.toolName}\n${JSON.stringify(block, null, 2)}`,
        )
        break
      }
      case "tool_output_tail": {
        flushAll()
        pushRendered(
          `${prefix(block.parentToolUseId)}📟 工具实时输出：${block.toolUseBlockId}\n${JSON.stringify(block, null, 2)}`,
        )
        break
      }
      case "goal": {
        flushAll()
        pushRendered(`${prefix(block.parentToolUseId)}${formatGoalBlock(block)}\n${JSON.stringify(block, null, 2)}`)
        break
      }
    }
  }
  flushAll()
  return { parts, dropped }
}

export function expandRenderedPartsWithWechatMedia(parts: IlinkPart[]): IlinkPart[] {
  const out: IlinkPart[] = []
  for (const part of parts) {
    if (part.type !== "text") {
      out.push(part)
      continue
    }
    if (!shouldExpandWechatMediaFromText(part.text)) {
      out.push(part)
      continue
    }
    const expanded = expandTextWithWechatMediaParts(part.text)
    if (expanded.text) out.push({ type: "text", text: expanded.text })
    for (const media of expanded.media) out.push(media)
  }
  return out
}

function shouldExpandWechatMediaFromText(text: string): boolean {
  return (
    !text.startsWith("💭 思考过程：") &&
    !text.startsWith("🔧 ") &&
    !text.startsWith("🎯 ")
  )
}

// ─── handler dependencies ──────────────────────────────────────────────────

export interface OutboundReceiverDeps {
  identityRepo: ContainerIdentityRepo
  pool: Pool
  rateLimiter: RateLimiter
  /**
   * Optional internal sideband handler for Codex billing frames. Billing frames
   * are authenticated with the same container identity as normal WeChat
   * outbound, but bypass message outbox rate limiting/rendering.
   */
  handleCodexBilling?: (body: WechatCodexBillingBody, identity: ContainerIdentity) => Promise<void>
  /** @deprecated 无损模式不再允许隐藏已计费的工具/思考内容。 */
  getWechatShowToolCalls?: (userId: number) => Promise<boolean>
  /** @deprecated 仅保留滚动升级配置兼容;出站重试不再封顶。 */
  maxAttempts?: number
  logger?: Logger
  /** 注入便于测试;default = Date.now。 */
  now?: () => number
}

export interface OutboundReceiverCtx {
  hostUuid: string
  boundIp: string
}

export type OutboundReceiverHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OutboundReceiverCtx,
) => Promise<void>

export function makeOutboundReceiverHandler(
  deps: OutboundReceiverDeps,
): OutboundReceiverHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "wechatOutboundReceiver" })
  const now = deps.now ?? (() => Date.now())
  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    const reqLog = log.child({
      requestId,
      hostUuid: ctx.hostUuid,
      boundIp: ctx.boundIp,
      method: req.method ?? "GET",
    })

    // 0) Method 白名单 — caller 已按路径路由,这里兜底防误调用。
    if (req.method !== "POST") {
      sendJsonError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId)
      return
    }

    // 1) Container identity(双因子,与 anthropicProxy / internalServerAuthored 同源)
    let identity
    try {
      identity = await verifyContainerIdentity(
        deps.identityRepo,
        ctx,
        req.headers.authorization,
      )
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn("identity_failed", { errcode: err.code })
        sendJsonError(
          res,
          401,
          "UNAUTHORIZED",
          "container identity verification failed",
          requestId,
        )
        return
      }
      throw err
    }
    const bindingUserId = String(identity.userId)
    const userLog = reqLog.child({ uid: identity.userId, containerId: identity.containerId })

    // 2) Body 读 + zod schema parse
    let raw: unknown
    try {
      raw = await readJson(req)
    } catch (err) {
      if (err instanceof HttpError) {
        sendJsonError(res, err.status, err.code, err.message, requestId)
        return
      }
      throw err
    }

    // Internal Codex billing sideband. It must run before normal WeChat
    // outbound rate limiting/render/enqueue, otherwise a user-visible message
    // throttle could delay billing until the pending turn times out.
    const billingParsed = CodexBillingBodySchema.safeParse(raw)
    if (billingParsed.success) {
      if (!deps.handleCodexBilling) {
        userLog.error("codex_billing_not_wired", { billingRequestId: billingParsed.data.requestId })
        sendJsonError(res, 503, "CODEX_BILLING_NOT_WIRED", "codex billing handler not configured", requestId)
        return
      }
      try {
        await deps.handleCodexBilling(billingParsed.data, identity)
      } catch (err) {
        userLog.error("codex_billing_handler_threw", {
          billingRequestId: billingParsed.data.requestId,
          err: err as Error,
        })
        sendJsonError(res, 500, "CODEX_BILLING_FAILED", "codex billing handler failed", requestId)
        return
      }
      sendJsonOk(
        res,
        200,
        {
          ok: true,
          accepted: true,
          outcome: "codex_billing",
          scheduled: false,
        },
        requestId,
      )
      return
    }

    let body: OutboundReceiverBody
    {
      const parsed = BodySchema.safeParse(raw)
      if (!parsed.success) {
        userLog.warn("bad_body", { issues: parsed.error.issues })
        sendJsonError(res, 400, "INVALID_BODY", "body schema rejected", requestId)
        return
      }
      body = parsed.data
    }

    // 3) Outbound rate-limit(P1 noop always true;P3 真实滑窗)
    if (!deps.rateLimiter.checkOutbound(bindingUserId)) {
      userLog.warn("rate_limited", {
        outboundId: body.outboundId,
        sessionId: body.sessionId,
      })
      sendJsonError(res, 429, "RATE_LIMIT", "outbound rate limit exceeded", requestId)
      return
    }

    // 4) Render OutboundContentBlock → IlinkPart[]
    const rendered = renderWechatBlocks(body.blocks)
    const expandedParts = expandRenderedPartsWithWechatMedia(rendered.parts)
    const parts = expandedParts
    const dropped = rendered.dropped
    if (parts.length === 0) {
      // 全 drop / 全空文本 — 不入队(避免 worker 走 invalid_payload 路径)。
      // 容器侧 sink 视为 "已接收、无可发内容、勿重试"。
      userLog.info("empty_render", {
        outboundId: body.outboundId,
        sessionId: body.sessionId,
        blocks: body.blocks.length,
        dropped,
      })
      await clearRunningIfFinal(body, bindingUserId, deps.pool, userLog)
      sendJsonOk(
        res,
        200,
        {
          ok: true,
          accepted: true,
          outcome: "empty_render",
          scheduled: false,
        },
        requestId,
      )
      return
    }

    // 5) Enqueue — outboundId UNIQUE 保证幂等,EnqueueOutcome 翻成 HTTP 应答
    let result
    try {
      result = await enqueue(
        deps.pool,
        {
          outboundId: body.outboundId,
          bindingUserId,
          senderId: body.peer.meta.senderId,
          sessionId: body.sessionId,
          payload: parts,
          rawPayload: body,
          now: now(),
        },
        deps.maxAttempts,
      )
    } catch (err) {
      userLog.error("enqueue_threw", {
        outboundId: body.outboundId,
        sessionId: body.sessionId,
        err: err as Error,
      })
      sendJsonError(res, 500, "STORAGE_ERROR", "enqueue failed", requestId)
      return
    }

    await clearRunningIfFinal(body, bindingUserId, deps.pool, userLog)
    sendOutcomeResponse(res, requestId, result.outcome, result.outboxId, userLog, body)
  }
}

async function clearRunningIfFinal(
  body: OutboundReceiverBody,
  bindingUserId: string,
  pool: Pool,
  log: Logger,
): Promise<void> {
  if (body.isFinal !== true) return
  if (!body.traceId) return
  try {
    await clearRunningSession(pool, bindingUserId, body.sessionId, body.traceId)
  } catch (err) {
    log.warn("clear_running_session_failed", {
      outboundId: body.outboundId,
      sessionId: body.sessionId,
      err: err as Error,
    })
  }
}

// ─── private helpers ───────────────────────────────────────────────────────

function sendOutcomeResponse(
  res: ServerResponse,
  requestId: string,
  outcome: EnqueueOutcome,
  outboxId: number,
  log: Logger,
  body: OutboundReceiverBody,
): void {
  // 已发送幂等命中用 200;待发(queued / pending)用 202。
  // Container sink 用 `scheduled` 判断本地 outbox 行该不该删:
  //   - scheduled:true  → broker 会发,sink 删本地 outbox
  //   - scheduled:false → 同 outboundId 此前已发送,sink 可删本地重复项
  switch (outcome) {
    case "queued":
      log.info("enqueued", { outboundId: body.outboundId, outboxId })
      sendJsonOk(
        res,
        202,
        {
          ok: true,
          accepted: true,
          outcome: "queued",
          scheduled: true,
          outboxId,
        },
        requestId,
      )
      return
    case "pending":
      // 同 outboundId 已在 queued / sending — 幂等命中,sink 收到 202 删本地行。
      log.info("pending_dedup", { outboundId: body.outboundId, outboxId })
      sendJsonOk(
        res,
        202,
        {
          ok: true,
          accepted: true,
          outcome: "pending",
          scheduled: true,
          outboxId,
        },
        requestId,
      )
      return
    case "already_sent":
      // 永久 tombstone — 不能二次下发(微信去重要求)。Sink 删本地重复行。
      log.info("already_sent_dedup", { outboundId: body.outboundId, outboxId })
      sendJsonOk(
        res,
        200,
        {
          ok: true,
          accepted: true,
          outcome: "already_sent",
          scheduled: false,
          outboxId,
        },
        requestId,
      )
      return
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const b = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
    total += b.length
    chunks.push(b)
  }
  if (total === 0) {
    throw new HttpError(400, "EMPTY_BODY", "request body is empty")
  }
  const text = Buffer.concat(chunks, total).toString("utf-8")
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new HttpError(
      400,
      "INVALID_JSON",
      `body is not valid JSON: ${(err as Error).message}`,
    )
  }
}

function sendJsonOk(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  requestId: string,
): void {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf-8")),
    [REQUEST_ID_HEADER]: requestId,
  })
  res.end(body)
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  if (res.headersSent) return
  const body = JSON.stringify({
    error: { code, message },
    request_id: requestId,
  })
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf-8")),
    [REQUEST_ID_HEADER]: requestId,
  })
  res.end(body)
}
