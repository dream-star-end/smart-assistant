import type { AgentSession } from './sessionTypes.js'
import type { SessionStreamEvent } from './engine/engineEvents.js'
export function beginIdleWait(session: AgentSession, emit: (event: SessionStreamEvent) => void): () => void {
  const listeners = session._idleWaiters ??= new Set()
  const clear = () => {
    if (!listeners.delete(clear)) return
    if (!listeners.size && session.currentTurnStatus === 'compacting') session.currentTurnStatus = null
    emit({ kind: 'turn_status', status: null })
  }
  listeners.add(clear)
  session.currentTurnStatus = 'compacting'
  emit({ kind: 'turn_status', status: 'compacting' })
  return clear
}
export function endIdleWait(session: AgentSession): void {
  for (const clear of session._idleWaiters ?? []) clear()
}
