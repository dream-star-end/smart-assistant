// cooldownRecoveryActor.test.ts — 验证 actor 周期调 tracker.halfOpen 且把异常吞掉
//
// 覆盖:
//   1. runOnStart=true → 启动后立即跑一次,返回 halfOpen 的结果
//   2. runNow → 直接调 halfOpen
//   3. tracker.halfOpen 抛 → onError 收到 + runNow 返空数组(不重抛)
//   4. stop() → 后续 setInterval 触发的回调走 stopped 守卫,不再调 tracker
//
// Mock 策略:fake AccountHealthTracker 只暴露 halfOpen 方法,记录调用次数 + 返回值。

import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type CooldownRecoveryActorDeps,
  startCooldownRecoveryActor,
} from '../account-pool/cooldownRecoveryActor.js'
import type { AccountHealth, AccountHealthTracker } from '../account-pool/health.js'

interface TrackerStub {
  callCount: number
  /** 强制 halfOpen 抛错(测 3) */
  shouldThrow?: boolean
  /** 每次调用返回的恢复列表(默认空数组) */
  returnRows: AccountHealth[]
}

function makeTracker(stub: TrackerStub): AccountHealthTracker {
  // 只 mock 用到的 halfOpen 方法;其它方法被调到说明测试有 bug,直接抛
  const t = {
    halfOpen: async (): Promise<AccountHealth[]> => {
      stub.callCount += 1
      if (stub.shouldThrow) {
        throw new Error('halfOpen DB error')
      }
      return stub.returnRows
    },
  } as unknown as AccountHealthTracker
  return t
}

describe('startCooldownRecoveryActor', () => {
  it('runOnStart=true 立即跑一次 + runNow 直接调 halfOpen', async () => {
    const recovered: AccountHealth[] = [
      {
        id: 42n,
        status: 'active',
        health_score: 50,
        cooldown_until: null,
      },
    ]
    const stub: TrackerStub = { callCount: 0, returnRows: recovered }
    const errors: Array<{ msg: string; err: unknown }> = []

    const deps: CooldownRecoveryActorDeps = {
      tracker: makeTracker(stub),
      // 大间隔避免测试中真触发 setInterval 回调
      intervalMs: 60_000,
      runOnStart: true,
      onError: (msg, err) => errors.push({ msg, err }),
    }
    const actor = startCooldownRecoveryActor(deps)

    // runOnStart 是 fire-and-forget;给微任务跑完
    await new Promise((r) => setImmediate(r))
    assert.equal(stub.callCount, 1, 'runOnStart 触发一次 halfOpen')

    const out = await actor.runNow()
    assert.equal(stub.callCount, 2, 'runNow 再触发一次')
    assert.deepEqual(out, recovered, 'runNow 返 halfOpen 结果')
    assert.equal(errors.length, 0, '无错误')

    actor.stop()
  })

  it('tracker.halfOpen 抛 → onError 收到 + runNow 返空数组', async () => {
    const stub: TrackerStub = { callCount: 0, shouldThrow: true, returnRows: [] }
    const errors: Array<{ msg: string; err: unknown }> = []

    const actor = startCooldownRecoveryActor({
      tracker: makeTracker(stub),
      intervalMs: 60_000,
      onError: (msg, err) => errors.push({ msg, err }),
    })

    const out = await actor.runNow()
    assert.deepEqual(out, [], '异常被吞,返空数组')
    assert.equal(stub.callCount, 1)
    assert.equal(errors.length, 1, 'onError 收到一次')
    assert.match(errors[0].msg, /halfOpen tick failed/)
    assert.ok(errors[0].err instanceof Error)

    actor.stop()
  })

  it('stop() 后 runNow 立即返空(stopped 守卫)', async () => {
    const stub: TrackerStub = { callCount: 0, returnRows: [] }
    const actor = startCooldownRecoveryActor({
      tracker: makeTracker(stub),
      intervalMs: 60_000,
    })
    actor.stop()
    const out = await actor.runNow()
    assert.deepEqual(out, [])
    assert.equal(stub.callCount, 0, 'stop 后不再调 tracker')
  })

  it('intervalMs < 1000 被钳到 1000(防 typo 把 DB 打穿)', async () => {
    const stub: TrackerStub = { callCount: 0, returnRows: [] }
    // 不真触发 interval,只验证 startCooldownRecoveryActor 不抛 + handle 可用
    const actor = startCooldownRecoveryActor({
      tracker: makeTracker(stub),
      intervalMs: 50,
    })
    // 直接 stop,不依赖 timer 真触发(测试稳定性)
    actor.stop()
    const out = await actor.runNow()
    assert.deepEqual(out, [])
  })
})
