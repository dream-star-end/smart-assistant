import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  type ManagedPluginWriteDailyCapPolicy,
  PluginWriteDailyCapError,
  beijingDay,
  consumeManagedPluginWriteDailyCap,
  writeDailyCapBucket,
} from './writeDailyCap.js'
import { managedPluginWriteDailyCap } from './writePolicy.js'

const POLICY: ManagedPluginWriteDailyCapPolicy = {
  buckets: { publish_video: 'publish', create_comment: 'comment', reply_comment: 'comment' },
  defaultBucket: 'interact',
  caps: { publish: 1, comment: 2, interact: 3 },
}

/** 只认 GET-then-INCR 脚本的内存 Redis;记录每次调用的 key/cap/ttl。 */
function counterRedis() {
  const values = new Map<string, number>()
  const calls: Array<{ key: string; cap: number; ttl: number }> = []
  return {
    values,
    calls,
    async eval(script: string, numKeys: number, ...args: Array<string | number>) {
      assert.equal(numKeys, 1)
      assert.match(script, /redis\.call\('INCR'/)
      const key = String(args[0])
      const cap = Number(args[1])
      calls.push({ key, cap, ttl: Number(args[2]) })
      const v = values.get(key) ?? 0
      if (v >= cap) return -1
      values.set(key, v + 1)
      return v + 1
    },
  }
}

const isCode = (code: string) => (e: unknown) =>
  e instanceof PluginWriteDailyCapError && e.code === code

// 2026-10-21 15:59:59Z = 北京时间 23:59:59;再过 1 秒即北京次日。
const BEFORE_MIDNIGHT = Date.UTC(2026, 9, 21, 15, 59, 59)
const AFTER_MIDNIGHT = BEFORE_MIDNIGHT + 1000

function consume(redis: unknown, actionId: string, now = BEFORE_MIDNIGHT, connectionId = '42') {
  return consumeManagedPluginWriteDailyCap({
    redis: redis as never,
    policy: POLICY,
    slug: 'demo',
    connectionId,
    actionId,
    now,
  })
}

describe('managed plugin write daily cap', () => {
  test('现有插件都没有每日上限(行为不变)', () => {
    for (const slug of ['weibo', 'zhihu', 'knowledge-planet', 'bili-account', 'literature-db']) {
      assert.equal(managedPluginWriteDailyCap(slug), null, slug)
    }
  })

  test('policy=null 不触达 Redis', async () => {
    let touched = false
    const redis = {
      async eval() {
        touched = true
        return 1
      },
    }
    const n = await consumeManagedPluginWriteDailyCap({
      redis,
      policy: null,
      slug: 'weibo',
      connectionId: '1',
      actionId: 'create_post',
      now: BEFORE_MIDNIGHT,
    })
    assert.equal(n, null)
    assert.equal(touched, false)
    // Redis 缺失时也不拒(没有上限就没有闸)。
    assert.equal(
      await consumeManagedPluginWriteDailyCap({
        redis: null,
        policy: null,
        slug: 'weibo',
        connectionId: '1',
        actionId: 'create_post',
        now: BEFORE_MIDNIGHT,
      }),
      null,
    )
  })

  test('按动作桶计数,超限 → WRITE_DAILY_LIMIT;桶之间互不影响', async () => {
    const redis = counterRedis()
    assert.equal(await consume(redis, 'create_comment'), 1)
    assert.equal(await consume(redis, 'reply_comment'), 2)
    await assert.rejects(consume(redis, 'create_comment'), isCode('WRITE_DAILY_LIMIT'))
    assert.equal(await consume(redis, 'publish_video'), 1)
    await assert.rejects(consume(redis, 'publish_video'), isCode('WRITE_DAILY_LIMIT'))
    // 未列出的写动作归入 defaultBucket。
    assert.equal(writeDailyCapBucket(POLICY, 'set_like'), 'interact')
    assert.equal(await consume(redis, 'set_like'), 1)
    assert.ok(redis.calls.every((c) => c.ttl === 48 * 3600))
  })

  test('按账号隔离:另一个账号有自己的额度', async () => {
    const redis = counterRedis()
    assert.equal(await consume(redis, 'publish_video', BEFORE_MIDNIGHT, '42'), 1)
    await assert.rejects(
      consume(redis, 'publish_video', BEFORE_MIDNIGHT, '42'),
      isCode('WRITE_DAILY_LIMIT'),
    )
    assert.equal(await consume(redis, 'publish_video', BEFORE_MIDNIGHT, '43'), 1)
    assert.ok(redis.calls.every((c) => c.key.startsWith('plugins:write-daily:demo:')))
  })

  test('按北京时间自然日重置', async () => {
    assert.equal(beijingDay(BEFORE_MIDNIGHT), '20261021')
    assert.equal(beijingDay(AFTER_MIDNIGHT), '20261022')
    const redis = counterRedis()
    assert.equal(await consume(redis, 'publish_video', BEFORE_MIDNIGHT), 1)
    await assert.rejects(
      consume(redis, 'publish_video', BEFORE_MIDNIGHT),
      isCode('WRITE_DAILY_LIMIT'),
    )
    assert.equal(await consume(redis, 'publish_video', AFTER_MIDNIGHT), 1)
    assert.deepEqual(
      redis.calls.map((c) => c.key),
      [
        'plugins:write-daily:demo:42:publish:20261021',
        'plugins:write-daily:demo:42:publish:20261021',
        'plugins:write-daily:demo:42:publish:20261022',
      ],
    )
  })

  test('声明了上限但 Redis 缺失/出错/返回异常 → 拒绝(fail-closed)', async () => {
    await assert.rejects(consume(null, 'publish_video'), isCode('RUNTIME_UNAVAILABLE'))
    const broken = {
      async eval() {
        throw new Error('ECONNRESET')
      },
    }
    await assert.rejects(consume(broken, 'publish_video'), isCode('RUNTIME_UNAVAILABLE'))
    const weird = {
      async eval() {
        return 'OK'
      },
    }
    await assert.rejects(consume(weird, 'publish_video'), isCode('RUNTIME_UNAVAILABLE'))
  })

  test('桶缺上限或上限非正整数 → 拒绝,不触达 Redis', async () => {
    const redis = counterRedis()
    const badCaps: Array<Readonly<Record<string, number>>> = [{}, { other: 0 }, { other: 1.5 }]
    for (const caps of badCaps) {
      await assert.rejects(
        consumeManagedPluginWriteDailyCap({
          redis,
          policy: { buckets: {}, defaultBucket: 'other', caps },
          slug: 'demo',
          connectionId: '42',
          actionId: 'x',
          now: BEFORE_MIDNIGHT,
        }),
        isCode('RUNTIME_UNAVAILABLE'),
      )
    }
    assert.equal(redis.calls.length, 0)
  })
})
