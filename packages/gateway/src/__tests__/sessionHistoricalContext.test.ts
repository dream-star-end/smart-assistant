import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildHistoricalContextPrompt,
  shouldAttemptHistoricalContextInjection,
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

test('shouldAttemptHistoricalContextInjection does not depend on provider-local turn count', () => {
  assert.equal(
    shouldAttemptHistoricalContextInjection({
      channel: 'webchat',
      userTextOrBlocks: '切到 codex 后继续',
      hasProviderResumeId: false,
    }),
    true,
  )
  assert.equal(
    shouldAttemptHistoricalContextInjection({
      channel: 'webchat',
      userTextOrBlocks: '原生 resume 可用时不注入',
      hasProviderResumeId: true,
    }),
    false,
  )
})
