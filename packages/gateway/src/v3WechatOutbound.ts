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
 *     isFinal    = true only for terminal final/error frames
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
 * Failure semantics(lossless mode):
 *   Every payload is fsync-staged before its first network attempt. The retry
 *   queue removes it only after 2xx acknowledgement or explicit 410 owner
 *   deletion. 401/403/404/429/5xx/schema/network/timeout errors remain staged
 *   without attempt,age,byte,or entry-count limits;errorClass is diagnostic.
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

/** Only bounds diagnostic response capture; outbound request content is uncapped. */
const RESPONSE_BODY_CAPTURE_BYTES = 64 * 1024

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
    bodyText = await readBoundedBody(res.body, RESPONSE_BODY_CAPTURE_BYTES)
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
    // Keep the diagnostic `fatal` class for operators. The durable queue does
    // not discard on this class; only an explicit 410 owner deletion may do so.
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

  // outboundId:per-call 唯一。Live WeChat may send several messages for the
  // same turn, so gateway can pass an explicit per-message outboundId.  Fall
  // back to the historical traceId behavior for one-shot final sends, then to
  // sessionId + ms + rand.  All accepted forms satisfy master's regex.
  const explicitOutboundId = (out as unknown as { outboundId?: unknown }).outboundId
  let outboundId: string
  if (typeof explicitOutboundId === "string" && OUTBOUND_ID_RE.test(explicitOutboundId)) {
    outboundId = explicitOutboundId
  } else if (out.traceId && OUTBOUND_ID_RE.test(out.traceId)) {
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
  if (out.isFinal === true) {
    payload.isFinal = true
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
  if (typeof out.turnKey === "string" && /^[0-9a-f]{64}$/.test(out.turnKey)) {
    payload.turnKey = out.turnKey
  }
  if (typeof out.parentTurnKey === "string" && /^[0-9a-f]{64}$/.test(out.parentTurnKey)) {
    payload.parentTurnKey = out.parentTurnKey
  }
  if (typeof out.parentSessionId === "string" && out.parentSessionId.length > 0) {
    payload.parentSessionId = out.parentSessionId
  }
  if (typeof out.delegateAgentId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(out.delegateAgentId)) {
    payload.delegateAgentId = out.delegateAgentId
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
 * 可以并存。v3 broker may run the underlying turn as channel "webchat" so the
 * realtime process link can attach to normal WebSocket/ring machinery; this
 * adapter is still the explicit opt-in that mirrors selected frames to WeChat.
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
      let payload: V3WechatOutboundPostPayload
      if (isCodexBillingFrame(maybeBilling)) {
        if (maybeBilling.channel !== "wechat" && maybeBilling.channel !== "webchat") return
        const built = buildCodexBillingPayload(maybeBilling)
        if ("error" in built) {
          throw new Error(`cannot durably stage codex billing frame: ${built.error}`)
        }
        payload = built
      } else {
        if (out.channel !== "wechat" && out.channel !== "webchat") return
        const built = buildWirePayload(out, cfg, now())
        if ("error" in built) {
          throw new Error(`cannot durably stage WeChat output: ${built.error}`)
        }
        payload = built
      }

      // Write + fsync + directory-fsync before the first network attempt. The
      // queue's kick performs delivery and removes the file only after a 2xx
      // ACK (or explicit 410 owner deletion); all other failures remain forever.
      const entry: V3WechatRetryEntry = {
        schemaVersion: 1,
        payload,
        firstSeenAt: now(),
        attempts: 0,
      }
      await retryQueue.enqueueDurable(entry)
    },

    async shutdown() {
      // Codex slice 7c plan v3 reminder #2:只停周期 drain,send() 仍可 enqueue
      retryQueue.stopPeriodic()
      if (ctx) ctx.log.info("[v3-wechat-outbound] adapter shutdown (drain stopped, enqueue still active)")
    },
  }
  return adapter
}
