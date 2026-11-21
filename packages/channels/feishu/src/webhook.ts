/**
 * Feishu Webhook Handler (B8 hardened):
 *   1. Mandatory non-empty `verificationToken` (fail-closed 401 if misconfigured)
 *   2. Event signature verification (`X-Lark-Signature` + replay window) when `encryptKey` configured
 *   3. Optional AES-256-CBC body decryption (`{ encrypt }`)
 *   4. Challenge handshake (`type: "url_verification"` -> `{ challenge }`)
 *   5. Commit-only Event ID idempotent deduplication (in-flight guard + mark committed AFTER success)
 *   6. Interactive approval card callback verification: mandatory chatId + operator + mandatory `resolveOperatorUid`
 *   7. `im.message.receive_v1` inbound message dispatch
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { InboundMessage } from '@openclaude/protocol'
import {
  buildFeishuCardCallbackResponse,
  parseFeishuApprovalCardCallback,
  type FeishuApprovalAction,
  type FeishuInteractiveCard,
} from './cards.js'
import {
  decryptFeishuPayload,
  verifyFeishuSignature,
  verifyFeishuToken,
} from './crypto.js'

const EVENT_DEDUPE_TTL_MS = 10 * 60_000
const EVENT_DEDUPE_MAX = 4096

export interface FeishuApprovalCallbackEvent {
  action: FeishuApprovalAction
  code: string
  decisionId: string
  chatId: string
  operatorOpenId: string
  /** Verified platform owner uid resolved by mandatory `resolveOperatorUid`. */
  operatorUid: string
  eventId?: string
}

export interface FeishuApprovalCallbackResult {
  ok: boolean
  toastText: string
  updatedCard?: FeishuInteractiveCard
}

export interface FeishuWebhookDeps {
  /** Mandatory non-empty Feishu verification token (fail-closed if empty). */
  verificationToken: string
  encryptKey?: string
  /** HMAC secret for interactive approval cards. Defaults to encryptKey ?? verificationToken. */
  cardSigningSecret?: string
  allowedChatIds?: ReadonlyArray<string>
  maxSkewMs?: number
  now?: () => number
  /**
   * Mandatory for approval callbacks: maps `(operatorOpenId, chatId)` -> platform `ownerUid`.
   * Omitted or returning `null` fails closed and refuses to invoke `onApprovalCallback`.
   */
  resolveOperatorUid?: (info: {
    operatorOpenId: string
    chatId: string
  }) => Promise<string | null>
  /** Optional shared committed-event dedupe cache (`eventId -> expiresAtMs`). */
  seenEventIds?: Map<string, number>
  /** Optional shared in-flight guard set (`eventId`). */
  inFlightEventIds?: Set<string>
  dispatchInbound?: (frame: InboundMessage) => void | Promise<void>
  onApprovalCallback?: (
    event: FeishuApprovalCallbackEvent,
  ) => Promise<FeishuApprovalCallbackResult>
}

export interface FeishuWebhookHttpResult {
  status: number
  body: Record<string, unknown>
}

function extractPayloadToken(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.token === 'string') return payload.token
  const header = payload.header
  if (header && typeof header === 'object' && typeof (header as Record<string, unknown>).token === 'string') {
    return (header as Record<string, unknown>).token as string
  }
  return undefined
}

function extractTextFromMessageContent(rawContent: unknown): string {
  if (typeof rawContent !== 'string' || !rawContent.trim()) return ''
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>
    if (typeof parsed.text === 'string') return parsed.text.trim()
  } catch {
    return rawContent.trim()
  }
  return ''
}

function isCommittedDuplicate(cache: Map<string, number>, eventId: string, nowMs: number): boolean {
  for (const [k, exp] of cache.entries()) {
    if (exp <= nowMs) cache.delete(k)
  }
  const existing = cache.get(eventId)
  return existing !== undefined && existing > nowMs
}

function markCommitted(cache: Map<string, number>, eventId: string, nowMs: number): void {
  if (cache.size >= EVENT_DEDUPE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(eventId, nowMs + EVENT_DEDUPE_TTL_MS)
}

export async function handleFeishuWebhookPayload(
  input: {
    headers: Record<string, string | string[] | undefined>
    rawBody: string
  },
  deps: FeishuWebhookDeps,
): Promise<FeishuWebhookHttpResult> {
  const nowMs = (deps.now ?? Date.now)()

  // 0) Fail-closed when verificationToken is missing/empty
  if (!deps.verificationToken || !deps.verificationToken.trim()) {
    return { status: 401, body: { ok: false, error: 'MISSING_VERIFICATION_TOKEN' } }
  }

  // 1) Signature verification when encryptKey is configured
  if (deps.encryptKey) {
    const sig = verifyFeishuSignature({
      headers: input.headers,
      rawBody: input.rawBody,
      encryptKey: deps.encryptKey,
      nowMs,
      maxSkewMs: deps.maxSkewMs,
    })
    if (!sig.ok) {
      return { status: 401, body: { ok: false, error: 'INVALID_SIGNATURE', reason: sig.reason } }
    }
  }

  // 2) Parse JSON (and decrypt `{ encrypt }` envelope if present)
  let parsed: Record<string, unknown>
  try {
    const initial = JSON.parse(input.rawBody || '{}') as Record<string, unknown>
    if (typeof initial.encrypt === 'string') {
      if (!deps.encryptKey) {
        return { status: 400, body: { ok: false, error: 'ENCRYPT_KEY_REQUIRED' } }
      }
      const decrypted = decryptFeishuPayload(initial.encrypt, deps.encryptKey)
      parsed = JSON.parse(decrypted) as Record<string, unknown>
    } else {
      parsed = initial
    }
  } catch {
    return { status: 400, body: { ok: false, error: 'INVALID_PAYLOAD' } }
  }

  // 3) Verification token check (fail-closed)
  const token = extractPayloadToken(parsed)
  if (!verifyFeishuToken(token, deps.verificationToken)) {
    return { status: 401, body: { ok: false, error: 'INVALID_TOKEN' } }
  }

  // 4) Challenge handshake (`url_verification`)
  if (parsed.type === 'url_verification' && typeof parsed.challenge === 'string') {
    return { status: 200, body: { challenge: parsed.challenge } }
  }

  const header =
    parsed.header && typeof parsed.header === 'object'
      ? (parsed.header as Record<string, unknown>)
      : null
  const eventType = typeof header?.event_type === 'string' ? header.event_type : undefined
  const eventId =
    typeof header?.event_id === 'string' && header.event_id.trim()
      ? header.event_id.trim()
      : typeof parsed.action_id === 'string' && parsed.action_id.trim()
        ? parsed.action_id.trim()
        : undefined

  // 5) Check committed duplicate or concurrent in-flight delivery (do NOT mark committed yet!)
  if (eventId && deps.seenEventIds && isCommittedDuplicate(deps.seenEventIds, eventId, nowMs)) {
    return { status: 200, body: { ok: true, handled: 'duplicate_event_ignored', eventId } }
  }
  if (eventId && deps.inFlightEventIds?.has(eventId)) {
    return { status: 200, body: { ok: true, handled: 'in_flight_event_ignored', eventId } }
  }

  // 6) Interactive approval card callback (v2 `card.action.trigger` or legacy `action` callback)
  if (eventType === 'card.action.trigger' || parsed.action !== undefined) {
    // B8: Mandatory operator->ownerUid resolver — refuse to invoke approval without verified subject!
    if (!deps.resolveOperatorUid) {
      return {
        status: 200,
        body: buildFeishuCardCallbackResponse({
          toastType: 'error',
          toastContent: '未配置操作者身份绑定校验器，已拒绝审批',
        }),
      }
    }

    const signingSecret = deps.cardSigningSecret ?? deps.encryptKey ?? deps.verificationToken
    const cardParsed = parseFeishuApprovalCardCallback(parsed, {
      signingSecret,
      allowedChatIds: deps.allowedChatIds,
      nowMs,
    })
    if (!cardParsed.ok) {
      const toastMsg =
        cardParsed.reason === 'expired'
          ? '审批卡片已过期，请发送 /pending 刷新'
          : cardParsed.reason === 'chat_not_allowed' ||
              cardParsed.reason === 'chat_mismatch' ||
              cardParsed.reason === 'missing_chat_id' ||
              cardParsed.reason === 'missing_operator'
            ? '当前会话或操作者无审批权限'
            : '审批卡片签名校验失败'
      return {
        status: 200,
        body: buildFeishuCardCallbackResponse({
          toastType: 'error',
          toastContent: toastMsg,
        }),
      }
    }

    if (!deps.onApprovalCallback) {
      return {
        status: 200,
        body: buildFeishuCardCallbackResponse({
          toastType: 'warning',
          toastContent: '审批服务尚未连接',
        }),
      }
    }

    if (eventId) deps.inFlightEventIds?.add(eventId)
    try {
      const operatorUid = await deps.resolveOperatorUid({
        operatorOpenId: cardParsed.operatorOpenId,
        chatId: cardParsed.chatId,
      })
      if (!operatorUid || !operatorUid.trim()) {
        return {
          status: 200,
          body: buildFeishuCardCallbackResponse({
            toastType: 'error',
            toastContent: '当前操作者未绑定审批权限，已拒绝',
          }),
        }
      }

      const result = await deps.onApprovalCallback({
        action: cardParsed.action,
        code: cardParsed.code,
        decisionId: cardParsed.decisionId,
        chatId: cardParsed.chatId,
        operatorOpenId: cardParsed.operatorOpenId,
        operatorUid: operatorUid.trim(),
        ...(eventId ? { eventId } : {}),
      })

      // Mark eventId committed ONLY AFTER business callback succeeds cleanly!
      if (eventId && deps.seenEventIds) {
        markCommitted(deps.seenEventIds, eventId, nowMs)
      }

      return {
        status: 200,
        body: buildFeishuCardCallbackResponse({
          toastType: result.ok ? 'success' : 'error',
          toastContent: result.toastText,
          card: result.updatedCard,
        }),
      }
    } finally {
      if (eventId) deps.inFlightEventIds?.delete(eventId)
    }
  }

  // 7) Inbound IM message (`im.message.receive_v1`)
  if (eventType === 'im.message.receive_v1' && parsed.event && typeof parsed.event === 'object') {
    const ev = parsed.event as Record<string, unknown>
    const msg =
      ev.message && typeof ev.message === 'object'
        ? (ev.message as Record<string, unknown>)
        : null
    const sender =
      ev.sender && typeof ev.sender === 'object'
        ? (ev.sender as Record<string, unknown>)
        : null
    const chatId = typeof msg?.chat_id === 'string' ? msg.chat_id : ''
    const messageId = typeof msg?.message_id === 'string' ? msg.message_id : ''
    const chatType = typeof msg?.chat_type === 'string' ? msg.chat_type : 'p2p'
    const text = extractTextFromMessageContent(msg?.content)

    if (!chatId || !text) {
      return { status: 200, body: { ok: true, handled: 'ignored_empty_message' } }
    }
    if (deps.allowedChatIds && deps.allowedChatIds.length > 0 && !deps.allowedChatIds.includes(chatId)) {
      return { status: 403, body: { ok: false, error: 'CHAT_NOT_ALLOWED' } }
    }

    const senderIdObj =
      sender?.sender_id && typeof sender.sender_id === 'object'
        ? (sender.sender_id as Record<string, unknown>)
        : null
    const displayName = typeof senderIdObj?.open_id === 'string' ? senderIdObj.open_id : ''

    const frame: InboundMessage = {
      type: 'inbound.message',
      idempotencyKey: `feishu:${chatId}:${eventId || messageId || nowMs}`,
      channel: 'feishu',
      peer: {
        id: chatId,
        kind: chatType === 'group' ? 'group' : 'dm',
        displayName,
      },
      content: { text },
      ts: nowMs,
    }
    if (eventId) deps.inFlightEventIds?.add(eventId)
    try {
      await deps.dispatchInbound?.(frame)
      if (eventId && deps.seenEventIds) {
        markCommitted(deps.seenEventIds, eventId, nowMs)
      }
      return { status: 200, body: { ok: true, handled: 'message_dispatched' } }
    } finally {
      if (eventId) deps.inFlightEventIds?.delete(eventId)
    }
  }

  return { status: 200, body: { ok: true, handled: 'ignored' } }
}

export function createFeishuWebhookHandler(
  deps: FeishuWebhookDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const seenEventIds = deps.seenEventIds ?? new Map<string, number>()
  const inFlightEventIds = deps.inFlightEventIds ?? new Set<string>()
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: 'METHOD_NOT_ALLOWED' }))
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > 512 * 1024) {
        res.statusCode = 413
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'PAYLOAD_TOO_LARGE' }))
        return
      }
      chunks.push(buf)
    }
    const rawBody = Buffer.concat(chunks).toString('utf8')
    try {
      const result = await handleFeishuWebhookPayload(
        { headers: req.headers, rawBody },
        { ...deps, seenEventIds, inFlightEventIds },
      )
      res.statusCode = result.status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(result.body))
    } catch {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: 'INTERNAL' }))
    }
  }
}
