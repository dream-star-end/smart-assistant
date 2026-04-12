// sessionKey 派生与解析。Trust boundary 编码进 key,为后续沙箱铺路。
//   agent:<agentId>:main                              # 主会话(本机操作)
//   agent:<agentId>:<channel>:dm:<peerId>             # 私聊
//   agent:<agentId>:<channel>:group:<peerId>          # 群组

export type SessionKey = string

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
