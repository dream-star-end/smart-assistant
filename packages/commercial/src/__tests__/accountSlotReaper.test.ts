/**
 * B7 — accountSlotReaper sweeper 单元测试。不触 DB。
 * 验证 runNow/runOnStart/log/onError 契约,不依赖 setInterval 真实触发(避免 flaky)。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  startAccountSlotReaper,
  type SlotReapable,
} from '../account-pool/accountSlotReaper.js'

function mkScheduler(reapReturns: number | (() => number)): {
  scheduler: SlotReapable
  calls: () => number
} {
  let calls = 0
  const scheduler: SlotReapable = {
    reapExpiredSlots() {
      calls += 1
      return typeof reapReturns === 'function' ? reapReturns() : reapReturns
    },
  }
  return { scheduler, calls: () => calls }
}

describe('startAccountSlotReaper', () => {
  test('runNow 返回 scheduler.reapExpiredSlots 的回收数', () => {
    const { scheduler } = mkScheduler(3)
    const h = startAccountSlotReaper({ scheduler, intervalMs: 60_000 })
    try {
      assert.equal(h.runNow(), 3)
    } finally {
      h.stop()
    }
  })

  test('runOnStart 默认 false:boot 不调 reap', () => {
    const { scheduler, calls } = mkScheduler(0)
    const h = startAccountSlotReaper({ scheduler, intervalMs: 60_000 })
    try {
      assert.equal(calls(), 0)
    } finally {
      h.stop()
    }
  })

  test('runOnStart=true:boot 立即调一次', () => {
    const { scheduler, calls } = mkScheduler(0)
    const h = startAccountSlotReaper({
      scheduler,
      intervalMs: 60_000,
      runOnStart: true,
    })
    try {
      assert.equal(calls(), 1)
    } finally {
      h.stop()
    }
  })

  test('回收数>0 才 log;=0 不 log', () => {
    let logged = 0
    const seq = [2, 0]
    let i = 0
    const { scheduler } = mkScheduler(() => seq[i++] ?? 0)
    const h = startAccountSlotReaper({
      scheduler,
      intervalMs: 60_000,
      log: () => {
        logged += 1
      },
    })
    try {
      h.runNow() // 2 → log
      h.runNow() // 0 → 不 log
      assert.equal(logged, 1)
    } finally {
      h.stop()
    }
  })

  test('reapExpiredSlots 抛错:runNow 返 0 + onError 捕获,不抛', () => {
    let errs = 0
    const scheduler: SlotReapable = {
      reapExpiredSlots() {
        throw new Error('boom')
      },
    }
    const h = startAccountSlotReaper({
      scheduler,
      intervalMs: 60_000,
      onError: () => {
        errs += 1
      },
    })
    try {
      assert.equal(h.runNow(), 0)
      assert.equal(errs, 1)
    } finally {
      h.stop()
    }
  })

  test('stop() 幂等且不抛', () => {
    const { scheduler } = mkScheduler(0)
    const h = startAccountSlotReaper({ scheduler, intervalMs: 60_000 })
    h.stop()
    h.stop()
  })
})
