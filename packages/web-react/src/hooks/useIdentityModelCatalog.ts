/** A catalog belongs to verified identity evidence, never to an AuthSession reference alone. */
import { useEffect } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { api } from '../lib/api'
import { applyIntelligentUiSnapshot } from '../lib/intelligentUi'
import { type PreferenceEffort, type PrefsView, extractPrefs } from '../lib/modelPreferences'
import { type ResolvedIdentity, identityIsCurrent } from '../lib/resolvedIdentity'
import type { AuthSession, LockedPublicModel, PublicModel } from '../lib/types'

export type IdentityModelCatalogInput = {
  auth: AuthSession | null
  authRef: RefObject<AuthSession>
  demo: boolean
  resolvedIdentity: ResolvedIdentity | null
  setCatalogOwner: Dispatch<SetStateAction<ResolvedIdentity | null>>
  setModels: Dispatch<SetStateAction<PublicModel[]>>
  setLockedModels: Dispatch<SetStateAction<LockedPublicModel[]>>
  setModelPrefs: Dispatch<SetStateAction<PrefsView>>
  setPreferenceEffort: Dispatch<SetStateAction<PreferenceEffort | undefined>>
  setModelsLoading: Dispatch<SetStateAction<boolean>>
  setTeamLeaderModelId: Dispatch<SetStateAction<string | undefined>>
}

export function catalogOwnerIsCurrent(
  owner: ResolvedIdentity | null,
  identity: ResolvedIdentity | null,
  auth: AuthSession | null,
  userId: string | undefined,
): boolean {
  return (
    !!owner &&
    !!identity &&
    !!auth &&
    identityIsCurrent(identity, auth, userId) &&
    owner.userId === identity.userId &&
    owner.epoch === identity.epoch &&
    owner.generation === identity.generation
  )
}

export function useIdentityModelCatalog(input: IdentityModelCatalogInput): void {
  const {
    auth,
    authRef,
    demo,
    resolvedIdentity: identity,
    setCatalogOwner,
    setModels,
    setLockedModels,
    setModelPrefs,
    setPreferenceEffort,
    setModelsLoading,
    setTeamLeaderModelId,
  } = input
  useEffect(() => {
    if (demo) return
    if (!auth || !identity) {
      setCatalogOwner(null)
      setTeamLeaderModelId(undefined)
      setModelsLoading(false)
      return
    }
    let cancelled = false
    const current = (): boolean =>
      !cancelled && authRef.current === auth && identityIsCurrent(identity, auth, identity.userId)
    if (!current()) return
    setModelsLoading(true)
    Promise.all([api.getPublicModels(auth), api.getPreferences(auth).catch(() => undefined)])
      .then(([catalog, snapshot]) => {
        if (!current()) return
        if (snapshot) applyIntelligentUiSnapshot(snapshot)
        const prefs = snapshot ? extractPrefs(snapshot) : ({} as PrefsView)
        setModels(catalog.models)
        setLockedModels(catalog.lockedModels)
        setTeamLeaderModelId(catalog.teamLeaderModelId)
        setModelPrefs(prefs)
        setPreferenceEffort(prefs.default_effort)
        setCatalogOwner(identity)
      })
      .catch(() => {
        /* Keep only a same-owner cache; App masks all other owners immediately. */
      })
      .finally(() => {
        if (current()) setModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    auth,
    authRef,
    demo,
    identity,
    setCatalogOwner,
    setModels,
    setLockedModels,
    setModelPrefs,
    setPreferenceEffort,
    setModelsLoading,
    setTeamLeaderModelId,
  ])
}
