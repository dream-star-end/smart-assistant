import type { ChatMessage } from './model'
import { isRecoveryControlUserTurn } from './pure'

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Automatic recovery children only. A manual continuation does not hide the send failure. */
export function collectAutomaticRecoveredSourceIds(messages: readonly ChatMessage[]): Set<string> {
  return new Set(
    messages
      .filter(
        (message) => isRecoveryControlUserTurn(message) && message._automaticRecovery === true,
      )
      .map((message) => message._recoveryOfClientMessageId)
      .filter(isNonEmptyId),
  )
}

/**
 * The source error card is hidden once an automatic child exists. A later
 * failure whose card was filtered out still owns the user bubble.
 */
export function recoveryFailureIsPresentedBelow(input: {
  message: ChatMessage
  presentedErrorTurnIds: ReadonlySet<string>
  automaticRecoveredSourceIds: ReadonlySet<string>
  safeMessages: readonly ChatMessage[]
  renderableIds: ReadonlySet<string>
  visibleErrorTurnId: (clientMessageId: string) => string
}): boolean {
  const unpresented = new Set<string>()
  for (const row of input.safeMessages) {
    const failed = (row.role === 'assistant' && !!row._errorCode) || row._turnStatusRecord === true
    if (!failed || typeof row._clientMessageId !== 'string' || row._clientMessageId.length === 0)
      continue
    if (input.renderableIds.has(row.id)) continue
    if (input.automaticRecoveredSourceIds.has(row._clientMessageId)) continue
    const owner = input.visibleErrorTurnId(row._clientMessageId)
    if (input.automaticRecoveredSourceIds.has(owner)) unpresented.add(owner)
  }
  const { message } = input
  return (
    message.role === 'user' &&
    (input.presentedErrorTurnIds.has(message.id) ||
      (input.automaticRecoveredSourceIds.has(message.id) && !unpresented.has(message.id)))
  )
}
