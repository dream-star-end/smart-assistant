// OCV5-593 FE-6: studio activity pushed over the chat socket (`sys.studio_event`, OCV5-591
// A2-1c-2) reaches the open project page as a window event. A push is only a hint to reload the
// project view; polling stays as the fallback.

export const STUDIO_PUSH_EVENT = 'oc:studio-push'

export interface StudioPushDetail {
  /** The project that changed; null when the socket (re)opened and anything may have changed. */
  projectId: string | null
}

export function emitStudioPush(projectId: string | null): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<StudioPushDetail>(STUDIO_PUSH_EVENT, { detail: { projectId } }),
  )
}

/** Subscribe to pushes; returns the unsubscribe. */
export function onStudioPush(fn: (detail: StudioPushDetail) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<StudioPushDetail>).detail
    if (detail && (detail.projectId === null || typeof detail.projectId === 'string')) fn(detail)
  }
  window.addEventListener(STUDIO_PUSH_EVENT, listener)
  return () => window.removeEventListener(STUDIO_PUSH_EVENT, listener)
}
