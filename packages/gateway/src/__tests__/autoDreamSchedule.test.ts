import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeAutoDreamSchedule } from '../server.js'

describe('Auto-Dream schedule authority boundary', () => {
  it('normalizes a schedule to the authoritative agent, id, and local delivery', () => {
    const normalized = normalizeAutoDreamSchedule(
      JSON.stringify({
        id: 'model-selected-id',
        agent: 'other-agent',
        schedule: '0 9 * * 1',
        prompt: '每周整理本周计划',
        deliver: 'local',
        enabled: true,
      }),
      'main',
      'auto-dream-authoritative-id',
    )
    assert.deepEqual(normalized, {
      id: 'auto-dream-authoritative-id',
      agent: 'main',
      schedule: '0 9 * * 1',
      prompt: '每周整理本周计划',
      deliver: 'local',
      enabled: true,
    })
  })

  it('rejects model-authored external delivery and peer targeting fields', () => {
    assert.throws(
      () =>
        normalizeAutoDreamSchedule(
          JSON.stringify({
            schedule: '0 9 * * 1',
            prompt: 'send externally',
            deliver: 'user',
          }),
          'main',
          'auto-dream-id',
        ),
      /AUTO_DREAM_SCHEDULE_INVALID/,
    )
    assert.throws(
      () =>
        normalizeAutoDreamSchedule(
          JSON.stringify({
            schedule: '0 9 * * 1',
            prompt: 'send externally',
            deliver: 'local',
            deliverTarget: 'attacker-selected-peer',
          }),
          'main',
          'auto-dream-id',
        ),
      /AUTO_DREAM_SCHEDULE_UNKNOWN_FIELD/,
    )
  })
})
