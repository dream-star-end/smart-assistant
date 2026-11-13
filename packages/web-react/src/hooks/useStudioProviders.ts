// OCV5-593: whether the studio is open to this account (GET /api/studio/providers answers 200 only
// for OC_STUDIO_ENABLED + allowlisted users) and the per-kind provider state. Any failure means
// "not available" and is never surfaced as an error. Cached per auth epoch, so an account switch
// in the same tab drops the previous answer (FE plan review P2).

import { useEffect, useState } from 'react'

import { AuthEpochStaleError } from '../lib/api'
import { studioApi } from '../lib/studio/api'
import type { MediaKind, ProviderKindView, ProvidersView } from '../lib/studio/types'
import type { AuthSession } from '../lib/types'

export type StudioAvailability =
  | { state: 'checking' }
  | { state: 'unavailable' }
  | { state: 'available'; providers: ProvidersView }

const cache = new Map<string, Promise<ProvidersView | null>>()

function cacheKey(auth: AuthSession): string {
  const snap = auth.snapshot()
  return `${snap.epoch}`
}

export function probeStudio(auth: AuthSession, force = false): Promise<ProvidersView | null> {
  const key = cacheKey(auth)
  if (force) cache.delete(key)
  let hit = cache.get(key)
  if (!hit) {
    hit = studioApi.providers(auth).catch((err) => {
      cache.delete(key)
      if (err instanceof AuthEpochStaleError) throw err
      return null
    })
    // Only the current epoch is worth keeping.
    for (const k of cache.keys()) if (k !== key) cache.delete(k)
    cache.set(key, hit)
  }
  return hit
}

/** Test seam. */
export function __resetStudioProbeCache(): void {
  cache.clear()
}

export function useStudioAvailability(auth: AuthSession | null | undefined): StudioAvailability {
  const [state, setState] = useState<StudioAvailability>({ state: 'checking' })
  const epoch = auth ? auth.snapshot().epoch : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-probe exactly when the identity changes
  useEffect(() => {
    if (!auth) {
      setState({ state: 'unavailable' })
      return
    }
    let live = true
    setState({ state: 'checking' })
    probeStudio(auth)
      .then((view) => {
        if (live)
          setState(view ? { state: 'available', providers: view } : { state: 'unavailable' })
      })
      .catch(() => {
        if (live) setState({ state: 'unavailable' })
      })
    return () => {
      live = false
    }
  }, [auth, epoch])
  return state
}

export function kindView(
  view: ProvidersView | null | undefined,
  kind: MediaKind,
): ProviderKindView {
  return (
    view?.kinds.find((k) => k.kind === kind) ?? {
      kind,
      state: 'unconfigured',
      reason: 'NO_PROVIDER',
      providers: [],
    }
  )
}
