import { useCallback, useEffect, useRef, useState } from 'react'
import { api, apiErrorMessage } from '../../lib/api'
import type { AuthSession, MarketplaceMyPublish } from '../../lib/types'

const PUBLISH_POLL_MS = 2_000
const TERMINAL_STATUSES = new Set(['approved', 'rejected'])

export type MarketplacePublishTransition = {
  previousStatus: 'pending'
  publish: MarketplaceMyPublish
}

/**
 * Compare one successful snapshot with the next. The first snapshot is a baseline,
 * so opening the market never produces notifications for historical approvals.
 */
export function detectPublishTransitions(
  previous: ReadonlyMap<string, string> | null,
  next: readonly MarketplaceMyPublish[],
  seen: Set<string>,
  mutedVersionIds: ReadonlySet<string>,
): MarketplacePublishTransition[] {
  if (!previous) return []
  const transitions: MarketplacePublishTransition[] = []
  for (const publish of next) {
    if (previous.get(publish.versionId) !== 'pending' || !TERMINAL_STATUSES.has(publish.status)) {
      continue
    }
    const key = `${publish.versionId}:${publish.status}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!mutedVersionIds.has(publish.versionId)) {
      transitions.push({ previousStatus: 'pending', publish })
    }
  }
  return transitions
}

function statusSnapshot(rows: readonly MarketplaceMyPublish[]): Map<string, string> {
  return new Map(rows.map((row) => [row.versionId, row.status]))
}

/**
 * Marketplace-level publish monitor. It remains mounted on every market tab, polls
 * only while a known submission is pending, pauses in hidden tabs, and never runs
 * more than one request at a time. Manual refreshes during an in-flight request are
 * coalesced into one latest follow-up request.
 */
export function useMarketplacePublishes({
  auth,
  enabled,
  onTransition,
}: {
  auth: AuthSession | null
  enabled: boolean
  onTransition: (transition: MarketplacePublishTransition) => void
}) {
  const [rows, setRows] = useState<MarketplaceMyPublish[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestNowRef = useRef<() => void>(() => {})
  const mutedVersionIdsRef = useRef(new Set<string>())
  const onTransitionRef = useRef(onTransition)

  useEffect(() => {
    onTransitionRef.current = onTransition
  }, [onTransition])

  const refresh = useCallback(() => requestNowRef.current(), [])
  const muteTransition = useCallback((versionId: string, muted: boolean) => {
    if (muted) mutedVersionIdsRef.current.add(versionId)
    else mutedVersionIdsRef.current.delete(versionId)
  }, [])

  useEffect(() => {
    if (!enabled || !auth) {
      requestNowRef.current = () => {}
      mutedVersionIdsRef.current.clear()
      setRows(null)
      setLoading(false)
      setError(null)
      return
    }
    const session = auth

    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight = false
    let rerun = false
    let requestSeq = 0
    let latestAppliedSeq = 0
    let previous: Map<string, string> | null = null
    let hasPending = false
    let retryAfterFailure = false
    const seen = new Set<string>()
    mutedVersionIdsRef.current.clear()
    setLoading(true)
    setError(null)

    const clearTimer = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }

    const schedule = () => {
      clearTimer()
      if (
        !alive ||
        (previous !== null && !hasPending && !retryAfterFailure) ||
        document.visibilityState === 'hidden'
      ) {
        return
      }
      timer = setTimeout(() => void request(), PUBLISH_POLL_MS)
    }

    async function request() {
      if (!alive || document.visibilityState === 'hidden') return
      clearTimer()
      if (inFlight) {
        rerun = true
        return
      }
      inFlight = true
      const seq = ++requestSeq
      try {
        const next = await api.listMarketplaceMyPublishes(session)
        if (!alive || seq < latestAppliedSeq) return
        latestAppliedSeq = seq
        const transitions = detectPublishTransitions(
          previous,
          next,
          seen,
          mutedVersionIdsRef.current,
        )
        previous = statusSnapshot(next)
        hasPending = next.some((row) => row.status === 'pending')
        retryAfterFailure = false
        setRows(next)
        setError(null)
        for (const transition of transitions) onTransitionRef.current(transition)
      } catch (cause) {
        if (alive) {
          retryAfterFailure = true
          setError(apiErrorMessage(cause, '加载发布状态失败'))
        }
      } finally {
        if (!alive) return
        inFlight = false
        setLoading(false)
        if (rerun) {
          rerun = false
          void request()
        } else {
          schedule()
        }
      }
    }

    requestNowRef.current = () => {
      clearTimer()
      void request()
    }

    const refreshIfVisible = () => {
      if (document.visibilityState !== 'hidden') requestNowRef.current()
      else clearTimer()
    }
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    refreshIfVisible()

    return () => {
      alive = false
      clearTimer()
      requestNowRef.current = () => {}
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [auth, enabled])

  return { rows, loading, error, refresh, muteTransition }
}
