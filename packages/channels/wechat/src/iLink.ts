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

import { randomBytes } from 'node:crypto'

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const ILINK_BOT_TYPE = '3'
export const ILINK_LONG_POLL_TIMEOUT_MS = 35_000
export const ILINK_API_TIMEOUT_MS = 15_000
export const ILINK_SESSION_EXPIRED = -14

export interface IlinkQrcode {
  qrcode: string // long opaque key (used to poll status)
  qrcode_img_content: string // liteapp.weixin.qq.com URL to render as QR
}

export interface IlinkConfirmed {
  bot_token: string
  account_id: string // mapped from ilink_bot_id
  login_user_id: string // mapped from ilink_user_id
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
  return { bot_token: botToken, account_id: accountId, login_user_id: loginUserId }
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
): Promise<any> {
  const clientId = `cid-${Date.now()}-${randomBytes(4).toString('hex')}`
  return ilinkRequest('/ilink/bot/sendmessage', {
    method: 'POST',
    token,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
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
