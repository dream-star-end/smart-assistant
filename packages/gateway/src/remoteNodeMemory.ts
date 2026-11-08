export const REMOTE_NODE_MEMORY_EXHAUSTED = 'REMOTE_NODE_MEMORY_EXHAUSTED'
export function nodeMemoryError(active: unknown): Error & { code: string; activeSessions: number } {
  if (!Number.isSafeInteger(active) || Number(active) < 0) throw new Error('REMOTE_MEMORY_FRAME_INVALID')
  return Object.assign(new Error(`远端节点内存不足，当前底座已有 ${active} 个会话在跑（本次未计费）`),
    { code: REMOTE_NODE_MEMORY_EXHAUSTED, activeSessions: Number(active) })
}
export function memoryRejection(error: unknown): { error: string; activeSessions: number } | undefined {
  const e = error as { code?: string; activeSessions?: number } | undefined
  return e?.code === REMOTE_NODE_MEMORY_EXHAUSTED && Number.isSafeInteger(e.activeSessions) && Number(e.activeSessions) >= 0
    ? { error: REMOTE_NODE_MEMORY_EXHAUSTED, activeSessions: e.activeSessions! } : undefined
}
