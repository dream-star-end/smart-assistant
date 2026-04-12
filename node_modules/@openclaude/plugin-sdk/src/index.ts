import type { InboundFrame, OutboundMessage } from '@openclaude/protocol'

// 渠道适配器接口。Gateway 在启动时实例化每个 enabled 的 channel,并注入 ChannelContext。
export interface ChannelAdapter {
  readonly name: string
  init(ctx: ChannelContext): Promise<void>
  send(out: OutboundMessage): Promise<void>
  shutdown(): Promise<void>
}

export interface ChannelContext {
  // 渠道接到入站消息时调用
  dispatch(frame: InboundFrame): void
  // 日志
  log: { info: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void }
  // 配置(从 ~/.openclaude/openclaude.json + credentials 读)
  config: Record<string, unknown>
}

// Channel 工厂签名:gateway plugins.ts 通过它构造 adapter
export type ChannelFactory = (channelConfig: unknown) => ChannelAdapter
