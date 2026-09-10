import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  consultAdvisorResultFromGateway,
  consultAdvisorUntilAdvice,
} from '../consultAdvisorClient.js'

describe('consultAdvisor consumer', () => {
  it('does not treat running JSON as recovered advice', () => {
    const running = consultAdvisorResultFromGateway({
      statusCode: 200,
      body: JSON.stringify({ status: 'running', reused: true, consultId: 'advc-1' }),
    })
    assert.equal(running.kind, 'pending')
    const pending = consultAdvisorResultFromGateway({
      statusCode: 202,
      body: JSON.stringify({ status: 'pending', reused: true, recoverable: true, consultId: 'advc-1' }),
    })
    assert.equal(pending.kind, 'pending')
    const ok = consultAdvisorResultFromGateway({
      statusCode: 200,
      body: JSON.stringify({ status: 'settled', advice: 'check the assertion first' }),
    })
    assert.equal(ok.kind, 'advice')
    assert.equal(ok.kind === 'advice' && ok.text, 'check the assertion first')
  })

  it('retries the same invocation until original advice', async () => {
    const posts: number[] = []
    const result = await consultAdvisorUntilAdvice({
      overallMs: 1_000,
      retryGapMs: 5,
      post: async () => {
        posts.push(Date.now())
        if (posts.length < 3) {
          return {
            statusCode: 202,
            body: JSON.stringify({ status: 'pending', reused: true, recoverable: true, consultId: 'advc-1' }),
          }
        }
        return {
          statusCode: 200,
          body: JSON.stringify({ status: 'settled', advice: 'check the assertion first', reused: true }),
        }
      },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.text, 'check the assertion first')
    assert.equal(posts.length, 3)
  })

  it('overall timeout stays pending error, never tool-success JSON', async () => {
    const result = await consultAdvisorUntilAdvice({
      overallMs: 30,
      retryGapMs: 5,
      post: async () => ({
        statusCode: 202,
        body: JSON.stringify({ status: 'pending', consultId: 'advc-wait', reused: true }),
      }),
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.pending, true)
    assert.match(result.text, /pending/)
    assert.match(result.text, /invocation/)
  })
})
