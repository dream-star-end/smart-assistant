// OCV5-593: a take's media inside a stage box — image, or the first frame of a video. Falls back
// to the textured stage placeholder while the ticket loads or when there is no media yet.

import type { CSSProperties, ReactNode } from 'react'

import { useBlobUrl } from '../../hooks/useBlobUrl'
import type { StudioTake } from '../../lib/studio/types'
import type { AuthSession } from '../../lib/types'

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
  const url = useBlobUrl(props.auth, props.take?.blobSha)
  const video = isVideoTake(props.take)
  return (
    <div
      className={`st-media st-placeholder shade ${props.className ?? ''}`}
      style={{ ...props.style, ...(props.dim ? { filter: 'grayscale(1) brightness(.45)' } : {}) }}
    >
      {url && video ? (
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
        <img className="st-media-fill" src={url} alt="" loading="lazy" decoding="async" />
      ) : null}
      {props.children}
    </div>
  )
}
