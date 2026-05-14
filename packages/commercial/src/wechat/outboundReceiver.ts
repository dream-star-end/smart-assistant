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
 *   2) zod 严格 parse;blocks 用 discriminatedUnion(kind),unknown key 拒绝
 *   3) outbound rate-limit 检查(P1 noop,但保留调用便于 P3 切换)
 *   4) renderWechatBlocks 把 5 种 OutboundContentBlock 投影成 IlinkPart[]:
 *        - text         → renderAssistantText(sanitize + split 1024)
 *        - tool_use     → renderToolAnnouncement("🔧 X…")
 *        - tool_result  → P1 drop(voluminous, 用户在 web 看;P2 可考虑短链摘要)
 *        - thinking     → P1 drop(reasoning 不外发)
 *        - tool_output_tail → P1 drop(已被 tool_use 公告覆盖)
 *        - parentToolUseId 非空 → 子 agent 内容,WeChat 不上抛(SoC:Agent card 是 web-only)
 *   5) 若渲染后 parts 为空 → 200 `outcome:"empty_render"`,**不**入队,**不**进 retry
 *      (避免 worker drainOne 走 invalid_payload 路径;receiver 侧前置一刀)
 *   6) 调 `enqueue(pool, params)`,把 EnqueueResult 翻成 HTTP 应答:
 *        - queued/pending  → 202 scheduled:true
 *        - already_sent    → 200 scheduled:false(24h tombstone 内拒二次下发)
 *        - already_failed  → 200 scheduled:false(broker 已放弃,sink 应停 retry)
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
import { renderAssistantText, renderToolAnnouncement } from "./rendererPipeline.js"
import { type RateLimiter } from "./rateLimiter.js"
import { WECHAT_SESSION_ID_REGEX, type IlinkPart } from "./types.js"

/** Container → master 出站 endpoint。挂在 master:18443 + self-host 18791。 */
export const WECHAT_OUTBOUND_PATH = "/internal/v3/wechat-outbound"

/**
 * Body 上限 256 KB —— 与 internalServerAuthored 对齐。
 *
 * 单条 outbound 一般 < 4 KB(assistant 文本 + 少量 tool_use 元数据);256 KB 留足
 * 富 tool_use input preview / tool_result preview 的余量,同时挡住 DoS-by-body。
 */
const MAX_BODY_BYTES = 256 * 1024

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
  .strict()

const ToolUseBlock = z
  .object({
    kind: z.literal("tool_use"),
    blockId: z.string().optional(),
    toolName: z.string().min(1).max(128),
    summary: z.string().optional(),
    inputPreview: z.string().optional(),
    inputJson: z.unknown().optional(),
    partial: z.boolean().optional(),
    parentToolUseId: z.string().optional(),
    messageId: z.string().optional(),
  })
  .strict()

const ToolResultBlock = z
  .object({
    kind: z.literal("tool_result"),
    blockId: z.string().optional(),
    toolUseBlockId: z.string().optional(),
    toolName: z.string().min(1).max(128),
    isError: z.boolean(),
    preview: z.string().optional(),
    parentToolUseId: z.string().optional(),
  })
  .strict()

const ThinkingBlock = z
  .object({
    kind: z.literal("thinking"),
    text: z.string(),
    parentToolUseId: z.string().optional(),
    messageId: z.string().optional(),
  })
  .strict()

const ToolOutputTailBlock = z
  .object({
    kind: z.literal("tool_output_tail"),
    toolUseBlockId: z.string().min(1),
    tail: z.string(),
    totalBytes: z.number(),
    truncatedHead: z.boolean(),
    parentToolUseId: z.string().optional(),
  })
  .strict()

const BlockSchema = z.discriminatedUnion("kind", [
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
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
    blocks: z.array(BlockSchema).min(1).max(64),
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

/** 渲染结果分类。renderEmpty 时不入队,返 200 + `outcome:"empty_render"`。 */
type RenderResult = { parts: IlinkPart[]; dropped: number }

/**
 * 把 5 种 OutboundContentBlock 投影成 IlinkPart[]。
 *
 * **规则**(详见模块头注释):
 *   - parentToolUseId 非空 → 整块 skip(subagent 内容只在 web Agent card 渲染)
 *   - text → renderAssistantText(可能产出多 part,sanitize markdown + split 1024)
 *   - tool_use → renderToolAnnouncement("🔧 X…")
 *   - tool_result / thinking / tool_output_tail → drop(P1 不外发)
 *
 * 返回 `dropped` 计数仅用于审计 / 测试断言(broker 关心"是否完全空"由 caller 判断)。
 */
export function renderWechatBlocks(blocks: OutboundReceiverBody["blocks"]): RenderResult {
  const parts: IlinkPart[] = []
  let dropped = 0
  for (const b of blocks) {
    if (b.parentToolUseId !== undefined && b.parentToolUseId.length > 0) {
      dropped++
      continue
    }
    switch (b.kind) {
      case "text": {
        const rendered = renderAssistantText(b.text)
        if (rendered.length === 0) {
          dropped++
        } else {
          for (const p of rendered) parts.push(p)
        }
        break
      }
      case "tool_use": {
        for (const p of renderToolAnnouncement(b.toolName)) parts.push(p)
        break
      }
      case "tool_result":
      case "thinking":
      case "tool_output_tail":
        dropped++
        break
    }
  }
  return { parts, dropped }
}

// ─── handler dependencies ──────────────────────────────────────────────────

export interface OutboundReceiverDeps {
  identityRepo: ContainerIdentityRepo
  pool: Pool
  rateLimiter: RateLimiter
  /** outbox 最大尝试数;default = DEFAULT_MAX_ATTEMPTS。 */
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
    let body: OutboundReceiverBody
    try {
      const raw = await readBoundedJson(req, MAX_BODY_BYTES)
      const parsed = BodySchema.safeParse(raw)
      if (!parsed.success) {
        userLog.warn("bad_body", { issues: parsed.error.issues })
        sendJsonError(res, 400, "INVALID_BODY", "body schema rejected", requestId)
        return
      }
      body = parsed.data
    } catch (err) {
      if (err instanceof HttpError) {
        sendJsonError(res, err.status, err.code, err.message, requestId)
        return
      }
      throw err
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

    // 4) Render 5 种 block → IlinkPart[]
    const { parts, dropped } = renderWechatBlocks(body.blocks)
    if (parts.length === 0) {
      // 全 drop / 全空文本 — 不入队(避免 worker 走 invalid_payload 路径)。
      // 容器侧 sink 视为 "已接收、无可发内容、勿重试"。
      userLog.info("empty_render", {
        outboundId: body.outboundId,
        sessionId: body.sessionId,
        blocks: body.blocks.length,
        dropped,
      })
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

    sendOutcomeResponse(res, requestId, result.outcome, result.outboxId, userLog, body)
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
  // 终态(already_sent / already_failed)用 200;待发(queued / pending)用 202。
  // Container sink 用 `scheduled` 判断本地 outbox 行该不该删:
  //   - scheduled:true  → broker 会发,sink 删本地 outbox
  //   - scheduled:false → broker 不会发(终态),sink 删本地 outbox(此前已发或永久失败,不该再 retry)
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
      // 24h tombstone 内 — 不能二次下发(微信去重要求)。Sink 删本地行。
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
    case "already_failed":
      // attempts >= maxAttempts — broker 已放弃,sink 也不应再发。
      log.info("already_failed_terminal", { outboundId: body.outboundId, outboxId })
      sendJsonOk(
        res,
        200,
        {
          ok: true,
          accepted: true,
          outcome: "already_failed",
          scheduled: false,
          outboxId,
        },
        requestId,
      )
      return
  }
}

async function readBoundedJson(
  req: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const b = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
    total += b.length
    if (total > maxBytes) {
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        `request body exceeds ${maxBytes} bytes`,
      )
    }
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
