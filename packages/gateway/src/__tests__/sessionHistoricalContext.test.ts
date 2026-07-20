import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildHistoricalContextPrompt,
  historicalContextInjectionKey,
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

test('buildHistoricalContextPrompt keeps every selected semantic role and ignores private/system rows', () => {
  const prompt = buildHistoricalContextPrompt(
    [
      { role: 'thinking', text: 'hidden' },
      { role: 'assistant', text: 'system notice', system: true },
      { role: 'user', text: 'visible' },
      { role: 'tool', toolName: 'Bash', inputJson: { command: 'pwd' }, output: 'TOOL_MARKER_/srv' },
      { role: 'plan', text: 'PLAN_MARKER', steps: [{ step: 'ship', status: 'in_progress' }] },
      { role: 'goal', objective: 'GOAL_MARKER', status: 'active' },
      { role: 'agent-group', text: 'DELEGATE_MARKER', _delegateAgentId: 'reviewer' },
      { role: 'error', text: 'ERROR_MARKER', _errorDetail: 'exact detail' },
    ],
    'next',
  )
  assert.ok(prompt)
  assert.doesNotMatch(prompt!, /hidden|system notice/)
  assert.match(prompt!, /User: visible/)
  assert.match(prompt!, /Tool record:.*TOOL_MARKER_\/srv/s)
  assert.match(prompt!, /Plan update:.*PLAN_MARKER/s)
  assert.match(prompt!, /Goal update:.*GOAL_MARKER/s)
  assert.match(prompt!, /Delegate record:.*DELEGATE_MARKER/s)
  assert.match(prompt!, /Agent error:.*ERROR_MARKER/s)
})

test('buildHistoricalContextPrompt has no second 40-row/14k cap and emits each selected record once', () => {
  const messages = Array.from({ length: 48 }, (_, index) => ({
    id: `history-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `ROW_MARKER_${index}_${'x'.repeat(400)}`,
  }))
  messages.splice(24, 0, {
    id: 'tool-history',
    role: 'tool',
    text: `TOOL_ONCE_MARKER_${'y'.repeat(400)}`,
  })
  const prompt = buildHistoricalContextPrompt(messages, 'CURRENT_UNIQUE_MESSAGE')
  assert.ok(prompt)
  assert.ok(prompt!.length > 14_000)
  for (let index = 0; index < 48; index++) {
    const marker = `ROW_MARKER_${index}_`
    assert.equal(prompt!.split(marker).length - 1, 1, `${marker} must appear exactly once`)
  }
  assert.equal(prompt!.split('TOOL_ONCE_MARKER_').length - 1, 1)
  assert.equal(prompt!.split('CURRENT_UNIQUE_MESSAGE').length - 1, 1)
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


test('historicalContextInjectionKey forces injection when latest master assistant is from another agent', () => {
  assert.equal(
    historicalContextInjectionKey({
      messages: [{ role: 'assistant', id: 'srv-s-main-t1', text: 'deepseek answer' }],
      peerId: 's',
      agentId: 'codex',
      hasProviderResumeId: true,
    }),
    'master:srv-s-main-t1',
  )
  assert.equal(
    historicalContextInjectionKey({
      messages: [{ role: 'assistant', id: 'srv-s-codex-t2', text: 'codex answer' }],
      peerId: 's',
      agentId: 'codex',
      hasProviderResumeId: true,
    }),
    null,
  )
})

test('shouldAttemptHistoricalContextInjection dedupes by master history key even with provider resume id', () => {
  assert.equal(
    shouldAttemptHistoricalContextInjection({
      channel: 'webchat',
      userTextOrBlocks: '切回 GPT 继续',
      hasProviderResumeId: true,
      injectionKey: 'master:srv-s-main-t1',
      lastInjectedKey: null,
    }),
    true,
  )
  assert.equal(
    shouldAttemptHistoricalContextInjection({
      channel: 'webchat',
      userTextOrBlocks: '普通追问',
      hasProviderResumeId: true,
      injectionKey: 'master:srv-s-main-t1',
      lastInjectedKey: 'master:srv-s-main-t1',
    }),
    false,
  )
})
