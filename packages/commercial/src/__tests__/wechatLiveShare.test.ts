import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'

import {
  buildWechatLiveToken,
  deriveWechatLiveLinkKey,
  verifyWechatLiveToken,
} from '../wechat/liveShare.js'
import type { WechatSessionId } from '../wechat/types.js'

const BRIDGE_SECRET = randomBytes(32).toString('hex')
const ALT_BRIDGE_SECRET = randomBytes(32).toString('hex')
const SESSION_ID = 'wsess-0123456789abcdef' as WechatSessionId
const USER_ID = 'c:42'
const NOW = 1_700_000_000_000

describe('wechat live link key derivation', () => {
  test('returns deterministic 32-byte key for valid bridge secret', () => {
    const a = deriveWechatLiveLinkKey(BRIDGE_SECRET)
    const b = deriveWechatLiveLinkKey(BRIDGE_SECRET)
    assert.equal(a.length, 32)
    assert.equal(a.toString('hex'), b.toString('hex'))
    assert.notEqual(a.toString('hex'), deriveWechatLiveLinkKey(ALT_BRIDGE_SECRET).toString('hex'))
  })

  test('rejects malformed bridge secret', () => {
    assert.throws(() => deriveWechatLiveLinkKey('abc'))
    assert.throws(() => deriveWechatLiveLinkKey('z'.repeat(64)))
    assert.throws(() => deriveWechatLiveLinkKey('A'.repeat(64)))
  })
})

describe('wechat live token', () => {
  const key = deriveWechatLiveLinkKey(BRIDGE_SECRET)

  test('roundtrip verifies session, user and expiry', () => {
    const { token, expMs } = buildWechatLiveToken(key, {
      sessionId: SESSION_ID,
      userId: USER_ID,
      nowMs: NOW,
      ttlMs: 60_000,
    })
    const verified = verifyWechatLiveToken(key, token, NOW + 1)
    assert.equal(verified.kind, 'ok')
    if (verified.kind === 'ok') {
      assert.equal(verified.sessionId, SESSION_ID)
      assert.equal(verified.userId, USER_ID)
      assert.equal(verified.expMs, expMs)
    }
  })

  test('tampered payload is forbidden', () => {
    const { token } = buildWechatLiveToken(key, {
      sessionId: SESSION_ID,
      userId: USER_ID,
      nowMs: NOW,
    })
    const [payload, sig] = token.split('.')
    const altered = `${payload!.replace(/.$/, payload!.endsWith('A') ? 'B' : 'A')}.${sig}`
    assert.equal(verifyWechatLiveToken(key, altered, NOW).kind, 'forbidden')
  })

  test('wrong key is forbidden', () => {
    const { token } = buildWechatLiveToken(key, {
      sessionId: SESSION_ID,
      userId: USER_ID,
      nowMs: NOW,
    })
    assert.equal(
      verifyWechatLiveToken(deriveWechatLiveLinkKey(ALT_BRIDGE_SECRET), token, NOW).kind,
      'forbidden',
    )
  })

  test('expired token returns gone', () => {
    const { token } = buildWechatLiveToken(key, {
      sessionId: SESSION_ID,
      userId: USER_ID,
      nowMs: NOW,
      ttlMs: 10,
    })
    assert.equal(verifyWechatLiveToken(key, token, NOW + 10).kind, 'gone')
  })

  test('bad build inputs are rejected', () => {
    assert.throws(() =>
      buildWechatLiveToken(key, {
        sessionId: 'sess-abc' as WechatSessionId,
        userId: USER_ID,
      }),
    )
    assert.throws(() =>
      buildWechatLiveToken(key, {
        sessionId: SESSION_ID,
        userId: '42',
      }),
    )
  })

  test('bad token shape and payload validation return bad-request', () => {
    assert.equal(verifyWechatLiveToken(key, null, NOW).kind, 'bad-request')
    assert.equal(verifyWechatLiveToken(key, 'not-a-token', NOW).kind, 'bad-request')
    assert.equal(verifyWechatLiveToken(key, 'bad.payload.parts', NOW).kind, 'bad-request')
  })
})
