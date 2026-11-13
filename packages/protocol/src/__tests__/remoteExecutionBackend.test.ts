import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { parseRemoteExecutionBackend, isRemoteBackendAuthority } from '../remoteExecutionBackend.js'
import { authoritySigningInput, encodeAuthorityEnvelope, verifyAuthority } from '../modelAuthority.js'

const backend = { kind: 'codex-app-server-v1', version: 1, operationId: '11111111-1111-4111-8111-111111111111',
  sessionKey: 'agent:main:webchat:dm:codex_remote_test', generation: '1', profileId: 'pro', authEpoch: 'epoch-1' }
test('Codex backend is distinct, closed and engine qualified', () => {
  assert.deepEqual(parseRemoteExecutionBackend(backend), backend)
  assert.equal(isRemoteBackendAuthority({ engine: 'codex', canonicalModel: 'gpt-6-luna-remote', executionBackend: backend }), true)
  for (const engine of ['ccb', 'grok']) assert.equal(isRemoteBackendAuthority({ engine, canonicalModel: 'gpt-6-luna-remote', executionBackend: backend }), false)
  for (const change of [{ version: 2 }, { generation: '0' }, { extra: true }, { kind: 'cc5-interactive-v1' }])
    assert.throws(() => parseRemoteExecutionBackend({ ...backend, ...change }))
})
test('signed Codex backend round trips; signing cannot bless engine confusion', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = 'mak1_testkey00000001', now = 1760000000000
  const keys = new Map([[keyId, new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'))]])
  const payload = { v: 1, keyId, uid: 3, containerId: 7, authorityTurnId: 'a'.repeat(32),
    connectionChallenge: 'challenge', canonicalModel: 'gpt-6-luna-remote', engine: 'codex', executionBackend: backend,
    executionDescriptor: { capabilityProfile: {}, capabilitySchemaVersion: 1, contextWindow: 10000,
      supportedEfforts: ['low'], supportsVision: false }, executionRevision: 'b'.repeat(64), securityEpoch: 1,
    issuedAt: now, expiresAt: now + 60000 }
  const envelope = (value: any) => encodeAuthorityEnvelope(value, sign(null, authoritySigningInput(value), privateKey))
  assert.deepEqual(verifyAuthority(envelope(payload), keys, now).executionBackend, backend)
  assert.throws(() => verifyAuthority(envelope({ ...payload, engine: 'ccb' }), keys, now))
})
