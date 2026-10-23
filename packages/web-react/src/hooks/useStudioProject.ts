// OCV5-593: one project's aggregate view. Polls every 3 s only while the project is planning /
// running / composing and the tab is visible (sys.studio_event push replaces this in A2-1).

import { useCallback, useEffect, useRef, useState } from 'react'

import { AuthEpochStaleError } from '../lib/api'
import { StudioApiError, studioApi } from '../lib/studio/api'
import { ACTIVE_STATUSES, type StudioProject, type StudioProjectView } from '../lib/studio/types'
import type { AuthSession } from '../lib/types'

export const STUDIO_POLL_MS = 3000

export type ProjectState =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'error'; error: unknown }
  | { state: 'ready'; view: StudioProjectView }

export function useStudioProject(auth: AuthSession, id: string) {
  const [state, setState] = useState<ProjectState>({ state: 'loading' })
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const mine = ++seq.current
    try {
      const view = await studioApi.project(auth, id)
      if (mine === seq.current) setState({ state: 'ready', view })
    } catch (err) {
      if (mine !== seq.current || err instanceof AuthEpochStaleError) return
      if (err instanceof StudioApiError && err.status === 404) setState({ state: 'missing' })
      // Keep showing the last good view on a transient poll failure.
      else setState((cur) => (cur.state === 'ready' ? cur : { state: 'error', error: err }))
    }
  }, [auth, id])

  useEffect(() => {
    void reload()
  }, [reload])

  const active = state.state === 'ready' && ACTIVE_STATUSES.has(state.view.project.status)
  useEffect(() => {
    if (!active) return
    const tick = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload()
    }, STUDIO_POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active, reload])

  /** Apply a server-returned project row (after PATCH / pause …) without a refetch. */
  const applyProject = useCallback((project: StudioProject) => {
    setState((cur) =>
      cur.state === 'ready' ? { state: 'ready', view: { ...cur.view, project } } : cur,
    )
  }, [])

  return { state, reload, applyProject }
}
