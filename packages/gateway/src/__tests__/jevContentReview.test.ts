import * as assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { contentReviewDbPath, getContentReviewStore, openContentReviewStore, setContentReviewStoreForTests } from '../contentReviewStore.js'
import { appealStrikeId, shouldBanForStrikes, violationInbox } from '../contentReviewNotice.js'

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
  setContentReviewPrefilter,
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
    assert.equal(isContentReviewSessionBanned('9', 'agent:main:webchat:dm:wsess-1'), false)
    const banned = store.ban(row!.id, 'admin:1')
    assert.equal(banned?.bannedAt != null, true)
    assert.equal(isContentReviewSessionBanned('9', 'agent:main:webchat:dm:wsess-1'), true)
    assert.equal(isContentReviewSessionBanned('8', 'agent:main:webchat:dm:wsess-1'), false)
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

  it('omni prefilter hit records a violation and does not call Jev', async () => {
    process.env[CONTENT_REVIEW_FLAG] = '1'
    process.env[CONTENT_REVIEW_KEY] = 'test-key'
    let calls = 0
    setContentReviewPrefilter(async () => true)
    setContentReviewDepsForTests({
      fetchImpl: async () => {
        calls += 1
        return { status: 200, json: async () => ({}) }
      },
    })
    const row = await runUserContentReview({ text: 'hello there friend', userId: '3', sessionKey: 's' })
    assert.equal(calls, 0)
    assert.equal(row?.choice, 'policy_violation')
    assert.equal(row?.thresholdMet, true)
  })

  it('omni prefilter failure still calls Jev', async () => {
    process.env[CONTENT_REVIEW_FLAG] = '1'
    process.env[CONTENT_REVIEW_KEY] = 'test-key'
    let calls = 0
    setContentReviewPrefilter(async () => {
      throw new Error('down')
    })
    setContentReviewDepsForTests({
      fetchImpl: async () => {
        calls += 1
        return {
          status: 200,
          json: async () => ({ answers: { risk: { choice: 'none', confidence: 0.99 } } }),
        }
      },
    })
    const row = await runUserContentReview({ text: 'hello there friend', userId: '3', sessionKey: 's' })
    assert.equal(calls, 1)
    assert.equal(row?.choice, 'none')
    assert.equal(row?.thresholdMet, false)
  })

  async function reviewAfterSlowPrefilter(finish: () => Promise<boolean>): Promise<{
    aborted: boolean
    alerts: number
    choice: string | undefined
    thresholdMet: boolean | undefined
  }> {
    process.env[CONTENT_REVIEW_FLAG] = '1'
    process.env[CONTENT_REVIEW_KEY] = 'test-key'
    let aborted = true
    let alerts = 0
    setContentReviewAlerter(() => {
      alerts += 1
    })
    setContentReviewDepsForTests({
      timeoutMs: 80,
      fetchImpl: async (_url, init) => {
        aborted = init.signal.aborted
        init.signal.throwIfAborted()
        return {
          status: 200,
          json: async () => ({ answers: { risk: { choice: 'policy_violation', confidence: 0.99 } } }),
        }
      },
    })
    setContentReviewPrefilter(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return finish()
    })
    const row = await runUserContentReview({
      text: 'mock policy violation input',
      userId: 'acceptance',
      sessionKey: 'acceptance-only',
    })
    return { aborted, alerts, choice: row?.choice, thresholdMet: row?.thresholdMet }
  }

  it('a slow prefilter miss still records and alerts on a fresh JEV budget', async () => {
    const result = await reviewAfterSlowPrefilter(async () => false)
    assert.equal(result.aborted, false)
    assert.equal(result.choice, 'policy_violation')
    assert.equal(result.thresholdMet, true)
    assert.equal(result.alerts, 1)
  })

  it('a slow prefilter failure still records and alerts on a fresh JEV budget', async () => {
    const result = await reviewAfterSlowPrefilter(async () => {
      throw new Error('mock upstream failure')
    })
    assert.equal(result.aborted, false)
    assert.equal(result.choice, 'policy_violation')
    assert.equal(result.thresholdMet, true)
    assert.equal(result.alerts, 1)
  })

  it('a prefilter timeout still records and alerts on a fresh JEV budget', async () => {
    const result = await reviewAfterSlowPrefilter(async () => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    })
    assert.equal(result.aborted, false)
    assert.equal(result.choice, 'policy_violation')
    assert.equal(result.thresholdMet, true)
    assert.equal(result.alerts, 1)
  })

  it('counts the third open strike as an account ban and tags the appeal', () => {
    assert.equal(shouldBanForStrikes(2), false)
    assert.equal(shouldBanForStrikes(3), true)
    const notice = violationInbox({ strikeId: '41', excerpt: 'sample', activeCount: 3 })
    assert.equal(appealStrikeId(notice.bodyMd), '41')
    assert.match(notice.title, /封禁/)
  })

  it('OCV5-877: contentReviewDbPath never treats OC_SESSIONS_STORE mode keywords (pg/sqlite/memory) as relative paths', () => {
    assert.equal(
      contentReviewDbPath({ OC_SESSIONS_STORE: 'pg', OPENCLAUDE_HOME: '/var/lib/oc-v5' }),
      '/var/lib/oc-v5/content-reviews.db',
    )
    assert.equal(
      contentReviewDbPath({ OC_SESSIONS_STORE: 'PG', OPENCLAUDE_HOME: '/var/lib/oc-v5' }),
      '/var/lib/oc-v5/content-reviews.db',
    )
    assert.equal(
      contentReviewDbPath({ OC_SESSIONS_STORE: 'sqlite', OPENCLAUDE_HOME: '/var/lib/oc-v5' }),
      '/var/lib/oc-v5/content-reviews.db',
    )
    assert.equal(
      contentReviewDbPath({ OC_SESSIONS_STORE: 'memory', OPENCLAUDE_HOME: '/var/lib/oc-v5' }),
      '/var/lib/oc-v5/content-reviews.db',
    )
    assert.equal(
      contentReviewDbPath({ OC_SESSIONS_STORE: 'postgres://u:p@127.0.0.1/db', OPENCLAUDE_HOME: '/var/lib/oc-v5' }),
      '/var/lib/oc-v5/content-reviews.db',
    )
    assert.equal(
      contentReviewDbPath({ OC_SESSIONS_STORE: 'sessions.db', OPENCLAUDE_HOME: '/var/lib/oc-v5' }),
      '/var/lib/oc-v5/content-reviews.db',
    )
    assert.equal(
      contentReviewDbPath({ OC_SESSIONS_STORE: '/var/lib/openclaude/sessions.db', OPENCLAUDE_HOME: '/var/lib/oc-v5' }),
      '/var/lib/openclaude/content-reviews.db',
    )
    assert.equal(
      contentReviewDbPath({
        OC_CONTENT_REVIEW_DB: '/custom/review.db',
        OC_SESSIONS_STORE: '/var/lib/openclaude/sessions.db',
      }),
      '/custom/review.db',
    )
  })

  it('OCV5-877 / OCV5-881: migrates legacy CWD content-reviews.db preserving IDs/bans and fails closed on split-brain', () => {
    const prevCwd = process.cwd()
    const legacyDir = mkdtempSync(join(tmpdir(), 'oc-review-legacy-cwd-'))
    const homeDir = mkdtempSync(join(tmpdir(), 'oc-review-home-'))
    const env: NodeJS.ProcessEnv = { OC_SESSIONS_STORE: 'pg', OPENCLAUDE_HOME: homeDir }

    try {
      // 1. Pre-upgrade: old code wrote ./content-reviews.db inside CWD for user A (id=1) + session ban
      const legacyStore = openContentReviewStore(join(legacyDir, 'content-reviews.db'))
      const rowA = legacyStore.insert({
        userId: 'user-A',
        sessionKey: 'agent:main:webchat:dm:sess-A',
        textHash: 'hash-A',
        excerpt: 'excerpt-A',
        choice: 'policy_violation',
        confidence: 0.99,
        thresholdMet: true,
      })
      assert.equal(rowA.id, 1)
      legacyStore.ban(rowA.id, 'admin:1')
      legacyStore.close()

      // 2. Upgrade: getContentReviewStore migrates legacy CWD DB into OPENCLAUDE_HOME preserving id=1 & ban
      process.chdir(legacyDir)
      setContentReviewStoreForTests(null)
      const upgraded = getContentReviewStore(env)
      const fetchedA = upgraded.get(1)
      assert.equal(fetchedA?.userId, 'user-A')
      assert.equal(fetchedA?.textHash, 'hash-A')
      assert.equal(upgraded.isBanned('user-A', 'agent:main:webchat:dm:sess-A'), true)

      // New insert for user B MUST NOT reuse id=1
      const rowB = upgraded.insert({
        userId: 'user-B',
        sessionKey: 'agent:main:webchat:dm:sess-B',
        textHash: 'hash-B',
        excerpt: 'excerpt-B',
        choice: 'policy_violation',
        confidence: 0.95,
        thresholdMet: true,
      })
      assert.equal(rowB.id, 2)
      assert.equal(upgraded.get(1)?.userId, 'user-A')
      upgraded.close()

      // 3. Subsequent restart while legacy file still sits untouched in read-only CWD succeeds cleanly
      setContentReviewStoreForTests(null)
      const restarted = getContentReviewStore(env)
      assert.equal(restarted.get(1)?.userId, 'user-A')
      assert.equal(restarted.get(2)?.userId, 'user-B')
      restarted.close()

      // 4. Split-brain: if legacy DB later gets a diverging write (e.g. concurrent dual-writer), fail closed
      const rogueLegacy = openContentReviewStore(join(legacyDir, 'content-reviews.db'))
      rogueLegacy.insert({
        userId: 'user-C',
        sessionKey: 'agent:main:webchat:dm:sess-C',
        textHash: 'hash-C',
        excerpt: 'excerpt-C',
        choice: 'policy_violation',
        confidence: 0.98,
        thresholdMet: true,
      })
      rogueLegacy.close()

      setContentReviewStoreForTests(null)
      assert.throws(() => getContentReviewStore(env), /content_review_split_brain/)
    } finally {
      setContentReviewStoreForTests(null)
      process.chdir(prevCwd)
    }
  })
})
