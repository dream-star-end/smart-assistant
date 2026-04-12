import type { ChannelAdapter, ChannelContext } from '@openclaude/plugin-sdk'
import type { OutboundMessage } from '@openclaude/protocol'

// 企业微信适配器(stub)
//
// 使用官方"自建应用"API:
//   - 入站:回调 URL(需要 gateway 暴露 HTTP 接收 webhook 事件)
//   - 出站:POST https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=xxx
//
// MVP stub:仅占位

export interface WeChatConfig {
  corpId: string
  corpSecret: string
  agentId: string
  token: string // 回调验签
  encodingAESKey: string
}

export function wechatChannelFactory(_cfg: WeChatConfig): ChannelAdapter {
  let ctx: ChannelContext | null = null
  return {
    name: 'wechat',
    async init(c) {
      ctx = c
      c.log.info('wechat channel stub initialized (TODO: implement)')
    },
    async send(_out: OutboundMessage) {
      ctx?.log.info('wechat send (stub, no-op)')
    },
    async shutdown() {},
  }
}
