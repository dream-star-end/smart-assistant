import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  rejectClientAssignedResumeIds,
  resolveReminderResume,
} from '../reminderResume.js'

describe('rejectClientAssignedResumeIds', () => {
  it('rejects model-supplied session identifiers', () => {
    assert.match(
      rejectClientAssignedResumeIds({ schedule: '0 9 * * *', sessionId: 'x' }) ?? '',
      /sessionId/,
    )
    assert.equal(rejectClientAssignedResumeIds({ schedule: '0 9 * * *', message: 'hi' }), null)
  })
})

describe('resolveReminderResume', () => {
  it('defaults to isolated when resume omitted', () => {
    assert.deepEqual(resolveReminderResume({}), { ok: true })
    assert.deepEqual(resolveReminderResume({ resume: 'isolated' }), { ok: true })
  })

  it('stamps originSessionKey from env, never from args', () => {
    const r = resolveReminderResume(
      { resume: 'origin-session' },
      { OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:dm:sess-1' },
    )
    assert.deepEqual(r, {
      ok: true,
      resume: 'origin-session',
      originSessionKey: 'agent:main:webchat:dm:sess-1',
    })
  })

  it('errors when origin-session is requested without a live session key', () => {
    const r = resolveReminderResume({ resume: 'origin-session' }, {})
    assert.equal(r.ok, false)
  })
})
