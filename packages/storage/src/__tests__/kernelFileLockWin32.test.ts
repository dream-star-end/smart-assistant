import * as assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { acquireKernelFileLock } from '../kernelFileLock.js'

describe('acquireKernelFileLock win32 wx branch — B7', () => {
  it('acquires via wx, writes pid, and releases by unlinking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-wx-lock-'))
    const path = join(dir, 'auto-dream.lock')
    try {
      const lock = await acquireKernelFileLock(path, 1_000, 'exclusive', {
        platform: 'win32',
        pid: 4242,
        pidAlive: () => true,
      })
      const body = await readFile(path, 'utf8')
      assert.equal(body.trim(), '4242')
      await lock.release()
      await assert.rejects(readFile(path), { code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reclaims a stale lock whose pid is not alive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-wx-stale-'))
    const path = join(dir, 'auto-dream.lock')
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path, '1\n', { flag: 'wx' })
      const lock = await acquireKernelFileLock(path, 1_000, 'exclusive', {
        platform: 'win32',
        pid: 99,
        pidAlive: (pid) => pid !== 1,
      })
      const body = await readFile(path, 'utf8')
      assert.equal(body.trim(), '99')
      await lock.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('times out while a live holder owns the wx lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-wx-timeout-'))
    const path = join(dir, `lock-${randomUUID()}`)
    try {
      const first = await acquireKernelFileLock(path, 1_000, 'exclusive', {
        platform: 'win32',
        pid: 7,
        pidAlive: () => true,
      })
      await assert.rejects(
        acquireKernelFileLock(path, 80, 'exclusive', {
          platform: 'win32',
          pid: 8,
          pidAlive: () => true,
        }),
        /timeout/i,
      )
      await first.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
