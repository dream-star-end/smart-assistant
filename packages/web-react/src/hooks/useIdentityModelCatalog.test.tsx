import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { createMemoryAuthSession } from '../lib/authSession'
import * as intelligentUi from '../lib/intelligentUi'
import type { PreferenceEffort, PrefsView } from '../lib/modelPreferences'
import {
  type ResolvedIdentity,
  captureIdentityAttempt,
  resolveIdentity,
  revokeResolvedIdentity,
} from '../lib/resolvedIdentity'
import type { LockedPublicModel, PublicModel } from '../lib/types'
import { catalogOwnerIsCurrent, useIdentityModelCatalog } from './useIdentityModelCatalog'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const catalog = (id: string) =>
  ({ models: [{ id }], lockedModels: [], teamLeaderModelId: id }) as never
function fixture() {
  const auth = createMemoryAuthSession(vi.fn(), 'synthetic-test-only')
  const identity = resolveIdentity(captureIdentityAttempt(auth, 'synthetic-test-only'), 'test-uid')
  const authRef = { current: auth }
  const prefsSpy = vi.spyOn(api, 'getPreferences').mockResolvedValue({ prefs: {} } as never)
  const uiSpy = vi.spyOn(intelligentUi, 'applyIntelligentUiSnapshot')
  function nextIdentity(uid: string) {
    revokeResolvedIdentity(identity)
    const epoch = auth.beginIdentity()
    auth.commitToken(epoch, 'synthetic-next-only')
    return resolveIdentity(captureIdentityAttempt(auth, 'synthetic-next-only'), uid)
  }
  function harness(props: { identity: ResolvedIdentity | null }) {
    const [models, setModels] = useState<PublicModel[]>([])
    const [locked, setLockedModels] = useState<LockedPublicModel[]>([])
    const [owner, setCatalogOwner] = useState<ResolvedIdentity | null>(null)
    const [prefs, setModelPrefs] = useState<PrefsView>({})
    const [effort, setPreferenceEffort] = useState<PreferenceEffort | undefined>()
    const [loading, setModelsLoading] = useState(false)
    const [leader, setTeamLeaderModelId] = useState<string | undefined>()
    useIdentityModelCatalog({
      auth,
      authRef,
      demo: false,
      resolvedIdentity: props.identity,
      setCatalogOwner,
      setModels,
      setLockedModels,
      setModelPrefs,
      setPreferenceEffort,
      setModelsLoading,
      setTeamLeaderModelId,
    })
    return {
      models,
      owner,
      visible: catalogOwnerIsCurrent(owner, props.identity, auth, props.identity?.userId)
        ? models
        : [],
      locked,
      prefs,
      effort,
      loading,
      leader,
    }
  }
  return { auth, identity, nextIdentity, harness, prefsSpy, uiSpy }
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('previous identity model disappears for the new UID while its catalog is pending or 503', async () => {
  const f = fixture()
  const pending = deferred<never>()
  vi.spyOn(api, 'getPublicModels')
    .mockResolvedValueOnce(catalog('box-claude-sonnet-5'))
    .mockReturnValueOnce(pending.promise)
  const view = renderHook(f.harness, {
    initialProps: { identity: f.identity as ResolvedIdentity | null },
  })
  await waitFor(() =>
    expect(view.result.current.visible.map((m) => m.id)).toEqual(['box-claude-sonnet-5']),
  )
  let normal!: ResolvedIdentity
  act(() => {
    normal = f.nextIdentity('normal-uid')
  })
  // A changed AuthSession reference is not required to invalidate the owner.
  expect(catalogOwnerIsCurrent(view.result.current.owner, f.identity, f.auth, 'test-uid')).toBe(
    false,
  )
  view.rerender({ identity: normal })
  expect(view.result.current.visible).toEqual([])
  await act(async () => {
    pending.reject(new Error('503'))
    await pending.promise.catch(() => {})
  })
  expect(view.result.current.visible).toEqual([])
  expect(view.result.current.loading).toBe(false)
})

it('late old-account catalog/preferences cannot commit even before React cleanup has run', async () => {
  const f = fixture()
  const old = deferred<never>()
  vi.spyOn(api, 'getPublicModels')
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(catalog('deepseek-v4-flash'))
  const view = renderHook(f.harness, {
    initialProps: { identity: f.identity as ResolvedIdentity | null },
  })
  const normal = f.nextIdentity('normal-uid')
  await act(async () => {
    old.resolve(catalog('box-claude-sonnet-5'))
    await old.promise
  })
  expect(view.result.current.models).toEqual([])
  expect(f.uiSpy).not.toHaveBeenCalled()
  view.rerender({ identity: normal })
  await waitFor(() =>
    expect(view.result.current.visible.map((m) => m.id)).toEqual(['deepseek-v4-flash']),
  )
  expect(f.uiSpy).toHaveBeenCalledTimes(1)
})

it('pending account acceptance with the same AuthSession keeps old cc5 hidden and accepts only the new catalog', async () => {
  const f = fixture()
  vi.spyOn(api, 'getPublicModels')
    .mockResolvedValueOnce(catalog('box-claude-sonnet-5'))
    .mockResolvedValueOnce(catalog('gpt-5.5'))
  const view = renderHook(f.harness, {
    initialProps: { identity: f.identity as ResolvedIdentity | null },
  })
  await waitFor(() => expect(view.result.current.visible).toHaveLength(1))
  const normal = f.nextIdentity('normal-uid')
  view.rerender({ identity: null })
  expect(view.result.current.visible).toEqual([])
  expect(view.result.current.owner).toBeNull()
  view.rerender({ identity: normal })
  await waitFor(() => expect(view.result.current.visible.map((m) => m.id)).toEqual(['gpt-5.5']))
})

it('a still-current same-UID catalog stays usable during its ordinary background refresh', async () => {
  const f = fixture()
  const pending = deferred<never>()
  vi.spyOn(api, 'getPublicModels')
    .mockResolvedValueOnce(catalog('gpt-5.5'))
    .mockReturnValueOnce(pending.promise)
  const view = renderHook(f.harness, {
    initialProps: { identity: f.identity as ResolvedIdentity | null },
  })
  await waitFor(() => expect(view.result.current.visible).toHaveLength(1))
  const current = resolveIdentity(captureIdentityAttempt(f.auth, 'synthetic-test-only'), 'test-uid')
  revokeResolvedIdentity(f.identity)
  view.rerender({ identity: current })
  expect(view.result.current.visible.map((m) => m.id)).toEqual(['gpt-5.5'])
  expect(view.result.current.loading).toBe(true)
  await act(async () => {
    pending.resolve(catalog('gpt-5.5'))
    await pending.promise
  })
  expect(view.result.current.visible.map((m) => m.id)).toEqual(['gpt-5.5'])
})
