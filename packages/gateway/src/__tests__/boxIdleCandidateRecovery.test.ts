import assert from 'node:assert/strict'
import { test } from 'node:test'
import { proveBoxIdleCandidateRecovery } from './fixtures/boxIdleCandidateFixture.js'

test('t1642u failed Box candidate recovers for same and different models only after proof', { timeout: 30_000 }, async () => {
  assert.equal(await proveBoxIdleCandidateRecovery(), '[t1642u-box-idle-recovery] PASS')
})
