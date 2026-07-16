import { useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import type { AuthSession } from '../../lib/types'

export const MARKETPLACE_REVISION_POLL_MS = 5_000

/**
 * Cross-client marketplace invalidation monitor. The first successful token is
 * a baseline; later unequal tokens refresh catalog consumers. It pauses in a
 * hidden tab and never overlaps requests.
 */
export function useMarketplaceRevision({
  auth,
  enabled,
  onChange,
}: {
  auth: AuthSession | null
  enabled: boolean
  onChange: () => void
}): void {
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!enabled || !auth) return
    const session = auth
    let alive = true
    let inFlight = false
    let revision: string | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const schedule = () => {
      clearTimer()
      if (!alive || document.visibilityState === 'hidden') return
      timer = setTimeout(() => void request(), MARKETPLACE_REVISION_POLL_MS)
    }
    async function request() {
      if (!alive || inFlight || document.visibilityState === 'hidden') return
      clearTimer()
      inFlight = true
      try {
        const next = (await api.getMarketplaceRevision(session)).revision
        if (!alive) return
        if (revision !== null && next !== revision) onChangeRef.current()
        revision = next
      } catch {
        // Invalidation is best-effort. Existing focus and publish polling remain
        // available, and the next interval retries without disturbing the UI.
      } finally {
        inFlight = false
        schedule()
      }
    }
    const refreshIfVisible = () => {
      if (document.visibilityState === 'hidden') clearTimer()
      else void request()
    }
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    refreshIfVisible()
    return () => {
      alive = false
      clearTimer()
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [auth, enabled])
}
