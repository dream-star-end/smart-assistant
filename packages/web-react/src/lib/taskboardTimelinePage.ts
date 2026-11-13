import { ApiError, AuthEpochStaleError } from './api'
import { boardGet, taskboardApi, type TimelineItem } from './taskboard'
import type { AuthSession } from './types'

export type TimelinePage = {
  window: 'latest-v1' | 'legacy'
  items: TimelineItem[]
  hasMore: boolean
  nextBefore: string | null
  head: string | null
  unchanged: boolean
}

/** Kept behind taskboard's lazy boundary; old runtimes remain readable. */
export async function loadTimelinePage(
  auth: AuthSession,
  id: string,
  options: { before?: string; ifHead?: string } = {},
): Promise<TimelinePage> {
  const query = new URLSearchParams({ window: 'latest', limit: '100' })
  if (options.before) query.set('before', options.before)
  if (options.ifHead) query.set('ifHead', options.ifHead)
  try {
    const page = await boardGet<TimelinePage>(
      auth,
      `/api/board/tickets/${encodeURIComponent(id)}/timeline?${query}`,
    )
    if (
      page.window === 'latest-v1' &&
      Array.isArray(page.items) &&
      page.items.length <= 500 &&
      typeof page.hasMore === 'boolean' &&
      typeof page.unchanged === 'boolean' &&
      (page.nextBefore === null || typeof page.nextBefore === 'string') &&
      (page.head === null || typeof page.head === 'string') &&
      (!page.hasMore || (typeof page.nextBefore === 'string' && page.nextBefore.length > 0)) &&
      (!page.unchanged ||
        (page.items.length === 0 && !!options.ifHead && page.head === options.ifHead))
    )
      return page
  } catch (error) {
    if (
      error instanceof AuthEpochStaleError ||
      (error instanceof ApiError && (error.status === 401 || error.status === 403)) ||
      options.before
    )
      throw error
  }
  if (options.before) throw new Error('暂时无法继续加载历史，请稍后重试')
  return {
    window: 'legacy',
    items: await taskboardApi.listTimeline(auth, id),
    hasMore: false,
    nextBefore: null,
    head: null,
    unchanged: false,
  }
}
