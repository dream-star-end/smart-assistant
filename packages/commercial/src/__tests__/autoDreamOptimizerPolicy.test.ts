import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeAutoDreamPreferencePatch } from '../user/autoDream.js'

describe('Auto-Dream V2 rollback preference boundary', () => {
  it('turns the legacy auto-mutating flag off when V2 consent is enabled', () => {
    const patch = normalizeAutoDreamPreferencePatch({
      auto_dream_enabled: true,
      auto_optimizer_enabled: true,
    })
    assert.equal(patch.auto_optimizer_enabled, true)
    assert.equal(
      patch.auto_dream_enabled,
      false,
      'an old runtime must see V1 disabled after rollback',
    )
  })

  it('keeps V1 and V2 mutually exclusive in both directions', () => {
    assert.deepEqual(normalizeAutoDreamPreferencePatch({ auto_dream_enabled: true }), {
      auto_dream_enabled: true,
      auto_optimizer_enabled: false,
    })
    assert.deepEqual(normalizeAutoDreamPreferencePatch({ auto_optimizer_enabled: false }), {
      auto_optimizer_enabled: false,
      auto_dream_enabled: false,
    })
  })
})
