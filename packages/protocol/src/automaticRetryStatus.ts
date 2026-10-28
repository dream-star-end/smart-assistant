import type { AutomaticRetryStatus, UserErrorAction } from './userErrorTypes.js'

const EXIT_ACTIONS: readonly UserErrorAction[] = ['switch_model', 'retry', 'contact_admin']
/** Counts come from the durable scheduler, never inferred from a recovery id. */
export function automaticRetryStatus(
  state: AutomaticRetryStatus['state'],
  attempt?: number,
  maxAttempts?: number,
): AutomaticRetryStatus {
  const hasAttempt = Number.isSafeInteger(attempt) && attempt! >= 0
  const hasMax = Number.isSafeInteger(maxAttempts) && maxAttempts! > 0 &&
    (!hasAttempt || attempt! <= maxAttempts!)
  const count = hasAttempt && hasMax ? `（${attempt}/${maxAttempts}）`
    : hasAttempt ? `（第 ${attempt} 次）` : ''
  const messages: Record<AutomaticRetryStatus['state'], string> = {
    scheduled: `正在等待自动重试${count}，请稍候。`,
    running: `正在自动重试${count}。`,
    paused: '自动重试已暂停。请确认已有结果，再换模型、重新发送或联系管理员。',
    exhausted: '已达到自动重试上限。你可以换个模型、重新发送，或联系管理员。',
    declined: '本轮未安排自动重试，请根据错误提示选择下一步操作。',
  }
  return {
    state,
    ...(hasAttempt ? { attempt } : {}),
    ...(hasMax ? { maxAttempts } : {}),
    message: messages[state],
    actions: state === 'paused' || state === 'exhausted' ? EXIT_ACTIONS : [],
  }
}
