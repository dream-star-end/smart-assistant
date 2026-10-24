import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { SystemActionCardActions } from '../components/tool/context'
import type { SystemActionsClient, ReceiptObserver } from '../lib/api/systemActionsApi'
import { AuthEpochStaleError } from '../lib/api/http'
import { applyIntelligentUiSnapshot } from '../lib/intelligentUi'
import { extractPrefs, type PrefsView } from '../lib/modelPreferences'
import type { AuthSession } from '../lib/types'
import type { Theme } from './useTheme'
import { useAuthAccessGeneration } from './useAuthAccessGeneration'

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
  applyInboxUnreadCount?: (count: number) => void
  onSyncError: () => void
}): { systemActions: SystemActionCardActions | undefined; preferencesRevision: number; inboxRevision: number } {
  const { authRef, userId, demo } = input
  const auth = authRef.current
  const latest = useRef(input); latest.current = input
  const alive = useRef(true)
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [deviceId] = useState(() => globalThis.crypto?.randomUUID?.() ?? null)
  const [preferencesRevision, setPreferencesRevision] = useState(0)
  const [inboxRevision, setInboxRevision] = useState(0)
  const generation = useAuthAccessGeneration(auth)
  const epoch = auth.snapshot().epoch
  const systemActions = useMemo<SystemActionCardActions | undefined>(() => {
    if (demo || !userId || !deviceId || generation < 0 || typeof auth.subscribeAccessGeneration !== 'function' || !auth.snapshot().token) return undefined
    const captured = auth.snapshot()
    const currentAuth = () => alive.current && latest.current.userId === userId && !latest.current.demo ? authRef.current : null
    function assertCurrent() {
      const now = auth.snapshot()
      if (currentAuth() !== auth || now.epoch !== epoch || now.token !== captured.token || auth.getAccessGeneration() !== generation) throw new AuthEpochStaleError()
    }
    const completed = new Set<string>()
    const pending = new Map<string, Promise<void>>()
    let tail = Promise.resolve()
    let client: Promise<SystemActionsClient> | undefined
    const onReceipt: ReceiptObserver = (receipt, context) => {
      const preferences = receipt.operationId === 'preferences.update'
      const notifications = receipt.operationId === 'notifications.mark-read' || receipt.operationId === 'notifications.read-all'
      if ((!preferences && !notifications) || receipt.state !== 'succeeded' || completed.has(receipt.id)) return
      const existing = pending.get(receipt.id)
      if (existing) return existing
      const work = tail.then(async () => {
        context.assertCurrent()
        if (notifications) {
          const count = await (await getClient()).getInboxUnreadCountSnapshot()
          context.assertCurrent()
          latest.current.applyInboxUnreadCount?.(count)
          setInboxRevision(n => n + 1)
        } else {
          const snap = await (await getClient()).getPreferencesSnapshot()
          context.assertCurrent()
          const prefs = extractPrefs(snap)
          applyIntelligentUiSnapshot(snap)
          latest.current.applyPreferences(prefs)
          latest.current.setTheme(prefs.theme === 'auto' ? 'system' : prefs.theme ?? 'system')
          setPreferencesRevision(n => n + 1)
        }
        completed.add(receipt.id)
      })
      pending.set(receipt.id, work)
      work.then(() => pending.delete(receipt.id), () => pending.delete(receipt.id))
      tail = work.catch(() => {})
      return work
    }
    function getClient(): Promise<SystemActionsClient> {
      assertCurrent()
      // The approval decoder/transport is not part of the first-screen preload graph.
      client ??= import('../lib/api/systemActionsApi').then(({ createSystemActionsApi }) => {
        assertCurrent()
        return createSystemActionsApi({ auth, currentAuth, deviceId: deviceId!, onReceipt,
          onReceiptError: () => latest.current.onSyncError() })
      }).catch(error => { client = undefined; throw error })
      return client
    }
    return {
      identityKey: `system:${instanceId(auth)}:${userId}:${epoch}:${generation}`,
      getDetail: async id => (await getClient()).getDetail(id),
      getConfirmation: async id => (await getClient()).getConfirmation(id),
      confirm: async (id, proof) => (await getClient()).confirm(id, proof),
      deny: async id => (await getClient()).deny(id),
      reconcile: async id => (await getClient()).reconcile(id),
    }
  }, [auth, authRef, userId, demo, deviceId, epoch, generation])
  return { systemActions, preferencesRevision, inboxRevision }
}
