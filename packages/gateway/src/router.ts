import type { InboundMessage, Peer } from '@openclaude/protocol'
import { deriveSessionKey } from '@openclaude/protocol'
import type { AgentDef, AgentsConfig, RouteRule } from '@openclaude/storage'

export interface RouteResult {
  sessionKey: string
  agent: AgentDef
}

export class Router {
  constructor(private agentsConfig: AgentsConfig) {}

  reload(cfg: AgentsConfig): void {
    this.agentsConfig = cfg
  }

  route(msg: InboundMessage): RouteResult {
    const matched = this.matchRule(msg.channel, msg.peer)
    const agentId = matched?.agent ?? this.agentsConfig.default
    const agent = this.agentsConfig.agents.find((a) => a.id === agentId) ?? { id: agentId }
    const sessionKey = deriveSessionKey({ agentId, channel: msg.channel, peer: msg.peer })
    return { sessionKey, agent }
  }

  private matchRule(channel: string, peer: Peer): RouteRule | undefined {
    for (const rule of this.agentsConfig.routes) {
      if (rule.match.channel && rule.match.channel !== channel) continue
      if (rule.match.peerKind && rule.match.peerKind !== peer.kind) continue
      if (rule.match.peerIdPattern) {
        const re = new RegExp(rule.match.peerIdPattern)
        if (!re.test(peer.id)) continue
      }
      return rule
    }
    return undefined
  }
}
