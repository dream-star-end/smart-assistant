import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DELEGATE_ENGINE_BILLING_SESSION_KEY_MAX_CHARS,
  DELEGATE_ENGINE_BILLING_SESSION_KEY_RE,
} from '../sessionKey.js'

const TASKBOARD_SESSION_KEY_155 =
  'agent:stage-triage:taskboard:5bfa0bd1-72de-47a4-b75b-a5a4d75e2eee:852859fa-cf1d-481c-96fd-23f2966b8b5f.stage.feature.0:3057ab8d-4308-46b6-b5f8-09f118294897'

describe('DELEGATE_ENGINE_BILLING_SESSION_KEY_RE', () => {
  it('caps at 240 for sessionLog NAME_MAX headroom, not VARCHAR(512)', () => {
    assert.equal(DELEGATE_ENGINE_BILLING_SESSION_KEY_MAX_CHARS, 240)
    assert.equal(
      DELEGATE_ENGINE_BILLING_SESSION_KEY_RE.source,
      `^[A-Za-z0-9_:@.-]{1,${DELEGATE_ENGINE_BILLING_SESSION_KEY_MAX_CHARS}}$`,
    )
  })

  it('accepts a real 155-char taskboard patrol sessionKey', () => {
    assert.equal(TASKBOARD_SESSION_KEY_155.length, 155)
    assert.equal(DELEGATE_ENGINE_BILLING_SESSION_KEY_RE.test(TASKBOARD_SESSION_KEY_155), true)
  })

  it('accepts 240, rejects 241, illegal characters, and empty string', () => {
    assert.equal(DELEGATE_ENGINE_BILLING_SESSION_KEY_RE.test('a'.repeat(240)), true)
    assert.equal(DELEGATE_ENGINE_BILLING_SESSION_KEY_RE.test('a'.repeat(241)), false)
    assert.equal(DELEGATE_ENGINE_BILLING_SESSION_KEY_RE.test(`${TASKBOARD_SESSION_KEY_155.slice(0, 154)}/`), false)
    assert.equal(DELEGATE_ENGINE_BILLING_SESSION_KEY_RE.test(''), false)
  })
})
