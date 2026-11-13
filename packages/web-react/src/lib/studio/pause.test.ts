import { describe, expect, test } from 'vitest'

import { studioPause } from './pause'
import type { StudioEvent, StudioProject } from './types'

const project = (over: Partial<StudioProject>): StudioProject =>
  ({
    id: 'p',
    title: '',
    brief: '',
    status: 'running',
    autonomy: 'max',
    aspect: '16:9',
    fps: 24,
    targetSec: 30,
    budgetCredits: '1',
    spentCredits: '0',
    reservedCredits: '0',
    settings: {},
    rev: 1,
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as StudioProject

const ev = (type: string, message: string, ts = '2026-11-01T02:00:00Z'): StudioEvent => ({
  id: type,
  ts,
  type,
  payload: { message },
})

describe('studioPause', () => {
  test('a provider outage continues through approve, same as the brief page', () => {
    const p = studioPause(
      project({ status: 'awaiting_user', settings: { awaitingReason: 'provider_failure' } }),
      [ev('project.awaiting_user', '视频服务暂时无法接收首帧，制作已暂停，已有结果会保留。')],
    )
    expect(p).toEqual({
      action: 'approve',
      reason: '视频服务暂时无法接收首帧，制作已暂停，已有结果会保留。',
    })
  })

  test('a user pause continues through resume and ignores an older outage message', () => {
    const p = studioPause(project({ status: 'paused', settings: { resumeTo: 'running' } }), [
      ev('project.awaiting_user', '旧的服务暂停', '2026-11-01T01:00:00Z'),
      ev('budget.exhausted', '预算不够下一步了，已暂停。调高预算后点继续。', '2026-11-01T03:00:00Z'),
    ])
    expect(p?.action).toBe('resume')
    expect(p?.reason).toContain('预算不够')
  })

  test('a running project has no continue', () => {
    expect(studioPause(project({ status: 'running' }), [])).toBeNull()
  })
})
