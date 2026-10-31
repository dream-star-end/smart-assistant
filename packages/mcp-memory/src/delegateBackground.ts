/** Background delivery is a gateway acknowledgement, never a client-side guess. */
import type { FanoutItemResult } from './delegateFanout.js'

export type DelegateBackgroundHandle = {
  resultDelivery: 'background'
  status: 'running' | 'queued'
  jobId: string
  agentId?: string
  sessionKey?: string
  parentSessionKey?: string
  parentTurnKey?: string
}

/** This advertises support; the gateway owns the flag, caller and owner gates. */
export function delegateBackgroundCapability(reviewMode?: string): { resultDelivery?: 'background' } {
  return reviewMode ? {} : { resultDelivery: 'background' }
}

export function readDelegateBackgroundHandle(
  statusCode: number,
  data: Record<string, unknown>,
): DelegateBackgroundHandle | undefined {
  if (statusCode < 200 || statusCode >= 300 || data.resultDelivery !== 'background') return undefined
  if (data.status !== 'running' && data.status !== 'queued') return undefined
  const jobId = typeof data.jobId === 'string' ? data.jobId.trim() : ''
  if (!jobId) return undefined
  const handle: DelegateBackgroundHandle = { resultDelivery: 'background', status: data.status, jobId }
  for (const key of ['agentId', 'sessionKey', 'parentSessionKey', 'parentTurnKey'] as const) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) handle[key] = value.trim()
  }
  return handle
}

export function formatDelegateBackground(handle: DelegateBackgroundHandle, label: string): string {
  return [
    `子任务已在后台运行 (agent: ${label})。结果会自动写回本会话，可继续与用户对话。`,
    JSON.stringify(handle),
  ].join('\n')
}

type BackgroundFanoutItem = FanoutItemResult & {
  running?: boolean
  deferred?: boolean
  jobId?: string
  backgroundHandle?: DelegateBackgroundHandle
}

/** Only ordinary unfinished members belong to the existing one-command wait. */
export function formatDelegateBackgroundFanout(items: BackgroundFanoutItem[]): string {
  const background = items.filter((item) => item.backgroundHandle)
  const pending = items.filter((item) => item.running && !item.backgroundHandle)
  const done = items.filter((item) => !item.running && !item.backgroundHandle)
  const parts = [
    `并行委派 ${items.length} 个子任务: ${done.length} 已完成 / ${background.length} 后台运行 / ${pending.length} 仍在等待。`,
    '',
    ...items.map((item, index) => {
      const mark = item.backgroundHandle || item.running ? '⏳' : item.isError ? '❌' : '✅'
      const goal = item.goal.length > 60 ? `${item.goal.slice(0, 60)}…` : item.goal
      const body = item.backgroundHandle
        ? formatDelegateBackground(item.backgroundHandle, item.label)
        : item.running
          ? `jobId=${item.jobId} (agent: ${item.label})`
          : item.text
      return `### ${index + 1}. ${mark} ${item.label} — ${goal}\n${body}`
    }),
  ]
  const stdoutJobIds = pending.filter((item) => !item.deferred && item.jobId).map((item) => item.jobId)
  if (stdoutJobIds.length > 0) {
    parts.push(
      '仅用下方一条 Bash 命令等待尚未转入后台的作业；后台作业结果会自动写回本会话。',
      `  oc-memory delegate-wait ${stdoutJobIds.join(' ')}`,
    )
  }
  if (pending.some((item) => item.deferred)) parts.push('网关已接管的等待结果会自动送回本会话。')
  return parts.join('\n\n')
}
