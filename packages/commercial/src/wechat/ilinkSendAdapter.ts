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
 * **处理 200+业务失败码**:iLink.ts 的 ilinkRequest 只检查 HTTP status / JSON parse。
 * 如果 HTTP 200 但 body 里有 `errno/errcode/error_code != 0` 或明确失败 status,
 * adapter 必须返回 ok=false,否则 outbox 会把实际未送达消息标记为 sent。
 */

import { sendIlinkMedia, sendIlinkText } from "../../../channels/wechat/src/iLink.js"

import { rootLogger, type Logger } from "../logging/logger.js"
import type { SendMediaFn, SendResult, SendTextFn } from "./outboxWorker.js"

/** "iLink HTTP NNN: ..." 前缀解析正则。NNN 是 3 位 status。 */
const ILINK_HTTP_PREFIX = /^iLink HTTP (\d{3})\b/

/** permanent error HTTP status 名单。命中 → SendResult.permanent=true。 */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 410])

const STRICT_NUMERIC_BUSINESS_FIELDS = ["errno", "errcode", "error_code", "ret"] as const
const LENIENT_NUMERIC_BUSINESS_FIELDS = ["code"] as const
const STATUS_BUSINESS_FIELDS = ["status", "result", "state"] as const
const FAILURE_VALUE_STRINGS = new Set(["error", "failed", "fail", "failure"])
const MESSAGE_FIELDS = ["errmsg", "err_msg", "message", "msg", "error", "error_msg", "reason"] as const
const STRONG_ERROR_MESSAGE_FIELDS = ["errmsg", "err_msg", "error", "error_msg", "reason"] as const

export type SendIlinkTextFn = (
  botToken: string,
  toUserId: string,
  contextToken: string,
  text: string,
  opts?: { clientId?: string },
) => Promise<unknown>

export type SendIlinkMediaFn = typeof sendIlinkMedia

export interface MakeIlinkSendAdapterOptions {
  /** sendIlinkText 注入点(默认 `@openclaude/channel-wechat` 的实现;测试注入 mock)。 */
  sendIlinkText?: SendIlinkTextFn
  sendIlinkMedia?: SendIlinkMediaFn
  logger?: Logger
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fieldNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const s = value.trim()
    if (/^[+-]?\d+$/.test(s)) return Number(s)
  }
  return null
}

function fieldString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const s = value.trim().toLowerCase()
  return s.length > 0 ? s : null
}

function findErrorMessage(body: Record<string, unknown>, fallback: string): string {
  for (const field of MESSAGE_FIELDS) {
    const value = body[field]
    if (typeof value === "string" && value.trim().length > 0) return value.trim()
  }
  return fallback
}

function hasFailureStatus(body: Record<string, unknown>): boolean {
  for (const field of STATUS_BUSINESS_FIELDS) {
    const value = fieldString(body[field])
    if (value && FAILURE_VALUE_STRINGS.has(value)) return true
  }
  return false
}

function hasStrongErrorMessage(body: Record<string, unknown>): boolean {
  for (const field of STRONG_ERROR_MESSAGE_FIELDS) {
    const value = body[field]
    if (typeof value === "string" && value.trim().length > 0) return true
  }
  return false
}

export function classifyIlinkBusinessAck(body: unknown): SendResult & {
  reasonField?: string
  reasonValue?: unknown
} {
  // Backward compatibility: old/mocked implementations may return undefined or
  // bodies without explicit business fields. Only explicit top-level envelope
  // failures are retried.
  if (!isRecord(body)) return { ok: true }

  for (const field of STRICT_NUMERIC_BUSINESS_FIELDS) {
    if (!(field in body)) continue
    const n = fieldNumber(body[field])
    if (n !== null && n !== 0) {
      return {
        ok: false,
        permanent: false,
        errMessage: findErrorMessage(body, `iLink business error: ${field}=${String(body[field])}`),
        reasonField: field,
        reasonValue: body[field],
      }
    }
  }

  for (const field of LENIENT_NUMERIC_BUSINESS_FIELDS) {
    if (!(field in body)) continue
    const n = fieldNumber(body[field])
    if (n !== null && n !== 0 && (hasFailureStatus(body) || hasStrongErrorMessage(body))) {
      return {
        ok: false,
        permanent: false,
        errMessage: findErrorMessage(body, `iLink business error: ${field}=${String(body[field])}`),
        reasonField: field,
        reasonValue: body[field],
      }
    }
  }

  if (hasFailureStatus(body)) {
    for (const field of STATUS_BUSINESS_FIELDS) {
      const value = fieldString(body[field])
      if (value && FAILURE_VALUE_STRINGS.has(value)) {
        return {
          ok: false,
          permanent: false,
          errMessage: findErrorMessage(body, `iLink business error: ${field}=${value}`),
          reasonField: field,
          reasonValue: body[field],
        }
      }
    }
  }

  return { ok: true }
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
    clientId?: string
  }): Promise<SendResult> => {
    try {
      const body = await send(params.botToken, params.toUserId, params.contextToken, params.text, {
        clientId: params.clientId,
      })
      const ack = classifyIlinkBusinessAck(body)
      if (!ack.ok) {
        log.warn("ilink_send_business_failed", {
          toUserId: params.toUserId,
          permanent: ack.permanent,
          errMessage: ack.errMessage,
          reasonField: ack.reasonField,
          reasonValue: ack.reasonValue,
          responseKeys: isRecord(body) ? Object.keys(body).slice(0, 20) : [],
        })
      }
      return ack
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

export function makeIlinkSendMediaAdapter(opts: MakeIlinkSendAdapterOptions = {}): SendMediaFn {
  const log = (opts.logger ?? rootLogger).child({ subsys: "wechatIlinkSendAdapter" })
  const send = opts.sendIlinkMedia ?? sendIlinkMedia

  return async (params): Promise<SendResult> => {
    try {
      const body = await send(params.botToken, params.toUserId, {
        kind: params.media.kind,
        filename: params.media.filename,
        content: params.media.content,
        mimeType: params.media.mimeType,
        contextToken: params.contextToken,
        clientId: params.clientId,
        captionClientId: params.captionClientId,
      })
      const ack = classifyIlinkBusinessAck(body)
      if (!ack.ok) {
        log.warn("ilink_send_media_business_failed", {
          toUserId: params.toUserId,
          kind: params.media.kind,
          permanent: ack.permanent,
          errMessage: ack.errMessage,
          reasonField: ack.reasonField,
          reasonValue: ack.reasonValue,
          responseKeys: isRecord(body) ? Object.keys(body).slice(0, 20) : [],
        })
      }
      return ack
    } catch (err) {
      const { permanent, errMessage } = classifyIlinkError(err)
      log.warn("ilink_send_media_failed", {
        toUserId: params.toUserId,
        kind: params.media.kind,
        permanent,
        errMessage,
      })
      return { ok: false, permanent, errMessage }
    }
  }
}
