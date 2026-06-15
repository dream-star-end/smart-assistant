/**
 * B1 unit:finalizeJournalReconciler 调度行为 + 阈值钳制(不依赖 PG)。
 *
 * SQL 真行为(committed/aborted 分类、GC LIMIT)见 integ 测试(需 REQUIRE_TEST_DB)。
 * 这里只覆盖 sweeper 包装层 + resolveStuckThresholdMs。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  DEFAULT_STUCK_THRESHOLD_MS,
  MAX_STUCK_THRESHOLD_MS,
  resolveStuckThresholdMs,
  startFinalizeJournalReconciler,
} from '../billing/finalizeJournalReconciler.js'

describe('resolveStuckThresholdMs', () => {
  test('env 缺省 → floor(默认 codex 600s → 30min)', () => {
    assert.equal(resolveStuckThresholdMs(undefined, undefined), DEFAULT_STUCK_THRESHOLD_MS)
  })
  test('env 低于 floor → 向上夹到 floor(不允许把阈值调小)', () => {
    assert.equal(resolveStuckThresholdMs(1000, 600_000), DEFAULT_STUCK_THRESHOLD_MS)
  })
  test('env 高于 floor → 采用 env', () => {
    assert.equal(resolveStuckThresholdMs(5_000_000, 600_000), 5_000_000)
  })
  test('codexMax 提高 → floor = codexMax*3', () => {
    assert.equal(resolveStuckThresholdMs(undefined, 1_000_000), 3_000_000)
  })
  test('非法 env / codexMax → 回落默认 floor', () => {
    assert.equal(resolveStuckThresholdMs('abc', Number.NaN), DEFAULT_STUCK_THRESHOLD_MS)
  })
  test('1e100 等非安全整数 env → 拒绝,回落 floor(防 ::bigint 指数记法打挂)', () => {
    assert.equal(resolveStuckThresholdMs(1e100, 600_000), DEFAULT_STUCK_THRESHOLD_MS)
    assert.equal(resolveStuckThresholdMs('1e100', 600_000), DEFAULT_STUCK_THRESHOLD_MS)
  })
  test('env 超过 24h 上限 → 封到 MAX', () => {
    assert.equal(
      resolveStuckThresholdMs(MAX_STUCK_THRESHOLD_MS * 10, 600_000),
      MAX_STUCK_THRESHOLD_MS,
    )
  })
})

describe('startFinalizeJournalReconciler', () => {
  const noGc = async () => 0

  test('runOnStart 默认 true,boot 立即 reconcile 一次', async () => {
    let n = 0
    const h = startFinalizeJournalReconciler({
      intervalMs: 60_000,
      reconcileFn: async () => {
        n++
        return { committed: 1, aborted: 2 }
      },
      gcFn: noGc,
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(n, 1)
    h.stop()
  })

  test('runOnStart=false → boot 不跑', async () => {
    let n = 0
    const h = startFinalizeJournalReconciler({
      intervalMs: 60_000,
      runOnStart: false,
      reconcileFn: async () => {
        n++
        return { committed: 0, aborted: 0 }
      },
      gcFn: noGc,
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(n, 0)
    h.stop()
  })

  test('stop 后不再 tick', async () => {
    let n = 0
    const h = startFinalizeJournalReconciler({
      intervalMs: 5_000,
      runOnStart: false,
      reconcileFn: async () => {
        n++
        return { committed: 0, aborted: 0 }
      },
      gcFn: noGc,
    })
    h.stop()
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(n, 0)
  })

  test('reconcile 抛错走 onError,sweeper 不挂,GC 仍尝试', async () => {
    const errs: unknown[] = []
    let gcRan = 0
    const h = startFinalizeJournalReconciler({
      intervalMs: 60_000,
      reconcileFn: async () => {
        throw new Error('boom')
      },
      gcFn: async () => {
        gcRan++
        return 0
      },
      onError: (e) => errs.push(e),
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(errs.length, 1)
    assert.equal((errs[0] as Error).message, 'boom')
    assert.equal(gcRan, 1, 'reconcile 失败不应阻断 GC')
    h.stop()
  })

  test('running 守卫:上一轮未结束时跳过重叠 tick', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const h = startFinalizeJournalReconciler({
      intervalMs: 60_000,
      runOnStart: false,
      reconcileFn: async () => {
        calls++
        await gate // 阻塞,模拟 DB 卡
        return { committed: 0, aborted: 0 }
      },
      gcFn: noGc,
    })
    const p1 = h.runNow() // 进入 running,卡在 gate
    await new Promise((r) => setTimeout(r, 10))
    const r2 = await h.runNow() // running=true → 立即返回 0,不再调 reconcileFn
    assert.deepEqual(r2, { committed: 0, aborted: 0, gc: 0 })
    assert.equal(calls, 1, '重叠 tick 不应二次调用 reconcileFn')
    release()
    await p1
    h.stop()
  })

  test('GC cadence:首轮即 GC,之后按 gcIntervalMs 节流', async () => {
    let t = 1_000_000_000_000 // 注入时钟
    const now = () => t
    let gcRuns = 0
    const h = startFinalizeJournalReconciler({
      intervalMs: 60_000,
      runOnStart: false,
      reconcileFn: async () => ({ committed: 0, aborted: 0 }),
      gcFn: async () => {
        gcRuns++
        return 0
      },
      gcIntervalMs: 3_600_000,
      now,
    })
    await h.runNow() // lastGcAt=0 → 首轮 GC
    assert.equal(gcRuns, 1)
    t += 1000 // 远不到 1h
    await h.runNow()
    assert.equal(gcRuns, 1, '未到 gcIntervalMs 不应再 GC')
    t += 3_600_000 // 满 1h
    await h.runNow()
    assert.equal(gcRuns, 2, '到 gcIntervalMs 应再 GC 一次')
    h.stop()
  })

  test('runNow 返回 {committed,aborted,gc}', async () => {
    const h = startFinalizeJournalReconciler({
      intervalMs: 60_000,
      runOnStart: false,
      reconcileFn: async () => ({ committed: 3, aborted: 4 }),
      gcFn: async () => 5,
      gcIntervalMs: 1, // 保证本次 GC 触发
      now: () => 10_000_000,
    })
    const out = await h.runNow()
    assert.deepEqual(out, { committed: 3, aborted: 4, gc: 5 })
    h.stop()
  })
})
