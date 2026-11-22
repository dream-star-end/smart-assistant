/**
 * Telegram Webhook Verification & Update Dispatcher (messages + Inline Keyboard callbacks).
 *
 * Security invariants (B8):
 *   - Public HTTP webhook ALWAYS requires a non-empty `webhookSecret` (`X-Telegram-Bot-Api-Secret-Token`).
 *   - Trusted long-polling calls `processTelegramUpdate` directly (separate from public webhook ingress).
 *   - Approval callbacks REQUIRE `resolveOperatorUid` (fail-closed if missing or returning null),
 *     bind `(action, code, decisionIdDigest, chatId, expSec)` via HMAC, verify `expectedDecisionId`
 *     when `resolveExpectedDecisionId` is supplied, and only mark `callback_query.id` committed AFTER
 *     the business handler succeeds (transient errors remain retryable).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { InboundMessage } from '@openclaude/protocol'
import {
  decisionIdDigest8,
  timingSafeEqualAscii,
  verifyTelegramApprovalCallback,
  type TelegramApprovalAction,
} from './approvalCallback.js'
import type { TelegramBotApi, TelegramUpdate } from './botApi.js'

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token'
const CALLBACK_DEDUPE_TTL_MS = 15 * 60_000
const CALLBACK_DEDUPE_MAX = 4096

export interface TelegramApprovalDecisionEvent {
  action: TelegramApprovalAction
  code: string
  decisionIdDigest: string
  /** Full decisionId when verified via `resolveExpectedDecisionId`. */
  decisionId?: string
  chatId: string
  fromUserId: string
  /** Verified platform owner uid resolved by mandatory `resolveOperatorUid`. */
  operatorUid: string
  callbackQueryId: string
  messageId?: number
}

export interface TelegramApprovalDecisionResult {
  ok: boolean
  toastText: string
  updatedMessageText?: string
}

export interface TelegramUpdateProcessorDeps {
  api: TelegramBotApi
  /** Secret key used to sign/verify Inline Keyboard callback_data HMAC. */
  callbackSecret?: string
  /** Optional allowlist of Telegram chatIds allowed to send commands or approve decisions. */
  allowedChatIds?: ReadonlyArray<string | number>
  /** Group chats require `@botUsername` mention unless set to false. */
  mentionRequired?: boolean
  botUsername?: string
  /**
   * Mandatory for approval callbacks: maps `(fromUserId, chatId)` -> platform `ownerUid`.
   * Omitted or returning `null` fails closed and refuses to invoke `onApprovalCallback`.
   */
  resolveOperatorUid?: (info: {
    fromUserId: string
    chatId: string
    chatType: string
  }) => Promise<string | null>
  /**
   * Optional lookup mapping `(ownerUid, shortCode)` -> active `decisionId`, verified against
   * the HMAC-signed `decisionIdDigest` before invoking `onApprovalCallback`.
   */
  resolveExpectedDecisionId?: (ownerUid: string, code: string) => Promise<string | null>
  /** Optional shared committed-callback dedupe map (`callback_query.id -> expiryMs`). */
  seenCallbackIds?: Map<string, number>
  /** Optional shared in-flight guard set (`callback_query.id`). */
  inFlightCallbackIds?: Set<string>
  dispatchInbound?: (frame: InboundMessage) => void | Promise<void>
  onApprovalCallback?: (
    event: TelegramApprovalDecisionEvent,
  ) => Promise<TelegramApprovalDecisionResult>
  now?: () => number
}

export interface TelegramWebhookDeps extends TelegramUpdateProcessorDeps {
  /** Mandatory non-empty secret verified against `X-Telegram-Bot-Api-Secret-Token`. */
  webhookSecret?: string
}

export interface TelegramWebhookHttpResult {
  status: number
  body: Record<string, unknown>
}

export function verifyTelegramWebhookSecret(
  headers: Record<string, string | string[] | undefined>,
  expectedSecret?: string,
): boolean {
  const expected = expectedSecret?.trim()
  if (!expected) return false
  const raw = headers[TELEGRAM_SECRET_HEADER] ?? headers['X-Telegram-Bot-Api-Secret-Token']
  const actual = Array.isArray(raw) ? raw[0] : raw
  if (typeof actual !== 'string' || !actual) return false
  return timingSafeEqualAscii(actual, expected)
}

function isChatAllowed(
  chatId: string | number,
  allowedChatIds?: ReadonlyArray<string | number>,
): boolean {
  if (!allowedChatIds || allowedChatIds.length === 0) return true
  const needle = String(chatId)
  return allowedChatIds.some((id) => String(id) === needle)
}

function isCommittedDuplicate(cache: Map<string, number>, id: string, nowMs: number): boolean {
  for (const [k, exp] of cache.entries()) {
    if (exp <= nowMs) cache.delete(k)
  }
  const existing = cache.get(id)
  return existing !== undefined && existing > nowMs
}

function markCommitted(cache: Map<string, number>, id: string, nowMs: number): void {
  if (cache.size >= CALLBACK_DEDUPE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(id, nowMs + CALLBACK_DEDUPE_TTL_MS)
}

export async function processTelegramUpdate(
  update: TelegramUpdate,
  deps: TelegramUpdateProcessorDeps,
): Promise<TelegramWebhookHttpResult> {
  const nowMs = (deps.now ?? Date.now)()

  // 1) Inline Keyboard callback_query (approval buttons)
  if (update.callback_query) {
    const cq = update.callback_query
    const chat = cq.message?.chat
    if (!chat || chat.id === undefined || !cq.from?.id) {
      await deps.api
        .answerCallbackQuery({ callback_query_id: cq.id, text: '无法识别会话或操作者', show_alert: true })
        .catch(() => {})
      return { status: 200, body: { ok: true, handled: 'callback_ignored_no_chat' } }
    }
    const chatId = chat.id

    if (deps.seenCallbackIds && isCommittedDuplicate(deps.seenCallbackIds, cq.id, nowMs)) {
      await deps.api
        .answerCallbackQuery({ callback_query_id: cq.id, text: '该审批操作已处理' })
        .catch(() => {})
      return { status: 200, body: { ok: true, handled: 'callback_duplicate_ignored' } }
    }
    if (deps.inFlightCallbackIds?.has(cq.id)) {
      return { status: 200, body: { ok: true, handled: 'callback_in_flight_ignored' } }
    }

    const secret = deps.callbackSecret?.trim() ?? ''
    if (!secret) {
      await deps.api
        .answerCallbackQuery({ callback_query_id: cq.id, text: '审批回调未配置签名密钥', show_alert: true })
        .catch(() => {})
      return { status: 200, body: { ok: true, handled: 'callback_rejected', reason: 'missing_secret' } }
    }

    // B8: Mandatory operator->ownerUid resolver — refuse to invoke approval without verified subject!
    if (!deps.resolveOperatorUid) {
      await deps.api
        .answerCallbackQuery({
          callback_query_id: cq.id,
          text: '未配置操作者身份绑定校验器，已拒绝审批',
          show_alert: true,
        })
        .catch(() => {})
      return {
        status: 200,
        body: { ok: true, handled: 'callback_rejected', reason: 'missing_operator_resolver' },
      }
    }

    const verified = verifyTelegramApprovalCallback({
      secret,
      data: cq.data ?? '',
      chatId,
      allowedChatIds: deps.allowedChatIds,
      nowMs,
    })

    if (!verified.ok) {
      const msg =
        verified.reason === 'expired'
          ? '审批按钮已过期，请发送 /pending 刷新'
          : verified.reason === 'chat_not_allowed'
            ? '当前会话无审批权限'
            : '审批回调签名无效'
      await deps.api
        .answerCallbackQuery({ callback_query_id: cq.id, text: msg, show_alert: true })
        .catch(() => {})
      return { status: 200, body: { ok: true, handled: 'callback_rejected', reason: verified.reason } }
    }

    if (!deps.onApprovalCallback) {
      await deps.api
        .answerCallbackQuery({ callback_query_id: cq.id, text: '审批服务未连接', show_alert: true })
        .catch(() => {})
      return { status: 200, body: { ok: true, handled: 'callback_unhandled' } }
    }

    deps.inFlightCallbackIds?.add(cq.id)
    try {
      const operatorUid = await deps.resolveOperatorUid({
        fromUserId: String(cq.from.id),
        chatId: verified.chatId,
        chatType: chat.type,
      })
      if (!operatorUid || !operatorUid.trim()) {
        await deps.api
          .answerCallbackQuery({
            callback_query_id: cq.id,
            text: '当前操作者未绑定审批权限，已拒绝',
            show_alert: true,
          })
          .catch(() => {})
        return {
          status: 200,
          body: { ok: true, handled: 'callback_rejected', reason: 'operator_not_authorized' },
        }
      }

      let expectedDecisionId: string | undefined
      if (deps.resolveExpectedDecisionId) {
        const resolvedDecision = await deps.resolveExpectedDecisionId(operatorUid.trim(), verified.code)
        if (
          !resolvedDecision ||
          !timingSafeEqualAscii(decisionIdDigest8(resolvedDecision), verified.decisionIdDigest)
        ) {
          await deps.api
            .answerCallbackQuery({
              callback_query_id: cq.id,
              text: '该审批按钮已失效或指向不同事项，请发送 /pending 刷新',
              show_alert: true,
            })
            .catch(() => {})
          return {
            status: 200,
            body: { ok: true, handled: 'callback_rejected', reason: 'decision_mismatch' },
          }
        }
        expectedDecisionId = resolvedDecision
      }

      const decisionResult = await deps.onApprovalCallback({
        action: verified.action,
        code: verified.code,
        decisionIdDigest: verified.decisionIdDigest,
        ...(expectedDecisionId ? { decisionId: expectedDecisionId } : {}),
        chatId: verified.chatId,
        fromUserId: String(cq.from.id),
        operatorUid: operatorUid.trim(),
        callbackQueryId: cq.id,
        messageId: cq.message?.message_id,
      })

      // Only mark committed AFTER business handler returns cleanly (transient throws stay retryable).
      if (deps.seenCallbackIds) {
        markCommitted(deps.seenCallbackIds, cq.id, nowMs)
      }

      await deps.api
        .answerCallbackQuery({
          callback_query_id: cq.id,
          text: decisionResult.toastText.slice(0, 180),
          show_alert: !decisionResult.ok,
        })
        .catch(() => {})

      if (decisionResult.updatedMessageText && cq.message?.message_id) {
        await deps.api
          .editMessageText({
            chat_id: chatId,
            message_id: cq.message.message_id,
            text: decisionResult.updatedMessageText,
          })
          .catch(() => {})
      }

      return {
        status: 200,
        body: {
          ok: true,
          handled: 'callback_resolved',
          action: verified.action,
          code: verified.code,
          decisionIdDigest: verified.decisionIdDigest,
          resolvedOk: decisionResult.ok,
        },
      }
    } finally {
      deps.inFlightCallbackIds?.delete(cq.id)
    }
  }

  // 2) Text message update
  if (update.message?.text) {
    const msg = update.message
    if (!isChatAllowed(msg.chat.id, deps.allowedChatIds)) {
      return { status: 403, body: { ok: false, error: 'CHAT_NOT_ALLOWED' } }
    }
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup'
    if (isGroup && deps.mentionRequired !== false) {
      const botUsername =
        deps.botUsername ||
        (await deps.api.getMe().then((u) => u.username).catch(() => undefined))
      if (botUsername && !msg.text!.includes(`@${botUsername}`)) {
        return { status: 200, body: { ok: true, handled: 'group_ignored_no_mention' } }
      }
    }

    const frame: InboundMessage = {
      type: 'inbound.message',
      idempotencyKey: `tg:${msg.chat.id}:${msg.message_id}`,
      channel: 'telegram',
      peer: {
        id: String(msg.chat.id),
        kind: isGroup ? 'group' : 'dm',
        displayName: msg.chat.title ?? msg.from?.username ?? '',
      },
      content: { text: msg.text! },
      ts: nowMs,
    }
    await deps.dispatchInbound?.(frame)
    return { status: 200, body: { ok: true, handled: 'message_dispatched' } }
  }

  return { status: 200, body: { ok: true, handled: 'ignored' } }
}

/** Public HTTP webhook entry — ALWAYS fails closed (401) if `webhookSecret` is missing or mismatched. */
export async function handleTelegramWebhookPayload(
  input: {
    headers: Record<string, string | string[] | undefined>
    body: unknown
  },
  deps: TelegramWebhookDeps,
): Promise<TelegramWebhookHttpResult> {
  if (!verifyTelegramWebhookSecret(input.headers, deps.webhookSecret)) {
    return { status: 401, body: { ok: false, error: 'INVALID_WEBHOOK_SECRET' } }
  }
  if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
    return { status: 400, body: { ok: false, error: 'INVALID_UPDATE' } }
  }
  return processTelegramUpdate(input.body as TelegramUpdate, {
    ...deps,
    callbackSecret: deps.callbackSecret ?? deps.webhookSecret,
  })
}

export function createTelegramWebhookHandler(
  deps: TelegramWebhookDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const seenCallbackIds = deps.seenCallbackIds ?? new Map<string, number>()
  const inFlightCallbackIds = deps.inFlightCallbackIds ?? new Set<string>()
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
      if (total > 256 * 1024) {
        res.statusCode = 413
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'PAYLOAD_TOO_LARGE' }))
        return
      }
      chunks.push(buf)
    }
    let body: unknown
    try {
      const text = Buffer.concat(chunks).toString('utf8')
      body = text ? JSON.parse(text) : {}
    } catch {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: 'INVALID_JSON' }))
      return
    }
    try {
      const result = await handleTelegramWebhookPayload(
        { headers: req.headers, body },
        { ...deps, seenCallbackIds, inFlightCallbackIds },
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
