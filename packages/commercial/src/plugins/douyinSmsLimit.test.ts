import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { DOUYIN_SMS_WINDOWS, consumeDouyinSmsQuota, douyinSmsQuotaKeys } from './douyinSmsLimit.js'

/** 内存 Redis：按脚本语义「先全部检查，再一起计数」，并能按秒推进时间让窗口过期。 */
function windowRedis() {
  const values = new Map<string, { n: number; expiresAt: number }>()
  let now = 0
  const calls: Array<{ keys: string[]; args: number[] }> = []
  return {
    calls,
    advance(seconds: number) {
      now += seconds
    },
    async eval(script: string, numKeys: number, ...rest: Array<string | number>) {
      assert.match(script, /INCR/)
      const keys = rest.slice(0, numKeys).map(String)
      const args = rest.slice(numKeys).map(Number)
      calls.push({ keys, args })
      const live = (key: string) => {
        const v = values.get(key)
        return v && v.expiresAt > now ? v.n : 0
      }
      for (let i = 0; i < keys.length; i += 1) if (live(keys[i]!) >= args[i * 2]!) return 0
      for (let i = 0; i < keys.length; i += 1) {
        const n = live(keys[i]!) + 1
        const prev = values.get(keys[i]!)
        values.set(keys[i]!, {
          n,
          expiresAt:
            n === 1 || !prev || prev.expiresAt <= now ? now + args[i * 2 + 1]! : prev.expiresAt,
        })
      }
      return 1
    },
  }
}

describe('douyin SMS quota (4.3.C)', () => {
  test('windows are 1 / 60s, 3 / hour, 5 / day per platform user', () => {
    assert.deepEqual(
      DOUYIN_SMS_WINDOWS.map((w) => [w.seconds, w.limit]),
      [
        [60, 1],
        [3600, 3],
        [86_400, 5],
      ],
    )
    assert.deepEqual(douyinSmsQuotaKeys(7), [
      'plugins:douyin:sms:7:60',
      'plugins:douyin:sms:7:3600',
      'plugins:douyin:sms:7:86400',
    ])
  })

  test('second send within 60s is limited; the hour and day caps hold; users are separate', async () => {
    const redis = windowRedis()
    assert.equal(await consumeDouyinSmsQuota({ redis, userId: 7 }), 'ok')
    assert.equal(await consumeDouyinSmsQuota({ redis, userId: 7 }), 'limited')
    assert.equal(await consumeDouyinSmsQuota({ redis, userId: 8 }), 'ok')
    redis.advance(61)
    assert.equal(await consumeDouyinSmsQuota({ redis, userId: 7 }), 'ok')
    redis.advance(61)
    assert.equal(await consumeDouyinSmsQuota({ redis, userId: 7 }), 'ok')
    redis.advance(61)
    // 1 小时内第 4 条。
    assert.equal(await consumeDouyinSmsQuota({ redis, userId: 7 }), 'limited')
    redis.advance(3600)
    assert.equal(await consumeDouyinSmsQuota({ redis, userId: 7 }), 'ok')
    redis.advance(61)
    assert.equal(await consumeDouyinSmsQuota({ redis, userId: 7 }), 'ok')
    redis.advance(3600)
    // 1 天内第 6 条。
    assert.equal(await consumeDouyinSmsQuota({ redis, userId: 7 }), 'limited')
  })

  test('a limited attempt does not consume any window', async () => {
    const redis = windowRedis()
    assert.equal(await consumeDouyinSmsQuota({ redis, userId: 7 }), 'ok')
    for (let i = 0; i < 5; i += 1)
      assert.equal(await consumeDouyinSmsQuota({ redis, userId: 7 }), 'limited')
    redis.advance(61)
    assert.equal(await consumeDouyinSmsQuota({ redis, userId: 7 }), 'ok')
  })

  test('fails closed: no Redis, a Redis error, an odd reply or a bad user id → unavailable', async () => {
    assert.equal(await consumeDouyinSmsQuota({ redis: null, userId: 7 }), 'unavailable')
    assert.equal(
      await consumeDouyinSmsQuota({
        redis: {
          async eval() {
            throw new Error('ECONNRESET')
          },
        },
        userId: 7,
      }),
      'unavailable',
    )
    assert.equal(
      await consumeDouyinSmsQuota({
        redis: {
          async eval() {
            return 'OK'
          },
        },
        userId: 7,
      }),
      'unavailable',
    )
    assert.equal(await consumeDouyinSmsQuota({ redis: windowRedis(), userId: 0 }), 'unavailable')
  })
})
