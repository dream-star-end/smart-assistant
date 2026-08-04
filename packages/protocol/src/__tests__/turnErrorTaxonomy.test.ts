import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AUTOMATIC_TURN_RETRY_MAX,
  TURN_ERROR_TAXONOMY,
  assessTurnRecoveryTape,
  maxAutomaticTurnRetryAttempt,
  supportsAutomaticTurnRecovery,
  turnRecoveryAttemptIdentity,
  turnRecoveryIdentity,
} from '../turnErrorTaxonomy.js'

describe('automatic turn recovery policy', () => {
  it('classifies every frontend-visible retryable code into automatic recovery or an explicit unsafe transport/admission exclusion', () => {
    const explicitUnsafe = new Set([
      'session_persist_unavailable', // no durable user-row/tape authority
      'conn_kicked', // connection lifecycle owns reconnect, not turn replay
      'bad_sequence', // requires exact sync before any new dispatch
      'codex_turn_busy', // another turn owns the session; FIFO lifecycle owns it
      'codex_billing', // billing admission result is not a model continuation proof
    ])
    const actual = Object.entries(TURN_ERROR_TAXONOMY)
      .filter(([, semantics]) =>
        semantics.retryable && !("automaticRecovery" in semantics && semantics.automaticRecovery === true))
      .map(([code]) => code)
    assert.deepEqual(actual.sort(), [...explicitUnsafe].sort())
  })

  it('includes transient execution failures but excludes user/action and admission failures', () => {
    for (const code of [
      'rate_limited',
      'model_capacity',
      'upstream_failed',
      'upstream_timeout',
      'network_error',
      'engine_error',
      'runner_crashed',
      'idle_timeout',
      'liveness_timeout',
      'err_container_timeout',
    ]) {
      assert.equal(supportsAutomaticTurnRecovery(code), true, code)
    }
    for (const code of [
      'auth_error',
      'insufficient_credits',
      'context_too_long',
      'bad_request',
      'stopped',
      'user_cancelled',
      'session_persist_unavailable',
      'model_not_available',
      'model_config_changed_retry_turn',
      'codex_billing',
      'unknown',
    ]) {
      assert.equal(supportsAutomaticTurnRecovery(code), false, code)
    }
  })

  it('mints one protocol-valid deterministic identity per source turn', () => {
    const first = turnRecoveryIdentity('session-1', 'client-1')
    const again = turnRecoveryIdentity('session-1', 'client-1')
    const other = turnRecoveryIdentity('session-1', 'client-2')
    assert.deepEqual(first, again)
    assert.notDeepEqual(first, other)
    assert.match(first.clientMessageId, /^m-recover-[a-z0-9]+$/)
    assert.match(first.idempotencyKey, /^recover-turn-[a-z0-9]+$/)
    assert.deepEqual(first, turnRecoveryAttemptIdentity('session-1', 'client-1', 1))
    assert.notDeepEqual(first, turnRecoveryAttemptIdentity('session-1', 'client-1', 2))
  })

  it('derives the monotonic retry counter from raw controls or compacted terminal stamps', () => {
    assert.equal(maxAutomaticTurnRetryAttempt([
      {
        role: 'runtime-event',
        _runtimeEvent: {
          type: 'retry_status',
          rootClientMessageId: 'client-1',
          attempt: 3,
          max: AUTOMATIC_TURN_RETRY_MAX,
        },
      },
      {
        role: 'assistant',
        _automaticRetryRootClientMessageId: 'client-1',
        _automaticRetryAttempt: 7,
        _automaticRetryMax: AUTOMATIC_TURN_RETRY_MAX,
      },
      {
        type: 'retry_status',
        rootClientMessageId: 'other',
        attempt: 10,
        max: AUTOMATIC_TURN_RETRY_MAX,
      },
    ], 'client-1'), 7)
  })

  it('derives checkpoint safety from exact process and external-action states', () => {
    assert.deepEqual(assessTurnRecoveryTape([]), {
      mode: 'replay',
      checkpointSafe: true,
    })
    assert.deepEqual(assessTurnRecoveryTape([
      { role: 'thinking', text: 'kept' },
      { role: 'tool', _completed: true, outputJson: { status: 'done' } },
    ]), {
      mode: 'checkpoint',
      checkpointSafe: true,
    })
    for (const unsafe of [
      { role: 'permission', _resolved: false },
      { role: 'tool', _completed: false },
      { role: 'tool', _completed: true, outputJson: { outcome: 'unknown' } },
      {
        role: 'agent-group',
        _completed: true,
        childBlocks: [{ kind: 'tool_use', _completed: false }],
      },
      { role: 'runtime-event', outcome: 'incomplete' },
    ]) {
      assert.deepEqual(assessTurnRecoveryTape([unsafe]), {
        mode: 'checkpoint',
        checkpointSafe: false,
      })
    }
  })
})
