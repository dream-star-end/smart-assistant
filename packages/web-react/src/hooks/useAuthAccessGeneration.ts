import { useCallback, useSyncExternalStore } from 'react'
import type { AuthSession } from '../lib/types'

/** One subscribed fence for token refresh, logout and account changes. Legacy fixtures fail closed. */
export function useAuthAccessGeneration(auth: AuthSession | null): number {
  const subscribe = useCallback((listener: () => void) => typeof auth?.subscribeAccessGeneration === 'function' ? auth.subscribeAccessGeneration(listener) : () => {}, [auth])
  const getGeneration = useCallback(() => typeof auth?.getAccessGeneration === 'function' ? auth.getAccessGeneration() : -1, [auth])
  return useSyncExternalStore(subscribe, getGeneration, getGeneration)
}
