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

  useEffect(
    () => () => {
      audio.current?.pause()
      audio.current = null
    },
    [],
  )

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
          if (want.current !== sha) return
          el.src = url
          await el.play()
          if (want.current === sha) setPlaying(sha)
        })
        .catch((err) => {
          if (want.current === sha) want.current = null
          setPlaying(null)
          errRef.current(err)
        })
        .finally(() => setLoading((cur) => (cur === sha ? null : cur)))
    },
    [auth],
  )
  return { playing, loading, toggle }
}
