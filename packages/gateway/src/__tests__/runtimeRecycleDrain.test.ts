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
})
