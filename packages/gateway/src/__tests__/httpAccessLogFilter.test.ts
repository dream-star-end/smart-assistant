// OCV5-461: probe paths are logged only when they fail or are slow.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { shouldLogHttpAccess } from '../server.js'

test('healthy fast probes are not logged', () => {
  assert.equal(shouldLogHttpAccess('/healthz', 200, 31), false)
  assert.equal(shouldLogHttpAccess('/metrics', 200, 5), false)
})

test('failing or slow probes are logged', () => {
  assert.equal(shouldLogHttpAccess('/healthz', 503, 12), true)
  assert.equal(shouldLogHttpAccess('/healthz', 200, 1000), true)
  assert.equal(shouldLogHttpAccess('/metrics', 401, 2), true)
})

test('api and v1 requests are logged as before; static assets never', () => {
  assert.equal(shouldLogHttpAccess('/api/sessions', 200, 4), true)
  assert.equal(shouldLogHttpAccess('/v1/messages', 200, 4), true)
  assert.equal(shouldLogHttpAccess('/assets/index-abc.js', 200, 1), false)
  assert.equal(shouldLogHttpAccess('/healthz/extra', 200, 1), false)
})
