import { type Static, Type } from '@sinclair/typebox'

export const MESSAGE_REPLY_ID_PATTERN = '^[A-Za-z0-9_.:-]{1,256}$'
const MESSAGE_REPLY_ID_RE = new RegExp(MESSAGE_REPLY_ID_PATTERN)

/**
 * Immutable presentation snapshot for a user reply. The referenced message
 * remains the conversation authority; this snapshot keeps the reply readable
 * after cross-device sync or archive paging without truncating its text.
 */
export const MessageReplyQuote = Type.Object({
  messageId: Type.String({ pattern: MESSAGE_REPLY_ID_PATTERN }),
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
  text: Type.String(),
})
export type MessageReplyQuote = Static<typeof MessageReplyQuote>

/** JSON ingress is manually parsed in the commercial bridge and gateway REST
 * route. Normalize both through one allow-list so their durable rows cannot
 * drift or retain attacker-controlled extra fields. */
export function normalizeMessageReplyQuote(value: unknown): MessageReplyQuote | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (
    typeof raw.messageId !== 'string' ||
    !MESSAGE_REPLY_ID_RE.test(raw.messageId) ||
    (raw.role !== 'user' && raw.role !== 'assistant') ||
    typeof raw.text !== 'string'
  ) return undefined
  return {
    messageId: raw.messageId,
    role: raw.role,
    text: raw.text,
  }
}

/**
 * Deterministic model-visible form. Wire and durable history keep the quote
 * exactly once as structured data; live gateway input and provider-switch
 * history derive this envelope only when a model actually needs it.
 */
export function formatMessageReplyPrompt(
  currentText: string,
  replyTo: MessageReplyQuote | undefined,
): string {
  if (!replyTo) return currentText
  const author = replyTo.role === 'user' ? '用户' : '助手'
  return [
    `[被引用的历史消息｜发送者：${author}｜消息ID：${replyTo.messageId}｜原文字符数：${replyTo.text.length}]`,
    replyTo.text,
    '[用户当前消息]',
    currentText,
  ].join('\n')
}
