// OCV5-593: a take's media inside a stage box — image, or the first frame of a video. Falls back
// to the textured stage placeholder while the ticket loads or when there is no media yet.

import { type CSSProperties, type ReactNode, createContext, useContext } from 'react'

import { previewUrl, useBlobUrl } from '../../hooks/useBlobUrl'
import type { StudioTake } from '../../lib/studio/types'
import type { AuthSession } from '../../lib/types'

/**
 * The still a video thumbnail shows instead of loading the clip (Q2); provided by the project
 * shell from the project view (model.posterOf). Without it a thumbnail falls back to the video.
 */
export const PosterContext = createContext<((take: StudioTake) => string | null) | null>(null)

/** Preview width of list thumbnails: sharp at 2x on a ~300 px card. */
const THUMB_WIDTH = 640

export function isVideoTake(take: StudioTake | null): boolean {
  return take?.ownerKind === 'shot_video' || take?.ownerKind === 'final'
}

export function MediaThumb(props: {
  auth: AuthSession
  take: StudioTake | null
  className?: string
  style?: CSSProperties
  dim?: boolean
  children?: ReactNode
}) {
  const posterFor = useContext(PosterContext)
  const video = isVideoTake(props.take)
  const posterSha = video && props.take && posterFor ? posterFor(props.take) : null
  const url = useBlobUrl(props.auth, posterSha ?? props.take?.blobSha)
  return (
    <div
      className={`st-media st-placeholder shade ${props.className ?? ''}`}
      style={{ ...props.style, ...(props.dim ? { filter: 'grayscale(1) brightness(.45)' } : {}) }}
    >
      {url && video && !posterSha ? (
        <video
          className="st-media-fill"
          src={`${url}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          tabIndex={-1}
          aria-hidden="true"
        />
      ) : url ? (
        <img
          className="st-media-fill"
          src={previewUrl(url, THUMB_WIDTH)}
          alt=""
          loading="lazy"
          decoding="async"
        />
      ) : null}
      {props.children}
    </div>
  )
}
