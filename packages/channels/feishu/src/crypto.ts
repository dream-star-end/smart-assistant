/**
 * Feishu (Lark) Webhook Signature Verification, AES-256-CBC Payload Decryption,
 * Verification Token check, and Interactive Card Action HMAC signing.
 *
 * Zero external dependencies — pure `node:crypto`.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

export const FEISHU_TIMESTAMP_HEADER = 'x-lark-request-timestamp'
export const FEISHU_NONCE_HEADER = 'x-lark-request-nonce'
export const FEISHU_SIGNATURE_HEADER = 'x-lark-signature'
export const DEFAULT_FEISHU_MAX_SKEW_MS = 5 * 60_000

export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function computeFeishuSignature(params: {
  timestamp: string
  nonce: string
  encryptKey: string
  rawBody: string
}): string {
  return createHash('sha256')
    .update(`${params.timestamp}${params.nonce}${params.encryptKey}${params.rawBody}`, 'utf8')
    .digest('hex')
}

export type VerifyFeishuSignatureResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'timestamp_out_of_window' | 'signature_mismatch' }

/**
 * Verify Feishu webhook signature (`X-Lark-Request-Timestamp`, `X-Lark-Request-Nonce`,
 * `X-Lark-Signature`) and guard against timestamp replay outside `maxSkewMs`.
 */
export function verifyFeishuSignature(params: {
  headers: Record<string, string | string[] | undefined>
  rawBody: string
  encryptKey: string
  nowMs?: number
  maxSkewMs?: number
}): VerifyFeishuSignatureResult {
  const readHeader = (name: string): string => {
    const direct = params.headers[name]
    if (typeof direct === 'string') return direct.trim()
    if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0].trim()
    const lower = name.toLowerCase()
    for (const [k, v] of Object.entries(params.headers)) {
      if (k.toLowerCase() === lower) {
        if (typeof v === 'string') return v.trim()
        if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim()
      }
    }
    return ''
  }

  const timestamp = readHeader(FEISHU_TIMESTAMP_HEADER)
  const nonce = readHeader(FEISHU_NONCE_HEADER)
  const signature = readHeader(FEISHU_SIGNATURE_HEADER)
  if (!timestamp || !nonce || !signature) {
    return { ok: false, reason: 'missing_headers' }
  }

  const tsSec = Number(timestamp)
  const nowMs = params.nowMs ?? Date.now()
  const maxSkewMs = params.maxSkewMs ?? DEFAULT_FEISHU_MAX_SKEW_MS
  if (!Number.isFinite(tsSec) || Math.abs(nowMs - tsSec * 1000) > maxSkewMs) {
    return { ok: false, reason: 'timestamp_out_of_window' }
  }

  const expected = computeFeishuSignature({
    timestamp,
    nonce,
    encryptKey: params.encryptKey,
    rawBody: params.rawBody,
  })
  if (!timingSafeEqualStr(expected, signature)) {
    return { ok: false, reason: 'signature_mismatch' }
  }
  return { ok: true }
}

export function verifyFeishuToken(providedToken: unknown, expectedToken?: string): boolean {
  const expected = expectedToken?.trim()
  // Fail-closed: empty/missing verificationToken MUST NOT allow unauthenticated webhook traffic.
  if (!expected) return false
  if (typeof providedToken !== 'string' || !providedToken) return false
  return timingSafeEqualStr(providedToken, expected)
}

/**
 * Official Feishu AES-256-CBC payload decryption:
 *   key = SHA-256(encryptKey)
 *   raw = base64Decode(encrypt)
 *   iv = raw[0..16), ciphertext = raw[16..)
 */
export function decryptFeishuPayload(encryptBase64: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest()
  const raw = Buffer.from(encryptBase64, 'base64')
  if (raw.length <= 16) {
    throw new Error('feishu encrypted payload is too short')
  }
  const iv = raw.subarray(0, 16)
  const ciphertext = raw.subarray(16)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}

/** Helper primarily for tests and round-trip verification of AES-256-CBC payloads. */
export function encryptFeishuPayload(plaintext: string, encryptKey: string, iv?: Buffer): string {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest()
  const actualIv = iv ?? randomBytes(16)
  if (actualIv.length !== 16) throw new Error('IV must be 16 bytes')
  const cipher = createCipheriv('aes-256-cbc', key, actualIv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([actualIv, encrypted]).toString('base64')
}

export function signFeishuCardAction(params: {
  secret: string
  action: 'approve' | 'deny'
  code: string
  decisionId: string
  chatId: string
  expiresAtMs: number
}): string {
  return createHmac('sha256', params.secret)
    .update(
      `feishu-card\0${params.action}\0${params.code}\0${params.decisionId}\0${params.chatId}\0${params.expiresAtMs}`,
      'utf8',
    )
    .digest('hex')
    .slice(0, 32)
}

export function verifyFeishuCardActionSignature(params: {
  secret: string
  signature: string
  action: 'approve' | 'deny'
  code: string
  decisionId: string
  chatId: string
  expiresAtMs: number
}): boolean {
  if (!params.signature) return false
  const expected = signFeishuCardAction({
    secret: params.secret,
    action: params.action,
    code: params.code,
    decisionId: params.decisionId,
    chatId: params.chatId,
    expiresAtMs: params.expiresAtMs,
  })
  return timingSafeEqualStr(expected, params.signature)
}
