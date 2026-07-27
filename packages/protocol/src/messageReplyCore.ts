/**
 * Browser-safe reply quote contract.
 *
 * messageReply.ts adds the TypeBox schema for wire validation. Browser code
 * only needs this structural contract and the deterministic normalizers, so
 * this leaf must stay free of schema/runtime dependencies.
 */

export const MESSAGE_REPLY_ID_PATTERN = '^[A-Za-z0-9_.:-]{1,256}$'
const MESSAGE_REPLY_ID_RE = new RegExp(MESSAGE_REPLY_ID_PATTERN)

/**
 * Immutable presentation snapshot for a user reply. The referenced message
 * remains the conversation authority; the full text is retained losslessly.
 */
export type MessageReplyQuote = {
  messageId: string
  role: 'user' | 'assistant'
  text: string
}

/** Normalize JSON ingress through one allow-list so durable rows cannot drift
 * or retain attacker-controlled extra fields. */
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

/** Deterministic model-visible envelope derived only when a model needs it. */
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
