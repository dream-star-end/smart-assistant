import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { SYSTEM_HELP_BOOTSTRAP_TTL_MS, SYSTEM_HELP_GRANT_TTL_MS, SystemHelpGrantError, SystemHelpGrantSigner, type SystemHelpIdentityScope } from '../system-assistant/helpGrant.js'
const scope: SystemHelpIdentityScope = { uid: '765', containerId: '123', sessionId: 'synthetic-session', agentId: 'main', dispatchId: randomUUID(), attemptNo: 1, ownerId: randomUUID(), dispatchLeaseEpoch: '7' }
test('bootstrap authenticates only refresh and a short grant authenticates only read/prepare', () => {
  const key = randomBytes(32)
  let now = 1000000
  const signer = new SystemHelpGrantSigner(key, () => now); key.fill(0)
  try {
    const initial = signer.issueBootstrap(scope)
    assert.equal(initial.expiresAt, now + SYSTEM_HELP_BOOTSTRAP_TTL_MS)
    assert.equal(signer.verifyBootstrap(initial.token).scope, 'bootstrap_refresh')
    assert.throws(() => signer.verify(initial.token))
    const short = signer.issue({ ...scope, securityEpoch: '12' })
    assert.equal(short.expiresAt, now + SYSTEM_HELP_GRANT_TTL_MS)
    assert.equal(signer.verify(short.token).scope, 'read_prepare')
    assert.equal(signer.verify(short.token).dispatchLeaseEpoch, '7')
    assert.equal('role' in signer.verify(short.token), false)
    assert.throws(() => signer.verifyBootstrap(short.token))
    now += SYSTEM_HELP_GRANT_TTL_MS
    assert.throws(() => signer.verify(short.token), e => e instanceof SystemHelpGrantError && e.code === 'CONTEXT_EXPIRED')
    assert.equal(signer.verifyBootstrap(initial.token).dispatchId, scope.dispatchId)
  } finally { signer.close() }
})
test('tampered scope data, an unrelated key and a raw ledger-key MAC cannot authenticate', () => {
  const key = randomBytes(32)
  const signer = new SystemHelpGrantSigner(key)
  const otherKey = randomBytes(32)
  const other = new SystemHelpGrantSigner(otherKey); otherKey.fill(0)
  try {
    const { token } = signer.issue({ ...scope, securityEpoch: '12' })
    const [body, signature] = token.split('.')
    assert.ok(body && signature)
    const altered = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    altered.uid = '8000000000000000000'
    assert.throws(() => signer.verify(`${Buffer.from(JSON.stringify(altered)).toString('base64url')}.${signature}`))
    assert.throws(() => other.verify(token))
    const rawKeyMac = createHmac('sha256', key).update(body).digest('base64url')
    assert.throws(() => signer.verify(`${body}.${rawKeyMac}`))
  } finally { key.fill(0); signer.close(); other.close() }
})
test('malformed tokens and unbounded identity fields are rejected without coercion', () => {
  const key = randomBytes(32)
  const signer = new SystemHelpGrantSigner(key); key.fill(0)
  try {
    for (const token of ['', 'x.y.z', 'a.!', 'a'.repeat(4097)]) assert.throws(() => signer.verify(token))
    assert.throws(() => signer.issueBootstrap({ ...scope, ownerId: '' }))
    assert.throws(() => signer.issueBootstrap({ ...scope, dispatchLeaseEpoch: '0' }))
    assert.throws(() => signer.issueBootstrap({ ...scope, agentId: 'a'.repeat(65) }))
    assert.throws(() => signer.issue({ ...scope, securityEpoch: '-1' }))
    assert.throws(() => signer.issueBootstrap({ ...scope, uid: 765 as unknown as string }))
  } finally { signer.close() }
})
test('future issuance is invalid, bootstrap expires, and a disposed signer cannot be reused or serialized with its key', () => {
  const key = randomBytes(32)
  let now = 1000000
  const signer = new SystemHelpGrantSigner(key, () => now); key.fill(0)
  const initial = signer.issueBootstrap(scope)
  now--
  assert.throws(() => signer.verifyBootstrap(initial.token))
  now = 1000000 + SYSTEM_HELP_BOOTSTRAP_TTL_MS
  assert.throws(() => signer.verifyBootstrap(initial.token), e => e instanceof SystemHelpGrantError && e.code === 'CONTEXT_EXPIRED')
  assert.equal(JSON.stringify(signer).includes('Buffer'), false)
  signer.close()
  assert.throws(() => signer.issueBootstrap(scope), e => e instanceof SystemHelpGrantError && e.code === 'UNAVAILABLE')
  assert.throws(() => signer.verifyBootstrap(initial.token))
})
