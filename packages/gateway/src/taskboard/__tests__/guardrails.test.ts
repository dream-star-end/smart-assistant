/**
 * 七项护栏逐条单测。不碰真实 ~/.openclaude,不调模型。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/guardrails.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GUARDRAIL_DEFAULTS } from '../domain.js'
import {
  IdleBackoffState,
  PatrolSlotCounter,
  checkCircuitBreaker,
  checkConcurrency,
  checkDailyBudget,
  checkPatrolPaused,
  checkQuietHours,
  checkStageLoop,
  emitGuardrailAlert,
  nextStageLoopCount,
  settingsFromDefaults,
} from '../guardrails.js'

describe('1. 独立并发槽', () => {
  it('默认上限 2,满员后 tryAcquire 失败,release 后恢复', () => {
    const slots = new PatrolSlotCounter(GUARDRAIL_DEFAULTS.maxConcurrentRuns)
    assert.equal(slots.getLimit(), 2)
    assert.equal(checkConcurrency(slots).ok, true)
    assert.equal(slots.tryAcquire(), true)
    assert.equal(slots.tryAcquire(), true)
    assert.equal(slots.tryAcquire(), false)
    const full = checkConcurrency(slots)
    assert.equal(full.ok, false)
    if (!full.ok) assert.equal(full.skipReason, 'concurrency_full')
    slots.release()
    assert.equal(slots.tryAcquire(), true)
  })

  it('与 delegate 全局槽无关:把上限拨到 1 只影响 taskboard', () => {
    const slots = new PatrolSlotCounter(1)
    assert.equal(slots.tryAcquire(), true)
    assert.equal(slots.tryAcquire(), false)
  })
})

describe('2. 每日预算', () => {
  const now = Date.parse('2026-08-17T02:00:00.000Z')

  it('run 数触顶 → budget_exhausted + 稳定 outboundId', () => {
    const settings = settingsFromDefaults({ maxRunsPerDay: 3 })
    const hit = checkDailyBudget({ runsToday: 3, costTodayUsd: 0, activeRuns: 0 }, settings, now)
    assert.equal(hit.ok, false)
    if (!hit.ok) {
      assert.equal(hit.skipReason, 'budget_exhausted')
      assert.equal(hit.alert.outboundId, 'taskboard-budget:2026-08-17')
    }
  })

  it('成本触顶同样暂停;未配成本上限则只看 run 数', () => {
    const withCost = settingsFromDefaults({ maxCostPerDayUsd: 1 })
    const hit = checkDailyBudget({ runsToday: 0, costTodayUsd: 1.5, activeRuns: 0 }, withCost, now)
    assert.equal(hit.ok, false)
    const ok = checkDailyBudget(
      { runsToday: 1, costTodayUsd: 99, activeRuns: 0 },
      settingsFromDefaults({ maxCostPerDayUsd: null, maxRunsPerDay: 200 }),
      now,
    )
    assert.equal(ok.ok, true)
  })
})

describe('3. 静默时段', () => {
  it('默认 23:00–08:00 上海,午夜在静默,上午不在', () => {
    const midnight = new Date('2026-08-16T16:00:00.000Z') // 上海 00:00
    const morning = new Date('2026-08-17T02:00:00.000Z') // 上海 10:00
    const quiet = checkQuietHours(midnight, 'Asia/Shanghai', 23, 8)
    assert.equal(quiet.ok, false)
    if (!quiet.ok) assert.equal(quiet.skipReason, 'outside_window')
    assert.equal(checkQuietHours(morning, 'Asia/Shanghai', 23, 8).ok, true)
  })
})

describe('4. 连败熔断', () => {
  it('连续失败达阈值 → circuit_open,outboundId 含 stage + 日', () => {
    const now = Date.parse('2026-08-17T02:00:00.000Z')
    assert.equal(checkCircuitBreaker(2, 3, 'stage-a', now).ok, true)
    const trip = checkCircuitBreaker(3, 3, 'stage-a', now)
    assert.equal(trip.ok, false)
    if (!trip.ok) {
      assert.equal(trip.skipReason, 'circuit_open')
      assert.equal(trip.alert.outboundId, 'taskboard-fuse:stage-a:2026-08-17')
    }
  })
})

describe('5. 单卡循环检测', () => {
  it('stageLoopCount 达上限 → loop_guard;换 stage 清零', () => {
    assert.equal(nextStageLoopCount(2, true), 3)
    assert.equal(nextStageLoopCount(9, false), 0)
    const ok = checkStageLoop(4, 5, 't1', 's1')
    assert.equal(ok.ok, true)
    const hit = checkStageLoop(5, 5, 't1', 's1')
    assert.equal(hit.ok, false)
    if (!hit.ok) {
      assert.equal(hit.skipReason, 'loop_guard')
      assert.equal(hit.alert.outboundId, 'taskboard-loop:t1:s1')
    }
  })
})

describe('6. 空转降频', () => {
  it('连续空转累加,有候选清零,lastPatrolAt 跟随实际巡检', () => {
    const idle = new IdleBackoffState()
    const t1 = new Date('2026-08-17T02:00:00.000Z')
    const t2 = new Date('2026-08-17T02:01:00.000Z')
    idle.markPatrolAttempt('s1', t1)
    const afterIdle = idle.recordIdle('s1', t1)
    assert.equal(afterIdle.idleTicks, 1)
    assert.equal(afterIdle.lastPatrolAt?.getTime(), t1.getTime())
    idle.recordIdle('s1', t2)
    assert.equal(idle.snapshot('s1').idleTicks, 2)
    idle.recordBusy('s1', t2)
    assert.equal(idle.snapshot('s1').idleTicks, 0)
  })
})

describe('7. 全局急停', () => {
  it('patrolPaused=true 时 tick 应空转', () => {
    const paused = checkPatrolPaused(settingsFromDefaults({ patrolPaused: true }))
    assert.equal(paused.ok, false)
    if (!paused.ok) assert.equal(paused.skipReason, 'patrol_disabled')
    assert.equal(checkPatrolPaused(settingsFromDefaults({ patrolPaused: false })).ok, true)
  })
})

describe('告警接口点(T10 接)', () => {
  it('handler 抛错不能砸调用方', () => {
    assert.doesNotThrow(() =>
      emitGuardrailAlert(
        () => {
          throw new Error('notify down')
        },
        {
          kind: 'budget_exhausted',
          outboundId: 'taskboard-budget:2026-08-17',
          message: 'x',
        },
      ),
    )
  })
})
