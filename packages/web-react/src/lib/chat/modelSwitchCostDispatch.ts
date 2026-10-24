import { formatMessageReplyPrompt } from '@openclaude/protocol/browser'
import type { AuthorizeSwitch, SwitchAuthorization } from '../../hooks/useModelSwitchCost'
import type { OfflineItem } from './socket'
import type { ChatSession } from './model'
interface QueueCostDeps {
  queue: OfflineItem[]
  slots: Map<string, string>
  sessions: Map<string, ChatSession>
  clear: (sid: string, id: string) => unknown
  notice: (sid: string, text: string) => void
  persist?: (sid: string) => void
  notify: () => void
}
/** Reconnection must never open a modal, lose the queued payload, or strand its slot. */
export async function authorizeQueuedModelSwitch(
  item: OfflineItem,
  authorize: AuthorizeSwitch,
  deps: QueueCostDeps,
): Promise<boolean> {
  const p = item.payload
  let permit: SwitchAuthorization | null
  try {
    permit = await authorize(
      {
        sessionId: item.sessId,
        requestId: item.msgId,
        targetModel: p.model!,
        agentId: p.agentId ?? 'main',
        text: formatMessageReplyPrompt(p.content.text ?? '', p.content.replyTo),
        mediaCount: p.content.media?.length ?? 0,
        teamMode: p.teamMode,
        ...(p.contextTier ? { contextTier: p.contextTier } : {}),
        ...(p.serviceTier ? { serviceTier: p.serviceTier } : {}),
      },
      { interactive: false, consent: p.modelSwitchConsent },
    )
  } catch {
    if (deps.queue.includes(item) && item.state === 'persisting') {
      item.state = 'queued'
      if (deps.slots.get(item.sessId) === item.msgId) deps.slots.delete(item.sessId)
      deps.notice(item.sessId, '费用信息暂不可用，消息已保留，恢复连接后重试')
    }
    return false
  }
  if (!deps.queue.includes(item) || item.state !== 'persisting') return false
  if (permit) {
    p.modelSwitchConsent = permit.consent
    return true
  }
  const sess = deps.sessions.get(item.sessId)
  deps.clear(item.sessId, item.msgId)
  if (deps.slots.get(item.sessId) === item.msgId) deps.slots.delete(item.sessId)
  if (sess) {
    if (sess._activeClientMessageId === item.msgId) {
      sess._sendingInFlight = false
      sess._activeClientMessageId = undefined
    }
    sess._dispatchPaused = true
    const user = sess.messages.find((m) => m.id === item.msgId && m.role === 'user')
    if (user) {
      user.status = 'error'
      user._errorCode = 'MODEL_SWITCH_CONFIRMATION_REQUIRED'
      user._errorDetail = '切换后的首轮费用需要重新确认，请点击重试'
    }
    deps.notice(sess.id, '切换后的首轮费用需要重新确认，请点击重试')
    deps.persist?.(sess.id)
    deps.notify()
  }
  return false
}

/** Journal failure keeps the existing in-memory delivery fallback, after cost authorization. */
export function commitAuthorizedModelSwitchDispatch(
  item: OfflineItem,
  queue: readonly OfflineItem[],
  commit: () => Promise<void> | undefined,
  ready: () => void,
  failed: () => void,
): void {
  if (!queue.includes(item) || item.state !== 'persisting') return
  const committed = commit()
  if (committed) void committed.then(ready, failed)
  else ready()
}
