import { createDecipheriv } from 'node:crypto'

import { ILINK_BASE_URL } from './iLink.js'

export const WECHAT_IMAGE_MAX_ATTACHMENTS = 5
export const WECHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024

export type RasterImageExtension = 'png' | 'jpg' | 'gif' | 'webp'

export interface WechatImageAttachment {
  fullUrl: string
  aesKeyHex: string
  msgId?: string
  midSize?: number
  thumbSize?: number
  thumbWidth?: number
  thumbHeight?: number
}

export interface DecryptedWechatImage {
  buffer: Buffer
  ext: RasterImageExtension
  mimeType: string
}

const HEX_AES_KEY_RE = /^[0-9a-fA-F]{32}$/

export function extractIlinkImageAttachments(raw: unknown): WechatImageAttachment[] {
  const items = Array.isArray((raw as any)?.item_list) ? (raw as any).item_list : []
  const out: WechatImageAttachment[] = []
  for (const item of items) {
    if (out.length >= WECHAT_IMAGE_MAX_ATTACHMENTS) break
    if (Number((item as any)?.type) !== 2) continue
    const image = (item as any)?.image_item
    if (!image || typeof image !== 'object') continue
    const media = image.media && typeof image.media === 'object' ? image.media : {}
    const fullUrl = extractIlinkImageUrl(media)
    const aesKeyHex = extractIlinkImageAesKeyHex(image, media)
    if (!fullUrl || !aesKeyHex) continue
    out.push({
      fullUrl,
      aesKeyHex,
      msgId: optionalString(image.msg_id),
      midSize: optionalPositiveNumber(image.mid_size),
      thumbSize: optionalPositiveNumber(image.thumb_size),
      thumbWidth: optionalPositiveNumber(image.thumb_width),
      thumbHeight: optionalPositiveNumber(image.thumb_height),
    })
  }
  return out
}

function extractIlinkImageUrl(media: any): string | null {
  const direct = optionalString(media.full_url)
  if (direct) return direct
  const encryptedQuery = optionalString(media.encrypt_query_param)
  if (!encryptedQuery) return null
  return `${ILINK_BASE_URL}/c2c/download?encrypted_query_param=${encodeURIComponent(encryptedQuery)}`
}

function extractIlinkImageAesKeyHex(image: any, media: any): string | null {
  const direct = normalizeAesKeyHex(optionalString(image.aeskey))
  if (direct) return direct

  const encoded = optionalString(media.aes_key)
  if (!encoded) return null
  try {
    const decoded = Buffer.from(encoded, 'base64')
    const asText = decoded.toString('utf8').trim()
    const textHex = normalizeAesKeyHex(asText)
    if (textHex) return textHex
    if (decoded.length === 16) return decoded.toString('hex')
  } catch {
    return null
  }
  return null
}

function normalizeAesKeyHex(input: string | null): string | null {
  if (!input || !HEX_AES_KEY_RE.test(input)) return null
  return input.toLowerCase()
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function optionalPositiveNumber(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function decryptIlinkImageBuffer(
  encrypted: Buffer,
  aesKeyHex: string,
): DecryptedWechatImage {
  const normalizedKey = normalizeAesKeyHex(aesKeyHex)
  if (!normalizedKey) throw new Error('invalid WeChat image aes key')
  if (encrypted.length <= 0) throw new Error('empty encrypted WeChat image')
  if (encrypted.length > WECHAT_IMAGE_MAX_BYTES) {
    throw new Error('encrypted WeChat image exceeds size limit')
  }

  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(normalizedKey, 'hex'), null)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (decrypted.length <= 0) throw new Error('empty decrypted WeChat image')
  if (decrypted.length > WECHAT_IMAGE_MAX_BYTES) {
    throw new Error('decrypted WeChat image exceeds size limit')
  }
  const detected = detectRasterImage(decrypted)
  if (!detected) throw new Error('decrypted WeChat image is not a supported raster image')
  return { buffer: decrypted, ext: detected.ext, mimeType: detected.mimeType }
}

export function detectRasterImage(
  buf: Buffer,
): { ext: RasterImageExtension; mimeType: string } | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { ext: 'png', mimeType: 'image/png' }
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mimeType: 'image/jpeg' }
  }
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString('ascii')
    if (sig === 'GIF87a' || sig === 'GIF89a') return { ext: 'gif', mimeType: 'image/gif' }
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', mimeType: 'image/webp' }
  }
  return null
}
