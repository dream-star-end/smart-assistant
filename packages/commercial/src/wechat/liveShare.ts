/**
 * v3 commercial WeChat realtime share links.
 *
 * WeChat users receive a bearer URL that opens a read-only live process page
 * without requiring the WeChat webview to carry the normal web login session.
 * The token is scoped to one broker-owned `wsess-*` session and one canonical
 * commercial sqlite user id (`c:<digits>`), then time-limited by `exp`.
 */

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

import { type WechatSessionId, isWechatSessionId } from './types.js'

const HKDF_INFO = Buffer.from('oc-wechat-live-link-v1')
const USER_ID_RE = /^c:[1-9]\d{0,18}$/
const TOKEN_PART_RE = /^[A-Za-z0-9_-]+$/
const SIG_LEN_BYTES = 32
const MAX_TOKEN_LEN = 2048

export const DEFAULT_WECHAT_LIVE_TTL_MS = 60 * 60 * 1000

export type VerifyWechatLiveTokenResult =
  | { kind: 'ok'; sessionId: WechatSessionId; userId: string; expMs: number }
  | { kind: 'bad-request'; reason: string }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'gone'; reason: string }

export interface BuildWechatLiveTokenInput {
  sessionId: WechatSessionId
  userId: string
  ttlMs?: number
  nowMs?: number
}

interface WechatLivePayload {
  v: 1
  sid: string
  uid: string
  exp: number
}

export function deriveWechatLiveLinkKey(bridgeSecret: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(bridgeSecret)) {
    throw new Error('deriveWechatLiveLinkKey: bridgeSecret must be 64-char lowercase hex')
  }
  const ikm = Buffer.from(bridgeSecret, 'hex')
  const ab = hkdfSync('sha256', ikm, Buffer.alloc(0), HKDF_INFO, 32)
  return Buffer.from(ab)
}

export function buildWechatLiveToken(
  key: Buffer,
  input: BuildWechatLiveTokenInput,
): { token: string; expMs: number } {
  if (!isWechatSessionId(input.sessionId)) {
    throw new Error('buildWechatLiveToken: invalid sessionId')
  }
  if (!USER_ID_RE.test(input.userId)) {
    throw new Error('buildWechatLiveToken: invalid userId')
  }
  const expMs = (input.nowMs ?? Date.now()) + (input.ttlMs ?? DEFAULT_WECHAT_LIVE_TTL_MS)
  const payload: WechatLivePayload = {
    v: 1,
    sid: input.sessionId,
    uid: input.userId,
    exp: expMs,
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sigB64 = signPayload(key, payloadB64).toString('base64url')
  return { token: `${payloadB64}.${sigB64}`, expMs }
}

export function verifyWechatLiveToken(
  key: Buffer,
  token: string | null,
  nowMs: number = Date.now(),
): VerifyWechatLiveTokenResult {
  if (!token) return { kind: 'bad-request', reason: 'missing-token' }
  if (token.length > MAX_TOKEN_LEN) return { kind: 'bad-request', reason: 'token-too-long' }

  const parts = token.split('.')
  if (parts.length !== 2) return { kind: 'bad-request', reason: 'bad-token-shape' }
  const [payloadB64, sigB64] = parts
  if (!payloadB64 || !sigB64 || !TOKEN_PART_RE.test(payloadB64) || !TOKEN_PART_RE.test(sigB64)) {
    return { kind: 'bad-request', reason: 'bad-token-encoding' }
  }

  const expected = signPayload(key, payloadB64)
  let got: Buffer
  try {
    got = Buffer.from(sigB64, 'base64url')
  } catch {
    return { kind: 'bad-request', reason: 'bad-signature-encoding' }
  }
  if (got.length !== SIG_LEN_BYTES || !timingSafeEqual(got, expected)) {
    return { kind: 'forbidden', reason: 'bad-signature' }
  }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return { kind: 'bad-request', reason: 'bad-payload' }
  }
  if (!isPayload(payload)) {
    return { kind: 'bad-request', reason: 'bad-payload' }
  }
  if (!isWechatSessionId(payload.sid)) {
    return { kind: 'bad-request', reason: 'bad-session-id' }
  }
  if (!USER_ID_RE.test(payload.uid)) {
    return { kind: 'bad-request', reason: 'bad-user-id' }
  }
  if (payload.exp <= nowMs) {
    return { kind: 'gone', reason: 'expired' }
  }
  return {
    kind: 'ok',
    sessionId: payload.sid,
    userId: payload.uid,
    expMs: payload.exp,
  }
}

function signPayload(key: Buffer, payloadB64: string): Buffer {
  return createHmac('sha256', key).update(payloadB64).digest()
}

function isPayload(v: unknown): v is WechatLivePayload {
  if (typeof v !== 'object' || v === null) return false
  const obj = v as Record<string, unknown>
  return (
    obj.v === 1 &&
    typeof obj.sid === 'string' &&
    typeof obj.uid === 'string' &&
    typeof obj.exp === 'number' &&
    Number.isSafeInteger(obj.exp)
  )
}
