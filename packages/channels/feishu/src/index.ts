import type { ChannelAdapter, ChannelContext } from '@openclaude/plugin-sdk'
import type { OutboundMessage } from '@openclaude/protocol'

// 飞书事件订阅适配器(stub)
//
// 入站:飞书开放平台 webhook → gateway HTTP 端点 → ctx.dispatch
// 出站:POST /open-apis/im/v1/messages
//
// MVP stub:仅占位

export interface FeishuConfig {
  appId: string
  appSecret: string
  verificationToken: string
  encryptKey?: string
}

export function feishuChannelFactory(_cfg: FeishuConfig): ChannelAdapter {
  let ctx: ChannelContext | null = null
  return {
    id: 'feishu',
    name: 'feishu',
    type: 'channel' as const,
    async init(c) {
      ctx = c
      c.log.info('feishu channel stub initialized (TODO: implement)')
    },
    async send(_out: OutboundMessage) {
      ctx?.log.info('feishu send (stub, no-op)')
    },
    async shutdown() {},
  }
}
