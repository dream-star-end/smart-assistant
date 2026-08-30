/**
 * OCV5-22 phase 0 protocol: failure_class version, legal transitions, cron key.
 *
 * Run: npx tsx --test packages/protocol/src/__tests__/delegation.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DELEGATE_FAILURE_CLASS_VERSION,
  DELEGATE_FAILURE_CLASSES,
  DELEGATE_JOB_STATES,
  assertDelegateTransition,
  cronDelegateIdempotencyKey,
  classifyNotifyLane,
  delegateCallbackMessageId,
  delegateNotifyId,
  failureClassFromLocalExecutionCode,
  isDelegateParentEngine,
  isDelegateTerminalState,
  isLegalDelegateTransition,
} from '../delegation.js'

describe('OCV5-22 delegation protocol', () => {
  it('freezes failure_class version 1 and the owned name set', () => {
    assert.equal(DELEGATE_FAILURE_CLASS_VERSION, 1)
    assert.ok(DELEGATE_FAILURE_CLASSES.includes('capacity_timeout'))
    assert.ok(DELEGATE_FAILURE_CLASSES.includes('invalid_model'))
    assert.ok(DELEGATE_FAILURE_CLASSES.includes('unknown_job'))
    assert.ok(DELEGATE_JOB_STATES.includes('queued'))
    assert.ok(DELEGATE_JOB_STATES.includes('killed_by_cutover'))
    assert.ok(DELEGATE_JOB_STATES.includes('paused_for_cutover'))
  })

  it('accepts v2 legal transitions including queued→paused and running→killed', () => {
    assert.equal(isLegalDelegateTransition('queued', 'running'), true)
    assert.equal(isLegalDelegateTransition('queued', 'failed'), true)
    assert.equal(isLegalDelegateTransition('queued', 'paused_for_cutover'), true)
    assert.equal(isLegalDelegateTransition('queued', 'killed_by_cutover'), true)
    assert.equal(isLegalDelegateTransition('running', 'killed_by_cutover'), true)
    assert.equal(isLegalDelegateTransition('running', 'paused_for_cutover'), true)
    assert.equal(isLegalDelegateTransition('paused_for_cutover', 'running'), true)
    assert.equal(isLegalDelegateTransition('paused_for_cutover', 'killed_by_cutover'), true)
    assert.equal(isLegalDelegateTransition('running', 'completed'), true)
    assert.equal(isLegalDelegateTransition('running', 'cancelled'), true)
  })

  it('rejects illegal and terminal→anything transitions', () => {
    assert.equal(isLegalDelegateTransition('queued', 'completed'), false)
    assert.equal(isLegalDelegateTransition('failed', 'running'), false)
    assert.equal(isLegalDelegateTransition('completed', 'failed'), false)
    assert.equal(isLegalDelegateTransition('killed_by_cutover', 'running'), false)
    const terminal = assertDelegateTransition('completed', 'running')
    assert.equal(terminal.ok, false)
    if (!terminal.ok) assert.equal(terminal.reason, 'already_terminal')
    const illegal = assertDelegateTransition('queued', 'completed')
    assert.equal(illegal.ok, false)
    if (!illegal.ok) assert.equal(illegal.reason, 'illegal_transition')
    assert.equal(isDelegateTerminalState('failed'), true)
    assert.equal(isDelegateTerminalState('running'), false)
  })

  it('maps DELEGATE_MODEL_UNKNOWN onto invalid_model and builds cron/callback keys', () => {
    assert.equal(failureClassFromLocalExecutionCode('DELEGATE_MODEL_UNKNOWN'), 'invalid_model')
    assert.equal(
      cronDelegateIdempotencyKey('remind-mtd9f0ng-pgki', 1767225600),
      'cron:remind-mtd9f0ng-pgki:1767225600',
    )
    assert.equal(delegateCallbackMessageId('dlgjob-abc', 1), 'dlgcb.dlgjob-abc.1')
    assert.equal(delegateNotifyId('dlgjob-abc', 1), 'dlgnfy.dlgjob-abc.1')
    assert.equal(classifyNotifyLane('ccb'), 'inline-push')
    assert.equal(classifyNotifyLane('codex'), 'inline-push')
    assert.equal(classifyNotifyLane('cursor'), 'resume-inject')
    assert.equal(classifyNotifyLane('grok'), 'resume-inject')
    assert.equal(classifyNotifyLane('zcode'), 'resume-inject')
    assert.equal(isDelegateParentEngine('cursor'), true)
    assert.equal(isDelegateParentEngine('unknown'), false)
  })
})
