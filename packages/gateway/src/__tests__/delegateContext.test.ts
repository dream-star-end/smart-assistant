import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DELEGATE_CONTEXT_TTL_MS,
  isConsultTurnClaims,
  issueConsultTurnToken,
  issueDelegateContextToken,
  issueParentCallerToken,
  resetDelegateContextKeyForTests,
  verifyDelegateContextToken,
} from '../delegateContext.js'

describe('delegateContext token', () => {
  it('covers the platform 12h turn lifetime plus settlement grace', () => {
    assert.equal(DELEGATE_CONTEXT_TTL_MS, 12 * 60 * 60_000 + 5 * 60_000)
  })

  it('round-trips agentId/sessionKey/depth', () => {
    const token = issueDelegateContextToken({
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:s1',
      depth: 2,
    })
    const claims = verifyDelegateContextToken(token)
    assert.ok(claims)
    assert.equal(claims.agentId, 'main')
    assert.equal(claims.sessionKey, 'agent:main:webchat:dm:s1')
    assert.equal(claims.depth, 2)
  })

  it('rejects tampered payload and rotated keys', () => {
    const token = issueDelegateContextToken({
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:s1',
      depth: 1,
    })
    const [payload, sig] = token.split('.')
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    parsed.depth = 0
    const forged = `${Buffer.from(JSON.stringify(parsed)).toString('base64url')}.${sig}`
    assert.equal(verifyDelegateContextToken(forged), null)

    resetDelegateContextKeyForTests()
    assert.equal(verifyDelegateContextToken(token), null)
  })

  it('rejects expired tokens', () => {
    const token = issueDelegateContextToken({
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:s1',
      depth: 0,
      now: 1_000,
      ttlMs: 50,
    })
    assert.equal(verifyDelegateContextToken(token, 1_050), null)
    // re-issue after reset so later tests are not poisoned
    resetDelegateContextKeyForTests()
  })

  it('consult v2 token freezes origin turnKey and is not a v1 claim', () => {
    const token = issueConsultTurnToken({
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:s1',
      depth: 0,
      turnKey: 'a'.repeat(64),
      turnIndex: 3,
      collabMode: 'advisor',
      configVersion: 'v1:advisor:gpt-6-astra',
    })
    const claims = verifyDelegateContextToken(token)
    assert.ok(claims)
    assert.equal(isConsultTurnClaims(claims), true)
    if (!isConsultTurnClaims(claims)) return
    assert.equal(claims.turnKey, 'a'.repeat(64))
    assert.equal(claims.turnIndex, 3)
    assert.equal(claims.collabMode, 'advisor')
  })
})

describe('canonical parent trace in signed caller snapshots', () => {
  it('v1 and advisor v2 preserve the parent trace; legacy stays absent', () => {
    const base = { agentId: 'main', sessionKey: 'agent:main:webchat:dm:p2', depth: 1 }
    for (const consultTurn of [undefined, { turnKey: 'a'.repeat(64), turnIndex: 2, configVersion: 'v1' }]) {
      const traceId = '1'.repeat(32)
      const signed = issueParentCallerToken({ ...base, traceId, consultTurn })
      assert.equal(verifyDelegateContextToken(signed)?.traceId, traceId)
      const [payload, signature] = signed.split('.')
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
      claims.traceId = '2'.repeat(32)
      assert.equal(verifyDelegateContextToken(`${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`), null)
    }
    assert.equal(verifyDelegateContextToken(issueParentCallerToken(base))?.traceId, undefined)
    assert.throws(() => issueParentCallerToken({ ...base, traceId: 'request-id-is-not-canonical' }))
  })
})
