import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatSendToAgentRunning, formatSendToAgentStart } from '../sendToAgent.js'

describe('send_to_agent background start', () => {
  it('returns status=running JSON and does not mention delegate-wait', () => {
    const text = formatSendToAgentRunning({
      agentId: 'research-assistant',
      jobId: 'dlgjob-1',
      sessionKey: 'agent:research-assistant:delegate:x',
    })
    const parsed = JSON.parse(text) as { status: string; jobId: string; message: string }
    assert.equal(parsed.status, 'running')
    assert.equal(parsed.jobId, 'dlgjob-1')
    assert.match(parsed.message, /结束本回合/)
    assert.doesNotMatch(parsed.message, /delegate-wait/)
  })

  it('parses the async delegate start body', () => {
    const started = formatSendToAgentStart(
      200,
      JSON.stringify({ status: 'running', jobId: 'dlgjob-9', sessionKey: 'sk' }),
      'research-assistant',
    )
    assert.equal(typeof started, 'string')
    if (typeof started !== 'string') return
    assert.match(started, /"status":"running"/)
    assert.match(started, /dlgjob-9/)
  })

  it('surfaces start errors', () => {
    const started = formatSendToAgentStart(401, 'async delegate requires delegate context', 'x')
    assert.equal(typeof started, 'object')
    if (typeof started === 'string') return
    assert.match(started.error, /发送失败|401|context/)
  })
})
