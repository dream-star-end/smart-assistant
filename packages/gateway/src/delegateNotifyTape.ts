/**
 * Parent-session tape ingest proof for InlinePush reclaim.
 *
 * Dual-send is judged by model-visible consumption (design v3 §10-9), not by
 * stdin write counts. A stdin push dies with the engine process; the durable
 * proof that the parent model consumed `notifyId` is a tape row whose id or
 * body carries that id (or the paired ResumeInject `dlgcb.*` clientMessageId).
 */
export type ParentTapeMessage = {
  id?: unknown
  text?: unknown
  content?: unknown
}

export function parentTapeHasNotifyId(
  messages: ReadonlyArray<ParentTapeMessage> | undefined | null,
  notifyId: string,
  clientMessageId?: string,
): boolean {
  if (!notifyId) return false
  for (const msg of messages ?? []) {
    if (messageCarriesNotifyId(msg, notifyId, clientMessageId)) return true
  }
  return false
}

function messageCarriesNotifyId(
  msg: ParentTapeMessage,
  notifyId: string,
  clientMessageId?: string,
): boolean {
  if (typeof msg.id === 'string' && msg.id.length > 0) {
    if (msg.id === notifyId) return true
    if (clientMessageId && msg.id === clientMessageId) return true
  }
  if (textCarriesNotifyId(msg.text, notifyId)) return true
  if (textCarriesNotifyId(msg.content, notifyId)) return true
  return false
}

function textCarriesNotifyId(value: unknown, notifyId: string): boolean {
  if (typeof value === 'string') return value.includes(notifyId)
  if (Array.isArray(value)) {
    return value.some((part) => {
      if (typeof part === 'string') return part.includes(notifyId)
      if (part && typeof part === 'object' && 'text' in part) {
        return typeof (part as { text?: unknown }).text === 'string'
          && (part as { text: string }).text.includes(notifyId)
      }
      return false
    })
  }
  return false
}
