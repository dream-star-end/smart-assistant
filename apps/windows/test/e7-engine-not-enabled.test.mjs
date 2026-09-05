import assert from 'node:assert/strict'
import test from 'node:test'

import { assertGatewayEnvSafe, buildGatewayEnv, DESKTOP_ENGINES } from '../src/host/gatewayProcess.mjs'
import { createLahGwToken, createLahToken } from '../src/host/tokens.mjs'

test('E7 desktop gateway env pins OPENCLAUDE_ENGINES=ccb so cursor is client-side disabled', () => {
  const env = buildGatewayEnv({
    localBridgeToken: 'aa'.repeat(32),
    lahGwToken: createLahGwToken(),
    lahToken: createLahToken(),
    masterProxyPort: 18792,
  })
  assertGatewayEnvSafe(env)
  assert.equal(DESKTOP_ENGINES, 'ccb')
  assert.equal(env.OPENCLAUDE_ENGINES, 'ccb')
})
