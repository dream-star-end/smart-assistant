/**
 * Container-side ChannelAdapter that ships OutboundMessage to master's
 * `/internal/v3/wechat-outbound` for the WeChat broker pipeline
 * (P1.7 slice 7c)。
 *
 * Why a separate adapter and not the existing manager.ts wechat adapter:
 *   manager.ts spawns one WechatWorker per active binding and writes to
 *   ilinkai.weixin.qq.com directly. That path is the **personal-OC** stack —
 *   each user binds their own bot and the container talks to Tencent. For
 *   v3 commercial the wire is reversed: the master holds the iLink token,
 *   long-polls Tencent, and translates inbound messages into broker-owned
 *   wsess- sessions. The container's job is to render OutboundMessage →
 *   POST to master broker → broker schedules outbox → broker.outboxWorker
 *   writes to Tencent. So this adapter does NOT touch Tencent at all; it
 *   only speaks to master.
 *
 * Wire payload:
 *   Matches master `outboundReceiver.BodySchema`(.strict + .passthrough on
 *   peer.meta only) exactly:
 *     sessionId  = out.peer.id   (wsess-[0-9a-f]{16}, broker namespace)
 *     channel    = "wechat"
 *     agentId    = current container agent (env-derived; optional)
 *     outboundId = out.traceId ?? `${sessionId}.${createdAt}.${rand}` —
 *                  per-call unique; master uses it as dedup key
 *     peer       = { kind, meta:{ senderId: out.peer.displayName } }
 *     blocks     = out.blocks (passed through; master filters server-side)
 *     createdAt  = now() ms epoch
 *     traceId    = out.traceId (optional, passed through for audit)
 *
 *   senderId carrier:  out.peer.displayName。dispatcher.wireBody stamps it
 *   inbound (slice 7c lock-in), the container gateway keeps it through
 *   OutboundMessage.peer.displayName, and this adapter pulls it back out
 *   into peer.meta.senderId for the wire. If it's missing we cannot
 *   satisfy master's schema (regex check fails),so the adapter logs +
 *   drops with a structured warn rather than enqueueing a guaranteed-fatal
 *   payload.
 *
 * Failure semantics(Codex slice 7c plan v3 PASS):
 *   2xx (200 + 202) → success(200 = empty_render / dedup terminal;
 *       202 = queued / pending_dedup / sending). Both: drop local retry entry.
 *   401 / 403 / 404 / 410 → fatal(tenant_mismatch / session_not_found /
 *       session_deleted / auth_invalid)。Retrying is pointless.
 *   429 / 5xx / network / timeout → transient → enqueue durable retry。
 *   Other 4xx → fatal(schema bug;ops surfaces via warn,never auto-retry)。
 *
 * Shutdown contract(Codex slice 7c plan v3 reminder #2):
 *   shutdown() stops the periodic drain timer **but DOES NOT** stop the
 *   send() path from calling enqueueDurable on attemptSend failure. Late
 *   frames(SIGTERM during a turn end)must still survive to disk —
 *   otherwise gateway shutdown silently drops the last assistant outputs.
 *   Drain resumes from the same dir on next boot.
 */

import { randomBytes } from "node:crypto"
import { request as undiciRequest } from "undici"

import type { ChannelAdapter, ChannelContext } from "@openclaude/plugin-sdk"
import type { OutboundCodexBilling, OutboundMessage } from "@openclaude/protocol"

import { createLogger } from "./logger.js"
import {
  type V3WechatRetryQueue,
  type V3WechatRetryEntry,
  type V3WechatSinkWirePayload,
  type V3WechatCodexBillingWirePayload,
  type V3WechatOutboundPostPayload,
  V3WechatSinkError,
  makeV3WechatRetryQueue,
} from "./v3WechatRetryQueue.js"

const log = createLogger({ module: "v3WechatOutbound" })

/** Master's broker path。与 outboundReceiver.ts:58 WECHAT_OUTBOUND_PATH 一致。 */
export const WECHAT_OUTBOUND_PATH = "/internal/v3/wechat-outbound"

/** Per-POST timeout。短于 v3MasterSink(8s),因为 broker enqueue 是同步 INSERT,
 *  正常应 < 200 ms;超 3 s 必然是 master overload / 网络糟糕,落 durable retry。 */
const ATTEMPT_TIMEOUT_MS = 3_000

/** Body cap。broker enqueue 行只存渲染后 IlinkPart[],原始 blocks 走 audit。
 *  64 KB 留余地:assistant text + tool snapshots 极少超过。超过 cap → 400
 *  INVALID_BODY = fatal,与 master `MAX_BODY_BYTES` 同源策略。 */
const MAX_BODY_BYTES = 64 * 1024

/** wsess- session regex,与 master/protocol/commercial 全栈同源。 */
const WSESS_RE = /^wsess-[0-9a-f]{16}$/

/** outboundId 字符集与长度,与 master OUTBOUND_ID_RE 一致。 */
const OUTBOUND_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/

/** senderId 字符集与长度,与 master SENDER_ID_RE 一致。 */
const SENDER_ID_RE = /^[A-Za-z0-9_-]{1,256}$/

/** agentId 字符集,与 master AGENT_ID_RE 一致。 */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export interface V3WechatOutboundConfig {
  /** Master 基地址,不带尾斜杠。e.g. `http://172.30.0.1:18791`。 */
  baseUrl: string
  /** 容器身份 bearer:`oc-v3.<containerId>.<secret>`。 */
  bearer: string
  /** 当前容器 agent id,会 stamp 到每条 outbound。可选;不传则 agentId 字段 omit。 */
  agentId?: string
}

/** Read env-driven config。两个 env 都缺 → null(personal / dev 不挂 adapter)。 */
export function readV3WechatOutboundConfig(
  env: NodeJS.ProcessEnv = process.env,
): V3WechatOutboundConfig | null {
  const baseUrl = env.OPENCLAUDE_V3_MASTER_BASE_URL
  const bearer = env.OPENCLAUDE_V3_CONTAINER_TOKEN
  if (!baseUrl || !bearer) return null
  // 同 v3MasterSink:strip trailing slash so URL composition unambiguous
  const cfg: V3WechatOutboundConfig = {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    bearer,
  }
  const agentId = env.OPENCLAUDE_AGENT_ID
  if (agentId !== undefined && AGENT_ID_RE.test(agentId)) {
    cfg.agentId = agentId
  }
  return cfg
}

export interface AttemptSendDeps {
  config: V3WechatOutboundConfig
  /** Override only for tests — real callers use undici。 */
  fetcher?: typeof undiciRequest
  /** Override only for tests。 */
  timeoutMs?: number
}

/**
 * Single immediate POST attempt。成功 void;任何失败 throw V3WechatSinkError
 * 带 errorClass。永不 log bearer / payload body — 只 log path + status。
 */
export async function attemptSend(
  payload: V3WechatOutboundPostPayload,
  deps: AttemptSendDeps,
): Promise<void> {
  const url = `${deps.config.baseUrl}${WECHAT_OUTBOUND_PATH}`
  const fetcher = deps.fetcher ?? undiciRequest
  const timeoutMs = deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS

  const body = JSON.stringify(payload)
  const bodyBytes = Buffer.byteLength(body, "utf8")
  if (bodyBytes > MAX_BODY_BYTES) {
    // master 会 413 → fatal;提前在这里截,日志看得清。
    throw new V3WechatSinkError(
      `payload exceeds body cap (${bodyBytes} > ${MAX_BODY_BYTES})`,
      "fatal",
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Awaited<ReturnType<typeof undiciRequest>>
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${deps.config.bearer}`,
      },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    // 网络 / DNS / TCP / TLS / abort 全 transient
    throw new V3WechatSinkError(`network error: ${msg}`, "transient")
  }
  clearTimeout(timer)

  const status = res.statusCode

  // Drain body even on success so keep-alive socket returns to pool。
  // 同样 cap 防 master 异常巨型 body OOM 容器。
  let bodyText = ""
  try {
    bodyText = await readBoundedBody(res.body, MAX_BODY_BYTES)
  } catch {
    // ignore — non-2xx 时丢掉 master 错误细节但 status code 已携带分类
  }

  // ★ 2xx success **必须先于** body parse 检查 — 200 (empty_render / dedup
  // terminal) 和 202 (queued / sending) 是合法 success,body shape 各异不该 gate
  // success 判定(Codex 7c plan v3 reminder #1)
  if (status >= 200 && status < 300) {
    return
  }
  if (status === 404) {
    throw new V3WechatSinkError(
      `session_not_found: ${truncateForLog(bodyText)}`,
      "fatal",
      404,
    )
  }
  if (status === 410) {
    throw new V3WechatSinkError(
      `session_deleted: ${truncateForLog(bodyText)}`,
      "fatal",
      410,
    )
  }
  if (status === 401 || status === 403) {
    // 与 v3MasterSink 不同:wechat broker 401/403 在生产路径上不可能短暂出现
    // (master 不会因为时钟漂移 reject;bearer 是容器启动期注入的稳定值)。
    // 持续 401/403 = 运维错配,enqueue retry 24h 是噪声。判 fatal,让 ops 看到。
    throw new V3WechatSinkError(
      `auth ${status}: ${truncateForLog(bodyText)}`,
      "fatal",
      status,
    )
  }
  if (status === 429) {
    // master rate limit per binding。等冷却。
    throw new V3WechatSinkError(
      `rate_limited: ${truncateForLog(bodyText)}`,
      "transient",
      429,
    )
  }
  if (status >= 500 && status < 600) {
    throw new V3WechatSinkError(
      `master ${status}: ${truncateForLog(bodyText)}`,
      "transient",
      status,
    )
  }
  // 其他 4xx — schema / method / payload 违约。和 v3MasterSink 同源策略。
  throw new V3WechatSinkError(
    `master rejected ${status}: ${truncateForLog(bodyText)}`,
    "fatal",
    status,
  )
}

async function readBoundedBody(
  body: { [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | Uint8Array | string> },
  max: number,
): Promise<string> {
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    const b =
      chunk instanceof Buffer
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, "utf8")
          : Buffer.from(chunk)
    total += b.length
    if (total > max) break
    chunks.push(b)
  }
  return Buffer.concat(chunks, Math.min(total, max)).toString("utf8")
}

function truncateForLog(s: string): string {
  if (s.length <= 200) return s
  return s.slice(0, 200) + "…"
}

/**
 * 把 OutboundMessage 拍成 wire payload。
 *
 * **失败模式**:返 null 表示 "无法满足 master schema",adapter.send 应 log + drop
 * (这条消息进 retry 也注定 400 fatal)。具体场景:
 *   - peer.id 不是 wsess-(说明本路径错误地撞到了非 broker 会话)
 *   - peer.displayName 缺失或非 senderId 字符集(dispatcher slice 7c carrier 没生效)
 *   - blocks 空数组(master schema 要求 ≥1)
 */
function buildWirePayload(
  out: OutboundMessage,
  cfg: V3WechatOutboundConfig,
  now: number,
): V3WechatSinkWirePayload | { error: string } {
  const sessionId = out.peer?.id ?? ""
  if (!WSESS_RE.test(sessionId)) {
    return { error: `peer.id is not wsess-: ${truncateForLog(sessionId)}` }
  }
  const senderId = out.peer?.displayName ?? ""
  if (!SENDER_ID_RE.test(senderId)) {
    return {
      error: `peer.displayName missing or invalid (senderId carrier broken)`,
    }
  }
  if (!Array.isArray(out.blocks) || out.blocks.length === 0) {
    return { error: "blocks must be non-empty" }
  }

  // outboundId:per-call 唯一。优先 traceId(per-turn canonical),否则 sessionId
  // + ms + rand。两种都满足 OUTBOUND_ID_RE [A-Za-z0-9._:-]{8,128}。
  let outboundId: string
  if (out.traceId && OUTBOUND_ID_RE.test(out.traceId)) {
    outboundId = out.traceId
  } else {
    const rand = randomBytes(6).toString("hex")
    outboundId = `${sessionId}.${now}.${rand}`
    // sessionId 24 chars + "." + 13 digit ts + "." + 12 hex = 51 → 安全在 128 内
    if (!OUTBOUND_ID_RE.test(outboundId)) {
      // 理论上不可能(组合字符集合法),但留兜底防 randomBytes 异常
      return { error: `derived outboundId failed regex: ${outboundId}` }
    }
  }

  const payload: V3WechatSinkWirePayload = {
    sessionId,
    channel: "wechat",
    outboundId,
    peer: {
      kind: out.peer.kind === "group" ? "group" : "dm",
      meta: { senderId },
    },
    blocks: out.blocks,
    createdAt: now,
  }
  if (cfg.agentId !== undefined) {
    payload.agentId = cfg.agentId
  }
  if (out.traceId !== undefined) {
    payload.traceId = out.traceId
  }
  return payload
}

function isCodexBillingFrame(out: unknown): out is OutboundCodexBilling {
  return !!out && typeof out === "object" && (out as { type?: unknown }).type === "outbound.codex_billing"
}

function buildCodexBillingPayload(
  out: OutboundCodexBilling,
): V3WechatCodexBillingWirePayload | { error: string } {
  if (!/^[0-9a-f]{32}$/.test(out.requestId)) {
    return { error: "requestId must be 32 lowercase hex chars" }
  }
  const payload: V3WechatCodexBillingWirePayload = {
    type: "outbound.codex_billing",
    requestId: out.requestId,
    status: out.status === "error" ? "error" : "success",
    durationMs: Number.isFinite(out.durationMs) && out.durationMs >= 0 ? out.durationMs : 0,
  }
  if (out.usage !== undefined) payload.usage = out.usage
  if (typeof out.errorReason === "string") payload.errorReason = out.errorReason
  if (out.rateLimits !== undefined) payload.rateLimits = out.rateLimits
  if (typeof out.traceId === "string") payload.traceId = out.traceId
  return payload
}

export interface V3WechatOutboundDeps {
  config: V3WechatOutboundConfig
  /** Override only for tests。 */
  retryQueue?: V3WechatRetryQueue
  /** Override only for tests。 */
  attemptSendImpl?: typeof attemptSend
  /** Override only for tests。 */
  now?: () => number
}

/**
 * Build the WeChat outbound ChannelAdapter。
 *
 * **Shutdown semantics**(test-locked,见 v3WechatOutbound.test.ts):
 *   - `shutdown()` 停 periodic drain 计时器
 *   - `send()` 在 shutdown 后仍可调:attempt 失败回退 enqueueDurable 不被 gate
 *   - 进程退出后未发完的 entry 留盘,下次 boot drain 接着送
 *
 * Adapter id = "v3-wechat-outbound" — 与 manager.ts 的 "wechat" id 区分;两个 adapter
 * 可以并存(gateway 不会同时把同一 OutboundMessage 派给两个,channel 字段决定路由)。
 */
export function makeV3WechatOutboundAdapter(deps: V3WechatOutboundDeps): ChannelAdapter {
  const cfg = deps.config
  const attempt = deps.attemptSendImpl ?? attemptSend
  const now = deps.now ?? (() => Date.now())

  const retryQueue: V3WechatRetryQueue =
    deps.retryQueue ??
    makeV3WechatRetryQueue({
      attemptSend: (p) => attempt(p, { config: cfg }),
      now,
    })

  let ctx: ChannelContext | null = null

  const adapter: ChannelAdapter = {
    id: "v3-wechat-outbound",
    name: "v3-wechat-outbound",
    type: "channel" as const,

    async init(c) {
      ctx = c
      // boot drain — 上次 shutdown 留盘的 entry 立刻尝试一遍
      retryQueue.kick()
      retryQueue.startPeriodic()
      c.log.info("[v3-wechat-outbound] adapter initialized")
    },

    async send(out: OutboundMessage) {
      const maybeBilling = out as unknown
      if (isCodexBillingFrame(maybeBilling)) {
        if (maybeBilling.channel !== "wechat") return
        const payload = buildCodexBillingPayload(maybeBilling)
        if ("error" in payload) {
          log.warn("dropped: build codex billing payload failed", { reason: payload.error })
          return
        }
        try {
          await attempt(payload, { config: cfg })
        } catch (err) {
          if (err instanceof V3WechatSinkError && err.errorClass === "fatal") {
            log.warn("send: fatal codex billing sink error, dropping", {
              requestId: payload.requestId,
              httpStatus: err.httpStatus,
              err: err.message,
            })
            return
          }
          const entry: V3WechatRetryEntry = {
            schemaVersion: 1,
            payload,
            firstSeenAt: now(),
            attempts: 1,
            lastErrorClass:
              err instanceof V3WechatSinkError ? err.errorClass : "transient",
            lastErrorAt: now(),
            lastErrorMessage:
              err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          }
          try {
            await retryQueue.enqueueDurable(entry)
          } catch (enqErr) {
            log.error(
              "send: enqueueDurable failed after codex billing attempt",
              { requestId: payload.requestId },
              enqErr,
            )
          }
        }
        return
      }

      if (out.channel !== "wechat") return
      const payload = buildWirePayload(out, cfg, now())
      if ("error" in payload) {
        // 拍 payload 失败 → 该消息进 retry 也注定 400 fatal,log + drop
        log.warn("dropped: build payload failed", {
          sessionId: out.peer?.id,
          reason: payload.error,
        })
        return
      }

      // 1) 即时一次 attempt
      try {
        await attempt(payload, { config: cfg })
        return
      } catch (err) {
        if (err instanceof V3WechatSinkError && err.errorClass === "fatal") {
          log.warn("send: fatal sink error, dropping", {
            sessionId: payload.sessionId,
            outboundId: payload.outboundId,
            httpStatus: err.httpStatus,
            err: err.message,
          })
          return
        }
        // transient / 未知 → enqueue durable retry
        const entry: V3WechatRetryEntry = {
          schemaVersion: 1,
          payload,
          firstSeenAt: now(),
          attempts: 1,
          lastErrorClass:
            err instanceof V3WechatSinkError ? err.errorClass : "transient",
          lastErrorAt: now(),
          lastErrorMessage:
            err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        }
        try {
          await retryQueue.enqueueDurable(entry)
        } catch (enqErr) {
          // 落盘失败也只能 log;此时已经把数据丢了,但至少 alarm 出来
          log.error(
            "send: enqueueDurable failed after transient attempt",
            { sessionId: payload.sessionId, outboundId: payload.outboundId },
            enqErr,
          )
        }
      }
    },

    async shutdown() {
      // Codex slice 7c plan v3 reminder #2:只停周期 drain,send() 仍可 enqueue
      retryQueue.stopPeriodic()
      if (ctx) ctx.log.info("[v3-wechat-outbound] adapter shutdown (drain stopped, enqueue still active)")
    },
  }
  return adapter
}
