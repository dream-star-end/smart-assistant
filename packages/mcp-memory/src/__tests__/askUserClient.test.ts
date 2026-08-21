/**
 * ask_user MCP client: wait budget, HTTP timeout, and failure fallback.
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/askUserClient.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ASK_USER_HTTP_TIMEOUT_MS,
  ASK_USER_POSTED_FALLBACK_MESSAGE,
  ASK_USER_WAIT_MS,
  askUserHttpTimeoutMs,
  askUserToolPostedFallback,
  askUserToolResultFromGateway,
  remainingAskUserWaitMs,
} from '../askUserClient.js'

describe('ask_user wait budget', () => {
  it('starts at 55s and never exceeds the 58s HTTP timeout or 60s wall', () => {
    assert.equal(ASK_USER_WAIT_MS, 55_000)
    assert.equal(ASK_USER_HTTP_TIMEOUT_MS, 58_000)
    assert.ok(ASK_USER_WAIT_MS < ASK_USER_HTTP_TIMEOUT_MS)
    assert.ok(ASK_USER_HTTP_TIMEOUT_MS < 60_000)
    assert.equal(remainingAskUserWaitMs(1_000, 1_000), 55_000)
    assert.equal(remainingAskUserWaitMs(1_000, 1_000 + 10_000), 45_000)
    assert.equal(remainingAskUserWaitMs(1_000, 1_000 + 55_000), 0)
    assert.equal(remainingAskUserWaitMs(1_000, 1_000 + 90_000), 0)
    assert.equal(askUserHttpTimeoutMs(55_000), 58_000)
    assert.equal(askUserHttpTimeoutMs(0), 5_000)
    assert.ok(askUserHttpTimeoutMs(55_000) < 60_000)
  })
})

describe('askUserToolResultFromGateway', () => {
  it('passes through an in-window answered body', () => {
    const body = JSON.stringify({
      status: 'answered',
      requestId: 'ask-user:1',
      answers: { q: 'Vim' },
      message: 'The user already answered these questions in this turn. Vim',
    })
    const r = askUserToolResultFromGateway({ statusCode: 200, body })
    assert.equal(r.content[0]!.text, body)
    assert.equal('isError' in r, false)
  })

  it('passes through posted (timeout degrade) body', () => {
    const body = JSON.stringify({
      status: 'posted',
      requestId: 'ask-user:1',
      message: ASK_USER_POSTED_FALLBACK_MESSAGE,
    })
    const r = askUserToolResultFromGateway({ statusCode: 200, body })
    assert.equal(r.content[0]!.text, body)
  })

  it('HTTP errors and empty 200 degrade to posted fallback, never throw', () => {
    const fallback = askUserToolPostedFallback()
    assert.match(fallback.content[0]!.text, /End your turn now/)
    assert.equal(
      askUserToolResultFromGateway({ statusCode: 500, body: 'boom' }).content[0]!.text,
      fallback.content[0]!.text,
    )
    assert.equal(
      askUserToolResultFromGateway({ statusCode: 200, body: '' }).content[0]!.text,
      fallback.content[0]!.text,
    )
    const skipped = askUserToolResultFromGateway({ statusCode: 409, body: 'nope' })
    assert.match(skipped.content[0]!.text, /"status":"skipped"/)
  })
})
