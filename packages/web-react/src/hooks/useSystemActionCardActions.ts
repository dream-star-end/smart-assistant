import { identityIsCurrent, assertResolvedIdentity, type ResolvedIdentity } from '../lib/resolvedIdentity'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { SystemActionCardActions } from '../components/tool/context'
import type { SystemActionsClient, SystemReceiptUiBindings } from '../lib/api/systemActionsApi'
import { AuthEpochStaleError } from '../lib/api/http'
import type { AuthSession } from '../lib/types'
import { useAuthAccessGeneration } from './useAuthAccessGeneration'

export function useSystemActionCardActions(input: {
  authRef: RefObject<AuthSession>
  userId: string | undefined
  identity: ResolvedIdentity | null
  demo: boolean
  onSyncError: () => void
} & SystemReceiptUiBindings): { systemActions: SystemActionCardActions | undefined; preferencesRevision: number; inboxRevision: number } {
  const { authRef, userId, demo, identity } = input
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
    if (demo || !userId || !identityIsCurrent(identity, auth, userId) || !deviceId || generation < 0 || typeof auth.subscribeAccessGeneration !== 'function' || !auth.snapshot().token) return undefined
    const captured = auth.snapshot()
    const currentAuth = () => alive.current && latest.current.userId === userId && latest.current.identity === identity && !latest.current.demo && identityIsCurrent(identity, authRef.current, userId) ? authRef.current : null
    function assertCurrent() {
      if (latest.current.identity !== identity) throw new AuthEpochStaleError()
      assertResolvedIdentity(identity!, authRef.current)
      const now = auth.snapshot()
      if (currentAuth() !== auth || now.epoch !== epoch || now.token !== captured.token || auth.getAccessGeneration() !== generation) throw new AuthEpochStaleError()
    }
    let client: Promise<SystemActionsClient> | undefined
    function getClient(): Promise<SystemActionsClient> {
      assertCurrent()
      // The approval decoder/transport is not part of the first-screen preload graph.
      client ??= import('../lib/api/systemActionsApi').then(({ createSystemActionsApi, createSystemReceiptObserver }) => {
        assertCurrent()
        return createSystemActionsApi({ auth, currentAuth, deviceId: deviceId!, onReceipt: createSystemReceiptObserver({
          getClient,
          currentUi: () => latest.current,
          preferencesChanged: setPreferencesRevision,
          inboxChanged: setInboxRevision,
        }),
          onReceiptError: () => latest.current.onSyncError() })
      }).catch(error => { client = undefined; throw error })
      return client
    }
    return {
      identityKey: `system:${identity!.sequence}`,
      getDetail: async id => (await getClient()).getDetail(id),
      getConfirmation: async id => (await getClient()).getConfirmation(id),
      confirm: async (id, proof) => (await getClient()).confirm(id, proof),
      deny: async id => (await getClient()).deny(id),
      reconcile: async id => (await getClient()).reconcile(id),
    }
  }, [auth, authRef, userId, identity, demo, deviceId, epoch, generation])
  return { systemActions, preferencesRevision, inboxRevision }
}
