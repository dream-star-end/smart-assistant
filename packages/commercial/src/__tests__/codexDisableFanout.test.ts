/**
 * codexDisableFanout.test.ts — v1.0.120 feat/codex-disable-rebind 单测。
 *
 * 覆盖:
 *   1. enqueue 去重(同 accountId 第二次入队静默丢弃)
 *   2. provider 二次确认 —— 非 codex 账号被传入时 skip
 *   3. 没有受影响容器 → no-op,既不 tx 也不调 helper
 *   4. happy fanout —— rebound + commit + write
 *   5. 单容器 migrate 失败 → 不影响其他容器(隔离)
 *   6. target_changed 容器 → skip commit/write
 *   7. write 失败 → tx ROLLBACK(commitFn 未被调用,异常被吞 + log)
 *   8. runWithConcurrency 限流(并发不超过 N,长尾不卡)
 */

import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  type CodexDisableFanoutDeps,
  _resetInflightFanoutForTest,
  enqueueCodexDisableFanout,
  runWithConcurrency,
} from '../account-pool/codexDisableFanout.js'

const OLD_ACCOUNT = 100n
const NEW_ACCOUNT = 200n

/** wait for fanout to drain — needed because enqueue is fire-and-forget. */
async function settle(): Promise<void> {
  // 4 ticks: enqueue → provCheck await → list await → migrate await → finally
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setImmediate(r))
  }
}

function fakeAccountSelect(provider: 'codex' | 'claude' = 'codex') {
  return async () => ({
    rows: [{ provider, status: 'disabled' }],
    rowCount: 1,
  })
}

function fakeContainersSelect(ids: number[]) {
  return async () => ({
    rows: ids.map((id) => ({ id: String(id) })),
    rowCount: ids.length,
  })
}

describe('codexDisableFanout', () => {
  test('enqueue dedup: second call while in-flight is silently dropped', async () => {
    _resetInflightFanoutForTest()
    let queryCount = 0
    const deps: CodexDisableFanoutDeps = {
      writeAuth: {
        selfHostId: null,
        containerUid: 1000,
        containerGid: 1000,
        codexContainerDir: '/tmp/x',
      },
      // queryFn called for provider check; gate fanout on this taking forever
      queryFn: async () => {
        queryCount += 1
        // hang the first call so the second enqueue happens while first inflight
        await new Promise((r) => setTimeout(r, 30))
        // after sleep return empty containers shape
        return { rows: [{ provider: 'codex', status: 'disabled' }], rowCount: 1 } as never
      },
    }
    enqueueCodexDisableFanout(OLD_ACCOUNT, deps)
    enqueueCodexDisableFanout(OLD_ACCOUNT, deps) // dedup'd
    enqueueCodexDisableFanout(OLD_ACCOUNT, deps) // dedup'd
    await new Promise((r) => setTimeout(r, 80))
    // 第二次 SELECT (containers list) 后 fanout 立刻结束 — provCheck + list = 2 次
    // 第一次入队完成才能释放 inflight,所以总 query 数应该是 provCheck + list = 2 次
    assert.equal(queryCount, 2, 'only the first enqueue runs; dups dropped')
  })

  test('provider check: non-codex account skipped (no containers query)', async () => {
    _resetInflightFanoutForTest()
    const calls: string[] = []
    const deps: CodexDisableFanoutDeps = {
      writeAuth: { selfHostId: null, containerUid: 1000, containerGid: 1000, codexContainerDir: '/tmp/x' },
      queryFn: async (sql: string) => {
        calls.push(sql)
        // first (and should be only) call: SELECT provider,status. Return claude.
        return { rows: [{ provider: 'claude', status: 'disabled' }], rowCount: 1 } as never
      },
      txFn: async () => {
        throw new Error('tx should not run for non-codex')
      },
    }
    enqueueCodexDisableFanout(OLD_ACCOUNT, deps)
    await settle()
    assert.equal(calls.length, 1, 'only the provider-check SELECT ran')
  })

  test('no affected containers → no-op (no tx)', async () => {
    _resetInflightFanoutForTest()
    let txRan = 0
    const queries: string[] = []
    const deps: CodexDisableFanoutDeps = {
      writeAuth: { selfHostId: null, containerUid: 1000, containerGid: 1000, codexContainerDir: '/tmp/x' },
      queryFn: async (sql: string) => {
        queries.push(sql)
        if (queries.length === 1) {
          return { rows: [{ provider: 'codex', status: 'disabled' }], rowCount: 1 } as never
        }
        return { rows: [], rowCount: 0 } as never
      },
      txFn: async () => {
        txRan += 1
        return undefined as never
      },
    }
    enqueueCodexDisableFanout(OLD_ACCOUNT, deps)
    await settle()
    assert.equal(queries.length, 2, 'provider + containers')
    assert.equal(txRan, 0, 'no containers → tx never opens')
  })

  test("0098 channel 划分:provCheck 与容器枚举 SQL 都圈定 runtime_channel='v3'(v5 行/容器不进 v3 fanout)", async () => {
    _resetInflightFanoutForTest()
    const queries: string[] = []
    const deps: CodexDisableFanoutDeps = {
      writeAuth: { selfHostId: null, containerUid: 1000, containerGid: 1000, codexContainerDir: '/tmp/x' },
      queryFn: async (sql: string) => {
        queries.push(sql)
        if (queries.length === 1) {
          return { rows: [{ provider: 'codex', status: 'disabled' }], rowCount: 1 } as never
        }
        return { rows: [], rowCount: 0 } as never
      },
    }
    enqueueCodexDisableFanout(OLD_ACCOUNT, deps)
    await settle()
    assert.equal(queries.length, 2, 'provider + containers')
    // provCheck:claude_accounts 按 channel 圈定 —— v5 行按 not_found skip,fanout 不越权。
    assert.match(queries[0]!, /claude_accounts/, 'first query is the account provCheck')
    assert.match(queries[0]!, /runtime_channel = 'v3'/, "provCheck 必须带 runtime_channel='v3'")
    // 容器枚举:agent_containers 按 channel 圈定 —— v5 容器归 v5 master fanout。
    assert.match(queries[1]!, /agent_containers/, 'second query is the containers list')
    assert.match(queries[1]!, /runtime_channel = 'v3'/, "容器枚举必须带 runtime_channel='v3'")
  })

  test('happy fanout: rebound → fetch+write+commit per container', async () => {
    _resetInflightFanoutForTest()
    const containers = [11, 22, 33]
    const writeCalls: number[] = []
    const commitCalls: number[] = []
    const deps: CodexDisableFanoutDeps = {
      writeAuth: { selfHostId: null, containerUid: 1000, containerGid: 1000, codexContainerDir: '/tmp/x' },
      concurrency: 2,
      queryFn: async (sql: string) => {
        if (sql.includes('FROM claude_accounts')) {
          return fakeAccountSelect()() as never
        }
        return fakeContainersSelect(containers)() as never
      },
      txFn: async (fn) => fn(null as never),
      acquireAndPickInTxFn: async () => ({
        kind: 'rebound',
        newAccountId: NEW_ACCOUNT,
        plan: 'pro' as const,
        hostUuidUnderLock: null,
      }),
      commitCodexRebindInTxFn: async (_c, containerId) => {
        commitCalls.push(containerId)
      },
      fetchAndWriteFn: async (args) => {
        writeCalls.push(args.containerId)
        return { accessToken: 'tok', chatgptAccountId: null, lastRefreshIso: '' }
      },
    }
    enqueueCodexDisableFanout(OLD_ACCOUNT, deps)
    await settle()
    assert.deepEqual(writeCalls.sort((a, b) => a - b), containers)
    assert.deepEqual(commitCalls.sort((a, b) => a - b), containers)
  })

  test('one migrate failure isolated — peers still complete', async () => {
    _resetInflightFanoutForTest()
    const containers = [11, 22, 33]
    const completed: number[] = []
    const deps: CodexDisableFanoutDeps = {
      writeAuth: { selfHostId: null, containerUid: 1000, containerGid: 1000, codexContainerDir: '/tmp/x' },
      queryFn: async (sql: string) =>
        sql.includes('FROM claude_accounts')
          ? (fakeAccountSelect()() as never)
          : (fakeContainersSelect(containers)() as never),
      txFn: async (fn) => fn(null as never),
      acquireAndPickInTxFn: async () => ({
        kind: 'rebound',
        newAccountId: NEW_ACCOUNT,
        plan: 'pro' as const,
        hostUuidUnderLock: null,
      }),
      commitCodexRebindInTxFn: async (_c, containerId) => {
        completed.push(containerId)
      },
      fetchAndWriteFn: async (args) => {
        if (args.containerId === 22) {
          throw new Error('disk full on 22')
        }
        return { accessToken: 'tok', chatgptAccountId: null, lastRefreshIso: '' }
      },
    }
    enqueueCodexDisableFanout(OLD_ACCOUNT, deps)
    await settle()
    assert.deepEqual(completed.sort((a, b) => a - b), [11, 33])
  })

  test('target_changed (already migrated by acquire/M1) — skip', async () => {
    _resetInflightFanoutForTest()
    const containers = [11]
    let commitCount = 0
    let writeCount = 0
    const deps: CodexDisableFanoutDeps = {
      writeAuth: { selfHostId: null, containerUid: 1000, containerGid: 1000, codexContainerDir: '/tmp/x' },
      queryFn: async (sql: string) =>
        sql.includes('FROM claude_accounts')
          ? (fakeAccountSelect()() as never)
          : (fakeContainersSelect(containers)() as never),
      txFn: async (fn) => fn(null as never),
      acquireAndPickInTxFn: async () => ({ kind: 'target_changed' }),
      commitCodexRebindInTxFn: async () => {
        commitCount += 1
      },
      fetchAndWriteFn: async () => {
        writeCount += 1
        return { accessToken: '', chatgptAccountId: null, lastRefreshIso: '' }
      },
    }
    enqueueCodexDisableFanout(OLD_ACCOUNT, deps)
    await settle()
    assert.equal(commitCount, 0)
    assert.equal(writeCount, 0)
  })

  test('write failure → tx ROLLBACK (commit never invoked, strong consistency)', async () => {
    _resetInflightFanoutForTest()
    let commitCount = 0
    let writeCount = 0
    let rolledBack = false
    const deps: CodexDisableFanoutDeps = {
      writeAuth: { selfHostId: null, containerUid: 1000, containerGid: 1000, codexContainerDir: '/tmp/x' },
      queryFn: async (sql: string) =>
        sql.includes('FROM claude_accounts')
          ? (fakeAccountSelect()() as never)
          : (fakeContainersSelect([11])() as never),
      // emulate real tx semantics: callback throws → swallow and mark rollback
      txFn: (async (fn: (client: never) => Promise<unknown>) => {
        try {
          return await fn(null as never)
        } catch {
          rolledBack = true
          return undefined as never
        }
      }) as never,
      acquireAndPickInTxFn: async () => ({
        kind: 'rebound',
        newAccountId: NEW_ACCOUNT,
        plan: 'pro' as const,
        hostUuidUnderLock: null,
      }),
      fetchAndWriteFn: async () => {
        writeCount += 1
        throw new Error('disk full')
      },
      commitCodexRebindInTxFn: async () => {
        commitCount += 1
      },
    }
    enqueueCodexDisableFanout(OLD_ACCOUNT, deps)
    await settle()
    assert.equal(writeCount, 1, 'fetch+write was attempted')
    assert.equal(commitCount, 0, 'commit must NOT run after write fails')
    assert.equal(rolledBack, true, 'tx callback threw → ROLLBACK')
  })
})

describe('runWithConcurrency', () => {
  test('empty input → returns immediately', async () => {
    let ran = 0
    await runWithConcurrency([], 4, async () => {
      ran += 1
    })
    assert.equal(ran, 0)
  })

  test('respects concurrency cap (parallel <= N at any moment)', async () => {
    let active = 0
    let maxActive = 0
    const items = Array.from({ length: 8 }, (_, i) => i)
    await runWithConcurrency(items, 3, async () => {
      active += 1
      if (active > maxActive) maxActive = active
      await new Promise((r) => setTimeout(r, 5))
      active -= 1
    })
    assert.ok(maxActive <= 3, `maxActive=${maxActive} exceeded cap of 3`)
    assert.ok(maxActive >= 1)
  })

  test('long-tail item does not block other workers', async () => {
    const done: number[] = []
    await runWithConcurrency([0, 1, 2], 2, async (n) => {
      // item 0 sleeps long; items 1+2 should finish first via worker-pool
      if (n === 0) await new Promise((r) => setTimeout(r, 40))
      done.push(n)
    })
    assert.equal(done[done.length - 1], 0, 'long-tail item 0 finishes last')
  })
})
