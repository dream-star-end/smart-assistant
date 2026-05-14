/**
 * v3 commercial WeChat broker — outbox SendTextFn 实装(iLink HTTP)。
 *
 * 详见 docs/v3/wechat-broker-design.md §4.6 + outboxWorker.ts:42 (SendTextFn interface)。
 *
 * **职责**:把 broker outboxWorker 的 `SendTextFn` 抽象坐实为 `sendIlinkText` 调用 +
 * 错误分类。
 *
 * **永不 throw**:outboxWorker.drainOne 期望 sendText 永远返回 `SendResult`,异常被 caller
 * 视为 unrecoverable bug。本 adapter 必须 catch 所有底层 throw 并翻译成 ok=false。
 *
 * **错误分类**(决定 outbox 是 retry 还是 force-fail):
 *   - `iLink HTTP 401|403|404|410` → permanent:true(认证 / 路由 / 已废弃,retry 无意义)
 *   - `iLink HTTP 5xx` / `iLink returned non-JSON` / 任何其他 throw → permanent:false(transient,
 *     outbox 按 attempts cap 重试)
 *
 * iLink 上游(`@openclaude/channel-wechat` iLink.ts)在 `resp.ok === false` 已经 throw 出统一格式
 * `iLink HTTP <status>: <truncated body>`,在 JSON parse 失败时 throw `iLink returned non-JSON: ...`,
 * 所以本 adapter 只需要按这两类前缀识别就够了。
 *
 * **不处理 200+errno 的 iLink 业务码**:iLink 接口当前在 200 + errno!=0 时 ilinkRequest 已经放行
 * (`resp.ok` 是 HTTP-level)。这是 P1 已知留白 — `errno` 业务码语义不稳定(iLink 文档不全),
 * 暂按 success 处理,等 iLink 行为有定论再加一层映射。
 */

import { sendIlinkText } from "@openclaude/channel-wechat"

import { rootLogger, type Logger } from "../logging/logger.js"
import type { SendResult, SendTextFn } from "./outboxWorker.js"

/** "iLink HTTP NNN: ..." 前缀解析正则。NNN 是 3 位 status。 */
const ILINK_HTTP_PREFIX = /^iLink HTTP (\d{3})\b/

/** permanent error HTTP status 名单。命中 → SendResult.permanent=true。 */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 410])

export type SendIlinkTextFn = (
  botToken: string,
  toUserId: string,
  contextToken: string,
  text: string,
) => Promise<unknown>

export interface MakeIlinkSendAdapterOptions {
  /** sendIlinkText 注入点(默认 `@openclaude/channel-wechat` 的实现;测试注入 mock)。 */
  sendIlinkText?: SendIlinkTextFn
  logger?: Logger
}

/** 暴露错误分类便于上层(broker / 测试)读取语义。 */
export function classifyIlinkError(err: unknown): {
  permanent: boolean
  errMessage: string
} {
  const errMessage = (err as Error)?.message ?? String(err)
  const m = ILINK_HTTP_PREFIX.exec(errMessage)
  if (m) {
    const status = Number(m[1])
    if (PERMANENT_STATUSES.has(status)) return { permanent: true, errMessage }
    // 5xx + 其他 4xx 都按 transient 处理(429 / 400 等会被 outbox attempts cap 兜底)
    return { permanent: false, errMessage }
  }
  // 非 iLink HTTP 前缀的错(non-JSON / network / unknown)按 transient
  return { permanent: false, errMessage }
}

/**
 * 构造 SendTextFn。一次实例,broker 全生命周期复用。
 */
export function makeIlinkSendAdapter(opts: MakeIlinkSendAdapterOptions = {}): SendTextFn {
  const log = (opts.logger ?? rootLogger).child({ subsys: "wechatIlinkSendAdapter" })
  const send = opts.sendIlinkText ?? sendIlinkText

  return async (params: {
    botToken: string
    toUserId: string
    contextToken: string
    text: string
  }): Promise<SendResult> => {
    try {
      await send(params.botToken, params.toUserId, params.contextToken, params.text)
      return { ok: true }
    } catch (err) {
      const { permanent, errMessage } = classifyIlinkError(err)
      log.warn("ilink_send_failed", {
        toUserId: params.toUserId,
        permanent,
        errMessage,
      })
      return { ok: false, permanent, errMessage }
    }
  }
}
