import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TRACE_ID_REGEX } from '../traceId.js'
import {
  g8CompactSummaryCheckpointInput,
  g8TurnEndCheckpointInput,
  judgeG8Replay,
  resetG8ReplayCheckpointForTest,
  runG8ReplayCheckpoint,
  sanitizeG8TraceId,
  setG8ReplayChecker,
  setG8ReplayCheckpoint,
  type G8ReplayObservation,
} from '../g8ReplayJudge.js'

const trace = '11111111111111111111111111111111'

function obs(over: Partial<G8ReplayObservation> = {}): G8ReplayObservation {
  return { point: 'turn_end', traceId: trace, ...over }
}

test('trace ids use the shared charset and drop anything else', () => {
  assert.equal(TRACE_ID_REGEX.test(trace), true)
  assert.equal(sanitizeG8TraceId(trace), trace)
  assert.equal(sanitizeG8TraceId('not a trace'), null)
  assert.equal(sanitizeG8TraceId(''), null)
  const judged = judgeG8Replay(obs({ traceId: 'not a trace' }))
  assert.equal(judged.traceId, null)
  assert.equal(JSON.stringify(judged).includes('not a trace'), false)
})

test('box rejection is a warning, asks a person, and does not stop', () => {
  const verdict = judgeG8Replay(obs({
    boxDecision: 'rejected',
    failureCode: 'BOX_TOOL_RESULT_MISMATCH',
    dispatchStatus: 'terminal',
    dispatchOutcome: 'not_accepted',
    engineReported: 'ended',
    engineProcessAlive: false,
    settledChargeCount: 0,
  }))
  assert.equal(verdict.verdict, 'box_rejected')
  assert.equal(verdict.severity, 'warning')
  assert.equal(verdict.retryable, false)
  assert.equal(verdict.askHuman, true)
  assert.equal(verdict.alert, true)
  assert.equal(verdict.stopSession, false)
  assert.equal(verdict.reason, 'box_rejected')
})

test('a failure code in the Box set is a rejection without an explicit decision', () => {
  const verdict = judgeG8Replay(obs({
    failureCode: 'BOX_REPLAY_EVIDENCE_INVALID',
    dispatchStatus: 'terminal',
    dispatchOutcome: 'not_accepted',
  }))
  assert.equal(verdict.verdict, 'box_rejected')
})

test('user cancel is not a Box rejection', () => {
  const verdict = judgeG8Replay(obs({
    failureCode: 'USER_CANCELLED',
    dispatchStatus: 'terminal',
    dispatchOutcome: 'not_accepted',
  }))
  assert.equal(verdict.verdict, 'ok')
  assert.equal(verdict.alert, false)
  assert.equal(verdict.askHuman, false)
})

test('an accepted Box decision is not a rejection even if a reject code is set', () => {
  const verdict = judgeG8Replay(obs({
    boxDecision: 'accepted',
    failureCode: 'BOX_TOOL_RESULT_MISMATCH',
    dispatchStatus: 'terminal',
    dispatchOutcome: 'completed',
    engineReported: 'ended',
    settledChargeCount: 1,
  }))
  assert.equal(verdict.verdict, 'ok')
})

test('a starting engine with no process is a mismatch and does not ask the user', () => {
  const verdict = judgeG8Replay(obs({
    engineReported: 'starting',
    engineProcessAlive: false,
    dispatchStatus: 'accepted',
    settledChargeCount: 0,
  }))
  assert.equal(verdict.verdict, 'engine_state_mismatch')
  assert.equal(verdict.reason, 'engine_starting_without_process')
  assert.equal(verdict.severity, 'warning')
  assert.equal(verdict.askHuman, false)
  assert.equal(verdict.alert, true)
  assert.equal(verdict.stopSession, false)
})

test('a busy engine after the dispatch is terminal is a mismatch', () => {
  const verdict = judgeG8Replay(obs({
    point: 'compact_summary',
    engineReported: 'running',
    dispatchStatus: 'terminal',
    dispatchOutcome: 'completed',
    summaryWritten: true,
  }))
  assert.equal(verdict.verdict, 'engine_state_mismatch')
  assert.equal(verdict.reason, 'engine_busy_after_terminal')
  assert.equal(verdict.point, 'compact_summary')
})

test('an ended engine while the dispatch is still accepted is a mismatch', () => {
  const verdict = judgeG8Replay(obs({
    engineReported: 'ended',
    dispatchStatus: 'accepted',
  }))
  assert.equal(verdict.reason, 'engine_idle_while_open')
})

test('unknown engine liveness is not a mismatch', () => {
  const verdict = judgeG8Replay(obs({
    engineReported: 'starting',
    dispatchStatus: 'accepted',
  }))
  assert.equal(verdict.verdict, 'ok')
})

test('two settled charges are critical and do not stop the session', () => {
  const verdict = judgeG8Replay(obs({
    settledChargeCount: 2,
    idempotentReplay: false,
    stackedSettledTurns: 2,
    dispatchStatus: 'terminal',
    dispatchOutcome: 'completed',
    engineReported: 'ended',
    engineProcessAlive: true,
    boxDecision: 'accepted',
  }))
  assert.equal(verdict.verdict, 'duplicate_charge')
  assert.equal(verdict.severity, 'critical')
  assert.equal(verdict.askHuman, true)
  assert.equal(verdict.retryable, false)
  assert.equal(verdict.alert, true)
  assert.equal(verdict.stopSession, false)
})

test('an idempotent second row is not a duplicate charge', () => {
  const verdict = judgeG8Replay(obs({
    settledChargeCount: 2,
    idempotentReplay: true,
    stackedSettledTurns: 1,
    dispatchStatus: 'terminal',
    dispatchOutcome: 'completed',
    engineReported: 'ended',
  }))
  assert.equal(verdict.verdict, 'ok')
})

test('two stacked settled turns stay a duplicate even when one row was idempotent', () => {
  const verdict = judgeG8Replay(obs({
    settledChargeCount: 2,
    idempotentReplay: true,
    stackedSettledTurns: 2,
    dispatchStatus: 'terminal',
    dispatchOutcome: 'completed',
    engineReported: 'ended',
  }))
  assert.equal(verdict.verdict, 'duplicate_charge')
})

test('a duplicate charge wins over a Box rejection', () => {
  const verdict = judgeG8Replay(obs({
    boxDecision: 'rejected',
    failureCode: 'BOX_PREPARED_REJECT',
    settledChargeCount: 2,
  }))
  assert.equal(verdict.verdict, 'duplicate_charge')
})

test('writing a compaction summary with no other signal is ok', () => {
  const verdict = judgeG8Replay(g8CompactSummaryCheckpointInput(trace))
  assert.equal(verdict.verdict, 'ok')
  assert.equal(verdict.point, 'compact_summary')
  assert.equal(verdict.alert, false)
})

test('the turn-end input carries the terminal dispatch and nothing else', () => {
  const input = g8TurnEndCheckpointInput({
    traceId: trace,
    outcome: 'not_accepted',
    failureCode: 'BOX_TOOL_RESULT_MISMATCH',
  })
  assert.equal(input.point, 'turn_end')
  assert.equal(input.dispatchStatus, 'terminal')
  assert.equal(judgeG8Replay(input).verdict, 'box_rejected')
})

test('the checkpoint is off until a listener is installed', () => {
  resetG8ReplayCheckpointForTest()
  assert.equal(runG8ReplayCheckpoint(obs({ boxDecision: 'rejected' })), null)
  resetG8ReplayCheckpointForTest()
})

test('an installed listener records the verdict and a thrown checker does not escape', () => {
  const seen: string[] = []
  setG8ReplayCheckpoint((verdict) => {
    seen.push(verdict.verdict)
  })
  const hit = runG8ReplayCheckpoint(obs({ boxDecision: 'rejected' }))
  assert.equal(hit?.verdict, 'box_rejected')
  assert.equal(hit?.stopSession, false)
  assert.deepEqual(seen, ['box_rejected'])

  setG8ReplayChecker(() => {
    throw new Error('checker broke')
  })
  const failed = runG8ReplayCheckpoint(obs())
  assert.equal(failed?.verdict, 'check_failed')
  assert.equal(failed?.alert, false)
  assert.equal(failed?.traceId, trace)
  assert.deepEqual(seen, ['box_rejected', 'check_failed'])

  setG8ReplayChecker(null)
  setG8ReplayCheckpoint(() => {
    throw new Error('sink broke')
  })
  const still = runG8ReplayCheckpoint(obs({ boxDecision: 'rejected' }))
  assert.equal(still?.verdict, 'box_rejected')
  resetG8ReplayCheckpointForTest()
  assert.equal(runG8ReplayCheckpoint(obs({ boxDecision: 'rejected' })), null)
})
