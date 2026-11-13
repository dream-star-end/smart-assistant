// OCV5-593 FE-5: a music source's search results, page by page. Each query starts a new generation;
// a cursor belongs to the generation that returned it and is dropped as soon as the query changes,
// one page loads at a time, and a late answer from an older generation or cursor is ignored
// (code r1 P1: no page from query A appended to query B, no page appended twice).

import { useCallback, useEffect, useRef, useState } from 'react'

import { studioApi } from '../../../lib/studio/api'
import type { MusicQuery, MusicTrack } from '../../../lib/studio/music'
import type { AuthSession } from '../../../lib/types'

export interface PagedSearch {
  tracks: MusicTrack[] | null
  next: string | null
  loading: boolean
  loadingMore: boolean
  more(): void
  reload(): void
}

export function usePagedSearch(
  auth: AuthSession,
  providerId: string,
  query: MusicQuery,
  onError: (err: unknown) => void,
  debounceMs = 0,
): PagedSearch {
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [tick, setTick] = useState(0)
  const gen = useRef(0)
  const pageBusy = useRef(false)
  const nextRef = useRef<{ gen: number; cursor: string } | null>(null)
  const errRef = useRef(onError)
  errRef.current = onError
  const key = JSON.stringify(query)

  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for query; tick forces a reload
  useEffect(() => {
    const mine = ++gen.current
    nextRef.current = null
    setNext(null)
    pageBusy.current = false
    setLoadingMore(false)
    const timer = window.setTimeout(() => {
      setLoading(true)
      studioApi
        .musicSearch(auth, providerId, query)
        .then((r) => {
          if (gen.current !== mine) return
          setTracks(r.tracks)
          nextRef.current = r.next ? { gen: mine, cursor: r.next } : null
          setNext(r.next)
        })
        .catch((err) => {
          if (gen.current !== mine) return
          setTracks((cur) => cur ?? [])
          errRef.current(err)
        })
        .finally(() => {
          if (gen.current === mine) setLoading(false)
        })
    }, debounceMs)
    return () => {
      window.clearTimeout(timer)
      // A query change (or unmount) invalidates everything still in flight.
      gen.current += 1
    }
  }, [auth, providerId, key, debounceMs, tick])

  const more = useCallback(() => {
    const page = nextRef.current
    if (!page || pageBusy.current || page.gen !== gen.current) return
    pageBusy.current = true
    setLoadingMore(true)
    studioApi
      .musicSearch(auth, providerId, { ...JSON.parse(key), cursor: page.cursor })
      .then((r) => {
        if (gen.current !== page.gen || nextRef.current?.cursor !== page.cursor) return
        setTracks((cur) => [...(cur ?? []), ...r.tracks])
        nextRef.current = r.next ? { gen: page.gen, cursor: r.next } : null
        setNext(r.next)
      })
      .catch((err) => {
        if (gen.current === page.gen) errRef.current(err)
      })
      .finally(() => {
        if (gen.current === page.gen) {
          pageBusy.current = false
          setLoadingMore(false)
        }
      })
  }, [auth, providerId, key])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { tracks, next, loading, loadingMore, more, reload }
}
