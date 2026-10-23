// OCV5-593: a studio blob as an <img>/<video>/<audio> URL. Tickets are bound to user + sha and last
// 15 minutes; they are cached in memory per auth epoch (never in storage) and renewed a minute
// before they expire.

import { useEffect, useState } from 'react'

import { studioApi } from '../lib/studio/api'
import type { AuthSession } from '../lib/types'

const RENEW_MARGIN_MS = 60_000
const tickets = new Map<string, { url: string; expiresAt: number; pending?: Promise<string> }>()

function key(auth: AuthSession, sha: string): string {
  return `${auth.snapshot().epoch}:${sha}`
}

export function blobTicketUrl(auth: AuthSession, sha: string, now = Date.now()): Promise<string> {
  const k = key(auth, sha)
  const hit = tickets.get(k)
  if (hit?.pending) return hit.pending
  if (hit && hit.expiresAt - RENEW_MARGIN_MS > now) return Promise.resolve(hit.url)
  const pending = studioApi
    .blobTicket(auth, sha)
    .then((t) => {
      tickets.set(k, { url: t.url, expiresAt: Date.now() + t.expiresInSeconds * 1000 })
      return t.url
    })
    .catch((err) => {
      tickets.delete(k)
      throw err
    })
  tickets.set(k, { url: hit?.url ?? '', expiresAt: hit?.expiresAt ?? 0, pending })
  return pending
}

/** Test seam. */
export function __resetBlobTickets(): void {
  tickets.clear()
}

export function useBlobUrl(auth: AuthSession, sha: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!sha) {
      setUrl(null)
      return
    }
    let live = true
    let timer: number | undefined
    const load = () => {
      blobTicketUrl(auth, sha)
        .then((u) => {
          if (!live) return
          setUrl(u)
          const hit = tickets.get(key(auth, sha))
          const wait = Math.max(5_000, (hit?.expiresAt ?? 0) - RENEW_MARGIN_MS - Date.now())
          timer = window.setTimeout(load, wait)
        })
        .catch(() => {
          if (live) setUrl(null)
        })
    }
    load()
    return () => {
      live = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [auth, sha])
  return url
}
