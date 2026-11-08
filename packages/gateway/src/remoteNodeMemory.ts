export const REMOTE_NODE_MEMORY_EXHAUSTED = 'REMOTE_NODE_MEMORY_EXHAUSTED'
export type RemoteResourceCode = 'REMOTE_NODE_MEMORY_EXHAUSTED' | 'REMOTE_NODE_TASKS_EXHAUSTED'
export function isRemoteResourceCode(value: unknown): value is RemoteResourceCode {
  return value === REMOTE_NODE_MEMORY_EXHAUSTED || value === 'REMOTE_NODE_TASKS_EXHAUSTED'
}
export function nodeMemoryError(active: unknown, code: RemoteResourceCode = REMOTE_NODE_MEMORY_EXHAUSTED): Error & { code: RemoteResourceCode; activeSessions: number } {
  if (!Number.isSafeInteger(active) || Number(active) < 0) throw new Error('REMOTE_MEMORY_FRAME_INVALID')
  return Object.assign(new Error(`远端节点${code === REMOTE_NODE_MEMORY_EXHAUSTED ? '内存不足' : '进程/线程额度不足'}，当前底座已有 ${active} 个会话在跑（本次未计费）`),
    { code, activeSessions: Number(active) })
}
export function memoryRejection(error: unknown): { error: RemoteResourceCode; activeSessions: number } | undefined {
  const e = error as { code?: string; activeSessions?: number } | undefined
  return isRemoteResourceCode(e?.code) && Number.isSafeInteger(e.activeSessions) && Number(e.activeSessions) >= 0
    ? { error: e!.code, activeSessions: e.activeSessions! } : undefined
}
