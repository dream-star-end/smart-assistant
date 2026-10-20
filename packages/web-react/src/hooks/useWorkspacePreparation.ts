import { useEffect, useRef } from 'react'
import { api } from '../lib/api'
import type { AuthSession } from '../lib/types'

/** Run in parallel with IndexedDB hydration; the normal socket still owns hello/cursors. */
export function useWorkspacePreparation(auth: AuthSession | null, enabled: boolean, userId: string | null): void {
  const authRef = useRef(auth)
  authRef.current = auth
  const authenticated = auth !== null
  useEffect(() => {
    if (!enabled || !authenticated || !userId) return
    const controller = new AbortController()
    let sent = false
    const prepare = () => {
      const current = authRef.current
      if (document.visibilityState === 'hidden' || sent || !current) return
      sent = true
      void api.prepareWorkspace(current, controller.signal).catch(() => {})
    }
    prepare()
    document.addEventListener('visibilitychange', prepare)
    return () => {
      controller.abort()
      document.removeEventListener('visibilitychange', prepare)
    }
  }, [authenticated, enabled, userId])
}
