/**
 * M6/P1-9 unit:refreshEventsSweeper 调度行为(不依赖 PG)。
 *
 * 通过注入 purgeFn 验证:
 *   - intervalMs 触发 tick
 *   - runOnStart 控制 boot 时是否立即跑一次
 *   - stop 后 tick 不再调
 *   - purge 抛错被 onError 接住,不冒泡
 *   - retentionDays 默认 28
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startRefreshEventsSweeper } from '../account-pool/refreshEventsSweeper.js'

describe('refreshEventsSweeper', () => {
  test('runOnStart=true 时 boot 立即跑一次', async () => {
    const calls: number[] = []
    const h = startRefreshEventsSweeper({
      retentionDays: 28,
      intervalMs: 60_000,
      runOnStart: true,
      purgeFn: async (d) => {
        calls.push(d)
        return 7
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(calls.length, 1)
    assert.equal(calls[0], 28)
    h.stop()
  })

  test('runOnStart=false(默认)时 boot 不跑', async () => {
    const calls: number[] = []
    const h = startRefreshEventsSweeper({
      retentionDays: 28,
      intervalMs: 60_000,
      purgeFn: async (d) => {
        calls.push(d)
        return 0
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(calls.length, 0)
    h.stop()
  })

  test('intervalMs 到点 tick', async () => {
    let n = 0
    const h = startRefreshEventsSweeper({
      retentionDays: 28,
      intervalMs: 1000,
      purgeFn: async () => {
        n++
        return 0
      },
    })
    await new Promise((r) => setTimeout(r, 1200))
    assert.ok(n >= 1, `expected at least 1 tick, got ${n}`)
    h.stop()
  })

  test('stop 后不再 tick', async () => {
    let n = 0
    const h = startRefreshEventsSweeper({
      retentionDays: 28,
      intervalMs: 1000,
      purgeFn: async () => {
        n++
        return 0
      },
    })
    h.stop()
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal(n, 0)
  })

  test('purge 抛错走 onError,sweeper 不挂', async () => {
    const errs: unknown[] = []
    const h = startRefreshEventsSweeper({
      retentionDays: 28,
      intervalMs: 60_000,
      runOnStart: true,
      purgeFn: async () => {
        throw new Error('boom')
      },
      onError: (e) => errs.push(e),
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(errs.length, 1)
    assert.equal((errs[0] as Error).message, 'boom')
    h.stop()
  })

  test('retentionDays 默认 28', async () => {
    const calls: number[] = []
    const h = startRefreshEventsSweeper({
      intervalMs: 60_000,
      runOnStart: true,
      purgeFn: async (d) => {
        calls.push(d)
        return 0
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(calls[0], 28)
    h.stop()
  })

  test('retentionDays <= 0 → 取下限 1', async () => {
    const calls: number[] = []
    const h = startRefreshEventsSweeper({
      retentionDays: 0,
      intervalMs: 60_000,
      runOnStart: true,
      purgeFn: async (d) => {
        calls.push(d)
        return 0
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(calls[0], 1)
    h.stop()
  })

  test('intervalMs < 1000 → 取下限 1000', async () => {
    // 防止 typo "5" 被解读成 5ms 把 DB 打爆
    let n = 0
    const h = startRefreshEventsSweeper({
      retentionDays: 28,
      intervalMs: 1, // 远低于下限
      purgeFn: async () => {
        n++
        return 0
      },
    })
    // 等 50ms 内不该触发任何 tick(下限被钳到 1000)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(n, 0)
    h.stop()
  })

  test('runNow 同步暴露,可被测试主动驱动', async () => {
    const calls: number[] = []
    const h = startRefreshEventsSweeper({
      retentionDays: 28,
      intervalMs: 60_000,
      purgeFn: async (d) => {
        calls.push(d)
        return 11
      },
    })
    const deleted = await h.runNow()
    assert.equal(deleted, 11)
    assert.deepEqual(calls, [28])
    h.stop()
  })
})
