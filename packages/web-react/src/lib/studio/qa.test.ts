import { describe, expect, test } from 'vitest'

import { eventTone } from './model'
import { qaView, recommendedTakes } from './qa'
import type { StudioEvent, StudioProjectView } from './types'

describe('QA as the user reads it (OCV5-593 FE-7a)', () => {
  test('outcome and reason in words; moderation; issues', () => {
    expect(qaView(null)).toEqual({ outcome: null, outcomeText: null, moderation: null, issues: [] })
    expect(qaView({ next: 'adopt', reason: 'passed', moderation: 'pass' })).toMatchObject({
      outcome: 'passed',
      outcomeText: '质检通过',
      moderation: 'pass',
    })
    expect(
      qaView({
        next: 'handoff',
        reason: 'retries_exhausted',
        issues: [{ frame: 'F2', what: '尾巴颜色不对' }, { what: '' }, 'x'],
      }),
    ).toMatchObject({
      outcome: 'handoff',
      outcomeText: '自动重做了 2 次仍未通过，交给你选',
      issues: ['尾巴颜色不对'],
    })
    expect(qaView({ next: 'redo', reason: 'below_threshold' }).outcomeText).toBe(
      '质检没通过，已自动重做',
    )
    expect(qaView({ skipped: true, reason: 'no_sandbox' })).toMatchObject({
      outcome: 'skipped',
      outcomeText: '合成沙箱未配置，视频没有质检',
    })
    // A take judged before outcomes existed (score only) shows no outcome line.
    expect(qaView({ score: 0.9 }).outcomeText).toBeNull()
  })

  test("the versions QA offered come from the shot's latest hand-off", () => {
    const ev = (id: string, shotId: string, takeIds: string[]): StudioEvent =>
      ({ id, ts: '', type: 'shot.needs_user', payload: { shotId, takeIds } }) as StudioEvent
    const view = {
      events: [ev('3', 's1', ['a', 'b']), ev('9', 's1', ['c', 'd']), ev('10', 's2', ['e'])],
    } as unknown as StudioProjectView
    expect([...recommendedTakes(view, 's1')]).toEqual(['c', 'd'])
    expect(recommendedTakes(view, 's3').size).toBe(0)
  })

  test('QA and moderation events read as ok / retry / bad', () => {
    const tone = (type: string) => eventTone({ id: '1', ts: '', type, payload: {} } as StudioEvent)
    expect(tone('qa.passed')).toBe('ok')
    expect(tone('qa.redo')).toBe('retry')
    expect(tone('brief.moderation')).toBe('bad')
    expect(tone('brief.moderation_deferred')).toBe('info')
  })
})
