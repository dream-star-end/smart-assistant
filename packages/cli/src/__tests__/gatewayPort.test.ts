import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveEffectiveGatewayPort } from '../commands/gateway.js'

test('resolveEffectiveGatewayPort honors OPENCLAUDE_GATEWAY_PORT override safely', () => {
  assert.equal(resolveEffectiveGatewayPort(18790, {}), 18790)
  assert.equal(resolveEffectiveGatewayPort(18790, { OPENCLAUDE_GATEWAY_PORT: '18791' }), 18791)
  assert.equal(resolveEffectiveGatewayPort(18790, { OPENCLAUDE_GATEWAY_PORT: ' 18795 ' }), 18795)
  assert.equal(resolveEffectiveGatewayPort(18790, { OPENCLAUDE_GATEWAY_PORT: 'invalid' }), 18790)
  assert.equal(resolveEffectiveGatewayPort(18790, { OPENCLAUDE_GATEWAY_PORT: '70000' }), 18790)
})
