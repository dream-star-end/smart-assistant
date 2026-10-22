// OCV5-322 live #7da201bd: each automatic "从断点继续" failed with the same Box
// 409 within a second, yet got the full ten-attempt budget — the only "output"
// of every attempt was Claude Code's own "API Error: 409 …" assistant row.
// OCV5-571 live #75f47e31: the same loop again, ten attempts in fifty seconds,
// because each attempt also closed with Claude Code's `result` event, whose
// session-wide `modelUsage` (and `maxOutputTokens`) passed for progress.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyRecoveryRepeatsModelPlaneFailure,
  hasMeaningfulAutomaticRecoveryProgress,
} from '../turnErrorTaxonomy.js'

const apiError = { id: 't2-s0', role: 'assistant', status: 'completed',
  text: 'API Error: 409 {"error":{"code":"BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION","message":"continuation rejected"}}',
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
const runtime = { id: 't2-runtime-7', role: 'runtime-event', status: 'completed', text: '{"is_error":true}' }
/** The closing CLI event of #75f47e31 attempt 2, as the tape stores it. */
const cliResult = (usage: Record<string, unknown> = {}) => ({ id: 't2-runtime-3', role: 'runtime-event',
  status: 'completed', text: '{"type":"result"}', _runtimeSource: 'ccb', _hiddenRuntimeEvent: true,
  _runtimeEvent: { type: 'result', subtype: 'success', is_error: true, num_turns: 1,
    duration_api_ms: 14466, total_cost_usd: 0.20485065,
    modelUsage: { 'box-claude-opus-5-5': { cacheCreationInputTokens: 52253, cacheReadInputTokens: 18703,
      contextWindow: 1000000, costUSD: 0.20485065, inputTokens: 2, maxOutputTokens: 128000,
      outputTokens: 219, webSearchRequests: 0 } },
    usage: { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, ...usage } } })

test('an empty automatic recovery that failed on the model plane is a deterministic repeat', () => {
  assert.equal(emptyRecoveryRepeatsModelPlaneFailure({ errorCode: 'engine_error', currentAttempt: 1,
    records: [runtime, apiError] }), true)
  assert.equal(emptyRecoveryRepeatsModelPlaneFailure({ errorCode: 'upstream_failed', currentAttempt: 4,
    records: [] }), true)
})

test('OCV5-571 the CLI result event with session-wide modelUsage is not progress of this recovery', () => {
  assert.equal(emptyRecoveryRepeatsModelPlaneFailure({ errorCode: 'ENGINE_ERROR', currentAttempt: 2,
    records: [runtime, apiError, cliResult()] }), true)
  // a model limit alone is never usage
  assert.equal(emptyRecoveryRepeatsModelPlaneFailure({ errorCode: 'engine_error', currentAttempt: 2,
    records: [apiError, { role: 'runtime-event', _runtimeEvent: { maxOutputTokens: 128000, contextWindow: 1000000 } }] }), true)
  // the other gates keep their wider rule unchanged
  assert.equal(hasMeaningfulAutomaticRecoveryProgress([cliResult()]), true)
})

test('OCV5-571 tokens this recovery really spent still keep the full budget', () => {
  for (const usage of [{ output_tokens: 7 }, { input_tokens: 1200 }, { cache_read_input_tokens: 18703 },
    { cache_creation_input_tokens: 52253 }]) {
    assert.equal(emptyRecoveryRepeatsModelPlaneFailure({ errorCode: 'engine_error', currentAttempt: 2,
      records: [apiError, cliResult(usage)] }), false, JSON.stringify(usage))
  }
  for (const usage of [{ reasoningOutputTokens: 3 }, { cacheReadTokens: 9 }, { cacheCreationTokens: 9 },
    { totalTokens: 9 }]) {
    assert.equal(emptyRecoveryRepeatsModelPlaneFailure({ errorCode: 'engine_error', currentAttempt: 2,
      records: [apiError, { role: 'assistant', _callUsage: { usage } }] }), false, JSON.stringify(usage))
  }
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
