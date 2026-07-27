import { type Static, Type } from '@sinclair/typebox'
import { MESSAGE_REPLY_ID_PATTERN } from './messageReplyCore.js'

export {
  MESSAGE_REPLY_ID_PATTERN,
  formatMessageReplyPrompt,
  normalizeMessageReplyQuote,
} from './messageReplyCore.js'

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
