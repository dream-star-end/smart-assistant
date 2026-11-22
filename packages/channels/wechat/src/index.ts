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
export {
  cancelPairing,
  resumePairing,
  startPairing,
  type PairingStart,
  type PairStatus,
} from './pairing.js'
// iLink low-level API — explicitly re-exported so cross-package consumers
// (commercial admin alert worker & WeChat adapters) go through the package
// boundary instead of deep relative paths. Required by S12a & R2 guardrails.
export {
  extractConfirmed,
  extractIlinkText,
  fetchIlinkQrcode,
  getIlinkUpdates,
  ILINK_API_TIMEOUT_MS,
  ILINK_BASE_URL,
  ILINK_BOT_TYPE,
  ILINK_CDN_BASE_URL,
  ILINK_CDN_UPLOAD_MAX_BYTES,
  ILINK_CDN_UPLOAD_TIMEOUT_MS,
  ILINK_LONG_POLL_TIMEOUT_MS,
  ILINK_SESSION_EXPIRED,
  ilinkRequest,
  pollIlinkQrcodeStatus,
  sendIlinkMedia,
  sendIlinkText,
  type IlinkConfirmed,
  type IlinkMediaKind,
  type IlinkQrcode,
  type IlinkSendMediaInput,
  type IlinkSendTextOptions,
} from './iLink.js'
export {
  decryptIlinkImageBuffer,
  detectRasterImage,
  extractIlinkImageAttachments,
  WECHAT_IMAGE_MAX_ATTACHMENTS,
  WECHAT_IMAGE_MAX_BYTES,
  type DecryptedWechatImage,
  type RasterImageExtension,
  type WechatImageAttachment,
} from './iLinkImage.js'
export {
  decryptIlinkMediaBuffer,
  extractIlinkImageAttachmentsCompat,
  extractIlinkMediaAttachments,
  legacyIlinkDownloadUrl,
  sanitizeWechatFilename,
  WECHAT_MEDIA_MAX_ATTACHMENTS,
  WECHAT_MEDIA_MAX_BYTES,
  type DecryptedWechatMedia,
  type WechatMediaAttachment,
  type WechatMediaKind,
} from './iLinkMedia.js'

// Re-export storage types for convenience in callers
export type { WechatBinding } from '@openclaude/storage'
