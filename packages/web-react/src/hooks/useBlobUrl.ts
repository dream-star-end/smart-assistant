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

/**
 * The downscaled WebP of an image blob at a ticket URL (GET /blobs/:sha/preview, Q2): same ticket,
 * width rounded up server-side to 320 / 640 / 1280. A URL of another shape is returned unchanged.
 */
export function previewUrl(url: string, width: number): string {
  const m = /^(.*\/blobs\/[0-9a-f]{64})\?(.*)$/.exec(url)
  return m ? `${m[1]}/preview?w=${width}&${m[2]}` : url
}

/** Test seam. */
export function __resetBlobTickets(): void {
  tickets.clear()
}

const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 60_000

export function useBlobUrl(auth: AuthSession, sha: string | null | undefined): string | null {
  // The URL is tied to the sha it was issued for: after a sha change the old URL is never returned,
  // so nothing (e.g. a waveform cache keyed by sha) can pair the new sha with old bytes (code r1 P1).
  const [state, setState] = useState<{ sha: string; url: string } | null>(null)
  useEffect(() => {
    if (!sha) {
      setState(null)
      return
    }
    let live = true
    let timer: number | undefined
    let retryMs = RETRY_MIN_MS
    const load = () => {
      blobTicketUrl(auth, sha)
        .then((u) => {
          if (!live) return
          retryMs = RETRY_MIN_MS
          setState({ sha, url: u })
          const hit = tickets.get(key(auth, sha))
          const wait = Math.max(5_000, (hit?.expiresAt ?? 0) - RENEW_MARGIN_MS - Date.now())
          timer = window.setTimeout(load, wait)
        })
        .catch(() => {
          if (!live) return
          // Keep retrying with backoff: a renewal that fails while offline must not end the chain
          // (code r1 P1). The last URL stays usable until it really expires.
          timer = window.setTimeout(load, retryMs)
          retryMs = Math.min(RETRY_MAX_MS, retryMs * 2)
        })
    }
    load()
    return () => {
      live = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [auth, sha])
  return state && state.sha === sha ? state.url : null
}
