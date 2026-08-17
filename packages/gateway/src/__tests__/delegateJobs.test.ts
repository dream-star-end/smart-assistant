/**
 * Delegate job handles + long-poll wait. Uses short constants / a fake clock;
 * does not wait real 45s/2h.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateJobs.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DelegateJobStore,
  MAX_DELEGATE_JOB_TTL_MS,
  MAX_DELEGATE_WAIT_MS,
  MIN_DELEGATE_JOB_TTL_MS,
  MIN_DELEGATE_WAIT_MS,
  resolveDelegateJobTtlMs,
  resolveDelegateWaitMs,
} from '../delegateJobs.js'

const doneBody = { ok: true, agentId: 'coding-assistant', output: '子任务完成' }

describe('resolveDelegateJobTtlMs / resolveDelegateWaitMs', () => {
  it('defaults and clamps TTL to 1min..2h', () => {
    assert.equal(resolveDelegateJobTtlMs({}), MAX_DELEGATE_JOB_TTL_MS)
    assert.equal(
      resolveDelegateJobTtlMs({ OPENCLAUDE_DELEGATE_JOB_TTL_MS: '10' }),
      MIN_DELEGATE_JOB_TTL_MS,
    )
    assert.equal(
      resolveDelegateJobTtlMs({ OPENCLAUDE_DELEGATE_JOB_TTL_MS: '999999999' }),
      MAX_DELEGATE_JOB_TTL_MS,
    )
  })

  it('clamps per-request waitMs to 250ms..55s', () => {
    assert.equal(resolveDelegateWaitMs(undefined), 30_000)
    assert.equal(resolveDelegateWaitMs(1), MIN_DELEGATE_WAIT_MS)
    assert.equal(resolveDelegateWaitMs(999_999), MAX_DELEGATE_WAIT_MS)
    assert.equal(resolveDelegateWaitMs(12_000), 12_000)
  })
})

describe('DelegateJobStore', () => {
  it('wait returns the full result when the job finishes inside the wait window', async () => {
    const store = new DelegateJobStore({ ttlMs: 60_000 })
    const created = store.create('coding-assistant')
    assert.ok('jobId' in created)
    const jobId = created.jobId
    setTimeout(() => {
      store.complete(jobId, { httpStatus: 200, body: doneBody })
    }, 15)
    const view = await store.wait(jobId, 200)
    assert.equal(view.status, 'done')
    if (view.status !== 'done') return
    assert.equal(view.httpStatus, 200)
    assert.deepEqual(view.body, doneBody)
    store.close()
  })

  it('wait returns running when the job is still in flight', async () => {
    const store = new DelegateJobStore({ ttlMs: 60_000 })
    const created = store.create('coding-assistant')
    assert.ok('jobId' in created)
    const view = await store.wait(created.jobId, 30)
    assert.deepEqual(view, { status: 'running', jobId: created.jobId })
    store.close()
  })

  it('TTL expiry: get/wait after the fake clock advances past ttl', async () => {
    let now = 1_000
    const store = new DelegateJobStore({ ttlMs: 100, now: () => now })
    const created = store.create('coding-assistant')
    assert.ok('jobId' in created)
    const jobId = created.jobId
    assert.equal(store.get(jobId).status, 'running')
    now = 1_101
    assert.deepEqual(store.get(jobId), { status: 'expired', jobId })
    assert.equal(store.size(), 0)
    const waitView = await store.wait(jobId, 30)
    assert.deepEqual(waitView, { status: 'expired', jobId })
    store.complete(jobId, { httpStatus: 200, body: doneBody })
    assert.deepEqual(store.get(jobId), { status: 'expired', jobId })
    store.close()
  })

  it('notifies an in-flight waiter when TTL expires', async () => {
    let now = 1_000
    let wakeSleep: (() => void) | undefined
    const store = new DelegateJobStore({
      ttlMs: 50,
      now: () => now,
      sleep: () =>
        new Promise<void>((resolve) => {
          wakeSleep = resolve
        }),
    })
    const created = store.create('coding-assistant')
    assert.ok('jobId' in created)
    const pending = store.wait(created.jobId, 5_000)
    now = 1_100
    const view = await Promise.race([
      pending,
      (async () => {
        store.sweep(now)
        return pending
      })(),
    ])
    assert.equal(view.status, 'expired')
    wakeSleep?.()
    store.close()
  })

  it('capacity: create fails once maxJobs is reached (after sweep)', () => {
    const store = new DelegateJobStore({ ttlMs: 60_000, maxJobs: 1 })
    assert.ok('jobId' in store.create('a'))
    assert.deepEqual(store.create('b'), { error: 'capacity' })
    store.close()
  })
})
