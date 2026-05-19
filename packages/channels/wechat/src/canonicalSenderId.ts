// senderId 在 iLink wire 与系统 canonical 形态间的双向转换。
//
// iLink server 把用户 openid 以 "<base64url>@im.wechat" 形态出现在
// `from_user_id` / `to_user_id` 字段中(实证)。系统内部所有上游
// (broker / dispatcher / outbox / v3WechatOutbound) 按 base64url 字符集
// 校验 senderId (SENDER_ID_RE = /^[A-Za-z0-9_-]{1,256}$/)，所以
// 在 channels/wechat 包边界做两端归一:
//
//   入站:WechatWorker 收到 raw `from_user_id` → canonicalSenderId() 剥后缀
//   出站:sendIlinkText 调用前 → toIlinkUserId() 拼回后缀
//
// 只针对 `@im.wechat` 这一种后缀。`@im.bot` (bot 自身 accountId)、
// 未来可能的 `@im.group` 等不在 senderId 语义内,不动。

const IM_WECHAT_SUFFIX = '@im.wechat'

/**
 * iLink wire 形态 → canonical base64url。
 *
 * - "abc@im.wechat" → "abc"
 * - "abc"          → "abc"  (已 canonical,幂等)
 * - "abc@im.bot"   → "abc@im.bot"  (非 @im.wechat 后缀,不剥;仍会被上游
 *   SENDER_ID_RE 拒绝,但那是上游决定的事,本函数只负责单一规则)
 * - ""             → ""
 */
export function canonicalSenderId(raw: string): string {
  if (raw.endsWith(IM_WECHAT_SUFFIX)) {
    return raw.slice(0, -IM_WECHAT_SUFFIX.length)
  }
  return raw
}

/**
 * canonical base64url → iLink wire 形态。
 *
 * - "abc"          → "abc@im.wechat"
 * - "abc@im.wechat" → "abc@im.wechat"  (已 wire,幂等)
 * - ""             → ""  (不拼空串)
 */
export function toIlinkUserId(canonical: string): string {
  if (canonical === '') return ''
  if (canonical.endsWith(IM_WECHAT_SUFFIX)) return canonical
  return canonical + IM_WECHAT_SUFFIX
}
