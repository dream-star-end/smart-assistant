import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import type { SystemActionCardActions } from '../components/tool/context'
import { createSystemActionsApi, type SystemActionsClient } from '../lib/api/systemActionsApi'
import { applyIntelligentUiSnapshot } from '../lib/intelligentUi'
import { extractPrefs, type PrefsView } from '../lib/modelPreferences'
import type { AuthSession } from '../lib/types'
import type { Theme } from './useTheme'

const instanceIds = new WeakMap<AuthSession, number>()
let nextInstanceId = 0
function instanceId(auth: AuthSession): number {
  let id = instanceIds.get(auth)
  if (id === undefined) { id = ++nextInstanceId; instanceIds.set(auth, id) }
  return id
}
export function useSystemActionCardActions(input: {
  authRef: RefObject<AuthSession>
  userId: string | undefined
  demo: boolean
  applyPreferences: (prefs: PrefsView) => void
  setTheme: (theme: Theme) => void
  onSyncError: () => void
}): { systemActions: SystemActionCardActions | undefined; preferencesRevision: number } {
  const { authRef, userId, demo } = input
  const auth = authRef.current
  const latest = useRef(input); latest.current = input
  const alive = useRef(true)
  useLayoutEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const [deviceId] = useState(() => globalThis.crypto?.randomUUID?.() ?? null)
  const [preferencesRevision, setPreferencesRevision] = useState(0)
  const subscribe = useCallback((listener: () => void) => typeof auth.subscribeAccessGeneration === 'function'
    ? auth.subscribeAccessGeneration(listener) : () => {}, [auth])
  const getGeneration = useCallback(() => typeof auth.getAccessGeneration === 'function' ? auth.getAccessGeneration() : -1, [auth])
  const generation = useSyncExternalStore(subscribe, getGeneration, getGeneration)
  const epoch = auth.snapshot().epoch
  const systemActions = useMemo(() => {
    if (demo || !userId || !deviceId || generation < 0 || typeof auth.subscribeAccessGeneration !== 'function' || !auth.snapshot().token) return undefined
    const completed = new Set<string>()
    const pending = new Map<string, Promise<void>>()
    let tail = Promise.resolve()
    const client: SystemActionsClient = createSystemActionsApi({
      auth, currentAuth: () => alive.current && latest.current.userId === userId && !latest.current.demo ? authRef.current : null, deviceId,
      onReceipt: (receipt, { assertCurrent }) => {
        if (receipt.operationId !== 'preferences.update' || receipt.state !== 'succeeded' || completed.has(receipt.id)) return
        const existing = pending.get(receipt.id)
        if (existing) return existing
        const work = tail.then(async () => {
          assertCurrent()
          const snap = await client.getPreferencesSnapshot()
          assertCurrent()
          const prefs = extractPrefs(snap)
          applyIntelligentUiSnapshot(snap)
          latest.current.applyPreferences(prefs)
          latest.current.setTheme(prefs.theme === 'auto' ? 'system' : prefs.theme ?? 'system')
          setPreferencesRevision(n => n + 1)
          completed.add(receipt.id)
        })
        pending.set(receipt.id, work)
        work.then(() => pending.delete(receipt.id), () => pending.delete(receipt.id))
        tail = work.catch(() => {})
        return work
      },
      onReceiptError: () => latest.current.onSyncError(),
    })
    return { ...client, identityKey: `system:${instanceId(auth)}:${userId}:${epoch}:${generation}` }
  }, [auth, authRef, userId, demo, deviceId, epoch, generation])
  return { systemActions, preferencesRevision }
}
