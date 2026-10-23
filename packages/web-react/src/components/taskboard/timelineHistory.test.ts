import { describe, expect, test, vi } from 'vitest'
import type { TimelineItem, TicketRun } from '../../lib/taskboard'
import type { TimelinePage } from '../../lib/taskboardTimelinePage'
import { TimelineHistory } from './timelineHistory'

const comment = (index: number): TimelineItem => ({
  kind: 'comment',
  createdAt: index,
  comment: {
    id: `c${index}`,
    ticketId: 'ticket',
    authorKind: 'human',
    author: 'user:765',
    body: `Comment ${index}`,
    runId: null,
    createdAt: index,
  },
})
const page = (
  from: number,
  to: number,
  nextBefore: string | null,
  unchanged = false,
): TimelinePage => ({
  window: 'latest-v1',
  items: unchanged
    ? []
    : Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => comment(from + i)),
  head: `revision-${from}-${to}`,
  hasMore: !!nextBefore,
  nextBefore,
  unchanged,
})
const accept = async (history: TimelineHistory) =>
  history.acceptLatest(await history.fetchLatest('ticket'))
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function run(over: Partial<TicketRun> = {}): TicketRun {
  return {
    id: 'run',
    ticketId: 'ticket',
    stageId: 'stage',
    agentId: 'main',
    status: 'failed',
    createdAt: 5000,
    startedAt: 5000,
    finishedAt: 6000,
    outputMd: 'FULL_PAID_OUTPUT_END',
    actualModels: ['actual-a'],
    settling: false,
    costUsd: 0.02,
    costImprecise: true,
    ...over,
  } as TicketRun
}

describe('timeline history coverage', () => {
  test('keeps earlier pages and bridges a new latest-window gap before advancing the oldest cursor', async () => {
    let latestCalls = 0
    const fetch = vi.fn(async (_id: string, options?: { before?: string }) => {
      if (!options?.before)
        return ++latestCalls === 1 ? page(81, 100, 'b81') : page(101, 120, 'b101')
      if (options.before === 'b81') return page(61, 80, 'b61')
      if (options.before === 'b101') return page(81, 100, 'b81')
      return page(1, 60, null)
    })
    const history = new TimelineHistory(fetch)
    await accept(history)
    await history.loadEarlier('ticket')
    await accept(history)
    expect(history.snapshot.gaps).toBe(2)
    await history.loadEarlier('ticket')
    expect(fetch.mock.calls.at(-1)?.[1]?.before).toBe('b101')
    expect(history.snapshot.gaps).toBe(1)
    const all = await history.loadEarlier('ticket')
    expect(fetch.mock.calls.at(-1)?.[1]?.before).toBe('b61')
    expect(all.map((item) => item.createdAt)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1))
    expect(history.snapshot.hasMore).toBe(false)
  })

  test('a latest refresh during an older fetch cannot overwrite the newly discovered gap', async () => {
    const hold = deferred<TimelinePage>()
    let latest = page(81, 100, 'b81')
    const fetch = vi.fn(async (_id: string, options?: { before?: string }) =>
      options?.before ? hold.promise : latest,
    )
    const history = new TimelineHistory(fetch)
    await accept(history)
    const loading = history.loadEarlier('ticket')
    latest = page(201, 220, 'b201')
    await accept(history)
    hold.resolve(page(61, 80, 'b61'))
    await loading
    expect(history.snapshot.gaps).toBe(2)
    const next = history.loadEarlier('ticket')
    expect(fetch.mock.calls.at(-1)?.[1]?.before).toBe('b201')
    await next
  })

  test('a formerly empty timeline still exposes older records after more than one window arrives', async () => {
    let latest = page(1, 0, null)
    const history = new TimelineHistory(async () => latest)
    await accept(history)
    latest = page(201, 220, 'b201')
    await accept(history)
    expect(history.snapshot.hasMore).toBe(true)
  })

  test('unchanged window responses preserve loaded history and the older cursor', async () => {
    let latest = page(81, 100, 'b81')
    const fetch = vi.fn(async (_id: string, options?: { before?: string }) =>
      options?.before ? page(61, 80, 'b61') : latest,
    )
    const history = new TimelineHistory(fetch)
    await accept(history)
    await history.loadEarlier('ticket')
    latest = page(81, 100, 'b81', true)
    const rows = await accept(history)
    expect(rows).toHaveLength(40)
    await history.loadEarlier('ticket')
    expect(fetch.mock.calls.at(-1)?.[1]?.before).toBe('b61')
  })

  test('independent current run hydration neither hides history gaps nor loses paid output to stale pages', async () => {
    let latest: TimelinePage = page(81, 100, 'b81')
    const history = new TimelineHistory(async () => latest)
    history.acceptRun(run())
    await accept(history)
    latest = page(201, 220, 'b201')
    await accept(history)
    expect(history.snapshot.gaps).toBe(2)
    latest = {
      ...page(1, 0, null),
      items: [
        {
          kind: 'run',
          createdAt: 5000,
          run: run({
            status: 'running',
            outputMd: null,
            costUsd: null,
            costImprecise: false,
            actualModels: ['actual-b'],
            settling: true,
          }),
        },
      ],
    }
    await accept(history)
    const full = history.fullRun('run')!
    expect(full.status).toBe('failed')
    expect(full.outputMd).toBe('FULL_PAID_OUTPUT_END')
    expect(full.actualModels).toEqual(['actual-a', 'actual-b'])
    expect(full.costUsd).toBe(0.02)
    expect(full.costImprecise).toBe(true)
    expect(full.settling).toBe(false)
  })

  test('failed or non-advancing pagination stays retryable at the same cursor', async () => {
    let fail = true
    const fetch = vi.fn(async (_id: string, options?: { before?: string }) => {
      if (!options?.before) return page(81, 100, 'b81')
      if (fail) throw new Error('offline')
      return page(1, 80, null)
    })
    const history = new TimelineHistory(fetch)
    await accept(history)
    await expect(history.loadEarlier('ticket')).rejects.toThrow('offline')
    expect(history.snapshot.hasMore).toBe(true)
    expect(history.snapshot.loading).toBe(false)
    fail = false
    await history.loadEarlier('ticket')
    expect(fetch.mock.calls.at(-1)?.[1]?.before).toBe('b81')
    expect(history.rows()).toHaveLength(100)
  })
})

test('a formerly complete same-time run window exposes a lower-rank comment behind its cursor', async () => {
  const runs: TimelineItem[] = Array.from({ length: 100 }, (_, i) => ({
    kind: 'run',
    createdAt: 100,
    run: run({ id: `r-${i}`, createdAt: 100 }),
  }))
  const inserted: TimelineItem = {
    kind: 'comment',
    createdAt: 100,
    comment: {
      id: 'lower-rank',
      ticketId: 'ticket',
      authorKind: 'human',
      author: 'user:765',
      body: 'SAME_TIME_LOWER_COMMENT',
      createdAt: 100,
      runId: null,
    },
  }
  let latest: TimelinePage = {
    window: 'latest-v1',
    items: runs,
    hasMore: false,
    nextBefore: null,
    head: 'complete',
    unchanged: false,
  }
  const history = new TimelineHistory(async (_id, options) =>
    options?.before
      ? {
          window: 'latest-v1',
          items: [inserted],
          hasMore: false,
          nextBefore: null,
          head: 'older',
          unchanged: false,
        }
      : latest,
  )
  await accept(history)
  expect(history.snapshot.hasMore).toBe(false)
  latest = { ...latest, hasMore: true, nextBefore: 'below-runs', head: 'new-lower-record' }
  await accept(history)
  expect(history.snapshot.hasMore).toBe(true)
  const rows = await history.loadEarlier('ticket')
  expect(rows).toHaveLength(101)
  expect(rows[0]).toEqual(inserted)
  expect(history.snapshot.hasMore).toBe(false)
})
