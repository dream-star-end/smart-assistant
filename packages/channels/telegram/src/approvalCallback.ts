/**
 * Telegram Inline Keyboard Approval Card Builder & Signed Callback Verifier.
 *
 * Telegram strictly limits `callback_data` to 1-64 UTF-8 bytes.
 * Compact signed format (44 bytes UTF-8):
 *   `oc:<a|d>:<4-digit-code>:<8-hex-decHash>:<8-hex-expSec>:<16-hex-hmac>`
 *
 * The HMAC-SHA256 binds `(action, code, decisionIdHash8, chatId, expSec)` so callbacks
 * cannot be forged, tampered with, replayed after expiry, reused across another chatId,
 * OR cross-resolved to a different decision after short-code reallocation.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { TelegramInlineKeyboardMarkup } from './botApi.js'

const CALLBACK_PREFIX = 'oc'
const CALLBACK_RE = /^oc:([ad]):(\d{4}):([0-9a-f]{8}):([0-9a-f]{8}):([0-9a-f]{16})$/
const DEFAULT_CALLBACK_TTL_SEC = 15 * 60

export type TelegramApprovalAction = 'approve' | 'deny'

export function decisionIdDigest8(decisionId: string): string {
  const trimmed = decisionId.trim()
  if (!trimmed) throw new Error('decisionId must be non-empty')
  return createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 8)
}

function computeCallbackSig(
  secret: string,
  actionChar: 'a' | 'd',
  code: string,
  decHash8: string,
  chatId: string,
  expHex: string,
): string {
  return createHmac('sha256', secret)
    .update(`tg-approval\0${actionChar}\0${code}\0${decHash8}\0${chatId}\0${expHex}`, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

export function timingSafeEqualAscii(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function buildSignedCallbackData(params: {
  secret: string
  action: TelegramApprovalAction
  code: string
  decisionId: string
  chatId: string | number
  expiresAtMs?: number
  nowMs?: number
}): string {
  const code = params.code.trim()
  if (!/^\d{4}$/.test(code)) {
    throw new Error(`approval short code must be 4 digits, got: ${code}`)
  }
  const decHash8 = decisionIdDigest8(params.decisionId)
  const nowSec = Math.floor((params.nowMs ?? Date.now()) / 1000)
  const expSec = params.expiresAtMs
    ? Math.floor(params.expiresAtMs / 1000)
    : nowSec + DEFAULT_CALLBACK_TTL_SEC
  const clampedExp = Math.max(0, Math.min(0xffffffff, expSec))
  const expHex = clampedExp.toString(16).padStart(8, '0')
  const actionChar = params.action === 'approve' ? 'a' : 'd'
  const chatIdStr = String(params.chatId)
  const sig = computeCallbackSig(params.secret, actionChar, code, decHash8, chatIdStr, expHex)
  const data = `${CALLBACK_PREFIX}:${actionChar}:${code}:${decHash8}:${expHex}:${sig}`
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error('callback_data exceeded Telegram 64-byte limit')
  }
  return data
}

export interface BuildTelegramApprovalCardParams {
  secret: string
  chatId: string | number
  decisionId: string
  code: string
  title: string
  summary: string
  sourceLabel?: string
  riskLabel?: string
  expiresAtMs?: number
  nowMs?: number
}

export function buildTelegramApprovalCard(params: BuildTelegramApprovalCardParams): {
  text: string
  reply_markup: TelegramInlineKeyboardMarkup
} {
  const header = [
    '【待拍板】',
    params.riskLabel ? `[${params.riskLabel}]` : '',
    params.sourceLabel ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  const text = [
    header,
    `事项：${params.title}`,
    `摘要：${params.summary.slice(0, 300)}`,
    `短码：${params.code}（也可回复 /approve ${params.code} 或 /deny ${params.code}）`,
  ].join('\n')

  const approveData = buildSignedCallbackData({
    secret: params.secret,
    action: 'approve',
    code: params.code,
    decisionId: params.decisionId,
    chatId: params.chatId,
    expiresAtMs: params.expiresAtMs,
    nowMs: params.nowMs,
  })
  const denyData = buildSignedCallbackData({
    secret: params.secret,
    action: 'deny',
    code: params.code,
    decisionId: params.decisionId,
    chatId: params.chatId,
    expiresAtMs: params.expiresAtMs,
    nowMs: params.nowMs,
  })

  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: `✅ 批准 (${params.code})`, callback_data: approveData },
          { text: `❌ 拒绝 (${params.code})`, callback_data: denyData },
        ],
      ],
    },
  }
}

export type VerifyTelegramCallbackResult =
  | {
      ok: true
      action: TelegramApprovalAction
      code: string
      decisionIdDigest: string
      chatId: string
      expiresAtMs: number
    }
  | {
      ok: false
      reason:
        | 'invalid_format'
        | 'chat_not_allowed'
        | 'invalid_signature'
        | 'decision_mismatch'
        | 'expired'
    }

export function verifyTelegramApprovalCallback(params: {
  secret: string
  data: string
  chatId: string | number
  expectedDecisionId?: string
  allowedChatIds?: ReadonlyArray<string | number>
  nowMs?: number
}): VerifyTelegramCallbackResult {
  const chatIdStr = String(params.chatId)
  if (params.allowedChatIds && params.allowedChatIds.length > 0) {
    const allowed = new Set(params.allowedChatIds.map((id) => String(id)))
    if (!allowed.has(chatIdStr)) {
      return { ok: false, reason: 'chat_not_allowed' }
    }
  }

  const m = CALLBACK_RE.exec(params.data.trim())
  if (!m) {
    return { ok: false, reason: 'invalid_format' }
  }
  const actionChar = m[1] as 'a' | 'd'
  const code = m[2]!
  const decHash8 = m[3]!
  const expHex = m[4]!
  const providedSig = m[5]!

  const expectedSig = computeCallbackSig(params.secret, actionChar, code, decHash8, chatIdStr, expHex)
  if (!timingSafeEqualAscii(expectedSig, providedSig)) {
    return { ok: false, reason: 'invalid_signature' }
  }

  if (params.expectedDecisionId !== undefined) {
    const expectedHash = decisionIdDigest8(params.expectedDecisionId)
    if (!timingSafeEqualAscii(expectedHash, decHash8)) {
      return { ok: false, reason: 'decision_mismatch' }
    }
  }

  const expSec = Number.parseInt(expHex, 16)
  const nowSec = Math.floor((params.nowMs ?? Date.now()) / 1000)
  if (expSec < nowSec) {
    return { ok: false, reason: 'expired' }
  }

  return {
    ok: true,
    action: actionChar === 'a' ? 'approve' : 'deny',
    code,
    decisionIdDigest: decHash8,
    chatId: chatIdStr,
    expiresAtMs: expSec * 1000,
  }
}
