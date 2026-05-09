/**
 * Issue A v1.0.108 — codex 路径 quota writer 纯单元测试。
 *
 * 不需要 PG:用 in-memory 假 Pool 验证:
 *  - maybeUpdateAccountQuotaCodex 各种 snap 输入边界
 *  - accountId === 0n / "0" 跳过(legacy 无关联账号)
 *  - 与 maybeUpdateAccountQuota(header 路径)共享 throttle 状态:同账号 30s 内
 *    任一入口先调,另一入口的 SQL 调用都被跳过
 *
 * 真 SQL 行为(COALESCE / WHERE 节流)在 accountQuota.integ.test.ts 覆盖,
 * 本文件不重复。
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import {
  _resetQuotaState,
  maybeUpdateAccountQuota,
  maybeUpdateAccountQuotaCodex,
} from './quota.js'

interface FakePool {
  query: (sql: string, params: unknown[]) => Promise<{ rowCount: number }>
  calls: Array<{ sql: string; params: unknown[] }>
}

function makeFakePool(): FakePool {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  return {
    calls,
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return { rowCount: 1 }
    },
  }
}

describe('maybeUpdateAccountQuotaCodex', () => {
  beforeEach(() => {
    _resetQuotaState()
  })

  test('happy path: 双窗口完整 snap → SQL 一次,5 个 params', async () => {
    const pool = makeFakePool()
    await maybeUpdateAccountQuotaCodex(pool as unknown as Parameters<typeof maybeUpdateAccountQuotaCodex>[0], 42n, {
      util5h: 33,
      reset5h: '2026-05-09T00:00:00.000Z',
      util7d: 12,
      reset7d: '2026-05-16T00:00:00.000Z',
    })
    assert.equal(pool.calls.length, 1)
    const c = pool.calls[0]
    assert.match(c.sql, /UPDATE claude_accounts/)
    assert.equal(c.params[0], '42')
    assert.equal(c.params[1], 33)
    assert.ok(c.params[2] instanceof Date)
    assert.equal((c.params[2] as Date).toISOString(), '2026-05-09T00:00:00.000Z')
    assert.equal(c.params[3], 12)
    assert.equal((c.params[4] as Date).toISOString(), '2026-05-16T00:00:00.000Z')
  })

  test('accountId=0n 跳过(legacy 无关联,Codex review NEEDS-FIX 3)', async () => {
    const pool = makeFakePool()
    await maybeUpdateAccountQuotaCodex(pool as unknown as Parameters<typeof maybeUpdateAccountQuotaCodex>[0], 0n, {
      util5h: 50,
      reset5h: '2026-05-09T00:00:00.000Z',
    })
    assert.equal(pool.calls.length, 0, 'must not write for legacy accountId 0n')
  })

  test('accountId="0" 同样跳过(字符串入参)', async () => {
    const pool = makeFakePool()
    await maybeUpdateAccountQuotaCodex(pool as unknown as Parameters<typeof maybeUpdateAccountQuotaCodex>[0], '0', {
      util5h: 50,
    })
    assert.equal(pool.calls.length, 0)
  })

  test('全字段非法 → 不打 SQL', async () => {
    const pool = makeFakePool()
    await maybeUpdateAccountQuotaCodex(pool as unknown as Parameters<typeof maybeUpdateAccountQuotaCodex>[0], 7n, {
      util5h: NaN,
      reset5h: 'not-a-date',
      util7d: Infinity,
      reset7d: '',
    })
    assert.equal(pool.calls.length, 0, 'all-invalid snap → noop')
  })

  test('部分有效 → 只传有效字段(其余 null,SQL COALESCE 兜底)', async () => {
    const pool = makeFakePool()
    await maybeUpdateAccountQuotaCodex(pool as unknown as Parameters<typeof maybeUpdateAccountQuotaCodex>[0], 7n, {
      util5h: 80,
      // reset5h 缺失
      // util7d 缺失
      reset7d: '2026-05-16T00:00:00.000Z',
    })
    assert.equal(pool.calls.length, 1)
    const c = pool.calls[0]
    assert.equal(c.params[1], 80)
    assert.equal(c.params[2], null)
    assert.equal(c.params[3], null)
    assert.equal((c.params[4] as Date).toISOString(), '2026-05-16T00:00:00.000Z')
  })

  test('clamp util 到 [0, 100]', async () => {
    const pool = makeFakePool()
    await maybeUpdateAccountQuotaCodex(pool as unknown as Parameters<typeof maybeUpdateAccountQuotaCodex>[0], 7n, {
      util5h: 150,
      util7d: -5,
    })
    assert.equal(pool.calls.length, 1)
    const c = pool.calls[0]
    assert.equal(c.params[1], 100)
    assert.equal(c.params[3], 0)
  })

  test('与 header 路径共享 throttle:同账号 30s 内只写一次', async () => {
    const pool = makeFakePool()
    let now = 1_000_000
    const nowFn = () => now

    // 1) header 路径先打(伪造 headers 让它解析成功)
    const fakeHeaders = {
      get: (n: string) => {
        if (n === 'anthropic-ratelimit-unified-5h-utilization') return '0.5'
        if (n === 'anthropic-ratelimit-unified-5h-reset') return '1714425600'
        return null
      },
    }
    await maybeUpdateAccountQuota(pool as unknown as Parameters<typeof maybeUpdateAccountQuota>[0], 99n, fakeHeaders, nowFn)
    assert.equal(pool.calls.length, 1, 'header path writes once')

    // 2) 立刻 codex 路径(throttle 应跳过)
    now += 1000  // 1 秒后
    await maybeUpdateAccountQuotaCodex(pool as unknown as Parameters<typeof maybeUpdateAccountQuotaCodex>[0], 99n, {
      util5h: 60,
    }, nowFn)
    assert.equal(pool.calls.length, 1, 'codex path skipped within 30s throttle')

    // 3) > 30s 后 codex 路径放行
    now += 30_001
    await maybeUpdateAccountQuotaCodex(pool as unknown as Parameters<typeof maybeUpdateAccountQuotaCodex>[0], 99n, {
      util5h: 60,
    }, nowFn)
    assert.equal(pool.calls.length, 2, 'codex path writes after throttle window expires')
  })

  test('PG 抛异常时 swallow 不抛(fire-and-forget 契约)', async () => {
    const pool = {
      query: async () => {
        throw new Error('synthetic PG error')
      },
      calls: [] as unknown[],
    }
    await assert.doesNotReject(() =>
      maybeUpdateAccountQuotaCodex(pool as unknown as Parameters<typeof maybeUpdateAccountQuotaCodex>[0], 7n, {
        util5h: 50,
      }),
    )
  })
})
