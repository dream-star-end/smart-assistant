import { useMemo, useSyncExternalStore } from 'react'
import { taskboardApi, type TicketRun, type TimelineItem } from '../../lib/taskboard'
import type { TimelinePage } from '../../lib/taskboardTimelinePage'
import type { AuthSession } from '../../lib/types'

type Key = { at: number; rank: number; id: string }
type Gap = { id: number; before: string; stopAt: Key | null }
type FetchPage = (
  id: string,
  options?: { before?: string; ifHead?: string },
) => Promise<TimelinePage>
const ranks = { activity: 0, comment: 1, run: 2 }
function key(item: TimelineItem): Key {
  return {
    at: item.createdAt,
    rank: ranks[item.kind],
    id:
      item.kind === 'run'
        ? item.run.id
        : item.kind === 'comment'
          ? item.comment.id
          : item.activity.id,
  }
}
function compare(a: Key, b: Key): number {
  if (a.at !== b.at) return a.at - b.at
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.id === b.id) return 0
  const left = [...a.id]
  const right = [...b.id]
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const diff = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!
    if (diff) return diff
  }
  return left.length - right.length
}
const identity = (item: TimelineItem) => `${item.kind}:${key(item).id}`
const terminal = (run: TicketRun) => run.status !== 'queued' && run.status !== 'running'
function mergeItem(previous: TimelineItem | undefined, incoming: TimelineItem): TimelineItem {
  if (!previous) return incoming
  if (previous.kind === 'run' && incoming.kind === 'run') {
    const old = previous.run
    const next = incoming.run
    const models = [...new Set([...(old.actualModels ?? []), ...(next.actualModels ?? [])])]
    if (terminal(old) && !terminal(next))
      return { ...previous, run: { ...old, actualModels: models } }
    const preserveCost = next.costUsd == null && old.costUsd != null
    return {
      ...incoming,
      run: {
        ...next,
        outputMd: next.outputMd ?? old.outputMd,
        summary: next.summary ?? old.summary,
        actualModels: models,
        costUsd: preserveCost ? old.costUsd : next.costUsd,
        costImprecise: preserveCost ? old.costImprecise : next.costImprecise,
        settling: terminal(old) && old.settling === false ? false : next.settling,
      },
    }
  }
  return incoming
}

/** Server coverage is tracked separately from the independently hydrated current run. */
export class TimelineHistory {
  readonly resultRequests = new Map<string, Promise<void>>()
  readonly resultFailures = new Map<string, TicketRun>()
  private readonly records = new Map<string, TimelineItem>()
  private readonly covered = new Set<string>()
  private readonly pages = new WeakMap<TimelineItem[], TimelinePage>()
  private readonly listeners = new Set<() => void>()
  private gaps: Gap[] = []
  private newest: Key | null = null
  private head: string | null = null
  private sequence = 0
  private initialized = false
  private supported = false
  private loading = false
  private error = ''
  snapshot = {
    initialized: false,
    supported: false,
    hasMore: false,
    hasGap: false,
    gaps: 0,
    loading: false,
    error: '',
  }
  constructor(private readonly fetchPage: FetchPage) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish() {
    this.snapshot = {
      initialized: this.initialized,
      supported: this.supported,
      hasMore: this.gaps.length > 0,
      hasGap: this.gaps.some((gap) => gap.stopAt !== null),
      gaps: this.gaps.length,
      loading: this.loading,
      error: this.error,
    }
    for (const listener of this.listeners) listener()
  }
  rows(): TimelineItem[] {
    return [...this.records.values()].sort((a, b) => compare(key(a), key(b)))
  }
  private put(items: readonly TimelineItem[]) {
    for (const item of items)
      this.records.set(identity(item), mergeItem(this.records.get(identity(item)), item))
  }
  private cover(items: readonly TimelineItem[]) {
    for (const item of items) {
      this.covered.add(identity(item))
      const next = key(item)
      if (!this.newest || compare(next, this.newest) > 0) this.newest = next
    }
    this.put(items)
  }
  async fetchLatest(id: string): Promise<TimelineItem[]> {
    const page = await this.fetchPage(id, this.head ? { ifHead: this.head } : {})
    this.pages.set(page.items, page)
    return page.items
  }
  acceptLatest(items: TimelineItem[]): TimelineItem[] {
    const page = this.pages.get(items)
    if (!page) {
      this.put(items)
      if (!this.initialized) {
        this.initialized = true
        this.publish()
      }
      return this.rows()
    }
    if (page.unchanged) return this.rows()
    if (page.window === 'latest-v1') {
      const keys = items.map(key).sort(compare)
      const first = keys[0]
      if (!this.initialized || !this.supported || !this.newest) {
        this.gaps =
          page.hasMore && page.nextBefore
            ? [{ id: ++this.sequence, before: page.nextBefore, stopAt: null }]
            : []
      } else if (!page.hasMore) this.gaps = []
      else if (
        first &&
        this.newest &&
        compare(first, this.newest) > 0 &&
        !items.some((item) => this.covered.has(identity(item))) &&
        page.nextBefore
      ) {
        this.gaps.unshift({ id: ++this.sequence, before: page.nextBefore, stopAt: this.newest })
      }
      this.head = page.head
      this.supported = true
      this.cover(items)
    } else {
      this.put(items)
      this.supported = false
    }
    this.initialized = true
    this.error = ''
    this.publish()
    return this.rows()
  }
  fullRun(id: string): TicketRun | undefined {
    const item = this.records.get(`run:${id}`)
    return item?.kind === 'run' && terminal(item.run) && !item.run.settling ? item.run : undefined
  }
  acceptWrite(item: TimelineItem): void {
    this.put([item])
  }
  acceptRun(run: TicketRun): TimelineItem[] {
    this.put([{ kind: 'run', createdAt: run.createdAt, run }])
    return this.rows()
  }
  async loadEarlier(id: string): Promise<TimelineItem[]> {
    if (this.loading || !this.gaps.length) return this.rows()
    const gap = this.gaps[0]!
    this.loading = true
    this.error = ''
    this.publish()
    try {
      const page = await this.fetchPage(id, { before: gap.before })
      if (
        page.window !== 'latest-v1' ||
        (page.hasMore && (!page.items.length || page.nextBefore === gap.before))
      )
        throw new Error('历史分页暂不可用')
      const position = this.gaps.findIndex((item) => item.id === gap.id)
      if (position >= 0) {
        const first = page.items.map(key).sort(compare)[0]
        if (!page.hasMore || !page.nextBefore) this.gaps.splice(position)
        else if (gap.stopAt && first && compare(first, gap.stopAt) <= 0)
          this.gaps.splice(position, 1)
        else this.gaps[position] = { ...gap, before: page.nextBefore }
      }
      this.cover(page.items)
      return this.rows()
    } catch (error) {
      this.error = '历史暂时未加载，请重试'
      throw error
    } finally {
      this.loading = false
      this.publish()
    }
  }
}

export function useTimelineHistory(auth: AuthSession, owner: string | null) {
  const controller = useMemo(
    () =>
      new TimelineHistory((id, options) => {
        if (!owner) return Promise.reject(new Error('未选择单据'))
        return taskboardApi.listTimelinePage(auth, id, options)
      }),
    [auth, owner],
  )
  const snapshot = useSyncExternalStore(controller.subscribe, () => controller.snapshot)
  return [controller, snapshot] as const
}
