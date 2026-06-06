// iLink (ilinkai.weixin.qq.com) low-level HTTP client.
//
// Ported from the standalone POC at /opt/openclaude/wechat-ilink-poc/poc.ts.
// Protocol reference: DeepScientist connector/weixin_support.py.
//
// Endpoints covered by this module:
//   GET  /ilink/bot/get_bot_qrcode?bot_type=3     → {qrcode, qrcode_img_content}
//   GET  /ilink/bot/get_qrcode_status?qrcode=X    → long-poll; eventually
//         {bot_token, ilink_bot_id, ilink_user_id, status:"confirmed"}
//   POST /ilink/bot/getupdates                    → long-poll inbound events
//   POST /ilink/bot/sendmessage                   → reply via context_token
//
// The server validates Authorization: Bearer <bot_token> only. No client-side
// identity. One bot_token == one long-poll worker.

import { createCipheriv, createHash, randomBytes } from 'node:crypto'

import { toIlinkUserId } from './canonicalSenderId.js'

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const ILINK_BOT_TYPE = '3'
export const ILINK_LONG_POLL_TIMEOUT_MS = 35_000
export const ILINK_API_TIMEOUT_MS = 15_000
export const ILINK_SESSION_EXPIRED = -14
export const ILINK_CDN_UPLOAD_TIMEOUT_MS = 30_000
export const ILINK_CDN_UPLOAD_MAX_BYTES = 100 * 1024 * 1024
const ILINK_CDN_UPLOAD_URL = `${ILINK_CDN_BASE_URL}/upload`

export type IlinkMediaKind = 'image' | 'video' | 'file' | 'voice'

export interface IlinkSendMediaInput {
  kind: IlinkMediaKind
  filename: string
  content: Buffer
  contextToken: string
  /** Optional stable iLink message id for retry idempotency. */
  clientId?: string
  /** Optional stable iLink message id for the caption text send. */
  captionClientId?: string
  caption?: string
  mimeType?: string
  voiceEncodeType?: number
}

export interface IlinkSendTextOptions {
  /** Optional stable iLink message id for retry idempotency. */
  clientId?: string
}

interface IlinkUploadedMedia {
  downloadEncryptedQueryParam: string
  aesKeyHex: string
  rawBytes: number
  encryptedBytes: number
  md5: string
}

export interface IlinkQrcode {
  qrcode: string // long opaque key (used to poll status)
  qrcode_img_content: string // liteapp.weixin.qq.com URL to render as QR
}

export interface IlinkConfirmed {
  bot_token: string
  account_id: string // mapped from ilink_bot_id
  login_user_id: string // mapped from ilink_user_id
  /** Optional token needed to proactively send the first bound-user message. */
  context_token?: string
}

interface RequestOpts {
  method: 'GET' | 'POST'
  body?: unknown
  token?: string
  timeoutMs?: number
  query?: Record<string, string>
}

function randomWechatUin(): string {
  const n = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(n), 'utf8').toString('base64')
}

export async function ilinkRequest(endpoint: string, opts: RequestOpts): Promise<any> {
  const url = new URL(`${ILINK_BASE_URL}${endpoint}`)
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v)

  const headers: Record<string, string> = {
    'iLink-App-ClientVersion': '1',
  }
  const rawBody = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  if (rawBody !== undefined) {
    headers['Content-Type'] = 'application/json'
    headers['AuthorizationType'] = 'ilink_bot_token'
    headers['X-WECHAT-UIN'] = randomWechatUin()
  }
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`

  const ctrl = new AbortController()
  const timeoutMs = opts.timeoutMs ?? ILINK_API_TIMEOUT_MS
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url.toString(), {
      method: opts.method,
      headers,
      body: rawBody,
      signal: ctrl.signal,
    })
    const text = await resp.text()
    if (!resp.ok) throw new Error(`iLink HTTP ${resp.status}: ${text.slice(0, 400)}`)
    if (!text.trim()) return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`iLink returned non-JSON: ${text.slice(0, 400)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchIlinkQrcode(): Promise<IlinkQrcode> {
  const resp = await ilinkRequest('/ilink/bot/get_bot_qrcode', {
    method: 'GET',
    query: { bot_type: ILINK_BOT_TYPE },
  })
  if (!resp?.qrcode || !resp?.qrcode_img_content) {
    throw new Error(`Unexpected qrcode response: ${JSON.stringify(resp).slice(0, 300)}`)
  }
  return { qrcode: String(resp.qrcode), qrcode_img_content: String(resp.qrcode_img_content) }
}

/** One long-poll call; server blocks up to ~35s. Returns raw JSON. */
export async function pollIlinkQrcodeStatus(qrcode: string): Promise<any> {
  return ilinkRequest('/ilink/bot/get_qrcode_status', {
    method: 'GET',
    query: { qrcode },
    timeoutMs: ILINK_LONG_POLL_TIMEOUT_MS + 2_000,
  })
}

/** Returns null unless the QR is confirmed. */
export function extractConfirmed(resp: any): IlinkConfirmed | null {
  const botToken = String(resp?.bot_token || '')
  const accountId = String(resp?.ilink_bot_id || resp?.account_id || '')
  const loginUserId = String(resp?.ilink_user_id || resp?.login_user_id || '')
  const status = String(resp?.status || '').toLowerCase()
  if (!botToken || !accountId || status !== 'confirmed') return null
  const contextToken = extractOptionalString(
    resp?.context_token,
    resp?.contextToken,
    resp?.login_context_token,
    resp?.msg?.context_token,
  )
  return {
    bot_token: botToken,
    account_id: accountId,
    login_user_id: loginUserId,
    ...(contextToken ? { context_token: contextToken } : {}),
  }
}

function extractOptionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

export async function getIlinkUpdates(token: string, getUpdatesBuf: string): Promise<any> {
  return ilinkRequest('/ilink/bot/getupdates', {
    method: 'POST',
    token,
    timeoutMs: ILINK_LONG_POLL_TIMEOUT_MS + 5_000,
    body: {
      get_updates_buf: getUpdatesBuf,
      base_info: { channel_version: 'openclaude-0.0.1' },
    },
  })
}

export async function sendIlinkText(
  token: string,
  toUserId: string,
  contextToken: string,
  text: string,
  opts: IlinkSendTextOptions = {},
): Promise<any> {
  // Boundary: 上游(broker / outboxWorker / manager)按 canonical base64url
  // 形态持有 senderId,iLink wire 要求 "<canonical>@im.wechat";幂等,
  // 已是 wire 形态时不重复加后缀。
  const wireToUserId = toIlinkUserId(toUserId)
  const clientId = opts.clientId?.trim() || randomIlinkClientId()
  return ilinkRequest('/ilink/bot/sendmessage', {
    method: 'POST',
    token,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: wireToUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: 'openclaude-0.0.1' },
    },
  })
}

export async function sendIlinkMedia(
  token: string,
  toUserId: string,
  input: IlinkSendMediaInput,
): Promise<any> {
  const wireToUserId = toIlinkUserId(toUserId)
  const kind = normalizeOutboundMediaKind(input.kind, input.filename)
  const uploaded = await uploadIlinkMedia(token, wireToUserId, kind, input.content)
  if (input.caption?.trim()) {
    await sendIlinkText(token, wireToUserId, input.contextToken, input.caption.trim(), {
      clientId: input.captionClientId,
    })
  }
  return sendIlinkMediaRef(token, wireToUserId, input.contextToken, {
    kind,
    filename: input.filename,
    uploaded,
    clientId: input.clientId,
    voiceEncodeType: input.voiceEncodeType ?? inferVoiceEncodeType(input.filename, input.mimeType),
  })
}

async function sendIlinkMediaRef(
  token: string,
  wireToUserId: string,
  contextToken: string,
  args: {
    kind: IlinkMediaKind
    filename: string
    uploaded: IlinkUploadedMedia
    clientId?: string
    voiceEncodeType?: number
  },
): Promise<any> {
  const clientId = args.clientId?.trim() || randomIlinkClientId()
  const media = {
    encrypt_query_param: args.uploaded.downloadEncryptedQueryParam,
    // iLink media refs use base64(hex-string) in Tencent/openclaw examples.
    aes_key: Buffer.from(args.uploaded.aesKeyHex, 'utf8').toString('base64'),
    encrypt_type: 1,
  }
  const item =
    args.kind === 'image'
      ? {
          type: 2,
          image_item: { media, mid_size: args.uploaded.encryptedBytes },
        }
      : args.kind === 'video'
        ? {
            type: 5,
            video_item: { media, video_size: args.uploaded.encryptedBytes },
          }
        : args.kind === 'voice'
          ? {
              type: 3,
              voice_item: {
                media,
                encode_type: args.voiceEncodeType ?? 7,
              },
            }
          : {
              type: 4,
              file_item: {
                media,
                file_name: safeIlinkFilename(args.filename),
                md5: args.uploaded.md5,
                len: String(args.uploaded.rawBytes),
              },
            }

  return ilinkRequest('/ilink/bot/sendmessage', {
    method: 'POST',
    token,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: wireToUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [item],
      },
      base_info: { channel_version: 'openclaude-0.0.1' },
    },
  })
}

async function uploadIlinkMedia(
  token: string,
  wireToUserId: string,
  kind: IlinkMediaKind,
  plaintext: Buffer,
): Promise<IlinkUploadedMedia> {
  if (plaintext.length <= 0) throw new Error('empty iLink media upload')
  if (plaintext.length > ILINK_CDN_UPLOAD_MAX_BYTES) {
    throw new Error('iLink media upload exceeds size limit')
  }
  const aesKey = randomBytes(16)
  const aesKeyHex = aesKey.toString('hex')
  const encrypted = encryptAes128Ecb(plaintext, aesKey)
  const filekey = randomBytes(16).toString('hex')
  const md5 = createHash('md5').update(plaintext).digest('hex')
  const upload = await ilinkRequest('/ilink/bot/getuploadurl', {
    method: 'POST',
    token,
    body: {
      filekey,
      media_type: uploadMediaType(kind),
      to_user_id: wireToUserId,
      rawsize: plaintext.length,
      rawfilemd5: md5,
      filesize: encrypted.length,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: { channel_version: 'openclaude-0.0.1' },
    },
  })
  const uploadUrl = extractIlinkUploadUrl(upload, filekey)
  const downloadEncryptedQueryParam = await uploadIlinkEncryptedToCdn(uploadUrl, encrypted)
  return {
    downloadEncryptedQueryParam,
    aesKeyHex,
    rawBytes: plaintext.length,
    encryptedBytes: encrypted.length,
    md5,
  }
}

function extractIlinkUploadUrl(upload: any, filekey: string): string {
  const uploadFullUrl =
    typeof upload?.upload_full_url === 'string' ? upload.upload_full_url.trim() : ''
  if (uploadFullUrl) {
    return validateIlinkUploadUrl(uploadFullUrl)
  }

  const uploadParam = typeof upload?.upload_param === 'string' ? upload.upload_param.trim() : ''
  if (uploadParam) {
    const cdnUrl = new URL(ILINK_CDN_UPLOAD_URL)
    cdnUrl.searchParams.set('encrypted_query_param', uploadParam)
    cdnUrl.searchParams.set('filekey', filekey)
    return cdnUrl.toString()
  }

  throw new Error(
    `iLink getuploadurl returned no upload target (keys: ${summarizeIlinkResponseKeys(upload)})`,
  )
}

function validateIlinkUploadUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('iLink getuploadurl returned invalid upload_full_url')
  }

  const expected = new URL(ILINK_CDN_UPLOAD_URL)
  if (url.protocol !== 'https:') throw new Error('iLink CDN upload URL must use https')
  if (url.host !== expected.host || url.pathname !== expected.pathname) {
    throw new Error('iLink getuploadurl returned unexpected upload_full_url host/path')
  }
  if (!url.searchParams.get('encrypted_query_param') || !url.searchParams.get('filekey')) {
    throw new Error('iLink getuploadurl returned incomplete upload_full_url')
  }
  return rawUrl
}

function summarizeIlinkResponseKeys(resp: unknown): string {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return typeof resp
  const keys = Object.keys(resp)
  return keys.length ? keys.slice(0, 12).join(', ') : 'none'
}

async function uploadIlinkEncryptedToCdn(uploadUrl: string, encrypted: Buffer): Promise<string> {
  const cdnUrl = new URL(validateIlinkUploadUrl(uploadUrl))

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ILINK_CDN_UPLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(cdnUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(encrypted),
      redirect: 'manual',
      signal: ctrl.signal,
    })
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`iLink CDN upload redirected unexpectedly: HTTP ${res.status}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`iLink CDN upload failed: HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const downloadParam = res.headers.get('x-encrypted-param')?.trim()
    if (!downloadParam) throw new Error('iLink CDN upload missing x-encrypted-param')
    return downloadParam
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('iLink CDN upload timed out')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function encryptAes128Ecb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

function uploadMediaType(kind: IlinkMediaKind): number {
  if (kind === 'image') return 1
  if (kind === 'video') return 2
  if (kind === 'file') return 3
  return 4
}

function normalizeOutboundMediaKind(kind: IlinkMediaKind, filename: string): IlinkMediaKind {
  if (kind !== 'voice') return kind
  return inferVoiceEncodeType(filename) ? 'voice' : 'file'
}

function inferVoiceEncodeType(filename: string, mimeType?: string): number | undefined {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'silk') return 6
  if (ext === 'mp3' || mimeType === 'audio/mpeg') return 7
  if (ext === 'wav' || mimeType === 'audio/wav') return 1
  if (ext === 'amr') return 5
  if (ext === 'ogg' || ext === 'oga') return 8
  return undefined
}

function safeIlinkFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop()?.trim() || 'file'
  return base.length > 120 ? base.slice(0, 120) : base
}

function randomIlinkClientId(): string {
  return `cid-${Date.now()}-${randomBytes(4).toString('hex')}`
}

/** Extract a plain-text string from an inbound msg.item_list. */
export function extractIlinkText(msg: any): string {
  const items = Array.isArray(msg?.item_list) ? msg.item_list : []
  for (const item of items) {
    if (Number(item?.type) === 1 && typeof item?.text_item?.text === 'string') {
      const t = item.text_item.text.trim()
      if (t) return t
    }
    if (Number(item?.type) === 3 && typeof item?.voice_item?.text === 'string') {
      const t = item.voice_item.text.trim()
      if (t) return t
    }
  }
  return ''
}
