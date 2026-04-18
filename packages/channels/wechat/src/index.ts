// @openclaude/channel-wechat — WeChat (iLink) channel adapter.
//
// iLink (ilinkai.weixin.qq.com) is Tencent's official long-poll bot protocol.
// Unlike 企业微信 (which was the old stub here), iLink lets any personal
// WeChat account register as a bot by scanning a QR code, and exposes a
// simple long-poll API — no domain filing, no callback URL, no corp ID.
//
// Multi-tenant: every OpenClaude user can bind their own WeChat bot. The
// manager fans out N long-poll workers from a single ChannelAdapter.
//
// Entrypoints:
//   - wechatChannelFactory(cfg)              → ChannelAdapter (used by gateway)
//   - startPairing() / resumePairing(key)    → QR scan flow (used by Web UI)

export type { WechatChannelConfig } from './manager.js'
export { wechatChannelFactory } from './manager.js'
export * from './pairing.js'

// Re-export storage types for convenience in callers
export type { WechatBinding } from '@openclaude/storage'
