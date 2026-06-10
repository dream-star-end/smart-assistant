import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getDelegateTimeoutReason,
  resolveDelegateTimeoutConfig,
} from '../delegateTimeout.js'

describe('delegate timeout config and activity reset', () => {
  it('defaults to a 300s idle timeout and clamps env overrides', () => {
    assert.deepEqual(resolveDelegateTimeoutConfig({}), {
      idleTimeoutMs: 300_000,
      hardTimeoutMs: 2_700_000,
      checkIntervalMs: 5_000,
    })
    assert.deepEqual(
      resolveDelegateTimeoutConfig({
        OPENCLAUDE_DELEGATE_IDLE_TIMEOUT_MS: '10',
        OPENCLAUDE_DELEGATE_HARD_TIMEOUT_MS: '100',
        OPENCLAUDE_DELEGATE_CHECK_INTERVAL_MS: '50',
      }),
      {
        idleTimeoutMs: 60_000,
        hardTimeoutMs: 300_000,
        checkIntervalMs: 1_000,
      },
    )
  })

  it('resets the idle timeout when child activity advances', () => {
    const cfg = { idleTimeoutMs: 300_000, hardTimeoutMs: 2_700_000, checkIntervalMs: 5_000 }
    const startedAt = 1_000

    assert.equal(getDelegateTimeoutReason(startedAt + 350_000, startedAt, startedAt, cfg)?.kind, 'idle')

    const childOutputAt = startedAt + 250_000
    assert.equal(
      getDelegateTimeoutReason(startedAt + 350_000, startedAt, childOutputAt, cfg),
      null,
    )
  })

  it('keeps a hard cap even when activity keeps arriving', () => {
    const cfg = { idleTimeoutMs: 300_000, hardTimeoutMs: 2_700_000, checkIntervalMs: 5_000 }
    const startedAt = 1_000
    const lastActivityAt = startedAt + 2_699_000
    const reason = getDelegateTimeoutReason(startedAt + 2_701_000, startedAt, lastActivityAt, cfg)
    assert.equal(reason?.kind, 'hard')
  })
})
