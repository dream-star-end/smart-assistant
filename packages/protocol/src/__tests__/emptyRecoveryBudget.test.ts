// OCV5-322 live #7da201bd: each automatic "从断点继续" failed with the same Box
// 409 within a second, yet got the full ten-attempt budget — the only "output"
// of every attempt was Claude Code's own "API Error: 409 …" assistant row.
import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyRecoveryRepeatsModelPlaneFailure } from '../turnErrorTaxonomy.js'

const apiError = { id: 't2-s0', role: 'assistant', status: 'completed',
  text: 'API Error: 409 {"error":{"code":"BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION","message":"continuation rejected"}}',
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
const runtime = { id: 't2-runtime-7', role: 'runtime-event', status: 'completed', text: '{"is_error":true}' }

test('an empty automatic recovery that failed on the model plane is a deterministic repeat', () => {
  assert.equal(emptyRecoveryRepeatsModelPlaneFailure({ errorCode: 'engine_error', currentAttempt: 1,
    records: [runtime, apiError] }), true)
  assert.equal(emptyRecoveryRepeatsModelPlaneFailure({ errorCode: 'upstream_failed', currentAttempt: 4,
    records: [] }), true)
})

test('a first failure, real progress or a non-model-plane code keeps the full budget', () => {
  assert.equal(emptyRecoveryRepeatsModelPlaneFailure({ errorCode: 'engine_error', currentAttempt: 0,
    records: [apiError] }), false)
  for (const progress of [{ role: 'assistant', text: 'Looking at the tests now.' },
    { role: 'tool', id: 'x', _completed: true },
    { ...apiError, usage: { inputTokens: 0, outputTokens: 12, totalTokens: 12 } }]) {
    assert.equal(emptyRecoveryRepeatsModelPlaneFailure({ errorCode: 'engine_error', currentAttempt: 2,
      records: [apiError, progress] }), false, JSON.stringify(progress))
  }
  assert.equal(emptyRecoveryRepeatsModelPlaneFailure({ errorCode: 'service_restart', currentAttempt: 2,
    records: [] }), false)
})
