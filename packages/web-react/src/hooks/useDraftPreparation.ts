import { useCallback, useEffect, useMemo, useRef } from 'react'
import { api, type WorkspaceDraftHint } from '../lib/api'
import type { AuthSession } from '../lib/types'
import { genWsSessionId } from './useSessionList'

/** A draft identity is memory-only. Materialization belongs to the user's action. */
export function useDraftPreparation(args: {
  auth: AuthSession | null
  userId: string | null
  activeId: string | undefined
  agentId: string
  modelId: string | undefined
  effortLevel: string | null | undefined
  enabled: boolean
}): { draftSessionId: string; stopPreparing: () => void } {
  const { auth, userId, activeId, agentId, modelId, effortLevel, enabled } = args
  const draftSessionId = useMemo(() => {
    void activeId; void userId; void agentId
    return genWsSessionId()
  }, [activeId, userId, agentId])
  const viewId = useRef(genWsSessionId()).current
  const revision = useRef(0)
  const authRef = useRef(auth)
  authRef.current = auth
  const stopRef = useRef<() => void>(() => {})
  const stopPreparing = useCallback(() => stopRef.current(), [])
  const authenticated = auth !== null
  useEffect(() => {
    if (!enabled || !authenticated || !userId || activeId || !modelId) return
    const controller = new AbortController()
    let sent = false
    let stopped = false
    let hint: WorkspaceDraftHint | undefined
    const owner = authRef.current
    const cancel = () => {
      controller.abort()
      if (stopped) return
      stopped = true
      if (sent && hint && owner) {
        void api.prepareWorkspace(owner, undefined,
          { ...hint, revision: ++revision.current, cancel: true }).catch(() => {})
      }
    }
    stopRef.current = cancel
    const prepare = () => {
      if (document.visibilityState === 'hidden') { if (sent) cancel(); return }
      if (sent || stopped || !owner) return
      sent = true
      hint = { viewId, revision: ++revision.current, sessionId: draftSessionId,
        agentId, modelId, ...(effortLevel !== undefined ? { effortLevel } : {}) }
      void api.prepareWorkspace(owner, controller.signal, hint).catch(() => {})
    }
    prepare()
    document.addEventListener('visibilitychange', prepare)
    return () => {
      cancel()
      if (stopRef.current === cancel) stopRef.current = () => {}
      document.removeEventListener('visibilitychange', prepare)
    }
  }, [activeId, agentId, authenticated, draftSessionId, effortLevel, enabled, modelId, userId, viewId])
  return { draftSessionId, stopPreparing }
}
