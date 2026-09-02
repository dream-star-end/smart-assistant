/**
 * OCV5-22 phase 0 protocol: failure_class version, legal transitions, cron key.
 *
 * Run: npx tsx --test packages/protocol/src/__tests__/delegation.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DELEGATE_CURSOR_MCP_WAIT_MS,
  DELEGATE_CUTOVER_FREEZE_MS,
  DELEGATE_FAILURE_CLASSES,
  DELEGATE_FAILURE_CLASS_VERSION,
  DELEGATE_JOB_STATES,
  type InflightDelegateSurface,
  assertDelegateTransition,
  classifyNotifyLane,
  cronDelegateIdempotencyKey,
  delegateCallbackMessageId,
  delegateNotifyId,
  failureClassFromLocalExecutionCode,
  isDelegateParentEngine,
  isDelegateTerminalState,
  isLegalDelegateTransition,
} from '../delegation.js'
import { isClientMessageId } from '../frames.js'

describe('OCV5-22 delegation protocol', () => {
  it('freezes failure_class version 1 and the owned name set', () => {
    assert.equal(DELEGATE_FAILURE_CLASS_VERSION, 1)
    assert.ok(DELEGATE_FAILURE_CLASSES.includes('capacity_timeout'))
    assert.ok(DELEGATE_FAILURE_CLASSES.includes('invalid_model'))
    assert.ok(DELEGATE_FAILURE_CLASSES.includes('unknown_job'))
    assert.ok(DELEGATE_JOB_STATES.includes('queued'))
    assert.ok(DELEGATE_JOB_STATES.includes('killed_by_cutover'))
    assert.ok(DELEGATE_JOB_STATES.includes('paused_for_cutover'))
    assert.equal(DELEGATE_CUTOVER_FREEZE_MS, 30_000)
    assert.equal(DELEGATE_CURSOR_MCP_WAIT_MS, 55_000)
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
    assert.equal(delegateCallbackMessageId('dlgjob-abc', 1), 'dlgcb-dlgjob-abc-1')
    // Master /internal/v3/cron-origin-inject gates on isClientMessageId; a dotted
    // id was rejected as invalid_payload and the callback retried forever.
    assert.ok(isClientMessageId(delegateCallbackMessageId('dlgjob-abc', 1)))
    assert.ok(isClientMessageId(delegateCallbackMessageId('dlgjob-rs-53149d9143e6', 12)))
    assert.equal(delegateNotifyId('dlgjob-abc', 1), 'dlgnfy.dlgjob-abc.1')
    assert.equal(classifyNotifyLane('ccb'), 'inline-push')
    assert.equal(classifyNotifyLane('codex'), 'inline-push')
    assert.equal(classifyNotifyLane('cursor'), 'resume-inject')
    assert.equal(classifyNotifyLane('grok'), 'resume-inject')
    assert.equal(classifyNotifyLane('zcode'), 'resume-inject')
    assert.equal(isDelegateParentEngine('cursor'), true)
    assert.equal(isDelegateParentEngine('unknown'), false)
  })

  it('freezes InflightDelegateSurface as the R2 session-slot read model', () => {
    const row: InflightDelegateSurface = {
      jobId: 'dlgjob-abc',
      runId: 'dlg-abc',
      agentId: 'coding-assistant',
      goal: 'do it',
      state: 'running',
      liveHint: 'Read src.ts',
      updatedAt: 1,
      parentSessionKey: 'agent:main:webchat:dm:web-1',
    }
    assert.equal(row.state, 'running')
    assert.equal(typeof row.foldedGroup, 'undefined')
    const terminal: InflightDelegateSurface = {
      ...row,
      state: 'completed',
      truncated: true,
      nested: false,
      ownerRunId: 'dlg-parent',
    }
    assert.equal(terminal.truncated, true)
    assert.equal(terminal.ownerRunId, 'dlg-parent')
  })
})
