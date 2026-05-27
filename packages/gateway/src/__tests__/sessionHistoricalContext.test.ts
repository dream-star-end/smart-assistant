import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LIVENESS_IDLE_TIMEOUT_COMPACTING_MS,
  LIVENESS_IDLE_TIMEOUT_DEFAULT_MS,
  LIVENESS_IDLE_TIMEOUT_TOOL_MS,
  buildHistoricalContextPrompt,
  getLivenessIdleTimeoutMs,
} from '../sessionManager.js'

test('buildHistoricalContextPrompt includes prior user/assistant turns and wraps current message', () => {
  const prompt = buildHistoricalContextPrompt(
    [
      { role: 'user', text: '之前的问题' },
      { role: 'assistant', text: '之前的回答' },
    ],
    '继续',
  )
  assert.ok(prompt)
  assert.match(prompt!, /<openclaude_previous_context>/)
  assert.match(prompt!, /User: 之前的问题/)
  assert.match(prompt!, /Assistant: 之前的回答/)
  assert.match(prompt!, /<current_user_message>\n继续\n<\/current_user_message>/)
})

test('buildHistoricalContextPrompt drops optimistic current user message from history', () => {
  const prompt = buildHistoricalContextPrompt(
    [
      { role: 'user', text: 'old' },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'new turn', status: 'sending' },
    ],
    'new turn',
  )
  assert.ok(prompt)
  assert.equal((prompt!.match(/User: new turn/g) ?? []).length, 0)
  assert.match(prompt!, /<current_user_message>\nnew turn\n<\/current_user_message>/)
})

test('buildHistoricalContextPrompt ignores non-chat/system messages', () => {
  const prompt = buildHistoricalContextPrompt(
    [
      { role: 'thinking', text: 'hidden' },
      { role: 'assistant', text: 'system notice', system: true },
      { role: 'user', text: 'visible' },
    ],
    'next',
  )
  assert.ok(prompt)
  assert.doesNotMatch(prompt!, /hidden|system notice/)
  assert.match(prompt!, /User: visible/)
})

test('getLivenessIdleTimeoutMs gives context compaction its own budget', () => {
  assert.equal(getLivenessIdleTimeoutMs(null), LIVENESS_IDLE_TIMEOUT_DEFAULT_MS)
  assert.equal(getLivenessIdleTimeoutMs({ pendingToolCalls: 1 }), LIVENESS_IDLE_TIMEOUT_TOOL_MS)
  assert.equal(
    getLivenessIdleTimeoutMs({ pendingToolCalls: 1, isCompacting: true }),
    LIVENESS_IDLE_TIMEOUT_COMPACTING_MS,
  )
})
