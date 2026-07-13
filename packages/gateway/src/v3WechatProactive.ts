// 容器 → master「主动微信投递」client。
//
// 用于 cron/提醒等**无入站触发**的主动消息:容器把文本交给 master,master 凭容器身份
// 权威解析收件人(senderId = binding.loginUserId)并 enqueue outbox。容器侧零微信状态:
// 不知道也不指定 senderId/wsess(对比 v3WechatOutbound 服务"回复入站",收件人由容器带回)。
//
// 与 v3WechatOutbound 的关键差异:本 client **必须读 master 返回的 outcome** —— 它决定
// 容器是否要把同一条消息回退到 web 以及是否标注"微信未送达"。v3WechatOutbound 是
// fire-and-forget(只入 retry queue,不读 body)。
//
// 配置复用 readV3WechatOutboundConfig(同 OPENCLAUDE_V3_MASTER_BASE_URL +
// OPENCLAUDE_V3_CONTAINER_TOKEN);两 env 缺 → 个人/dev/master 不启用,调用方应跳过。

import { request as undiciRequest } from "undici"

import {
  readV3WechatOutboundConfig,
  type V3WechatOutboundConfig,
} from "./v3WechatOutbound.js"

/** 容器侧路径常量,必须与 master proactiveReceiver.WECHAT_PROACTIVE_PATH 对齐。 */
export const WECHAT_PROACTIVE_PATH = "/internal/v3/wechat-proactive"

const ATTEMPT_TIMEOUT_MS = 10_000
const MAX_RESP_BYTES = 16 * 1024

/** 复用 outbound 的 env 配置(同 master baseUrl + 容器 bearer)。 */
export function readV3WechatProactiveConfig(
  env: NodeJS.ProcessEnv = process.env,
): V3WechatOutboundConfig | null {
  return readV3WechatOutboundConfig(env)
}

export interface SendProactiveArgs {
  config: V3WechatOutboundConfig
  /** 主动推送纯文本。 */
  text: string
  /** 幂等键(outbox UNIQUE);调用方按 jobId+fireTs 派生。 */
  outboundId: string
  traceId?: string
  /** Override only for tests。 */
  fetcher?: typeof undiciRequest
  /** Override only for tests。 */
  timeoutMs?: number
}

/**
 * 主动投递结果 —— 已抽象成容器决策语义,onDeliver 无需感知 master outcome 字符串:
 *   - delivered           : 微信已接管(queued / already_sent / pending),勿重复 web。
 *   - fallback{marked:true}: 绑了微信但会话过期/未入站过(no_context_token / no_session),
 *                            回退 web 并标注"微信未送达,发条微信可恢复"。
 *   - fallback{marked:false}: 其它(未绑微信 / 关了偏好 / 渲染空 / 永久失败 / 网络/装配错误),
 *                            正常 web,不标注(对用户无意义)。
 */
export type ProactiveDeliveryResult =
  | { kind: "delivered" }
  | { kind: "fallback"; marked: boolean }

/** master outcome → 容器决策。未知 outcome 保守按 fallback 不标注。 */
function classifyOutcome(outcome: string): ProactiveDeliveryResult {
  switch (outcome) {
    case "queued":
    case "already_sent":
    case "pending":
      return { kind: "delivered" }
    case "no_context_token":
    case "no_session":
      return { kind: "fallback", marked: true }
    case "pref_off":
    case "no_binding":
    case "empty_render":
    default:
      return { kind: "fallback", marked: false }
  }
}

/**
 * 单次 best-effort POST。任何网络/HTTP 错误 → fallback{marked:false}(回退 web 不标注:
 * 配置/网络问题不是用户会话问题,标注会误导)。永不抛 —— 主动投递不该阻断 cron web 投递。
 */
export async function sendV3WechatProactive(
  args: SendProactiveArgs,
): Promise<ProactiveDeliveryResult> {
  const url = `${args.config.baseUrl}${WECHAT_PROACTIVE_PATH}`
  const fetcher = args.fetcher ?? undiciRequest
  const timeoutMs = args.timeoutMs ?? ATTEMPT_TIMEOUT_MS
  const body = JSON.stringify({
    text: args.text,
    outboundId: args.outboundId,
    ...(args.config.agentId ? { agentId: args.config.agentId } : {}),
    ...(args.traceId ? { traceId: args.traceId } : {}),
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${args.config.bearer}`,
      },
      body,
      signal: controller.signal,
    })
    let respText = ""
    try {
      let total = 0
      const chunks: Buffer[] = []
      for await (const chunk of res.body) {
        const b =
          chunk instanceof Buffer
            ? chunk
            : typeof chunk === "string"
              ? Buffer.from(chunk, "utf8")
              : Buffer.from(chunk)
        total += b.length
        if (total > MAX_RESP_BYTES) break
        chunks.push(b)
      }
      respText = Buffer.concat(chunks, Math.min(total, MAX_RESP_BYTES)).toString("utf8")
    } catch {
      // drain 失败 → 按网络错误回退
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { kind: "fallback", marked: false }
    }
    try {
      const parsed = JSON.parse(respText) as { outcome?: string }
      if (parsed && typeof parsed.outcome === "string") {
        return classifyOutcome(parsed.outcome)
      }
    } catch {
      // 非法 JSON → fallback
    }
    return { kind: "fallback", marked: false }
  } catch {
    // 网络 / DNS / TCP / TLS / abort → 回退 web 不标注
    return { kind: "fallback", marked: false }
  } finally {
    clearTimeout(timer)
  }
}
