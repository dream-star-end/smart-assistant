import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { acquireKernelFileLock } from '../kernelFileLock.js'
import { MemoryBarrierTimeoutError, MemoryDir } from '../memoryDir.js'
import { paths } from '../paths.js'

describe('acquireKernelFileLock', () => {
  it('serializes contenders on one stable inode and releases via stdin EOF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-kernel-lock-'))
    const path = join(dir, 'auto-dream.lock')
    const first = await acquireKernelFileLock(path, 1_000)

    let secondAcquired = false
    const secondPromise = acquireKernelFileLock(path, 2_000).then((lock) => {
      secondAcquired = true
      return lock
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(secondAcquired, false, 'second contender waits while first owns flock')

    await first.release()
    const second = await secondPromise
    assert.equal(secondAcquired, true)
    await second.release()

    await access(path)
  })

  it('fails off after the bounded acquire timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-kernel-lock-timeout-'))
    const path = join(dir, 'auto-dream.lock')
    const first = await acquireKernelFileLock(path, 1_000)
    await assert.rejects(acquireKernelFileLock(path, 50), /flock|timeout/i)
    await first.release()
  })

  it('allows concurrent shared holders and fences an exclusive contender', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-kernel-lock-shared-'))
    const path = join(dir, 'memory-barrier.lock')
    const first = await acquireKernelFileLock(path, 1_000, 'shared')
    const second = await acquireKernelFileLock(path, 1_000, 'shared')
    let exclusiveAcquired = false
    const exclusivePromise = acquireKernelFileLock(path, 2_000, 'exclusive').then((lock) => {
      exclusiveAcquired = true
      return lock
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(exclusiveAcquired, false)
    await first.release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(exclusiveAcquired, false, 'all shared holders must leave first')
    await second.release()
    const exclusive = await exclusivePromise
    assert.equal(exclusiveAcquired, true)
    await exclusive.release()
  })

  it('retries foreground shared-barrier contention within one bounded budget', async () => {
    const agentId = `kernel-barrier-retry-${randomUUID()}`
    const lockPath = paths.agentMemoryBarrier(agentId)
    const exclusive = await acquireKernelFileLock(lockPath, 1_000, 'exclusive')
    const releaseLater = setTimeout(() => void exclusive.release().catch(() => {}), 220)
    try {
      const shared = await new MemoryDir(agentId).acquireSharedBarrier({
        totalBudgetMs: 1_000,
        perAttemptMs: 60,
        retryDelayMs: 20,
      })
      await shared.release()
    } finally {
      clearTimeout(releaseLater)
      await exclusive.release().catch(() => {})
      await rm(paths.agentDir(agentId), { recursive: true, force: true })
    }
  })

  it('keeps a hard total budget and throws a typed timeout under long contention', async () => {
    const agentId = `kernel-barrier-timeout-${randomUUID()}`
    const lockPath = paths.agentMemoryBarrier(agentId)
    const exclusive = await acquireKernelFileLock(lockPath, 1_000, 'exclusive')
    try {
      await assert.rejects(
        new MemoryDir(agentId).acquireSharedBarrier({
          totalBudgetMs: 180,
          perAttemptMs: 50,
          retryDelayMs: 10,
        }),
        (err: unknown) =>
          err instanceof MemoryBarrierTimeoutError && err.code === 'MEMORY_BARRIER_TIMEOUT',
      )
    } finally {
      await exclusive.release()
      await rm(paths.agentDir(agentId), { recursive: true, force: true })
    }
  })
})
