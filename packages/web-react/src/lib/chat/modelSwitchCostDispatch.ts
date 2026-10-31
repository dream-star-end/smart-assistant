import { formatMessageReplyPrompt } from '@openclaude/protocol/browser'
import type { AuthorizeSwitch, SwitchAuthorization } from '../../hooks/useModelSwitchCost'
import type { OfflineItem } from './socket'
import type { ChatSession } from './model'
import { ApiError, apiErrorMessage } from '../api'
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
  let permit: SwitchAuthorization | null = null
  let refusalCode = 'MODEL_SWITCH_CONFIRMATION_REQUIRED'
  let refusalMessage = '切换后的首轮费用需要重新确认，请点击重试'
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
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status < 500 &&
      error.code &&
      error.code !== 'MODEL_SWITCH_UNAVAILABLE'
    ) {
      refusalCode = error.code
      refusalMessage =
        error.code === 'MODEL_SWITCH_INSUFFICIENT_BALANCE'
          ? '可用余额不足以覆盖切换后的首轮预估，请充值后重试'
          : apiErrorMessage(error, '发送未获授权，消息已保留，请重试')
    } else {
      if (deps.queue.includes(item) && item.state === 'persisting') {
        item.state = 'queued'
        const row = deps.sessions.get(item.sessId)?.messages.find((m) => m.id === item.msgId && m.role === 'user')
        if (row?.status === 'sending') row.status = 'queued'
        if (deps.slots.get(item.sessId) === item.msgId) deps.slots.delete(item.sessId)
        deps.notice(item.sessId, '费用信息暂不可用，消息已保留，恢复连接后重试')
      }
      return false
    }
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
      user._errorCode = refusalCode
      user._errorDetail = refusalMessage
    }
    deps.notice(sess.id, refusalMessage)
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

/** 用户在「切换中…」时点取消：在途压缩切换撤回，保留原模型。 */
export const MODEL_SWITCH_CANCELLED_MESSAGE = '已取消切换，仍保留原模型'
