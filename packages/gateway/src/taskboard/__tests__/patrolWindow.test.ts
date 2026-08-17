import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GUARDRAIL_DEFAULTS } from '../domain.js'
import {
  type PatrolStageView,
  cronMatches,
  isInQuietHours,
  shouldPatrol,
  zonedDateParts,
} from '../patrolWindow.js'

/** 2026-08-16T16:00:00Z = 上海周一 00:00 / 纽约周日 12:00 / UTC 周日 16:00 */
const INSTANT = new Date('2026-08-16T16:00:00.000Z')

function stage(over: Partial<PatrolStageView> = {}): PatrolStageView {
  return {
    patrolEnabled: true,
    patrolCron: '* * * * *',
    patrolTimezone: 'Asia/Shanghai',
    quietHoursStart: 23,
    quietHoursEnd: 8,
    ...over,
  }
}

describe('cronMatches 时区', () => {
  it('同一瞬间只在对应时区命中', () => {
    // 上海 00:00 周一
    assert.equal(cronMatches('0 0 * * 1', INSTANT, 'Asia/Shanghai'), true)
    assert.equal(cronMatches('0 0 * * 1', INSTANT, 'UTC'), false)
    assert.equal(cronMatches('0 0 * * 1', INSTANT, 'America/New_York'), false)
    // 纽约 12:00 周日
    assert.equal(cronMatches('0 12 * * 0', INSTANT, 'America/New_York'), true)
    assert.equal(cronMatches('0 12 * * 0', INSTANT, 'Asia/Shanghai'), false)
    assert.equal(cronMatches('0 12 * * 0', INSTANT, 'UTC'), false)
    // UTC 16:00 周日
    assert.equal(cronMatches('0 16 * * 0', INSTANT, 'UTC'), true)
    assert.equal(cronMatches('0 16 * * 0', INSTANT, 'Asia/Shanghai'), false)
  })

  it('zonedDateParts 对非 UTC 时区给出本地字段', () => {
    const sh = zonedDateParts(INSTANT, 'Asia/Shanghai')
    assert.deepEqual(sh, { minute: 0, hour: 0, day: 17, month: 8, weekday: 1 })
    const ny = zonedDateParts(INSTANT, 'America/New_York')
    assert.deepEqual(ny, { minute: 0, hour: 12, day: 16, month: 8, weekday: 0 })
  })
})

describe('cronMatches 语法', () => {
  const at = new Date('2026-08-16T01:15:00.000Z') // 上海 09:15 周日

  it('支持 */n', () => {
    assert.equal(cronMatches('*/15 9 * * *', at, 'Asia/Shanghai'), true)
    assert.equal(cronMatches('*/10 9 * * *', at, 'Asia/Shanghai'), false)
    assert.equal(cronMatches('*/15 8 * * *', at, 'Asia/Shanghai'), false)
  })

  it('支持 a-b 与 a,b,c', () => {
    assert.equal(cronMatches('15 9-17 * * *', at, 'Asia/Shanghai'), true)
    assert.equal(cronMatches('15 10-17 * * *', at, 'Asia/Shanghai'), false)
    assert.equal(cronMatches('15 8,9,10 * * 0', at, 'Asia/Shanghai'), true)
    assert.equal(cronMatches('15 8,10 * * 0', at, 'Asia/Shanghai'), false)
  })

  it('支持 a-b/n', () => {
    // 9,11,13,15,17 — 09:15 命中小时 9
    assert.equal(cronMatches('15 9-17/2 * * *', at, 'Asia/Shanghai'), true)
    assert.equal(cronMatches('15 10-17/2 * * *', at, 'Asia/Shanghai'), false)
    // 10,12,14,16 — 09 不在
    assert.equal(cronMatches('15 10-16/2 * * *', at, 'Asia/Shanghai'), false)
    const at11 = new Date('2026-08-16T03:15:00.000Z') // 上海 11:15
    assert.equal(cronMatches('15 9-17/2 * * *', at11, 'Asia/Shanghai'), true)
  })

  it('字段数不对 → false', () => {
    assert.equal(cronMatches('* * *', at, 'UTC'), false)
    assert.equal(cronMatches('* * * * * *', at, 'UTC'), false)
  })
})

describe('isInQuietHours 跨午夜', () => {
  it('23→8 跨午夜:23 点与凌晨在窗内,8 点整已出窗', () => {
    const tz = 'Asia/Shanghai'
    // 上海 23:00 = UTC 15:00 同日
    assert.equal(isInQuietHours(new Date('2026-08-16T15:00:00.000Z'), tz, 23, 8), true)
    // 上海 00:30 = UTC 16:30 前日
    assert.equal(isInQuietHours(new Date('2026-08-16T16:30:00.000Z'), tz, 23, 8), true)
    // 上海 07:59
    assert.equal(isInQuietHours(new Date('2026-08-15T23:59:00.000Z'), tz, 23, 8), true)
    // 上海 08:00 出静默
    assert.equal(isInQuietHours(new Date('2026-08-16T00:00:00.000Z'), tz, 23, 8), false)
    // 上海 22:59 未进静默
    assert.equal(isInQuietHours(new Date('2026-08-16T14:59:00.000Z'), tz, 23, 8), false)
  })

  it('同时区下纽约白天不落进 23→8', () => {
    // INSTANT = 纽约 12:00
    assert.equal(isInQuietHours(INSTANT, 'America/New_York', 23, 8), false)
    assert.equal(isInQuietHours(INSTANT, 'Asia/Shanghai', 23, 8), true)
  })

  it('同日区间与起止相同', () => {
    const noonSh = new Date('2026-08-16T04:00:00.000Z') // 上海 12:00
    assert.equal(isInQuietHours(noonSh, 'Asia/Shanghai', 12, 14), true)
    assert.equal(isInQuietHours(noonSh, 'Asia/Shanghai', 13, 14), false)
    assert.equal(isInQuietHours(noonSh, 'Asia/Shanghai', 8, 8), false)
  })
})

describe('shouldPatrol', () => {
  const workHour = new Date('2026-08-17T02:00:00.000Z') // 上海周一 10:00,不在 23-8

  it('patrolEnabled 关闭则不巡,且不填 skipReason', () => {
    const v = shouldPatrol(stage({ patrolEnabled: false }), workHour)
    assert.equal(v.patrol, false)
    if (!v.patrol) {
      assert.equal(v.skipReason, undefined)
      assert.match(v.detail, /关闭巡检/)
    }
  })

  it('未配置 cron 不巡', () => {
    const v = shouldPatrol(stage({ patrolCron: null }), workHour)
    assert.equal(v.patrol, false)
  })

  it('不在 cron 匹配点 → outside_window', () => {
    const v = shouldPatrol(stage({ patrolCron: '0 9 * * *' }), workHour)
    assert.equal(v.patrol, false)
    if (!v.patrol) assert.equal(v.skipReason, 'outside_window')
  })

  it('落在静默时段 → outside_window(默认 23-8)', () => {
    const night = new Date('2026-08-16T16:30:00.000Z') // 上海 00:30
    const v = shouldPatrol(
      stage({
        patrolCron: '* * * * *',
        quietHoursStart: null,
        quietHoursEnd: null,
      }),
      night,
    )
    assert.equal(v.patrol, false)
    if (!v.patrol) {
      assert.equal(v.skipReason, 'outside_window')
      assert.match(v.detail, /静默/)
    }
  })

  it('stage 覆盖静默时段后工作时间可巡', () => {
    const v = shouldPatrol(
      stage({
        patrolCron: '0 10 * * 1',
        quietHoursStart: 0,
        quietHoursEnd: 0,
      }),
      workHour,
    )
    assert.equal(v.patrol, true)
  })

  it('空转降频:连续空转后未满间隔则跳过', () => {
    const last = new Date(workHour.getTime() - 5 * 60 * 1000)
    const v = shouldPatrol(
      stage({
        patrolCron: '* * * * *',
        quietHoursStart: 0,
        quietHoursEnd: 0,
        idleBackoffAfterTicks: GUARDRAIL_DEFAULTS.idleBackoffAfterTicks,
        idleBackoffIntervalMs: GUARDRAIL_DEFAULTS.idleBackoffIntervalMs,
      }),
      workHour,
      last,
      GUARDRAIL_DEFAULTS.idleBackoffAfterTicks,
    )
    assert.equal(v.patrol, false)
    if (!v.patrol) {
      assert.equal(v.skipReason, 'outside_window')
      assert.match(v.detail, /降频/)
    }
  })

  it('空转降频:间隔已过则恢复巡检', () => {
    const last = new Date(workHour.getTime() - GUARDRAIL_DEFAULTS.idleBackoffIntervalMs - 1)
    const v = shouldPatrol(
      stage({ patrolCron: '* * * * *', quietHoursStart: 0, quietHoursEnd: 0 }),
      workHour,
      last,
      GUARDRAIL_DEFAULTS.idleBackoffAfterTicks,
    )
    assert.equal(v.patrol, true)
  })

  it('空转未达阈值不降频', () => {
    const last = new Date(workHour.getTime() - 1000)
    const v = shouldPatrol(
      stage({ patrolCron: '* * * * *', quietHoursStart: 0, quietHoursEnd: 0 }),
      workHour,
      last,
      GUARDRAIL_DEFAULTS.idleBackoffAfterTicks - 1,
    )
    assert.equal(v.patrol, true)
  })

  it('到点且不在静默、无降频 → 巡检', () => {
    const v = shouldPatrol(
      stage({ patrolCron: '0 10 * * 1', quietHoursStart: 23, quietHoursEnd: 8 }),
      workHour,
    )
    assert.equal(v.patrol, true)
  })
})
