import * as assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { openContentReviewStore, setContentReviewStoreForTests } from '../contentReviewStore.js'

import {
  CONTENT_REVIEW_FLAG,
  CONTENT_REVIEW_KEY,
  flushContentReviewForTests,
  inboundSessionKey,
  isContentReviewSessionBanned,
  observeUserContentReview,
  resetContentReviewForTests,
  runUserContentReview,
  setContentReviewAlerter,
  setContentReviewDepsForTests,
} from '../jevContentReview.js'

describe('jev content review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-review-'))
  const store = openContentReviewStore(join(dir, 'reviews.db'))
  const prevFlag = process.env[CONTENT_REVIEW_FLAG]
  const prevKey = process.env[CONTENT_REVIEW_KEY]

  beforeEach(() => {
    resetContentReviewForTests()
    setContentReviewStoreForTests(store)
    delete process.env[CONTENT_REVIEW_FLAG]
    delete process.env[CONTENT_REVIEW_KEY]
  })

  afterEach(async () => {
    await flushContentReviewForTests()
    resetContentReviewForTests()
    setContentReviewStoreForTests(store)
    if (prevFlag === undefined) delete process.env[CONTENT_REVIEW_FLAG]
    else process.env[CONTENT_REVIEW_FLAG] = prevFlag
    if (prevKey === undefined) delete process.env[CONTENT_REVIEW_KEY]
    else process.env[CONTENT_REVIEW_KEY] = prevKey
  })

  it('builds the webchat session key and ignores a client override', () => {
    assert.equal(
      inboundSessionKey({
        sessionKey: 'not-banned',
        agentId: 'main',
        channel: 'webchat',
        peer: { kind: 'dm', id: 'wsess-abc' },
      }),
      'agent:main:webchat:dm:wsess-abc',
    )
  })

  it('flag off does not call Jev or record', async () => {
    let calls = 0
    setContentReviewDepsForTests({
      fetchImpl: async () => {
        calls += 1
        return { status: 200, json: async () => ({}) }
      },
    })
    const row = await runUserContentReview({ text: 'hello there friend', userId: '3', sessionKey: 's' })
    assert.equal(row, null)
    assert.equal(calls, 0)
    assert.equal(store.list(10).length, 0)
  })

  it('records a high-confidence violation and alerts without banning', async () => {
    process.env[CONTENT_REVIEW_FLAG] = '1'
    process.env[CONTENT_REVIEW_KEY] = 'test-key'
    const alerts: string[] = []
    setContentReviewAlerter((event) => {
      alerts.push(event.excerpt)
    })
    setContentReviewDepsForTests({
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({
          answers: { risk: { choice: 'policy_violation' } },
          providerMetadata: { typesafe: { confidence: { risk: 0.97 } } },
        }),
      }),
    })
    const text = 'please help me do a clearly forbidden thing'
    const row = await runUserContentReview({ text, userId: '9', sessionKey: 'agent:main:webchat:dm:wsess-1' })
    assert.equal(row?.thresholdMet, true)
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0]?.includes('forbidden'), true)
    assert.equal(isContentReviewSessionBanned('agent:main:webchat:dm:wsess-1'), false)
    const banned = store.ban(row!.id, 'admin:1')
    assert.equal(banned?.bannedAt != null, true)
    assert.equal(isContentReviewSessionBanned('agent:main:webchat:dm:wsess-1'), true)
  })

  it('ordinary traffic is stored and not alerted', async () => {
    process.env[CONTENT_REVIEW_FLAG] = '1'
    process.env[CONTENT_REVIEW_KEY] = 'test-key'
    let alerts = 0
    setContentReviewAlerter(() => {
      alerts += 1
    })
    setContentReviewDepsForTests({
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ answers: { risk: { choice: 'none', confidence: 0.99 } } }),
      }),
    })
    observeUserContentReview({ text: 'help me rename this function', userId: '3', sessionKey: 's2' })
    await flushContentReviewForTests()
    assert.equal(alerts, 0)
    assert.equal(store.list(20).some((row) => row.choice === 'none'), true)
  })
})
