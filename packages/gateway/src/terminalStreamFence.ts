/**
 * OCV5-2: 终结流 fence 之后，delegate_progress / outbound 帧认新爹或走 leftover。
 * leftover = 省略 clientMessageId，master persist 进 legacy leftover journal。
 */
import { isClientMessageId } from '@openclaude/protocol'

export function resolveDelegateProgressBinding(args: {
  candidate?: string | null
  isFenced: (cmid: string) => boolean
}): { clientMessageId?: string } {
  const cmid = args.candidate
  if (!isClientMessageId(cmid) || args.isFenced(cmid)) return {}
  return { clientMessageId: cmid }
}

export function rebindOutboundClientMessageId(args: {
  clientMessageId?: string | null
  sessionKey?: string | null
  isFenced: (sessionKey: string, cmid: string) => boolean
  openTurnClientMessageId?: string | null
}): string | undefined {
  const open =
    typeof args.openTurnClientMessageId === 'string' && args.openTurnClientMessageId
      ? args.openTurnClientMessageId
      : undefined
  const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : ''
  const cmid = typeof args.clientMessageId === 'string' ? args.clientMessageId : ''
  if (cmid && sessionKey && args.isFenced(sessionKey, cmid)) {
    return open
  }
  if (cmid) return cmid
  return open
}
