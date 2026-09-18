import { installDelegateSandbox } from './helpers/delegateSandbox.js'
const sandbox = installDelegateSandbox()

/**
 * W1: wait sleep continuation must not touch durable SQLite after settle/close.
 *
 * Run: node --import tsx --test packages/gateway/src/__tests__/waitClose.test.ts
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { DelegateDurableDb } from '../delegateDurable.js'
import {
  DelegateJobStore,
  resolveDelegateWaitMs,
  type DelegateJobWaitView,
} from '../delegateJobs.js'

const DONE_BODY = { ok: true, agentId: 'coding-assistant', output: 'wait-close-done' }

type JobBag = { jobs: Map<string, { waiters: unknown[] }> }

function waiterCount(store: DelegateJobStore, jobId: string): number {
  return (store as unknown as JobBag).jobs.get(jobId)?.waiters.length ?? 0
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (err: unknown) => void
} {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await Promise.resolve()
}

async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const onUnhandled = (err: unknown) => {
    seen.push(err)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await run()
    await flush()
    return seen
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

function instrumentGets(durable: DelegateDurableDb): {
  markClosed(): void
  get lateReads(): number
  get totalReads(): number
} {
  const orig = durable.get.bind(durable)
  let closed = false
  let lateReads = 0
  let totalReads = 0
  durable.get = (jobId: string) => {
    totalReads += 1
    if (closed) lateReads += 1
    return orig(jobId)
  }
  return {
    markClosed() {
      closed = true
    },
    get lateReads() {
      return lateReads
    },
    get totalReads() {
      return totalReads
    },
  }
}

const liveStores: DelegateJobStore[] = []

afterEach(() => {
  for (const store of liveStores.splice(0)) {
    try {
      store.close()
    } catch {
      /* already closed */
    }
  }
})

function openStore(opts: {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
} = {}): { store: DelegateJobStore; durable: DelegateDurableDb; gets: ReturnType<typeof instrumentGets> } {
  const dbPath = join(sandbox.root, 'state', 'wait-close.db')
  const durable = new DelegateDurableDb(dbPath)
  sandbox.assertOwnedPath(dbPath)
  const gets = instrumentGets(durable)
  const store = new DelegateJobStore({
    sm: true,
    ttlMs: 60_000,
    leaseMs: 1_000,
    durable,
    bootId: 'gw:wait-close',
    sleep: opts.sleep,
  })
  liveStores.push(store)
  return { store, durable, gets }
}

function createClaimed(store: DelegateJobStore): {
  jobId: string
  fence: { claimToken: string; fencingEpoch: number }
} {
  const created = store.create('coding-assistant', { queued: true })
  assert.ok('jobId' in created)
  const claimed = store.claimQueued(created.jobId)
  assert.equal(claimed.ok, true)
  if (!claimed.ok) throw new Error('claimQueued failed')
  return { jobId: created.jobId, fence: claimed }
}

describe('DelegateJobStore wait/close sleep lifecycle', () => {
  it('complete then close then late sleep does not read SQLite or unhandle', async () => {
    const gate = deferred()
    const { store, gets } = openStore({ sleep: () => gate.promise })
    const { jobId, fence } = createClaimed(store)
    const waitP = store.wait(jobId, 5_000)
    assert.equal(
      store.complete(jobId, { httpStatus: 200, body: DONE_BODY }, fence),
      true,
    )
    const view = await waitP
    assert.equal(view.status, 'done')
    assert.equal(waiterCount(store, jobId), 0)
    store.close()
    gets.markClosed()
    const unhandled = await collectUnhandled(async () => {
      gate.resolve()
    })
    assert.equal(gets.lateReads, 0, 'late sleep must not evaluate get after close')
    assert.equal(unhandled.length, 0)
    assert.equal(waiterCount(store, jobId), 0)
  })

  it('pending close then late sleep returns expired once and does not read SQLite', async () => {
    const gate = deferred()
    const { store, gets } = openStore({ sleep: () => gate.promise })
    const { jobId } = createClaimed(store)
    const waitP = store.wait(jobId, 5_000)
    store.close()
    gets.markClosed()
    const view = await waitP
    assert.deepEqual(view, { status: 'expired', jobId })
    const unhandled = await collectUnhandled(async () => {
      gate.resolve()
    })
    assert.equal(gets.lateReads, 0)
    assert.equal(unhandled.length, 0)
  })

  it('custom sleep that ignores AbortSignal does not delay wait or read after settle', async () => {
    const late = deferred()
    let seenSignal: AbortSignal | undefined
    const { store, gets } = openStore({
      sleep: (_ms, signal) => {
        seenSignal = signal
        return late.promise
      },
    })
    const { jobId, fence } = createClaimed(store)
    const waitP = store.wait(jobId, 5_000)
    const t0 = Date.now()
    assert.equal(
      store.complete(jobId, { httpStatus: 200, body: DONE_BODY }, fence),
      true,
    )
    const view = await waitP
    assert.ok(Date.now() - t0 < 200, 'wait must not wait for ignoring custom sleep')
    assert.equal(view.status, 'done')
    assert.ok(seenSignal, 'default wait still passes AbortSignal')
    assert.equal(waiterCount(store, jobId), 0)
    store.close()
    gets.markClosed()
    const unhandled = await collectUnhandled(async () => {
      late.resolve()
    })
    assert.equal(gets.lateReads, 0)
    assert.equal(unhandled.length, 0)
  })

  it('late reject from signal-ignoring sleep is consumed and does not read SQLite', async () => {
    const late = deferred()
    const { store, gets } = openStore({ sleep: () => late.promise })
    const { jobId, fence } = createClaimed(store)
    const waitP = store.wait(jobId, 5_000)
    assert.equal(
      store.complete(jobId, { httpStatus: 200, body: DONE_BODY }, fence),
      true,
    )
    assert.equal((await waitP).status, 'done')
    store.close()
    gets.markClosed()
    const unhandled = await collectUnhandled(async () => {
      late.reject(new Error('late custom sleep reject'))
    })
    assert.equal(gets.lateReads, 0)
    assert.equal(unhandled.length, 0)
  })

  it('synchronous sleep throw rejects wait and clears waiter', async () => {
    const { store } = openStore({
      sleep: () => {
        throw new Error('sync sleep throw')
      },
    })
    const { jobId } = createClaimed(store)
    await assert.rejects(store.wait(jobId, 5_000), /sync sleep throw/)
    assert.equal(waiterCount(store, jobId), 0)
    store.close()
  })

  it('asynchronous sleep reject rejects wait and clears waiter', async () => {
    const { store } = openStore({
      sleep: () => Promise.reject(new Error('async sleep reject')),
    })
    const { jobId } = createClaimed(store)
    await assert.rejects(store.wait(jobId, 5_000), /async sleep reject/)
    assert.equal(waiterCount(store, jobId), 0)
    store.close()
  })

  it('get throw after sleep fulfill rejects wait and clears waiter', async () => {
    const gate = deferred()
    const { store, durable } = openStore({ sleep: () => gate.promise })
    const orig = durable.get.bind(durable)
    let boom = false
    durable.get = (jobId: string) => {
      if (boom) throw new Error('injected get throw')
      return orig(jobId)
    }
    const { jobId } = createClaimed(store)
    const waitP = store.wait(jobId, 5_000)
    boom = true
    gate.resolve()
    await assert.rejects(waitP, /injected get throw/)
    assert.equal(waiterCount(store, jobId), 0)
    store.close()
  })

  it('normal timeout returns the current job view exactly once', async () => {
    const gate = deferred()
    let sleepSettles = 0
    const { store } = openStore({
      sleep: () =>
        gate.promise.finally(() => {
          sleepSettles += 1
        }),
    })
    const { jobId } = createClaimed(store)
    const waitP = store.wait(jobId, 5_000)
    let views = 0
    const counted: Promise<DelegateJobWaitView> = waitP.then((view) => {
      views += 1
      return view
    })
    gate.resolve()
    const view = await counted
    assert.equal(view.status, 'running')
    assert.equal(view.jobId, jobId)
    assert.equal(views, 1)
    assert.equal(sleepSettles, 1)
    assert.equal(waiterCount(store, jobId), 0)
    store.close()
  })

  it('default sleep timer is actually cancelled on complete', async () => {
    const waitMs = 12_000
    const capped = resolveDelegateWaitMs(waitMs)
    type TimerHandle = object
    type SetTimer = (fn: (...cbArgs: unknown[]) => void, ms?: number, ...args: unknown[]) => TimerHandle
    type ClearTimer = (handle?: TimerHandle) => void
    const timers = globalThis as unknown as { setTimeout: SetTimer; clearTimeout: ClearTimer }
    const origSet = timers.setTimeout
    const origClear = timers.clearTimeout
    const tracked = new Map<TimerHandle, { ms: number; cleared: boolean }>()
    timers.setTimeout = (fn, ms, ...args) => {
      const handle = origSet(fn, ms, ...args)
      if (ms === capped) tracked.set(handle, { ms, cleared: false })
      return handle
    }
    timers.clearTimeout = (handle) => {
      const rec = handle !== undefined ? tracked.get(handle) : undefined
      if (rec) rec.cleared = true
      origClear(handle)
    }
    const { store } = openStore()
    try {
      const { jobId, fence } = createClaimed(store)
      const waitP = store.wait(jobId, waitMs)
      assert.equal(tracked.size, 1, 'default wait must schedule a real timer')
      assert.equal(
        store.complete(jobId, { httpStatus: 200, body: DONE_BODY }, fence),
        true,
      )
      const view = await waitP
      assert.equal(view.status, 'done')
      assert.equal(waiterCount(store, jobId), 0)
      assert.ok(
        [...tracked.values()].every((rec) => rec.cleared),
        'default wait timer must be cleared, not left to fire',
      )
      store.close()
    } finally {
      for (const handle of tracked.keys()) origClear(handle)
      timers.setTimeout = origSet
      timers.clearTimeout = origClear
    }
  })
})
