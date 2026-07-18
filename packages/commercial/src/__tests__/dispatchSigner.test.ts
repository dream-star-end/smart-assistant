/**
 * dispatchSigner unit:__oc_dispatch 铸票 → 验签 round-trip(RFC §2.2)。
 * 证明 master 铸的票能被 gateway 同套 keyring 验通,且 kind 域隔离 / 时效生效。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { verifyDispatchAuthority, ModelAuthorityError } from '@openclaude/protocol'
import { AuthoritySigner } from '../ws/authoritySigner.js'
import { mintDispatchEnvelope } from '../dispatch/dispatchSigner.js'

const input = {
  uid: 42n,
  containerId: 7,
  sessionId: 'sess-0001',
  clientMessageId: 'cm-1',
  dispatchId: '11111111-1111-4111-8111-111111111111',
  attemptNo: 1,
  payloadHash: 'abc123',
  billingRequestId: 'br-1',
  connectionChallenge: 'chal-xyz',
}

describe('mintDispatchEnvelope', () => {
  test('round-trips through verifyDispatchAuthority with the signer keyring', () => {
    const signer = AuthoritySigner.createEphemeral()
    const now = 1_000_000
    const env = mintDispatchEnvelope(signer, input, { now })
    const payload = verifyDispatchAuthority(env, signer.publicKeyring(), now + 1000)
    assert.equal(payload.uid, '42')
    assert.equal(payload.containerId, '7')
    assert.equal(payload.dispatchId, input.dispatchId)
    assert.equal(payload.attemptNo, 1)
    assert.equal(payload.payloadHash, 'abc123')
    // B9(master 半):envelope 忠实携带 sessionId(= bridge 注入的 peerId)与 billingRequestId
    // (= 受理铸、journal 复用的同一 id)—— 签发侧不改名/不丢字段,gateway 验签取到的就是这两值。
    assert.equal(payload.sessionId, input.sessionId)
    assert.equal(payload.sessionId, 'sess-0001')
    assert.equal(payload.billingRequestId, 'br-1')
    assert.equal(payload.connectionChallenge, 'chal-xyz')
    assert.equal(payload.keyId, signer.activeKeyId)
  })

  test('expired ticket rejected', () => {
    const signer = AuthoritySigner.createEphemeral()
    const now = 1_000_000
    const env = mintDispatchEnvelope(signer, input, { now, ttlMs: 100 })
    assert.throws(
      () => verifyDispatchAuthority(env, signer.publicKeyring(), now + 5000),
      (err: unknown) => err instanceof ModelAuthorityError && err.code === 'Expired',
    )
  })

  test('rejects bad attemptNo before signing', () => {
    const signer = AuthoritySigner.createEphemeral()
    assert.throws(() => mintDispatchEnvelope(signer, { ...input, attemptNo: 0 }))
  })

  test('rejects empty required string before signing', () => {
    const signer = AuthoritySigner.createEphemeral()
    assert.throws(() => mintDispatchEnvelope(signer, { ...input, payloadHash: '' }))
  })
})
