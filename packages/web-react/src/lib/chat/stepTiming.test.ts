import { describe, expect, test } from 'vitest'
import type { ChatMessage } from './model'
import { combineStepTimings, computeStepTimings, formatStepDuration } from './stepTiming'

function row(
  id: string,
  role: ChatMessage['role'],
  ts: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, text: '', ts, ...extra } as ChatMessage
}

describe('OCV5-367 步骤耗时', () => {
  test('历史轮(turn tape):工具按 ts+durationMs 结束,思考到下一行开始;各步之和 = 整轮', () => {
    // 形态取自真实 tape(g367-tape-ts-sample.log):工具 ts=arrivedAt,durationMs 是执行时长。
    const rows = [
      row('think', 'thinking', 81_522),
      row('say', 'assistant', 82_153),
      row('t1', 'tool', 86_186, { _completed: true, durationMs: 2_205 }),
      row('t2', 'tool', 88_452, { _completed: true, durationMs: 100 }),
      row('t3', 'tool', 119_065, { _completed: true, durationMs: 11_741 }),
    ]
    const timings = computeStepTimings(rows, {
      turnStartedAt: 60_000,
      turnEndedAt: 140_000,
      active: false,
    })
    expect(timings.get('think')).toEqual({ ms: 82_153 - 60_000 })
    expect(timings.get('say')).toEqual({ ms: 86_186 - 82_153 })
    expect(timings.get('t1')).toEqual({ ms: 88_391 - 86_186 })
    expect(timings.get('t2')).toEqual({ ms: 88_552 - 88_391 })
    // 模型写这条命令的 30 秒算在这一步里,不算到上一条工具头上。
    expect(timings.get('t3')).toEqual({ ms: 130_806 - 88_552 })
    const sum = [...timings.values()].reduce((acc, t) => acc + (t.ms ?? 0), 0)
    expect(sum).toBe(130_806 - 60_000)
  })

  test('实时:工具以结果到达时刻(completedAt)结束;仍在跑的工具从上一步结束起计时', () => {
    const rows = [
      row('t1', 'tool', 1_000, { _completed: true, completedAt: 4_000 }),
      row('t2', 'tool', 9_000, { _completed: false }),
    ]
    const timings = computeStepTimings(rows, { turnStartedAt: 500, active: true })
    expect(timings.get('t1')).toEqual({ ms: 3_500 })
    expect(timings.get('t2')).toEqual({ runningSince: 4_000 })
  })

  test('并行工具:被上一步完全覆盖的一步显示自身时长,不出现 0 或负数', () => {
    const rows = [
      row('slow', 'tool', 1_000, { _completed: true, completedAt: 10_000 }),
      row('fast', 'tool', 1_100, { _completed: true, completedAt: 3_000 }),
      row('next', 'tool', 12_000, { _completed: true, completedAt: 12_500 }),
    ]
    const timings = computeStepTimings(rows, { active: false })
    expect(timings.get('slow')).toEqual({ ms: 9_000 })
    expect(timings.get('fast')).toEqual({ ms: 1_900 })
    expect(timings.get('next')).toEqual({ ms: 2_500 })
  })

  test('没有可信时间就不给:live-units 行、历史末行无终点、非进行中的未完成工具', () => {
    const rows = [
      row('unit', 'tool', 5_000, { _liveUnit: true, _completed: true }),
      row('t1', 'tool', 6_000, { _completed: true, durationMs: 500 }),
      row('dangling', 'thinking', 7_000),
    ]
    const timings = computeStepTimings(rows, { active: false })
    expect(timings.has('unit')).toBe(false)
    expect(timings.get('t1')).toEqual({ ms: 500 })
    expect(timings.has('dangling')).toBe(false)
    expect(computeStepTimings([row('x', 'tool', 0)], { active: true }).size).toBe(0)
  })

  test('轮起点晚于首步或相隔超过一天(不同时钟)时不用,改从首步开始算', () => {
    const rows = [row('t1', 'tool', 10_000, { _completed: true, durationMs: 1_000 })]
    expect(computeStepTimings(rows, { turnStartedAt: 20_000, active: false }).get('t1')).toEqual({
      ms: 1_000,
    })
    expect(
      computeStepTimings(rows, { turnStartedAt: 10_000 - 25 * 3600_000, active: false }).get('t1'),
    ).toEqual({ ms: 1_000 })
  })

  test('合并的思考组:各段相加;末段进行中则整体从累计值往上跳', () => {
    const timings = new Map([
      ['a', { ms: 2_000 }],
      ['b', { runningSince: 10_000 }],
    ] as const)
    expect(combineStepTimings(timings, ['a'])).toEqual({ ms: 2_000 })
    expect(combineStepTimings(timings, ['a', 'b'])).toEqual({ runningSince: 8_000 })
    expect(combineStepTimings(timings, ['a', 'missing'])).toBeUndefined()
    expect(combineStepTimings(null, ['a'])).toBeUndefined()
  })

  test.each([
    [0, '<0.1 秒'],
    [420, '0.4 秒'],
    [9_949, '9.9 秒'],
    [12_400, '12 秒'],
    [185_000, '3 分 05 秒'],
    [999_000, '16 分 39 秒'],
    [3_780_000, '1 小时 03 分'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatStepDuration(ms)).toBe(text)
  })
})
