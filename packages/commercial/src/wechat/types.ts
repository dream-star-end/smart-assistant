/**
 * v3 commercial WeChat broker — 共享类型与命名空间约定。
 *
 * 详见 docs/v3/wechat-broker-design.md。
 *
 * **SessionId 命名空间 `wsess-[0-9a-f]{16}`**
 *   broker-owned client_sessions 行用这个前缀标识。WECHAT_SESSION_ID_REGEX 是
 *   namespace shape 的权威源。slice 7a 起 client_sessions 同时多了 `origin_channel`
 *   列(`NULL` = legacy/webchat;`'wechat'` = broker-authored);reconcile/orphan
 *   检测合并使用 GLOB(shape)+ origin_channel='wechat'(channel tag),让 dispatcher
 *   合同显式化、避免与 webchat 行误交叉。
 *
 * **IlinkPart**
 *   P1 仅文本 (`type: 'text'`);P2 加图片/语音/媒体时扩 union member。worker drain
 *   时手工 validate 取出的 JSONB payload shape — 不在 SQL 层做 CHECK(JSONB 内部结构
 *   不应让 DB 来保。rendererPipeline 产出的 IlinkPart[] 类型即合同)。
 */

export type BindingId = string
export type WechatSessionId = string

/** broker-owned session id 正则;16 hex = 64 bits 熵,单进程无碰撞担忧。 */
export const WECHAT_SESSION_ID_REGEX = /^wsess-[0-9a-f]{16}$/

export function isWechatSessionId(s: string): s is WechatSessionId {
  return WECHAT_SESSION_ID_REGEX.test(s)
}

/** Outbox 行状态机;详见 migrations/0066_wechat_pointer_outbox_audit.sql 表头注释。 */
export type OutboxStatus = "queued" | "sending" | "sent" | "failed"

/** P1 仅支持文本;P2 union 扩展。 */
export interface IlinkTextPart {
  type: "text"
  text: string
}

export type IlinkPart = IlinkTextPart

/**
 * Outbox 行的 TS 视图。
 *
 * 列对应 wechat_outbox。`payload` 反序列化后是 IlinkPart[];注意 DB 列就是 JSONB,
 * pg driver 已自动 parse,这里不要再 JSON.parse。
 */
export interface OutboxRow {
  id: number
  outboundId: string
  bindingUserId: BindingId
  senderId: string
  sessionId: WechatSessionId
  payload: IlinkPart[]
  status: OutboxStatus
  attempts: number
  lastError: string | null
  lockedAt: number | null
  sentAt: number | null
  createdAt: number
  updatedAt: number
}

/**
 * Audit 行的 TS 视图。
 *
 * `rawPayload` 是完整 iLink 入站事件,故障复盘用;不约束 shape。
 */
export interface AuditRow {
  id: number
  bindingUserId: BindingId
  accountId: string
  senderId: string | null
  messageId: string | null
  itemTypes: string
  rawPayload: unknown
  receivedAt: number
}
