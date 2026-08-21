import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DELEGATE_CONTEXT_TTL_MS,
  issueDelegateContextToken,
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
})
