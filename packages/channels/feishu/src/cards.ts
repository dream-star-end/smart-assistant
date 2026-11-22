/**
 * Feishu Interactive Approval Card Builder & Callback Parser.
 */

import { signFeishuCardAction, verifyFeishuCardActionSignature } from './crypto.js'

export type FeishuApprovalAction = 'approve' | 'deny'
export type FeishuCardRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface BuildFeishuApprovalCardParams {
  signingSecret: string
  chatId: string
  decisionId: string
  code: string
  title: string
  summary: string
  sourceLabel?: string
  riskLevel?: FeishuCardRiskLevel
  expiresAtMs?: number
  nowMs?: number
}

export interface FeishuCardActionValue {
  kind: 'openclaude_pending_decision'
  action: FeishuApprovalAction
  code: string
  decisionId: string
  chatId: string
  expiresAtMs: number
  sig: string
}

export interface FeishuInteractiveCard {
  config: {
    wide_screen_mode: boolean
    update_multi?: boolean
  }
  header: {
    template: 'red' | 'orange' | 'blue' | 'green' | 'grey'
    title: {
      tag: 'plain_text'
      content: string
    }
  }
  elements: Array<Record<string, unknown>>
}

function headerTemplateForRisk(risk?: FeishuCardRiskLevel): 'red' | 'orange' | 'blue' {
  if (risk === 'critical') return 'red'
  if (risk === 'high') return 'orange'
  return 'blue'
}

export function buildFeishuApprovalCard(
  params: BuildFeishuApprovalCardParams,
): FeishuInteractiveCard {
  const nowMs = params.nowMs ?? Date.now()
  const expiresAtMs = params.expiresAtMs ?? nowMs + 15 * 60_000
  const code = params.code.trim()

  const buildValue = (action: FeishuApprovalAction): FeishuCardActionValue => ({
    kind: 'openclaude_pending_decision',
    action,
    code,
    decisionId: params.decisionId,
    chatId: params.chatId,
    expiresAtMs,
    sig: signFeishuCardAction({
      secret: params.signingSecret,
      action,
      code,
      decisionId: params.decisionId,
      chatId: params.chatId,
      expiresAtMs,
    }),
  })

  const sourceLine = params.sourceLabel ? `**来源**：${params.sourceLabel}\n` : ''
  const expiryIso = new Date(expiresAtMs).toISOString()

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: headerTemplateForRisk(params.riskLevel),
      title: {
        tag: 'plain_text',
        content: `【待拍板】${params.title.slice(0, 80)}`,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${sourceLine}**摘要**：${params.summary.slice(0, 400)}\n**短码**：\`${code}\`\n**有效期至**：${expiryIso}`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `批准 (${code})` },
            type: 'primary',
            value: buildValue('approve'),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `拒绝 (${code})` },
            type: 'danger',
            value: buildValue('deny'),
          },
        ],
      },
    ],
  }
}

export function buildFeishuResolvedCard(params: {
  title: string
  summary?: string
  code: string
  action: FeishuApprovalAction
  operatorId?: string
}): FeishuInteractiveCard {
  const approved = params.action === 'approve'
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: approved ? 'green' : 'grey',
      title: {
        tag: 'plain_text',
        content: `${approved ? '✅ 已批准' : '❌ 已拒绝'}：${params.title.slice(0, 80)}`,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            params.summary ? `**摘要**：${params.summary.slice(0, 300)}` : '',
            `**短码**：\`${params.code}\``,
            params.operatorId ? `**处理人**：${params.operatorId}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      },
    ],
  }
}

export type ParseFeishuCardCallbackResult =
  | {
      ok: true
      action: FeishuApprovalAction
      code: string
      decisionId: string
      chatId: string
      operatorOpenId: string
      expiresAtMs: number
    }
  | {
      ok: false
      reason:
        | 'not_approval_card'
        | 'invalid_payload'
        | 'missing_chat_id'
        | 'missing_operator'
        | 'chat_not_allowed'
        | 'chat_mismatch'
        | 'invalid_signature'
        | 'expired'
    }

/**
 * Parse and cryptographically verify both Feishu v2 `card.action.trigger` callbacks
 * and legacy interactive card action webhooks.
 */
export function parseFeishuApprovalCardCallback(
  payload: Record<string, unknown>,
  opts: {
    signingSecret: string
    allowedChatIds?: ReadonlyArray<string>
    nowMs?: number
  },
): ParseFeishuCardCallbackResult {
  const event =
    payload.event && typeof payload.event === 'object'
      ? (payload.event as Record<string, unknown>)
      : null

  const rawAction = (event?.action ?? payload.action) as Record<string, unknown> | undefined
  const rawValue = rawAction?.value as Record<string, unknown> | undefined
  if (!rawValue || rawValue.kind !== 'openclaude_pending_decision') {
    return { ok: false, reason: 'not_approval_card' }
  }

  const action = rawValue.action
  const code = typeof rawValue.code === 'string' ? rawValue.code.trim() : ''
  const decisionId = typeof rawValue.decisionId === 'string' ? rawValue.decisionId.trim() : ''
  const signedChatId = typeof rawValue.chatId === 'string' ? rawValue.chatId.trim() : ''
  const expiresAtMs = Number(rawValue.expiresAtMs)
  const sig = typeof rawValue.sig === 'string' ? rawValue.sig.trim() : ''

  if (
    (action !== 'approve' && action !== 'deny') ||
    !/^\d{4}$/.test(code) ||
    !decisionId ||
    !signedChatId ||
    !Number.isFinite(expiresAtMs) ||
    !sig
  ) {
    return { ok: false, reason: 'invalid_payload' }
  }

  const contextObj =
    event?.context && typeof event.context === 'object'
      ? (event.context as Record<string, unknown>)
      : null
  const operatorObj =
    event?.operator && typeof event.operator === 'object'
      ? (event.operator as Record<string, unknown>)
      : null

  // B8: Never self-fill missing chatId from the card payload, and always require non-empty operatorOpenId.
  const observedChatRaw = contextObj?.open_chat_id ?? payload.open_chat_id
  const observedChatId = typeof observedChatRaw === 'string' ? observedChatRaw.trim() : ''
  if (!observedChatId) {
    return { ok: false, reason: 'missing_chat_id' }
  }

  const operatorRaw = operatorObj?.open_id ?? payload.open_id
  const operatorOpenId = typeof operatorRaw === 'string' ? operatorRaw.trim() : ''
  if (!operatorOpenId) {
    return { ok: false, reason: 'missing_operator' }
  }

  if (observedChatId !== signedChatId) {
    return { ok: false, reason: 'chat_mismatch' }
  }

  if (opts.allowedChatIds && opts.allowedChatIds.length > 0) {
    if (!opts.allowedChatIds.includes(signedChatId)) {
      return { ok: false, reason: 'chat_not_allowed' }
    }
  }

  const sigOk = verifyFeishuCardActionSignature({
    secret: opts.signingSecret,
    signature: sig,
    action,
    code,
    decisionId,
    chatId: signedChatId,
    expiresAtMs,
  })
  if (!sigOk) {
    return { ok: false, reason: 'invalid_signature' }
  }

  const nowMs = opts.nowMs ?? Date.now()
  if (expiresAtMs <= nowMs) {
    return { ok: false, reason: 'expired' }
  }

  return {
    ok: true,
    action,
    code,
    decisionId,
    chatId: signedChatId,
    operatorOpenId,
    expiresAtMs,
  }
}

export function buildFeishuCardCallbackResponse(params: {
  toastType: 'success' | 'info' | 'warning' | 'error'
  toastContent: string
  card?: FeishuInteractiveCard
}): Record<string, unknown> {
  return {
    toast: {
      type: params.toastType,
      content: params.toastContent,
    },
    ...(params.card ? { card: { type: 'raw', data: params.card } } : {}),
  }
}
