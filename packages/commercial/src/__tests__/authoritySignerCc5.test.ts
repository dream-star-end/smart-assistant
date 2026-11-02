/** In-memory synthetic signing keys only; public-ring verification, no production keys or IO. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ModelAuthorityError,
  type Cc5ExecutionBackend,
  assertLeaseMatchesAuthority,
  parseAuthorityKeyring,
  verifyAuthority,
  verifyTurnLease,
} from '@openclaude/protocol'
import { AuthoritySigner, type AuthorityMintInput } from '../ws/authoritySigner.js'

const NOW = 1_760_000_000_000
const backend: Cc5ExecutionBackend = {
  kind: 'cc5-interactive-v1',
  sessionKey: 'agent:main:webchat:dm:new_chat_123',
  operationId: '11111111-1111-4111-8111-111111111111',
}
function input(over: Partial<AuthorityMintInput> = {}): AuthorityMintInput {
  return {
    uid: 912, containerId: 91, connectionChallenge: 'fixture-connection',
    canonicalModel: 'box-claude-sonnet-5', engine: 'ccb',
    executionDescriptor: {
      capabilityProfile: { ccb: { contextOwner: 'box-native-v1', capabilityZero: false, supportsThinking: true } },
      capabilitySchemaVersion: 1, contextWindow: 200000, supportedEfforts: [], supportsVision: true,
    },
    executionRevision: 'a'.repeat(64), securityEpoch: 9, auxModels: [],
    executionBackend: backend, ...over,
  }
}
function isCode(code: string) {
  return (error: unknown) => error instanceof ModelAuthorityError && error.code === code
}

test('master signs the native backend under the existing Sonnet identity; public ring verifies authority and matching lease', () => {
  const signer = AuthoritySigner.createEphemeral()
  const minted = signer.signBundle(input(), { now: NOW })
  const ring = parseAuthorityKeyring(signer.publicKeyringEnv())
  const authority = verifyAuthority(minted.bundle.authority, ring, NOW + 1000)
  const lease = verifyTurnLease(minted.bundle.lease, ring, NOW + 1000)
  assert.deepEqual(authority, minted.payload)
  assert.deepEqual(authority.executionBackend, backend)
  assert.equal(Object.isFrozen(authority.executionBackend), true)
  assert.equal(authority.canonicalModel, 'box-claude-sonnet-5')
  assert.equal(authority.engine, 'ccb')
  assert.deepEqual(authority.executionDescriptor, input().executionDescriptor)
  assert.deepEqual(lease, minted.lease)
  assert.doesNotThrow(() => assertLeaseMatchesAuthority(lease, authority))
  assert.equal('executionBackend' in lease, false)
})

test('ordinary same-model authority has no backend; inserting a backend after signing fails', () => {
  const signer = AuthoritySigner.createEphemeral()
  const minted = signer.signBundle(input({ executionBackend: undefined }), { now: NOW })
  const ring = signer.publicKeyring()
  const authority = verifyAuthority(minted.bundle.authority, ring, NOW)
  assert.equal('executionBackend' in authority, false)
  assert.doesNotThrow(() => assertLeaseMatchesAuthority(verifyTurnLease(minted.bundle.lease, ring, NOW), authority))
  const forged = JSON.parse(Buffer.from(minted.bundle.authority, 'base64url').toString('utf8'))
  forged.payload.executionBackend = backend
  assert.throws(() => verifyAuthority(Buffer.from(JSON.stringify(forged)).toString('base64url'), ring, NOW), isCode('VerifyFail'))
})

test('changing or removing a valid signed backend scope cannot retain the original signature', () => {
  const signer = AuthoritySigner.createEphemeral()
  const minted = signer.signBundle(input(), { now: NOW })
  for (const change of [
    { ...backend, sessionKey: 'agent:main:webchat:dm:other_chat_123' },
    { ...backend, operationId: '22222222-2222-4222-8222-222222222222' },
    undefined,
  ]) {
    const forged = JSON.parse(Buffer.from(minted.bundle.authority, 'base64url').toString('utf8'))
    if (change === undefined) Reflect.deleteProperty(forged.payload, 'executionBackend')
    else forged.payload.executionBackend = change
    assert.throws(() => verifyAuthority(Buffer.from(JSON.stringify(forged)).toString('base64url'), signer.publicKeyring(), NOW), isCode('VerifyFail'))
  }
})

test('even correctly signed invalid backend/model/engine combinations fail public verification', () => {
  const signer = AuthoritySigner.createEphemeral()
  for (const over of [
    { canonicalModel: 'cc5-remote-t1555u' },
    { engine: 'cursor' as const },
    { executionBackend: { ...backend, sessionKey: 'fixture-session' } },
    { executionBackend: { ...backend, kind: 'other-backend' } as unknown as Cc5ExecutionBackend },
    { executionBackend: { ...backend, extra: true } },
  ]) {
    const minted = signer.signBundle(input(over), { now: NOW })
    assert.throws(() => verifyAuthority(minted.bundle.authority, signer.publicKeyring(), NOW), isCode('BadShape'))
  }
})

test('individually valid native authority and foreign lease fail binding reconciliation', () => {
  const signer = AuthoritySigner.createEphemeral()
  const native = signer.signBundle(input(), { now: NOW })
  const authority = verifyAuthority(native.bundle.authority, signer.publicKeyring(), NOW)
  for (const over of [
    { uid: 913 }, { containerId: 92 }, { canonicalModel: 'glm-5.2', executionBackend: undefined },
    { connectionChallenge: 'other-connection' }, { securityEpoch: 10 }, { auxModels: ['other-model'] },
  ]) {
    const foreign = signer.signBundle(input({ authorityTurnId: authority.authorityTurnId, ...over }), { now: NOW })
    const lease = verifyTurnLease(foreign.bundle.lease, signer.publicKeyring(), NOW)
    assert.throws(() => assertLeaseMatchesAuthority(lease, authority), isCode('LeaseMismatch'))
  }
  const otherTurn = signer.signBundle(input(), { now: NOW })
  assert.throws(() => assertLeaseMatchesAuthority(verifyTurnLease(otherTurn.bundle.lease, signer.publicKeyring(), NOW), authority), isCode('LeaseMismatch'))
})
