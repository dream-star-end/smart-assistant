// OCV5-593 FE-5: one preview player for the whole music page — starting a track stops the one that
// was playing (mockup d10: 试听同时只播一首). Catalog previews play through ordinary blob tickets.

import { useCallback, useEffect, useRef, useState } from 'react'

import { blobTicketUrl } from '../../../hooks/useBlobUrl'
import type { AuthSession } from '../../../lib/types'

export interface Preview {
  playing: string | null
  loading: string | null
  toggle(sha: string): void
}

export function usePreview(auth: AuthSession, onError: (err: unknown) => void): Preview {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const want = useRef<string | null>(null)
  const errRef = useRef(onError)
  errRef.current = onError

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      // Unmount: invalidate a preview still waiting for its ticket and stop the player.
      alive.current = false
      want.current = null
      audio.current?.pause()
      audio.current = null
    }
  }, [])

  const toggle = useCallback(
    (sha: string) => {
      const el = audio.current ?? new Audio()
      audio.current = el
      if (want.current === sha) {
        want.current = null
        el.pause()
        setPlaying(null)
        return
      }
      el.pause()
      want.current = sha
      setPlaying(null)
      setLoading(sha)
      el.onended = () => {
        if (want.current === sha) {
          want.current = null
          setPlaying(null)
        }
      }
      blobTicketUrl(auth, sha)
        .then(async (url) => {
          if (!alive.current || want.current !== sha || audio.current !== el) return
          el.src = url
          await el.play()
          // The page may have gone (or another track started) while play() was pending.
          if (!alive.current || want.current !== sha) {
            el.pause()
            return
          }
          setPlaying(sha)
        })
        .catch((err) => {
          if (!alive.current) return
          if (want.current === sha) want.current = null
          setPlaying(null)
          errRef.current(err)
        })
        .finally(() => {
          if (alive.current) setLoading((cur) => (cur === sha ? null : cur))
        })
    },
    [auth],
  )
  return { playing, loading, toggle }
}
