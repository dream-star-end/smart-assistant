import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  RuntimeRecycleDrainCoordinator,
  type RuntimeRecycleDrainDeps,
  attemptRuntimeRecycleDrain,
} from '../runtimeRecycleDrain.js'

function harness(overrides: Partial<RuntimeRecycleDrainDeps> = {}) {
  let now = 1_000
  let gatewayUntil = 0
  let sessionUntil = 0
  let gatewayReleases = 0
  let sessionReleases = 0
  let ingress = 0
  const ttlMs = 10_000

  const deps: RuntimeRecycleDrainDeps = {
    ttlMs,
    now: () => now,
    armGatewayDrain: (until) => {
      gatewayUntil = until
    },
    isGatewayDrainActive: (at) => gatewayUntil > at,
    releaseGatewayDrain: () => {
      gatewayUntil = 0
      gatewayReleases++
    },
    armSessionDrain: (ttl) => {
      sessionUntil = now + ttl
      return { accepted: true, activeTurns: 0 }
    },
    isSessionDrainActive: (at) => sessionUntil > at,
    releaseSessionDrain: () => {
      sessionUntil = 0
      sessionReleases++
    },
    activeIngress: () => ingress,
    countDurableRunning: async () => 0,
    ...overrides,
  }

  return {
    deps,
    setNow(value: number) {
      now = value
    },
    setIngress(value: number) {
      ingress = value
    },
    state: () => ({ gatewayUntil, sessionUntil, gatewayReleases, sessionReleases }),
  }
}

describe('planned runtime recycle drain', () => {
  test('双内存闸 + durable running 均空才返回 200,闸门保持 armed', async () => {
    const h = harness()
    const decision = await attemptRuntimeRecycleDrain(h.deps)
    assert.deepEqual(decision, { ok: true, status: 200, drainTtlMs: 10_000 })
    assert.ok(h.state().gatewayUntil > 1_000)
    assert.ok(h.state().sessionUntil > 1_000)
    assert.equal(h.state().gatewayReleases, 0)
    assert.equal(h.state().sessionReleases, 0)
  })

  test('in-memory active 或 durable running 均 409 并释放双闸', async () => {
    const ingress = harness()
    ingress.setIngress(1)
    const ingressDecision = await attemptRuntimeRecycleDrain(ingress.deps)
    assert.equal(ingressDecision.ok, false)
    assert.equal(ingressDecision.status, 409)
    assert.deepEqual(
      { gateway: ingress.state().gatewayUntil, session: ingress.state().sessionUntil },
      { gateway: 0, session: 0 },
    )

    const durable = harness({ countDurableRunning: async () => 2 })
    const durableDecision = await attemptRuntimeRecycleDrain(durable.deps)
    assert.equal(durableDecision.ok, false)
    assert.equal(durableDecision.status, 409)
    if (!durableDecision.ok) assert.equal(durableDecision.durableRunning, 2)
    assert.equal(durable.state().gatewayUntil, 0)
    assert.equal(durable.state().sessionUntil, 0)
  })

  test('SessionManager 拒绝或 SQLite await 期间新 ingress 均不得穿过 drain', async () => {
    const sessionBusy = harness({
      armSessionDrain: () => ({ accepted: false, activeTurns: 2 }),
    })
    const sessionDecision = await attemptRuntimeRecycleDrain(sessionBusy.deps)
    assert.equal(sessionDecision.ok, false)
    assert.equal(sessionDecision.status, 409)
    if (!sessionDecision.ok) assert.equal(sessionDecision.activeTurns, 2)
    assert.equal(sessionBusy.state().gatewayUntil, 0)

    const racedIngress = harness()
    racedIngress.deps.countDurableRunning = async () => {
      racedIngress.setIngress(1)
      return 0
    }
    const racedDecision = await attemptRuntimeRecycleDrain(racedIngress.deps)
    assert.equal(racedDecision.ok, false)
    assert.equal(racedDecision.status, 409)
    if (!racedDecision.ok) assert.equal(racedDecision.activeIngress, 1)
    assert.equal(racedIngress.state().gatewayUntil, 0)
    assert.equal(racedIngress.state().sessionUntil, 0)
  })

  test('durable state 读取失败时 fail-closed 503 并释放双闸', async () => {
    const h = harness({
      countDurableRunning: async () => {
        throw new Error('sqlite busy')
      },
    })
    assert.deepEqual(await attemptRuntimeRecycleDrain(h.deps), {
      ok: false,
      status: 503,
      reason: 'drain_state_unavailable',
    })
    assert.equal(h.state().gatewayUntil, 0)
    assert.equal(h.state().sessionUntil, 0)
  })

  test('await durable read 期间 TTL 过期不得返回 200', async () => {
    const h = harness()
    h.deps.countDurableRunning = async () => {
      h.setNow(11_001)
      return 0
    }
    assert.deepEqual(await attemptRuntimeRecycleDrain(h.deps), {
      ok: false,
      status: 503,
      reason: 'drain_fence_expired',
    })
    assert.equal(h.state().gatewayUntil, 0)
    assert.equal(h.state().sessionUntil, 0)
  })

  test('optional runningDelegateJobs 计入 409,缺省钩子不改 flag-off 形状', async () => {
    const withJobs = harness({ countRunningDelegateJobs: async () => 2 })
    const busy = await attemptRuntimeRecycleDrain(withJobs.deps)
    assert.equal(busy.ok, false)
    assert.equal(busy.status, 409)
    if (!busy.ok) {
      assert.equal(busy.runningDelegateJobs, 2)
      assert.equal(busy.durableRunning, 2)
    }

    const flagOff = harness()
    const ok = await attemptRuntimeRecycleDrain(flagOff.deps)
    assert.deepEqual(ok, { ok: true, status: 200, drainTtlMs: 10_000 })
    assert.equal('runningDelegateJobs' in ok, false)
  })

  test('freeze 在 await 前持有,409/503 释放,200 保留 holder', async () => {
    const holders = new Set<string>()
    const busy = harness({
      freezeDelegateDispatch: (holder) => {
        holders.add(holder)
      },
      thawDelegateDispatch: (holder) => {
        holders.delete(holder)
      },
      countDurableRunning: async () => 1,
    })
    const busyDecision = await attemptRuntimeRecycleDrain(busy.deps)
    assert.equal(busyDecision.ok, false)
    assert.equal(busyDecision.status, 409)
    assert.equal(holders.size, 0)

    const okHolders = new Set<string>()
    const ok = harness({
      freezeDelegateDispatch: (holder) => {
        okHolders.add(holder)
      },
      thawDelegateDispatch: (holder) => {
        okHolders.delete(holder)
      },
    })
    const okDecision = await attemptRuntimeRecycleDrain(ok.deps)
    assert.equal(okDecision.ok, true)
    assert.equal(okHolders.size, 1)
    if (okDecision.ok) assert.equal(typeof okDecision.freezeHolder, 'string')
  })

  test('freeze 后未预期抛错必须 thaw,不得留下哑 freeze', async () => {
    const holders = new Set<string>()
    const h = harness({
      freezeDelegateDispatch: (holder) => {
        holders.add(holder)
      },
      thawDelegateDispatch: (holder) => {
        holders.delete(holder)
      },
      armGatewayDrain: () => {
        throw new Error('boom')
      },
    })
    await assert.rejects(() => attemptRuntimeRecycleDrain(h.deps), /boom/)
    assert.equal(holders.size, 0)
  })

  test('ACK 前同步 peek 看到 running 则 409,即使 await count 返回 0', async () => {
    let running = 0
    const h = harness({
      freezeDelegateDispatch: () => {},
      thawDelegateDispatch: () => {},
      countRunningDelegateJobs: async () => {
        queueMicrotask(() => {
          running = 1
        })
        return 0
      },
      peekRunningDelegateJobs: () => running,
    })
    const decision = await attemptRuntimeRecycleDrain(h.deps)
    assert.equal(decision.ok, false)
    assert.equal(decision.status, 409)
    if (!decision.ok) assert.equal(decision.runningDelegateJobs, 1)
  })

  test('重叠握手串行化:后请求不得释放先请求已受理的双闸', async () => {
    const h = harness()
    let durableReads = 0
    let resolveRead: ((value: number) => void) | undefined
    h.deps.countDurableRunning = () => {
      durableReads++
      return new Promise<number>((resolve) => {
        resolveRead = resolve
      })
    }
    const coordinator = new RuntimeRecycleDrainCoordinator(h.deps)

    const first = coordinator.attempt()
    assert.equal(durableReads, 1)
    assert.deepEqual(await coordinator.attempt(), {
      ok: false,
      status: 409,
      reason: 'drain_in_progress',
    })
    assert.equal(durableReads, 1)

    resolveRead?.(0)
    assert.deepEqual(await first, { ok: true, status: 200, drainTtlMs: 10_000 })
    h.deps.countDurableRunning = async () => {
      durableReads++
      throw new Error('must not run while accepted fence is active')
    }
    assert.deepEqual(await coordinator.attempt(), {
      ok: false,
      status: 409,
      reason: 'drain_in_progress',
    })
    assert.equal(durableReads, 1)
    assert.equal(h.state().gatewayReleases, 0)
    assert.equal(h.state().sessionReleases, 0)

    // Once the retained fence really expires, a later supervisor may start a
    // fresh evaluation; its own failure then releases only that fresh attempt.
    h.setNow(11_001)
    assert.deepEqual(await coordinator.attempt(), {
      ok: false,
      status: 503,
      reason: 'drain_state_unavailable',
    })
    assert.equal(durableReads, 2)
    assert.equal(h.state().gatewayReleases, 1)
    assert.equal(h.state().sessionReleases, 1)
  })

  test('200 attaches holder expiry at ACK now + ttlMs; pending freeze has none', async () => {
    const calls: Array<{ holder: string; expiresAt?: number }> = []
    const h = harness({
      freezeDelegateDispatch: (holder, expiresAt) => {
        calls.push({ holder, expiresAt })
      },
      thawDelegateDispatch: () => {},
    })
    const decision = await attemptRuntimeRecycleDrain(h.deps)
    assert.equal(decision.ok, true)
    if (decision.ok) assert.equal(decision.freezeHolder, 'drain:1000')
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.holder, 'drain:1000')
    assert.equal(calls[0]?.expiresAt, undefined)
    assert.equal(calls[1]?.holder, 'drain:1000')
    assert.equal(calls[1]?.expiresAt, 11_000)
  })
})
