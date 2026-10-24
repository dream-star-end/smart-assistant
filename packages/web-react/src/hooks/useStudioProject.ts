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
  const inFlight = useRef(0)

  const reload = useCallback(async () => {
    const mine = ++seq.current
    inFlight.current += 1
    try {
      const view = await studioApi.project(auth, id)
      if (mine === seq.current) setState({ state: 'ready', view })
    } catch (err) {
      if (mine !== seq.current || err instanceof AuthEpochStaleError) return
      if (err instanceof StudioApiError && err.status === 404) setState({ state: 'missing' })
      // Keep showing the last good view on a transient poll failure.
      else setState((cur) => (cur.state === 'ready' ? cur : { state: 'error', error: err }))
    } finally {
      inFlight.current -= 1
    }
  }, [auth, id])

  // A poll tick never starts a second request while one is still out (code r1 P1): on a network
  // slower than the poll period every response would otherwise be superseded and dropped.
  const poll = useCallback(() => {
    if (inFlight.current === 0 && document.visibilityState === 'visible') void reload()
  }, [reload])

  useEffect(() => {
    void reload()
  }, [reload])

  // Also while any take is in flight (e.g. a voice being designed in a draft project, FE-4).
  const active =
    state.state === 'ready' &&
    (ACTIVE_STATUSES.has(state.view.project.status) ||
      state.view.takes.some((t) => t.status === 'queued' || t.status === 'running'))
  useEffect(() => {
    if (!active) return
    const tick = window.setInterval(poll, STUDIO_POLL_MS)
    const onVisible = () => poll()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active, poll])

  /** Apply a server-returned project row (after PATCH / pause …) without a refetch. */
  const applyProject = useCallback((project: StudioProject) => {
    setState((cur) =>
      cur.state === 'ready' ? { state: 'ready', view: { ...cur.view, project } } : cur,
    )
  }, [])

  return { state, reload, applyProject }
}
