/**
 * Run: npx tsx --test --test-force-exit packages/gateway/src/__tests__/transientRetryCircuitBreaker.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AutomaticRetryState } from '../engine/engineAdapter.js'
import {
  TRANSIENT_SAME_CLASS_BREAKER,
  advanceTransientBreaker,
  resolveTransientBreakerThreshold,
} from '../sessionManager.js'

function freshState(): AutomaticRetryState {
  return { rootClientMessageId: 'm1', attempt: 0, max: 10 }
}

describe('advanceTransientBreaker', () => {
  it('opens after 3 consecutive upstream_failed', () => {
    const state = freshState()
    const first = advanceTransientBreaker(state, 'upstream_failed', TRANSIENT_SAME_CLASS_BREAKER)
    assert.equal(first.open, false)
    assert.equal(first.consecutive, 1)
    const second = advanceTransientBreaker(state, 'upstream_failed', TRANSIENT_SAME_CLASS_BREAKER)
    assert.equal(second.open, false)
    assert.equal(second.consecutive, 2)
    const third = advanceTransientBreaker(state, 'upstream_failed', TRANSIENT_SAME_CLASS_BREAKER)
    assert.equal(third.open, true)
    assert.equal(third.consecutive, 3)
    assert.equal(state.consecutiveSameClass, 3)
    assert.equal(state.lastErrorClass, 'upstream_failed')
  })

  it('resets when the error class changes', () => {
    const state = freshState()
    assert.equal(advanceTransientBreaker(state, 'upstream_failed', TRANSIENT_SAME_CLASS_BREAKER).open, false)
    assert.equal(advanceTransientBreaker(state, 'upstream_failed', TRANSIENT_SAME_CLASS_BREAKER).open, false)
    const switched = advanceTransientBreaker(state, 'rate_limited', TRANSIENT_SAME_CLASS_BREAKER)
    assert.equal(switched.open, false)
    assert.equal(switched.consecutive, 1)
    assert.equal(state.lastErrorClass, 'rate_limited')
  })
})

describe('resolveTransientBreakerThreshold', () => {
  it('uses env override so the 3rd same-class failure stays closed at threshold 5', () => {
    const threshold = resolveTransientBreakerThreshold({ OPENCLAUDE_TRANSIENT_BREAKER: '5' })
    assert.equal(threshold, 5)
    const state = freshState()
    assert.equal(advanceTransientBreaker(state, 'upstream_failed', threshold).open, false)
    assert.equal(advanceTransientBreaker(state, 'upstream_failed', threshold).open, false)
    const third = advanceTransientBreaker(state, 'upstream_failed', threshold)
    assert.equal(third.open, false)
    assert.equal(third.consecutive, 3)
  })

  it('falls back to 3 for missing or illegal env', () => {
    assert.equal(resolveTransientBreakerThreshold({}), TRANSIENT_SAME_CLASS_BREAKER)
    assert.equal(
      resolveTransientBreakerThreshold({ OPENCLAUDE_TRANSIENT_BREAKER: 'nope' }),
      TRANSIENT_SAME_CLASS_BREAKER,
    )
    assert.equal(
      resolveTransientBreakerThreshold({ OPENCLAUDE_TRANSIENT_BREAKER: '0' }),
      TRANSIENT_SAME_CLASS_BREAKER,
    )
    assert.equal(
      resolveTransientBreakerThreshold({ OPENCLAUDE_TRANSIENT_BREAKER: '-1' }),
      TRANSIENT_SAME_CLASS_BREAKER,
    )
    assert.equal(
      resolveTransientBreakerThreshold({ OPENCLAUDE_TRANSIENT_BREAKER: '' }),
      TRANSIENT_SAME_CLASS_BREAKER,
    )
    assert.equal(TRANSIENT_SAME_CLASS_BREAKER, 3)
  })
})
