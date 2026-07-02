/**
 * B3 unit:codex disable drift reconcile 编排 + sweeper 调度(不依赖 PG)。
 *
 * findCodexDisableDrift 的真 SQL 见 codexDisableDrift.integ.test.ts。
 * 这里:reconcileCodexDisableDrift 用 stub queryFn(返漂移行)+ stub migrateOne
 * 验证"对每行调一次 rebind、计 failed";sweeper 包装层用注入 reconcileFn 验。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { CodexDisableFanoutDeps } from '../account-pool/codexDisableFanout.js'
import {
  reconcileCodexDisableDrift,
  startCodexDisableDriftReconciler,
} from '../account-pool/codexDisableFanout.js'

function depsWithDriftRows(rows: Array<{ container_id: string; account_id: string }>) {
  return {
    queryFn: (async () => ({ rows, rowCount: rows.length })) as unknown,
    concurrency: 4,
  } as unknown as CodexDisableFanoutDeps
}

describe('reconcileCodexDisableDrift', () => {
  test('对每条漂移行调一次 migrateOne;found 正确,failed=0', async () => {
    const deps = depsWithDriftRows([
      { container_id: '1', account_id: '100' },
      { container_id: '2', account_id: '100' },
      { container_id: '3', account_id: '200' },
    ])
    const calls: Array<[number, bigint]> = []
    const res = await reconcileCodexDisableDrift(deps, async (cid, acc) => {
      calls.push([cid, acc])
    })
    assert.deepEqual(res, { found: 3, failed: 0 })
    assert.equal(calls.length, 3)
    // 类型转换正确:container→number,account→bigint
    assert.deepEqual(
      calls.sort((a, b) => a[0] - b[0]),
      [
        [1, 100n],
        [2, 100n],
        [3, 200n],
      ],
    )
  })

  test('无漂移 → found=0,不调 migrateOne', async () => {
    const deps = depsWithDriftRows([])
    let called = 0
    const res = await reconcileCodexDisableDrift(deps, async () => {
      called += 1
    })
    assert.deepEqual(res, { found: 0, failed: 0 })
    assert.equal(called, 0)
  })

  test('单条 migrate 抛错 → 计 failed,其余继续', async () => {
    const deps = depsWithDriftRows([
      { container_id: '1', account_id: '100' },
      { container_id: '2', account_id: '100' },
    ])
    let ok = 0
    const res = await reconcileCodexDisableDrift(deps, async (cid) => {
      if (cid === 1) throw new Error('boom')
      ok += 1
    })
    assert.equal(res.found, 2)
    assert.equal(res.failed, 1)
    assert.equal(ok, 1)
  })
})

describe('startCodexDisableDriftReconciler', () => {
  const deps = { writeAuth: {} } as unknown as CodexDisableFanoutDeps

  test('runOnStart 默认 true,boot 立即跑一次', async () => {
    let n = 0
    const h = startCodexDisableDriftReconciler({
      deps,
      intervalMs: 60_000,
      reconcileFn: async () => {
        n += 1
        return { found: 0, failed: 0 }
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(n, 1)
    h.stop()
  })

  test('runOnStart=false → boot 不跑', async () => {
    let n = 0
    const h = startCodexDisableDriftReconciler({
      deps,
      intervalMs: 60_000,
      runOnStart: false,
      reconcileFn: async () => {
        n += 1
        return { found: 0, failed: 0 }
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(n, 0)
    h.stop()
  })

  test('stop 后不再 tick', async () => {
    let n = 0
    const h = startCodexDisableDriftReconciler({
      deps,
      intervalMs: 30_000,
      runOnStart: false,
      reconcileFn: async () => {
        n += 1
        return { found: 0, failed: 0 }
      },
    })
    h.stop()
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(n, 0)
  })

  test('reconcile 抛错走 onError,sweeper 不挂', async () => {
    const errs: unknown[] = []
    const h = startCodexDisableDriftReconciler({
      deps,
      intervalMs: 60_000,
      reconcileFn: async () => {
        throw new Error('boom')
      },
      onError: (e) => errs.push(e),
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(errs.length, 1)
    assert.equal((errs[0] as Error).message, 'boom')
    h.stop()
  })

  test('running 守卫:上一轮未结束时跳过重叠 tick', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const h = startCodexDisableDriftReconciler({
      deps,
      intervalMs: 60_000,
      runOnStart: false,
      reconcileFn: async () => {
        calls += 1
        await gate
        return { found: 0, failed: 0 }
      },
    })
    const p1 = h.runNow()
    await new Promise((r) => setTimeout(r, 10))
    const r2 = await h.runNow()
    assert.deepEqual(r2, { found: 0, failed: 0 })
    assert.equal(calls, 1)
    release()
    await p1
    h.stop()
  })

  test('runNow 返回 {found,failed}', async () => {
    const h = startCodexDisableDriftReconciler({
      deps,
      intervalMs: 60_000,
      runOnStart: false,
      reconcileFn: async () => ({ found: 5, failed: 2 }),
    })
    assert.deepEqual(await h.runNow(), { found: 5, failed: 2 })
    h.stop()
  })
})
