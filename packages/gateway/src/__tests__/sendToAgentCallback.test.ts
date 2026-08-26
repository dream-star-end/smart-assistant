import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildSendToAgentCallbackText,
  isSendToAgentCallbackComplete,
  sendToAgentCallbackClientMessageId,
  sendToAgentCallbackIdempotencyKey,
} from '../sendToAgentCallback.js'
import { parseOriginWebchatSessionKey } from '../cronOriginSession.js'

describe('sendToAgentCallback text + ids', () => {
  it('builds a self-contained callback user turn', () => {
    const text = buildSendToAgentCallbackText({
      agentId: 'research-assistant',
      goal: '查萧山机场事件',
      output: '结论正文',
    })
    assert.match(text, /research-assistant/)
    assert.match(text, /查萧山机场事件/)
    assert.match(text, /结论正文/)
    assert.match(text, /完成回调/)
  })

  it('labels failures separately', () => {
    const text = buildSendToAgentCallbackText({
      agentId: 'research-assistant',
      goal: '查',
      error: 'upstream 402',
    })
    assert.match(text, /失败/)
    assert.match(text, /upstream 402/)
  })

  it('stamps stable ids from the job', () => {
    assert.equal(sendToAgentCallbackClientMessageId('dlgjob-abc'), 'sta-cb-dlgjob-abc')
    assert.equal(sendToAgentCallbackIdempotencyKey('dlgjob-abc'), 'send-to-agent-callback:dlgjob-abc')
  })

  it('only origin-inject is the complete callback mode', () => {
    assert.equal(isSendToAgentCallbackComplete('origin-inject'), true)
    assert.equal(isSendToAgentCallbackComplete(true), false)
    assert.equal(isSendToAgentCallbackComplete('notify'), false)
  })

  it('accepts a live webchat parent key', () => {
    const origin = parseOriginWebchatSessionKey('agent:main:webchat:dm:sess-1')
    assert.ok(origin)
    assert.equal(origin?.peerId, 'sess-1')
  })
})
