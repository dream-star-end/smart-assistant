import { createDecipheriv } from 'node:crypto'

import { ILINK_BASE_URL, ILINK_CDN_BASE_URL } from './iLink.js'
import {
  WECHAT_IMAGE_MAX_ATTACHMENTS,
  WECHAT_IMAGE_MAX_BYTES,
  detectRasterImage,
  type RasterImageExtension,
  type WechatImageAttachment,
} from './iLinkImage.js'

export type WechatMediaKind = 'image' | 'voice' | 'video' | 'file'

export const WECHAT_MEDIA_MAX_ATTACHMENTS = WECHAT_IMAGE_MAX_ATTACHMENTS
export const WECHAT_MEDIA_MAX_BYTES = 100 * 1024 * 1024

export interface WechatMediaAttachment {
  kind: WechatMediaKind
  fullUrl: string
  aesKeyHex: string
  fileName?: string
  size?: number
  msgId?: string
  mimeType?: string
  voiceText?: string
  voiceEncodeType?: number
  voicePlaytimeMs?: number
  rawType?: number
}

export interface DecryptedWechatMedia {
  kind: WechatMediaKind
  buffer: Buffer
  ext: string
  mimeType: string
  filename: string
}

const HEX_AES_KEY_RE = /^[0-9a-fA-F]{32}$/

export function extractIlinkMediaAttachments(raw: unknown): WechatMediaAttachment[] {
  const items = Array.isArray((raw as any)?.item_list) ? (raw as any).item_list : []
  const out: WechatMediaAttachment[] = []
  for (const item of items) {
    if (out.length >= WECHAT_MEDIA_MAX_ATTACHMENTS) break
    const type = Number((item as any)?.type)
    const att = extractMediaItem(type, item)
    if (att) out.push(att)
  }
  return out
}

export function extractIlinkImageAttachmentsCompat(raw: unknown): WechatImageAttachment[] {
  return extractIlinkMediaAttachments(raw)
    .filter((m) => m.kind === 'image')
    .map((m) => ({
      fullUrl: m.fullUrl,
      aesKeyHex: m.aesKeyHex,
      msgId: m.msgId,
      midSize: m.size,
    }))
}

function extractMediaItem(type: number, item: any): WechatMediaAttachment | null {
  if (type === 2) {
    const image = item?.image_item
    if (!image || typeof image !== 'object') return null
    const media = mediaObject(image.media)
    return buildAttachment('image', type, media, {
      aesKeyHex: extractAesKeyHex(image.aeskey, media.aes_key),
      msgId: optionalString(image.msg_id ?? item?.msg_id),
      size: optionalPositiveNumber(image.mid_size ?? image.hd_size),
      fileName: optionalString(image.file_name) ?? optionalString(image.name),
    })
  }

  if (type === 3) {
    const voice = item?.voice_item
    if (!voice || typeof voice !== 'object') return null
    const media = mediaObject(voice.media)
    return buildAttachment('voice', type, media, {
      aesKeyHex: extractAesKeyHex(undefined, media.aes_key),
      msgId: optionalString(voice.msg_id ?? item?.msg_id),
      size: optionalPositiveNumber(voice.len ?? voice.size),
      fileName: optionalString(voice.file_name) ?? defaultVoiceFilename(voice.encode_type),
      voiceText: optionalString(voice.text),
      voiceEncodeType: optionalPositiveNumber(voice.encode_type),
      voicePlaytimeMs: optionalPositiveNumber(voice.playtime),
    })
  }

  if (type === 4) {
    const file = item?.file_item
    if (!file || typeof file !== 'object') return null
    const media = mediaObject(file.media)
    return buildAttachment('file', type, media, {
      aesKeyHex: extractAesKeyHex(undefined, media.aes_key),
      msgId: optionalString(file.msg_id ?? item?.msg_id),
      size: optionalPositiveNumber(file.len ?? file.size),
      fileName: optionalString(file.file_name) ?? 'wechat-file.bin',
    })
  }

  if (type === 5) {
    const video = item?.video_item
    if (!video || typeof video !== 'object') return null
    const media = mediaObject(video.media)
    return buildAttachment('video', type, media, {
      aesKeyHex: extractAesKeyHex(undefined, media.aes_key),
      msgId: optionalString(video.msg_id ?? item?.msg_id),
      size: optionalPositiveNumber(video.video_size ?? video.len ?? video.size),
      fileName: optionalString(video.file_name) ?? 'wechat-video.mp4',
    })
  }
  return null
}

function buildAttachment(
  kind: WechatMediaKind,
  rawType: number,
  media: Record<string, unknown>,
  fields: Omit<Partial<WechatMediaAttachment>, 'kind' | 'fullUrl' | 'rawType' | 'aesKeyHex'> & {
    aesKeyHex?: string | null
  },
): WechatMediaAttachment | null {
  const fullUrl = extractMediaUrl(media)
  const aesKeyHex = fields.aesKeyHex ?? null
  if (!fullUrl || !aesKeyHex) return null
  return {
    kind,
    rawType,
    fullUrl,
    aesKeyHex,
    fileName: fields.fileName ? sanitizeWechatFilename(fields.fileName) : undefined,
    size: fields.size,
    msgId: fields.msgId,
    voiceText: fields.voiceText,
    voiceEncodeType: fields.voiceEncodeType,
    voicePlaytimeMs: fields.voicePlaytimeMs,
  }
}

function mediaObject(media: unknown): Record<string, unknown> {
  return media && typeof media === 'object' && !Array.isArray(media)
    ? (media as Record<string, unknown>)
    : {}
}

function extractMediaUrl(media: Record<string, unknown>): string | null {
  const direct = optionalString(media.full_url ?? media.url)
  if (direct) return direct
  const encryptedQuery = optionalString(media.encrypt_query_param)
  if (!encryptedQuery) return null
  return `${ILINK_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQuery)}`
}

function extractAesKeyHex(directHex: unknown, encoded: unknown): string | null {
  const direct = normalizeAesKeyHex(optionalString(directHex))
  if (direct) return direct
  const encodedText = optionalString(encoded)
  if (!encodedText) return null
  try {
    const decoded = Buffer.from(encodedText, 'base64')
    if (decoded.length === 16) return decoded.toString('hex')
    const asText = decoded.toString('utf8').trim()
    const textHex = normalizeAesKeyHex(asText)
    if (textHex) return textHex
  } catch {
    return null
  }
  return null
}

function normalizeAesKeyHex(input: string | undefined | null): string | null {
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

function defaultVoiceFilename(encodeType: unknown): string {
  const n = Number(encodeType)
  if (n === 6) return 'wechat-voice.silk'
  if (n === 7) return 'wechat-voice.mp3'
  if (n === 1) return 'wechat-voice.wav'
  if (n === 5) return 'wechat-voice.amr'
  if (n === 8) return 'wechat-voice.ogg'
  return 'wechat-voice.bin'
}

export function decryptIlinkMediaBuffer(
  encrypted: Buffer,
  aesKeyHex: string,
  attachment: Pick<WechatMediaAttachment, 'kind' | 'fileName' | 'voiceEncodeType'>,
): DecryptedWechatMedia {
  const normalizedKey = normalizeAesKeyHex(aesKeyHex)
  if (!normalizedKey) throw new Error('invalid WeChat media aes key')
  if (encrypted.length <= 0) throw new Error('empty encrypted WeChat media')
  if (encrypted.length > WECHAT_MEDIA_MAX_BYTES) {
    throw new Error('encrypted WeChat media exceeds size limit')
  }
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(normalizedKey, 'hex'), null)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (decrypted.length <= 0) throw new Error('empty decrypted WeChat media')
  if (decrypted.length > WECHAT_MEDIA_MAX_BYTES) {
    throw new Error('decrypted WeChat media exceeds size limit')
  }

  const detected = detectMedia(decrypted, attachment)
  const filename = safeFilenameWithExt(attachment.fileName, detected.ext, attachment.kind)
  return {
    kind: attachment.kind,
    buffer: decrypted,
    ext: detected.ext,
    mimeType: detected.mimeType,
    filename,
  }
}

function detectMedia(
  buf: Buffer,
  attachment: Pick<WechatMediaAttachment, 'kind' | 'fileName' | 'voiceEncodeType'>,
): { ext: string; mimeType: string } {
  const image = detectRasterImage(buf)
  if (image) return image
  const magic = detectByMagic(buf)
  if (magic) return magic
  const byName = detectByFilename(attachment.fileName)
  if (byName) return byName
  if (attachment.kind === 'voice') {
    const voice = detectVoiceByEncodeType(attachment.voiceEncodeType)
    if (voice) return voice
  }
  if (attachment.kind === 'video') return { ext: 'mp4', mimeType: 'video/mp4' }
  return { ext: 'bin', mimeType: 'application/octet-stream' }
}

function detectByMagic(buf: Buffer): { ext: string; mimeType: string } | null {
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    return { ext: 'mp4', mimeType: 'video/mp4' }
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') {
    return { ext: 'ogg', mimeType: 'audio/ogg' }
  }
  if (buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'ID3') {
    return { ext: 'mp3', mimeType: 'audio/mpeg' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) {
    return { ext: 'mp3', mimeType: 'audio/mpeg' }
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return { ext: 'wav', mimeType: 'audio/wav' }
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF') {
    return { ext: 'pdf', mimeType: 'application/pdf' }
  }
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return { ext: 'zip', mimeType: 'application/zip' }
  }
  return null
}

function detectByFilename(filename: string | undefined): { ext: string; mimeType: string } | null {
  const ext = safeExt(filename)
  if (!ext) return null
  const imageExts: Record<string, RasterImageExtension> = { jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' }
  if (imageExts[ext]) return { ext: imageExts[ext], mimeType: `image/${imageExts[ext] === 'jpg' ? 'jpeg' : imageExts[ext]}` }
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    silk: 'audio/silk',
    amr: 'audio/amr',
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
  }
  return map[ext] ? { ext, mimeType: map[ext]! } : null
}

function detectVoiceByEncodeType(encodeType: number | undefined): { ext: string; mimeType: string } | null {
  if (encodeType === 6) return { ext: 'silk', mimeType: 'audio/silk' }
  if (encodeType === 7) return { ext: 'mp3', mimeType: 'audio/mpeg' }
  if (encodeType === 1) return { ext: 'wav', mimeType: 'audio/wav' }
  if (encodeType === 5) return { ext: 'amr', mimeType: 'audio/amr' }
  if (encodeType === 8) return { ext: 'ogg', mimeType: 'audio/ogg' }
  return null
}

function safeExt(filename: string | undefined): string {
  const base = sanitizeWechatFilename(filename ?? '')
  const idx = base.lastIndexOf('.')
  if (idx < 0 || idx === base.length - 1) return ''
  return base.slice(idx + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
}

export function sanitizeWechatFilename(input: string): string {
  const base = input.split(/[\\/]/).pop()?.trim() || 'wechat-media'
  const safe = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim()
  const collapsed = safe.replace(/\.+/g, '.').replace(/^\.+/, '')
  return (collapsed || 'wechat-media').slice(0, 120)
}

function safeFilenameWithExt(input: string | undefined, ext: string, kind: WechatMediaKind): string {
  const fallback = kind === 'image' ? `wechat-image.${ext}` : kind === 'voice' ? `wechat-voice.${ext}` : kind === 'video' ? `wechat-video.${ext}` : `wechat-file.${ext}`
  const safe = sanitizeWechatFilename(input ?? fallback)
  const currentExt = safeExt(safe)
  if (currentExt) return safe
  return `${safe}.${ext}`
}

// Backward compatibility for existing image fallback URLs that used
// ilinkai.weixin.qq.com/c2c/download before the CDN base was documented.
export function legacyIlinkDownloadUrl(encryptedQueryParam: string): string {
  return `${ILINK_BASE_URL}/c2c/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}
