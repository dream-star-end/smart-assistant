/**
 * V5 ZCode route validation. The opaque route is master-authored and becomes
 * the community CLI Anthropic baseURL + apiKey, so every byte of its shape is closed.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/zcodeRouteOverride.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { _buildSafeZcodeRouteOverride } from '../server.js'
import { V5_ZCODE_RELAY_PREFIX } from '../v5ZcodeRelay.js'

const PORT = 18791
const TOKEN = 'a'.repeat(64)
const VALID = {
  baseUrl: `http://127.0.0.1:${PORT}${V5_ZCODE_RELAY_PREFIX}/route/${TOKEN}`,
  routeToken: TOKEN,
}

function build(
  rawRoute: unknown,
  overrides: {
    model?: string
    port?: number
    authority?: { canonicalModel: string; engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' }
  } = {},
) {
  return _buildSafeZcodeRouteOverride({
    agent: { id: 'main' },
    model: 'model' in overrides ? overrides.model : 'zcode-experimental',
    rawRoute,
    officialRelayPort: overrides.port ?? PORT,
    authority: overrides.authority,
  })
}

describe('_buildSafeZcodeRouteOverride', () => {
  test('accepts only the exact token-bound loopback route without a trailing /v1', () => {
    assert.deepEqual(build(VALID), VALID)
    assert.deepEqual(build(VALID, {
      model: 'glm-5.3-zai',
      authority: { canonicalModel: 'glm-5.3-zai', engine: 'zcode' },
    }), VALID)
  })

  test('rejects CCB authority so the old-code deploy window stays on CCB', () => {
    assert.equal(build(VALID, {
      model: 'glm-5.3-zai',
      authority: { canonicalModel: 'glm-5.3-zai', engine: 'ccb' },
    }), null)
    assert.equal(build(VALID, { model: 'glm-5.2' }), null)
  })

  test('rejects unknown fields, token mismatch, /v1 suffix, alternate hosts and query tricks', () => {
    for (const raw of [
      null,
      'route',
      { ...VALID, extra: true },
      { ...VALID, routeToken: 'b'.repeat(64) },
      { ...VALID, baseUrl: VALID.baseUrl.replace('127.0.0.1', 'localhost') },
      { ...VALID, baseUrl: VALID.baseUrl.replace('http:', 'https:') },
      { ...VALID, baseUrl: `${VALID.baseUrl}/v1` },
      { ...VALID, baseUrl: `${VALID.baseUrl}?next=https://evil.example` },
      { ...VALID, baseUrl: VALID.baseUrl.replace(String(PORT), '18790') },
    ]) {
      assert.equal(build(raw), null, JSON.stringify(raw))
    }
  })
})
