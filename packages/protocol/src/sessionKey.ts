// sessionKey 派生与解析。Trust boundary 编码进 key,为后续沙箱铺路。
//   agent:<agentId>:main                              # 主会话(本机操作)
//   agent:<agentId>:<channel>:dm:<peerId>             # 私聊
//   agent:<agentId>:<channel>:group:<peerId>          # 群组
//   agent:<agentId>:taskboard:<ticketId>:<stageId>:<runId>  # 巡检

export type SessionKey = string

/**
 * engine-reported delegate billing 专用 sessionKey 长度上限，不是全局
 * sessionKey 契约。prompt_queue VARCHAR(512) 只是 PG 列宽，不能当 admit 上限：
 * `paths.sessionLog` 把 sessionKey 只替换 `:/` 后写成 `${key}.jsonl`，Linux
 * NAME_MAX=255，减去 `.jsonl`(6) 再留 9 字符余量 = 240。覆盖 taskboard 合法
 * 最坏约 207 与 mintDelegateSessionKey 约 175。
 */
export const DELEGATE_ENGINE_BILLING_SESSION_KEY_MAX_CHARS = 240

/**
 * engine-reported delegate billing 的 sessionKey 白名单。
 * 字符集沿用 2026-09-02 的 `[A-Za-z0-9_:@.-]`；长度从 128 抬到
 * DELEGATE_ENGINE_BILLING_SESSION_KEY_MAX_CHARS。gateway 与 commercial
 * runtime 必须共用本常量。
 */
export const DELEGATE_ENGINE_BILLING_SESSION_KEY_RE = new RegExp(
  `^[A-Za-z0-9_:@.-]{1,${DELEGATE_ENGINE_BILLING_SESSION_KEY_MAX_CHARS}}$`,
)

export interface ParsedSessionKey {
  agentId: string
  scope: 'main' | 'dm' | 'group'
  channel?: string
  peerId?: string
}

export function deriveSessionKey(params: {
  agentId: string
  channel?: string
  peer?: { id: string; kind: 'dm' | 'group' }
}): SessionKey {
  const { agentId, channel, peer } = params
  if (!channel || !peer) return `agent:${agentId}:main`
  return `agent:${agentId}:${channel}:${peer.kind}:${sanitize(peer.id)}`
}

export function parseSessionKey(key: SessionKey): ParsedSessionKey {
  const parts = key.split(':')
  if (parts[0] !== 'agent' || parts.length < 3) {
    throw new Error(`invalid sessionKey: ${key}`)
  }
  const agentId = parts[1]
  if (parts[2] === 'main' && parts.length === 3) {
    return { agentId, scope: 'main' }
  }
  if (parts.length >= 5 && (parts[3] === 'dm' || parts[3] === 'group')) {
    return {
      agentId,
      scope: parts[3] as 'dm' | 'group',
      channel: parts[2],
      peerId: parts.slice(4).join(':'),
    }
  }
  throw new Error(`invalid sessionKey: ${key}`)
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}
